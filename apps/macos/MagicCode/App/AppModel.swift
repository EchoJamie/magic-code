import AppKit
import Combine
import ServiceManagement
import OSLog

@MainActor final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case starting, ready, stopping, fault(String)
        var text: String {
            switch self { case .starting: return "正在启动"; case .ready: return "核心已就绪"
            case .stopping: return "正在停止工作…"; case .fault(let reason): return reason }
        }
    }
    @Published var phase: Phase = .starting
    @Published private(set) var identity: ServiceIdentity?
    @Published private(set) var projection: NativeProjection?
    @Published private(set) var list = WorkList()
    @Published var selected: String?
    @Published private(set) var selectedNotice: AttentionItem?
    @Published var actionMessage: String?
    @Published var showQuitConfirmation = false
    @Published var stopTarget: NativeWork?
    @Published var notificationRoutes: [NoticeRoute] = []
    @Published var diagnosticsText = ""
    @Published var configPath = ""
    @Published var runtimeBase = ""
    @Published var loginStatus: SMAppService.Status = .notRegistered
    @Published var notificationsEnabled: Bool
    @Published var cliDirectory: String
    @Published var projectDirectory: URL?
    #if DEBUG
    @Published private(set) var systemTestAuthorization = Set<String>()
    #endif
    @Published private(set) var selectedBase: URL?
    let appURL: URL
    let helperURL: URL
    let userHome: URL
    let isValidation: Bool
    let isDevelopment: Bool
    let publication: HostPublication
    let terminal: TerminalLauncher
    let notifications: NotificationCoordinator
    var removeCLILink: (URL, URL) throws -> Void = { try CLIInstallation.remove(link: $0, helper: $1) }
    private let defaults: UserDefaults
    private var host: HostProcess?
    private var observer: ObserverConnection?
    private var hostInstance = UUID().uuidString
    private var hostStopped = false
    private var shutdownRequest: String?
    private var automaticRecoveryUsed = false
    /// 用户在 App 内明确点过「开」、只因系统拒绝而未兑现的意图（只在本次运行内有效：
    /// 不回写默认值，避免久后被一次无关的系统权限变化自动带开）。
    private var pendingNotificationsIntent = false
    private var acquired = false
    private var panelVisible = false
    private var pendingInspections: [String: (session: String, open: Bool, notice: String?)] = [:]
    private var stoppingRequests: [String: String] = [:]
    private var switchBase: URL?
    private var switching = false
    private var startupTimeout: Task<Void, Never>?
    private var stopTimeout: Timer?
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var notificationGeneration: String?
    private var deferredNoticeRoutes: [NoticeRoute] = []
    private var cleanExit: (() -> Void)?
    private var removingIntegration = false
    private let shutdownTimeout: TimeInterval
    private let expectedVersion: String
    private let expectedProtocol: Int
    private var tokens: [NSObjectProtocol] = []
    private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "dev.magic-code", category: "runtime")

    init(appURL: URL = Bundle.main.bundleURL, validationRoot: URL? = nil,
         notificationPort: NotificationCoordinator? = nil, shutdownTimeout: TimeInterval = 15) {
        self.appURL = appURL
        self.shutdownTimeout = shutdownTimeout
        let bundle = Bundle(url: appURL) ?? Bundle.main
        expectedVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        expectedProtocol = bundle.object(forInfoDictionaryKey: "MagicProtocolVersion") as? Int ?? 1
        helperURL = appURL.appendingPathComponent("Contents/Helpers/magic-runtime").resolvingSymlinksInPath()
        isValidation = validationRoot != nil
        isDevelopment = (bundle.bundleIdentifier ?? "com.magiccode.app.dev").hasSuffix(".dev")
        userHome = validationRoot ?? FileManager.default.homeDirectoryForCurrentUser
        defaults = validationRoot.map { UserDefaults(suiteName: "MagicCode.Validation.\($0.lastPathComponent)")! } ?? .standard
        if let validationRoot { selectedBase = validationRoot }
        else if isDevelopment {
            // Development never silently reads the user's production Magic data.
            selectedBase = ProcessInfo.processInfo.environment["MAGIC_HOME"].map { URL(fileURLWithPath: $0) }
                ?? defaults.string(forKey: "baseDirectory").map { URL(fileURLWithPath: $0) }
                ?? FileManager.default.temporaryDirectory.appendingPathComponent("MagicCode-Dev-\(UUID().uuidString)")
        } else { selectedBase = defaults.string(forKey: "baseDirectory").map { URL(fileURLWithPath: $0) } }
        cliDirectory = defaults.string(forKey: "cliDirectory") ?? userHome.appendingPathComponent(".local/bin").path
        notificationsEnabled = validationRoot == nil && defaults.bool(forKey: "notificationsEnabled")
        let support = userHome.appendingPathComponent("Library/Application Support/\(isDevelopment ? "Magic Code Dev" : "Magic Code")/runtime")
        publication = HostPublication(directory: support)
        terminal = TerminalLauncher(directory: support.appendingPathComponent("terminal"))
        notifications = notificationPort ?? NotificationCoordinator()
        notifications.enabled = notificationsEnabled
        if let since = defaults.object(forKey: "notificationsEnabledSince") as? Double { notifications.enabledSince = since }
        notifications.delivered = { [weak self] ids in self?.observer?.send(.delivered(ids: ids)) }
        notifications.failure = { [weak self] text in self?.actionMessage = text }
        notifications.openRoutes = { [weak self] routes in
            guard let self else { return }
            NSApp?.activate(ignoringOtherApps: true)
            if !self.isCurrent { self.deferredNoticeRoutes += routes; return }
            if routes.count == 1, let route = routes.first { self.openNotification(route) }
            else { self.notificationRoutes = routes; self.actionMessage = "请在通知事项窗口选择要查看的工作"; self.showNotificationWindow?() }
        }
        #if DEBUG
        if let validationRoot {
            terminal.validationHome = validationRoot
            terminal.validationEvent = { [weak self] event, detail in self?.validationEvent(event, detail: detail) }
        }
        if let root = systemTestRoot {
            refreshSystemTestAuthorization()
            notificationsEnabled = systemTestAuthorization.contains("notifications") && defaults.bool(forKey: "notificationsEnabled")
            notifications.enabled = notificationsEnabled
            notifications.deliveryAudit = { [weak self] delivery in
                guard let self else { return false }; self.refreshSystemTestAuthorization()
                guard self.systemTestAuthorization.contains("notifications") else { return false }
                let file = root.appendingPathComponent("system-notification-requests.json")
                var requests = (try? JSONSerialization.jsonObject(with: Data(contentsOf: file))) as? [[String: Any]] ?? []
                guard requests.count < 5 else { return false }
                requests.append(["identifier": delivery.identifier, "title": delivery.title, "body": delivery.body,
                                 "ids": delivery.ids, "at": Date().timeIntervalSince1970])
                do { try PrivateFiles.write(JSONSerialization.data(withJSONObject: requests, options: [.prettyPrinted, .sortedKeys]), to: file); return true }
                catch { self.actionMessage = error.localizedDescription; return false }
            }
            // Only the explicitly installed fixture substitutes the Terminal port.
            if FileManager.default.fileExists(atPath: appURL.appendingPathComponent("Contents/Resources/controlled-helper.py").path) {
                terminal.copyText = { [weak self] text in self?.validationEvent("system-test.copy", detail: text) }
                terminal.openFile = { [weak self] file, completion in
                    self?.validationEvent("system-test.terminal-request", detail: file.path); completion(nil)
                }
            }
        }
        #endif
    }
    var showNotificationWindow: (() -> Void)?
    var onUnconfirmedShutdown: (() -> Void)?
    var affected: [NativeWork] { projection?.works.filter(\.affected) ?? [] }
    var works: [NativeWork] { projection?.works ?? [] }
    var isCurrent: Bool { phase == .ready && projection != nil }
    var symbol: String {
        if case .fault = phase { return "exclamationmark.circle" }
        if works.contains(where: { WorkGroup.of($0) == .needsYou || WorkGroup.of($0) == .uncertain }) { return "sparkles.rectangle.stack.fill" }
        return works.contains(where: { $0.affected }) ? "sparkles.square.filled.on.square" : "sparkles"
    }
    var summary: String {
        guard isCurrent else { return phase.text }
        if affected.isEmpty { return "当前没有进行中的工作" }
        let running = works.filter { $0.state == .running || $0.state == .stopping }.count
        let waiting = works.filter { $0.state == .waiting }.count
        return "\(running) 项执行中，\(waiting) 项需要你"
    }

    func start() {
        guard host == nil else { return }
        do {
            if !acquired { try publication.acquire(); acquired = true }
            if let selectedBase { try FileManager.default.createDirectory(at: selectedBase, withIntermediateDirectories: true) }
            terminal.cleanupExpired()
            startHost()
            if !isValidation {
                refreshLogin()
                tokens.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.refreshAfterWake() }
                })
                tokens.append(NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.presence(focused: false) }
                })
            }
            // 回到前台：核对系统授权，并在用户先前明确点过「开」而当时被系统拒绝时兑现它。
            // 验收身份下也要跑（不在 !isValidation 里），否则验收环境无法覆盖这条路径。
            tokens.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    if !self.isValidation { self.refreshLogin(); self.presence(focused: true) }
                    await self.completePendingNotificationIntent()
                }
            })
        } catch { phase = .fault(error.localizedDescription) }
    }
    private func startHost() {
        phase = .starting; identity = nil; notificationGeneration = nil; hostStopped = false; shutdownRequest = nil
        reconnectTask?.cancel(); reconnectAttempts = 0
        hostInstance = UUID().uuidString
        let instance = hostInstance
        let process = HostProcess(); host = process
        process.received = { [weak self] message in
            guard let self, self.hostInstance == instance else { return }; self.receiveHost(message)
        }
        process.exited = { [weak self] code in
            guard let self, self.hostInstance == instance else { return }; self.hostExited(code)
        }
        process.diagnostic = { [weak self] text in self?.recordDiagnostic(text) }
        var environment = ProcessInfo.processInfo.environment
        if isValidation { environment = ["HOME": userHome.path, "PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh", "LANG": "en_US.UTF-8"] }
        do {
            var manager = helperURL
            #if DEBUG
            let fixture = appURL.appendingPathComponent("Contents/Resources/controlled-helper.py")
            if systemTestRoot != nil, FileManager.default.fileExists(atPath: fixture.path) { manager = fixture }
            #endif
            try process.start(helper: manager, app: appURL, instance: instance, base: selectedBase, home: userHome, environment: environment)
            startupTimeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(20)) } catch { return }
                guard let self, self.phase == .starting else { return }
                self.phase = .fault("核心启动超时。请查看诊断后重试。")
                self.host?.closeLifetime()
            }
        } catch { host = nil; phase = .fault("核心未能启动：\(error.localizedDescription)") }
    }
    private func receiveHost(_ response: HostResponse) {
        validationEvent("host.response", detail: String(describing: response))
        switch response {
        case .ready(let identity, let socket, let base, let config):
            guard identity.hostInstance == hostInstance,
                  identity.protocol == expectedProtocol,
                  identity.version == expectedVersion,
                  URL(fileURLWithPath: identity.source).resolvingSymlinksInPath() == helperURL else {
                phase = .fault("内置核心与 App 的身份或版本不匹配"); host?.closeLifetime(); return
            }
            self.identity = identity; runtimeBase = base; configPath = config
            do {
                try publication.publish(HostDiscovery(identity: identity, socket: socket, base: base, app: appURL.path))
                connectObserver(socket: socket, identity: identity)
            } catch { phase = .fault(error.localizedDescription); host?.closeLifetime() }
        case .stopped(let request):
            if shutdownRequest == nil || request == shutdownRequest { hostStopped = true }
        case .error(let reason):
            phase = .fault(reason); recordDiagnostic(reason)
            if shutdownRequest != nil { onUnconfirmedShutdown?() }
        }
    }
    private func connectObserver(socket: String, identity: ServiceIdentity) {
        observer?.close()
        let connection = ObserverConnection(); observer = connection
        connection.receive = { [weak self, weak connection] response in
            guard let self, self.observer === connection else { return }; self.receive(response)
        }
        connection.disconnected = { [weak self, weak connection] reason in
            guard let self, self.observer === connection, self.shutdownRequest == nil else { return }
            self.phase = .fault(reason)
            guard self.reconnectAttempts < 3, self.host?.process.isRunning == true else { return }
            self.reconnectAttempts += 1
            self.reconnectTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self, self.shutdownRequest == nil else { return }
                self.connectObserver(socket: socket, identity: identity)
            }
        }
        connection.connect(path: socket, identity: identity)
    }
    private func receive(_ response: NativeResponse) {
        switch response {
        case .welcome(let received, let projection):
            guard received == identity, projection.serviceInstance == received.serviceInstance else {
                phase = .fault("连接的核心身份已改变"); observer?.close(); return
            }
            startupTimeout?.cancel(); reconnectAttempts = 0
            apply(projection)
            // A valid handshake restores the connection even when its snapshot is unchanged.
            if shutdownRequest == nil, let current = self.projection { phase = current.accepting ? .ready : .stopping }
            notifications.prepare(dataDir: received.dataDir)
            Task {
                await notifications.reconcile()
                guard self.identity == received else { return }
                notificationGeneration = received.serviceInstance
                if let current = self.projection { notifications.observe(current, identity: received) }
                if deferredNoticeRoutes.count == 1, let route = deferredNoticeRoutes.first { openNotification(route) }
                else if !deferredNoticeRoutes.isEmpty { notificationRoutes = deferredNoticeRoutes; showNotificationWindow?() }
                deferredNoticeRoutes = []
            }
        case .projection(let projection): apply(projection)
        case .inspected(let request, let work, let error):
            guard let intent = pendingInspections.removeValue(forKey: request) else { return }
            guard let work, work.session == intent.session else { actionMessage = error ?? "该会话已不可达"; return }
            let notice = intent.notice.flatMap { id in work.notices.first { $0.id == id && $0.session == intent.session } }
            guard intent.notice == nil || notice != nil else { actionMessage = "这条事项已不可达，请刷新后查看。"; return }
            selected = work.id
            selectedNotice = notice
            if let notice, notice.unread { observer?.send(.read(ids: [notice.id])) }
            presence(focused: panelVisible && NSApp?.isActive == true)
            if intent.open { launch(work) }
        case .stopped(let request, let session, let phase, let note):
            guard stoppingRequests[request] == session else { return }
            actionMessage = note ?? (phase == .accepted ? "正在停止任务…" : phase == .done ? "任务已停止" : "尚未确认停止，请查看当前状态")
            if phase != .accepted { stoppingRequests.removeValue(forKey: request) }
            observer?.send(.refresh)
        case .attached(let request, let session):
            if terminal.attached(request: request, session: session) {
                validationEvent("terminal.attached", detail: "request=\(request), session=\(session ?? "null")")
            }
        case .error(let reason): phase = .fault(reason)
        }
    }
    private func apply(_ value: NativeProjection) {
        guard value.serviceInstance == identity?.serviceInstance else { return }
        if let old = projection, old.serviceInstance == value.serviceInstance, old.revision >= value.revision { return }
        projection = value
        list.update(value.works, interacting: panelVisible)
        if shutdownRequest == nil { phase = value.accepting ? .ready : .stopping }
        if let identity, notificationGeneration == identity.serviceInstance { notifications.observe(value, identity: identity) }
    }
    private func hostExited(_ code: Int32) {
        validationEvent("host.exited", detail: "\(code), stopped=\(hostStopped), request=\(shutdownRequest ?? "none")")
        // Once host is nil this flag proves both the acknowledgement and successful exit.
        hostStopped = hostStopped && code == 0
        startupTimeout?.cancel(); reconnectTask?.cancel(); observer?.close(); observer = nil; host = nil
        publication.remove(host: hostInstance)
        if shutdownRequest != nil {
            stopTimeout?.invalidate()
            guard code == 0, hostStopped else {
                phase = .fault("服务已退出，但尚未确认所有工作都已停止。请保留诊断。")
                onUnconfirmedShutdown?(); return
            }
            if switching {
                selectedBase = switchBase; defaults.set(selectedBase?.path, forKey: "baseDirectory")
                switching = false; switchBase = nil; automaticRecoveryUsed = false; startHost()
            } else { finishQuit() }
        } else if !automaticRecoveryUsed {
            automaticRecoveryUsed = true; recordDiagnostic("核心异常退出（\(code)），核对后恢复服务一次；不重跑旧工作。")
            startHost()
        } else { phase = .fault("核心恢复失败（退出码 \(code)）。请查看诊断并重试。") }
    }
    func retry() {
        if shutdownRequest != nil { confirmQuit(); return }
        if host?.process.isRunning == true { refreshAfterWake(); return }
        automaticRecoveryUsed = false; start()
    }
    func refreshAfterWake() {
        guard shutdownRequest == nil else { return }
        if let identity, let data = try? Data(contentsOf: publication.file), let discovery = try? JSONDecoder().decode(HostDiscovery.self, from: data), discovery.hostInstance == hostInstance {
            phase = .starting; connectObserver(socket: discovery.socket, identity: identity)
        } else { observer?.send(.refresh) }
    }
    func requestQuit(onClean: @escaping () -> Void) {
        cleanExit = onClean
        if shutdownRequest != nil { confirmQuit(); return }
        if host == nil { finishQuit(); return }
        if !affected.isEmpty || !isCurrent { showQuitConfirmation = true }
        else { confirmQuit() }
    }
    func confirmQuit() {
        showQuitConfirmation = false
        guard host?.process.isRunning == true else {
            if host == nil, hostStopped { finishQuit(); return }
            phase = .fault("服务已退出，但工作停止尚未确认。请保留诊断；不会重启旧工作。")
            onUnconfirmedShutdown?()
            return
        }
        phase = .stopping; presence(focused: false)
        // Retrying is the same stop responsibility. Never reopen admission or start a host.
        let request = shutdownRequest ?? UUID().uuidString; shutdownRequest = request
        validationEvent("stop.requested", detail: request)
        stopTimeout?.invalidate()
        host?.shutdown(request: request)
        let timer = Timer(timeInterval: shutdownTimeout, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.host != nil else { return }
                self.phase = .fault("收尾尚未确认，App 保持打开。请查看诊断；工作可能仍在停止。")
                self.onUnconfirmedShutdown?()
            }
        }
        stopTimeout = timer
        RunLoop.main.add(timer, forMode: .common)
        RunLoop.main.add(timer, forMode: MainRunLoop.modal)
    }
    func cancelQuit() { showQuitConfirmation = false; removingIntegration = false; cleanExit = nil }
    func systemQuit(onClean: @escaping () -> Void) {
        cleanExit = onClean
        if host == nil && shutdownRequest == nil { finishQuit() } else { confirmQuit() }
    }
    func stop(_ work: NativeWork) {
        guard isCurrent, let gen = work.gen, let service = identity?.serviceInstance else { return }
        let request = UUID().uuidString; stoppingRequests[request] = work.session
        observer?.send(.stop(request: request, serviceInstance: service, session: work.session, gen: gen))
    }
    func panelVisibility(_ visible: Bool) {
        panelVisible = visible; list.update(works, interacting: visible)
        presence(focused: visible && NSApp?.isActive == true)
    }
    func inspect(_ work: NativeWork, open: Bool = false, notice: String? = nil) {
        guard isCurrent else { actionMessage = "状态尚未核对，请重试连接。"; return }
        presence(focused: false)
        let request = UUID().uuidString
        pendingInspections[request] = (work.session, open, notice)
        observer?.send(.inspect(request: request, session: work.session, notice: notice))
    }
    private func presence(focused: Bool) {
        guard let selected, let work = works.first(where: { $0.id == selected }) else { return }
        observer?.send(.presence(session: selected, ids: work.notices.map(\.id), focused: focused && panelVisible))
    }
    private func launch(_ work: NativeWork) {
        terminal.open(helper: helperURL, workspace: work.workspace.first.map { URL(fileURLWithPath: $0) } ?? userHome, base: selectedBase, session: work.session)
    }
    func newTerminal() {
        guard isCurrent else { actionMessage = "核心尚未就绪"; return }
        terminal.open(helper: helperURL, workspace: projectDirectory ?? userHome, base: selectedBase, session: nil)
    }
    func copyCommand(_ work: NativeWork) {
        terminal.copy(TerminalCommand.make(helper: helperURL, workspace: work.workspace.first.map { URL(fileURLWithPath: $0) } ?? userHome,
                                          base: selectedBase, session: work.session, request: nil))
    }
    func openNotification(_ route: NoticeRoute) {
        guard isCurrent else { deferredNoticeRoutes.append(route); return }
        guard route.dataDir == identity?.dataDir else {
            actionMessage = "此通知属于另一数据位置：\(route.dataDir)。请在设置中明确切换后查看。"; showNotificationWindow?(); return
        }
        let request = UUID().uuidString
        pendingInspections[request] = (route.session, true, route.ids.first)
        observer?.send(.inspect(request: request, session: route.session, notice: route.ids.first))
    }
    func changeBase(_ base: URL?) {
        guard isCurrent, affected.isEmpty else { actionMessage = "仍有在途工作或状态待确认，无法切换数据目录。"; return }
        switching = true; switchBase = base; confirmQuit()
    }
    /// 只有「系统允许」与「系统静默送达」都算用户已选择启用通知；两者的区别在状态文案里。
    func setNotifications(_ value: Bool) async {
        guard canChangeNotifications else { return }
        if value {
            notificationsEnabled = await notifications.enableExplicitly()
            if notificationsEnabled {
                notifications.enabledSince = Date().timeIntervalSince1970 * 1000
                defaults.set(notifications.enabledSince, forKey: "notificationsEnabledSince")
                pendingNotificationsIntent = false
            } else {
                // 用户在这里明确要开、只因系统拒绝而没兑现：记住这个意图，
                // 等他去系统设置放行、回到 App 时补上，而不是让他再点一次。
                pendingNotificationsIntent = true
            }
        }
        else { notificationsEnabled = false; notifications.enabled = false; pendingNotificationsIntent = false }
        defaults.set(notificationsEnabled, forKey: "notificationsEnabled")
    }
    /// 回到前台时兑现「上次明确要开、被系统拒了」的意图；系统权限自己变化不在此列。
    func completePendingNotificationIntent() async {
        guard canChangeNotifications, pendingNotificationsIntent else { return }
        await notifications.refreshAuthorization()
        let status = notifications.authorizationStatus
        guard status == .authorized || status == .provisional else { return }
        pendingNotificationsIntent = false
        await setNotifications(true)
    }
    var canChangeNotifications: Bool {
        #if DEBUG
        if isValidation { return systemTestRoot != nil && systemTestAuthorization.contains("notifications") }
        #endif
        return !isValidation
    }
    var canChangeLogin: Bool {
        #if DEBUG
        if isValidation { return systemTestRoot != nil && systemTestAuthorization.contains("login") }
        #endif
        return !isValidation
    }
    func refreshLogin() {
        #if DEBUG
        if systemTestRoot != nil { loginStatus = SMAppService.mainApp.status; return }
        #endif
        if !isValidation { loginStatus = SMAppService.mainApp.status }
    }
    func setLogin(_ value: Bool) {
        guard canChangeLogin else { return }
        do { if value { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }; refreshLogin() }
        catch { actionMessage = error.localizedDescription; refreshLogin() }
    }
    func installCLI() {
        do {
            try CLIInstallation.install(helper: helperURL, at: URL(fileURLWithPath: cliDirectory).appendingPathComponent("magic"), app: appURL)
            defaults.set(cliDirectory, forKey: "cliDirectory"); actionMessage = "终端命令已安装：\(cliDirectory)/magic"
        } catch { actionMessage = error.localizedDescription }
    }
    func uninstallIntegration(onQuitRequest: () -> Void = { NSApp.terminate(nil) }) {
        removingIntegration = true
        onQuitRequest()
    }
    private func finishQuit() {
        do {
            if removingIntegration {
                if !isValidation, [.enabled, .requiresApproval].contains(SMAppService.mainApp.status) { try SMAppService.mainApp.unregister() }
                try removeCLILink(URL(fileURLWithPath: cliDirectory).appendingPathComponent("magic"), helperURL)
            }
            validationEvent("app.clean-exit", detail: "")
            cleanExit?()
        } catch { phase = .fault("工作已停止，但系统集成移除失败：\(error.localizedDescription)"); onUnconfirmedShutdown?() }
    }
    private func recordDiagnostic(_ text: String) {
        diagnosticsText = String((diagnosticsText + text + "\n").suffix(32768))
        log.error("\(text, privacy: .private)")
    }
    func validationEvent(_ event: String, detail: String) {
        #if DEBUG
        guard isValidation else { return }
        if let data = try? JSONSerialization.data(withJSONObject: ["event": event, "detail": detail]) {
            FileHandle.standardOutput.write(data + Data([10]))
        }
        #endif
    }
}

#if DEBUG
extension AppModel {
    static func systemTestRoot(bundle: Bundle) -> URL? {
        guard let id = bundle.bundleIdentifier, id.hasPrefix("com.magiccode.validation."), id.hasSuffix(".dev"),
              let path = bundle.object(forInfoDictionaryKey: "MagicSystemTestRoot") as? String else { return nil }
        let root = URL(fileURLWithPath: path)
        let resolved = root.resolvingSymlinksInPath()
        guard ["/tmp", "/private/tmp"].contains(resolved.deletingLastPathComponent().path), resolved.lastPathComponent.hasPrefix("magic-system-test-") else { return nil }
        return root
    }
    var systemTestRoot: URL? { Bundle(url: appURL).flatMap { Self.systemTestRoot(bundle: $0) } }
    func refreshSystemTestAuthorization() {
        guard let root = systemTestRoot else { return }
        let json = (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("system-authorization.json")))) as? [String: Any]
        let allowed = json?["bundle"] as? String == Bundle(url: appURL)?.bundleIdentifier ? Set(json?["allow"] as? [String] ?? []) : []
        if systemTestAuthorization != allowed { systemTestAuthorization = allowed }
        if !allowed.contains("notifications") { notifications.enabled = false; notificationsEnabled = false }
    }
    func writeSystemTestState() async {
        guard let root = systemTestRoot else { return }
        refreshSystemTestAuthorization(); refreshLogin(); await notifications.refreshAuthorization()
        let value: [String: Any] = ["bundle": Bundle(url: appURL)?.bundleIdentifier ?? "", "root": root.path,
            "phase": String(describing: phase), "isCurrent": isCurrent,
            "hostInstance": identity?.hostInstance ?? "", "serviceInstance": identity?.serviceInstance ?? "",
            "revision": projection?.revision ?? -1, "selectedSession": selected ?? "", "selectedNotice": selectedNotice?.id ?? "",
            "loginStatus": loginStatus.rawValue, "loginWritesAllowed": canChangeLogin,
            "notificationAuthorization": notifications.authorization, "notificationWritesAllowed": canChangeNotifications,
            "notificationPreference": notificationsEnabled,
            "notificationAuthorizationStatus": String(describing: notifications.authorizationStatus),
            "notificationsPendingIntent": pendingNotificationsIntent]
        try? PrivateFiles.write(JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), to: root.appendingPathComponent("system-state.json"))
    }
    func restoreSystemTestNotifications() async {
        guard let root = systemTestRoot, canChangeNotifications else { return }
        await setNotifications(false)
        let requests = (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("system-notification-requests.json")))) as? [[String: Any]] ?? []
        notifications.removeNotifications(identifiers: requests.compactMap { $0["identifier"] as? String })
        await writeSystemTestState()
    }
}
#endif
