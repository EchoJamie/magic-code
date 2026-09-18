/**
 * 外壳 · 一屏（缺陷轮 II 重画）——**三带结构**：上＝记录区 · 下＝交互区 · 最底＝状态行。
 *
 * 版面（原型 · 交互逻辑）：
 * - **无顶栏**；视觉锚点在左下；**全屏只有一条分隔线**（记录区与交互区之间那一条）；
 * - **铺满窗口**、resize 按新尺寸重算——记录区可视行数 · 抽屉最大高度（半屏）·
 *   状态行两段放不放得下；
 * - **抽屉**（左下交互区）四种用法同一位置：输入 / 裁决 / 选择器——展开高度＝内容所需，
 *   **最多半屏**，再多滚它自己。
 *
 * 两层分得清：`AppView` 是**纯**的（给视图与尺寸就画一屏——快照直接取景）；
 * `TuiApp` 是**活**的（订阅外壳、把 Ink 的键喂进外壳、按 `ShellEffect` 退场）。
 */

import { Box, Text, useApp, useInput, usePaste, useWindowSize } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { useSyncExternalStore } from 'react'
import type { Shell, ShellKey } from '../shell.ts'
import type { ShellView } from '../view.ts'
import { Composer, type ComposerTone } from './composer.ts'
import { DecisionCard } from './decision.ts'
import { Log } from './log.ts'
import { PALETTE, wrap } from './lines.ts'
import { PickerList } from './picker.ts'
import { StatusLine } from './status.ts'

// —— 纯呈现 ——

export type AppViewProps = {
  readonly view: ShellView
  readonly columns: number
  readonly rows: number
}

export function AppView({ view, columns, rows }: AppViewProps) {
  const dock = Math.min(dockHeightOf(view, columns), Math.max(4, Math.floor(rows / 2)))
  // 铺满窗口：减去分隔线（1）与状态行（1）
  const logHeight = Math.max(1, rows - dock - 2)

  return h(
    Box,
    { flexDirection: 'column', width: columns, height: rows },
    h(Log, {
      rows: view.rows,
      columns,
      height: logHeight,
      expanded: view.expanded,
      empty: view.rows.length === 0 && view.sessionId === null,
    }),
    // **全屏只有这一条分隔线**
    h(Text, { color: PALETTE.ghost }, '─'.repeat(Math.max(1, columns))),
    h(Box, { flexDirection: 'column' }, ...dockOf(view)),
    h(StatusLine, { status: view.status, columns }),
  )
}

/** 左下交互区的内容（四种用法）。 */
function dockOf(view: ShellView): readonly ReactElement[] {
  const flash =
    view.flash === null
      ? []
      : [h(Text, { key: 'flash', color: PALETTE.warn }, `▲ ${view.flash}`)]

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

  return [h(Composer, { key: 'composer', draft: view.draft, tone: toneOf(view) }), ...flash]
}

/** 输入行的面孔——按状态给（显示层不判断业务，只翻状态）。 */
function toneOf(view: ShellView): ComposerTone {
  if (view.status.state === 'retrying') return 'retrying'
  if (view.status.state === 'working') return 'working'

  return 'idle'
}

/**
 * 抽屉要几行——**按内容算**（原型：展开高度＝内容所需，最多半屏）。
 * 纯函数：布局预算与用例都拿它。
 */
export function dockHeightOf(view: ShellView, columns: number): number {
  const flash = view.flash === null ? 0 : 1

  if (view.dock.kind === 'decision') {
    // 卡（标题 1 ＋ 材料若干 ＋ 键位 1，另加 marginTop 1）＋ 输入行 1
    const material = view.dock.pending.material
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, wrap(line, Math.max(8, columns - 4)).length), 0)

    return material + 4 + flash
  }

  if (view.dock.kind === 'picker') {
    const hint = view.dock.picker.hint === undefined ? 0 : 1
    return view.dock.picker.rows.length + hint + flash
  }

  return 1 + flash
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
  },
): readonly ShellKey[] {
  if (key.ctrl === true && input === 'c') return [{ kind: 'ctrl+c' }]
  if (key.ctrl === true && input === 'o') return [{ kind: 'ctrl+o' }]
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
