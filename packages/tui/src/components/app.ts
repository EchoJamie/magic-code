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
import { Composer, clip, draftHeight, inkWidth, type ComposerTone } from './composer.ts'
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
  // 活动区的预算：减去交互区与状态行，**再留一格**（**不填满窗口**——内联模式下内容跟内容走）。
  //
  // ⚠️ 这里的 `dock` 是**账**，`dockOf` 画出来的是**屏**——两者必须相等（U31 二轮退回）：
  //    账按 `maxDraftLines`（半屏）封顶、而输入行多画了两行提示时，屏上的动态帧正好顶到
  //    终端高度 ⇒ Ink 省掉末尾换行 ⇒ 真光标高一行。故「上面/下面还有 N 行」那两行
  //    **也算在 `maxDraftLines` 里**（`composerLayout` 那一处收口），这里不必再补。
  //
  // ⚠️ **留的那一格不是余量，是 Ink 末尾那个换行要落的一行**（U31 三轮退回把账补齐）：
  //    动态帧 ＝ 活动区 ＋ `CHROME_LINES`（分隔线 ＋ 状态行）＋ 交互区；
  //    「帧高 ≥ 视口行数」时 Ink 走**整屏那一支**——只写正文、**不写末尾那个换行**
  //    （`ink.js` 的 `renderInteractiveFrame`：`isFullscreen ? output : output + '\n'`），
  //    而它摆光标的后缀仍按「正文之下还有一行」回退
  //    （`cursor-helpers.js` 的 `buildCursorSuffix`：`moveUp = visibleLineCount - cursor.y`）
  //    ⇒ **真光标高一行**。故账要写**短于这一屏**——`rows - 1` 才是动态帧能占的上限。
  //    早先 `max(1, rows - dock - 2)` 在活动区吃满时正好等于 `rows`：注释写着「不填满窗口」，
  //    算式却正好填满（40×10 · 草稿 300 个 a · 3 行流式 ⇒ 帧 10 行、真光标 (13,6) 而非 (13,7)）。
  // ⚠️ **交互区的高度就是它画出来的那些行**——不许再按「最多半屏」封顶（U31 三轮退回）：
  //    那个封顶只封**账**、不封**屏**（草稿那一片本来就由 `maxDraftLines` 封在半屏，
  //    而裁决卡 / 选择器 / 补全候选是各自算的行数，封顶够不着它们）——于是「账 4 行、
  //    屏 5 行」这号分家又回来了：矮窗上活动区多算了一行 ⇒ 帧正好顶满 ⇒ 真光标高一行
  //    （40×8 的接管屏就是那一格）。账与屏**同取 `dockHeightOf` 一处**，剩下的格子归活动区。
  const dock = dockHeightOf(view, columns, rows)
  // 空态那一行**已删**（用户 2026-09-20 定：那句「会话在你按下第一次回车时才建立」没有动作价值，
  // 原型早已删掉）——账里也就不再有这一项：帧的三段只剩活动区、`CHROME_LINES`、交互区。
  const liveBudget = Math.max(0, rows - 1 - CHROME_LINES - dock)
  const live = liveAreaOf(view, columns, liveBudget)

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
    // ⚠️ **空态那一块已删**（用户 2026-09-20 定：启动屏上「会话在你按下第一次回车时才建立」
    //    这句没有动作价值，原型早已删掉）。删掉之后这一屏就只是：记录区（`Static`）→ 活动区
    //    → 分隔线 → 交互区 → 状态行——开机屏上不再有那句话，也没有为它单算的高度项
    //    （见上面 `liveBudget` 那一段注）。
    // 本轮的行（还在变）——就地重绘
    //
    // ⚠️ **画哪几条、留不留分段、切哪几行，全由 `liveAreaOf` 一处给**（`live`）——账与屏
    //    同取一处才谈得上「不差分毫」。早先这两件事分在两处：算账那支用 `needsSpacer(rows, i)`
    //    （下标 0 恒为「不留」），渲染那支用 `needsSpacerAfter(settled.at(-1), row)`
    //    （上一条是用户消息就留）——**同一条交界行，两处各判各的**。
    ...live.map((entry) =>
      h(LogRowView, {
        key: entry.row.key,
        row: entry.row,
        columns,
        expanded: view.expanded,
        // 交界那一条的「上一条」在 `settled` 里——同一条规矩（`needsSpacerAfter`），
        // 免得「用户消息之前留一行」在交界处换一副面孔（字标自带的后留白也在这条规矩里）
        spaced: entry.spaced,
        // 头一条自己就超预算时它要跳过的那几行（记录里一行不少，屏上只画放得下的）
        skip: entry.skip,
        now,
      }),
    ),
    // **全屏只有这一条分隔线**（记录区与交互区之间）
    h(Text, { color: PALETTE.ghost }, '─'.repeat(Math.max(1, columns))),
    h(Box, { flexDirection: 'column' }, ...dockOf(view, columns, rows)),
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
 * 动态帧里**除活动区之外**的固定行数——分隔线与状态行（各一行）。
 *
 * 它是活动区预算那个减法里的一项：动态帧 ＝ 活动区 ＋ `CHROME_LINES` ＋ 交互区。
 * 交互区那一项不在这里（它按内容算，见 `dock` 那一段注）。
 */
const CHROME_LINES = 2

/** 活动区要画的那一条——**画哪几条、留不留分段、跳几行**都在这一处定（账与屏同源）。 */
type LiveEntry = {
  readonly row: LogRow
  /** 这一条之前留不留一行分段（用户消息之前＝留）——**按它在本轮里的真上一条**算。 */
  readonly spaced: boolean
  /**
   * 这一条**开头几行不画**——只有头一条会非零：它自己就比预算高（单条长记录 / 一段长 diff）
   * 时，只画它**末尾**那几行。**记录里一行不少，屏上画不下的就不画**。
   */
  readonly skip: number
}

/**
 * 活动区的那几条——**从尾往前数满预算**（取尾部：屏上留下最近发生的）。
 *
 * ⚠️ **两条都归这里管**（U31 三轮退回）：
 *
 * ① **单条自己就超预算要真切**——早先那一支是「至少留住一条整行」（`kept.length > 0`
 *    才 `break`），于是一条 4 行的流式记录在 3 行的预算里**整条留了下来** ⇒ 动态帧 11 行、
 *    终端 10 行 ⇒ 照样顶满 ⇒ 真光标高一行。预算常量减一减不掉这一条，故**切它的末尾**：
 *    留的那几条加起来**恰好等于预算**（不多一行）。
 * ② **「上一条是谁」按本轮的次序算**——交界那一行（下标 0）的上一条是 `settled` 的末条
 *    **只在它真是头一条时**才成立；窗口从中间截断时，它的上一条是**被截掉的那条本轮行**。
 *    早先账里恒按「无上一条」算（`needsSpacer(rows, 0)` 恒为假）、渲染那处恒按 `settled.at(-1)`
 *    算——同一条交界行两本账，差的正是一行分段。
 */
function liveAreaOf(view: ShellView, columns: number, budget: number): readonly LiveEntry[] {
  const rows = view.rows
  const spacedAt = (index: number): boolean =>
    needsSpacerAfter(index === 0 ? view.settled.at(-1) : rows[index - 1], rows[index])

  if (budget <= 0) return []

  const entries: LiveEntry[] = []
  let used = 0

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as LogRow
    const spaced = spacedAt(index)
    const size = heightOf(row, columns, view.expanded, spaced)
    const room = budget - used

    if (size > room) {
      // 装不下：**只有头一条**（下面那几条都已经装下了）切末尾——更老的整条不画，
      // 「整行保留」那条不变（切一半的老条目比不画更容易读串行）
      if (used === 0) entries.unshift({ row, spaced, skip: size - room })
      break
    }

    entries.unshift({ row, spaced, skip: 0 })
    used += size
  }

  return entries
}

/** 一行的显示行数（只数，不渲染——借记录区的纯函数）。 */
function heightOf(row: LogRow, columns: number, expanded: boolean, spaced: boolean): number {
  return rowLines(row, { columns, expanded, spaced }).length
}

/** 左下交互区的内容（四种用法）。 */
function dockOf(view: ShellView, columns: number, rows: number): readonly ReactElement[] {
  const flash =
    view.flash === null ? [] : [h(Text, { key: 'flash', color: PALETTE.warn }, `▲ ${view.flash}`)]

  if (view.dock.kind === 'decision') {
    // **不画输入行**（D29）：接管期间打不进字，那句「等你的答复」与状态行的「● 等你定夺」
    // 说的是同一件事。材料与键位在卡上、状态与件数在状态行，该说的都在。
    // ⚠️ 真光标不会因此留在屏上：`Composer` 卸载时 Ink 的 `useCursor` 清理把它藏回去；
    //    草稿与插入点归 `view.stashed`（`takeOver` / `undock`），与画不画这一行无关。
    return [h(DecisionCard, { key: 'card', pending: view.dock.pending }), ...flash]
  }

  if (view.dock.kind === 'picker') {
    // 候选列在**输入行之上**（与自动补全那一栏同一位置：先看候选，再看自己在打的那句话）。
    return [
      h(PickerList, { key: 'picker', picker: view.dock.picker, columns }),
      // ⚠️ **`@` 那一栏把输入行留着**（U36）——设计「引用留在交代的位置」：用户打的路径
      // 正长在那句话里，把输入行藏掉，他就看不见它落在哪儿了（别的那几栏不必显示输入行：
      // 它们的查询是抽屉自己的，不写进草稿）。插入点也照旧摆着（真光标就在那句子里）。
      ...(view.dock.picker.source === 'paths'
        ? [
            h(Composer, {
              key: 'composer',
              draft: view.draft,
              caret: view.caret,
              refs: view.refs,
              tone: toneOf(view),
              maxLines: maxDraftLines(rows),
              columns,
            }),
          ]
        : []),
      ...flash,
    ]
  }

  return [
    ...(view.completion === null
      ? []
      : [h(Completion, { key: 'completion', completion: view.completion, columns })]),
    // ⚠️ **U36 起没有「草稿材料」那一行**（U33 的 `SkillLine` 已删）：材料就写在正文里
    // （`@src/login.ts` / `/review`），**原位**那一段自己就是凭据——旁边再列一行「待发送」，
    // 等于同一件事说两遍，而删了正文那处材料还在（暗带）。见 `ShellView.refs` 那条注。
    h(Composer, {
      key: 'composer',
      draft: view.draft,
      caret: view.caret,
      refs: view.refs,
      tone: toneOf(view),
      maxLines: maxDraftLines(rows),
      columns,
    }),
    ...flash,
  ]
}

/**
 * 自动补全的候选（D12）——列在输入行**上方**：名字 ＋ 一句话说明，选中那条高亮。
 *
 * 说明那半截**截到一行装得下**（`clip`）：技能名进了候选之后（U33），说明取自用户写的
 * `description`，可以很长——折一行，交互区的高度账就少算一行（`dockHeightOf` 一行一条数），
 * 矮终端上动态帧正好顶满 ⇒ 真光标高一行（U31 三轮那条老病）。故这一栏**每条都担保一行**。
 */
function Completion({
  completion,
  columns,
}: {
  readonly completion: CompletionState
  readonly columns: number
}): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    ...completion.candidates.map((candidate, index) => {
      const marker = index === completion.selected ? '› ' : '  '
      // 这一栏没有内边距：整行就是屏宽 —— 扣掉标记（2 列）与名字、以及中间那个全角空格（2 列）
      const room = Math.max(0, columns - 4 - inkWidth(candidate.name))
      const summary = clip(candidate.summary, room)

      return h(
        Text,
        { key: `c:${candidate.name}` },
        h(
          Text,
          { color: index === completion.selected ? PALETTE.user : PALETTE.faint, bold: index === completion.selected },
          `${marker}${candidate.name}`,
        ),
        h(Text, { color: index === completion.selected ? PALETTE.dim : PALETTE.faint }, `　${summary}`),
      )
    }),
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

/**
 * 草稿那一片最多占几行——**半屏**（原型 · 键盘：多行草稿的高度随内容长，上限半屏）。
 *
 * ⚠️ 这一份预算**含**「… 上面/下面还有 N 行」那两行提示（U31 二轮退回）——
 * 它同时是 `dockOf` 渲染用的 `maxLines` 与 `dockHeightOf` 算账用的那一个，
 * 两处同源，账与屏才不差分毫（由头见 `dock` 那一段注）。
 */
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

    // `+ 3` ＝ 卡自己那三行：标题前那一行 `marginTop` · 标题 · 键位行。
    // ⚠️ 账与屏同源：这里比屏上多算一行，活动区就少一行，矮窗上**真光标高一行**
    //    （见本文件 `dock` 那一段注）。
    return material + 3 + flash
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

    // `@` 那一栏**多一行输入行**（U36：草稿照旧露着，见 `dockOf`）——与渲染**同取一处**
    // （`draftHeight`）。这一格漏了，账与屏当场分家（矮终端上真光标高一行，U31 那条老病）。
    const composer =
      view.dock.picker.source === 'paths'
        ? draftHeight(view.draft, view.caret, columns, maxDraftLines(rows))
        : 0

    return view.dock.picker.rows.length + heads + hint + composer + flash
  }

  // 输入行那一片：草稿有几**视觉行**就占几行（多行草稿 —— 半屏封顶；见 `draftHeight`）。
  // ⚠️ 与渲染**同一处**算（`composerLayout`）——折行、折叠、「上面/下面还有 N 行」
  //    那两行都算在内；各算一套迟早对不上（D11 那条「行高与实际不符」就是这么来的）。
  // ⚠️ **U36 起没有「草稿材料」那一行**（U33 的 `SkillLine` 已删，账里那一格随之去掉）：
  //    引用就长在草稿那几行里，不另占一行。
  return draftHeight(view.draft, view.caret, columns, maxDraftLines(rows)) + completing + flash
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
    readonly leftArrow?: boolean
    readonly rightArrow?: boolean
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
  // ⚠️ **退格与前向删除是两个键**（U31）——早先并成「退格」，插入点一动就露馅：
  //    两个键删的是**两边**（`⌫` 删插入点左边、`delete` 删右边）
  if (key.backspace === true) return [{ kind: 'backspace' }]
  if (key.delete === true) return [{ kind: 'delete' }]
  if (key.escape === true) return [{ kind: 'escape' }]
  if (key.upArrow === true) return [{ kind: 'up' }]
  if (key.downArrow === true) return [{ kind: 'down' }]
  // 左右键（U31）——Ink 给的形态：`input === ''` ＋ `key.leftArrow / rightArrow`
  if (key.leftArrow === true) return [{ kind: 'left' }]
  if (key.rightArrow === true) return [{ kind: 'right' }]

  // 带 ctrl / meta 的其余键不是正文（Ink 把控制字符解成「字母 ＋ ctrl」）
  if (key.ctrl === true || key.meta === true) {
    return input === '' ? [] : [{ kind: 'other', label: `${key.ctrl === true ? 'ctrl+' : 'meta+'}${input}` }]
  }

  if (input === '') return []

  // 一次来一串＝粘贴（没走 bracketed paste 的终端）
  return [...input].map((char) => ({ kind: 'char', char }) as const)
}
