/**
 * 审批提示（U09）——**闸门落到用户眼前**的那一屏。
 *
 * 呈现材料（`material`）与轻重（`weight`），三个答复键：`y` 批准 · `n` 拒绝 ·
 * `a` **总是允许**（批准 ＋ 记住，本会话同类不再问）。
 * 摩擦对准高危：`weight` 为重的框与标题取警示色（技术方案 · 权限：摩擦对准高危）。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { DecisionWeight } from '@magic/contracts'
import type { PendingDecision } from '../view.ts'
import { linesOf } from './lines.ts'

/** 「总是允许」的答复键——`components/app.ts` 的按键处理与屏上提示**取同一个常量**。 */
export const REMEMBER_KEY = 'a'

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
    // 键位**写在屏上**——用户不必记（「总是允许」是本屏新增的那一键，尤其要说清它管多久）
    h(Text, { dimColor: true }, hintOf(pending.weight)),
  )
}

/**
 * 答复键位提示——**「总是允许」只在轻的询问上给**。
 *
 * 重（必闸类）是**禁区**：任何规则不可放行，「总是允许」按了也不生效（技术方案 · 权限：
 * 优先级 必闸 ＞ 规则 ＞ 默认问）。给一个按不动的键比不给更坏——那时用户以为自己放权了，
 * 下一次照样被拦，而他会开始怀疑整个闸门。故重的那一屏**明说缘由**。
 */
function hintOf(weight: DecisionWeight): string {
  return weight === 'heavy'
    ? 'y 批准 · n 拒绝 ·（必闸类不可「总是允许」——每次都问）'
    : `y 批准 · n 拒绝 · ${REMEMBER_KEY} 总是允许（本会话同类不再问）`
}

function weightLabel(weight: DecisionWeight): string {
  return weight === 'heavy' ? '重' : '轻'
}
