import SwiftUI
import ServiceManagement

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @State private var explainNotifications = false
    @State private var uninstall = false
    var body: some View {
        Form {
            Section("启动与通知") {
                Toggle("登录时打开 Magic Code", isOn: Binding(get: { model.loginStatus == .enabled }, set: { model.setLogin($0) }))
                    .disabled(!model.canChangeLogin)
                if model.loginStatus == .requiresApproval {
                    Button("在系统设置中允许登录启动") { SMAppService.openSystemSettingsLoginItems() }
                }
                Toggle("启用系统通知", isOn: Binding(get: { model.notificationsEnabled }, set: { value in
                    if value { explainNotifications = true } else { Task { await model.setNotifications(false) } }
                })).disabled(!model.canChangeNotifications)
                Text("只在需要你、失败或结果可查看时提醒。首次启动不会请求通知权限。").font(.caption).foregroundStyle(.secondary)
                NotificationPermissionStatus(notifications: model.notifications)
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
        .onAppear { model.refreshLogin(); Task { await model.notifications.refreshAuthorization() } }
        .alert("启用系统通知？", isPresented: $explainNotifications) {
            Button("取消", role: .cancel) {}
            Button("继续并申请权限") { Task { await model.setNotifications(true) } }
        } message: { Text("Magic Code 会提醒需要答复、失败和可查看的结果；通知不包含命令或正文。接下来由 macOS 确认权限。") }
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
struct NotificationPermissionStatus: View {
    @ObservedObject var notifications: NotificationCoordinator
    var body: some View { Text(notifications.authorization).font(.caption).foregroundStyle(.secondary) }
}
