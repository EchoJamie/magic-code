import Foundation

enum WorkGroup: Int, CaseIterable, Identifiable {
    case needsYou, uncertain, running, recent
    var id: Int { rawValue }
    var title: String { ["需要你", "异常 / 状态待确认", "进行中", "最近工作"][rawValue] }
    static func of(_ work: NativeWork) -> WorkGroup {
        if work.state == .waiting { return .needsYou }
        if work.state == .unknown { return .uncertain }
        if work.affected || work.state == .running || work.state == .stopping { return .running }
        if work.notices.contains(where: { $0.kind == .failed && $0.unread }) { return .uncertain }
        return .recent
    }
}

/// Only presentation order is retained. All work facts still come from the latest projection.
struct WorkList {
    private(set) var order: [String] = []
    private var groups: [String: WorkGroup] = [:]
    mutating func update(_ works: [NativeWork], interacting: Bool) {
        let ids = Set(works.map(\.id))
        if !interacting { order = []; groups = [:] }
        order.removeAll { !ids.contains($0) }
        groups = groups.filter { ids.contains($0.key) }
        for work in works.sorted(by: { $0.since > $1.since }) where !order.contains(work.id) {
            order.append(work.id); groups[work.id] = WorkGroup.of(work)
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
        let rows = order.compactMap { id in groups[id] == group ? byID[id] : nil }
        return group == .recent ? Array(rows.prefix(10)) : rows
    }
}
