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
import type { Shell, ShellKey } from '../shell.ts'
import type { CompletionState, LogRow, ShellView } from '../view.ts'
import { hasRunningTool } from '../view.ts'
import { Composer, draftHeight, type ComposerTone } from './composer.ts'
import { DecisionCard } from './decision.ts'
import { LogRowView, needsSpacer, rowLines } from './log.ts'
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

  return h(
    Box,
    { flexDirection: 'column' },
    // **已定局的行走 Static**——写一次即入 scrollback，此后不重绘（D11 的结构性护栏）。
    // `key` 按会话——换会话时重挂，重建的那些行才会被写出来（Static 只追加新项）
    h(StaticList, {
      key: `static:${view.sessionId ?? 'none'}`,
      // ⚠️ **原样交 `view.settled`，不 `[...]` 复制**（U21 · 历史区静态化）：
      // Ink 的 `Static` 拿 `[items, index]` 做 `useMemo` 的依赖——每帧递一个新数组，
      // 那个 memo 每帧都白算一遍（`items.slice(index)`）。`settled` 只在**真的加了行**
      // 时才换对象（`settle` / `appendSettled` 都是这么写的），故这一交就是稳定的。
      // 实测这笔账很小（5000 行 0.019ms · `bench-cost.ts`）——**如实记：它不是瓶颈**，
      // 改它是顺手把这条纪律立住，不是优化的大头。
      items: view.settled,
      // `children` 是**函数入参**（Static 的形态如此，不是 JSX 子节点）——故写在 props 里
      children: (row: LogRow, index: number) =>
        h(LogRowView, {
          key: row.key,
          row,
          columns,
          expanded: view.expanded,
          spaced: needsSpacer(view.settled, index),
        }),
    }),
    // **空态**（原型 · 场景 1）——还没有会话、屏上也没有东西时给引导语
    ...(isEmpty(view) ? [h(EmptyState, { key: 'empty' })] : []),
    // 本轮的行（还在变）——就地重绘
    ...live.rows.map((row, index) =>
      h(LogRowView, {
        key: row.key,
        row,
        columns,
        expanded: view.expanded,
        spaced: index === 0 ? view.settled.length > 0 && row.kind === 'user' : needsSpacer(live.rows, index),
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
 * 空态（原型 · 场景 1）——**按「这条会话有没有内容」判**（缺陷 D3）：
 * 还没有会话（`sessionId === null`）且屏上什么都没有。**不是**按本进程的计数。
 */
export function isEmpty(view: ShellView): boolean {
  return view.sessionId === null && view.settled.length === 0 && view.rows.length === 0
}

/** 空态的引导语（原型 · 场景 1 的原文）。 */
function EmptyState(): ReactElement {
  const line = (key: string, text: string, color: string = PALETTE.dim) =>
    h(Text, { key, color }, text)

  return h(
    Box,
    { flexDirection: 'column' },
    h(
      Text,
      { key: 'e:0' },
      h(Text, { color: PALETTE.faint }, '交代一件事就开始。会话在'),
      h(Text, { color: PALETTE.faint, bold: true }, '你按下第一次回车'),
      h(Text, { color: PALETTE.faint }, '时才建立。'),
    ),
    line('e:1', ''),
    line('e:2', '比如：'),
    line('e:3', '　· 看看这个工作区里有什么'),
    line('e:4', '　· 把 src/utils/date.ts 的时区处理改成本地时区'),
    h(
      Text,
      { key: 'e:5' },
      h(Text, { color: PALETTE.dim }, '　· 上次那个 bug 修到哪了？'),
      h(Text, { color: PALETTE.faint }, '　（/session 接着上次）'),
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
    const hint = view.dock.picker.hint === undefined ? 0 : 1
    return view.dock.picker.rows.length + hint + flash
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
