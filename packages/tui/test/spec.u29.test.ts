/**
 * U29 · **抽屉开合不丢记录**（缺陷 D25）——规格即测试。
 *
 * 出处：vault `缺陷/D25 抽屉一开记录区少一行`。三句话都是**屏上的话**，视图字段答不了：
 * **字标印两遍** · **记录区少一行** · **空态那句消失（`esc` 后也不回来）**。
 *
 * ⚠️ **必须逐帧录**（`show(views…)` 而不是一帧一屏）：这条缺陷只在**帧序**里现形——
 * 把抽屉开着那一屏**一次性画**出来完全正常。那也正是它躲过仓里一千多条用例的原因
 * （既有用例绝大多数是 `stage.screen()`＝单帧）。
 *
 * ## 根因（真 PTY 实测 · 见回报 U29）
 *
 * `<Static>` 的 `key` 原先按**会话 id**，而「读侧命令先开一张**空壳**会话」
 * （`/grants` 那条路：信封必带会话）让**抽屉一开就撞上一次 id 到位**（`null` → 真 id）：
 * React 重挂 `Static` ⇒ 游标归零 ⇒ 已印进 scrollback 的字标**又印一遍**；
 * 那一帧还走 Ink 的「有静态输出」那条路（`log.clear()` ＋ 重写静态输出），
 * 擦头正落在上一帧的**顶行**（空态那句）⇒ 记录区少一行。
 * 空态那条判据同时被这次 id 到位带翻（原锚 `sessionId === null`）⇒ 引导语消失。
 *
 * ## 三条判据
 *
 * **字标只一份** · **引导语在**（还没落过账就丢不得） · **抽屉的行只一份**。
 * 每条都在帧序上量——「只一份」这类话，单帧取景问不出来。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, EventDataOf } from '@magic/contracts'
import { bannerOf } from '../src/banner.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame, ScreenOptions, Stage } from './screen.ts'
import { show } from './screen.ts'

/** 正常的宽（与其余规格用例同尺寸）与一档窄窗（字标换成一行版的那一侧）。 */
const WIDE: ScreenOptions = { columns: 80, rows: 24 }
const NARROW: ScreenOptions = { columns: 40, rows: 24 }

const ENTER = { kind: 'enter' } as const
const ESC = { kind: 'escape' } as const

/** 空壳会话的 id——**目录里没有它**（装配为「信封必带会话」开的那张，D5 的不落账那条）。 */
const SHELL_SESSION = 'shell-u29'

/** 一句用户话——「抽屉开完之后还打得出字」用它当草稿。 */
const DRAFT = '看看这个工作区里有什么'

/** 一份有项的名录（两条授权 ＋ 一个陈旧的节）——抽屉「有东西可点」那一档。 */
function catalog(over: Partial<EventDataOf['grants.catalog']> = {}): EventDataOf['grants.catalog'] {
  return {
    workspace: '/work/proj',
    grants: [
      { describe: '工具 exec × 路径 根内 × 操作 read', grantedAt: 1_700_000_000_000, hits: 3, lastHitAt: 1_700_000_000_000, stale: false },
      { describe: '工具 read × 根内 × 操作任意', grantedAt: 1_699_000_000_000, stale: true },
    ],
    stale: ['/work/gone'],
    decisions: { total: 8, uncovered: 4, vetoed: 1 },
    history: { total: 20, auto: 15 },
    ...over,
  }
}

/** 逐帧录一串——第 0 帧＝装载，其后每步一拍。 */
function takes(stage: Stage, steps: readonly (() => void)[]): readonly ShellView[] {
  const views: ShellView[] = [stage.shell.getView()]
  for (const step of steps) {
    step()
    views.push(stage.shell.getView())
  }

  return views
}

/** 屏上「字标画幅首行」出现几次——**重复印一份就是两次**（这就是 D25 的第一句）。 */
function bannerCopies(frame: Frame, columns: number): number {
  // `bannerOf` 交出来的已经是**带缩进的那一行**（`BANNER_INDENT` 在里面加好了）
  const art = (bannerOf(columns)[0]?.text ?? '').replace(/\s+$/u, '')

  return frame.screen.lines.filter((line) => line.replace(/\s+$/u, '') === art).length
}

/** 屏上含 `needle` 的行有几条（「只一份」用）。 */
const countOf = (frame: Frame, needle: string): number =>
  frame.screen.lines.filter((line) => line.includes(needle)).length

/** 还有没有字可打——作曲家那一行在不在（`› ` 起头那行就是输入行）。 */
const canType = (frame: Frame): boolean => frame.dock.some((line) => line.text.includes('›'))

/** 引导语那句（措辞改动见 `app.ts` 的 `EmptyState` 注；这里钉的是**它在不在**）。 */
const GUIDANCE = '你按下第一次回车时才建立'

/** 抽屉开着时的现场：草稿 ＋ 名录到手（**还没**收到那张空壳的 `session.state`）。 */
function drawerOpen(over: Partial<EventDataOf['grants.catalog']> = {}): {
  readonly stage: Stage
  readonly views: readonly ShellView[]
} {
  const stage = createStage()

  return {
    stage,
    views: takes(stage, [
      () => stage.type('/grants'),
      () => stage.press(ENTER),
      () => stage.feed([event('grants.catalog', catalog(over))]),
    ]),
  }
}

// ══ ① 有项抽屉：开合都不重复、不丢行 ══════════════════════════════════

describe('① 抽屉开合（有项）', () => {
  test('**抽屉开着**：字标一份 · 引导语在 · 名录的行在', async () => {
    const { views } = drawerOpen()
    const frame = await show(views, WIDE)

    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    expect(frame.has(GUIDANCE)).toBe(true)
    expect(countOf(frame, '工具 exec × 路径 根内 × 操作 read')).toBe(1)
  })

  test('**空壳的 `session.state` 随后到**（抽屉还开着）：字标仍一份 · 引导语仍在', async () => {
    // 这一拍正是 D25 的现场：读侧命令先开一张空壳，答复异步随后到——
    // 会话 id 到位（`null` → 真 id）**不是**「记录区换了一页」，也不是「会话有内容了」
    const { stage, views } = drawerOpen()
    const withShell = [
      ...views,
      (() => {
        stage.feed([event('session.state', { active: SHELL_SESSION, sessions: [] })])
        return stage.shell.getView()
      })(),
    ]

    const frame = await show(withShell, WIDE)

    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    expect(frame.has(GUIDANCE)).toBe(true)
    expect(withShell.length).toBe(views.length + 1) // 那一拍真的录进去了
  })

  test('**收起之后**：字标仍一份 · 引导语仍在 · 抽屉的行不留痕', async () => {
    const { stage, views } = drawerOpen()
    stage.feed([event('session.state', { active: SHELL_SESSION, sessions: [] })])
    const opened = [...views, stage.shell.getView()]
    stage.press(ESC)
    const closed = [...opened, stage.shell.getView()]

    const frame = await show(closed, WIDE)

    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    expect(frame.has(GUIDANCE)).toBe(true)
    expect(frame.has('工具 exec × 路径 根内 × 操作 read')).toBe(false) // 收起＝不留痕
    expect(canType(frame)).toBe(true)
    expect(opened.length).toBe(views.length + 1)
  })
})

// ══ ② 窄窗同一句话 ═══════════════════════════════════════════════════

describe('② 窄窗（字标换成一行版那一侧）', () => {
  test('**40 列**：同一个帧序，字标一份 · 引导语在 · 抽屉的行一份', async () => {
    const { stage, views } = drawerOpen()
    stage.feed([event('session.state', { active: SHELL_SESSION, sessions: [] })])
    const frame = await show([...views, stage.shell.getView()], NARROW)

    // 一行版也要「只一份」——量的是**这个宽度下**字标首行出现几次（不是钉版本）
    expect(bannerCopies(frame, NARROW.columns)).toBe(1)
    expect(frame.has(GUIDANCE)).toBe(true)
    // ⚠️ 窄窗量的是**只一份**（`工具 exec` 那一处），不是「一行写完」——40 列放不下整条，
    //    行会折成两行贴上去（那是列表自己的折行，不归这条判据管）
    expect(countOf(frame, '工具 exec')).toBe(1)
  })
})

// ══ ④ 换页仍要「印得出来」（换页判据动了，这条钉住它的另一半）════════

/**
 * **换到另一条会话**——新一页要**成页**：页头（字标）与新内容都印出来。
 *
 * 为什么这条要紧：`<Static>` 只**追加**新项，它的游标停在上一页的条数上；
 * 「记录区整块换掉」若不重挂，新页的**页头（`settled[0]`）就印不出来**——
 * 屏上会变成「上一页的内容后面直接接一串没有开始的行」。
 * 本单元改的正是**什么时候重挂**，这条守它的另一半（别把重挂改没了）。
 *
 * ⚠️ 样本要**先长后短**：甲那条先长出内容把游标顶上去，再切到只有一条的乙。
 * （实测：Ink 的 `useLayoutEffect` 会把游标压回数组长度，故**行**多半能自愈地接上，
 * 咬得住的是**页头那一下**——所以这里量的是「屏上出现了**新一页的字标**」。）
 *
 * 旧页留在 scrollback 里（内联渲染的既定行为：切走＝另起一页，旧的滚在上面）——
 * 这里不问它，问的是新页齐不齐。
 */
describe('④ 换会话（新一页要成页）', () => {
  test('**新页的页头（字标）与新行都在**', async () => {
    const stage = createStage()
    const first: Entry[] = [
      { id: 1, kind: 'user', content: { text: '甲：看看有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '甲：列一下。' }, at: 1 },
    ]
    const second: Entry[] = [{ id: 3, kind: 'user', content: { text: '乙：就一句' }, at: 2 }]

    const views = takes(stage, [
      () => stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '甲的事' }] })]),
      () => stage.feed([event('session.history', { session: 's1', entries: first, done: true })]),
      () => stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙的事' }] })]),
      () => stage.feed([event('session.history', { session: 's2', entries: second, done: true })]),
    ])
    const frame = await show(views, WIDE)

    expect(frame.has('› 乙：就一句')).toBe(true) // 新会话的行
    // 启动那一页 ＋ 乙这一页 ⇒ 两份（不重挂就只有启动那一份：新页没有开头）
    expect(bannerCopies(frame, WIDE.columns)).toBeGreaterThanOrEqual(2)
  })
})

// ══ ③ 空抽屉：回执进记录区，输入照常 ══════════════════════════════════

describe('③ 空抽屉（名录一条都没有）', () => {
  test('**不开抽屉**：那句回执落进记录区（只一份），接着打字照常进草稿', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.type('/grants'),
      () => stage.press(ENTER),
      () => stage.feed([event('grants.catalog', catalog({ grants: [], stale: [] }))]),
      () => stage.type(DRAFT),
    ])
    const frame = await show(views, WIDE)

    expect(countOf(frame, '还没有授权')).toBe(1) // 记录区里只一份（不重复、不丢）
    expect(canType(frame)).toBe(true)
    expect(frame.dock.some((line) => line.text.includes(DRAFT))).toBe(true) // 草稿真进了作曲家
  })

  test('**回执之后开有项的抽屉、再收起**：回执还在且只一份 · 字标一份', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.type('/grants'),
      () => stage.press(ENTER),
      () => stage.feed([event('grants.catalog', catalog({ grants: [], stale: [] }))]), // 回执一条
      () => stage.type('/grants'),
      () => stage.press(ENTER),
      () => stage.feed([event('grants.catalog', catalog())]), // 这一次有项 ⇒ 抽屉开
      () => stage.feed([event('session.state', { active: SHELL_SESSION, sessions: [] })]),
      () => stage.press(ESC),
    ])
    const frame = await show(views, WIDE)

    expect(countOf(frame, '还没有授权')).toBe(1) // 「记录保留」：回执仍在，且没被重印
    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    // 空态那句**该退场**了——记录区里有那条回执（「屏上什么都没有」这一条不再成立）
    expect(frame.has(GUIDANCE)).toBe(false)
    expect(frame.has('工具 exec × 路径 根内 × 操作 read')).toBe(false) // 收起不留痕
  })
})
