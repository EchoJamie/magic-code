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
            "statusLine": raw.object["statusLine"] ?? .object(["cells": .strings(["session", "context"]), "color": .bool(true)])]
        for key in ["models", "agentRoles", "rules", "skills", "permissions", "motion"] { configuration[key] = raw.object[key] ?? .object([:]) }
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
        let grantPath = base + "/grants.json", grantStamp = SettingsFile.stamp(grantPath)
        var grants: [SettingsValue] = [], grantProblem: String?
        do {
            let file = try SettingsFile.read(grantPath)
            if grantStamp != nil {
                try validGrantFile(file)
                for (workspace, entries) in file["workspaces"].object.sorted(by: { $0.key < $1.key }) {
                    if !entries.isArray { grantProblem = "授权文件存在无法读取的内容，请定位文件修复"; continue }
                    let valid = entries.array.compactMap { entry -> SettingsValue? in
                        do { try validGrant(entry); return normalizedGrant(entry) } catch { grantProblem = "授权文件存在无法读取的内容，请定位文件修复"; return nil }
                    }
                    if !valid.isEmpty { grants.append(.object(["workspace": .string(workspace), "entries": .array(valid)])) }
                }
            }
        } catch { grantProblem = "授权文件存在无法读取的内容，请定位文件修复" }
        guard SettingsFile.stamp(path) == stamp, SettingsFile.stamp(grantPath) == grantStamp else { throw WireError.invalid("配置或授权在读取期间已改变，请重新读取") }
        let status = preview?["statusLine"] ?? configuration["statusLine"]!
        return SettingsSnapshot(preview: settingsPreview(status, columns: Int(preview?["columns"].number ?? 90), reduced: preview?["reducedMotion"].flag ?? raw["motion"]["reduced"].flag),
            configPath: path, base: base, stamp: stamp, configuration: .object(configuration), catalog: models.rows(raw, stamp: stamp),
            vendors: models.metadata["vendors"].array.map { .object($0.object.filter { ["vendor", "label", "regions", "protocols"].contains($0.key) }) }, sources: sources,
            grants: grants, grantStamp: grantStamp, grantProblem: grantProblem)
    }
    func apply(_ action: SettingsValue, stamp: String?) async throws -> String {
        guard SettingsFile.stamp(path) == stamp else { throw WireError.invalid("配置已被修改，请重新读取后再保存；输入已保留") }
        let raw = try SettingsFile.read(path); try SettingsValidation.config(raw)
        let type = action["type"].text
        if type == "model.refresh" {
            guard let config = raw["providers"].object[action["provider"].text] else { throw WireError.invalid("连接已不存在，请重新读取") }
            try await models.refresh(action["provider"].text, config: config, stamp: stamp)
            return "模型列表已刷新；未发起模型调用"
        }
        if type == "grants.revoke" {
            try revoke(action)
            return "已撤销授权；配置权限规则另行管理"
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
                for mapping in next["models"].object.values where mapping["provider"].text == provider { try models.checkSelection(config, model: mapping["model"].text) }
                if type == "provider.save" { for model in config["modelOverrides"].object.keys { try models.checkSelection(config, model: model) } }
            }
            if type == "role.save", let model = action["role"].object["model"] { try validateRole(model, raw: next, stamp: stamp) }
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
                guard !action["initialize"].flag || choice == "default" else { throw WireError.invalid("首次初始化只能保存 Default") }
                let mapping = SettingsValue.object(["provider": action["provider"], "model": action["model"]])
                configured.put(choice, mapping)
                if action["initialize"].flag { for tier in ["cantrip", "spell", "arcane"] where configured.object[tier] == nil { configured.put(tier, mapping) } }
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
        case "permissions.set":
            for rule in action["rules"].array { try SettingsValidation.permission(rule, ops: models.metadata["ruleOps"].array.map(\.text)) }
            var permissions = raw["permissions"]; permissions.put("rules", action["rules"]); next.put("permissions", permissions)
        default: throw WireError.invalid("未知设置动作")
        }
        return next
    }
    private func validateRole(_ role: SettingsValue, raw: SettingsValue, stamp: String?) throws {
        guard let choice = role.object["choice"]?.text else { throw WireError.invalid("角色模型设置须明确选择 Default 或模型档位") }
        let mapping = raw["models"][choice]
        guard mapping.isObject else { throw WireError.invalid("角色模型设置：所选档位尚未配置") }
        let id = mapping["provider"].text, model = mapping["model"].text, config = raw["providers"][id]
        try models.checkSelection(config, model: model)
        let known = models.snapshot(id, config: config, stamp: stamp)?["models"].array.first { $0["id"].text == model }
        try SettingsValidation.require((config["modelOverrides"][model]["capabilities"].object["chat"] ?? known?["capabilities"].object["chat"]) != .bool(false), "角色模型对话能力")
        guard let setting = role.object["reasoning"], setting["mode"].text != "default" else { return }
        guard let support = models.effectiveReasoning(config, model: model, known: known) else { throw WireError.invalid("角色模型的思考能力未知，只能使用默认设置") }
        switch setting["mode"].text {
        case "off": try SettingsValidation.require(support["disable"] == .bool(true), "角色模型关闭思考")
        case "level": try SettingsValidation.require(support["levels"].array.contains(setting["level"]), "角色模型思考档位")
        case "budget":
            let value = setting["budgetTokens"].number ?? 0, budget = support["budget"]
            try SettingsValidation.require(budget.isObject && value >= (budget["minTokens"].number ?? 1) && value <= (budget["maxTokens"].number ?? .greatestFiniteMagnitude), "角色模型思考预算")
        default: throw WireError.invalid("角色模型思考设置无效")
        }
    }
    private func validGrantFile(_ raw: SettingsValue) throws {
        try SettingsValidation.require((raw.object["version"] == nil || raw["version"] == .number(1)) && raw["workspaces"].isObject, "授权文件版本或工作区")
    }
    private func validGrant(_ entry: SettingsValue) throws {
        var rule = entry
        for key in ["grantedAt", "lastHitAt", "hits"] { rule.put(key, nil) }
        try SettingsValidation.permission(rule, ops: models.metadata["ruleOps"].array.map(\.text))
        try SettingsValidation.require(entry["grantedAt"].number?.isFinite == true, "授权记账时间")
        for key in ["lastHitAt", "hits"] { if let value = entry.object[key] { try SettingsValidation.require(value.number.map { $0.isFinite && $0 >= 0 } == true, "授权记账字段") } }
    }
    private func normalizedGrant(_ entry: SettingsValue) -> SettingsValue {
        var entry = entry
        for key in ["tool", "path", "host", "via"] { if let value = entry.object[key] { let text = value.text.trimmingCharacters(in: .whitespacesAndNewlines); entry.put(key, .string(["host", "via"].contains(key) ? text.lowercased() : text)) } }
        return entry
    }
    private func revoke(_ action: SettingsValue) throws {
        let grantPath = base + "/grants.json", expected = action["grantStamp"] == .null ? nil : action["grantStamp"].text
        try SettingsFile.edit(grantPath, expected: expected) { file in
            let raw = expected == nil ? SettingsValue.object(["version": .number(1), "workspaces": .object([:])]) : file
            try validGrantFile(raw)
            var next = raw, workspaces = raw["workspaces"]
            let workspace = action["workspace"].text
            if let index = action["index"].number {
                let rows = workspaces[workspace].array
                let validIndices = rows.indices.filter { (try? validGrant(rows[$0])) != nil }
                guard index < Double(validIndices.count) else { throw WireError.invalid("该授权已不存在，请重新读取") }
                var kept = rows; kept.remove(at: validIndices[Int(index)])
                workspaces.put(workspace, kept.isEmpty ? nil : .array(kept))
            } else { workspaces.put(workspace, nil) }
            next.put("workspaces", workspaces); return next
        }
    }
    private func settingsPreview(_ status: SettingsValue, columns: Int, reduced: Bool) -> SettingsValue {
        let sample = models.metadata["preview"], separator = sample["separator"].text
        let segments = sample["segments"].array
        guard segments.count >= 3 else { return .object([:]) }
        func width(_ text: String) -> Int { text.reduce(0) { $0 + ($1.unicodeScalars.contains { $0.value >= 0x2E80 && $0.value <= 0xA4CF || $0.value >= 0xAC00 && $0.value <= 0xD7AF || $0.value >= 0xF900 && $0.value <= 0xFAFF || $0.value >= 0xFF01 && $0.value <= 0xFF60 } ? 2 : 1) } }
        let state = segments[0]["text"].text + segments[1]["text"].text, fixed = segments[2]["text"].text
        let names = sample["cells"].array.map(\.text)
        var cells = status["cells"].array.compactMap { value -> SettingsValue? in names.firstIndex(of: value.text).flatMap { segments.indices.contains($0 + 3) ? segments[$0 + 3] : nil } }
        let available = columns - 2 - width(state) - width(fixed)
        while cells.count > 1 && cells.reduce(0, { $0 + width($1["text"].text) }) > available { cells.removeLast() }
        if var first = cells.first {
            let content = String(first["text"].text.dropFirst(separator.count)), allowed = max(4, available - separator.count)
            if width(content) > allowed {
                var kept = "", used = 0
                for char in content { let size = width(String(char)); if used + size > allowed - 1 { break }; kept.append(char); used += size }
                first.put("text", .string(separator + kept + "…")); cells[0] = first
            }
        }
        var shown = Array(segments.prefix(3)) + cells
        let color = status["color"] != .bool(false)
        if !color { shown = shown.map { var item = $0; if item.object["color"] != nil { item.put("color", .null) }; return item } }
        return .object(["text": .string(shown.map { $0["text"].text }.joined()), "columns": .number(Double(columns)), "segments": .array(shown),
            "colors": color ? sample[reduced ? "reducedColors" : "colors"] : .array(Array(repeating: .null, count: 10)), "separator": sample["separator"], "fixed": sample["fixed"]])
    }
}
