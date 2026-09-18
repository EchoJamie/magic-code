/**
 * 裁决卡（缺陷轮 II 重画）——**不套框**：左竖线着色 ＋ 材料内联 ＋ 键位只出现一次。
 *
 * 规格（原型 · 场景 4–8）：
 * - **轻＝黄线 · 重＝红线**（摩擦对准高危）；
 * - **材料内联**——diff / 命令分解直接贴上来，不另套容器；
 * - **键位只出现一次**（在卡上）——接管态的输入框只报「等你的答复」，不重列；
 * - **必闸类不给 `a`**——**划掉**（`strikethrough`）而不是藏起来：让你看见「这里本该有它，但这件不给」；
 * - **多件逐件问**——件数报在卡的标题（`2 / 3`）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import type { PendingDecision } from '../view.ts'
import { PALETTE } from './lines.ts'

export type DecisionCardProps = {
  readonly pending: PendingDecision
}

export function DecisionCard({ pending }: DecisionCardProps) {
  const heavy = pending.weight === 'heavy'
  const accent = heavy ? PALETTE.danger : PALETTE.warn
  const bar = (line: string, color: string = PALETTE.fg, bold = false): ReactElement =>
    h(Text, { key: `l:${line}` }, h(Text, { color: accent }, '│ '), h(Text, { color, bold }, line))

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, marginTop: 1 },
    // 标题：工具 · 危险词（· 第几件）
    h(
      Text,
      null,
      h(Text, { color: accent }, '│ '),
      h(Text, { color: accent, bold: true }, pending.name),
      h(Text, { color: PALETTE.dim }, ` · ${heavy ? '不可逆' : '可逆'}`),
      pending.position === null
        ? null
        : h(Text, { color: PALETTE.dim }, ` · ${pending.position.index} / ${pending.position.total}`),
    ),
    // 材料内联（原样贴，不另套容器）
    ...pending.material.split('\n').map((line) => bar(line, PALETTE.dim)),
    // 键位——**只此一处**
    h(
      Text,
      { key: 'keys' },
      h(Text, { color: accent }, '│ '),
      keyHint('y', '批准'),
      keyHint('a', '本工作区总是允许', heavy),
      keyHint('n', '拒绝'),
    ),
  )
}

function keyHint(key: string, label: string, struck = false): ReactElement {
  return h(
    Text,
    { key: `k:${key}` },
    h(Text, { color: struck ? PALETTE.ghost : PALETTE.fg, bold: !struck, strikethrough: struck }, key),
    h(Text, { color: struck ? PALETTE.ghost : PALETTE.dim, strikethrough: struck }, ` ${label}　`),
  )
}
