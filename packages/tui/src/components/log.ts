/**
 * 记录区（缺陷轮 III）——**内联渲染**下的纯日志。
 *
 * 三条规矩（原型 · 组件规格 ＋ 密度节）：
 * - **三类行各有其形**：会话内容（`›` 用户 · `⏺` 助手 · `●` 工具）· 命令输出（dim 块）·
 *   命令回执（`·` 最弱）；
 * - **密度**：**块内不插空行**（分层靠标记 / 缩进 / 明暗）· **相邻两块之间留一整行**
 *   （U67 补全：块＝一条用户发言 / 一条助手发言 / 一个工具组，见下面「分段」那一节
 *   ——早先只判「这一条是不是用户消息」，只留了**一半**）；
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
import { bannerOf } from '../banner.ts'
import { diffRowsOf, looksLikeDiff, replaceDiff } from '../diff.ts'
import type { DiffKind, DiffRow } from '../diff.ts'
import { markdownStream } from '../markdown.ts'
import type { MdLine } from '../markdown.ts'
import type { LogRow } from '../view.ts'
import { nonEmptyLines, quietRowHidden, textOfLines } from '../view.ts'
import { PALETTE, displayWidth, durationLabel, expandTabs, wrap } from './lines.ts'

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
  /** **分段行**（块与块之间那一行，见「分段」一节）——渲染成空行。 */
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
  /** 这条行之前留不留一行分段（上一块与这一块不同＝留，见「分段」一节）。 */
  readonly spaced: boolean
  /**
   * **开头跳过几个显示行**（U31 三轮退回）——缺省 0（整条照画）。
   *
   * 只有活动区的头一条会用上：**它自己就比预算高**时（单条长记录 / 一段长 diff），
   * 屏上只画它**末尾**那几行——留一条溢出预算的整行，整个动态帧就顶满终端，
   * Ink 那支「顶满就省末尾换行」立刻把真光标顶高一行（见 `app.ts` 的 `liveAreaOf`）。
   * ⚠️ **这是画的事，不是记录的事**：`row` 一个字不动，跳过的行照样在记录里。
   */
  readonly skip?: number
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
export function LogRowView({
  row,
  columns,
  expanded,
  spaced,
  skip = 0,
  now = null,
}: LogRowProps): ReactElement {
  const all = rowLines(row, { columns, expanded, spaced, now })
  // 头一条超预算时只画末尾那几行（`skip` 见 props；0 时**原样交那一份**——它是缓存里的数组）
  const lines = skip > 0 ? all.slice(skip) : all

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
 * `spaced` ＝ 这条之前留一行分段（**上一块与这一块不同**，见文件头「密度」那一条）。
 *
 * **带缓存**（U21 · 增量重绘）——一屏上一条行在一帧里会被问两遍（活动区的行数预算
 * 与真渲染各一次），而流式时同一行还会被**逐帧**问下去。两处的答案只由
 * **行的内容 ＋ 四个参数**决定，故记下来即可：
 *
 * - 行对象**身份**为键（`WeakMap`）——归约从不改入参（`view.ts` 的既有纪律），
 *   故「同一个行对象」＝「同一份内容」；行一变就是新对象，自然落到新的一格。
 * - **助手正文另算**：它在流式里**每帧都是新对象**，身份缓存对它等于没有。那一条走
 *   `assistantLines`——按**正文前缀**增量（见其注）。
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
  const key = cacheKeyOf(options)
  const hit = rowCache.get(row)
  if (hit !== undefined && hit.key === key) return hit.lines

  const body = rowBody(row, options)
  const lines = options.spaced === true ? [SPACER, ...body] : body

  rowCache.set(row, { key, lines })

  return lines
}

/** 分段行（用户消息之前那一行）——**同一个对象**，省得每帧新建一个。 */
const SPACER: LogLine = { key: 'spacer', segments: [], spacer: true }

/** 字标块**上面**那一行留白（见 `case 'banner'`）——键与下面那条不同（同一行里的兄弟键要唯一）。 */
const BANNER_GAP_TOP: LogLine = { key: 'r:n:pad:top', segments: [], spacer: true }

/** 字标块**下面**那一行留白——「用户消息之前那一行分段」的活儿由它兼了（见 `needsSpacerAfter`）。 */
const BANNER_GAP_BOTTOM: LogLine = { key: 'r:n:pad:bottom', segments: [], spacer: true }

/** 显示行的四个参数合成一个键（`now` 参与——跑动中的那行每滴答一次就该重算一次）。 */
function cacheKeyOf(options: {
  readonly columns: number
  readonly expanded: boolean
  readonly spaced?: boolean
  readonly now?: number | null
}): string {
  return `${options.columns}:${options.expanded ? 1 : 0}:${options.spaced === true ? 1 : 0}:${options.now ?? -1}`
}

type RowCache = { readonly key: string; readonly lines: readonly LogLine[] }

/** 行身份 → 显示行（见 `rowLines` 的注）。 */
const rowCache = new WeakMap<LogRow, RowCache>()

/**
 * 助手正文的**增量折行**（U21 · 增量重绘）——挂在 `markdownStream` 的定稿前缀之上。
 *
 * ## 为什么还要一层
 *
 * `markdownStream` 省掉的是**解析**（正文 → `MdLine`）；而 `MdLine` → 显示行还要再走一遍
 * `wrapSegments`（折行 ＋ 切色段），那也是 `O(正文)`。两条合起来才是「一帧重算了一整段正文」。
 *
 * 故这一层把**已折好的显示行**按同一个「定稿前缀」攒着：`markdownStream` 说前 `settled`
 * 条不会再变 ⇒ 那几条的折行结果也不会再变，攒下来即可。每帧真正重算的只有
 * **`settled` 之后那一段**（没有未闭围栏时＝最后那一行）。
 *
 * ## 由头（实测）
 *
 * `bench-cost.ts`：正文 800 显示行时 `AppView` 一帧 **30.4ms**，而 Ink 的写档是 33ms
 * ——**一帧的活就吃满一帧的预算**，流式必然掉队（`bench-stream.ts`：2000 条要 29.5s）。
 *
 * ## 键与失守
 *
 * 键＝行的 `key`（`assistant:${id}`，一条消息一个、全程不变）。缓存**只对「往后长」成立**：
 * 新正文不是旧正文的前缀（重放 / 换会话 / 重建）就整条丢掉重来——**那一条判据不能省**。
 */
type AssistantCache = {
  /** 上次算过的正文（判「还是不是同一段在长」）。 */
  source: string
  readonly columns: number
  readonly expanded: boolean
  /** 已折好的显示行——对应 `markdownStream` 定稿的那一截。 */
  readonly lines: LogLine[]
  /** 上面那一截覆盖到第几条 `MdLine`。 */
  settled: number
}

const assistantCaches = new Map<string, AssistantCache>()

/** 缓存条数上限——同时只有一两条在长；给上限是防长会话里把每条消息都攒着。 */
const ASSISTANT_LIMIT = 16

function assistantLines(
  key: string,
  body: string,
  columns: number,
  expanded: boolean,
): readonly LogLine[] {
  const cached = assistantCaches.get(key)
  const usable =
    cached !== undefined &&
    cached.columns === columns &&
    cached.expanded === expanded &&
    body.startsWith(cached.source)

  const cache = usable ? cached : resetAssistant(key, columns, expanded)
  const parsed = markdownStream(key, body)

  // 新定稿的那几条折一次，攒进去（此后不再重算）
  for (let at = cache.settled; at < parsed.settled; at += 1) {
    appendLines(cache.lines, wrapAssistant(parsed.lines, at, at + 1, columns))
  }
  cache.settled = parsed.settled
  cache.source = body

  // 尾巴（还有未闭围栏时）每帧重算——没有围栏时它就是最后那一行，`O(1)`。
  // ⚠️ 尾巴**不进缓存**：它还**不是**定稿的（围栏一闭合，这几行的形会变）。
  const tail = wrapAssistant(parsed.lines, parsed.settled, parsed.lines.length, columns)

  // 交副本——`cache.lines` 还会被下一次 `push` 长出来，同一个对象交出去会让上一帧的结果背地里变
  return tail.length === 0 ? [...cache.lines] : [...cache.lines, ...tail]
}

/** 重置某条正文的增量状态（**丢掉旧的**——缓存只对前缀成立）。 */
function resetAssistant(key: string, columns: number, expanded: boolean): AssistantCache {
  assistantCaches.delete(key)

  while (assistantCaches.size >= ASSISTANT_LIMIT) {
    const oldest = assistantCaches.keys().next().value
    if (oldest === undefined) break
    assistantCaches.delete(oldest)
  }

  const cache: AssistantCache = { source: '', columns, expanded, lines: [], settled: 0 }
  assistantCaches.set(key, cache)

  return cache
}

/** `push(...)` 会在长数组上炸参数上限——一个一个来。 */
function appendLines(into: LogLine[], lines: readonly LogLine[]): void {
  for (const line of lines) into.push(line)
}

/**
 * 助手正文的 `[from, to)` 那几条 `MdLine` → 显示行。
 *
 * ⚠️ **`at` 是 `MdLine` 里的绝对下标**（不是切片下标）——首行标记（`⏺ `）与
 * 续行缩进（两格）按它分，显示行的 `key` 也按它编（`r:a:${at}`）。用相对下标会让
 * 增量之后**同一个 `key` 指到不同的行**，React 那侧就要错位。
 */
function wrapAssistant(
  lines: readonly MdLine[],
  from: number,
  to: number,
  columns: number,
): readonly LogLine[] {
  const out: LogLine[] = []

  for (let at = from; at < to; at += 1) {
    const line = lines[at] as MdLine
    appendLines(
      out,
      wrapSegments(
        at === 0 ? [seg('⏺ ', PALETTE.ok, true), ...line.segments] : [seg(INDENT), ...line.segments],
        columns,
        { key: `r:a:${at}`, hang: `${INDENT}${line.hang ?? ''}`, bodyColor: PALETTE.fg },
      ),
    )
  }

  return out
}

// ══ 分段：块与块之间留一整行（U67）══════════════════════════════════

/** **走一遍攒下的两格**：上一条画得出来的行 ＋ 上一块的块别（分段那笔账的全部输入）。 */
export type SpacerContext = {
  /** 上一条**画得出来**的行（一行都不占的那些不算——见 `rowDrawn`）。 */
  readonly previous: LogRow | undefined
  /** **上一块**的块别（`undefined` ＝顶上还没有块）。 */
  readonly block: string | undefined
}

/** 顶上（还没有任何行）那一份。 */
const NO_SPACER_CONTEXT: SpacerContext = { previous: undefined, block: undefined }

/**
 * **块**与「块之间留一整行、块内紧凑」——设计 · 终端呈现那一条（2026-09-25 写准）。
 *
 * ## 判据按「块」分，不按「谁在中间」分
 *
 * 一块＝**一条用户发言** / **一条助手发言** / **一个工具组**（这一批发起的调用 · 结果 ·
 * 所属附件 · 回执合起来算一块）／⚠️ **思考（`（思考）…` 那一段）自成一块**（2026-09-25
 * 用户定）——**它上下各留一整行**，不再与助手发言挤在同一块里；
 * **相邻两块之间留一整行，块内紧凑**。
 *
 * ⚠️ **别写成「用户 ↔ 助手 ↔ 工具组」那种以助手为中心的说法**（用户 2026-09-25 补正）：
 * 用户输入之后紧跟的**可能直接就是工具**（模型一句话都没说就调工具，屏上是
 * `› 改个文件` 紧接 `⟳ write note.txt`、**中间没有 `⏺` 那句**）。按「块」分才不漏这一形。
 *
 * ## 这一支以前只做了一半
 *
 * 原判据是 `row?.kind === 'user' && previous.kind !== 'banner'`——**只判「这一条是不是
 * 用户消息」** ⇒ 只在用户消息**之前**留，用户消息之后（`⏺` 之前）不留。设计那句
 * 「…**之间**」是双向的，于是「我输入之后与模型回复之间没有空行」一路没人发现
 * ——因为帧上一直长这样、看着像正常的。
 *
 * ## 三条不许（都在下面的实现里有着落）
 *
 * - **别用线**——线是划界用的（那两条已经各划一块），消息之间加线就成了装帧。这一支
 *   只吐**空行**（`SPACER`）；
 * - **别把字标自带的后留白弄成两行**——字标结尾自带 `BANNER_GAP_BOTTOM`，故它**后面
 *   紧挨着的那一条**不再叠这一层（见下面 `needsSpacerAfter` 的第一支）；
 * - **两处同一条规矩**——活动区那个交界（上一条在 `settled`、这一条在 `rows`）与
 *   已定局那一列走的是**同一个** `spacerWalk`，`app.ts` 只负责把两段接上。
 */

/**
 * 一行**自己**长不长一块——`undefined` ＝**不长**（字标 · 命令输出 · 回执）。
 *
 * 不长块的这三样**贴在前一块的尾巴上**：故它们前面不留分段、也不把块切开。
 * 由头：设计明写工具组那一块含**回执**（「这一批发起的调用 · 结果 · 所属附件 · 回执
 * 合起来算一块」）；字标与命令输出同理——它们本就是前一块的装帧与产物。
 *
 * ⚠️ **用户行按 `key` 认块**（不是一律 `'user'`）：设计说的是「一块＝**一条**用户发言」
 * ——两条挨着的用户消息是两块，中间该有一行。
 * ⚠️ **思考自成一块**（`'thinking'`，2026-09-25 用户定）：`（思考）…` 那一段**上下各留
 * 一整行**——它与助手发言**不再同属一块**（原先两者都是 `'speech'`，于是正文与思考之间
 * 一行都不留）。`appendText` 把同类增量并在同一行，正文与思考**交替**时才分行。
 */
function blockOf(row: LogRow): string | undefined {
  switch (row.kind) {
    case 'user':
      return `u:${row.key}`
    case 'assistant':
      return 'speech'
    // ⚠️ **思考自成一块**（2026-09-25 用户定）：`（思考）…` 那一段**上下各留一整行**，
    // 不再与助手发言挤在同一块里。设计 · 终端呈现那一句把「思考那一段」与用户发言 /
    // 助手发言 / 工具组并列为**一种块**。
    //
    // 自成一档而不是按行认（`t:<key>`）：设计说的是「**那一段**」——同一条思考（连着的
    // 几行都是它）是一块，块内紧凑。正文与思考**交替**时才分行（见 `appendText`），
    // 那几行之间本来就隔着助手行，各归各的块。
    case 'thinking':
      return 'thinking'
    // **连续的工具行算一个工具组**（相邻才比较 ⇒ 挨着的两条工具行＝同一组）——单条调用、
    // 结果的续行、收拢的 `● N 次工具调用` 都落在这一块里
    case 'tool':
    case 'toolgroup':
      return 'tool'
    case 'banner':
    case 'output':
    case 'receipt':
      return undefined
  }
}

/**
 * 这一行**在屏上占不占地方**——一行都不占的那些（空正文的助手 / 思考 · 收起的安静工具行）
 * **不参与分段那笔账**：
 *
 * - 不给它们留分段（留了就是一条**孤零零的空行**——它后面什么也没有）；
 * - 算「上一条是谁」时也跳过它们。
 *
 * ⚠️ **第二条不能省**——省了，「模型一句话都没说就调工具」那一形（用户 → 空助手行 → 工具）
 * 就会两边各留一行、**连成两行空行**（`invariants.ts` 的 `blankRuns` 当场红）；而只做第一条
 * 又会把用户与工具之间那一行**整个丢掉**（正是工单点名要有帧的那一形）。
 *
 * ⚠️ **判据与 `rowBody` 必须同步**（那边是「一条行 → 显示行」的出处）：这里只在**不折行
 * 就能判**的三处下结论，其余一律当「占地方」——不去调 `rowBody`（助手那条要解析 Markdown，
 * 每帧为算分段付这个价钱不值）。
 */
export function rowDrawn(row: LogRow, expanded: boolean): boolean {
  switch (row.kind) {
    case 'assistant':
    case 'thinking':
      return row.text.trim() !== ''
    // 安静的工具行：成功（含跑动中）＋ 收起 ⇒ 一行都不画（见 `quietRowHidden`）
    case 'tool':
      return !(quietRowHidden(row) && !expanded)
    default:
      return true
  }
}

/**
 * 紧邻的两条之间留不留一行分段——**「这一条起不起新的一块」×「上一块是谁」**。
 *
 * 拆出这一支是为了**活动区那一段交界**（`app.ts`）：那儿没有一整列可索引（上一条在
 * `settled` 里、这一条在 `rows` 里），只有「上一条是谁、上一块是谁」。两处必须是**同一条规矩**，
 * 否则同一屏上同一个交界会有两种行为。
 *
 * 四支判据，每条都有由头：
 * - **顶上没有东西**（`previous === undefined`）⇒ 不留——首条不必分段，顶上没有东西要分；
 * - **这一条一行都不占** ⇒ 不留（见 `rowDrawn`：留了就是一条孤零零的空行）；
 * - **上一条是字标** ⇒ 不留——字标结尾自带一行留白（`BANNER_GAP_BOTTOM`）。不排这一支，
 *   字标之后的第一条用户消息前面会**空两行**（`invariants.ts` 的 `blankRuns` 当场红）；
 * - **这一条不长块**（回执 / 命令输出）⇒ 不留——它贴在前一块的尾巴上。
 *
 * 剩下的就是正题：**这一块与上一块不同 ⇒ 留一整行**。
 */
export function needsSpacerAfter(
  previous: LogRow | undefined,
  block: string | undefined,
  row: LogRow | undefined,
  expanded: boolean,
): boolean {
  if (previous === undefined || row === undefined) return false
  if (previous.kind === 'banner') return false
  if (!rowDrawn(row, expanded)) return false

  const own = blockOf(row)

  return own !== undefined && own !== block
}

/** 走完一列之后攒下的东西——**接着它往下走**（活动区那一列与已定局那一列的接缝）。 */
export type SpacerWalk = {
  /** 每一条之前留不留一行分段（与 `rows` 一一对应）。 */
  readonly flags: readonly boolean[]
  /** 走完之后的状态（活动区从这儿接着走）。 */
  readonly end: SpacerContext
}

/**
 * 一路走过去，问每一行「你前面留不留一整行」——**分段那笔账只有走一遍才算得准**。
 *
 * 为什么不能只看紧邻的两条：「这一条贴在前一块的尾巴上」（回执 / 命令输出）意味着
 * **上一块是谁**要一直记着——`tool · 回执 · tool` 那一串是**一个**工具组，中间一行都不留。
 *
 * `from` 缺省＝从顶上走；活动区那一列把它传成 `settled` 走完的状态（见 `app.ts`）。
 */
export function spacerWalk(
  rows: readonly LogRow[],
  expanded: boolean,
  from: SpacerContext = NO_SPACER_CONTEXT,
): SpacerWalk {
  const flags: boolean[] = []
  let previous = from.previous
  let block = from.block

  for (const row of rows) {
    const drawn = rowDrawn(row, expanded)
    flags.push(needsSpacerAfter(previous, block, row, expanded))
    if (!drawn) continue

    // 不长块的那三样（回执 / 命令输出 / 字标）**不动块别**——它们贴在前一块的尾巴上
    block = blockOf(row) ?? block
    previous = row
  }

  return { flags, end: { previous, block } }
}

/**
 * 从顶上走一遍的结果——**按数组身份攒着**（同 `rowLines` 那条缓存的口径）。
 *
 * 由头：已定局那一列一帧里要被问好几遍（活动区那个交接问一次、已定局那一侧每加一行
 * 又问一次），而它**一帧内身份不变**（换对象式地长，见 `view.ts` 的写法）。
 * 不攒的话每次问都是 `O(列长)`——长会话里那笔账会跟着列长一起长。
 */
const walkCache = new WeakMap<readonly LogRow[], { readonly expanded: boolean; readonly walk: SpacerWalk }>()

/** 从顶上走一遍 `rows`（带按身份攒的那一层）。 */
function cachedWalk(rows: readonly LogRow[], expanded: boolean): SpacerWalk {
  const hit = walkCache.get(rows)
  if (hit !== undefined && hit.expanded === expanded) return hit.walk

  const walk = spacerWalk(rows, expanded)
  walkCache.set(rows, { expanded, walk })

  return walk
}

/** 走完 `rows` 之后的状态（活动区接着它往下走的那一份）。 */
export function spacerEnd(rows: readonly LogRow[], expanded: boolean): SpacerContext {
  return cachedWalk(rows, expanded).end
}

/** 一条之前留不留一行分段（已定局那一列的取法——给它一列与下标）。 */
export function needsSpacer(rows: readonly LogRow[], index: number, expanded: boolean): boolean {
  return cachedWalk(rows, expanded).flags[index] ?? false
}

/** 一屏上的**全部**显示行（含分段）——快照取景与行数预算用。 */
export function logLines(
  rows: readonly LogRow[],
  options: { readonly columns: number; readonly expanded: boolean; readonly now?: number | null },
): readonly LogLine[] {
  const { flags } = spacerWalk(rows, options.expanded)

  return rows.flatMap((row, index) =>
    rowLines(row, { ...options, spaced: flags[index] === true }),
  )
}

function rowBody(
  row: LogRow,
  options: { readonly columns: number; readonly expanded: boolean; readonly now?: number | null },
): readonly LogLine[] {
  const { columns, expanded } = options

  switch (row.kind) {
    /**
     * **启动字标**（品牌视觉 · TUI Banner）——记录区最前面那一块，启动印一次。
     *
     * 三件都在这一处落定：
     * - **画哪一版按列数挑**（`bannerOf`）——≥57 列块字版（左侧留 2 列白）· ≥10 列一行版
     *   · 更窄**不印**（一行都不给，把位置让回正文与输入）；
     * - **两段配色**——`MAGIC` 品牌青 · `CODE` 主文字色，切点由 `bannerOf` 连文字一起给
     *   （两版的切点不同：27 / 5，渲染层自己数迟早数错一列）；
     * - **没有第三样**——不动效、不 Icon、不带宣传图或工具信息（设计那一条「静态」）。
     *
     * ## 为什么就是 `PALETTE.user` 与 `PALETTE.fg`
     *
     * 不是「相近的颜色」——**是同一个色**：设计文档配色表里深底一档的
     * `MAGIC #56B6C2` 正是色板里的 `user`，`CODE #D8DCE4` 正是 `fg`。复用而不是
     * 另起两个常量，为的是**色只有一处出处**（色板那条自律：「颜色只表语义，不做装饰」）。
     *
     * 另外两档**此刻不做**，如实记：**浅底**那一档（`#167682` / `#18232D`）要终端主题信息，
     * 而**这个壳没有主题检测**（整块色板都是照深底定的，别处也一样）；**未知主题用默认前景**
     * 那一条则由 `chalk` 自己兑现——无色终端根本不发色码，字标整块落到默认前景上，
     * 正是设计要的那一句。⇒ 两条都不是「漏了」，是**没有那个输入**。
     *
     * ⚠️ 画幅是纯 BMP（`█` ＋ 空格），故 `slice` 按码元切与按字切等价；
     * 若日后换成含代理对的字形，这一处要跟着改 `Array.from`。
     */
    case 'banner': {
      const art = bannerOf(columns).map((line, at) => ({
        key: `r:n:${at}`,
        segments: [
          seg(line.text.slice(0, line.magicWidth), PALETTE.user),
          seg(line.text.slice(line.magicWidth), PALETTE.fg),
        ],
      }))

      // **极窄 ⇒ 一行都不给**——含那两行留白（「一个格子都不占」是字面意思：
      // 9 列那一档的判据是「整屏字节与摘掉字标那份逐字节相同」，多一行空行就不成立了）。
      if (art.length === 0) return []

      /**
       * **自成一块**（原型 · 界面原型.html 场景 1 的 `.banner{margin:0 0 17px}` 与 `.log` 的上留白）：
       * 前后**各一行留白**——品牌与空态提示是两种东西，贴着就成了「硬放」。
       *
       * ⚠️ **后留白与「用户消息之前那一行分段」是同一件事**，故那儿不再叠一层
       * （见 `needsSpacerAfter`）：字标总在最前，紧挨着它的那条已经被这一行留白隔开了。
       */
      return [BANNER_GAP_TOP, ...art, BANNER_GAP_BOTTOM]
    }

    case 'user': {
      // **整行淡青背景**（一眼看出「这句是我说的」）——正文原色、标记青
      const body = wrapSegments([seg('› ', PALETTE.user, true), seg(trimBlank(row.text), PALETTE.fg)], columns, {
        key: 'r:u',
        background: USER_BG,
        hang: INDENT,
        bodyColor: PALETTE.fg, // 续行＝正文原色（缺陷 D22）——别让折下去那截比首行暗
      })

      // **随这条交代送出去的技能**（U33）——**只有重建那一趟才有**（见 `LogRow` 那两格注：
      // 恢复后屏上没别的地方说这件事，而当场发的那一次另有草稿材料行与使用回执）。
      //
      // 形态取**草稿上那一行**的写法（`技能：名称 · 来源`），只是不带「（待发送）」
      // ——它早就发出去了。**不带 `· ` 那个回执标记**：回执说的是「当时发生了什么」，
      // 恢复时不该重放，两副面孔长得不一样才对。
      const skills = row.skills
      if (skills === undefined || skills.length === 0) return body

      return [
        ...body,
        ...wrapSegments(
          [
            seg(`${INDENT}技能：`, PALETTE.faint),
            seg(skills.map((one) => `${one.name} · ${one.label}`).join('、'), PALETTE.faint),
          ],
          columns,
          { key: 'r:u:sk', hang: INDENT },
        ),
      ]
    }

    case 'assistant': {
      // **空内容不渲染**（D6 的外壳侧双保险）——模型只发工具调用、不吐正文的那一轮
      const body = trimBlank(row.text)
      if (body.trim() === '') return []

      // **正文是 Markdown**（缺陷 D14）——五样渲染 ＋ 流式容忍都在 `markdown.ts` 里，
      // 这里只做「显示行 → 折好的行」。
      // **统一悬挂缩进**（缺陷 D20）——首行的标记占 2 列 ⇒ **正文与所有折行都从第 3 列起**；
      // markdown 自己的悬挂（列表按标记宽度）再叠在这条基线上。
      //
      // 折行**按前缀增量**（U21 · 增量重绘）——见 `assistantLines` 的注。
      return assistantLines(row.key, body, columns, expanded)
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
      // **安静的工具行**（U34 · 计划读写与历史回查那三个）：**默认不占地方，展开就照常画**。
      //
      // 「默认不另刷一串工具卡或重复计划全文」（设计）——它们的成功结果与计划本身说的是同一
      // 件事，再铺一张卡就是同一件事说两遍。
      //
      // ⚠️ **「默认不画」的边界（设计 · 终端投影那一节，2026-09-23 收紧）**：
      // **活动输出**沿 `ctrl+o` 展开详情（这一行还在活动区时，展开就与别的工具行长得
      // 一模一样：名字 · 参数 · 结果正文全在）；**已结束的过程沿持久会话 / 工具记录供排障**
      // ——已写进原生 scrollback 的条目**不承诺重绘**，也不为它新开历史查看面。
      // 判据（`quietRowHidden`，与历史收拢共用一把尺子）：没跑成（失败 / 被拒 / 被扣下）
      // 照旧可见；成功（含跑动中）收起时不画。
      if (quietRowHidden(row) && !expanded) return []

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

  /**
   * **在等裁决的那一笔：那一行不说「跑了多久」**（U66 · 设计 · 终端交互「工具那行的计时
   * 只算执行本身」）。
   *
   * 由头：**在等你 ≠ 在执行**（「等待你」在运行事实那张表里本就是独立一档）。卡片挂着时
   * 这件工具**一次都还没跑**，它上面那几秒是**人在想**——算成「它跑了多久」就是屏上说了一句
   * 不成立的话。**那一屏的话由卡片说**（卡上写着「y 批准 / n 拒绝」，状态行写着「等你定夺」），
   * 这一行不重复、也不报一个不存在的数。
   *
   * ⚠️ **只停钟、不换标记、也不加词**：`⟳` 照旧（这一笔**还没落定**——那正是它的语义），
   * 头一行的名字与参数照旧，只是**底下那行读数不画**。加一句什么（「等你定夺」「待裁决」）
   * 就是把卡片那句话再说一遍——一屏上的每条各说一件别处没说的。
   */
  if (running) {
    if (row.awaitingDecision === true) return [...head, ...body]

    // **跑动中报真秒数**——起算时刻（`startedAt`：发起，或者**批准那一刻**——见
    // `view.ts` 的 `reduceVerdict`）到此刻，`now` 由活壳给 ⇒ 这一个是**量出来的**，
    // 不是编的。（第 22 轮不报数，是因为当时拿的是**裁决耗时**——那笔账不同，
    // 且当时没有钟。见行上 `elapsedMs` 的注。）
    const clock = liveClock(row, now)

    return [
      ...head,
      ...prefixLine(INDENT, clock === null ? '⟳ 运行中' : `⟳ ${clock}`, PALETTE.warn, 'r:run'),
      ...body,
    ]
  }

  const verdict = verdictOf(row, expanded)
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
function verdictOf(
  row: Extract<LogRow, { kind: 'tool' }>,
  expanded: boolean,
): {
  readonly marker: string
  readonly color: string
  readonly text: string
} {
  // 没跑成：报**为什么**（首行缘由就是那句「为什么」；输出为空才回退到一句话）
  if (row.state === 'rejected') {
    return { marker: '✗', color: PALETTE.danger, text: firstLineOf(row.output) ?? '未执行' }
  }
  // **规约扣下 / 材料超限停批**：也是「压根没跑」，故与失败分开画——不上失败那个叉
  // （`!` ＋ warn 要说的是「这一笔要你再看一眼」），也没有耗时（归约那一步就落了 `null`，
  // 依据是结果上的 `notExecuted`，见 `view.ts`·`reduceToolResult`）。那句 `未执行 · …`
  // 是结果正文的首行，本行照抄——正文后头还有一条「为什么、怎么办」，`ctrl+o` 展开可见。
  if (row.state === 'unexecuted') {
    return { marker: '!', color: PALETTE.warn, text: firstLineOf(row.output) ?? '未执行' }
  }
  // **失败那一行保头也保尾**（U93）——它跟上面两支的**形状不同**：被拒 / 被扣下那两句
  // 把「为什么 ＋ 用什么」写在**头里**（`messages.ts` 的 `refusalOutput` 明写「第一行要能
  // 独立读」，`rules.ts` 那两句也是「未执行 · 由此往下读」），而失败这句的**收梢那一句**
  // （「该怎么办」）落在最后那几个字上——`D41` 那一半只解决到「名分一次」，指引要展开才
  // 看得见。故这一支另给一把尺子（头也留、尾也留，见 `truncateMid`）。
  if (row.state === 'failed') {
    return { marker: '✗', color: PALETTE.danger, text: failedLineOf(row.output) }
  }

  // **大块结果另有一句话要说**（U82）——有多大、屏上有没有铺全、正文去哪儿看
  const bulk = bulkSummaryOf(row, expanded)

  return { marker: '✓', color: PALETTE.ok, text: bulk ?? summaryOf(row) }
}

/**
 * **大块结果那一行**（U82）——记录里存的是引用（越过 8 KiB）时，屏上说什么。
 *
 * 三条都得说到（工单 U82 · ①）：
 * - **不出现任何内部 id**——那串 sha256 原样印出来，用户读成「有个转储文件」（`D40` 现场）；
 * - **看得出「这块内容大、没全带回来」**——「大块输出」是这块大，`（屏幕上没铺全）`
 *   是没全带回来（折叠时正文确实不在屏上）；
 * - **有路看到内容**——正文就在这一行里（`output`），`ctrl+o` 展开即见（既有那一条展开键，
 *   与别的工具行同一个走法）。
 *
 * 两态各说各的（同一行的两种状态，不是两句话）：
 * - **收起**：多大 ＋ 没铺全；
 * - **展开**：正文就在下面——此时只报规模，不再说「没铺全」（那句话此刻不再为真）。
 *
 * ⚠️ **「展开即见」有一个既有的窗口**：`ctrl+o` 只对**还在活动区**的行管用——已定局的行
 * 进 `<Static>`，**写一次就不再重绘**（U72 的留帧记过同一条：「按了等于没按」）。
 * 故这一行**不印「按 ctrl+o」这种指路的话**：定局之后那句话就是个跑不了的入口
 * （`AGENTS.md`：「指一个跑不了的入口，比不指更坏」）。限度如实记在回报里。
 *
 * ⚠️ **行数取自 `row.output`**：那是**流式攒下的正文本身**（U82 起大块结果不再被引用换掉），
 * 数它＝数屏上真画得出来的行数——**不编一个数**。
 *
 * ⚠️ **没有正文就不报行数**：不流式的工具（`read` 那一类）转存之后行里没有正文
 * （见 `view.ts` 上 `bulk` 那一格的注），那时只说「大块、没铺全」——**不知道的不编**。
 */
function bulkSummaryOf(row: Extract<LogRow, { kind: 'tool' }>, expanded: boolean): string | null {
  if (row.bulk !== true) return null

  const lines = nonEmptyLines(row.output).length
  const scale = lines === 0 ? '大块输出' : `大块输出 ${lines} 行`

  return expanded ? scale : `${scale}（屏幕上没铺全）`
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

  // `read` 与 `skill` 回的都是**一整份文档**——报**行数**才有信息（末行是文档的最后一句话，
  // 与「读到了什么」没关系）。`skill` 是 U33 加的读取入口，与 `read` 同一处境，故同一处置。
  if (row.name === 'read' || row.name === 'skill') return `${lines.length} 行`

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

/**
 * 跑动中的墙钟（`⟳ 0.6s`）——**起算时刻**到此刻。没有钟 / 没有起算时刻 ⇒ `null`（不编）。
 *
 * ⚠️ 起算时刻不是「发起」那么简单了（U66）：人工批准那一档，它被挪到**批准那一刻**
 * ——故这个数就是**真跑的那一段**（见 `view.ts` 的 `reduceVerdict`）。
 * **在等裁决的行根本走不到这儿**（`toolLines` 先按 `awaitingDecision` 停表）。
 */
function liveClock(row: Extract<LogRow, { kind: 'tool' }>, now: number | null): string | null {
  if (now === null || row.startedAt === null) return null

  const elapsed = now - row.startedAt

  return elapsed < 0 ? null : durationLabel(elapsed)
}

/**
 * 结果的首条非空行（**被拒 / 被扣下**那两句的缘由就在那儿）。
 *
 * ⚠️ **这一支只留头**（U93 起仍是）——那两句的形状是「**由前往后读**」：
 * `messages.ts` 的 `refusalOutput` 明写「第一行要能独立读（已拒绝 ＋ 为什么 ＋ 用什么）」，
 * `rules.ts` 的 `未执行 · …` 同理（「首行得自己读出没跑」）。要害在**前段**，中截反而会把
 * 「用什么」（`trash` 那一半）挤掉——**故这两支的尺子本单一个字不动**。
 * 失败那一支另走 `failedLineOf`（保头保尾），见那处的注。
 */
function firstLineOf(output: readonly string[]): string | null {
  const line = nonEmptyLines(output)[0]

  return line === undefined ? null : truncateLine(line, 48)
}

function truncateLine(text: string, width: number): string {
  const clean = text.trim()
  return displayWidth(clean) <= width ? clean : `${clean.slice(0, width)}…`
}

/** 失败那一行铺几列（实现级常量；**折叠态只有一行**是这一格的硬约束——见 `truncateMid`）。 */
const FAILED_LINE_COLUMNS = 48

/**
 * 中段省掉时，**尾巴保几个字**（其余全给头）——**量出来的数**，推导见 `truncateMid`：
 * 13 是收梢那一句（`上级目录不存在——先建目录` / `用 exec ＋ curl`）要的量。
 */
const FAILED_TAIL_CHARS = 13

/** 失败那一行的整句话——首行口径照旧（取输出的首行），**变的是它被裁到几列、裁哪一头**。 */
function failedLineOf(output: readonly string[]): string {
  const line = nonEmptyLines(output)[0]

  return line === undefined ? '失败' : truncateMid(line, FAILED_LINE_COLUMNS)
}

/**
 * 截到宽度——**保头也保尾**，中段省掉（U93 · `D41` 的「另一半」）。
 *
 * ## 为什么不是「只留头」
 *
 * 失败那整句是这个形状（U83 定的措辞，一个字不许动）：
 *
 * ```
 * 写入失败（<路径>）：上级目录不存在——先建目录
 * ```
 *
 * **要害全在后半截**：为什么（`：` 之后那句原委）＋ 该怎么办（`——` 之后那句指引）。
 * 而路径可以很长——按头裁 48 列时，屏上只剩「名分 ＋ 半个路径」，那句指引要 `ctrl+o`
 * 展开才看得到（`D41` 的「只解决了一半」，U83 如实报的）。折叠态只有一行时，这一行
 * 得自己把「为什么 ＋ 该怎么办」读出来。
 *
 * ## 分配：**尾保 13 个字，余下的全给头**（量出来的，不是拍的）
 *
 * 这一行两头装的是两样东西：**头里是「名分 ＋ 对象 ＋ 原委的开头」**（哪件工具 · 在哪一处 ·
 * 为什么），**尾里是收梢那一句**（「该怎么办」常落在最后那几个字上）。拿本仓真跑里出得来的
 * 三句量一量：
 *
 * | 真句子 | 两边各要几个字 |
 * | --- | --- |
 * | `取不得「http://localhost:8080/x」——本机地址（localhost）不走「取网页」这条路；要访问本地服务用 exec ＋ curl` | 头要 **34** 才装得下「名分 ＋ 地址 ＋ **本机地址**」（各半＝23、尾重＝19 都装不下——屏上只剩「取不得「http://localhos…」）；尾要 **13** 才装得下「用 exec ＋ curl」 |
 * | `写入失败（<六十字的绝对路径>）：上级目录不存在——先建目录` | 尾要 **13** 才装得下收梢那句（`上级目录不存在——先建目录`）；头再多也只是路径 |
 * | `文件超长（超过 50 MiB）——不做编辑，以免写回截断内容；改用 exec（如 sed / python）分段改` | 尾 13 正好落在「/ python）分段改」——**出口**那一头 |
 *
 * ⇒ **尾恒取 13 字，头拿剩下的 34**——两句的要害都落得进来。
 * ⚠️ **这是个紧数**：尾少一个字，`取不得「…」——本机地址` 就短一口（U72 真跑里那条
 * 「缘由说得出口」的判据当场红，见 `frames-u72-tui.ts` 的 ④）；尾多一个字，收梢那句就缺一角。
 * **要动它，先把上面这三句重跑一遍。**
 *
 * ## 尺子**照旧是既有的那一把**（本单只改「留哪一头」）
 *
 * 触发与预算都沿用 `truncateLine` 那一套：**按显示宽判**（`displayWidth > width` 才动手）、
 * **按码点切**（切出来的是字，不是列）。⚠️ 这一条是**实测逼出来的**：改成「按列切」时，
 * `已取消——已停止等待并发出取消请求（取消不等于远端撤销，未收到结果）` 那一句（36 个字、
 * 70 列）会**第一次被切**——而它正好是 U38 要屏上读到的那句（U40 的
 * `mcp-approval-edge` 那条判据当场红）。**本单要改的是「留哪一头」，不是那行留多少**——
 * 顺手把中文那类的可见字数砍半，就是把别人的判据切掉了。
 *
 * ⚠️ **两处顺带的（都在这一行上）**：
 * - 「宽度超了、**字符数却没超预算**」那一档**原样返回**。旧写法在这一档会缀一个**假省略号**
 *   （`…未收到结果）…`——什么都没省却说「还有」），是一句假话，故去掉；
 * - 省略处只有一个 `…`：这一行的预算容不下「省了多少」那两格——报数是**模型那一份**的事
 *   （`exec.ts` 的 `truncationNote`）。两处**规则同一条**（头尾都留 · 省略处留记号），
 *   预算各随各的格。
 */
function truncateMid(text: string, width: number): string {
  const clean = text.trim()
  if (displayWidth(clean) <= width) return clean

  const chars = [...clean]
  const budget = Math.max(width - 1, 0) // 中间那个 `…` 占一个字
  if (chars.length <= budget) return clean

  const tail = Math.min(FAILED_TAIL_CHARS, budget)
  const head = budget - tail

  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
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
  // ⚠️ **先展开 Tab，折行与色段都按展开后的那一份**（2026-09-22 · 独立复核退回①）：
  //    展开只发生在显示层（原文不动），但**首行与续行必须取自同一份显示文本**——
  //    早先折的是展开后的行、首行色段却拿**展开前**的原段按「展开后有几个字符」去截
  //    ⇒ 首行把裸 `\t`（甚至下一行的换行）吞了进来，屏上那一行又自己折一次 ⇒ 重印。
  const display = displaySegments(segments)
  const text = display.map((piece) => piece.text).join('')
  // 折行宽度按**悬得最远的那一条**算（首行前缀 2 列 / 续行的 `hang`）——否则续行会
  // 比首行宽出 `hang - 2` 列，终端再折一次 ⇒ Ink 的行数账目就错了（D11/D13 那族的老病）。
  const width = Math.max(8, columns - Math.max(2, displayWidth(options.hang)))
  const wrapped = wrap(text, width)

  return wrapped.map((line, at) =>
    at === 0
      ? {
          key: `${options.key}:0`,
          segments: firstLine(display, line),
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
 * 段表 → **显示段表**：Tab 在显示层展开成空格（`expandTabs`，与终端同一条规矩）。
 *
 * 逐段展开、列数一路累加——**与整段一次性展开等价**（同一把尺子、同一条规矩），
 * 而好处是**每一段的色/粗与它那段文字仍然成对**：首行按显示坐标切片时，样式跟着走。
 *
 * ⚠️ **「接着累加」是按整段文字说的，不是按段自己的宽度**（2026-09-22 · 独立复核 b25b9ff）：
 * 段只是**色界**，不是行界——这一段**没有换行**时，列数要**在上一段的列上继续加**
 * （早先写成「取本段最后一行」，没换行就是**把前面几段一笔勾销**：`**left**\tright` 与
 * `left\tright` 同一段可见文字，加粗那一份的 Tab 从第 1 列起算 ⇒ 多出两格空白，
 * 屏上 `right` 落在第 10 列而不是第 8 列）。有换行才归到最后一行（终端把制表位按物理行算）。
 *
 * **导出给用例**：段表是本函数的入参，判据（分段与不分段等价）要能自己造段。
 */
export function displaySegments(segments: readonly Segment[]): readonly Segment[] {
  let column = 0
  const out: Segment[] = []

  for (const piece of segments) {
    const text = expandTabs(piece.text, column)
    out.push({ ...piece, text })

    const lines = text.split('\n')
    // 没有换行 ⇒ 接着上一段往下加；有换行 ⇒ 归到**最后那一行**的宽度
    column =
      lines.length === 1 ? column + displayWidth(text) : displayWidth(lines[lines.length - 1] ?? '')
  }

  return out
}

/**
 * 首行的色段——把**显示段**切到**折好的首行**那么多字符为止。
 *
 * 两边都是**显示坐标**（都展开过 Tab，见 `displaySegments`），故「首行画多长就切多长」
 * 是同一本账：裸 `\t` 与下一行的换行都不会被吞进来（切法的由头见 `wrapSegments` 的注）。
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
