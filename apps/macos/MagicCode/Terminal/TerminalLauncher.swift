import AppKit

struct TerminalCommand {
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func make(helper: URL, workspace: URL, base: URL?, session: String?, request: String?) -> String {
        let instance = base.map { "MAGIC_HOME=\(quote($0.path))" } ?? "/usr/bin/env -u MAGIC_HOME"
        var command = "cd -- \(quote(workspace.path)) && \(instance) \(quote(helper.path))"
        if let session { command += " resume \(quote(session))" }
        if let request { command += " --open-request \(quote(request))" }
        return command
    }
}

@MainActor final class TerminalLauncher: ObservableObject {
    struct Pending { let request: String; let session: String?; let file: URL; let command: String }
    @Published private(set) var pending: [String: Pending] = [:]
    @Published var message: String?
    @Published var fallbackCommand: String?
    let directory: URL
    var copyText: (String) -> Void = { text in NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
    var openFile: ((URL, @escaping (Error?) -> Void) -> Void)?
    #if DEBUG
    var validationHome: URL?
    var validationEvent: ((String, String) -> Void)?
    #endif
    private func openInTerminal(_ url: URL, completion: @escaping (Error?) -> Void) {
        guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") else {
            completion(WireError.invalid("找不到 Terminal.app")); return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        #if DEBUG
        let previous = NSWorkspace.shared.frontmostApplication
        let existing = Set(NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Terminal").map(\.processIdentifier))
        if let validationHome {
            configuration.createsNewApplicationInstance = true
            configuration.activates = false
            configuration.addsToRecentItems = false
            configuration.environment = ["HOME": validationHome.path, "ZDOTDIR": validationHome.path]
        }
        #endif
        NSWorkspace.shared.open([url], withApplicationAt: terminal, configuration: configuration) { [weak self] application, error in
            DispatchQueue.main.async {
                #if DEBUG
                if self?.validationHome != nil, let application {
                    let reused = existing.contains(application.processIdentifier)
                    let stoleFocus = NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier
                    if stoleFocus { previous?.activate(options: []) }
                    self?.validationEvent?("terminal.opened", "pid=\(application.processIdentifier), reused=\(reused), restoredFocus=\(stoleFocus)")
                    if reused { completion(WireError.invalid("验收需要独立 Terminal 实例；未继续控制已有窗口")); return }
                }
                #endif
                completion(error)
            }
        }
    }
    init(directory: URL) { self.directory = directory }
    func cleanupExpired(now: Date = Date()) {
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey]) else { return }
        for file in files where file.pathExtension == "command" {
            if let values = try? file.resourceValues(forKeys: [.contentModificationDateKey]),
               let date = values.contentModificationDate, now.timeIntervalSince(date) > 86400 {
                try? FileManager.default.removeItem(at: file)
            }
        }
    }
    func open(helper: URL, workspace: URL, base: URL?) {
        let session: String? = nil
        let key = "new-draft"
        guard pending[key] == nil else { return }
        let request = UUID().uuidString
        let command = TerminalCommand.make(helper: helper, workspace: workspace, base: base, session: session, request: request)
        let file = directory.appendingPathComponent("\(request).command")
        do {
            var script = "#!/bin/zsh -f\n" + command + "\n"
            #if DEBUG
            if let validationHome {
                let evidence = validationHome.appendingPathComponent("terminal-evidence/\(request)")
                try FileManager.default.createDirectory(at: evidence, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                let context: [String: Any] = ["request": request, "session": session as Any? ?? NSNull(), "home": validationHome.path,
                                              "helper": helper.path, "workspace": workspace.path, "command": command]
                try PrivateFiles.write(JSONSerialization.data(withJSONObject: context, options: [.sortedKeys]), to: evidence.appendingPathComponent("context.json"))
                let recordedCommand = command + "\nmagic_cli_exit=$?\n" +
                    "printf '%s\\n' \"$magic_cli_exit\" > \(TerminalCommand.quote(evidence.appendingPathComponent("exit-code").path))\nexit \"$magic_cli_exit\"\n"
                let env = ["/usr/bin/env", "-i", "HOME=\(validationHome.path)", "ZDOTDIR=\(validationHome.path)",
                           "PATH=/usr/bin:/bin", "SHELL=/bin/zsh", "LANG=zh_CN.UTF-8", "TERM=xterm-256color",
                           "/usr/bin/script", "-q", evidence.appendingPathComponent("tty.log").path, "/bin/zsh", "-f", "-c", recordedCommand]
                script = "#!/bin/zsh -f\numask 077\n" +
                    "printf '%s\\n' \"$$\" > \(TerminalCommand.quote(evidence.appendingPathComponent("shell.pid").path))\n" +
                    env.map(TerminalCommand.quote).joined(separator: " ") + "\nmagic_terminal_exit=$?\n" +
                    "printf '%s\\n' \"$magic_terminal_exit\" > \(TerminalCommand.quote(evidence.appendingPathComponent("recorder-exit-code").path))\nexit \"$magic_terminal_exit\"\n"
            }
            #endif
            try PrivateFiles.write(Data(script.utf8), to: file, mode: 0o700)
            pending[key] = Pending(request: request, session: session, file: file, command: command)
            message = "等待终端接入…"; fallbackCommand = command
            let completion: (Error?) -> Void = { [weak self] error in
                guard let self, let error, self.pending[key]?.request == request else { return }
                self.pending.removeValue(forKey: key)
                self.message = "终端未打开：\(error.localizedDescription)"
            }
            if let openFile { openFile(file, completion) } else { openInTerminal(file, completion: completion) }
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.pending[key]?.request == request else { return }
                self.pending.removeValue(forKey: key)
                self.message = "尚未收到终端接入确认。可复制命令重试。"
            }
        } catch { message = error.localizedDescription; fallbackCommand = command }
    }
    @discardableResult func attached(request: String, session: String?) -> Bool {
        guard let entry = pending.first(where: { $0.value.request == request }), entry.value.session == session else { return false }
        try? FileManager.default.removeItem(at: entry.value.file)
        pending.removeValue(forKey: entry.key)
        message = "已在终端接入"; fallbackCommand = nil
        return true
    }
    func copy(_ command: String) { copyText(command) }
}

enum CLIInstallation {
    static func install(helper: URL, at link: URL, app: URL) throws {
        guard !app.path.hasPrefix("/Volumes/") else { throw WireError.invalid("请先把 App 移到 Applications，再安装终端命令。") }
        try FileManager.default.createDirectory(at: link.deletingLastPathComponent(), withIntermediateDirectories: true)
        var info = stat()
        if lstat(link.path, &info) == 0 {
            if try belongs(link, helper: helper) { return }
            throw WireError.invalid("安装位置已被占用：\(link.path)。请选择其他目录。")
        }
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: helper)
    }
    static func belongs(_ link: URL, helper: URL) throws -> Bool {
        guard let destination = try? FileManager.default.destinationOfSymbolicLink(atPath: link.path) else { return false }
        return URL(fileURLWithPath: destination, relativeTo: link.deletingLastPathComponent()).standardizedFileURL == helper.standardizedFileURL
    }
    static func remove(link: URL, helper: URL) throws {
        if try belongs(link, helper: helper) { try FileManager.default.removeItem(at: link) }
    }
}
