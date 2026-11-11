/**
 * **网页服务**（`WebSource` · U94）——两项网页工具共用的 DeepSeek 取材实现。
 *
 * 出处：需求 U94 与《DeepSeek 网页工具接入方案》。本文件只做**出网与结构校验**：
 *
 * - `fetchPage(url)` —— `POST /v1/tools/fetch`，返回标题与 Markdown 正文；
 * - `search(query)` —— `POST /v1/tools/search`（`need_content=false`），返回逐条资料。
 *
 * 提炼仍归工具域（Fetch 之后交 Cantrip 一次），综合归主 Agent；本文件**不调模型**。
 *
 * ## 网络边界
 *
 * 1. **页面地址仍走 `webTargetOf`**：`http` 升 `https`、`localhost` / 无点主机名 /
 *    IP 字面量在发请求之前就拒——判据与审批卡同源，不另写一套。
 * 2. **服务地址固定**：`https://api.deepseek.com`。不跟随重定向——凭据不能跟着
 *    一次跳转离开固定服务域；服务回 3xx 就如实报「未跟随」。
 * 3. **完整读取响应后才返回成功**；读取失败、超时或取消不返回半份正文。
 *
 * ## 值得信任的是这个服务，不是这段代码
 *
 * DeepSeek 负责抓取、跳转与正文提取；Magic 直接采用其成功响应，不预检、不复抓、
 * 不做原站完整性比对。Magic 自己负责的只有：完整接收 API 响应、解析合法 JSON、
 * 把非空 Markdown 全量交给下一次提炼，以及把传输中断与模型失败报成失败。
 */

import type { PageFetch, WebSearchItem, WebSearchOutcome, WebSource } from '@magic/contracts'
import { WEB_SERVICE_HOST, webTargetOf } from '@magic/contracts'

/** 缺省超时——一次取材请求用不到这么久。 */
export const WEB_FETCH_TIMEOUT_MS = 30_000

/** 页面地址的供应商上界——与 DeepSeek Fetch 文档一致（不截断，超了直接报）。 */
export const WEB_FETCH_MAX_URL_CHARS = 8192

/** 首版固定的服务地址（文档规定的 DeepSeek 官方服务）。 */
export const DEEPSEEK_WEB_ORIGIN = 'https://api.deepseek.com'

/** 两项工具的固定服务域——审批卡上的 `via`、授权匹配都读它（契约一处定）。 */
export const DEEPSEEK_WEB_HOST = WEB_SERVICE_HOST

export type WebSourceOptions = {
  /** 这条连接解析出来的凭据——缺省不发出请求（装配应在执行前报清来源问题）。 */
  readonly apiKey: string
  /** 取件实现——缺省全局 `fetch`（用例里换成桩，不出网）。 */
  readonly fetch?: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>) | undefined
  readonly timeoutMs?: number | undefined
}

export function createWebSource(options: WebSourceOptions): WebSource {
  const send = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_TIMEOUT_MS

  const request = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly json: unknown } | { readonly ok: false; readonly reason: string }> => {
    if (options.apiKey.trim() === '') {
      return { ok: false, reason: '网页服务连接缺少凭据——请在连接设置里填写 API Key，或设置对应的环境变量' }
    }

    const deadline = AbortSignal.timeout(timeoutMs)
    const merged = signal === undefined ? deadline : AbortSignal.any([signal, deadline])

    try {
      const response = await send(`${DEEPSEEK_WEB_ORIGIN}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey.trim()}`,
        },
        body: JSON.stringify(body),
        signal: merged,
      })

      // 凭据不跟着跳转离开固定服务域（见文件头注第 2 条）
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        return { ok: false, reason: `网页服务返回了跳转（HTTP ${response.status}）——未跟随；请检查服务地址` }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return { ok: false, reason: serviceErrorOf(response.status) }
      }

      const text = await response.text()
      try {
        return { ok: true, json: JSON.parse(text) }
      } catch {
        return { ok: false, reason: '网页服务返回的内容不是合法 JSON——传输可能中断，本次不作数' }
      }
    } catch (error) {
      return { ok: false, reason: `网页服务没有取到结果：${describe(error, timeoutMs)}` }
    }
  }

  return {
    async fetchPage(raw: string, opts): Promise<PageFetch> {
      const target = webTargetOf(raw)
      if (!target.ok) return { ok: false, reason: target.reason }
      if (target.url.length > WEB_FETCH_MAX_URL_CHARS) {
        return { ok: false, reason: `参数错误：归一后的 url 超过 ${WEB_FETCH_MAX_URL_CHARS} 字符，服务不接受` }
      }

      const got = await request('/v1/tools/fetch', { url: target.url }, opts?.signal)
      if (!got.ok) return got

      const body = asObject(got.json)
      if (body === undefined || typeof body['content'] !== 'string') {
        return { ok: false, reason: '网页服务返回的结构损坏（缺少 Markdown 正文）——本次不作数' }
      }
      const title = typeof body['title'] === 'string' ? body['title'] : ''

      return { ok: true, url: target.url, title, markdown: body['content'] }
    },

    async search(input, opts): Promise<WebSearchOutcome> {
      const got = await request(
        '/v1/tools/search',
        { query: input.query, need_content: false },
        opts?.signal,
      )
      if (!got.ok) return got

      const body = asObject(got.json)
      const rows = body?.['results']
      if (!Array.isArray(rows)) {
        return { ok: false, reason: '网页服务返回的结构损坏（缺少 results 数组）——本次不作数' }
      }

      const results: WebSearchItem[] = []
      for (const row of rows) {
        const item = asObject(row)
        const url = item?.['url']
        if (item === undefined || typeof url !== 'string' || url.trim() === '') {
          return { ok: false, reason: '网页服务返回的结果结构损坏（某一条缺少链接）——本次不作数' }
        }
        const title = item['title']
        const date = item['date']
        const summary = item['summary']
        if ((title !== undefined && title !== null && typeof title !== 'string')
          || (date !== undefined && date !== null && typeof date !== 'string')
          || (summary !== undefined && summary !== null && typeof summary !== 'string')) {
          return { ok: false, reason: '网页服务返回的结果结构损坏（字段类型不对）——本次不作数' }
        }

        results.push({
          title: typeof title === 'string' ? title : '',
          url,
          ...(typeof date === 'string' && date.trim() !== '' ? { date } : {}),
          ...(typeof summary === 'string' && summary.trim() !== '' ? { summary } : {}),
        })
      }

      return { ok: true, results }
    },
  }
}

/** HTTP 错误分类——只说明服务这一侧发生了什么，不断言原页面是否存在。 */
function serviceErrorOf(status: number): string {
  if (status === 400) return '网页服务拒绝了请求（HTTP 400）——参数不符合服务要求'
  if (status === 401) return '网页服务认证失败（HTTP 401）——请检查这条连接的密钥'
  if (status === 402) return '网页服务余额不足（HTTP 402）——请检查 DeepSeek 账户'
  if (status === 403) return '网页服务拒绝了这次请求（HTTP 403）——可能是权限或配额限制'
  if (status === 404) return '网页服务没有取到可用正文（HTTP 404）——这不代表原页面不存在'
  if (status === 429) return '网页服务限流（HTTP 429）——请稍后再试'
  if (status >= 500) return `网页服务暂时不可用（HTTP ${status}）——请稍后再试`
  return `网页服务返回失败（HTTP ${status}）`
}

/** 抛出来的原委——`AbortError` 说人话（它是「超时 / 被掐断」，不是「页面坏了」）。 */
function describe(error: unknown, timeoutMs: number): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `超过 ${timeoutMs / 1000} 秒没有回应（这一趟不再等）`
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '被中止'
    return error.message === '' ? error.name : error.message
  }
  return String(error)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
