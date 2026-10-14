import SwiftUI

struct McpSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var remove: String?
    var body: some View {
        SettingsCard(title: "工具服务") {
            Text("添加你希望任务使用的外部工具。新任务采用保存的配置，正在进行的任务继续使用原来的工具。").font(.callout).foregroundStyle(.secondary)
            let servers = snapshot.configuration["mcp"]["servers"]
            if servers.object.isEmpty { Text("尚未配置服务器。").foregroundStyle(.secondary) }
            ForEach(servers.object.keys.sorted(), id: \.self) { name in
                HStack(alignment: .top) {
                    MagicIcon(name: "shippingbox")
                    VStack(alignment: .leading, spacing: 5) { Text(name).font(.headline); Text(servers[name]["url"] == .null ? "stdio · \(servers[name]["command"].text)" : "HTTP · \(servers[name]["url"].text)").font(.caption).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    MagicBadge(text: "已配置"); Spacer(); Button("编辑") { drafts.mcpEditor = name }; Button("移除", role: .destructive) { remove = name }
                }
                Divider()
            }
            Button("添加服务器", systemImage: "plus") { drafts.mcpEditor = "" }
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
        .sheet(isPresented: Binding(get: { drafts.mcpEditor != nil }, set: { if !$0 { drafts.mcpEditor = nil } })) {
            if let name = drafts.mcpEditor {
                let server = snapshot.configuration["mcp"]["servers"][name]
                McpEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("mcp-\(name)", .object([
                    "name": .string(name), "transport": .string(server["url"] == .null ? "stdio" : "http"),
                    "command": .string(server["command"].text), "url": .string(server["url"].text), "args": server["args"] == .null ? .array([]) : server["args"],
                    "secretRows": .array(server["secretNames"].array.map { .object(["name": $0, "mode": .string("keep"), "value": .string("")]) })
                ]), stamp: snapshot.stamp), name: name) { drafts.mcpEditor = nil }
            }
        }
        .sheet(isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            if let name = remove {
                SettingsRemovalSheet(model: model, title: "移除工具服务", object: name, boundary: "仅移除此服务器配置。正在进行的任务继续使用原来的工具，新任务不再接入此服务。", action: .object(["type": .string("mcp.remove"), "name": .string(name)]), stamp: snapshot.stamp, key: "remove-mcp") { remove = nil }
            }
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
        SettingsSheet(title: name.isEmpty ? "添加工具服务" : "编辑工具服务", subtitle: name.isEmpty ? "配置新任务可使用的 MCP 工具服务" : "当前服务器：\(name)", icon: "shippingbox") {
            SettingsCard(title: "身份") {
                SettingText(title: "服务器名称", value: draft.field("name")).disabled(!name.isEmpty)
                Text("名称使用字母、数字、点、下划线或短横线，不能含双下划线。").font(.caption).foregroundStyle(.secondary)
            }
            SettingsCard(title: "接入方式与参数") {
                Picker("接入方式", selection: draft.field("transport")) { Text("stdio · 本地命令").tag("stdio"); Text("HTTP").tag("http") }
                if draft.value["transport"].text == "http" { SettingText(title: "HTTP URL", value: draft.field("url"), multiline: true) }
                else { SettingText(title: "命令", value: draft.field("command"), multiline: true); StringListEditor(title: "独立参数（每项为一个参数）", values: draft.strings("args"), ordered: true) }
                if transportChanged {
                    Text("更换接入方式会移除原方式的凭据；需要使用的值请重新输入。").font(.caption).foregroundStyle(.orange)
                }
            }
            SettingsCard(title: draft.value["transport"].text == "http" ? "凭据与请求头" : "凭据与环境变量") {
                ForEach(draft.value["secretRows"].array.indices, id: \.self) { index in
                    VStack(alignment: .leading, spacing: 8) {
                        SettingText(title: "名称", value: row(index, "name")).disabled(snapshot.configuration["mcp"]["servers"][name]["secretNames"].array.contains(draft.value["secretRows"].array[index]["name"]))
                        Picker("值的处理", selection: row(index, "mode")) {
                            if existingSecret(index) { Text("保留已配置值").tag("keep") }
                            Text("替换").tag("replace"); Text("清除").tag("clear")
                        }
                        if draft.value["secretRows"].array[index]["mode"].text == "replace" { SecureField("输入新值", text: row(index, "value")).textFieldStyle(.roundedBorder) }
                        Button("移除此项", role: .destructive) { var rows = draft.value["secretRows"].array; if existingSecret(index) { rows[index] = .object(["name": rows[index]["name"], "mode": .string("clear")]) } else { rows.remove(at: index) }; draft.put("secretRows", .array(rows)) }
                    }.padding(10).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                }
                Button("添加环境变量或请求头", systemImage: "plus") { var rows = draft.value["secretRows"].array; rows.append(.object(["name": .string(""), "mode": .string("replace"), "value": .string("")])); draft.put("secretRows", .array(rows)) }
                Text("已配置值只显示名称。保留、替换和清除分别处理；查看或取消不会执行命令。").font(.caption).foregroundStyle(.secondary)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                if let fieldError { Text(fieldError).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
                DraftFooter(model: model, draft: draft, key: "mcp-\(name)", boundary: "新任务使用保存的配置；正在进行的任务继续使用原来的工具。", cancel: { drafts.discard("mcp-\(name)"); close() }, action: action)
            }
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "mcp-\(name)" { close() } }
    }
    private var transportChanged: Bool {
        !name.isEmpty && draft.value["transport"].text != (snapshot.configuration["mcp"]["servers"][name]["url"] == .null ? "stdio" : "http")
    }
    private func existingSecret(_ index: Int) -> Bool {
        snapshot.configuration["mcp"]["servers"][name]["secretNames"].array.contains(draft.value["secretRows"].array[index]["name"])
    }
    private func row(_ index: Int, _ key: String) -> Binding<String> {
        Binding(get: { let rows = draft.value["secretRows"].array; return rows.indices.contains(index) ? rows[index][key].text : "" }, set: { value in var rows = draft.value["secretRows"].array; guard rows.indices.contains(index) else { return }; var row = rows[index].object; row[key] = .string(value); rows[index] = .object(row); draft.put("secretRows", .array(rows)) })
    }
    private func action() -> SettingsValue? {
        if transportChanged && draft.value["secretRows"].array.contains(where: { $0["mode"].text == "keep" }) {
            fieldError = "更换接入方式后，请将原凭据选择为替换或清除。"; return nil
        }
        let names = draft.value["secretRows"].array.map { $0["name"].text }
        guard names.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }), Set(names).count == names.count else { fieldError = "环境变量或请求头名称不能为空，也不能重复。"; return nil }
        fieldError = nil
        var secrets: [String: SettingsValue] = [:]
        for row in draft.value["secretRows"].array { let name = row["name"].text; if row["mode"].text == "clear" { secrets[name] = .null }; if row["mode"].text == "replace" { secrets[name] = row["value"] } }
        let server: SettingsValue = draft.value["transport"].text == "http" ? .object(["url": draft.value["url"]]) : .object(["command": draft.value["command"], "args": draft.value["args"]])
        return .object(["type": .string("mcp.save"), "name": draft.value["name"], "server": server, "secrets": .object(secrets)])
    }
}

private enum MaterialSource: String, CaseIterable, Identifiable {
    case rules = "rules.sources", links = "rules.linkSources", skills = "skills.sources"
    var id: String { rawValue }
    var title: String { switch self { case .rules: "主动加载的补充规约"; case .links: "规约链接的允许来源"; case .skills: "补充技能目录" } }
    var icon: String { self == .skills ? "sparkles" : self == .links ? "link" : "book.closed" }
    var detail: String { switch self {
    case .rules: "指定文件或目录，正文在既有加载时点进入上下文。"
    case .links: "只允许根内规约链接跟随至这些来源，不主动加载正文。"
    case .skills: "补充技能发现目录；同名时保留既有来源优先级。"
    } }
    func paths(_ snapshot: SettingsSnapshot) -> SettingsValue {
        let keys = rawValue.split(separator: ".").map(String.init)
        let value = snapshot.configuration[keys[0]][keys[1]]
        return value == .null ? .array([]) : value
    }
}
struct MaterialSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var editing: MaterialSource?
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(MaterialSource.allCases) { source in
                SettingsCard(title: source.title) {
                    HStack(alignment: .top, spacing: 12) {
                        MagicIcon(name: source.icon)
                        VStack(alignment: .leading, spacing: 6) {
                            Text(source.detail).foregroundStyle(.secondary)
                            MagicBadge(text: "\(source.paths(snapshot).array.count) 个配置来源")
                        }
                        Spacer()
                        Button("编辑来源") { editing = source }
                    }
                    SourceStatusList(model: model, entries: snapshot.sources.filter { $0["source"].text == source.rawValue })
                }.id(source.rawValue)
            }
            Text("这里管理补充来源；来源路径不授予执行权限。保存不重写已发送的上下文。").font(.caption).foregroundStyle(.secondary)
        }.sheet(item: $editing) { source in
            SourceEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft(source.rawValue, .object(["type": .string("sources.set"), "source": .string(source.rawValue), "paths": source.paths(snapshot)]), stamp: snapshot.stamp), source: source) { editing = nil }
        }
    }
}
private struct SourceStatusList: View {
    @ObservedObject var model: AppModel
    let entries: [SettingsValue]
    var body: some View {
        if entries.isEmpty { Text("尚未配置补充来源").font(.caption).foregroundStyle(.secondary) }
        ForEach(entries, id: \.self) { entry in
            VStack(alignment: .leading, spacing: 6) {
                Divider()
                HStack(alignment: .top) {
                    Text(entry["path"].text).font(.system(.callout, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    MagicBadge(text: entry["problem"].text.isEmpty ? "路径已检查" : "需要处理", color: entry["problem"].text.isEmpty ? MagicStyle.accent : .orange)
                }
                SettingsPath(label: "解析位置", path: entry["resolved"].text) { model.copyText(entry["resolved"].text) }
                if !entry["problem"].text.isEmpty { Text(entry["problem"].text).foregroundStyle(.red).font(.caption) }
                Button("在 Finder 定位") { revealSettingPath(entry["resolved"].text) }.disabled(entry["resolved"].text.isEmpty)
            }
        }
    }
}
private struct SourceEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let source: MaterialSource
    var close: () -> Void
    var body: some View {
        SettingsSheet(title: source.title, subtitle: source.detail, icon: source.icon) {
            SettingsCard(title: "来源路径与顺序") {
                StringListEditor(title: "来源路径", values: draft.strings("paths"), ordered: true)
                Text("使用绝对路径或 ~ 开头的路径。调整顺序沿用既有发现与加载规则。").font(.caption).foregroundStyle(.secondary)
            }
        } footer: {
            DraftFooter(model: model, draft: draft, key: source.rawValue, boundary: "只更新这一类来源。下次加载时使用，已经发给模型的内容保持不变。", cancel: { drafts.discard(source.rawValue); close() })
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == source.rawValue { close() } }
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
                    MagicIcon(name: "person.crop.rectangle")
                    VStack(alignment: .leading, spacing: 6) {
                        Text(roles[id]["name"].text).font(.headline)
                        Text(id).font(.caption).foregroundStyle(.secondary)
                        Text(roles[id]["instructions"].text).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                        Text("\(roles[id]["model"]["choice"].text.isEmpty ? "继承创建入口模型" : roles[id]["model"]["choice"].text.capitalized) · \(roles[id]["tools"] == .null ? "继承工具范围" : "指定 \(roles[id]["tools"].array.count) 个工具")").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Button("编辑") { drafts.roleEditor = id }; Button("删除", role: .destructive) { remove = id }
                }; Divider()
            }
            Button("添加角色", systemImage: "plus") { drafts.roleEditor = "" }

        }.id("roles")
        .sheet(isPresented: Binding(get: { drafts.roleEditor != nil }, set: { if !$0 { drafts.roleEditor = nil } })) {
            if let id = drafts.roleEditor {
                var value: SettingsValue { var fields = snapshot.configuration["agentRoles"][id].object; fields["id"] = .string(id); return .object(fields) }
                RoleEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("role-\(id)", value, stamp: snapshot.stamp), id: id) { drafts.roleEditor = nil }
            }
        }
        .sheet(isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            if let id = remove {
                SettingsRemovalSheet(model: model, title: "删除角色", object: "\(snapshot.configuration["agentRoles"][id]["name"].text) · \(id)", boundary: "删除此角色的创建默认。已有成员保留原职责、模型与工具范围。", action: .object(["type": .string("role.remove"), "id": .string(id)]), stamp: snapshot.stamp, key: "remove-role") { remove = nil }
            }
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
        SettingsSheet(title: id.isEmpty ? "添加协作角色" : "编辑协作角色", subtitle: id.isEmpty ? "为后续创建的成员定义职责与默认选项" : "当前角色：\(id)", icon: "person.crop.rectangle") {
            SettingsCard(title: "身份与职责") {
                SettingText(title: "角色 ID", value: draft.field("id")).disabled(!id.isEmpty)
                SettingText(title: "名称", value: draft.field("name"))
                SettingText(title: "职责与指导", value: draft.field("instructions"), multiline: true)
            }
            SettingsCard(title: "指导材料") {
                StringListEditor(title: "指导文件（引用原文件）", values: draft.strings("guidanceFiles"))
                StringListEditor(title: "技能引用", values: draft.strings("skills"))
            }
            SettingsCard(title: "工具范围") {
                Toggle("收窄可用工具", isOn: Binding(get: { draft.value["tools"] != .null }, set: { draft.put("tools", $0 ? .array([]) : .null) }))
                if draft.value["tools"] != .null { StringListEditor(title: "工具名（空列表不使用普通工具）", values: draft.strings("tools")) }
                Text("未收窄时沿既有工具范围；角色不能授予权限。").font(.caption).foregroundStyle(.secondary)
            }
            SettingsCard(title: "模型与思考") {
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
            }
        } footer: {
            DraftFooter(model: model, draft: draft, key: "role-\(id)", boundary: "新建成员使用这些默认值；已有成员保持原设置，工具仍需满足权限要求。", cancel: { drafts.discard("role-\(id)"); close() }, action: {
                var role = draft.value.object; role.removeValue(forKey: "id")
                return .object(["type": .string("role.save"), "id": draft.value["id"], "role": .object(role)])
            })
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "role-\(id)" { close() } }
    }
    private func nestedField(_ key: String) -> Binding<String> {
        Binding(get: { draft.value["model"][key].text }, set: { var model = draft.value["model"].object; if $0.isEmpty { model.removeValue(forKey: key) } else { model[key] = .string($0) }; draft.put("model", model.isEmpty ? .null : .object(model)) })
    }
    private func reasoningField(_ key: String) -> Binding<String> {
        Binding(get: { let value = draft.value["model"]["reasoning"][key]; return value.number.map { String(format: "%.0f", $0) } ?? value.text }, set: { value in
            var model = draft.value["model"].object; var reasoning = model["reasoning"]?.object ?? [:]
            if key == "mode" { reasoning = value.isEmpty ? [:] : ["mode": .string(value)] }
            else { reasoning[key] = key == "budgetTokens" ? Double(value).map(SettingsValue.number) ?? .string(value) : .string(value) }
            if reasoning.isEmpty { model.removeValue(forKey: "reasoning") } else { model["reasoning"] = .object(reasoning) }
            draft.put("model", model.isEmpty ? .null : .object(model))
        })
    }
}

struct SettingsRemovalSheet: View {
    @ObservedObject var model: AppModel
    let title: String
    let object: String
    let boundary: String
    let action: SettingsValue
    let stamp: String?
    let key: String
    var close: () -> Void
    var body: some View {
        SettingsSheet(title: title, subtitle: object, icon: "exclamationmark.triangle", preferredHeight: 280) {
            Text(boundary).fixedSize(horizontal: false, vertical: true)
        } footer: {
            VStack(alignment: .leading, spacing: 12) {
                Divider()
                if let error = model.settingsError { Text(error).foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                HStack {
                    Button("取消", action: close).keyboardShortcut(.cancelAction)
                    Spacer()
                    Button(title, role: .destructive) { model.applySettings(action, stamp: stamp, key: key) }.buttonStyle(.borderedProminent).tint(.red)
                }.disabled(model.settingsBusy)
            }
        }
        .onChange(of: model.settingsSavedKey) { _, value in if value == key { close() } }
    }
}
