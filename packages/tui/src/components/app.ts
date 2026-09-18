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
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import type { Shell, ShellKey } from '../shell.ts'
import type { CompletionState, LogRow, ShellView } from '../view.ts'
import { Composer, type ComposerTone } from './composer.ts'
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
}

export function AppView({ view, columns, rows }: AppViewProps) {
  // 活动区的预算：减去交互区与状态行（**不填满窗口**——内联模式下内容跟内容走）
  const dock = Math.min(dockHeightOf(view, columns), Math.max(4, Math.floor(rows / 2)))
  const liveBudget = Math.max(1, rows - dock - 2)
  const live = tailWithin(view.rows, columns, view.expanded, liveBudget)

  return h(
    Box,
    { flexDirection: 'column' },
    // **已定局的行走 Static**——写一次即入 scrollback，此后不重绘（D11 的结构性护栏）。
    // `key` 按会话——换会话时重挂，重建的那些行才会被写出来（Static 只追加新项）
    h(StaticList, {
      key: `static:${view.sessionId ?? 'none'}`,
      items: [...view.settled],
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
      }),
    ),
    // **全屏只有这一条分隔线**（记录区与交互区之间）
    h(Text, { color: PALETTE.ghost }, '─'.repeat(Math.max(1, columns))),
    h(Box, { flexDirection: 'column' }, ...dockOf(view)),
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
function dockOf(view: ShellView): readonly ReactElement[] {
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
    h(Composer, { key: 'composer', draft: view.draft, tone: toneOf(view) }),
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

/** 输入行的面孔——按状态给（显示层不判断业务，只翻状态）。 */
function toneOf(view: ShellView): ComposerTone {
  if (view.status.state === 'retrying') return 'retrying'
  if (view.status.state === 'working') return 'working'

  return 'idle'
}

/**
 * 交互区要几行——**按内容算**（原型：展开高度＝内容所需，最多半屏）。纯函数：布局与用例都拿它。
 */
export function dockHeightOf(view: ShellView, columns: number): number {
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

  return 1 + completing + flash
}

/** 自动补全的候选行数（D12）——零条时不出。 */
function completionLines(view: ShellView): number {
  return view.completion === null ? 0 : view.completion.candidates.length
}

// —— 活壳 ——

export type TuiAppProps = {
  readonly shell: Shell
}

export function TuiApp({ shell }: TuiAppProps) {
  const view = useSyncExternalStore(shell.subscribe, shell.getView)
  const { columns, rows } = useWindowSize()
  const { exit } = useApp()

  const feed = (key: ShellKey): void => {
    if (shell.key(key).exit) exit()
  }

  useInput((input, key) => {
    for (const mapped of toShellKeys(input, key)) feed(mapped)
  })

  // 粘贴走**另一条信道**（bracketed paste）——接管期间一律拒并提示
  usePaste((text) => feed({ kind: 'paste', text }))

  return h(AppView, { view, columns, rows })
}

/** Ink 的 `(input, key)` → 外壳认得的按键（0 到多条——一次回调可能带一串正文）。 */
export function toShellKeys(
  input: string,
  key: {
    readonly ctrl?: boolean
    readonly meta?: boolean
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
