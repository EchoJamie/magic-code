import AppKit

struct TerminalCommand {
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func make(helper: URL, workspace: URL, base: URL, session: String) -> String {
        let instance = "MAGIC_HOME=\(quote(base.path))"
        return "cd -- \(quote(workspace.path)) && \(instance) \(quote(helper.path)) resume \(quote(session))"
    }
}
