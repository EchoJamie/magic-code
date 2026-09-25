/**
 * 状态行（缺陷轮 II 重画）——**左下最后一行**：此刻是什么状态。
 *
 * 规格（原型 · 状态行规格）：
 * - **左半四格次序恒定**：① 状态（五态固定词，**量挂在状态后面**）· ② 会话 · ③ 模型 · ④ 用量；
 * - **右位独立**放本状态的键位提示——**出现 / 消失不推动左半**（两段排版，不是一个流）；
 * - **窄窗口从右往左省**：用量 → 模型 → 标题截断；**省了不改剩余字段的位置**；
 * - **一次性的事不进状态行**（「已切到 #2」去记录区当回执）。
 *
 * **全放行那一格**（U73）——挂在 ① 之后、② 之前，且**永不省**：
 *
 * - 它报的是**这一代**（命令行 `--allow-all` 起的那一代，见 `ShellStatus.allowAll`），
 *   不是窗口自己的 argv——挂上一条早就活着的那一代时，两处可以不一样。
 * - ⚠️ **它是常驻状态，不是回执**：设计按三分类把它归进「状态 ⇒ 常驻」，由头是一句话
 *   ——「**看不见的裸奔是最坏的一形**」。故两点：**不自己消失**（本文件里它没有钟），
 *   **不参与降级**（`degrade` 让的是 ②③④ 那几格，它跟 ① 一样在任何宽度下都在）。
 * - 省它等于把这一位从屏上抹掉——那一格就是它**在屏上的唯一痕迹**。
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

/**
 * 全放行那一格的字（U73）——**产品上就这三个字**。
 *
 * 用户敲的是 `--allow-all`，屏上报的是「全放行」（说法见 `设计/工具执行与权限`）。
 * 导出是为了让判据**锚在它上面**：改了它，用例会红，不会静默过期（同 `anchors.ts` 那条）。
 */
export const ALLOW_ALL_LABEL = '全放行'

export function StatusLine({ status, columns }: StatusLineProps) {
  // 全放行那一格——挂在 ① 之后、**不参与降级**（见文件头注）。不在全放行时它整格不存在。
  const fixed = status.allowAll ? [ALLOW_ALL_LABEL] : []
  const left = degrade(status, columns, status.hint, fixed)

  return h(
    Box,
    { paddingX: 1, justifyContent: 'space-between' },
    h(
      Text,
      null,
      h(Text, { color: stateColor(status.state) }, stateLabel(status.state)),
      // **量挂状态后面**（耗时 / 第几件 / 第几次）
      status.amount === null ? '' : h(Text, { color: stateColor(status.state) }, ` ${status.amount}`),
      // **全放行那一格**——`warn` 色：它与 ②③④ 那几格不是一类（那几格是**在报什么**，
      // 这一格是**在报此刻有多放得开**），故不吃 `faint`；也不必吃 `danger`（那不是出错）
      ...fixed.map((cell) => h(Text, { key: 'allow-all', color: PALETTE.warn }, `${SEP}${cell}`)),
      ...left.map((cell, index) =>
        h(Text, { key: `c:${index}`, color: PALETTE.faint }, `${SEP}${cell}`),
      ),
    ),
    // 右位——独立一栏；放不下就整段不出现（**不推动左半**）。
    // ⚠️ 算宽度时**带上 ① 与全放行那一格**：否则右位会以为自己放得下，把左半挤着折行
    h(Text, { color: PALETTE.ghost }, fitting(status.hint, columns, [...fixed, ...left])),
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
 * ① 状态**永不省**（它是视觉锚）；**全放行那一格同样永不省**（U73），故它**不在 `cells` 里**
 * ——`fixed` 是**不参与让位**的那一截（此刻只会有它一格），只在算宽度与截标题时占位。
 *
 * ⚠️ **让位的还是原来那三格**（②③④）：多一格**没有**把谁挤掉，也没有改「谁先让」的次序。
 */
function degrade(
  status: ShellStatus,
  columns: number,
  hint: string,
  fixed: readonly string[] = [],
): readonly string[] {
  const title = status.session ?? '新会话'
  const model = status.model
  const usage = status.usage

  const cells: readonly (string | null)[] = [
    title,
    model,
    // ④ 用量——`12.4k/200k`（分母拿不到就只报已用量；见 `usageLabel`）
    usageLabel(usage, status.window),
  ]

  // **不让位的那一截**占掉多少列——截标题的那一步要从预算里扣掉它
  const fixedWidth = fixed.reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  // 逐步省：先去用量，再去模型，最后截标题（每步算一次「连同右位放不放得下」）
  let kept = [...cells]
  if (!fits([...fixed, ...kept], columns, hint)) kept = [kept[0] ?? '', null, null]
  if (!fits([...fixed, ...kept], columns, hint)) {
    kept = [truncate(kept[0] ?? '', Math.max(4, columns - 20 - fixedWidth)), null, null]
  }

  return kept.filter((cell): cell is string => cell !== null && cell !== '')
}

/**
 * **右位那一串**（连同状态那格与两侧留白）大概要占多少列——左半那两处都按它让位。
 *
 * ⚠️ **短提示照旧走那个用惯了的预算（24）**：那条口径调过几轮（「从右往左省」那三条
 * 用例钉的就是它），别顺手动它。提示**比它还长**时（选择器那一屏就是——U61 起那一行
 * 多了 `← 退`）按它**实际**占的算：不然多出来的那几列是从**提示自己**身上扣的
 * ——它整段不出现，而设计要的是「左半那几格让位」（工单 U61：「别为它挤掉更要紧的」）。
 */
function rightCost(hint: string): number {
  return Math.max(24, displayWidth(hint) + 8)
}

/** 左段（含状态那格）连同右位放不放得下——粗算即可（留 2 列余量）。 */
function fits(cells: readonly (string | null)[], columns: number, hint: string): boolean {
  const width = cells
    .filter((cell): cell is string => cell !== null && cell !== '')
    .reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  return width + rightCost(hint) <= columns - 4
}

/** 右位放不下就整段不出现。 */
function fitting(hint: string, columns: number, left: readonly string[]): string {
  const used = left.reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  return used + rightCost(hint) <= columns - 2 ? hint : ''
}
