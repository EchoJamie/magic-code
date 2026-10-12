import Foundation
import UserNotifications

struct NoticeRoute: Codable, Equatable {
    let base: String
    let serviceInstance: String
    let session: String
    let notice: AttentionItem
}
struct NoticeDelivery: Equatable {
    let identifier: String
    let title: String
    let subtitle: String
    let body: String
    let route: NoticeRoute
    var ids: [String] { [route.notice.id] }
    static func identifier(base: String, session: String) -> String {
        "work:\(URL(fileURLWithPath: base).resolvingSymlinksInPath().path):\(session)"
    }
    init(work: NativeWork, notice: AttentionItem, identity: ServiceIdentity) {
        identifier = Self.identifier(base: identity.base, session: work.session)
        title = work.title; subtitle = work.project
        body = String((notice.detail?.isEmpty == false ? notice.detail! : work.statusText).prefix(240))
        route = NoticeRoute(base: identity.base, serviceInstance: identity.serviceInstance, session: work.session, notice: notice)
    }
}

@MainActor final class NotificationCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published private(set) var authorization = "未启用"
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    var enabled = false
    var enabledSince = Date().timeIntervalSince1970 * 1000 - 2000
    var delivered: (([String]) -> Void)?
    var openRoute: ((NoticeRoute) -> Void)?
    var failure: ((String) -> Void)?
    #if DEBUG
    var deliveryAudit: ((NoticeDelivery) -> Bool)?
    #endif
    private var seen = Set<String>()
    private var pending: [String: NativeWork] = [:]
    private var current: [String: NativeWork] = [:]
    private var deliveryTokens: [String: UUID] = [:]
    private var displayed: [String: (identifier: String, source: String)] = [:]
    private let removeDelivery: ([String]) -> Void
    private var timer: Task<Void, Never>?
    private var base: String?
    private var serviceInstance: String?
    private let center: UNUserNotificationCenter?
    private let sendDelivery: (NoticeDelivery) async throws -> Void
    // The authorization surface is a pair of closures: production reads them from the system center,
    // the collector port (no center) is driven by its caller.
    private var statusProvider: () async -> UNAuthorizationStatus
    private var requester: () async throws -> Bool
    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        statusProvider = { await center.notificationSettings().authorizationStatus }
        requester = { try await center.requestAuthorization(options: [.alert, .sound, .badge]) }
        sendDelivery = { delivery in
            let content = UNMutableNotificationContent()
            content.title = delivery.title; content.subtitle = delivery.subtitle; content.body = delivery.body
            content.categoryIdentifier = "MAGIC_WORK"
            content.userInfo = ["route": String(decoding: try JSONEncoder().encode(delivery.route), as: UTF8.self)]
            try await center.add(UNNotificationRequest(identifier: delivery.identifier, content: content, trigger: nil))
        }
        removeDelivery = { ids in
            center.removePendingNotificationRequests(withIdentifiers: ids)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
        super.init(); center.delegate = self
    }
    private func configureActions() {
        guard let center else { return }
        center.setNotificationCategories([UNNotificationCategory(identifier: "MAGIC_WORK", actions: [
            UNNotificationAction(identifier: "VIEW", title: "查看", options: [.foreground])
        ], intentIdentifiers: [], options: [])])
    }
    // Collector used by native tests; it cannot reach the system notification center.
    init(send: @escaping (NoticeDelivery) async throws -> Void,
         status: @escaping () async -> UNAuthorizationStatus = { .authorized },
         request: @escaping () async throws -> Bool = { false },
         remove: @escaping ([String]) -> Void = { _ in }) {
        center = nil; sendDelivery = send; removeDelivery = remove
        statusProvider = status; requester = request; super.init()
    }

    /// 权限是**系统的状态**：这里没有 App 自己的「开没开」，投递门直接由系统授权决定。
    /// 静默送达（provisional）与正常允许都能投递，但只有后者弹横幅——两者必须分别显示。
    func refreshAuthorization() async {
        let status = await statusProvider()
        authorizationStatus = status
        let now = deliverable
        if now, !enabled { enabledSince = Date().timeIntervalSince1970 * 1000 }
        enabled = now
        switch status {
        case .authorized: authorization = "系统已允许"
        case .provisional: authorization = "系统静默送达：只进通知中心，不弹横幅"
        case .ephemeral: authorization = "系统临时允许（仅本次会话）"
        case .denied: authorization = "系统里还没允许"
        default: authorization = "尚未申请权限"
        }
    }
    /// **「提醒我」＝我们持有的偏好**（默认开，落在 App 的设置里）。与系统那一格**各说各的**：
    /// 系统拒绝时它仍可以是开——那是用户的意图本身，不必藏成什么「待兑现意图」。
    var preference = true
    /// 仅正在查看对应工作里的具体事项时不打断；列表或其他事项不抑制它。
    var userLooking: (String, String) -> Bool = { _, _ in false }
    /// 投递前通过现有 inspect 读取实际绑定；失败或服务换代返回空候选。
    var currentWorks: (([String]) async -> [NativeWork])?
    /// 投递门 = **我们想提醒**（偏好）**且**系统允许。两个条件各归各的主，谁也冒充不了谁。
    private var deliverable: Bool {
        preference && (authorizationStatus == .authorized || authorizationStatus == .provisional)
    }
    /// 偏好开、系统还没问过：候选先攒着，**第一次真要提醒时**再就地请求（不是首次启动）。
    private var awaitingRequest: Bool { preference && authorizationStatus == .notDetermined }
    func enableExplicitly() async -> Bool {
        let status = await statusProvider()
        do {
            if status == .notDetermined { enabled = try await requester() }
            else { enabled = status == .authorized || status == .provisional }
            if enabled { configureActions() }
            await refreshAuthorization()
            return enabled
        } catch { failure?(error.localizedDescription); return false }
    }
    func reconcile() async {
        // A reconnect establishes a watermark; it never replays offline notices.
        guard let center, let base else { return }
        let sent = await center.deliveredNotifications().map(\.request)
        let queued = await center.pendingNotificationRequests()
        let requests = sent + queued
        for request in requests {
            guard let route = Self.decodeRoute(request.content.userInfo),
                  URL(fileURLWithPath: route.base).resolvingSymlinksInPath().path == base else { continue }
            if let work = current[route.session], visibleReason(work)?.id == route.notice.id {
                displayed[route.session] = (request.identifier, route.notice.id)
            } else { removeDelivery([request.identifier]) }
        }
    }
    func prepare(base: String) {
        let base = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
        guard self.base != base else { return }
        disconnect(); self.base = base; seen = []
    }
    func disconnect() {
        timer?.cancel(); timer = nil; pending = [:]; current = [:]; serviceInstance = nil
        removeDelivery(displayed.values.map(\.identifier)); displayed = [:]
    }
    func beginConnection(_ projection: NativeProjection, identity: ServiceIdentity) {
        disconnect(); prepare(base: identity.base)
        serviceInstance = identity.serviceInstance
        current = Dictionary(uniqueKeysWithValues: projection.works.map { ($0.session, $0) })
        seen = Set(projection.works.compactMap { $0.currentNotice?.id })
    }
    private func visibleReason(_ work: NativeWork) -> AttentionItem? {
        guard !work.archived, !work.terminalOpen, let notice = work.currentNotice, notice.unread else { return nil }
        return notice
    }
    func observe(_ projection: NativeProjection, identity: ServiceIdentity) {
        guard projection.serviceInstance == identity.serviceInstance else { return }
        guard serviceInstance == identity.serviceInstance else { beginConnection(projection, identity: identity); return }
        current = Dictionary(uniqueKeysWithValues: projection.works.map { ($0.session, $0) })
        for (session, shown) in displayed where current[session].flatMap(visibleReason)?.id != shown.source {
            removeDelivery([shown.identifier]); displayed.removeValue(forKey: session)
        }
        pending = pending.filter { session, work in current[session].flatMap(visibleReason)?.id == work.currentNotice?.id }
        for work in projection.works {
            guard let notice = work.currentNotice else { continue }
            if notice.delivered || !notice.unread || work.archived { seen.insert(notice.id); continue }
            // A bound TUI suppresses delivery; its first departure can reveal an unpresented stop.
            if work.terminalOpen { continue }
            if userLooking(work.session, notice.id) { continue }
            guard seen.insert(notice.id).inserted, enabled || awaitingRequest, notice.at >= enabledSince else { continue }
            pending[work.session] = work
        }
        schedule(identity)
    }
    private func schedule(_ identity: ServiceIdentity) {
        guard timer == nil, !pending.isEmpty else { return }
        let acknowledge = delivered
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard let self else { return }
            defer { if self.serviceInstance == identity.serviceInstance { self.timer = nil; self.schedule(identity) } }
            if self.awaitingRequest { _ = await self.enableExplicitly() }
            guard !Task.isCancelled, self.serviceInstance == identity.serviceInstance else { return }
            guard self.enabled else { self.pending = [:]; return }
            let candidates = self.pending; self.pending = [:]
            let refreshed = await self.currentWorks?(Array(candidates.keys)) ?? Array(self.current.values)
            guard !Task.isCancelled, self.serviceInstance == identity.serviceInstance else { return }
            for work in refreshed {
                guard let notice = self.visibleReason(work), !notice.delivered,
                      candidates[work.session]?.currentNotice?.id == notice.id,
                      self.current[work.session].flatMap(self.visibleReason)?.id == notice.id,
                      !self.userLooking(work.session, notice.id) else { continue }
                let delivery = NoticeDelivery(work: work, notice: notice, identity: identity)
                let token = UUID(); self.deliveryTokens[delivery.identifier] = token
                do {
                    #if DEBUG
                    if self.deliveryAudit?(delivery) == false { self.failure?("系统验收尚未授权或已达到本轮次数上限"); continue }
                    #endif
                    try await self.sendDelivery(delivery)
                    guard !Task.isCancelled, self.serviceInstance == identity.serviceInstance,
                          self.current[work.session].flatMap(self.visibleReason)?.id == notice.id else {
                        if self.deliveryTokens[delivery.identifier] == token { self.removeDelivery([delivery.identifier]) }; continue
                    }
                    self.displayed[work.session] = (delivery.identifier, notice.id)
                    acknowledge?([notice.id])
                } catch { self.failure?("通知未送达：\(error.localizedDescription)") }
            }
        }
    }
    func removeNotifications(identifiers: [String]) { removeDelivery(identifiers) }
    nonisolated static func decodeRoute(_ info: [AnyHashable: Any]) -> NoticeRoute? {
        guard let json = info["route"] as? String else { return nil }
        return try? JSONDecoder().decode(NoticeRoute.self, from: Data(json.utf8))
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                           withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        Task { @MainActor in
            if response.actionIdentifier != UNNotificationDismissActionIdentifier, let route = Self.decodeRoute(info) { self.openRoute?(route) }
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                           withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }
}
