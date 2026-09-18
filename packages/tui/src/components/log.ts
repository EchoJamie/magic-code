/**
 * 记录区（缺陷轮 III）——**内联渲染**下的纯日志。
 *
 * 三条规矩（原型 · 组件规格 ＋ 密度节）：
 * - **三类行各有其形**：会话内容（`›` 用户 · `⏺` 助手 · `●` 工具）· 命令输出（dim 块）·
 *   命令回执（`·` 最弱）；
 * - **密度**：条目之间**不插空行**（分层靠标记 / 缩进 / 明暗）；**只有用户消息之前**留一行分段；
 *   **空内容不渲染**（缺陷 D6 的外壳侧双保险）；工具结果与工具行同组缩进；思考默认折一行；
 * - **助手正文走 Markdown**（缺陷 D14）——五样（粗体 · 行内代码 · 代码块 · 列表 · 标题）在
 *   `../markdown.ts` 里解析成显示行，本文件只负责折行与挂缩进（换皮不动解析）；
 * - **一行一个 `<Text>`、行内不写换行**——⚠️ 这正是 **D11 的根因**：
 *   早先每行 `<Text>` 里又写了一个 `'\n'`，而 Ink 的竖排 Box **本来就一个子节点一行**
 *   ⇒ 每行实际占两行 ⇒ Ink 以为的帧高只有实际的一半 ⇒ 重绘「上移 N 行」擦不干净
 *   ⇒ 旧行留在屏上、新行又画一遍（同一段出现两遍）。**换行归 Box。**
 *
 * `rowLines` 是纯函数（一条行 → 显示行）——快照与用例直接拿它取景，不起 Ink。
 */

import { Box, Text } from 'ink'
import { createElement as h } from 'react'
import type { ReactElement } from 'react'
import { diffRowsOf, looksLikeDiff, replaceDiff } from '../diff.ts'
import type { DiffKind, DiffRow } from '../diff.ts'
import { markdown } from '../markdown.ts'
import type { LogRow } from '../view.ts'
import { textOfLines } from '../view.ts'
import { PALETTE, displayWidth, durationLabel, wrap } from './lines.ts'

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
  /**
   * **此刻**（毫秒）——跑动中的工具行拿它算「跑到第几秒了」（`⟳ 0.6s`）。
   *
   * 缺省 `null` ＝**没有钟**：那就照旧报「运行中」，**不编一个秒数**（拿不到的不编）。
   * 钟由活壳（`TuiApp`）给；取景与快照不给 ⇒ 帧是确定的。
   */
  readonly now?: number | null
}

/**
 * 一条记录行 → 一屏上的若干行。
 *
 * ⚠️ **每条显示行各是一个 `<Text>`、行内不写 `'\n'`**——见文件头注（D11 的根因与修法）。
 */
export function LogRowView({ row, columns, expanded, spaced, now = null }: LogRowProps): ReactElement {
  const lines = rowLines(row, { columns, expanded, spaced, now })

  return h(
    'ink-box',
    { key: `row:${row.key}`, style: { flexDirection: 'column' } },
    ...lines.map((line) => {
      // ⚠️ **空行得给一个「有东西」的孩子**——Ink 7 会把内容为空串的 `<Text>` 整行丢掉
      // ⇒ 正文里的段落空行被**静默吃掉**（缺陷 D19。**根因在这里，不在 `markdown.ts`**：
      // 那边把空行好好地交出来了）。一格空格就够，肉眼仍是空行。
      const children =
        line.spacer === true || line.segments.length === 0
          ? [' ']
          : line.segments.map((piece, at) =>
              h(Text, { key: `s:${at}`, color: piece.color, bold: piece.bold }, piece.text),
            )

      // **背景要铺满整行**（缺陷 D21）——`<Text>` 的 `backgroundColor` 只涂**文字那几格**，
      // 于是短句子看着像**块小补丁**（规格要的是「一眼看出这句是我说的」）。
      // 铺满得靠一个 `width: '100%'` 的容器来承这个背景；没有背景的行不多套这一层。
      return line.background === undefined
        ? h(Text, { key: line.key }, ...children)
        : h(
            Box,
            { key: line.key, width: '100%', backgroundColor: line.background },
            h(Text, {}, ...children),
          )
    }),
  )
}

/**
 * 记录行 → 显示行（纯函数）。
 * `spaced` ＝ 这条之前留一行分段（**只有用户消息之前**——原型 · 密度）。
 */
export function rowLines(
  row: LogRow,
  options: {
    readonly columns: number
    readonly expanded: boolean
    readonly spaced?: boolean
    readonly now?: number | null
  },
): readonly LogLine[] {
  const body = rowBody(row, options)

  return options.spaced === true ? [{ key: 'spacer', segments: [], spacer: true }, ...body] : body
}

/** 一屏上的**全部**显示行（含分段）——快照取景与行数预算用。 */
export function logLines(
  rows: readonly LogRow[],
  options: { readonly columns: number; readonly expanded: boolean; readonly now?: number | null },
): readonly LogLine[] {
  return rows.flatMap((row, index) => rowLines(row, { ...options, spaced: needsSpacer(rows, index) }))
}

/** 用户消息之前留一行分段；首条不必（顶上没有东西要分隔）。 */
export function needsSpacer(rows: readonly LogRow[], index: number): boolean {
  return index > 0 && rows[index]?.kind === 'user'
}

function rowBody(
  row: LogRow,
  options: { readonly columns: number; readonly expanded: boolean; readonly now?: number | null },
): readonly LogLine[] {
  const { columns, expanded } = options

  switch (row.kind) {
    case 'user':
      // **整行淡青背景**（一眼看出「这句是我说的」）——正文原色、标记青
      return wrapSegments([seg('› ', PALETTE.user, true), seg(trimBlank(row.text), PALETTE.fg)], columns, {
        key: 'r:u',
        background: USER_BG,
        hang: INDENT,
        bodyColor: PALETTE.fg, // 续行＝正文原色（缺陷 D22）——别让折下去那截比首行暗
      })

    case 'assistant': {
      // **空内容不渲染**（D6 的外壳侧双保险）——模型只发工具调用、不吐正文的那一轮
      const body = trimBlank(row.text)
      if (body.trim() === '') return []

      // **正文是 Markdown**（缺陷 D14）——五样渲染 ＋ 流式容忍都在 `markdown.ts` 里，
      // 这里只做「显示行 → 折好的行」。
      // **统一悬挂缩进**（缺陷 D20）——首行的标记占 2 列 ⇒ **正文与所有折行都从第 3 列起**；
      // markdown 自己的悬挂（列表按标记宽度）再叠在这条基线上。
      return markdown(body).flatMap((line, at) =>
        wrapSegments(
          at === 0
            ? [seg('⏺ ', PALETTE.ok, true), ...line.segments]
            : [seg(INDENT), ...line.segments],
          columns,
          { key: `r:a:${at}`, hang: `${INDENT}${line.hang ?? ''}`, bodyColor: PALETTE.fg },
        ),
      )
    }

    case 'thinking': {
      const lines = textOfLines(trimBlank(row.text)).filter((line) => line.trim() !== '')
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
      return toolLines(row, columns, expanded, options.now ?? null)

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
 * 不该比 Agent 的话更抢眼）＋ 工具名上色 ＋ 参数 dim；跑起来换 `⟳` ＋ **真耗时**；
 * 结果**同组缩进一行**。
 *
 * **就近渲染已知形态**（`对表.md`·B8——「工具输出渲染是主战场」）：
 * - **参数**（`argTextOf`）——已知的笨重形态（`edit` / `write` 的整段正文）只报**路径**，
 *   不再把 JSON 大团铺上屏；其余原样（不追全量）；
 * - **结果**（`verdictOf`）——按形态出摘要：diff 报增删行数 · 列表报项数 · 读文件报行数 ·
 *   失败报**首行缘由**（不必展开就知道为什么没成）；其余原样（末条非空行）；
 * - **正文**（`resultBody`）——`edit` 改成了的**那一段 diff 默认就地给出**（`+`/`-` 着色、
 *   上下文 dim）；越预算就折，展开（`ctrl+o`）给全量。
 */
function toolLines(
  row: Extract<LogRow, { kind: 'tool' }>,
  columns: number,
  expanded: boolean,
  now: number | null,
): readonly LogLine[] {
  const running = row.state === 'running'
  const marker = running ? '⟳ ' : '● '
  const markerColor = running ? PALETTE.warn : PALETTE.tool
  const args = argTextOf(row)
  const body = resultBody(row, expanded)

  const head = wrapSegments(
    [seg(marker, markerColor), seg(row.name, PALETTE.tool), seg(args === '' ? '' : ` ${args}`, PALETTE.dim)],
    columns,
    { key: 'r:h', hang: INDENT },
  )

  if (running) {
    // **跑动中报真秒数**——`tool.call` 自带 `at`（发起时刻），`now` 由活壳给 ⇒ 这一个是
    // **量出来的**，不是编的。（第 22 轮不报数，是因为当时拿的是**裁决耗时**——那笔账不同，
    // 且当时没有钟。见行上 `elapsedMs` 的注。）
    const clock = liveClock(row, now)

    return [
      ...head,
      ...prefixLine(INDENT, clock === null ? '⟳ 运行中' : `⟳ ${clock}`, PALETTE.warn, 'r:run'),
      ...body,
    ]
  }

  const verdict = verdictOf(row)
  const meta = [
    seg(`${INDENT}${verdict.marker} `, verdict.color, true),
    seg(
      row.elapsedMs === null ? verdict.text : `${durationLabel(row.elapsedMs)} · ${verdict.text}`,
      PALETTE.faint,
    ),
  ]

  return [...head, ...wrapSegments(meta, columns, { key: 'r:m', hang: '' }), ...body]
}

/** 结果行那半句——按**形态**出（见 `toolLines` 的头注）。 */
function verdictOf(row: Extract<LogRow, { kind: 'tool' }>): {
  readonly marker: string
  readonly color: string
  readonly text: string
} {
  // 没跑成：报**为什么**（首行缘由就是那句「为什么」；输出为空才回退到一句话）
  if (row.state === 'rejected') {
    return { marker: '✗', color: PALETTE.danger, text: firstLineOf(row.output) ?? '未执行' }
  }
  if (row.state === 'failed') {
    return { marker: '✗', color: PALETTE.danger, text: firstLineOf(row.output) ?? '失败' }
  }

  return { marker: '✓', color: PALETTE.ok, text: summaryOf(row) }
}

/** 工具的**列表类**（结果一条一行，故「几行」＝「几项」）——名字取自工具集 v1 的冻结行。 */
const LIST_TOOLS: readonly string[] = ['ls', 'grep', 'glob']

/** 成功结果的摘要——按已知形态出（B8）。 */
function summaryOf(row: Extract<LogRow, { kind: 'tool' }>): string {
  const lines = nonEmptyLines(row.output)
  if (lines.length === 0) return '完成'

  // 输出本来就是 diff（`exec` 跑 `git diff` 那类）——报增删行数比报末行有用
  if (looksLikeDiff(lines)) return diffStat(diffRowsOf(lines))

  // 列表类的「**注行**」优先——内核的注都写成整行方括号（`[空目录]` · `[无命中]` ·
  // `[命中达到上限 200——可能还有更多]`），而它们比计数**要紧**：说的是「结果为空 / 不完整」。
  // （只对列表类这么做：那几样工具的结果是**文件名**，不会整行是一个方括号。）
  if (LIST_TOOLS.includes(row.name)) {
    const note = listNoteOf(lines)
    return note ?? `${lines.length} 项`
  }

  if (row.name === 'read') return `${lines.length} 行`

  return truncateLine(lines[lines.length - 1] as string, 48)
}

/** 末行是整行方括号的**注**吗（`[空目录]` 那类）。 */
function listNoteOf(lines: readonly string[]): string | null {
  const last = lines[lines.length - 1] ?? ''

  return /^\[[^\]]*\]$/.test(last.trim()) ? truncateLine(last, 48) : null
}

/** diff 的增减计数（`+3 −2`）——`−` 用减号（U+2212）与 `-` 行首分开，省得读串行。 */
function diffStat(rows: readonly DiffRow[]): string {
  const add = rows.filter((row) => row.kind === 'add').length
  const del = rows.filter((row) => row.kind === 'del').length

  return `+${add} −${del}`
}

/**
 * 工具行的**参数**那一格——已知的笨重形态就地成形。
 *
 * `edit` / `write` 的参数里塞着**整段正文**（JSON 化之后是一条长到没法读的行，多行正文
 * 全被转义成 `\n`），而上屏要的是「改了哪个文件」。其余工具的参数本就短小，原样铺
 * （「表格保持原文」同一条取向：**不追全量**，B8）。
 *
 * 流式那几帧 `args` 还是 `null`（片段不全）⇒ 回退到原文片段，照旧看得见。
 */
function argTextOf(row: Extract<LogRow, { kind: 'tool' }>): string {
  if (row.args !== null && (row.name === 'edit' || row.name === 'write')) {
    const path = row.args['path']
    if (typeof path === 'string') return path
  }

  return row.argsText
}

/**
 * 工具结果的**正文块**。
 *
 * 三条：
 * - **`edit` 改成了** ⇒ 由参数里的 `old` / `new` 推出**这一段 diff**，**默认就出**
 *   （折叠着也给——「改了文件看不见改了什么」正是要修的那件事）；越预算折成一行说明，
 *   `ctrl+o` 给全量。**只有做成了才给**：没落地之前那是「打算」，落地失败它就没发生过；
 * - 别的工具：**展开才出**（折叠时只留标题与状态行——密度那条：老工具调用折一行）；
 * - 输出本身是 diff（`@@` 块头）⇒ 逐行着色，其余照旧 dim。
 */
function resultBody(row: Extract<LogRow, { kind: 'tool' }>, expanded: boolean): readonly LogLine[] {
  const derived = editDiffOf(row)
  if (derived !== null) {
    return diffLines(derived, expanded ? Number.POSITIVE_INFINITY : DIFF_PREVIEW)
  }

  if (!expanded) return []

  const lines = nonEmptyLines(row.output)
  if (lines.length === 0) return []

  return looksLikeDiff(lines)
    ? diffLines(diffRowsOf(lines), Number.POSITIVE_INFINITY)
    : lines.flatMap((line, at) => prefixLine(`${INDENT}${INDENT}`, line, PALETTE.dim, `r:out:${at}`))
}

/**
 * `edit` 这一处改动推出来的 diff（**只有做成了才给**：`ok` 之外一律 `null`）。
 *
 * 拿的是**参数**里的 `old` / `new`——那是模型自己说「把这段换成那一段」的原话，
 * 逐字比对得出**它究竟改了什么**。文件全文不在参数里 ⇒ **不编行号**（见 `../diff.ts` 头注）。
 */
function editDiffOf(row: Extract<LogRow, { kind: 'tool' }>): readonly DiffRow[] | null {
  if (row.name !== 'edit' || row.state !== 'ok' || row.args === null) return null

  const before = row.args['old']
  const after = row.args['new']
  if (typeof before !== 'string' || typeof after !== 'string') return null

  const rows = replaceDiff(before, after)

  return rows.length === 0 ? null : rows
}

/** 一段 diff → 显示行（缩进 4；`+` 绿 · `−` 红 · 上下文 dim · 块头与结构行最弱）。 */
function diffLines(rows: readonly DiffRow[], budget: number): readonly LogLine[] {
  const kept = rows.slice(0, budget)
  const rest = rows.length - kept.length

  const out = kept.flatMap((row, at) =>
    prefixLine(`${INDENT}${INDENT}`, row.text, DIFF_COLOR[row.kind], `r:d:${at}`),
  )

  // 折住的那截**如实报行数**（不编、也不装作画全了）；`ctrl+o` 展开给全量
  return rest === 0
    ? out
    : [...out, ...prefixLine(`${INDENT}${INDENT}`, `… 还有 ${rest} 行（ctrl+o 展开）`, PALETTE.faint, 'r:dfold')]
}

/** diff 各档的色（原型 · 裁决卡的 diff 就是这个分法：`-` 红 · `+` 绿）。 */
const DIFF_COLOR: Record<DiffKind, string> = {
  add: PALETTE.ok,
  del: PALETTE.danger,
  context: PALETTE.dim,
  hunk: PALETTE.faint,
  meta: PALETTE.faint,
}

/**
 * 折叠时默认给几行 diff（实现级常量）。
 *
 * 取 16 的由头：一屏（24 行）里记录区与左下那片各占一份，16 行是「常见的那一改」够用、
 * 又不至于把记录区挤成一屏只有一段 diff 的尺寸。**越了就折**并如实报剩余行数——
 * 折叠不是丢，是「这里还有，按一下就看全」。
 */
const DIFF_PREVIEW = 16

/** 跑动中的墙钟（`⟳ 0.6s`）——发起时刻到此刻。没有钟 / 没有起手时刻 ⇒ `null`（不编）。 */
function liveClock(row: Extract<LogRow, { kind: 'tool' }>, now: number | null): string | null {
  if (now === null || row.startedAt === null) return null

  const elapsed = now - row.startedAt

  return elapsed < 0 ? null : durationLabel(elapsed)
}

/** 结果里的非空行（空行不上屏——密度那条）。 */
function nonEmptyLines(output: readonly string[]): readonly string[] {
  return output.filter((line) => line.trim() !== '')
}

/** 结果的首条非空行（失败缘由就在那儿）。 */
function firstLineOf(output: readonly string[]): string | null {
  const line = nonEmptyLines(output)[0]

  return line === undefined ? null : truncateLine(line, 48)
}

function truncateLine(text: string, width: number): string {
  const clean = text.trim()
  return displayWidth(clean) <= width ? clean : `${clean.slice(0, width)}…`
}

/**
 * 一行片段 → 折好的显示行（续行按 `hang` 缩进）。
 *
 * ⚠️ **首行的色段按「折好的那一行」切**（`firstLine(segments, wrapped[0])`），
 * **不是**按宽度把整段重切一遍 ✗——差别在换行上：`wrap` 会把 `\n` 切成新行，
 * 而按宽度重切会把换行**留在首行里**（宽度只数可见列 ✗）⇒ 首行在终端上自己再展开成几行，
 * 同时续行又把同一段画一遍 ⇒ **同一段正文出现两遍**（缺陷 D13 的根因）。
 */
function wrapSegments(
  segments: readonly Segment[],
  columns: number,
  options: {
    readonly key: string
    readonly background?: string
    readonly hang: string
    /**
     * **续行用什么色**（缺陷 D22）——缺省 `dim`。正文类行（助手 / 用户）给 `fg`：
     * 同一句话第一行原色、折下去那截变暗，**读着像两段**。
     *
     * 工具行 / 命令输出的 `dim` 是**它们自己的语义**（参数与输出本就该弱），别改。
     */
    readonly bodyColor?: string
  },
): readonly LogLine[] {
  const text = segments.map((piece) => piece.text).join('')
  // 折行宽度按**悬得最远的那一条**算（首行前缀 2 列 / 续行的 `hang`）——否则续行会
  // 比首行宽出 `hang - 2` 列，终端再折一次 ⇒ Ink 的行数账目就错了（D11/D13 那族的老病）。
  const width = Math.max(8, columns - Math.max(2, displayWidth(options.hang)))
  const wrapped = wrap(text, width)

  return wrapped.map((line, at) =>
    at === 0
      ? {
          key: `${options.key}:0`,
          segments: firstLine(segments, line),
          background: options.background,
        }
      : {
          // 续行：按 `hang` 缩进，颜色**沿用该行的正文色**（缺省 dim——见 `bodyColor` 注）
          key: `${options.key}:${at}`,
          segments: [seg(`${options.hang}${line}`, options.bodyColor ?? PALETTE.dim)],
          background: options.background,
        },
  )
}

/**
 * 首行的色段——把原段切到**折好的首行**那么多字符为止（**含换行在内逐字对**，
 * 故换行不会被吞进首行）。
 */
function firstLine(segments: readonly Segment[], head: string): readonly Segment[] {
  const out: Segment[] = []
  let left = [...head].length

  for (const piece of segments) {
    if (left <= 0) break

    const chars = [...piece.text]
    const kept = chars.slice(0, left).join('')
    if (kept !== '') out.push({ ...piece, text: kept })
    left -= chars.length
  }

  return out
}

/** 缩进 ＋ 单色一行。 */
function prefixLine(indent: string, text: string, color: string, key: string): readonly LogLine[] {
  return [{ key, segments: [seg(`${indent}${text}`, color)] }]
}

/**
 * 正文**首尾的空行不渲染**（密度：空内容不渲染）。
 *
 * 由头：模型常在正文前给 `\n\n`（实测 MiniMax 如此）——留着就在屏上留两个空行，
 * 而条目的正文**原样保留**（只在渲染这一层去掉）。
 */
function trimBlank(text: string): string {
  return text.replace(/^\s*\n+/, '').replace(/\n+\s*$/, '')
}

/** 折叠一行：取首个非空行，太长的截断。 */
function collapse(lines: readonly string[]): string {
  return truncateLine(lines[0] ?? '', 60)
}
