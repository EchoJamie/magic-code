/**
 * 共享语言 · 搜索（U88）。
 *
 * 出处：设计 · 网页与搜索「两件工具」表的第二行，以及**「搜索的回执长什么样（2026-09-26 实测）」**
 * 那一节——那一节的形状是**本机 Claude CLI 四次真实调用逐字读出来的**，不是照着谁家的界面
 * 抄的。故这一单的份量在**把它钉住**：源还没定（设计「卡在哪一件上」：规划侧主张 Tavily，
 * 用户未表态）⇒ 接线等源定了再做，而**形状先从被忘掉里救出来**。
 *
 * 本文件只有**一样**（同 `web.ts` 的 `webTargetOf`：「一处定、两处用」的规则载体）：
 *
 * **`searchReceiptOf`——回执的成形**。它是**主模型真正读到的那一根字符串**：
 * 抬头 / 链接段 / 正文。消费它的有两处——那台**独立小服务**（`WebSearchService`，跑完查询、
 * 读过若干页、小模型综合完之后，出这一根）与**用例**（形状要逐字咬住）。两处各写一遍，
 * 就是两套「搜索的回执」——而形状恰好是这一单要钉住的那件东西。
 *
 * ⚠️ **成形在这一层，不在工具域**：服务将来落哪一域还没定（设计：「『服务』是进程内的一层
 * 组件，还是真起一个进程」待定，倾向进程内），而**域之间不互相 import**（域只 import
 * `@magic/contracts`）。放工具域里，服务那一侧就够不着。
 *
 * ## 形状（**逐字照实测那一节**）
 *
 * ```
 * Web search results for query: "<原查询>"
 *                                  ← 空行
 * Links: [{"title":"…","url":"…"}, …]
 *                                  ← 空行
 * <综合正文>
 * ```
 *
 * **一处实测里的东西不在这个形里**：末尾那句 `REMINDER: You MUST include the sources …`
 * ——它是**给模型的指令**（要求回答里带 markdown 链接），混在参照面的回执里。本文件
 * **不添它**：一是实测那一节把回执读成「抬头 / 链接段 / 正文」三段（那一句是第 ④ 段之后的
 * 尾巴，不属于搜到的东西）；二是「要不要要求模型带出处」是**提示词那一侧**的事，不该由
 * 回执成形这一层替它做主（成形只管搜到了什么）。这一条留在这儿备查——真要加，是这一处
 * 加一行。
 */

/**
 * 一条搜索结果——**标题 ＋ 地址**（出处：设计「两件工具」表：链接段就是这两件）。
 *
 * **链接数是服务那一侧的事**（实测那四次都是 10 条）——本面不收窄也不补齐：
 * 给几条就照几条成形。
 */
export type SearchLink = {
  /**
   * 标题——**拿不到就留空**（`"title":""`），**不补一句「无标题」**。
   *
   * 由头（设计「三条白拿的细节」第一条）：那四次真调用里**各有一条** `"title":""`。
   * 留空是**如实**——「没拿到标题」与「这一条本来就没有标题」是两件事；补一句
   * 「无标题」是把前一件说成了后一件，还多塞了三个字进上下文。
   *
   * **可选位**：缺席与空串同义（都是「没拿到」）——同一条口径不必两种写法。
   */
  readonly title?: string
  readonly url: string
}

/** 成形的入参三件——查询 ＋ 链接数组 ＋ 综合正文（工单 ② 的原话）。 */
export type SearchReceiptInput = {
  /** 模型/用户给的那句查询的**原话**（写法归一看 `searchReceiptOf`）。 */
  readonly query: string
  /** 服务读回来的链接（标题 ＋ 地址）——顺序照给。 */
  readonly links: readonly SearchLink[]
  /** **小模型综合出来的正文**——它可能带着套话（见 `PREAMBLE_PATTERNS`），成形这一层负责掐。 */
  readonly body: string
}

/** 抬头那一行的前缀——`Web search results for query: `（**英文、逐字**，实测第 ① 行）。 */
const SEARCH_RECEIPT_LEAD = 'Web search results for query: '

/** 链接段那一行的前缀——`Links: `，后面接的是那个 **JSON 数组字面量**（实测第 ③ 行）。 */
const SEARCH_LINKS_LEAD = 'Links: '

/**
 * **小模型的开场白**——成形这一层**不许**把它放进回执。
 *
 * 由头（设计「三条白拿的细节」第三条，⚠️ 原话）：实测四次的回执里**四次全有**这一类句子
 * （`I'll search for information about X.` / `I'll perform a web search for that query.`），
 * 「**没有任何信息量**」——它是**提炼那一步漏出来的噪声**，不是这一趟搜到的东西。
 *
 * ## 判法只掐**开头那一截**
 *
 * 「开场白」三个字就是这个意思：**从正文起头连着掐**，一旦碰到一句不像的，**后面再也不看**
 * ——正文中段里出现同样一句，那是**搜到的内容在引它**，一个字都不许动。
 *
 * ⚠️ **这一份是要长的一张表**（一处定）：真跑起来撞见新的套话，**往这里加一条**即可，
 * 不必去动成形那一段。今天这两条是照实测那两句的形写的（第一人称 ＋ 宣告要去搜）。
 */
const PREAMBLE_PATTERNS: readonly RegExp[] = [
  // `I'll search for information about X.` · `I'll perform a web search for that query.`
  /^i(?:'|’)?(?:ll| will)\b[^\n]*\b(?:search|look\s+up)\b/iu,
  // 同一族（把自己叫起来那一路）——同一条由头：它是宣告，不是搜到的东西。
  /^let me\b[^\n]*\b(?:search|look\s+up)\b/iu,
]

/**
 * 回执 —— **抬头 / 空行 / 链接段 / 空行 / 正文**（见文件头注那张图）。
 *
 * ## 三处成形的分寸
 *
 * - **抬头里的查询**：**归一空白**（前导尾随掐掉、行内的换行与连续空白并成一个空格）。
 *   抬头是一行的形（实测那四次都是），而查询里真会出现换行（多行粘贴）；不归一，
 *   那一行当场被拆成两行，形状就断了。**除此之外一个字不改**——引号照原样、中英照原样
 *   （实测就是拿原查询直接放进这对引号里）。
 * - **链接段**：`JSON.stringify` 出来的**紧凑数组字面量**（不缩进、不加空格），键序
 *   照实测是 `title` 在前、`url` 在后，且**只有这两把键**——源那一侧多给的字段
 *   （相关度 · 日期 ……）**一个都不进回执**（形状是逐字钉住的，多一把键就多一份要
 *   重新定的东西）。**标题缺席 / 全是空白 ⇒ `""`**（见 `SearchLink`）。
 * - **正文**：先掐掉开头那一截套话（`PREAMBLE_PATTERNS`），再首尾去白。
 *   **掐完什么都不剩 ⇒ 那一段整个不出现**（不添一个空行、更不补一句「无正文」——
 *   同「空标题留空」那一条：没有的东西不编出来占位）。
 */
export function searchReceiptOf(input: SearchReceiptInput): string {
  const head = `${SEARCH_RECEIPT_LEAD}"${headlineOf(input.query)}"`
  const links = `${SEARCH_LINKS_LEAD}${JSON.stringify(input.links.map(linkOf))}`
  const body = stripPreamble(input.body)

  return body === '' ? `${head}\n\n${links}` : `${head}\n\n${links}\n\n${body}`
}

/** 抬头里那一句查询的写法——**只归一空白**（见 `searchReceiptOf` 那一格分寸）。 */
function headlineOf(query: string): string {
  return query.trim().replace(/\s+/gu, ' ')
}

/** 链接段里的一条——**标题缺席 / 全是空白 ⇒ 空串**（`"title":""`，不编一句「无标题」）。 */
function linkOf(link: SearchLink): { readonly title: string; readonly url: string } {
  return { title: link.title?.trim() ?? '', url: link.url }
}

/**
 * 掐掉正文开头那一截套话——**只掐开头，碰到第一句不像的就收手**（见 `PREAMBLE_PATTERNS`）。
 *
 * 前导空行一并吃掉：正文与链接段之间的那个空行由 `searchReceiptOf` 自己摆，正文里再来
 * 一截前导空白，屏上就成了两三个空行。
 */
function stripPreamble(body: string): string {
  const lines = body.split('\n')
  let start = 0

  while (start < lines.length) {
    const line = lines[start]?.trim() ?? ''
    if (line !== '' && !PREAMBLE_PATTERNS.some((pattern) => pattern.test(line))) break
    start += 1
  }

  return lines.slice(start).join('\n').trim()
}
