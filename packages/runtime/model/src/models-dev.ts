import type { ModelInfo, ProviderConfig, ReasoningSupport } from '@magic/contracts'
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
export type ModelsDevRead = { readonly snapshot?: ModelsDevSnapshot; readonly failure?: string }
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

/** 官方适配的区域别名只用于资料归属，不改写连接或精确型号。自定义服务须匹配完整地址。 */
export function modelsDevProvider(config: ProviderConfig, catalog: ModelsDevCatalog): string | undefined {
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
