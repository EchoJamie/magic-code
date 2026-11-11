import { Box, Text } from 'ink'
import { sanitizeForDisplay } from '@magic/contracts'
import { createElement as h } from 'react'
import type { Picker } from '../view.ts'
import { rowLines } from './log.ts'
import { clip } from './composer.ts'
import { PALETTE } from './lines.ts'

export function readerLayout(reader: NonNullable<Picker['reader']>, columns: number, rows: number) {
  const lines = reader.rows.flatMap((row, index) => rowLines(row, { columns: Math.max(4, columns - 2), expanded: true, spaced: index > 0 }))
  const budget = Math.max(1, Math.floor(Number.isFinite(rows) ? rows / 2 : 12) - 2)
  const maxTop = Math.max(0, lines.length - budget)
  const top = Math.min(maxTop, Math.max(0, reader.top))
  return { lines: lines.slice(top, top + budget), top, maxTop, total: lines.length, height: Math.max(1, Math.min(lines.length, budget)) + 2 }
}

export function RecordReader({ reader, columns, rows }: { readonly reader: NonNullable<Picker['reader']>; readonly columns: number; readonly rows: number }) {
  const layout = readerLayout(reader, columns, rows)
  return h(Box, { flexDirection: 'column', paddingX: 1 },
    h(Text, { color: PALETTE.fg, bold: true }, clip(sanitizeForDisplay(reader.title), Math.max(1, columns - 2))),
    ...(layout.lines.length ? layout.lines.map((line, index) => h(Text, { key: index },
      ...(line.segments.length ? line.segments.map((segment, at) => h(Text, { key: at, color: segment.color, bold: segment.bold }, segment.text)) : [' ']),
    )) : [h(Text, { key: 'empty', color: PALETTE.dim }, '暂无记录')]),
    h(Text, { color: PALETTE.faint }, clip(`↑↓ / PgUp PgDn 阅读 · ← 返回 · Esc 收起 · ${layout.total ? layout.top + 1 : 0}–${Math.min(layout.total, layout.top + layout.lines.length)} / ${layout.total}`, Math.max(1, columns - 2))),
  )
}
