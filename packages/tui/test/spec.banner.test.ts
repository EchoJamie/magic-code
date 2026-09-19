/**
 * 规格即测试 · **TUI Banner 前置展示**——启动字标逐条落成用例。
 *
 * 出处：vault `品牌视觉/TUI Banner 设计.md`（资源 `资源/折跃-v1/tui/`）。**规格以那份为准**；
 * 本文件把它的每一条话锚成一句「**我要什么**」，而不是「现在跑成什么样」。
 *
 * | # | 我要什么（规格原话/其落法） | 用例在哪 |
 * | --- | --- | --- |
 * | ① | 窗口**至少 57 列**时用**块字版**（53 列画幅 ＋ 左右各 2 列留白） | `describe('①')` |
 * | ② | 窄于 57 列 ⇒ **一行版** `Magic Code`（占 10 列 · 不缩写成 M · 不附加 Icon） | `describe('②')` |
 * | ③ | **极窄到放不下 10 列** ⇒ **不印**——「优先保证正文与输入空间」 | `describe('③')` |
 * | ④ | **记录区的最前面**，**启动印一次**；**内联随内容滚动**（不钉屏、不长期挤占对话空间） | `describe('④')` |
 * | ⑤ | 接续（`--session` 那条路＝重建）之后**仍在最前面** | `describe('⑤')` |
 * | ⑥ | `MAGIC` **品牌青** · `CODE` **主文字色** · **不强制铺底色**；**无色终端**整块用默认前景 | `describe('⑥')` |
 * | ⑦ | **静态**——不动效 · 不 Icon · 不宣传图或工具信息 | `describe('⑦')` |
 * | ⑧ | **块字符不自动检测**——默认就用块字版；ASCII 版**留着**但**没有路径切过去** | `describe('⑧')` |
 *
 * ## 三处「不是设计漏了，是这里没有那个输入」的如实记录
 *
 * 1. **浅色主题那一档颜色不做**（设计表里另有一列 `#167682` / `#18232D`）：那要终端**主题**信息，
 *    而这个壳**没有主题检测**——整块 `PALETTE` 都是照深底定的。故取深底那一档，
 *    它的两个值恰好就是色板里现成的 `user` / `fg`（见 `⑥`）。
 * 2. **「可用高度不足时」那半条不在此处射程**：内联渲染下窗口高度**不约束记录区**
 *    （内容随滚动走，该几行就几行），「可用高度」不是一个稳定输入。取**宽度**这一条。
 * 3. **ASCII 版没有触发条件**——规划侧已定「不自动切」（终端**不告诉你字体信息**，检测必错）。
 *    它作为资源留在 `src/banner.ts` 里，`⑧` 钉住它**是个完好的资源**且**真的切不过去**。
 */

import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { createElement as h } from 'react'
import type { Entry } from '@magic/contracts'
import {
  BANNER_ASCII,
  BANNER_COMPACT,
  BANNER_COMPACT_MIN,
  BANNER_WIDE,
  BANNER_WIDE_MIN,
  bannerOf,
} from '../src/banner.ts'
import { AppView } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'
import { createSpyTransport } from './fakes.ts'
import { record } from './terminal.ts'

/** 记录区的**前几行**（字标在这儿）——取景那两处都从这条进。 */
const headOf = (frame: Frame, count: number): readonly string[] =>
  frame.record.slice(0, count).map((line) => line.text)

/** 抹行尾（帧上的行尾空白被归一化过，比形状时两边口径要一样）。 */
const trimmed = (lines: readonly string[]): readonly string[] => lines.map((line) => line.replace(/\s+$/u, ''))

/** 块字版在屏上的样子——**左留 2 列**（设计：建议左右各留 2 列空白）。 */
const WIDE_ON_SCREEN = trimmed(BANNER_WIDE.map((line) => `  ${line}`))

/** 起一个壳，取一帧。 */
const frameAt = async (columns: number, rows = 30): Promise<Frame> =>
  createStage().screen({ columns, rows })

// ══ ① 宽 ⇒ 块字版 ═══════════════════════════════════════════════════

describe('① 窗口够宽 ⇒ 块字版', () => {
  test('**≥57 列**：记录区最前面就是那 5 行块字，一字不差（左留 2 列白）', async () => {
    const frame = await frameAt(100)

    expect(headOf(frame, 5)).toEqual(WIDE_ON_SCREEN)
    // 一字不差那条之外，再钉「**是块字符**」——否则换成 ASCII 版这条照样绿
    expect(WIDE_ON_SCREEN.join('')).toContain('█')
  })

  test('阈值**正好是 57**（＝53 列画幅 ＋ 左右各 2 列留白）——56 列就不给块字版了', async () => {
    expect(BANNER_WIDE_MIN).toBe(57)
    expect(BANNER_WIDE[0]?.length).toBe(53)

    expect(headOf(await frameAt(57), 5)).toEqual(WIDE_ON_SCREEN)
    expect(headOf(await frameAt(56), 1)).not.toEqual(WIDE_ON_SCREEN.slice(0, 1))
  })

  test('**不溢出**——终端不许替我们折行（折了就是「自算宽度 > 终端宽度」）', async () => {
    // 画幅 53 ＋ 左 2 ＝ 55 列；57 列的下限正是让它放得下
    const frame = await frameAt(57)
    const at = frame.record.findIndex((line) => line.text.includes('█'))

    expect(at).not.toBe(-1)
    expect(frame.screen.wrapped[at]).toBe(false)
  })
})

// ══ ② 窄 ⇒ 一行版 ═══════════════════════════════════════════════════

describe('② 窄 ⇒ 一行版', () => {
  test('**窄于 57 列**：换成一行完整产品名，占 10 列', async () => {
    const frame = await frameAt(45)

    expect(headOf(frame, 1)).toEqual([BANNER_COMPACT])
    expect(BANNER_COMPACT).toBe('Magic Code')
    expect(BANNER_COMPACT.length).toBe(10)
  })

  test('**不缩写成 M、不附加 Icon**——整行就是那两个词', async () => {
    const line = (await frameAt(45)).record[0]?.text ?? ''

    expect(line).toBe('Magic Code')
    expect(line).not.toContain('█')
  })

  test('一行版的分色点＝两个词之间（`Magic` ｜ ` Code`）', async () => {
    const frame = await frameAt(45)
    const cells = frame.cellsOf(frame.record[0]?.row ?? 0)

    expect(cells[4]?.text).toBe('c') // `Magic` 末字
    expect(cells[0]?.fg).toBe('#56b6c2') // Magic —— 品牌青
    expect(cells[5]?.fg).toBe('#d8dce4') // Code —— 主文字色
  })

  test('阈值**正好是 10**（文档：「极窄到放不下 10 列时隐藏」）', async () => {
    expect(BANNER_COMPACT_MIN).toBe(10)

    expect(bannerOf(10)).toHaveLength(1)
    expect(bannerOf(9)).toHaveLength(0)
  })
})

// ══ ③ 极窄 ⇒ 不印 ═══════════════════════════════════════════════════

describe('③ 极窄 ⇒ 不印', () => {
  /**
   * ⚠️ **这条的判据不是拿帧文本去 `includes`**——反向验证当场戳穿过：
   * 把「≥10 列」那一支掐掉（＝极窄也照印），`includes('Magic Code')` 照样为假——
   * 因为**9 列的终端会把 `Magic Code` 折成两行**，那一串字在帧上根本不连续。
   * 「红不红」全看终端折不折，那就不叫判据。
   *
   * ⇒ 换一把折不断的尺子：**同一份视图，摘掉字标那一行，比两串字节**。
   * 一样 ⇒ 字标在这一宽度上**一个格子都没占**；不一样 ⇒ 它占了。
   * 顺带在 57 列上把同一把尺子反过来使一遍（那儿**必须**不一样）——
   * 免得「两边都量不到东西」也看着像绿。
   */
  test('**放不下 10 列**：帧上一个格子都没占——优先保证正文与输入空间', async () => {
    const view = createStage().shell.getView()
    const stripped: ShellView = { ...view, settled: view.settled.filter((row) => row.kind !== 'banner') }

    expect(view.settled.some((row) => row.kind === 'banner')).toBe(true) // 防空转

    expect(await bytesAt(view, 9, 0)).toBe(await bytesAt(stripped, 9, 0))
    expect(await bytesAt(view, 57, 0)).not.toBe(await bytesAt(stripped, 57, 0))
  })

  test('字标**零行**——不是「印了个空的」（行数就是行数）', () => {
    expect(bannerOf(9)).toEqual([])
    expect(bannerOf(1)).toEqual([])
    expect(bannerOf(0)).toEqual([])
  })
})

// ══ ④ 位置与时机 ═══════════════════════════════════════════════════

describe('④ 记录区最前面 · 启动印一次', () => {
  test('`settled[0]` 就是字标——**记录区的最前面**那一块', () => {
    const shell = createShell(createSpyTransport().transport)

    expect(shell.getView().settled[0]?.kind).toBe('banner')
  })

  test('**印一次**——一整趟跑下来，记录区里只有一行字标', () => {
    const stage = createStage()
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
    stage.type('跑一下')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '好。' }),
      event('turn.end', { reason: 'settled' }),
    ])

    const view = stage.shell.getView()
    const all = [...view.settled, ...view.rows]

    expect(all.filter((row) => row.kind === 'banner')).toHaveLength(1)
    expect(view.settled[0]?.kind).toBe('banner') // 而且还在最前面
    expect(view.settled.length).toBeGreaterThan(1) // 后面确实长了东西出来（防空转）
  })

  test('**内联随内容滚动**——内容一多，字标滚进 scrollback，不再占着窗口', async () => {
    const stage = createStage()
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '长会话' }] })])
    const entries: Entry[] = Array.from({ length: 40 }, (_unused, index) => ({
      id: index + 1,
      kind: 'user' as const,
      content: { text: `第 ${index + 1} 句` },
      at: index,
    }))
    stage.feed([event('session.history', { session: 's1', entries, done: true })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const lines = frame.screen.lines
    const at = lines.findIndex((line) => line.includes('█'))

    expect(at).toBeGreaterThanOrEqual(0) // 它确实画过（在 scrollback 里）
    // 而**当前这一屏**（最后 24 行）里已经没有它了——「避免长期挤占对话空间」
    expect(at).toBeLessThan(lines.length - 24)
  })
})

// ══ ⑤ 接续那条路也印 ═══════════════════════════════════════════════

describe('⑤ 接续（重建）之后仍在最前面', () => {
  test('`session.history` 收齐 ⇒ `rebuild` 换掉整个记录区——**字标要回来**', () => {
    const stage = createStage()
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])

    const entries: Entry[] = [
      { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '列一下。' }, at: 1 },
    ]
    stage.feed([event('session.history', { session: 's1', entries, done: true })])

    const view = stage.shell.getView()

    expect(view.settled[0]?.kind).toBe('banner')
    expect(view.settled).toHaveLength(3) // 字标 ＋ 那两条——**重建的内容一条不少**
    expect(view.settled.filter((row) => row.kind === 'banner')).toHaveLength(1)
  })

  test('换会话（记录区清空重来）——字标照旧在最前面', () => {
    const stage = createStage()
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
    stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙' }] })])

    const view = stage.shell.getView()

    expect(view.settled).toHaveLength(1)
    expect(view.settled[0]?.kind).toBe('banner')
  })

  test('**空态没有被字标挡住**（程序性判据：那正是原型场景 1 那一屏）', async () => {
    // 还没会话、屏上也还没有内容 ⇒ 空态那句话照旧在
    expect((await frameAt(100)).record.some((line) => line.text.includes('交代一件事就开始'))).toBe(true)
  })
})

// ══ ⑥ 配色 ═════════════════════════════════════════════════════════

describe('⑥ 配色', () => {
  /** 一格里非空格子的颜色（去重）——`MAGIC` 与 `CODE` 各量一半。 */
  const colorsOf = (frame: Frame, from: number, to: number): readonly (string | null)[] => {
    const row = frame.record[0]?.row ?? 0

    return [
      ...new Set(
        frame
          .cellsOf(row)
          .slice(from, to)
          .filter((cell) => cell.text.trim() !== '')
          .map((cell) => cell.fg),
      ),
    ]
  }

  test('**`MAGIC` 品牌青 · `CODE` 主文字色**（深底那一档：`#56B6C2` / `#D8DCE4`）', async () => {
    const frame = await frameAt(100)

    // 画幅：左 2 列白 ＋ MAGIC 27 列 ＋ 空档 4 列 ＋ CODE 22 列
    expect(colorsOf(frame, 2, 29)).toEqual(['#56b6c2'])
    expect(colorsOf(frame, 31, 53)).toEqual(['#d8dce4'])
  })

  test('**不强制铺底色**——字标每一格的背景都是终端自己的', async () => {
    const frame = await frameAt(100)
    const row = frame.record[0]?.row ?? 0

    expect(frame.cellsOf(row).every((cell) => cell.bg === null)).toBe(true)
  })

  test('**无色终端整块用默认前景**——一个色码都不发，名字仍然完整', async () => {
    const view = createShell(createSpyTransport().transport).getView()
    const bytes = await bytesAt(view, 100, 0)

    expect(bytes).not.toMatch(/\u001b\[[0-9;]*m/) // 一条 SGR 都没有 ⇒ 落到默认前景
    // 而字标**照旧在**（无色不是不印）
    expect(bytes).toContain('█   █  ███')
  })

  test('两档**分得开**——有色的那串字节与无色那串不是一回事（D17 那条教训的反面）', async () => {
    const view = createShell(createSpyTransport().transport).getView()
    const colored = await bytesAt(view, 100, 3)
    const dull = await bytesAt(view, 100, 0)

    expect(colored).toMatch(/\u001b\[[0-9;]*m/) // 有色档确实发了色码（不是「没开色」）
    expect(dull).not.toMatch(/\u001b\[[0-9;]*m/)
    expect(colored).not.toBe(dull)
  })
})

// ══ ⑦ 静态 ═════════════════════════════════════════════════════════

describe('⑦ 静态', () => {
  test('**只有字标本身**——不夹 slogan、版本号、Icon 或工具信息', async () => {
    const frame = await frameAt(100)
    const art = headOf(frame, 5).join('\n')

    // 把画幅原样去掉之后，剩不下任何东西（多一行字都会露出来）
    expect(art.replace(/[█\s]/gu, '')).toBe('')
    expect(art).not.toContain('折跃')
    expect(art).not.toContain('v0')
    expect(art).not.toContain('Magic Code') // 那是窄屏那一版，不是块字版的第 6 行
  })

  test('不加动效 · 不加重 ——字标每一格都不粗、不斜、不删线、不换色底', async () => {
    const frame = await frameAt(100)
    const row = frame.record[0]?.row ?? 0
    const cells = frame.cellsOf(row)

    expect(cells.every((cell) => cell.bold === false)).toBe(true)
    expect(cells.every((cell) => cell.strikethrough === false)).toBe(true)
    expect(cells.every((cell) => cell.bg === null)).toBe(true)
  })

  test('**字标是死的常量**——同一列数取几帧，一个字节都不差（没有钟、没有随机）', async () => {
    const stage = createStage()
    const first = await stage.screen({ columns: 100, rows: 30 })
    const second = await stage.screen({ columns: 100, rows: 30 })

    expect(headOf(first, 5)).toEqual(headOf(second, 5))
  })
})

// ══ ⑧ 块字符不自动检测 ═════════════════════════════════════════════

describe('⑧ 默认用块字版（不做字体检测）', () => {
  test('**没有任何宽度切到 ASCII 版**——不检测，也就不切换', () => {
    const asciiLines = new Set(BANNER_ASCII)

    for (let columns = 0; columns <= 200; columns += 1) {
      expect(bannerOf(columns).some((line) => asciiLines.has(line.text))).toBe(false)
    }
    // 防空转：那一份里确实有东西可切（否则上面那句等于没断言）
    expect(asciiLines.size).toBe(5)
  })

  test('够宽就是**块字符**（默认那一版），不是 ASCII', async () => {
    expect((await frameAt(200)).record[0]?.text).toContain('█')
    expect((await frameAt(200)).record[0]?.text).not.toContain('#')
  })

  test('ASCII 那份**留着，且是完好的资源**——53 列 × 5 行，全部可打印 ASCII', () => {
    expect(BANNER_ASCII).toHaveLength(5)
    expect(BANNER_ASCII.every((line) => line.length === 53)).toBe(true)
    expect(BANNER_ASCII.every((line) => [...line].every((char) => char >= ' ' && char <= '~'))).toBe(true)
  })

  test('块字版也是**53 列 × 5 行**（与设计文档核对的画幅对得上）', () => {
    expect(BANNER_WIDE).toHaveLength(5)
    expect(BANNER_WIDE.every((line) => line.length === 53)).toBe(true)
  })
})

// —— 一件小工具（色那两条用）——

/**
 * 录一段字节，**色档自己拧**——`3` ＝ 真彩终端 · `0` ＝ 无色终端。
 *
 * 档位是**环境**给的（`chalk` 看 `FORCE_COLOR` / TTY，见 `screen.ts` 与 `terminal.ts` 的注），
 * 而「无色终端用默认前景」这句话**只有把档拧到 0 才量得到**——不拧的话测试进程
 * 量到的永远是「没开色」，**那不是「代码没上色」**（D17 那族的老账）。
 * 用完还原，别把档位漏给别的用例。
 */
async function bytesAt(view: ShellView, columns: number, level: 0 | 3): Promise<string> {
  const restore = chalk.level
  chalk.level = level
  try {
    return await record([h(AppView, { key: 'banner', view, columns, rows: 30 })], { columns, rows: 30 })
  } finally {
    chalk.level = restore
  }
}
