import Foundation

final class NativeSettings {
    let home: String
    let base: String
    let path: String
    let models: SettingsModels
    init(request: SettingsValue, metadata: SettingsValue, environment: [String: String]) throws {
        home = request["home"].text; base = request["base"].text; path = request["configPath"].text
        guard request.validSettingsRequest, [home, base, path].allSatisfy({ $0.hasPrefix("/") }),
              SettingsFile.canonical(path) == SettingsFile.canonical(base + "/config.json") else {
            throw WireError.invalid("配置路径与读取时的数据实例不一致，未保存")
        }
        models = SettingsModels(metadata: metadata, base: base, configPath: path, environment: environment)
    }
    func expand(_ path: String) -> String { path == "~" ? home : path.hasPrefix("~/") ? home + String(path.dropFirst()) : path }
    func read(preview: SettingsValue? = nil) throws -> SettingsSnapshot {
        let stamp = SettingsFile.stamp(path), raw = try SettingsFile.read(path)
        try SettingsValidation.config(raw)
        for config in raw["providers"].object.values { _ = try models.endpoint(config) }
        var providers: [String: SettingsValue] = [:]
        for (id, config) in raw["providers"].object {
            var fields = config.object.filter { ["vendor", "name", "region", "baseURL", "protocol", "auth", "modelOverrides"].contains($0.key) }
            fields["keySource"] = .string(models.keySource(id, config))
            fields["keyConfigured"] = .bool(config["auth"].text != "none" && config["apiKey"].nonempty)
            providers[id] = .object(fields)
        }
        let servers = raw["mcp"]["servers"].object.mapValues { server -> SettingsValue in
            if server.object["url"] != nil { return .object(["url": server["url"], "secretNames": .strings(Array(server["headers"].object.keys).sorted())]) }
            return .object(["command": server["command"], "args": server.object["args"] ?? .array([]), "secretNames": .strings(Array(server["env"].object.keys).sorted())])
        }
        var configuration: [String: SettingsValue] = ["providers": .object(providers), "mcp": .object(["servers": .object(servers)]),
            "debugMode": raw.object["debugMode"] ?? .bool(false), "logLevel": raw.object["logLevel"] ?? .string("info"),
            "statusLine": raw.object["statusLine"] ?? .object(["cells": .strings(["session", "model", "context"]), "color": .bool(true)])]
        for key in ["models", "agentRoles", "rules", "skills", "motion"] { configuration[key] = raw.object[key] ?? .object([:]) }
        configuration["web"] = raw.object["web"] ?? .object([:])
        configuration["workspaceRoots"] = raw.object["workspaceRoots"]
        let sources = [("rules", "sources"), ("rules", "linkSources"), ("skills", "sources")].flatMap { section, key in
            raw[section][key].array.map { source -> SettingsValue in
                let expanded = expand(source.text), resolved = SettingsFile.canonical(expanded)
                var row: [String: SettingsValue] = ["source": .string(section + "." + key), "path": source, "resolved": .string(resolved)]
                var directory: ObjCBool = false
                if !expanded.hasPrefix("/") { row["problem"] = .string("须使用绝对路径或 ~ 开头的路径") }
                else if !FileManager.default.fileExists(atPath: resolved, isDirectory: &directory) { row["problem"] = .string("路径不存在或不可读取") }
                else if section == "skills", !directory.boolValue { row["problem"] = .string("技能来源须是目录") }
                return .object(row)
            }
        }
        guard SettingsFile.stamp(path) == stamp else { throw WireError.invalid("配置在读取期间已改变，请重新读取") }
        let status = preview?["statusLine"] ?? configuration["statusLine"]!
        return SettingsSnapshot(preview: settingsPreview(status, columns: Int(preview?["columns"].number ?? 90), reduced: preview?["reducedMotion"].flag ?? raw["motion"]["reduced"].flag),
            configPath: path, base: base, stamp: stamp, configuration: .object(configuration), catalog: models.rows(raw, stamp: stamp),
            vendors: models.metadata["vendors"].array.map { .object($0.object.filter { ["vendor", "label", "regions", "protocols"].contains($0.key) }) }, sources: sources)
    }
    func apply(_ action: SettingsValue, stamp: String?) async throws -> String {
        guard SettingsFile.stamp(path) == stamp else { throw WireError.invalid("配置已被修改，请重新读取后再保存；输入已保留") }
        let raw = try SettingsFile.read(path); try SettingsValidation.config(raw)
        let type = action["type"].text
        if type == "model.refresh" {
            guard let config = raw["providers"].object[action["provider"].text] else { throw WireError.invalid("连接已不存在，请重新读取") }
            async let metadataFailure = models.refreshMetadata([config], force: true)
            var listFailure: String?
            do { try await models.refresh(action["provider"].text, config: config, stamp: stamp) } catch { listFailure = error.localizedDescription }
            let failures = await [listFailure, metadataFailure].compactMap { $0 }
            if !failures.isEmpty { throw WireError.invalid(failures.joined(separator: "；")) }
            return "模型列表与 Models.dev 资料已刷新；未发起模型调用"
        }
        let snapshots = raw["providers"].object.compactMap { id, config in models.snapshot(id, config: config, stamp: stamp).map { (id, config, $0) } }
        try SettingsFile.edit(path, expected: stamp) { current in
            let next = try self.edited(current, action: action)
            try SettingsValidation.config(next)
            for (_, config) in next["providers"].object { _ = try models.endpoint(config) }
            // 网页引用在写这一侧从严；加载侧容忍悬空引用（见 SettingsValidation.config）。
            if type == "web.configure" || (type == "provider.save" && next["web"]["provider"].text == action["provider"].text) {
                try SettingsValidation.webReference(next)
                if next["web"] != .null {
                    let id = next["web"]["provider"].text
                    // `region` 是既有官方区域字段——判据是**解析后的有效基址**固定。
                    let endpoint = try models.endpoint(next["providers"][id])
                    try SettingsValidation.require(endpoint == "https://api.deepseek.com", "web.provider 须使用固定官方地址")
                }
            }
            if type == "provider.save" || type == "model.configure" {
                let provider = action["provider"].text, config = next["providers"][provider]
                // 保存前只校验**地址与协议解析**（官方提示缺这一位、型号明确不支持对话都不再拦）。
                for mapping in next["models"].object.values where mapping["provider"].text == provider { _ = try models.protocolID(config, model: mapping["model"].text) }
                if type == "provider.save" { for model in config["modelOverrides"].object.keys { _ = try models.protocolID(config, model: model) } }
            }
            if type == "role.save" { try validateRole(action["role"]) }
            return next
        }
        var cacheNote = ""
        do {
            let nextStamp = SettingsFile.stamp(path), next = try SettingsFile.read(path)
            guard SettingsFile.stamp(path) == nextStamp else { throw WireError.invalid("配置在读取期间已改变") }
            for (id, config, snapshot) in snapshots {
                guard let after = next["providers"].object[id], ["vendor", "baseURL", "region", "apiKey", "protocol", "auth"].allSatisfy({ config.object[$0] == after.object[$0] }) else { continue }
                try models.store(snapshot, config: after, stamp: nextStamp)
            }
        } catch { cacheNote = "；模型缓存未能更新，请重新刷新列表" }
        if type.hasPrefix("model.") || type.hasPrefix("provider.") { return "已保存；之后解析模型配置时采用，已有 Agent 的选择保留" + cacheNote }
        if type.hasPrefix("role.") { return "已保存；后续创建采用，已有成员保留" + cacheNote }
        if ["prefs.set", "diagnostics.set"].contains(type) { return "已保存；运行中的入口随后采用，离线入口下次启动采用" + cacheNote }
        return "已保存；下次装配时采用，已有工作保持原配置" + cacheNote
    }
    private func edited(_ raw: SettingsValue, action: SettingsValue) throws -> SettingsValue {
        var next = raw
        let type = action["type"].text, provider = action["provider"].text
        switch type {
        case "provider.save":
            var providers = raw["providers"], entry = providers[provider]
            for key in ["vendor", "name", "region", "protocol", "auth"] {
                if let value = action.object[key] { entry.put(key, value == .null || value.text.isEmpty ? nil : value) }
            }
            if let address = action.object["baseURL"], address.text != (entry.object["baseURL"]?.text ?? ""), providers.object[provider] != nil {
                guard entry["auth"].text == "none" || action["apiKey"].nonempty else { throw WireError.invalid("服务地址已改变，请重新填写该服务的凭据，或明确选择无需认证；原配置未改动") }
                if entry["auth"].text == "none" { entry.put("apiKey", nil) }
            }
            for key in ["baseURL", "apiKey"] { if let value = action.object[key] { entry.put(key, value.text.isEmpty ? nil : value) } }
            providers.put(provider, entry); next.put("providers", providers)
        case "provider.remove":
            guard raw["providers"].object[provider] != nil else { throw WireError.invalid("连接已不存在") }
            guard !raw["models"].object.values.contains(where: { $0["provider"].text == provider }) else { throw WireError.invalid("连接仍被 Default 或档位引用，请先更换或清除映射") }
            guard raw["web"]["provider"].text != provider else { throw WireError.invalid("连接仍被网页查询与搜索引用，请先在工具接入里更换或清除") }
            var providers = raw["providers"]; providers.put(provider, nil); next.put("providers", providers)
        case "web.configure":
            if action["provider"] == .null { next.put("web", nil) }
            else {
                let id = action["provider"].text
                guard raw["providers"].object[id] != nil else { throw WireError.invalid("连接已不存在，请重新读取") }
                next.put("web", .object(["provider": .string(id)]))
            }
        case "model.configure", "model.clear":
            var configured = raw.object["models"] ?? .object([:])
            let choice = action["choice"].text
            if type == "model.clear" { configured.put(choice, nil) }
            else {
                let mapping = SettingsValue.object(["provider": action["provider"], "model": action["model"]])
                configured.put(choice, mapping)
                if action["initialize"].flag {
                    for tier in ["cantrip", "spell", "arcane"] where configured.object[tier] == nil { configured.put(tier, mapping) }
                    if raw.object["defaultTier"] == nil { next.put("defaultTier", .string("cantrip")) }
                }
            }
            next.put("models", configured)
        case "model.override":
            guard raw["providers"].object[provider] != nil else { throw WireError.invalid("连接已不存在") }
            var providers = raw["providers"], entry = providers[provider], overrides = entry["modelOverrides"]
            overrides.put(action["model"].text, action["override"] == .null ? nil : action["override"])
            entry.put("modelOverrides", overrides); providers.put(provider, entry); next.put("providers", providers)
        case "prefs.set":
            if let status = action.object["statusLine"] { next.put("statusLine", status) }
            if let reduced = action.object["reducedMotion"] { next.put("motion", reduced.flag ? .object(["reduced": .bool(true)]) : nil) }
        case "diagnostics.set":
            for key in ["debugMode", "logLevel"] { if let value = action.object[key] { next.put(key, value) } }
        case "mcp.save", "mcp.remove":
            var mcp = raw["mcp"], servers = mcp["servers"]
            let name = action["name"].text
            if type == "mcp.remove" { servers.put(name, nil) }
            else {
                var server = action["server"]
                let http = server.object["url"] != nil, key = http ? "headers" : "env"
                if http { try SettingsValidation.require(["http", "https"].contains(URL(string: server["url"].text)?.scheme ?? ""), "MCP URL") }
                var secrets = servers[name][key]
                for (name, value) in action["secrets"].object {
                    try SettingsValidation.text(.string(name), "环境变量或请求头名称")
                    secrets.put(name, value == .null ? nil : value)
                }
                if !secrets.object.isEmpty { server.put(key, secrets) }
                servers.put(name, server)
            }
            mcp.put("servers", servers); next.put("mcp", mcp)
        case "sources.set":
            let parts = action["source"].text.split(separator: ".").map(String.init)
            try SettingsValidation.require(action["paths"].array.allSatisfy { expand($0.text).hasPrefix("/") }, action["source"].text)
            var section = raw[parts[0]]; section.put(parts[1], action["paths"]); next.put(parts[0], section)
        case "role.save", "role.remove":
            var roles = raw["agentRoles"]; roles.put(action["id"].text, type == "role.remove" ? nil : action["role"]); next.put("agentRoles", roles)
        case "workspace.set":
            let roots = action["roots"]
            if roots != .null {
                var seen = Set<String>()
                try SettingsValidation.require(!roots.array.isEmpty, "workspaceRoots")
                for root in roots.array {
                    let expanded = expand(root.text), canonical = SettingsFile.canonical(expanded)
                    var directory: ObjCBool = false
                    try SettingsValidation.require(expanded.hasPrefix("/") && FileManager.default.fileExists(atPath: canonical, isDirectory: &directory) && directory.boolValue && seen.insert(canonical).inserted, "workspaceRoots")
                }
            }
            next.put("workspaceRoots", roots == .null ? nil : roots)
        default: throw WireError.invalid("未知设置动作")
        }
        return next
    }
    /// 角色保存只判结构与明显冲突（D65）：档位是否配置、地址／协议能否解析、
    /// 对话与思考能力都留给创建成员或真实请求时解析。形制（字段、枚举、类型）
    /// 已由 `SettingsValidation.config` 校验；这里只多守一条——写了 model 就要指明档位。
    private func validateRole(_ role: SettingsValue) throws {
        guard role.object["model"] != nil else { return }
        guard role.object["model"]?.object["choice"] != nil else {
            throw WireError.invalid("角色模型设置须明确选择 Default 或模型档位")
        }
    }

    private func settingsPreview(_ status: SettingsValue, columns: Int, reduced: Bool) -> SettingsValue {
        let sample = models.metadata["preview"], separator = sample["separator"].text
        let segments = sample["segments"].array
        guard segments.count >= 2 else { return .object([:]) }
        func width(_ text: String) -> Int { text.reduce(0) { $0 + ($1.unicodeScalars.contains { $0.value >= 0x2E80 && $0.value <= 0xA4CF || $0.value >= 0xAC00 && $0.value <= 0xD7AF || $0.value >= 0xF900 && $0.value <= 0xFAFF || $0.value >= 0xFF01 && $0.value <= 0xFF60 } ? 2 : 1) } }
        let state = segments[0]["text"].text + segments[1]["text"].text
        let names = sample["cells"].array.map(\.text)
        var cells = status["cells"].array.compactMap { value -> SettingsValue? in names.firstIndex(of: value.text).flatMap { segments.indices.contains($0 + 2) ? segments[$0 + 2] : nil } }
        let available = columns - 2 - width(state)
        while cells.count > 1 && cells.reduce(0, { $0 + width($1["text"].text) }) > available { cells.removeLast() }
        if var first = cells.first {
            let content = String(first["text"].text.dropFirst(separator.count)), allowed = max(4, available - separator.count)
            if width(content) > allowed {
                var kept = "", used = 0
                for char in content { let size = width(String(char)); if used + size > allowed - 1 { break }; kept.append(char); used += size }
                first.put("text", .string(separator + kept + "…")); cells[0] = first
            }
        }
        var shown = Array(segments.prefix(2)) + cells
        let color = status["color"] != .bool(false)
        if !color { shown = shown.map { var item = $0; if item.object["color"] != nil { item.put("color", .null) }; return item } }
        return .object(["text": .string(shown.map { $0["text"].text }.joined()), "columns": .number(Double(columns)), "segments": .array(shown),
            "colors": color ? sample[reduced ? "reducedColors" : "colors"] : .array(Array(repeating: .null, count: 10)), "separator": sample["separator"], "fixed": .string("")])
    }
}
