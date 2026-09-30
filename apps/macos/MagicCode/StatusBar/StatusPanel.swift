import SwiftUI

struct StatusPanel: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openSettings) private var openSettings
    @FocusState private var focused: String?
    private var rows: [NativeWork] { WorkGroup.allCases.flatMap { model.list.rows($0, works: model.works) } }
    private var stale: Bool { !model.isCurrent && model.projection != nil }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Magic Code").font(.headline)
                Spacer()
                Button("设置", systemImage: "gearshape") { openSettings(); NSApp.activate(ignoringOtherApps: true) }
                    .labelStyle(.iconOnly).help("打开设置").accessibilityLabel("打开 Magic Code 设置")
            }
            Text(model.summary).font(.subheadline).foregroundStyle(.secondary).accessibilityIdentifier("status-summary")
            if case .fault = model.phase {
                Button("重试连接") { model.retry() }
            }
            Divider()
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(WorkGroup.allCases) { group in
                        let works = model.list.rows(group, works: model.works)
                        if !works.isEmpty {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(stale ? "上次连接时 · \(group.title)" : group.title).font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                                ForEach(works) { work in row(work).id(work.id) }
                            }
                        }
                    }
                    if model.works.count > 10 {
                        Button("在终端查看全部") { model.newTerminal() }.buttonStyle(.link)
                        Text("在终端使用 /resume 查看全部会话").font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.frame(maxHeight: min(520, (NSScreen.main?.visibleFrame.height ?? 720) - 230))
                .onChange(of: focused) { _, id in if let id { proxy.scrollTo(id, anchor: .center) } }
            }
            if let message = model.actionMessage { Text(message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
            TerminalStatus(terminal: model.terminal)
            Divider()
            HStack {
                Button("打开终端") { model.newTerminal() }.disabled(!model.isCurrent)
                Spacer()
                Button("退出 Magic Code…") { NSApp.terminate(nil) }
            }
        }
        .padding(16).frame(width: 360).background(.background)
        .onAppear {
            model.panelVisibility(true)
            focused = rows.first?.id
        }
        .onDisappear { model.panelVisibility(false) }
        .onExitCommand { dismiss() }
        .onMoveCommand { direction in
            guard !rows.isEmpty else { return }
            let index = rows.firstIndex { $0.id == focused } ?? -1
            if direction == .down { focused = rows[min(index + 1, rows.count - 1)].id }
            if direction == .up { focused = rows[max(index - 1, 0)].id }
        }
        .confirmationDialog(model.stopTarget.map { "停止“\($0.title)”？" } ?? "停止任务？", isPresented: Binding(get: { model.stopTarget != nil }, set: { if !$0 { model.stopTarget = nil } }), titleVisibility: .visible) {
            Button("停止任务", role: .destructive) { if let work = model.stopTarget { model.stop(work) }; model.stopTarget = nil }
            Button("取消", role: .cancel) { model.stopTarget = nil }
        } message: {
            if let work = model.stopTarget { Text("\(work.project) · \(work.statusText)\n只停止这项工作。") }
        }
    }
    @ViewBuilder private func row(_ work: NativeWork) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Button { model.inspect(work) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(work.title.isEmpty ? "未命名工作" : work.title).fontWeight(.medium).lineLimit(2)
                        Spacer(minLength: 8)
                        Text(work.project).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle).frame(maxWidth: 95)
                    }
                    Text(stale ? "上次状态：\(work.statusText)" : work.statusText).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    if model.selected != work.id, model.works.contains(where: { $0.id != work.id && $0.title == work.title }), let path = work.workspace.first {
                        Text(path).font(.caption2).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).focused($focused, equals: work.id)
                .accessibilityLabel("\(work.title)，\(work.project)，\(stale ? "上次状态：" : "")\(work.statusText)")
                .accessibilityIdentifier("work-\(work.id)")
                .accessibilityHint("展开详情；在终端打开以接回工作")
                .onKeyPress(.return) { model.inspect(work, open: true); return .handled }
            if model.selected == work.id {
                if let reason = work.reason, reason != work.statusText {
                    Text(reason).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
                if let path = work.workspace.first { FullPath(label: "项目路径", path: path) { model.terminal.copy(path) } }
                HStack {
                    Button("在终端打开") { model.inspect(work, open: true) }.disabled(!model.isCurrent)
                    Spacer()
                    Text(Date(timeIntervalSince1970: work.since / 1000), style: .relative)
                        .environment(\.locale, Locale(identifier: "zh_CN"))
                        .font(.caption2).foregroundStyle(.secondary)
                    Menu {
                        Button("复制接回命令") { model.copyCommand(work) }
                        if work.affected {
                            Button("停止任务…", role: .destructive) { model.stopTarget = work }.disabled(!model.isCurrent || work.gen == nil)
                        }
                    } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).fixedSize().accessibilityLabel("\(work.title) 更多操作")
                }
                if !work.notices.isEmpty {
                    Text("事项").font(.caption).fontWeight(.semibold).foregroundStyle(.secondary)
                    ForEach(work.notices) { notice in
                        Button { model.inspect(work, notice: notice.id) } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(noticeTitle(notice.kind)).fontWeight(.medium)
                                    Spacer()
                                    Text(notice.unread ? "未读" : "已读").foregroundStyle(.secondary)
                                }
                                Text(Date(timeIntervalSince1970: notice.at / 1000), format: .dateTime.month().day().hour().minute().second())
                                    .environment(\.locale, Locale(identifier: "zh_CN")).foregroundStyle(.secondary)
                            }.font(.caption).padding(8).frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 6))
                            .accessibilityIdentifier("notice-\(notice.id)")
                            .accessibilityHint("打开这条事项；仅确认这一条已读")
                            .disabled(!model.isCurrent)
                        if model.selectedNotice?.id == notice.id, let shown = model.selectedNotice {
                            Text(shown.detail.flatMap { $0.isEmpty ? nil : $0 } ?? "这条事项没有附加说明。")
                                .font(.callout).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                .accessibilityIdentifier("notice-content-\(notice.id)")
                        }
                    }
                }
            }
        }.padding(10).background(model.selected == work.id ? Color.accentColor.opacity(0.08) : Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
    }
    private func noticeTitle(_ kind: NoticeKind) -> String {
        switch kind { case .done: return "结果可查看"; case .failed: return "工作遇到问题"; case .needsYou: return "需要你的答复" }
    }
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
        VStack(alignment: .leading, spacing: 16) {
            Text("通知事项").font(.title2)
            Text("选择一项，在终端查看当前状态").font(.subheadline).foregroundStyle(.secondary)
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
    func makeQuitAlert() -> NSAlert {
        let alert = NSAlert()
        alert.messageText = affected.isEmpty ? "工作状态尚未确认，仍要退出 Magic Code？" : "退出将停止 \(affected.count) 项工作"
        alert.informativeText = "确认工作已停止后退出。未确认时，App 会保持打开。"
        let cancel = alert.addButton(withTitle: "取消")
        let stop = alert.addButton(withTitle: "停止并退出")
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
