/**
 * 记录区（缺陷轮 III）——**内联渲染**下的纯日志。
 *
 * 三条规矩（原型 · 组件规格 ＋ 密度节）：
 * - **三类行各有其形**：会话内容（`›` 用户 · `⏺` 助手 · `●` 工具）· 命令输出（dim 块）·
 *   命令回执（`·` 最弱）；
 * - **密度**：条目之间**不插空行**（分层靠标记 / 缩进 / 明暗）；**只有用户消息之前**留一行分段；
 *   **空内容不渲染**（缺陷 D6 的外壳侧双保险）；工具结果与工具行同组缩进；思考默认折一行；
 * - **一行一个 `<Text>`、行内不写换行**——⚠️ 这正是 **D11 的根因**：
 *   早先每行 `<Text>` 里又写了一个 `'\n'`，而 Ink 的竖排 Box **本来就一个子节点一行**
 *   ⇒ 每行实际占两行 ⇒ Ink 以为的帧高只有实际的一半 ⇒ 重绘「上移 N 行」擦不干净
 *   ⇒ 旧行留在屏上、新行又画一遍（同一段出现两遍）。**换行归 Box。**
 *
 * `rowLines` 是纯函数（一条行 → 显示行）——快照与用例直接拿它取景，不起 Ink。
 */

import { Text } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
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
  /** **分段行**（用户消息之前那一行，原型 · 密度）——渲染成空行。 */
  readonly spacer?: boolean
}

const seg = (text: string, color?: string, bold?: boolean): Segment => ({ text, color, bold })

/** 缩进（工具结果与工具行同组，缩进一行）。 */
const INDENT = '  '

/** 用户行背景——淡青（原型 `--userbg` 在深底上的实色近似）。 */
const USER_BG = '#131d23'

export type LogRowProps = {
  readonly row: LogRow
  readonly columns: number
  readonly expanded: boolean
  /** 这条行之前留不留一行分段（用户消息之前＝留）。 */
  readonly spaced: boolean
}

/**
 * 一条记录行 → 一屏上的若干行。
 *
 * ⚠️ **每条显示行各是一个 `<Text>`、行内不写 `'\n'`**——见文件头注（D11 的根因与修法）。
 */
export function LogRowView({ row, columns, expanded, spaced }: LogRowProps): ReactElement {
  const lines = rowLines(row, { columns, expanded, spaced })

  return h(
    'ink-box',
    { key: `row:${row.key}`, style: { flexDirection: 'column' } },
    ...lines.map((line) =>
      h(
        Text,
        { key: line.key, backgroundColor: line.background },
        ...(line.spacer === true
          ? ['']
          : line.segments.map((piece, at) =>
              h(Text, { key: `s:${at}`, color: piece.color, bold: piece.bold }, piece.text),
            )),
      ),
    ),
  )
}

/**
 * 记录行 → 显示行（纯函数）。
 * `spaced` ＝ 这条之前留一行分段（**只有用户消息之前**——原型 · 密度）。
 */
export function rowLines(
  row: LogRow,
  options: { readonly columns: number; readonly expanded: boolean; readonly spaced?: boolean },
): readonly LogLine[] {
  const body = rowBody(row, options)

  return options.spaced === true ? [{ key: 'spacer', segments: [], spacer: true }, ...body] : body
}

/** 一屏上的**全部**显示行（含分段）——快照取景与行数预算用。 */
export function logLines(
  rows: readonly LogRow[],
  options: { readonly columns: number; readonly expanded: boolean },
): readonly LogLine[] {
  return rows.flatMap((row, index) => rowLines(row, { ...options, spaced: needsSpacer(rows, index) }))
}

/** 用户消息之前留一行分段；首条不必（顶上没有东西要分隔）。 */
export function needsSpacer(rows: readonly LogRow[], index: number): boolean {
  return index > 0 && rows[index]?.kind === 'user'
}

function rowBody(
  row: LogRow,
  options: { readonly columns: number; readonly expanded: boolean },
): readonly LogLine[] {
  const { columns, expanded } = options

  switch (row.kind) {
    case 'user':
      // **整行淡青背景**（一眼看出「这句是我说的」）——正文原色、标记青
      return wrapSegments([seg('› ', PALETTE.user, true), seg(row.text, PALETTE.fg)], columns, {
        key: 'r:u',
        background: USER_BG,
        hang: INDENT,
      })

    case 'assistant':
      // **空内容不渲染**（D6 的外壳侧双保险）——模型只发工具调用、不吐正文的那一轮
      if (row.text.trim() === '') return []
      return wrapSegments([seg('⏺ ', PALETTE.ok, true), seg(row.text, PALETTE.fg)], columns, {
        key: 'r:a',
        hang: INDENT,
      })

    case 'thinking': {
      const lines = textOfLines(row.text).filter((line) => line.trim() !== '')
      if (lines.length === 0) return [] // 空思考不渲染

      if (expanded) {
        return lines.flatMap((line, at) =>
          wrapSegments([seg(at === 0 ? '（思考）' : '', PALETTE.faint), seg(line, PALETTE.faint)], columns, {
            key: `r:t:${at}`,
            hang: INDENT,
          }),
        )
      }

      return wrapSegments([seg('（思考）', PALETTE.faint), seg(collapse(lines), PALETTE.faint)], columns, {
        key: 'r:t',
        hang: INDENT,
      })
    }

    case 'tool':
      return toolLines(row, columns, expanded)

    case 'toolgroup':
      // 收拢的组——`●` 起头 ＋ 次数与名字（原型 · 场景 13）
      return wrapSegments(
        [
          seg('● ', PALETTE.ghost),
          seg(`${row.names.length} 次工具调用`, PALETTE.faint, true),
          seg(`（${row.names.join(' · ')}）`, PALETTE.faint),
        ],
        columns,
        { key: 'r:g', hang: INDENT },
      )

    case 'output':
      return row.lines
        .filter((line) => line.trim() !== '')
        .flatMap((line, at) =>
          wrapSegments([seg(line, PALETTE.dim)], columns, { key: `r:o:${at}`, hang: '' }),
        )

    case 'receipt':
      return wrapSegments([seg('· ', PALETTE.ghost, true), seg(row.text, PALETTE.faint)], columns, {
        key: 'r:x',
        hang: INDENT,
      })
  }
}

/**
 * 工具行——`●`（**与助手同族 · 只换颜色 · 视觉重量比助手轻**：不加粗不放大——工具是过程，
 * 不该比 Agent 的话更抢眼）＋ 工具名上色 ＋ 参数 dim；跑起来换 `⟳` ＋ 耗时；
 * 结果**同组缩进一行**。
 */
function toolLines(
  row: Extract<LogRow, { kind: 'tool' }>,
  columns: number,
  expanded: boolean,
): readonly LogLine[] {
  const running = row.state === 'running'
  const marker = running ? '⟳ ' : '● '
  const markerColor = running ? PALETTE.warn : PALETTE.tool
  const args = row.argsText === '' ? '' : ` ${row.argsText}`

  const head = wrapSegments(
    [seg(marker, markerColor), seg(row.name, PALETTE.tool), seg(args, PALETTE.dim)],
    columns,
    { key: 'r:h', hang: INDENT },
  )

  if (running) {
    return [...head, ...prefixLine(INDENT, `⟳ ${durationLabel(row.elapsedMs ?? 0)}`, PALETTE.warn, 'r:run')]
  }

  const verdict =
    row.state === 'rejected'
      ? { marker: '✗', color: PALETTE.danger, text: '未执行' }
      : row.state === 'failed'
        ? { marker: '✗', color: PALETTE.danger, text: '失败' }
        : { marker: '✓', color: PALETTE.ok, text: summaryOf(row.output) }

  const meta = [
    seg(`${INDENT}${verdict.marker} `, verdict.color, true),
    seg(
      row.elapsedMs === null ? verdict.text : `${durationLabel(row.elapsedMs)} · ${verdict.text}`,
      PALETTE.faint,
    ),
  ]

  // 结果行：dim 缩进块（展开时才出；折叠时只留标题与状态行——「老工具调用折一行」）
  const body = expanded
    ? row.output
        .filter((line) => line.trim() !== '')
        .flatMap((line, at) => prefixLine(`${INDENT}${INDENT}`, line, PALETTE.dim, `r:out:${at}`))
    : []

  return [...head, ...wrapSegments(meta, columns, { key: 'r:m', hang: '' }), ...body]
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
  const width = Math.max(8, columns - 2)

  return wrap(text, width).map((line, at) =>
    at === 0
      ? { key: `${options.key}:0`, segments: firstLine(segments, width), background: options.background }
      : {
          // 续行：着色只在首行，续行按 `hang` 缩进
          key: `${options.key}:${at}`,
          segments: [seg(`${options.hang}${line}`, PALETTE.dim)],
          background: options.background,
        },
  )
}

/** 首行的色段——把原段**按宽度切**到首行长度为止。 */
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
function prefixLine(indent: string, text: string, color: string, key: string): readonly LogLine[] {
  return [{ key, segments: [seg(`${indent}${text}`, color)] }]
}

/** 折叠一行：取首个非空行，太长的截断。 */
function collapse(lines: readonly string[]): string {
  return truncateLine(lines[0] ?? '', 60)
}
