import SwiftUI
import AppKit

@MainActor final class SessionBrowserModel: ObservableObject {
    @Published var archived = false
    @Published var search = ""
    @Published var workspace: [String] = []
    @Published private(set) var workspaces: [[String]] = []
    @Published var selection = Set<String>()
    @Published private(set) var compactDetail = false
    @Published private(set) var rows: [NativeSession] = []
    @Published private(set) var currentRequests: [HistoryEvent] = []
    @Published private(set) var events: [HistoryEvent] = []
    @Published private(set) var entries: [HistoryEntry] = []
    @Published private(set) var loading = false
    @Published private(set) var reading = false
    @Published private(set) var busy = false
    @Published private(set) var online = false
    @Published private(set) var error: String?
    @Published private(set) var operationMessage: String?
    @Published private(set) var historyError: String?
    @Published private(set) var route: NoticeRoute?
    @Published private(set) var detailWork: NativeWork?
    @Published private(set) var done = false
    @Published var historyExpanded = false
    @Published private(set) var memberSession: String?
    @Published var rename: String?
    var send: ((NativeRequest) -> Void)?
    var copy: ((NativeSession) -> Void)?
    private var identity: ServiceIdentity?
    private var catalogRequest: String?
    private var historyRequest: String?
    private var refreshingCurrent = false
    private var inspectRequest: String?
    private var manageRequest: String?
    private var next: Int?
    private var opened = false
    @Published private(set) var active = false
    private var visibleNotice: String?
    private var readNotice: String?
    private var works: [String: NativeWork] = [:]
    private var selectedByView: [Bool: Set<String>] = [:]
    private var selectionAfterRefresh: Set<String>?
    var selected: NativeSession? {
        guard selection.count == 1 else { return nil }
        if let row = rows.first(where: { selection.contains($0.id) }) { return row }
        guard let route, selection.contains(route.session), let work = detailWork else { return nil }
        return NativeSession(background: work.background, id: work.session, title: work.title, at: work.since, workspace: work.workspace,
            archived: work.archived, canArchive: work.canArchive, terminalOpen: work.terminalOpen, state: work.state,
            reason: work.reason, recentInput: nil, recentProgress: nil)
    }
    var eligible: [NativeSession] { rows.filter { selection.contains($0.id) && (archived || $0.canArchive) } }
    var readingNotice: AttentionItem? { route?.notice ?? detailWork?.currentNotice }
    var readingSession: String? { route?.session ?? selected?.id }
    var routeIsCurrent: Bool { route?.notice.id == detailWork?.currentNotice?.id && detailWork?.archived == false }
    func connect(identity: ServiceIdentity?, current: Bool, works: [NativeWork]) {
        if self.identity != identity { disconnect() }
        self.identity = identity; online = current
        self.works = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
        if let target = readingSession { detailWork = self.works[target] ?? detailWork }
        if opened && current {
            refresh(); if route != nil && inspectRequest == nil { locate() }
            if historyExpanded && !entries.isEmpty { history(refreshCurrent: true) }
        }
    }
    func disconnect() {
        online = false; loading = false; reading = false; busy = false
        catalogRequest = nil; historyRequest = nil; inspectRequest = nil; manageRequest = nil
        visibleNotice = nil
    }
    func open(route: NoticeRoute? = nil) {
        opened = true
        if let route {
            compactDetail = true
            self.route = route; readNotice = nil; visibleNotice = nil; historyExpanded = true
            search = ""; workspace = []; selection = [route.session]; selectionAfterRefresh = nil
            entries = []; events = []; currentRequests = []; detailWork = nil; rename = nil; memberSession = nil
            historyRequest = nil; inspectRequest = nil; reading = false; next = nil; done = false; historyError = nil
            locate()
        } else { refresh() }
    }
    func close() { opened = false; visibleNotice = nil; windowActive(false) }
    func windowActive(_ value: Bool) { active = value; acknowledgeViewedNotice() }
    func showDetail(_ session: String? = nil) {
        if let session { selection = [session] }
        guard !selection.isEmpty else { return }
        compactDetail = true
    }
    func showCatalog() { compactDetail = false; visibleNotice = nil }
    func switchView(_ value: Bool) {
        showCatalog()
        selectedByView[archived] = selection
        archived = value; route = nil; selection = selectedByView[value] ?? []
        rows = []; choose(); refresh()
    }
    func refresh() {
        guard opened, online else { return }
        let request = UUID().uuidString; catalogRequest = request; loading = true; error = nil
        send?(.sessions(request: request, archived: archived, workspace: workspace.isEmpty ? nil : workspace, search: search.isEmpty ? nil : search))
        expire(request)
    }
    func choose() {
        if selection.isEmpty { showCatalog() }
        if route != nil && selection == Set([route!.session]) { return }
        if route?.session != selected?.id { route = nil; detailWork = nil }
        inspectRequest = nil; readNotice = nil; memberSession = nil
        entries = []; events = []; currentRequests = []; next = nil; done = false; historyError = nil; historyRequest = nil; reading = false; rename = nil; visibleNotice = nil
        detailWork = selection.count == 1 ? selection.first.flatMap { works[$0] } : nil
        inspectSelection()
        if historyExpanded, selected != nil { history() }
    }
    func history(refreshCurrent: Bool = false) {
        guard online, !reading, let session = selected?.id ?? route?.session else { return }
        let request = UUID().uuidString; historyRequest = request; refreshingCurrent = refreshCurrent; reading = true; historyError = nil
        send?(.history(request: request, session: session, after: refreshCurrent ? nil : next, source: route?.notice.source ?? memberSession.map { AttentionSource(session: $0) }))
        expire(request)
    }
    func chooseMember(_ session: String?) {
        memberSession = session; route = nil; entries = []; events = []; next = nil; done = false
        historyRequest = nil; reading = false; visibleNotice = nil; readNotice = nil; historyExpanded = true
        history()
    }
    private func inspectSelection() {
        guard route == nil, online, let selected, inspectRequest == nil else { return }
        let request = UUID().uuidString; inspectRequest = request
        send?(.inspect(request: request, session: selected.id, notice: nil)); expire(request)
    }
    func retryLocation() { locate() }
    private func locate() {
        guard let route else { return }
        guard online, let identity else { historyError = "Magic Engine 未连接；已保留通知目标，可连接后重新读取。"; return }
        guard URL(fileURLWithPath: route.base).resolvingSymlinksInPath().path == URL(fileURLWithPath: identity.base).resolvingSymlinksInPath().path else {
            historyError = "通知属于另一数据位置：\(route.base)。请在设置中明确切换后读取。"; return
        }
        // Old callbacks may read their source, but must never acknowledge a new Engine instance.
        let request = UUID().uuidString; inspectRequest = request
        send?(.inspect(request: request, session: route.session, notice: nil)); expire(request)
    }
    func manage(_ items: [SessionManagement], request: String = UUID().uuidString) {
        guard online, !busy, let identity, !items.isEmpty else { return }
        busy = true; manageRequest = request; operationMessage = nil
        send?(.manage(request: request, serviceInstance: identity.serviceInstance, items: items)); expire(request)
    }
    func copySelected() { if let selected, !selected.archived, online { copy?(selected); operationMessage = "已复制接回命令" } }
    func detailVisible(session: String, visible: Bool) {
        guard opened, readingSession == session else { return }
        visibleNotice = visible ? readingNotice?.id : nil
        acknowledgeViewedNotice()
    }
    func isPresenting(session: String, notice: String) -> Bool {
        opened && online && active && visibleNotice == notice && readingSession == session && readingNotice?.id == notice
    }
    private func acknowledgeViewedNotice() {
        guard opened, online, active, let notice = readingNotice, notice.unread, visibleNotice == notice.id, let identity,
              route == nil || route?.serviceInstance == identity.serviceInstance, readNotice != notice.id else { return }
        readNotice = notice.id
        send?(.read(serviceInstance: identity.serviceInstance, ids: [notice.id]))
    }
    private func expire(_ request: String) {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard let self else { return }
            if self.catalogRequest == request { self.catalogRequest = nil; self.loading = false; self.error = "目录读取超时，请重试。" }
            if self.historyRequest == request || self.inspectRequest == request {
                self.historyRequest = nil; self.inspectRequest = nil; self.reading = false; self.historyError = "内容读取超时，目标已保留，请重试。"
            }
            if self.manageRequest == request { self.manageRequest = nil; self.busy = false; self.operationMessage = "未收到操作结果；请刷新核对当前状态后重试。"; self.refresh() }
        }
    }
    func receive(_ response: NativeResponse) {
        switch response {
        case let .sessionsResult(request, service, sessions, error):
            guard request == catalogRequest, service == identity?.serviceInstance, online else { return }
            catalogRequest = nil; loading = false; self.error = error
            guard let sessions else { return }
            // Preserve identity order while interacting. Newly encountered rows keep Engine order.
            let byID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
            let kept = rows.compactMap { byID[$0.id] }
            rows = kept + sessions.filter { row in !kept.contains { $0.id == row.id } }
            for roots in sessions.compactMap(\.workspace) where !workspaces.contains(roots) { workspaces.append(roots) }
            if let pending = selectionAfterRefresh { selection = pending; selectionAfterRefresh = nil }
            if route == nil {
                selection.formIntersection(Set(rows.map(\.id)))
                detailWork = selected.flatMap { works[$0.id] ?? (detailWork?.session == $0.id ? detailWork : nil) }
                inspectSelection()
                if historyExpanded && selected != nil && entries.isEmpty && !done && !reading { history() }
            }
        case let .inspected(request, work, error):
            guard request == inspectRequest, online else { return }; inspectRequest = nil
            guard let work, work.session == (route?.session ?? selected?.id) else { historyError = error ?? "来源会话暂不可达"; return }
            detailWork = work
            if route != nil {
                archived = work.archived; selection = [work.session]; selectionAfterRefresh = selection
                refresh(); if entries.isEmpty && events.isEmpty { next = nil; done = false; history() }
            }
        case let .historyResult(request, service, session, entries, events, currentRequests, next, done, error):
            guard request == historyRequest, service == identity?.serviceInstance,
                  session == (selected?.id ?? route?.session), online else { return }
            historyRequest = nil; reading = false; historyError = error
            guard let entries else { return }
            if let events { self.events = events }
            if let currentRequests { self.currentRequests = currentRequests }
            self.entries += entries.filter { row in !self.entries.contains { $0.id == row.id } }
            if !refreshingCurrent { self.next = next; self.done = done }
        case let .managed(request, service, results):
            guard request == manageRequest, service == identity?.serviceInstance, online else { return }
            manageRequest = nil; busy = false
            let failures = results.filter { !$0.ok }, successes = results.filter(\.ok)
            operationMessage = failures.isEmpty ? "已完成 \(successes.count) 项" : failures.map { result in
                "\(rows.first { $0.id == result.session }?.displayTitle ?? result.session)：\(result.error ?? "操作失败")"
            }.joined(separator: "\n")
            if results.contains(where: { $0.action == "rename" && $0.ok }) { rename = nil }
            if failures.isEmpty, successes.contains(where: { $0.action == "restore" }) {
                archived = false; selectionAfterRefresh = Set(successes.map(\.session))
            } else if !failures.isEmpty { selectionAfterRefresh = Set(failures.map(\.session)) }
            refresh()
            if route != nil { locate() }
        default: break
        }
    }
}

struct SessionWindow: View {
    @ObservedObject var model: SessionBrowserModel
    @FocusState private var searchFocused: Bool
    @State private var ordinaryPosition = ScrollPosition(idType: String.self)
    @State private var archivedPosition = ScrollPosition(idType: String.self)
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                if geometry.size.width >= 700 || !model.compactDetail {
                    HStack(spacing: 10) {
                        MagicIcon(name: "bubble.left.and.bubble.right", size: 32)
                        Text("会话").font(.title3.weight(.semibold))
                        MagicBadge(text: "\(model.rows.count)", color: .secondary)
                        Spacer()
                        if model.loading { ProgressView().controlSize(.small) }
                    }.padding(.horizontal, 18).padding(.top, 14)
                    ViewThatFits(in: .horizontal) {
                        HStack { viewPicker; workspacePicker; searchField.frame(minWidth: 180); refreshButton }
                        VStack(alignment: .leading, spacing: 8) {
                            HStack { viewPicker; Spacer(); refreshButton }
                            HStack(spacing: 8) { workspacePicker.frame(width: 150); searchField }
                        }
                    }.padding(.horizontal, 18).padding(.vertical, 12)
                }
                if !model.online { Text("Magic Engine 未连接 · 以下为上次快照").foregroundStyle(.secondary).padding(8) }
                if let error = model.error { HStack { Text(error); Button("重试") { model.refresh() } }.padding(8) }
                if let message = model.operationMessage { Text(message).font(.callout).textSelection(.enabled).padding(8) }
                Divider()
                if geometry.size.width < 700 {
                    if model.compactDetail {
                        VStack(alignment: .leading, spacing: 14) { Button("会话列表", systemImage: "chevron.left") { model.showCatalog() }; detail }.padding(18)
                    } else { catalog }
                } else {
                    HSplitView { catalog.frame(minWidth: 230, idealWidth: 300, maxWidth: 340); detail.frame(minWidth: 320).padding(24) }
                }
            }
        }
        .frame(minWidth: 460, minHeight: 420)
        .background(MagicStyle.canvas).tint(MagicStyle.accent)
        .background(InitialContentFocus())
        .onChange(of: model.workspace) { _, _ in model.refresh() }
        .onChange(of: model.search) { _, _ in model.refresh() }
        .onChange(of: model.selection) { _, _ in model.choose() }
        .onChange(of: model.historyExpanded) { _, expanded in if expanded, model.entries.isEmpty { model.history() } }
        .background(Button("") { model.showCatalog(); searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden())
    }
    private var viewPicker: some View {
        Picker("会话", selection: Binding(get: { model.archived }, set: { model.switchView($0) })) {
            Text("普通").tag(false); Text("已归档").tag(true)
        }.pickerStyle(.segmented).labelsHidden().fixedSize()
    }
    private var workspacePicker: some View {
        Picker("工作区", selection: $model.workspace) {
            Text("全部工作区").tag([String]())
            ForEach(model.workspaces, id: \.self) { roots in Text(roots.joined(separator: " · ")).tag(roots) }
        }.labelsHidden().frame(minWidth: 120, maxWidth: 250)
    }
    private var searchField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("搜索会话名称", text: $model.search).textFieldStyle(.plain).focused($searchFocused)
        }.padding(7).background(MagicStyle.surface, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(MagicStyle.border))
    }
    private var refreshButton: some View {
        Button("刷新", systemImage: "arrow.clockwise") { model.refresh() }.labelStyle(.iconOnly).disabled(!model.online)
    }
    private var catalog: some View {
        VStack(spacing: 0) {
            if model.loading && model.rows.isEmpty { ProgressView("正在读取会话…") }
            else if model.rows.isEmpty {
                Text(model.search.isEmpty && model.workspace.isEmpty ? "这里还没有会话" : "没有匹配的会话").foregroundStyle(.secondary).padding()
            }
            List(selection: $model.selection) {
                ForEach(model.rows) { row in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: row.archived ? "archivebox" : row.state.symbol).foregroundStyle(row.archived ? .secondary : row.state.color)
                            Text(row.displayTitle).font(.system(size: 13, weight: .medium)).lineLimit(2)
                        }
                        if let count = model.online ? row.backgroundText : "后台命令数量待确认" { Text(count).font(.caption).foregroundStyle(.secondary) }
                        if let preview = row.recentProgress ?? row.recentInput { Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        HStack(spacing: 4) {
                            Image(systemName: "folder")
                            Text((row.workspace ?? []).map { URL(fileURLWithPath: $0).lastPathComponent }.joined(separator: " · ")).lineLimit(1)
                            Spacer(minLength: 4)
                            Text(Date(timeIntervalSince1970: row.at / 1000), style: .date)
                        }.font(.system(size: 11)).foregroundStyle(.secondary)
                        if row.state == .waiting || row.terminalOpen {
                            HStack(spacing: 6) {
                                if row.state == .waiting { MagicBadge(text: row.state.title) }
                                if row.terminalOpen { MagicBadge(text: "终端已打开", color: .secondary) }
                            }
                        }
                    }.padding(12).frame(maxWidth: .infinity, alignment: .leading)
                        .background(model.selection.contains(row.id) ? MagicStyle.accent.opacity(0.09) : MagicStyle.surface, in: RoundedRectangle(cornerRadius: 11))
                        .overlay(RoundedRectangle(cornerRadius: 11).strokeBorder(model.selection.contains(row.id) ? MagicStyle.accent.opacity(0.4) : MagicStyle.border))
                        .padding(.vertical, 3).tag(row.id).listRowSeparator(.hidden)
                        .contentShape(Rectangle())
                        .simultaneousGesture(TapGesture().onEnded {
                            guard NSEvent.modifierFlags.intersection([.shift, .command, .control]).isEmpty else { return }
                            model.showDetail(row.id)
                        })
                }
            }.listStyle(.plain).scrollContentBackground(.hidden).scrollPosition(model.archived ? $archivedPosition : $ordinaryPosition)
                .onKeyPress(.return) {
                    guard !model.selection.isEmpty else { return .ignored }
                    model.showDetail(); return .handled
                }
            Label("归档保留记录，恢复后手动接回", systemImage: "archivebox").font(.system(size: 11)).foregroundStyle(.secondary).padding(12)
        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(MagicStyle.canvas)
    }
    @ViewBuilder private var detail: some View {
        if model.selection.count > 1 {
            VStack(alignment: .leading, spacing: 16) {
                Text("已选择 \(model.selection.count) 项会话").font(.title2)
                if !model.eligible.isEmpty {
                    Button("\(model.archived ? "恢复" : "归档") \(model.eligible.count) 项") {
                        model.manage(model.eligible.map { SessionManagement(session: $0.id, action: model.archived ? "restore" : "archive") })
                    }.disabled(model.busy || !model.online)
                }
                if model.eligible.count < model.selection.count { Text("其余会话正在执行或状态尚未确认，未纳入本次归档。").foregroundStyle(.secondary) }
                Spacer()
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else if let row = model.selected {
            reading(row).id(row.id)
        } else if model.route != nil {
            VStack { Text("正在定位通知来源"); if let error = model.historyError { Text(error).textSelection(.enabled) }; Button("重新读取") { model.retryLocation() }.disabled(!model.online) }
        } else {
            VStack(spacing: 14) {
                MagicIcon(name: "text.bubble", size: 56)
                Text("选择一段会话").font(.title3.weight(.medium))
                Text("查看交代、进展与保存的记录").font(.callout).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
    private func reading(_ row: NativeSession) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.rename != nil && !row.archived {
                        TextField("会话名称", text: Binding(get: { model.rename ?? "" }, set: { model.rename = $0 }))
                            .textFieldStyle(.roundedBorder).controlSize(.large)
                            .onSubmit { model.manage([SessionManagement(session: row.id, action: "rename", title: model.rename)]) }
                            .onExitCommand { model.rename = nil }
                        HStack {
                            Button("取消") { model.rename = nil }
                            Button("保存名称") { model.manage([SessionManagement(session: row.id, action: "rename", title: model.rename)]) }
                                .buttonStyle(.borderedProminent).disabled(model.busy || !model.online)
                        }
                    } else { Text(row.displayTitle).font(.system(size: 25, weight: .semibold)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                    Label((row.workspace ?? []).joined(separator: "\n"), systemImage: "folder").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    HStack(spacing: 8) {
                        MagicBadge(text: row.archived ? "已归档" : row.state.title, color: row.archived ? .secondary : row.state.color)
                        if row.terminalOpen { MagicBadge(text: "已在终端打开", color: .secondary) }
                    }
                    if let reason = row.reason, reason != row.state.title { Text(reason).font(.callout).foregroundStyle(.secondary) }
                    HStack {
                        if row.archived { Button("恢复会话", systemImage: "arrow.uturn.backward") { model.manage([SessionManagement(session: row.id, action: "restore")]) }.buttonStyle(.borderedProminent).disabled(model.busy || !model.online) }
                        else { Button("复制接回命令", systemImage: "terminal") { model.copySelected() }.buttonStyle(.borderedProminent).disabled(!model.online) }
                        if !row.archived { Menu("更多") {
                            Button("改名") { model.rename = row.displayTitle }
                            if row.canArchive { Button("归档") { model.manage([SessionManagement(session: row.id, action: "archive")]) } }
                        }.disabled(model.busy || !model.online) }
                    }.controlSize(.large)
                    if row.archived { Text("恢复后保留全部记录；需要在终端手动接回才能继续。").font(.caption).foregroundStyle(.secondary) }
                    Divider().padding(.vertical, 4)
                    if let route = model.route {
                        SettingsCard(title: "原提醒") {
                            if route.notice.source == nil { Text("提醒未保存来源引用；以下可查看会话记录，无法确定对应条目。").font(.caption).foregroundStyle(.secondary) }
                            Text(route.notice.detail ?? "此提醒没有保存正文；请查看来源记录。").textSelection(.enabled)
                            ForEach(model.events) { event in eventContent(event) }
                            if let error = model.historyError { Text(error).foregroundStyle(.secondary); Button("重新读取") { model.retryLocation() } }
                            Text(model.routeIsCurrent ? "对应当前关注原因" : "这是此前的来源；当前状态以本页会话状态为准。").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        if let input = row.recentInput { SettingsCard(title: "最近交代") { Text(input).font(.callout).lineSpacing(4).textSelection(.enabled) } }
                        if let progress = row.recentProgress { SettingsCard(title: "实际进展") { Text(progress).font(.callout).lineSpacing(4).textSelection(.enabled) } }
                    }
                    if !row.archived && !model.currentRequests.isEmpty {
                        SettingsCard(title: "需要你的答复") {
                            Label("请在终端答复；查看不会批准请求。", systemImage: "terminal").font(.caption).foregroundStyle(.secondary)
                            ForEach(model.currentRequests) { event in eventContent(event) }
                        }.overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(MagicStyle.accent.opacity(0.35)))
                    }
                    if let members = model.detailWork?.members, !members.isEmpty {
                        Menu(model.memberSession.flatMap { id in members.first { $0.session == id }?.name } ?? "入口会话记录") {
                            Button("入口会话记录") { model.chooseMember(nil) }
                            ForEach(members) { member in Button(member.name) { model.chooseMember(member.session) } }
                        }
                    }
                    DisclosureGroup(isExpanded: $model.historyExpanded) {
                        LazyVStack(alignment: .leading, spacing: 16) {
                            ForEach(model.entries) { entry in
                                let notice = model.readingNotice
                                HistoryRow(entry: entry, targeted: notice?.source?.entry == entry.id).id(entry.id)
                            }
                            if model.reading { ProgressView("正在读取记录…") }
                            else if !model.done { Button("继续读取") { model.history() } }
                            if let error = model.historyError { Text(error).foregroundStyle(.secondary); Button("重新读取") { model.history() } }
                        }.padding(.top, 8)
                    } label: { Label("历史记录", systemImage: "clock.arrow.circlepath").font(.headline).padding(.vertical, 8) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }
            .onAppear { model.detailVisible(session: row.id, visible: true) }
            .onDisappear { model.detailVisible(session: row.id, visible: false) }
            .onChange(of: model.active) { _, active in if active { model.detailVisible(session: row.id, visible: true) } }
            .onChange(of: model.readingNotice?.id) { _, _ in model.detailVisible(session: row.id, visible: true) }
            .onChange(of: model.entries.map(\.id)) { previous, ids in
                if let target = model.route?.notice.source?.entry, !previous.contains(target), ids.contains(target) { proxy.scrollTo(target, anchor: .center) }
            }
        }
    }
    private func eventContent(_ event: HistoryEvent) -> some View {
        Text(event.text).textSelection(.enabled)
    }
}

private struct HistoryRow: View {
    let entry: HistoryEntry
    let targeted: Bool
    @State private var expanded = false
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if entry.kind == "assistant" { MagicBrandIcon(size: 26) }
                else { MagicIcon(name: entry.kind == "user" ? "person" : entry.kind.hasPrefix("tool-") ? "wrench.and.screwdriver" : entry.kind == "agent-message" ? "person.2" : "text.alignleft", size: 26) }
                Text(["user": "你", "assistant": "Magic Code", "tool-call": "工具调用", "tool-result": "工具结果", "agent-message": "协作消息", "summary": "摘要"][entry.kind] ?? entry.kind).font(.callout.weight(.medium))
                if targeted { MagicBadge(text: "提醒来源") }
            }
            if entry.kind.hasPrefix("tool-") && !targeted {
                DisclosureGroup("查看保存的工具内容", isExpanded: $expanded) { Text(entry.text).textSelection(.enabled) }
            } else {
                Text(entry.text).font(.callout).lineSpacing(4).textSelection(.enabled)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
            .background(targeted ? MagicStyle.accent.opacity(0.08) : MagicStyle.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(targeted ? MagicStyle.accent.opacity(0.4) : MagicStyle.border))
    }
}
