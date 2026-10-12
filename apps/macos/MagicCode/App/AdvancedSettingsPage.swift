import SwiftUI

struct AdvancedSettingsPage: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    @ObservedObject var drafts: SettingsDrafts
    @State private var editing: Section?
    private enum Section: String, Identifiable {
        case data, roots, permissions, grants, diagnostics, integration
        var id: String { rawValue }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            SettingsCard(title: "数据位置") {
                HStack(alignment: .top, spacing: 12) {
                    MagicIcon(name: "externaldrive")
                    SettingsPath(label: "当前基础目录", path: model.effectiveBase.path) { model.terminal.copy(model.effectiveBase.path) }
                    Spacer()
                    Button("管理位置") { editing = .data }
                }
                Text("配置与数据使用此目录下的 .magic；切换位置不会搬迁数据。").font(.caption).foregroundStyle(.secondary)
            }.id("data")
            SettingsCard(title: "执行范围与权限") {
                HStack(spacing: 12) {
                    MagicIcon(name: "folder")
                    VStack(alignment: .leading, spacing: 5) {
                        Text("工作区根").font(.headline)
                        Text(snapshot.configuration["workspaceRoots"] == .null ? "采用启动目录" : "\(snapshot.configuration["workspaceRoots"].array.count) 个根目录 · 第一项为默认根").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Button("编辑") { editing = .roots }
                }.id("roots")
                Divider()
                HStack(spacing: 12) {
                    MagicIcon(name: "lock.shield")
                    VStack(alignment: .leading, spacing: 5) {
                        Text("配置权限规则").font(.headline)
                        Text("\(snapshot.configuration["permissions"]["rules"].array.count) 条规则 · 后续装配采用").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Button("编辑") { editing = .permissions }
                }.id("permissions")
                Divider()
                HStack(spacing: 12) {
                    MagicIcon(name: "checkmark.shield")
                    VStack(alignment: .leading, spacing: 5) {
                        Text("已记住的授权").font(.headline)
                        Text("\(snapshot.grants.reduce(0) { $0 + $1["entries"].array.count }) 项授权 · 按工作区管理").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Button("查看与撤销") { editing = .grants }
                }
                if let problem = snapshot.grantProblem { Text(problem).font(.caption).foregroundStyle(.red) }
                Text("材料与角色不授予执行权限；当前待答审批仍在所属工作处理。").font(.caption).foregroundStyle(.secondary)
            }
            SettingsCard(title: "诊断") {
                HStack(spacing: 12) {
                    MagicIcon(name: "waveform.path.ecg")
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.phase.text).font(.headline)
                        Text("日志等级 \(model.diagnostics.logLevel.rawValue) · 调试模式\(model.diagnostics.debugMode ? "开启" : "关闭")").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer(); Button("管理诊断") { editing = .diagnostics }
                }
                Text(model.logProblem ?? "App 日志写入正常").font(.caption).foregroundStyle(model.logProblem == nil ? Color.secondary : .red)
            }.id("diagnostics")
            SettingsCard(title: "系统集成") {
                HStack(alignment: .top, spacing: 12) {
                    MagicIcon(name: "exclamationmark.triangle")
                    VStack(alignment: .leading, spacing: 5) {
                        Text("移除系统集成并退出").font(.headline)
                        Text("撤销登录项与属于本 App 的终端链接，保留记录和配置。").font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("移除…", role: .destructive) { editing = .integration }.accessibilityIdentifier("remove-integration")
                }
            }
        }
        .sheet(item: $editing) { section in
            switch section {
            case .data:
                DataLocationEditor(model: model, snapshot: snapshot) { editing = nil }
            case .roots:
                RootEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("roots", .object(["roots": snapshot.configuration["workspaceRoots"]]), stamp: snapshot.stamp)) { editing = nil }
            case .permissions:
                PermissionEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("permissions", snapshot.configuration["permissions"]["rules"] == .null ? .array([]) : snapshot.configuration["permissions"]["rules"], stamp: snapshot.stamp)) { editing = nil }
            case .grants:
                SavedGrantsEditor(model: model, snapshot: snapshot) { editing = nil }
            case .diagnostics:
                DiagnosticsEditor(model: model, snapshot: snapshot, drafts: drafts, draft: drafts.draft("diagnostics", .object(["type": .string("diagnostics.set"), "debugMode": .bool(model.diagnostics.debugMode), "logLevel": .string(model.diagnostics.logLevel.rawValue)]), stamp: snapshot.stamp)) { editing = nil }
            case .integration:
                SettingsSheet(title: "移除系统集成并退出", subtitle: "作用于这台 Mac 上属于本 App 的系统集成", icon: "exclamationmark.triangle", preferredHeight: 280) {
                    Text("撤销登录项并移除属于本 App 的 magic 终端链接。操作完成后退出 Magic Code；记录和配置保留，之后可在 Finder 删除 App。")
                } footer: {
                    VStack(alignment: .leading, spacing: 12) {
                        Divider()
                        if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                        HStack {
                            Button("取消") { editing = nil }.keyboardShortcut(.cancelAction)
                            Spacer()
                            Button("移除并退出", role: .destructive) { model.uninstallIntegration() }.buttonStyle(.borderedProminent).tint(.red)
                        }
                    }
                }
            }
        }
    }
}

private struct DataLocationEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    var close: () -> Void
    @State private var selected: URL?
    private var target: URL { selected ?? model.effectiveBase }
    private var canChange: Bool { !model.engineBusy && (!model.isCurrent || model.canChangeData) }
    var body: some View {
        SettingsSheet(title: "管理数据位置", subtitle: "当前实例的配置与记录位置", icon: "externaldrive") {
            SettingsCard(title: "当前位置") {
                SettingsPath(label: "基础目录", path: model.effectiveBase.path) { model.terminal.copy(model.effectiveBase.path) }
                SettingsPath(label: "配置文件", path: snapshot.configPath) { model.terminal.copy(snapshot.configPath) }
                Text("服务实例：\(model.identity?.serviceInstance ?? "未连接")").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Button("在 Finder 定位配置文件") { revealSettingPath(snapshot.configPath) }
            }
            SettingsCard(title: "切换基础目录") {
                SettingsPath(label: "目标目录", path: target.path) { model.terminal.copy(target.path) }
                HStack {
                    Button("选择目录…") { settingsDirectory { selected = $0 } }
                    Button("使用默认位置") { selected = model.userHome }
                }.disabled(!canChange)
                Text("选择包含 .magic 的基础目录，不要选择 .magic 本身。切换不搬迁、合并或删除任何记录；原位置的数据保留。").font(.caption).foregroundStyle(.secondary)
                if !canChange { Text("切换前需确认 Engine 已停止，或没有所属工作责任。").font(.caption).foregroundStyle(.orange) }
            }
        } footer: {
            VStack(alignment: .leading, spacing: 12) {
                Divider()
                if let message = model.actionMessage { Text(message).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                HStack {
                    Button("取消", action: close).keyboardShortcut(.cancelAction).disabled(model.engineBusy)
                    Spacer()
                    if model.engineBusy { ProgressView().controlSize(.small) }
                    Button("切换位置") { model.changeBase(target) }.buttonStyle(.borderedProminent)
                        .disabled(!canChange || target.resolvingSymlinksInPath() == model.effectiveBase.resolvingSymlinksInPath())
                }
            }
        }
        .onChange(of: model.effectiveBase) { _, _ in close() }
    }
}

private struct DiagnosticsEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var close: () -> Void
    var body: some View {
        SettingsSheet(title: "诊断", subtitle: "调整 App 调试模式与日志等级", icon: "waveform.path.ecg") {
            SettingsCard(title: "诊断选项") {
                Toggle("调试模式", isOn: draft.flag("debugMode")).accessibilityIdentifier("debug-mode")
                Text("开启后显示独立工作窗口，便于自动化操作与问题排查。关闭窗口不关闭调试模式。").font(.caption).foregroundStyle(.secondary)
                Picker("日志等级", selection: draft.field("logLevel")) {
                    ForEach(LogLevel.allCases, id: \.rawValue) { Text($0.rawValue).tag($0.rawValue) }
                }.accessibilityIdentifier("log-level")
                if !snapshot.configuration["diagnosticsNote"].text.isEmpty { Text(snapshot.configuration["diagnosticsNote"].text).font(.caption).foregroundStyle(.secondary) }
            }
            SettingsCard(title: "日志与窗口") {
                SettingsPath(label: "日志目录", path: model.logDirectory) { model.terminal.copy(model.logDirectory) }
                HStack {
                    Button("在 Finder 打开日志目录") { NSWorkspace.shared.open(URL(fileURLWithPath: model.logDirectory)) }.disabled(model.logDirectory.isEmpty)
                    if model.diagnostics.debugMode { Button("打开调试窗口") { model.showDebugWindow?() } }
                }
                Text(model.logProblem ?? "App 日志写入正常").font(.caption).foregroundStyle(model.logProblem == nil ? Color.secondary : .red)
            }
        } footer: {
            DraftFooter(model: model, draft: draft, key: "diagnostics", boundary: "保存后运行中的入口随后采用；离线入口下次启动采用。", cancel: { drafts.discard("diagnostics"); close() })
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "diagnostics" { close() } }
    }
}

private struct SavedGrantsEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    var close: () -> Void
    @State private var revoke: SettingsValue?
    @State private var revokeLabel = ""
    var body: some View {
        SettingsSheet(title: "已记住的授权", subtitle: "按工作区撤销授权，后续执行继续按权限规则与审批处理", icon: "checkmark.shield") {
            if let problem = snapshot.grantProblem { Text(problem).foregroundStyle(.red) }
            if snapshot.grants.isEmpty { Text("尚无已保存的授权。").foregroundStyle(.secondary) }
            ForEach(snapshot.grants, id: \.self) { section in
                SettingsCard(title: "工作区授权") {
                    SettingsPath(label: "工作区", path: section["workspace"].text) { model.terminal.copy(section["workspace"].text) }
                    ForEach(section["entries"].array.indices, id: \.self) { index in
                        let grant = section["entries"].array[index]
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("\(grant["tool"].text) · \(grant["path"].text.isEmpty ? "根内" : grant["path"].text)").textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                if !grant["host"].text.isEmpty { Text("域名：\(grant["host"].text)").font(.caption) }
                                Text("操作：\(grant["op"].text.isEmpty ? grant["op"].array.map(\.text).joined(separator: " / ") : grant["op"].text)").font(.caption)
                            }
                            Spacer()
                            Button("撤销…", role: .destructive) {
                                revokeLabel = "\(section["workspace"].text) · \(grant["tool"].text) · \(grant["path"].text.isEmpty ? "根内" : grant["path"].text)"
                                revoke = .object(["type": .string("grants.revoke"), "workspace": section["workspace"], "index": .number(Double(index)), "grantStamp": snapshot.grantStamp.map(SettingsValue.string) ?? .null])
                            }
                        }
                        Divider()
                    }
                    Button("撤销此工作区全部授权…", role: .destructive) {
                        revokeLabel = "\(section["workspace"].text) · 全部 \(section["entries"].array.count) 项授权"
                        revoke = .object(["type": .string("grants.revoke"), "workspace": section["workspace"], "grantStamp": snapshot.grantStamp.map(SettingsValue.string) ?? .null])
                    }
                }
            }
        } footer: {
            VStack(spacing: 12) {
                Divider()
                HStack { Spacer(); Button("完成", action: close).keyboardShortcut(.cancelAction) }
            }
        }
        .sheet(isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            if let action = revoke {
                SettingsRemovalSheet(model: model, title: "撤销授权", object: revokeLabel, boundary: "仅撤销上述已记住的授权。后续执行继续按配置权限规则与审批处理；不会替你回答当前待答审批。", action: action, stamp: snapshot.stamp, key: "revoke-grant") { revoke = nil }
            }
        }
    }
}

struct RootEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var close: () -> Void
    var body: some View {
        SettingsSheet(title: "工作区根", subtitle: "定义后续工作的默认根与可用根目录", icon: "folder") {
            SettingsCard(title: "根目录范围") {
                Toggle("显式指定工作区根", isOn: Binding(get: { draft.value["roots"] != .null }, set: { draft.put("roots", $0 ? .array([]) : .null) }))
                if draft.value["roots"] != .null { StringListEditor(title: "根目录（第一项是默认根）", values: draft.strings("roots"), ordered: true) }
            }
        } footer: {
            DraftFooter(model: model, draft: draft, key: "roots", boundary: "留空使用启动目录。指定目录必须有效，新任务采用，当前任务的目录保持不变。", cancel: { drafts.discard("roots"); close() }, action: { .object(["type": .string("workspace.set"), "roots": draft.value["roots"]]) })
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "roots" { close() } }
    }
}
struct PermissionEditor: View {
    @ObservedObject var model: AppModel
    let snapshot: SettingsSnapshot
    let drafts: SettingsDrafts
    @ObservedObject var draft: SettingsDraft
    var close: () -> Void
    var body: some View {
        SettingsSheet(title: "配置权限规则", subtitle: "规则用于后续创建的任务", icon: "lock.shield") {
            Text("规则是工具、路径、操作与域名的允许范围。必要的禁区保护仍优先；材料来源不代表执行许可。").font(.caption).foregroundStyle(.secondary)
            ForEach(draft.value.array.indices, id: \.self) { index in
                VStack(alignment: .leading, spacing: 9) {
                    Text("规则 \(index + 1)").font(.subheadline.weight(.medium))
                    SettingText(title: "工具名（* 表示任意工具）", value: field(index, "tool"))
                    SettingText(title: "路径模式（留空为根内）", value: field(index, "path"), multiline: true)
                    SettingText(title: "域名模式（网络调用按域名匹配）", value: field(index, "host"))
                    StringListEditor(title: "操作（空白表示任意；read/create/edit/overwrite/delete/move/system/outbound/unknown）", values: Binding(get: { let rows = draft.value.array; guard rows.indices.contains(index) else { return [] }; let op = rows[index]["op"]; return op == .null ? [] : op.text.isEmpty ? op.array.map(\.text) : [op.text] }, set: { values in var rows = draft.value.array; guard rows.indices.contains(index) else { return }; var row = rows[index].object; if values.isEmpty { row.removeValue(forKey: "op") } else { row["op"] = .strings(values) }; rows[index] = .object(row); draft.value = .array(rows) }))
                    Button("删除规则", role: .destructive) { var values = draft.value.array; values.remove(at: index); draft.value = .array(values) }
                }.padding(12).background(Color.secondary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
            }
            Button("添加规则", systemImage: "plus") { draft.value = .array(draft.value.array + [.object(["tool": .string("")])]) }
        } footer: {
            DraftFooter(model: model, draft: draft, key: "permissions", boundary: "新任务使用这些规则；当前任务的待答请求请回到终端处理。", cancel: { drafts.discard("permissions"); close() }, action: { .object(["type": .string("permissions.set"), "rules": draft.value]) })
        }
        .onChange(of: model.settingsSavedKey) { _, key in if key == "permissions" { close() } }
    }
    private func field(_ index: Int, _ key: String) -> Binding<String> {
        Binding(get: { let rows = draft.value.array; return rows.indices.contains(index) ? rows[index][key].text : "" }, set: { value in var rows = draft.value.array; guard rows.indices.contains(index) else { return }; var row = rows[index].object; if value.isEmpty { row.removeValue(forKey: key) } else { row[key] = .string(value) }; rows[index] = .object(row); draft.value = .array(rows) })
    }
}
