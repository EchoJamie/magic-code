import Foundation

/// 原生编辑的文件契约；未知字段保留，已知字段不以默认值掩盖损坏内容。
enum SettingsValidation {
    static let choices = ["default", "cantrip", "spell", "arcane"]
    static func require(_ valid: Bool, _ field: String) throws {
        if !valid { throw WireError.invalid("\(field) 内容无效，请检查该字段") }
    }
    static func object(_ value: SettingsValue, _ field: String) throws { try require(value.isObject, field) }
    static func text(_ value: SettingsValue, _ field: String) throws { try require(value.nonempty, field) }
    static func texts(_ value: SettingsValue, _ field: String, empty: Bool = false) throws {
        try require(value.isArray && value.array.allSatisfy { empty ? $0.isText : $0.nonempty }, field)
    }
    static func positive(_ value: SettingsValue, _ field: String) throws {
        try require(value.number.map { $0 > 0 && $0.rounded() == $0 && $0.isFinite } == true, field)
    }
    static func reasoning(_ value: SettingsValue, _ field: String) throws {
        try object(value, field)
        switch value["mode"].text {
        case "default", "off": break
        case "level": try text(value["level"], field + ".level")
        case "budget": try positive(value["budgetTokens"], field + ".budgetTokens")
        default: try require(false, field + ".mode")
        }
    }
    static func support(_ value: SettingsValue, _ field: String) throws {
        try object(value, field)
        if let levels = value.object["levels"] { try texts(levels, field + ".levels") }
        if let mode = value.object["default"] { try require(["on", "off"].contains(mode.text), field + ".default") }
        if let disable = value.object["disable"] { try require(disable.isBool, field + ".disable") }
        if let budget = value.object["budget"] {
            try object(budget, field + ".budget")
            for key in ["minTokens", "maxTokens"] { if let n = budget.object[key] { try positive(n, field + ".budget." + key) } }
            if let min = budget["minTokens"].number, let max = budget["maxTokens"].number { try require(min <= max, field + ".budget") }
        }
    }
    static func overrides(_ value: SettingsValue, _ field: String) throws {
        try object(value, field)
        for (id, entry) in value.object {
            let field = field + "." + id
            try text(.string(id), field); try object(entry, field)
            try require(entry.object["reasoning"] == nil, field + ".reasoning 已移除")
            if let limits = entry.object["limits"] {
                try object(limits, field + ".limits")
                for key in ["maxInputTokens", "maxOutputTokens", "maxContextTokens"] { if let n = limits.object[key] { try positive(n, field + ".limits." + key) } }
                if let window = limits["maxContextTokens"].number {
                    for key in ["maxInputTokens", "maxOutputTokens"] { if let n = limits[key].number { try require(n <= window, field + ".limits." + key) } }
                }
            }
            if let traits = entry.object["traits"] {
                try object(traits, field + ".traits")
                if let inline = traits.object["inlineThinking"] { try object(inline, field + ".traits.inlineThinking"); try text(inline["tag"], field + ".traits.inlineThinking.tag") }
            }
            if let reasoning = entry.object["reasoningSupport"] { try support(reasoning, field + ".reasoningSupport") }
            if let capabilities = entry.object["capabilities"] {
                try object(capabilities, field + ".capabilities")
                try require(capabilities.object.allSatisfy { ["chat", "image", "tools"].contains($0.key) && $0.value.isBool }, field + ".capabilities")
            }
        }
    }
    static func config(_ raw: SettingsValue) throws {
        try object(raw, "配置根")
        if let providers = raw.object["providers"] {
            try object(providers, "providers")
            for (id, entry) in providers.object {
                let field = "providers." + id
                try object(entry, field)
                for key in ["model", "reasoning", "traits", "contextWindow"] { try require(entry.object[key] == nil, field + "." + key + " 已移除") }
                for key in ["vendor", "protocol", "auth", "name", "region", "baseURL"] { if let v = entry.object[key] { try text(v, field + "." + key) } }
                if let key = entry.object["apiKey"] { try require(key.isText, field + ".apiKey") }
                if entry.object["vendor"] == nil { try text(entry["baseURL"], field + ".baseURL") }
                if let p = entry.object["protocol"] { try require(["responses", "messages", "chat-completions"].contains(p.text), field + ".protocol") }
                if let auth = entry.object["auth"] { try require(["none", "bearer", "api-key"].contains(auth.text), field + ".auth") }
                if let values = entry.object["modelOverrides"] { try overrides(values, field + ".modelOverrides") }
            }
        }
        if let models = raw.object["models"] {
            try object(models, "models")
            for (choice, mapping) in models.object {
                let field = "models." + choice
                try require(choices.contains(choice), field); try object(mapping, field)
                try require(mapping.object.keys.allSatisfy { ["provider", "model"].contains($0) }, field)
                try text(mapping["provider"], field + ".provider"); try text(mapping["model"], field + ".model")
                try require(raw["providers"].object[mapping["provider"].text] != nil, field + ".provider")
            }
        }
        if let roles = raw.object["agentRoles"] {
            try object(roles, "agentRoles")
            for (id, role) in roles.object {
                let field = "agentRoles." + id
                try text(.string(id), field); try object(role, field)
                try require(role.object.keys.allSatisfy { ["name", "instructions", "guidanceFiles", "skills", "tools", "model"].contains($0) }, field)
                for key in ["name", "instructions"] { try text(role[key], field + "." + key) }
                for key in ["guidanceFiles", "skills", "tools"] { if let v = role.object[key] { try texts(v, field + "." + key) } }
                if let model = role.object["model"] {
                    try object(model, field + ".model")
                    try require(model.object.keys.allSatisfy { ["choice", "reasoning"].contains($0) }, field + ".model")
                    if let choice = model.object["choice"] { try require(choices.contains(choice.text), field + ".model.choice") }
                    if let value = model.object["reasoning"] { try reasoning(value, field + ".model.reasoning") }
                }
            }
        }
        if let roots = raw.object["workspaceRoots"] { try texts(roots, "workspaceRoots") }
        for section in ["rules", "skills", "permissions", "motion", "mcp"] { if let value = raw.object[section] { try object(value, section) } }
        for (section, key) in [("rules", "sources"), ("rules", "linkSources"), ("skills", "sources")] {
            if let values = raw[section].object[key] { try texts(values, section + "." + key) }
        }
        if let servers = raw["mcp"].object["servers"] {
            try object(servers, "mcp.servers")
            for (name, server) in servers.object {
                let field = "mcp.servers." + name
                try require(name.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil && !name.contains("__"), field)
                try object(server, field)
                let http = server.object["url"] != nil
                if http {
                    try require(server.object["command"] == nil, field)
                    try text(server["url"], field + ".url")
                    try require(URL(string: server["url"].text)?.scheme != nil, field + ".url")
                } else {
                    try text(server["command"], field + ".command")
                    if let args = server.object["args"] { try texts(args, field + ".args", empty: true) }
                }
                let key = http ? "headers" : "env"
                if let secrets = server.object[key] {
                    try object(secrets, field + "." + key)
                    try require(secrets.object.values.allSatisfy { $0.isText && (!http || $0.text.unicodeScalars.allSatisfy { (32...126).contains($0.value) }) }, field + "." + key)
                }
            }
        }
        if let status = raw.object["statusLine"] {
            try object(status, "statusLine")
            try require(status["cells"].isArray && status["cells"].array.allSatisfy { ["session", "model", "reasoning", "context", "workspace"].contains($0.text) }, "statusLine.cells")
            if let color = status.object["color"] { try require(color.isBool, "statusLine.color") }
        }
        if let motion = raw["motion"].object["reduced"] { try require(motion.isBool, "motion.reduced") }
        if let debug = raw.object["debugMode"] { try require(debug.isBool, "debugMode") }
        if let level = raw.object["logLevel"] { try require(["error", "warn", "info", "debug", "trace"].contains(level.text), "logLevel") }
        if let duration = raw.object["turnDuration"] { try require(["elapsed", "active"].contains(duration.text), "turnDuration") }
    }
    static func permission(_ rule: SettingsValue, ops allowed: [String]) throws {
        try object(rule, "权限规则")
        try require(rule.object.keys.allSatisfy { ["tool", "path", "host", "op"].contains($0) }, "权限规则字段")
        try text(rule["tool"], "权限规则.tool")
        for key in ["path", "host"] { if let value = rule.object[key] { try text(value, "权限规则." + key) } }
        if let op = rule.object["op"] {
            let ops = op.isArray ? op.array : [op]
            try require(!ops.isEmpty && ops.allSatisfy { allowed.contains($0.text) }, "权限规则.op")
        }
    }
}
