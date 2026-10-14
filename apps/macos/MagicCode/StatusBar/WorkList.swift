import Foundation

enum WorkGroup: Int, CaseIterable, Identifiable {
    case needsYou, uncertain, running, results, opened
    var id: Int { rawValue }
    var title: String { ["需要你", "异常 / 状态待确认", "进行中", "结果待查看", "终端已连接"][rawValue] }
    static func of(_ work: NativeWork) -> WorkGroup? {
        if work.state == .waiting { return .needsYou }
        if work.state == .unknown { return .uncertain }
        if work.affected || work.state == .running || work.state == .stopping { return .running }
        if let notice = work.currentNotice, notice.unread {
            switch notice.kind { case .failed: return .uncertain; case .done: return .results; case .needsYou: return .needsYou }
        }
        return work.terminalOpen ? .opened : nil
    }
}

/// Only presentation order is retained. All work facts still come from the latest projection.
struct WorkList {
    private(set) var order: [String] = []
    mutating func update(_ works: [NativeWork], interacting: Bool) {
        let ids = Set(works.map(\.id))
        if !interacting { order = [] }
        order.removeAll { !ids.contains($0) }
        for work in works.sorted(by: { $0.since > $1.since }) where !order.contains(work.id) {
            order.append(work.id)
        }
    }
    static func shortPath(_ path: String, among paths: [String]) -> String {
        let parts = path.split(separator: "/")
        for count in 2...max(2, parts.count) {
            let suffix = parts.suffix(count).joined(separator: "/")
            if !paths.contains(where: { $0 != path && $0.split(separator: "/").suffix(count).joined(separator: "/") == suffix }) {
                return parts.count > count ? "…/" + suffix : path
            }
        }
        return path
    }
    func rows(_ group: WorkGroup, works: [NativeWork]) -> [NativeWork] {
        let byID = Dictionary(works.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let rows = order.compactMap { byID[$0] }.filter { WorkGroup.of($0) == group }
        return rows
    }
}
