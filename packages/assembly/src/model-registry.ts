/** 模型注册表与模型目录 —— 装配的**模型域**（从 index.ts 按职责拆出，行为不变）。
 *
 * 拆出的那一份职责：注册表的构造与重建（`rebuildRegistry`）、切换的**唯一**落笔路径
 * （`commitModel` —— 成败都发 `model.switched`，缺陷 D16 的产出路径）、模型/供应商/设置
 * 的读侧目录命令（`model.catalog` / `provider.catalog` 系列，U33 起的「归装配」那批）、
 * 偏好与网页配置读数（`prefs.state` / `web.state`——同为 modelSource 的配置面）。
 * 会话链、事件汇与记录域仍归装配编排（index.ts）——本域经 `ModelDomainDeps` 拿到它们的把手。
 */
import type {
  AgentIdentity,
  AgentModelConfig,
  EventDataOf,
  EventSink,
  EventStamper,
  MagicHome,
  ModelGateway,
  ModelSwitchRequest,
  PrefsSetRequest,
  SessionId,
  StatusLineConfig,
  Timestamp,
} from '@magic/contracts'
import type { FetchLike, ModelInfoService, ModelRegistry, ModelSwitchResult } from '@magic/model'
import { selectModel } from '@magic/model'
import type { LoadedConfig } from '@magic/state'
import { loadConfig } from '@magic/state'
import { providerRemovedNote, resolveModelChoice, validateSelection, modelCatalog, providerCatalog } from '@magic/host'
import type { ModelCatalogReader } from '@magic/host'
import type { RecordsStore } from '@magic/data'
import type { AgentSession } from './agent-assembly/session.ts'
import { createModelConfiguration } from './agent-assembly/model-configuration.ts'

/** 注册表缺席时那条切换结果的缘由（注入了替身网关＝这批装配换不了模型）。 */
const NO_REGISTRY = '本次装配没有供应商注册表（注入了替身网关）'

/** 模型域的依赖束——显式列出，不隐式持装配上下文。 */
export type ModelDomainDeps = {
  readonly loaded: LoadedConfig
  readonly magic: MagicHome
  readonly environment: Readonly<Record<string, string>>
  readonly fetch: FetchLike
  readonly now: () => Timestamp

  readonly sink: EventSink
  readonly forwardStamper: EventStamper
  /** 当下活跃的会话链（注册表写到它身上；没有会话时注册表归开局）。 */
  readonly chain: () => AgentSession | undefined
  readonly recordsStore: RecordsStore
  readonly collaborationChanged?: (() => void) | undefined
  /** 读侧目录命令的起手：还没有会话就先开一条（信封铸造器要它就位）。 */
  readonly ensureSession: () => Promise<void>
  readonly requireActiveStamper: () => EventStamper

  /** **注入替身网关**＝这批装配不建注册表、换不了模型（测试替身的那一形）。 */
  readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined
  /** 显式接续的会话与它的持久身份（开局选择只用于首次构造）。 */
  readonly startup?: SessionId | undefined
  readonly savedAgent?: AgentIdentity | undefined
}

export type ModelDomain = {
  readonly source: ReturnType<typeof createModelConfiguration>
  readonly info: ModelInfoService
  readonly modelsOf: () => ModelRegistry | undefined
  readonly rebuildRegistry: () => { readonly ok: true } | { readonly ok: false; readonly reason: string }
  readonly switchModel: (request: ModelSwitchRequest) => ModelSwitchResult
  readonly applyModel: (selection: AgentModelConfig) => ModelSwitchResult
  readonly listModels: (note?: string, saved?: boolean) => Promise<void>
  readonly listProviders: (note?: string, saved?: boolean) => Promise<void>
  readonly refreshModels: (provider?: string) => Promise<void>
  readonly saveModelSettings: (action: Extract<import('@magic/contracts').SettingsAction, { type: 'provider.save' | 'model.configure' | 'model.override' }>) => Promise<void>
  readonly removeProviderCommand: (provider: string) => Promise<void>
  readonly setPrefsCommand: (request: PrefsSetRequest) => Promise<void>
  readonly listWeb: () => Promise<void>
  readonly configureWebCommand: (provider: string | null) => Promise<void>
  /** 配置文件可能在盘上被别处改过——重读一遍刷新偏好读数（`Assembly.refreshSettings`）。 */
  readonly refreshSettings: () => void
  readonly contextWindowOf: (registry: ModelRegistry | undefined) => number | null
  /** 收尾前的状态保留（index 的 `close` 调它）：把当下注册表存回开局位。 */
  readonly suspend: () => void
}

export function createModelDomain(deps: ModelDomainDeps): ModelDomain {
  const { loaded, magic, environment, fetch, now, sink, forwardStamper, recordsStore } = deps
  const savedAgent = deps.savedAgent

  let statusLineConfig: StatusLineConfig | undefined = loaded.config.statusLine
  let turnDuration = loaded.config.turnDuration ?? 'elapsed'
  let reducedMotion = loaded.config.motion?.reduced === true
  /** 实验性 · 语音输入（D75）——**缺省关**；开关只在这一处读数上生效。 */
  let experimentalVoice = loaded.config.experimental?.voice === true

  const modelSource = createModelConfiguration({
    loaded, magic, environment, fetch, now,
    onError: message => {
      const session = deps.chain()
      if (session !== undefined) sink.emit(session.stamper.stamp('error', { message }))
    },
    onChange: () => {
      const session = deps.chain()
      if (session !== undefined) sink.emit(session.stamper.stamp('model.catalog', catalogOf(modelsOf())))
    },
  })
  const modelInfo = modelSource.info

  let initialModels: ModelRegistry | undefined
  // 会话建立后，模型选择只存于该会话链；开局选择只用于首次构造。
  const modelsOf = (): ModelRegistry | undefined => deps.chain() === undefined ? initialModels : deps.chain()!.models
  if (deps.modelGateway === undefined) {
    if (deps.startup !== undefined && savedAgent === undefined) {
      throw new Error('该工作缺少已保存的模型组合，无法按历史接回——请在 /config · 模型与连接 配置模型档位，/model 切到档位后继续；历史记录已保留')
    }
    const initial = savedAgent === undefined ? resolveModelChoice({ providers: modelSource.providers, configuredModels: modelSource.configured, defaultTier: modelSource.defaultTier, modelInfoOf: modelSource.knownModel }) : { ok: true as const, selection: savedAgent.model }
    initialModels = modelSource.registry(initial.ok ? initial.selection : undefined, forwardStamper)
  }

  const rebuildRegistry = (): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
    if (deps.modelGateway !== undefined) return { ok: true }

    const kept = modelsOf()?.current()
    const session = deps.chain()

    try {
      const candidate = modelSource.registry(kept, session?.stamper ?? forwardStamper)
      if (session === undefined) initialModels = candidate
      else session.models = candidate
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `配置已保存，但这次装配还用不上它：${reason}` }
    }

    return { ok: true }
  }

  const commitModel = (checked: ModelSwitchResult): ModelSwitchResult => {
    const models = modelsOf()
    const session = deps.chain()
    if (session === undefined) {
      if (models === undefined) return { ok: false, reason: NO_REGISTRY }
      if (!checked.ok) return checked
      try {
        initialModels = modelSource.registry(checked.selection, forwardStamper)
        return checked
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    // 注册表缺席（注入了替身网关）＝如实报「这批装配换不了模型」——同样是一条**切换结果**
    if (models === undefined) {
      const missing: ModelSwitchResult = { ok: false, reason: NO_REGISTRY }
      sink.emit(forwardStamper.stamp('model.switched', missing))
      return missing
    }

    let result: ModelSwitchResult
    if (recordsStore.collaboration.agentForSession(session.session)?.purpose === 'consultation') result = { ok: false, reason: '咨询固定使用启动时解析的 Arcane，不开放成员换模' }
    else if (!checked.ok) result = checked
    else {
      try {
        const candidate = modelSource.registry(checked.selection, session.stamper)
        const identity = recordsStore.collaboration.agentForSession(session.session)
        // 持久更新失败不发布新网关；入口与成员都只改自己的身份，不碰协作派生默认。
        if (identity !== undefined) recordsStore.collaboration.updateAgent(identity.agentId, { model: checked.selection })
        session.models = candidate
        result = checked
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    const budget = result.ok
      ? session.models?.capacityOf(result.selection.provider, result.selection.model)?.inputBudget
      : undefined

    sink.emit(
      result.ok
        ? forwardStamper.stamp('model.switched', {
          ok: true,
          choice: result.selection.choice,
          ...(result.selection.reasoning === undefined ? {} : { reasoning: result.selection.reasoning }),
          provider: result.selection.provider,
          model: result.selection.model,
          protocol: result.selection.protocol,
          endpoint: result.selection.endpoint,
          ...(budget === undefined ? {} : { inputBudget: budget }),
        })
        : forwardStamper.stamp('model.switched', { ok: false, reason: result.reason }),
    )

    if (result.ok) {
      // 主会话切档成功 ⇒ 开局档位记录跟着走（新会话从这次的选择继续）；成员不写记录。
      // 落笔失败不动摇已完成的切换——如实报一声，不吞掉。信封**同步预铸**：
      // 写回是异步的，回调时链条可能已收摊，那时再铸会炸。
      if (result.selection.choice !== undefined && recordsStore.collaboration.agentForSession(session.session) === undefined) {
        const recordMiss = forwardStamper.stamp('error', { message: '模型已切换，但开局档位记录未写回（配置可能被并发修改）；下次切档会再试' })
        void modelSource.persistDefaultTier(result.selection.choice).then(ok => {
          if (!ok) { try { sink.emit(recordMiss) } catch { /* 收摊后的迟到通知无处可去 */ } }
        }).catch(() => {
          try { sink.emit(recordMiss) } catch { /* 同上 */ }
        })
      }
      try { deps.collaborationChanged?.() }
      catch (error) { sink.emit(forwardStamper.stamp('error', { message: `模型已切换，但协作状态通知失败：${String(error)}` })) }
    }
    return result
  }

  const switchModel = (request: ModelSwitchRequest): ModelSwitchResult => {
    modelSource.sync()
    const models = modelsOf()
    const checked = models === undefined ? { ok: false as const, reason: NO_REGISTRY }
      : validateSelection({ models, configuredModels: modelSource.configured, providers: modelSource.providers, config: request, modelInfoOf: modelSource.knownModel })
    return commitModel(checked)
  }

  // 仅受信任的宿主内部配置消息使用已解析组合，不重新读取可变映射。
  const applyModel = (selection: AgentModelConfig): ModelSwitchResult =>
    commitModel((modelsOf() === undefined ? undefined : selectModel({ providers: modelSource.providers, modelInfoOf: modelSource.knownModel }, selection)) ?? { ok: false, reason: NO_REGISTRY })

  const listModels = async (note?: string, saved?: boolean): Promise<void> => {
    await deps.ensureSession()
    const catalog = catalogOf(modelsOf())
    sink.emit(deps.requireActiveStamper().stamp('model.catalog', {
      ...catalog, stamp: modelSource.stamp,
      ...(note === undefined ? {} : { note }), ...(saved === undefined ? {} : { saved })
    }))
  }

  /** 纯目录投影与常驻观察面共用；活跃执行者仍提供真实内存选中与缓存。 */
  const catalogReader = (registry: ModelRegistry | undefined): ModelCatalogReader => {
    modelSource.sync()
    const current = registry?.current()
    return {
      providers: modelSource.providers,
      configuredModels: modelSource.configured,
      entries: Object.keys(modelSource.providers).map(id => ({ id })),
      ...(current === undefined ? {} : { current }),
      read: (provider) => modelInfo.read(provider),
      describe: modelInfo.describe,
      inputBudget: (provider, model) => registry?.capacityOf(provider, model)?.inputBudget,
    }
  }

  const catalogOf = (registry: ModelRegistry | undefined): EventDataOf['model.catalog'] =>
    registry === undefined ? { entries: [], note: NO_REGISTRY } : modelCatalog(catalogReader(registry), modelSource.configured)

  const providerCatalogOf = (note?: string): EventDataOf['provider.catalog'] => providerCatalog(catalogReader(modelsOf()), note)

  const listProviders = async (note?: string, saved?: boolean): Promise<void> => {
    await deps.ensureSession()
    sink.emit(deps.requireActiveStamper().stamp('provider.catalog', { ...providerCatalogOf(note), stamp: modelSource.stamp, ...(saved === undefined ? {} : { saved }) }))
  }

  const refreshModels = async (provider?: string): Promise<void> => {
    const target = provider ?? modelsOf()?.current()?.provider ?? modelSource.configured?.[modelSource.defaultTier ?? 'cantrip']?.provider
    if (target === undefined) {
      listModels('还没有可刷新的连接——先接入一个供应商')
      return
    }
    listModels()
    await modelInfo.refresh(target)
  }

  /**
   * 保存供应商、模型信息与档位映射，成功后同步配置读面。
   * 当前 Agent 的有效选择仍只由明确应用动作改变。
   */
  const saveModelSettings = async (action: Extract<import('@magic/contracts').SettingsAction, { type: 'provider.save' | 'model.configure' | 'model.override' }>): Promise<void> => {
    const { note, saved } = await modelSource.save(action)
    if (action.type === 'provider.save') await listProviders(note, saved)
    else await listModels(note, saved)
  }

  /** 网页服务读数（U94）——读的是盘上当下的配置；不发起网页或模型推理请求。 */
  const emitWebState = (note?: string, saved?: boolean): void => {
    const config = loadConfig({ path: loaded.path, magic }).config
    sink.emit(deps.requireActiveStamper().stamp('web.state', {
      ...(config.web === undefined ? {} : { provider: config.web.provider }),
      ...(config.models?.cantrip === undefined ? {} : { cantrip: config.models.cantrip }),
      ...(saved === undefined ? {} : { saved }),
      ...(note === undefined ? {} : { note }),
    }))
  }

  const listWeb = async (): Promise<void> => {
    await deps.ensureSession()
    emitWebState('读的是已保存的配置；浏览不发起网页或模型调用')
  }

  const configureWebCommand = async (provider: string | null): Promise<void> => {
    await deps.ensureSession()
    const { note, saved } = await modelSource.save({ type: 'web.configure', provider })
    emitWebState(note, saved)
  }

  const setPrefsCommand = async (request: PrefsSetRequest): Promise<void> => {
    const outcome = await modelSource.setPrefs(request)

    if (outcome.ok) {
      // 保存成功后更新当前偏好读数。
      if (request.statusLine !== undefined) statusLineConfig = request.statusLine
      if (request.reducedMotion !== undefined) reducedMotion = request.reducedMotion
      if (request.turnDuration !== undefined) turnDuration = request.turnDuration
      if (request.voice !== undefined) experimentalVoice = request.voice
    }

    const changed: string[] = []
    if (request.statusLine !== undefined) changed.push('状态行')
    if (request.reducedMotion !== undefined) changed.push('动效')
    if (request.turnDuration !== undefined) changed.push('本轮耗时')
    if (request.voice !== undefined) changed.push('语音输入')

    sink.emit(
      deps.requireActiveStamper().stamp('prefs.state', {
        ...(statusLineConfig === undefined ? {} : { statusLine: statusLineConfig }),
        reducedMotion, turnDuration,
        voice: experimentalVoice,
        note: outcome.ok
          ? `已更新：${changed.join(' · ')}`
          : `${changed.join(' · ')}没改成——${outcome.reason}`,
      }),
    )
  }

  const removeProviderCommand = async (provider: string): Promise<void> => {
    const outcome = await modelSource.remove(provider)
    if (!outcome.ok) {
      await listProviders(outcome.reason)
      return
    }
    const rebuilt = rebuildRegistry()
    const note = providerRemovedNote(provider, {
      connections: Object.keys(modelSource.providers).length,
      hasModel: modelsOf() === undefined || modelsOf()?.current() !== undefined,
    })
    listProviders([note, rebuilt.ok ? undefined : rebuilt.reason, outcome.note].filter(one => one !== undefined).join('；'))
  }

  const contextWindowOf = (registry: ModelRegistry | undefined): number | null => {
    if (registry === undefined) return null

    // 还没有去向（没配缺省连接 / 还没选过模型）⇒ **没有分母可言**——不取列表第一项，
    // 也不拿别的模型的窗长顶上（「拿不到的不编」）
    const current = registry.current()
    if (current === undefined) return null

    return registry.capacityOf(current.provider, current.model)?.inputBudget ?? null
  }

  return {
    source: modelSource,
    info: modelInfo,
    modelsOf,
    rebuildRegistry,
    switchModel,
    applyModel,
    listModels,
    listProviders,
    refreshModels,
    saveModelSettings,
    removeProviderCommand,
    setPrefsCommand,
    listWeb,
    configureWebCommand,
    refreshSettings: () => {
      const current = loadConfig({ path: loaded.path, magic })
      statusLineConfig = current.config.statusLine
      turnDuration = current.config.turnDuration ?? 'elapsed'
      reducedMotion = current.config.motion?.reduced === true
      experimentalVoice = current.config.experimental?.voice === true
    },
    contextWindowOf,
    suspend: () => { initialModels = modelsOf() },
  }
}
