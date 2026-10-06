import SwiftUI

struct AdvancedSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var uninstall = false
    @State private var revoke: SettingsValue?
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "当前实例与路径") {
                SettingsPath(label: "基础路径", path: model.selectedBase?.path ?? model.userHome.path) { model.terminal.copy(model.selectedBase?.path ?? model.userHome.path) }
                SettingsPath(label: "配置文件", path: snapshot.configPath) { model.terminal.copy(snapshot.configPath) }
                SettingsPath(label: "当前运行数据", path: model.identity?.dataDir ?? snapshot.dataDir) { model.terminal.copy(model.identity?.dataDir ?? snapshot.dataDir) }
                Text("服务实例：\(model.identity?.serviceInstance ?? "等待就绪")").font(.caption).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Button("定位配置文件") { revealSettingPath(snapshot.configPath) }
                Text("基础路径下使用 .magic；不要把 .magic 本身再选作基础路径。切换不搬迁数据。").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("选择基础目录…") { settingsDirectory { model.changeBase($0) } }
                    Button("恢复默认位置") { model.changeBase(nil) }
                }.disabled(!model.isCurrent || !snapshot.canChangeData || !model.affected.isEmpty)
                if let current = model.identity?.dataDir, URL(fileURLWithPath: current).resolvingSymlinksInPath() != URL(fileURLWithPath: snapshot.dataDir).resolvingSymlinksInPath() {
                    Button("重新打开此实例，采用已保存的数据位置") { model.changeBase(model.selectedBase) }
                        .disabled(!model.isCurrent || !snapshot.canChangeData || !model.affected.isEmpty)
                }
                if !snapshot.canChangeData { Text("此实例仍有执行责任，不能切换数据位置。").foregroundStyle(.secondary).font(.caption) }
                DataDirectoryEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("data-directory", .object(["directory": snapshot.configuration["dataDir"]]), stamp: snapshot.stamp))
            }.id("data")
            SettingsCard(title: "工作区根") {
                RootEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("roots", .object(["roots": snapshot.configuration["workspaceRoots"]]), stamp: snapshot.stamp))
            }.id("roots")
            SettingsCard(title: "配置权限规则") {
                PermissionEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("permissions", snapshot.configuration["permissions"]["rules"] == .null ? .array([]) : snapshot.configuration["permissions"]["rules"], stamp: snapshot.stamp))
            }.id("permissions")
            SettingsCard(title: "已有授权") {
                Text("这里管理已记住的授权；当前待答审批仍在所属工作处理。配置权限规则与授权分别管理。").font(.caption).foregroundStyle(.secondary)
                if let problem = snapshot.grantProblem { Text(problem).foregroundStyle(.red) }
                if snapshot.grants.isEmpty { Text("尚无已保存的授权。").foregroundStyle(.secondary) }
                ForEach(snapshot.grants, id: \.self) { section in
                    SettingsPath(label: "工作区", path: section["workspace"].text) { model.terminal.copy(section["workspace"].text) }
                    ForEach(section["entries"].array.indices, id: \.self) { index in
                        let grant = section["entries"].array[index]
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(grant["tool"].text) · \(grant["path"].text.isEmpty ? "根内" : grant["path"].text)").textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                if !grant["host"].text.isEmpty { Text("域名：\(grant["host"].text)").font(.caption) }
                                Text("操作：\(grant["op"].text.isEmpty ? grant["op"].array.map(\.text).joined(separator: " / ") : grant["op"].text)").font(.caption)
                            }; Spacer()
                            Button("撤销", role: .destructive) { revoke = .object(["type": .string("grants.revoke"), "workspace": section["workspace"], "index": .number(Double(index)), "grantStamp": snapshot.grantStamp.map(SettingsValue.string) ?? .null]) }.disabled(model.settingsBusy)
                        }
                    }
                    Button("撤销此工作区全部授权", role: .destructive) { revoke = .object(["type": .string("grants.revoke"), "workspace": section["workspace"], "grantStamp": snapshot.grantStamp.map(SettingsValue.string) ?? .null]) }.disabled(model.settingsBusy)
                    Divider()
                }
            }
            SettingsCard(title: "诊断与系统集成") {
                Text(model.phase.text).foregroundStyle(.secondary)
                Toggle("调试模式", isOn: Binding(get: { model.diagnostics.debugMode }, set: {
                    model.applySettings(.object(["type": .string("diagnostics.set"), "debugMode": .bool($0)]), stamp: snapshot.stamp, key: "diagnostics")
                })).disabled(model.settingsBusy).accessibilityIdentifier("debug-mode")
                Text("开启后显示独立工作窗口，便于自动化操作与问题排查。关闭窗口不关闭调试模式。").font(.caption).foregroundStyle(.secondary)
                Picker("日志等级", selection: Binding(get: { model.diagnostics.logLevel.rawValue }, set: {
                    model.applySettings(.object(["type": .string("diagnostics.set"), "logLevel": .string($0)]), stamp: snapshot.stamp, key: "diagnostics")
                })) { ForEach(LogLevel.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) } }
                    .disabled(model.settingsBusy).accessibilityIdentifier("log-level")
                Text("日志等级独立生效，保存后立即应用于运行进程。").font(.caption).foregroundStyle(.secondary)
                SettingsPath(label: "日志目录", path: model.logDirectory) { model.terminal.copy(model.logDirectory) }
                HStack {
                    Button("在 Finder 中打开日志目录") { NSWorkspace.shared.open(URL(fileURLWithPath: model.logDirectory)) }.disabled(model.logDirectory.isEmpty)
                    if model.diagnostics.debugMode { Button("打开调试窗口") { model.showDebugWindow?() } }
                }
                Text(model.logProblem ?? "App 日志写入正常").foregroundStyle(model.logProblem == nil ? Color.secondary : .red)
                if !snapshot.configuration["diagnosticsNote"].text.isEmpty { Text(snapshot.configuration["diagnosticsNote"].text).font(.caption).foregroundStyle(.secondary) }
                Button("移除系统集成并退出…", role: .destructive) { uninstall = true }.accessibilityIdentifier("remove-integration")
                Text("撤销登录项并移除属于本 App 的终端链接；记录和配置保留。随后可在 Finder 删除 App。").font(.caption).foregroundStyle(.secondary)
                if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled) }
            }.id("diagnostics")
        }
        .confirmationDialog("移除系统集成并退出？", isPresented: $uninstall, titleVisibility: .visible) {
            Button("移除并退出", role: .destructive) { model.uninstallIntegration() }; Button("取消", role: .cancel) {}
        }
        .confirmationDialog("撤销已有授权？后续执行继续按权限规则与审批处理。", isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button("撤销", role: .destructive) { if let action = revoke { model.applySettings(action, stamp: snapshot.stamp, key: "revoke-grant") }; revoke = nil }
            Button("取消", role: .cancel) { revoke = nil }
        }
    }
}
struct DataDirectoryEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            SettingText(title: "自定义数据目录（留空使用基础目录）", value: draft.field("directory"), multiline: true)
            DraftFooter(model: model, draft: draft, key: "data-directory", boundary: "无执行责任才能保存。下次打开实例时采用，原数据保留，不搬迁记录。", cancel: { drafts.discard("data-directory") }, action: { .object(["type": .string("data.set"), "directory": draft.value["directory"].text.isEmpty ? .null : draft.value["directory"]]) })
        }.disabled(!snapshot.canChangeData)
    }
}
struct RootEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("显式指定工作区根", isOn: Binding(get: { draft.value["roots"] != .null }, set: { draft.put("roots", $0 ? .array([]) : .null) }))
            if draft.value["roots"] != .null { StringListEditor(title: "根目录（第一项是默认根）", values: draft.strings("roots"), ordered: true) }
            DraftFooter(model: model, draft: draft, key: "roots", boundary: "缺省采用启动目录；显式列表须有有效目录。下次装配采用，不改变在途工作目录。", cancel: { drafts.discard("roots") }, action: { .object(["type": .string("workspace.set"), "roots": draft.value["roots"]]) })
        }
    }
}
struct PermissionEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("规则是工具、路径、操作与域名的允许范围。必要的禁区保护仍优先；材料来源不代表执行许可。").font(.caption).foregroundStyle(.secondary)
            ForEach(draft.value.array.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 9) {
                    Text("规则 \(index + 1)").font(.subheadline.weight(.medium))
                    SettingText(title: "工具名（* 表示任意工具）", value: field(index, "tool"))
                    SettingText(title: "路径模式（留空为根内）", value: field(index, "path"), multiline: true)
                    SettingText(title: "域名模式（网络调用按域名匹配）", value: field(index, "host"))
                    StringListEditor(title: "操作（空白表示任意；read/create/edit/overwrite/delete/move/system/outbound/unknown）", values: Binding(get: { let op = draft.value.array[index]["op"]; return op == .null ? [] : op.text.isEmpty ? op.array.map(\.text) : [op.text] }, set: { values in var rows = draft.value.array; var row = rows[index].object; if values.isEmpty { row.removeValue(forKey: "op") } else { row["op"] = .strings(values) }; rows[index] = .object(row); draft.value = .array(rows) }))
                    Button("删除规则", role: .destructive) { var values = draft.value.array; values.remove(at: index); draft.value = .array(values) }
                }.padding(12).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            }
            Button("添加规则", systemImage: "plus") { draft.value = .array(draft.value.array + [.object(["tool": .string("")])]) }
            DraftFooter(model: model, draft: draft, key: "permissions", boundary: "下次装配时采用；当前待答审批不在设置中回答。", cancel: { drafts.discard("permissions") }, action: { .object(["type": .string("permissions.set"), "rules": draft.value]) })
        }
    }
    private func field(_ index: Int, _ key: String) -> Binding<String> {
        Binding(get: { draft.value.array[index][key].text }, set: { value in var rows = draft.value.array; var row = rows[index].object; if value.isEmpty { row.removeValue(forKey: key) } else { row[key] = .string(value) }; rows[index] = .object(row); draft.value = .array(rows) })
    }
}
