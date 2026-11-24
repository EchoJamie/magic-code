/**
 * **「这一屏拿没拿到焦点」与「那一下轻点算不算」**（D75）——纯逻辑，不碰终端。
 *
 * 上游（`run.ts`）把 stdin 的原始字节喂进闸门、把助手报的两半（`down` / `up`）递进来；
 * 这里只量三件事：未知不触发、按下与松开要在**同一屏**、退出复原那两条字节。
 *
 * 真机那半边（Ghostty 的多窗口／标签页／分屏）验不了——见 D75 的完成判据，
 * 那几条要手动开两个窗口走一遍。
 */

import { describe, expect, test } from 'bun:test'
import { FOCUS_OFF, FOCUS_ON, createFocusGate, openFocusReport, stripFocusReports } from '../src/focus.ts'
import { toShellKeys } from '../src/input.ts'

/** 造一个闸门 ＋ 一只可拨的钟（用例不等真时间）。 */
function gate() {
  let now = 1_000
  const focus = createFocusGate(() => now)
  return {
    focus,
    /** 时间往前走 `ms`（焦点变化与按下时刻都按它记）。 */
    wait: (ms: number): void => { now += ms },
    /** 一次完整的轻点：按下 → 松开。 */
    tap: (): boolean => { const down = focus.tap('down', now); expect(down).toBe(false); return focus.tap('up', now) },
  }
}

describe('语音那一下轻点的焦点准入（D75）', () => {
  test('焦点未知时不触发——终端一次都没报过，就说不上是哪一屏', () => {
    const one = gate()
    expect(one.focus.focus()).toBe('unknown')
    expect(one.tap()).toBe(false)
  })

  test('拿到焦点：按下与松开都在这一屏 ⇒ 算一次轻点', () => {
    const one = gate()
    one.focus.feed('\u001b[I')
    expect(one.focus.focus()).toBe('in')
    expect(one.tap()).toBe(true)
  })

  test('失焦之后不触发（另一个窗口在这一屏失焦期间按了键）', () => {
    const one = gate()
    one.focus.feed('\u001b[I')
    one.focus.feed('\u001b[O')
    expect(one.focus.focus()).toBe('out')
    expect(one.tap()).toBe(false)
  })

  test('按下之后换过焦点，松开不算——「在 A 按下、切到 B 再松开」不能由 B 发起', () => {
    const one = gate()
    one.focus.feed('\u001b[I')
    expect(one.focus.tap('down', 1_000)).toBe(false)
    // 按下之后切走又切回来：读数还是 `in`，但那是**新的**一次进焦点
    one.wait(10)
    one.focus.feed('\u001b[O')
    one.wait(10)
    one.focus.feed('\u001b[I')
    one.wait(10)
    expect(one.focus.tap('up', 1_030)).toBe(false)
  })

  test('一直拿着焦点的一小段之内：按下与松开仍算——判定不靠「松得多快」', () => {
    const one = gate()
    one.focus.feed('\u001b[I')
    one.wait(50)
    one.focus.tap('down', 1_050)
    one.wait(400)
    expect(one.focus.tap('up', 1_450)).toBe(true)
  })

  test('一条上报分两次读进来（`\\x1b` 与 `[I`）也认', () => {
    const one = gate()
    one.focus.feed('\u001b')
    expect(one.focus.focus()).toBe('unknown')
    one.focus.feed('[I')
    expect(one.focus.focus()).toBe('in')
    expect(one.tap()).toBe(true)
  })

  test('按下时还没焦点（刚报 `[I` 之前）⇒ 不算；那之后再按才算', () => {
    const one = gate()
    one.focus.tap('down', 1_000)
    one.wait(5)
    one.focus.feed('\u001b[I')
    expect(one.focus.tap('up', 1_010)).toBe(false)
    expect(one.tap()).toBe(true)
  })

  test('老助手只报「按完了」（没有按下那一半）：按此刻的焦点判', () => {
    const one = gate()
    one.focus.feed('\u001b[I')
    expect(one.focus.tap('up', 1_000)).toBe(true)
    one.focus.feed('\u001b[O')
    expect(one.focus.tap('up', 2_000)).toBe(false)
  })

  test('退出复原那两个字节（开了就得关，别留给下一个程序）', () => {
    expect(FOCUS_ON).toBe('\u001b[?1004h')
    expect(FOCUS_OFF).toBe('\u001b[?1004l')
  })
})

describe('焦点上报不是正文', () => {
  test('Ink 交上来的 `[I` / `[O` 一个键都不产生', () => {
    expect(toShellKeys('[I', {})).toEqual([])
    expect(toShellKeys('[O', {})).toEqual([])
    expect(stripFocusReports('[I[O')).toBe('')
  })

  test('正文里的方括号字母一个字都不吃（只有行首那几条是上报）', () => {
    expect(stripFocusReports('a[I')).toBe('a[I')
    expect(toShellKeys('a[I', {})).toEqual([
      { kind: 'char', char: 'a' },
      { kind: 'char', char: '[' },
      { kind: 'char', char: 'I' },
    ])
    // 上报后面紧跟正文时，正文照旧进草稿
    expect(toShellKeys('[I你好', {})).toEqual([
      { kind: 'char', char: '你' },
      { kind: 'char', char: '好' },
    ])
  })
})

describe('开一次焦点上报（写字节 ＋ 挂监听 ＋ 复原）', () => {
  test('开就写 FOCUS_ON；收摊写 FOCUS_OFF，只写一次，监听也摘干净', () => {
    // 最小的一对假流：只认这一件用到的那两个方法（不引 node:stream，免得把终端行为也演一遍）。
    const listeners = new Set<(chunk: Buffer | string) => void>()
    const stdin = {
      on(_event: 'data', listener: (chunk: Buffer | string) => void) { listeners.add(listener) },
      off(_event: 'data', listener: (chunk: Buffer | string) => void) { listeners.delete(listener) },
    }
    const written: string[] = []
    const report = openFocusReport(stdin, { write: (chunk: string) => { written.push(chunk) } })

    expect(written).toEqual([FOCUS_ON])
    expect(listeners.size).toBe(1)

    // 字节喂进来 ⇒ 闸门认到焦点（与真终端同形：一条 3 字节）
    for (const listener of listeners) listener('\u001b[I')
    expect(report.gate.focus()).toBe('in')
    // 半条也能接上（一次读只到 `\x1b[`）
    for (const listener of listeners) listener('\u001b[')
    for (const listener of listeners) listener('O')
    expect(report.gate.focus()).toBe('out')

    report.close()
    report.close() // 复原只做一次
    expect(written).toEqual([FOCUS_ON, FOCUS_OFF])
    expect(listeners.size).toBe(0)
  })
})
