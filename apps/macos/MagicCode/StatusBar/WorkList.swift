import Foundation

enum WorkGroup: Int, CaseIterable, Identifiable {
    case needsYou, uncertain, running, recent
    var id: Int { rawValue }
    var title: String { ["需要你", "异常 / 状态待确认", "执行中", "最近结果"][rawValue] }
    static func of(_ work: NativeWork) -> WorkGroup {
        if work.state == .waiting { return .needsYou }
        if work.state == .unknown || work.notices.contains(where: { $0.kind == .failed && $0.unread }) { return .uncertain }
        if work.affected || work.state == .running || work.state == .stopping { return .running }
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
    func rows(_ group: WorkGroup, works: [NativeWork]) -> [NativeWork] {
        let byID = Dictionary(works.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let rows = order.compactMap { id in groups[id] == group ? byID[id] : nil }
        return group == .recent ? Array(rows.prefix(10)) : rows
    }
}
