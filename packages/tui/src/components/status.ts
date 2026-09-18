/**
 * 状态行（U09）——一屏的底栏：**此刻是什么状态、Ctrl+C 会怎样**。
 *
 * 忙碌位是键盘语义的依据（空闲退出 / 工作中中断）——所以它与提示始终同屏。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ShellStatus } from '../view.ts'
import { sessionLabel } from '../view.ts'

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
      sessionPart(status),
      modelPart(status),
      // 退避期间**必须出声**——不然界面一动不动，用户以为卡死了（技术方案 · 模型策略 · 错误分档）
      status.retry === null
        ? ''
        : h(
            Text,
            { color: 'yellow' },
            ` · 正在重试（第 ${status.retry.attempt} 次，${secondsLabel(status.retry.delayMs)}后）`,
          ),
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

/**
 * 当前**会话**（U16）——标题可用就报标题，没有就报 id 前 8 位。
 *
 * 取的是**内核报的**（`session.state.active`），不是用户命令的自我报告：
 * 忙时切不动，拿意图当状态会显示一条并没在用的会话。
 * id 截断只为省屏幕——全 id 在 `/session` 的目录里看得到。
 */
function sessionPart(status: ShellStatus): string {
  const session = status.session
  if (session === null) return ''

  return ` · 会话 ${sessionLabel(session.title, session.id)}`
}

/**
 * 当前**供应商 / 模型**（技术方案 · 领域划分 ·「运行时切换」：外壳给一条斜杠命令 ＋
 * 状态行显示当前供应商）。
 *
 * 供应商可能缺（产生方没报）——那时只显示模型名，**不编一个出来**。
 * 值是**真跑过的那次调用**报的（`model.call.start`），不是用户命令的自我报告。
 */
function modelPart(status: ShellStatus): string {
  if (status.model === null) return ''

  return status.provider === null ? ` · 模型 ${status.model}` : ` · 模型 ${status.provider}/${status.model}`
}

/** 退避时长按**人读的秒**报（「x 秒后」是屏幕上的话，不是日志里的毫秒）。 */
function secondsLabel(delayMs: number): string {
  return `${(delayMs / 1000).toFixed(1)} 秒`
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
