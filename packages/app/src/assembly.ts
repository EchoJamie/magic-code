/** 装配入口：构造共享资源，按会话建立执行链，绑定控制与恢复端口。
 * 共享配置不携带 Agent 选择；当前展示只指向一条会话链。
 * 调用方先订阅 shell，再 boot/恢复，最后放开输入。
 */
import { createAssemblyGrants, type GrantsView } from './agent-assembly/grants.ts'
import { createModelConfiguration } from './agent-assembly/model-configuration.ts'
import { createAgentSession, type AgentSession, type EnvironmentVars } from './agent-assembly/session.ts'
import { noticesOf, providerRemovedNote } from './run/observation.ts'
import { createWorkEnvironment, type WorkEnvironment } from './work-environment.ts'
export type { GrantsView } from './agent-assembly/grants.ts'
export type { EnvironmentVars } from './agent-assembly/session.ts'
export { createStamper } from './agent-assembly/events.ts'
export { workspaceOf } from './run/observation.ts'

import type { SessionPorts } from '@magic/actions'
import { createActions } from '@magic/actions'
import type {
  AgentModelConfig,
  BackgroundRuns,
  CollaborationReply,
  CollaborationRequest,
  ControlTransport,
  EventDataOf,
  EventKind,
  EventSink,
  EventStamper,
  MagicHome,
  McpConnectionState,
  McpToolRejection,
  ModelGateway,
  ModelSwitchRequest,
  PrefsSetRequest,
  ProcessLedger,
  RulesLoad,
  SessionId,
  SkillCatalog,
  StatusLineConfig,
  Timestamp,
  UserInput,
  WebSource,
} from '@magic/contracts'
import { GRANTS_FILE_NAME, TRANSIENT_EVENT_KINDS, expandHome } from '@magic/contracts'
import { createControlHub, createInProcessTransportPair } from '@magic/control'
import type { ContextPolicy, SessionInstance } from '@magic/conversation'
import { createConversationService } from '@magic/conversation'
import {
  createBackgroundRuns,
  createMaterials,
  createProcessLedger,
  createProjectRules,
  createSandbox,
  createSkills,
  createWorkspaceService,
  imageBytesOf,
  readClipboardImage,
  reapOwned,
} from '@magic/execution'
import type { McpServers } from '@magic/mcp'
import { createMcpServers } from '@magic/mcp'
import type { FetchLike, ModelInfoService, ModelRegistry, ModelSwitchResult } from '@magic/model'
import { selectModel } from '@magic/model'
import type { PermissionRule, RuleProblem } from '@magic/permission'
import { parseRules } from '@magic/permission'
import type { RecordsStore } from '@magic/records'
import { createRecordsStore } from '@magic/records'
import type { ToolDefinition } from '@magic/tools'
import { defineMcpTools } from '@magic/tools'
import { tmpdir } from 'node:os'
import { resolveModelChoice, validateSelection } from './agent-models.ts'
import type { LoadedConfig } from '@magic/config'
import { loadConfig } from '@magic/config'
import { saveImageFile } from './image-file.ts'
import type { ModelCatalogReader } from './run/observation.ts'
import {
  grantsCatalog,
  mcpCatalog,
  modelCatalog,
  pathsCatalog,
  providerCatalog,
  skillsCatalog,
  workspaceOf,
} from './run/observation.ts'
import { backgroundOutputDirOf, runPathsOf } from './run/paths.ts'

/** 瞬时类不落库（契约 `TRANSIENT_EVENT_KINDS`——记录 schema v0 规则 ①）。 */
const TRANSIENT: ReadonlySet<EventKind> = new Set(TRANSIENT_EVENT_KINDS)

/** 装配入参——一切「从外面拿的」都经此进来（测试与入口复用同一条路径）。 */
export type AssembleOptions = {
  readonly ledger?: ProcessLedger
  readonly environment?: Readonly<Record<string, string>>
  readonly network?: WorkEnvironment
  readonly signal?: AbortSignal

  readonly records?: RecordsStore

  readonly collaboration?: ((session: SessionId, request: CollaborationRequest) => Promise<CollaborationReply>) | undefined
  readonly collaborationChanged?: (() => void) | undefined
  readonly executionId?: string | undefined
  /** **启动目录**——首站单根＝默认根（技术方案 · 执行 · 工作区）。须是**已存在**的路径。 */
  readonly cwd: string
  /** 已加载的配置——缺省 `loadConfig({ magic })`（读 `<基础目录>/config.json`）。 */
  readonly config?: LoadedConfig | undefined

  readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined

  readonly modelFetch?: FetchLike | undefined

  readonly webSource?: WebSource | undefined
  /**
   * **显式接续**：给 id ＝ 开局就装载这条会话（并跑一次恢复处置在途）。
   * **不给 ＝ 启动＝新会话**（D4）：一个会话都不开，首条消息按下回车才建立（D5）。
   */
  readonly session?: SessionId | undefined
  /** 时钟——条目 / 信封的时间戳（域不各自取时钟）；缺省 `Date.now`。 */
  readonly now?: (() => Timestamp) | undefined

  readonly context?: Partial<ContextPolicy> | undefined
  /** 提示词的环境注入项（见 `EnvironmentVars`）。 */
  readonly prompt?: EnvironmentVars | undefined
  /**
   * **授权文件的落点**——缺省 `<基础目录>/grants.json`（`~` 在此展开）。
   *
   * 与 config.json 同属基础目录；覆盖参数只供显式注入使用。
   */
  readonly grantsFile?: string | undefined
  /** 入口已确定的系统家目录与 Magic 基础目录；装配不读取环境补位置。 */
  readonly magic: MagicHome

  readonly mcpTimeouts?:
  | { readonly connectTimeoutMs?: number; readonly callTimeoutMs?: number }
  | undefined

  readonly allowAll?: boolean | undefined
}

/** 装配产物——外壳侧一端 ＋ 自检 / 验收要用的把手。 */
/** 注册表缺席时那条切换结果的缘由（注入了替身网关＝这批装配换不了模型）。 */
const NO_REGISTRY = '本次装配没有供应商注册表（注入了替身网关）'

export type McpServerView = {
  readonly server: string
  /** 哪一种接入（`stdio` / `http`）——这一屏有两条来路，读数上分得开。 */
  readonly transport: 'stdio' | 'http'
  readonly state: McpConnectionState
  readonly tools: readonly string[]

  readonly rejected: readonly McpToolRejection[]
}

export type Assembly = {
  refreshSettings(): void
  reconnectMcp(server: string): Promise<string>
  /** 当前执行实例仍有明确输入消费意图；遗留持久输入不算自动继续授权。 */
  hasPendingInput(): boolean
  /** 只唤起已装配的同一身份，持久收件在主循环边界消费。 */
  wakeCollaboration(): void
  /** 原样保留输入引用，由会话读取、接收并发布共享约束。 */
  supplementCollaboration(input: UserInput, shared: boolean): Promise<void>
  /**
   * **换模型**——装配侧的**唯一**切换入口：命令面（`model.switch`）与 `--script` 的
   * `{switch}` 都调它，**成败都发一条 `model.switched`（落库）**（缺陷 D16 收拢的产出路径）。
   * 结果原样交回调用方（脚本据以决定继续还是当场停）。
   */
  readonly applyModel: (selection: AgentModelConfig) => ModelSwitchResult
  readonly switchModel: (request: ModelSwitchRequest) => ModelSwitchResult

  readonly modelInfo: ModelInfoService
  /**
   * **外壳侧一端**（契约 `ControlTransport`）——接外壳。
   * 用法＝先 `subscribe(…)`、后 `send(…)`（顺序纪律见文件头注）。
   */
  readonly shell: ControlTransport
  /**
   * **当下活跃**的会话 id（单活跃——切换之后跟着变）；
   * **`undefined` ＝ 还没有会话**（空手打开；首条消息按下回车才建立——D5）。
   */
  readonly session: SessionId | undefined
  /** 本次装配用的配置（自检报告用；**不含 key**）。 */
  readonly config: LoadedConfig

  readonly magic: MagicHome

  readonly models: ModelRegistry | undefined
  /** 库把手——收尾（`close`）· 入口那道 `magic resume` 校验（U28）· 验收脚本用。 */
  readonly records: RecordsStore
  /** 数据落点（`records.db` 与 `blobs/` 的绝对路径）。 */
  readonly paths: { readonly database: string; readonly blobs: string }
  /**
   * 本次生效的**权限规则**（配置 `permissions.rules` 经权限域 `parseRules` 的落地）——
   * 自检 / 验收据以确认「规则真的接进闸门了」。
   */
  readonly permissionRules: readonly PermissionRule[]
  /**
   * **被拒的规则条目**（连同缘由）——解析从严：读不懂的**不生效**（而不是退化成更宽的规则）。
   * 缘由交回装配是**给用户看的**：静默丢弃会让人对着一条不生效的规则发呆。
   */
  readonly rejectedRules: readonly RuleProblem[]

  readonly grantsPath: string

  readonly grantsView: () => GrantsView

  readonly grantsUnreadable: string | undefined

  notices(): Promise<readonly string[]>

  readonly mcpServers: () => readonly McpServerView[]

  ready(): Promise<void>

  shutdown(): Promise<void>

  readonly contextWindow: number | null
  readonly readRules: (targets?: readonly string[]) => Promise<RulesLoad>

  readonly readSkills: () => Promise<SkillCatalog>

  readonly workspaceRoots: readonly string[]

  boot(): Promise<void>
  /**
   * 关库（blob 无需收尾）＋ **发起**外部服务器的释放（不等它——要等请 `await shutdown()`）。
   */
  close(): void

  readonly ledger: ProcessLedger

  readonly background: BackgroundRuns | undefined
}

export function assemble(options: AssembleOptions): Assembly {
  // 入口拥有位置选择权；装配与下游共用传入结果。
  const network = options.network ?? createWorkEnvironment(options.environment ?? process.env)
  const environment = network.env
  const fetch: FetchLike = (input, init) => (options.modelFetch ?? network.fetch)(input, { ...init, signal: init?.signal == null ? signal : AbortSignal.any([signal, init.signal]) })
  const lifetime = new AbortController()
  const signal = options.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, options.signal])
  const magic = options.magic
  const loaded = options.config ?? loadConfig({ magic })
  const now = options.now ?? Date.now
  const startup = options.session
  // 先读持久身份，再建立执行边界。此查询不创建会话，也不采信后来变更的全局根。
  const savedAgent = (() => {
    if (startup === undefined) return undefined
    const lookup = options.records ?? createRecordsStore({ dataDir: magic.base, workspace: [options.cwd] })
    try { return lookup.collaboration.agentForSession(startup) }
    finally { if (!options.records) lookup.close() }
  })()

  const workspace = savedAgent === undefined
    ? workspaceOf(loaded, options.cwd)
    : createWorkspaceService({ roots: savedAgent.workspace })

  const ledger = options.ledger ?? createProcessLedger()

  const executionId = options.executionId ?? crypto.randomUUID()
  const backgroundDir = ((): string | undefined => {
    try {
      return `${backgroundOutputDirOf(runPathsOf(magic, tmpdir()))}/${executionId}`
    } catch {
      return undefined
    }
  })()

  const backgroundRuns =
    backgroundDir === undefined
      ? undefined
      : createBackgroundRuns({ dir: backgroundDir, workspace, ledger, env: environment, signal })

  const sandbox = createSandbox({
    env: environment,
    workspace,
    ledger,
  })

  const mcp: McpServers = createMcpServers({
    environment, cwd: workspace.defaultRoot(), signal, fetch: network.fetch,
    servers: savedAgent?.purpose === 'consultation' ? {} : loaded.config.mcp?.servers ?? {},
    ledger,
    ...(options.mcpTimeouts?.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.mcpTimeouts.connectTimeoutMs }),
    ...(options.mcpTimeouts?.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.mcpTimeouts.callTimeoutMs }),
  })

  const mcpTools = (): readonly ToolDefinition[] =>
    mcp.connections.flatMap((connection) => [...defineMcpTools(connection)])

  const projectRules = createProjectRules({
    signal,
    workspace,
    sources: loaded.config.rules?.sources ?? [],
    // 两张名册两件事（契约 `RulesConfig`）：`sources` 读进来，`linkSources` 只放行链接
    linkSources: loaded.config.rules?.linkSources ?? [],
  })

  const skills = createSkills({
    signal,
    workspace,
    magicBase: magic.base,
    home: magic.home,
    sources: loaded.config.skills?.sources ?? [],
  })

  const materials = createMaterials({ workspace })

  const grantState = createAssemblyGrants({
    path: options.grantsFile === undefined
      ? `${magic.base}/${GRANTS_FILE_NAME}`
      : expandHome(options.grantsFile, magic.home),
    workspace: workspace.defaultRoot(), now,
  })

  const recordsStore = options.records?.forWorkspace(workspace.roots()) ?? createRecordsStore({
    dataDir: magic.base,
    workspace: workspace.roots(),
  })

  // 所有会话共享控制广播与记录连接；信封仍由各自的铸造器生成。
  const hub = createControlHub(error => {
    if (chain === undefined) throw error
    sink.emit(chain.stamper.stamp('error', { message: `控制操作失败：${error instanceof Error ? error.message : String(error)}` }))
  })
  const sink: EventSink = {
    emit(event) {
      // ① 控制广播**全部**（含瞬时增量——渲染要实时）
      //    先广播后落库：反过来的话，落库一炸（载荷非 JSON 等）就是外壳**静默**漏事件
      //    ——比如一条裁决询问没显示出来，用户永远等不到提示。丢持久可查、丢渲染会挂。
      hub.emit(event)
      if (!TRANSIENT.has(event.kind)) recordsStore.appendEvent(event)
    },
  }

  // 解析结果供自检读取；会话闸门在裁决时读取最新配置。
  const parsedRules = parseRules(loaded.config.permissions?.rules ?? [])

  /** 当前展示会话的控制面事件使用转发铸造器；执行链使用自己的铸造器。 */
  const forwardStamper: EventStamper = {
    stamp: (kind, data) => requireActiveStamper().stamp(kind, data),
    beginTurn: (turn) => requireActiveStamper().beginTurn(turn),
  }

  const requireActiveStamper = (): EventStamper => {
    if (chain === undefined) {
      throw new Error('信封铸造器还没就位——装配次序错了（会话链要先开一条）')
    }
    return chain.stamper
  }

  let statusLineConfig: StatusLineConfig | undefined = loaded.config.statusLine
  let turnDuration = loaded.config.turnDuration ?? 'elapsed'
  let reducedMotion = loaded.config.motion?.reduced === true

  const modelSource = createModelConfiguration({
    loaded, magic, environment, fetch, now,
    onError: message => {
      if (chain !== undefined) sink.emit(chain.stamper.stamp('error', { message }))
    },
    onChange: () => {
      if (chain !== undefined) sink.emit(chain.stamper.stamp('model.catalog', catalogOf(modelsOf())))
    },
  })
  const modelInfo = modelSource.info

  let initialModels: ModelRegistry | undefined
  // 会话建立后，模型选择只存于该会话链；开局选择只用于首次构造。
  const modelsOf = (): ModelRegistry | undefined => chain === undefined ? initialModels : chain.models
  if (options.modelGateway === undefined) {
    if (startup !== undefined && savedAgent === undefined) {
      throw new Error('该工作缺少已保存的模型组合，无法可靠接回；历史记录已保留')
    }
    const initial = savedAgent === undefined ? resolveModelChoice({ providers: modelSource.providers, configuredModels: modelSource.configured, modelInfoOf: modelSource.knownModel }) : { ok: true as const, selection: savedAgent.model }
    initialModels = modelSource.registry(initial.ok ? initial.selection : undefined, forwardStamper)
  }

  const rebuildRegistry = (): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
    if (options.modelGateway !== undefined) return { ok: true }

    const kept = modelsOf()?.current()

    try {
      const candidate = modelSource.registry(kept, chain?.stamper ?? forwardStamper)
      if (chain === undefined) initialModels = candidate
      else chain.models = candidate
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `配置已保存，但这次装配还用不上它：${reason}` }
    }

    return { ok: true }
  }

  let chain: AgentSession | undefined
  const chains = new Map<SessionId, AgentSession>()

  const open = (session: SessionId): SessionInstance => {
    const previous = chains.get(session)
    if (previous !== undefined) {
      chain = previous
      return previous
    }
    const opened = createAgentSession({
      session, magic, context: options.context, prompt: options.prompt,
      webSource: options.webSource, modelGateway: options.modelGateway, allowAll: options.allowAll,
      collaboration: options.collaboration, collaborationChanged: options.collaborationChanged,
      loaded, recordsStore, workspace, grantState, sink, now,
      signal, network, executionId, backgroundRuns, backgroundDir,
      sandbox, projectRules, skills, materials, mcpTools,
      model: {
        create: (selection, stamper) => {
          const current = modelsOf()
          return current === undefined ? undefined : modelSource.registry(selection ?? current.current(), stamper)
        },
        cantrip: modelSource.cantrip,
        canDistill: () => { modelSource.sync(); return modelSource.configured?.cantrip !== undefined },
        connections: () => Object.keys(modelSource.providers).length,
        webSource: modelSource.webSource,
      },
    })
    chains.set(session, opened)
    chain = opened
    sink.emit(opened.stamper.stamp('background.state', opened.background?.view() ?? { commands: [], waiting: [] }))
    return opened
  }

  const actionPorts = (): SessionPorts => {
    const current = active()
    return {
      session: current.session,
      records: current.records,
      tools: current.tools,
      stamper: current.stamper,
    }
  }

  /** 当下这束——路由转发用（`open` 至少跑过一次，见 `createConversationService` 的构造）。 */
  const active = (): AgentSession => {
    if (chain === undefined) throw new Error('会话链还没开——装配次序错了')
    return chain
  }

  const conversation = createConversationService({
    session: startup,
    open,
    // 记录域**读面**（窄口）：会话未定时也要能读（目录 / 首条消息 / 重建展示）
    records: {
      listSessions: async query => (await recordsStore.listSessions(query)).filter(row => {
        const collaboration = recordsStore.collaboration.collaborationForSession(row.id)
        return collaboration === undefined || collaboration.originSessionId === row.id
      }),
      readEntries: recordsStore.readEntries,
      readEntriesBack: recordsStore.readEntriesBack,
      readEvents: session => recordsStore.serviceFor(session).readEvents(session),
      blobs: recordsStore.blobs,
    },
    setTitle: (session, title, at) => recordsStore.setSessionTitle(session, title, at),
    sink,
    now,
    saveImage: (file) => saveImageFile(file),
  })

  const actions = createActions({ conversation, sink, now })

  const commitModel = (checked: ModelSwitchResult): ModelSwitchResult => {
    const models = modelsOf()
    if (chain === undefined) {
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
    if (recordsStore.collaboration.agentForSession(chain.session)?.purpose === 'consultation') result = { ok: false, reason: '咨询固定使用启动时解析的 Arcane，不开放成员换模' }
    else if (!checked.ok) result = checked
    else {
      try {
        const candidate = modelSource.registry(checked.selection, chain.stamper)
        const identity = recordsStore.collaboration.agentForSession(chain.session)
        // 持久更新失败不发布新网关；入口与成员都只改自己的身份，不碰协作派生默认。
        if (identity !== undefined) recordsStore.collaboration.updateAgent(identity.agentId, { model: checked.selection })
        chain.models = candidate
        result = checked
      } catch (error) {
        result = { ok: false, reason: error instanceof Error ? error.message : String(error) }
      }
    }

    const budget = result.ok
      ? chain.models?.capacityOf(result.selection.provider, result.selection.model)?.inputBudget
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
      try { options.collaborationChanged?.() }
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
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
    const catalog = catalogOf(modelsOf())
    sink.emit(requireActiveStamper().stamp('model.catalog', {
      ...catalog, stamp: modelSource.stamp,
      ...(note === undefined ? {} : { note }), ...(saved === undefined ? {} : { saved })
    }))
  }

  const listSkills = async (): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('skills.catalog', (await skillCatalogOf())))
  }

  const listPaths = async (query: string): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })

    sink.emit(requireActiveStamper().stamp('paths.catalog', await pathsCatalog(materials, query)))
  }

  const identifyPath = async (path: string, external?: true): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })

    let image: EventDataOf['paths.identified']['image']
    try {
      const found = await materials.load([
        { kind: 'file', source: path, ...(external === true ? { external: true as const } : {}) },
      ])
      const material = found.ok ? found.materials[0] : undefined

      image =
        material === undefined || material.kind !== 'image'
          ? undefined
          : {
            mime: material.mime,
            name: material.name,
            bytes: material.bytes.length,
            blob: await recordsStore.blobs.put(material.bytes),
            label: material.label,
          }
    } catch {
      image = undefined
    }

    sink.emit(
      requireActiveStamper().stamp('paths.identified', {
        path,
        ...(image === undefined ? {} : { image }),
      }),
    )
  }

  const CLIPBOARD_IMAGE_NAME = '剪贴板'

  const pasteClipboardImage = async (): Promise<void> => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })

    let image: EventDataOf['input.pasted']['image']
    let problem: string | undefined
    try {
      const read = await readClipboardImage()
      if (!read.ok) {
        problem = read.reason
      } else {
        // **两把尺子在这里过**（与按路径取图同一处判据）——不过就说清是哪一条不过
        const checked = imageBytesOf(read.bytes, '剪贴板里这一张')
        if (!checked.ok) problem = checked.reason
        else {
          image = {
            mime: checked.mime,
            // ⚠️ **它没有文件名**（剪贴板来的那一张本来就没有落位）——这一格是
            // `image` 支的必填，故给一个**说得出出处、不冒充文件**的名字。
            // 一段输入里认它是靠 `Image#N`（那一处引用块），这一格只是出处。
            name: CLIPBOARD_IMAGE_NAME,
            bytes: read.bytes.length,
            blob: await recordsStore.blobs.put(read.bytes),
            label: CLIPBOARD_IMAGE_NAME,
          }
        }
      }
    } catch (error) {
      // 落 blob 那一步炸了（写不进去）——**这一张没送成**，如实说
      problem = `剪贴板里那一张没能存下来（${error instanceof Error ? error.message : String(error)}）。`
    }

    sink.emit(
      requireActiveStamper().stamp('input.pasted', {
        ...(image === undefined ? {} : { image }),
        ...(problem === undefined ? {} : { problem }),
      }),
    )
  }

  const skillCatalogOf = async (): Promise<EventDataOf['skills.catalog']> => skillsCatalog((await skills.discover()))

  const contextWindowOf = (registry: ModelRegistry | undefined): number | null => {
    if (registry === undefined) return null

    // 还没有去向（没配缺省连接 / 还没选过模型）⇒ **没有分母可言**——不取列表第一项，
    // 也不拿别的模型的窗长顶上（「拿不到的不编」）
    const current = registry.current()
    if (current === undefined) return null

    return registry.capacityOf(current.provider, current.model)?.inputBudget ?? null
  }

  const listGrants = async (note?: string): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('grants.catalog', grantsCatalogOf(note)))
  }

  const grantsCatalogOf = (note?: string): EventDataOf['grants.catalog'] =>
    grantsCatalog(grantState.view(), active().gate.tally(), recordsStore.decisionHistory(), note, grantState.trouble(), grantState.writeError)

  const revokeGrants = async (section?: string, index?: number): Promise<void> => {
    const target = section ?? workspace.defaultRoot()

    if (index === undefined) {
      const dropped = await grantState.ledger.dropSection(target)
      listGrants(
        dropped === 0
          ? `没撤成：${target} 那一节不在名录里`
          : `已撤销整节：${target}（${dropped} 条）`,
      )
      return
    }

    // 回执要报出**撤掉的是哪一条**——名录得在撤销**之前**取（撤完它就没了）。
    // 只有撤**本工作区**时才取得到：`view()` 读的就是本工作区那一节，
    // 撤别处（陈旧节那条路走的是 index 缺省，到不了这里）时如实说「那一条」而不编名字
    const named =
      target === workspace.defaultRoot() ? grantState.ledger.view()[index]?.describe : undefined
    const done = await grantState.ledger.revoke(target, index)

    listGrants(done ? `已撤销：${named ?? '那一条'}` : '没撤成：那一条已经不在了')
  }

  const listMcp = async (note?: string): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('mcp.catalog', mcpCatalogOf(note)))
  }

  const mcpServers = (): readonly McpServerView[] =>
    mcp.connections.map((connection) => ({
      server: connection.server,
      transport: connection.transport,
      state: connection.state,
      tools: connection.tools().map((tool) => tool.name),
      rejected: connection.rejected,
    }))

  /** 那一屏 → 契约载荷（照列一排：端口形态到此为止，事件面只出现读得出来的那几格）。 */
  const mcpCatalogOf = (note?: string): EventDataOf['mcp.catalog'] => mcpCatalog(mcpServers(), note)

  /**
   * **显式重连一台**（U39）——重走一趟起手与发现，**不重放任何业务调用**。
   *
   * 认不出的名字不当作错误：名录照给，缘由写在答复的 `note` 上（那一屏照旧说得出全部内容）。
   */
  const reconnectMcp = async (server: string): Promise<string> => {
    const connection = await mcp.reconnect(server)
    if (connection === undefined) return `没有配这一台：「${server}」——配置里 mcp.servers 的条目名才是身份`
    return connection.state.status === 'available' ? `已重连「${server}」` : `重连没成：「${server}」`
  }

  /** 项目规约的按需读数——见 `Assembly.readRules`。 */
  const readRules = async (targets: readonly string[] = []): Promise<RulesLoad> => (await (chain?.roleRules ?? projectRules).load(targets))

  /** 技能目录的按需读数——见 `Assembly.readSkills`。 */
  const readSkills = async (): Promise<SkillCatalog> => (await skills.discover())

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
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('provider.catalog', { ...providerCatalogOf(note), stamp: modelSource.stamp, ...(saved === undefined ? {} : { saved }) }))
  }

  const refreshModels = async (provider?: string): Promise<void> => {
    const target = provider ?? modelsOf()?.current()?.provider ?? modelSource.configured?.default?.provider
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
    sink.emit(requireActiveStamper().stamp('web.state', {
      ...(config.web === undefined ? {} : { provider: config.web.provider }),
      ...(config.models?.cantrip === undefined ? {} : { cantrip: config.models.cantrip }),
      ...(saved === undefined ? {} : { saved }),
      ...(note === undefined ? {} : { note }),
    }))
  }

  /** 与 `listModels` 同一条起手：还没有会话就先开一条（信封铸造器要它就位）。 */
  const ensureSession = async (): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
  }

  const listWeb = async (): Promise<void> => {
    await ensureSession()
    emitWebState('读的是已保存的配置；浏览不发起网页或模型调用')
  }

  const configureWebCommand = async (provider: string | null): Promise<void> => {
    await ensureSession()
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
    }

    const changed: string[] = []
    if (request.statusLine !== undefined) changed.push('状态行')
    if (request.reducedMotion !== undefined) changed.push('动效')
    if (request.turnDuration !== undefined) changed.push('本轮耗时')

    sink.emit(
      requireActiveStamper().stamp('prefs.state', {
        ...(statusLineConfig === undefined ? {} : { statusLine: statusLineConfig }),
        reducedMotion, turnDuration,
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

  hub.bind({
    // 提交输入前也同步一次（裁决：「配置变更时**重取实际连接资料**」——用户改完配置
    // 直接发消息、不看 `/model` 的那条路也要用上新资料）
    onBackground: async command => {
      if (command.type === 'background.list') {
        if (chain) sink.emit(chain.stamper.stamp('background.state', chain.background?.view() ?? { commands: [], waiting: [] }))
      } else {
        const outcome = command.target.execution !== executionId ? { ok: false as const, reason: '执行代次已改变' } : await chains.get(command.target.session)?.background?.stop(command.target.id) ?? { ok: false as const, reason: '目标会话不存在' }
        if (chain) sink.emit(chain.stamper.stamp('background.state', { ...(chain.background?.view() ?? { commands: [], waiting: [] }), result: { target: command.target, outcome } }))
      }
    },
    onInputManage: command => conversation.manage(command),
    onInput: (input) => {
      modelSource.sync()
      conversation.submit(input)
    },
    onInterrupt: () => conversation.interrupt(),
    // 答复**原样转手**（含「总是允许」位）——装配不解释它，落地归权限域。
    // 闸门**按会话各一份**（在途询问与裁决的账各归各的），故取当下这束的；
    // 而它记下的授权进的是**工作区级**账本（跨会话那个），两者不是一回事
    onDecision: async (id, decision, opts) => (await active().gate.resolve(id, decision, opts)),
    // 换模型（阶段 2）——**判别式处置**（技术方案 · 领域划分：「切不动就不动」）
    onModelSwitch: (request) => switchModel(request),
    onSession: (command) => conversation.handle(command),
    // 读侧命令——**原样转手**给对话域（会话与条目归它）；答复走事件（`session.history`）
    onHistoryRead: (session) => conversation.readHistory(session),
    // 模型条目表（读侧）——**归装配**（注册表在它手上，同 `model.switched` 的产出路径）；
    // 答复走事件（`model.catalog`，不落库）
    onModelList: () => listModels(),
    onModelRefresh: (provider) => refreshModels(provider),
    onModelConfigure: (request) => saveModelSettings({ ...request, type: 'model.configure' }),
    onModelOverride: (request) => saveModelSettings(request),
    onPrefsSet: (request) => setPrefsCommand(request),
    onWebList: () => listWeb(),
    onWebConfigure: (provider) => configureWebCommand(provider),
    onProviderList: () => listProviders(),
    onProviderSave: (request) => saveModelSettings({ ...request, type: 'provider.save' }),
    onProviderRemove: (provider) => removeProviderCommand(provider),

    onGrantsList: () => listGrants(),
    onGrantsRevoke: (workspace, index) => revokeGrants(workspace, index),
    // 技能目录（读侧 · U33）——**归装配**（执行域的发现面是它组起来的，同 `model.list`
    // 之于注册表、`grants.list` 之于授权文件）；答复走事件（`skills.catalog`，不落库）
    onSkillList: () => listSkills(),
    // 路径候选（读侧 · U36）——**归装配**（它握着执行域的路径面，同技能目录那一处）；
    // 答复走事件（`paths.catalog`，不落库）。**异步**：它要真去看一眼目录。
    onPathList: (query) => listPaths(query),
    onPathIdentify: (path, external) => identifyPath(path, external),
    onInputPaste: () => pasteClipboardImage(),
    onImageExport: (blob, name, mime) => conversation.exportImage(blob, name, mime),
    // 外部服务器（读侧 ＋ 显式重连 · U39）——**归装配**（那一束连接是它编排的，同
    // `model.list` 之于注册表）；答复走事件（`mcp.catalog`，不落库）
    onMcpList: () => listMcp(),
    onMcpReconnect: async (server) => { const note = await reconnectMcp(server); await listMcp(note) },
  })

  const { kernel, shell } = createInProcessTransportPair()
  hub.attach(kernel)

  return {
    refreshSettings() {
      const current = loadConfig({ path: loaded.path, magic })
      statusLineConfig = current.config.statusLine
      turnDuration = current.config.turnDuration ?? 'elapsed'
      reducedMotion = current.config.motion?.reduced === true
      grantState.refresh()
      grantState.discardHits()
    },
    reconnectMcp,
    hasPendingInput: () => [...chains.values()].some(one => one.service.busy()),
    wakeCollaboration: () => chain?.service.wake(),
    supplementCollaboration: async (input, shared) => {
      if (chain === undefined) throw new Error('当前没有已装配的成员会话')
      await chain.service.supplement(input, shared)
    },
    shell,
    // **活跃**那条（切换之后跟着变）——**`undefined` ＝ 还没有会话**（空手打开，
    // 首条消息才开张）。不是开局那条（`Assembly.session` 的旧义）。
    get session(): SessionId | undefined {
      return conversation.active()
    },
    config: loaded,
    magic,
    get models() { return modelsOf() },
    modelInfo,
    switchModel,
    applyModel,
    records: recordsStore,
    paths: recordsStore.paths,
    permissionRules: parsedRules.rules,
    rejectedRules: parsedRules.rejected,
    grantsPath: grantState.path,
    grantsView: grantState.view,
    get grantsUnreadable(): string | undefined {
      return grantState.unreadable
    },
    readRules,
    readSkills,
    // **现读**（见 `Assembly.notices` 的注）：外部服务器连不上那一条要等 `ready()` 才落定，
    // 而这一位在放开输入之前（`boot`）与自检（`--check`）两处都会被读——快照会在前一处漏话。
    async notices(): Promise<readonly string[]> {
      return noticesOf(
        parsedRules.rejected,
        grantState.notes(),
        loaded.path,
        (await readRules()).problems,
        mcp.connections,
      )
    },
    mcpServers,
    ready: async () => {
      await modelInfo.warmup()
      const models = modelsOf()
      const selection = models?.current()
      if (models !== undefined && selection !== undefined) {
        const checked = selectModel({ providers: modelSource.providers, modelInfoOf: modelSource.knownModel }, selection)
        if (!checked.ok) throw new Error(`成员模型配置不可用：${checked.reason}`)
      }
      await mcp.ready()
    },
    // 释放自有子进程（见 `Assembly.shutdown`）——幂等，收尾路径可以走两遍
    shutdown: async () => {
      const startsClosed = ledger.close?.()
      lifetime.abort()
      const reap = async () => {
        const reclaim = async () => {
          const results = await Promise.all(ledger.list().map(owned => reapOwned(owned)))
          for (const result of results) if (result.kind !== 'gone' && result.kind !== 'reaped') throw new Error(result.note)
        }
        // 在等服务/工具退出之前开始回收；迟到登记在启动屏障关闭后再次接住。
        await reclaim()
        await startsClosed
        await reclaim()
      }
      const results = await Promise.allSettled([
        reap(), hub.shutdown(), ...Array.from(chains.values(), value => value.service.shutdown()), mcp.shutdown(),
        ...(backgroundRuns?.running().map(async run => {
          const stopped = await backgroundRuns.stop(run.id)
          if (!stopped.ok) throw new Error(stopped.reason)
        }) ?? []),
      ])
      await grantState.flush()
      if (options.network === undefined) await network.close()
      const failures = results.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(one => one.reason), '执行实例未完成收尾')
    },
    // 自有进程组那一本账（见 `Assembly.ledger`）——账自己摘掉已经没了的那些
    ledger,
    background: backgroundRuns,
    // **当下**那一条的窗（不是装配那一刻的快照）——理由同下面 `session` 那个取值器：
    // `--model` 是**开局就落地**的选中（`cli.ts` 在起外壳之前先跑 `applySwitch`），
    // 快照会把缺省条目的数报成选中条目的——**报错一个数比不报更坏**。
    get contextWindow(): number | null {
      return contextWindowOf(modelsOf())
    },
    workspaceRoots: workspace.roots(),
    boot: async () => {
      if (startup !== undefined) await actions.recover(actionPorts())
    },
    close: () => {
      initialModels = modelsOf()
      chain = undefined
      recordsStore.close()
    },
  }
}
