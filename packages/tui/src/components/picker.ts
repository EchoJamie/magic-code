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
import type { Picker, PickerRow } from '../view.ts'
import { groupHeads } from '../view.ts'
import { clip, inkWidth } from './composer.ts'
import { PALETTE } from './lines.ts'

export type PickerProps = {
  readonly picker: Picker
  /**
   * 一屏多少列——**只有「担保一行」的那些行用得上**（`PickerRow.oneLine`：超宽要截，
   * 截到哪儿得知道屏有多宽）。别的行不看它（照旧由 Ink 折行，那是既有行为）。
   */
  readonly columns: number
}

/** 序号那一格的宽（`01 `）——截断要把这几位扣掉，不然算出来的宽度多三列。 */
const NUMBER_WIDTH = 3
/** 标签与 meta 之间那个**全角**空格（`　`）占两列。 */
const GAP_WIDTH = 2

/**
 * 一行要画的字——**担保一行的行**在这儿截（`oneLine`），其余原样。
 *
 * 宽度从整屏列数倒推：盒子的 `paddingX: 1` 两边各占一列，行里先是序号，
 * 再是标签，中间一个全角空格，最后是 meta。扣完剩下的才是这两段共用的额度
 * ——标签先占，meta 吃剩下的（**窄窗先保住名称/来源、再截断简述**：技能那些行把
 * 来源摆在 meta 的前半截，正是为了先丢的是简述）。
 *
 * ⚠️ 截断用的是 **Ink 那把尺**（`clip`／`inkWidth`，见 `composer.ts`）——两把尺混用
 * 会让「裁到刚好」与「Ink 又折了一行」各说各的，交互区的高度账当场分家。
 */
function partsOf(row: PickerRow, columns: number): { label: string; meta: string } {
  if (row.oneLine !== true) return { label: row.label, meta: row.meta }

  const room = Math.max(0, columns - 2 - NUMBER_WIDTH - GAP_WIDTH)
  // **名称至多占一半**（U33 独立验收退回①）：名字取自 front-matter，可以长到 64 字符；
  // 让它按需吃满，窄窗下 meta（来源 ＋ 简述）就会被**整段挤掉**——两行同名同档的候选
  // 于是只剩同一串截断的名字，用户一个依据都没有（真 PTY 反例：60 列 · 56 字符名 ·
  // 项目/用户两份，连「项目 / 用户」都不见了）。留一半给 meta，来源就总在。
  const label = clip(row.label, Math.max(1, Math.floor(room / 2)))

  return { label, meta: clip(row.meta, Math.max(0, room - inkWidth(label))) }
}

export function PickerList({ picker, columns }: PickerProps) {
  const heads = groupHeads(picker.rows)
  const lines = picker.rows.map((row, index) => {
    const { label, meta } = partsOf(row, columns)

    return h(
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
          label,
        ),
        h(Text, { color: PALETTE.faint }, `　${meta}`),
      ),
    )
  })

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...lines,
    // 列表下方那行说明（可选）
    picker.hint === undefined ? null : h(Text, { color: PALETTE.faint }, `　${picker.hint}`),
  )
}
