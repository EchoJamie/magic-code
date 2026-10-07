import Foundation

/// 仅用于原生协议值适配；用户编辑的是各页字段，不是 JSON。
indirect enum SettingsValue: Codable, Hashable {
    case object([String: SettingsValue]), array([SettingsValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let value = try? c.decode(Bool.self) { self = .bool(value) }
        else if let value = try? c.decode(String.self) { self = .string(value) }
        else if let value = try? c.decode(Double.self) { self = .number(value) }
        else if let value = try? c.decode([String: SettingsValue].self) { self = .object(value) }
        else { self = .array(try c.decode([SettingsValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    var object: [String: SettingsValue] { if case .object(let v) = self { return v }; return [:] }
    var array: [SettingsValue] { if case .array(let v) = self { return v }; return [] }
    var text: String { if case .string(let v) = self { return v }; return "" }
    var flag: Bool { if case .bool(let v) = self { return v }; return false }
    var number: Double? { if case .number(let v) = self { return v }; return nil }
    subscript(_ key: String) -> SettingsValue { object[key] ?? .null }
    static func strings(_ values: [String]) -> SettingsValue { .array(values.map { .string($0) }) }
}
struct SettingsSnapshot: Codable, Equatable {
    let preview: SettingsValue
    let configPath: String
    let dataDir: String
    let base: String
    let stamp: String?
    let configuration: SettingsValue
    let catalog: [SettingsValue]
    let vendors: [SettingsValue]
    let sources: [SettingsValue]
    let grants: [SettingsValue]
    let grantStamp: String?
    let grantProblem: String?
    let mcp: [SettingsValue]
    let canChangeData: Bool
}

extension SettingsValue {
    var validSettingsAction: Bool {
        let v = self.object
        let type = self["type"].text
        func text(_ key: String) -> Bool { !self[key].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        func object(_ key: String) -> Bool { if case .object = self[key] { return true }; return false }
        func strings(_ key: String) -> Bool { if case .array(let values) = self[key] { return values.allSatisfy { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }; return false }
        switch type {
        case "provider.save": return text("provider") && ["vendor", "name", "region", "baseURL", "apiKey"].allSatisfy { key in if v[key] == nil { return true }; if case .string = self[key] { return true }; return false }
        case "provider.remove", "model.refresh": return text("provider")
        case "model.configure": return ["default", "cantrip", "spell", "arcane"].contains(self["choice"].text) && text("provider") && text("model") && (v["initialize"] == nil || self["initialize"] == .bool(true) || self["initialize"] == .bool(false))
        case "model.clear": return ["default", "cantrip", "spell", "arcane"].contains(self["choice"].text)
        case "model.override": return text("provider") && text("model") && (self["override"] == .null || object("override"))
        case "diagnostics.set":
            return (v["source"] == nil || ["app", "cli"].contains(self["source"].text)) && (v["debugMode"] != nil || v["logLevel"] != nil) && (v["debugMode"] == nil || self["debugMode"] == .bool(true) || self["debugMode"] == .bool(false)) && (v["logLevel"] == nil || LogLevel(rawValue: self["logLevel"].text) != nil)
        case "prefs.set":
            if let reduced = v["reducedMotion"], reduced != .bool(true) && reduced != .bool(false) { return false }
            if let status = v["statusLine"] {
                guard case .object = status, case .array(let cells) = status["cells"], Set(cells).count == cells.count,
                      cells.allSatisfy({ ["session", "model", "reasoning", "context", "workspace"].contains($0.text) }) else { return false }
                if let color = status.object["color"], color != .bool(true) && color != .bool(false) { return false }
            }
            return true
        case "mcp.save":
            let server = self["server"]
            let validServer = server.object.keys.allSatisfy { server["url"] == .null ? ["command", "args"].contains($0) : $0 == "url" }
                && (server["url"] == .null ? !server["command"].text.isEmpty && (server.object["args"] == nil || { if case .array(let values) = server["args"] { return values.allSatisfy { if case .string = $0 { return true }; return false } }; return false }()) : !server["url"].text.isEmpty)
            return text("name") && object("server") && validServer && object("secrets") && self["secrets"].object.values.allSatisfy { if $0 == .null { return true }; if case .string = $0 { return true }; return false }
        case "mcp.remove": return text("name")
        case "mcp.reconnect": return text("name") && text("session") && self["gen"].number.map { $0 >= 0 && $0.rounded() == $0 } == true
        case "sources.set": return ["rules.sources", "rules.linkSources", "skills.sources"].contains(self["source"].text) && strings("paths")
        case "role.save": return text("id") && object("role")
        case "role.remove": return text("id")
        case "workspace.set": return self["roots"] == .null || strings("roots")
        case "permissions.set": if case .array = self["rules"] { return true }; return false
        case "data.set": return self["directory"] == .null || text("directory")
        case "grants.revoke": return text("workspace") && (self["grantStamp"] == .null || text("grantStamp")) && (v["index"] == nil || self["index"].number.map { $0 >= 0 && $0.rounded() == $0 } == true)
        default: return false
        }
    }
    var validSettingsPreview: Bool {
        guard let columns = self["columns"].number, columns >= 20, columns <= 300, columns.rounded() == columns else { return false }
        return (self["reducedMotion"] == .bool(true) || self["reducedMotion"] == .bool(false)) && SettingsValue.object(["type": .string("prefs.set"), "statusLine": self["statusLine"]]).validSettingsAction
    }
}
extension SettingsSnapshot {
    private enum Keys: String, CodingKey { case preview, configPath, dataDir, base, stamp, configuration, catalog, vendors, sources, grants, grantStamp, grantProblem, mcp, canChangeData }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        preview = try c.decode(SettingsValue.self, forKey: .preview)
        configPath = try c.decode(String.self, forKey: .configPath); dataDir = try c.decode(String.self, forKey: .dataDir); base = try c.decode(String.self, forKey: .base)
        stamp = try c.decode(String?.self, forKey: .stamp); grantStamp = try c.decode(String?.self, forKey: .grantStamp)
        configuration = try c.decode(SettingsValue.self, forKey: .configuration)
        catalog = try c.decode([SettingsValue].self, forKey: .catalog); vendors = try c.decode([SettingsValue].self, forKey: .vendors); sources = try c.decode([SettingsValue].self, forKey: .sources)
        grants = try c.decode([SettingsValue].self, forKey: .grants); mcp = try c.decode([SettingsValue].self, forKey: .mcp); canChangeData = try c.decode(Bool.self, forKey: .canChangeData)
        grantProblem = c.contains(.grantProblem) ? try c.decode(String.self, forKey: .grantProblem) : nil
        guard case .object = configuration, case .object = preview else { throw WireError.invalid("设置快照必须包含已知配置与预览对象") }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(preview, forKey: .preview); try c.encode(configPath, forKey: .configPath); try c.encode(dataDir, forKey: .dataDir); try c.encode(base, forKey: .base)
        try c.encode(stamp, forKey: .stamp); try c.encode(grantStamp, forKey: .grantStamp); try c.encode(configuration, forKey: .configuration)
        try c.encode(catalog, forKey: .catalog); try c.encode(vendors, forKey: .vendors); try c.encode(sources, forKey: .sources); try c.encode(grants, forKey: .grants); try c.encode(mcp, forKey: .mcp)
        try c.encode(canChangeData, forKey: .canChangeData); try c.encodeIfPresent(grantProblem, forKey: .grantProblem)
    }
}
