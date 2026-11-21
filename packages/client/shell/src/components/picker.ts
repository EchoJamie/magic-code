import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { Picker, PickerRow } from '../view.ts'
import { groupHeads } from '../view.ts'
import { breathColor, breathOf } from '../motion.ts'
import { clip, inkWidth } from './composer.ts'
import { MARKS } from '../boards/conversation/marks.ts'
import { wrap, PALETTE } from './lines.ts'

/**
 * **两套排版，一屏一种**（2026-11-20 · 关掉「字符画」那一轮）。
 *
 * - **面板式**（`picker.tabs !== undefined`）：`Tab` 那两屏（协作 ↔ 后台命令）。页签行铺
 *   **反白块**表示「你在哪一页」，底下一行留白，行是**两列对齐**（名称在左、状态在右），
 *   选中那一条**整行铺底色**＋左侧 `❯`。**一条分隔线都不画**——分组靠留白与缩进，
 *   与 Claude Code 的 `/config` 同一路子：那里的「不像字符画」不是画笔更好，是
 *   底色块 + 两列 + 留白 + 符号各管一件事。
 * - **抽屉式**（其余）：照原样画（一行一条、`›` 标记、`　` 分隔两段）。别的一次性选择
 *   器不动——它们不需要「你在哪一页」这个概念，改了只是顺手，不是这一轮的事。
 */

type PickerItem =
  | { readonly kind: 'head'; readonly key: string; readonly head: string; readonly faint: boolean }
  | { readonly kind: 'row'; readonly key: string; readonly row: PickerRow; readonly index: number }
  | { readonly kind: 'notice'; readonly key: string; readonly text: string }
  | { readonly kind: 'detail'; readonly key: string; readonly text: string }
export type PickerLayout = { readonly items: readonly PickerItem[]; readonly above: number; readonly below: number; readonly height: number; readonly detailTop: number; readonly detailSize: number; readonly detailTotal: number }
export type PickerProps = { readonly picker: Picker; readonly columns: number; readonly rows?: number; readonly now?: number | null }
function maxPickerLines(rows: number): number { return Math.max(1, Math.floor(rows / 2)) }
/** 面板式那面旗——`tabs` 给了就是（见文件头「两套排版」）。 */
const panelOf = (picker: Picker): boolean => picker.tabs !== undefined
export function titleLines(picker: Picker, columns: number): number {
  // 面板式里标题挪到**页签那一行的右边**当面包屑（`tabRow`），不另占行。
  if (panelOf(picker) || picker.title === undefined) return 0
  return wrap(picker.title, Math.max(1, columns - 2)).length
}
/** 页签那一行 ＋ 那一行留白（面板式）；抽屉式没有这两行。 */
export function tabLines(picker: Picker): number { return panelOf(picker) ? 2 : 0 }
/** 底下那行说明按实际折几行算——**渲染与高度账同取这一处**（见 `dockContentHeightOf`）。 */
export function hintLines(picker: Picker, columns: number): readonly string[] {
  if (picker.hint === undefined) return []
  return wrap(picker.hint, Math.max(1, columns - (panelOf(picker) ? 2 : 5)))
}
export function pickerBudget(picker: Picker, columns: number, rows: number): number {
  return Math.max(1, maxPickerLines(rows) - tabLines(picker) - titleLines(picker, columns) - hintLines(picker, columns).length)
}
function partsOf(row: PickerRow, columns: number): { label: string; meta: string } {
  if (row.oneLine !== true) return { label: row.label, meta: row.meta }
  const room = Math.max(1, columns - 5), gap = row.meta === '' ? 0 : 2
  if (inkWidth(row.label) + gap + inkWidth(row.meta) <= room) return { label: row.label, meta: row.meta }
  const keep = Math.min(inkWidth(row.keep ?? '') + gap, Math.floor(room / 2))
  const label = clip(row.label, Math.max(1, room - keep))
  const left = room - inkWidth(label) - gap
  return { label, meta: left > 1 ? clip(row.meta, left) : '' }
}
function rowText(row: PickerRow, columns: number): string {
  const { label, meta } = partsOf(row, columns); return label + (meta === '' ? '' : `　${meta}`)
}
/**
 * **面板式那一行的两段**：名称在左、状态在右，中间靠位置分开。
 *
 * 额度算法与抽屉式同一条纪律（窄窗先保名称、再截 meta）；差别只在左边固定让出两格：
 * 一格是 `❯ `，一格是行末的留白——故可用宽度是 `columns - 2（外边距） - 2（标记）`。
 */
function panelParts(row: PickerRow, columns: number): { label: string; meta: string } {
  const avail = Math.max(1, columns - 4), gap = row.meta === '' ? 0 : 2
  if (inkWidth(row.label) + gap + inkWidth(row.meta) <= avail) return { label: row.label, meta: row.meta }
  const keep = Math.min(inkWidth(row.keep ?? '') + gap, Math.floor(avail / 2))
  const label = clip(row.label, Math.max(1, avail - keep))
  const left = avail - inkWidth(label) - gap
  return { label, meta: left > 1 ? clip(row.meta, left) : '' }
}
function itemHeight(item: PickerItem, columns: number, panel: boolean): number {
  // 面板式的行**自己截到一行**（两段各留额度，见 `panelParts`）——账与屏才对得上。
  if (panel && item.kind === 'row') return 1
  return wrap(item.kind === 'row' ? rowText(item.row, columns) : item.kind === 'head' ? item.head : item.text, Math.max(1, columns - (item.kind === 'head' ? 2 : 5))).length
}
/** 焦点窗口按真实折行高度收缩；渲染与高度账共享同一结果。 */
export function pickerLayout(picker: Picker, budget = Number.POSITIVE_INFINITY, columns = 160): PickerLayout {
  const heads = groupHeads(picker.rows), blocks: PickerItem[][] = [], pinned: PickerItem[] = []
  const panel = panelOf(picker)
  // 同一布局中窗口反复收缩，只量一次每个条目的真实行高。
  const heights = new Map<PickerItem, number>()
  const height = (items: readonly PickerItem[]) => items.reduce((n, item) => {
    let size = heights.get(item)
    if (size === undefined) { size = itemHeight(item, columns, panel); heights.set(item, size) }
    return n + size
  }, 0)
  const selected = picker.rows[picker.selected]
  const details = (picker.detail ?? selected?.detail ?? []).flatMap(text => wrap(text, Math.max(1, columns - 5)))
  // 长详情复用层内翻页；焦点与可读正文作为一个窗口，不因裁候选而丢失详情。
  const focused: PickerItem[] = selected === undefined ? [] : [
    ...(selected.group ? [{ kind: 'head' as const, key: 'focused-head', head: selected.group, faint: selected.faint === true }] : []),
    { kind: 'row', key: `r:${picker.selected}`, row: selected, index: picker.selected },
  ]
  for (const [index, row] of picker.rows.entries()) if (row.pinned) pinned.push({ kind: 'row', key: `r:${index}`, row, index })
  const room = Math.max(0, budget - height(focused) - height(pinned) - (picker.rows.length > 1 ? 1 : 0))
  const detailSize = details.length <= room ? details.length : Math.max(0, room - 1)
  const detailTop = Math.min(Math.max(0, picker.detailTop ?? 0), Math.max(0, details.length - detailSize))
  const detailItems: PickerItem[] = details.slice(detailTop, detailTop + detailSize).map((text, index) => ({ kind: 'detail', key: `d:${detailTop + index}`, text }))
  if (detailSize < details.length) detailItems.push({ kind: 'notice', key: 'detail-page', text: `PgUp/PgDn 详情 ${detailTop + 1}–${detailTop + detailSize}/${details.length}` })
  picker.rows.forEach((row, index) => {
    if (row.pinned) return
    const block: PickerItem[] = []
    if (heads[index]) block.push({ kind: 'head', key: `h:${index}`, head: row.group ?? '', faint: row.faint === true })
    block.push({ kind: 'row', key: `r:${index}`, row, index })
    if (index === picker.selected) block.push(...detailItems)
    blocks.push(block)
  })
  const result = (items: readonly PickerItem[], above: number, below: number): PickerLayout => ({ items, above, below, height: height(items), detailTop, detailSize, detailTotal: details.length })
  const all = [...blocks.flat(), ...pinned]
  if (height(all) <= budget) return result(all, 0, 0)
  const anchor = Math.max(0, blocks.findIndex(block => block.some(item => item.kind === 'row' && item.index === picker.selected)))
  for (let size = blocks.length; size >= 1; size--) {
    const from = Math.min(Math.max(anchor - Math.floor((size - 1) / 2), 0), blocks.length - size)
    if (from > anchor || from + size <= anchor) continue
    const above = from, below = blocks.length - from - size
    const window = blocks.slice(from, from + size).flat()
    const first = window.find(item => item.kind === 'row')
    if (first?.kind === 'row' && first.row.group && window[0]?.kind !== 'head') window.unshift({ kind: 'head', key: 'window-head', head: first.row.group, faint: first.row.faint === true })
    const items: PickerItem[] = [...window, ...pinned,
    ...(above || below ? [{ kind: 'notice' as const, key: 'more', text: `… 上面 ${above} 条 · 下面 ${below} 条` }] : [])]
    if (height(items) <= budget) return result(items, above, below)
  }
  return result([...focused, ...detailItems, ...pinned], anchor, blocks.length - anchor - 1)
}
/** 面板式的页签行：左边几段（当前那段铺反白块），右边面包屑（`title`）。 */
function tabRow(picker: Picker & { readonly tabs: NonNullable<Picker['tabs']> }, columns: number) {
  const tabs = picker.tabs
  const used = tabs.reduce((sum, tab) => sum + inkWidth(tab.label) + 2, 0) + Math.max(0, tabs.length - 1) * 2
  const room = columns - 2 - used - 2
  const subtitle = picker.title === undefined || room < 4 ? '' : clip(picker.title, room)
  return h(Box, { flexDirection: 'row', justifyContent: 'space-between', width: Math.max(1, columns - 2) },
    h(Box, { flexDirection: 'row' },
      ...tabs.map((tab, index) => h(Box, { key: `tab:${index}`, marginLeft: index === 0 ? 0 : 2 },
        h(Text, {
          backgroundColor: tab.active ? PALETTE.tabOn : undefined,
          bold: tab.active,
          color: tab.active ? PALETTE.tabText : PALETTE.faint,
        }, ` ${tab.label} `)))),
    subtitle === '' ? null : h(Text, { color: PALETTE.faint }, subtitle))
}
/**
 * 面板式的一行：`❯` ＋ 名称，状态靠右对齐；**选中那一条整行铺底色**——底色表焦点，
 * 不靠「画一条线」或「加个边框」。
 *
 * `tone` 那一格只管两件事：状态位那个符号的颜色（`run` 走呼吸，其余取语义色）、
 * 以及 meta 的色；名称永远是正常前景色（一行是「谁」比一行是「什么状态」重要）。
 */
function panelRow(item: { readonly row: PickerRow; readonly index: number }, picker: Picker, columns: number, now: number | null) {
  const selected = item.index === picker.selected
  const { label, meta } = panelParts(item.row, columns)
  const tone = item.row.tone ?? 'idle'
  // 行首状态记号（可选，形取自 marks.ts 白名单）与 meta 前的 tone 点共用一套语义色——
  // `◐`/`⚠` 是脱队的老形，此役并回 marks 语言。
  // 自带 mark 的行由**记号**占状态位（渲染在行首），meta 前不再另加点——一行一个形。
  const dot = item.row.mark !== undefined ? '' : meta === '' ? '' : tone === 'run' ? `${MARKS.dot} ` : tone === 'wait' ? `${MARKS.ring} ` : tone === 'danger' ? `${MARKS.error} ` : ''
  const dotColor = tone === 'run'
    ? (now === null ? PALETTE.user : breathColor(PALETTE.user, breathOf(now)))
    : tone === 'wait' ? PALETTE.warn : PALETTE.danger
  const metaColor = tone === 'wait' ? PALETTE.warn : tone === 'danger' ? PALETTE.danger : tone === 'run' ? PALETTE.user : PALETTE.faint
  const markColor = dotColor
  return h(Box, {
    key: `r:${item.index}`,
    backgroundColor: selected ? PALETTE.select : undefined,
    flexDirection: 'row',
    width: Math.max(1, columns - 2),
  },
    h(Text, { color: selected ? PALETTE.user : PALETTE.faint }, selected ? '❯ ' : '  '),
    item.row.mark === undefined ? null : h(Text, { color: markColor }, `${item.row.mark} `),
    h(Text, { bold: selected, color: item.row.faint ? PALETTE.faint : PALETTE.fg }, label),
    h(Box, { flexGrow: 1 }),
    dot === '' ? null : h(Text, { color: dotColor }, dot),
    meta === '' ? null : h(Text, { color: selected ? PALETTE.fg : metaColor }, meta))
}
export function PickerList({ picker, columns, rows = Number.POSITIVE_INFINITY, now = null }: PickerProps) {
  const layout = pickerLayout(picker, pickerBudget(picker, columns, rows), columns)
  const panel = panelOf(picker)
  const items = layout.items.map(item => {
    if (item.kind === 'row') {
      if (panel) return panelRow(item, picker, columns, now)
      const selected = item.index === picker.selected
      return h(Box, { key: item.key }, h(Text, { color: selected ? PALETTE.user : PALETTE.faint }, selected ? '›  ' : '   '), h(Text, { color: selected ? PALETTE.fg : item.row.current ? PALETTE.user : item.row.faint ? PALETTE.faint : PALETTE.dim, bold: selected || item.row.current }, rowText(item.row, columns)))
    }
    if (item.kind === 'head') return h(Text, { key: item.key, color: item.faint ? PALETTE.faint : PALETTE.dim }, panel ? `  ${item.head}` : item.head)
    return h(Box, { key: item.key, paddingLeft: panel ? 2 : 3 }, h(Text, { color: PALETTE.faint }, item.text))
  })
  const hint = hintLines(picker, columns).map((line, index) =>
    panel
      ? h(Box, { key: `hint:${index}`, flexDirection: 'row', justifyContent: 'flex-end', width: Math.max(1, columns - 2) }, h(Text, { color: PALETTE.faint }, line))
      : h(Text, { key: `hint:${index}`, color: PALETTE.faint }, line))
  if (!panel) {
    return h(Box, { flexDirection: 'column', paddingX: 1 },
      picker.title === undefined ? null : h(Text, { color: PALETTE.fg }, picker.title),
      ...items,
      hint.length === 0 ? null : h(Box, { paddingLeft: 3, flexDirection: 'column' }, ...hint))
  }
  return h(Box, { flexDirection: 'column', paddingX: 1 },
    tabRow(picker as Picker & { readonly tabs: NonNullable<Picker['tabs']> }, columns),
    // 页签与列表之间**留一行白**（不是分隔线）：一屏的层次靠这个空行立起来。
    h(Text, {}, ' '),
    ...items,
    ...hint)
}
