/**
 * `web_search` —— **联网搜索：直接回逐条摘要，由主 Agent 综合**（U88 · U94）。
 *
 * DeepSeek Search 已提供与查询相关、供模型阅读的逐条 `summary`；本工具**不再**跑
 * 「搜 → 读页 → 综合」的内部循环，也不调用 Cantrip。一次调用只做三件事：
 *
 * 1. 校验 query（1–128 个 Unicode 字符，非全空白）；
 * 2. 把 query 发给固定网页服务（`need_content=false`，不取全文）；
 * 3. 按服务返回顺序组织逐条 `title / url / date / summary`。
 *
 * 主 Agent 依据摘要与当前任务综合回答；需要版本、代码或原文细节时**显式调用 `web_fetch`**。
 * 摘要不是页面全文——回执里写明这一点，避免把「服务摘要」误读成「已读原文」。
 *
 * ## 为什么没有辅助模型
 *
 * 取消工具内综合省去一次重复处理，也让 Search **不依赖 Cantrip**：未配置提炼模型
 * 只阻止 Fetch，搜索照常可用。
 */

import type { ToolSpec, WebSource } from '@magic/contracts'
import { WEB_SERVICE_HOST, searchReceiptOf } from '@magic/contracts'
import { defineTool } from './registry.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused } from './toolkit.ts'
import type { WebServiceRef } from './web-fetch-tool.ts'

/** query 的服务上界（DeepSeek Search 文档：1–128 个 Unicode 字符）。 */
export const WEB_SEARCH_MAX_QUERY_CHARS = 128

export const WEB_SEARCH_PARAMETERS = {
  type: 'object',
  description:
    '联网搜索：给一句简短的查询，回逐条搜索服务摘要与出处。' +
    '摘要不是页面全文——要某一页的细节用 web_fetch 取那一页。',
  properties: {
    query: {
      type: 'string',
      description: `要查什么——写给搜索服务的简明问题（1–${WEB_SEARCH_MAX_QUERY_CHARS} 个字符）`,
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const

/** 工具规格——名字 · 说明 · 参数 · 危险归类（外发 ⇒ 必闸）。 */
export const WEB_SEARCH_SPEC: ToolSpec = {
  name: 'web_search',
  summary: '联网搜索（一次查询 → 逐条摘要 → 由主 Agent 综合）',
  parameters: WEB_SEARCH_PARAMETERS,
  danger: { level: 'gated', reason: 'outbound' },
}

export type WebSearchDeps = {
  /** 每次调用现问一次——网页配置随时可能被改。 */
  readonly web: () => WebServiceRef
}

export function defineWebSearchTool(deps: WebSearchDeps): ToolDefinition {
  return defineTool<{ query: string }>({
    spec: WEB_SEARCH_SPEC,
    // 服务身份由装配写死；权限卡据此写清发往哪一台服务
    via: WEB_SERVICE_HOST,
    get unavailable() {
      const service = deps.web()
      return service.ok ? undefined : service.reason
    },

    prepare(args) {
      const query = args['query']
      if (typeof query !== 'string') throw new Error('参数错误：query 须为非空字符串')

      const trimmed = query.trim()
      const length = [...trimmed].length
      if (length === 0) throw new Error('参数错误：query 不得全是空白')
      if (length > WEB_SEARCH_MAX_QUERY_CHARS) {
        throw new Error(
          `参数错误：query 有 ${length} 个字符，超过服务的 ${WEB_SEARCH_MAX_QUERY_CHARS} 字符上限——` +
            '请改写成更短、更明确的搜索问题（不会替你截断）',
        )
      }

      return { query: trimmed }
    },

    async run({ query }, ctx): Promise<ToolRunResult> {
      const service = deps.web()
      if (!service.ok) return refused(service.reason)

      const searched = await search(service.web, query, ctx.signal)
      if (!searched.ok) return refused(searched.reason)

      if (searched.results.length === 0) {
        return { ok: true, output: '本次未找到匹配结果。' }
      }

      return {
        ok: true,
        output: searchReceiptOf({ query, results: searched.results }),
      }
    },
  })
}

/** 取消信号照端口姿势原样传下去；失败是返回值的一种。 */
function search(web: WebSource, query: string, signal: AbortSignal | undefined) {
  return web.search({ query }, signal === undefined ? {} : { signal })
}
