import Foundation

// Codable adapter for packages/contracts/src/native.ts; no fallback wire versions.
struct ServiceIdentity: Codable, Equatable {
    let `protocol`: Int
    let version: String
    let source: String
    let hostInstance: String
    let serviceInstance: String
    let dataDir: String
}
struct HostDiscovery: Codable, Equatable {
    let `protocol`: Int
    let version: String
    let source: String
    let hostInstance: String
    let serviceInstance: String
    let dataDir: String
    let socket: String
    let base: String
    let app: String
    init(identity: ServiceIdentity, socket: String, base: String, app: String) {
        self.protocol = identity.protocol; version = identity.version; source = identity.source
        hostInstance = identity.hostInstance; serviceInstance = identity.serviceInstance
        dataDir = identity.dataDir; self.socket = socket; self.base = base; self.app = app
    }
}
enum RunState: String, Codable { case running, waiting, stopping, stopped, idle, unknown }
enum StopPhase: String, Codable { case accepted, done, unconfirmed }
enum NoticeKind: String, Codable { case done, failed; case needsYou = "needs-you" }
struct AttentionItem: Codable, Equatable, Identifiable {
    let id: String
    let session: String
    let kind: NoticeKind
    let at: Double
    let detail: String?
    let unread: Bool
    let delivered: Bool
    let fact: String
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
    let session: String
    let title: String
    let workspace: [String]
    let state: RunState
    let action: String?
    let reason: String?
    let since: Double
    let gen: Int?
    let affected: Bool
    let notices: [AttentionItem]
    let members: [NativeMember]?
    private enum Keys: String, CodingKey { case session, title, workspace, state, action, reason, since, gen, affected, notices, members }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        session = try c.decode(String.self, forKey: .session)
        title = try c.decode(String.self, forKey: .title)
        workspace = try c.decode([String].self, forKey: .workspace)
        state = try c.decode(RunState.self, forKey: .state)
        action = try c.decodeOptional(String.self, forKey: .action)
        reason = try c.decodeOptional(String.self, forKey: .reason)
        since = try c.decode(Double.self, forKey: .since)
        gen = try c.decode(Int?.self, forKey: .gen)
        affected = try c.decode(Bool.self, forKey: .affected)
        notices = try c.decode([AttentionItem].self, forKey: .notices)
        members = try c.decodeOptional([NativeMember].self, forKey: .members)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(session, forKey: .session)
        try c.encode(title, forKey: .title)
        try c.encode(workspace, forKey: .workspace)
        try c.encode(state, forKey: .state)
        try c.encodeIfPresent(action, forKey: .action)
        try c.encodeIfPresent(reason, forKey: .reason)
        try c.encode(since, forKey: .since)
        try c.encode(gen, forKey: .gen)
        try c.encode(affected, forKey: .affected)
        try c.encode(notices, forKey: .notices)
        try c.encodeIfPresent(members, forKey: .members)
    }
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
struct NativeProjection: Codable, Equatable {
    let serviceInstance: String
    let revision: Int
    let accepting: Bool
    let works: [NativeWork]
}

enum NativeRequest: Codable, Equatable {
    case hello(role: String, protocol: Int, version: String, source: String, dataDir: String)
    case refresh
    case settingsRead(request: String, serviceInstance: String, dataDir: String, preview: SettingsValue?)
    case settingsApply(request: String, serviceInstance: String, dataDir: String, stamp: String?, action: SettingsValue)
    case inspect(request: String, session: String, notice: String?)
    case stop(request: String, serviceInstance: String, session: String, gen: Int)
    case read(ids: [String])
    case delivered(ids: [String])
    case presence(session: String, ids: [String], focused: Bool)
    private enum Keys: String, CodingKey { case t, role, `protocol`, version, source, dataDir, request, session, notice, serviceInstance, gen, ids, focused, stamp, action, preview }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "hello": self = .hello(role: try c.decode(String.self, forKey: .role), protocol: try c.decode(Int.self, forKey: .protocol), version: try c.decode(String.self, forKey: .version), source: try c.decode(String.self, forKey: .source), dataDir: try c.decode(String.self, forKey: .dataDir))
        case "native.settings.read": self = .settingsRead(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), dataDir: try c.decode(String.self, forKey: .dataDir), preview: try c.decodeOptional(SettingsValue.self, forKey: .preview))
        case "native.settings.apply": self = .settingsApply(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), dataDir: try c.decode(String.self, forKey: .dataDir), stamp: try c.decode(String?.self, forKey: .stamp), action: try c.decode(SettingsValue.self, forKey: .action))
        case "native.refresh": self = .refresh
        case "native.inspect": self = .inspect(request: try c.decode(String.self, forKey: .request), session: try c.decode(String.self, forKey: .session), notice: try c.decodeOptional(String.self, forKey: .notice))
        case "native.stop": self = .stop(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), session: try c.decode(String.self, forKey: .session), gen: try c.decode(Int.self, forKey: .gen))
        case "native.read": self = .read(ids: try c.decode([String].self, forKey: .ids))
        case "native.delivered": self = .delivered(ids: try c.decode([String].self, forKey: .ids))
        case "native.presence": self = .presence(session: try c.decode(String.self, forKey: .session), ids: try c.decode([String].self, forKey: .ids), focused: try c.decode(Bool.self, forKey: .focused))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
        if case .settingsApply(_, _, _, _, let action) = self, !action.validSettingsAction { throw WireError.invalid("非法设置动作") }
        if case .settingsRead(_, _, _, let preview) = self, let preview, !preview.validSettingsPreview { throw WireError.invalid("非法设置预览") }
        if case .hello(let role, _, _, _, _) = self, role != "observer" { throw WireError.invalid("观察连接用途必须为 observer") }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .hello(role, `protocol`, version, source, dataDir):
            try c.encode("hello", forKey: .t)
            try c.encode(role, forKey: .role)
            try c.encode(`protocol`, forKey: .protocol)
            try c.encode(version, forKey: .version)
            try c.encode(source, forKey: .source)
            try c.encode(dataDir, forKey: .dataDir)
        case let .settingsRead(request, serviceInstance, dataDir, preview):
            try c.encode("native.settings.read", forKey: .t); try c.encode(request, forKey: .request); try c.encodeIfPresent(preview, forKey: .preview)
            try c.encode(serviceInstance, forKey: .serviceInstance); try c.encode(dataDir, forKey: .dataDir)
        case let .settingsApply(request, serviceInstance, dataDir, stamp, action):
            try c.encode("native.settings.apply", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance); try c.encode(dataDir, forKey: .dataDir)
            try c.encode(stamp, forKey: .stamp); try c.encode(action, forKey: .action)
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
        case let .read(ids):
            try c.encode("native.read", forKey: .t)
            try c.encode(ids, forKey: .ids)
        case let .delivered(ids):
            try c.encode("native.delivered", forKey: .t)
            try c.encode(ids, forKey: .ids)
        case let .presence(session, ids, focused):
            try c.encode("native.presence", forKey: .t)
            try c.encode(session, forKey: .session)
            try c.encode(ids, forKey: .ids)
            try c.encode(focused, forKey: .focused)
        }
    }
}

enum NativeResponse: Codable, Equatable {
    case welcome(identity: ServiceIdentity, projection: NativeProjection)
    case projection(projection: NativeProjection)
    case inspected(request: String, work: NativeWork?, error: String?)
    case stopped(request: String, session: String, phase: StopPhase, note: String?)
    case attached(request: String, session: String?)
    case settingsResult(request: String, serviceInstance: String, dataDir: String, snapshot: SettingsSnapshot?, error: String?, note: String?)
    case error(reason: String)
    private enum Keys: String, CodingKey { case t, identity, projection, request, work, error, session, phase, note, reason, serviceInstance, dataDir, snapshot }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "native.welcome": self = .welcome(identity: try c.decode(ServiceIdentity.self, forKey: .identity), projection: try c.decode(NativeProjection.self, forKey: .projection))
        case "native.projection": self = .projection(projection: try c.decode(NativeProjection.self, forKey: .projection))
        case "native.inspected": self = .inspected(request: try c.decode(String.self, forKey: .request), work: try c.decodeOptional(NativeWork.self, forKey: .work), error: try c.decodeOptional(String.self, forKey: .error))
        case "native.stopped": self = .stopped(request: try c.decode(String.self, forKey: .request), session: try c.decode(String.self, forKey: .session), phase: try c.decode(StopPhase.self, forKey: .phase), note: try c.decodeOptional(String.self, forKey: .note))
        case "native.attached": self = .attached(request: try c.decode(String.self, forKey: .request), session: try c.decode(String?.self, forKey: .session))
        case "native.settings.result": self = .settingsResult(request: try c.decode(String.self, forKey: .request), serviceInstance: try c.decode(String.self, forKey: .serviceInstance), dataDir: try c.decode(String.self, forKey: .dataDir), snapshot: try c.decodeOptional(SettingsSnapshot.self, forKey: .snapshot), error: try c.decodeOptional(String.self, forKey: .error), note: try c.decodeOptional(String.self, forKey: .note))
        case "native.error": self = .error(reason: try c.decode(String.self, forKey: .reason))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
        if case .settingsResult(_, _, _, let snapshot, let error, _) = self, (snapshot == nil) == (error == nil) { throw WireError.invalid("设置结果必须给出 snapshot 或 error 其中一项") }
        if case .inspected(_, let work, let error) = self, (work == nil) == (error == nil) {
            throw WireError.invalid("事项查询必须给出 work 或 error 其中一项")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
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
        case let .settingsResult(request, serviceInstance, dataDir, snapshot, error, note):
            try c.encode("native.settings.result", forKey: .t); try c.encode(request, forKey: .request)
            try c.encode(serviceInstance, forKey: .serviceInstance); try c.encode(dataDir, forKey: .dataDir)
            try c.encodeIfPresent(snapshot, forKey: .snapshot); try c.encodeIfPresent(error, forKey: .error); try c.encodeIfPresent(note, forKey: .note)
        case let .error(reason):
            try c.encode("native.error", forKey: .t)
            try c.encode(reason, forKey: .reason)
        }
    }
}

enum HostRequest: Codable, Equatable {
    case shutdown(request: String)
    case diagnosticsApplied(request: String, error: String?)
    private enum Keys: String, CodingKey { case t, request, error }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "host.diagnostics.applied": self = .diagnosticsApplied(request: try c.decode(String.self, forKey: .request), error: try c.decodeIfPresent(String.self, forKey: .error))
        case "host.shutdown": self = .shutdown(request: try c.decode(String.self, forKey: .request))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .diagnosticsApplied(request, error):
            try c.encode("host.diagnostics.applied", forKey: .t); try c.encode(request, forKey: .request); try c.encodeIfPresent(error, forKey: .error)
        case let .shutdown(request):
            try c.encode("host.shutdown", forKey: .t)
            try c.encode(request, forKey: .request)
        }
    }
}

enum HostResponse: Codable, Equatable {
    case diagnostics(request: String, value: Diagnostics, dataDir: String)
    case ready(identity: ServiceIdentity, socket: String, base: String, config: String)
    case stopped(request: String?)
    case error(reason: String)
    private enum Keys: String, CodingKey { case t, identity, socket, base, config, request, reason, value, dataDir }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .t) {
        case "host.diagnostics": self = .diagnostics(request: try c.decode(String.self, forKey: .request), value: try c.decode(Diagnostics.self, forKey: .value), dataDir: try c.decode(String.self, forKey: .dataDir))
        case "host.ready": self = .ready(identity: try c.decode(ServiceIdentity.self, forKey: .identity), socket: try c.decode(String.self, forKey: .socket), base: try c.decode(String.self, forKey: .base), config: try c.decode(String.self, forKey: .config))
        case "host.stopped": self = .stopped(request: try c.decodeOptional(String.self, forKey: .request))
        case "host.error": self = .error(reason: try c.decode(String.self, forKey: .reason))
        default: throw DecodingError.dataCorruptedError(forKey: .t, in: c, debugDescription: "不支持的协议消息")
        }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .diagnostics(request, value, dataDir):
            try c.encode("host.diagnostics", forKey: .t); try c.encode(request, forKey: .request); try c.encode(value, forKey: .value); try c.encode(dataDir, forKey: .dataDir)
        case let .ready(identity, socket, base, config):
            try c.encode("host.ready", forKey: .t)
            try c.encode(identity, forKey: .identity)
            try c.encode(socket, forKey: .socket)
            try c.encode(base, forKey: .base)
            try c.encode(config, forKey: .config)
        case let .stopped(request):
            try c.encode("host.stopped", forKey: .t)
            try c.encodeIfPresent(request, forKey: .request)
        case let .error(reason):
            try c.encode("host.error", forKey: .t)
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
    }
}
