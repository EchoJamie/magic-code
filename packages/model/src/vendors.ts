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
 * ③ **补充不添型号**——`supplement` 只补 API 没给的、**有官方出处**的字段；
 *    它不能让一个供应商没列出的型号出现在选择器里。
 * ④ **认不出就不猜**——未知 `vendor` / 未知 `region` 一律返回 `undefined` 由调用方
 *    如实报错，不回落某个「大概率是它」的地址（凭据会跟着去错地方）。
 *
 * ⚠️ **key 只向下流**：本层拿得到它（发请求要用），但产出的一切文本先过脱敏
 * （与取件层同一条纪律）。
 */

import type { JSONValue } from 'ai'
import type {
  ModelInfo,
  ProviderConfig,
  ReasoningSetting,
  ReasoningSupport,
  VendorInfo,
  VendorRegion,
} from '@magic/contracts'
import type { FetchLike } from './ai-sdk.ts'
import { MODEL_CONTEXT_BUILTIN } from './capacity.ts'
import { matchBuiltinTraits } from './traits.ts'

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
  /**
   * 解析这条连接该走的基址——明确写了 `baseURL` 就用它（「高级地址只在明确需要时编辑」），
   * 否则按区域取官方地址；**认不出返回 `undefined`**（调用方报错，不猜）。
   */
  baseURLOf(config: ProviderConfig): string | undefined
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
  /**
   * **助手消息里的思考要回传**——该供应商的协议要求（DeepSeek 的思考模式在带 tools 时
   * 不回传历史轮的 `reasoning_content` 就 400）。**没有这一位＝不带**：
   * 思考是**这一家这一个模型**的私有协议内容，不转发给其它供应商（设计明文）。
   */
  readonly echoesReasoning?: boolean | undefined
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
   * **缺项补充**——只补 API 没给的、有官方出处的字段（**不添型号**）。
   *
   * 优先级里它排在「供应商 API 当前有效信息」**之后**：API 给了的字段一律不覆盖。
   */
  supplement(info: ModelInfo): ModelInfo
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
  ): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined
}

// —— 列表响应归一（两家共用的那半：`{ object: 'list', data: [{ id, … }] }`）——

/**
 * 把 `{ data: [...] }` 归一成模型信息——**只认 `id`**。
 *
 * 两家列表**只保证 `id`**（MiniMax 另有 `created` / `owned_by`，DeepSeek 有 `owned_by`）：
 * 那些既不是调用要用的、也不是选择要看的，收了只会让人以为「这些字段一直有」。
 * 其余一切（规格 / 能力）走 `supplement` 或详情。
 */
function toModelsOf(body: unknown): readonly ModelInfo[] {
  if (typeof body !== 'object' || body === null) throw new Error('模型列表不是对象')
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) throw new Error('模型列表里没有 data 数组')

  const models: ModelInfo[] = []
  for (const one of data) {
    if (typeof one !== 'object' || one === null) continue
    const id = (one as { id?: unknown }).id
    // **id 是调用时要送的那个名字**——不是字符串就跳过（收了也用不了）
    if (typeof id !== 'string' || id.length === 0) continue
    models.push({ id })
  }
  return models
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
  // ⚠️ 这是**新建官方连接**的地址（文档给的 `api.minimax.cn`）；旧兼容连接用的
  // `api.minimaxi.com` 一个字不动——那是另一条路，不因域名变化自动迁移凭据
  regions: [{ id: 'cn', label: '中国大陆', baseURL: 'https://api.minimax.cn/v1' }],

  baseURLOf(config) {
    return resolveBaseURL(this.regions, config)
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
   * 与 `ai-sdk.ts` 的 `requestBody` 是同一件事——那条管**兼容接入**的老路径
   * （无 `vendor` 的连接），这条管官方适配。两处各写一份是**故意的**：
   * 让 `ai-sdk.ts` 只依赖类型、不反向 import 本文件，域内不出现运行时循环。
   */
  transformRequestBody(args) {
    const { max_tokens: maxTokens, ...rest } = args
    if (maxTokens === undefined) return rest
    return { ...rest, max_completion_tokens: maxTokens }
  },

  /**
   * 缺项补充——MiniMax 的官方模型表（窗长）与实测行为（内嵌思考）。
   *
   * 两张表（与 `capacity.ts` / `traits.ts` 是**同一份**常量：官方资料只有一个出处，
   * 兼容接入那条路按模型名查它、官方适配这条路按适配补它，内容因此不会分叉）。
   *
   * ⚠️ **U65 起两样的查法不一样**：特征标记按**家族**查（`matchBuiltinTraits`——
   * `MiniMax-M2.7-highspeed` 落 M2 那一条），窗长仍按**精确 id** 查。不是漏改：
   * 内嵌思考有「同一线不同版本号行为相同」的实测依据（见 `traits.ts` 那条注），
   * 而窗长是**逐型号的规格**，没有依据说小改款的窗口跟着走——不按型号名猜。
   */
  supplement(info) {
    const window = Object.hasOwn(MODEL_CONTEXT_BUILTIN, info.id)
      ? MODEL_CONTEXT_BUILTIN[info.id]
      : undefined
    const traits = matchBuiltinTraits(info.id)

    return {
      ...info,
      // API 给了的字段一律不覆盖（补充排在它之后）
      ...(info.limits === undefined && window === undefined
        ? {}
        : { limits: { ...(window === undefined ? {} : { maxContextTokens: window }), ...info.limits } }),
      ...(traits === undefined ? {} : { traits }),
    }
  },

  /**
   * 思考设置——**官方文档未给出可配置的思考参数**（M3 / M2 的思考内嵌在正文里，
   * 由 `traits.inlineThinking` 切开）。故只认「模型默认」：
   * 其余形态**如实报缺口**，不发送一个我们没依据的参数。
   */
  reasoningOf(setting): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined {
    if (setting.mode === 'default') return undefined
    return { gap: 'MiniMax 官方文档没有可配置的思考参数——只能用它自己的默认' }
  },
}

// —— DeepSeek ——

/**
 * DeepSeek 开放平台（官方文档 2026-09-23）：
 * - 列表 `GET /models`（**无分页、无详情接口、没有容量声明**——公开结构只有
 *   `id` / `object` / `owned_by`）；
 * - 故本适配**不实现 `retrieveModel`**：不拼造详情 URL（设计明文）；
 * - 容量（官方价目表写「1M」上下文 /「384K」输出）**不收**：`K` / `M` 的单位无从判定
 *   （`1,000,000` 还是 `1,048,576`？）——与 `capacity.ts` 拒收 MiniMax `M2-her`
 *   那条「64 K」同一条判据：**说不准的数不上屏**，落到未知就如实未知。
 *
 * 思考模式（`guides/thinking_mode`，2026-09-23）：`thinking.type = enabled|disabled`、
 * 档位 `reasoning_effort = low|high|max`、**默认开启且默认 high**、**无 token 预算参数**。
 */
export const DEEPSEEK_VENDOR: VendorAdapter = {
  id: 'deepseek',
  label: 'DeepSeek',
  regions: [{ id: 'official', label: '官方', baseURL: 'https://api.deepseek.com' }],
  // 思考模式的工具往返要求把历史轮的 `reasoning_content` 原样回传（官方文档明文）
  echoesReasoning: true,

  baseURLOf(config) {
    return resolveBaseURL(this.regions, config)
  },

  async listModels(ctx) {
    const body = await getJson(ctx, '/models')
    return collectPages(() => Promise.resolve({ models: toModelsOf(body) }))
  },

  /**
   * 缺项补充——**思考能力的依据来自官方文档**（`guides/thinking_mode`，2026-09-23）：
   * 开关 `thinking.type = enabled|disabled`、档位 `reasoning_effort = low|high|max`、
   * **没有 token 预算参数**。列表本身只回 `id`，故这份能力只能由适配补
   *（设计：「必要缺项按官方资料补充」）。
   *
   * 容量**不补**：官方价目表写「1M / 384K」，`K`/`M` 的单位无从判定（同 `capacity.ts`
   * 拒收 MiniMax「64 K」那条判据）——说不准的数不上屏，如实未知。
   */
  supplement(info) {
    return {
      ...info,
      // API 给了的不覆盖（补充排在供应商当前信息之后）
      ...(info.reasoning === undefined ? { reasoning: REASONING_SUPPORT } : {}),
    }
  },

  /**
   * 思考设置 → 原生参数。
   *
   * - `default` ⇒ **什么都不发**（官方默认就是开启 ＋ high，那是它自己的默认）；
   * - `off` ⇒ `thinking.type = 'disabled'`（官方支持的明确关闭）；
   * - `level` ⇒ `reasoning_effort`（官方只认 low / high / max——**其余档位报缺口**）；
   * - `budget` ⇒ **报缺口**：官方没有 token 预算参数，不能拿一个不存在的参数去凑。
   */
  reasoningOf(setting): { readonly params: Record<string, JSONValue> } | { readonly gap: string } | undefined {
    switch (setting.mode) {
      case 'default':
        return undefined
      case 'off':
        // 官方支持的明确关闭（与 `default` 不是一回事：那是「说了别想」）
        return { params: { thinking: { type: 'disabled' } } }
      case 'level':
        return setting.level === 'low' || setting.level === 'high' || setting.level === 'max'
          ? { params: { reasoningEffort: setting.level } }
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

/** DeepSeek 的思考能力（官方文档 2026-09-23）——全线模型同一套，故是适配级的常量。 */
const REASONING_SUPPORT: ReasoningSupport = {
  levels: ['low', 'high', 'max'],
  disable: true,
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
  }))
}
