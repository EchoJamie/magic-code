import SwiftUI

struct StatusPanel: View {
    @ObservedObject var model: AppModel
    var surface: AppModel.PanelSurface = .menu
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openSettings) private var openSettings
    @FocusState private var focused: String?
    @State private var listFocus: String?
    @State private var listPosition = ScrollPosition(idType: String.self)
    private var rows: [NativeWork] { WorkGroup.allCases.flatMap { model.list.rows($0, works: model.works) } }
    private var stale: Bool {
        guard model.projection != nil else { return false }
        switch model.phase { case .starting, .stopped, .unreachable, .fault: return true; default: return false }
    }
    private var connectionSummary: String {
        guard stale else { return model.summary }
        if case .starting = model.phase { return "正在连接 · 以下为上次快照" }
        return "连接中断 · 以下为上次快照"
    }
    private var engineStatus: String {
        switch model.phase {
        case .starting: "正在启动"
        case .ready: "运行中"
        case .stopping: "正在停止"
        case .stopped: "已停止"
        case .unreachable: "无法连接"
        case .fault: "启动或运行失败"
        }
    }
    private var width: CGFloat { min(380, (NSScreen.main?.visibleFrame.width ?? 1024) - 32) }
    private var scrollLimit: CGFloat { max(120, min(520, (NSScreen.main?.visibleFrame.height ?? 720) - 240)) }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let selected = model.selected {
                HStack {
                    Button("所有工作", systemImage: "chevron.left") { model.leaveDetail() }
                        .accessibilityIdentifier("back-to-works")
                    Spacer()
                    if let work = model.works.first(where: { $0.id == selected }) { workMenu(work) }
                }
                if let work = model.works.first(where: { $0.id == selected }) {
                    WorkDetail(model: model, work: work, stale: stale, limit: scrollLimit).id(work.id)
                } else {
                    Text("这项工作已不可达").font(.headline)
                    Text("返回列表查看其他工作。").foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    Text("Magic Code").font(.headline)
                    Spacer()
                    Button("设置", systemImage: "gearshape") { openSettings(); NSApp.activate(ignoringOtherApps: true) }
                        .labelStyle(.iconOnly).help("打开设置").accessibilityLabel("打开 Magic Code 设置")
                }
                HStack {
                    Text("Magic Engine · \(engineStatus)").font(.subheadline)
                    Spacer()
                    switch model.phase {
                    case .starting, .stopping: ProgressView().controlSize(.small)
                    case .ready, .unreachable:
                        Button("停止 Magic Engine…") { model.presentEngineStopAlert() }.disabled(model.engineBusy)
                    case .stopped:
                        Button("启动 Magic Engine") { model.startEngine() }.disabled(model.engineBusy)
                    case .fault:
                        Button("重试启动") { model.startEngine() }.disabled(model.engineBusy)
                    }
                }.accessibilityIdentifier("engine-status")
                if model.isCurrent || stale {
                    Text(connectionSummary)
                        .font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("status-summary")
                }
                if !rows.isEmpty {
                    PanelScroll(limit: scrollLimit, initialHeight: CGFloat(rows.count) * 90 + 80, position: $listPosition) {
                        VStack(alignment: .leading, spacing: 14) {
                            ForEach(WorkGroup.allCases) { group in
                                let works = model.list.rows(group, works: model.works)
                                if !works.isEmpty {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(group.title).font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                                        ForEach(works) { work in row(work).id(work.id) }
                                    }
                                }
                            }
                            if model.works.count > rows.count {
                                Button("在终端查看全部") { model.newTerminal() }.buttonStyle(.link)
                                    .help("在终端使用 /resume 查看全部工作")
                            }
                        }.scrollTargetLayout()
                    }
                    .onAppear { focused = listFocus ?? rows.first?.id }
                }
                if case .fault(let reason) = model.phase {
                    Text(reason).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            }
            if let message = model.inspectionMessage { Text(message).font(.caption).foregroundStyle(.secondary) }
            if let message = model.actionMessage { Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            TerminalStatus(terminal: model.terminal)
            if model.selected == nil {
                if !rows.isEmpty { Divider() }
                if model.diagnostics.debugMode && surface == .menu { Button("打开调试窗口") { model.showDebugWindow?() } }
                HStack {
                    Button("打开终端") { model.newTerminal() }
                    Spacer()
                    Menu {
                        Button("刷新 Engine 状态") { model.refreshAfterWake() }.disabled(model.engineBusy)
                        if case .fault = model.phase {
                            Button("停止 Magic Engine…", role: .destructive) { model.presentEngineStopAlert() }.disabled(model.engineBusy)
                        }
                        Divider()
                        Button("退出 Magic Code") { NSApp.terminate(nil) }
                    } label: { Image(systemName: "ellipsis") }
                        .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("更多操作")
                }
            }
        }
        .padding(16).frame(width: width).background(.background)
        .onAppear { model.panelVisibility(true, surface: surface) }
        .onDisappear { model.panelVisibility(false, surface: surface) }
        .onChange(of: model.selected) { old, selected in
            if old == nil, let selected { listFocus = selected; focused = nil }
            if selected == nil { focused = listFocus }
        }
        .onChange(of: rows.map(\.id)) { old, ids in
            guard let focus = listFocus ?? focused, !ids.contains(focus) else { return }
            let index = old.firstIndex(of: focus) ?? 0
            listFocus = ids.isEmpty ? nil : ids[min(index, ids.count - 1)]
            if model.selected == nil { focused = listFocus }
        }
        .onExitCommand {
            if model.stopTarget != nil { model.stopTarget = nil }
            else if model.selected != nil { model.leaveDetail() }
            else { dismiss() }
        }
        .onMoveCommand { direction in
            guard model.selected == nil, model.stopTarget == nil, !rows.isEmpty,
                  direction == .down || direction == .up else { return }
            let index = rows.firstIndex { $0.id == focused } ?? -1
            let next = direction == .down ? min(index + 1, rows.count - 1) : max(index - 1, 0)
            focused = rows[next].id; listFocus = focused
            listPosition.scrollTo(id: rows[next].id)
        }
        .confirmationDialog(model.stopTarget.map { "停止“\($0.work.title)”？" } ?? "停止任务？",
                            isPresented: Binding(get: { model.stopTarget != nil }, set: { if !$0 { model.stopTarget = nil } }), titleVisibility: .visible) {
            Button("停止任务", role: .destructive) { model.confirmStop() }
            Button("取消", role: .cancel) { model.stopTarget = nil }
        } message: {
            if let work = model.stopTarget?.work {
                Text("\(work.project) · \(work.statusText)\n\(work.members == nil ? "只停止这项工作。" : "停止整件工作，包括其成员与在途执行。")")
            }
        }
    }
    private func workMenu(_ work: NativeWork) -> some View {
        Menu {
            Button("复制接回命令") { model.copyCommand(work) }
            if work.affected {
                Button("停止任务…", role: .destructive) { model.prepareStop(work) }.disabled(!model.isCurrent || work.gen == nil)
            }
        } label: { Image(systemName: "ellipsis") }
            .menuStyle(.borderlessButton).fixedSize().accessibilityLabel("\(work.title) 更多操作")
    }
    private func row(_ work: NativeWork) -> some View {
        let explanation = work.statusText
        let status = work.state == .unknown && explanation != work.state.title ? "状态待确认 · \(explanation)" : work.statusText
        return Button { model.inspect(work) } label: {
            HStack(alignment: .top, spacing: 8) {
                Text(work.state.mark).foregroundStyle(work.state == .waiting ? Color.accentColor : .secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text(work.title.isEmpty ? "未命名工作" : work.title).fontWeight(.medium).lineLimit(3)
                    Text("\(work.project) · \(stale ? "上次状态：" : "")\(status)")
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if work.notices.contains(where: { $0.kind == .failed && $0.unread }) {
                        Text("▲ 有未读的问题事项").font(.caption).foregroundStyle(.secondary)
                    }
                    if model.works.contains(where: { $0.id != work.id && $0.title == work.title && $0.project == work.project }),
                       let path = work.workspace.first {
                        Text(WorkList.shortPath(path, among: model.works.filter { $0.title == work.title && $0.project == work.project }.compactMap { $0.workspace.first }))
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
            }.padding(.vertical, 8).padding(.horizontal, 6).contentShape(Rectangle())
        }.buttonStyle(WorkRowStyle(focused: focused == work.id)).focused($focused, equals: work.id)
            .accessibilityLabel("\(work.title)，\(work.project)，\(stale ? "上次状态：" : "")\(status)")
            .accessibilityIdentifier("work-\(work.id)").accessibilityHint("查看详情和接回命令")
            .onKeyPress(.return) { model.inspect(work); return .handled }
            .onChange(of: focused) { _, id in if id == work.id { listFocus = id } }
    }
}

private struct WorkRowStyle: ButtonStyle {
    let focused: Bool
    func makeBody(configuration: Configuration) -> some View {
        WorkRowFeedback(content: configuration.label, focused: focused || configuration.isPressed)
    }
}
private struct WorkRowFeedback<Content: View>: View {
    let content: Content
    let focused: Bool
    @State private var hovered = false
    var body: some View {
        content.background(focused ? Color.accentColor.opacity(0.12) : hovered ? Color.primary.opacity(0.05) : .clear,
                           in: RoundedRectangle(cornerRadius: 6)).onHover { hovered = $0 }
    }
}

/// Measure content rather than reserving a minimum height for every list.
private struct PanelScroll<Content: View>: View {
    let limit: CGFloat
    let initialHeight: CGFloat
    var position: Binding<ScrollPosition>?
    @ViewBuilder var content: () -> Content
    @State private var contentHeight: CGFloat?
    var body: some View {
        scroll.frame(height: min(contentHeight ?? initialHeight, limit))
    }
    @ViewBuilder private var scroll: some View {
        if let position { base.scrollPosition(position) } else { base }
    }
    private var base: some View {
        ScrollView {
            content().frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
        }.defaultScrollAnchor(.top)
    }
}

private struct WorkDetail: View {
    @ObservedObject var model: AppModel
    let work: NativeWork
    let stale: Bool
    let limit: CGFloat
    @State private var pathsExpanded = false
    @State private var membersExpanded = false
    var body: some View {
        PanelScroll(limit: limit, initialHeight: 300) {
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(work.title.isEmpty ? "未命名工作" : work.title).font(.headline).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    Text(work.project).font(.subheadline).foregroundStyle(.secondary)
                    Text("\(work.state.mark) \(stale ? "上次状态：" : "")\(work.state.title)").font(.subheadline)
                    if work.statusText != work.state.title { Text(work.statusText).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                    if [.unknown, .stopping, .stopped].contains(work.state), let reason = work.reason,
                       !reason.isEmpty, reason != work.statusText, reason != work.state.title {
                        Text(reason).font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("在你的终端执行以下命令接回对话").font(.caption).foregroundStyle(.secondary)
                    Text(model.resumeCommand(work)).font(.system(.caption, design: .monospaced))
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        .accessibilityIdentifier("work-resume-command")
                    Button("复制接回命令") { model.copyCommand(work) }
                        .accessibilityIdentifier("copy-work-resume-command")
                }
                if !work.notices.isEmpty || !work.workspace.isEmpty || work.members != nil {
                    VStack(alignment: .leading, spacing: 16) {
                        if !work.notices.isEmpty {
                            Text("相关事项").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                            ForEach(work.notices) { notice in
                                VStack(alignment: .leading, spacing: 6) {
                                    Button { model.inspect(work, notice: notice.id) } label: {
                                        HStack {
                                            Text(notice.kind.title).fontWeight(.medium)
                                            Spacer()
                                            Text(notice.unread ? "未读" : "已读").foregroundStyle(.secondary)
                                            Image(systemName: model.selectedNotice?.id == notice.id ? "chevron.down" : "chevron.right")
                                        }.font(.callout).contentShape(Rectangle())
                                    }.buttonStyle(.plain).disabled(!model.isCurrent)
                                        .accessibilityIdentifier("notice-\(notice.id)")
                                        .accessibilityHint("查看这条事项；仅确认这一条已读")
                                    if model.selectedNotice?.id == notice.id, let shown = model.selectedNotice {
                                        Text(shown.detail.flatMap { $0.isEmpty ? nil : $0 } ?? "这条事项没有附加说明。")
                                            .font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                            .accessibilityIdentifier("notice-content-\(notice.id)")
                                            .onScrollVisibilityChange(threshold: 0.01) { visible in model.noticePresented(shown.id, visible: visible) }
                                    }
                                }
                            }
                        }
                        if let members = work.members, !members.isEmpty {
                            DisclosureGroup("协作成员（\(members.count)）", isExpanded: $membersExpanded) {
                                VStack(alignment: .leading, spacing: 12) {
                                    ForEach(members) { member in
                                        VStack(alignment: .leading, spacing: 4) {
                                            Text(member.name).fontWeight(.medium)
                                            Text("\(member.state.mark) \(member.state.title)").foregroundStyle(.secondary)
                                            if let action = member.action, action != member.state.title { Text(action) }
                                            if let reason = member.reason, reason != member.action, reason != member.state.title { Text(reason) }
                                        }.font(.callout).fixedSize(horizontal: false, vertical: true)
                                    }
                                }.padding(.top, 8)
                            }.accessibilityIdentifier("work-members")
                        }
                        if !work.workspace.isEmpty {
                            DisclosureGroup("工作区路径", isExpanded: $pathsExpanded) {
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(work.workspace, id: \.self) { path in FullPath(label: "工作区路径", path: path) { model.terminal.copy(path) } }
                                }.padding(.top, 8)
                            }
                        }
                    }
                }
            }
        }
    }
}

private extension NoticeKind {
    var title: String { switch self { case .done: "结果可查看"; case .failed: "工作遇到问题"; case .needsYou: "答复事项" } }
}
private extension RunState {
    var title: String { switch self { case .running: "正在执行"; case .waiting: "等待你的答复"; case .stopping: "正在停止"; case .stopped: "已停止"; case .idle: "当前空闲"; case .unknown: "状态待确认" } }
    var mark: String { switch self { case .running: "●"; case .waiting: "◊"; case .stopping: "●"; case .stopped, .idle: "○"; case .unknown: "■" } }
}

struct TerminalStatus: View {
    @ObservedObject var terminal: TerminalLauncher
    var body: some View {
        if let message = terminal.message {
            HStack {
                Text(message).font(.caption).foregroundStyle(.secondary)
                if let command = terminal.fallbackCommand { Button("复制命令") { terminal.copy(command) }.font(.caption) }
            }
        }
    }
}

struct NoticeWindow: View {
    @ObservedObject var model: AppModel
    var body: some View {
        if model.selected != nil {
            StatusPanel(model: model)
        } else { routes }
    }
    private var routes: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("通知事项").font(.title2)
            Text("选择一项，查看工作详情和接回命令").font(.subheadline).foregroundStyle(.secondary)
            if let message = model.actionMessage { Text(message).textSelection(.enabled) }
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(Array(model.notificationRoutes.enumerated()), id: \.offset) { _, route in
                        let work = model.works.first { $0.session == route.session }
                        Button { model.openNotification(route) } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(work?.title ?? "查看这条通知的工作").fontWeight(.medium).lineLimit(2)
                                    Text(work?.statusText ?? "打开后核对实际状态").font(.caption).foregroundStyle(.secondary)
                                    if let path = work?.workspace.first {
                                        Text(path).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading)
                                Image(systemName: "chevron.right").foregroundStyle(.secondary)
                            }.padding(12).contentShape(Rectangle())
                        }.buttonStyle(.plain).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
        }.padding(20).frame(minWidth: 380, minHeight: 200).background(.background)
    }
}

struct QuitImpactList: View {
    let affected: [NativeWork]
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                ForEach(affected) { work in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(work.title).fontWeight(.medium).fixedSize(horizontal: false, vertical: true)
                        Text(work.statusText).foregroundStyle(.secondary)
                        if let path = work.workspace.first { Text(path).font(.caption).foregroundStyle(.secondary) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
            }.padding(4)
        }.frame(width: 360, height: min(300, CGFloat(affected.count) * 100))
    }
}

struct FullPath: View {
    let label: String
    let path: String
    let copy: () -> Void
    var body: some View {
        HStack(alignment: .top) {
            Text(path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("\(label)：\(path)")
            Button("复制完整路径", systemImage: "doc.on.doc", action: copy).labelStyle(.iconOnly)
                .help("复制\(label)的完整路径").accessibilityLabel("复制\(label)完整路径")
                .accessibilityIdentifier("copy-path-\(label)")
        }
    }
}

extension AppModel {
    func presentEngineStopAlert() {
        let alert = makeEngineStopAlert()
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertSecondButtonReturn { confirmEngineStop() }
    }
    func makeEngineStopAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "停止 Magic Engine？"
        alert.informativeText = "将停止全部后台工作并收回所属工具。退出 App 不会停止 Engine。"
        let cancel = alert.addButton(withTitle: "取消")
        let stop = alert.addButton(withTitle: "停止 Engine")
        stop.hasDestructiveAction = true
        stop.keyEquivalent = ""
        if !affected.isEmpty {
            let list = NSHostingView(rootView: QuitImpactList(affected: affected))
            list.frame.size = list.fittingSize
            alert.accessoryView = list
        }
        alert.window.initialFirstResponder = cancel
        return alert
    }
}
