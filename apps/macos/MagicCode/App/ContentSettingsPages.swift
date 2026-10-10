import SwiftUI

struct McpSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var remove: String?
    var body: some View {
        SettingsCard(title: "MCP 服务器") {
            Text("保存即明确配置接入，下次装配采用。查看设置不会启动服务器；已有工作不更换工具表。").font(.callout).foregroundStyle(.secondary)
            let servers = snapshot.configuration["mcp"]["servers"]
            if servers.object.isEmpty { Text("尚未配置服务器。").foregroundStyle(.secondary) }
            ForEach(servers.object.keys.sorted(), id: \.self) { name in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) { Text(name).font(.headline); Text(servers[name]["url"] == .null ? "stdio · \(servers[name]["command"].text)" : "HTTP · \(servers[name]["url"].text)").font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    Spacer(); Button("编辑") { drafts.mcpEditor = name }; Button("移除", role: .destructive) { remove = name }
                }
                Divider()
            }
            Button("添加服务器", systemImage: "plus") { drafts.mcpEditor = "" }
            if let name = drafts.mcpEditor {
                let server = servers[name]
                McpEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("mcp-\(name)", .object([
                    "name": .string(name), "transport": .string(server["url"] == .null ? "stdio" : "http"),
                    "command": .string(server["command"].text), "url": .string(server["url"].text), "args": server["args"] == .null ? .array([]) : server["args"],
                    "secretRows": .array(server["secretNames"].array.map { .object(["name": $0, "mode": .string("keep"), "value": .string("")]) })
                ]), stamp: snapshot.stamp), name: name) { drafts.mcpEditor = nil }
            }
            Divider(); Text("工作中的连接状态").font(.headline)
            if let error = model.runtimeSettingsError { Text(error).font(.caption).foregroundStyle(.secondary) }
            Button("刷新运行状态") { model.readRuntimeSettings() }.disabled(!model.isCurrent)
            if model.runtimeMcp.isEmpty { Text("当前没有可查询的活动工作。配置条目不代表已连接。").font(.caption).foregroundStyle(.secondary) }
            ForEach(model.runtimeMcp, id: \.self) { work in
                Text("工作：\(work["session"].text)").font(.caption).textSelection(.enabled)
                ForEach(work["servers"].array, id: \.self) { server in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(server["server"].text) · \(server["state"]["status"].text) · \(server["tools"].array.count) 个工具")
                            if !server["state"]["reason"].text.isEmpty { Text(server["state"]["reason"].text).foregroundStyle(.secondary).font(.caption).fixedSize(horizontal: false, vertical: true) }
                        }
                        Spacer()
                        Button("重连此工作") {
                            model.reconnectMcp(session: work["session"].text, gen: Int(work["gen"].number ?? -1), name: server["server"].text)
                        }.disabled(!model.isCurrent || work["gen"] == .null)
                    }
                }
            }
        }.id("servers")
        .confirmationDialog("移除服务器配置？已有工作保持原工具表。", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            Button("移除", role: .destructive) { if let name = remove { model.applySettings(.object(["type": .string("mcp.remove"), "name": .string(name)]), stamp: snapshot.stamp, key: "remove-mcp") }; remove = nil }
            Button("取消", role: .cancel) { remove = nil }
        }
    }
}
struct McpEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let name: String
    var close: () -> Void
    @State private var fieldError: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider(); Text(name.isEmpty ? "添加服务器" : "编辑服务器").font(.headline)
            SettingText(title: "服务器名称", value: draft.field("name")).disabled(!name.isEmpty)
            Text("名称使用字母、数字、点、下划线或短横线，不能含双下划线。").font(.caption).foregroundStyle(.secondary)
            Picker("接入方式", selection: draft.field("transport")) { Text("stdio · 本地命令").tag("stdio"); Text("HTTP").tag("http") }
            if draft.value["transport"].text == "http" { SettingText(title: "HTTP URL", value: draft.field("url"), multiline: true) }
            else { SettingText(title: "命令", value: draft.field("command"), multiline: true); StringListEditor(title: "独立参数（每项为一个参数）", values: draft.strings("args"), ordered: true) }
            Text(draft.value["transport"].text == "http" ? "请求头" : "环境变量").font(.headline)
            ForEach(draft.value["secretRows"].array.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 8) {
                    SettingText(title: "名称", value: row(index, "name")).disabled(snapshot.configuration["mcp"]["servers"][name]["secretNames"].array.contains(draft.value["secretRows"].array[index]["name"]))
                    Picker("值的处理", selection: row(index, "mode")) { Text("保留已配置值").tag("keep"); Text("替换").tag("replace"); Text("清除").tag("clear") }
                    if draft.value["secretRows"].array[index]["mode"].text == "replace" { SecureField("输入新值", text: row(index, "value")).textFieldStyle(.roundedBorder) }
                    Button("移除此项", role: .destructive) { var rows = draft.value["secretRows"].array; rows[index] = .object(["name": rows[index]["name"], "mode": .string("clear")]); draft.put("secretRows", .array(rows)) }
                }.padding(10).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            }
            Button("添加环境变量或请求头", systemImage: "plus") { var rows = draft.value["secretRows"].array; rows.append(.object(["name": .string(""), "mode": .string("replace"), "value": .string("")])); draft.put("secretRows", .array(rows)) }
            Text("已配置值只显示名称。保留、替换和清除分别处理；查看或取消不会执行命令。").font(.caption).foregroundStyle(.secondary)
            if let fieldError { Text(fieldError).foregroundStyle(.red) }
            DraftFooter(model: model, draft: draft, key: "mcp-\(name)", boundary: "下次装配时采用，已有工作不热换工具表。", cancel: { drafts.discard("mcp-\(name)"); close() }, action: action)
        }.onChange(of: model.settingsSavedKey) { _, key in if key == "mcp-\(name)" { close() } }
    }
    private func row(_ index: Int, _ key: String) -> Binding<String> {
        Binding(get: { draft.value["secretRows"].array[index][key].text }, set: { value in var rows = draft.value["secretRows"].array; var row = rows[index].object; row[key] = .string(value); rows[index] = .object(row); draft.put("secretRows", .array(rows)) })
    }
    private func action() -> SettingsValue? {
        let names = draft.value["secretRows"].array.map { $0["name"].text }
        guard names.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }), Set(names).count == names.count else { fieldError = "环境变量或请求头名称不能为空，也不能重复。"; return nil }
        fieldError = nil
        var secrets: [String: SettingsValue] = [:]
        for row in draft.value["secretRows"].array { let name = row["name"].text; if row["mode"].text == "clear" { secrets[name] = .null }; if row["mode"].text == "replace" { secrets[name] = row["value"] } }
        let server: SettingsValue = draft.value["transport"].text == "http" ? .object(["url": draft.value["url"]]) : .object(["command": draft.value["command"], "args": draft.value["args"]])
        return .object(["type": .string("mcp.save"), "name": draft.value["name"], "server": server, "secrets": .object(secrets)])
    }
}

struct MaterialSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(["rules.sources", "rules.linkSources", "skills.sources"], id: \.self) { source in
                let components = source.split(separator: ".").map(String.init)
                let values = snapshot.configuration[components[0]][components[1]]
                SourceEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft(source, .object(["type": .string("sources.set"), "source": .string(source), "paths": values == .null ? .array([]) : values]), stamp: snapshot.stamp), source: source)
            }
        }
    }
}
struct SourceEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let source: String
    private var title: String { source == "rules.sources" ? "主动加载的补充规约" : source == "rules.linkSources" ? "规约链接的允许来源" : "补充技能目录" }
    var body: some View {
        SettingsCard(title: title) {
            Text(source == "rules.sources" ? "点名文件或目录，正文会在既有加载时点进入上下文。" : source == "rules.linkSources" ? "只允许根内规约链接跟随至这些来源，不主动加载正文。" : "补充技能发现目录；同名时保留既有来源优先级。").font(.callout).foregroundStyle(.secondary)
            StringListEditor(title: "来源路径", values: draft.strings("paths"), ordered: true)
            ForEach(snapshot.sources.filter { $0["source"].text == source }, id: \.self) { entry in
                VStack(alignment: .leading, spacing: 5) {
                    SettingsPath(label: "解析位置", path: entry["resolved"].text) { model.terminal.copy(entry["resolved"].text) }
                    if !entry["problem"].text.isEmpty { Text(entry["problem"].text).foregroundStyle(.red).font(.caption) }
                    Button("在 Finder 定位原文件") { revealSettingPath(entry["resolved"].text) }
                }
            }
            DraftFooter(model: model, draft: draft, key: source, boundary: "按既有发现与加载时点采用，不重写已发送上下文。这些来源不授予执行权限。", cancel: { drafts.discard(source) })
        }.id(source)
    }
}

struct RoleSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var remove: String?
    var body: some View {
        SettingsCard(title: "角色") {
            let roles = snapshot.configuration["agentRoles"]
            if roles.object.isEmpty { Text("尚未配置角色。可以先明确职责，再按需设置材料与模型。").foregroundStyle(.secondary) }
            ForEach(roles.object.keys.sorted(), id: \.self) { id in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) { Text(roles[id]["name"].text).font(.headline); Text(roles[id]["instructions"].text).font(.caption).foregroundStyle(.secondary).lineLimit(4) }
                    Spacer(); Button("编辑") { drafts.roleEditor = id }; Button("删除", role: .destructive) { remove = id }
                }; Divider()
            }
            Button("添加角色", systemImage: "plus") { drafts.roleEditor = "" }
            if let id = drafts.roleEditor {
                var value: SettingsValue { var fields = roles[id].object; fields["id"] = .string(id); return .object(fields) }
                RoleEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("role-\(id)", value, stamp: snapshot.stamp), id: id) { drafts.roleEditor = nil }
            }
        }.id("roles")
        .confirmationDialog("删除角色默认？已有成员保留。", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            Button("删除", role: .destructive) { if let id = remove { model.applySettings(.object(["type": .string("role.remove"), "id": .string(id)]), stamp: snapshot.stamp, key: "remove-role") }; remove = nil }
            Button("取消", role: .cancel) { remove = nil }
        }
    }
}
struct RoleEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let id: String
    var close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider(); Text(id.isEmpty ? "添加角色" : "编辑角色").font(.headline)
            SettingText(title: "角色 ID", value: draft.field("id")).disabled(!id.isEmpty)
            SettingText(title: "名称", value: draft.field("name"))
            SettingText(title: "职责与指导", value: draft.field("instructions"), multiline: true)
            StringListEditor(title: "指导文件（引用原文件）", values: draft.strings("guidanceFiles"))
            StringListEditor(title: "技能引用", values: draft.strings("skills"))
            Toggle("收窄可用工具", isOn: Binding(get: { draft.value["tools"] != .null }, set: { draft.put("tools", $0 ? .array([]) : .null) }))
            if draft.value["tools"] != .null { StringListEditor(title: "工具名（空列表不使用普通工具）", values: draft.strings("tools")) }
            Text("未收窄时沿既有工具范围；角色不能授予权限。").font(.caption).foregroundStyle(.secondary)
            Picker("后续创建的默认模型", selection: nestedField("choice")) {
                Text("继承创建入口").tag("")
                ForEach(["default", "cantrip", "spell", "arcane"], id: \.self) { Text($0.capitalized).tag($0) }
            }
            Picker("独立思考", selection: reasoningField("mode")) {
                Text("继承创建入口").tag(""); Text("模型默认").tag("default"); Text("关闭").tag("off"); Text("指定档位").tag("level"); Text("指定 token 预算").tag("budget")
            }
            if draft.value["model"]["reasoning"]["mode"].text == "level" { SettingText(title: "思考档（须由该型号支持）", value: reasoningField("level")) }
            if draft.value["model"]["reasoning"]["mode"].text == "budget" { SettingText(title: "思考 token 预算", value: reasoningField("budgetTokens")) }
            Button("清除显式模型与思考默认") { draft.put("model", .null) }
            DraftFooter(model: model, draft: draft, key: "role-\(id)", boundary: "后续创建采用；已有成员保留。指导文件、技能、工具沿既有检查，不扩权。", cancel: { drafts.discard("role-\(id)"); close() }, action: {
                var role = draft.value.object; role.removeValue(forKey: "id")
                return .object(["type": .string("role.save"), "id": draft.value["id"], "role": .object(role)])
            })
        }.onChange(of: model.settingsSavedKey) { _, key in if key == "role-\(id)" { close() } }
    }
    private func nestedField(_ key: String) -> Binding<String> {
        Binding(get: { draft.value["model"][key].text }, set: { var model = draft.value["model"].object; if $0.isEmpty { model.removeValue(forKey: key) } else { model[key] = .string($0) }; draft.put("model", model.isEmpty ? .null : .object(model)) })
    }
    private func reasoningField(_ key: String) -> Binding<String> {
        Binding(get: { let value = draft.value["model"]["reasoning"][key]; return value.number.map { String(Int($0)) } ?? value.text }, set: { value in
            var model = draft.value["model"].object; var reasoning = model["reasoning"]?.object ?? [:]
            if key == "mode" { reasoning = value.isEmpty ? [:] : ["mode": .string(value)] }
            else { reasoning[key] = key == "budgetTokens" ? Double(value).map(SettingsValue.number) ?? .string(value) : .string(value) }
            if reasoning.isEmpty { model.removeValue(forKey: "reasoning") } else { model["reasoning"] = .object(reasoning) }
            draft.put("model", model.isEmpty ? .null : .object(model))
        })
    }
}
