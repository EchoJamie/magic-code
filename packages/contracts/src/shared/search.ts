/**
 * 共享语言 · 搜索回执（U88 · U94）。
 *
 * 出处：设计 · 网页与搜索「两件工具」表的第二行。U94 起搜索**不再由源侧综合**：
 * DeepSeek Search 返回逐条 `title / url / date / summary`，主 Agent 结合当前任务综合。
 * 本文件把「哪些字段、缺了怎么说、按什么顺序」钉在一处——工具域只把结果递进来。
 *
 * 形状（U94 定稿）：
 *
 * ```
 * Web search results for query: "<原查询>"
 *                                  ← 空行
 * 结果：N 条 · 搜索服务摘要（不是页面全文；需要细节用 web_fetch 取那一页）
 *                                  ← 空行
 * 1. 标题：…
 *    链接：…
 *    日期：…（未知就写「未知」）
 *    摘要：…（缺就写「该条未提供摘要」）
 * ```
 *
 * 三条分寸：
 * - **标题未知留空**——`标题：` 后面什么都不写，不补一句「无标题」；
 * - **日期未知保持未知**、**摘要缺失如实标明**——缺的是资料，不是「没有这件事」；
 * - **不编造、不按评分删结果**——服务给几条就照几条，顺序照给。
 */

/**
 * 一条搜索结果——服务回来的原始资料（U94）。
 *
 * `title` 缺席与空串同义（都是「没拿到」）；`date` / `summary` 缺席＝服务没给。
 */
export type SearchItem = {
  readonly title?: string
  readonly url: string
  readonly date?: string
  readonly summary?: string
}

/** 成形的入参——查询原话 ＋ 逐条结果（顺序照服务给）。 */
export type SearchReceiptInput = {
  /** 模型给的那句查询的**原话**（抬头只归一空白，其余照原样）。 */
  readonly query: string
  /** 服务读回来的逐条资料。 */
  readonly results: readonly SearchItem[]
}

/** 抬头那一行的前缀——`Web search results for query: `（沿用 U88 实测形状）。 */
const SEARCH_RECEIPT_LEAD = 'Web search results for query: '

/**
 * 回执成形——**抬头 / 条数与边界 / 逐条**。
 *
 * 抬头里的查询只归一空白（换行会拆断那一行）；其余一个字不改。
 * 「不是页面全文」与「需要细节用 web_fetch」是给主模型的边界：摘要可能不是完整页面。
 */
export function searchReceiptOf(input: SearchReceiptInput): string {
  const head = `${SEARCH_RECEIPT_LEAD}"${headlineOf(input.query)}"`
  const count = `结果：${input.results.length} 条 · 搜索服务摘要（不是页面全文；需要细节用 web_fetch 取那一页）`
  const items = input.results.map((item, index) => itemLines(item, index + 1).join('\n'))

  return `${head}\n\n${count}${items.length === 0 ? '' : `\n\n${items.join('\n\n')}`}`
}

/** 抬头里那一句查询的写法——**只归一空白**。 */
function headlineOf(query: string): string {
  return query.trim().replace(/\s+/gu, ' ')
}

/** 一条结果的四行——缺字段如实标明（见文件头注三条分寸）。 */
function itemLines(item: SearchItem, index: number): readonly string[] {
  const title = item.title?.trim() ?? ''
  const date = item.date?.trim() ?? ''
  const summary = item.summary?.trim() ?? ''

  return [
    `${index}. 标题：${title}`,
    `   链接：${item.url}`,
    `   日期：${date === '' ? '未知' : date}`,
    `   摘要：${summary === '' ? '该条未提供摘要' : summary}`,
  ]
}
