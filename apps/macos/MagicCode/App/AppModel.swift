import AppKit
import Combine
import ServiceManagement

@MainActor final class AppModel: ObservableObject {
    enum MainPage: Hashable { case sessions, settings }
    @Published private(set) var mainPage: MainPage = .sessions
    enum Phase: Equatable {
        case starting, ready, stopping, stopped, unreachable, fault(String)
        var text: String {
            switch self { case .starting: return "正在启动"; case .ready: return "Magic Engine 运行中"
            case .stopping: return "Magic Engine 正在停止…"; case .stopped: return "Magic Engine 已停止"
            case .unreachable: return "Magic Engine 失联，尚未确认停止"; case .fault(let reason): return reason }
        }
    }
    @Published private(set) var settingsSnapshot: SettingsSnapshot?
    @Published private(set) var settingsBusy = false
    @Published private(set) var settingsError: String?
    @Published private(set) var settingsNote: String?
    @Published private(set) var settingsSavedKey: String?
    private var settingsErrorFromWrite = false
    @Published var settingsCategory = "models"
    private var queuedSettingsPreview: SettingsValue?
    @Published private(set) var runtimeMcp: [SettingsValue] = []
    @Published private(set) var runtimeSettingsError: String?
    @Published private(set) var canChangeData = false
    private var runtimeRequest: String?
    @Published var phase: Phase = .starting
    @Published private(set) var identity: ServiceIdentity?
    @Published private(set) var projection: NativeProjection?
    @Published private(set) var list = WorkList()
    @Published private(set) var selected: String?
    let sessions = SessionBrowserModel()
    @Published var actionMessage: String?
    struct StopTarget { let work: NativeWork; let identity: ServiceIdentity }
    @Published var stopTarget: StopTarget?
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
    @Published private(set) var engineBusy = false
    @Published var showEngineStopConfirmation = false
    private var observer: ObserverConnection?
    private var shutdownRequest: String?
    private var queuedSettingsRead = false
    var configurationStatus: String {
        guard isCurrent else { return "配置已保存在本机；Engine 未连接" }
        guard let adoption = projection?.configuration else { return "等待 Engine 确认配置采用状态" }
        if let error = adoption.error { return "Engine 采用失败：\(error)" }
        return adoption.stamp == settingsSnapshot?.stamp ? "Engine 已采用当前配置" : "配置已保存，等待 Engine 采用"
    }
    private var panelVisible = false
    private var noticeInspections: [String: (session: String, identity: ServiceIdentity, continuation: CheckedContinuation<NativeWork?, Never>)] = [:]
    private var stoppingRequests: [String: String] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var notificationGeneration: String?
    private var cleanExit: (() -> Void)?
    private var removingIntegration = false
    private let expectedVersion: String
    private let expectedProtocol: Int
    private var tokens: [NSObjectProtocol] = []

    init(appURL: URL = Bundle.main.bundleURL, validationRoot: URL? = nil,
         notificationPort: NotificationCoordinator? = nil) {
        self.appURL = appURL
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
        sessions.send = { [weak self] request in self?.observer?.send(request) }
        sessions.copy = { [weak self] session in
            guard let self else { return }
            let link = URL(fileURLWithPath: self.cliDirectory).appendingPathComponent("magic")
            let executable = (try? CLIInstallation.belongs(link, helper: self.helperURL)) == true ? link : self.helperURL
            self.terminal.copy(TerminalCommand.make(helper: executable,
                workspace: session.workspace?.first.map { URL(fileURLWithPath: $0) } ?? self.userHome,
                base: self.effectiveBase, session: session.id, request: nil))
        }
        notifications.userLooking = { [weak self] session, id in self?.sessions.isPresenting(session: session, notice: id) == true }
        notifications.currentWorks = { [weak self] sessions in await self?.currentNoticeWorks(sessions) ?? [] }
        notifications.failure = { [weak self] text in self?.actionMessage = text }
        notifications.openRoute = { [weak self] route in self?.openNotification(route) }
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
    var showMainWindow: (() -> Void)?
    var onUnconfirmedShutdown: (() -> Void)?
    var affected: [NativeWork] { projection?.works.filter(\.affected) ?? [] }
    var works: [NativeWork] { projection?.works ?? [] }
    var isCurrent: Bool { phase == .ready && projection != nil }
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
        terminal.cleanupExpired()
        engine(CommandLine.arguments.contains("--settings") ? "status" : "start")
        readSettings()
            if !isValidation {
                refreshLogin()
                tokens.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                    Task { @MainActor in self?.refreshAfterWake() }
                })
            }
            // 启动时就按系统实际状态对齐一次投递门（App 不再存自己的「开没开」）。
            Task { @MainActor in await self.refreshNotifications() }
            // 回到前台：重读系统授权——用户在系统设置里改了，这边自己就变，不用他回来再点一次。
            // 验收身份下也要跑（不在 !isValidation 里），否则验收环境无法覆盖这条路径。
            tokens.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    if !self.isValidation { self.refreshLogin() }
                    await self.refreshNotifications()
                }
            })
    }
    private func engine(_ action: String, parent: URL? = nil) {
        guard !engineBusy else { return }
        engineBusy = true
        if action == "start" { phase = .starting }
        if action == "stop" || action == "switch" { phase = .stopping }
        let target = (action == "stop" || action == "switch" || action == "remove") ? identity : nil
        let request = shutdownRequest ?? UUID().uuidString
        if action == "stop" { shutdownRequest = request }
        Task {
            defer { engineBusy = false }
            do {
                let result = try await EngineControl.run(app: appURL, action: action, home: isValidation ? userHome : nil,
                                                         parent: parent, expected: target, request: request)
                if action == "switch", let parent, result.base.map({ URL(fileURLWithPath: $0).resolvingSymlinksInPath() }) == parent.appendingPathComponent(".magic").resolvingSymlinksInPath() { selectedBase = parent; settingsSnapshot = nil; settingsError = nil; readSettings() }
                if let base = result.base { runtimeBase = base; configPath = URL(fileURLWithPath: base).appendingPathComponent("config.json").path }
                if let found = result.record {
                    guard found.identity.protocol == expectedProtocol, found.version == expectedVersion,
                          URL(fileURLWithPath: found.source).resolvingSymlinksInPath() == helperURL else { throw WireError.invalid("Engine 来源或版本不匹配") }
                    identity = found.identity
                }
                if action == "switch", result.state == "failed", let found = result.record, found.state == "ready" {
                    actionMessage = result.error
                    connectObserver(socket: found.socket, identity: found.identity)
                    return
                }
                switch result.state {
                case "ready":
                    shutdownRequest = nil
                    if let found = result.record { connectObserver(socket: found.socket, identity: found.identity) }
                case "stopped": shutdownRequest = nil; disconnectEngine(); phase = .stopped; canChangeData = true
                case "stopping": phase = .stopping
                case "starting": phase = .starting
                case "unreachable": disconnectEngine(); phase = .unreachable
                default: shutdownRequest = nil; disconnectEngine(); phase = .fault(result.error ?? "Magic Engine 启动失败")
                }
            } catch { phase = .fault(error.localizedDescription); actionMessage = error.localizedDescription }
        }
    }
    private func disconnectEngine() {
        notifications.disconnect(); notificationGeneration = nil
        let prior = observer; observer = nil; prior?.close()
        disconnectSettings(); disconnectInspection()
    }
    func startEngine() { engine("start") }
    func confirmEngineStop() { showEngineStopConfirmation = false; engine("stop") }
    private func connectObserver(socket: String, identity: ServiceIdentity) {
        disconnectSettings(); disconnectInspection()
        notifications.disconnect(); notificationGeneration = nil
        let prior = observer; observer = nil; prior?.close()
        let connection = ObserverConnection(); observer = connection
        connection.receive = { [weak self, weak connection] response in
            guard let self, self.observer === connection else { return }; self.receive(response)
        }
        connection.disconnected = { [weak self, weak connection] reason in
            guard let self, self.observer === connection, self.shutdownRequest == nil else { return }
            self.disconnectSettings(); self.disconnectInspection()
            self.notifications.disconnect(); self.notificationGeneration = nil
            self.phase = .unreachable
            guard self.reconnectAttempts < 3 else { return }
            self.reconnectAttempts += 1
            self.reconnectTask = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self, self.shutdownRequest == nil else { return }
                self.engine("status")
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
            reconnectAttempts = 0
            apply(projection)
            // A valid handshake restores the connection even when its snapshot is unchanged.
            if shutdownRequest == nil, let current = self.projection { phase = current.accepting ? .ready : .stopping }
            sessions.connect(identity: received, current: isCurrent, works: self.projection?.works ?? [])
            notifications.delivered = { [weak self] ids in
                guard let self, self.identity == received else { return }
                self.observer?.send(.delivered(serviceInstance: received.serviceInstance, ids: ids))
            }
            notifications.beginConnection(projection, identity: received)
            notificationGeneration = received.serviceInstance
            Task {
                await notifications.reconcile()
                guard self.identity == received else { return }

            }
        case .runtimeResult(let request, let service, let mcp, let canChange, let error, let note):
            guard runtimeRequest == request, service == identity?.serviceInstance else { return }
            runtimeRequest = nil; runtimeSettingsError = error
            if let mcp { runtimeMcp = mcp }
            if let canChange { canChangeData = canChange }
            if let note { actionMessage = note }
        case .projection(let projection): apply(projection)
        case .inspected(let request, let work, _):
            if let pending = noticeInspections.removeValue(forKey: request) {
                pending.continuation.resume(returning: isCurrent && pending.identity == identity && work?.session == pending.session ? work : nil)
                return
            }
            sessions.receive(response)
        case .sessionsResult, .historyResult: sessions.receive(response)
        case .managed:
            sessions.receive(response); actionMessage = sessions.operationMessage; observer?.send(.refresh)
        case .stopped(let request, let session, let phase, let note):
            guard stoppingRequests[request] == session else { return }
            actionMessage = note ?? (phase == .accepted ? "正在停止任务…" : phase == .done ? "任务已停止" : "尚未确认停止，请查看当前状态")
            if phase != .accepted { stoppingRequests.removeValue(forKey: request) }
            observer?.send(.refresh)
        case .attached(let request, let session):
            if terminal.attached(request: request, session: session) {
                validationEvent("terminal.attached", detail: "request=\(request), session=\(session ?? "null")")
            }
        case .engineResult: break
        case .error(let reason): disconnectInspection(); phase = .fault(reason)
        }
    }
    func rememberSettingsCategory(_ category: String) { settingsCategory = category; defaults.set(category, forKey: "settingsCategory") }
    func readSettings(preview: SettingsValue? = nil) {
        if settingsBusy { queuedSettingsRead = true; if let preview { queuedSettingsPreview = preview }; return }
        callSettings(action: nil, stamp: nil, key: nil, preview: preview)
        readRuntimeSettings()
    }
    func applySettings(_ action: SettingsValue, stamp: String?, key: String) {
        guard !settingsBusy else { return }
        settingsError = nil; settingsErrorFromWrite = false; settingsNote = nil; settingsSavedKey = nil
        guard let snapshot = settingsSnapshot,
              URL(fileURLWithPath: snapshot.base).resolvingSymlinksInPath() == effectiveBase.appendingPathComponent(".magic").resolvingSymlinksInPath() else {
            settingsErrorFromWrite = true
            settingsError = "所选数据位置已改变，请重新读取；输入已保留"; return
        }
        callSettings(action: action, stamp: stamp, key: key, preview: nil)
    }
    private func callSettings(action: SettingsValue?, stamp: String?, key: String?, preview: SettingsValue?) {
        let request = UUID().uuidString
        let base = effectiveBase.appendingPathComponent(".magic").path
        let path = URL(fileURLWithPath: base).appendingPathComponent("config.json").path
        var fields: [String: SettingsValue] = ["request": .string(request), "home": .string(userHome.path), "base": .string(base), "configPath": .string(path)]
        if let action { fields["action"] = action; fields["stamp"] = stamp.map(SettingsValue.string) ?? .null }
        if let preview { fields["preview"] = preview }
        settingsBusy = true
        var environment = ProcessInfo.processInfo.environment
        if isValidation { environment = ["HOME": userHome.path, "PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"] }
        Task {
            defer {
                settingsBusy = false
                if queuedSettingsRead || queuedSettingsPreview != nil {
                    let preview = queuedSettingsPreview; queuedSettingsPreview = nil; queuedSettingsRead = false
                    readSettings(preview: preview)
                }
            }
            do {
                let result = try await SettingsCall.run(helper: helperURL, request: .object(fields), environment: environment)
                guard result.request == request, result.base == base, result.configPath == path else { throw WireError.invalid(result.error ?? "设置返回的目标不一致") }
                guard effectiveBase.appendingPathComponent(".magic").path == base else { throw WireError.invalid("所选数据位置已改变；原位置的结果未应用到新页面，请重新读取") }
                // 刷新可修复读失败，但不能覆盖尚需用户处理的写失败或保存回执。
                if action != nil || settingsError == nil || !settingsErrorFromWrite {
                    settingsError = result.error
                    settingsErrorFromWrite = action != nil && !result.saved && result.error != nil
                }
                if action != nil {
                    settingsNote = result.note
                    settingsSavedKey = result.saved ? key : nil
                }
                if let snapshot = result.snapshot {
                    settingsSnapshot = snapshot; configPath = snapshot.configPath
                    applyDiagnostics(snapshot)
                    if !diagnosticsArguments.isEmpty {
                        let args = diagnosticsArguments; diagnosticsArguments = []
                        var action: [String: SettingsValue] = ["type": .string("diagnostics.set"), "source": .string("app")]
                        if args.contains("--debug") { action["debugMode"] = .bool(true) }
                        if args.contains("--no-debug") { action["debugMode"] = .bool(false) }
                        if let at = args.firstIndex(of: "--log-level"), args.indices.contains(at + 1) { action["logLevel"] = .string(args[at + 1]) }
                        Task { @MainActor in self.applySettings(.object(action), stamp: snapshot.stamp, key: "diagnostics") }
                    }
                }
            } catch {
                if action != nil || settingsError == nil || !settingsErrorFromWrite {
                    settingsError = error.localizedDescription
                    settingsErrorFromWrite = action != nil
                }
            }
        }
    }
    private func applyDiagnostics(_ snapshot: SettingsSnapshot) {
        let value = Diagnostics(debugMode: snapshot.configuration["debugMode"].flag, logLevel: LogLevel(rawValue: snapshot.configuration["logLevel"].text) ?? .info)
        let changed = diagnostics.debugMode != value.debugMode
        diagnostics = value; logDirectory = URL(fileURLWithPath: snapshot.base).appendingPathComponent("logs").path
        fileLog.configure(dataDir: snapshot.base, level: value.logLevel) { [weak self] problem in self?.logProblem = problem }
        if changed { if value.debugMode { showDebugWindow?() } else { hideDebugWindow?() } }
    }
    func readRuntimeSettings() {
        guard isCurrent else { runtimeSettingsError = "Magic Engine 未连接，运行状态不可用"; return }
        let request = UUID().uuidString; runtimeRequest = request
        observer?.send(.runtimeRead(request: request))
    }
    func reconnectMcp(session: String, gen: Int, name: String) {
        guard isCurrent, let identity else { runtimeSettingsError = "Magic Engine 未连接，无法重连工作"; return }
        let request = UUID().uuidString; runtimeRequest = request
        observer?.send(.runtimeReconnect(request: request, serviceInstance: identity.serviceInstance, session: session, gen: gen, name: name))
    }
    private func disconnectSettings() {
        runtimeRequest = nil; runtimeMcp = []; canChangeData = false
        runtimeSettingsError = "Magic Engine 未连接，运行状态不可用"
    }
    private func apply(_ value: NativeProjection) {
        guard value.serviceInstance == identity?.serviceInstance else { return }
        if let old = projection, old.serviceInstance == value.serviceInstance, old.revision >= value.revision { return }
        if let selected, !value.works.contains(where: { $0.id == selected }) { self.selected = nil }
        let configurationChanged = projection?.configuration != value.configuration
        projection = value
        if configurationChanged { readSettings() }
        list.update(value.works, interacting: panelVisible)
        sessions.connect(identity: identity, current: value.accepting, works: value.works)
        if shutdownRequest == nil { phase = value.accepting ? .ready : .stopping }
        if let identity, notificationGeneration == identity.serviceInstance { notifications.observe(value, identity: identity) }
    }
    func retry() { if removingIntegration { finishQuit() } else { refreshAfterWake() } }
    func refreshAfterWake() { engine("status") }
    func requestQuit(onClean: @escaping () -> Void) {
        cleanExit = onClean; confirmQuit()
    }
    func confirmQuit() {
        reconnectTask?.cancel(); disconnectEngine(); finishQuit()
    }
    func systemQuit(onClean: @escaping () -> Void) { requestQuit(onClean: onClean) }
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
        panelVisible = false; leaveDetail()
        debugWindowVisible = visible
        fileLog.write(.debug, visible ? "window.debug.opened" : "window.debug.closed")
    }
    func panelVisibility(_ visible: Bool, surface: PanelSurface = .menu) {
        guard surface == (debugWindowVisible ? .debug : .menu) else { return }
        panelVisible = visible; list.update(works, interacting: visible)
        if !visible { leaveDetail() }
    }
    func leaveDetail() {
        fileLog.write(.debug, "work.detail.closed")
        selected = nil; actionMessage = nil; stopTarget = nil
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
        sessions.disconnect(); stopTarget = nil
    }
    func inspect(_ work: NativeWork) { selected = work.id; actionMessage = nil }
    func selectMainPage(_ page: MainPage) {
        mainPage = page
        if page == .sessions { sessions.open() } else { sessions.close() }
    }
    func openMainWindow(_ page: MainPage) { selectMainPage(page); showMainWindow?() }
    func manageSessions() { openMainWindow(.sessions) }
    func manageSettings() { openMainWindow(.settings) }
    func viewReason(_ work: NativeWork) {
        guard let identity, let notice = work.currentNotice else { return }
        openNotification(NoticeRoute(base: identity.base, serviceInstance: identity.serviceInstance, session: work.session, notice: notice))
    }
    func archive(_ work: NativeWork) {
        guard isCurrent, work.canArchive, identity != nil else { return }
        let request = UUID().uuidString
        sessions.manage([SessionManagement(session: work.session, action: "archive")], request: request)
    }
    func newTerminal() {
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
        sessions.open(route: route); mainPage = .sessions; showMainWindow?()
    }
    func changeBase(_ base: URL?) { engine("switch", parent: base ?? userHome) }
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
    func installCLI(at directory: String? = nil) {
        let candidate = directory ?? cliDirectory
        do {
            try CLIInstallation.install(helper: helperURL, at: URL(fileURLWithPath: candidate).appendingPathComponent("magic"), app: appURL)
            cliDirectory = candidate
            defaults.set(cliDirectory, forKey: "cliDirectory"); actionMessage = "终端命令已安装：\(cliDirectory)/magic"
        } catch { actionMessage = error.localizedDescription }
    }
    func uninstallIntegration(onQuitRequest: @escaping @MainActor () -> Void = { NSApp.terminate(nil) }) {
        guard !engineBusy else { return }
        engineBusy = true
        Task {
            defer { engineBusy = false }
            do {
                let result = try await EngineControl.run(app: appURL, action: "remove", home: isValidation ? userHome : nil, expected: identity)
                guard result.state == "stopped" else { throw WireError.invalid(result.error ?? "Engine 停止尚未确认") }
                removingIntegration = true; onQuitRequest()
            } catch { actionMessage = error.localizedDescription }
        }
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
    nonisolated static func systemTestRoot(bundle: Bundle) -> URL? {
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
            "serviceInstance": identity?.serviceInstance ?? "",
            "revision": projection?.revision ?? -1, "selectedSession": selected ?? "", "selectedNotice": sessions.route?.notice.id ?? "",
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
