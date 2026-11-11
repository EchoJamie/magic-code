import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { Picker, PickerRow } from '../view.ts'
import { groupHeads } from '../view.ts'
import { clip, inkWidth } from './composer.ts'
import { wrap, PALETTE } from './lines.ts'

export type PickerItem =
  | { readonly kind: 'head'; readonly key: string; readonly head: string; readonly faint: boolean }
  | { readonly kind: 'row'; readonly key: string; readonly row: PickerRow; readonly index: number }
  | { readonly kind: 'notice'; readonly key: string; readonly text: string }
  | { readonly kind: 'detail'; readonly key: string; readonly text: string }
export type PickerLayout = { readonly items: readonly PickerItem[]; readonly above: number; readonly below: number; readonly height: number; readonly detailTop: number; readonly detailSize: number; readonly detailTotal: number }
export type PickerProps = { readonly picker: Picker; readonly columns: number; readonly rows?: number }
export function maxPickerLines(rows: number): number { return Math.max(1, Math.floor(rows / 2)) }
export function titleLines(picker: Picker, columns: number): number { return picker.title === undefined ? 0 : wrap(picker.title, Math.max(1, columns - 2)).length }
export function pickerBudget(picker: Picker, columns: number, rows: number): number {
  return Math.max(1, maxPickerLines(rows) - titleLines(picker, columns) - (picker.hint === undefined ? 0 : wrap(picker.hint, Math.max(1, columns - 5)).length))
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
function itemHeight(item: PickerItem, columns: number): number {
  return wrap(item.kind === 'row' ? rowText(item.row, columns) : item.kind === 'head' ? item.head : item.text, Math.max(1, columns - (item.kind === 'head' ? 2 : 5))).length
}
/** 焦点窗口按真实折行高度收缩；渲染与高度账共享同一结果。 */
export function pickerLayout(picker: Picker, budget = Number.POSITIVE_INFINITY, columns = 160): PickerLayout {
  const heads = groupHeads(picker.rows), blocks: PickerItem[][] = [], pinned: PickerItem[] = []
  // 同一布局中窗口反复收缩，只量一次每个条目的真实行高。
  const heights = new Map<PickerItem, number>()
  const height = (items: readonly PickerItem[]) => items.reduce((n, item) => {
    let size = heights.get(item)
    if (size === undefined) { size = itemHeight(item, columns); heights.set(item, size) }
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
export function PickerList({ picker, columns, rows = Number.POSITIVE_INFINITY }: PickerProps) {
  const layout = pickerLayout(picker, pickerBudget(picker, columns, rows), columns)
  return h(Box, { flexDirection: 'column', paddingX: 1 },
    picker.title === undefined ? null : h(Text, { color: PALETTE.fg }, picker.title),
    ...layout.items.map(item => {
      if (item.kind === 'head') return h(Text, { key: item.key, color: item.faint ? PALETTE.faint : PALETTE.dim }, item.head)
      if (item.kind !== 'row') return h(Box, { key: item.key, paddingLeft: 3 }, h(Text, { color: PALETTE.faint }, item.text))
      const selected = item.index === picker.selected
      return h(Box, { key: item.key }, h(Text, { color: selected ? PALETTE.user : PALETTE.faint }, selected ? '›  ' : '   '), h(Text, { color: selected ? PALETTE.fg : item.row.current ? PALETTE.user : item.row.faint ? PALETTE.faint : PALETTE.dim, bold: selected || item.row.current }, rowText(item.row, columns)))
    }),
    picker.hint === undefined ? null : h(Box, { paddingLeft: 3 }, h(Text, { color: PALETTE.faint }, picker.hint)))
}
