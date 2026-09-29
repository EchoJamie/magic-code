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
                // 权限是**系统的状态**，不是 App 的配置：这里只有「状态 ＋ 动作」，没有开关。
                NotificationAuthorizationRow(model: model, notifications: model.notifications)
                Text("只在需要你、失败或结果可查看时提醒。首次启动不会请求通知权限。").font(.caption).foregroundStyle(.secondary)
            }
            Section("数据目录") {
                LabeledContent("基础路径") { path(model.selectedBase?.path ?? model.userHome.path, label: "基础路径") }
                Text("基础路径下使用 .magic；请勿把 .magic 本身再选作基础路径。").font(.caption).foregroundStyle(.secondary)
                LabeledContent("配置") { path(model.configPath.isEmpty ? "等待核心就绪" : model.configPath, label: "配置路径") }
                LabeledContent("数据") { path(model.identity?.dataDir ?? "等待核心就绪", label: "数据路径") }
                HStack {
                    Button("选择基础目录…") { chooseDirectory { model.changeBase($0) } }.disabled(!model.isCurrent || !model.affected.isEmpty)
                    Button("恢复默认位置") { model.changeBase(nil) }.disabled(!model.isCurrent || !model.affected.isEmpty || model.isDevelopment)
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
                LabeledContent("版本", value: "\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0") · \(model.isDevelopment ? "开发版" : "正式版")")
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
/// 通知那一栏：只反映**系统**持有的状态，并按状态给对应动作；没有本地开关，也没有二次确认。
/// 用户在系统设置里改了，界面回到前台／重新出现时自己就变，不需要他回来再点一次。
struct NotificationAuthorizationRow: View {
    @ObservedObject var model: AppModel
    // 状态挂在嵌套的协调器上：只观察 model 不会跟着重绘，回来那一行就不会自己变。
    @ObservedObject var notifications: NotificationCoordinator
    var body: some View {
        LabeledContent("系统通知") {
            switch notifications.authorizationStatus {
            case .notDetermined:
                Button("打开通知") { Task { await model.requestNotifications() } }
                    .disabled(!model.canChangeNotifications)
                    .accessibilityIdentifier("open-notifications")
            case .denied:
                HStack(spacing: 12) {
                    Text("系统里还没允许").foregroundStyle(.secondary)
                    Button("去系统设置允许") { model.openNotificationSettings() }
                        .accessibilityIdentifier("open-notification-settings")
                }
            case .authorized:
                Text("已允许").foregroundStyle(.secondary)
            case .provisional:
                Text("只静默送达：通知只进通知中心，不弹横幅").foregroundStyle(.secondary)
            default:
                Text("系统临时允许（仅本次会话）").foregroundStyle(.secondary)
            }
        }
    }
}
