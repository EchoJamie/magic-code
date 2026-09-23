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
 * | ⑨ | **左缩进 2 列**——**两版同一个性格**（一行版也缩，退让时不换性格） | `describe('⑨')` |
 * | ⑩ | **自成一块**：**前后各一行留白**——它与引导语是两种东西，贴着就成了「硬放」 | `describe('⑩')` |
 * | ⑪ | 宽度判据是**整块宽**（画幅 ＋ 那 2 列留白）——**留白不算可用宽度**，窄一列就顶边 | `describe('⑪')` |
 *
 * ⑨⑩⑪ 是 **2026-09-20「首屏布局收口」**那一轮的三条（用户看了真机截图：「真就直接硬放一个
 * banner 呗 一点布局设计都没有的那种」——顶格贴左上角、紧挨着引导语）。规格出处：
 * vault `界面原型.html` 场景 1 新落的 `.banner{padding-left:2ch;margin:0 0 17px}` 与那段注。
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
  BANNER_INDENT,
  BANNER_WIDE,
  BANNER_WIDE_MIN,
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
const frameAt = async (columns: number, rows = 30): Promise<Frame> =>
  createStage().screen({ columns, rows })

// ══ ① 宽 ⇒ 块字版 ═══════════════════════════════════════════════════

describe('① 窗口够宽 ⇒ 块字版', () => {
  test('**≥57 列**：记录区最前面就是那 5 行块字，一字不差（左留 2 列白）', async () => {
    const frame = await frameAt(100)

    expect(artOf(frame, 5)).toEqual(WIDE_ON_SCREEN)
    // 一字不差那条之外，再钉「**是块字符**」——否则换成 ASCII 版这条照样绿
    expect(WIDE_ON_SCREEN.join('')).toContain('█')
  })

  test('阈值**正好是 57**（＝53 列画幅 ＋ 左右各 2 列留白）——56 列就不给块字版了', async () => {
    expect(BANNER_WIDE_MIN).toBe(57)
    expect(BANNER_WIDE[0]?.length).toBe(53)

    expect(artOf(await frameAt(57), 5)).toEqual(WIDE_ON_SCREEN)
    expect(artOf(await frameAt(56), 1)).not.toEqual(WIDE_ON_SCREEN.slice(0, 1))
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
  test('**窄于 57 列**：换成一行完整产品名（画幅 10 列）', async () => {
    const frame = await frameAt(45)

    // ⚠️ 左 2 列留白也在——**同一块东西，退让时别换性格**（⑨ 是它自己的判据）
    expect(artOf(frame, 1)).toEqual([`${BANNER_INDENT}${BANNER_COMPACT}`])
    expect(BANNER_COMPACT).toBe('Magic Code')
    expect(BANNER_COMPACT.length).toBe(10)
  })

  test('**不缩写成 M、不附加 Icon**——整行就是那两个词', async () => {
    const line = artOf(await frameAt(45), 1)[0] ?? ''

    expect(line.trim()).toBe('Magic Code')
    expect(line).not.toContain('█')
  })

  test('一行版的分色点＝两个词之间（`Magic` ｜ ` Code`）', async () => {
    const frame = await frameAt(45)
    const cells = frame.cellsOf(artRow(frame))

    // 左 2 列留白 ＋ `Magic` 5 字 ⇒ `Magic` 占 2..6、空档在 7、`Code` 从 8 起
    expect(cells[6]?.text).toBe('c') // `Magic` 末字
    expect(cells[2]?.fg).toBe('#56b6c2') // Magic —— 品牌青
    expect(cells[8]?.fg).toBe('#d8dce4') // Code —— 主文字色
  })

  test('阈值**正好是 12**（＝10 列画幅 ＋ 同样那 2 列左留白）', async () => {
    // ⚠️ **原锚** `toBe(10)` ＋ `bannerOf(10)` 有 1 行——那时这个 10 是**画幅**宽，
    //    而一行版**不带缩进**（贴在最左边），故「放得下 10 列」就等于「放得下整块」。
    //    **为何变**：2026-09-20「首屏布局收口」给一行版补上了那 2 列左留白（⑨：同一块东西，
    //    退让时别换性格）⇒ 它落进界面之后占的是 **12** 列，而判据的口径是**整块宽**
    //    （⑪：留白不算可用宽度）。照字面的 10 放行的话，10～11 列的终端上这一行会被折成两行
    //    ——恰好违背这一档的由头（「优先保证正文与输入空间」：装饰反而多占一行）。
    //    **新锚** `toBe(12)`：放不下 10 ＋ 2 ⇒ 不印。**规划侧若判「按字面的 10 放行」**，
    //    改回 `bannerOf` 那一支即可（这里会当场红，正是该红的地方）。
    expect(BANNER_COMPACT_MIN).toBe(12)

    expect(bannerOf(12)).toHaveLength(1)
    expect(bannerOf(11)).toHaveLength(0)
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
    const frame = await show(views, { columns: 100, rows: 30 })
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
    const first = await stage.screen({ columns: 100, rows: 30 })
    const second = await stage.screen({ columns: 100, rows: 30 })

    expect(artOf(first, 5)).toEqual(artOf(second, 5))
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

  test('一行版**同样缩 2 列**——退让时不换性格', async () => {
    // ⚠️ **原锚** `['Magic Code']`——那时一行版**贴在最左边**（缩进只给了块字版）。
    //    **为何变**：2026-09-20「首屏布局收口」——同一个字标在两种宽度下不许是两个性格
    //    （规划侧原话：「同一块东西，退让时别换性格」）。缩进因此从块字版推广到一行版。
    //    **新锚** `['  Magic Code']`——那 2 列是**留白**（跟着首段着色，肉眼仍是空白）。
    const frame = await frameAt(45)

    expect(artOf(frame, 1)).toEqual([`${BANNER_INDENT}${BANNER_COMPACT}`])
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

  test('一行版**照旧自成一块**（缩进退了，形状不退）', async () => {
    const texts = headOf(await frameAt(45), 4)

    expect(texts[0]?.trim()).toBe('')
    expect(texts[1]?.trim()).toBe('Magic Code')
    expect(texts[2]?.trim()).toBe('')
    expect(texts).toHaveLength(3) // 记录区到块尾为止（原锚：块之后是空态引导语那句，已删）
  })

  test('**极窄不印时一行都不占**——连那两行留白也不留', async () => {
    // 「不印」是字面意思：顶上第一行就是内容，不是「先空两行再说」
    //
    // ⚠️ 本条钉的是**字标块占了几行**（0 行）——与块之外那些行怎么写无关
    //（原先这里注着「不钉引导语的措辞」：那句引导语 2026-09-20 已整句删掉，见 `app.ts` 的注）。
    const frame = await frameAt(9)

    expect(frame.record[0]?.text.trim()).not.toBe('') // ① 顶上**不是空行**
    expect(frame.record.every((line) => !line.text.includes('█'))).toBe(true) // ② 整屏没有字标
    expect(bannerOf(9)).toEqual([]) // 防空转：这一档确实不印
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

    const frame = await stage.screen({ columns: 100, rows: 30 })
    const texts = headOf(frame, 8)

    expect(texts.slice(1, 6).join('')).toContain('█') // 画幅还在最前
    expect(texts[6]?.trim()).toBe('') // 后留白（一行）
    expect(texts[7]).toContain('› 第一句') // 紧接着就是那条用户消息
    expect(blankRuns(frame.screen)).toEqual([]) // 记录区里没有成片空行
  })
})

// ══ ⑪ 判据是整块宽（留白不算可用宽度）════════════════════════════════

/**
 * 规格出处：`界面原型.html` 场景 1 那段注 ——
 * 「**≥57 列**＝块字版（**57 ＝ 53 ＋ 左右各 2** —— 那 2 列是留白，**别算进可用宽度**）」。
 *
 * 一句话：**下限判的是「整块放不放得下」，不是「画幅放不放得下」**。
 * 照画幅宽放行＝把那 2 列留白算成了可用宽度 ⇒ 窄一列就顶边。
 */
describe('⑪ 判据是**整块宽**——留白不算可用宽度', () => {
  test('块字版：**53～56 列不给**（画幅放得下，加上那 2 列留白就顶边了）', async () => {
    for (const columns of [53, 54, 55, 56]) {
      const lines = bannerOf(columns)

      expect(lines).toHaveLength(1) // 退到一行版——而不是硬塞块字
      expect(lines[0]?.text).not.toContain('█')
      // 退回去的那一档也**不折行**（两档都不许顶边）
      expect((await frameAt(columns)).screen.wrapped.some(Boolean)).toBe(false)
    }

    expect(bannerOf(57)).toHaveLength(5)
  })

  test('块字版在 57 列上：**右边还剩 2 列**（57 ＝ 左 2 ＋ 53 ＋ 右 2）', async () => {
    const frame = await frameAt(57)

    expect(artOf(frame, 1)[0]?.length).toBe(55) // 左 2 ＋ 画幅 53
    expect(frame.screen.wrapped[artRow(frame)]).toBe(false) // 终端没替我们折行
    // 那 2 列右留白是**真的空着**——字标没顶到最后一列
    const cells = frame.rawCellsOf(artRow(frame))

    expect(cells.slice(55, 57).every((cell) => cell.text.trim() === '')).toBe(true)
  })

  test('一行版：**11 列不给、12 列才给**（10 列画幅 ＋ 同样那 2 列留白）', async () => {
    // ⚠️ 判据不用「帧文本里有没有 `Magic Code`」——那条路是**折行**走过的
    //    （11 列放一行版，终端会把它折成 `  Magic Cod` ＋ `e`，那串字在帧上不连续，
    //    于是反向验证时把下限掐掉它照样绿）。改用 ③ 那把折不断的尺子：**比字节**。
    const view = createStage().shell.getView()
    const stripped: ShellView = { ...view, settled: view.settled.filter((row) => row.kind !== 'banner') }

    expect(view.settled.some((row) => row.kind === 'banner')).toBe(true) // 防空转

    expect(await bytesAt(view, 11, 0)).toBe(await bytesAt(stripped, 11, 0)) // 11 列：一个格子都没占
    expect(await bytesAt(view, 12, 0)).not.toBe(await bytesAt(stripped, 12, 0)) // 12 列：占上了
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
