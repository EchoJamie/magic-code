/** TUI Banner：当前两种终端验收规格下的资源、位置、颜色与交互。规格来源：文档库品牌视觉/TUI Banner 设计.md。 */

import { describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import { createElement as h } from 'react'
import type { Entry } from '@magic/contracts'
import {
  BANNER_ASCII,
  BANNER_INDENT,
  BANNER_WIDE,
  bannerOf,
} from '../src/banner.ts'
import { AppView } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { blankRuns } from './invariants.ts'
import { createStage, show } from './screen.ts'
import type { Frame } from './screen.ts'
import { createSpyTransport } from './fakes.ts'
import { record } from './terminal.ts'

/** 记录区的**前几行**（字标那一块在这儿）——取景那几处都从这条进。 */
const headOf = (frame: Frame, count: number): readonly string[] =>
  frame.record.slice(0, count).map((line) => line.text)

/**
 * 字标**画幅**的首行在记录区的第几行——**块首那一行是留白**（⑩：字标自成一块）。
 *
 * 写成字面量而不是「找第一行含 `█` 的」：那一行**必须**是这个位置（前面正好一行留白），
 * 找出来的话就把⑩那条判据绕过去了。
 */
const ART_FROM = 1

/** 字标**画幅**那几行（块首那行留白跳过）。 */
const artOf = (frame: Frame, count: number): readonly string[] =>
  headOf(frame, ART_FROM + count).slice(ART_FROM)

/** 字标**画幅**首行在屏上的行号（读格用）。 */
const artRow = (frame: Frame): number => frame.record[ART_FROM]?.row ?? 0

/** 抹行尾（帧上的行尾空白被归一化过，比形状时两边口径要一样）。 */
const trimmed = (lines: readonly string[]): readonly string[] => lines.map((line) => line.replace(/\s+$/u, ''))

/** 块字版在屏上的样子——**左留 2 列**（设计：建议左右各留 2 列空白）。 */
const WIDE_ON_SCREEN = trimmed(BANNER_WIDE.map((line) => `  ${line}`))

/** 起一个壳，取一帧。 */
const frameAt = async (columns: number, rows = 40): Promise<Frame> =>
  createStage().screen({ columns, rows })

// ══ ① 宽 ⇒ 块字版 ═══════════════════════════════════════════════════

describe('① 窗口够宽 ⇒ 块字版', () => {
  test('**≥57 列**：记录区最前面就是那 5 行块字，一字不差（左留 2 列白）', async () => {
    const frame = await frameAt(100)

    expect(artOf(frame, 5)).toEqual(WIDE_ON_SCREEN)
    // 一字不差那条之外，再钉「**是块字符**」——否则换成 ASCII 版这条照样绿
    expect(WIDE_ON_SCREEN.join('')).toContain('█')
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

    const frame = await stage.screen({ columns: 200, rows: 40 })
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

  // ⚠️ **本条 2026-09-24 按新行为改写**（U43 · 缺陷 D28 乙的裁定）：原句是
  //    『换会话（记录区清空重来）——字标照旧在最前面』，钉的是 `settled` 里有**新种的一条字标**
  //    （`toHaveLength(1)` ＋ `settled[0].kind === 'banner'`）。裁定『换会话不重印』之后，
  //    那一条正是要它**不在**的东西——**判据没删，换成了它的反面**：
  //    ① 这一页里**一条字标都没有**；② 而**屏上仍只有一份**（开机印的那一份）。
  test('换会话（记录区清空重来）——**不种新字标**，屏上仍是开机那一份（U43）', async () => {
    const stage = createStage()
    // ⚠️ **逐帧录**（`show(views)` 而不是一帧一屏）：这一句的下半问的是「屏幕上累计印了几份」，
    //    单帧取景只看得到「这一页里有没有字标」——那正是本单要它没有的那一件
    //    （`describe('④')` 里「内联随内容滚动」那条同此：时机类的话只在帧序里现形）
    const views: ShellView[] = [stage.shell.getView()]
    stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲' }] })])
    views.push(stage.shell.getView())
    stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙' }] })])
    views.push(stage.shell.getView())

    const view = stage.shell.getView()

    // 这一页**清空重来**（内容由随后读回来的历史铺），而**字标不在它上面**
    expect(view.settled).toHaveLength(0)
    expect(view.page).toBeGreaterThan(0) // 确实另开了一页（防空转）

    // 屏上仍是**一份**：开机印的那一份。换会话既不重印，也擦不掉它
    //（内联渲染＋主缓冲：已写出去的内容归终端——形态本身的限度，见缺陷 D28 乙）
    const frame = await show(views, { columns: 100, rows: 40 })
    expect(frame.screen.lines.filter((line) => line === WIDE_ON_SCREEN[0])).toHaveLength(1)
  })

  // ⚠️ **删掉过一条**（U31 三轮）：『**空态没有被字标挡住**』——那句空态引导语
  //    （`你按下第一次回车时才建立`）2026-09-20 由用户定删（没有动作价值，原型早已删掉，
  //    见 `app.ts` 那一段注）。被挡住的判据没了载体，这条随之去掉；
  //    本节前两条（重建 / 换会话之后字标仍在最前）没动。
})

// ══ ⑥ 配色 ═════════════════════════════════════════════════════════

describe('⑥ 配色', () => {
  /** 一格里非空格子的颜色（去重）——`MAGIC` 与 `CODE` 各量一半。 */
  const colorsOf = (frame: Frame, from: number, to: number): readonly (string | null)[] => {
    const row = artRow(frame)

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
    const row = artRow(frame)

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
    const art = artOf(frame, 5).join('\n')

    // 把画幅原样去掉之后，剩不下任何东西（多一行字都会露出来）
    expect(art.replace(/[█\s]/gu, '')).toBe('')
    expect(art).not.toContain('折跃')
    expect(art).not.toContain('v0')
    expect(art).not.toContain('Magic Code') // 那是窄屏那一版，不是块字版的第 6 行
  })

  test('不加动效 · 不加重 ——字标每一格都不粗、不斜、不删线、不换色底', async () => {
    const frame = await frameAt(100)
    const row = artRow(frame)
    const cells = frame.cellsOf(row)

    expect(cells.every((cell) => cell.bold === false)).toBe(true)
    expect(cells.every((cell) => cell.strikethrough === false)).toBe(true)
    expect(cells.every((cell) => cell.bg === null)).toBe(true)
  })

  test('**字标是死的常量**——同一列数取几帧，一个字节都不差（没有钟、没有随机）', async () => {
    const stage = createStage()
    const first = await stage.screen({ columns: 100, rows: 40 })
    const second = await stage.screen({ columns: 100, rows: 40 })

    expect(artOf(first, 5)).toEqual(artOf(second, 5))
  })
})

// ══ ⑧ 块字符不自动检测 ═════════════════════════════════════════════

describe('⑧ 默认用块字版（不做字体检测）', () => {
  test('**没有任何宽度切到 ASCII 版**——不检测，也就不切换', () => {
    const asciiLines = new Set(BANNER_ASCII)

    for (const columns of [200, 100]) {
      expect(bannerOf(columns).some((line) => asciiLines.has(line.text))).toBe(false)
    }
    // 防空转：那一份里确实有东西可切（否则上面那句等于没断言）
    expect(asciiLines.size).toBe(5)
  })

  test('够宽就是**块字符**（默认那一版），不是 ASCII', async () => {
    expect(artOf(await frameAt(200), 1)[0]).toContain('█')
    expect(artOf(await frameAt(200), 1)[0]).not.toContain('#')
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

// ══ ⑨ 左缩进 2 列（两版同一个性格）═══════════════════════════════════

/**
 * 规格出处：`界面原型.html` 场景 1 —— `.banner{padding-left:2ch}` 与那段注
 * 「窄些＝一行 `Magic Code`（**同样缩 2 列，退让时别换性格**）」。
 */
describe('⑨ 左缩进 2 列——两版同一个性格', () => {
  test('块字版：画幅每一行前面就是那 2 列留白', async () => {
    const frame = await frameAt(100)
    const art = artOf(frame, 5)

    expect(art.every((line) => line.startsWith(BANNER_INDENT))).toBe(true)
    // 防空转：留白确实是 2 格，且留白之后**真接着画幅**（不是整行恰好以空格开头）
    expect(BANNER_INDENT).toBe('  ')
    expect(art[0]?.slice(2, 3)).toBe('█')
  })

  test('**两版的左边缘在同一列上**——96 列与 40 列画出来，字标都从第 3 列起', async () => {
    // 这一条是「同一个性格」的**尺子**：不比字面量，比两帧上第一个非空格落在第几列
    const firstInk = async (columns: number): Promise<number> => {
      const frame = await frameAt(columns)

      return frame.cellsOf(artRow(frame)).findIndex((cell) => cell.text.trim() !== '')
    }

    expect(await firstInk(96)).toBe(2) // 块字版：留白 2 ＋ 画幅
    expect(await firstInk(40)).toBe(2) // 一行版：留白 2 ＋ `Magic Code`
  })
})

// ══ ⑩ 自成一块（前后各一行留白）══════════════════════════════════════

/**
 * 规格出处：`界面原型.html` 场景 1 —— `.banner{margin:0 0 17px}` 与 `.log` 的上留白，
 * 以及那段注：「启动时先印 Banner——它**自成一块**：左缩进 2 列 · **前后各一行留白**
 * （它与引导语是两种东西——品牌 vs 空态提示，**贴着就成了「硬放」**）」。
 *
 * 用户当场的批评：「真就直接硬放一个 banner 呗 一点布局设计都没有的那种」。
 *
 * ⚠️ 那段注里作对照的「引导语」（空态提示）2026-09-20 已由用户定删——**字标自成一块**
 * 这条不受影响（它量的是那一块前后的留白），只是块之后不再是引导语、而是那条分隔线。
 */
describe('⑩ 字标**自成一块**——前后各一行留白', () => {
  test('块＝前留白 ＋ 画幅 ＋ 后留白（块之后**紧接着**是记录区收尾那条分隔线）', async () => {
    const frame = await frameAt(100)
    const texts = headOf(frame, 8)

    expect(texts[0]?.trim()).toBe('') // ① 前：一行留白
    expect(texts.slice(1, 6).join('')).toContain('█') // ② 中：5 行画幅
    expect(texts[6]?.trim()).toBe('') // ③ 后：一行留白
    // ⚠️ **换过锚**（U31 三轮）：原锚是 `texts[7]` ＝ 空态引导语那句（「紧接着才是引导语」）——
    //    那句已由用户定删（没有动作价值，原型早已删，见 `app.ts` 的注）。**新锚**：记录区
    //    到块尾**戛然而止**（那一屏上记录区就只有这一块，共 7 行）——**自成一块**这条主句没变：
    //    画幅末行之后**恰好一行**留白，多一行就是成片空行（`invariants` 的 `blankRuns` 会红）。
    //    （分隔线不在 `record` 里——`Frame` 把它划在记录区**之下**，故这里数的是块本身。）
    expect(texts).toHaveLength(7)
  })

  test('留白**不叠**：字标之后紧接用户消息时，中间只有一行空', async () => {
    // 字标自带后留白，而「用户消息之前留一行分段」也是同一件事——
    // 不排掉的话会空两行（成片空行，`invariants.blankRuns` 当场红）
    const stage = createStage()
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '答一' }),
      event('turn.end', { reason: 'settled' }),
    ])

    const frame = await stage.screen({ columns: 100, rows: 40 })
    const texts = headOf(frame, 8)

    expect(texts.slice(1, 6).join('')).toContain('█') // 画幅还在最前
    expect(texts[6]?.trim()).toBe('') // 后留白（一行）
    expect(texts[7]).toContain('› 第一句') // 紧接着就是那条用户消息
    expect(blankRuns(frame.screen)).toEqual([]) // 记录区里没有成片空行
  })
})

async function bytesAt(view: ShellView, columns: number, level: 0 | 3): Promise<string> {
  const restore = chalk.level
  chalk.level = level
  try {
    return await record([h(AppView, { key: 'banner', view, columns, rows: 40 })], { columns, rows: 40 })
  } finally {
    chalk.level = restore
  }
}
