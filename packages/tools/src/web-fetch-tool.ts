/**
 * `web_fetch` —— **取网页：DeepSeek 代读 → Markdown 缓存 → 按问题提炼 → 只交答案**（U72 · U94）。
 *
 * ## 链路（U94 定稿）
 *
 * `参数准备 → 权限裁决 → DeepSeek Fetch → Markdown 缓存 → Cantrip 按 prompt 一次提炼 → 答案与来源`
 *
 * - DeepSeek 是**可信任的代读服务**：抓取、跳转与正文提取由它完成，Magic 直接采用其成功
 *   返回的 Markdown——不预检、不复抓、不做原站完整性比对，也没有本地回退。
 * - DeepSeek 只收 `{url}`；`prompt` 留在 Magic，随后交给配置的 Cantrip。
 * - 收到完整合法 JSON 与非空 Markdown 后才进入提炼；正文按结构完整进入**同一次**请求。
 * - 缓存 15 分钟原始 Markdown，每次按当前问题重新提炼。
 *
 * ## 回执为什么不报原站状态
 *
 * 新接口没有原站状态码 / 字节数 / 最终 URL。编一个「200」会让模型把服务成功读成
 * 「原站亲口说 200」——那正是这张回执不该给的确定性。故回执只报服务来源、请求地址、
 * 缓存事实与提炼模型，并明说「不是原文」。
 */

import type { PageDistiller, WebSource } from '@magic/contracts'
import { WEB_CACHE_TTL_MS, WEB_SERVICE_HOST, webTargetOf } from '@magic/contracts'
import { isText } from './args.ts'
import { defineTool } from './registry.ts'
import type { ToolDefinition, ToolRunResult } from './registry.ts'
import { refused } from './toolkit.ts'

/** 缓存条数上限——**短时缓存**，不是资料库。 */
export const WEB_CACHE_MAX_ENTRIES = 32

/**
 * 装配在**每次调用开始时**给的网页服务读数（U94）。
 *
 * `ok: false` 带的是**给模型看的一句话**：未配置 / 缺凭据 / 引用已失效。两项网页工具
 * 据此决定是否送进模型工具表（`unavailable`），在途旧调用也能拿到同一条原因。
 *
 * `scope` 是缓存的身份：连接或凭据作用域一变，旧页面就不再命中（换连接不串缓存）。
 */
export type WebServiceRef =
  | { readonly ok: true; readonly web: WebSource; readonly provider: string; readonly scope: string }
  | { readonly ok: false; readonly reason: string }

export type WebFetchDeps = {
  /** **每次调用现问一次**——网页配置随时可能被改；工具是造一次、用一路的。 */
  readonly web: () => WebServiceRef
  /**
   * 提炼面——每次调用现问一次（理由同上）。返回 `undefined` ＝ Cantrip 此刻还没配
   * （只影响 Fetch，不影响 Search）。
   */
  readonly distiller?: (() => PageDistiller | undefined) | undefined
  /** 时钟——缓存与耗时都据它（用例里钉住时间）。 */
  readonly now?: (() => number) | undefined
}

/** 缺少 Cantrip 时就地收束，给出真实设置入口。 */
const NOT_CONFIGURED = [
  'Cantrip 尚未配置——去 /model → 模型档位设置',
  '这一趟取不到答案，这一轮就停在这儿：不拿别的模型顶上，也不绕道去抓原文。',
  '配好之后接着说一句就能继续。',
].join('\n')

export const WEB_FETCH_PARAMETERS = {
  type: 'object',
  description:
    '取一个网页，按你的问题把答案挑出来——只回答案，不把整页原文塞进上下文。' +
    '页面由网页服务代读；要页面原文时不要用它，改用 exec 跑 curl。',
  properties: {
    url: {
      type: 'string',
      description: '要取的网页地址（http 一律按 https 取；本机地址与没有点的主机名取不了）',
    },
    prompt: {
      type: 'string',
      description: '你要知道什么——这一趟就按它从这一页里挑答案',
    },
  },
  required: ['url', 'prompt'],
  additionalProperties: false,
} as const

/** 缓存里的一页——**服务取回来并转好 markdown 的那一份**（不是答案：答案随问题变）。 */
type CachedPage = {
  readonly at: number
  readonly url: string
  readonly title: string
  readonly markdown: string
}

export function defineWebFetchTool(deps: WebFetchDeps): ToolDefinition {
  const now = deps.now ?? Date.now
  /** 键＝`scope \\0 url`——连接 / 凭据作用域变了，旧条目自然不再命中。 */
  const cache = new Map<string, CachedPage>()
  /** 当前连接 / 凭据作用域——一变就把旧作用域的清掉（不在内存里留别人的页面）。 */
  let cachedScope: string | undefined

  const pageOf = async (
    service: WebServiceRef & { readonly ok: true },
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly ok: true; readonly page: CachedPage; readonly hit: boolean } | { readonly ok: false; readonly output: string }> => {
    if (cachedScope !== service.scope) {
      cache.clear()
      cachedScope = service.scope
    }
    const key = `${service.scope}\u0000${url}`
    const cached = cache.get(key)
    if (cached !== undefined && now() - cached.at < WEB_CACHE_TTL_MS) {
      // 顺手挪到末尾——`Map` 的插入序就是这里用的 LRU
      cache.delete(key)
      cache.set(key, cached)
      return { ok: true, page: cached, hit: true }
    }

    const fetched = await service.web.fetchPage(url, signal === undefined ? {} : { signal })
    if (!fetched.ok) return { ok: false, output: fetched.reason }

    const page: CachedPage = {
      at: now(),
      url: fetched.url,
      title: fetched.title,
      markdown: fetched.markdown,
    }

    cache.set(key, page)
    // 满了就把最早那一条挤掉——缓存只为省一次取回，不承担留存
    if (cache.size > WEB_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined && oldest !== key) cache.delete(oldest)
    }

    return { ok: true, page, hit: false }
  }

  return defineTool<{ url: string; prompt: string }>({
    spec: {
      name: 'web_fetch',
      summary: '取网页（服务代读 → 按问题提炼 → 只回答案）',
      parameters: WEB_FETCH_PARAMETERS,
      // **声明的是方向**（外发 ⇒ 必闸）；判定与「总是允许按 {目标域 × 中转域}」都在权限域
      danger: { level: 'gated', reason: 'outbound' },
    },
    // **服务身份由装配写死**，模型自报不作数；审批卡据此写清「谁去取」
    via: WEB_SERVICE_HOST,
    get unavailable() {
      const service = deps.web()
      return service.ok ? undefined : service.reason
    },

    prepare(args) {
      const url = args['url']
      if (!isText(url)) throw new Error('参数错误：url 须为非空字符串')

      const prompt = args['prompt']
      if (!isText(prompt)) throw new Error('参数错误：prompt 须为非空字符串')

      // **发请求之前就拒**——本机地址 / 无点主机名 / 非 http(s) 一律取不得
      const target = webTargetOf(url)
      if (!target.ok) throw new Error(target.reason)

      return { url: target.url, prompt }
    },

    async run({ url, prompt }, ctx): Promise<ToolRunResult> {
      // 网页服务未配置 / 缺凭据：零出网。这一类调用通常已被 `unavailable` 挡在工具表外，
      // 这里兜住已在途的旧调用。
      const service = deps.web()
      if (!service.ok) return refused(service.reason)

      // ⚠️ **没配提炼模型：这一轮停住**——拦在取回之前：这一趟注定提炼不了，
      // 那一次取回就不必发出去。`halt` 让循环**不开下一轮**：不能改用 `exec curl` 绕过。
      const distiller = deps.distiller?.()
      if (distiller === undefined) return { ok: false, output: NOT_CONFIGURED, halt: true }

      const started = now()

      const got = await pageOf(service, url, ctx.signal)
      if (!got.ok) return refused(got.output)

      const { page, hit } = got
      if (page.markdown.trim() === '') {
        return refused(
          '服务返回成功，但正文里没有可提炼的文字' +
            '——这一页可能没有可提取的正文内容；要它渲染后的样子，改用 exec 里的浏览器类命令',
        )
      }

      const distilled = await distiller.distill(
        {
          url: page.url,
          page: page.markdown,
          prompt,
        },
        ctx.signal === undefined ? {} : { signal: ctx.signal },
      )

      // 配了但这一趟没成——**照普通失败办**，不 `halt`（模型处置得了）
      if (!distilled.ok) return refused(`提炼没成：${distilled.reason}`)

      return {
        ok: true,
        output: compose({
          page,
          hit,
          elapsedMs: now() - started,
          model: distilled.model,
          answer: distilled.answer,
        }),
      }
    },
  })
}

/**
 * 回执 —— **两行抬头 ＋ 答案**。抬头报收据，答案在最后（它是这一份的正文）。
 *
 * 抬头报的是**服务与缓存事实**，不是原站状态——新接口没有那些字段，不编。
 * 那句「不是原文」与「没问到的未必没有」各说一件事：
 * 前者是「这一份是提炼」，后者是「提炼可能漏」。
 */
function compose(input: {
  readonly page: CachedPage
  readonly hit: boolean
  readonly elapsedMs: number
  readonly model: string
  readonly answer: string
}): string {
  const { page, hit, elapsedMs, model, answer } = input

  const retrieval = hit
    ? `${page.url} · 内容由 DeepSeek 提供 · 缓存命中（${WEB_CACHE_TTL_MS / 60_000} 分钟内取过，没有再取）`
    : `${page.url} · 内容由 DeepSeek 提供 · 本次取得 · ${formatMs(elapsedMs)}`

  return [
    `取回 ${retrieval}`,
    `提炼 按你问的那件事挑出的答案 · 不是原文 · 模型 ${model}`,
    '没问到的这一页未必没有；要看原文，用 exec ＋ curl 取。',
    '',
    answer,
  ].join('\n')
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))}ms` : `${(ms / 1000).toFixed(1)}s`
}
