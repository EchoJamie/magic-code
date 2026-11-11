/**
 * diff 渲染件（U20）——**改了什么，看得见**。
 *
 * 出处：`对表.md`·阶段 3 差距 1（diff 审阅）＋ B7（首站＝**unified**：`+`/`−` 行；
 * 不做 side-by-side、**不引语法高亮**——「少而稳」的依赖纪律）＋ B8（就近渲染已知形态）。
 *
 * 两件事，两条路：
 * - **认**（`diffRowsOf`）——工具输出里**本来就是** diff 文本（`exec` 跑 `git diff` 那类）；
 * - **推**（`replaceDiff`）——`edit` 的参数里只有 `old` / `new` 两段文本（**没有文件全文**），
 *   由它们推出「这一处改了什么」——这正是「改了文件看不见改了什么」那个差距的落点。
 *
 * ⚠️ **不编行号**——`@@ -12,3 +12,4 @@` 要**文件全文**才数得出，而 `edit` 的参数里没有全文。
 * 故**推出来的**那一段不带 `@@` 头（认出来的那种自带，原样留着）；拿不到的不编。
 *
 * 本文件是**纯的**（无 Ink、无状态）——色由调用方按 `kind` 挂（`components/log.ts`）。
 */

/** 一段 diff 里一行的分档。 */
export type DiffKind =
  /** 增行（`+`）。 */
  | 'add'
  /** 删行（`-`）。 */
  | 'del'
  /** 上下文行（行首一个空格）——不是改动，是「改动在哪儿」的坐标。 */
  | 'context'
  /** 块头（`@@ … @@`）。 */
  | 'hunk'
  /** 结构行（`diff --git` · `index` · `---` · `+++` · `\ No newline`）——不是内容的行。 */
  | 'meta'

export type DiffRow = {
  readonly kind: DiffKind
  /** **原行**（含 `+`/`-` 那个标记）——渲染时原样上屏，只换色。 */
  readonly text: string
}

/** 推出来的上下文每侧最多留几行（unified 的老规矩：3）。 */
const CONTEXT = 3

/**
 * 这段文本**是不是**一段 unified diff——判据取**块头 `@@`**。
 *
 * 为什么不用「有没有 `+` / `-` 起头的行」：那会误伤一大片——markdown 的列表（`- 一条`）、
 * `---` 分隔线、甚至命令行里的加减号，都长得像。而 `@@` 是 diff **独有的**块头
 * （`git diff` / `diff -u` 都出），认它不误伤。
 *
 * 已知限度（照实记）：**没有 `@@` 的 diff 认不出**（比如只截了后半段、或二进制文件的
 * `Binary files … differ`）——那类就按原文铺（B8：不做全量，保持原文是允许的落法）。
 */
export function looksLikeDiff(lines: readonly string[]): boolean {
  return lines.some((line) => line.startsWith('@@'))
}

/** 逐行分档——不认得的行按 `meta` 走（原文照上屏，只是退到最弱色）。 */
export function diffRowsOf(lines: readonly string[]): readonly DiffRow[] {
  return lines.map((text) => ({ kind: kindOf(text), text }))
}

/** 一行的档——次序要紧：`+++` / `---` 是结构行，别被 `+` / `-` 抢了先。 */
function kindOf(text: string): DiffKind {
  if (text.startsWith('@@')) return 'hunk'
  if (text.startsWith('+++') || text.startsWith('---')) return 'meta'
  if (text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('\\')) return 'meta'
  if (text.startsWith('+')) return 'add'
  if (text.startsWith('-')) return 'del'
  if (text.startsWith(' ')) return 'context'

  return 'meta'
}

/**
 * `old` → `new` 这一处改动**推**成 unified diff 的行。
 *
 * 三样都不编：
 * - **不编行号**——`@@` 头不出（文件全文不在参数里，见文件头注）；
 * - **不编未改动的内容**——公共的首尾只作**上下文**出现（每侧最多 `CONTEXT` 行），
 *   其余照实略去（略去不是丢，是「这次改动不涉及」）；
 * - **不编「改得多好」**——只按行分增减，不做字符级的差异（那才是 side-by-side 的活）。
 *
 * 两个地方要说明白：
 * - 逐行比对是**朴素**的（公共前缀 ＋ 公共后缀）；`edit` 的语义是「把这一段换成那一段」，
 *   两段多半同头同尾（模型会给足上下文），故朴素法在这一处够用且**不会认错**；
 * - `old` / `new` 为空串时按「没有行」算（纯删 / 纯增）——`split('\n')` 会给出一个空串元素，
 *   那不是一行。
 */
export function replaceDiff(oldText: string, newText: string): readonly DiffRow[] {
  const before = splitLines(oldText)
  const after = splitLines(newText)
  const head = commonHead(before, after)
  const tail = commonTail(before, after, head)

  const removed = before.slice(head, before.length - tail)
  const added = after.slice(head, after.length - tail)
  if (removed.length === 0 && added.length === 0) return [] // 一模一样＝没有可画的

  const rows: DiffRow[] = []
  for (const line of before.slice(Math.max(0, head - CONTEXT), head)) rows.push({ kind: 'context', text: ` ${line}` })
  for (const line of removed) rows.push({ kind: 'del', text: `-${line}` })
  for (const line of added) rows.push({ kind: 'add', text: `+${line}` })
  for (const line of before.slice(before.length - tail, before.length - tail + CONTEXT)) {
    rows.push({ kind: 'context', text: ` ${line}` })
  }

  return rows
}

/** 文本 → 行。空串＝**没有行**（不是「一个空行」）；末尾那个换行不算一行。 */
function splitLines(text: string): readonly string[] {
  if (text === '') return []

  const lines = text.split('\n')

  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

/** 公共前缀的长度。 */
function commonHead(before: readonly string[], after: readonly string[]): number {
  let at = 0
  while (at < before.length && at < after.length && before[at] === after[at]) at += 1

  return at
}

/** 公共后缀的长度（**不越过头**——全是公共行时它得让位给「没有改动」那个结论）。 */
function commonTail(before: readonly string[], after: readonly string[], head: number): number {
  let at = 0
  const most = Math.min(before.length, after.length) - head

  while (
    at < most &&
    before[before.length - 1 - at] === after[after.length - 1 - at]
  ) {
    at += 1
  }

  return at
}
