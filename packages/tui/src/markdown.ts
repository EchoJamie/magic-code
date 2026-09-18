/**
 * Markdown 渲染（缺陷轮 V · D14）——**记录区的助手正文**。
 *
 * 出处：`缺陷/D14 记录区不渲染 Markdown.md` ＋ `界面原型.html` ·「Markdown 渲染（记录区的助手正文）」。
 * 纯函数：正文 → **显示行**（样式已就位）——不起 Ink、也不看终端宽度（折行归渲染层）。
 *
 * **只做五样**（规格定死）：粗体 · 行内代码（**换色、不换背景**——省行高）· 代码块（缩进 ＋ 淡化、
 * **去围栏**）· 列表（保留符号、缩进对齐）· 标题（加粗、**去 `#`**）。
 * **其余留白**（首站保持原文）：表格 · 图片 · 嵌套引用；链接**只保留文字、URL 淡化**。
 *
 * **流式容忍**（规格定死的一条）——未闭合的 `**` / 反引号 / 围栏**先按字面显示**，闭合后转样式。
 * 做法是**逐行定夺、不做跨行累积状态**：任何「找不到闭合」的标记都退化成普通字符
 * ⇒ 同一段前缀在流式里怎么往后长，**它前面那些行的结果都一样**（不闪、不跳），
 * 也不必等定局才渲染。围栏那一处要有闭合才成块——见 `fenced` 的注。
 */

import { PALETTE, displayWidth } from './components/lines.ts'

/** 显示行里的一段（同段一个颜色）——与 `components/log.ts` 的 `Segment` 同形（那边只当它是色段）。 */
export type MdSegment = {
  readonly text: string
  readonly color?: string
  readonly bold?: boolean
}

/** 一条**显示行**——还没折行（宽度归渲染层）。 */
export type MdLine = {
  readonly segments: readonly MdSegment[]
  /**
   * **续行的悬挂缩进**（几列）——列表项靠它对齐到符号之后。
   * 不给就是普通正文（渲染层按默认缩进挂）。
   */
  readonly hang?: string
}

/** 行内代码的颜色——**换色不换背景**（背景要占行高，密度不划算）。 */
const CODE_COLOR = PALETTE.tool

/** 代码块的颜色——缩进之外再**淡化**一层。 */
const BLOCK_COLOR = PALETTE.dim

/** 代码块的缩进（去围栏后靠它认出来是块）。 */
const BLOCK_INDENT = '  '

/** 链接的 URL——**淡化**（文字留给读者，地址只是备查）。 */
const URL_COLOR = PALETTE.faint

/** 开围栏（```` ``` ```` / `~~~`，三个起步）。 */
const FENCE = /^\s*(`{3,}|~{3,})/

/** 标题——`#` 一到六个 ＋ 一个空白；**没有空白的不算**（`#话题` 是正文）。 */
const HEADING = /^\s*#{1,6}\s+(.*)$/

/** 列表项——`- ` / `* ` / `+ ` / `1. `；**后面要有空白**（`*强调*` 不算）。 */
const LIST = /^\s*(?:[-*+]|\d+\.)\s/

/** 链接——`[文字](地址)`；地址不含空白与括号（够用且不会误吞）。 */
const LINK = /^\[([^\]]*)\]\(([^()\s]*)\)/

/**
 * 正文 → 显示行。**纯函数**——同一段输入任何时候都是同一份结果（流式不闪不跳的底子）。
 */
export function markdown(source: string): readonly MdLine[] {
  const lines = source.split('\n')
  const out: MdLine[] = []
  let at = 0

  while (at < lines.length) {
    const line = lines[at] as string
    const fence = FENCE.exec(line)

    if (fence !== null) {
      const open = fence[1] as string
      const close = closingFence(lines, at + 1, open)

      if (close !== -1) {
        // 围栏闭合 ⇒ 成块：**围栏两行都不出现**，正文缩进 ＋ 淡化
        for (let body = at + 1; body < close; body += 1) out.push(codeLine(lines[body] as string))
        at = close + 1
        continue
      }
      // 未闭合（流式中／本来就没打算闭合）——**整行按字面**，围栏照旧可见
    }

    out.push(textLine(line))
    at += 1
  }

  return out
}

/** 一行**块外**正文——标题 / 列表 / 普通段落。 */
function textLine(line: string): MdLine {
  const heading = HEADING.exec(line)
  if (heading !== null) {
    // 标题：去 `#`、整行加粗（层级不影响首站的呈现——只去标记）
    return { segments: inline(heading[1] as string, true) }
  }

  const list = LIST.exec(line)
  if (list !== null) {
    // 列表：**符号原样留着**（`- ` / `1. ` 是它的形），续行挂到符号之后
    const marker = list[0]
    return { segments: inline(line), hang: ' '.repeat(displayWidth(marker)) }
  }

  return { segments: inline(line) }
}

/** 代码块里的一行——缩进 ＋ 淡化（**不带围栏**）。 */
function codeLine(line: string): MdLine {
  return { segments: [{ text: `${BLOCK_INDENT}${line}`, color: BLOCK_COLOR }] }
}

/**
 * 找闭合围栏——**同字符、不短于开围栏、整行只有它**（带信息的 `` ```ts `` 不算闭合）。
 * 找不到返回 `-1`：调用方按「未闭合」处理（流式里这是常态，不是错误）。
 */
function closingFence(lines: readonly string[], from: number, open: string): number {
  const char = open[0] as string

  for (let at = from; at < lines.length; at += 1) {
    const line = (lines[at] as string).trim()
    if (line.length < open.length) continue
    if (![...line].every((one) => one === char)) continue

    return at
  }

  return -1
}

/**
 * 行内——粗体 · 行内代码 · 链接；其余逐字照抄。
 *
 * **未闭合的标记一律退化成普通字符**（`**` / 反引号找不到闭合就原样留下）——
 * 这就是「流式期间先按字面显示」的那一条，也是**不闪**的来源：
 * 已经画出去的那几行不会因为后面又来了一段而改主意。
 *
 * `bold` 是**基底**（标题整行加粗走它）——但**代码段一律不加粗**：
 * 代码靠颜色认，不靠字重（与「换色不换背景」同一笔账）。
 */
function inline(text: string, bold = false): readonly MdSegment[] {
  const out: MdSegment[] = []
  let plain = ''
  let at = 0

  const flush = (): void => {
    if (plain !== '') out.push(bold ? { text: plain, bold: true } : { text: plain })
    plain = ''
  }

  while (at < text.length) {
    // 粗体 `**x**`——**空的不算**（`****` 是原文），找不到闭合也不算
    if (text.startsWith('**', at)) {
      const close = text.indexOf('**', at + 2)
      if (close > at + 2) {
        flush()
        out.push(...inline(text.slice(at + 2, close), true))
        at = close + 2
        continue
      }

      plain += '**'
      at += 2
      continue
    }

    // 行内代码 —— 反引号可以成串（`` ` `` / ` `` `），闭合要**等长**
    if (text[at] === '`') {
      const run = runOf(text, at, '`')
      const close = closeRun(text, at + run, '`', run)
      if (close !== -1) {
        flush()
        out.push({ text: text.slice(at + run, close), color: CODE_COLOR })
        at = close + run
        continue
      }

      plain += '`'.repeat(run)
      at += run
      continue
    }

    // 链接——保留文字、URL 淡化；**图片（`![…]`）不渲染**（首站留白），按原文
    if (text[at] === '[' && text[at - 1] !== '!') {
      const link = LINK.exec(text.slice(at))
      if (link !== null) {
        flush()
        const label = link[1] as string
        if (label !== '') out.push(...inline(label, bold))
        out.push({ text: `（${link[2] as string}）`, color: URL_COLOR })
        at += link[0].length
        continue
      }
    }

    plain += text[at]
    at += 1
  }

  flush()
  return out
}

// ══ 流式增量（U21 · 受控渲染）════════════════════════════════════════
//
// ## 为什么能增量
//
// `markdown()` 是**逐行定夺**的——同一个前缀，无论后面接什么，它前面那些行怎么长
// **结果都一样**（这条正是「流式不闪不跳」的底子，写在文件头注里）。唯一的跨行耦合是
// **围栏**：开围栏要找后面的闭合行，找不到就按字面。
//
// 于是「可以定稿的前缀」＝**不含「未闭合围栏」的那一段**：
//
// - 扫描只吃**完整行**（以 `\n` 结尾的那些）；遇到一道围栏而在已到的完整行里找不到闭合
//   ⇒ **就地停下**，那一段连同尾巴交给**全量的 `markdown()`** 现算（`O(未闭那段)`）；
// - 围栏一旦闭合 ⇒ 整块并入定稿前缀，此后不再重算；
// - 没有围栏的正文（散文那类）⇒ 定稿前缀一路推进到最后一个完整行，每帧只算**新加的那几行**。
//
// ⚠️ **判据不是「这一段对不对」，是「与全量逐字一致」**——`markdownStream` 与 `markdown`
// 对**同一个前缀**必须交出**同一串显示行**。它不是一句口头保证：
// `markdown.test.ts` 把一段会流式长出来的正文**每个前缀都比一遍**。
//
// ## 缓存归谁
//
// 状态按 `key`（＝那一条记录行的 `key`）存——正文只会往后长，故下次拿新正文进来时，
// 旧的那份**仍是新正文的前缀**（不是就当新的从头算）。键用完即弃由调用方管
// （`log.ts` 那边有个上限，见其注）。

/** 一条正文的流式解析状态。 */
type StreamState = {
  /** 上次算过的完整行（`split('\n')` 里除最后那个**可能不完整**的元素）。 */
  done: number
  /** `done` 条完整行对应的显示行——**定稿**，不再重算（只往后 `push`）。 */
  lines: MdLine[]
  /** 上次的正文（判「还是不是同一段在长」）。 */
  source: string
}

const streams = new Map<string, StreamState>()

/** 缓存条数上限——外壳同时只有一两条在长；给个上限是防长会话里攒着不放。 */
const STREAM_LIMIT = 16

export type MarkdownStream = {
  /** 全部显示行（定稿前缀 ＋ 尾巴）。 */
  readonly lines: readonly MdLine[]
  /** 其中前多少条是**定稿**的——`lines.slice(settled)` 才是每帧要重算的那一段。 */
  readonly settled: number
}

/**
 * 流式正文 → 显示行（`markdown` 的增量版）。
 *
 * 结果与 `markdown(source)` **逐字相同**，差别只在「算了多少」：定稿的那一段只算一次。
 */
export function markdownStream(key: string, source: string): MarkdownStream {
  const lines = source.split('\n')
  const complete = lines.length - 1 // 最后一个元素可能不完整——不进扫描

  const cached = streams.get(key)
  // 正文不再是「往后长」（换了内容 / 重放）⇒ 从头算——缓存只对「前缀」成立
  const state = cached !== undefined && source.startsWith(cached.source) ? cached : fresh(key)
  const grown = state.lines
  let done = state.done

  while (done < complete) {
    const line = lines[done] as string
    const fence = FENCE.exec(line)

    if (fence === null) {
      grown.push(textLine(line))
      done += 1
      continue
    }

    const open = fence[1] as string
    const close = closingFence(lines, done + 1, open)
    // 闭合行**本身也得是完整行**才吃进来（`close < complete`）——否则交给尾巴现算。
    // 保守那一档只是少赚一次增量，不会算错（尾巴走的是全量那条路）。
    if (close === -1 || close >= complete) break

    for (let body = done + 1; body < close; body += 1) grown.push(codeLine(lines[body] as string))
    done = close + 1
  }

  // **尾巴**——从 `done` 到末尾（含那个不完整的行）交给全量那条路：与 `markdown()` 同源，
  // 故「未闭合先按字面」那一条在这里自动成立，不另写一份。
  const tail = markdown(lines.slice(done).join('\n'))

  state.done = done
  state.source = source

  // ⚠️ **交出去的是副本**——`grown` 是缓存自己那份，还会被下一次 `push` 长出来；
  // 把同一个对象交出去，上一帧拿到的结果就会**背地里变**（快照那类消费者正中此刀）。
  return { lines: [...grown, ...tail], settled: grown.length }
}

/** 起一条新的流式状态（**重置**：把旧的丢掉）。 */
function fresh(key: string): StreamState {
  streams.delete(key)

  // 满了就丢最早那一条（`Map` 保序）——早就定稿的那些重算一次也不亏
  while (streams.size >= STREAM_LIMIT) {
    const oldest = streams.keys().next().value
    if (oldest === undefined) break
    streams.delete(oldest)
  }

  const state: StreamState = { done: 0, lines: [], source: '' }
  streams.set(key, state)

  return state
}

/** 从 `at` 起有几个连续的 `char`。 */
function runOf(text: string, at: number, char: string): number {
  let size = 0
  while (text[at + size] === char) size += 1

  return size
}

/** 找**等长**的闭合串（`` ``x`` `` 不能被单个反引号闭掉）——找不到返回 `-1`。 */
function closeRun(text: string, from: number, char: string, size: number): number {
  let at = from

  while (at < text.length) {
    if (text[at] !== char) {
      at += 1
      continue
    }

    const run = runOf(text, at, char)
    if (run === size) return at
    at += run
  }

  return -1
}
