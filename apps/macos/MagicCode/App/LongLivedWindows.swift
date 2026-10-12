import SwiftUI
import AppKit
import Combine

/// 「长期窗口」＝主窗口与显式调试窗口。它们**在前台存在**时 App 才是 `.regular`：
/// Dock 里有图标、Cmd+Tab 切得到，窗口被别的窗口盖住也找得回来；**全部关掉**就回 `.accessory`（菜单栏形态）。
/// 菜单栏那块**瞬时面板不登记在这里**——它不是长期窗口，为它切策略会让 Dock 图标每点一次菜单栏就闪一下。
@MainActor final class LongLivedWindows {
    static let shared = LongLivedWindows()
    /// 注入点：测试里换掉这两个闭包，就能只判「该不该切、真切了几次」，不去动真实进程的策略。
    var current: () -> NSApplication.ActivationPolicy = { NSApp?.activationPolicy() ?? .accessory }
    var apply: (NSApplication.ActivationPolicy) -> Void = { NSApp?.setActivationPolicy($0) }
    /// 只记**真的换了**的那几次（含时间与触发者）；「展开面板时 Dock 图标不闪」读它有没有多出一条。
    private(set) var transitions: [String] = []
    /// 验证装置用：每次真的切换时喊一声（不切不喊），带毫秒——用来判「那一下到底眨没眨」。
    var record: ((String) -> Void)?
    private var registered: [ObjectIdentifier: NSWindow] = [:]
    private var watching: [ObjectIdentifier: [NSKeyValueObservation]] = [:]
    private let observing: Bool

    /// `observing: false` 给测试：只要结算逻辑，不去盯真窗口。
    init(observing: Bool = true) { self.observing = observing }

    /// 窗口还在（可见）就算「在前台存在」。
    static func present(_ window: NSWindow) -> Bool { window.isVisible || window.isMiniaturized }
    var presentCount: Int { registered.values.filter(Self.present).count }
    var policyName: String { current() == .regular ? "regular" : "accessory" }

    func register(_ window: NSWindow) {
        let key = ObjectIdentifier(window)
        guard registered[key] == nil else { return }
        registered[key] = window
        if observing {
            // 可见性同时覆盖 close 和 orderOut，不能只靠焦点变化结算 Dock 策略。
            watching[key] = [window.observe(\.isVisible, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { _ = self?.settle(reason: "isVisible") }
            }]
        }
        settle(reason: "register")
    }
    /// 结算一次：还有一条「在前台存在」的长期窗口 ⇒ `.regular`，否则 `.accessory`。
    /// 幂等——策略没变就不调 `setActivationPolicy`，也不记一条（面板开合走的正是这条无声路）。
    @discardableResult
    func settle(reason: String) -> NSApplication.ActivationPolicy {
        let wanted: NSApplication.ActivationPolicy = presentCount > 0 ? .regular : .accessory
        guard current() != wanted else { return wanted }
        apply(wanted)
        let entry = "\(String(format: "%.3f", Date().timeIntervalSince1970)) \(wanted == .regular ? "regular" : "accessory") ← \(reason)"
        transitions.append(entry)
        if transitions.count > 64 { transitions.removeFirst(transitions.count - 64) }
        record?(entry)
        return wanted
    }
}

struct MainWindowView: View {
    @ObservedObject var model: AppModel
    var body: some View {
        MainWindowPages(model: model)
            .frame(minWidth: 460, minHeight: 480)
            .background(MagicStyle.canvas).tint(MagicStyle.accent)
            .toolbar {
                if model.mainPage == .settings {
                    ToolbarItem(placement: .navigation) {
                        Button("返回会话", systemImage: "chevron.left") { model.manageSessions() }
                            .labelStyle(.titleAndIcon).accessibilityIdentifier("main-return-sessions")
                    }
                } else {
                    ToolbarItem(placement: .primaryAction) {
                        Button("应用设置", systemImage: "gearshape") { model.manageSettings() }
                            .labelStyle(.iconOnly).help("应用设置 · ⌘,").accessibilityIdentifier("main-open-settings")
                    }
                }
            }
    }
}

/// 隐藏原生分页控件，只保留页面实例与可见性管理，让返回时的滚动、搜索和草稿保持原位。
private struct MainWindowPages: NSViewRepresentable {
    @ObservedObject var model: AppModel
    func makeNSView(context: Context) -> NSTabView {
        let pages = NSTabView()
        pages.tabViewType = .noTabsNoBorder
        pages.addTabViewItem(NSTabViewItem(viewController: NSHostingController(rootView: SessionWindow(model: model.sessions))))
        pages.addTabViewItem(NSTabViewItem(viewController: NSHostingController(rootView: SettingsView(model: model))))
        return pages
    }
    func updateNSView(_ pages: NSTabView, context: Context) {
        let index = model.mainPage == .sessions ? 0 : 1
        if pages.selectedTabViewItem !== pages.tabViewItem(at: index) { pages.selectTabViewItem(at: index) }
    }
}

@MainActor final class MainWindowController: NSObject, NSWindowDelegate {
    private let model: AppModel
    private var observations = Set<AnyCancellable>()
    private(set) var window: NSWindow?
    init(model: AppModel) {
        self.model = model
        super.init()
        model.$mainPage.sink { [weak self] page in
            guard let self else { return }
            self.model.sessions.windowActive(page == .sessions && self.window?.isKeyWindow == true && NSApp.isActive)
        }.store(in: &observations)
        NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)
            .merge(with: NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification))
            .sink { [weak self] _ in self?.updateVisibility() }.store(in: &observations)
    }
    func show() {
        if window == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 760), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
            window.title = "Magic Code"; window.isReleasedWhenClosed = false
            let content = NSHostingController(rootView: MainWindowView(model: model))
            content.sizingOptions = [.minSize]
            window.contentViewController = content; window.delegate = self
            window.setContentSize(NSSize(width: 1000, height: 760)); window.center()
            self.window = window
            LongLivedWindows.shared.register(window)
        }
        window?.deminiaturize(nil); window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        updateVisibility()
    }
    private func updateVisibility() { model.sessions.windowActive(model.mainPage == .sessions && window?.isKeyWindow == true && NSApp.isActive) }
    func windowDidBecomeKey(_ notification: Notification) { updateVisibility() }
    func windowDidResignKey(_ notification: Notification) { model.sessions.windowActive(false) }
    func windowWillClose(_ notification: Notification) { model.sessions.close() }
}

/// Give a newly attached surface a neutral initial focus; normal Tab navigation remains native.
struct InitialContentFocus: NSViewRepresentable {
    final class FocusView: NSView {
        override var acceptsFirstResponder: Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard let window else { return }
            window.initialFirstResponder = self
            window.makeFirstResponder(self)
        }
    }
    func makeNSView(context: Context) -> FocusView { FocusView() }
    func updateNSView(_ view: FocusView, context: Context) {}
}
