/**
 * 规格即测试 · **U21 性能**——受控渲染三条，逐条落成用例。
 *
 * 出处：`技术方案.md`·接入「TUI 显示工程」第 1 条（**本单元就是它**）——
 * 「**受控渲染**：增量重绘（只刷活动区）、流式节流（批量 flush）、历史区静态化」；
 * `对表.md`·阶段 3 范围表（性能——受控渲染 · 启动路径）；`工作分解.md`·U21 行
 * （判据：**流式不卡 · 启动快**）。
 *
 * ## 判据锚的是「我要什么」，不是「现在跑成什么样」
 *
 * | # | 我要什么（规格） | 用例在哪 |
 * | --- | --- | --- |
 * | ① | **增量重绘**——已定稿的行不再重算，且算出来的屏**与全量逐字一致** | `describe('①')` |
 * | ② | **流式节流**——一串增量**合批**，而**键盘一步都不等** | `describe('②')` |
 * | ③ | **历史区静态化**——已定局那一片**每帧不再重建** | `describe('③')` |
 *
 * ⚠️ **① 那两条的分工**（这一处最容易写歪）：
 * - **「与全量逐字一致」是底线**——增量是**省算**，不是**换算法**。故拿一段真会流式长出来的
 *   正文，**每一个前缀**都比一遍 `markdown()`；
 * - **「已画出的行不再变」是「不闪不跳」的形式**（规格原话：流式容忍靠「逐行定夺」，
 *   同一段前缀怎么往后长，它前面那些行结果都一样）。这条**只有无围栏的正文才成立**——
 *   围栏闭合那一刻**本来就要重排**（`缺陷/D14` 与「已知限度」都写着），
 *   故它单列一段**不含围栏**的正文来钉，别拿它去盖围栏那条。
 *
 * ⚠️ **① 的第三条是「形状」不是「快慢」**：它比的是「加一行」与「整段重算」两个代价的
 * **比值**（绝对毫秒数换台机器就漂，比值不漂）。倒回不做增量那一版，这条当场红。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import { event } from './events.ts'
import { markdown, markdownStream } from '../src/markdown.ts'
import { AppView } from '../src/components/app.ts'
import { rowLines } from '../src/components/log.ts'
import { createView } from '../src/view.ts'
import type { LogRow } from '../src/view.ts'
import { createShell } from '../src/shell.ts'
import type { Shell } from '../src/shell.ts'

const WIDE = { columns: 80, expanded: false } as const

/** 一条助手行。 */
function assistant(text: string, key: string): LogRow {
  return { kind: 'assistant', key, text }
}

/** 显示行 → 纯文字（色段拼回去）——「逐字一致」那两条按它比。 */
function textOf(lines: readonly { readonly segments: readonly { readonly text: string }[] }[]): string {
  return lines.map((line) => line.segments.map((piece) => piece.text).join('')).join('\n')
}

// ══ ① 增量重绘（只刷活动区 · 已定稿的行不重算）════════════════════════

/**
 * 一段**每样都带一点**的正文——围栏（含**未闭合**的那一段）· 粗体 · 行内代码 · 列表 ·
 * 标题 · 链接 · 空行。逐**字符**切前缀：流式里正文是一个字一个字长出来的，
 * 每个中间态都得与「那一刻的全量解析」一样，否则屏上就会闪。
 */
const EVERYTHING = [
  '# 标题一',
  '',
  '一段**粗体**与 `行内代码`，还有 [链接](https://example.com)。',
  '- 列表项甲',
  '- 列表项乙',
  '',
  '```ts',
  'const a = 1',
  'const b = 2',
  '```',
  '',
  '围栏之后还有正文。',
  '```',
  '这段围栏不闭合',
].join('\n')

/** 一段**不含围栏**的正文——「已画出的行不再变」那条只对它成立（理由见文件头注）。 */
const PROSE = '第一行有**粗体**。\n第二行有 `代码`。\n第三行起是列表：\n- 甲\n- 乙\n'

describe('① 增量重绘', () => {
  test('增量解析与全量解析逐字一致（每个前缀都比一遍）', () => {
    for (let cut = 1; cut <= EVERYTHING.length; cut += 1) {
      const prefix = EVERYTHING.slice(0, cut)

      expect(textOf(markdownStream('一致', prefix).lines)).toBe(textOf(markdown(prefix)))
    }
  })

  test('未闭合的围栏挡住定稿——那一段每帧现算（「未闭合先按字面」的必然后果）', () => {
    const open = '正文一行\n```ts\n还没闭合'
    const streamed = markdownStream('未闭', open)

    // 定稿停在围栏之前：只有第一行是稳的
    expect(textOf(streamed.lines.slice(0, streamed.settled))).toBe('正文一行')
    // 而整段的结果仍与全量一致（未闭合按字面）
    expect(textOf(streamed.lines)).toBe(textOf(markdown(open)))
  })

  test('没有围栏时定稿一路推进——重算的只剩最后那一行', () => {
    const text = `${PROSE}尾巴一行\n`
    const streamed = markdownStream('定稿', text)

    // 定稿的那些行 ＋ 尾巴那一行 ＝ 全部（尾巴恒为最后一条）
    expect(streamed.settled).toBeGreaterThan(0)
    expect(streamed.settled).toBe(streamed.lines.length - 1)
  })

  test('正文换了一段（不再是前缀）⇒ 缓存丢掉重来，不交出上一段的残影', () => {
    const first = '第一段\n第二行\n'
    expect(textOf(markdownStream('换段', first).lines)).toBe(textOf(markdown(first)))

    const other = '完全不相干的一段\n'
    expect(textOf(markdownStream('换段', other).lines)).toBe(textOf(markdown(other)))
  })

  test('已画出的行不再变——同一段正文往后长，前面那些显示行一字不差', () => {
    const streamed = (text: string): readonly string[] => textOf(rowLines(assistant(text, '不闪'), WIDE)).split('\n')

    // 每次只多长一个字，把「上一帧的前 k-1 行」与「这一帧的前 k-1 行」比一遍
    let previous = streamed(PROSE)
    for (const char of '后面又来了好多好多的字，一行一行地往下写。\n再起一行。\n') {
      const next = streamed(PROSE + char)
      const keep = previous.length - 1 // **末行还在长**，不参与比

      expect(next.slice(0, keep)).toEqual(previous.slice(0, keep))
      previous = next
    }
  })

  test('一行的代价与**全文长度**无关——比的是「加一行 ÷ 整段重算」这个形状', () => {
    const lines = 800
    const long = Array.from({ length: lines }, (_, index) => `第 ${index} 行：一段**正文**。`).join('\n')

    let text = long
    void rowLines(assistant(text, '增长'), WIDE) // 先把整段铺进去（定稿）

    const perLine = (): number => {
      const started = Bun.nanoseconds()
      for (let index = 0; index < 50; index += 1) {
        text += '\n又一行'
        void rowLines(assistant(text, '增长'), WIDE)
      }

      return (Bun.nanoseconds() - started) / 1e6 / 50
    }

    // 同量级的「整段重算」长什么样——拿不带缓存的 `markdown()` 当尺子
    const started = Bun.nanoseconds()
    for (let index = 0; index < 5; index += 1) void markdown(long)
    const fullParse = (Bun.nanoseconds() - started) / 1e6 / 5

    const perLineMs = Math.min(perLine(), perLine())

    // 判据是**形状**：加一行的代价该远小于「整段重算」。实测约 1/30；
    // 给 1/5 的界——宽松到不怕机器慢，又咬得住「与全文成正比」那一版
    //（倒回不做增量时实测 25.0ms vs 5.0ms ⇒ 这条当场红）。
    expect(perLineMs).toBeLessThan(fullParse / 5)
  })
})

// ══ ② 流式节流（批量 flush）════════════════════════════════════════════

/** 起一个壳，并数「订阅者被叫醒几次」。 */
function countingShell(): {
  readonly shell: Shell
  readonly wakes: () => number
  readonly emit: (event: KernelEvent) => void
} {
  const listeners = new Set<(event: KernelEvent) => void>()
  const shell = createShell({
    send: () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  })

  let count = 0
  shell.subscribe(() => {
    count += 1
  })

  return {
    shell,
    wakes: () => count,
    emit: (one) => {
      for (const listener of [...listeners]) listener(one)
    },
  }
}

/** 一条正文增量。 */
function delta(text: string): KernelEvent {
  return event('model.delta', { channel: 'text', id: 'x', text })
}

describe('② 流式节流', () => {
  test('一窗之内的一串增量合批——领头的当场、末尾补一次，中间那些不单独叫醒', async () => {
    const { wakes, emit } = countingShell()
    const started = wakes()

    // 20 条增量挤在一次同步循环里（真实流式里它们就落在同一个窗口内）
    for (let index = 0; index < 20; index += 1) emit(delta('字'))

    // **领头**：第一条当场就叫醒（不白等一个窗口）
    expect(wakes() - started).toBe(1)

    // **末尾**：窗口结束时补一次——把这一串的最终样子交出去
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(wakes() - started).toBe(2)
  })

  test('视图本身**即时**更新——节流的是通知，不是状态', () => {
    const { shell, emit } = countingShell()

    emit(delta('甲'))

    // 不等任何一帧：视图上已经有这个字了（`getView` 拿的永远是当下那一份）
    const row = shell.getView().rows[0]
    expect(row?.kind).toBe('assistant')
    expect(row?.kind === 'assistant' ? row.text : '').toBe('甲')
  })

  test('键盘一步都不等——按下去当场通知（输入回声最不该等）', () => {
    const { shell, wakes, emit } = countingShell()

    emit(delta('字'))
    const started = wakes()

    shell.key({ kind: 'char', char: 'a' })

    expect(wakes() - started).toBe(1)
  })

  test('非流式的事件也当场通知（`turn.end` 会换掉整片，晚一帧就是按了没反应）', () => {
    const { shell, wakes, emit } = countingShell()

    emit(delta('字'))
    const started = wakes()

    emit(event('turn.end', { reason: 'settled' }))

    expect(wakes() - started).toBe(1)
    expect(shell.getView().status.state).toBe('idle')
  })
})

// ══ ③ 历史区静态化 ═══════════════════════════════════════════════════

describe('③ 历史区静态化', () => {
  test('`Static` 拿到的就是 `view.settled` 那一份——每帧不再重建阵列', () => {
    const view = createView()
    const frame = AppView({ view, columns: 80, rows: 24 })
    const children = (frame.props as { children: readonly { props: { items: unknown } }[] }).children

    // 第一个孩子就是 `<Static>`——它的 `items` 该**原样**是 `view.settled`
    expect(children[0]?.props.items).toBe(view.settled)
  })

  test('没加行时 `settled` 的引用不变（重建的代价因此为零）', () => {
    const { shell, emit } = countingShell()
    const before = shell.getView().settled

    emit(delta('字'))

    expect(shell.getView().settled).toBe(before)
  })
})
