import type { MagicConfig } from '@magic/contracts'
import type { AgentModelConfig, AgentRoleConfig, MagicHome, ModelSwitchRequest, ProviderConfig } from '@magic/contracts'
import { createModelInfoService, createModelRegistry, createModelGateway, modelSpecOf, resolveConnection, resolveApiKey, selectModel } from '@magic/model'
import type { ModelRegistry, ModelRegistryOptions, ModelSelection, ModelSwitchResult } from '@magic/model'
import { loadConfig } from './config.ts'
import { cacheAccessFor } from './cache-access.ts'
import { createFileModelInfoCache } from './model-cache.ts'

/** 运行选择的唯一解析边界；缺失不猜测，思考修改不重新读取映射。 */
export function resolveModelChoice(input: {
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly configuredModels?: NonNullable<MagicConfig['models']>
  readonly defaults?: AgentModelConfig
  readonly newAgent?: boolean
  readonly role?: ModelSwitchRequest
  readonly config?: ModelSwitchRequest
  readonly modelInfoOf?: ModelRegistryOptions['modelInfoOf']
}): ModelSwitchResult {
  let selection = input.defaults
  if (input.newAgent && selection !== undefined) {
    const mapping = input.configuredModels?.[selection.choice]
    selection = mapping === undefined ? undefined : {
      choice: selection.choice, ...mapping,
      ...(mapping.provider === selection.provider && mapping.model === selection.model && selection.reasoning !== undefined ? { reasoning: selection.reasoning } : {}),
    }
  }
  for (const request of [input.config?.choice === undefined ? input.role : undefined, input.config]) {
    if (request === undefined) continue
    for (const key of Object.keys(request)) if (!['choice', 'reasoning'].includes(key)) return { ok: false, reason: `模型选择不接受 ${key}；请选择 Default、Cantrip、Spell 或 Arcane` }
    if (request.choice === undefined && request.reasoning === undefined) return { ok: false, reason: '请选择默认模型或模型档位，或设置思考等级' }
    if (request.choice !== undefined) {
      if (!['default', 'cantrip', 'spell', 'arcane'].includes(request.choice)) return { ok: false, reason: '未知模型选择；只能选择 default / cantrip / spell / arcane' }
      const mapping = input.configuredModels?.[request.choice]
      if (mapping === undefined) return { ok: false, reason: `${labelOf(request.choice)} 尚未配置；请在 /model → ${request.choice === 'default' ? '默认模型' : '模型档位'} 中设置` }
      const changed = selection?.provider !== mapping.provider || selection.model !== mapping.model
      selection = { choice: request.choice, ...mapping, ...(request.reasoning === undefined
        ? changed ? {} : selection?.reasoning === undefined ? {} : { reasoning: selection.reasoning }
        : { reasoning: request.reasoning }) }
    } else if (selection !== undefined) selection = { ...selection, reasoning: request.reasoning }
    else return { ok: false, reason: '当前还没有模型；请先在 /model 选择默认模型或模型档位' }
  }
  if (selection === undefined) {
    const choice = input.newAgent ? input.defaults?.choice ?? 'default' : 'default'
    const mapping = input.configuredModels?.[choice]
    if (mapping === undefined) return { ok: false, reason: `${labelOf(choice)} 尚未配置；请在 /model → ${choice === 'default' ? '默认模型' : '模型档位'} 中设置` }
    selection = { choice, ...mapping }
  }
  return selectModel({ providers: input.providers, modelInfoOf: input.modelInfoOf }, selection)
}

const labelOf = (choice: string): string => choice[0]!.toUpperCase() + choice.slice(1)

/** 每个成员独立 registry；继承的是此前有效组合，显式选择才解析当前映射。 */
export function createAgentModels(input: {
  readonly options: ModelRegistryOptions
  readonly configuredModels?: NonNullable<MagicConfig['models']>
  readonly defaults: ModelSelection
  readonly role?: AgentRoleConfig
  readonly config?: ModelSwitchRequest
}): { readonly ok: true; readonly models: ModelRegistry; readonly selection: ModelSelection } | { readonly ok: false; readonly reason: string } {
  const resolved = resolveModelChoice({ newAgent: true, ...input.options, configuredModels: input.configuredModels, defaults: input.defaults, role: input.role?.model, config: input.config })
  if (!resolved.ok) return resolved
  const models = createModelRegistry(input.options)
  const chosen = models.use(resolved.selection)
  return chosen.ok ? { ...chosen, models } : chosen
}

export function validateSelection(input: { readonly models: ModelRegistry; readonly configuredModels?: NonNullable<MagicConfig['models']>; readonly providers: Readonly<Record<string, ProviderConfig>>; readonly config: ModelSwitchRequest; readonly modelInfoOf?: ModelRegistryOptions['modelInfoOf'] }) {
  return resolveModelChoice({ ...input, defaults: input.models.current() })
}

/** manager 预检只读配置与匹配接入身份的缓存，不联网。 */
export async function resolveManagedModel(input: {
  readonly magic: MagicHome
  readonly defaults: AgentModelConfig
  readonly role?: string
  readonly model?: ModelSwitchRequest
}): Promise<AgentModelConfig> {
  const { loaded, info } = await managedModelContext(input.magic)
  const role = input.role === undefined ? undefined : loaded.config.agentRoles?.[input.role]
  if (input.role !== undefined && (!Object.hasOwn(loaded.config.agentRoles ?? {}, input.role) || role === undefined)) throw new Error(`未知角色「${input.role}」`)
  const resolved = resolveModelChoice({
    providers: loaded.config.providers, configuredModels: loaded.config.models,
    newAgent: true, defaults: input.defaults, role: role?.model, config: input.model,
    modelInfoOf: (provider, model) => info.peek(provider).snapshot?.models.find(one => one.id === model),
  })
  if (!resolved.ok) throw new Error(resolved.reason)
  resolveApiKey({ providerId: resolved.selection.provider, config: loaded.config.providers[resolved.selection.provider]!, env: process.env, configPath: loaded.path })
  return resolved.selection
}

async function managedModelContext(magic: MagicHome) {
  const loaded = loadConfig({ magic })
  const processToken = crypto.randomUUID()
  const info = createModelInfoService({
    connections: () => Object.entries(loaded.config.providers).map(([providerId, config]) => ({
      ...resolveConnection({ providerId, config }),
      access: cacheAccessFor({ provider: providerId, configPath: loaded.path, apiKey: config.apiKey, processToken }),
    })),
    cache: createFileModelInfoCache(loaded.config.dataDir), now: Date.now,
    fetch: async () => { throw new Error('配置预检不允许联网') },
  })
  await info.warmup()
  return { loaded, info }
}

/** 协调者只读已配置的档位及已知能力；不发分类或模型请求。 */
export async function managedModelChoices(magic: MagicHome) {
  const { loaded, info } = await managedModelContext(magic)
  return (['default', 'cantrip', 'spell', 'arcane'] as const).map(choice => {
    const mapping = loaded.config.models?.[choice]
    if (mapping === undefined) return { choice, configured: false }
    const known = info.peek(mapping.provider).snapshot?.models.find(one => one.id === mapping.model)
    const override = loaded.config.providers[mapping.provider]?.modelOverrides?.[mapping.model]
    return { choice, configured: true, ...mapping,
      capabilities: known?.capabilities === undefined ? override?.capabilities : { ...known.capabilities, ...override?.capabilities },
      reasoning: override?.reasoningSupport ?? known?.reasoning }
  })
}

/** 独立辅助调用：解析一次档位，捕获同一份连接与模型信息，不借主工作选中态。 */
export function bindModelChoice(input: {
  readonly options: ModelRegistryOptions
  readonly configuredModels: MagicConfig['models']
  readonly request: ModelSwitchRequest
}) {
  const resolved = resolveModelChoice({ ...input.options, configuredModels: input.configuredModels, config: input.request })
  if (!resolved.ok) throw new Error(resolved.reason)
  const chosen = resolved.selection
  const config = input.options.providers[chosen.provider]!
  const known = input.options.modelInfoOf?.(chosen.provider, chosen.model)
  const gateway = createModelGateway({ ...input.options, providerId: chosen.provider,
    model: chosen.model, reasoning: chosen.reasoning, config,
    apiKey: input.options.apiKeys?.[chosen.provider], modelInfoOf: () => known })
  return { gateway, inputBudget: modelSpecOf(config, chosen.model, known)?.inputBudget,
    location: `${input.options.configPath} → providers.${chosen.provider}.modelOverrides.${chosen.model}.limits` }
}
