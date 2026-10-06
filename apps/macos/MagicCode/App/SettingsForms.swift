import SwiftUI
import ServiceManagement

@MainActor final class SettingsDraft: ObservableObject {
    @Published var value: SettingsValue
    private(set) var original: SettingsValue
    var stamp: String?
    init(_ value: SettingsValue, stamp: String?) { self.value = value; original = value; self.stamp = stamp }
    var dirty: Bool { value != original }
    func field(_ key: String) -> Binding<String> { Binding(get: { self.value[key].text }, set: { self.put(key, .string($0)) }) }
    func flag(_ key: String, default fallback: Bool = false) -> Binding<Bool> { Binding(get: { self.value[key] == .null ? fallback : self.value[key].flag }, set: { self.put(key, .bool($0)) }) }
    func strings(_ key: String) -> Binding<[String]> { Binding(get: { self.value[key].array.map(\.text) }, set: { self.put(key, .strings($0)) }) }
    func put(_ key: String, _ value: SettingsValue) { var next = self.value.object; if value == .null { next.removeValue(forKey: key) } else { next[key] = value }; self.value = .object(next) }
}
@MainActor final class SettingsDrafts: ObservableObject {
    @Published var providerEditor: String?
    @Published var overrideProvider: String?
    @Published var mcpEditor: String?
    @Published var roleEditor: String?
    private var values: [String: SettingsDraft] = [:]
    func draft(_ key: String, _ value: SettingsValue, stamp: String?) -> SettingsDraft {
        if let existing = values[key] {
            if !existing.dirty && existing.original != value { values[key] = SettingsDraft(value, stamp: stamp); return values[key]! }
            if !existing.dirty { existing.stamp = stamp }
            return existing
        }
        let draft = SettingsDraft(value, stamp: stamp); values[key] = draft; return draft
    }
    func discard(_ key: String) { values.removeValue(forKey: key); objectWillChange.send() }
}
struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }
}
struct SettingText: View {
    let title: String
    @Binding var value: String
    var multiline = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.callout.weight(.medium))
            TextField(title, text: $value, axis: multiline ? .vertical : .horizontal).textFieldStyle(.roundedBorder).accessibilityIdentifier("settings-field-\(title)")
        }
    }
}
struct StringListEditor: View {
    let title: String
    @Binding var values: [String]
    var ordered = false
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.callout.weight(.medium))
            ForEach(values.indices, id: \.self) { index in
                HStack(alignment: .top) {
                    TextField(title, text: Binding(get: { index < values.count ? values[index] : "" }, set: { if index < values.count { values[index] = $0 } }), axis: .vertical).textFieldStyle(.roundedBorder)
                    if ordered {
                        Button { values.swapAt(index, index - 1) } label: { Image(systemName: "arrow.up") }.disabled(index == 0).accessibilityLabel("上移")
                        Button { values.swapAt(index, index + 1) } label: { Image(systemName: "arrow.down") }.disabled(index + 1 == values.count).accessibilityLabel("下移")
                    }
                    Button { values.remove(at: index) } label: { Image(systemName: "minus.circle") }.accessibilityLabel("移除第 \(index + 1) 项")
                }
            }
            Button("添加一项", systemImage: "plus") { values.append("") }
        }
    }
}
struct DraftFooter: View {
    @ObservedObject var model: AppModel
    @ObservedObject var draft: SettingsDraft
    let key: String, boundary: String
    var cancel: () -> Void
    var action: (() -> SettingsValue?)?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(boundary).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button("保存") {
                    if let action { if let value = action() { model.applySettings(value, stamp: draft.stamp, key: key) } }
                    else { model.applySettings(draft.value, stamp: draft.stamp, key: key) }
                }.buttonStyle(.borderedProminent).disabled(!model.isCurrent || model.settingsBusy).accessibilityIdentifier("settings-save-\(key)")
                Button("取消", action: cancel).disabled(model.settingsBusy)
                if draft.stamp != model.settingsSnapshot?.stamp {
                    Button("采用新配置基线，保留输入") { draft.stamp = model.settingsSnapshot?.stamp; draft.objectWillChange.send() }.disabled(model.settingsBusy)
                }
                if model.settingsBusy { ProgressView().controlSize(.small) }
            }
        }
    }
}
func settingsDirectory(_ action: @escaping (URL) -> Void) {
    let panel = NSOpenPanel(); panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true; panel.allowsMultipleSelection = false
    panel.begin { result in if result == .OK, let url = panel.url { action(url) } }
}
func revealSettingPath(_ path: String) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }
struct SettingsPath: View {
    let label: String, path: String
    var copy: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.callout.weight(.medium))
            FullPath(label: label, path: path, copy: copy)
        }
    }
}

struct AppSettingsPage: View {
    @ObservedObject var model: AppModel
    private var cliStatus: String {
        let path = URL(fileURLWithPath: model.cliDirectory).appendingPathComponent("magic")
        if (try? CLIInstallation.belongs(path, helper: model.helperURL)) == true { return "magic 命令已连接本 App" }
        return FileManager.default.fileExists(atPath: path.path) ? "安装位置已被其他文件占用" : "此目录尚未安装 magic 命令"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "启动与提醒") {
                Toggle("登录时打开 Magic Code", isOn: Binding(get: { model.loginStatus == .enabled }, set: { model.setLogin($0) })).disabled(!model.canChangeLogin)
                if model.loginStatus == .requiresApproval { Button("在系统设置中允许登录启动") { SMAppService.openSystemSettingsLoginItems() } }
                Toggle("提醒我", isOn: Binding(get: { model.notificationsEnabled }, set: { value in Task { await model.setNotifications(value) } })).disabled(!model.canChangeNotifications)
                Text("只在需要你、失败或结果可查看时提醒；你在看的时候不打扰。").font(.caption).foregroundStyle(.secondary)
                if model.notificationsEnabled { NotificationAuthorizationRow(notifications: model.notifications, openSettings: model.openNotificationSettings) }
            }.id("notifications")
            SettingsCard(title: "终端命令与新草稿项目") {
                SettingText(title: "命令安装目录", value: $model.cliDirectory, multiline: true).accessibilityIdentifier("cli-directory")
                Text(cliStatus).font(.caption).foregroundStyle(.secondary)
                HStack { Button("复制完整路径") { model.terminal.copy(model.cliDirectory) }.accessibilityIdentifier("copy-cli-directory"); Button("安装 magic 命令") { model.installCLI() } }
                Text("安装为指向本 App 内置 CLI 的符号链接；移动 App 后需重新安装。已有文件不会被覆盖。").font(.caption).foregroundStyle(.secondary)
                Text("若 PATH 中没有此目录，添加：").font(.caption)
                Text("export PATH=\(TerminalCommand.quote(model.cliDirectory)):\"$PATH\"").font(.system(.caption, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                SettingsPath(label: "新草稿项目", path: model.projectDirectory?.path ?? model.userHome.path) { model.terminal.copy(model.projectDirectory?.path ?? model.userHome.path) }
                Button("选择新草稿项目…") { settingsDirectory { model.projectDirectory = $0 } }
            }.id("cli")
            if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled) }
        }.toggleStyle(.switch)
    }
}
