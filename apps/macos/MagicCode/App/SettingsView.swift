import SwiftUI
import ServiceManagement

struct SettingsCategory: Identifiable {
    let id: String, title: String, icon: String, explanation: String
    static let all: [Self] = [
        .init(id: "models", title: "模型与连接", icon: "cpu", explanation: "接入供应商，设置 Default 和三个能力档位。"),
        .init(id: "tools", title: "工具接入", icon: "puzzlepiece.extension", explanation: "管理 MCP 服务器；配置和工作中的连接状态分别查看。"),
        .init(id: "materials", title: "规则与技能", icon: "doc.text", explanation: "管理补充来源，正文仍保留在原文件。"),
        .init(id: "roles", title: "角色默认", icon: "person.2", explanation: "为后续创建的成员准备职责、材料与独立模型设置。"),
        .init(id: "terminal", title: "终端呈现", icon: "terminal", explanation: "选择状态行字段、顺序、颜色与动效。"),
        .init(id: "app", title: "应用", icon: "app.badge", explanation: "登录启动、提醒、命令安装与新草稿项目。"),
        .init(id: "advanced", title: "数据与高级", icon: "externaldrive", explanation: "查看实例与路径，管理工作区、权限及系统集成。")
    ]
}
struct SettingsSearchItem: Identifiable {
    let id: String, category: String, title: String, words: String
    static let all: [Self] = [
        .init(id: "configuredModels", category: "models", title: "Default 与能力档位", words: "默认模型 Cantrip Spell Arcane 型号 映射"),
        .init(id: "providers", category: "models", title: "供应商连接与模型规格", words: "密钥 API key DeepSeek MiniMax 地址 缓存 刷新 容量 思考 覆盖"),
        .init(id: "servers", category: "tools", title: "MCP 服务器", words: "工具 stdio HTTP 命令 参数 环境变量 请求头 连接 重连"),
        .init(id: "rules.sources", category: "materials", title: "主动加载的补充规约", words: "规则 文件 AGENTS CLAUDE sources"),
        .init(id: "rules.linkSources", category: "materials", title: "规约链接的允许来源", words: "符号链接 linkSources"),
        .init(id: "skills.sources", category: "materials", title: "补充技能目录", words: "skill sources 技能 目录"),
        .init(id: "roles", category: "roles", title: "成员角色默认", words: "职责 指导 文件 技能 工具 模型 思考 角色"),
        .init(id: "status", category: "terminal", title: "状态行与动效", words: "会话名 模型 思考 上下文 工作区 颜色 顺序 减少动效"),
        .init(id: "notifications", category: "app", title: "启动与提醒", words: "登录 通知 系统设置"),
        .init(id: "cli", category: "app", title: "终端命令与新草稿项目", words: "安装 CLI magic PATH 项目 路径"),
        .init(id: "data", category: "advanced", title: "实例与数据位置", words: "配置文件 基础路径 目录 位置"),
        .init(id: "roots", category: "advanced", title: "工作区根", words: "workspaceRoots 根目录"),
        .init(id: "permissions", category: "advanced", title: "权限规则与已有授权", words: "permissions rules grants 查看 撤销 授权"),
        .init(id: "diagnostics", category: "advanced", title: "诊断与系统集成", words: "版本 调试 debug 日志 log trace info warn error 移除 卸载")
    ]
}
struct SettingsView: View {
    static let defaultSize = CGSize(width: 1000, height: 860)
    @ObservedObject var model: AppModel
    @StateObject private var drafts = SettingsDrafts()
    @State private var search = ""
    @State private var returnSearch = ""
    @State private var anchor: String?
    @State private var initialized = false
    @FocusState private var searchFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    private var category: SettingsCategory { SettingsCategory.all.first { $0.id == model.settingsCategory } ?? SettingsCategory.all[0] }
    var body: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                Text("设置").font(.title3.weight(.semibold)).padding(20)
                ScrollView {
                    VStack(spacing: 4) {
                        ForEach(SettingsCategory.all) { item in
                            Button { model.rememberSettingsCategory(item.id); search = ""; returnSearch = ""; anchor = nil } label: {
                                Label(item.title, systemImage: item.icon).font(.body)
                                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 9)
                                    .background(item.id == category.id && search.isEmpty ? Color.accentColor.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 7))
                                    .foregroundStyle(item.id == category.id && search.isEmpty ? Color.accentColor : Color.primary)
                            }.buttonStyle(.plain).accessibilityIdentifier("settings-category-\(item.id)")
                        }
                    }.padding(.horizontal, 12)
                }
                Spacer(minLength: 12)
                Text("v\(model.appVersion)")
                    .font(.caption).foregroundStyle(.secondary).padding(20).accessibilityIdentifier("settings-version")
            }.frame(width: 194).background(Color(nsColor: .windowBackgroundColor))
            Divider()
            VStack(spacing: 0) {
                HStack {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索设置", text: $search).textFieldStyle(.plain).focused($searchFocused).accessibilityIdentifier("settings-search")
                    Button("搜索设置") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden().frame(width: 0, height: 0)
                    if !search.isEmpty { Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }.buttonStyle(.plain).accessibilityLabel("清除搜索") }
                    Button { model.readSettings() } label: { Image(systemName: "arrow.clockwise") }
                        .disabled(model.settingsBusy).help("重新读取当前配置；保留未提交草稿")
                    if model.settingsBusy { ProgressView().controlSize(.small) }
                }.padding(16).background(Color(nsColor: .controlBackgroundColor))
                Text(model.configurationStatus).font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.bottom, 8)
                Divider()
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 20) {
                            if !search.isEmpty { results }
                            else {
                                if !returnSearch.isEmpty { Button("返回搜索：\(returnSearch)") { search = returnSearch; returnSearch = "" } }
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(category.title).font(.title2.weight(.semibold))
                                    Text(category.explanation).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                                }
                                if let error = model.settingsError { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red).textSelection(.enabled).fixedSize(horizontal: false, vertical: true).id("settings-feedback") }
                                if let note = model.settingsNote { Label(note, systemImage: "checkmark.circle").foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                                if category.id == "app" { AppSettingsPage(model: model) }
                                else if let snapshot = model.settingsSnapshot {
                                    switch category.id {
                                    case "models": ModelSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    case "tools": McpSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    case "materials": MaterialSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    case "roles": RoleSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    case "terminal": TerminalSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    default: AdvancedSettingsPage(model: model, snapshot: snapshot, drafts: drafts)
                                    }
                                } else {
                                    Text(model.isCurrent ? "正在读取配置…" : "服务尚未就绪。就绪后可读取与编辑配置。")
                                    Button("重新读取") { model.readSettings() }.disabled(model.settingsBusy)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
                    }.background(Color(nsColor: .controlBackgroundColor))
                    .onChange(of: anchor) { _, value in if let value { withAnimation { proxy.scrollTo(value, anchor: .top) } } }
                    .onChange(of: model.settingsError) { _, value in if value != nil { proxy.scrollTo("settings-feedback", anchor: .top) } }
                }
            }
        }.background(Color(nsColor: .windowBackgroundColor)).tint(.blue)
            .frame(minWidth: 650, idealWidth: Self.defaultSize.width, minHeight: 600, idealHeight: Self.defaultSize.height)
        .onAppear { model.refreshLogin(); Task { await model.refreshNotifications() }; model.readSettings() }
        .onChange(of: model.isCurrent) { _, current in if current { model.readSettings() } }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.readSettings() }
        .onChange(of: scenePhase) { _, value in if value == .active { model.readSettings() } }
        .onChange(of: model.settingsSnapshot) { _, value in
            if !initialized, let value { if value.configuration["models"]["default"] == .null { model.rememberSettingsCategory("models") }; initialized = true }
        }
        .onChange(of: model.settingsSavedKey) { _, key in if let key { drafts.discard(key) } }
    }
    private var results: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("搜索结果").font(.title2.weight(.semibold))
            let term = search.trimmingCharacters(in: .whitespacesAndNewlines)
            let found = SettingsSearchItem.all.filter { item in
                let values = safeSearchValue(item)
                return term.split(whereSeparator: \.isWhitespace).allSatisfy { "\(item.title) \(item.words) \(values)".localizedCaseInsensitiveContains(String($0)) }
            }
            if found.isEmpty { Text("没有找到相关设置。可修改关键词或清除搜索。").foregroundStyle(.secondary) }
            ForEach(found) { item in
                Button {
                    returnSearch = search; search = ""; model.rememberSettingsCategory(item.category)
                    anchor = nil; DispatchQueue.main.async { anchor = item.id }
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.title).font(.headline)
                        Text(SettingsCategory.all.first { $0.id == item.category }?.title ?? "").font(.caption).foregroundStyle(.secondary)
                        Text(safeSearchValue(item)).font(.callout).foregroundStyle(.secondary).lineLimit(3)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(14)
                }.buttonStyle(.bordered)
            }
        }
    }
    private func safeSearchValue(_ item: SettingsSearchItem) -> String {
        guard let config = model.settingsSnapshot?.configuration else { return "尚未读取配置" }
        switch item.id {
        case "configuredModels": return ["default", "cantrip", "spell", "arcane"].map { "\($0.capitalized)：\(config["models"][$0]["model"].text.isEmpty ? "未配置" : config["models"][$0]["model"].text)" }.joined(separator: " · ")
        case "providers": return config["providers"].object.keys.sorted().map { config["providers"][$0]["name"].text.isEmpty ? $0 : config["providers"][$0]["name"].text }.joined(separator: " · ")
        case "servers": return config["mcp"]["servers"].object.keys.sorted().joined(separator: " · ")
        case "roles": return config["agentRoles"].object.keys.sorted().joined(separator: " · ")
        case "rules.sources", "rules.linkSources", "skills.sources": return model.settingsSnapshot?.sources.filter { $0["source"].text == item.id }.map { $0["path"].text }.joined(separator: " · ") ?? ""
        case "data": return model.settingsSnapshot?.configPath ?? ""
        default: return "查看当前值并编辑"
        }
    }
}

struct NotificationAuthorizationRow: View {
    @ObservedObject var notifications: NotificationCoordinator
    var openSettings: () -> Void
    var body: some View {
        switch notifications.authorizationStatus {
        case .denied: LabeledContent("系统里还没允许通知") { Button("去系统设置允许", action: openSettings).accessibilityIdentifier("open-notification-settings") }
        case .provisional: LabeledContent("只进通知中心，不弹横幅") { Button("改提醒样式", action: openSettings).accessibilityIdentifier("open-notification-settings") }
        default: EmptyView()
        }
    }
}
