/**
 * U45 · **字标按「开一条新的」印** ＋ **交互区下沿那条分隔线**——规格即测试。
 *
 * 两件事都在同一块屏上（工单并作一单），各判各的。
 *
 * ## 之一 · 字标是「开一条新的」的记号（设计 · 终端呈现）
 *
 * | 哪一跳 | 字标 |
 * | --- | --- |
 * | **开机** | **印** |
 * | **`/clear`**（开一条新的） | **印** |
 * | **`/resume`**（翻回已有的一页） | **不印**——页头另有 `· 已切到 <名字>` 划界 |
 *
 * 三处里**开机**与 **`/resume`** 归 `spec.u43.test.ts` / `spec.banner.test.ts` 那两处量
 * （前者已把「换会话不重印」钉在该文件 ①，后者钉开机的份数）；本文件补的是**这一条改判之后
 * 才存在的那两格**：
 *
 * - **`/clear` 那一页从字标起**（那一页原先是**全空**的——那正是本单的由头：
 *   一屏只剩分隔线贴顶，**看着像故障，不像开张**）；
 * - **内核挡回时一条都不种**（`note` 在＝这一跳没成）：空手开机、首条消息正跑着时按 `/clear`，
 *   `view.sessionId` 还是 `null`——「`null → 活跃位`」落在「换页」那一格里，若不认 `note`，
 *   屏被清掉、字标**凭空多印一块**，而内核其实一个字都没答应。
 *
 * ## 之二 · 交互区下沿那条线
 *
 * 一屏**恰好两条**满宽分隔线（记录区／交互区之间 ＋ 交互区下沿），**同宽同色**；
 * 输入行与状态行被夹在当中；**两条之外不多线**（工单硬约束 3）；
 * 极窄档照旧整宽（既有那一手，不新造分支）——且**账与屏同源**（`CHROME_LINES` 那一笔：
 * 少算了，矮窗上帧正好顶满 ⇒ 真光标高一行，那是 U31 那一族的老病）。
 */

import { describe, expect, test } from 'bun:test'
import { bannerOf } from '../src/banner.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { blankRuns } from './invariants.ts'
import { createStage, show } from './screen.ts'
import type { Frame, ScreenOptions, Stage } from './screen.ts'

const ENTER = { kind: 'enter' } as const
const WIDE: ScreenOptions = { columns: 100, rows: 30 }

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/** 屏上那两条线的行号（顶 → 底）——**恰好两条**由调用方自己钉。 */
const rulesOf = (frame: Frame): readonly number[] =>
  frame.screen.lines.map((text, row) => ({ text, row })).filter((entry) => isRule(entry.text)).map((entry) => entry.row)

/** 一条答复（`session.state`）——`note` 给不给按那一跳成没成。 */
const state = (active: string, note?: string) =>
  event('session.state', {
    active,
    sessions: [{ id: active, at: 0, title: '甲的事' }],
    ...(note === undefined ? {} : { note }),
  })

/** 逐帧录一串——开机那一屏 ＋ 其后每步一拍（同 `spec.u43.test.ts` 的 `takes`）。 */
function takes(stage: Stage, steps: readonly (() => void)[]): readonly ShellView[] {
  const views: ShellView[] = [stage.shell.getView()]
  for (const step of steps) {
    step()
    views.push(stage.shell.getView())
  }

  return views
}

/** 整份缓冲里字标画幅首行出现几次——**每多一份 ＝ 终端上多一块字标**。 */
function bannerCopies(frame: Frame, columns: number): number {
  const art = (bannerOf(columns)[0]?.text ?? '').replace(/\s+$/u, '')

  return frame.screen.lines.filter((line) => line.replace(/\s+$/u, '') === art).length
}

// ══ 之一 · `/clear` 那一页从字标起 ═══════════════════════════════════

describe('之一 · `/clear`（开一条新的）⇒ 那一页印字标', () => {
  /** 敲一句 `/clear` ＋ 它那一跳的答复（开成了：活跃位换了）。 */
  const cleared = (stage: Stage, to: string): readonly (() => void)[] => [
    () => stage.type('/clear'),
    () => stage.press(ENTER),
    () => stage.feed([state(to)]),
  ]

  test('**这一页从字标起**（原先是全空——那正是本单的由头）', async () => {
    const stage = createStage()
    const views = takes(stage, [() => stage.feed([state('s1')]), ...cleared(stage, 's2')])
    const frame = await show(views, WIDE)

    // 视图那一侧：这一页**只有字标那一行**（不是「铺了条回执顶着」）
    expect(stage.shell.getView().settled.map((row) => row.kind)).toEqual(['banner'])
    // 屏那一侧：**两块**（开机那块 ＋ 这一跳种的）——份数钉精确值，多一块少一块都是要看的
    expect(bannerCopies(frame, WIDE.columns)).toBe(2)
    // 而这一页的**顶行就是它**（不是「只剩分隔线贴顶」）
    const art = (bannerOf(WIDE.columns)[0]?.text ?? '').replace(/\s+$/u, '')
    expect(frame.screen.lines.find((line) => line.trim() !== '')).toBe(art)
  })

  test('**不另发文案**：这一页上一条回执都没有（回执就是清屏 ＋ 字标）', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([state('s1')]),
      () => stage.type('先交代一句'),
      () => stage.press(ENTER),
      ...cleared(stage, 's2'),
    ])
    const frame = await show(views, WIDE)
    const view = stage.shell.getView()

    // 视图那一侧：这一页里**除字标之外一条不剩**（不是「铺了条回执顶着」）
    expect(view.settled.filter((row) => row.kind !== 'banner')).toHaveLength(0)
    // 屏那一侧：整份缓冲里一条 `·` 回执都没有（U43 补条那句 `· 已开一条新会话` 之后
    // `/clear` 就没再说过话——U45 也没给它补一句）
    expect(frame.screen.lines.filter((line) => line.trimStart().startsWith('· '))).toHaveLength(0)
  })
})

// ══ 之一 · 内核挡回时：一页都不开、一块都不种 ═══════════════════════════

describe('之一 · 内核挡回（`note` 在）⇒ 不翻页、不种字标', () => {
  /**
   * **本单最容易漏的那一格**（工单的边界）：外壳**不会**在首条消息开张时收到 `session.state`，
   * 故 `view.sessionId` 一直是 `null`——此后按 `/clear` 若被内核挡回，那一跳落进
   * 「`null → 活跃位` ⇒ 换页」这一格里：屏被清掉、字标**凭空多印一块**，而内核一个字都没答应。
   */
  test('`null → 活跃位` 那一跳若被挡回（`note` 在）⇒ 页不动、字标不种', async () => {
    const stage = createStage()
    // 空手开机（没有会话）⇒ `/clear` ⇒ 内核忙，活跃位没动、带一句 `note` 挡回
    takes(stage, [
      () => stage.type('/clear'),
      () => stage.press(ENTER),
      () => stage.feed([state('s1', '正在跑一轮——先 Ctrl+C 中断')]),
    ])
    const view = stage.shell.getView()

    expect(view.sessionId).toBe('s1') // 活跃位照实记下（那是内核说的真话）
    expect(view.page).toBe(0) // 但**没有翻页**（什么都没发生，屏不该动）
    expect(view.settled.map((row) => row.kind)).toEqual(['banner', 'receipt']) // 种的是那行 note，不是新字标
    expect(stage.spy.commands.some((command) => command.type === 'session.new')).toBe(true) // 防空转：命令真发出去过
  })

  test('**同一条判据的正面**：没被挡回的那一跳照常翻页 ＋ 种字标（不然上面那条等于没判）', async () => {
    const stage = createStage()
    takes(stage, [
      () => stage.type('/clear'),
      () => stage.press(ENTER),
      () => stage.feed([state('s1')]), // 没有 `note` ＝ 成了
    ])
    const view = stage.shell.getView()

    expect(view.page).toBe(1)
    expect(view.settled.map((row) => row.kind)).toEqual(['banner'])
  })
})

// ══ 之二 · 两条分隔线 ═════════════════════════════════════════════════

describe('之二 · 交互区下沿那条分隔线', () => {
  test('一屏**恰好两条**满宽线，且**同宽同色**（走既有那条的样式）', async () => {
    const frame = await createStage().screen(WIDE)
    const rows = rulesOf(frame)

    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // 整宽：一个不少（100 列）
      expect([...(frame.screen.lines[row] as string)].length).toBe(WIDE.columns)
      // 同色：两行每一格都是 `ghost`（两条线走的是同一处 `separatorOf`）
      const colors = new Set(frame.cellsOf(row).map((cell) => cell.fg))
      expect(colors).toEqual(new Set(['#49505e']))
    }
  })

  test('**输入行与状态行夹在当中**——三块一眼分得开', async () => {
    const frame = await createStage().screen(WIDE)
    const [top, bottom] = rulesOf(frame) as [number, number]
    const composer = frame.screen.lines.findLastIndex((line) => line.includes('›'))
    const status = frame.screen.lines.findLastIndex((line) => line.includes('○ ') || line.includes('● '))

    expect(composer).toBeGreaterThan(top)
    expect(composer).toBeLessThan(bottom)
    expect(status).toBeGreaterThan(composer)
    expect(status).toBeLessThan(bottom)
  })

  test('**两条之外不多线**：记录区里没有、输入行与状态行之间也没有', async () => {
    const stage = createStage()
    stage.type('先交代一句')
    stage.press(ENTER)
    stage.feed([event('turn.start', {}), event('model.delta', { channel: 'text', text: '好。' }), event('turn.end', { reason: 'settled' })])
    const frame = await stage.screen(WIDE)

    expect(rulesOf(frame)).toHaveLength(2)
    // 记录区里一条都没有（用户那句、答复那句都是内容，不是线）
    expect(frame.record.some((line) => isRule(line.text))).toBe(false)
  })

  test('**极窄档照旧整宽**（既有那一手，不新造分支）：9 列两条都在，也没有成片空行', async () => {
    const frame = await createStage().screen({ columns: 9, rows: 24 })

    expect(rulesOf(frame)).toHaveLength(2)
    for (const row of rulesOf(frame)) {
      expect(frame.screen.lines[row]).toBe('─'.repeat(9)) // 整宽——不是「按内容缩排」
    }
    expect(blankRuns(frame.screen)).toEqual([]) // 没切出多余的空行
  })

  test('**账与屏同源**：动态帧仍短于这一屏（矮窗上不许顶满——U31 那一族的老病）', async () => {
    // 40×10：活动区预算只剩 1 行，账里少算一条线的话，帧正好顶满 ⇒ 真光标高一行
    const stage = createStage()
    stage.type('a'.repeat(120))
    const frame = await stage.screen({ columns: 40, rows: 10 })
    const last = frame.screen.lines.findLastIndex((line) => line.trim() !== '')

    expect(last).toBeLessThan(10)
    expect(rulesOf(frame)).toHaveLength(2)
    expect(blankRuns(frame.screen)).toEqual([])
  })
})
