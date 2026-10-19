/**
 * 供应商适配 —— 模型域内部的一层（U41）。
 *
 * 出处：设计 · 模型与上下文「多供应商与多模型」「技术实现方案 · 接入与职责」。
 *
 * 内置的是**供应商适配**：认证方式 · 官方服务区域/地址 · 列表与详情 API · 分页 ·
 * 字段归一 · 调用协议及令牌口径——**不是一份需要随新增型号改代码的全量清单**。
 *
 * 四条纪律：
 * ① **适配不上公开面**——装配只见 `ProviderConfig.vendor` 这个名字，细节（端点 ·
 *    字段名 · 分页参数）全封在这里；公开面出的 `ModelInfo` 已是归一后的形态。
 * ② **没有依据不发请求**——没有详情接口的适配**压根不实现** `retrieveModel`，
 *    不去拼一个「看上去对」的 URL（DeepSeek 即此例，设计明文）。
 * ③ 型号规格由供应商接口与 Models.dev 资源提供；适配只处理协议和参数。
 * ④ **认不出就不猜**——未知 `vendor` / 未知 `region` 一律返回 `undefined` 由调用方
 *    如实报错，不回落某个「大概率是它」的地址（凭据会跟着去错地方）。
 *
 * ⚠️ **key 只向下流**：本层拿得到它（发请求要用），但产出的一切文本先过脱敏
 * （与取件层同一条纪律）。
 */

import type { JSONValue } from 'ai'
import type {
  ModelInfo,
  ModelProtocol,
  ModelSource,
  ProviderAuth,
  VendorProtocol,
  ProviderConfig,
  ReasoningSetting,
  ReasoningSupport,
  VendorInfo,
  VendorRegion,
} from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'

/** 发一次请求要的东西——地址与凭据由**连接**给定（适配不猜、不存）。 */
export type VendorRequestContext = {
  readonly providerId: string
  /** 已解析的基址（含路径前缀，如 `https://api.minimax.cn/v1`）。 */
  readonly baseURL: string
  readonly apiKey: string
  /** 注入用 fetch（测试：假端点回放 JSON，不经网络）。 */
  readonly fetch: FetchLike
  readonly signal?: AbortSignal | undefined
}

/** 列表的一页——**有下一页才给 `next`**（游标形态由各家的适配决定）。 */
export type VendorListPage = {
  readonly models: readonly ModelInfo[]
  readonly next?: string
}

/**
 * 读**完整列表**——一页一页取到没有下一页为止。
 *
 * 一致性边界（设计 · 模型与上下文「获取」）：**全部成功才返回**——中途失败、或游标
 * 重复（对面在绕圈）都当场抛，**不提交半份快照**。调用方据此保留上一份成功的结果。
 */
export async function collectPages(
  fetchPage: (cursor?: string) => Promise<VendorListPage>,
): Promise<readonly ModelInfo[]> {
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  let cursor: string | undefined

  for (;;) {
    const page = await fetchPage(cursor)
    models.push(...page.models)

    const next = page.next
    if (next === undefined) return models

    // 游标重复＝对面在绕圈：停下（继续转只会把事情拖成「永远取不完」）
    if (seen.has(next)) throw new Error('模型列表分页游标重复——不提交半份快照')
    seen.add(next)
    cursor = next
  }
}

/**
 * 供应商适配——**模型域内部的端口**（实现就是下面那两家；域内件，不上公开面）。
 */
export type VendorAdapter = {
  /** 适配名——即 `ProviderConfig.vendor`。 */
  readonly id: string
  /** **可读名**（界面接入选「哪一家」时显示的就是它）。 */
  readonly label: string
  /**
   * 官方区域——**第一项是缺省**（`region` 没写时用它）。
   *
   * 数组而不是字典：**次序本身是信息**（缺省那一个），且界面要照序铺行。
   */
  readonly regions: readonly VendorRegion[]
  readonly protocols: readonly VendorProtocol[]
  /**
   * 解析这条连接该走的基址——明确写了 `baseURL` 就用它（「高级地址只在明确需要时编辑」），
   * 否则按区域取官方地址；**认不出返回 `undefined`**（调用方报错，不猜）。
   */
  baseURLOf(config: ProviderConfig, protocol?: ModelProtocol): string | undefined
  /** **取完整列表**——分页全部成功才返回（见 `collectPages`）。 */
  listModels(ctx: VendorRequestContext): Promise<readonly ModelInfo[]>
  /**
   * **取详情**（可选）——**没有详情接口的适配不给本方法**。
   *
   * 设计：缺少选中模型所需信息**才**取详情，不对所有型号无条件逐个请求。
   * 返回 `undefined` ＝这次没取到（调用方保留列表里那份）。
   */
  retrieveModel?(
    ctx: VendorRequestContext,
    modelId: string,
  ): Promise<Pick<ModelInfo, 'id' | 'name' | 'description' | 'capabilities' | 'limits' | 'reasoning'> | undefined>
  /** 请求明确采用分离格式，content 不再经过内嵌标签切分。 */
  readonly separatesReasoning?: boolean
  /**
   * **请求体改写**（该供应商已知的参数名差异）——没有这一位就原样发。
   *
   * 挂在这里而不是配置里：「参数」不入配置形制（技术方案：供应商差异封接缝）；
   * 也不按 provider id 猜——id 是用户自由命名的。
   */
  readonly transformRequestBody?:
    | ((args: Record<string, unknown>) => Record<string, unknown>)
    | undefined
  /**
   * 思考设置 → **该供应商的原生请求参数**；不是它支持的形态 ⇒ 报缺口（**不发假参数**）。
   *
   * 返回的原样进取件层的 `providerOptions`——`@ai-sdk/openai-compatible` 会把
   * **不在其 options 表里的键平铺进请求体**（`reasoningEffort` 则映射成 `reasoning_effort`），
   * 故这里写的就是供应商文档里那些字段名。
   *
   * - `undefined` ＝这条设置在这家**没有对应参数**（`default` 就是这样——什么都不发）；
   * - `{ gap }` ＝**做不到**，缘由说给人听（调用方据此拒绝这次设置并说明缺口）。
   */
  reasoningOf(
    setting: ReasoningSetting,
    model: string,
    protocol?: ModelProtocol,
  ): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined
}

// —— 列表响应归一（两家共用的那半：`{ object: 'list', data: [{ id, … }] }`）——

/** 列表中已有明确语义且被消费的信息；缺失或无效字段保持未知。 */
function toModelsOf(body: unknown): readonly ModelInfo[] {
  const record = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
  const data = record(body).data
  if (!Array.isArray(data)) throw new Error('模型列表里没有 data 数组')
  return data.flatMap(value => {
    const raw = record(value)
    if (typeof raw.id !== 'string' || raw.id.length === 0) return []
    const limits: Record<string, number> = {}
    for (const [source, target] of [['max_input_tokens', 'maxInputTokens'], ['max_output_tokens', 'maxOutputTokens'], ['context_window', 'maxContextTokens']] as const) {
      const v = raw[source]
      if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) limits[target] = v
    }
    const capabilities: Record<string, boolean> = {}
    const declared = record(raw.capabilities)
    for (const key of ['chat', 'image', 'tools']) if (typeof declared[key] === 'boolean') capabilities[key] = declared[key]
    if (Array.isArray(raw.input_modalities) && raw.input_modalities.every(v => typeof v === 'string')) capabilities.image ??= raw.input_modalities.includes('image')
    const source = record(raw.reasoning)
    const levels = source.levels ?? record(raw.effort).supported_levels
    const reasoning: ReasoningSupport = {
      ...(typeof source.disable === 'boolean' ? { disable: source.disable } : {}),
      ...(source.default === 'on' || source.default === 'off' ? { default: source.default } : {}),
      ...(Array.isArray(levels) && levels.every(v => typeof v === 'string' && v.length) ? { levels: levels as string[] } : {}),
    }
    const budget = record(source.budget)
    const min = budget.min_tokens, max = budget.max_tokens
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
    const budgetInfo = valid(min) && valid(max) && min > max ? undefined : {
      ...(valid(min) ? { minTokens: min } : {}), ...(valid(max) ? { maxTokens: max } : {}),
    }
    return [{ id: raw.id,
      ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
      ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      ...(Object.keys(reasoning).length || (budgetInfo && Object.keys(budgetInfo).length)
        ? { reasoning: { ...reasoning, ...(budgetInfo && Object.keys(budgetInfo).length ? { budget: budgetInfo } : {}) } } : {}),
    }]
  })
}

/** 发一次 GET，回 JSON——失败当场抛（**带状态码，不带响应正文里的凭据**）。 */
async function getJson(ctx: VendorRequestContext, path: string): Promise<unknown> {
  const response = await ctx.fetch(`${ctx.baseURL}${path}`, {
    headers: { authorization: `Bearer ${ctx.apiKey}`, accept: 'application/json' },
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })

  if (!response.ok) {
    // ⚠️ 不回显响应正文：出错时对面可能把凭据或请求头原样抄回来（与取件层同一条纪律）
    throw new Error(`取模型列表失败（HTTP ${response.status}）`)
  }
  return response.json()
}

export const PROTOCOLS = [
  { id: 'responses', label: 'Responses' },
  { id: 'messages', label: 'Anthropic Messages' },
  { id: 'chat-completions', label: 'Chat Completions' },
] as const

/** 连接保存与调用来源共用的地址规则；保留基础路径，仅移除末尾斜杠。 */
export function normalizeBaseURL(base: string): string {
  const endpoint = new URL(base)
  // href 同时覆盖空查询/片段分隔符（URL.search/hash 对单独的 ?/# 返回空串）。
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.href.includes('?') || endpoint.href.includes('#')) throw new Error('基础地址须为无凭据、查询参数和片段的 HTTP/HTTPS URL')
  return endpoint.href.replace(/\/+$/, '')
}

/** 只校验和解析，不读凭据、不访问网络。显式协议不支持时绝不降级。 */
export function resolveModelSource(config: ProviderConfig, model: string): ModelSource {
  const adapter = config.vendor === undefined ? undefined : vendorOf(config.vendor)
  if (config.vendor !== undefined && adapter === undefined) throw new Error(`未知供应商适配「${config.vendor}」`)
  const supported = adapter?.protocols.filter(p => p.models === undefined || p.models.includes(model))
  const protocol = config.protocol ?? (adapter === undefined ? 'responses' : supported?.[0]?.id)
  if (protocol === undefined || (supported !== undefined && !supported.some(p => p.id === protocol))) {
    throw new Error(`模型「${model}」不支持${config.protocol === undefined ? '已核实的官方协议' : `协议「${config.protocol}」`}；请核对精确型号`)
  }
  const base = adapter === undefined ? config.baseURL : adapter.baseURLOf(config, protocol)
  if (!base) throw new Error('连接没有有效服务地址或官方区域')
  return { protocol, endpoint: normalizeBaseURL(base) }
}

export function authOf(config: ProviderConfig, protocol: ModelProtocol): ProviderAuth {
  return config.auth ?? (protocol === 'messages' ? 'api-key' : 'bearer')
}

// —— MiniMax ——

/**
 * MiniMax 开放平台（官方文档 2026-09-23）：
 * - 列表 `GET /v1/models`（无分页）· 详情 `GET /v1/models/{id}`；
 * - 两者的响应体**是同一组四个字段**（`id` / `object` / `created` / `owned_by`）——
 *   详情并不比列表多给什么，故**只在确需时才取**（设计：缺少选中模型所需信息才取详情）。
 *
 * ⚠️ **旧配置里的 `api.minimaxi.com` 不动**：那是兼容接入的地址（无 `vendor`），
 * 官方适配连的是文档给的 `api.minimax.cn`——**不因域名变化自动迁移凭据**（设计明文）。
 */
export const MINIMAX_VENDOR: VendorAdapter = {
  id: 'minimax',
  label: 'MiniMax',
  separatesReasoning: true,
  // ⚠️ 这是**新建官方连接**的地址（文档给的 `api.minimax.cn`）；旧兼容连接用的
  // `api.minimaxi.com` 一个字不动——那是另一条路，不因域名变化自动迁移凭据
  protocols: PROTOCOLS,
  regions: [{ id: 'cn', label: '中国大陆', baseURL: 'https://api.minimax.cn/v1' }],

  baseURLOf(config, protocol = config.protocol ?? 'chat-completions') {
    const base = resolveBaseURL(this.regions, config)
    if (config.baseURL !== undefined || protocol !== 'messages' || base === undefined) return base
    return base.replace(/\/v1$/, '') + '/anthropic/v1'
  },

  async listModels(ctx) {
    const body = await getJson(ctx, '/models')
    return collectPages(() => Promise.resolve({ models: toModelsOf(body) }))
  },

  async retrieveModel(ctx, modelId) {
    const body = await getJson(ctx, `/models/${encodeURIComponent(modelId)}`)
    const one = toModelsOf({ data: [body] })
    return one[0]
  },

  /**
   * MiniMax 的已知差异：`max_tokens` 已弃用，改用 `max_completion_tokens`。
   *
   * 另请求 reasoning_split，正文与思考按字段区分。
   * 通用兼容接入不做这项改写。
   */
  transformRequestBody(args) {
    const { max_tokens: maxTokens, ...rest } = args
    return {
      ...rest,
      ...(maxTokens === undefined ? {} : { max_completion_tokens: maxTokens }),
      reasoning_split: true,
    }
  },

  /** 格式分离不等于关闭思考；按实际型号支持的控制参数映射。 */
  reasoningOf(setting, model, protocol = 'chat-completions'): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined {
    if (setting.mode === 'default') return undefined
    if (setting.mode === 'off') return { params: protocol === 'responses' ? { reasoningEffort: 'none' } : { thinking: { type: 'disabled' } } }
    if (setting.mode === 'level'
      && ['low', 'medium', 'high', 'xhigh', 'max'].includes(setting.level)) return { params: protocol === 'messages' ? { effort: setting.level } : { reasoningEffort: setting.level } }
    return { gap: `当前 MiniMax 模型「${model}」不支持该思考设置` }
  },
}

// —— DeepSeek ——

/**
 * DeepSeek：列表 GET /models，无分页、无详情接口。
 * 精确整数容量来自接口；价目表的 K/M 单位不明确，不据此补数值。
 * 官方思考控制支持开关与 low/high/max，默认开启，无 token 预算参数。
 */
export const DEEPSEEK_VENDOR: VendorAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  protocols: PROTOCOLS.map(p => ({ ...p, models: p.id === 'responses' ? ['deepseek-flash'] : ['deepseek-flash', 'deepseek-v4-pro'] })),
  regions: [{ id: 'official', label: '官方', baseURL: 'https://api.deepseek.com' }],
  // 思考模式的工具往返要求把历史轮的 `reasoning_content` 原样回传（官方文档明文）
  separatesReasoning: true,

  baseURLOf(config, protocol = config.protocol ?? 'chat-completions') {
    const base = resolveBaseURL(this.regions, config)
    if (config.baseURL !== undefined || protocol !== 'messages' || base === undefined) return base
    return base.replace(/\/v1$/, '') + '/anthropic/v1'
  },

  async listModels(ctx) {
    const body = await getJson(ctx, '/models')
    return collectPages(() => Promise.resolve({ models: toModelsOf(body) }))
  },

  /**
   * 思考设置 → 原生参数。
   *
   * - `default` ⇒ **什么都不发**（官方默认就是开启 ＋ high，那是它自己的默认）；
   * - `off` ⇒ `thinking.type = 'disabled'`（官方支持的明确关闭）；
   * - `level` ⇒ `reasoning_effort`（官方只认 low / high / max——**其余档位报缺口**）；
   * - `budget` ⇒ **报缺口**：官方没有 token 预算参数，不能拿一个不存在的参数去凑。
   */
  reasoningOf(setting, _model, protocol = 'chat-completions'): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined {
    switch (setting.mode) {
      case 'default':
        return undefined
      case 'off':
        // 官方支持的明确关闭（与 `default` 不是一回事：那是「说了别想」）
        return { params: protocol === 'responses' ? { reasoningEffort: 'none' } : { thinking: { type: 'disabled' } } }
      case 'level':
        return setting.level === 'low' || setting.level === 'high' || setting.level === 'max'
          ? { params: protocol === 'messages' ? { thinking: { type: 'enabled' }, effort: setting.level } : protocol === 'responses' ? { reasoningEffort: setting.level } : { thinking: { type: 'enabled' }, reasoningEffort: setting.level } }
          : { gap: `DeepSeek 的思考档位只有 low / high / max——不认识「${setting.level}」` }
      case 'budget':
        return { gap: 'DeepSeek 官方没有思考预算（token）参数——只能选档位或用它的默认' }
    }
  },
}

/**
 * 该走哪个基址——**明确写了 `baseURL` 就用它**（「高级地址只在明确需要时编辑」），
 * 否则按区域取官方地址；**认不出返回 `undefined`**（调用方报错，不猜）。
 */
function resolveBaseURL(
  regions: readonly VendorRegion[],
  config: ProviderConfig,
): string | undefined {
  if (config.baseURL !== undefined) return config.baseURL

  const wanted = config.region ?? regions[0]?.id
  return regions.find((one) => one.id === wanted)?.baseURL
}

// —— 注册表 ——

/**
 * 已注册的官方适配——**首批只这两家**（设计：「首批只注册这两家的官方接入」）。
 *
 * `undefined` ＝**认不出**：调用方据 `config.vendor` 有没有值分别走官方 / 兼容两条路；
 * 有值却认不出时**如实报错**（不悄悄当成兼容接入——那会拿官方域名去走旧协议）。
 */
const ADAPTERS: Readonly<Record<string, VendorAdapter>> = {
  minimax: MINIMAX_VENDOR,
  deepseek: DEEPSEEK_VENDOR,
}

/** 查适配——只认自有键（条目名是用户给的字符串，见 `capacity.ts` 的 `ownOf` 注）。 */
export function vendorOf(id: string): VendorAdapter | undefined {
  return Object.hasOwn(ADAPTERS, id) ? ADAPTERS[id] : undefined
}

/** 已注册的适配名（**报错话里要列它**——用户打错字时当场看得见有哪些可选）。 */
export function vendorIds(): readonly string[] {
  return Object.keys(ADAPTERS)
}

/**
 * **内置供应商与官方区域的读面**（U41 返修）——界面「接入」时据此列。
 *
 * 由头（工单）：「官方信息由适配统一提供，**不能让界面维护第二份表**」。
 * 故这一份是**从适配现取**的，不是另存的一张常量表——加一家只改 `ADAPTERS`。
 */
export function vendorCatalog(): readonly VendorInfo[] {
  return Object.values(ADAPTERS).map((adapter) => ({
    vendor: adapter.id,
    label: adapter.label,
    regions: adapter.regions,
    protocols: adapter.protocols,
  }))
}

/** 仅开放三协议已有明确表达的设置，不由用户能力声明生成私有参数。 */
export function reasoningParams(adapter: VendorAdapter | undefined, setting: ReasoningSetting | undefined, model: string, protocol: ModelProtocol): ReturnType<VendorAdapter['reasoningOf']> {
  if (setting === undefined || setting.mode === 'default') return undefined
  if (adapter !== undefined) return adapter.reasoningOf(setting, model, protocol)
  if (protocol === 'messages') {
    if (setting.mode === 'off') return { params: { thinking: { type: 'disabled' } } }
    if (setting.mode === 'budget') return { params: { thinking: { type: 'enabled', budgetTokens: setting.budgetTokens } } }
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(setting.level)) return { params: { thinking: { type: 'adaptive' }, effort: setting.level } }
  } else {
    if (setting.mode === 'off') return { params: { reasoningEffort: 'none' } }
    if (setting.mode === 'level' && ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(setting.level)) return { params: { reasoningEffort: setting.level } }
  }
  return { gap: `协议「${protocol}」无法表达该思考设置` }
}
