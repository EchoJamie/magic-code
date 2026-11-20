// 右 ⌥ 的只读监听（U135）——单独一个文件，因为 `main.swift` 里的顶层声明处在脚本
// 上下文里，C 函数指针（`CGEventTapCallBack`）不能引用那里的类型与函数。
//
// 只看不改：`.listenOnly` 的 tap 不会吞键、不改变任何按键，也不记录输入内容。
// 判定只有一条：**右 ⌥ 单独按下再松开**；中途按了别的键、或同时带着别的修饰键，都不算。

import Foundation
import CoreGraphics

/// 监听状态（C 回调拿不到局部变量，只好放在文件作用域里）。
final class ListenState {
  var rightOptionDown = false
  var combined = false
}

/// 命中一次就调一次（由 `main` 装上，落成一行 `{"type":"hotkey","phase":…}`）。
/// 参数是**两半**：`"down"`（右 ⌥ 按下，干净的那一下）与 `"up"`（松开了，且整次没夹别的键）。
///
/// 为什么要报**按下**（D75）：「轻点的是哪一屏」得在**按下那一刻**量一次——只报「按完了」，
/// 就没法区分「在 A 按下、切到 B 松开」（B 会以为自己发起的那一下）。判定仍在这一侧：
/// 夹了别的键的那一下，按下也不报（`up` 自然也不会来）。
var hotkeyHandler: ((_ phase: String) -> Void)?

/// 右 ⌥ 的键码（W3C：左 ⌥＝58、右 ⌥＝61）。**放文件作用域**：C 回调里不能引用局部常量。
private let rightOptionKeycode: Int64 = 61

/// 活着的监听状态——**必须在这里持有强引用**：`startHotkeyListener()` 一返回，局部变量就释放了，
/// 回调拿到的指针会变成野指针（第一版就是这么写错的：tap 建得起来，但按下去毫无反应）。
private var activeState: ListenState?

/// 起监听；成功返回 true（此后由调用方跑 run loop）。`nil` tap＝没有「输入监控」权限。
func startHotkeyListener() -> Bool {
  let mask: CGEventMask = (1 << CGEventType.flagsChanged.rawValue) | (1 << CGEventType.keyDown.rawValue)
  let state = ListenState()
  activeState = state
  let statePointer = Unmanaged.passUnretained(state).toOpaque()

  let callback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let state = Unmanaged<ListenState>.fromOpaque(info).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      return Unmanaged.passUnretained(event)
    }
    if type == .keyDown {
      // 这一下里夹了别的键：整次不算（组合键不触发）。
      state.combined = true
      return Unmanaged.passUnretained(event)
    }
    if type == .flagsChanged {
      let code = event.getIntegerValueField(.keyboardEventKeycode)
      guard code == rightOptionKeycode else { return Unmanaged.passUnretained(event) }
      let flags = event.flags
      let down = flags.contains(.maskAlternate)
      if down && !state.rightOptionDown {
        state.rightOptionDown = true
        state.combined = flags.contains(.maskShift) || flags.contains(.maskControl) || flags.contains(.maskCommand)
        // 干净的一下才报「按下」——带着别的修饰键那不是一次轻点的开头。
        if !state.combined { hotkeyHandler?("down") }
      } else if !down && state.rightOptionDown {
        state.rightOptionDown = false
        if !state.combined { hotkeyHandler?("up") }
      }
    }
    return Unmanaged.passUnretained(event)
  }

  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                    options: .listenOnly, eventsOfInterest: mask,
                                    callback: callback, userInfo: statePointer) else { return false }
  guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else { return false }
  CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  return true
}
