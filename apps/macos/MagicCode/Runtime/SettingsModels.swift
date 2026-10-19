import Foundation
import CryptoKit
import Network

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
    func protocolID(_ config: SettingsValue, model: String) throws -> String {
        if config.object["vendor"] == nil { _ = try endpoint(config); return config.object["protocol"]?.text ?? "responses" }
        guard let vendor = vendor(config) else { throw WireError.invalid("未知供应商适配，请检查 vendor") }
        let supported = vendor["protocols"].array.filter { $0.object["models"] == nil || $0["models"].array.contains(.string(model)) }
        let selected = config.object["protocol"]?.text ?? supported.first?["id"].text ?? ""
        guard supported.contains(where: { $0["id"].text == selected }), try !endpoint(config, protocolID: selected).isEmpty else {
            throw WireError.invalid("模型不支持所选官方协议或区域，请核对精确型号")
        }
        return selected
    }
    func checkSelection(_ config: SettingsValue, model: String) throws {
        _ = try protocolID(config, model: model)
        guard config["modelOverrides"][model]["capabilities"]["chat"] != .bool(false) else { throw WireError.invalid("模型不支持对话") }
    }
    private func scope(_ config: SettingsValue) throws -> String { config["vendor"].text + "@" + (try endpoint(config)) + "#" + (config.object["protocol"]?.text ?? "auto") }
    private func cachePath(_ id: String, config: SettingsValue, stamp: String?) -> String? {
        guard config["apiKey"].nonempty, let stamp else { return nil }
        func slug(_ text: String) -> String { String(Data(SHA256.hash(data: Data(text.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").prefix(22)) }
        return base + "/cache/models/" + slug(id) + "." + slug("cfg:\(id):\(stamp)") + ".json"
    }
    func snapshot(_ id: String, config: SettingsValue, stamp: String?) -> SettingsValue? {
        guard vendor(config) != nil else { return nil }
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
           let source = resource?["data"][provider]["models"].object[model], source["id"].text == model {
            info["id"] = .string(model)
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
        }
        if let supplied {
            for (key, value) in supplied.object {
                info[key] = ["limits", "capabilities", "reasoning"].contains(key)
                    ? .object((info[key]?.object ?? [:]).merging(value.object) { _, current in current }) : value
            }
        }
        return info.isEmpty ? nil : .object(info)
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
    func refresh(_ id: String, config: SettingsValue, stamp: String?) async throws {
        guard vendor(config) != nil else { return }
        guard let url = URL(string: try endpoint(config) + "/models") else { throw WireError.invalid("该连接没有可用的官方模型列表接口") }
        let key = config["apiKey"].nonempty ? config["apiKey"].text.trimmingCharacters(in: .whitespacesAndNewlines) : environment[Self.environmentKey(id)]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !key.isEmpty else { throw WireError.invalid("连接缺少认证凭据") }
        var request = URLRequest(url: url); request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization"); request.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        do {
            let session = try session(for: url); defer { session.invalidateAndCancel() }
            let (received, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw WireError.invalid("模型列表刷新失败") }
            data = received
        } catch { throw WireError.invalid("模型列表刷新失败，请检查连接与认证") }
        guard let body = try? JSONDecoder().decode(SettingsValue.self, from: data), body["data"].isArray else { throw WireError.invalid("模型列表响应无效") }
        let models = body["data"].array.compactMap { source -> SettingsValue? in
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
        let snapshot = SettingsValue.object(["provider": .string(id), "scope": .string(try scope(config)), "fetchedAt": .number(Date().timeIntervalSince1970 * 1000), "models": .array(models)])
        // 迟到结果只写入发起时的认证范围；后续读取会按当前指纹选取。
        try store(snapshot, config: config, stamp: stamp)
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
