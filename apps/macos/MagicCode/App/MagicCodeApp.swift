import SwiftUI
import AppKit
import Combine

@main enum MagicCodeEntry {
    static func main() {
        if CommandLine.arguments.dropFirst().first == "--internal-engine-control" {
            signal(SIGPIPE, SIG_IGN)
            do {
                let result = try EngineControl.perform(Array(CommandLine.arguments.dropFirst(2)))
                FileHandle.standardOutput.write(try JSONEncoder().encode(result) + Data([10]))
                exit(result.state == "failed" ? 1 : 0)
            } catch {
                let result = EngineControlResult(state: "failed", base: nil, alive: nil, record: nil, error: error.localizedDescription)
                if let data = try? JSONEncoder().encode(result) { FileHandle.standardOutput.write(data + Data([10])) }
                exit(1)
            }
        }
        MagicCodeApp.main()
    }
}

struct MagicCodeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model: AppModel
    init() {
        let args = CommandLine.arguments
        if args.contains("--help") || args.contains("-h") {
            print("Magic Code\n选项：--debug / --no-debug；--log-level <error|warn|info|debug|trace>\n显式设置保存到 config.json；无参数采用已保存设置。")
            exit(0)
        }
        #if DEBUG
        let fixedRoot = AppModel.systemTestRoot(bundle: .main)
        let root = fixedRoot ?? args.firstIndex(of: "--validation-root").flatMap { args.indices.contains($0 + 1) ? URL(fileURLWithPath: args[$0 + 1]) : nil }
        #else
        let root: URL? = nil
        #endif
        if Bundle.main.bundleIdentifier?.hasPrefix("com.magiccode.validation.") == true, root == nil {
            FileHandle.standardError.write(Data("系统验收隔离根无效，拒绝启动\n".utf8)); exit(78)
        }
        let diagnosticArgs: [String]
        do { diagnosticArgs = try Diagnostics.arguments(args) }
        catch { FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8)); exit(64) }
        let model = AppModel(validationRoot: root)
        model.diagnosticsArguments = diagnosticArgs
        _model = StateObject(wrappedValue: model)
        AppDelegate.model = model
    }
    var body: some Scene {
        MenuBarExtra {
            if model.debugWindowVisible {
                Button("打开调试窗口") { model.showDebugWindow?() }.padding()
            } else { StatusPanel(model: model) }
        } label: {
            MenuBarMark(state: model.menuBarState).accessibilityLabel("Magic Code，\(model.summary)").modifier(SettingsLaunch())
        }.menuBarExtraStyle(.window)
        // 设置窗口是**长期窗口**：它在 ⇒ App 是 `.regular`（Dock 有图标、Cmd+Tab 切得到）。标记不占位置。
        Settings { SettingsView(model: model).background(LongLivedWindowMarker()) }
            .defaultSize(SettingsView.defaultSize)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private var terminating = false
    private var awaitingTerminationReply = false
    private var powerOff: NSObjectProtocol?
    private var validation: AnyCancellable?
    private var noticeWindow: NSWindow?
    private var debugWindow: DebugWorkWindow?
    #if DEBUG
    private var systemTestTimer: Timer?
    #endif
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        // 缺省是菜单栏形态（无 Dock 图标、不进 Cmd+Tab）。**策略只在 `LongLivedWindows` 一处改**：
        // 这里只结算一次——长期窗口（设置窗口、通知/事项定位窗口）还没出现时它落的正是 `.accessory`。
        LongLivedWindows.shared.settle(reason: "launch")
        Self.model?.onUnconfirmedShutdown = { [weak self] in
            guard let self, self.awaitingTerminationReply else { return }
            self.awaitingTerminationReply = false
            NSApp.reply(toApplicationShouldTerminate: false)
        }
        Self.model?.showNotificationWindow = { [weak self] in
            guard let self, let model = Self.model else { return }
            if self.noticeWindow == nil {
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 300), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
                window.title = "Magic Code 通知事项"; window.isReleasedWhenClosed = false
                window.contentViewController = NSHostingController(rootView: NoticeWindow(model: model))
                window.center(); self.noticeWindow = window
                // 定位窗口也是长期窗口：它在 ⇒ 有 Dock 图标、Cmd+Tab 切得到。
                LongLivedWindows.shared.register(window)
            }
            self.noticeWindow?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        }
        #if DEBUG
        if let model = Self.model, model.isValidation {
            validation = model.$phase.sink { [weak self] phase in
                // Test-only driver of the actual App lifecycle. No popup, login item or notification.
                if phase == .ready {
                    let info: [String: Any] = ["event": "app.ready", "host": model.publication.file.path]
                    if let data = try? JSONSerialization.data(withJSONObject: info) { FileHandle.standardOutput.write(data + Data([10])) }
                    if CommandLine.arguments.contains("--validation-quit") {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { NSApp.terminate(nil) }
                    }
                    if CommandLine.arguments.contains("--validation-open-terminal") {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { model.newTerminal() }
                    }
                    if CommandLine.arguments.contains("--validation-show-status") {
                        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 360, height: 650), styleMask: [.titled, .closable], backing: .buffered, defer: false)
                        window.title = "Magic Code 隔离界面验收"; window.isReleasedWhenClosed = false
                        window.contentViewController = NSHostingController(rootView: StatusPanel(model: model).frame(height: 650))
                        window.center(); window.orderBack(nil); self?.noticeWindow = window
                    }
                    // 策略台账跟着事件流出去（隔离验收时才有）：一闪而过的那一下也要留痕。
                    LongLivedWindows.shared.record = { model.validationEvent("activation-policy", detail: $0) }
                    if let index = CommandLine.arguments.firstIndex(of: "--validation-open-session"), CommandLine.arguments.indices.contains(index + 1) {
                        let session = CommandLine.arguments[index + 1]
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            guard let work = model.works.first(where: { $0.session == session }) else {
                                model.validationEvent("terminal.error", detail: "隔离目标不存在：\(session)"); return
                            }
                            model.inspect(work)
                            model.validationEvent("resume.command", detail: model.resumeCommand(work))
                        }
                    }
                    self?.validation?.cancel()
                } else if case .fault(let reason) = phase {
                    let info = ["event": "app.error", "reason": reason]
                    if let data = try? JSONSerialization.data(withJSONObject: info) { FileHandle.standardOutput.write(data + Data([10])) }
                }
            }
        }
        #endif
        if let model = Self.model {
            let window = DebugWorkWindow(model: model); debugWindow = window
            model.showDebugWindow = { [weak window] in window?.show() }
            model.hideDebugWindow = { [weak window] in window?.close() }
        }
        Self.model?.start()
        #if DEBUG
        if let model = Self.model, let root = model.systemTestRoot {
            systemTestTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                Task { @MainActor in
                    await model.writeSystemTestState()
                    let path = root.appendingPathComponent("system-command.json")
                    guard let command = (try? JSONSerialization.jsonObject(with: Data(contentsOf: path))) as? [String: String] else { return }
                    try? FileManager.default.removeItem(at: path)
                    switch command["action"] {
                    case "refresh-connection": model.refreshAfterWake()
                    case "restore-notifications": await model.restoreSystemTestNotifications()
                    case "restore-login": if model.canChangeLogin { model.setLogin(false) }
                    case "quit": NSApp.terminate(nil)
                    default: break
                    }
                    await model.writeSystemTestState()
                    model.validationEvent("system-test.command", detail: command["action"] ?? "status")
                }
            }
        } else if let model = Self.model, model.isValidation {
            // 只有临时隔离根、没有系统验收身份的那一种（`--validation-root`）：把策略读数落在本轮根目录。
            // 外部装置因此核得到「该切时切了、不该切时一条都没记」，不必为此再开一只鼠标。
            systemTestTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                Task { @MainActor in AppDelegate.writePolicyReadout(to: model.userHome) }
            }
        }
        #endif
        powerOff = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willPowerOffNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                Self.model?.systemQuit { self?.terminating = true; NSApp.reply(toApplicationShouldTerminate: true) }
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        Self.model?.validationEvent("app.terminate-request", detail: "terminating=\(terminating)")
        if terminating { return .terminateNow }
        awaitingTerminationReply = true
        Self.model?.requestQuit { [weak self] in
            self?.terminating = true
            MainRunLoop.deliver { [weak self] in
                if self?.awaitingTerminationReply == true { NSApp.reply(toApplicationShouldTerminate: true) }
                else { NSApp.terminate(nil) }
            }
        }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
}

extension AppDelegate {
    #if DEBUG
    /// 隔离验收的策略读数：`policy` 是此刻真实的策略，`changes` 只记**真的切过**的那几次。
    @MainActor static func writePolicyReadout(to root: URL) {
        let value: [String: Any] = ["policy": LongLivedWindows.shared.policyName, "presentWindows": LongLivedWindows.shared.presentCount,
                                    "changes": LongLivedWindows.shared.transitions]
        try? PrivateFiles.write(JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
                                to: root.appendingPathComponent("activation-policy.json"))
    }
    #endif
}

@MainActor private final class DebugWorkWindow: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var window: NSWindow?
    init(model: AppModel) { self.model = model }
    func show() {
        guard model.diagnostics.debugMode else { return }
        model.setDebugWindowVisible(true)
        if window == nil {
            let controller = NSHostingController(rootView: StatusPanel(model: model, surface: .debug))
            let window = NSWindow(contentViewController: controller)
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.title = "Magic Code · 调试"; window.isReleasedWhenClosed = false
            window.delegate = self; window.center(); self.window = window
            LongLivedWindows.shared.register(window)
        }
        window?.deminiaturize(nil); window?.makeKeyAndOrderFront(nil)
        model.panelVisibility(true, surface: .debug)
        NSApp.activate(ignoringOtherApps: true)
    }
    func close() { window?.close() }
    func windowWillClose(_ notification: Notification) { model.panelVisibility(false, surface: .debug); model.setDebugWindowVisible(false) }
    func windowDidMiniaturize(_ notification: Notification) { model.panelVisibility(false, surface: .debug) }
    func windowDidDeminiaturize(_ notification: Notification) { model.panelVisibility(true, surface: .debug) }
}

private struct SettingsLaunch: ViewModifier {
    @Environment(\.openSettings) private var openSettings
    @State private var opened = false
    func body(content: Content) -> some View {
        content.task {
            guard !opened, CommandLine.arguments.contains("--settings") else { return }
            opened = true; openSettings(); NSApp.activate(ignoringOtherApps: true)
        }
    }
}
