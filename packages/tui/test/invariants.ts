/**
 * 三条不变量（U23）——**对屏幕矩阵说的话**，不是对视图说的话。
 *
 * ## 为什么是这三条
 *
 * 它们不是拍脑袋定的，是从**用户亲跑撞的三跤**里反推出来的最小集合：
 *
 * | 不变量 | 它守的那条缝 | 活体标本 |
 * | --- | --- | --- |
 * | **不重复** | 重绘擦不干净 / 一段内容被画两遍 | D11（`4737930`）· D13（`4ab8358`） |
 * | **不空行** | 每行多写一个换行 ⇒ 帧高算成一半 | D11（`4737930`） |
 * | **不溢出** | 渲染层自算的宽度 > 终端实际宽度 | `4737930` 的根 Box 写死 `width` |
 *
 * 三条都**只在屏上成立或不成立**——视图对象里分别叫「rows 数组没变」「一行一个元素」「宽度参数对」，
 * 全都合法。**这就是八百多个视图级用例一条都拦不住它们的原因。**
 *
 * ## 形状：找茬的返回清单，断言用 `expect`
 *
 * 三个函数都**不改不抛**，只把违例找出来（没违例＝空数组）。断言留给 `bun:test` 现成的
 * `expect(...).toEqual([])`——**不造 DSL**：失败时打印的是 bun 自己的深比较，
 * 违例对象里带着行号与原文，一眼看得出屏上哪儿坏了。
 *
 * ⚠️ **「记录区」是算出来的，不是写死的**：终端最后一屏的下半截是交互区与状态行
 * （输入框 / 分隔线 / 状态行），它们**本来就该有空行、本来就该有缩进**，拿记录区的尺子去量它们
 * 会满屏假红。分界取**最后一条满宽分隔线**（`AppView` 里有且只有这一条），
 * 这样不变量不必知道「交互区几行」——那是渲染层的账，多一行少一行都不该让这条尺子失灵。
 */

import type { Screen } from './terminal.ts'

/** 满宽分隔线——记录区与交互区之间那一条（整行都是 `─`，且铺满终端宽）。 */
function isSeparator(line: string, columns: number): boolean {
  return line.length >= columns - 1 && [...line].every((char) => char === '─')
}

/** 记录区的行（含行号）——**最后一条满宽分隔线之上**的部分；没有分隔线时取到最后一个非空行。 */
export function recordArea(screen: Screen): readonly { readonly row: number; readonly text: string }[] {
  const rows = screen.lines.map((text, row) => ({ row, text }))
  const divider = rows.filter((entry) => isSeparator(entry.text, screen.columns)).at(-1)

  if (divider !== undefined) return rows.slice(0, divider.row)

  // 还没画出分隔线（空态 / 只录了半屏）——到最后一个非空行为止，屏下的空白不算记录区
  const last = rows.filter((entry) => entry.text.trim() !== '').at(-1)

  return rows.slice(0, last === undefined ? 0 : last.row + 1)
}

// —— 一 · 不重复 ——

export type Duplicate = {
  /** 第几段内容重复了（`trim` 之后的原文）。 */
  readonly text: string
  /** 它出现在哪几行（按屏上的行号）。 */
  readonly rows: readonly number[]
}

/**
 * **不重复**——记录区里同一段非空内容不得出现两次。
 *
 * 判据为什么收得这么紧：记录区画的是「**这一趟发生过什么**」。同一句话在同一趟里出现两遍，
 * 只可能是**重绘残留**（旧帧没擦干净，新帧又画一遍）。
 * 合法的「同一句话出现两次」都不在这个区里，或者**带着不同的行首**：
 *
 * - 用户的交代有 `› ` 起头、助手的正文有 `⏺ ` 起头——**归一化后仍不同**（实测：真跑那一趟
 *   「只回四个字：甲乙丙丁」与「甲乙丙丁」正是这样分得开的）；
 * - 状态行里那个「会话标题＝首条消息」在**交互带**，被 `recordArea` 隔在外面。
 *
 * 比较用 `trim()`：残留副本带**续行缩进**（`hang`），按原文比会漏——D11 的残影正是
 * `甲乙丙丁`（第 6 行）与 `␣␣甲乙丙丁`（第 10 行）这一对。
 */
export function duplicates(screen: Screen): readonly Duplicate[] {
  const seen = new Map<string, number[]>()

  for (const { row, text } of recordArea(screen)) {
    const key = text.trim()
    if (key === '') continue
    seen.set(key, [...(seen.get(key) ?? []), row])
  }

  return [...seen.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([text, rows]) => ({ text, rows }))
}

// —— 二 · 不空行 ——

export type BlankRun = {
  readonly from: number
  readonly to: number
  /** 连续空行的条数（≥2 才算违例）。 */
  readonly count: number
}

/** 连续空行的上限——1 行是**分段**（用户消息之前那一条，原型 · 密度），2 行以上就是泄了。 */
const MAX_BLANK_RUN = 1

/**
 * **不空行**——记录区里连续的空白行不得超过 1 行。
 *
 * 为什么是 1 而不是 0：密度规则允许**用户消息之前留一行分段**（`needsSpacer`），
 * 那是设计要的呼吸。
 *
 * 判据**含记录区末尾的空**——内容与分隔线之间那一片也算数。这一条是**量过的**，
 * 不是想当然：
 *
 * ⚠️ **反证坐实的一件事（别把它当 D11 的哨兵）**——拿 `4737930` 的记录做对照实验，
 * **只摘掉那个多余的 `\\n`、其余一律不动**，重录之后屏上仍有 **12 行**连续空档
 * （带 bug 时反而是 7 行——内容被撑开、占掉了空档）。
 * ⇒ **那一片是旧全屏版面的留白（`Log` 铺满窗口 `flexGrow: 1`），不是那个换行的账。**
 *
 * ⚠️⚠️ **更要紧的一条（实测 · 别以为这条能拦 D11）**：D11 的逐行夹空行恰好是「**一行**」
 * （内容 / 空行 / 内容 …），正落在 `≤1` 的**边界内侧**。
 *
 * **反向验证的硬结果**——把 D11 那个多余的 `\n` **塞回当前代码**（其余一律不动），重录：
 *
 * ```text
 *  0|› 看看工作区里有什么|
 *  2|（思考）先列一下。|          ← 每行之间夹一个空行（1,3,5,…）
 *  4|⏺ 工作区基本为空：|
 *  6|  - README.md|
 * ```
 *
 * 屏上**确实坏了**（正是 D11 的形状），可**三条不变量一条都没红**：
 * 逐行都不同（不重复 ⋅ 空）· 每处空行恰好 1（不空行 ⋅ 空，`≤1` 放行）· 不溢出。
 * 原因是当前架构（`Static` ＋ 内联）下，那个换行**不再造成擦不干净的重复**——
 * 历史标本 `4737930` 里的重复来自**全屏版面的擦行**，而全屏已经拆了。
 *
 * ⇒ **这条规则守的是「成片空行」**（屏上连着好几行什么都没有、又不是设计要的），
 * **不是 D11 的哨兵**。要拦住上面那张屏，判据得收紧成「**空行只许出现在用户消息之前**」
 * （＝密度规则原文）。**这是判据定义，属规划侧裁，本轮按工单原样落 `≤1` 并记在回报「待决」。**
 */
export function blankRuns(screen: Screen): readonly BlankRun[] {
  const rows = recordArea(screen)
  const runs: BlankRun[] = []
  const blankAt = (at: number): boolean => (rows[at]?.text.trim() ?? '非空') === ''

  for (let at = 0; at < rows.length; at += 1) {
    if (!blankAt(at)) continue

    let end = at
    while (blankAt(end + 1)) end += 1

    const count = end - at + 1
    if (count > MAX_BLANK_RUN) {
      runs.push({ from: rows[at]?.row ?? 0, to: rows[end]?.row ?? 0, count })
    }

    at = end
  }

  return runs
}

// —— 三 · 不溢出 ——

export type Overflow = {
  readonly row: number
  /** 这一行被终端折出来的内容（折行点的**后半截**）。 */
  readonly text: string
}

/**
 * **不溢出**——屏上不许有「终端自己折出来的行」。
 *
 * 为什么只认这个形态：终端**从不报错**，宽了它只会默默折行。所以「一行太宽」在屏上
 * **唯一的证据**就是折行标记（`isWrapped`）——它意味着**上游把一个宽于终端的行交给了终端**。
 * 反过来，渲染层自己折好的行（哪怕折得再碎）**一个标记都不会有**：这正是判据干净的地方。
 *
 * ⚠️ 实测记录（省得日后有人以为这条是空的）：
 * **宽度一致时，当前实现结构性地溢出不了**——Ink 的布局会把每个文本节点折到盒宽，
 * 而盒宽＝终端宽。窄到 6 列都不折。这条守的是**两个宽度不一致**的那一类：
 * 渲染层自己算的宽度（`AppView` 的 `columns` 是**入参**）与终端实际宽度分家时
 * ——resize 那一瞬、或任何把 `columns` 传错的地方。`4737930` 的根 Box 写死
 * `width: columns`，正是这样把 120 宽的分隔线与状态行画进了 80 列的终端。
 */
export function overflows(screen: Screen): readonly Overflow[] {
  return screen.lines
    .map((text, row) => ({ row, text, wrapped: screen.wrapped[row] === true }))
    .filter((entry) => entry.wrapped)
    .map(({ row, text }) => ({ row, text }))
}
