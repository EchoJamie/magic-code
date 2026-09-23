/**
 * U26 · 会话面 —— `/resume` 列表**按工作区分组**（规格即测试）。
 *
 * 出处：`项目字典.md` · Workspace / Session（2026-09-19）——一个会话属于一个工作区；
 * `工作分解.md` · `U26` 的实现落点（规划侧 2026-09-19 裁）：
 * **分组头 ＋ 全部列出**（别的项目**压暗、仍可切**）。
 *
 * **为什么全部列出而不是藏起来**（裁决理由，照抄）：列表是「**找到会话**」的地方，
 * 藏起来＝找不到；而**换个目录接着上次的活是真场景**。
 *
 * **压暗是相对谁**——「别的项目」＝**本进程工作区之外**的那些（你此刻所在的目录）。
 * 由头就是这个单元要解决的问题：换个目录启动、切过去，旧任务会在另一个项目里接着跑
 * ——列表得让这件事**看得出来**。故本工作区没有会话时，**光标之外满屏皆暗**（正确的信号）。
 *
 * 两处例外，都在用例里说明：① **「正在用」压过压暗**（当前那条永远亮着——压暗是视觉次序，
 * 不是把当前那条藏掉）；② **光标那一行**（选择器起手总得落在一个位置）。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, SessionSummary } from '@magic/contracts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'
import { event } from './events.ts'

const HERE = '/work/alpha'
const ELSEWHERE = '/work/beta'

/** 色板里的两档（断言用字面量，与实现各自独立——色板改动时这里当场红）。 */
const DIM = '#8b93a1'
const FAINT = '#5a626f'

type Row = { readonly id: string; readonly title?: string; readonly workspace?: readonly string[] }

const state = (active: string, rows: readonly Row[]) =>
  event('session.state', {
    active,
    sessions: rows.map(
      (row): SessionSummary => ({
        id: row.id,
        at: 0,
        ...(row.title === undefined ? {} : { title: row.title }),
        ...(row.workspace === undefined ? {} : { workspace: row.workspace }),
      }),
    ),
  })

/**
 * 起一个「我在 `/work/alpha`」的壳——本进程的工作区就是它（`U26` 起由装配递进来）。
 *
 * 给 `null` ＝ **装配没给工作区**（不知道自己在哪儿）——与「给了一组空的」是两件事，
 * 与「省掉不写」更不是一件事（省掉＝缺省值，那是有工作区的）。
 */
function live(workspace: readonly string[] | null = [HERE]) {
  const stage = createStage(workspace === null ? {} : { workspaceRoots: workspace })

  return {
    stage,
    /**
     * 开 `/resume` 的选择器：投目录 → 敲命令 → **内核回话**（目录再来一次）。
     * 真链路上 `session.list` 是**当场**答的（进程内传输直连），故这一步在用例里
     * 就是「再喂一遍同一条 `session.state`」。
     */
    open: (catalog: readonly KernelEvent[]) => {
      stage.feed(catalog)
      stage.type('/resume')
      stage.press({ kind: 'enter' })
      stage.feed(catalog)
    },
  }
}

/** 分组头那一行的**可见**格（左边那格缩进是 Box 的 padding，没有色，不算）。 */
function headerCells(frame: Frame, head: string): ReturnType<Frame['cellsOf']> {
  return frame.cellsOf(frame.rowOf(head)).filter((cell) => cell.text.trim() !== '')
}

/**
 * 某一行的**标题那一格**——压暗看的就是它。
 *
 * ⚠️ 别拿整行「有没有 faint」当判据：序号那一格**恒是 faint**（当前那条除外），
 * 那是原型的既有样式，不是这一轮的压暗（那样量到的是别人的规格）。
 */
function labelCell(frame: Frame, title: string): { readonly fg: string | null } | undefined {
  return frame.cellsOf(frame.rowOf(title)).find((cell) => cell.text === title.slice(0, 1))
}

describe('分组头 ＋ 全部列出', () => {
  test('两组的头都在、每条会话都在**列**里，本工作区那组在前', async () => {
    const app = live()
    app.open([
      state('b1', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'a1', title: '甲项目的事', workspace: [HERE] },
      ]),
    ])

    const frame = await app.stage.screen()

    expect(frame.textAt(frame.rowOf(HERE))).toContain(HERE)
    expect(frame.rowOf(HERE)).toBeLessThan(frame.rowOf(ELSEWHERE)) // 本工作区那组在前
    expect(frame.has('甲项目的事')).toBe(true)
    expect(frame.has('乙项目的事')).toBe(true) // 「全部列出」——别的项目不藏
  })

  test('同一组的多条：头只画一次（不是每条都顶着它）', async () => {
    const app = live()
    app.open([
      state('a1', [
        { id: 'a1', title: '甲之一', workspace: [HERE] },
        { id: 'a2', title: '甲之二', workspace: [HERE] },
      ]),
    ])

    const frame = await app.stage.screen()
    const headers = frame.dock.filter((line) => line.text.includes(HERE))

    expect(headers).toHaveLength(1)
    expect(frame.has('甲之一')).toBe(true)
    expect(frame.has('甲之二')).toBe(true)
  })

  test('列加上之前落账的会话——单列一组「未记录」，**不编**一个工作区给它', async () => {
    const app = live()
    // 当前那条不在列里（空壳会话还没落账）——光标起手落第一条，按一下挪开，
    // 好量到「既非当前也非光标」的那一行（光标那一行是亮的，见上一条）
    app.open([
      state('shell', [
        { id: 'old', title: '早先的事' },
        { id: 'old2', title: '早先的另一件' },
      ]),
    ])
    app.stage.press({ kind: 'down' })

    const frame = await app.stage.screen()

    expect(frame.has('（工作区未记录）')).toBe(true)
    expect(frame.has('早先的事')).toBe(true)
    // **不拿「当下的启动目录」顶上**——判据落在**分组头**那一行上：
    //   原锚：`expect(frame.has(HERE)).toBe(false)`（整屏不许出现 HERE）。
    //   为何变：U27 起，本工作区没有会话时列表下方会报一句「本工作区：/work/alpha」
    //     （`sessionHint`——那正是「这儿是哪儿」，也正是本用例的由头）；于是 HERE 合法地
    //     上了屏，**整屏级的否定够不着**这条判据了（不是判据过期，是那把尺子太粗）。
    //   新锚：钉未记录那组的**头**——它就是「早先的事」上面那一行，且里头没有 HERE。
    const headRow = frame.rowOf('早先的事') - 1
    expect(frame.textAt(headRow)).toContain('（工作区未记录）')
    expect(frame.textAt(headRow)).not.toContain(HERE)
    // **也不压暗**：无从判断它是不是「别处」——不编（压暗留给判得实的那些）
    expect(labelCell(frame, '早先的事')?.fg).toBe(DIM)
  })

  test('多根工作区——分组头把**整组根**报出来（分隔符 ` · `，`[0]` 默认根在前）', async () => {
    const app = live([HERE, '/work/shared'])
    app.open([state('m1', [{ id: 'm1', title: '多根之下的事', workspace: [HERE, '/work/shared'] }])])

    const frame = await app.stage.screen()

    expect(frame.has(`${HERE} · /work/shared`)).toBe(true)
  })
})

describe('别的项目压暗 · 仍可切', () => {
  test('别的项目的行**压暗**（faint），本工作区的行是常规的弱（dim）', async () => {
    const app = live()
    app.open([
      state('a1', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'a1', title: '甲项目的事', workspace: [HERE] },
        { id: 'a2', title: '甲那边的另一件', workspace: [HERE] },
      ]),
    ])

    const frame = await app.stage.screen()

    expect(labelCell(frame, '乙项目的事')?.fg).toBe(FAINT)
    expect(labelCell(frame, '甲那边的另一件')?.fg).toBe(DIM)
  })

  /**
   * **「正在用」压过压暗**——当前那条永远亮着（哪怕它在别的项目里）。
   *
   * 由头：这一档只是**视觉次序**，而「你正在用哪条」比「它属于哪组」更该被看见——
   * 压暗是为了让本项目的会话浮上来，不是为了把当前那条藏掉。分组那件事不丢：
   * 它头顶那一行的头**照旧是暗的**。
   */
  test('当前那条在别的项目里 ⇒ 它自己**照旧亮**（头照旧暗）', async () => {
    const app = live()
    app.open([
      state('b1', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'b2', title: '乙项目的另一件', workspace: [ELSEWHERE] },
        { id: 'b3', title: '乙项目的第三件', workspace: [ELSEWHERE] },
      ]),
    ])
    // 光标从当前那条挪开——量到的才是「正在用」那一档，不是「光标」那一档
    app.stage.press({ kind: 'down' })

    const frame = await app.stage.screen()

    expect(labelCell(frame, '乙项目的事')?.fg).toBe('#56b6c2') // 「正在用」压过压暗
    expect(labelCell(frame, '乙项目的第三件')?.fg).toBe(FAINT) // 既非当前也非光标 ⇒ 照样压暗
    // 分组头那一行**照旧压暗**——归属这件事没说谎
    expect(headerCells(frame, ELSEWHERE).every((cell) => cell.fg === FAINT)).toBe(true)
  })

  /**
   * 换个目录启动的样子：列里全是别处的会话，**一条都不属于这儿**。
   *
   * ⚠️ 光标那一行是例外——选择器起手**总得落在一个位置**（落不上当前那条就落第一条），
   * 而光标是「你要按回车的那一条」，不是「属于这儿」。故这条判据看的是**光标之外**的行。
   */
  test('本工作区一条都没有 ⇒ 光标之外**满屏皆暗**', async () => {
    const app = live()
    // 空手打开：内核开的是一张**还没落账**的空壳（不在目录里），故列中没有「正在用」那条
    app.open([
      state('shell', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'b2', title: '乙项目的另一件', workspace: [ELSEWHERE] },
      ]),
    ])

    const frame = await app.stage.screen()
    expect(labelCell(frame, '乙项目的另一件')?.fg).toBe(FAINT)
    expect(headerCells(frame, ELSEWHERE).every((cell) => cell.fg === FAINT)).toBe(true)
  })

  test('压暗**不挡路**——照样选得中、回车就切过去', async () => {
    const app = live()
    app.open([
      state('a1', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'a1', title: '甲项目的事', workspace: [HERE] },
      ]),
    ])

    // 行序＝［甲（本工作区那组在前）· 乙］，选中项起手落在当前那条（甲）——下移一格即乙
    app.stage.press({ kind: 'down' })
    app.stage.press({ kind: 'enter' })

    // 最末那条才是这次选定（前面那条 `session.list` 是开选择器时发的）
    expect(app.stage.commands().at(-1)).toEqual({ type: 'session.open', session: 'b1' })
  })

  test('选中项落在**当前那条**上（分组之后序号跟着走）', () => {
    const app = live()
    app.open([
      state('a1', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'a1', title: '甲项目的事', workspace: [HERE] },
      ]),
    ])

    const dock = app.stage.shell.getView().dock
    if (dock.kind !== 'picker') throw new Error('选择器没开——判据取错了对象')

    // 分组之后的行序：甲（本工作区那组在前）· 乙 —— 当前那条是甲，故选中 0
    expect(dock.picker.rows.map((row) => row.value)).toEqual(['a1', 'b1'])
    expect(dock.picker.selected).toBe(0)
  })
})

/**
 * U27 · **列表下方那句说明**（`U26` 待决 2）——本工作区没有会话时，报一句「**这儿是哪儿**」。
 *
 * 由头：本工作区一条会话都没有时，整张表都是暗的——用户看得出「这些不是这儿的」，
 * 但**看不出「这儿」是哪儿**。故在那行 `hint` 里报出本工作区，且**与分组头同形**
 * （整组根、` · ` 隔开）——不同形就对不上是哪一组。
 *
 * ⚠️ **只在「本工作区没有会话」时报**：有会话时表自明，这行留给别的用处（空态那句、
 * `/model` 的说明各占各的）；「不知道自己在哪儿」（装配没给工作区）时**不编**。
 */
describe('列表下方那句说明——报「这儿是哪儿」（U27）', () => {
  test('本工作区一条都没有 ⇒ hint 报出本工作区（不然整张表都是暗的，无从知道「这儿」是哪）', async () => {
    const app = live()
    app.open([
      state('shell', [
        { id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] },
        { id: 'b2', title: '乙项目的另一件', workspace: [ELSEWHERE] },
      ]),
    ])

    const frame = await app.stage.screen()
    expect(frame.has(`本工作区：${HERE}`)).toBe(true)
  })

  test('**多根** ⇒ 整组报出来（与分组头同形：` · ` 隔开、`[0]` 在前）', async () => {
    const app = live([HERE, '/work/shared'])
    app.open([state('shell', [{ id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] }])])

    const frame = await app.stage.screen()
    expect(frame.has(`本工作区：${HERE} · /work/shared`)).toBe(true)
  })

  test('本工作区**有**会话 ⇒ 不报那句（表自明，这行不占）', async () => {
    const app = live()
    app.open([state('a1', [{ id: 'a1', title: '甲项目的事', workspace: [HERE] }])])

    const frame = await app.stage.screen()
    expect(frame.has('本工作区：')).toBe(false)
  })

  test('列里**一条都没有** ⇒ 照旧是空态那句，不拿工作区顶上', async () => {
    const app = live()
    app.open([state('shell', [])])

    const frame = await app.stage.screen()
    expect(frame.has('还没有落过账的会话')).toBe(true)
    expect(frame.has('本工作区：')).toBe(false)
  })

  test('装配**没给工作区**（不知道自己在哪儿）⇒ 不编一句', async () => {
    const app = live(null) // ← 「没给」不是「给了一组空的」，更不是省掉不写（省掉＝缺省值）
    app.open([state('shell', [{ id: 'b1', title: '乙项目的事', workspace: [ELSEWHERE] }])])

    const frame = await app.stage.screen()
    expect(frame.has('本工作区：')).toBe(false)
  })
})
