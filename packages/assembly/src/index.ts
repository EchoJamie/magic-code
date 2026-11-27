/** 装配入口：构造共享资源，按会话建立执行链，绑定控制与恢复端口。
 * 共享配置不携带 Agent 选择；当前展示只指向一条会话链。
 * 调用方先订阅 shell，再 boot/恢复，最后放开输入。
 */
import { createAgentSession, type AgentSession, type EnvironmentVars } from './agent-assembly/session.ts'
import { noticesOf } from '@magic/host'
import type { WorkEnvironment } from '@magic/host'
export type { EnvironmentVars } from './agent-assembly/session.ts'
export { createStamper } from './agent-assembly/events.ts'
export { workspaceOf } from '@magic/host'
import { createModelDomain } from './model-registry.ts'
import { createSharedResources } from './shared-resources.ts'

import type { SessionPorts } from '@magic/host'
import { createActions } from '@magic/host'
import type {
  AgentModelConfig,
  CollaborationReply,
  CollaborationRequest,
  ControlTransport,
  EventDataOf,
  EventStamper,
  MagicHome,
  McpConnectionState,
  McpToolRejection,
  ModelGateway,
  ModelSwitchRequest,
  ProcessLedger,
  RulesLoad,
  SessionId,
  SkillCatalog,
  SudoAuth,
  Timestamp,
  UserInput,
  WebSource,
} from '@magic/contracts'
import { createInProcessTransportPair } from '@magic/transport'
import type { ContextPolicy, SessionInstance } from '@magic/conversation'
import { createConversationService, createPlanReader } from '@magic/conversation'
import {
  type BackgroundRegistry,
  createWorkspaceService,
  imageBytesOf,
  reapOwned,
} from '@magic/resources'
import { readClipboardImage } from '@magic/client'
import type { FetchLike, ModelInfoService, ModelRegistry, ModelSwitchResult } from '@magic/model'
import { selectModel } from '@magic/model'
import type { RecordsStore } from '@magic/data'
import { createRecordsStore } from '@magic/data'
import type { LoadedConfig } from '@magic/state'
import { loadConfig } from '@magic/state'
import { saveImageFile } from './image-file.ts'
import {
  mcpCatalog,
  pathsCatalog,
  skillsCatalog,
  workspaceOf,
} from '@magic/host'

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
  /** 入口已确定的系统家目录与 Magic 基础目录；装配不读取环境补位置。 */
  readonly magic: MagicHome

  readonly mcpTimeouts?:
  | { readonly connectTimeoutMs?: number; readonly callTimeoutMs?: number }
  | undefined

  /**
   * **sudo 专用认证端口**（U129）——由执行者（经 UI 通道）提供。
   * 不给 ＝ 这次装配没有认证通道，`exec` 遇到 sudo 时如实回一句「用不了」。
   */
  readonly sudoAuth?: SudoAuth | undefined

  /**
   * **AI 标题**（docs/会话标题方案.md）——首条真实用户交代落账后，旁路调当前模型起标题，
   * 写入与改名同一个字段（装配接自己的 `recordsStore.setSessionTitle`）。
   * **缺省＝不做**（行为与加它之前一字不动——脚本对齐的用例不受影响）。
   */
  readonly aiTitle?: true | undefined
}

/** 装配产物——外壳侧一端 ＋ 自检 / 验收要用的把手。 */

export type McpServerView = {
  readonly server: string
  /** 哪一种接入（`stdio` / `http`）——这一屏有两条来路，读数上分得开。 */
  readonly transport: 'stdio' | 'http'
  readonly state: McpConnectionState
  readonly tools: readonly string[]

  readonly rejected: readonly McpToolRejection[]
}

export type Assembly = {
  compact(session: string, request: { requestId: string; focus?: string }, signal: AbortSignal, started: () => void): Promise<import('@magic/contracts').CompactState>
  refreshSettings(): void
  reconnectMcp(server: string): Promise<string>
  /** 当前执行实例仍有明确输入消费意图；遗留持久输入不算自动继续授权。 */
  hasPendingInput(): boolean
  /** 账本上还有本会话的待办（含被「下一件」收束判据持有的行）——收缩前必看，防提前退场。 */
  hasPendingLedgerInput(): boolean
  /** 只唤起已装配的同一身份，持久收件在主循环边界消费。 */
  wakeCollaboration(): void
  /** 原样保留输入引用，由会话读取、接收并发布共享约束。 */
  supplementCollaboration(input: UserInput, shared: boolean): Promise<void>
  /** 消费信号（T2.1）：账本 pending 行准入+出队后入队消费 ＋ 协作收件箱唤起。
   * `shared` ＝ 这次信号是共同补充（shared 位随信号走），消费的行按补充发布给成员。 */
  consumeLedgerInputs(shared?: boolean): Promise<void>
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

  readonly background: BackgroundRegistry | undefined
}

export function assemble(options: AssembleOptions): Assembly {
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

  // 共享资源构造归编排域（shared-resources.ts）；这里只交入参与收把手。
  const resources = createSharedResources({
    options: {
      ledger: options.ledger, environment: options.environment, network: options.network,
      signal: options.signal, records: options.records, modelFetch: options.modelFetch,
      executionId: options.executionId, mcpTimeouts: options.mcpTimeouts,
    },
    magic, loaded, workspace, savedAgent,
    onHubError: onHubErrorOf,
  })
  const { network, environment, fetch, lifetime, signal, ledger, backgroundRuns, sandbox, mcp, mcpTools, projectRules, skills, materials, recordsStore, hub, sink } = resources
  const executionId = options.executionId ?? crypto.randomUUID()

  /** 当前展示会话的控制面事件使用转发铸造器；执行链使用自己的铸造器。 */
  const forwardStamper: EventStamper = {
    stamp: (kind, data) => requireActiveStamper().stamp(kind, data),
    beginTurn: (turn) => requireActiveStamper().beginTurn(turn),
    beginStep: (step) => requireActiveStamper().beginStep?.(step),
    setGeneration: (generation) => requireActiveStamper().setGeneration?.(generation),
  }

  const requireActiveStamper = (): EventStamper => {
    if (chain === undefined) {
      throw new Error('信封铸造器还没就位——装配次序错了（会话链要先开一条）')
    }
    return chain.stamper
  }

  /** 控制广播出错——有活跃会话就发一条 error 事件；没有就原样上抛（装配次序错误）。 */
  function onHubErrorOf(error: unknown): void {
    if (chain === undefined) throw error
    sink.emit(chain.stamper.stamp('error', { message: `控制操作失败：${error instanceof Error ? error.message : String(error)}` }))
  }

  const modelDomain = createModelDomain({
    loaded, magic, environment, fetch, now,
    sink,
    forwardStamper,
    chain: () => chain,
    recordsStore,
    collaborationChanged: options.collaborationChanged,
    ensureSession: () => ensureSession(),
    requireActiveStamper: () => requireActiveStamper(),
    modelGateway: options.modelGateway,
    startup,
    savedAgent,
  })
  const modelInfo = modelDomain.info

  let chain: AgentSession | undefined
  const chains = new Map<SessionId, AgentSession>()
  // **唤醒早于会话建立**时记下（wake 是幂等的「有输入待消费，看一眼」）——
  // 多终端并发首跑时，协作唤醒会先于成员会话的装配完成到达，此处丢弃后无人再喊。
  let pendingWake = false

  const open = (session: SessionId): SessionInstance => {
    const previous = chains.get(session)
    if (previous !== undefined) {
      chain = previous
      return previous
    }
    const opened = createAgentSession({
      session, magic, context: options.context, prompt: options.prompt,
      webSource: options.webSource, modelGateway: options.modelGateway,
      collaboration: options.collaboration, collaborationChanged: options.collaborationChanged,
      loaded, recordsStore, workspace, sudoAuth: options.sudoAuth, sink, now,
      signal, network, executionId, backgroundRuns,
      sandbox, projectRules, skills, materials, mcpTools,
      setTitle: options.aiTitle === true ? (session, title, at) => recordsStore.setSessionTitle(session, title, at) : undefined,
      model: {
        create: (selection, stamper) => {
          const current = modelDomain.modelsOf()
          return current === undefined ? undefined : modelDomain.source.registry(selection ?? current.current(), stamper)
        },
        cantrip: modelDomain.source.cantrip,
        canDistill: () => { modelDomain.source.sync(); return modelDomain.source.configured?.cantrip !== undefined },
        connections: () => Object.keys(modelDomain.source.providers).length,
        webSource: modelDomain.source.webSource,
      },
    })
    chains.set(session, opened)
    chain = opened
    if (pendingWake) { pendingWake = false; opened.service.wake() }
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
    readPlan: session => createPlanReader({ records: recordsStore.serviceFor(session), session }).readPlan(),
    setTitle: (session, title, at) => recordsStore.setSessionTitle(session, title, at),
    sink,
    now,
    saveImage: (file) => saveImageFile(file),
  })

  const actions = createActions({ conversation, sink, now })

  /** 与 `listModels` 同一条起手：还没有会话就先开一条（信封铸造器要它就位）。 */
  const ensureSession = async (): Promise<void> => {
    if (conversation.active() === undefined) await conversation.handle({ type: 'session.new' })
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
      modelDomain.source.sync()
      conversation.submit(input)
    },
    onInterrupt: () => conversation.interrupt(),
    // 换模型（阶段 2）——**判别式处置**（技术方案 · 领域划分：「切不动就不动」）
    onModelSwitch: (request) => modelDomain.switchModel(request),
    onSession: (command) => conversation.handle(command),
    // 读侧命令——**原样转手**给对话域（会话与条目归它）；答复走事件（`session.history`）
    onHistoryRead: (session) => conversation.readHistory(session),
    // 当前计划读侧（`plan.read`）——同一条姿势；答复走事件（`plan.changed`，带 `requestId`）
    onPlanRead: (session, requestId) => conversation.readPlanSnapshot(session, requestId),
    // 模型条目表（读侧）——**归装配**（注册表在它手上，同 `model.switched` 的产出路径）；
    // 答复走事件（`model.catalog`，不落库）
    onModelList: () => modelDomain.listModels(),
    onModelRefresh: (provider) => modelDomain.refreshModels(provider),
    onModelConfigure: (request) => modelDomain.saveModelSettings({ ...request, type: 'model.configure' }),
    onModelOverride: (request) => modelDomain.saveModelSettings(request),
    onPrefsSet: (request) => modelDomain.setPrefsCommand(request),
    onWebList: () => modelDomain.listWeb(),
    onWebConfigure: (provider) => modelDomain.configureWebCommand(provider),
    onProviderList: () => modelDomain.listProviders(),
    onProviderSave: (request) => modelDomain.saveModelSettings({ ...request, type: 'provider.save' }),
    onProviderRemove: (provider) => modelDomain.removeProviderCommand(provider),

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
    refreshSettings: () => modelDomain.refreshSettings(),
    reconnectMcp,
    compact: (session, request, signal, started) => {
      const target = chains.get(session)
      if (target === undefined) return Promise.resolve({ requestId: request.requestId, state: 'failed', reason: '目标会话未装配，未执行压缩' })
      return target.service.compact(request, signal, started)
    },
    hasPendingInput: () => [...chains.values()].some(one => one.service.busy()),
    hasPendingLedgerInput: () => [...chains.values()].some(one => one.records.inputs.list().some(row => row.state === 'pending')),
    wakeCollaboration: () => { if (chain === undefined) { pendingWake = true; return } chain.service.wake() },
    /** 消费信号（T2.1：engine 受理落账后发信号帧，正文以账本为准）——
     * 消费流（裁定 · 信号先于出队）：读账本 pending → 协作成员请求 run 级准入
     * （beginExecution 经帧）→ 请求 dequeue（engine 唯一写权，现读 revision，撤回竞态
     * SQL 原子判负）→ 回执里的行入队消费。失败/未出队的行留账本（对账兜底，不重复消费）。 */
    consumeLedgerInputs: async (shared = false) => {
      const active = chain
      if (active === undefined) { pendingWake = true; return }
      const pending = active.records.inputs.list().filter(row => row.state === 'pending' && row.entry === undefined)
      if (pending.length === 0) { active.service.wake(); return }
      const refs = pending.map(row => row.ref)

      // **run 级准入**（协作成员；普通会话无协作身份，跳过）——beginExecution 一次，
      // 不随每个工具调用重复（T2.2 降频）。准入失败＝这一轮没有开始执行（N14），留账待再试。
      const agent = recordsStore.collaboration.agentForSession(active.session)
      if (agent !== undefined && options.collaboration !== undefined) {
        try {
          await options.collaboration(active.session, {
            action: 'beginExecution', operationId: `run:${executionId}:${crypto.randomUUID()}`,
            at: now(), runId: executionId, kind: 'model',
            // 2026-11-24 准入口径：咨询执行者的执行就是协调形态（答询本身），
            // 其余成员带 accepted delegation 走 work；purpose 与跳过判据同源读出。
            mode: agent.purpose === 'consultation' ? 'coordination' : 'work',
          })
        } catch { /* 准入帧失败＝未准入：行留 pending，用户可「立即再试」 */ }
      }

      // **「下一件」的收束自查**（边界方案 M2 · 外循环的推进决策归执行者）：purpose=next
      // 的行要等这项工作的委派/待答收束后才可出队——判据读同一账本（出队前的现场），
      // 引擎 dequeue 只剩账面事务（出队没成的行留账，对账器再敲门，本执行者再自查）。
      const work = recordsStore.collaboration.collaborationForSession(active.session)
      const nextHeld = work !== undefined
        && recordsStore.collaboration.listDelegations(work.collaborationId).some(d =>
          !['received', 'rejected', 'cancelled'].includes(d.state)
          || (d.deliveryMessageId !== undefined && d.receivedAt === undefined))
      const eligibleRefs = nextHeld
        ? refs.filter(ref => pending.find(row => row.ref === ref)?.purpose !== 'next')
        : refs

      // **dequeue 请求**——无协作 client 的单机形态退化为本地 dequeue（engine 与执行者
      // 同体，写权语义不跨进程）；有 client 走帧（engine 唯一写者，纯事务）。
      let dequeued: ReadonlySet<string>
      if (options.collaboration === undefined) {
        const sessionRecords = active.records
        dequeued = new Set(eligibleRefs.filter(ref => {
          const revision = sessionRecords.inputs.get(ref)?.revision
          return revision !== undefined && sessionRecords.inputs.dequeue(ref, revision)
        }))
      } else {
        const reply = await options.collaboration(active.session, {
          action: 'dequeue', operationId: `dequeue:${executionId}:${crypto.randomUUID()}`, refs: eligibleRefs, at: now(),
        }).catch(() => undefined)
        const value = reply?.ok === true ? reply.value as { dequeued?: readonly string[] } : undefined
        dequeued = new Set(value?.dequeued ?? [])
      }

      for (const row of pending) {
        if (!dequeued.has(row.ref)) continue
        // **shared 位随信号走**（边界方案 §四#1）：shared 信号消费的行按补充入队——
        // 除进入本会话自己的轮外，还要经协作边界把同一份条目发布给成员。
        if (shared) await active.service.supplement(row.input, true)
        else conversation.submit(row.input)
      }
      active.service.wake()
    },
    supplementCollaboration: async (input, shared) => {
      // **会话链未开不再抛**（边界方案 T2.1：删 throw 路径）——抛会让执行者把自己收摊
      // （执行者侧 trackOperation 的失败路径发 done 并走 closeOut），而协作输入在 engine
      // 侧账本仍持有（受理前移：T1.1 起 engine 先 `inputs.accept` 再发帧），对账器会补发
      // wake 补消费。执行者活着、账本为真源，信号丢了不丢输入。
      if (chain === undefined) return
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
    get models() { return modelDomain.modelsOf() },
    modelInfo,
    switchModel: modelDomain.switchModel,
    applyModel: modelDomain.applyModel,
    records: recordsStore,
    paths: recordsStore.paths,
    readRules,
    readSkills,
    // **现读**（见 `Assembly.notices` 的注）：外部服务器连不上那一条要等 `ready()` 才落定，
    // 而这一位在放开输入之前（`boot`）与自检（`--check`）两处都会被读——快照会在前一处漏话。
    async notices(): Promise<readonly string[]> {
      return noticesOf(
        (await readRules()).problems,
        mcp.connections,
      )
    },
    mcpServers,
    ready: async () => {
      await modelInfo.warmup()
      const models = modelDomain.modelsOf()
      const selection = models?.current()
      if (models !== undefined && selection !== undefined) {
        const checked = selectModel({ providers: modelDomain.source.providers, modelInfoOf: modelDomain.source.knownModel }, selection)
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
      return modelDomain.contextWindowOf(modelDomain.modelsOf())
    },
    workspaceRoots: workspace.roots(),
    boot: async () => {
      if (startup !== undefined) await actions.recover(actionPorts())
    },
    close: () => {
      modelDomain.suspend()
      chain = undefined
      recordsStore.close()
    },
  }
}

export * from './background-session.ts'
export * from './collaboration-boundary.ts'
export * from './image-file.ts'
