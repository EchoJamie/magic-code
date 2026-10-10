import Foundation
import UserNotifications

struct NoticeRoute: Codable, Equatable {
    let base: String
    let session: String
    let ids: [String]
    let facts: [String]
}
struct NoticeDelivery: Equatable {
    let identifier: String
    let title: String
    let subtitle: String
    let body: String
    let routes: [NoticeRoute]
    var ids: [String] { routes.flatMap(\.ids) }
}

/// Pure two-second batch policy; the service owns delivered/read persistence.
struct NoticeBatch {
    private(set) var pending: [String: (NativeWork, AttentionItem)] = [:]
    mutating func add(work: NativeWork, notice: AttentionItem) { pending[notice.id] = (work, notice) }
    mutating func retain(_ ids: Set<String>) { pending = pending.filter { ids.contains($0.key) } }
    mutating func remove(_ ids: Set<String>) { pending = pending.filter { !ids.contains($0.key) } }
    mutating func take(base: String) -> [NoticeDelivery] {
        let base = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
        defer { pending.removeAll() }
        let rows = Dictionary(grouping: pending.values, by: { $0.0.session })
        var urgent: [NoticeDelivery] = []
        var completed: [(NativeWork, AttentionItem)] = []
        for session in rows.keys.sorted() {
            let notices = rows[session]!.sorted { $0.1.at < $1.1.at }
            let important = notices.filter { $0.1.kind != .done }
            if let last = important.last {
                urgent.append(NoticeDelivery(identifier: "work:\(base):\(session)", title: last.0.title,
                    subtitle: last.0.project, body: last.1.kind == .needsYou ? "需要你的答复，请在终端查看" : "工作遇到问题，请查看当前状态",
                    routes: [NoticeRoute(base: base, session: session, ids: notices.map { $0.1.id }, facts: notices.map { $0.1.fact })]))
            } else { completed += notices }
        }
        if completed.count == 1, let one = completed.first {
            urgent.append(NoticeDelivery(identifier: "fact:\(one.1.id)", title: one.0.title, subtitle: one.0.project,
                body: "结果已可查看", routes: [NoticeRoute(base: base, session: one.0.session, ids: [one.1.id], facts: [one.1.fact])]))
        } else if !completed.isEmpty {
            let routes = Dictionary(grouping: completed, by: { $0.0.session }).keys.sorted().map { session in
                let rows = completed.filter { $0.0.session == session }
                return NoticeRoute(base: base, session: session, ids: rows.map { $0.1.id }, facts: rows.map { $0.1.fact })
            }
            urgent.append(NoticeDelivery(identifier: "results:\(completed.map { $0.1.id }.sorted().joined(separator: ":"))",
                title: "\(routes.count) 项工作有新结果", subtitle: "Magic Code", body: "打开查看工作与结果", routes: routes))
        }
        return urgent
    }
}

@MainActor final class NotificationCoordinator: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published private(set) var authorization = "未启用"
    @Published private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    var enabled = false
    var enabledSince = Date().timeIntervalSince1970 * 1000 - 2000
    var delivered: (([String]) -> Void)?
    var openRoutes: (([NoticeRoute]) -> Void)?
    var failure: ((String) -> Void)?
    #if DEBUG
    var deliveryAudit: ((NoticeDelivery) -> Bool)?
    #endif
    private var seen = Set<String>()
    private var batch = NoticeBatch()
    private var timer: Task<Void, Never>?
    private var base: String?
    private var serviceInstance: String?
    private let center: UNUserNotificationCenter?
    private let sendDelivery: (NoticeDelivery) async throws -> Void
    private let existingIDs: (String) async -> [String]
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
            content.userInfo = ["routes": String(decoding: try JSONEncoder().encode(delivery.routes), as: UTF8.self)]
            try await center.add(UNNotificationRequest(identifier: delivery.identifier, content: content, trigger: nil))
        }
        existingIDs = { base in
            let sent = await center.deliveredNotifications().map(\.request)
            let pending = await center.pendingNotificationRequests()
            return (sent + pending).flatMap { Self.decodeRoutes($0.content.userInfo).filter { URL(fileURLWithPath: $0.base).resolvingSymlinksInPath().path == base }.flatMap(\.ids) }
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
    init(send: @escaping (NoticeDelivery) async throws -> Void, existing: @escaping (String) async -> [String] = { _ in [] },
         status: @escaping () async -> UNAuthorizationStatus = { .authorized },
         request: @escaping () async throws -> Bool = { false }) {
        center = nil; sendDelivery = send; existingIDs = existing
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
        guard enabled, let base else { return }
        let acknowledge = delivered
        let ids = await existingIDs(base)
        guard self.base == base else { return }
        seen.formUnion(ids); batch.remove(Set(ids)); if !ids.isEmpty { acknowledge?(ids) }
    }
    func prepare(base: String) {
        let base = URL(fileURLWithPath: base).resolvingSymlinksInPath().path
        guard self.base != base else { return }
        timer?.cancel(); timer = nil; batch = NoticeBatch(); seen = []; self.base = base
    }
    func disconnect() {
        timer?.cancel(); timer = nil; batch = NoticeBatch(); serviceInstance = nil
    }
    func beginConnection(_ projection: NativeProjection, identity: ServiceIdentity) {
        disconnect(); prepare(base: identity.base)
        serviceInstance = identity.serviceInstance
        seen = Set(projection.works.flatMap { $0.notices.map(\.id) })
    }
    func observe(_ projection: NativeProjection, identity: ServiceIdentity) {
        prepare(base: identity.base)
        if serviceInstance != nil, serviceInstance != identity.serviceInstance {
            timer?.cancel(); timer = nil; batch = NoticeBatch(); seen = []
        }
        serviceInstance = identity.serviceInstance
        retainCandidates(projection.works)
        for work in projection.works {
            for notice in work.notices {
                if notice.delivered || !notice.unread { seen.insert(notice.id); continue }
                if work.terminalNoticeIds?.contains(notice.id) == true { continue }
                // 仅抑制正在查看的具体事项。不记 seen，离开后仍可提醒。
                if userLooking(work.session, notice.id) { continue }
                guard seen.insert(notice.id).inserted else { continue }
                // The enable date is a preference, not a second notice ledger. Persisted
                // delivered facts and system requests cover restarts across the 2s window.
                guard enabled || awaitingRequest, notice.at >= enabledSince else { continue }
                batch.add(work: work, notice: notice)
            }
        }
        schedule(identity)
    }
    private func schedule(_ identity: ServiceIdentity) {
        guard enabled || awaitingRequest, timer == nil, !batch.pending.isEmpty else { return }
        let acknowledge = delivered
        timer = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard let self else { return }
            defer {
                if self.serviceInstance == identity.serviceInstance {
                    self.timer = nil
                    self.schedule(identity)
                }
            }
            // 真有该告诉你的事、而系统还没问过 ⇒ 就在这一刻问（系统框只在第一次调用时出现）。
            if self.awaitingRequest { _ = await self.enableExplicitly() }
            guard !Task.isCancelled, self.serviceInstance == identity.serviceInstance else { return }
            guard self.enabled else { self.batch = NoticeBatch(); return }
            // 刷新期间到达的新事项留给下一批，不被这次查询的会话集合吞掉。
            var candidates = self.batch
            self.batch = NoticeBatch()
            if let currentWorks = self.currentWorks {
                let sessions = Array(Set(candidates.pending.values.map { $0.0.session }))
                let works = await currentWorks(sessions)
                guard !Task.isCancelled, self.base == URL(fileURLWithPath: identity.base).resolvingSymlinksInPath().path,
                      self.serviceInstance == identity.serviceInstance else { return }
                let eligible = self.candidateIDs(works)
                self.seen.subtract(Set(candidates.pending.keys).subtracting(eligible))
                candidates.retain(eligible)
            }
            for delivery in candidates.take(base: identity.base) {
                guard !Task.isCancelled, self.serviceInstance == identity.serviceInstance else { return }
                do {
                    #if DEBUG
                    if self.deliveryAudit?(delivery) == false { self.failure?("系统验收尚未授权或已达到本轮次数上限"); continue }
                    #endif
                    try await self.sendDelivery(delivery)
                    acknowledge?(delivery.ids)
                } catch { self.failure?("通知未送达：\(error.localizedDescription)") }
            }
        }
    }
    private func candidateIDs(_ works: [NativeWork]) -> Set<String> {
        Set(works.flatMap { work in
            work.notices.filter { $0.unread && !$0.delivered &&
                work.terminalNoticeIds?.contains($0.id) != true && !userLooking(work.session, $0.id)
            }.map(\.id)
        })
    }
    private func retainCandidates(_ works: [NativeWork]) {
        let eligible = candidateIDs(works)
        // 连接只决定提醒去向；尚未呈现的事项离开终端后仍可提醒。
        seen.subtract(Set(batch.pending.keys).subtracting(eligible))
        batch.retain(eligible)
    }
    func removeNotifications(identifiers: [String]) {
        center?.removePendingNotificationRequests(withIdentifiers: identifiers)
        center?.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
    static func decodeRoutes(_ info: [AnyHashable: Any]) -> [NoticeRoute] {
        guard let json = info["routes"] as? String else { return [] }
        return (try? JSONDecoder().decode([NoticeRoute].self, from: Data(json.utf8))) ?? []
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                           withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        Task { @MainActor in
            let routes = Self.decodeRoutes(info)
            if !routes.isEmpty { self.openRoutes?(routes) }
            completionHandler()
        }
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                           withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner])
    }
}
