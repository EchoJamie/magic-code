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
import { bannerOf } from '../banner.ts'
import { diffRowsOf, looksLikeDiff, replaceDiff } from '../diff.ts'
import type { DiffKind, DiffRow } from '../diff.ts'
import { markdownStream } from '../markdown.ts'
import type { MdLine } from '../markdown.ts'
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

/** 一屏上的**全部**显示行（含分段）——快照取景与行数预算用。 */
export function logLines(
  rows: readonly LogRow[],
  options: { readonly columns: number; readonly expanded: boolean; readonly now?: number | null },
): readonly LogLine[] {
  return rows.flatMap((row, index) => rowLines(row, { ...options, spaced: needsSpacer(rows, index) }))
}

/** 用户消息之前留一行分段；首条不必（顶上没有东西要分隔）。 */
export function needsSpacer(rows: readonly LogRow[], index: number): boolean {
  return needsSpacerAfter(index > 0 ? rows[index - 1] : undefined, rows[index])
}

/**
 * 紧邻的两条之间留不留一行分段——**「这条是不是用户消息」×「上一条是不是字标」**。
 *
 * 拆出这一支是为了**活动区那一段交界**（`app.ts`）：那儿没有 `rows` 数组可索引
 * （上一条在 `settled` 里、这一条在 `rows` 里），只有「上一条是谁」。两处必须是**同一条规矩**，
 * 否则同一屏上「用户消息之前」会有两种行为。
 *
 * ⚠️ **字标不加这一层**：它自己结尾就带一行留白（`BANNER_GAP_BOTTOM`）。
 * 不排这一支的话，字标之后的第一条用户消息前面会**空两行**——那是「成片空行」，
 * `invariants.ts` 的 `blankRuns` 当场红（≤1 行）。
 */
export function needsSpacerAfter(previous: LogRow | undefined, row: LogRow | undefined): boolean {
  return previous !== undefined && row?.kind === 'user' && previous.kind !== 'banner'
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
  // **规约扣下 / 材料超限停批**（2026-09-20 二轮裁）：也是「压根没跑」，故与失败分开画——
  // 不上失败那个叉（`!` ＋ warn 要说的是「这一笔要你再看一眼」），也没有耗时
  // （归约那一步就落了 `null`，见 `view.ts`·`unexecutedOf`）。那句 `未执行 · …` 是结果
  // 正文的首行，本行照抄——正文后头还有一条「为什么、怎么办」，`ctrl+o` 展开可见。
  if (row.state === 'unexecuted') {
    return { marker: '!', color: PALETTE.warn, text: firstLineOf(row.output) ?? '未执行' }
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
