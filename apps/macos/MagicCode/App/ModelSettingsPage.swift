import SwiftUI

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
                ModelOverrideEditor(model: model, snapshot: current, drafts: drafts, provider: id) { editor = nil }
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
                    Text("\(provider["vendor"].text) · \(id)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer(minLength: 0)
                Button { editor = .provider(id) } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.plain).accessibilityLabel("编辑连接 \(providerName(id, in: snapshot))")
            }
            Label(providerKeySource(provider), systemImage: "key").font(.caption).foregroundStyle(.secondary)
            ModelCatalogStatus(model: model, snapshot: snapshot, provider: id)
            HStack {
                Button("规格与覆盖") { editor = .specifications(id) }
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
        let existing = snapshot.configuration["providers"][id]
        return drafts.draft("provider-\(id)", .object([
            "type": .string("provider.save"), "provider": .string(id),
            "vendor": .string(existing["vendor"].text.isEmpty ? snapshot.vendors.first?["vendor"].text ?? "" : existing["vendor"].text),
            "name": .string(existing["name"].text), "region": .string(existing["region"].text), "baseURL": .string(existing["baseURL"].text)
        ]), stamp: snapshot.stamp)
    }
}

private func providerName(_ id: String, in snapshot: SettingsSnapshot) -> String {
    let name = snapshot.configuration["providers"][id]["name"].text
    return name.isEmpty ? id : name
}

private func providerKeySource(_ value: SettingsValue) -> String {
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
                Text("尚未获取模型列表；可刷新列表或手动填写精确型号。")
            } else {
                Text("已缓存 \(cache["snapshot"]["models"].array.count) 个型号 · \(cache["stale"].flag ? "已过期" : "未过期")")
                if let ms = cache["snapshot"]["fetchedAt"].number {
                    Text("获取于 \(Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .shortened))")
                }
            }
            if !cache["failure"]["reason"].text.isEmpty {
                Text(cache["failure"]["reason"].text).foregroundStyle(.red).textSelection(.enabled)
            }
            Button("刷新模型列表", systemImage: "arrow.clockwise") {
                refreshing = true; feedback = nil
                model.applySettings(.object(["type": .string("model.refresh"), "provider": .string(provider)]), stamp: snapshot.stamp, key: "refresh-\(provider)")
            }.disabled(model.settingsBusy)
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
                Text("手动输入").tag(true)
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
                                            if entry == .null { Text("已配置 · 未在缓存列表中").font(.caption2).foregroundStyle(.secondary) }
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
        .onAppear { manual = !selection.isEmpty && !identifiers.contains(selection) }
    }
}

struct ModelChoiceEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var draft: SettingsDraft
    let drafts: SettingsDrafts, choice: String
    var close: () -> Void
    @State private var clear = false
    private var key: String { "choice-\(choice)" }
    private var canSave: Bool {
        ["provider", "model"].allSatisfy { !draft.value[$0].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }
    var body: some View {
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
                    ModelCatalogStatus(model: model, snapshot: snapshot, provider: draft.value["provider"].text)
                }
                if choice == "default" && snapshot.configuration["models"]["default"] == .null {
                    Toggle("同时初始化尚未配置的三个档位", isOn: draft.flag("initialize"))
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
                DraftFooter(model: model, draft: draft, key: key, boundary: "下次选择模型时生效；已经开始的任务继续使用原模型。", cancel: cancel, canSave: canSave)
            }
        }
        .confirmationDialog("清除 \(choice == "default" ? "Default" : choice.capitalized) 映射？", isPresented: $clear) {
            Button("清除映射", role: .destructive) {
                model.applySettings(.object(["type": .string("model.clear"), "choice": .string(choice)]), stamp: draft.stamp, key: key)
            }
        } message: { Text("其他映射保持原值；之后使用此项时需要重新配置。") }
        .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { cancel() } }
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
    @State private var keyAction = "keep"
    @State private var advancedExpanded = false
    @State private var validation: String?
    private var key: String { "provider-\(id)" }
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
                    Picker("供应商", selection: Binding(get: { draft.value["vendor"].text }, set: {
                        draft.put("vendor", .string($0)); draft.put("region", .string(""))
                    })) {
                        ForEach(snapshot.vendors, id: \.self) { vendor in Text(vendor["label"].text).tag(vendor["vendor"].text) }
                    }
                    let regions = snapshot.vendors.first { $0["vendor"].text == draft.value["vendor"].text }?["regions"].array ?? []
                    Picker("官方区域", selection: draft.field("region")) {
                        Text("供应商默认区域").tag("")
                        ForEach(regions, id: \.self) { region in Text(region["label"].text).tag(region["id"].text) }
                    }
                }.disabled(model.settingsBusy)
                SettingsCard(title: "凭据") {
                    Text(providerKeySource(snapshot.configuration["providers"][id])).font(.caption).foregroundStyle(.secondary)
                    Picker("密钥操作", selection: $keyAction) {
                        Text(id.isEmpty ? "使用环境变量" : "保留现有").tag("keep")
                        Text("输入新密钥").tag("replace")
                        if !id.isEmpty { Text("清除文件密钥").tag("clear") }
                    }
                    if keyAction == "replace" {
                        SecureField("新 API 密钥", text: draft.field("apiKey")).textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("settings-provider-key")
                        Text(id.isEmpty ? "输入此连接使用的 API 密钥，或选择使用环境变量。" : "现有密钥不会回显；保存后以新密钥替换。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if keyAction == "clear" {
                        Text("保存后清除配置文件中的密钥，仍可回退环境变量。取消不会清除。")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("不改动配置文件中的密钥；没有文件密钥时可使用环境变量。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.disabled(model.settingsBusy)
                SettingsCard(title: "高级") {
                    DisclosureGroup("自定义服务地址", isExpanded: $advancedExpanded) {
                        VStack(alignment: .leading, spacing: 8) {
                            SettingText(title: "服务地址", value: draft.field("baseURL"), multiline: true)
                            Text("留空使用所选供应商与区域的官方地址。修改地址不会自动测试连接。")
                                .font(.caption).foregroundStyle(.secondary)
                        }.padding(.top, 8)
                    }
                }.disabled(model.settingsBusy)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 10) {
                if let validation { Label(validation, systemImage: "exclamationmark.circle").foregroundStyle(.red).font(.callout) }
                DraftFooter(model: model, draft: draft, key: key, boundary: "仅保存连接资料，不发起模型调用。", cancel: cancel, action: {
                    validation = nil
                    if id.isEmpty && snapshot.configuration["providers"].object[draft.value["provider"].text] != nil {
                        validation = "此连接 ID 已存在，请使用其他 ID，或取消后编辑已有连接。"; return nil
                    }
                    if keyAction == "replace" && draft.value["apiKey"].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        validation = id.isEmpty ? "请输入新密钥，或选择使用环境变量。" : "请输入新密钥，或切换到保留现有密钥。"; return nil
                    }
                    return draft.value
                })
            }
        }
        .onAppear {
            keyAction = draft.value.object["apiKey"] == nil ? (id.isEmpty ? "replace" : "keep") : draft.value["apiKey"].text.isEmpty ? "clear" : "replace"
            advancedExpanded = !draft.value["baseURL"].text.isEmpty
        }
        .onChange(of: keyAction) { _, value in
            if value == "keep" { draft.put("apiKey", .null) }
            else if value == "clear" { draft.put("apiKey", .string("")) }
            else if draft.value["apiKey"].text.isEmpty { draft.put("apiKey", .null) }
            validation = nil
        }
        .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { cancel() } }
    }
    private func cancel() { drafts.discard(key); close() }
}

struct ModelOverrideEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts, provider: String
    var close: () -> Void
    @State private var selected = ""
    @State private var inspected: String?
    var body: some View {
        if let inspected {
            let override = snapshot.configuration["providers"][provider]["modelOverrides"][inspected]
            let draft = drafts.draft("override-\(provider)-\(inspected)", override == .null ? .object([:]) : override, stamp: snapshot.stamp)
            OverrideForm(model: model, snapshot: snapshot, drafts: drafts, draft: draft, provider: provider, selected: inspected, close: close, reselect: { self.inspected = nil })
        } else {
            SettingsSheet(title: "型号规格与覆盖", subtitle: providerName(provider, in: snapshot) + " · " + provider, icon: "slider.horizontal.3") {
                VStack(alignment: .leading, spacing: 18) {
                    ModelIdentifierPicker(snapshot: snapshot, provider: provider, selection: $selected).disabled(model.settingsBusy)
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
                        Button("查看规格与覆盖") { inspected = selected }
                            .buttonStyle(.borderedProminent).disabled(selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.settingsBusy)
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
            ForEach([("chat", "对话能力"), ("image", "图片能力")], id: \.0) { key, label in
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
    @State private var clear = false
    @State private var changeModel = false
    private var key: String { "override-\(provider)-\(selected)" }
    var body: some View {
        SettingsSheet(title: "型号规格与覆盖", subtitle: providerName(provider, in: snapshot) + " · " + provider, icon: "slider.horizontal.3") {
            content
        } footer: {
            footer
        }
    }
    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            let cache = snapshot.catalog.first { $0["provider"].text == provider }?["cache"] ?? .null
            let raw = cache["snapshot"]["models"].array.first { $0["id"].text == selected } ?? .null
            Text(selected).font(.headline).textSelection(.enabled)
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
            }.disabled(model.settingsBusy)
            SettingsCard(title: "用户覆盖 · 思考能力") {
                Toggle("覆盖整组思考能力", isOn: Binding(get: { draft.value["reasoningSupport"] != .null }, set: {
                    draft.put("reasoningSupport", $0 ? .object([:]) : .null)
                }))
                Text("关闭时继承供应商思考能力。开启后整组替换，未填写的能力为未知；空组明确表示无已知可配置能力。思考投入由 Agent 或角色独立选择。")
                    .font(.caption).foregroundStyle(.secondary)
                if draft.value["reasoningSupport"] != .null {
                    triState("支持关闭思考", group: "reasoningSupport", key: "disable")
                    Toggle("指定支持的思考档位", isOn: Binding(get: { draft.value["reasoningSupport"]["levels"] != .null }, set: {
                        nested("reasoningSupport", "levels", $0 ? .array([]) : .null)
                    }))
                    if draft.value["reasoningSupport"]["levels"] != .null {
                        StringListEditor(title: "思考档位（空列表表示无档位）", values: Binding(get: { draft.value["reasoningSupport"]["levels"].array.map(\.text) }, set: { nested("reasoningSupport", "levels", .strings($0)) }))
                    }
                    SettingText(title: "思考预算最小值", value: nestedNumber("reasoningSupport.budget", "minTokens"))
                    SettingText(title: "思考预算最大值", value: nestedNumber("reasoningSupport.budget", "maxTokens"))
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
    }
    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button("选择其他型号") {
                    if draft.dirty { changeModel = true } else { drafts.discard(key); reselect() }
                }
                Spacer()
                if snapshot.configuration["providers"][provider]["modelOverrides"][selected] != .null {
                    Button("清除全部覆盖", role: .destructive) { clear = true }
                }
            }.disabled(model.settingsBusy)
            DraftFooter(model: model, draft: draft, key: key, boundary: "仅影响此连接与精确型号，不修改供应商原始缓存。", cancel: cancel, action: {
                .object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": draft.value])
            })
        }
        .confirmationDialog("清除此型号的全部用户覆盖？", isPresented: $clear) {
            Button("清除全部覆盖", role: .destructive) {
                model.applySettings(.object(["type": .string("model.override"), "provider": .string(provider), "model": .string(selected), "override": .null]), stamp: draft.stamp, key: key)
            }
        } message: { Text("之后使用供应商已有资料，未提供的规格保持未知。") }
        .confirmationDialog("放弃当前型号尚未保存的修改？", isPresented: $changeModel) {
            Button("放弃修改并选择其他型号", role: .destructive) { drafts.discard(key); reselect() }
        }
        .onChange(of: model.settingsSavedKey) { _, saved in if saved == key { cancel() } }
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
            if budget.isEmpty { support.removeValue(forKey: "budget") } else { support["budget"] = .object(budget) }
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
            Text(group == "reasoningSupport" ? "未知" : "不覆盖").tag("unknown")
            Text("支持").tag("yes")
            Text("不支持").tag("no")
        }
    }
}
