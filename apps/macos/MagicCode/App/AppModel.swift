import AppKit
import Combine
import ServiceManagement

@MainActor final class AppModel: ObservableObject {
    enum Phase: Equatable {
        case starting, ready, stopping, fault(String)
        var text: String {
            switch self { case .starting: return "正在启动"; case .ready: return "核心已就绪"
            case .stopping: return "正在停止工作…"; case .fault(let reason): return reason }
        }
    }
    @Published private(set) var settingsSnapshot: SettingsSnapshot?
    @Published private(set) var settingsBusy = false
    @Published private(set) var settingsError: String?
    @Published private(set) var settingsNote: String?
    @Published private(set) var settingsSavedKey: String?
    @Published var settingsCategory = "models"
    private var queuedSettingsPreview: SettingsValue?
    private var settingsRequests: [String: (identity: ServiceIdentity, key: String?)] = [:]
    @Published var phase: Phase = .starting
    @Published private(set) var identity: ServiceIdentity?
    @Published private(set) var projection: NativeProjection?
    @Published private(set) var list = WorkList()
    @Published private(set) var selected: String?
    @Published private(set) var selectedNotice: AttentionItem?
    private var visibleNoticeID: String?
    @Published var actionMessage: String?
    @Published var showQuitConfirmation = false
    struct StopTarget { let work: NativeWork; let identity: ServiceIdentity }
    @Published var stopTarget: StopTarget?
    @Published var notificationRoutes: [NoticeRoute] = []
    @Published private(set) var diagnostics = Diagnostics.defaults
    @Published private(set) var logDirectory = ""
    @Published private(set) var logProblem: String?
    @Published private(set) var debugWindowVisible = false
    var diagnosticsArguments: [String] = []
    var showDebugWindow: (() -> Void)?
    var hideDebugWindow: (() -> Void)?
    private let fileLog = DiagnosticFileLog()
    @Published var configPath = ""
    @Published var runtimeBase = ""
    @Published var loginStatus: SMAppService.Status = .notRegistered
    /// **「提醒我」＝我们的偏好**（默认关）。与「系统里允许通知」那一格各说各的：
    /// 系统拒绝时它仍可以是开——那是用户的意图本身，不是需要藏起来的第二个真相。
    @Published var notificationsEnabled: Bool
    @Published var cliDirectory: String
    @Published var projectDirectory: URL?
    #if DEBUG
    @Published private(set) var systemTestAuthorization = Set<String>()
    #endif
    @Published private(set) var selectedBase: URL?
    var effectiveBase: URL { selectedBase ?? userHome }
    let appURL: URL
    let helperURL: URL
    let userHome: URL
    let isValidation: Bool
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
    private var acquired = false
    private var panelVisible = false
    private var noticeInspections: [String: (session: String, identity: ServiceIdentity, continuation: CheckedContinuation<NativeWork?, Never>)] = [:]
    @Published private var pendingInspection: (request: String, session: String, notice: String?, identity: ServiceIdentity)?
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

    init(appURL: URL = Bundle.main.bundleURL, validationRoot: URL? = nil,
         notificationPort: NotificationCoordinator? = nil, shutdownTimeout: TimeInterval = 15) {
        self.appURL = appURL
        self.shutdownTimeout = shutdownTimeout
        let bundle = Bundle(url: appURL) ?? Bundle.main
        expectedVersion = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
        expectedProtocol = bundle.object(forInfoDictionaryKey: "MagicProtocolVersion") as? Int ?? 1
        helperURL = appURL.appendingPathComponent("Contents/Helpers/magic-runtime").resolvingSymlinksInPath()
        isValidation = validationRoot != nil
        userHome = validationRoot ?? FileManager.default.homeDirectoryForCurrentUser
        // **验证身份的偏好必须落在它自己的临时根里。** `UserDefaults(suiteName:)` 的名字里带路径时，
        // plist 就落在那个路径下。原先只用房间名（`…magic-system-test-<UUID>`）⇒ 落到**真实**
        // `~/Library/Preferences/`；而 cfprefsd 是**异步**刷盘的，测试 teardown 删完它还会再刷回来
        // ——U106 实测：跑一次 `check.sh` 漏 3 条，两侧读数 0 → 3。
        defaults = validationRoot.map { UserDefaults(suiteName: "\($0.path)/MagicCode.Validation")! } ?? .standard
        // **验证身份仍然先走它自己的固定根** —— 测试副本的隔离靠的是**这一支**（外加
        // 独立 validation 身份与 capability 文件），**不靠**原先那个按 bundle 后缀认的
        // 旧身份。U109 起只有一个身份（`com.magiccode.app`），没有那套单独落点，故这里不再分叉。
        if let validationRoot { selectedBase = validationRoot }
        else { selectedBase = defaults.string(forKey: "baseDirectory").map { URL(fileURLWithPath: $0) } }
        settingsCategory = defaults.string(forKey: "settingsCategory") ?? "models"
        cliDirectory = defaults.string(forKey: "cliDirectory") ?? userHome.appendingPathComponent(".local/bin").path
        // 「提醒我」默认开：没说不要，就是要（关掉它＝让 Magic 闭嘴）。
        notificationsEnabled = defaults.object(forKey: "notificationsEnabled") as? Bool ?? true
        let support = userHome.appendingPathComponent("Library/Application Support/Magic Code/runtime")
        publication = HostPublication(directory: support)
        terminal = TerminalLauncher(directory: support.appendingPathComponent("terminal"))
        notifications = notificationPort ?? NotificationCoordinator()
        fileLog.changed = { [weak self] problem in self?.logProblem = problem }
        notifications.preference = notificationsEnabled
        notifications.userLooking = { [weak self] session, id in
            self?.panelVisible == true && NSApp?.isActive == true && self?.selected == session && self?.selectedNotice?.id == id && self?.visibleNoticeID == id
        }
        notifications.currentWorks = { [weak self] sessions in await self?.currentNoticeWorks(sessions) ?? [] }
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
    var inspectionMessage: String? {
        pendingInspection == nil ? nil : "正在读取事项…"
    }
    var appVersion: String { expectedVersion }
    var summary: String {
        guard isCurrent else { return phase.text }
        if affected.isEmpty { return "当前没有进行中的工作" }
        let waiting = affected.filter { $0.state == .waiting }.count
        let unknown = affected.filter { $0.state == .unknown }.count
        let active = affected.count - waiting - unknown
        var parts: [String] = []
        if waiting > 0 { parts.append("\(waiting) 项需要你") }
        if unknown > 0 { parts.append("\(unknown) 项状态待确认") }
        if active > 0 { parts.append("\(active) 项进行中") }
        return parts.joined(separator: "，")
    }

    func start() {
        guard host == nil else { return }
        do {
            if !acquired {
                do { try publication.acquire(); acquired = true }
                catch {
                    guard !diagnosticsArguments.isEmpty else { throw error }
                    // Another copy owns the instance. Forward through its settings service.
                    let process = Process(); let errors = Pipe()
                    process.executableURL = helperURL
                    process.arguments = ["--internal-diagnostics", "--home", userHome.path] + diagnosticsArguments
                    process.standardOutput = FileHandle.nullDevice; process.standardError = errors
                    process.terminationHandler = { child in
                        let data = errors.fileHandleForReading.readDataToEndOfFile()
                        Task { @MainActor [weak self] in
                            if child.terminationStatus == 0 { NSApp.terminate(nil) }
                            else { self?.phase = .fault(String(decoding: data, as: UTF8.self)) }
                        }
                    }
                    try process.run(); return
                }
            }
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
            // 启动时就按系统实际状态对齐一次投递门（App 不再存自己的「开没开」）。
            Task { @MainActor in await self.refreshNotifications() }
            // 回到前台：重读系统授权——用户在系统设置里改了，这边自己就变，不用他回来再点一次。
            // 验收身份下也要跑（不在 !isValidation 里），否则验收环境无法覆盖这条路径。
            tokens.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    if !self.isValidation { self.refreshLogin(); self.presence(focused: true) }
                    await self.refreshNotifications()
                }
            })
        } catch { phase = .fault(error.localizedDescription) }
    }
    private func startHost() {
        disconnectInspection(); phase = .starting; identity = nil; notificationGeneration = nil; hostStopped = false; shutdownRequest = nil
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
            try process.start(helper: manager, app: appURL, instance: instance, base: effectiveBase, home: userHome, environment: environment, diagnosticsArguments: diagnosticsArguments)
            diagnosticsArguments = []
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
        case .diagnostics(let request, let value, let base):
            let changed = diagnostics.debugMode != value.debugMode
            diagnostics = value
            logDirectory = URL(fileURLWithPath: base).appendingPathComponent("logs").path
            if changed { if value.debugMode { showDebugWindow?() } else { hideDebugWindow?() } }
            let owner = host
            fileLog.identify(host: hostInstance, service: identity?.serviceInstance)
            fileLog.configure(dataDir: base, level: value.logLevel) { [weak self, weak owner] problem in
                guard let self, self.host === owner else { return }
                self.logProblem = problem
                owner?.send(.diagnosticsApplied(request: request, error: problem))
                if self.isCurrent && !self.settingsBusy { self.readSettings() }
            }
        case .ready(let identity, let socket, let base, let config):
            guard identity.hostInstance == hostInstance,
                  identity.protocol == expectedProtocol,
                  identity.version == expectedVersion,
                  URL(fileURLWithPath: identity.base).resolvingSymlinksInPath().path == URL(fileURLWithPath: base).resolvingSymlinksInPath().path,
                  URL(fileURLWithPath: base).resolvingSymlinksInPath().path == effectiveBase.appendingPathComponent(".magic").resolvingSymlinksInPath().path,
                  URL(fileURLWithPath: identity.source).resolvingSymlinksInPath() == helperURL else {
                phase = .fault("内置核心与 App 的身份或版本不匹配"); host?.closeLifetime(); return
            }
            self.identity = identity; runtimeBase = base; configPath = config
            fileLog.identify(host: identity.hostInstance, service: identity.serviceInstance)
            fileLog.write(.info, "host.ready")
            do {
                try publication.publish(HostDiscovery(identity: identity, socket: socket, base: base, app: appURL.path))
                connectObserver(socket: socket, identity: identity)
            } catch { phase = .fault(error.localizedDescription); host?.closeLifetime() }
        case .stopped(let request):
            if shutdownRequest == nil || request == shutdownRequest { hostStopped = true }
        case .error(let reason):
            phase = .fault(reason); fileLog.write(.error, "host.failed")
            if shutdownRequest != nil { onUnconfirmedShutdown?() }
        }
    }
    private func connectObserver(socket: String, identity: ServiceIdentity) {
        disconnectSettings(); disconnectInspection()
        observer?.close()
        let connection = ObserverConnection(); observer = connection
        connection.receive = { [weak self, weak connection] response in
            guard let self, self.observer === connection else { return }; self.receive(response)
        }
        connection.disconnected = { [weak self, weak connection] reason in
            guard let self, self.observer === connection, self.shutdownRequest == nil else { return }
            self.disconnectSettings(); self.disconnectInspection()
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
        fileLog.write(.trace, "native.received")
        switch response {
        case .welcome(let received, let projection):
            guard received == identity, projection.serviceInstance == received.serviceInstance else {
                cancelNoticeInspections(); phase = .fault("连接的核心身份已改变"); observer?.close(); return
            }
            startupTimeout?.cancel(); reconnectAttempts = 0
            apply(projection)
            // A valid handshake restores the connection even when its snapshot is unchanged.
            if shutdownRequest == nil, let current = self.projection { phase = current.accepting ? .ready : .stopping }
            notifications.prepare(base: received.base)
            Task {
                await notifications.reconcile()
                guard self.identity == received else { return }
                notificationGeneration = received.serviceInstance
                if let current = self.projection { notifications.observe(current, identity: received) }
                if deferredNoticeRoutes.count == 1, let route = deferredNoticeRoutes.first { openNotification(route) }
                else if !deferredNoticeRoutes.isEmpty { notificationRoutes = deferredNoticeRoutes; showNotificationWindow?() }
                deferredNoticeRoutes = []
            }
        case .settingsResult(let request, let service, let base, let snapshot, let error, let note):
            guard let pending = settingsRequests[request], pending.identity == identity,
                  service == pending.identity.serviceInstance, URL(fileURLWithPath: base).resolvingSymlinksInPath().path == URL(fileURLWithPath: pending.identity.base).resolvingSymlinksInPath().path else { return }
            settingsRequests.removeValue(forKey: request)
            settingsBusy = !settingsRequests.isEmpty
            settingsError = error; settingsNote = note
            if let snapshot { settingsSnapshot = snapshot; if let key = pending.key { settingsSavedKey = key } }
            if let preview = queuedSettingsPreview { queuedSettingsPreview = nil; readSettings(preview: preview) }
        case .projection(let projection): apply(projection)
        case .inspected(let request, let work, let error):
            if let pending = noticeInspections.removeValue(forKey: request) {
                pending.continuation.resume(returning: isCurrent && pending.identity == identity && work?.session == pending.session ? work : nil)
                return
            }
            guard let intent = pendingInspection, intent.request == request,
                  intent.identity == identity, isCurrent else { return }
            pendingInspection = nil
            guard selected == intent.session else { return }
            guard let work, work.session == intent.session, works.contains(where: { $0.id == work.id }) else {
                actionMessage = error ?? "这项工作已不可达，请返回列表。"; return
            }
            let notice = intent.notice.flatMap { id in work.notices.first { $0.id == id && $0.session == intent.session } }
            guard intent.notice == nil || notice != nil else { actionMessage = "这条事项已不可达，请刷新后查看。"; return }
            selectedNotice = notice
        case .stopped(let request, let session, let phase, let note):
            guard stoppingRequests[request] == session else { return }
            actionMessage = note ?? (phase == .accepted ? "正在停止任务…" : phase == .done ? "任务已停止" : "尚未确认停止，请查看当前状态")
            if phase != .accepted { stoppingRequests.removeValue(forKey: request) }
            observer?.send(.refresh)
        case .attached(let request, let session):
            if terminal.attached(request: request, session: session) {
                validationEvent("terminal.attached", detail: "request=\(request), session=\(session ?? "null")")
            }
        case .error(let reason): disconnectInspection(); phase = .fault(reason)
        }
    }
    func rememberSettingsCategory(_ category: String) { settingsCategory = category; defaults.set(category, forKey: "settingsCategory") }
    func readSettings(preview: SettingsValue? = nil) {
        if settingsBusy { if let preview { queuedSettingsPreview = preview }; return }
        guard isCurrent, let identity else { return }
        let request = UUID().uuidString
        settingsRequests[request] = (identity, nil); settingsBusy = true; settingsError = nil
        observer?.send(.settingsRead(request: request, serviceInstance: identity.serviceInstance, base: identity.base, preview: preview))
        expireSettings(request)
    }
    func applySettings(_ action: SettingsValue, stamp: String?, key: String) {
        guard isCurrent, let identity, !settingsBusy else { settingsError = "服务未就绪，请重新读取"; return }
        let request = UUID().uuidString
        settingsRequests[request] = (identity, key); settingsBusy = true; settingsError = nil; settingsNote = nil; settingsSavedKey = nil
        fileLog.write(.debug, "settings.apply", request: request)
        observer?.send(.settingsApply(request: request, serviceInstance: identity.serviceInstance, base: identity.base, stamp: stamp, action: action))
        expireSettings(request)
    }
    private func expireSettings(_ request: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(40))
            guard let self else { return }
            if settingsRequests.removeValue(forKey: request) != nil { settingsBusy = !settingsRequests.isEmpty; settingsError = "结果未确认，请重新读取；未提交输入已保留" }
        }
    }
    private func disconnectSettings() {
        if !settingsRequests.isEmpty { settingsError = "连接已断开，结果未确认；请重新读取，未提交输入已保留" }
        settingsRequests.removeAll(); queuedSettingsPreview = nil; settingsBusy = false
    }
    private func apply(_ value: NativeProjection) {
        guard value.serviceInstance == identity?.serviceInstance else { return }
        if let old = projection, old.serviceInstance == value.serviceInstance, old.revision >= value.revision { return }
        if let selected, !value.works.contains(where: { $0.id == selected }) {
            presence(focused: false); pendingInspection = nil; selectedNotice = nil
            actionMessage = "这项工作已不可达，请返回列表。"
        }
        if let notice = selectedNotice, let work = value.works.first(where: { $0.id == selected }) {
            selectedNotice = work.notices.first { $0.id == notice.id }
        }
        projection = value
        list.update(value.works, interacting: panelVisible)
        if shutdownRequest == nil { phase = value.accepting ? .ready : .stopping }
        if let identity, notificationGeneration == identity.serviceInstance { notifications.observe(value, identity: identity) }
    }
    private func hostExited(_ code: Int32) {
        cancelNoticeInspections()
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
        cancelNoticeInspections()
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
    func prepareStop(_ work: NativeWork) {
        guard isCurrent, let identity, work.affected, work.gen != nil else { return }
        stopTarget = StopTarget(work: work, identity: identity)
    }
    func confirmStop() {
        guard let target = stopTarget else { return }
        stopTarget = nil
        guard target.identity == identity else { actionMessage = "服务已改变，请重新核对工作。"; return }
        stop(target.work)
    }
    func stop(_ work: NativeWork) {
        guard isCurrent, let gen = work.gen, let service = identity?.serviceInstance,
              let current = works.first(where: { $0.id == work.id }), current.gen == gen, current.affected else {
            actionMessage = "工作已结束或状态已改变，请重新核对。"; return
        }
        let request = UUID().uuidString; stoppingRequests[request] = work.session
        observer?.send(.stop(request: request, serviceInstance: service, session: work.session, gen: gen))
    }
    enum PanelSurface { case menu, debug }
    func setDebugWindowVisible(_ visible: Bool) {
        guard debugWindowVisible != visible else { return }
        presence(focused: false); panelVisible = false; leaveDetail()
        debugWindowVisible = visible
        fileLog.write(.debug, visible ? "window.debug.opened" : "window.debug.closed")
    }
    func panelVisibility(_ visible: Bool, surface: PanelSurface = .menu) {
        guard surface == (debugWindowVisible ? .debug : .menu) else { return }
        panelVisible = visible; list.update(works, interacting: visible)
        if !visible { leaveDetail() } else { presence(focused: NSApp?.isActive == true) }
    }
    func leaveDetail() {
        fileLog.write(.debug, "work.detail.closed")
        presence(focused: false)
        pendingInspection = nil; selected = nil; selectedNotice = nil; visibleNoticeID = nil; actionMessage = nil; stopTarget = nil
    }
    private func cancelNoticeInspections() {
        let pending = noticeInspections.values
        noticeInspections.removeAll()
        for request in pending { request.continuation.resume(returning: nil) }
    }
    private func currentNoticeWorks(_ sessions: [String]) async -> [NativeWork] {
        guard isCurrent, let identity, let connection = observer else { return [] }
        var works: [NativeWork] = []
        for session in Set(sessions) {
            guard isCurrent, self.identity == identity, observer === connection else { return [] }
            let work: NativeWork? = await withCheckedContinuation { continuation in
                let request = UUID().uuidString
                noticeInspections[request] = (session, identity, continuation)
                connection.send(.inspect(request: request, session: session, notice: nil))
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    self?.noticeInspections.removeValue(forKey: request)?.continuation.resume(returning: nil)
                }
            }
            guard let work, isCurrent, self.identity == identity, observer === connection else { return [] }
            works.append(work)
        }
        return works
    }
    private func disconnectInspection() {
        cancelNoticeInspections()
        presence(focused: false)
        pendingInspection = nil; selectedNotice = nil; visibleNoticeID = nil; stopTarget = nil
    }
    func inspect(_ work: NativeWork, notice: String? = nil) {
        fileLog.write(.debug, "work.inspected")
        // The current projection already contains the detail summary. Navigation needs no request.
        if notice == nil {
            presence(focused: false); pendingInspection = nil
            selected = work.id; selectedNotice = nil; visibleNoticeID = nil; actionMessage = nil
            return
        }
        guard isCurrent, let identity else { actionMessage = "状态尚未核对，请重试连接。"; return }
        if let pending = pendingInspection, pending.session == work.session, pending.notice == notice { return }
        presence(focused: false); selectedNotice = nil; visibleNoticeID = nil; actionMessage = nil
        selected = work.id
        let request = UUID().uuidString
        pendingInspection = (request, work.session, notice, identity)
        observer?.send(.inspect(request: request, session: work.session, notice: notice))
    }
    /// Selection is an intent; only content inside the scroll viewport counts as presented.
    func noticePresented(_ id: String, visible: Bool = true) {
        if !visible {
            guard visibleNoticeID == id else { return }
            presence(focused: false); visibleNoticeID = nil
            return
        }
        guard panelVisible, isCurrent, let notice = selectedNotice, notice.id == id,
              notice.session == selected else { return }
        visibleNoticeID = id
        if notice.unread { observer?.send(.read(ids: [notice.id])) }
        presence(focused: NSApp?.isActive == true)
    }
    private func presence(focused: Bool) {
        guard let selected else { return }
        let ids = selectedNotice?.id == visibleNoticeID ? visibleNoticeID.map { [$0] } ?? [] : []
        observer?.send(.presence(session: selected, ids: ids, focused: focused && panelVisible))
    }
    func newTerminal() {
        guard isCurrent else { actionMessage = "核心尚未就绪"; return }
        terminal.open(helper: helperURL, workspace: projectDirectory ?? userHome, base: effectiveBase)
    }
    func resumeCommand(_ work: NativeWork) -> String {
        let link = URL(fileURLWithPath: cliDirectory).appendingPathComponent("magic")
        let executable = (try? CLIInstallation.belongs(link, helper: helperURL)) == true ? link : helperURL
        return TerminalCommand.make(helper: executable, workspace: work.workspace.first.map { URL(fileURLWithPath: $0) } ?? userHome,
                                    base: effectiveBase, session: work.session, request: nil)
    }
    func copyCommand(_ work: NativeWork) {
        terminal.copy(resumeCommand(work))
        actionMessage = "已复制"
    }
    func openNotification(_ route: NoticeRoute) {
        guard isCurrent else { deferredNoticeRoutes.append(route); return }
        guard let identity, URL(fileURLWithPath: route.base).resolvingSymlinksInPath().path == URL(fileURLWithPath: identity.base).resolvingSymlinksInPath().path else {
            actionMessage = "此通知属于另一数据位置：\(route.base)。请在设置中明确切换后查看。"; showNotificationWindow?(); return
        }
        guard let work = works.first(where: { $0.id == route.session }) else { actionMessage = "此通知的工作已不可达。"; return }
        inspect(work, notice: route.ids.first)
        showNotificationWindow?()
    }
    func changeBase(_ base: URL?) {
        guard isCurrent, affected.isEmpty else { actionMessage = "仍有在途工作或状态待确认，无法切换基础路径。"; return }
        switching = true; switchBase = base; confirmQuit()
    }
    /// 「提醒我」这一下：存的**是我们的偏好**（系统拒绝也照存，那是用户的意图本身）。
    /// 拨开而系统还没问过 ⇒ **就地请求**（Apple 也把「从功能开关里请求」列为正解）；首次打开不弹框。
    ///
    /// **U105 修**：上面这句原先只活在注释里——函数体只 `refreshAuthorization()`（读状态），
    /// 从没调过 `requester()`，于是拨开关根本不请求；而设计正文·通知节总纲写死了
    /// 「偏好开而系统未问过 ⇒ 第一次真要提醒时就地请求」。补上这一步。不改别处语义：
    /// 系统已经问过时 `enableExplicitly` 只读状态、不会重复弹框。
    func setNotifications(_ value: Bool) async {
        guard canChangeNotifications else { return }
        notificationsEnabled = value
        notifications.preference = value
        defaults.set(value, forKey: "notificationsEnabled")
        if value { _ = await notifications.enableExplicitly() }
        await notifications.refreshAuthorization()
    }
    /// 回到前台／设置页出现时重读系统状态：用户在系统设置里改了，这边自己跟上。
    func refreshNotifications() async { await notifications.refreshAuthorization() }
    /// 「去系统设置允许」：把用户送到系统的通知设置面板。
    func openNotificationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
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
            fileLog.write(.info, "app.stopped")
            fileLog.close { [weak self] in self?.cleanExit?() }
        } catch { phase = .fault("工作已停止，但系统集成移除失败：\(error.localizedDescription)"); onUnconfirmedShutdown?() }
    }
    private func recordDiagnostic(_ text: String) {
        // stderr may be routine output and may contain credentials. Keep only its occurrence.
        fileLog.write(.debug, "host.stderr")
    }
    func validationEvent(_ event: String, detail: String) {
        fileLog.write(.debug, event)
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
            "notificationAuthorizationStatus": notifications.authorizationStatus.rawValue,
            "notificationPreference": notificationsEnabled,
            // **U105 加**：把失败原因也交出来。原先 `actionMessage` 只进 UI，装置读不到 ——
            // 请求没弹框时「为什么」是空白（本轮就卡在这）。空串＝此刻没有待报的失败。
            "actionMessage": actionMessage ?? "",
            // 判「横幅为什么没出来」的检查项之一：发送方 App 当时是否在前台
            //（macOS 前台默认不弹，须 willPresent 显式返回 .banner）。
            "appActive": NSApp?.isActive == true,
            // 长期窗口（设置/定位窗口）在 ⇒ regular：Dock 有图标、Cmd+Tab 切得到；关光 ⇒ accessory。
            // `activationPolicyChanges` 只记**真的切过**的几次：展开菜单栏面板时它不该多出一条。
            "activationPolicy": LongLivedWindows.shared.policyName,
            "activationPolicyChanges": LongLivedWindows.shared.transitions]
        try? PrivateFiles.write(JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]), to: root.appendingPathComponent("system-state.json"))
    }
    func restoreSystemTestNotifications() async {
        guard let root = systemTestRoot, canChangeNotifications else { return }
        // App 侧没有「偏好」可关：恢复只做一件事——把本轮发过的 request id 从系统里撤掉。
        let requests = (try? JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("system-notification-requests.json")))) as? [[String: Any]] ?? []
        notifications.removeNotifications(identifiers: requests.compactMap { $0["identifier"] as? String })
        await writeSystemTestState()
    }
}
#endif
