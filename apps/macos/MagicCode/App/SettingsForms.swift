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
    func put(_ key: String, _ value: SettingsValue, preserveNull: Bool = false) { var next = self.value.object; if value == .null && !preserveNull { next.removeValue(forKey: key) } else { next[key] = value }; self.value = .object(next) }
}
@MainActor final class SettingsDrafts: ObservableObject {
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
enum MagicStyle {
    static let accent = adaptive(0x7656E8, 0xB49BFF)
    static let canvas = adaptive(0xF5F5F9, 0x17171E)
    static let surface = adaptive(0xFFFFFF, 0x202029)
    static let subtle = adaptive(0xF0F0F5, 0x292934)
    static let border = adaptive(0xE4E4EC, 0x353541)
    private static func adaptive(_ light: Int, _ dark: Int) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let value = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                           green: CGFloat((value >> 8) & 255) / 255, blue: CGFloat(value & 255) / 255, alpha: 1)
        })
    }
}

struct MagicIcon: View {
    let name: String
    var size: CGFloat = 36
    var body: some View {
        Image(systemName: name).font(.system(size: size * 0.44, weight: .medium))
            .foregroundStyle(MagicStyle.accent).frame(width: size, height: size)
            .background(MagicStyle.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: size * 0.28))
            .accessibilityHidden(true)
    }
}

struct MagicBrandIcon: View {
    var size: CGFloat = 36
    private final class ResourceBundle {}
    var body: some View {
        Image("BrandMark", bundle: Bundle(for: ResourceBundle.self)).resizable().renderingMode(.template)
            .scaledToFit().frame(width: size * 0.6375, height: size * 0.6375)
            .foregroundStyle(Color(red: 86 / 255, green: 182 / 255, blue: 194 / 255))
            .frame(width: size, height: size)
            .background(Color(red: 16 / 255, green: 22 / 255, blue: 29 / 255), in: RoundedRectangle(cornerRadius: size * 0.21875))
            .accessibilityHidden(true)
    }
}

struct MagicBadge: View {
    let text: String
    var color: Color = MagicStyle.accent
    var body: some View {
        Text(text).font(.system(size: 11, weight: .medium)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.10), in: Capsule()).fixedSize(horizontal: false, vertical: true)
    }
}

struct SettingsSheet<Content: View, Footer: View>: View {
    let title: String, subtitle: String, icon: String
    var preferredHeight: CGFloat = 640
    @ViewBuilder var content: Content
    @ViewBuilder var footer: Footer
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 14) {
                MagicIcon(name: icon, size: 44)
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.title2.weight(.semibold)).accessibilityAddTraits(.isHeader)
                    Text(subtitle).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(24)
            Divider().overlay(MagicStyle.border)
            ScrollView { VStack(alignment: .leading, spacing: 20) { content }.padding(24).frame(maxWidth: .infinity, alignment: .leading) }
                .defaultScrollAnchor(.top)
            footer.padding(.horizontal, 24).padding(.bottom, 20)
        }.frame(width: 580).frame(idealHeight: preferredHeight, maxHeight: 720)
            .background(MagicStyle.canvas).tint(MagicStyle.accent)
            .background(InitialContentFocus())
            .interactiveDismissDisabled()
    }
}

struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            content
        }.frame(maxWidth: .infinity, alignment: .leading).padding(20)
            .background(MagicStyle.surface, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(MagicStyle.border, lineWidth: 1))
    }
}
struct SettingText: View {
    let title: String
    @Binding var value: String
    var multiline = false
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.callout.weight(.medium))
            TextField(title, text: $value, axis: multiline ? .vertical : .horizontal)
                .textFieldStyle(.roundedBorder).controlSize(.large).accessibilityIdentifier("settings-field-\(title)")
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
    var canSave = true
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider().padding(.vertical, 4)
            if let error = model.settingsError {
                Label(error, systemImage: "exclamationmark.circle.fill").font(.callout).foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            Text(boundary).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if draft.stamp != model.settingsSnapshot?.stamp {
                Text("配置已在别处更新。可保留输入并采用当前版本，然后再次保存。").font(.caption).foregroundStyle(.orange)
                Button("保留输入，使用当前版本") { draft.stamp = model.settingsSnapshot?.stamp; draft.objectWillChange.send() }.disabled(model.settingsBusy)
            }
            HStack {
                Button("取消", action: cancel).disabled(model.settingsBusy).keyboardShortcut(.cancelAction)
                Spacer()
                if model.settingsBusy { ProgressView().controlSize(.small); Text("正在保存…").font(.caption).foregroundStyle(.secondary) }
                Button("保存") {
                    if let action { if let value = action() { model.applySettings(value, stamp: draft.stamp, key: key) } }
                    else { model.applySettings(draft.value, stamp: draft.stamp, key: key) }
                }.buttonStyle(.borderedProminent).disabled(model.settingsBusy || !canSave).accessibilityIdentifier("settings-save-\(key)")
            }.controlSize(.large)
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
    @State private var editingCLI = false
    @State private var cliDraft = ""
    private var cliStatus: String {
        let path = URL(fileURLWithPath: model.cliDirectory).appendingPathComponent("magic")
        if (try? CLIInstallation.belongs(path, helper: model.helperURL)) == true { return "magic 命令已连接本 App" }
        return FileManager.default.fileExists(atPath: path.path) ? "安装位置已被其他文件占用" : "此目录尚未安装 magic 命令"
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "日常使用") {
                HStack(alignment: .top, spacing: 14) {
                    MagicIcon(name: "power")
                    VStack(alignment: .leading, spacing: 5) {
                        Toggle("登录时打开 Magic Code", isOn: Binding(get: { model.loginStatus == .enabled }, set: { model.setLogin($0) })).disabled(!model.canChangeLogin)
                        Text("登录后保留菜单栏入口，随时查看正在进行的工作。").font(.caption).foregroundStyle(.secondary)
                        if model.loginStatus == .requiresApproval { Button("在系统设置中允许登录启动") { SMAppService.openSystemSettingsLoginItems() } }
                    }
                }
                Divider().padding(.vertical, 4)
                HStack(alignment: .top, spacing: 14) {
                    MagicIcon(name: "bell.badge")
                    VStack(alignment: .leading, spacing: 5) {
                        Toggle("提醒我", isOn: Binding(get: { model.notificationsEnabled }, set: { value in Task { await model.setNotifications(value) } })).disabled(!model.canChangeNotifications)
                        Text("需要答复、遇到问题或结果可查看时提醒。会话已在终端打开时不发系统提醒。").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        if model.notificationsEnabled { NotificationAuthorizationRow(notifications: model.notifications, openSettings: model.openNotificationSettings) }
                    }
                }
            }.id("notifications")
            SettingsCard(title: "终端命令") {
                HStack(alignment: .top, spacing: 14) {
                    MagicIcon(name: "terminal")
                    VStack(alignment: .leading, spacing: 6) {
                        Text("magic 命令").font(.headline)
                        Text(cliStatus).font(.callout).foregroundStyle(.secondary)
                        Text(model.cliDirectory).font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Button("管理命令…") { cliDraft = model.cliDirectory; editingCLI = true }
                }
            }.id("cli")
            if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled) }
        }.toggleStyle(.switch)
        .sheet(isPresented: $editingCLI) {
            SettingsSheet(title: "管理终端命令", subtitle: "安装后，在终端输入 magic 即可开始工作。", icon: "terminal") {
                SettingsCard(title: "安装位置") {
                    SettingText(title: "目录", value: $cliDraft, multiline: true).accessibilityIdentifier("cli-directory")
                    Text("将创建指向本 App 内置 CLI 的 magic 链接。已有其他文件不会被覆盖；移动 App 后可在这里重新安装。").font(.callout).foregroundStyle(.secondary)
                    Text(URL(fileURLWithPath: cliDraft).appendingPathComponent("magic").path).font(.system(.callout, design: .monospaced)).textSelection(.enabled)
                }
                SettingsCard(title: "让终端找到命令") {
                    Text("如果终端提示找不到 magic，将下面一行加入你的 shell 配置。").font(.callout).foregroundStyle(.secondary)
                    Text("export PATH=\(TerminalCommand.quote(cliDraft)):\"$PATH\"").font(.system(.callout, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                    Button("复制 PATH 配置") { model.copyText("export PATH=\(TerminalCommand.quote(cliDraft)):\"$PATH\"") }
                }
            } footer: {
                if let message = model.actionMessage { Label(message, systemImage: "info.circle").font(.callout).textSelection(.enabled) }
                Divider()
                HStack {
                    Button("关闭") { editingCLI = false }.keyboardShortcut(.cancelAction)
                    Spacer()
                    Button("安装 magic 命令") { model.installCLI(at: cliDraft) }
                        .buttonStyle(.borderedProminent).disabled(cliDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.controlSize(.large)
            }
        }
    }
}
