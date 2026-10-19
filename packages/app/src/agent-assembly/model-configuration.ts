import type {
  AgentModelConfig,
  EventStamper,
  MagicConfig,
  MagicHome,
  ModelCacheAccess,
  ModelInfo,
  PrefsSetRequest,
  ProviderConfig,
  SettingsAction,
} from '@magic/contracts'
import type { FetchLike, ModelInfoService, ModelRegistry } from '@magic/model'
import { createModelInfoService, createModelRegistry, resolveConnection } from '@magic/model'
import type { WebServiceRef } from '@magic/tools'
import { createWebSource } from '@magic/execution'
import { bindModelChoice } from '../agent-models.ts'
import { configStamp as configStampOf } from '@magic/config'
import { cacheAccessFor, connectionScopeChanged } from '../cache-access.ts'
import { removeProvider, setPrefs } from '@magic/config'
import { loadConfig, type LoadedConfig } from '@magic/config'
import { createFileModelInfoCache } from '../model-cache.ts'
import { createSettings } from '../settings.ts'

/** 连接资料、配置水位与可重建缓存；每个 Agent 的模型选择由调用者独立持有。 */
export function createModelConfiguration(input: {
  loaded: LoadedConfig
  magic: MagicHome
  environment: Readonly<Record<string, string>>
  fetch: FetchLike
  now: () => number
  onError: (message: string) => void
  onChange: () => void
}) {
  const { loaded, magic, environment, fetch, now, onError, onChange } = input
  let providerBook: Readonly<Record<string, ProviderConfig>> = loaded.config.providers

  let configuredModels: MagicConfig['models'] = loaded.config.models

  /** 网页服务引用（U94）——与连接表一起按配置水位刷新。 */
  let webConfig: MagicConfig['web'] = loaded.config.web

  const modelCache = createFileModelInfoCache(magic.base)

  /**
   * 本进程的唯一值——**环境变量来源**那支身份用（`persistent: false`，不落盘）。
   * 它只作「这不是别的进程」的标记，进不了磁盘文件名以外的任何地方。
   */
  const processToken = crypto.randomUUID()

  /**
   * 配置指纹的**水位**（同一个文件**本身**的六件里挑出的比对串）——`syncProviderBook`
   * 据它判「外部改过没有」。开局那一刻先取一次（此后只有变才动）。
   */
  let configStamp = loaded.stamp === undefined ? configStampOf(loaded.path) : loaded.stamp

  const cacheAccessOf = (provider: string, config: ProviderConfig | undefined): ModelCacheAccess =>
    // 「什么算『认证取自配置文件』」只判一处（`cache-access.ts`）——窗口那一侧算开屏的
    // 分母时读的是**同一份**缓存，两处各判一遍迟早开成两份文件
    cacheAccessFor({
      provider,
      configPath: loaded.path,
      apiKey: config?.apiKey,
      processToken,
    })

  /** 几段回话合成一句（一段都没有 ⇒ `undefined`，答复里就不带 `note`）。 */
  const twoNotes = (...said: readonly (string | undefined)[]): string | undefined => {
    const parts = said.filter((one): one is string => one !== undefined)
    return parts.length === 0 ? undefined : parts.join('；')
  }

  const dropCacheQuietly = async (
    target: { readonly provider: string; readonly access: ModelCacheAccess } | undefined,
  ): Promise<string | undefined> => {
    if (target === undefined) return undefined

    try {
      await modelCache.drop(target.provider, target.access)
      return undefined
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `旧缓存没能清掉（${reason}）——它不会串进当前范围，但会占着磁盘`
    }
  }

  const syncProviderBook = (): Promise<string | undefined> | undefined => {
    const stamp = configStampOf(loaded.path)
    if (stamp === configStamp) return
    const reloaded = loadConfig({ path: loaded.path, magic })
    const previous = providerBook
    providerBook = reloaded.config.providers
    configuredModels = reloaded.config.models
    webConfig = reloaded.config.web
    configStamp = stamp
    // 先发布新快照，避免 drop 读取连接时重入；同步作废在途位，异步收妥缓存文件。
    const dropped = Object.entries(previous)
      .filter(([provider, config]) => connectionScopeChanged(config, providerBook[provider]))
      .map(async ([provider]) => {
        try { await modelInfo.drop(provider) }
        catch (error) {
          const note = `模型缓存未能更新：${error instanceof Error ? error.message : String(error)}`
          onError(note)
          return note
        }
      })
    return Promise.all(dropped).then(notes => twoNotes(...notes))
  }

  const modelInfo: ModelInfoService = createModelInfoService({
    connections: () => {
      // 每次现取连接资料之前，先看**外部**有没有改过配置（见 `syncProviderBook`）
      syncProviderBook()

      return Object.entries(providerBook).map(([id, config]) => {
        const resolved = resolveConnection({ providerId: id, config, env: environment })
        return { ...resolved, access: cacheAccessOf(id, config) }
      })
    },
    cache: modelCache,
    fetch,
    now,
    onChange,
  })

  const knownModelOf = (provider: string, model: string): ModelInfo | undefined =>
    modelInfo.peek(provider).snapshot?.models.find((one) => one.id === model)

  // 每次构造独立注册表；保存的组合缺来源时拒绝恢复，不重新猜默认值。
  const registryOf = (selection: AgentModelConfig | undefined, stamper: EventStamper): ModelRegistry => {
    const registry = createModelRegistry({
      providers: providerBook,
      stamper,
      fetch, env: environment,
      configPath: loaded.path,
      // 有效规格要看得见缓存里那份资料（见 `knownModelOf`）
      modelInfoOf: knownModelOf,
    })
    if (selection !== undefined) {
      if (selection.protocol === undefined || selection.endpoint === undefined) throw new Error('该工作保存的模型组合缺少协议或服务地址来源，无法可靠接回；历史记录已保留')
      const result = registry.use(selection)
      if (!result.ok) throw new Error(result.reason)
    }
    return registry
  }

  const cantrip = (stamper: EventStamper) => {
    syncProviderBook()
    return bindModelChoice({
      configuredModels, request: { choice: 'cantrip' },
      options: {
        providers: providerBook, stamper, fetch, env: environment,
        configPath: loaded.path, modelInfoOf: knownModelOf
      }
    })
  }

  /**
   * **网页服务读数**（U94）——每次工具调用现取：配置改了下一趟就生效。
   *
   * 只做两件事：按 `web.provider` 找到连接、解析凭据。**不发探测请求**——
   * 「已配置」不等于「已连通」。缺配置 / 悬空引用 / 缺凭据各给一句可处置的话。
   */
  const webSource = (): WebServiceRef => {
    syncProviderBook()

    if (webConfig === undefined) {
      return {
        ok: false,
        reason: '网页服务尚未配置——去 /web（或设置 · 工具接入）选择一条 DeepSeek 连接',
      }
    }

    const config = providerBook[webConfig.provider]
    if (config === undefined) {
      return {
        ok: false,
        reason: `网页服务引用的连接「${webConfig.provider}」已不存在——请重新选择网页服务`,
      }
    }
    if (config.vendor !== 'deepseek') {
      return {
        ok: false,
        reason: `网页服务连接「${webConfig.provider}」不是 DeepSeek 官方连接——首版只接 DeepSeek`,
      }
    }
    if (config.baseURL !== undefined || config.region !== undefined) {
      return {
        ok: false,
        reason: `网页服务连接「${webConfig.provider}」使用了自定义地址或区域——首版只接固定官方地址`,
      }
    }

    const resolved = resolveConnection({ providerId: webConfig.provider, config, env: environment })
    const apiKey = resolved.apiKey?.trim() ?? ''
    if (apiKey === '') {
      return {
        ok: false,
        reason: `网页服务连接「${webConfig.provider}」缺少凭据——请在连接设置里填写 API Key，或设置对应的环境变量`,
      }
    }

    return {
      ok: true,
      provider: webConfig.provider,
      // 缓存身份：连接 id ＋ 凭据作用域。换连接 / 换 key 都不再命中旧页面。
      scope: `${webConfig.provider}\u0000${apiKey}`,
      web: createWebSource({ apiKey, fetch }),
    }
  }

  async function save(action: Extract<SettingsAction, { type: 'provider.save' | 'model.configure' | 'model.override' | 'web.configure' }>) {
    let note: string
    let saved = false
    try {
      const expected = 'expectedStamp' in action && action.expectedStamp !== undefined ? action.expectedStamp : configStamp
      note = await createSettings({ magic, configPath: loaded.path, environment, fetch, now }).apply(action, expected)
      saved = true
      note = twoNotes(note, await syncProviderBook())!
      await modelInfo.warmup()
    } catch (error) { note = error instanceof Error ? error.message : String(error) }
    return { note, saved }
  }

  async function remove(provider: string) {
    // **被移除那条的**身份——同样要**在改动之前**算
    const removed = providerBook[provider]
    const removedTarget =
      removed === undefined ? undefined : { provider, access: cacheAccessOf(provider, removed) }

    const outcome = await removeProvider({
      path: loaded.path,
      expectedStamp: configStamp,
      provider,
    })
    if (!outcome.ok) {
      return outcome
    }

    configStamp = configStampOf(loaded.path)

    const next = { ...providerBook }
    delete next[provider]
    providerBook = next
    const reloaded = loadConfig({ path: loaded.path, magic }).config
    configuredModels = reloaded.models
    webConfig = reloaded.web

    modelInfo.drop(provider)
    const cleared = await dropCacheQuietly(removedTarget)

    return { ok: true as const, note: cleared }
  }

  return {
    info: modelInfo,
    get providers() { return providerBook },
    get configured() { return configuredModels },
    get stamp() { return configStamp },
    sync: syncProviderBook,
    registry: registryOf,
    knownModel: knownModelOf,
    cantrip,
    webSource,
    save,
    remove,
    async setPrefs(request: PrefsSetRequest) {
      const outcome = await setPrefs({ path: loaded.path, expectedStamp: configStamp, request })
      if (outcome.ok) configStamp = configStampOf(loaded.path)
      return outcome
    },
  }
}
