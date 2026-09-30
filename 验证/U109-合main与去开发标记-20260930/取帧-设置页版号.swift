// U109 ④ · **按正式版重建取帧**：设置页「版本」那一行的**真帧 ＋ 真读数**。
//
// 判据两件，缺一不可：
//  ① **真帧**：真启动那个包、真点菜单栏、真点面板里的「设置」按钮、真截屏（不是离屏
//     `cacheDisplay` 那一套——离屏帧只画视图、读的是 XCTest bundle 的版本号，实测栽过）；
//  ② **真读数**：同一刻从**无障碍树**里把「版本」那一行的值抠出来判字面量。截图只作
//     物证，判据落在 AX 的文本上（「看图说话」不算判据）。
//
// 被测对象：`.artifacts/macos/Magic Code.app`——**正式身份**（`com.magiccode.app`、
// 名字 `Magic Code`、版号 `0.1.0`）。它以 `--validation-root` 起（临时隔离根 ＋ HOME
// 也换掉），运行期不碰用户任何真实数据。
//
// 用法：
//   xcrun swiftc -O 取帧-设置页版号.swift -o /tmp/u109-settings-frame
//   /tmp/u109-settings-frame --app ".artifacts/macos/Magic Code.app" --out <证据目录>
// 需要辅助功能授权（真点菜单栏/按钮、真截屏）。不写用户数据。

import AppKit
import ApplicationServices

let screens = NSScreen.screens
let screen = screens[0].frame

var out = URL(fileURLWithPath: "/tmp/u109-settings-frame")
var appURL = URL(fileURLWithPath: ".artifacts/macos/Magic Code.app")
var root = URL(fileURLWithPath: "/private/tmp/magic-system-test-u109frame")
var pid: pid_t = 0
var app: NSRunningApplication?
var failures: [String] = []
var observations: [String: Any] = [:]

func note(_ text: String) { print("· \(text)"); fflush(stdout) }
func fail(_ text: String) { failures.append(text); print("✘ \(text)"); fflush(stdout) }
func check(_ condition: Bool, _ text: String) { condition ? note("✓ \(text)") : fail(text) }

/// AppKit 的屏坐标是左下原点，而 `screencapture -R` 是左上原点——帧那一刀要翻过来。
func flipped(_ box: CGRect) -> CGRect {
    CGRect(x: box.minX, y: screen.maxY - box.maxY, width: box.width, height: box.height)
}

@discardableResult
func capture(_ name: String, region: CGRect? = nil) -> URL {
    let url = out.appendingPathComponent(name + ".png")
    var args = ["-x"]
    if let region { args += ["-R", "\(Int(region.minX)),\(Int(region.minY)),\(Int(region.width)),\(Int(region.height))"] }
    args.append(url.path)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = args
    try? process.run(); process.waitUntilExit()
    return url
}

// MARK: - 无障碍

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ element: AXUIElement, _ name: String) -> String { attribute(element, name) as? String ?? "" }
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func press(_ element: AXUIElement) -> Bool { AXUIElementPerformAction(element, kAXPressAction as CFString) == .success }
func size(_ element: AXUIElement) -> CGSize {
    guard let raw = attribute(element, kAXSizeAttribute) else { return .zero }
    var value = CGSize.zero; AXValueGetValue(raw as! AXValue, .cgSize, &value); return value
}
func position(_ element: AXUIElement) -> CGPoint {
    guard let raw = attribute(element, kAXPositionAttribute) else { return .zero }
    var value = CGPoint.zero; AXValueGetValue(raw as! AXValue, .cgPoint, &value); return value
}
func walk(_ element: AXUIElement, _ depth: Int = 0, _ visit: (AXUIElement, Int) -> Bool) -> AXUIElement? {
    if visit(element, depth) { return element }
    guard depth < 20 else { return nil }
    for child in children(element) { if let found = walk(child, depth + 1, visit) { return found } }
    return nil
}
func applicationElement() -> AXUIElement { AXUIElementCreateApplication(pid) }
func statusItem() -> AXUIElement? {
    guard let bar = attribute(applicationElement(), "AXExtrasMenuBar") else { return nil }
    return children(bar as! AXUIElement).first
}
func settingsWindow() -> AXUIElement? {
    let windows = attribute(applicationElement(), kAXWindowsAttribute) as? [AXUIElement] ?? []
    return windows.first { text($0, kAXTitleAttribute) != "" && size($0).width > 400 }
}

func click(at point: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.3)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.1)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
}

/// 把一棵 AX 子树里的**文本**按上到下的次序收集起来（`AXStaticText` 与带 `AXValue` 的控件都算）。
func collect(_ element: AXUIElement, _ depth: Int = 0, _ into: inout [String]) {
    let role = text(element, kAXRoleAttribute)
    if role == kAXStaticTextRole as String {
        let value = text(element, kAXValueAttribute); if !value.isEmpty { into.append(value) }
    } else if role == kAXButtonRole as String || role == kAXTextFieldRole as String {
        let title = text(element, kAXTitleAttribute); let value = text(element, kAXValueAttribute)
        if !title.isEmpty { into.append(title) } else if !value.isEmpty { into.append(value) }
    } else if let raw = attribute(element, kAXValueAttribute) as? String, !raw.isEmpty {
        into.append(raw)
    }
    guard depth < 24 else { return }
    for child in children(element) { collect(child, depth + 1, &into) }
}

// MARK: - 起 App

func launch() {
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let log = out.appendingPathComponent("launch.stdout.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    let handle = try! FileHandle(forWritingTo: log)
    let process = Process()
    process.executableURL = appURL.appendingPathComponent("Contents/MacOS/MagicCode")
    process.arguments = ["--validation-root", root.path]
    process.environment = ["HOME": root.path, "PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh", "LANG": "zh_CN.UTF-8", "MAGIC_HOME": root.path]
    process.standardOutput = handle; process.standardError = handle
    try! process.run()
    pid = process.processIdentifier
    note("启动 \(appURL.lastPathComponent) pid=\(pid) 隔离根=\(root.path)")
    for _ in 0..<120 {
        let text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        if text.contains("\"app.ready\"") { break }
        Thread.sleep(forTimeInterval: 0.25)
    }
    let log_text = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
    let ready = log_text.contains("\"app.ready\"")
    check(ready, "应用起到 ready（事件流里有 app.ready）")
    if !ready { fail("起手没到 ready，日志：\(log_text.suffix(400))") }
    app = NSRunningApplication(processIdentifier: pid)
    Thread.sleep(forTimeInterval: 1.5)
}

var quitDone = false
func quitApp() {
    if quitDone { return }
    quitDone = true
    app?.terminate()
    for _ in 0..<120 { if kill(pid, 0) != 0 { break }; Thread.sleep(forTimeInterval: 0.5) }
    let log = (try? String(contentsOf: out.appendingPathComponent("launch.stdout.log"), encoding: .utf8)) ?? ""
    check(log.contains("app.clean-exit"), "收尾事件里有 app.clean-exit")
}

// MARK: - 正戏

func main() {
    var iterator = CommandLine.arguments.dropFirst().makeIterator()
    while let flag = iterator.next() {
        switch flag {
        case "--app": if let value = iterator.next() { appURL = URL(fileURLWithPath: value) }
        case "--out": if let value = iterator.next() { out = URL(fileURLWithPath: value) }
        case "--root": if let value = iterator.next() { root = URL(fileURLWithPath: value) }
        default: break
        }
    }
    try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    // 隔离根必须在 /private/tmp 底下且末段以 magic-system-test- 起头：这是 `--validation-root`
    // 那一条的固有要求（与 systemTestRoot 同一套判据），故这里照它命名。
    if !root.path.hasPrefix("/private/tmp/magic-system-test-") {
        root = URL(fileURLWithPath: "/private/tmp/magic-system-test-u109frame-\(UUID().uuidString.prefix(8))")
    }

    // 包里那三件先静态量一遍（身份、名字、版号）——与后面屏上读到的互相印证。
    let bundle = Bundle(url: appURL)!
    observations["bundle"] = [
        "identifier": bundle.bundleIdentifier ?? "?",
        "name": bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "?",
        "version": bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
    ]
    check(bundle.bundleIdentifier == "com.magiccode.app", "包身份是 com.magiccode.app（正式身份）：\(bundle.bundleIdentifier ?? "?")")
    check((bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) == "0.1.0", "包版号是 0.1.0")

    launch()
    defer { quitApp() }

    // —— 展开菜单栏面板，再真点里面的「设置」——
    guard let item = statusItem() else { fail("找不到菜单栏项"); return }
    let frame = CGRect(origin: position(item), size: size(item))
    click(at: CGPoint(x: frame.midX, y: frame.midY))
    Thread.sleep(forTimeInterval: 1.2)
    guard let button = walk(applicationElement(), 0, { element, _ in
        text(element, kAXRoleAttribute) == kAXButtonRole as String
            && text(element, kAXDescriptionAttribute).contains("打开 Magic Code 设置")
    }) else { fail("面板里找不到「设置」按钮"); return }
    check(press(button), "真点面板里的「设置」按钮（AXPress）")
    var settings: AXUIElement?
    for _ in 0..<40 { settings = settingsWindow(); if settings != nil { break }; Thread.sleep(forTimeInterval: 0.25) }
    guard let settings else { fail("设置窗口没有出现"); return }
    Thread.sleep(forTimeInterval: 1.2)
    note("设置窗口：title=«\(text(settings, kAXTitleAttribute))» size=\(Int(size(settings).width))x\(Int(size(settings).height))")

    // —— 滚到底：版号那一段在最后一节 ——
    if let scrollArea = walk(settings, 0, { element, _ in text(element, kAXRoleAttribute) == kAXScrollAreaRole as String }) {
        if let bar = walk(scrollArea, 0, { element, _ in text(element, kAXRoleAttribute) == kAXScrollBarRole as String }) {
            AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, 1.0 as CFTypeRef)
        }
    }
    Thread.sleep(forTimeInterval: 0.8)

    // —— 真帧：窗口那一刀（整屏也留一张，作「它真在屏上」的物证）——
    let box = CGRect(origin: position(settings), size: size(settings))
    capture("设置页-整屏")
    capture("设置页-窗口", region: flipped(box))

    // —— 真读数：AX 里的全部文本 ——
    var lines: [String] = []
    collect(settings, 0, &lines)
    observations["axLines"] = lines
    observations["window"] = ["title": text(settings, kAXTitleAttribute), "box": "\(Int(box.width))x\(Int(box.height))"]

    let versionIndex = lines.firstIndex(where: { $0.contains("版本") })
    let versionRow = versionIndex.map { lines[$0...].prefix(4).joined(separator: " ｜ ") } ?? ""
    observations["versionRow"] = versionRow
    check(versionIndex != nil, "设置页里有「版本」那一行")
    check(lines.contains("0.1.0"), "「版本」那一行的值是 0.1.0（AX 读到 \(versionRow)）")
    for banned in ["开发版", "正式版", "Magic Code Dev", "com.magiccode.app.dev", "isDevelopment"] {
        check(!lines.contains { $0.contains(banned) }, "设置页里没有「\(banned)」这类标记")
    }

    // ⚠️ **收摊要在 `exit()` 之前显式做**：`exit()` 不跑 `defer`（第一趟就是这么把一份
    //    验证副本留在机器上的——帧全绿，进程还在）。
    quitApp()
    observations["failures"] = failures
    let data = try! JSONSerialization.data(withJSONObject: observations, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
    try! data.write(to: out.appendingPathComponent("settings-frame.json"))

    print(failures.isEmpty ? "\n全绿（\(out.path)）" : "\n红了 \(failures.count) 条")
    exit(failures.isEmpty ? 0 : 1)
}

main()
