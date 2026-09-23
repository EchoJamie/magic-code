/**
 * U43 · **切换会话不重印字标**——规格即测试。
 *
 * 出处：vault `交接/工单/U43.md`（裁定与由头见 `缺陷/D28 切会话后重建启动区并印出会话创建提示`
 * 的「乙」那半）。三句话都是**屏上的话**：
 * **一屏只有一份字标** · **换过去那一条的记录照常铺出来** · **回执每次都在**。
 *
 * ## 为什么这三句单看视图字段答不了
 *
 * 字标重印是**帧序**里的现象：把「切完之后的视图」一次性画出来只看得见它**该长什么样**，
 * 看不见「屏幕上已经印过几份」——旧的印进 scrollback，擦不掉也不在视图里。
 * 故本文件一律**逐帧录**（`show(views…)`），量的正是「这一趟下来屏上累计印了几份」。
 * 单看的话，本单要它**没有**的那一件（切走这一页上也有一条字标）恰好能被视图字段答成「对」——
 * 那正是 U29 时把份数钉成 1 / 2 / 3 的来路。
 *
 * ## 与 `spec.u29.test.ts` ④ 的分工
 *
 * 那一条量的是**一页一个页头**这件事本身（`<Static>` 重挂的账）；本文件量的是
 * **用户在这一屏上看到什么**：字标几份、内容铺没铺出来、回执在不在。
 * 两条都钉**精确份数**，谁也不许退成「至少出现过」。
 *
 * ## 走的是真路径
 *
 * 换会话经**真选择器**（`/session` → 回车开 → ↑↓ 选 → 回车定），不是直接喂一个 `session.state`
 * ——回执 `· 已切到 <名字>` 只在那条路上发（`shell.ts` 的 `submit`），少了它就等于
 * 把「回执每次都在」这条判据空转掉。`session.state` / `session.history` **分两帧**喂
 * （现实里它们隔着一趟控制面往返：外壳收到 `session.state` 才发 `history.read`）。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, KernelEvent } from '@magic/contracts'
import { bannerOf } from '../src/banner.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'
import { createStage, show } from './screen.ts'
import type { Frame, ScreenOptions, Stage } from './screen.ts'

/** 常宽（块字版那一档）与窄窗（一行版那一档）各一次——窄窗下字标本就不印块字。 */
const WIDE: ScreenOptions = { columns: 100, rows: 30 }
const NARROW: ScreenOptions = { columns: 40, rows: 30 }

const ENTER = { kind: 'enter' } as const
const DOWN = { kind: 'down' } as const
const UP = { kind: 'up' } as const

/** 目录里那两条——**两趟切换都用同一份**（`active` 说此刻在哪一条）。 */
function catalog(active: string): KernelEvent {
  return event('session.state', {
    active,
    sessions: [
      { id: 's1', at: 0, title: '甲的事' },
      { id: 's2', at: 0, title: '乙的事' },
    ],
  })
}

const 甲: readonly Entry[] = [
  { id: 1, kind: 'user', content: { text: '甲：看看有什么' }, at: 0 },
  { id: 2, kind: 'assistant', content: { text: '甲：列一下。' }, at: 1 },
]
const 乙: readonly Entry[] = [{ id: 3, kind: 'user', content: { text: '乙：就一句' }, at: 2 }]

/** 一条历史读回来（`done`＝收齐，外壳据此走 `rebuild`）。 */
const history = (session: string, entries: readonly Entry[]): KernelEvent =>
  event('session.history', { session, entries, done: true })

/** 屏上含 `needle` 的行有几条（份数一律钉**精确值**）。 */
const countOf = (frame: Frame, needle: string): number =>
  frame.screen.lines.filter((line) => line.includes(needle)).length

/** 屏上「字标画幅首行」出现几次——`bannerCopies` 每多一份＝终端上多一块字标。 */
function bannerCopies(frame: Frame, columns: number): number {
  // `bannerOf` 交出来的已经是**带缩进的那一行**（`BANNER_INDENT` 在里面加好了）
  const art = (bannerOf(columns)[0]?.text ?? '').replace(/\s+$/u, '')

  return frame.screen.lines.filter((line) => line.replace(/\s+$/u, '') === art).length
}

/** 逐帧录一串——第 0 帧＝装载（开机那一屏），其后每步一拍。 */
function takes(stage: Stage, steps: readonly (() => void)[]): readonly ShellView[] {
  const views: ShellView[] = [stage.shell.getView()]
  for (const step of steps) {
    step()
    views.push(stage.shell.getView())
  }

  return views
}

/**
 * 经**真选择器**切一条：`/session` → 回车开 → 按 `keys` 选行 → 回车定 → 答复到 → 换会话。
 *
 * ⚠️ **目录那两次答复要分开喂**（照真路径的次序）：
 * ① `/session` 问出来的那一趟，`active` 还是**切之前**那条（问的是「有哪几条」，
 *    不是「换过去」）——照目标会话喂就成了「抽屉一开就换过去了」，后面的 ↑↓ 全落在别处；
 * ② 选定之后内核才报新会话（`session.open` 的答复）——**换会话那一帧是它**。
 *
 * 每一拍**各记一帧**（命令那一屏、抽屉那一屏、选定那一帧都在帧序里）——
 * 「回执在不在」要在同一帧上判，跳帧就判空了。
 */
function switchThroughPicker(
  stage: Stage,
  keys: readonly ('down' | 'up')[],
  from: string,
  to: string,
): readonly (() => void)[] {
  const steps: (() => void)[] = [
    () => stage.type('/session'),
    () => stage.press(ENTER),
    // 目录答复回来了 ⇒ 抽屉真开（`openSessionPicker` 认的是「刚问过」那一趟）
    () => stage.feed([catalog(from)]),
  ]

  for (const key of keys) steps.push(() => stage.press(key === 'down' ? DOWN : UP))
  steps.push(() => stage.press(ENTER)) // 选定：发 `session.open` ＋ 留一行回执（回执就在这一帧上）
  steps.push(() => stage.feed([catalog(to)])) // 换会话那一帧：记录区清空、另开一页

  return steps
}

// ══ ① 三屏：一屏一份字标，且在最前 ═══════════════════════════════════

describe('① 开机 → 切走 → 切回：屏上始终只有那一份字标', () => {
  test('**三趟都在同一块屏上**：字标一份、在最前；切走与切回各铺各的记录', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([catalog('s1')]),
      () => stage.feed([history('s1', 甲)]),
      ...switchThroughPicker(stage, ['down'], 's1', 's2'),
      () => stage.feed([history('s2', 乙)]),
      ...switchThroughPicker(stage, ['up'], 's2', 's1'),
      () => stage.feed([history('s1', 甲)]),
    ])

    const frame = await show(views, WIDE)

    // **只有一份**——开机印的那一份（切走／切回都不重印）
    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    // **且在最前**：记录区第 0 行是字标块前那道留白，紧接着就是画幅首行
    const banner = bannerOf(WIDE.columns).map((line) => line.text.replace(/\s+$/u, ''))
    expect(frame.screen.lines.slice(0, banner.length + 1).slice(1)).toEqual(banner)

    // **两条会话的记录各铺各的**：甲那两行印过两遍（开机 ＋ 切回来），乙那一行一遍
    expect(countOf(frame, '› 甲：看看有什么')).toBe(2)
    expect(countOf(frame, '⏺ 甲：列一下。')).toBe(2)
    expect(countOf(frame, '› 乙：就一句')).toBe(1)
  })

  test('**回执每次都在**（连切两次）：两条 `· 已切到`，条数＝切了几次', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([catalog('s1')]),
      () => stage.feed([history('s1', 甲)]),
      ...switchThroughPicker(stage, ['down'], 's1', 's2'),
      () => stage.feed([history('s2', 乙)]),
      ...switchThroughPicker(stage, ['up'], 's2', 's1'),
      () => stage.feed([history('s1', 甲)]),
    ])

    const frame = await show(views, WIDE)

    // 「字标没了、回执也没了」那种空屏——本单要防的正是它：**切几次就有几条**（精确值）
    const receipts = frame.screen.lines.filter((line) => line.includes('· 已切到')).length
    expect(receipts).toBe(2)
    expect(countOf(frame, '· 已切到 乙的事')).toBe(1) // 甲 → 乙
    expect(countOf(frame, '· 已切到 甲的事')).toBe(1) // 乙 → 甲
  })
})

// ══ ② 空会话：不铺内容，也不留残块 ═══════════════════════════════════

describe('② 切到一条还没有记录的会话', () => {
  test('**记录区清空重来、一条都不铺**：回执之后没有别的东西（不是被「不重印」连带吞掉）', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([catalog('s1')]),
      () => stage.feed([history('s1', 甲)]),
      ...switchThroughPicker(stage, ['down'], 's1', 's2'),
      () => stage.feed([history('s2', [])]), // 空会话：读回来一条都没有
    ])

    const view = stage.shell.getView()
    const frame = await show(views, WIDE)

    // 视图那一侧：这一页确实是空的（不是「铺了个字标顶着」）
    expect(view.settled).toHaveLength(0)
    // 屏那一侧：字标仍只一份；回执在；**它下面一条记录行都没有**
    expect(bannerCopies(frame, WIDE.columns)).toBe(1)
    expect(countOf(frame, '· 已切到 乙的事')).toBe(1)
    expect(frame.content.at(-1)?.text).toBe('· 已切到 乙的事')
  })
})

// ══ ③ 窄窗：块字本就不印，换会话那一屏别有残块 ═══════════════════════

describe('③ 窄窗（字标换成一行版那一档）', () => {
  test('**40 列**：同一个帧序，字标仍是一份（一行版）、记录照常铺', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([catalog('s1')]),
      () => stage.feed([history('s1', 甲)]),
      ...switchThroughPicker(stage, ['down'], 's1', 's2'),
      () => stage.feed([history('s2', 乙)]),
    ])

    const frame = await show(views, NARROW)

    // 一行版也要「只一份」——量的是**这个宽度下**字标首行出现几次（不是钉版本）
    expect(bannerCopies(frame, NARROW.columns)).toBe(1)
    expect(countOf(frame, '乙：就一句')).toBe(1) // 窄窗下会折行，故量整句
  })

  /**
   * **极窄（9 列）那一档**——如实说清这一条钉的是哪一半：
   *
   * 这一档上**字标本来一行都不印**（`bannerOf(9)` 是空的，`app.ts` 还把它从 `items` 里
   * 整个摘掉——「空盒子不是无害的零」那条注），故「换会话不重印」在**屏上**没有可见差别：
   * 本单改动前后这一屏长得一模一样。留着它，钉的是另外两件会真翻脸的事：
   * ① **换会话那一屏不许冒出块字残块**（`items` 里那条字标一旦没摘干净、又赶上 `Static` 重挂，
   * 它就会按极窄档画成别的东西）；② **目标会话的记录照常、且只铺一遍**（重挂不许把它重印）。
   */
  test('**极窄（9 列）**：没有块字残块，目标会话的记录照常、且只铺一遍', async () => {
    const stage = createStage()
    const views = takes(stage, [
      () => stage.feed([catalog('s1')]),
      ...switchThroughPicker(stage, ['down'], 's1', 's2'),
      () => stage.feed([history('s2', 乙)]),
    ])

    const frame = await show(views, { columns: 9, rows: 30 })

    expect(bannerOf(9)).toEqual([]) // 防空转：这一档本来就没有字标可印
    expect(frame.screen.lines.some((line) => line.includes('█'))).toBe(false)
    // 目标会话那一行铺出来了（9 列下它折成一堆短行，故只问「有没有」这一截）
    expect(frame.screen.lines.some((line) => line.includes('乙'))).toBe(true)
  })
})
