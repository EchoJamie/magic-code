import type { ModelInfo, ModelsDevMatch, ProviderConfig, ReasoningSupport } from '@magic/contracts'
import { vendorOf } from './vendors.ts'

export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const MODELS_DEV_TTL_MS = 60 * 60 * 1000
export const MODELS_DEV_ALIASES = [
  { vendor: 'minimax', base: 'https://api.minimax.cn/v1', provider: 'minimax-cn' },
  { vendor: 'minimax', base: 'https://api.minimaxi.com/v1', provider: 'minimax-cn' },
  { vendor: 'minimax', base: 'https://api.minimax.io/v1', provider: 'minimax' },
  { vendor: 'deepseek', base: 'https://api.deepseek.com', provider: 'deepseek' },
  { vendor: 'deepseek', base: 'https://api.deepseek.com/v1', provider: 'deepseek' },
] as const

export type ModelsDevCatalog = Readonly<Record<string, {
  readonly api?: string
  readonly models: Readonly<Record<string, ModelInfo>>
}>>
export type ModelsDevSnapshot = { readonly fetchedAt: number; readonly providers: ModelsDevCatalog }
type ModelsDevRead = { readonly snapshot?: ModelsDevSnapshot; readonly failure?: string }
/** 文件实现由装配注入；读取只访问本地资源，刷新不携带供应商凭据。 */
export type ModelsDevResource = {
  read(): ModelsDevRead
  refresh(force?: boolean): Promise<boolean>
}

const object = (v: unknown): Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0)
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0

/** 只保留消费的规格；不执行目录中的请求体、请求头或 SDK 配置。 */
export function parseModelsDev(data: unknown): ModelsDevCatalog {
  const providers = Object.fromEntries(Object.entries(object(data)).flatMap(([provider, value]) => {
    const raw = object(value)
    if (!Object.keys(object(raw.models)).length) return []
    const models = Object.fromEntries(Object.entries(object(raw.models)).flatMap(([id, value]) => {
      const model = object(value)
      if (!id || model.id !== id) return []
      const limit = object(model.limit), modalities = object(model.modalities)
      const limits = Object.fromEntries([
        ['maxContextTokens', limit.context], ['maxInputTokens', limit.input], ['maxOutputTokens', limit.output],
      ].filter(([, n]) => positive(n)))
      if (positive(limit.context)) {
        if (positive(limit.input) && limit.input > limit.context) delete limits.maxInputTokens
        if (positive(limit.output) && limit.output > limit.context) delete limits.maxOutputTokens
      }
      const capabilities = {
        ...(strings(modalities.output) ? { chat: modalities.output.includes('text') } : {}),
        ...(strings(modalities.input) ? { image: modalities.input.includes('image') } : {}),
        ...(typeof model.tool_call === 'boolean' ? { tools: model.tool_call } : {}),
      }
      let reasoning: ReasoningSupport | undefined
      if (Array.isArray(model.reasoning_options)) {
        const options = model.reasoning_options.map(object)
        const effort = options.find(o => o.type === 'effort')
        const budget = options.find(o => o.type === 'budget_tokens')
        reasoning = {
          ...(options.some(o => o.type === 'toggle') ? { disable: true } : {}),
          ...(effort === undefined ? { levels: [] } : strings(effort.values) ? { levels: effort.values } : {}),
          ...(budget === undefined ? {} : { budget: {
            ...(positive(budget.min) ? { minTokens: budget.min } : {}),
            ...(positive(budget.max) ? { maxTokens: budget.max } : {}),
          } }),
        }
      }
      const info: ModelInfo = {
        id,
        ...(typeof model.name === 'string' ? { name: model.name } : {}),
        ...(typeof model.description === 'string' ? { description: model.description } : {}),
        ...(Object.keys(limits).length ? { limits: limits as ModelInfo['limits'] } : {}),
        ...(Object.keys(capabilities).length ? { capabilities } : {}),
        ...(reasoning === undefined ? {} : { reasoning }),
        metadata: { provider, ...(typeof model.last_updated === 'string' ? { updatedAt: model.last_updated } : {}) },
      }
      return [[id, info]]
    }))
    return [[provider, { ...(typeof raw.api === 'string' ? { api: raw.api } : {}), models }]]
  }))
  if (!Object.values(providers).some(p => Object.keys(p.models).length)) throw new Error('Models.dev 未返回有效模型目录')
  return providers
}

/**
 * **按名字检索 Models.dev 的型号**——用户手动对位自己那条连接（自定义渠道常改型号写法）。
 *
 * 判的是**名字**，不是「它就是同一个型号」：命中只说明这一条可以抄过来看看，抄进
 * 用户覆盖的是**我们这条连接的原始型号**（调用方自己填），不是这里给的那一串。
 *
 * 排序（稳定、不猜语义）：型号 id 完全相同 → id 前缀 → id 含查询 → 名称含查询 →
 * 供应商名含查询；同档按供应商、型号 id 排，最后截到 `limit`。
 * 空查询不返回任何东西（不做「列全部」——那是一张几千行的表，不是检索结果）。
 */
export function searchModelsDev(
  catalog: ModelsDevCatalog,
  query: string,
  limit = 20,
): readonly ModelsDevMatch[] {
  const wanted = query.trim().toLowerCase()
  if (wanted.length === 0 || limit <= 0) return []

  const ranked: { readonly rank: number; readonly provider: string; readonly model: ModelInfo }[] = []
  for (const [provider, entry] of Object.entries(catalog)) {
    const providerHit = provider.toLowerCase().includes(wanted)
    for (const model of Object.values(entry.models)) {
      const id = model.id.toLowerCase()
      const name = model.name?.toLowerCase() ?? ''
      const rank = id === wanted ? 0 : id.startsWith(wanted) ? 1 : id.includes(wanted) ? 2 : name.includes(wanted) ? 3 : providerHit ? 4 : undefined
      if (rank === undefined) continue
      ranked.push({ rank, provider, model })
    }
  }

  return ranked
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      const providerA = a.provider.toLowerCase(), providerB = b.provider.toLowerCase()
      if (providerA !== providerB) return providerA < providerB ? -1 : 1
      const idA = a.model.id.toLowerCase(), idB = b.model.id.toLowerCase()
      return idA === idB ? 0 : idA < idB ? -1 : 1
    })
    .slice(0, limit)
    .map(modelsDevMatchOf)
}

/** 检索结果 → **能直接填进用户覆盖**的那一形（只带消费的几格，不带目录里的地址之类）。 */
export function modelsDevMatchOf(entry: { readonly provider: string; readonly model: ModelInfo }): ModelsDevMatch {
  const model = entry.model
  return {
    provider: entry.provider,
    model: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.limits === undefined ? {} : { limits: model.limits }),
    ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(model.metadata?.updatedAt === undefined ? {} : { updatedAt: model.metadata.updatedAt }),
  }
}

/** 官方适配的区域别名只用于资料归属，不改写连接或精确型号。自定义服务须匹配完整地址。 */export function modelsDevProvider(config: ProviderConfig, catalog: ModelsDevCatalog): string | undefined {
  const base = config.vendor === undefined ? config.baseURL : vendorOf(config.vendor)?.baseURLOf(config, 'chat-completions')
  if (!base) return undefined
  const normalized = base.replace(/\/+$/, '')
  const alias = MODELS_DEV_ALIASES.find(alias => alias.vendor === config.vendor && alias.base === normalized)
  if (alias) return alias.provider
  const matches = Object.entries(catalog).filter(([, provider]) => provider.api?.replace(/\/+$/, '') === normalized)
  return matches.length === 1 ? matches[0]![0] : undefined
}

/** 供应商接口逐字段优先，用户覆盖由有效规格层处理；原始缓存不混入第三方资料。 */
export function mergeModelInfo(id: string, supplied?: ModelInfo, metadata?: ModelInfo): ModelInfo | undefined {
  if (supplied === undefined && metadata === undefined) return undefined
  const limits = { ...metadata?.limits, ...supplied?.limits }
  const capabilities = { ...metadata?.capabilities, ...supplied?.capabilities }
  const reasoning = { ...metadata?.reasoning, ...supplied?.reasoning }
  return {
    ...metadata, ...supplied, id,
    ...(Object.keys(limits).length ? { limits } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  }
}
