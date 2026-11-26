import type {
  AgentIdentity,
  AttentionItem,
  BackgroundView,
  ClientToManager,
  CollaborationCommand,
  CollaborationView,
  Command,
  ExecutorToManager,
  KernelEvent,
  MagicHome,
  McpCatalogRow,
  McpProbeRow,
  McpServerConfig,
  NativeSession,
  NativeWork,
  NoticeKind,
  RunRow,
  ServiceIdentity,
  StopPhase,
  StopScope,
} from '@magic/contracts'
import type { CollaborationNativeGroup, RunPaths, RunRecord } from '@magic/host'
import type { Socket } from 'bun'
import type { ClientConn } from '../connections.ts'
import type { DiagnosticLog } from '../diagnostic-log.ts'
import type { Executor } from '../executor-control.ts'
import type { ExecutorLauncher } from '../launch.ts'
import type { ManagerRecord } from '../run-store.ts'

type Connections = ReturnType<typeof import('../connections.ts').createClientConnections>
type Sessions = ReturnType<typeof import('../session-management.ts').createSessionManagement>
type Compactions = ReturnType<typeof import('../compact.ts').createCompactController>
type Control = ReturnType<typeof import('../executor-control.ts').createExecutorControl>
type Collaboration = ReturnType<typeof import('../collaboration.ts').createManagedCollaboration>
type Native = ReturnType<typeof import('../native-server.ts').createNativeServer>
type RunStops = ReturnType<typeof import('../stopping.ts').createRunStops>
type Store = ReturnType<typeof import('@magic/data').createRecordsStore>

/** 这一推的合并窗（毫秒）——见 `pushRuns`。 */
export const RUNS_PUSH_MS = 100

/** 运行登记落盘的合并窗（毫秒）——见 `saveRuns`。 */
export const RUNS_SAVE_MS = 300

export type ManagerOptions = {
  readonly beforeExit?: () => Promise<void>
  readonly engineState?: (state: 'stopping' | 'stopped' | 'failed', request: string, error?: string) => Promise<void>
  readonly lifecycle?: {
    /** 同步持久关闭协作准入；先于任何执行收尾。 */
    readonly closeAdmission: () => void
    readonly shutdown: () => Promise<void>
    readonly affected: () => Promise<readonly NativeWork[]>
  }
  readonly onShutdownError?: (reason: string) => void

  /** 这一摊运行的三条路径（`runPathsOf` 算出来的）。 */
  readonly paths: RunPaths
  /** 起执行者的方式——见 `ExecutorLauncher`。 */
  /** **必填**——发车方式由装配点显式声明：真实引擎用独立子进程，不存在生产缺省。 */
  readonly launch: ExecutorLauncher

  readonly magic: MagicHome

  readonly mcp?: Readonly<Record<string, McpServerConfig>> | undefined
  /** 预检的连接上限（毫秒）——缺省＝适配器那个实现级常量；用例把它调小。 */
  readonly mcpConnectTimeoutMs?: number | undefined
  /** 时钟——缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined
  /** 生命探测的间隔（毫秒）——缺省 5 秒；见 `PROBE_INTERVAL_MS`。 */
  readonly probeIntervalMs?: number | undefined

  readonly stopGraceMs?: number | undefined
  /** 停止时 TERM 之后再等多久才 KILL（毫秒）——缺省三秒；见 `STOP_KILL_MS`。 */
  readonly stopKillMs?: number | undefined
  /** 诊断——缺省不打印（**这条线上不写业务日志**）。 */
  readonly log?: ((line: string) => void) | undefined
}

/**
 * 一个立起来的管理者。
 *
 * 三个读数给**诊断与验收装置**（客户端自己看不到这些——它只需要一条连接）。
 */
export type Manager = {
  readonly identity: ServiceIdentity
  ready(): Promise<void>

  readonly record: ManagerRecord
  readonly socketPath: string
  /** 挂着的客户端连接数。 */
  clients(): number
  /** 这一摊里活着的执行者（按会话归）。 */
  executors(): readonly { readonly session: string | null; readonly gen: number }[]
  /**
   * **这一摊此刻的运行事实**（U49）——与推给窗口的那一份**同一处产出**（`rows()`）。
   *
   * 给验收装置一个不必起窗口就能读的读数（同 `clients()` / `executors()` 的姿势）。
   */
  runs(): readonly RunRow[]
  /** 显式收摊（收缩那条路与用例的收尾都走它）。 */
  stop(why: string): void
  /** 等它真退干净（socket 摘掉、执行者收光、连接关光）。 */
  waitUntilExit(): Promise<void>
}

export type StartResult =
  | { readonly role: 'manager'; readonly manager: Manager }
  /** 已经有一个管理者了——**连接它，不另起**。 */
  | { readonly role: 'existing'; readonly record: ManagerRecord | undefined }
  | { readonly role: 'failed'; readonly reason: string }

export type SpawnInput = {
  readonly session: string | null
  readonly explicit: boolean
  readonly environment?: Readonly<Record<string, string>>
  readonly cwd: string
  readonly switch?: import('@magic/contracts').ModelSwitchRequest | undefined
}

export type NativeSessionsQuery = {
  archived?: boolean
  workspace?: readonly string[]
  search?: string
  ids?: readonly string[]
}

type ManagerRuntime = {
  read(): Promise<{
    canChangeData: boolean
    mcp: { session: string; gen: number | null; servers: readonly McpCatalogRow[] }[]
  }>
  reconnect(session: string, gen: number, name: string): Promise<string>
}

/** 一摊运行的全部可变状态与跨模块助手；模块只通过这一份对象读写。 */
export type ManagerContext = {
  // —— 构造参数与时钟 ——
  options: ManagerOptions
  paths: RunPaths
  now: () => number
  probeIntervalMs: number
  stopGraceMs: number
  stopKillMs: number

  // —— 连接、执行者与运行事实 ——
  connections: Connections
  executors: Set<Executor>
  lastRuns: Map<string, RunRecord>
  nextGen: number
  available: boolean
  stopped: boolean
  storeClosed: boolean
  settle: () => void
  exited: Promise<void>

  // —— 端点、记录库与身份 ——
  server: ReturnType<typeof Bun.listen>
  store: Store
  identity: ServiceIdentity
  diagnosticLog: DiagnosticLog
  record: ManagerRecord
  mcpCatalog: readonly McpCatalogRow[]
  probed: readonly McpProbeRow[]

  // —— 工作环境与会话 ——
  environments: Map<string, import('@magic/host').WorkEnvironment>
  closingEnvironments: Set<Promise<void>>
  sessions: Sessions
  compactions: Compactions

  // —— 协作与执行者控制 ——
  collaborationInputs: Map<string, { conn: ClientConn; session: string; target: string; ref?: string }>
  sudoRequests: Map<string, { readonly executor: Executor; readonly command: string }>
  control: Control
  collaboration: Collaboration

  // —— 推送与落盘的合并窗 ——
  pushTimer: ReturnType<typeof setTimeout> | undefined
  saveTimer: ReturnType<typeof setTimeout> | undefined

  // —— 对外立面与停止登记 ——
  manager: Manager
  stopReports: Map<number, (phase: StopPhase, note?: string) => void>
  nextStopRequest: number
  nextStopGeneration: number
  stopGenerations: WeakMap<RunRecord, number>
  collaborationStopVersions: Map<string, { signature: string; gen: number }>
  stopContent: WeakMap<RunRecord, { entry?: number; event?: number; error?: string; stop?: KernelEvent }>
  settledRuns: WeakSet<RunRecord>

  // —— 原生端点、配置与生命周期 ——
  runtime: ManagerRuntime
  configuration: { stamp: string | null; error?: string }
  native: Native
  closeConfigWatch: () => Promise<void>
  runStops: RunStops
  probe: ReturnType<typeof setInterval>
  reconcileTimer?: ReturnType<typeof setInterval>
  evidencePaths: () => readonly string[]
  confirmStop(conn: Pick<ClientConn, 'id' | 'link'>, session: string): void
  shutdownInFlight: Promise<void> | undefined
  admissionClosed: boolean

  // —— 停止与运行事实 ——
  releaseEnvironments(): void
  environmentFor(session: string): import('@magic/host').WorkEnvironment | undefined
  startMember(agent: AgentIdentity): Promise<void>
  cancelMembers(sessions: readonly string[]): Promise<void>

  // —— 投影 ——
  rows(): readonly RunRow[]
  /** 线上视图：有界、字段裁短；内部判定仍用完整的 `rows()`。 */
  runsView(): readonly RunRow[]
  currentRevision(): number
  pushRuns(immediate?: boolean): void
  saveRuns(immediate?: boolean): void
  publishPreferences(except?: ClientConn): void
  terminalClients(session: string): ClientConn[]
  nativeWorks(): Promise<readonly NativeWork[]>
  nativeSessions(query: NativeSessionsQuery): Promise<readonly NativeSession[]>

  // —— 提醒与后台视图 ——
  backgroundView(session: string): BackgroundView
  publishBackground(conn: ClientConn, result?: BackgroundView['result']): void
  backgroundCommand(conn: ClientConn, command: Extract<Command, { type: `background.${string}` }>): void
  collaborationEvent(conn: ClientConn, view: CollaborationView): boolean
  viewingSelfGuard(conn: ClientConn, member: string | undefined): string | undefined
  publishCollaboration(conn: ClientConn): Promise<void>
  reconcileNotice(session: string): AttentionItem | undefined
  clearTurnNotice(session: string): void
  notify(session: string, kind: NoticeKind, fact: string | number, detail?: string, source?: { session: string; event?: number; entry?: number }, at?: number): void
  notifyStop(run: RunRecord, event: KernelEvent): Promise<void>

  // —— 命令路由 ——
  accept(socket: Socket<unknown>): void
  catalog(conn: ClientConn, archived?: boolean): Promise<void>
  readHistory(conn: ClientConn, session: string): Promise<void>
  onCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void>
  acceptCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void>
  collaborationCommand(conn: ClientConn, command: CollaborationCommand): Promise<void>
  stopRun(conn: Pick<ClientConn, 'id'>, session: string, scope: StopScope): void

  // —— 执行者放置与送达 ——
  liveOf(session: string): Executor | undefined
  spawnFresh(conn: ClientConn, model?: import('@magic/contracts').ModelSwitchRequest): Executor | undefined
  spawn(input: SpawnInput): Executor | undefined
  retarget(conn: ClientConn, session: string): void
  bindEnvironment(executor: Executor, session: string | null): void
  deliver(executor: Executor, command: Command): void
  dropConnection(id: number): void
  answerSudo(conn: ClientConn, message: Extract<ClientToManager, { t: 'sudo.answer' }>): void
  cancelSudo(requestId: string, executor: Executor): void

  // —— 执行者交接与收尾 ——
  onExecutorMessage(executor: Executor, message: ExecutorToManager): void
  markStopping(executor: Executor, why: string): void
  onEvent(executor: Executor, event: KernelEvent): void
  retire(executor: Executor, reason: string): void
  afterEnd(run: RunRecord): void
  reportStop(connId: number, session: string, scope: StopScope, phase: StopPhase, note?: string): void
  workStopGeneration(session: string, group?: CollaborationNativeGroup): number | null
  stop(why: string): void
  beginStop(why: string): Promise<void>
  shutdown(why: string): Promise<void>
}
