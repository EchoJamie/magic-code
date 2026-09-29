// U104 装置：长期窗口 ⇒ Dock 图标与 Cmd+Tab 的三态实测。
//
// 三项判据都要**真的东西**，不判「代码里调了 setActivationPolicy」：
//   ① 设置窗口在前台存在 ⇒ Dock 里真有图标、Cmd+Tab 真切得到（真点子项、真按键、真截图）；
//   ② 长期窗口全部关掉 ⇒ Dock 与 Cmd+Tab 里都没有它（真点关闭按钮、真截图）；
//   ③ 点菜单栏展开那块瞬时面板 ⇒ 不闪（面板开着时 Dock 无图标，且策略读数一条切换都没多）。
//
// 用法（先 build.sh 出开发包）：
//   xcrun swiftc -O scripts/macos/dock-cmdtab-probe.swift -o /tmp/dock-cmdtab-probe
//   /tmp/dock-cmdtab-probe --app ".artifacts/macos/Magic Code Dev.app" --root /private/tmp/u104-accept --out .artifacts/macos/u104
// `--pid` 用已启动的实例（开发时用；正式跑不给它，装置自己起、自己收）。
//
// 需要辅助功能授权（真点子项、真按 Cmd+Tab、真移鼠标露出 Dock）。不写用户数据：App 以 `--validation-root` 隔离启动。
import AppKit
import ApplicationServices

// MARK: - 现场

let screen = NSScreen.screens[0].frame
var out = URL(fileURLWithPath: ".artifacts/macos/u104")
var root = URL(fileURLWithPath: "/private/tmp/u104-accept")
var appURL = URL(fileURLWithPath: ".artifacts/macos/Magic Code Dev.app")
var given: pid_t = 0
var pid: pid_t = 0
var app: NSRunningApplication?
var observations: [String: Any] = [:]
var failures: [String] = []

func note(_ text: String) { print("· \(text)"); fflush(stdout) }
func fail(_ text: String) { failures.append(text); print("✘ \(text)"); fflush(stdout) }
func check(_ condition: Bool, _ text: String) { condition ? note("✓ \(text)") : fail(text) }

// MARK: - 截图与鼠标

func y(_ value: CGFloat) -> CGFloat { screen.maxY - value }   // 左下 → 左上（CGEvent 与 screencapture 都是左上原点）

@discardableResult
func capture(_ name: String, region: CGRect? = nil) -> URL {
    let url = out.appendingPathComponent(name + ".png")
    var args = ["-x"]
    if let region { args += ["-R", "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))"] }
    args.append(url.path)
    let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); process.arguments = args
    try? process.run(); process.waitUntilExit()
    return url
}
func moveMouse(to point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}
/// 真鼠标点击（菜单栏那块面板不吃 AXPress：用真按下去的那一下）。
func click(at point: CGPoint) {
    moveMouse(to: point); Thread.sleep(forTimeInterval: 0.3)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}
/// 停到屏幕中间偏上：别压在窗口正文上，也别贴着 Dock 边缘。
func parkMouse() { moveMouse(to: CGPoint(x: screen.midX, y: y(screen.maxY * 0.25))) }

func dockOrientation() -> String { UserDefaults(suiteName: "com.apple.dock")?.string(forKey: "orientation") ?? "bottom" }
/// Dock 此刻在不在屏上（它自己那扇窗）。截图前先确认，免得把「Dock 没浮出来」当成「Dock 里没有它」。
func dockShown() -> Bool {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
    return list.contains { ($0[kCGWindowOwnerName as String] as? String) == "Dock" }
}
/// 把鼠标压到 Dock 那一条边上，等它真浮出来。
func revealDock() {
    switch dockOrientation() {
    case "left": moveMouse(to: CGPoint(x: 1, y: y(screen.midY)))
    case "right": moveMouse(to: CGPoint(x: screen.maxX - 1, y: y(screen.midY)))
    default: moveMouse(to: CGPoint(x: screen.midX, y: screen.maxY - 1))
    }
    for _ in 0..<30 { if dockShown() { break }; Thread.sleep(forTimeInterval: 0.15) }
    Thread.sleep(forTimeInterval: 0.4)
    check(dockShown(), "Dock 真的浮出来了（这一帧才算得上判据）")
}
/// Dock 帧的统一口径：先让陪练应用在最前——Dock 是半透明的，背后那扇窗不同，几张帧就没法比。
func captureDock(_ name: String) {
    if let rival = rivalApp() { activate(rival) }
    revealDock(); capture(name, region: dockRegion())
}
func dockRegion() -> CGRect {
    switch dockOrientation() {
    case "left": return CGRect(x: 0, y: 0, width: 170, height: screen.height)
    case "right": return CGRect(x: screen.maxX - 170, y: 0, width: 170, height: screen.height)
    default: return CGRect(x: 0, y: screen.maxY - 170, width: screen.width, height: 170)
    }
}
func menuBarRegion() -> CGRect { CGRect(x: 0, y: 0, width: screen.width, height: 30) }

// MARK: - 键盘（Cmd+Tab）

func key(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags
    event?.post(tap: .cghidEventTap)
}
/// 按住 Cmd 敲一下 Tab（切到上一个应用），按住不放时截图，再松手。
@discardableResult
func commandTab(captureSwitcher name: String?) -> pid_t {
    let command: CGKeyCode = 0x37, tab: CGKeyCode = 0x30
    key(command, down: true, flags: .maskCommand); Thread.sleep(forTimeInterval: 0.25)
    key(tab, down: true, flags: .maskCommand); Thread.sleep(forTimeInterval: 0.45)
    if let name { capture(name, region: CGRect(x: screen.midX - 700, y: screen.midY - 280, width: 1400, height: 560)) }
    Thread.sleep(forTimeInterval: 0.2)
    key(tab, down: false, flags: .maskCommand); key(command, down: false, flags: [])
    Thread.sleep(forTimeInterval: 0.7)
    return NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
}
func frontmost() -> pid_t { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0 }
/// 按住 Cmd 连敲 Tab，一步一步走；每步留一帧，落在 `target` 上就算到得了。
func commandTabWalk(to target: pid_t, prefix: String, limit: Int = 6) -> [String] {
    var steps: [String] = []
    for step in 1...limit {
        let front = commandTab(captureSwitcher: "\(prefix)-第\(step)步")
        steps.append("第\(step)步 → pid=\(front)\(front == target ? "（本 App）" : "")")
        if front == target { break }
    }
    return steps
}
func activate(_ target: pid_t) {
    NSRunningApplication(processIdentifier: target)?.activate()
    Thread.sleep(forTimeInterval: 0.8)
}

// MARK: - 无障碍（真点子项、真点按钮）

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func flag(_ element: AXUIElement, _ name: String) -> Bool? { (attribute(element, name) as? NSNumber)?.boolValue }
func size(_ element: AXUIElement) -> CGSize {
    guard let raw = attribute(element, kAXSizeAttribute) else { return .zero }
    var size = CGSize.zero; AXValueGetValue(raw as! AXValue, .cgSize, &size); return size
}
func position(_ element: AXUIElement) -> CGPoint {
    guard let raw = attribute(element, kAXPositionAttribute) else { return .zero }
    var point = CGPoint.zero; AXValueGetValue(raw as! AXValue, .cgPoint, &point); return point
}
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func press(_ element: AXUIElement) -> Bool { AXUIElementPerformAction(element, kAXPressAction as CFString) == .success }
func walk(_ element: AXUIElement, _ depth: Int = 0, _ visit: (AXUIElement, Int) -> Bool) -> AXUIElement? {
    if visit(element, depth) { return element }
    guard depth < 12 else { return nil }
    for child in children(element) { if let found = walk(child, depth + 1, visit) { return found } }
    return nil
}
func applicationElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }
func statusItem(_ pid: pid_t) -> AXUIElement? {
    guard let bar = attribute(applicationElement(pid), "AXExtrasMenuBar") else { return nil }
    return children(bar as! AXUIElement).first
}
func windowElement(_ pid: pid_t, where matches: (AXUIElement) -> Bool) -> AXUIElement? {
    let windows = attribute(applicationElement(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
    return windows.first(where: matches)
}

// MARK: - App 的读数与窗口现场

func readout() -> [String: Any] {
    let path = root.appendingPathComponent("activation-policy.json")
    guard let data = try? Data(contentsOf: path), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
    return json
}
func policyReadout() -> String { readout()["policy"] as? String ?? "?" }
func changes() -> [String] { readout()["changes"] as? [String] ?? [] }
/// 本 App 真在屏上的「内容窗口」（面板/设置/定位窗）；菜单栏那块的图标窗很小，按宽度滤掉。
func appWindows(_ pid: pid_t) -> [[String: Any]] {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return list.filter {
        guard ($0[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { return false }
        let bounds = $0[kCGWindowBounds as String] as? [String: Any] ?? [:]
        return (bounds["Width"] as? Double ?? 0) > 200
    }
}

/// 采样器：一边做事一边盯住策略读数与真实进程策略，抓「闪一下」。
final class Sampler {
    private let lock = NSLock()
    private var rows: [[String: Any]] = []
    private var running = false
    private var thread: Thread?
    func start() {
        running = true
        thread = Thread { [self] in
            while running {
                var row: [String: Any] = ["t": Date().timeIntervalSince1970]
                row["readout"] = policyReadout(); row["presentWindows"] = readout()["presentWindows"] as? Int ?? -1
                row["changes"] = changes().count
                row["runningApplication"] = app?.activationPolicy == .regular ? "regular" : "accessory"
                lock.lock(); rows.append(row); lock.unlock()
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        thread?.start()
    }
    func stop(_ name: String) -> [[String: Any]] {
        running = false; Thread.sleep(forTimeInterval: 0.15)
        lock.lock(); let taken = rows; rows = []; lock.unlock()
        if let data = try? JSONSerialization.data(withJSONObject: taken, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: out.appendingPathComponent(name + ".json"))
        }
        return taken
    }
}

// MARK: - 参数

var arguments = Array(CommandLine.arguments.dropFirst())
while let flag = arguments.first {
    arguments.removeFirst()
    func value() -> String { arguments.isEmpty ? "" : arguments.removeFirst() }
    switch flag {
    case "--app": appURL = URL(fileURLWithPath: value())
    case "--root": root = URL(fileURLWithPath: value())
    case "--out": out = URL(fileURLWithPath: value())
    case "--pid": given = pid_t(value()) ?? 0
    default: print("未知参数 \(flag)"); exit(2)
    }
}
try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

func rivalApp() -> pid_t? {
    // 陪练：一个正常的前台应用，用来给 Cmd+Tab 一个起点。不碰它的窗口内容。
    let candidates = ["com.mitchellh.ghostty", "com.apple.finder"]
    for identifier in candidates {
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first, running.processIdentifier != pid {
            return running.processIdentifier
        }
    }
    return nil
}

// MARK: - 起 App

func launch() {
    let log = out.appendingPathComponent("launch.stdout.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let handle = try! FileHandle(forWritingTo: log)
    let process = Process()
    process.executableURL = appURL.appendingPathComponent("Contents/MacOS/MagicCode")
    process.arguments = ["--validation-root", root.path]
    var environment = ["HOME": root.path, "PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh", "LANG": "zh_CN.UTF-8"]
    environment["MAGIC_HOME"] = root.path
    process.environment = environment
    process.standardOutput = handle; process.standardError = handle
    try! process.run()
    pid = process.processIdentifier
    note("启动 \(appURL.lastPathComponent) pid=\(pid) 隔离根=\(root.path)")
    // 等 app.ready（事件流里那一条），再等读数文件出现（装置只认它自己的读数，不认「等了多久」）。
    for _ in 0..<120 {
        let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        if text.contains("\"app.ready\""), policyReadout() != "?" { break }
        Thread.sleep(forTimeInterval: 0.25)
    }
    check(policyReadout() != "?", "App 起来了，策略读数已经在写（policy=\(policyReadout())）")
    Thread.sleep(forTimeInterval: 1.5)
}
func quitApp() {
    guard let app else { return }
    note("请求正常退出（等价于用户退出，走宿主收尾）")
    app.terminate()
    var gone = false
    for _ in 0..<120 {
        if app.isTerminated || kill(pid, 0) != 0 { gone = true; break }
        Thread.sleep(forTimeInterval: 0.5)
    }
    check(gone, "App 已正常退出（进程真的没了）")
    let log = (try? String(contentsOf: out.appendingPathComponent("launch.stdout.log"), encoding: .utf8)) ?? ""
    check(log.contains("app.clean-exit"), "收尾事件里有 app.clean-exit")
}

// MARK: - 三态

func settingsWindow() -> AXUIElement? {
    windowElement(pid, where: { text($0, kAXTitleAttribute) != "" && size($0).width > 400 })
}

func stateNoWindow() -> [String: Any] {
    note("【一】没有任何长期窗口")
    let before = changes().count
    check(policyReadout() == "accessory", "读数：策略是 accessory（读数=\(policyReadout())）")
    check(readout()["presentWindows"] as? Int == 0, "账上一条「在前台存在的长期窗口」都没有")
    captureDock("state1-无窗口-Dock")
    var steps: [String] = []
    if let rival = rivalApp() {
        activate(rival)
        steps = commandTabWalk(to: pid, prefix: "state1-无窗口-CmdTab")
        check(!steps.contains { $0.contains("（本 App）") }, "Cmd+Tab 走遍一圈都切不到它：\(steps.joined(separator: "；"))")
        check(changes().count == before, "这一趟没有发生策略切换（\(before) → \(changes().count)）")
    } else { fail("找不到陪练应用，Cmd+Tab 这一条没测") }
    parkMouse()
    return ["policy": policyReadout(), "changes": before, "cmdTab": steps]
}

func statePanel() -> [String: Any] {
    note("【三】只点菜单栏，展开那块瞬时面板")
    guard let item = statusItem(pid) else { fail("找不到菜单栏项"); return [:] }
    let before = changes()
    let sampler = Sampler(); sampler.start()
    let itemFrame = CGRect(origin: position(item), size: size(item))
    click(at: CGPoint(x: itemFrame.midX, y: itemFrame.midY))
    note("真鼠标点击菜单栏项「\(text(item, kAXTitleAttribute))」@ (\(Int(itemFrame.midX)),\(Int(itemFrame.midY)))")
    Thread.sleep(forTimeInterval: 1.2)
    let panel = appWindows(pid)
    check(!panel.isEmpty, "面板窗口真的开了（本进程内容窗口 \(panel.count) 个）")
    let panelLeft = max(0, itemFrame.minX - 20)   // 面板挂在子项右侧，往右截
    capture("state3-面板-面板区", region: CGRect(x: panelLeft, y: 0, width: min(420, screen.maxX - panelLeft), height: 700))
    captureDock("state3-面板-Dock")
    let samples = sampler.stop("state3-面板-采样")
    check(changes().count == before.count, "面板展开期间一条策略切换都没有（\(before.count) → \(changes().count)）")
    check(!samples.contains { ($0["readout"] as? String) == "regular" }, "采样期间策略没变成过 regular（\(samples.count) 个样本）")
    check(policyReadout() == "accessory", "面板开着时策略仍是 accessory")
    check(readout()["presentWindows"] as? Int == 0, "面板不算长期窗口")
    return ["panelWindows": panel.count, "samples": samples.count, "changes": changes()]
}

func stateSettings() -> [String: Any] {
    note("【二】在面板里点「设置」——设置窗口是长期窗口")
    guard let button = walk(applicationElement(pid), 0, { element, _ in
        text(element, kAXRoleAttribute) == kAXButtonRole as String && text(element, kAXDescriptionAttribute).contains("打开 Magic Code 设置")
    }) else { fail("面板里找不到「设置」按钮"); return [:] }
    let before = changes().count
    let sampler = Sampler(); sampler.start()
    check(press(button), "真点「设置」按钮（AXPress）")
    var settings: AXUIElement?
    for _ in 0..<40 { settings = settingsWindow(); if settings != nil { break }; Thread.sleep(forTimeInterval: 0.25) }
    guard let settings else { fail("设置窗口没有出现"); return [:] }
    Thread.sleep(forTimeInterval: 1.0)
    let title = text(settings, kAXTitleAttribute), box = "\(Int(size(settings).width))x\(Int(size(settings).height))"
    note("设置窗口：title=«\(title)» size=\(box)；此刻前台=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?")")
    check(policyReadout() == "regular", "读数：策略切到 regular（读数=\(policyReadout())）")
    check(changes().count > before, "读数里记下了这一次切换：\(changes().suffix(1))")
    capture("state2-设置窗口-整屏")
    capture("state2-设置窗口-菜单栏", region: menuBarRegion())
    captureDock("state2-设置窗口-Dock")
    var steps: [String] = []
    if let rival = rivalApp() {
        activate(rival)
        check(frontmost() != pid, "先切到别的应用（前台=\(frontmost())）")
        steps = commandTabWalk(to: pid, prefix: "state2-设置窗口-CmdTab")
        check(steps.contains { $0.contains("（本 App）") }, "Cmd+Tab 切得到它：\(steps.joined(separator: "；"))")
        capture("state2-设置窗口-CmdTab切回后")
        check(policyReadout() == "regular", "切回来仍是 regular")
    } else { fail("找不到陪练应用，Cmd+Tab 这一条没测") }
    // 附：最小化的长期窗口不算「关掉」——它还在，Dock 图标就得在（否则那条 miniwindow 会跟着消失、窗口找不回来）。
    // 附：「最小化还算不算在」这一支有没有对象——看那颗黄按钮是不是灰的。
    // 实测：按钮在但 AXEnabled=false、窗口 AXMinimizable=false（styleMask 没有 .miniaturizable），
    // 所以判据只看 isVisible，装置也不去点它。真能最小化了再回来补这一支。
    if let rawMinimize = attribute(settings, kAXMinimizeButtonAttribute) {
        let minimize = rawMinimize as! AXUIElement
        observations["minimizable"] = flag(minimize, kAXEnabledAttribute) ?? false
        note("最小化按钮：AXEnabled=\(flag(minimize, kAXEnabledAttribute) ?? false) 窗口 AXMinimizable=\(flag(settings, "AXMinimizable") ?? false)")
    } else { observations["minimizable"] = false; note("设置窗口没有最小化按钮") }
    let samples = sampler.stop("state2-设置窗口-采样")
    check(samples.contains { ($0["readout"] as? String) == "regular" }, "采样里能看到策略变成 regular")
    parkMouse()
    return ["title": title, "size": box, "cmdTab": steps, "changes": changes()]
}

func stateClosed() -> [String: Any] {
    note("【四】关掉全部长期窗口")
    guard let settings = settingsWindow() else { fail("找不到设置窗口"); return [:] }
    let before = changes().count
    let sampler = Sampler(); sampler.start()
    guard let close = attribute(settings, kAXCloseButtonAttribute) else { fail("设置窗口没有关闭按钮"); return [:] }
    check(press(close as! AXUIElement), "真点设置窗口的关闭按钮（AXPress）")
    var settled = false
    for _ in 0..<40 { if policyReadout() == "accessory" { settled = true; break }; Thread.sleep(forTimeInterval: 0.25) }
    check(settled, "关掉之后读数回到 accessory（读数=\(policyReadout())）")
    check(readout()["presentWindows"] as? Int == 0, "账上长期窗口归零")
    check(changes().count > before, "读数里记下了回切：\(changes().suffix(1))")
    Thread.sleep(forTimeInterval: 2.0)          // 读数文件每 0.5 秒写一次：让它先把「关掉之后」写进去
    let samples = sampler.stop("state4-关掉-采样")
    check(samples.suffix(5).allSatisfy { ($0["readout"] as? String) == "accessory" }, "关掉之后 2 秒里一次都没变回 regular（末 5 个样本）")
    check(changes().count == before + 1, "这一段只发生了一次回切（\(before) → \(changes().count)）")
    captureDock("state4-关掉-Dock")
    var steps: [String] = []
    if let rival = rivalApp() {
        activate(rival)
        steps = commandTabWalk(to: pid, prefix: "state4-关掉-CmdTab")
        check(!steps.contains { $0.contains("（本 App）") }, "Cmd+Tab 里没有它了：\(steps.joined(separator: "；"))")
    }
    parkMouse()
    return ["changes": changes(), "cmdTab": steps]
}

// MARK: - 跑

guard AXIsProcessTrusted() else { print("缺辅助功能授权：装置要点真控件、发真按键。"); exit(3) }
note("屏幕 \(Int(screen.width))x\(Int(screen.height))，Dock 在\(dockOrientation())，截图与读数落在 \(out.path)")
if given != 0 { pid = given; note("用已启动的实例 pid=\(pid)") } else { launch() }
app = NSRunningApplication(processIdentifier: pid)
guard app != nil else { print("找不到进程 \(pid)"); exit(4) }
Thread.sleep(forTimeInterval: 1.0)

// 从「屏上一扇自己的窗都没有」开始：上一轮若把面板留在屏上，先点一下收起来。
if let item = statusItem(pid), !appWindows(pid).isEmpty {
    let frame = CGRect(origin: position(item), size: size(item))
    note("先收起上一轮留下的面板")
    click(at: CGPoint(x: frame.midX, y: frame.midY)); Thread.sleep(forTimeInterval: 1.2)
}

observations["state1"] = stateNoWindow()
observations["state3"] = statePanel()
observations["state2"] = stateSettings()
observations["state4"] = stateClosed()
observations["changes"] = changes()
// 策略台账：App 的事件流里那几条（带毫秒）单独抄一份，判「那一下到底眨没眨」。
let stream = (try? String(contentsOf: out.appendingPathComponent("launch.stdout.log"), encoding: .utf8)) ?? ""
let ledger = stream.split(separator: "\n").compactMap { line -> String? in
    guard let data = line.data(using: .utf8), let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          json["event"] as? String == "activation-policy" else { return nil }
    return json["detail"] as? String
}
try? ledger.joined(separator: "\n").appending("\n").write(to: out.appendingPathComponent("策略台账.txt"), atomically: true, encoding: .utf8)
note("策略台账（真切换）\(ledger.count) 条：\(ledger.joined(separator: "；"))")
observations["failures"] = failures
if given == 0 { quitApp() }
if let data = try? JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys]) {
    try? data.write(to: out.appendingPathComponent("run.json"))
}
print(failures.isEmpty ? "全部成立" : "未成立 \(failures.count) 条")
exit(failures.isEmpty ? 0 : 1)
