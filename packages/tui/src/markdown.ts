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
