import Foundation
import CryptoKit
import Network

/// 官方适配的协议固定优先级；显示与解析共用这一份（D62：不能各算一份）。
let providerProtocolPriority = ["responses", "messages", "chat-completions"]

/// 协议解析结果——`fallback` 表示官方提示里没有这个型号，按固定优先级兜底。
struct ProtocolResolution {
    let id: String
    let fallback: Bool
}

/// 协议解析的唯一来源：显式 → 官方提示里第一个支持该型号的协议 → 固定优先级兜底。
/// `SettingsModels.protocolID` 与界面显示（`modelProtocolName`）都走这里。
func resolveProtocol(vendor: SettingsValue, explicit: String, model: String) -> ProtocolResolution {
    let declared = vendor["protocols"].array
    // 固定优先级不依赖适配表的书写顺序；未知协议留在末尾（仅为不丢资料）。
    let protocols = providerProtocolPriority.compactMap { id in declared.first { $0["id"].text == id } }
        + declared.filter { entry in !providerProtocolPriority.contains(entry["id"].text) }
    if !explicit.isEmpty { return ProtocolResolution(id: explicit, fallback: false) }
    let supported = protocols.filter { $0.object["models"] == nil || $0["models"].array.contains(.string(model)) }
    if let id = supported.first?["id"].text, !id.isEmpty { return ProtocolResolution(id: id, fallback: false) }
    if let id = providerProtocolPriority.first(where: { id in protocols.contains { $0["id"].text == id } }) {
        return ProtocolResolution(id: id, fallback: true)
    }
    return ProtocolResolution(id: protocols.first?["id"].text ?? "responses", fallback: true)
}

/// 只供离线设置的目录资料与列表刷新；不装配模型或执行请求。
final class SettingsModels {
    let metadata: SettingsValue
    let base: String
    let configPath: String
    let environment: [String: String]
    private var metadataFailure: String?
    private var transient: [String: SettingsValue] = [:]
    init(metadata: SettingsValue, base: String, configPath: String, environment: [String: String]) {
        self.metadata = metadata; self.base = base; self.configPath = configPath; self.environment = environment
    }
    func vendor(_ config: SettingsValue) -> SettingsValue? { metadata["vendors"].array.first { $0["vendor"] == config["vendor"] } }
    static func environmentKey(_ id: String) -> String {
        "MAGIC_" + id.uppercased().replacingOccurrences(of: "[^A-Z0-9]", with: "_", options: .regularExpression) + "_API_KEY"
    }
    func keySource(_ id: String, _ config: SettingsValue) -> String {
        if config["auth"].text == "none" { return "none" }
        if config["apiKey"].nonempty { return "config" }
        return environment[Self.environmentKey(id)]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? "env" : "missing"
    }
    func endpoint(_ config: SettingsValue, protocolID: String = "chat-completions") throws -> String {
        var address = config["baseURL"].text
        if address.isEmpty, let vendor = vendor(config) {
            let region = config.object["region"] ?? vendor["regions"].array.first?["id"] ?? .null
            address = vendor["endpoints"][region.text][protocolID].text
        }
        guard !address.isEmpty else { return "" }
        guard let url = URLComponents(string: address), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.host?.isEmpty == false, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
            throw WireError.invalid("基础地址须为无凭据、查询参数和片段的 HTTP/HTTPS URL")
        }
        var normalized = url; normalized.scheme = url.scheme?.lowercased(); normalized.host = url.host?.lowercased()
        if (normalized.scheme == "http" && normalized.port == 80) || (normalized.scheme == "https" && normalized.port == 443) { normalized.port = nil }
        return (normalized.string ?? address).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }
    /// 该型号的协议——**协议兼容不是硬闸门**：型号不在官方支持提示里也照用。
    ///
    /// 显式写了协议就用它；没写时取官方提示里第一个支持该型号的协议；官方还没有该型号的
    /// 提示时按固定优先级（Responses → Anthropic Messages → Chat Completions）兜底。
    /// 地址与区域照旧解析——**没有地址就报错**（不猜）。解析规则与界面显示共用 `resolveProtocol`。
    func protocolID(_ config: SettingsValue, model: String) throws -> String {
        if config.object["vendor"] == nil { _ = try endpoint(config); return config.object["protocol"]?.text ?? "responses" }
        guard let vendor = vendor(config) else { throw WireError.invalid("未知供应商适配，请检查 vendor") }
        let selected = resolveProtocol(vendor: vendor, explicit: config.object["protocol"]?.text ?? "", model: model).id
        guard try !endpoint(config, protocolID: selected).isEmpty else {
            throw WireError.invalid("连接没有有效服务地址或官方区域")
        }
        return selected
    }
    private func scope(_ config: SettingsValue) throws -> String { config["vendor"].text + "@" + (try endpoint(config)) + "#" + (config.object["protocol"]?.text ?? "auto") }
    /// 认证取出处：无需认证的连接没有凭据可随行，配置指纹本身就是身份（与 TS 同一把尺子）。
    private func identityIsConfig(_ config: SettingsValue) -> Bool { config["apiKey"].nonempty || config["auth"].text == "none" }
    private func cachePath(_ id: String, config: SettingsValue, stamp: String?) -> String? {
        guard identityIsConfig(config), let stamp else { return nil }
        func slug(_ text: String) -> String { String(Data(SHA256.hash(data: Data(text.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").prefix(22)) }
        return base + "/cache/models/" + slug(id) + "." + slug("cfg:\(id):\(stamp)") + ".json"
    }
    func snapshot(_ id: String, config: SettingsValue, stamp: String?) -> SettingsValue? {
        let value = cachePath(id, config: config, stamp: stamp).flatMap { try? SettingsFile.read($0) } ?? transient[id]
        guard var value, value["provider"].text == id, value["scope"].text == (try? scope(config)),
              value["fetchedAt"].number?.isFinite == true, value["models"].isArray else { return nil }
        value.put("models", .array(value["models"].array.filter { $0["id"].isText && !$0["id"].text.isEmpty }))
        return value
    }
    func store(_ snapshot: SettingsValue, config: SettingsValue, stamp: String?) throws {
        let id = snapshot["provider"].text
        guard let path = cachePath(id, config: config, stamp: stamp) else { transient[id] = snapshot; return }
        try SettingsFile.withLock(path, cache: true) {
            let existing = try? SettingsFile.read(path)
            if (existing?["fetchedAt"].number ?? 0) > (snapshot["fetchedAt"].number ?? 0) { return }
            try SettingsFile.replace(snapshot, at: path, expected: SettingsFile.stamp(path))
        }
    }
    func effectiveReasoning(_ config: SettingsValue, model: String, known: SettingsValue?) -> SettingsValue? {
        guard let protocolID = try? protocolID(config, model: model) else { return nil }
        guard let support = config["modelOverrides"][model].object["reasoningSupport"] ?? known?.object["reasoning"] else { return nil }
        let controls = vendor(config)?["reasoningControls"][protocolID]
        let allowed = controls?.object[model] ?? controls?.object["*"]
        var value: [String: SettingsValue] = [:]
        value["default"] = support.object["default"]
        if support["disable"] == .bool(false) { value["disable"] = .bool(false) }
        else if support["disable"] == .bool(true), vendor(config) == nil || allowed?["disable"] == .bool(true) { value["disable"] = .bool(true) }
        if let levels = support.object["levels"] {
            let accepted = vendor(config) == nil ? (protocolID == "messages" ? ["low", "medium", "high", "xhigh", "max"] : ["minimal", "low", "medium", "high", "xhigh"]) : allowed?["levels"].array.map(\.text) ?? []
            value["levels"] = .array(levels.array.filter { accepted.contains($0.text) })
        }
        if let budget = support.object["budget"], vendor(config) == nil && protocolID == "messages" { value["budget"] = budget }
        return .object(value)
    }
    func rows(_ raw: SettingsValue, stamp: String?) -> [SettingsValue] {
        let resource = modelsDevSnapshot()
        return raw["providers"].object.sorted { $0.key < $1.key }.map { id, config in
            var row = config.object.filter { ["name", "vendor", "region", "baseURL", "protocol", "auth", "modelOverrides"].contains($0.key) }
            row["provider"] = .string(id)
            let source = keySource(id, config); if source != "missing" { row["keySource"] = .string(source) }
            let snapshot = snapshot(id, config: config, stamp: stamp)
            if let snapshot { row["cache"] = .object(["snapshot": snapshot, "stale": .bool(Date().timeIntervalSince1970 * 1000 - snapshot["fetchedAt"].number! > (metadata["modelTTL"].number ?? 86_400_000))]) }
            let ids = Set((snapshot?["models"].array.map { $0["id"].text } ?? []) + Array(config["modelOverrides"].object.keys) + raw["models"].object.values.filter { $0["provider"].text == id }.map { $0["model"].text })
            let infos = Dictionary(uniqueKeysWithValues: ids.compactMap { model in
                modelInfo(config, model: model, supplied: snapshot?["models"].array.first { $0["id"].text == model }, resource: resource).map { (model, $0) }
            })
            row["modelInfo"] = .object(infos)
            var status: [String: SettingsValue] = ["stale": .bool(resource == nil || Date().timeIntervalSince1970 * 1000 - (resource?["fetchedAt"].number ?? 0) >= (metadata["modelsDev"]["ttl"].number ?? 3_600_000))]
            status["fetchedAt"] = resource?.object["fetchedAt"]
            if let metadataFailure { status["failure"] = .string(metadataFailure) }
            row["metadata"] = .object(status)
            let support = Dictionary(uniqueKeysWithValues: ids.compactMap { model -> (String, SettingsValue)? in
                effectiveReasoning(config, model: model, known: infos[model]).map { (model, $0) }
            })
            if !support.isEmpty { row["effectiveReasoning"] = .object(support) }
            return .object(row)
        }
    }
    private var modelsDevPath: String { base + "/cache/models.dev.json" }
    func modelsDevSnapshot() -> SettingsValue? {
        guard let value = try? SettingsFile.read(modelsDevPath), let fetchedAt = value["fetchedAt"].number, fetchedAt > 0,
              value["data"].object.values.contains(where: { $0["models"].object.contains { $0.key == $0.value["id"].text } }) else { return nil }
        return value
    }
    private func modelsDevProvider(_ config: SettingsValue, data: SettingsValue) -> String? {
        guard let address = try? endpoint(config), !address.isEmpty else { return nil }
        if let alias = metadata["modelsDev"]["aliases"].array.first(where: { $0["vendor"] == config["vendor"] && $0["base"].text == address }) { return alias["provider"].text }
        let matches = data.object.filter { $0.value["api"].text.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) == address }
        return matches.count == 1 ? matches.first?.key : nil
    }
    func modelInfo(_ config: SettingsValue, model: String, supplied: SettingsValue?, resource: SettingsValue?) -> SettingsValue? {
        var info: [String: SettingsValue] = [:]
        if let provider = modelsDevProvider(config, data: resource?["data"] ?? .null),
           let source = resource?["data"][provider]["models"].object[model],
           let mapped = metadataInfo(provider: provider, model: model, source: source) {
            info = mapped.object
        }
        if let supplied {
            for (key, value) in supplied.object {
                info[key] = ["limits", "capabilities", "reasoning"].contains(key)
                    ? .object((info[key]?.object ?? [:]).merging(value.object) { _, current in current }) : value
            }
        }
        return info.isEmpty ? nil : .object(info)
    }

    /// Models.dev 的一条型号 → 我们消费的那几格（读面与检索共用这一套映射，免得两处各说一套）。
    private func metadataInfo(provider: String, model: String, source: SettingsValue) -> SettingsValue? {
        guard source["id"].text == model else { return nil }
        var info: [String: SettingsValue] = ["id": .string(model)]
        for key in ["name", "description"] { if source[key].isText { info[key] = source[key] } }
        var limits: [String: SettingsValue] = [:]
        for (from, to) in [("context", "maxContextTokens"), ("input", "maxInputTokens"), ("output", "maxOutputTokens")] {
            if let n = source["limit"][from].number, n > 0, n <= 9_007_199_254_740_991, n.rounded() == n { limits[to] = .number(n) }
        }
        if let context = limits["maxContextTokens"]?.number {
            for key in ["maxInputTokens", "maxOutputTokens"] where (limits[key]?.number ?? 0) > context { limits.removeValue(forKey: key) }
        }
        if !limits.isEmpty { info["limits"] = .object(limits) }
        var capabilities: [String: SettingsValue] = [:]
        for (key, capability, modality) in [("input", "image", "image"), ("output", "chat", "text")] {
            let values = source["modalities"][key]
            if values.isArray && values.array.allSatisfy({ $0.isText && $0.nonempty }) { capabilities[capability] = .bool(values.array.contains(.string(modality))) }
        }
        if source["tool_call"].isBool { capabilities["tools"] = source["tool_call"] }
        if !capabilities.isEmpty { info["capabilities"] = .object(capabilities) }
        if source["reasoning_options"].isArray {
            let options = source["reasoning_options"].array
            var reasoning: [String: SettingsValue] = [:]
            if options.contains(where: { $0["type"].text == "toggle" }) { reasoning["disable"] = .bool(true) }
            if let effort = options.first(where: { $0["type"].text == "effort" }) {
                if effort["values"].isArray && effort["values"].array.allSatisfy({ $0.isText && $0.nonempty }) { reasoning["levels"] = effort["values"] }
            } else { reasoning["levels"] = .array([]) }
            if let budget = options.first(where: { $0["type"].text == "budget_tokens" }) {
                var range: [String: SettingsValue] = [:]
                for (from, to) in [("min", "minTokens"), ("max", "maxTokens")] {
                    if let n = budget[from].number, n > 0, n <= 9_007_199_254_740_991, n.rounded() == n { range[to] = .number(n) }
                }
                reasoning["budget"] = .object(range)
            }
            info["reasoning"] = .object(reasoning)
        }
        var origin: [String: SettingsValue] = ["provider": .string(provider)]
        if source["last_updated"].isText { origin["updatedAt"] = source["last_updated"] }
        info["metadata"] = .object(origin)
        return .object(info)
    }

    /**
     * **按名字检索 Models.dev 的型号**（手动对位）——与 TS 的 `searchModelsDev` 同一套判法：
     * id 完全相同 → id 前缀 → id 含查询 → 名称含查询 → 供应商名含查询；同档按供应商、型号 id 排。
     *
     * 只读本地那份资料（没有就返回空，让界面如实说「先刷新一次」），不改配置。
     */
    func searchModelsDev(query: String, limit: Int = 20) -> [SettingsValue] {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty, limit > 0, let data = modelsDevSnapshot()?["data"] else { return [] }
        var ranked: [(rank: Int, provider: String, model: String, row: SettingsValue)] = []
        for (provider, value) in data.object {
            let providerHit = provider.lowercased().contains(wanted)
            for (model, source) in value["models"].object {
                let id = model.lowercased(), name = source["name"].text.lowercased()
                let rank: Int
                if id == wanted { rank = 0 }
                else if id.hasPrefix(wanted) { rank = 1 }
                else if id.contains(wanted) { rank = 2 }
                else if name.contains(wanted) { rank = 3 }
                else if providerHit { rank = 4 }
                else { continue }
                guard let info = metadataInfo(provider: provider, model: model, source: source) else { continue }
                var row: [String: SettingsValue] = ["provider": .string(provider), "model": .string(model)]
                for key in ["name", "description", "limits", "capabilities", "reasoning"] where info[key] != .null { row[key] = info[key] }
                if info["metadata"]["updatedAt"] != .null { row["updatedAt"] = info["metadata"]["updatedAt"] }
                ranked.append((rank, provider, model, .object(row)))
            }
        }
        ranked.sort { a, b in
            if a.rank != b.rank { return a.rank < b.rank }
            let providerA = a.provider.lowercased(), providerB = b.provider.lowercased()
            if providerA != providerB { return providerA < providerB }
            let idA = a.model.lowercased(), idB = b.model.lowercased()
            return idA == idB ? false : idA < idB
        }
        return ranked.prefix(limit).map(\.row)
    }
    func refreshMetadata(_ configs: [SettingsValue], force: Bool = false) async -> String? {
        let resource = modelsDevSnapshot()
        guard force || configs.contains(where: { modelsDevProvider($0, data: resource?["data"] ?? .null) != nil }) else { return nil }
        if !force, let at = resource?["fetchedAt"].number, Date().timeIntervalSince1970 * 1000 - at < (metadata["modelsDev"]["ttl"].number ?? 3_600_000) { return nil }
        metadataFailure = await ModelsDevRefresh.shared.run(path: modelsDevPath, force: force) {
            guard let url = URL(string: self.metadata["modelsDev"]["url"].text) else { throw WireError.invalid("Models.dev 地址无效") }
            let session = try self.session(for: url); defer { session.invalidateAndCancel() }
            let (data, response) = try await session.data(for: URLRequest(url: url, timeoutInterval: 10))
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw WireError.invalid("Models.dev 响应失败") }
            let body = try JSONDecoder().decode(SettingsValue.self, from: data)
            guard body.object.values.contains(where: { $0["models"].object.contains { !$0.key.isEmpty && $0.key == $0.value["id"].text } }) else { throw WireError.invalid("Models.dev 未返回有效模型目录") }
            let value = SettingsValue.object(["fetchedAt": .number(Date().timeIntervalSince1970 * 1000), "data": body])
            try SettingsFile.withLock(self.modelsDevPath, cache: true) {
                try SettingsFile.replace(value, at: self.modelsDevPath, expected: SettingsFile.stamp(self.modelsDevPath))
            }
        }
        return metadataFailure
    }
    private func session(for url: URL) throws -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        let scheme = url.scheme?.lowercased() ?? "https", host = url.host?.lowercased() ?? ""
        let port = url.port ?? (scheme == "https" ? 443 : 80)
        let noProxy = environment["no_proxy"] ?? environment["NO_PROXY"] ?? ""
        let bypass = noProxy == "*" || noProxy.split(whereSeparator: { $0 == "," || $0.isWhitespace }).contains { token in
            var domain = String(token).lowercased()
            if let colon = domain.lastIndex(of: ":"), let selectedPort = Int(domain[domain.index(after: colon)...]) {
                if selectedPort != port { return false }; domain = String(domain[..<colon])
            }
            if domain.hasPrefix("*.") { domain.removeFirst(2) } else if domain.hasPrefix(".") { domain.removeFirst() }
            return host == domain || host.hasSuffix("." + domain)
        }
        let all = environment["all_proxy"] ?? environment["ALL_PROXY"] ?? ""
        let proxy = environment[scheme + "_proxy"] ?? environment[scheme.uppercased() + "_PROXY"] ?? all
        if !bypass && !proxy.isEmpty {
            guard let address = URLComponents(string: proxy), let host = address.host,
                  let scheme = address.scheme, ["http", "https"].contains(scheme),
                  let port = NWEndpoint.Port(rawValue: UInt16(exactly: address.port ?? (scheme == "https" ? 443 : 80)) ?? 0), port.rawValue > 0 else {
                throw WireError.invalid("模型列表代理配置无效")
            }
            var selected = ProxyConfiguration(httpCONNECTProxy: .hostPort(host: .init(host), port: port), tlsOptions: scheme == "https" ? .init() : nil)
            selected.allowFailover = false
            if let username = address.user { selected.applyCredential(username: username.removingPercentEncoding ?? username, password: address.password?.removingPercentEncoding ?? "") }
            configuration.connectionProxyDictionary = nil
            configuration.proxyConfigurations = [selected]
        }
        return URLSession(configuration: configuration)
    }
    /// Anthropic Messages 的接口版本（列表与对话同一版）。
    private static let anthropicVersion = "2023-06-01"
    /// 官方连接的列表端点：列表与调用共用同一个基址，端点本身是协议标准的那一条。
    private static let listProtocol = "chat-completions"

    /// 取一趟完整列表：**官方适配优先，其余按连接所选协议**（协议自带列表规范）。
    func refresh(_ id: String, config: SettingsValue, stamp: String?) async throws {
        let custom = vendor(config) == nil
        let protocolID = custom ? (config.object["protocol"]?.text ?? "responses") : Self.listProtocol
        let base = try endpoint(config)
        guard !base.isEmpty else { throw WireError.invalid("该连接没有可用的服务地址") }

        let auth = config.object["auth"]?.text ?? (protocolID == "messages" ? "api-key" : "bearer")
        let key = config["apiKey"].nonempty ? config["apiKey"].text.trimmingCharacters(in: .whitespacesAndNewlines) : environment[Self.environmentKey(id)]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if auth != "none", key.isEmpty { throw WireError.invalid("连接缺少认证凭据") }

        var headers = ["Accept": "application/json"]
        if auth == "bearer" { headers["Authorization"] = "Bearer " + key } else if auth == "api-key" { headers["x-api-key"] = key }
        if protocolID == "messages" { headers["anthropic-version"] = Self.anthropicVersion }

        var models: [SettingsValue] = [], after: String?
        for _ in 0..<100 {
            guard var components = URLComponents(string: base + "/models") else { throw WireError.invalid("模型列表地址无效") }
            if protocolID == "messages" {
                components.queryItems = [URLQueryItem(name: "limit", value: "1000")] + (after.map { [URLQueryItem(name: "after_id", value: $0)] } ?? [])
            }
            guard let url = components.url else { throw WireError.invalid("模型列表地址无效") }
            var request = URLRequest(url: url)
            for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
            let received: Data
            do {
                let session = try session(for: url); defer { session.invalidateAndCancel() }
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw WireError.invalid("模型列表刷新失败") }
                received = data
            } catch { throw WireError.invalid("模型列表刷新失败，请检查连接与认证") }
            guard let body = try? JSONDecoder().decode(SettingsValue.self, from: received), body["data"].isArray else { throw WireError.invalid("模型列表响应无效") }
            models += body["data"].array.compactMap { protocolID == "messages" ? SettingsModels.anthropicRow($0) : SettingsModels.listRow($0) }
            guard protocolID == "messages", body["has_more"].flag, !body["last_id"].text.isEmpty, body["last_id"].text != after else { break }
            after = body["last_id"].text
        }
        let snapshot = SettingsValue.object(["provider": .string(id), "scope": .string(try scope(config)), "fetchedAt": .number(Date().timeIntervalSince1970 * 1000), "models": .array(models)])
        // 迟到结果只写入发起时的认证范围；后续读取会按当前指纹选取。
        try store(snapshot, config: config, stamp: stamp)
    }

    /// Anthropic Messages 的列表行：`{ id, display_name, created_at }`（字段少，只取有用的两格）。
    private static func anthropicRow(_ source: SettingsValue) -> SettingsValue? {
        guard source["id"].isText, !source["id"].text.isEmpty else { return nil }
        var row: [String: SettingsValue] = ["id": source["id"]]
        if source["display_name"].isText, !source["display_name"].text.isEmpty { row["name"] = source["display_name"] }
        return .object(row)
    }

    /// 协议标准（OpenAI 形状）的列表行：`{ id, name?, description?, 容量/能力/思考? }`。
    private static func listRow(_ source: SettingsValue) -> SettingsValue? {
        guard source["id"].isText, !source["id"].text.isEmpty else { return nil }
        var row: [String: SettingsValue] = ["id": source["id"]]
        for key in ["name", "description"] { if source[key].isText { row[key] = source[key] } }
        var limits: [String: SettingsValue] = [:]
        for (from, to) in [("max_input_tokens", "maxInputTokens"), ("max_output_tokens", "maxOutputTokens"), ("context_window", "maxContextTokens")] {
            if let n = source[from].number, n > 0, n <= 9_007_199_254_740_991, n.rounded() == n { limits[to] = .number(n) }
        }
        var capabilities = source["capabilities"].object.filter { ["chat", "image", "tools"].contains($0.key) && $0.value.isBool }
        if capabilities["image"] == nil, source["input_modalities"].isArray, source["input_modalities"].array.allSatisfy(\.isText) { capabilities["image"] = .bool(source["input_modalities"].array.contains(.string("image"))) }
        var reasoning = source["reasoning"].object.filter { ($0.key == "disable" && $0.value.isBool) || ($0.key == "default" && ["on", "off"].contains($0.value.text)) }
        let levels = source["reasoning"].object["levels"] ?? source["effort"].object["supported_levels"]
        if let levels, levels.isArray, levels.array.allSatisfy({ $0.isText && !$0.text.isEmpty }) { reasoning["levels"] = levels }
        var budget: [String: SettingsValue] = [:]
        for (from, to) in [("min_tokens", "minTokens"), ("max_tokens", "maxTokens")] {
            if let n = source["reasoning"]["budget"][from].number, n > 0, n <= 9_007_199_254_740_991, n.rounded() == n { budget[to] = .number(n) }
        }
        if let min = budget["minTokens"]?.number, let max = budget["maxTokens"]?.number, min > max { budget = [:] }
        if !budget.isEmpty { reasoning["budget"] = .object(budget) }
        if !limits.isEmpty { row["limits"] = .object(limits) }; if !capabilities.isEmpty { row["capabilities"] = .object(capabilities) }; if !reasoning.isEmpty { row["reasoning"] = .object(reasoning) }
        return .object(row)
    }
}

/// 同一进程共享在途刷新与失败冷却；目录本身始终从文件读取。
private actor ModelsDevRefresh {
    static let shared = ModelsDevRefresh()
    private var tasks: [String: Task<String?, Never>] = [:]
    private var failures: [String: (Date, String)] = [:]
    func run(path: String, force: Bool, load: @escaping () async throws -> Void) async -> String? {
        if let task = tasks[path] { return await task.value }
        if !force, let (at, failure) = failures[path], Date().timeIntervalSince(at) < 60 { return failure }
        let task = Task<String?, Never> {
            do { try await load(); return nil }
            catch { return "Models.dev 刷新失败：" + error.localizedDescription }
        }
        tasks[path] = task
        let failure = await task.value
        tasks[path] = nil
        failures[path] = failure.map { (Date(), $0) }
        return failure
    }
}
