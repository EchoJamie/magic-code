import SwiftUI

let providerProtocols = ["responses", "messages", "chat-completions"]
func providerProtocolLabel(_ value: String) -> String {
    switch value {
    case "responses": return "Responses"
    case "messages": return "Anthropic Messages"
    case "chat-completions": return "Chat Completions"
    default: return "未知协议"
    }
}
func providerDefaultAuth(_ value: String) -> String { value == "messages" ? "api-key" : "bearer" }
func providerProtocolOptions(_ vendor: SettingsValue) -> [SettingsValue] {
    providerProtocols.compactMap { id in vendor["protocols"].array.first { $0["id"].text == id } }
}
func modelProtocolName(provider: SettingsValue, model: String, vendors: [SettingsValue]) -> String {
    if !provider["protocol"].text.isEmpty { return providerProtocolLabel(provider["protocol"].text) }
    if provider["vendor"].text.isEmpty { return providerProtocolLabel("responses") }
    guard let vendor = vendors.first(where: { $0["vendor"].text == provider["vendor"].text }),
          let supported = providerProtocolOptions(vendor).first(where: { $0["models"].array.contains(.string(model)) }) else { return "未知 · 尚无此型号的协议资料" }
    return supported["label"].text
}
func providerFormValue(id: String, snapshot: SettingsSnapshot) -> SettingsValue {
    let existing = snapshot.configuration["providers"][id]
    let vendor = id.isEmpty ? snapshot.vendors.first?["vendor"].text ?? "" : existing["vendor"].text
    var value: [String: SettingsValue] = ["type": .string("provider.save"), "provider": .string(id), "name": existing["name"] == .null ? .string("") : existing["name"]]
    if vendor.isEmpty {
        value["baseURL"] = .string(existing["baseURL"].text)
        value["protocol"] = existing["protocol"] == .null ? .string("responses") : existing["protocol"]
        value["auth"] = existing["auth"] == .null ? .string(providerDefaultAuth(value["protocol"]!.text)) : existing["auth"]
    } else {
        value["vendor"] = .string(vendor)
        value["region"] = .string(existing["region"].text)
        // 未显式选择时不把生效协议写回配置。
        if existing["protocol"] != .null { value["protocol"] = existing["protocol"] }
    }
    return .object(value)
}
func providerFormAction(_ value: SettingsValue) -> SettingsValue {
    var action = value.object
    action.removeValue(forKey: "keyAction")
    if value["vendor"].text.isEmpty {
        action.removeValue(forKey: "vendor"); action.removeValue(forKey: "region")
    } else {
        action.removeValue(forKey: "baseURL"); action.removeValue(forKey: "auth")
    }
    if value["auth"].text == "none" { action.removeValue(forKey: "apiKey") }
    return .object(action)
}
func providerFormProblem(_ value: SettingsValue, snapshot: SettingsSnapshot) -> String? {
    if value["provider"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "请填写连接 ID。" }
    if value["vendor"].text.isEmpty {
        guard let url = URLComponents(string: value["baseURL"].text), ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return "API 基础地址须为完整 HTTP 或 HTTPS 地址，不含凭据、查询参数或片段。" }
        let existing = snapshot.configuration["providers"][value["provider"].text]
        if existing != .null && existing["baseURL"].text != value["baseURL"].text && value["auth"].text != "none" && value["apiKey"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "地址已改变，请重新填写该服务的凭据，或选择无需认证。"
        }
        if !providerProtocols.contains(value["protocol"].text) { return "请选择接入协议。" }
        if !["none", "bearer", "api-key"].contains(value["auth"].text) { return "请选择认证方式。" }
    } else if value["protocol"] != .null {
        let vendor = snapshot.vendors.first { $0["vendor"].text == value["vendor"].text } ?? .null
        guard let entry = vendor["protocols"].array.first(where: { $0["id"].text == value["protocol"].text }) else { return "供应商不支持所选协议。" }
        let mappings = snapshot.configuration["models"].object.values.filter { $0["provider"].text == value["provider"].text }
        let unsupported = Set(mappings.map { $0["model"].text }).subtracting(entry["models"].array.map(\.text)).sorted()
        if !unsupported.isEmpty { return "型号 \(unsupported.joined(separator: "、")) 不支持 \(entry["label"].text)，请调整协议或模型映射。" }
    }
    return nil
}
func modelInformationProblem(_ value: SettingsValue) -> String? {
    let fields = [(value["limits"], [("maxInputTokens", "输入上限"), ("maxOutputTokens", "输出上限"), ("maxContextTokens", "联合窗口")]),
                  (value["reasoningSupport"]["budget"], [("minTokens", "思考预算最小值"), ("maxTokens", "思考预算最大值")])]
    for (group, keys) in fields {
        for (key, label) in keys where group[key] != .null {
            guard let number = group[key].number, number.isFinite, number > 0, number.rounded() == number else { return "\(label)须为正整数，未知时请留空。" }
        }
    }
    let budget = value["reasoningSupport"]["budget"]
    if let min = budget["minTokens"].number, let max = budget["maxTokens"].number, min > max { return "思考预算最小值不能大于最大值。" }
    if value["reasoningSupport"]["levels"].array.contains(where: { $0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { return "思考档位名称不能为空。" }
    return nil
}

private enum ModelSettingsEditor: Identifiable {
    case choice(String), provider(String), specifications(String)
    var id: String {
        switch self {
        case .choice(let id): return "choice-\(id)"
        case .provider(let id): return "provider-\(id)"
        case .specifications(let id): return "specifications-\(id)"
        }
    }
}

struct ModelSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var editor: ModelSettingsEditor?
    @State private var remove: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 18) {
                MagicIcon(name: "sparkles", size: 44)
                VStack(alignment: .leading, spacing: 7) {
                    Text("日常工作的默认模型").font(.caption.weight(.medium)).foregroundStyle(MagicStyle.accent)
                    Text(modelName("default")).font(.title2.weight(.semibold)).textSelection(.enabled)
                    Text(connectionName("default")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("更换模型") { editor = .choice("default") }.buttonStyle(.borderedProminent)
            }
            .padding(22).frame(maxWidth: .infinity, alignment: .leading)
            .background(MagicStyle.accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(MagicStyle.accent.opacity(0.22)))
            .id("configuredModels")

            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("服务连接").font(.headline)
                    Spacer()
                    Button("添加连接", systemImage: "plus") { editor = .provider("") }
                }
                if snapshot.configuration["providers"].object.isEmpty {
                    SettingsCard(title: "尚未添加连接") {
                        Text("先添加服务连接，再为 Default 和能力档位选择模型。").foregroundStyle(.secondary)
                        Button("添加第一个连接") { editor = .provider("") }
                    }
                }
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 250), alignment: .top)], alignment: .leading, spacing: 12) {
                    ForEach(snapshot.configuration["providers"].object.keys.sorted(), id: \.self) { id in
                        providerCard(id)
                    }
                }
            }.id("providers")

            SettingsCard(title: "不同能力档位") {
                ForEach(["cantrip", "spell", "arcane"], id: \.self) { name in
                    Button { editor = .choice(name) } label: {
                        HStack(spacing: 12) {
                            MagicIcon(name: name == "cantrip" ? "bolt" : name == "spell" ? "sparkles" : "circle.hexagongrid", size: 30)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(name.capitalized).font(.callout.weight(.semibold))
                                Text(name == "cantrip" ? "轻量任务" : name == "spell" ? "常规任务" : "复杂任务").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 8)
                            VStack(alignment: .trailing, spacing: 3) {
                                Text(modelName(name)).font(.callout)
                                Text(connectionName(name)).font(.caption).foregroundStyle(.secondary)
                            }.multilineTextAlignment(.trailing)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }.padding(.vertical, 5).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("选择 \(name.capitalized) 模型")
                    if name != "arcane" { Divider() }
                }
                Label("Default 与三个档位分别保存；调整默认模型不会改变其他档位。", systemImage: "info.circle")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .sheet(item: $editor) { item in
            let current = model.settingsSnapshot ?? snapshot
            switch item {
            case .choice(let name):
                ModelChoiceEditor(model: model, snapshot: current, draft: choice(name), drafts: drafts, choice: name) { editor = nil }
            case .provider(let id):
                ProviderEditor(model: model, snapshot: current, drafts: drafts, draft: providerDraft(id), id: id) { editor = nil }
            case .specifications(let id):
                ModelOverrideEditor(model: model, snapshot: current, drafts: drafts, provider: id, selection: drafts.draft("override-selection-\(id)", .object([:]), stamp: current.stamp)) { editor = nil }
            }
        }
        .confirmationDialog("移除连接“\(remove.map { providerName($0, in: snapshot) } ?? "")”？", isPresented: Binding(get: { remove != nil }, set: { if !$0 { remove = nil } })) {
            Button("移除连接", role: .destructive) {
                if let id = remove {
                    model.applySettings(.object(["type": .string("provider.remove"), "provider": .string(id)]), stamp: snapshot.stamp, key: "remove-provider-\(id)")
                }
                remove = nil
            }
            Button("取消", role: .cancel) { remove = nil }
        } message: {
            Text("已有记录保留。仍被 Default 或能力档位引用的连接不能移除，请先更换或清除映射。")
        }
    }

    private func providerCard(_ id: String) -> some View {
        let provider = snapshot.configuration["providers"][id]
        return VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                MagicIcon(name: "network", size: 30)
                VStack(alignment: .leading, spacing: 4) {
                    Text(providerName(id, in: snapshot)).font(.headline)
                    Text("\(provider["vendor"].text.isEmpty ? "自定义" : provider["vendor"].text) · \(id)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer(minLength: 0)
                Button { editor = .provider(id) } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.plain).accessibilityLabel("编辑连接 \(providerName(id, in: snapshot))")
            }
            Label(providerKeySource(provider), systemImage: "key").font(.caption).foregroundStyle(.secondary)
            ModelCatalogStatus(model: model, snapshot: snapshot, provider: id)
            HStack {
                Button("模型与信息") { editor = .specifications(id) }
                Spacer()
                Button("移除", role: .destructive) { remove = id }.disabled(model.settingsBusy)
            }.font(.caption)
        }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(MagicStyle.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(MagicStyle.border))
    }

    private func choice(_ name: String) -> SettingsDraft {
        var value = snapshot.configuration["models"][name].object
        value["type"] = .string("model.configure")
        value["choice"] = .string(name)
        if name == "default" && snapshot.configuration["models"][name] == .null { value["initialize"] = .bool(true) }
        return drafts.draft("choice-\(name)", .object(value), stamp: snapshot.stamp)
    }
    private func modelName(_ name: String) -> String {
        let value = snapshot.configuration["models"][name]["model"].text
        return value.isEmpty ? "尚未选择模型" : value
    }
    private func connectionName(_ name: String) -> String {
        let id = snapshot.configuration["models"][name]["provider"].text
        return id.isEmpty ? "选择服务连接与精确型号" : providerName(id, in: snapshot)
    }
    private func providerDraft(_ id: String) -> SettingsDraft {
        drafts.draft("provider-\(id)", providerFormValue(id: id, snapshot: snapshot), stamp: snapshot.stamp)
    }
}

private func providerName(_ id: String, in snapshot: SettingsSnapshot) -> String {
    let name = snapshot.configuration["providers"][id]["name"].text
    return name.isEmpty ? id : name
}

private func providerKeySource(_ value: SettingsValue) -> String {
    if value["auth"].text == "none" { return "无需认证" }
    switch value["keySource"].text {
    case "config": return "密钥已配置"
    case "env": return "使用环境变量密钥"
    default: return "密钥未配置"
    }
}

private struct ModelCatalogStatus: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let provider: String
    @State private var refreshing = false
    @State private var feedback: String?
    @State private var failed = false
    var body: some View {
        let cache = snapshot.catalog.first { $0["provider"].text == provider }?["cache"] ?? .null
        VStack(alignment: .leading, spacing: 6) {
            if cache["snapshot"] == .null {
                Text(snapshot.configuration["providers"][provider]["vendor"].text.isEmpty ? "自定义连接可直接手动填写模型，无需模型列表接口。" : "尚未获取模型列表；可刷新列表或手动填写精确型号。")
            } else {
                Text("已缓存 \(cache["snapshot"]["models"].array.count) 个型号 · \(cache["stale"].flag ? "已过期" : "未过期")")
                if let ms = cache["snapshot"]["fetchedAt"].number {
                    Text("获取于 \(Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened))")
                }
            }
            if !cache["failure"]["reason"].text.isEmpty {
                Text(cache["failure"]["reason"].text).foregroundStyle(.red).textSelection(.enabled)
            }
            if !snapshot.configuration["providers"][provider]["vendor"].text.isEmpty {
                Button("刷新模型列表", systemImage: "arrow.clockwise") {
                    refreshing = true; feedback = nil
                    model.applySettings(.object(["type": .string("model.refresh"), "provider": .string(provider)]), stamp: snapshot.stamp, key: "refresh-\(provider)")
                }.disabled(model.settingsBusy)
            }
            if refreshing && model.settingsBusy {
                HStack { ProgressView().controlSize(.small); Text("正在获取模型列表…") }
            } else if let feedback {
                Text(feedback).foregroundStyle(failed ? Color.red : Color.secondary).textSelection(.enabled)
            }
        }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .onChange(of: model.settingsBusy) { _, busy in
                if !busy && refreshing {
                    failed = model.settingsError != nil
                    feedback = model.settingsError ?? model.settingsNote
                    refreshing = false
                }
            }
    }
}

// 列表与手动输入共用一个型号值，但只呈现当前模式的编辑控件。
private struct ModelIdentifierPicker: View {
    let snapshot: SettingsSnapshot
    let provider: String
    @Binding var selection: String
    @State private var manual = false
    @State private var search = ""
    private var cached: [SettingsValue] {
        snapshot.catalog.first { $0["provider"].text == provider }?["cache"]["snapshot"]["models"].array ?? []
    }
    private var identifiers: [String] {
        let mapped = snapshot.configuration["models"].object.values.filter { $0["provider"].text == provider }.map { $0["model"].text }
        return Set(cached.map { $0["id"].text } + mapped + Array(snapshot.configuration["providers"][provider]["modelOverrides"].object.keys))
            .filter { !$0.isEmpty }.sorted()
    }
    private var matches: [String] {
        identifiers.filter { id in
            search.isEmpty || id.localizedCaseInsensitiveContains(search) || cached.first { $0["id"].text == id }?["name"].text.localizedCaseInsensitiveContains(search) == true
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Picker("型号输入方式", selection: $manual) {
                Text("选择型号").tag(false)
                Text("手动填写模型").tag(true)
            }.pickerStyle(.segmented)
            if manual {
                SettingText(title: "精确型号", value: $selection)
                Text("填写供应商提供的完整 model ID，保留大小写与符号。手动输入不会验证服务端是否接受此型号。")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                TextField("搜索型号或显示名称", text: $search).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("搜索型号")
                if matches.isEmpty {
                    Text(identifiers.isEmpty ? "没有可选型号。刷新模型列表，或切换到手动输入。" : "没有匹配的型号，可切换到手动输入。")
                        .font(.callout).foregroundStyle(.secondary).padding(.vertical, 8)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 6) {
                            ForEach(matches, id: \.self) { id in
                                let entry = cached.first { $0["id"].text == id } ?? .null
                                Button { selection = id } label: {
                                    HStack(spacing: 10) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(entry["name"].text.isEmpty ? id : entry["name"].text).font(.callout.weight(.medium))
                                            Text(id).font(.caption).foregroundStyle(.secondary)
                                            if snapshot.configuration["providers"][provider]["modelOverrides"].object[id] != nil { Text("用户填写 · 覆盖优先").font(.caption2).foregroundStyle(.secondary) }
                                            else if entry == .null { Text("已配置 · 未在缓存列表中").font(.caption2).foregroundStyle(.secondary) }
                                        }
                                        Spacer()
                                        Image(systemName: selection == id ? "checkmark.circle.fill" : "circle")
                                            .foregroundStyle(selection == id ? MagicStyle.accent : Color.secondary)
                                    }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                        .background(selection == id ? MagicStyle.accent.opacity(0.09) : MagicStyle.canvas, in: RoundedRectangle(cornerRadius: 8))
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).accessibilityAddTraits(selection == id ? .isSelected : [])
                            }
                        }
                    }.frame(height: min(CGFloat(matches.count) * 76, 230))
                }
                if !selection.isEmpty {
                    Text("已选：\(selection)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
        }
        .onAppear { manual = identifiers.isEmpty || (!selection.isEmpty && !identifiers.contains(selection)) }
    }
}

struct ModelChoiceEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var draft: SettingsDraft
    let drafts: SettingsDrafts, choice: String
    var close: () -> Void
    @State private var clear = false
    @State private var information = false
    private var key: String { "choice-\(choice)" }
    private var canSave: Bool {
        ["provider", "model"].allSatisfy { !draft.value[$0].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    var body: some View {
        if information {
            let provider = draft.value["provider"].text, selected = draft.value["model"].text
            let value = snapshot.configuration["providers"][provider]["modelOverrides"][selected]
            let infoDraft = drafts.draft("override-\(provider)-\(selected)", value == .null ? .object([:]) : value, stamp: snapshot.stamp)
            OverrideForm(model: model, snapshot: snapshot, drafts: drafts, draft: infoDraft, provider: provider, selected: selected, close: { information = false }, reselect: { information = false }, saved: {
                guard draft.stamp == infoDraft.stamp, let current = model.settingsSnapshot,
                      current.configuration["models"][choice]["provider"] == draft.original["provider"],
                      current.configuration["models"][choice]["model"] == draft.original["model"] else { return }
                draft.stamp = current.stamp
            })
        } else {
            SettingsSheet(title: choice == "default" ? "选择默认模型" : "选择 \(choice.capitalized) 模型", subtitle: "为这类任务选择连接和型号，其他模型选择保持不变。", icon: "sparkles") {
                VStack(alignment: .leading, spacing: 18) {
                    if snapshot.configuration["providers"].object.isEmpty {
                        Text("尚无服务连接。请取消并在模型页添加连接后再选择型号。").foregroundStyle(.secondary)
                    }
                    Picker("服务连接", selection: Binding(get: { draft.value["provider"].text }, set: {
                        draft.put("provider", .string($0)); draft.put("model", .string(""))
                    })) {
                        Text("请选择连接").tag("")
                        ForEach(snapshot.configuration["providers"].object.keys.sorted(), id: \.self) { id in
                            Text("\(providerName(id, in: snapshot)) · \(id)").tag(id)
                        }
                    }.disabled(model.settingsBusy)
                    if !draft.value["provider"].text.isEmpty {
                        ModelIdentifierPicker(snapshot: snapshot, provider: draft.value["provider"].text, selection: draft.field("model"))
                            .id(draft.value["provider"].text).disabled(model.settingsBusy)
                        if !draft.value["model"].text.isEmpty {
                            LabeledContent("协议（按型号）", value: modelProtocolName(provider: snapshot.configuration["providers"][draft.value["provider"].text], model: draft.value["model"].text, vendors: snapshot.vendors))
                        }
                        Button("模型信息") { information = true }.disabled(!canSave || model.settingsBusy)
                        ModelCatalogStatus(model: model, snapshot: snapshot, provider: draft.value["provider"].text)
                    }
                    if choice == "default" && snapshot.configuration["models"]["default"] == .null {
                        Toggle("同时初始化尚未配置的三个档位", isOn: draft.flag("initialize", default: true))
                            .disabled(model.settingsBusy)
                        Text("只补齐尚未设置的档位；已有选择保留，之后仍可分别调整。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } footer: {
                VStack(alignment: .leading, spacing: 10) {
                    if snapshot.configuration["models"][choice] != .null {
                        Button("清除这项映射", role: .destructive) { clear = true }.disabled(model.settingsBusy)
                    }
                    DraftFooter(model: model, draft: draft, key: key, boundary: "下次选择模型时生效；已经开始的任务继续使用原模型。", cancel: close, canSave: canSave)
                }
            }
            .confirmationDialog("清除 \(choice == "default" ? "Default" : choice.capitalized) 映射？", isPresented: $clear) {
                Button("清除映射", role: .destructive) {
                    model.applySettings(.object(["type": .string("model.clear"), "choice": .string(choice)]), stamp: draft.stamp, key: key)
                }
            } message: { Text("其他映射保持原值；之后使用此项时需要重新配置。") }
            .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { cancel() } }
        }
    }
    private func cancel() { drafts.discard(key); close() }
}

struct ProviderEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let id: String
    var close: () -> Void
    @State private var validation: String?
    private var key: String { "provider-\(id)" }
    private var isCustom: Bool { draft.value["vendor"].text.isEmpty }
    private var keyAction: String {
        if !draft.value["keyAction"].text.isEmpty { return draft.value["keyAction"].text }
        if id.isEmpty { return "replace" }
        return draft.value.object["apiKey"] == nil ? "keep" : draft.value["apiKey"].text.isEmpty ? "clear" : "replace"
    }
    var body: some View {
        SettingsSheet(title: id.isEmpty ? "添加服务连接" : "编辑服务连接", subtitle: "连接保存接入资料，型号由 Default 和能力档位分别选择。", icon: "network") {
            VStack(alignment: .leading, spacing: 18) {
                SettingsCard(title: "身份") {
                    SettingText(title: "连接名称", value: draft.field("name"))
                    if id.isEmpty {
                        SettingText(title: "连接 ID", value: draft.field("provider"))
                    } else {
                        LabeledContent("连接 ID") {
                            Text(id).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                    Text(id.isEmpty ? "用于配置引用的唯一标识，创建后保持稳定。" : "连接 ID 保持不变，修改名称不会改变已有引用。")
                        .font(.caption).foregroundStyle(.secondary)
                }.disabled(model.settingsBusy)
                SettingsCard(title: "接入") {
                    Picker("供应商", selection: Binding(get: { draft.value["vendor"].text }, set: { vendor in
                        draft.put("vendor", vendor.isEmpty ? .null : .string(vendor))
                        draft.put("region", .string(""))
                        draft.put("protocol", vendor.isEmpty ? .string("responses") : .null, preserveNull: true)
                        draft.put("auth", vendor.isEmpty ? .string("bearer") : .null)
                    })) {
                        if id.isEmpty || isCustom { Text("自定义").tag("") }
                        ForEach(snapshot.vendors, id: \.self) { vendor in Text(vendor["label"].text).tag(vendor["vendor"].text) }
                    }
                    .disabled(!id.isEmpty && snapshot.configuration["providers"][id]["vendor"].text.isEmpty)
                    if isCustom {
                        Picker("接入协议", selection: Binding(get: { draft.value["protocol"].text }, set: { value in
                            let previousDefault = providerDefaultAuth(draft.value["protocol"].text)
                            if draft.value["auth"].text == previousDefault { draft.put("auth", .string(providerDefaultAuth(value))) }
                            draft.put("protocol", .string(value))
                        })) {
                            ForEach(providerProtocols, id: \.self) { value in Text(providerProtocolLabel(value)).tag(value) }
                        }
                        SettingText(title: "API 基础地址", value: draft.field("baseURL"), multiline: true)
                        Text("填写服务要求的完整基础前缀，包含所需版本路径。切换协议会保留地址；修改地址后请重新填写该服务凭据，或选择无需认证。")
                            .font(.caption).foregroundStyle(.secondary)
                        Picker("认证", selection: draft.field("auth")) {
                            Text("无需认证").tag("none")
                            Text("Bearer").tag("bearer")
                            Text("API Key（x-api-key）").tag("api-key")
                        }
                    } else {
                        let vendor = snapshot.vendors.first { $0["vendor"].text == draft.value["vendor"].text } ?? .null
                        let protocols = providerProtocolOptions(vendor)
                        if protocols.count == 1 && draft.value["protocol"] == .null {
                            LabeledContent("接入协议", value: providerProtocolLabel(protocols[0]["id"].text))
                        } else {
                            Picker("接入协议", selection: Binding(get: { draft.value["protocol"].text }, set: {
                                draft.put("protocol", $0.isEmpty ? .null : .string($0), preserveNull: true)
                            })) {
                                Text("自动 · 按精确型号选择").tag("")
                                ForEach(protocols, id: \.self) { value in Text(value["label"].text).tag(value["id"].text) }
                            }
                        }
                        Text("自动时按 Responses → Anthropic Messages → Chat Completions 选择此型号支持的协议。手动选择不支持的型号会在保存前提示。")
                            .font(.caption).foregroundStyle(.secondary)
                        ForEach(snapshot.configuration["models"].object.keys.sorted(), id: \.self) { choice in
                            let mapping = snapshot.configuration["models"][choice]
                            if mapping["provider"].text == id {
                                LabeledContent("\(choice.capitalized) · \(mapping["model"].text)", value: modelProtocolName(provider: draft.value, model: mapping["model"].text, vendors: snapshot.vendors))
                            }
                        }
                        Picker("官方区域", selection: draft.field("region")) {
                            Text("供应商默认区域").tag("")
                            ForEach(vendor["regions"].array, id: \.self) { region in Text(region["label"].text).tag(region["id"].text) }
                        }
                    }
                }.disabled(model.settingsBusy)
                if draft.value["auth"].text != "none" {
                    SettingsCard(title: "凭据") {
                        Text(providerKeySource(snapshot.configuration["providers"][id])).font(.caption).foregroundStyle(.secondary)
                        Picker("密钥操作", selection: Binding(get: { keyAction }, set: { value in
                            draft.put("keyAction", .string(value))
                            if value == "keep" { draft.put("apiKey", .null) }
                            else if value == "clear" { draft.put("apiKey", .string("")) }
                            else if draft.value["apiKey"].text.isEmpty { draft.put("apiKey", .null) }
                            validation = nil
                        })) {
                            Text(id.isEmpty ? "使用环境变量" : "保留现有").tag("keep")
                            Text("输入新密钥").tag("replace")
                            if !id.isEmpty { Text("清除文件密钥").tag("clear") }
                        }
                        if keyAction == "replace" {
                            SecureField("新 API 密钥", text: draft.field("apiKey")).textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("settings-provider-key")
                            Text("现有密钥不会回显；保存后以新密钥替换。").font(.caption).foregroundStyle(.secondary)
                        } else {
                            Text(keyAction == "clear" ? "保存后清除文件密钥，仍可回退此连接的环境变量。" : "保留文件密钥；没有文件密钥时使用此连接的环境变量。")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(model.settingsBusy)
                } else {
                    Text("无需认证：不发送密钥，也不读取环境变量凭据。").font(.caption).foregroundStyle(.secondary)
                }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 10) {
                if let validation { Label(validation, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.callout) }
                DraftFooter(model: model, draft: draft, key: key, boundary: "仅保存连接资料，不发起模型调用。", cancel: close, action: {
                    validation = nil
                    if id.isEmpty && snapshot.configuration["providers"].object[draft.value["provider"].text] != nil {
                        validation = "此连接 ID 已存在，请使用其他 ID，或取消后编辑已有连接。"; return nil
                    }
                    if draft.value["auth"].text != "none" && keyAction == "replace" && draft.value["apiKey"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        validation = id.isEmpty ? "请输入新密钥，或选择使用环境变量。" : "请输入新密钥，或切换到保留现有密钥。"; return nil
                    }
                    validation = providerFormProblem(draft.value, snapshot: snapshot)
                    return validation == nil ? providerFormAction(draft.value) : nil
                })
            }
        }
        .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { cancel() } }
    }
    private func cancel() { drafts.discard(key); close() }
}

struct ModelOverrideEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts, provider: String
    @ObservedObject var selection: SettingsDraft
    var close: () -> Void
    @State private var inspected: String?
    var body: some View {
        if let inspected {
            let override = snapshot.configuration["providers"][provider]["modelOverrides"][inspected]
            let draft = drafts.draft("override-\(provider)-\(inspected)", override == .null ? .object([:]) : override, stamp: snapshot.stamp)
            OverrideForm(model: model, snapshot: snapshot, drafts: drafts, draft: draft, provider: provider, selected: inspected, close: close, reselect: { self.inspected = nil })
        } else {
            SettingsSheet(title: "型号规格与覆盖", subtitle: providerName(provider, in: snapshot) + " · " + provider, icon: "slider.horizontal.3") {
                VStack(alignment: .leading, spacing: 18) {
                    ModelIdentifierPicker(snapshot: snapshot, provider: provider, selection: selection.field("model")).disabled(model.settingsBusy)
                    ModelCatalogStatus(model: model, snapshot: snapshot, provider: provider)
                }
            } footer: {
                VStack(alignment: .leading, spacing: 10) {
                    if let error = model.settingsError { Text(error).foregroundStyle(.red).font(.callout).textSelection(.enabled) }
                    if let note = model.settingsNote { Text(note).foregroundStyle(.secondary).font(.caption) }
                    Divider()
                    HStack {
                        Button("取消", action: close).keyboardShortcut(.cancelAction).disabled(model.settingsBusy)
                        Spacer()
                        Button("编辑模型与信息") { inspected = selection.value["model"].text }
                            .buttonStyle(.borderedProminent).disabled(selection.value["model"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.settingsBusy)
                    }
                }
            }
        }
    }
}

struct ModelSpecRows: View {
    let info: SettingsValue
    let source: String
    var body: some View {
        SettingsCard(title: "供应商原始规格") {
            Text("供应商资料经接入层归一；不含下方用户覆盖。缺失信息保持未知。").font(.caption).foregroundStyle(.secondary)
            if !info["description"].text.isEmpty { Text(info["description"].text).font(.callout).textSelection(.enabled) }
            ForEach([("maxInputTokens", "输入上限"), ("maxOutputTokens", "输出上限"), ("maxContextTokens", "联合窗口")], id: \.0) { key, label in
                LabeledContent(label, value: number(info["limits"][key]))
            }
            ForEach([("chat", "对话能力"), ("image", "图片能力"), ("tools", "工具调用")], id: \.0) { key, label in
                LabeledContent(label, value: support(info["capabilities"][key]))
            }
            LabeledContent("思考档位", value: info["reasoning"]["levels"] == .null ? "未知" : info["reasoning"]["levels"].array.isEmpty ? "无档位" : info["reasoning"]["levels"].array.map(\.text).joined(separator: " / "))
            LabeledContent("支持关闭思考", value: support(info["reasoning"]["disable"]))
            LabeledContent("思考预算", value: "\(number(info["reasoning"]["budget"]["minTokens"])) — \(number(info["reasoning"]["budget"]["maxTokens"]))")
            LabeledContent("内联思考标记", value: info["traits"] == .null ? "未知" : info["traits"]["inlineThinking"]["tag"].text.isEmpty ? "无" : info["traits"]["inlineThinking"]["tag"].text)
            Text("来源：\(source)").font(.caption).foregroundStyle(.secondary)
        }.font(.callout).textSelection(.enabled)
    }
    private func number(_ value: SettingsValue) -> String { value.number.map { $0.formatted(.number.precision(.fractionLength(0))) } ?? "未知" }
    private func support(_ value: SettingsValue) -> String { value == .null ? "未知" : value.flag ? "支持" : "不支持" }
}

struct OverrideForm: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    let provider: String, selected: String
    var close: () -> Void
    var reselect: () -> Void
    var saved: (() -> Void)? = nil
    @State private var clear = false
    @State private var informationExpanded = false
    @State private var validation: String?
    private var key: String { "override-\(provider)-\(selected)" }
    var body: some View {
        SettingsSheet(title: "型号规格与覆盖", subtitle: providerName(provider, in: snapshot) + " · " + provider, icon: "slider.horizontal.3") {
            content
        } footer: {
            footer
        }
        .onAppear { informationExpanded = !draft.value.object.isEmpty }
    }
    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            let cache = snapshot.catalog.first { $0["provider"].text == provider }?["cache"] ?? .null
            let raw = cache["snapshot"]["models"].array.first { $0["id"].text == selected } ?? .null
            Text(selected).font(.headline).textSelection(.enabled)
            LabeledContent("协议（按型号）", value: modelProtocolName(provider: snapshot.configuration["providers"][provider], model: selected, vendors: snapshot.vendors))
            DisclosureGroup("模型信息", isExpanded: $informationExpanded) {
                ModelSpecRows(info: raw, source: cache["snapshot"]["fetchedAt"].number.map {
                    "供应商模型列表 · " + Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .shortened) + (cache["stale"].flag ? " · 缓存已过期" : "")
                } ?? "尚未获取供应商模型列表")
                SettingsCard(title: "用户覆盖 · 上下文与能力") {
                    Text("令牌上限逐项覆盖；留空继承原始资料。数值须为正整数。").font(.caption).foregroundStyle(.secondary)
                    ForEach([("maxInputTokens", "输入上限"), ("maxOutputTokens", "输出上限"), ("maxContextTokens", "联合窗口")], id: \.0) { key, label in
                        SettingText(title: label, value: nestedNumber("limits", key))
                    }
                    triState("对话能力", group: "capabilities", key: "chat")
                    triState("图片能力", group: "capabilities", key: "image")
                    triState("工具调用", group: "capabilities", key: "tools")
                }.disabled(model.settingsBusy)
                SettingsCard(title: "用户覆盖 · 思考能力") {
                    Toggle("覆盖整组思考能力", isOn: Binding(get: { draft.value["reasoningSupport"] != .null }, set: {
                        draft.put("reasoningSupport", $0 ? .object([:]) : .null)
                    }))
                    Text("关闭时继承供应商思考能力。开启后整组替换，未填写的能力为未知；空组明确表示无已知可配置能力。思考投入由 Agent 或角色独立选择。")
                        .font(.caption).foregroundStyle(.secondary)
                    if draft.value["reasoningSupport"] != .null {
                        Picker("模型默认思考", selection: Binding(get: { draft.value["reasoningSupport"]["default"].text }, set: {
                            nested("reasoningSupport", "default", $0.isEmpty ? .null : .string($0))
                        })) {
                            Text("未知").tag(""); Text("开启").tag("on"); Text("关闭").tag("off")
                        }
                        triState("支持关闭思考", group: "reasoningSupport", key: "disable")
                        Toggle("指定支持的思考档位", isOn: Binding(get: { draft.value["reasoningSupport"]["levels"] != .null }, set: {
                            nested("reasoningSupport", "levels", $0 ? .array([]) : .null)
                        }))
                        if draft.value["reasoningSupport"]["levels"] != .null {
                            StringListEditor(title: "思考档位（空列表表示无档位）", values: Binding(get: { draft.value["reasoningSupport"]["levels"].array.map(\.text) }, set: { nested("reasoningSupport", "levels", .strings($0)) }))
                        }
                        Toggle("声明支持思考预算（未声明为未知）", isOn: Binding(get: { draft.value["reasoningSupport"]["budget"] != .null }, set: {
                            nested("reasoningSupport", "budget", $0 ? .object([:]) : .null)
                        }))
                        if draft.value["reasoningSupport"]["budget"] != .null {
                            SettingText(title: "思考预算最小值", value: nestedNumber("reasoningSupport.budget", "minTokens"))
                            SettingText(title: "思考预算最大值", value: nestedNumber("reasoningSupport.budget", "maxTokens"))
                        }
                        Text("模型默认不指定思考投入。这里仅描述能力；具体关闭、档位和预算仍由所选协议适配校验，不生成私有请求字段。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.disabled(model.settingsBusy)
                SettingsCard(title: "用户覆盖 · 内联思考") {
                    Picker("内联思考识别", selection: Binding(get: { draft.value["traits"] == .null ? "inherit" : draft.value["traits"]["inlineThinking"] == .null ? "clear" : "tag" }, set: {
                        draft.put("traits", $0 == "inherit" ? .null : $0 == "clear" ? .object([:]) : .object(["inlineThinking": .object(["tag": .string("")])]))
                    })) {
                        Text("继承型号资料").tag("inherit")
                        Text("清除模型特征").tag("clear")
                        Text("指定思考标记").tag("tag")
                    }
                    if draft.value["traits"]["inlineThinking"] != .null {
                        SettingText(title: "内联思考标记", value: Binding(get: { draft.value["traits"]["inlineThinking"]["tag"].text }, set: { nested("traits", "inlineThinking", .object(["tag": .string($0)])) }))
                    }
                    Text("标记用于识别正文中的内联思考，不改变模型的思考投入。").font(.caption).foregroundStyle(.secondary)
                }.disabled(model.settingsBusy)
            }
            Text(draft.value.object.isEmpty ? "信息可选填；未提供的能力保持未知。保存即可保留此精确型号。" : "来源：用户填写，优先于供应商信息；清除覆盖后恢复下层来源。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button("选择其他型号") {
                    reselect()
                }
                Spacer()
                if snapshot.configuration["providers"][provider]["modelOverrides"][selected] != .null {
                    Button("清除全部覆盖", role: .destructive) { clear = true }
                }
            }.disabled(model.settingsBusy)
            if let validation { Text(validation).foregroundStyle(.red).font(.callout) }
            DraftFooter(model: model, draft: draft, key: key, boundary: "仅影响此连接与精确型号，不修改供应商原始缓存。", cancel: close, action: {
                validation = modelInformationProblem(draft.value)
                guard validation == nil else { informationExpanded = true; return nil }
                return .object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": draft.value])
            })
        }
        .confirmationDialog("清除此型号的全部用户覆盖？", isPresented: $clear) {
            Button("清除全部覆盖", role: .destructive) {
                model.applySettings(.object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": .null]), stamp: draft.stamp, key: key)
            }
        } message: { Text("之后使用供应商已有资料，未提供的规格保持未知。") }
        .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { self.saved?(); cancel() } }
    }
    private func cancel() { drafts.discard(key); close() }
    private func nestedNumber(_ group: String, _ key: String) -> Binding<String> {
        Binding(get: {
            let value = group == "reasoningSupport.budget" ? draft.value["reasoningSupport"]["budget"][key] : draft.value[group][key]
            return value.number.map { $0.formatted(.number.grouping(.never).precision(.fractionLength(0...16)).locale(Locale(identifier: "en_US_POSIX"))) } ?? value.text
        }, set: { nested(group, key, $0.isEmpty ? .null : Double($0).map(SettingsValue.number) ?? .string($0)) })
    }
    private func nested(_ group: String, _ key: String, _ value: SettingsValue) {
        if group == "reasoningSupport.budget" {
            var support = draft.value["reasoningSupport"].object
            var budget = support["budget"]?.object ?? [:]
            if value == .null { budget.removeValue(forKey: key) } else { budget[key] = value }
            support["budget"] = .object(budget)
            draft.put("reasoningSupport", .object(support))
            return
        }
        var object = draft.value[group].object
        if value == .null { object.removeValue(forKey: key) } else { object[key] = value }
        draft.put(group, object.isEmpty && group != "reasoningSupport" ? .null : .object(object))
    }
    private func triState(_ label: String, group: String, key: String) -> some View {
        Picker(label, selection: Binding(get: { draft.value[group][key] == .null ? "unknown" : draft.value[group][key].flag ? "yes" : "no" }, set: {
            nested(group, key, $0 == "unknown" ? .null : .bool($0 == "yes"))
        })) {
            Text(group == "reasoningSupport" ? "未知" : "不覆盖 · 未提供时为未知").tag("unknown")
            Text("支持").tag("yes")
            Text("不支持").tag("no")
        }
    }
}
