import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var uninstall = false
    var body: some View {
        Form {
            Section("启动与通知") {
                Toggle("登录时打开 Magic Code", isOn: Binding(get: { model.loginStatus == .enabled }, set: { model.setLogin($0) }))
                    .disabled(!model.canChangeLogin)
                if model.loginStatus == .requiresApproval {
                    Button("在系统设置中允许登录启动") { SMAppService.openSystemSettingsLoginItems() }
                }
                // 两格、两件事，各说各的：
                // ① 「提醒我」＝**我们的偏好**：一个开关，默认开。关掉它＝让 Magic 闭嘴，系统那边不用动。
                Toggle("提醒我", isOn: Binding(get: { model.notificationsEnabled }, set: { value in
                    Task { await model.setNotifications(value) }
                })).disabled(!model.canChangeNotifications)
                Text("只在需要你、失败或结果可查看时提醒；你在看的时候不打扰。").font(.caption).foregroundStyle(.secondary)
                // ② 系统那一格**不进常驻**：授权「已允许」是没有新增信息的一格；只在受阻时出现并带路。
                //    偏好关着就不发，也就不会受阻 ⇒ 那一行不出现。
                if model.notificationsEnabled { NotificationAuthorizationRow(notifications: model.notifications, openSettings: { model.openNotificationSettings() }) }
            }
            Section("数据目录") {
                LabeledContent("基础路径") { path(model.selectedBase?.path ?? model.userHome.path, label: "基础路径") }
                Text("基础路径下使用 .magic；请勿把 .magic 本身再选作基础路径。").font(.caption).foregroundStyle(.secondary)
                LabeledContent("配置") { path(model.configPath.isEmpty ? "等待核心就绪" : model.configPath, label: "配置路径") }
                LabeledContent("数据") { path(model.identity?.dataDir ?? "等待核心就绪", label: "数据路径") }
                HStack {
                    Button("选择基础目录…") { chooseDirectory { model.changeBase($0) } }.disabled(!model.isCurrent || !model.affected.isEmpty)
                    Button("恢复默认位置") { model.changeBase(nil) }.disabled(!model.isCurrent || !model.affected.isEmpty)
                }
            }
            Section("终端") {
                TextField("命令安装目录", text: $model.cliDirectory, axis: .vertical)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cli-directory")
                Button("复制命令安装完整路径") { model.terminal.copy(model.cliDirectory) }.accessibilityIdentifier("copy-cli-directory")
                Button("安装 magic 命令") { model.installCLI() }
                Text("安装为指向本 App 内置 CLI 的符号链接；移动 App 后需重新安装。已有文件不会被覆盖。").font(.caption).foregroundStyle(.secondary)
                Text("若终端 PATH 中没有此目录，添加：").font(.caption)
                Text("export PATH=\(TerminalCommand.quote(model.cliDirectory)):\"$PATH\"").font(.system(.caption, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                HStack {
                    LabeledContent("新草稿项目") { path(model.projectDirectory?.path ?? model.userHome.path, label: "新草稿项目") }
                    Button("选择…") { chooseDirectory { model.projectDirectory = $0 } }
                }
            }
            Section("版本与诊断") {
                // **只显示版号**（U109）：不再在后面拼那两个字——用户 2026-09-30 定：代码里不留这种标记。
                LabeledContent("版本", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0")
                Text(model.phase.text).foregroundStyle(.secondary)
                DisclosureGroup("查看诊断") {
                    Text(model.diagnosticsText.isEmpty ? "当前无诊断" : model.diagnosticsText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                }
                Button("移除系统集成并退出…", role: .destructive) { uninstall = true }.accessibilityIdentifier("remove-integration")
                Text("撤销登录项并移除属于本 App 的终端链接；记录和配置保留。随后可在 Finder 删除 App。").font(.caption).foregroundStyle(.secondary)
            }
            if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled) }
        }.formStyle(.grouped).frame(width: 580, height: 680)
        .onAppear { model.refreshLogin(); Task { await model.refreshNotifications() } }
        .confirmationDialog("移除系统集成并退出？", isPresented: $uninstall, titleVisibility: .visible) {
            Button("移除并退出", role: .destructive) { model.uninstallIntegration() }
            Button("取消", role: .cancel) {}
        }
    }
    private func path(_ value: String, label: String) -> some View {
        FullPath(label: label, path: value) { model.terminal.copy(value) }
    }
    private func chooseDirectory(_ action: @escaping (URL) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.begin { result in if result == .OK, let url = panel.url { action(url) } }
    }
}
/// ① 「系统里允许通知」这一格：**只反映系统持有的状态**（只读；被拒时给一条去系统设置的路）。
/// 它不承担请求、也不存任何东西——请求由「提醒我」那一下发起；系统拒绝时那一格照旧是关不住的意图。
struct NotificationAuthorizationRow: View {
    // 状态挂在嵌套的协调器上：只观察上层对象不会跟着重绘，回来那一行就不会自己变。
    @ObservedObject var notifications: NotificationCoordinator
    var openSettings: () -> Void
    var body: some View {
        // 只有受阻两种状态才出现（「已允许」与「未问过」都不占地方）。
        switch notifications.authorizationStatus {
        case .denied:
            LabeledContent("系统里还没允许通知") {
                Button("去系统设置允许", action: openSettings).accessibilityIdentifier("open-notification-settings")
            }
        case .provisional:
            LabeledContent("只进通知中心，不弹横幅") {
                Button("改提醒样式", action: openSettings).accessibilityIdentifier("open-notification-settings")
            }
        default:
            EmptyView()
        }
    }
}
