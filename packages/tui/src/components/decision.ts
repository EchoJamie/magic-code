/**
 * 审批提示（U09）——**闸门落到用户眼前**的那一屏。
 *
 * 呈现材料（`material`）与轻重（`weight`），两个答复键：`y` 批准 · `n` 拒绝。
 * 摩擦对准高危：`weight` 为重的框与标题取警示色（技术方案 · 权限：摩擦对准高危）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { DecisionWeight } from '@magic/contracts'
import type { PendingDecision } from '../view.ts'
import { linesOf } from './lines.ts'

export type DecisionPromptProps = {
  readonly pending: PendingDecision
}

export function DecisionPrompt({ pending }: DecisionPromptProps) {
  const heavy = pending.weight === 'heavy'
  const accent = heavy ? 'red' : 'yellow'

  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: accent, paddingX: 1, marginX: 1 },
    h(
      Text,
      { color: accent, bold: true },
      `需要裁决 · ${weightLabel(pending.weight)} · ${pending.name}`,
    ),
    ...linesOf(pending.material).map((line, index) => h(Text, { key: `m:${index}` }, line)),
    h(Text, { dimColor: true }, 'y 批准 · n 拒绝'),
  )
}

function weightLabel(weight: DecisionWeight): string {
  return weight === 'heavy' ? '重' : '轻'
}
