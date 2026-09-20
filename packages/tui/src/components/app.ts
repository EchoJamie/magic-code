/**
 * 外壳 · 一屏（缺陷轮 III）——**内联渲染**下的三带结构。
 *
 * 渲染模型（原型开篇那条注）：**内联（经典）· 不接管整屏 · 不捕获鼠标**。
 * 于是滚轮滚**终端自己的** scrollback ✓ · 原生拖选复制 ✓ ——两个都免费。
 * 代价三条（用户已认下）：输入框**不钉底**（跟内容走）· resize **不重排已滚出的历史** ·
 * 退出后内容**留在终端**。
 *
 * 版面对应的三段：
 * - **已定局的行**（上一轮及更早）→ `<Static>`：**写一次就不再重绘**——它们落进终端
 *   scrollback，滚动与复制都归终端 ✓。⚠️ **这也是 D11 的结构性护栏**：写出去的永不重擦。
 * - **本轮的行**（在流式、还会变）→ 活动区：就地重绘（高度按内容，**不填满窗口**）。
 * - **分隔线 ＋ 交互区 ＋ 状态行** → 活动区尾部。
 *
 * ⚠️ **要防的那个 bug**（原型 · 交互逻辑）：内联下重绘擦不干净＝同一段重复堆进 scrollback。
 * 两条护栏：① 已定局的行走 `Static`（不重绘）；② **一行一个 `<Text>`、行内不写换行**
 * （早先多写的那一个换行正是 D11 的根因——Ink 以为的帧高只有实际的一半）。
 *
 * 两层分得清：`AppView` 是**纯**的（给视图与尺寸就画一屏——快照直接取景）；
 * `TuiApp` 是**活**的（订阅外壳、把 Ink 的键喂进外壳、按 `ShellEffect` 退场）。
 */

import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { createElement as h } from 'react'
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import { bannerOf } from '../banner.ts'
import type { Shell, ShellKey } from '../shell.ts'
import type { CompletionState, LogRow, ShellView } from '../view.ts'
import { groupHeads, hasRunningTool } from '../view.ts'
import { Composer, draftHeight, type ComposerTone } from './composer.ts'
import { DecisionCard } from './decision.ts'
import { LogRowView, needsSpacer, needsSpacerAfter, rowLines } from './log.ts'
import { PALETTE, wrap } from './lines.ts'
import { PickerList } from './picker.ts'
import { StatusLine } from './status.ts'

/**
 * `Static` 的**定型**视图——⚠️ 一次断言，理由同包装配的铸造器那处：
 * React 的泛型组件经 `createElement` 用时**推不出** `T`（推成 `unknown`），
 * 而这里 `items` 与 `children` 的对应关系是**代码里写死的**（都是 `LogRow`）。
 */
const StaticList = Static as unknown as (props: {
  readonly key?: string
  readonly items: readonly LogRow[]
  readonly children: (item: LogRow, index: number) => ReactElement
}) => ReactElement

// —— 纯呈现 ——

export type AppViewProps = {
  readonly view: ShellView
  readonly columns: number
  readonly rows: number
  /**
   * **此刻**（毫秒）——跑动中的工具行拿它报「跑到第几秒了」（`⟳ 0.6s`）。
   *
   * 钟归**活壳**（`TuiApp` 按需滴答）；这里是纯的：不给就 `null` ⇒ 屏上回退成
   * 「运行中」——**不编一个秒数**（取景与快照因此是确定的）。
   */
  readonly now?: number | null
}

export function AppView({ view, columns, rows, now = null }: AppViewProps) {
  // 活动区的预算：减去交互区与状态行（**不填满窗口**——内联模式下内容跟内容走）
  const dock = Math.min(dockHeightOf(view, columns, rows), Math.max(4, Math.floor(rows / 2)))
  const liveBudget = Math.max(1, rows - dock - 2)
  const live = tailWithin(view.rows, columns, view.expanded, liveBudget)

  // **字标在放不下的宽度上要「一行都不占」**（设计 · 极窄：「不印，优先保证正文与输入空间」）。
  //
  // ⚠️ 光让它渲染出 0 行**还不够**——`<Static>` 里的**条目数**本身会进 Ink 的版面账：
  // 实测（9 列 · 内容高过视口）留着那条空字标，Ink 就多走一次**整屏清**
  // （`\e[2J\e[3J`，连 scrollback 一起擦）；把它从 `items` 里摘掉，两串字节逐字节相同。
  // 空盒子不是「无害的零」，它是一行账——这一条是量出来的，别凭直觉把它删了。
  //
  // ⚠️ **照常时原样交 `view.settled`**（不新建数组）——U21 那条纪律：`Static` 拿 `items`
  // 做 `useMemo` 的依赖，每帧递一个新数组会让它每帧白算一遍（见下面 `items:` 那一段注）。
  // 新建数组只发生在**极窄**那一档（`bannerOf` 给 0 行），那时屏上本来也没几行。
  const items =
    bannerOf(columns).length > 0 ? view.settled : view.settled.filter((row) => row.kind !== 'banner')

  return h(
    Box,
    { flexDirection: 'column' },
    // **已定局的行走 Static**——写一次即入 scrollback，此后不重绘（D11 的结构性护栏）。
    //
    // `key` 按**页**——记录区整块换掉时（开局 / 重建 / 换会话）重挂，那些行才会被写出来
    // （Static 只追加新项：`items` 一变短，它的游标就落在数组外，一行都不印）。
    //
    // ⚠️ **别拿会话 id 当页号**（原写法，缺陷 D25）：会话 id 与「记录区换了一页」是两回事——
    // `/grants` 这类读侧命令会先在装配那边开一张**空壳**会话（信封必带会话），
    // 于是「打开抽屉」就撞上一次 id 到位（`null` → 真 id）：`<Static>` 当场重挂，
    // 已经印进 scrollback 的字标**又印一遍**；那一帧还走 Ink 的「有静态输出」那条路
    // （`log.clear()` ＋ 重写静态输出），擦头正落在上一帧的顶行 ⇒ 记录区少一行。
    // 页的身份见 `pageOf`。
    h(StaticList, {
      key: `static:${pageOf(view)}`,
      // ⚠️ **照常就是 `view.settled` 原样，不 `[...]` 复制**（U21 · 历史区静态化）：
      // Ink 的 `Static` 拿 `[items, index]` 做 `useMemo` 的依赖——每帧递一个新数组，
      // 那个 memo 每帧都白算一遍（`items.slice(index)`）。`settled` 只在**真的加了行**
      // 时才换对象（`settle` / `appendSettled` 都是这么写的），故这一交就是稳定的。
      // 实测这笔账很小（5000 行 0.019ms · `bench-cost.ts`）——**如实记：它不是瓶颈**，
      // 改它是顺手把这条纪律立住，不是优化的大头。
      // （`items` 只在**极窄那一档**才是另建的数组——见上面那一段注。）
      items,
      // `children` 是**函数入参**（Static 的形态如此，不是 JSX 子节点）——故写在 props 里
      children: (row: LogRow, index: number) =>
        h(LogRowView, {
          key: row.key,
          row,
          columns,
          expanded: view.expanded,
          // ⚠️ 问的是 **`items`**（真印出来的那一列），不是 `view.settled`：极窄那一档
          // 字标被摘掉之后，两者差着一位——拿 `settled` 索引会让每条的「上一条」都错位一格
          // （用户消息该有的分段时有时无）。`items === view.settled` 时不差分毫。
          spaced: needsSpacer(items, index),
        }),
    }),
    // **空态**（原型 · 场景 1）——屏上还没有东西、手上这条会话也还没落过账时给引导语
    ...(isEmpty(view) ? [h(EmptyState, { key: 'empty' })] : []),
    // 本轮的行（还在变）——就地重绘
    ...live.rows.map((row, index) =>
      h(LogRowView, {
        key: row.key,
        row,
        columns,
        expanded: view.expanded,
        // 交界那一条的「上一条」在 `settled` 里——同一条规矩（`needsSpacerAfter`），
        // 免得「用户消息之前留一行」在交界处换一副面孔（字标自带的后留白也在这条规矩里）
        spaced:
          index === 0
            ? needsSpacerAfter(view.settled.at(-1), row)
            : needsSpacer(live.rows, index),
        now,
      }),
    ),
    // **全屏只有这一条分隔线**（记录区与交互区之间）
    h(Text, { color: PALETTE.ghost }, '─'.repeat(Math.max(1, columns))),
    h(Box, { flexDirection: 'column' }, ...dockOf(view, rows)),
    h(StatusLine, { status: view.status, columns }),
  )
}

/**
 * 一页的编号（U29）——`<Static>` 只在**记录区真的换了一页**时重挂（见 `key:` 那一段注）。
 *
 * 页的身份＝**记录区开头那一行**（字标那一行）。这一条立得住，是因为**整块换掉**
 * `settled` 的三处（开局 `withBanner` · 重建 `rebuild` · 换会话 `reduceSessionState`）
 * **都经 `bannerFirst`**，而 `bannerFirst` 每次都种一个**新的字标对象**；
 * 追加（`settle` / `appendSettled`）只往后接，开头那一行的对象不动。
 * ⇒ 开头那一行的**对象身份**＝页的身份（记在 WeakMap 里：那个对象活着，页号就还在）。
 *
 * 空 `settled` 给 `none`——`createView` 的起点（标本与纯归约的用例）没有「页」这回事，
 * 那时 `Static` 本来也没东西可印。**这一档与原写法（`static:none`）逐字节相同**，
 * 故既有标本与快照不受影响。
 *
 * 领号这一步在渲染里做（首次见到某页时领）——**同一份视图重画拿到的号一样**，
 * 故取景 / 快照仍是确定的（`AppView` 那条「给视图与尺寸就画一屏」照旧成立）。
 */
const pageIds = new WeakMap<LogRow, number>()
let pageCount = 0

function pageOf(view: ShellView): string {
  const first: LogRow | undefined = view.settled[0]
  if (first === undefined) return 'none'

  let id = pageIds.get(first)
  if (id === undefined) {
    pageCount += 1
    id = pageCount
    pageIds.set(first, id)
  }

  return String(id)
}

/**
 * 空态（原型 · 场景 1）——**按「这条会话有没有内容」判**（缺陷 D3）。
 * 三件都要：屏上什么都没有 · 手上这条会话**还没落过账**。
 *
 * ⚠️ **启动字标不算「有内容」**：它现在恒在 `settled[0]`（见 `view.ts` 的 `withBanner`），
 * 照「`settled` 空不空」判的话它会把空态**永远挡住**——而那正是原型场景 1 那一屏
 * （「会话在你按下第一次回车时才建立」）。故这里问的是**除了字标还有没有东西**。
 *
 * 用 `every` 而不是「长度减一」：字标**恒在最前且恒只一行**（`bannerFirst` 的收口），
 * 故 `every` 在真有事发生的那一屏上**第一个元素之后当场收手**，不是每帧数一遍。
 *
 * ⚠️ **「会话 id 到位」不是「会话有内容」**（U29 改，原锚＝`sessionId === null`）——
 * **为何变**：读侧命令（`/grants` · `/model`）会先在装配那边开一张**空壳**会话
 * （信封必带会话，「空手也照答」），于是「抽屉一开」就撞上一次 id 到位：空态**当场消失**
 * 且**再也不回来**（`esc` 也不行）——而那一刻记录区一个字都没有，引导语说的
 * 「会话在你按下第一次回车时才建立」**仍然成立**。**新锚**＝问这份**目录**
 * （`session.list` 的答复，只列**落过账**的会话）：手上这条不在目录里，就是还没内容。
 *
 * 目录这一问与既有规格同源——`sessions.test.ts`「会话开了（**在目录里**）就不再是空态」。
 * 会话真开了之后（首条消息落账）不靠这一问收口：那时屏上已有内容，前两件就管住了。
 */
export function isEmpty(view: ShellView): boolean {
  return (
    view.rows.length === 0 &&
    view.settled.every((row) => row.kind === 'banner') &&
    (view.sessionId === null || !view.catalog.some((row) => row.id === view.sessionId))
  )
}

/**
 * 空态的引导语。
 *
 * ⚠️ **只留第一句**（用户 2026-09-20 定）——
 * **原锚**：原型 · 场景 1 的原文，一句说明 ＋ 空行 ＋ `比如：` ＋ 三条示例（「看看这个
 *   工作区里有什么」那几句）。
 * **为何变**：用户看了启动呈现后说「**会有一些用法的提示文字 这个似乎不太需要 直接去掉吧**」。
 *   去掉的是**用法提示**那一段（教人怎么用），留下的那句讲的是**产品行为**——会话**何时**
 *   建立（首条消息按下回车才开张），那是「会发生什么」而不是「你该怎么操作」，
 *   故照用户的分寸留着（他给的判据是「用法提示」，不是「一切文字」）。
 * **新锚**：空态只有那一句。
 *
 * ⚠️ **与 `界面原型.html` 差这一处**（如实记，别让两边偷偷不一致）：被删的那几行在代码里
 * 一直标着「原型 · 场景 1 的原文」——**删它们等于改规格**。此处**照用户的话改代码**，
 * 差异备案在回报里；原型若要跟上，是规划侧那次同步的事。
 *
 * ⚠️ **再去掉开头那半句**（用户 2026-09-20 看真机帧时指出：「交代一件事 看了图没发现这句话是
 * 重复叙述？」）——
 * **原锚**：`交代一件事就开始。会话在你按下第一次回车时才建立。`
 * **为何变**：**同一屏上、隔着一行**，输入框的占位正是「交代一件事，回车发送」——
 *   引导语以同一个词起头，读者读到的是**把占位又说了一遍**。用户的原话：
 *   那半句是废话（**占位已经说了**）；留下的是**用户不知道的信息**（会话**建立于何时**）。
 * **新锚**：`会话在你按下第一次回车时才建立。`——只讲**会发生什么**，不再重述怎么开始。
 *
 * ⚠️ **这条的教训**（规划侧自陈、我照记）：上一轮**只看了布局没读话**，所以漏了——
 * 「从上到下一行行通读」是这一屏的验收动作之一，光量缩进与留白量不出重复叙述。
 *
 * 另：状态行右位那两处键位提示（`/ 命令 · ctrl+c 退出` · `ctrl+c 中断`）**不动**——
 * 那是**功能发现**（不显示就不知道能打 `/`），与「用法提示文字」不是一类（用户划定）。
 */
function EmptyState(): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { key: 'e:0' },
      h(Text, { color: PALETTE.faint }, '会话在'),
      h(Text, { color: PALETTE.faint, bold: true }, '你按下第一次回车'),
      h(Text, { color: PALETTE.faint }, '时才建立。'),
    ),
  )
}

/** 取尾部若干行——活动区只画放得下的那些（铺满不了窗口，故只受「一屏」约束）。 */
function tailWithin(
  rows: readonly LogRow[],
  columns: number,
  expanded: boolean,
  budget: number,
): { readonly rows: readonly LogRow[] } {
  const total = rows.reduce(
    (sum, row, index) => sum + heightOf(row, columns, expanded, needsSpacer(rows, index)),
    0,
  )
  if (total <= budget) return { rows }

  // 从尾往前数满预算——返回**整行**（不切行）
  const kept: number[] = []
  let used = 0
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const size = heightOf(rows[index] as LogRow, columns, expanded, needsSpacer(rows, index))
    if (used + size > budget && kept.length > 0) break
    used += size
    kept.unshift(index)
  }

  return { rows: kept.map((index) => rows[index] as LogRow) }
}

/** 一行的显示行数（只数，不渲染——借记录区的纯函数）。 */
function heightOf(row: LogRow, columns: number, expanded: boolean, spaced: boolean): number {
  return rowLines(row, { columns, expanded, spaced }).length
}

/** 左下交互区的内容（四种用法）。 */
function dockOf(view: ShellView, rows: number): readonly ReactElement[] {
  const flash =
    view.flash === null ? [] : [h(Text, { key: 'flash', color: PALETTE.warn }, `▲ ${view.flash}`)]

  if (view.dock.kind === 'decision') {
    return [
      h(DecisionCard, { key: 'card', pending: view.dock.pending }),
      h(Composer, { key: 'composer', draft: '', tone: 'taken' }),
      ...flash,
    ]
  }

  if (view.dock.kind === 'picker') {
    return [h(PickerList, { key: 'picker', picker: view.dock.picker }), ...flash]
  }

  return [
    ...(view.completion === null
      ? []
      : [h(Completion, { key: 'completion', completion: view.completion })]),
    h(Composer, { key: 'composer', draft: view.draft, tone: toneOf(view), maxLines: maxDraftLines(rows) }),
    ...flash,
  ]
}

/** 自动补全的候选（D12）——列在输入行**上方**：名字 ＋ 一句话说明，选中那条高亮。 */
function Completion({ completion }: { readonly completion: CompletionState }): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    ...completion.candidates.map((candidate, index) =>
      h(
        Text,
        { key: `c:${candidate.name}` },
        h(
          Text,
          { color: index === completion.selected ? PALETTE.user : PALETTE.faint, bold: index === completion.selected },
          `${index === completion.selected ? '› ' : '  '}${candidate.name}`,
        ),
        h(Text, { color: index === completion.selected ? PALETTE.dim : PALETTE.faint }, `　${candidate.summary}`),
      ),
    ),
  )
}

/**
 * 输入行的面孔——按状态给（显示层不判断业务，只翻状态）。
 *
 * `working` 还要再分一次（U20 · 差距 3「进度感：**工具跑动 / 等待模型 / 退避重试**，
 * 屏上都要看得出」）：**有工具在跑**时说的是「工作中」（此刻有 `⟳` 那行在动），
 * **没有工具在跑**时球在模型那边——说的是「等模型回来」。两句话分开，三种状态就
 * 各自有各自的**屏上痕迹**，不用去看状态行才分得出。
 */
function toneOf(view: ShellView): ComposerTone {
  if (view.status.state === 'retrying') return 'retrying'
  if (view.status.state === 'working') return hasRunningTool(view) ? 'working' : 'waiting'

  return 'idle'
}

/** 草稿最多占几行——**半屏**（原型 · 键盘：多行草稿的高度随内容长，上限半屏）。 */
function maxDraftLines(rows: number): number {
  return Math.max(1, Math.floor(rows / 2))
}

/**
 * 交互区要几行——**按内容算**（原型：展开高度＝内容所需，最多半屏）。纯函数：布局与用例都拿它。
 */
export function dockHeightOf(view: ShellView, columns: number, rows = Number.POSITIVE_INFINITY): number {
  const flash = view.flash === null ? 0 : 1
  const completing = completionLines(view)

  if (view.dock.kind === 'decision') {
    const material = view.dock.pending.material
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, wrap(line, Math.max(8, columns - 4)).length), 0)

    return material + 4 + flash
  }

  if (view.dock.kind === 'picker') {
    // 分组头也算行（U26——`/session` 按工作区分组；一处判定两处用，见 `groupHeads`）
    const heads = groupHeads(view.dock.picker.rows).filter(Boolean).length
    // 那行说明**按实际占几行算**（U22）：`/grants` 的说明比 `/session` 的长得多
    // （怎么用 ＋ 那笔账），超宽会由 Ink 折行——照 1 行算，交互区就少算了一行
    // （D11 那条「行高与实际不符」的老账，正是这么来的）
    const hint =
      view.dock.picker.hint === undefined
        ? 0
        : wrap(view.dock.picker.hint, Math.max(8, columns - 4)).length

    return view.dock.picker.rows.length + heads + hint + flash
  }

  // 输入行那一片：草稿有几行就占几行（多行草稿 —— 半屏封顶；见 `draftHeight`）
  return draftHeight(view.draft, maxDraftLines(rows)) + completing + flash
}

/** 自动补全的候选行数（D12）——零条时不出。 */
function completionLines(view: ShellView): number {
  return view.completion === null ? 0 : view.completion.candidates.length
}

// —— 活壳 ——

export type TuiAppProps = {
  readonly shell: Shell
}

/**
 * 跑动中滴答的间隔（毫秒）——实现级常量。
 *
 * 取 200 的由头：屏上报的是 `0.6s` / `1.2s` 这一档（一位小数），200ms 一跳看着是**连着走**的，
 * 而不是一格一格蹦；比这更密只是白烧重绘（受控渲染是 U21 的账）。**没有东西在跑就停表**——
 * 闲着的屏一格都不重绘。
 */
const TICK_MS = 200

/**
 * 活钟（U20 · 差距 3）——**工具跑动时**才滴答；给屏上那行 `⟳ 0.6s` 一个「此刻」。
 *
 * 为什么钟归这一层（而不是视图或外壳）：它是**渲染**的事（同一条视图，此刻画出来与
 * 半秒后画出来不同），而视图要可重放、外壳要可测——两者都不该带一个走着的钟。
 */
function useLiveClock(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (!active) {
      setNow(null)
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)

    return () => clearInterval(timer)
  }, [active])

  return now
}

export function TuiApp({ shell }: TuiAppProps) {
  const view = useSyncExternalStore(shell.subscribe, shell.getView)
  const { columns, rows } = useWindowSize()
  const { exit } = useApp()
  const now = useLiveClock(hasRunningTool(view))

  const feed = (key: ShellKey): void => {
    if (shell.key(key).exit) exit()
  }

  useInput((input, key) => {
    for (const mapped of toShellKeys(input, key)) feed(mapped)
  })

  // 粘贴走**另一条信道**（bracketed paste）——接管期间一律拒并提示
  usePaste((text) => feed({ kind: 'paste', text }))

  return h(AppView, { view, columns, rows, now })
}

/** Ink 的 `(input, key)` → 外壳认得的按键（0 到多条——一次回调可能带一串正文）。 */
export function toShellKeys(
  input: string,
  key: {
    readonly ctrl?: boolean
    readonly meta?: boolean
    readonly shift?: boolean
    readonly return?: boolean
    readonly backspace?: boolean
    readonly delete?: boolean
    readonly escape?: boolean
    readonly upArrow?: boolean
    readonly downArrow?: boolean
    readonly tab?: boolean
  },
): readonly ShellKey[] {
  if (key.ctrl === true && input === 'c') return [{ kind: 'ctrl+c' }]
  if (key.ctrl === true && input === 'o') return [{ kind: 'ctrl+o' }]
  if (key.tab === true) return [{ kind: 'tab' }]

  // **`shift+回车` ＝ 换行**（原型 · 键盘）。两条来路都要认（这就是「两条来路」那件事）：
  // ① **kitty 键盘协议**（`run.ts` 开了）——终端把它报成独立的 `CSI 13;2u`，
  //    Ink 解出 `return ＋ shift`；
  // ② **裸 LF**——有的终端 `shift+回车` 就发一个 `\n`（而 `\n` 在 Ink 那儿**本来就不是**
  //    `return`：它名字叫 `enter`；今天落到下面的分支会被当成一个正文字符塞进草稿）。
  if (key.return === true && key.shift === true) return [{ kind: 'newline' }]
  if (input === '\n') return [{ kind: 'newline' }]

  if (key.return === true) return [{ kind: 'enter' }]
  if (key.backspace === true || key.delete === true) return [{ kind: 'backspace' }]
  if (key.escape === true) return [{ kind: 'escape' }]
  if (key.upArrow === true) return [{ kind: 'up' }]
  if (key.downArrow === true) return [{ kind: 'down' }]

  // 带 ctrl / meta 的其余键不是正文（Ink 把控制字符解成「字母 ＋ ctrl」）
  if (key.ctrl === true || key.meta === true) {
    return input === '' ? [] : [{ kind: 'other', label: `${key.ctrl === true ? 'ctrl+' : 'meta+'}${input}` }]
  }

  if (input === '') return []

  // 一次来一串＝粘贴（没走 bracketed paste 的终端）
  return [...input].map((char) => ({ kind: 'char', char }) as const)
}
