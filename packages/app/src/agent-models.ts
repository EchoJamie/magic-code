import type { AgentModelConfig, AgentRoleConfig, MagicHome } from '@magic/contracts'
import { createModelInfoService, createModelRegistry, resolveConnection } from '@magic/model'
import type { ModelRegistry, ModelRegistryOptions, ModelSelection, ModelSwitchRequest } from '@magic/model'
import { loadConfig } from './config.ts'
import { cacheAccessFor } from './cache-access.ts'
import { createFileModelInfoCache } from './model-cache.ts'

/** 每个成员单独调用；共享连接/缓存，绝不共享 registry 的可变选中态。 */
export function createAgentModels(input: {
  readonly options: Omit<ModelRegistryOptions, 'defaultProvider'>
  readonly defaults: ModelSelection
  readonly role?: AgentRoleConfig
  readonly config?: ModelSwitchRequest
}): { readonly ok: true; readonly models: ModelRegistry; readonly selection: ModelSelection }
  | { readonly ok: false; readonly reason: string } {
  // 不预造入口的网关：只验证并构造此成员实际选中的连接。
  const models = createModelRegistry({ ...input.options, defaultProvider: undefined })
  const resolved = models.resolve({ defaults: input.defaults, role: input.role?.model, config: input.config })
  if (!resolved.ok) return resolved
  const provider = input.options.providers[resolved.selection.provider]
  if (provider?.vendor === undefined) return { ok: false, reason: `连接「${resolved.selection.provider}」缺少 vendor，不能创建成员模型配置` }
  const chosen = models.use(resolved.selection)
  return chosen.ok ? { ...chosen, models } : chosen
}

/** 只做选择预检；主机核对当前上下文后调用该成员 models.use(config) 提交，失败均不改旧选择。 */
export function validateSelection(input: { readonly models: ModelRegistry; readonly config: ModelSwitchRequest }) {
  const { provider, model, reasoning } = input.config
  if (provider === undefined && model === undefined && reasoning === undefined) {
    return { ok: false as const, reason: '既没给 provider 也没给 model 或 reasoning——不知道要换成什么' }
  }
  const defaults = input.models.current()
  return input.models.resolve({ defaults, config: defaults === undefined
    ? { provider: input.models.defaultProviderId(), ...input.config } : input.config })
}

/** manager 的创建/配置预检：只读当前配置与匹配接入身份的磁盘缓存，不发现模型、不发请求。 */
export async function resolveManagedModel(input: {
  readonly magic: MagicHome
  readonly defaults: AgentModelConfig
  readonly role?: string
  readonly model?: Partial<AgentModelConfig>
}): Promise<AgentModelConfig> {
  const loaded = loadConfig({ magic: input.magic })
  const role = input.role === undefined ? undefined : loaded.config.agentRoles?.[input.role]
  if (input.role !== undefined && (!Object.hasOwn(loaded.config.agentRoles ?? {}, input.role) || role === undefined)) {
    throw new Error(`未知角色「${input.role}」`)
  }
  const processToken = crypto.randomUUID()
  const info = createModelInfoService({
    connections: () => Object.entries(loaded.config.providers).map(([providerId, config]) => ({
      ...resolveConnection({ providerId, config }),
      access: cacheAccessFor({ provider: providerId, configPath: loaded.path, apiKey: config.apiKey, processToken }),
    })),
    cache: createFileModelInfoCache(loaded.config.dataDir),
    now: Date.now,
    fetch: async () => { throw new Error('配置预检不允许联网') },
  })
  await info.warmup()
  const prepared = createAgentModels({
    defaults: input.defaults,
    role,
    config: input.model,
    options: {
      providers: loaded.config.providers,
      configPath: loaded.path,
      modelInfoOf: (provider, model) => info.peek(provider).snapshot?.models.find(one => one.id === model),
      stamper: { stamp() { throw new Error('配置预检不能调用模型') }, beginTurn() {} },
    },
  })
  if (!prepared.ok) throw new Error(prepared.reason)
  return prepared.selection
}
