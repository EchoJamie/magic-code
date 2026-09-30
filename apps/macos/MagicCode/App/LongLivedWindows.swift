import SwiftUI
import AppKit

/// 「长期窗口」＝设置窗口、通知/事项定位窗口。它们**在前台存在**时 App 才是 `.regular`：
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
    /// 不含「最小化」——长期窗口当前都不可最小化：设置窗口与定位窗口的 styleMask 都没有 `.miniaturizable`
    /// （实测：那颗黄按钮在，但 `AXEnabled=false`、`AXMinimizable=false`，点了不动）。真能最小化时才需要把它算回来。
    static func present(_ window: NSWindow) -> Bool { window.isVisible }
    var presentCount: Int { registered.values.filter(Self.present).count }
    var policyName: String { current() == .regular ? "regular" : "accessory" }

    func register(_ window: NSWindow) {
        let key = ObjectIdentifier(window)
        guard registered[key] == nil else { return }
        registered[key] = window
        if observing {
            // 盯「窗口还在不在」这件事本身。AppKit **没有**「被 order out 了」这条通知——
            // 关掉设置窗口走的正是 order out（不是 close），只盯 didBecomeKey 会让 Dock 图标留在那儿下不来。
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

/// 把承载它的窗口登记为长期窗口；挂在设置窗口的内容上，窗口出现即登记。
struct LongLivedWindowMarker: NSViewRepresentable {
    final class Marker: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { LongLivedWindows.shared.register(window) }
        }
    }
    func makeNSView(context: Context) -> Marker { Marker() }
    func updateNSView(_ view: Marker, context: Context) {}
}
