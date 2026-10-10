import SwiftUI

struct ModelSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var remove: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "Default") {
                Text("普通新工作的默认选择；与三个能力档位分别保存。").foregroundStyle(.secondary).font(.callout)
                ModelChoiceEditor(model: model, snapshot: snapshot, draft: choice("default"), drafts: drafts, choice: "default")
            }.id("configuredModels")
            SettingsCard(title: "能力档位") {
                ForEach(["cantrip", "spell", "arcane"], id: \.self) { name in
                    DisclosureGroup {
                        ModelChoiceEditor(model: model, snapshot: snapshot, draft: choice(name), drafts: drafts, choice: name)
                    } label: {
                        HStack { Text(name.capitalized).font(.headline); Spacer(); Text(mapping(name)).foregroundStyle(.secondary).multilineTextAlignment(.trailing).fixedSize(horizontal: false, vertical: true) }
                    }
                    if name != "arcane" { Divider() }
                }
            }
            SettingsCard(title: "供应商连接") {
                if snapshot.configuration["providers"].object.isEmpty { Text("尚未添加连接。先接入供应商，再设置 Default。").foregroundStyle(.secondary) }
                ForEach(snapshot.configuration["providers"].object.keys.sorted(), id: \.self) { id in
                    VStack(alignment: .leading, spacing: 9) {
                        let provider = snapshot.configuration["providers"][id]
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(provider["name"].text.isEmpty ? id : provider["name"].text).font(.headline)
                                Text("\(provider["vendor"].text) · \(id) · \(keySource(provider))").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            Button("编辑") { drafts.providerEditor = id }
                            Button("移除", role: .destructive) { remove = id }
                        }
                        HStack { Button("刷新模型列表") { model.applySettings(.object(["type": .string("model.refresh"), "provider": .string(id)]), stamp: snapshot.stamp, key: "refresh-\(id)") }.disabled(model.settingsBusy)
                            Button("规格与覆盖…") { drafts.overrideProvider = id }
                        }
                        let cache = snapshot.catalog.first { $0["provider"].text == id }?["cache"] ?? .null
                        if cache["snapshot"] == .null { Text("尚未获取模型列表；查看设置不会自动联网。").font(.caption).foregroundStyle(.secondary) }
                        else { Text("缓存：\(cache["snapshot"]["models"].array.count) 个型号 · \(cache["stale"].flag ? "已过期" : "有效") · \(cacheTime(cache))").font(.caption).foregroundStyle(.secondary) }
                        if !cache["failure"]["reason"].text.isEmpty { Text(cache["failure"]["reason"].text).foregroundStyle(.red).font(.caption) }
                    }.padding(.vertical, 6)
                    Divider()
                }
                Button("添加连接", systemImage: "plus") { drafts.providerEditor = "" }
                if let id = drafts.providerEditor {
                    ProviderEditor(model: model, snapshot: snapshot, drafts: drafts,
                                   draft: providerDraft(id), id: id) { drafts.providerEditor = nil }.padding(.top, 10)
                }
                if let id = drafts.overrideProvider { ModelOverrideEditor(model: model, snapshot: snapshot, drafts: drafts, provider: id) { drafts.overrideProvider = nil } }
            }.id("providers")
        }
        .confirmationDialog("移除连接？已有记录保留，仍有映射引用时不会移除。", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            Button("移除", role: .destructive) { if let id = remove { model.applySettings(.object(["type": .string("provider.remove"), "provider": .string(id)]), stamp: snapshot.stamp, key: "remove-provider-\(id)") }; remove = nil }
            Button("取消", role: .cancel) { remove = nil }
        }
    }
    private func choice(_ name: String) -> SettingsDraft {
        var value = snapshot.configuration["models"][name].object
        value["type"] = .string("model.configure"); value["choice"] = .string(name)
        if name == "default" && snapshot.configuration["models"]["default"] == .null { value["initialize"] = .bool(true) }
        return drafts.draft("choice-\(name)", .object(value), stamp: snapshot.stamp)
    }
    private func mapping(_ name: String) -> String {
        let mapping = snapshot.configuration["models"][name]
        return mapping["model"].text.isEmpty ? "未配置" : "\(mapping["provider"].text) / \(mapping["model"].text)"
    }
    private func providerDraft(_ id: String) -> SettingsDraft {
        let existing = snapshot.configuration["providers"][id]
        return drafts.draft("provider-\(id)", .object([
            "type": .string("provider.save"), "provider": .string(id), "vendor": .string(existing["vendor"].text.isEmpty ? snapshot.vendors.first?["vendor"].text ?? "" : existing["vendor"].text),
            "name": .string(existing["name"].text), "region": .string(existing["region"].text), "baseURL": .string(existing["baseURL"].text)
        ]), stamp: snapshot.stamp)
    }
    private func keySource(_ value: SettingsValue) -> String {
        switch value["keySource"].text { case "config": return "密钥已配置"; case "env": return "使用环境变量密钥"; default: return "密钥未配置" }
    }
    private func cacheTime(_ value: SettingsValue) -> String {
        guard let ms = value["snapshot"]["fetchedAt"].number else { return "时间未知" }
        return Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened)
    }
}

struct ModelChoiceEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var draft: SettingsDraft
    let drafts: SettingsDrafts, choice: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("连接", selection: draft.field("provider")) {
                Text("请选择连接").tag("")
                ForEach(snapshot.configuration["providers"].object.keys.sorted(), id: \.self) { id in Text(id).tag(id) }
            }
            let cacheModels = snapshot.catalog.first { $0["provider"].text == draft.value["provider"].text }?["cache"]["snapshot"]["models"].array ?? []
            if !cacheModels.isEmpty {
                Picker("缓存型号", selection: draft.field("model")) {
                    Text("请选择型号").tag("")
                    if !draft.value["model"].text.isEmpty && !cacheModels.contains(where: { $0["id"].text == draft.value["model"].text }) { Text(draft.value["model"].text).tag(draft.value["model"].text) }
                    ForEach(cacheModels, id: \.self) { entry in Text(entry["name"].text.isEmpty ? entry["id"].text : entry["name"].text).tag(entry["id"].text) }
                }
            }
            SettingText(title: "精确型号", value: draft.field("model"))
            if choice == "default" && snapshot.configuration["models"]["default"] == .null {
                Toggle("同时用此型号初始化尚未配置的三个档位", isOn: draft.flag("initialize", default: false))
                Text("已有独立映射保留。之后调整 Default 不会带动其他档位。").font(.caption).foregroundStyle(.secondary)
            }
            DraftFooter(model: model, draft: draft, key: "choice-\(choice)", boundary: "之后解析时采用；已有 Agent 保持原来的实际组合。", cancel: { drafts.discard("choice-\(choice)") })
            if snapshot.configuration["models"][choice] != .null {
                Button("清除这项映射", role: .destructive) { model.applySettings(.object(["type": .string("model.clear"), "choice": .string(choice)]), stamp: snapshot.stamp, key: "choice-\(choice)") }.disabled(model.settingsBusy)
            }
        }.padding(.vertical, 8)
        .onChange(of: draft.value["provider"]) { _, _ in draft.put("model", .string("")) }
    }
}
struct ProviderEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let id: String
    var close: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider(); Text(id.isEmpty ? "添加连接" : "编辑连接").font(.headline)
            SettingText(title: "连接 ID", value: draft.field("provider")).disabled(!id.isEmpty)
            SettingText(title: "连接名称", value: draft.field("name"))
            Picker("供应商", selection: draft.field("vendor")) { ForEach(snapshot.vendors, id: \.self) { vendor in Text(vendor["label"].text).tag(vendor["vendor"].text) } }
            let regions = snapshot.vendors.first { $0["vendor"].text == draft.value["vendor"].text }?["regions"].array ?? []
            Picker("官方区域", selection: draft.field("region")) {
                Text("供应商默认区域").tag("")
                ForEach(regions, id: \.self) { region in Text(region["label"].text).tag(region["id"].text) }
            }
            SettingText(title: "高级服务地址（留空使用官方地址）", value: draft.field("baseURL"), multiline: true)
            SecureField("输入新密钥；留空保留", text: Binding(get: { draft.value["apiKey"].text }, set: { draft.put("apiKey", $0.isEmpty ? .null : .string($0)) })).textFieldStyle(.roundedBorder).accessibilityIdentifier("settings-provider-key")
            Toggle("明确清除文件中的密钥（仍可回退环境变量）", isOn: Binding(get: { draft.value.object["apiKey"] == .string("") }, set: { draft.put("apiKey", $0 ? .string("") : .null) }))
            Text("名称修改保持连接 ID。密钥只接受新输入，不回传原值。").font(.caption).foregroundStyle(.secondary)
            DraftFooter(model: model, draft: draft, key: "provider-\(id)", boundary: "保存接入资料；不会发起模型请求。", cancel: { drafts.discard("provider-\(id)"); close() })
        }
        .onChange(of: draft.value["vendor"]) { _, _ in draft.put("region", .string("")) }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "provider-\(id)" { close() } }
    }
}
struct ModelOverrideEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts, provider: String
    var close: () -> Void
    @State private var selected = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider(); Text("型号规格与必要覆盖").font(.headline)
            let cache = snapshot.catalog.first { $0["provider"].text == provider }?["cache"] ?? .null
            let models = cache["snapshot"]["models"].array
            Picker("缓存型号", selection: $selected) { Text("选择一个型号").tag(""); ForEach(models, id: \.self) { Text($0["id"].text).tag($0["id"].text) } }
            TextField("精确型号（也可直接填写）", text: $selected).textFieldStyle(.roundedBorder)
            if !selected.isEmpty {
                let raw = models.first { $0["id"].text == selected } ?? .null
                ModelSpecRows(info: raw, source: cache["snapshot"]["fetchedAt"].number.map { "供应商模型列表 · " + Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) } ?? "尚未获取供应商模型列表")
                let override = snapshot.configuration["providers"][provider]["modelOverrides"][selected]
                OverrideForm(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("override-\(provider)-\(selected)", override == .null ? .object([:]) : override, stamp: snapshot.stamp), provider: provider, selected: selected)
            }
            Button("关闭", action: close)
        }
    }
}
struct ModelSpecRows: View {
    let info: SettingsValue
    let source: String
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("供应商原始规格").font(.subheadline.weight(.medium))
            ForEach([("maxInputTokens", "输入上限"), ("maxOutputTokens", "输出上限"), ("maxContextTokens", "联合窗口")], id: \.0) { key, label in
                Text("\(label)：\(info["limits"][key].number.map { String(Int($0)) } ?? "未知")").font(.caption)
            }
            Text("来源：\(source)").font(.caption).foregroundStyle(.secondary)
            Text("思考档：\(info["reasoning"]["levels"] == .null ? "未知" : info["reasoning"]["levels"].array.map(\.text).joined(separator: " / "))").font(.caption)
            ForEach([("chat", "对话能力"), ("image", "图片能力")], id: \.0) { key, label in
                Text("\(label)：\(info["capabilities"][key] == .null ? "未知" : info["capabilities"][key].flag ? "支持" : "不支持")").font(.caption)
            }
            Text("关闭思考：\(info["reasoning"]["disable"] == .null ? "未知" : info["reasoning"]["disable"].flag ? "支持" : "不支持")").font(.caption)
            Text("思考预算：\(info["reasoning"]["budget"]["minTokens"].number.map { String(Int($0)) } ?? "未知") — \(info["reasoning"]["budget"]["maxTokens"].number.map { String(Int($0)) } ?? "未知")").font(.caption)
        }
    }
}
struct OverrideForm: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let provider: String, selected: String
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("用户覆盖（留空表示不覆盖该值）").font(.subheadline.weight(.medium))
            ForEach([("maxInputTokens", "输入上限"), ("maxOutputTokens", "输出上限"), ("maxContextTokens", "联合窗口")], id: \.0) { key, label in
                SettingText(title: label, value: nestedNumber("limits", key))
            }
            triState("对话能力", group: "capabilities", key: "chat")
            triState("图片能力", group: "capabilities", key: "image")
            triState("支持关闭思考", group: "reasoningSupport", key: "disable")
            Toggle("显式覆盖思考档列表", isOn: Binding(get: { draft.value["reasoningSupport"].object["levels"] != nil }, set: { nested("reasoningSupport", "levels", $0 ? .array([]) : .null) }))
            if draft.value["reasoningSupport"].object["levels"] != nil { StringListEditor(title: "支持的思考档（空列表表示无档位）", values: Binding(get: { draft.value["reasoningSupport"]["levels"].array.map(\.text) }, set: { nested("reasoningSupport", "levels", .strings($0)) })) }
            SettingText(title: "思考预算最小值", value: nestedNumber("reasoningSupport.budget", "minTokens"))
            SettingText(title: "思考预算最大值", value: nestedNumber("reasoningSupport.budget", "maxTokens"))
            Picker("内联思考识别", selection: Binding(get: { draft.value["traits"] == .null ? "inherit" : draft.value["traits"]["inlineThinking"] == .null ? "clear" : "tag" }, set: { draft.put("traits", $0 == "inherit" ? .null : $0 == "clear" ? .object([:]) : .object(["inlineThinking": .object(["tag": .string("")])])) })) {
                Text("继承型号资料").tag("inherit"); Text("清除模型特征").tag("clear"); Text("指定思考标记").tag("tag")
            }
            if draft.value["traits"]["inlineThinking"] != .null { SettingText(title: "内联思考标记", value: Binding(get: { draft.value["traits"]["inlineThinking"]["tag"].text }, set: { nested("traits", "inlineThinking", .object(["tag": .string($0)])) })) }
            DraftFooter(model: model, draft: draft, key: "override-\(provider)-\(selected)", boundary: "仅命中这个连接和精确型号；思考投入由 Agent 或角色独立选择。", cancel: { drafts.discard("override-\(provider)-\(selected)") }, action: {
                .object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": draft.value])
            })
            Button("清除此型号的全部覆盖", role: .destructive) { model.applySettings(.object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": .null]), stamp: snapshot.stamp, key: "override-\(provider)-\(selected)") }.disabled(model.settingsBusy)
        }
    }
    private func nestedNumber(_ group: String, _ key: String) -> Binding<String> {
        Binding(get: { let value = group == "reasoningSupport.budget" ? draft.value["reasoningSupport"]["budget"][key] : draft.value[group][key]; return value.number.map { String(Int($0)) } ?? value.text }, set: { nested(group, key, $0.isEmpty ? .null : Double($0).map(SettingsValue.number) ?? .string($0)) })
    }
    private func nested(_ group: String, _ key: String, _ value: SettingsValue) {
        if group == "reasoningSupport.budget" { var support = draft.value["reasoningSupport"].object; var budget = support["budget"]?.object ?? [:]; if value == .null { budget.removeValue(forKey: key) } else { budget[key] = value }; if budget.isEmpty { support.removeValue(forKey: "budget") } else { support["budget"] = .object(budget) }; draft.put("reasoningSupport", support.isEmpty ? .null : .object(support)); return }
        var object = draft.value[group].object; if value == .null { object.removeValue(forKey: key) } else { object[key] = value }; draft.put(group, object.isEmpty ? .null : .object(object))
    }
    private func triState(_ label: String, group: String, key: String) -> some View {
        Picker(label, selection: Binding(get: { draft.value[group][key] == .null ? "unknown" : draft.value[group][key].flag ? "yes" : "no" }, set: { nested(group, key, $0 == "unknown" ? .null : .bool($0 == "yes")) })) { Text("不覆盖").tag("unknown"); Text("支持").tag("yes"); Text("不支持").tag("no") }
    }
}
