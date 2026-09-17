/**
 * 对话流（U09）——一屏的主体：交代 / 助手 / 思考 / 工具调用链 / 错误行。
 *
 * **骨架版**：够看清「Agent 干了什么」；diff 视图 · 结构化结果 · 表格归 U20。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { OutputChannel } from '@magic/contracts'
import type { ToolOutcome, TranscriptItem } from '../view.ts'
import { durationLabel, linesOf } from './lines.ts'

export type TranscriptProps = {
  readonly items: readonly TranscriptItem[]
}

export function Transcript({ items }: TranscriptProps) {
  if (items.length === 0) return h(EmptyState)

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    ...items.map((item) => h(Row, { key: item.key, item })),
  )
}

/** 空屏——启动即可用：给一句自然语言的例子（交互词汇：自然语言优先、固定命令精简）。 */
function EmptyState() {
  return h(
    Box,
    { flexDirection: 'column', paddingX: 1 },
    h(Text, { dimColor: true }, '还没有对话。'),
    h(Text, { dimColor: true }, '交代一件事，比如「看看工作区里有什么」。'),
  )
}

type RowProps = { readonly item: TranscriptItem }

function Row({ item }: RowProps) {
  switch (item.kind) {
    case 'user':
      return h(
        Box,
        { flexDirection: 'column' },
        h(Text, null, h(Text, { color: 'cyan' }, '› '), item.text),
      )

    case 'assistant':
      return h(Text, null, item.text)

    case 'thinking':
      return h(Text, { dimColor: true }, `（思考）${item.text}`)

    case 'notice':
      return h(
        Text,
        { color: item.tone === 'error' ? 'red' : undefined, dimColor: item.tone !== 'error' },
        `！${item.text}`,
      )

    case 'tool':
      return h(
        Box,
        { flexDirection: 'column' },
        h(
          Text,
          null,
          h(Text, { color: 'magenta' }, '▸ 工具 '),
          h(Text, { bold: true }, item.name),
          h(Text, { dimColor: true }, ` ${item.argsText}`),
        ),
        ...streamRows(item.output),
        resultRow(item.result, item.output.length > 0),
        item.verdict === null
          ? null
          : h(
              Text,
              { dimColor: true },
              `   · 裁决：${verdictLabel(item.verdict.decision)}（${item.verdict.decider}，${durationLabel(item.verdict.elapsedMs)}）`,
            ),
      )
  }
}

/** 执行输出的两路流——`stdout` / `stderr` 各自累积，逐行呈现。 */
function streamRows(output: Extract<TranscriptItem, { kind: 'tool' }>['output']) {
  return output.flatMap((stream) =>
    linesOf(stream.text).map((line, index) =>
      h(
        Text,
        { key: `${stream.channel}:${index}`, color: stream.channel === 'stderr' ? 'red' : undefined },
        `   ${channelLabel(stream.channel)} › ${line}`,
      ),
    ),
  )
}

/**
 * 结果行——流式输出已呈现过就不再回显正文（免得同一段输出看两遍）；
 * 大负载只留引用（**外壳不解析 blob**——记录域的事）。
 */
function resultRow(result: ToolOutcome | null, streamed: boolean) {
  if (result === null) return null

  const head = h(
    Text,
    { color: result.ok ? 'green' : 'red', key: 'result' },
    `   ${result.ok ? '✓ 完成' : '✗ 失败'}`,
  )

  if (result.blob) {
    return h(Text, { dimColor: true }, head, `　（输出转存 blob：${result.output}）`)
  }

  if (streamed) return head

  return h(
    Box,
    { flexDirection: 'column' },
    head,
    ...linesOf(result.output).map((line, index) => h(Text, { key: `out:${index}` }, `   ${line}`)),
  )
}

function channelLabel(channel: OutputChannel): string {
  return channel === 'stderr' ? 'stderr' : 'stdout'
}

function verdictLabel(decision: 'approve' | 'reject'): string {
  return decision === 'approve' ? '批准' : '拒绝'
}
