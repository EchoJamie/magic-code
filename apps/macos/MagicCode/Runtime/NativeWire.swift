import Foundation

// Codable adapter for packages/contracts/src/native.ts; no fallback wire versions.
struct ServiceIdentity: Codable, Equatable {
    let `protocol`: Int
    let version: String
    let source: String
    let serviceInstance: String
    let base: String
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.protocol == rhs.protocol && lhs.version == rhs.version && lhs.source == rhs.source &&
        lhs.serviceInstance == rhs.serviceInstance &&
        URL(fileURLWithPath: lhs.base).resolvingSymlinksInPath().path == URL(fileURLWithPath: rhs.base).resolvingSymlinksInPath().path
    }
}
struct HostDiscovery: Codable, Equatable {
    let `protocol`: Int
    let version: String
    let source: String
    let serviceInstance: String
    let socket: String
    let base: String
    let lifecycle: String
    let pid: Int?
    let startedAt: Double?
    let state: String
    let request: String?
    let error: String?
    var identity: ServiceIdentity { ServiceIdentity(protocol: `protocol`, version: version, source: source, serviceInstance: serviceInstance, base: base) }

}
extension HostDiscovery {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        `protocol` = try c.decode(Int.self, forKey: .protocol)
        version = try c.decode(String.self, forKey: .version)
        source = try c.decode(String.self, forKey: .source)
        serviceInstance = try c.decode(String.self, forKey: .serviceInstance)
        socket = try c.decode(String.self, forKey: .socket)
        base = try c.decode(String.self, forKey: .base)
        lifecycle = try c.decode(String.self, forKey: .lifecycle)
        pid = try c.decodeOptional(Int.self, forKey: .pid)
        startedAt = try c.decodeOptional(Double.self, forKey: .startedAt)
        state = try c.decode(String.self, forKey: .state)
        request = try c.decodeOptional(String.self, forKey: .request)
        error = try c.decodeOptional(String.self, forKey: .error)
        guard ["starting", "ready", "stopping", "stopped", "unreachable", "failed"].contains(state) else { throw WireError.invalid("未知 Engine 状态") }
    }
}
enum RunState: String, Codable { case running, waiting, stopping, stopped, idle, unknown }
enum StopPhase: String, Codable { case accepted, done, unconfirmed }
enum NoticeKind: String, Codable { case done, failed; case needsYou = "needs-you" }
struct AttentionSource: Codable, Equatable {
    let session: String
    var event: Int? = nil
    var entry: Int? = nil
}
struct AttentionItem: Codable, Equatable, Identifiable {
    let id: String
    let session: String
    let kind: NoticeKind
    let at: Double
    let detail: String?
    let unread: Bool
    let delivered: Bool
    let fact: String
    var source: AttentionSource? = nil
}
struct NativeMember: Codable, Equatable, Identifiable {
    let session: String
    let name: String
    let state: RunState
    let action: String?
    let reason: String?
    var id: String { session }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        session = try c.decode(String.self, forKey: .session)
        name = try c.decode(String.self, forKey: .name)
        state = try c.decode(RunState.self, forKey: .state)
        action = try c.decodeOptional(String.self, forKey: .action)
        reason = try c.decodeOptional(String.self, forKey: .reason)
    }
}
struct NativeWork: Codable, Equatable, Identifiable {
    let background: Int?
    let session: String
    let title: String
    let workspace: [String]
    let state: RunState
    let action: String?
    let reason: String?
    let since: Double
    let gen: Int?
    let affected: Bool
    let archived: Bool
    let canArchive: Bool
    let terminalOpen: Bool
    let currentNotice: AttentionItem?
    let members: [NativeMember]?
    private enum Keys: String, CodingKey { case background, session, title, workspace, state, action, reason, since, gen, affected, archived, canArchive, terminalOpen, currentNotice, members }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        background = try c.decodeOptional(Int.self, forKey: .background)
        if let background, background < 0 { throw DecodingError.dataCorruptedError(forKey: .background, in: c, debugDescription: "后台命令数量无效") }
        session = try c.decode(String.self, forKey: .session)
        title = try c.decode(String.self, forKey: .title)
        workspace = try c.decode([String].self, forKey: .workspace)
        state = try c.decode(RunState.self, forKey: .state)
        action = try c.decodeOptional(String.self, forKey: .action)
        reason = try c.decodeOptional(String.self, forKey: .reason)
        since = try c.decode(Double.self, forKey: .since)
        gen = try c.decode(Int?.self, forKey: .gen)
        affected = try c.decode(Bool.self, forKey: .affected)
        archived = try c.decode(Bool.self, forKey: .archived)
        canArchive = try c.decode(Bool.self, forKey: .canArchive)
        terminalOpen = try c.decode(Bool.self, forKey: .terminalOpen)
        currentNotice = try c.decodeOptional(AttentionItem.self, forKey: .currentNotice)
        members = try c.decodeOptional([NativeMember].self, forKey: .members)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encodeIfPresent(background, forKey: .background)
        try c.encode(session, forKey: .session)
        try c.encode(title, forKey: .title)
        try c.encode(workspace, forKey: .workspace)
        try c.encode(state, forKey: .state)
        try c.encodeIfPresent(action, forKey: .action)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encode(since, forKey: .since)
        try c.encode(gen, forKey: .gen)
        try c.encode(affected, forKey: .affected)
        try c.encode(archived, forKey: .archived)
        try c.encode(canArchive, forKey: .canArchive)
        try c.encode(terminalOpen, forKey: .terminalOpen)
        try c.encodeIfPresent(currentNotice, forKey: .currentNotice)
        try c.encodeIfPresent(members, forKey: .members)
    }
    var backgroundText: String? { background.map { $0 > 0 ? "\($0) 个后台命令运行中" : nil } ?? "后台命令数量待确认" }
    var id: String { session }
    var project: String { workspace.first.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "未选项目" }
    var statusText: String {
        if let action, !action.isEmpty { return action }
        if let reason, !reason.isEmpty { return reason }
        switch state {
        case .running: return "正在执行"
        case .waiting: return "等待你的答复"
        case .stopping: return "正在停止"
        case .stopped: return "已停止"
        case .idle: return "当前空闲"
        case .unknown: return "状态待确认"
        }
    }
}
struct ConfigurationAdoption: Codable, Equatable {
    let stamp: String?
    let error: String?
}
struct NativeProjection: Codable, Equatable {
    let serviceInstance: String
    let revision: Int
    let accepting: Bool
    let works: [NativeWork]
    var configuration: ConfigurationAdoption? = nil
}

enum NativeRequest: Codable, Equatable {
    case hello(role: String, protocol: Int, version: String, source: String, base: String)
    case refresh
    case engineStop(request: String, identity: ServiceIdentity, idleOnly: Bool?)
    case runtimeRead(request: String)
    case runtimeReconnect(request: String, serviceInstance: String, session: String, gen: Int, name: String)
    case inspect(request: String, session: String, notice: String?)
    case stop(request: String, serviceInstance: String, session: String, gen: Int)
    case read(serviceInstance: String, ids: [String])
    case delivered(serviceInstance: String, ids: [String])
    case sessions(request: String, archived: Bool?, workspace: [String]?, search: String?)
    case history(request: String, session: String, after: Int?, source: AttentionSource?)
    case manage(request: String, serviceInstance: String, items: [SessionManagement])
    private enum Keys: String, CodingKey { case after, archived, items, search, workspace, t, role, `protocol`, version, source, base, request, session, notice, serviceInstance, gen, ids, name, identity, idleOnly }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "native.sessions": self = .sessions(request: try c.decode(String.self, forKey: .request), archived: try c.decodeOptional(Bool.self, forKey: .archived), workspace: try c.decodeOptional([String].self, forKey: .workspace), search: try c.decodeOptional(String.self, forKey: .search))
        case "native.history": self = .history(request: try c.decode(String.self, forKey: .request), session: try c.decode(String.self, forKey: .session), after: try c.decodeOptional(Int.self, forKey: .after), source: try c.decodeOptional(AttentionSource.self, forKey: .source))
        case "native.session.manage": self = .manage(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), items: try c.decode([SessionManagement].self, forKey: .items))

        case "hello": self = .hello(role: try c.decode(String.self, forKey: .role), protocol: try c.decode(Int.self, forKey: .protocol), version: try c.decode(String.self, forKey: .version), source: try c.decode(String.self, forKey: .source), base: try c.decode(String.self, forKey: .base))
        case "native.runtime.read": self = .runtimeRead(request: try c.decode(String.self, forKey: .request))
        case "native.runtime.reconnect": self = .runtimeReconnect(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), session: try c.decode(String.self, forKey: .session), gen: try c.decode(Int.self, forKey: .gen), name: try c.decode(String.self, forKey: .name))
        case "native.engine.stop": self = .engineStop(request: try c.decode(String.self, forKey: .request), identity: try c.decode(ServiceIdentity.self, forKey: .identity), idleOnly: try c.decodeOptional(Bool.self, forKey: .idleOnly))
        case "native.refresh": self = .refresh
        case "native.inspect": self = .inspect(request: try c.decode(String.self, forKey: .request), session: try c.decode(String.self, forKey: .session), notice: try c.decodeOptional(String.self, forKey: .notice))
        case "native.stop": self = .stop(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), session: try c.decode(String.self, forKey: .session), gen: try c.decode(Int.self, forKey: .gen))
        case "native.read": self = .read(serviceInstance: try c.decode(String.self, forKey: .serviceInstance), ids: try c.decode([String].self, forKey: .ids))
        case "native.delivered": self = .delivered(serviceInstance: try c.decode(String.self, forKey: .serviceInstance), ids: try c.decode([String].self, forKey: .ids))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
        if case .hello(let role, _, _, _, _) = self, role != "observer" { throw WireError.invalid("观察连接用途必须为 observer") }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .sessions(request, archived, workspace, search):
            try c.encode("native.sessions", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encodeIfPresent(archived, forKey: .archived)
            try c.encodeIfPresent(workspace, forKey: .workspace)
            try c.encodeIfPresent(search, forKey: .search)
        case let .history(request, session, after, source):
            try c.encode("native.history", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(session, forKey: .session)
            try c.encodeIfPresent(after, forKey: .after)
            try c.encodeIfPresent(source, forKey: .source)
        case let .manage(request, serviceInstance, items):
            try c.encode("native.session.manage", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(items, forKey: .items)

        case let .hello(role, `protocol`, version, source, base):
            try c.encode("hello", forKey: .t)
            try c.encode(role, forKey: .role)
            try c.encode(`protocol`, forKey: .protocol)
            try c.encode(version, forKey: .version)
            try c.encode(source, forKey: .source)
            try c.encode(base, forKey: .base)
        case let .runtimeRead(request):
            try c.encode("native.runtime.read", forKey: .t); try c.encode(request, forKey: .request)
        case let .runtimeReconnect(request, serviceInstance, session, gen, name):
            try c.encode("native.runtime.reconnect", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance); try c.encode(session, forKey: .session)
            try c.encode(gen, forKey: .gen); try c.encode(name, forKey: .name)
        case let .engineStop(request, identity, idleOnly):
            try c.encode("native.engine.stop", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(identity, forKey: .identity); try c.encodeIfPresent(idleOnly, forKey: .idleOnly)
        case .refresh:
            try c.encode("native.refresh", forKey: .t)
        case let .inspect(request, session, notice):
            try c.encode("native.inspect", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(session, forKey: .session)
            try c.encodeIfPresent(notice, forKey: .notice)
        case let .stop(request, serviceInstance, session, gen):
            try c.encode("native.stop", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(session, forKey: .session)
            try c.encode(gen, forKey: .gen)
        case let .read(serviceInstance, ids):
            try c.encode("native.read", forKey: .t)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(ids, forKey: .ids)
        case let .delivered(serviceInstance, ids):
            try c.encode("native.delivered", forKey: .t)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(ids, forKey: .ids)
        }
    }
}

enum EngineStopPhase: String, Codable { case accepted, done, failed }

enum NativeResponse: Codable, Equatable {
    case welcome(identity: ServiceIdentity, projection: NativeProjection)
    case projection(projection: NativeProjection)
    case inspected(request: String, work: NativeWork?, error: String?)
    case stopped(request: String, session: String, phase: StopPhase, note: String?)
    case attached(request: String, session: String?)
    case runtimeResult(request: String, serviceInstance: String, mcp: [SettingsValue]?, canChangeData: Bool?, error: String?, note: String?)
    case engineResult(request: String, phase: EngineStopPhase, error: String?)
    case error(reason: String)
    case sessionsResult(request: String, serviceInstance: String, sessions: [NativeSession]?, error: String?)
    case historyResult(request: String, serviceInstance: String, session: String, entries: [HistoryEntry]?, events: [HistoryEvent]?, currentRequests: [HistoryEvent]?, next: Int?, done: Bool, error: String?)
    case managed(request: String, serviceInstance: String, results: [SessionManagementResult])
    private enum Keys: String, CodingKey { case done, entries, events, currentRequests, next, results, sessions, t, identity, projection, request, work, error, session, phase, note, reason, serviceInstance, base, snapshot, mcp, canChangeData }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "native.sessions.result": self = .sessionsResult(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), sessions: try c.decodeOptional([NativeSession].self, forKey: .sessions), error: try c.decodeOptional(String.self, forKey: .error))
        case "native.history.result": self = .historyResult(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), session: try c.decode(String.self, forKey: .session), entries: try c.decodeOptional([HistoryEntry].self, forKey: .entries), events: try c.decodeOptional([HistoryEvent].self, forKey: .events), currentRequests: try c.decodeOptional([HistoryEvent].self, forKey: .currentRequests), next: try c.decodeOptional(Int.self, forKey: .next), done: try c.decode(Bool.self, forKey: .done), error: try c.decodeOptional(String.self, forKey: .error))
        case "native.session.managed": self = .managed(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), results: try c.decode([SessionManagementResult].self, forKey: .results))

        case "native.welcome": self = .welcome(identity: try c.decode(ServiceIdentity.self, forKey: .identity), projection: try c.decode(NativeProjection.self, forKey: .projection))
        case "native.projection": self = .projection(projection: try c.decode(NativeProjection.self, forKey: .projection))
        case "native.inspected": self = .inspected(request: try c.decode(String.self, forKey: .request), work: try c.decodeOptional(NativeWork.self, forKey: .work), error: try c.decodeOptional(String.self, forKey: .error))
        case "native.stopped": self = .stopped(request: try c.decode(String.self, forKey: .request), session: try c.decode(String.self, forKey: .session), phase: try c.decode(StopPhase.self, forKey: .phase), note: try c.decodeOptional(String.self, forKey: .note))
        case "native.attached": self = .attached(request: try c.decode(String.self, forKey: .request), session: try c.decode(String?.self, forKey: .session))
        case "native.runtime.result": self = .runtimeResult(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), mcp: try c.decodeOptional([SettingsValue].self, forKey: .mcp), canChangeData: try c.decodeOptional(Bool.self, forKey: .canChangeData), error: try c.decodeOptional(String.self, forKey: .error), note: try c.decodeOptional(String.self, forKey: .note))
        case "native.engine.result": self = .engineResult(request: try c.decode(String.self, forKey: .request), phase: try c.decode(EngineStopPhase.self, forKey: .phase), error: try c.decodeOptional(String.self, forKey: .error))
        case "native.error": self = .error(reason: try c.decode(String.self, forKey: .reason))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
        if case .inspected(_, let work, let error) = self, (work == nil) == (error == nil) {
            throw WireError.invalid("事项查询必须给出 work 或 error 其中一项")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .sessionsResult(request, serviceInstance, sessions, error):
            try c.encode("native.sessions.result", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encodeIfPresent(sessions, forKey: .sessions)
            try c.encodeIfPresent(error, forKey: .error)
        case let .historyResult(request, serviceInstance, session, entries, events, currentRequests, next, done, error):
            try c.encode("native.history.result", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(session, forKey: .session)
            try c.encodeIfPresent(entries, forKey: .entries)
            try c.encodeIfPresent(events, forKey: .events)
            try c.encodeIfPresent(currentRequests, forKey: .currentRequests)
            try c.encodeIfPresent(next, forKey: .next)
            try c.encode(done, forKey: .done)
            try c.encodeIfPresent(error, forKey: .error)
        case let .managed(request, serviceInstance, results):
            try c.encode("native.session.managed", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encode(results, forKey: .results)

        case let .welcome(identity, projection):
            try c.encode("native.welcome", forKey: .t)
            try c.encode(identity, forKey: .identity)
            try c.encode(projection, forKey: .projection)
        case let .projection(projection):
            try c.encode("native.projection", forKey: .t)
            try c.encode(projection, forKey: .projection)
        case let .inspected(request, work, error):
            try c.encode("native.inspected", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encodeIfPresent(work, forKey: .work)
            try c.encodeIfPresent(error, forKey: .error)
        case let .stopped(request, session, phase, note):
            try c.encode("native.stopped", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(session, forKey: .session)
            try c.encode(phase, forKey: .phase)
            try c.encodeIfPresent(note, forKey: .note)
        case let .attached(request, session):
            try c.encode("native.attached", forKey: .t)
            try c.encode(request, forKey: .request)
            try c.encode(session, forKey: .session)
        case let .runtimeResult(request, serviceInstance, mcp, canChangeData, error, note):
            try c.encode("native.runtime.result", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance)
            try c.encodeIfPresent(mcp, forKey: .mcp); try c.encodeIfPresent(canChangeData, forKey: .canChangeData)
            try c.encodeIfPresent(error, forKey: .error); try c.encodeIfPresent(note, forKey: .note)
        case let .engineResult(request, phase, error):
            try c.encode("native.engine.result", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(phase, forKey: .phase); try c.encodeIfPresent(error, forKey: .error)
        case let .error(reason):
            try c.encode("native.error", forKey: .t)
            try c.encode(reason, forKey: .reason)
        }
    }
}

enum WireError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let text) = self { return text }; return nil }
}
struct JSONLines {
    private var buffer = Data()
    mutating func append(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var lines: [Data] = []
        while let end = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<end]); buffer.removeSubrange(...end)
            if !line.isEmpty { lines.append(line) }
        }
        guard buffer.count <= 8 * 1024 * 1024 else { throw WireError.invalid("协议帧超过大小限制") }
        return lines
    }
}

private extension KeyedDecodingContainer {
    func decodeOptional<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        // TS optional means absent, not JSON null. Nullable wire fields use decode(T?.self).
        contains(key) ? try decode(type, forKey: key) : nil
    }
}
extension AttentionItem {
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        session = try c.decode(String.self, forKey: .session)
        kind = try c.decode(NoticeKind.self, forKey: .kind)
        at = try c.decode(Double.self, forKey: .at)
        detail = try c.decodeOptional(String.self, forKey: .detail)
        unread = try c.decode(Bool.self, forKey: .unread)
        delivered = try c.decode(Bool.self, forKey: .delivered)
        fact = try c.decode(String.self, forKey: .fact)
        source = try c.decodeOptional(AttentionSource.self, forKey: .source)
    }
}

struct NativeSession: Codable, Equatable, Identifiable {
    var background: Int? = nil
    var backgroundText: String? { background.map { $0 > 0 ? "\($0) 个后台命令运行中" : nil } ?? "后台命令数量待确认" }
    let id: String
    let title: String?
    let at: Double
    let workspace: [String]?
    let archived: Bool
    let canArchive: Bool
    let terminalOpen: Bool
    let state: RunState
    let reason: String?
    let recentInput: String?
    let recentProgress: String?
    var displayTitle: String { title.flatMap { $0.isEmpty ? nil : $0 } ?? "未命名会话" }
}
struct SessionManagement: Codable, Equatable {
    let session: String
    let action: String
    var title: String? = nil
}
struct SessionManagementResult: Codable, Equatable {
    let session: String
    let action: String
    let title: String?
    let ok: Bool
    let archived: Bool?
    let error: String?
}
struct HistoryEntry: Codable, Equatable, Identifiable {
    let id: Int
    let kind: String
    let content: SettingsValue
    let payload: SettingsValue?
    let at: Double
    let source: String?
    var text: String { content.object["text"]?.text ?? "正文以附件保存，暂不可读取。" }
}

struct HistoryEvent: Codable, Equatable, Identifiable {
    let turn: Int?
    let id: Int
    let session: String
    let at: Double
    let kind: String
    let data: SettingsValue
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(turn, forKey: .turn); try c.encode(id, forKey: .id)
        try c.encode(session, forKey: .session); try c.encode(at, forKey: .at)
        try c.encode(kind, forKey: .kind); try c.encode(data, forKey: .data)
    }
    var text: String {
        if let material = data.object["material"] { return material.text.isEmpty ? material.pretty : material.text }
        if let message = data.object["message"] { return message.text }
        return data.pretty
    }
}
extension SettingsValue {
    var pretty: String {
        guard let data = try? JSONEncoder().encode(self), let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let formatted = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return text }
        return String(decoding: formatted, as: UTF8.self)
    }
}
