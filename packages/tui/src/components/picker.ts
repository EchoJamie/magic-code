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
import { groupHeads } from '../view.ts'
import { PALETTE } from './lines.ts'

export type PickerProps = {
  readonly picker: Picker
}

export function PickerList({ picker }: PickerProps) {
  const heads = groupHeads(picker.rows)
  const lines = picker.rows.map((row, index) =>
    h(
      Box,
      { key: `p:${index}`, flexDirection: 'column' },
      // 分组头（`/session` 按工作区分组，U26）——画在本组第一行之前；别的项目那一组连头一起压暗
      heads[index] === true
        ? h(Text, { key: 'head', color: row.faint === true ? PALETTE.faint : PALETTE.dim }, `　${row.group ?? ''}`)
        : null,
      h(
        Text,
        { key: 'row' },
        h(Text, { color: row.current ? PALETTE.user : PALETTE.faint }, `${String(index + 1).padStart(2)} `),
        h(
          Text,
          {
            // 压暗最弱，但**当前那条与选中项照旧亮**——「正在用」比「属于哪组」更该被看见，
            // 而压暗只是视觉次序，不是可用性（压暗的行照样选得中、切得过去）
            color:
              index === picker.selected
                ? PALETTE.fg
                : row.current
                  ? PALETTE.user
                  : row.faint === true
                    ? PALETTE.faint
                    : PALETTE.dim,
            bold: index === picker.selected || row.current,
          },
          row.label,
        ),
        h(Text, { color: PALETTE.faint }, `　${row.meta}`),
      ),
    ),
  )

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...lines,
    // 列表下方那行说明（可选）
    picker.hint === undefined ? null : h(Text, { color: PALETTE.faint }, `　${picker.hint}`),
  )
}
