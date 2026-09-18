/**
 * 状态行（缺陷轮 II 重画）——**左下最后一行**：此刻是什么状态。
 *
 * 规格（原型 · 状态行规格）：
 * - **左半四格次序恒定**：① 状态（五态固定词，**量挂在状态后面**）· ② 会话 · ③ 模型 · ④ 用量；
 * - **右位独立**放本状态的键位提示——**出现 / 消失不推动左半**（两段排版，不是一个流）；
 * - **窄窗口从右往左省**：用量 → 模型 → 标题截断；**省了不改剩余字段的位置**；
 * - **一次性的事不进状态行**（「已切到 #2」去记录区当回执）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ShellStatus } from '../view.ts'
import { stateLabel } from '../view.ts'
import { PALETTE, displayWidth, truncate, usageLabel } from './lines.ts'

export type StatusLineProps = {
  readonly status: ShellStatus
  /** 终端列数——降级按它算。 */
  readonly columns: number
}

/** 分隔点（`·`）——最弱色，只是分栏，不是内容。 */
const SEP = ' · '

export function StatusLine({ status, columns }: StatusLineProps) {
  const left = degrade(status, columns)

  return h(
    Box,
    { paddingX: 1, justifyContent: 'space-between' },
    h(
      Text,
      null,
      h(Text, { color: stateColor(status.state) }, stateLabel(status.state)),
      // **量挂状态后面**（耗时 / 第几件 / 第几次）
      status.amount === null ? '' : h(Text, { color: stateColor(status.state) }, ` ${status.amount}`),
      ...left.map((cell, index) =>
        h(Text, { key: `c:${index}`, color: PALETTE.faint }, `${SEP}${cell}`),
      ),
    ),
    // 右位——独立一栏；放不下就整段不出现（**不推动左半**）
    h(Text, { color: PALETTE.ghost }, fitting(status.hint, columns, left)),
  )
}

function stateColor(state: ShellStatus['state']): string {
  if (state === 'idle') return PALETTE.ok
  if (state === 'error') return PALETTE.danger

  return PALETTE.warn
}

/**
 * 四格的裁剪（窄窗口从右往左省）——**省了不改剩余字段的位置**：
 * 省的是整格，剩下的格子仍在原来的次序上，只是「用量 → 模型 → 标题截断」依次让位。
 *
 * ① 状态**永不省**（它是视觉锚）。
 */
function degrade(status: ShellStatus, columns: number): readonly string[] {
  const title = status.session ?? '新会话'
  const model = status.model
  const usage = status.usage

  const cells: readonly (string | null)[] = [
    title,
    model,
    // ④ 用量——`12.4k/200k`（分母拿不到就只报已用量；见 `usageLabel`）
    usageLabel(usage, status.window),
  ]

  // 逐步省：先去用量，再去模型，最后截标题（每步算一次「连同右位放不放得下」）
  let kept = [...cells]
  if (!fits(kept, columns)) kept = [kept[0] ?? '', null, null]
  if (!fits(kept, columns)) kept = [truncate(kept[0] ?? '', Math.max(4, columns - 20)), null, null]

  return kept.filter((cell): cell is string => cell !== null && cell !== '')
}

/** 左段（含状态那格）连同右位放不放得下——粗算即可（留 2 列余量）。 */
function fits(cells: readonly (string | null)[], columns: number): boolean {
  const width = cells
    .filter((cell): cell is string => cell !== null && cell !== '')
    .reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  return width + 24 <= columns - 4
}

/** 右位放不下就整段不出现。 */
function fitting(hint: string, columns: number, left: readonly string[]): string {
  const used = left.reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  return displayWidth(hint) + used + 8 <= columns - 2 ? hint : ''
}
