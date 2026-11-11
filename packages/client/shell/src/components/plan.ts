/**
 * 步骤清单那一块（U34 · **U85 挪位**）——**铺在分隔线之下、输入区上方**，与输入区同侧。
 *
 * ⚠️ **U34 起它画在记录区那一侧**（上面那条分隔线**之上**）——屏上读起来就是「上面那些话的
 * 一部分」。U85 挪到线的这一侧：现成的线把它与滚动记录划开（不另加第三条线，见
 * `components/app.ts` 的 `AppView`）。**排版一个字没动**，动的只是它站哪一侧。
 *
 * 这一层**只画**：画什么、画几行、哪几行由 `plan.ts` 的 `planBlockOf` 一处定
 * （账与屏同源——高度也是那一个数）。故这里没有一列宽度是自己算的。
 *
 * ⚠️ **U90 起清单是两段**：**目标顶格一行**（这件事是什么）· **步骤整块退一级**挂在它
 * 下面。层级靠缩进给，不加线、不加记号、不引入父子树（步骤之间仍是平的一列）。
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
import { GLYPHS, MARK_WIDTH, PLAN_INDENT, breathOf, planStyleOf } from '../plan.ts'
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
  // 目标那一行（U90）：**顶格、无记号、不动色**——层次由缩进给（步骤退一级），
  // 颜色留给状态那条语义（「颜色只表语义」，见 `PALETTE` 那一处的口径）。
  if (row.kind === 'goal') return h(Text, null, row.text)

  if (row.kind !== 'step') {
    // 溢出提示与「已收起」那一行：**最弱的那一档色**——它们是把手，不是内容
    return h(Text, { color: PALETTE.faint }, row.text)
  }

  const style = planStyleOf(row.status, now === null ? 1 : breathOf(now))

  // 步骤**退一级**（`PLAN_INDENT`）：首行与续行都先让出这一级，文字左边缘仍是一条线。
  //
  // ⚠️ 这一级**并进方块那一段**（不另起一个无样式的盒子）：已完成那一行整行压暗，
  //    若缩进那两格不吃 `dimColor`，屏上「整行压暗」就不是整行了（用例量的是**整行**）。
  //    空格有没有色与强度本来就看不出，并进去只是让这一行的格子**同一种面孔**。
  const mark = `${' '.repeat(PLAN_INDENT)}${row.head ? `${GLYPHS[row.status]} ` : ' '.repeat(MARK_WIDTH)}`

  return h(
    Text,
    null,
    h(Text, { color: style.glyph ?? undefined, dimColor: style.dim }, mark),
    h(Text, { bold: style.bold, dimColor: style.dim }, row.text),
  )
}
