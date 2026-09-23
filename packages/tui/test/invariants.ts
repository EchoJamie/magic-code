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
 * 会满屏假红。分界取**上面那条满宽分隔线**（`dividerAt`；U45 起下面还有一条，见 `footerAt`），
 * 这样不变量不必知道「交互区几行」——那是渲染层的账，多一行少一行都不该让这条尺子失灵。
 */

import type { Screen } from './terminal.ts'

/** 满宽分隔线——记录区与交互区之间那一条（整行都是 `─`，且铺满终端宽）。 */
function isSeparator(line: string, columns: number): boolean {
  return line.length >= columns - 1 && [...line].every((char) => char === '─')
}

/**
 * 分隔线的行号——**记录区与交互区之间那一条**（**第一条**满宽 `─`）。
 * 还没画出来（只录了半屏 / 空档）＝ `-1`。
 *
 * ⚠️ **取第一条，不是最后一条**（U45）：`AppView` 起有**两条**分隔线——上面那条划的是
 * 记录区与交互区的界，下面那条（交互区下沿）把「输入行 ＋ 状态行」从底下封住。
 * 拿最后一条当界，`recordArea` 就会把**整个交互区与状态行**算进记录区
 * （`blankRuns` / `duplicates` 那几条当场满屏假红）。底下那一条归 `footerAt`。
 */
export function dividerAt(screen: Screen): number {
  return screen.lines.findIndex((line) => isSeparator(line, screen.columns))
}

/**
 * **下沿那条分隔线**的行号（U45）——**最后一条**满宽 `─`；一条都没有时 `-1`。
 *
 * 与 `dividerAt` 成对：`dividerAt` 之上是记录区，两条之间是交互区 ＋ 状态行
 * （`screen.ts` 的 `Frame.dock` 正是这么切的）。
 */
export function footerAt(screen: Screen): number {
  return screen.lines.findLastIndex((line) => isSeparator(line, screen.columns))
}

/** 记录区的行（含行号）——**第一条满宽分隔线之上**的部分；没有分隔线时取到最后一个非空行。 */
export function recordArea(screen: Screen): readonly { readonly row: number; readonly text: string }[] {
  const rows = screen.lines.map((text, row) => ({ row, text }))
  const divider = dividerAt(screen)

  if (divider !== -1) return rows.slice(0, divider)

  // 还没画出分隔线（只录了半屏）——到最后一个非空行为止，屏下的空白不算记录区
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
 * **不是 D11 的哨兵**。
 *
 * ⚠️ **第 2 轮的裁决与落法**（规划侧 2026-09-19）：不放宽 `≤1`，而是**加一条收紧的**
 * ——见下面的 `entryBlanks`（「不夹空行」）：**同一条目之内，空行数不许超过原文的段落分隔数**。
 * 两条各守一头，本文件里别把 `blankRuns` 当 D11 的哨兵用：
 * - `blankRuns`——**不认场景**（任何屏都能量），守「成片空行」；
 * - `entryBlanks`——**认场景原文**，守「那个换行把每行都撑开了」。**D11 归它管。**
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

// —— 二之二 · 不夹空行（「不空行」的收紧形） ——

/**
 * 场景声明的一条内容——**原文**（外壳收到什么，就是什么）。
 *
 * `marker` 是渲染层给这一条加的行首（`› ` 用户 · `⏺ ` 助手 · `（思考）` 思考…）——
 * 屏上靠它把条目切出来。**原文由场景提供**是这条判据成立的前提：
 * 「空行多不多」没有绝对的答案，**要看原文本来有几个段落分隔**。
 */
export type EntrySpec = {
  readonly marker: string
  readonly text: string
}

export type EntryBlock = {
  readonly marker: string
  readonly text: string
  /** 这一条在屏上占的行（首 → 末，含尾部空行）。 */
  readonly from: number
  readonly to: number
  /**
   * 屏幕：这一条**内部**有几个空行（掐掉首尾的空）。
   *
   * ⚠️ **只数内部**，与 `paragraphBreaks` 对齐——两边口径不一致就不叫「对得上」。两条理由都是实的：
   * - **尾部那一行空不归它**：`needsSpacer` 那一条合法分段（用户消息之前）落在**上一条的尾部**，
   *   算进来就会让任何两条用户消息的场景**假红**；
   * - **旧全屏版面的留白同理**（`Log` 铺满窗口，末条与分隔线之间那一片是版面，不是这一条多写的）。
   */
  readonly blanks: number
  /** 原文：这一条本来有几个**段落分隔**（内部的空行）。 */
  readonly allowed: number
}

/**
 * 原文里的**段落分隔数**——**内部**的空行个数。
 *
 * ⚠️ 三个界定，都是量出来的：
 * - **只数内部**（首个非空行到末个非空行之间）：首尾的空行不是「段落分隔」。
 *   这一条直接决定 `leadblank` 那一形——正文原文是 `\n\n甲乙丙丁`，前导两个换行
 *   **本来就该被渲染层去掉**（`trimBlank`），若把它们算进预算，判据就白送 2 个空行的额度。
 * - **空行＝`trim()` 后为空的行**：`  ` 那种只有缩进的行也算空——它在屏上就是一行空白。
 * - **单个 `\n` 不算段落分隔**：那是同一段里的折行（`- README.md\n- packages` 是一段列举，
 *   不是两个段落）。这一条是判据能咬住 D11 的关键——见 `entryBlanks`。
 */
export function paragraphBreaks(text: string): number {
  const lines = text.split('\n')
  const first = lines.findIndex((line) => line.trim() !== '')
  const last = lines.findLastIndex((line) => line.trim() !== '')

  if (first === -1) return 0

  return lines.slice(first, last + 1).filter((line) => line.trim() === '').length
}

/**
 * 把记录区按场景声明的条目**切块**——找到每条的行首标记，块到**下一条的行首**为止
 * （末条到记录区末尾）。
 *
 * 找不到的条目**不进结果**（不是这条判据的事：那是「该画的没画」，归别的面）。
 * 正因如此，**用它的用例必须另外断言「找到的条数＝声明的条数」**——
 * 否则标记写错一个字母，这条判据就成了空转（实测踩过的教训：判据要自己先证明不是空的）。
 */
export function entryBlocks(screen: Screen, entries: readonly EntrySpec[]): readonly EntryBlock[] {
  const rows = recordArea(screen)
  const located: { readonly spec: EntrySpec; readonly at: number }[] = []
  let cursor = 0

  for (const spec of entries) {
    const at = rows.findIndex((row, index) => index >= cursor && row.text.trim().startsWith(spec.marker))
    if (at === -1) continue

    located.push({ spec, at })
    cursor = at + 1
  }

  return located.map((entry, order) => {
    const end = located[order + 1]?.at ?? rows.length
    const block = rows.slice(entry.at, end)
    // 内部＝首个非空行到末个非空行之间（尾部空行不归这一条，见 `EntryBlock.blanks` 的注）
    const first = block.findIndex((row) => row.text.trim() !== '')
    const last = block.findLastIndex((row) => row.text.trim() !== '')
    const inside = first === -1 ? [] : block.slice(first, last + 1)

    return {
      marker: entry.spec.marker,
      text: entry.spec.text,
      from: block[0]?.row ?? 0,
      to: block.at(-1)?.row ?? 0,
      blanks: inside.filter((row) => row.text.trim() === '').length,
      allowed: paragraphBreaks(entry.spec.text),
    }
  })
}

/**
 * **不夹空行**——同一条目之内，空行数**不许超过**原文的段落分隔数。
 *
 * 这是「不空行」的**收紧形**（第 2 轮 · 规划侧裁决）：`blankRuns` 的 `≤1`
 * 拦不住 D11 的新形态，因为它每处空行**恰好一个**，正落在边界内侧。
 *
 * | 情形 | 屏上空行 | 原文段落分隔 | 判 |
 * | --- | --- | --- | --- |
 * | 正常（D11 修后） | 0 | 0 | ✓ |
 * | **D11 的新形态**（每行夹一个空行） | 条目内**每行一个** | 原文**一个都没有**（都是单个 `\n`） | **红** |
 * | **D19**（该留的段落空行照留） | 与原文相等 | 1 | ✓ |
 *
 * **为什么是上界（不许超过）而不是相等**：渲染层**有权去掉**原文首尾的空行
 * （`trimBlank`——模型爱给 `\n\n` 前缀，那是噪声不是段落）。去掉是好事，不该判红；
 * **凭空多出来**才是坏。⇒ 上界。D19 那一侧走的是「相等」，自然也落在上界之内。
 *
 * **为什么用原文当尺子**：屏上「空行多不多」**没有绝对答案**——纯看屏，
 * 「条目之间夹一行」和「正文本来就有两个段落」长得一模一样。原文是唯一能分清这两者的东西，
 * 而场景**本来就知道**它喂进去的是什么（`record.ts` 的 `SCENARIOS`）。
 */
export function entryBlanks(screen: Screen, entries: readonly EntrySpec[]): readonly EntryBlock[] {
  return entryBlocks(screen, entries).filter((block) => block.blanks > block.allowed)
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
