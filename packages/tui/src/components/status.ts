/**
 * 状态行（缺陷轮 II 重画 · **U112 起可配**）——**左下最后一行**：此刻是什么状态。
 *
 * 规格（设计 · 终端交互「状态行可配置：给一列可选项，不给脚本」＋ 既有那几条）：
 *
 * - **锚那两格次序恒定、永不省**：① **状态**（五态固定词，**量挂在状态后面**）·
 *   ② **全放行**（只在全放行时存在——「看不见的裸奔是最坏的一形」）；
 * - **锚之后那几格由用户挑**（挑哪几格、什么顺序）——顺序即屏上顺序，**也是让位的次序**
 *   （窄窗从右往左省：用户摆在前面的先保）；
 * - **某项当时不可用就整格省掉**（不占位、不显示空值）；
 * - **右位独立**放本状态的键位提示——**出现 / 消失不推动左半**（两段排版，不是一个流）；
 * - **一次性的事不进状态行**（「已切到 #2」去记录区当回执）。
 *
 * ## U112 改了三处
 *
 * ① **状态那一格分形状**（设计：「必须分形状，不能只靠颜色」）：工作中 `●`、在等你 `◊`
 *    ——无色终端里也能一眼分出「在忙」与「需要你」（`view.ts` 的 `stateMark`）；
 * ② **动效只挂状态位**：工作中那一位**呼吸**（复用既有按需 200ms 的钟）；**「在等你」只在
 *    出现时脉冲一次**（设计：「动效用来说明『正在发生』，不用来证明『还活着』」）——
 *    故它平时**定住**，只有那一下亮起来；
 * ③ **可配**：挑哪几格、什么顺序、上不上色（见 `StatusLineProps`）。
 *
 * ## 全放行那一格（U73 · 本单不改）
 *
 * - 它报的是**这一代**（命令行 `--allow-all` 起的那一代，见 `ShellStatus.allowAll`），
 *   不是窗口自己的 argv——挂上一条早就活着的那一代时，两处可以不一样。
 * - ⚠️ **它是常驻状态，不是回执**：不自己消失、**不参与降级**、**也不在可挑的那一列里**
 *   （省它等于把这一位从屏上抹掉——那一格就是它**在屏上的唯一痕迹**）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { StatusLineCell } from '@magic/contracts'
import { breathColor, breathOf, pulseOf } from '../motion.ts'
import type { ShellStatus } from '../view.ts'
import { stateMark, stateText } from '../view.ts'
import { MARKS } from '../marks.ts'
import { PALETTE, displayWidth, truncate, usageLabel } from './lines.ts'

export type StatusLineProps = {
  readonly status: ShellStatus
  /** 终端列数——降级按它算。 */
  readonly columns: number
  /**
   * **锚之后要摆哪几格**（顺序即屏上顺序）——由 `AppView` 从视图那份配置取
   * （`statusLineCellsOf`）。**空数组是合法的**（只要锚那两格）。
   */
  readonly cells: readonly StatusLineCell[]
  /** **上色开关**——关掉时整行不吃色（交给终端的前景色）。 */
  readonly color: boolean
  /** 「工作区」那一格的字；`null` ＝ 不知道 ⇒ 那一格整格省掉。 */
  readonly workspace: string | null
  /**
   * **「在等你」那一次脉冲的起算时刻**（毫秒）——`null` ＝ 不动。
   *
   * 由活壳给（`TuiApp` 在状态切到 `waiting` 那一刻记下）。**减少动效时给 `null`**
   * ——停转动与亮度变化那一条就落在这一格上（渲染层不必再判一次）。
   */
  readonly pulseAt?: number | null
  /**
   * **此刻**（毫秒）——呼吸与脉冲靠它算亮度。缺省 `null` ＝**没有钟**：那时画**原色**
   * （不编一个亮度出来），取景与快照因此是确定的（同 `LogRowProps.now` 那条）。
   */
  readonly now?: number | null
}

/**
 * 分隔点——**从 `MARKS` 取**（一处出处）。它**只做分隔符**、不做任何一行的身份
 * （2026-10-01 那条「同一个字形不许兼两个角色」，见 `marks.ts`）。
 */
const SEP = ` ${MARKS.sep} `

/**
 * 全放行那一格的字（U73）——**产品上就这三个字**。
 *
 * 用户敲的是 `--allow-all`，屏上报的是「全放行」（说法见 `设计/工具执行与权限`）。
 * 导出是为了让判据**锚在它上面**：改了它，用例会红，不会静默过期（同 `anchors.ts` 那条）。
 */
export const ALLOW_ALL_LABEL = '全放行'

export function StatusLine({
  status,
  columns,
  cells,
  color,
  workspace,
  pulseAt = null,
  now = null,
}: StatusLineProps) {
  // **上色开关**那一处出口——关掉时不传色（`undefined` ＝ 继承终端前景色）。
  const tint = (value: string | undefined): string | undefined => (color ? value : undefined)

  // 全放行那一格——挂在 ① 之后、**不参与降级**（见文件头注）。不在全放行时它整格不存在。
  const fixed = status.allowAll ? [ALLOW_ALL_LABEL] : []
  const left = degrade(cellTexts(status, cells, workspace), columns, status.hint, fixed)

  return h(
    Box,
    { paddingX: 1, justifyContent: 'space-between' },
    h(
      Text,
      null,
      // ① **状态**——形状 ＋ 词 ＋ 量（**量挂状态后面**）。它**永不省**（视觉锚）。
      h(Text, { color: tint(stateColor(status, now, pulseAt)) }, stateMark(status.state)),
      h(Text, { color: tint(stateColor(status, null, null)) }, ` ${stateText(status.state)}`),
      status.amount === null ? '' : h(Text, { color: tint(stateColor(status, null, null)) }, ` ${status.amount}`),
      // ② **全放行**——`warn` 色：它与那几格不是一类（那几格是**在报什么**，这一格是
      // **在报此刻有多放得开**），故不吃 `faint`；也不必吃 `danger`（那不是出错）
      ...fixed.map((cell) => h(Text, { key: 'allow-all', color: tint(PALETTE.warn) }, `${SEP}${cell}`)),
      ...left.map((cell, index) => h(Text, { key: `c:${index}`, color: tint(PALETTE.faint) }, `${SEP}${cell}`)),
    ),
    // 右位——独立一栏；放不下就整段不出现（**不推动左半**）。
    // ⚠️ 算宽度时**带上 ① 与全放行那一格**：否则右位会以为自己放得下，把左半挤着折行
    h(Text, { color: tint(PALETTE.ghost) }, fitting(status.hint, columns, [...fixed, ...left])),
  )
}

/**
 * **状态那一格的颜色**——U112 起它多管两件：**呼吸**（工作中）与**脉冲**（等你那一次）。
 *
 * - `now === null`（没钟 / 减少动效）⇒ **原色**：一动不动（设计那三条的③）；
 * - 工作中 / 正在重试 ⇒ **呼吸**（一轮两秒，复用 `motion.ts` 那一支）；
 * - 在等你 ⇒ **脉冲一次**：从暗端单调升到原色，走完定住（不持续、不闪烁）。
 *   要的是「它到了，现在轮到你了」那一下。
 */
function stateColor(status: ShellStatus, now: number | null, pulseAt: number | null): string {
  const base = baseColor(status.state)

  if (now === null) return base
  if (status.state === 'waiting') return pulseAt === null ? base : breathColor(PALETTE.warn, pulseOf(pulseAt, now))
  if (status.state === 'working' || status.state === 'retrying') return breathColor(base, breathOf(now))

  return base
}

function baseColor(state: ShellStatus['state']): string {
  if (state === 'idle') return PALETTE.ok
  if (state === 'error') return PALETTE.danger
  // **失联**（U100）——不是出错（没有哪一步错了），也不是「在忙」：那一格是**放弃判断**，
  // 故取最弱的那一档色（它该说的是「这边不知道」，不是「快看我」）
  if (state === 'lost') return PALETTE.faint

  return PALETTE.warn
}

/**
 * **那几格此刻各自的字**——**拿不到就不给**（`null`，那一格**整格省掉**：不占位、
 * 不显示空值。设计明写）。
 *
 * 逐格说：
 * - **会话名**——总有（还没有会话时写「新会话」，与 `/resume` 那一屏同一个说法）；
 * - **模型**——还没跑过任何一次调用就**省掉**（不写「未知」，那是编一个词）；
 * - **思考档**——壳没报就省掉（见 `ShellStatus.reasoning`）；
 * - **上下文占用**——还没有用量读数就省掉（`usageLabel` 给 `null`——它只管有分母才写分母）；
 * - **工作区**——不知道自己在哪儿就省掉。
 */
function cellTexts(
  status: ShellStatus,
  cells: readonly StatusLineCell[],
  workspace: string | null,
): readonly string[] {
  return cells
    .map((cell) => {
      if (cell === 'session') return status.session ?? '新会话'
      if (cell === 'model') return status.model
      if (cell === 'reasoning') return status.reasoning
      if (cell === 'workspace') return workspace

      return usageLabel(status.usage, status.window)
    })
    .filter((text): text is string => text !== null && text !== '')
}

/**
 * 那几格的裁剪（窄窗口**从右往左省**）——**省了不改剩余字段的位置**：省的是整格，剩下的
 * 格子仍在原来的次序上。
 *
 * ① 状态**永不省**（它是视觉锚）；**全放行那一格同样永不省**（U73），故它**不在 `cells` 里**
 * ——`fixed` 是**不参与让位**的那一截（此刻只会有它一格），只在算宽度与截标题时占位。
 *
 * ⚠️ **让位的次序就是用户摆的次序**（U112）：挑格那一屏上排在前面的先保，排在后面的先让。
 * 一格格摘，摘到只剩一格还放不下就**截它**（`truncate`）。这一条把旧那三条
 * （「用量 → 模型 → 标题截断」）**收进一个通则里**：默认那条是「会话名 · 上下文占用」，
 * 于是一个先让、另一个后截——与旧写法逐字同效。
 */
function degrade(
  cells: readonly string[],
  columns: number,
  hint: string,
  fixed: readonly string[] = [],
): readonly string[] {
  if (cells.length === 0) return []

  // **不让位的那一截**占掉多少列——截最后那一格时要从预算里扣掉它
  const fixedWidth = fixed.reduce((sum, cell) => sum + displayWidth(cell) + SEP.length, 0)

  // 逐步省：先摘末尾那几格；只剩一格还放不下就截它
  let kept = [...cells]
  while (kept.length > 1 && !fits([...fixed, ...kept], columns, hint)) kept = kept.slice(0, -1)

  const last = kept[0] ?? ''
  if (!fits([...fixed, ...[last]], columns, hint)) {
    kept = [truncate(last, Math.max(4, columns - 20 - fixedWidth))]
  }

  return kept.filter((cell) => cell !== '')
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
