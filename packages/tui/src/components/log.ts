/**
 * 记录区（缺陷轮 II 重画）——**纯日志**：上带，只有会话内容与屏上痕迹，没有控件。
 *
 * 三条规矩（原型 · 组件规格 ＋ 交互逻辑）：
 * - **三类行各有其形**：会话内容（`›` 用户 · `⏺` 助手 · `▶` 工具）· 命令输出（dim 块）·
 *   命令回执（`·` 最弱）；
 * - **折叠**：思考与老工具调用默认折一行，`ctrl+o` 展开（`expanded`）；
 * - **视口是自己的账**：铺满窗口之后终端滚动历史没了，记录区只渲染**视口内的行**——
 *   故这里把行先摊成**显示行**（自己折行、自己数），再取末尾 `height` 行。
 *
 * `logLines` 是纯函数（行 → 显示行）——快照与用例直接拿它取景，不起 Ink。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { LogRow } from '../view.ts'
import { textOfLines } from '../view.ts'
import { PALETTE, charWidth, displayWidth, durationLabel, wrap } from './lines.ts'

/** 一行里的一段（同段一个颜色）。 */
export type Segment = {
  readonly text: string
  readonly color?: string
  readonly bold?: boolean
}

/** 一条**显示行**——已经折好、备好色段。 */
export type LogLine = {
  readonly key: string
  readonly segments: readonly Segment[]
  /** 整行背景（用户行：整行淡青）。 */
  readonly background?: string
}

const seg = (text: string, color?: string, bold?: boolean): Segment => ({ text, color, bold })

/** 缩进（工具的结果 / 状态行都缩进对齐名字）。 */
const INDENT = '  '

export type LogProps = {
  readonly rows: readonly LogRow[]
  readonly columns: number
  /** 记录区**可视行数**（铺满窗口算出来的）。 */
  readonly height: number
  readonly expanded: boolean
  /** 首条消息之前（还没有会话）——空态给引导语（原型 · 场景 1）。 */
  readonly empty: boolean
}

export function Log({ rows, columns, height, expanded, empty }: LogProps) {
  const lines = empty ? emptyStateLines() : logLines(rows, { columns, expanded })
  const visible = lines.slice(Math.max(0, lines.length - Math.max(0, height)))

  return h(
    Box,
    { flexDirection: 'column', paddingX: 1, flexGrow: 1, overflow: 'hidden' },
    ...visible.map((line, index) =>
      h(
        Text,
        { key: line.key, backgroundColor: line.background },
        ...line.segments.map((piece, at) =>
          h(
            Text,
            { key: `s:${at}`, color: piece.color, bold: piece.bold },
            piece.text,
          ),
        ),
        // 末行不留换行（Ink 自己管行距）
        index === visible.length - 1 ? '' : '\n',
      ),
    ),
  )
}

/** 空态（原型 · 场景 1）——**还没建立会话**时的引导语。 */
function emptyStateLines(): readonly LogLine[] {
  const hint = (text: string): LogLine => ({
    key: `e:${text}`,
    segments: [seg(text, PALETTE.dim)],
  })

  return [
    {
      key: 'empty:0',
      segments: [seg('交代一件事就开始。会话在', PALETTE.faint), seg('你按下第一次回车', PALETTE.faint, true), seg('时才建立。', PALETTE.faint)],
    },
    { key: 'empty:1', segments: [seg('', PALETTE.dim)] },
    hint('比如：'),
    hint('　· 看看这个工作区里有什么'),
    hint('　· 把 src/utils/date.ts 的时区处理改成本地时区'),
    {
      key: 'empty:3',
      segments: [
        seg('　· 上次那个 bug 修到哪了？', PALETTE.dim),
        seg('　（/session 接着上次）', PALETTE.faint),
      ],
    },
  ]
}

/** 记录行 → 显示行（纯函数：视口预算与快照取景都拿它）。 */
export function logLines(rows: readonly LogRow[], options: { readonly columns: number; readonly expanded: boolean }): readonly LogLine[] {
  return rows.flatMap((row, index) => rowLines(row, index, options))
}

function rowLines(
  row: LogRow,
  index: number,
  options: { readonly columns: number; readonly expanded: boolean },
): readonly LogLine[] {
  const { columns, expanded } = options

  switch (row.kind) {
    case 'user':
      // **整行淡青背景**（一眼看出「这句是我说的」）——正文原色、标记青
      return wrapSegments(
        [seg('› ', PALETTE.user, true), seg(row.text, PALETTE.fg)],
        columns,
        { key: `r:${index}`, background: USER_BG, hang: INDENT },
      )

    case 'assistant':
      return wrapSegments([seg('⏺ ', PALETTE.ok, true), seg(row.text, PALETTE.fg)], columns, {
        key: `r:${index}`,
        hang: INDENT,
      })

    case 'thinking': {
      const lines = textOfLines(row.text)
      const shown = expanded ? lines : [collapse(lines)]
      const head: Segment[] = expanded ? [] : [seg('（思考）', PALETTE.faint), seg(shown[0] ?? '', PALETTE.faint)]
      const body = expanded ? shown.map((line) => seg(line, PALETTE.faint)) : []

      return wrapSegments(expanded ? body : head, columns, {
        key: `r:${index}-t`,
        hang: expanded ? INDENT : '',
      })
    }

    case 'tool':
      return toolLines(row, index, columns, expanded)

    case 'output':
      return row.lines.flatMap((line, at) =>
        wrapSegments([seg(line, PALETTE.dim)], columns, { key: `r:${index}-o:${at}`, hang: '' }),
      )

    case 'toolgroup':
      // 收拢的组——`▶` 起头 ＋ 次数与名字（弱色；原型：`▶ 3 次工具调用（ls · read · grep）`）
      return wrapSegments(
        [
          seg('▶ ', PALETTE.tool, true),
          seg(`${row.names.length} 次工具调用`, PALETTE.faint, true),
          seg(`（${row.names.join(' · ')}）`, PALETTE.faint),
        ],
        columns,
        { key: `r:${index}-g`, hang: INDENT },
      )

    case 'receipt':
      return wrapSegments([seg('· ', PALETTE.ghost, true), seg(row.text, PALETTE.faint)], columns, {
        key: `r:${index}-x`,
        hang: INDENT,
      })
  }
}

/** 工具行——`▶`（跑起来换 `⟳` ＋ 耗时）＋ 名字上色加粗 ＋ 参数 dim；结果另起一行缩进。 */
function toolLines(
  row: Extract<LogRow, { kind: 'tool' }>,
  index: number,
  columns: number,
  expanded: boolean,
): readonly LogLine[] {
  const running = row.state === 'running'
  const marker = running ? '⟳ ' : '▶ '
  const markerColor = running ? PALETTE.warn : PALETTE.tool
  const name = row.name
  const args = row.argsText === '' ? '' : ` ${row.argsText}`

  const head = wrapSegments(
    [
      // 标记：跑起来是转圈 ＋ 警示色（「在跑」与「跑完」一眼可分）
      seg(marker, markerColor, true),
      seg(name, PALETTE.tool, true),
      seg(args, PALETTE.dim),
    ],
    columns,
    { key: `r:${index}-h`, hang: INDENT },
  )

  if (running) {
    return [...head, ...prefixLine(INDENT, `⟳ ${durationLabel(row.elapsedMs ?? 0)}`, PALETTE.warn, `r:${index}-run`)]
  }

  const verdict =
    row.state === 'rejected'
      ? { marker: '✗', color: PALETTE.danger, text: '未执行' }
      : row.state === 'failed'
        ? { marker: '✗', color: PALETTE.danger, text: '失败' }
        : { marker: '✓', color: PALETTE.ok, text: summaryOf(row.output) }

  const meta = [
    seg(`${INDENT}${verdict.marker} `, verdict.color, true),
    seg(row.elapsedMs === null ? verdict.text : `${durationLabel(row.elapsedMs)} · ${verdict.text}`, PALETTE.faint),
  ]

  // 结果行：dim 缩进块（展开时才出；折叠时只留标题与状态行——「老工具调用折一行」）
  const body = expanded
    ? row.output.flatMap((line, at) =>
        prefixLine(`${INDENT}${INDENT}`, line, PALETTE.dim, `r:${index}-out:${at}`),
      )
    : []

  return [...head, ...wrapSegments(meta, columns, { key: `r:${index}-m`, hang: '' }), ...body]
}

/** 结果行的摘要（`14 项` 那类）——取结果最后一条非空行，截短。 */
function summaryOf(output: readonly string[]): string {
  const last = [...output].reverse().find((line) => line.trim() !== '')

  return last === undefined ? '完成' : truncateLine(last, 48)
}

function truncateLine(text: string, width: number): string {
  const clean = text.trim()
  return displayWidth(clean) <= width ? clean : `${clean.slice(0, width)}…`
}

/** 一行片段 → 折好的显示行（续行按 `hang` 缩进）。 */
function wrapSegments(
  segments: readonly Segment[],
  columns: number,
  options: { readonly key: string; readonly background?: string; readonly hang: string },
): readonly LogLine[] {
  const text = segments.map((piece) => piece.text).join('')
  const wrapped = wrap(text, Math.max(8, columns - 2))
  const lines: LogLine[] = []

  for (const [at, line] of wrapped.entries()) {
    if (at === 0) {
      lines.push({
        key: `${options.key}:0`,
        segments: firstLine(segments, Math.max(8, columns - 2)),
        background: options.background,
      })
      continue
    }

    // 续行：原色段丢掉（着色只在首行），按 hang 缩进
    lines.push({
      key: `${options.key}:${at}`,
      segments: [seg(`${options.hang}${line}`, PALETTE.dim)],
      background: options.background,
    })
  }

  return lines
}

/**
 * 首行的色段——把原段**按宽度切**到首行长度为止（着色只在首行，续行走 dim ＋ 缩进）。
 */
function firstLine(segments: readonly Segment[], width: number): readonly Segment[] {
  const out: Segment[] = []
  let left = width

  for (const piece of segments) {
    if (left <= 0) break

    let kept = ''
    let used = 0
    for (const char of piece.text) {
      const size = charWidth(char)
      if (used + size > left) break
      kept += char
      used += size
    }

    if (kept !== '') out.push({ ...piece, text: kept })
    left -= used
  }

  return out
}

/** 缩进 ＋ 单色一行。 */
function prefixLine(
  indent: string,
  text: string,
  color: string,
  key: string,
): readonly LogLine[] {
  return [{ key, segments: [seg(`${indent}${text}`, color)] }]
}

/** 用户行背景——淡青（原型 `--userbg` 在深底上的实色近似）。 */
const USER_BG = '#131d23'

/** 折叠一行：取首个非空行，太长的截断。 */
function collapse(lines: readonly string[]): string {
  const first = lines.find((line) => line.trim() !== '') ?? ''

  return truncateLine(first, 60)
}
