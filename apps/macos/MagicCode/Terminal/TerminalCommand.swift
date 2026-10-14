import AppKit

struct TerminalCommand {
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func make(helper: URL, workspace: URL, base: URL, session: String) -> String {
        let instance = "MAGIC_HOME=\(quote(base.path))"
        return "cd -- \(quote(workspace.path)) && \(instance) \(quote(helper.path)) resume \(quote(session))"
    }
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
