/**
 * 步骤清单那一块（U34）——**铺在动态区末尾、输入区上方**（设计 · 任务推进 · 终端投影与布局）。
 *
 * 这一层**只画**：画什么、画几行、哪几行由 `plan.ts` 的 `planBlockOf` 一处定
 * （账与屏同源——高度也是那一个数）。故这里没有一列宽度是自己算的。
 *
 * 三个状态各自的样子（设计）：
 * - **未开始**空心、继承终端前景色；
 * - **进行中**主题色实心方块 ＋ 步骤文字适度强调，方块**轻微亮度呼吸**（由活壳那支
 *   按需 200ms 的钟给「此刻」，见 `breathOf`）；
 * - **已完成**继承前景色的静态实心方块。
 *
 * **无色环境**（终端不发色码）剩下的正是字形与文字强调：空心/实心分得出未开始，
 * `bold` 分得出进行中——故「什么都不用颜色也能读」（设计那句「无色环境保留形状与
 * 文字强调的区别」）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { GLYPHS, MARK_WIDTH, breathOf, planStyleOf } from '../plan.ts'
import type { PlanBlock, PlanRow } from '../plan.ts'
import { PALETTE } from './lines.ts'

export type PlanListProps = {
  readonly block: PlanBlock
  /**
   * **此刻**（毫秒）——呼吸靠它；`null` ＝ 没有钟在走（空闲 / 不该动的时候），
   * 那时画**原色**（不呼吸＝最亮那一档，见 `planStyleOf`）。
   */
  readonly now: number | null
}

export function PlanList({ block, now }: PlanListProps): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    ...block.rows.map((row) => h(PlanLine, { key: row.key, row, now })),
  )
}

/** 一行——只有「带方块」的那些行分两段（方块那格 ＋ 文字），其余整行一种面孔。 */
function PlanLine({ row, now }: { readonly row: PlanRow; readonly now: number | null }): ReactElement {
  if (row.kind !== 'step') {
    // 溢出提示与「已收起」那一行：**最弱的那一档色**——它们是把手，不是内容
    return h(Text, { color: PALETTE.faint }, row.text)
  }

  const style = planStyleOf(row.status, now === null ? 1 : breathOf(now))

  return h(
    Text,
    null,
    row.head
      ? h(Text, { color: style.glyph ?? undefined, dimColor: style.dim }, `${GLYPHS[row.status]} `)
      : h(Text, null, ' '.repeat(MARK_WIDTH)),
    h(Text, { bold: style.bold, dimColor: style.dim }, row.text),
  )
}
