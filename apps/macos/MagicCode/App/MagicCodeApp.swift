import SwiftUI
import AppKit
import Combine

@main struct MagicCodeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model: AppModel
    init() {
        let args = CommandLine.arguments
        #if DEBUG
        let fixedRoot = AppModel.systemTestRoot(bundle: .main)
        if Bundle.main.bundleIdentifier?.hasPrefix("com.magiccode.validation.") == true, fixedRoot == nil {
            FileHandle.standardError.write(Data("系统验收隔离根无效，拒绝启动\n".utf8)); exit(78)
        }
        let root = fixedRoot ?? args.firstIndex(of: "--validation-root").flatMap { args.indices.contains($0 + 1) ? URL(fileURLWithPath: args[$0 + 1]) : nil }
        #else
        let root: URL? = nil
        #endif
        let model = AppModel(validationRoot: root)
        _model = StateObject(wrappedValue: model)
        AppDelegate.model = model
    }
    var body: some Scene {
        MenuBarExtra {
            StatusPanel(model: model)
        } label: {
            Image(systemName: model.symbol).accessibilityLabel("Magic Code，\(model.summary)")
        }.menuBarExtraStyle(.window)
        Settings { SettingsView(model: model) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    static var model: AppModel?
    private var terminating = false
    private var awaitingTerminationReply = false
    private var powerOff: NSObjectProtocol?
    private var validation: AnyCancellable?
    private var noticeWindow: NSWindow?
    #if DEBUG
    private var systemTestTimer: Timer?
    #endif
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        NSApp.setActivationPolicy(.accessory)
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
                    if let index = CommandLine.arguments.firstIndex(of: "--validation-open-session"), CommandLine.arguments.indices.contains(index + 1) {
                        let session = CommandLine.arguments[index + 1]
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                            guard let work = model.works.first(where: { $0.session == session }) else {
                                model.validationEvent("terminal.error", detail: "隔离目标不存在：\(session)"); return
                            }
                            model.inspect(work, open: true)
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
        // SwiftUI's panel can be closed when Quit comes from the system. Show the same
        // confirmation in an AppKit sheet only for a real user termination request.
        if Self.model?.showQuitConfirmation == true, Self.model?.presentQuitAlert() == false {
            awaitingTerminationReply = false
            return .terminateCancel
        }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
}

extension AppModel {
    func presentQuitAlert() -> Bool {
        let alert = makeQuitAlert()
        NSApp.activate(ignoringOtherApps: true)
        // NSAlert's default button consumes Escape before cancelOperation on the tested macOS.
        let escape = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.window === alert.window, event.keyCode == 53,
                  event.modifierFlags.intersection([.command, .control, .option]).isEmpty else { return event }
            alert.buttons[0].performClick(nil)
            return nil
        }
        defer { if let escape { NSEvent.removeMonitor(escape) } }
        let response = alert.runModal()
        if response == .alertSecondButtonReturn { confirmQuit(); return true }
        cancelQuit(); return false
    }
}
