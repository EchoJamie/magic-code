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
import { createWebSource, DEEPSEEK_WEB_ORIGIN } from '@magic/resources'
import { bindModelChoice } from '@magic/host'
import { configStamp as configStampOf } from '@magic/state'
import { cacheAccessFor, connectionScopeChanged } from '@magic/host'
import { removeProvider, setPrefs } from '@magic/state'
import { loadConfig, type LoadedConfig } from '@magic/state'
import { createFileModelInfoCache } from '@magic/host'
import { createModelsDevResource } from '@magic/host'
import { createSettings } from '@magic/host'

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
    metadata: createModelsDevResource(magic.base, fetch, now),
    fetch,
    now,
    onChange,
  })

  modelInfo.warmup()

  const knownModelOf = (provider: string, model: string): ModelInfo | undefined =>
    modelInfo.model(provider, model)

  /**
   * 每次构造独立注册表。
   *
   * 历史里的 `protocol`／`endpoint` 只作诊断元数据（D63）：缺这两项不妨碍接回，
   * 来源按**当前配置**重新解析；缺连接或型号时点名缺项与下一步，不要求「重新选择模型」。
   */
  const registryOf = (selection: AgentModelConfig | undefined, stamper: EventStamper): ModelRegistry => {
    const registry = createModelRegistry({
      providers: providerBook,
      // 下一次请求按当前配置组装：取连接资料前先看外部有没有改过（见 `syncProviderBook`）
      providersOf: () => {
        syncProviderBook()
        return providerBook
      },
      stamper,
      fetch, env: environment,
      configPath: loaded.path,
      // 有效规格要看得见缓存里那份资料（见 `knownModelOf`）
      modelInfoOf: knownModelOf,
    })
    if (selection !== undefined) {
      if (typeof selection.provider !== 'string' || selection.provider.trim() === '') {
        throw new Error('这条工作保存的模型组合缺少连接（provider）——请在 /model 的接入设置里确认连接；历史记录已保留')
      }
      if (typeof selection.model !== 'string' || selection.model.trim() === '') {
        throw new Error('这条工作保存的模型组合缺少模型（model）——请在 /model 为该连接设置精确型号；历史记录已保留')
      }
      const result = registry.use(selection)
      if (!result.ok) throw new Error(`这条工作保存的模型组合按当前配置接不回来：${result.reason}——请在 /model 检查这条工作的默认模型或档位与连接设置；历史记录已保留`)
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

    const resolved = resolveConnection({ providerId: webConfig.provider, config, env: environment })
    // `region` 是既有的官方区域字段，不单独拒；判据是**解析后的实际基址**必须固定。
    if (resolved.baseURL !== DEEPSEEK_WEB_ORIGIN) {
      return {
        ok: false,
        reason: `网页服务连接「${webConfig.provider}」的有效地址不是固定的 ${DEEPSEEK_WEB_ORIGIN}——首版只接 DeepSeek 官方地址`,
      }
    }
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
