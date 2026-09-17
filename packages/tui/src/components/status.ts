/**
 * 状态行（U09）——一屏的底栏：**此刻是什么状态、Ctrl+C 会怎样**。
 *
 * 忙碌位是键盘语义的依据（空闲退出 / 工作中中断）——所以它与提示始终同屏。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ShellStatus } from '../view.ts'

export type StatusLineProps = {
  readonly status: ShellStatus
}

export function StatusLine({ status }: StatusLineProps) {
  const busy = status.phase === 'busy'

  return h(
    Box,
    { paddingX: 1 },
    h(
      Text,
      { dimColor: true },
      h(Text, { color: busy ? 'yellow' : 'green' }, busy ? '● 工作中' : '○ 空闲'),
      agentPart(status),
      status.model === null ? '' : ` · 模型 ${status.model}`,
      usagePart(status),
      turnPart(status),
      ` · Ctrl+C ${busy ? '中断' : '退出'}`,
    ),
  )
}

/** agent 只在非常态时出声（`waiting` 是默认态，占了位置没用）。 */
function agentPart(status: ShellStatus): string {
  if (status.agent === 'paused') return ' · 已暂停'
  if (status.agent === 'resumed') return ' · 已恢复'

  return ''
}

function usagePart(status: ShellStatus): string {
  const usage = status.usage
  return usage === null ? '' : ` · 用量 ${usage.inputTokens}→${usage.outputTokens}`
}

function turnPart(status: ShellStatus): string {
  const reason = status.turnEnd
  if (reason === null) return ''
  if (reason === 'settled') return ' · 上轮 正常收束'

  return reason === 'aborted' ? ' · 上轮 已中断' : ' · 上轮 出错'
}
