/**
 * 选择器（缺陷轮 II 重画）——`/session` · `/model` 的展开形态。
 *
 * 规矩（原型 · 场景 9 / 10）：**只在左下开，记录区什么都不进**；上下选＝常规逻辑；
 * 选定后**留一行回执**；`esc` 取消＝**不留痕迹**。
 *
 * 与输入区**同一位置、同一开合**——故它只是 `Dock` 的另一种形态，不另起一块。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { Picker } from '../view.ts'
import { PALETTE } from './lines.ts'

export type PickerProps = {
  readonly picker: Picker
}

export function PickerList({ picker }: PickerProps) {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...picker.rows.map((row, index) =>
      h(
        Text,
        { key: `p:${index}` },
        h(Text, { color: row.current ? PALETTE.user : PALETTE.faint }, `${String(index + 1).padStart(2)} `),
        h(
          Text,
          {
            color: index === picker.selected ? PALETTE.fg : row.current ? PALETTE.user : PALETTE.dim,
            bold: index === picker.selected || row.current,
          },
          row.label,
        ),
        h(Text, { color: PALETTE.faint }, `　${row.meta}`),
      ),
    ),
    // 列表下方那行说明（可选）
    picker.hint === undefined ? null : h(Text, { color: PALETTE.faint }, `　${picker.hint}`),
  )
}
