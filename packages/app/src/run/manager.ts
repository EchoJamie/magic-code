import type { BackgroundView } from '@magic/contracts'
import { diagnosticsOf, isTurnTimingEvent, type TurnTimingEvent } from '@magic/contracts'
import { setPrefs } from '../config-save.ts'
import { watchConfig } from '../config-watch.ts'
import { loadConfig } from '../config.ts'
import { DiagnosticLog } from '../diagnostic-log.ts'
import { createWorkEnvironment, type WorkEnvironment } from '../work-environment.ts'
import {
  captureCollaborationNative,
  mergeCollaborationNative,
  type CollaborationNativeGroup,
} from './collaboration-native.ts'
import { createManagedCollaboration } from './collaboration.ts'
import { createClientConnections, type ClientConn } from './connections.ts'
import { createExecutorControl, sendToExecutor as send, type Executor } from './executor-control.ts'
import { ARCHIVED_NOTE, createSessionManagement } from './session-management.ts'
import { createRunStops } from './stopping.ts'
/** App 所属的本机管理者：独占服务、只读观察、按需执行与有责收尾。
 * 记录事实通过 records 端口读取；控制连接本身不创建会话或执行者。
 * 执行者退出与其自有资源核销分开确认，宿主生命管道负责最终收尾。
 */

import type {
  AgentIdentity,
  AttentionItem,
  CollaborationCommand,
  CollaborationView,
  Command,
  Entry,
  KernelEvent,
  MagicHome,
  McpCatalogRow,
  McpServerConfig,
  ModelSwitchRequest,
  NativeSession,
  NativeWork,
  NoticeKind,
  OwnedProcess,
  RunRow,
  ServiceIdentity,
  StopPhase,
  StopScope,
  Wire,
} from '@magic/contracts'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION } from '@magic/contracts'
import { readSessionCatalog, readSessionDisplayHistory, summarize } from '@magic/conversation'
import { createProcessLedger } from '@magic/execution'
import { createRecordsStore } from '@magic/records'
import type { Socket } from 'bun'
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { RunRecord, StoredRun, StoredRuns } from './facts.ts'
import {
  RUNS_VERSION,
  STORED_RUNS_LIMIT,
  actionOf,
  backgroundOf,
  endKindOf,
  isProgress,
  newRunRecord,
  progressOf,
  reconcile,
  refresh,
  runRowOf,
  storedRunOf,
  tailOf,
} from './facts.ts'
import { createAgentLauncher, type ExecutorLauncher, type SpawnedExecutor } from './launch.ts'
export type { ExecutorLauncher, ExecutorRequest, SpawnedExecutor } from './launch.ts'
import { projectWorks } from './native-projection.ts'
import { createNativeServer } from './native-server.ts'
import { noticeKey } from './notices.ts'
import { query as observe } from './observation.ts'
import type { RunPaths } from './paths.ts'
import { ensureRunDir, normalizeDataDir, tightenSocket } from './paths.ts'
import { softwareSource } from './runtime-launch.ts'
import type { ClientToManager, ExecutorToManager, Link, ManagerToExecutor, McpProbeRow } from './wire.ts'
import { linkOf, localLinks, socketHandlers } from './wire.ts'

/** 管理者自报身份的落盘形（`manager.json`）——诊断与重启核对用，**不是**权威状态。 */
export type ManagerRecord = {
  readonly pid: number
  readonly at: number
  /** 数据目录的规范形——管理者就是按它认的自己这一摊。 */
  readonly dataDir: string
  readonly socket: string
  /** 本文件里那一版的形制——将来加字段时读的人据此判。 */
  readonly v: number
}

const RECORD_VERSION = 1

/** 一条挂着的客户端连接。 */
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
  readonly launch?: ExecutorLauncher

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

/** 重试次数——「尸首清掉再 bind」那一步；给三次是因为它只该有一次成功或彻底失败。 */
const BIND_ATTEMPTS = 3

const PROBE_INTERVAL_MS = 5_000

const STOP_GRACE_MS = 8_000

/** 工具 TERM/KILL 回收各阶段的等待预算。 */
const STOP_KILL_MS = 3_000

const RUNS_PUSH_MS = 100

/** 运行登记落盘的合并窗（毫秒）——见 `saveRuns`。 */
const RUNS_SAVE_MS = 300

export async function startManager(options: ManagerOptions): Promise<StartResult> {
  const { paths } = options
  const now = options.now ?? Date.now

  ensureRunDir(paths.dir)

  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const bound = await bindManager(options, now)
    if (bound !== undefined) return { role: 'manager', manager: bound }

    // bind 没成——**先问「是不是有人在」**，问到就连接它，一句都不清
    if (await someoneListens(paths.socket)) {
      return { role: 'existing', record: readRecord(paths) }
    }

    // 连也连不上 ⇒ 路径上是上一次的尸首。**清掉它**，下一轮重新 bind。
    // 清之前再确认一次（探测与清理合成不了一次原子动作）——探测失败的方向是**保守**的。
    if (!(await someoneListens(paths.socket))) clearStale(paths.socket)
  }

  return { role: 'failed', reason: `连着 ${BIND_ATTEMPTS} 次都没能占住 ${paths.socket}` }
}

/** bind 成了就返回一个立好的管理者；没成返回 `undefined`（判归属的那三步在调用方）。 */
async function bindManager(options: ManagerOptions, now: () => number): Promise<Manager | undefined> {
  const { paths } = options
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  const stopKillMs = options.stopKillMs ?? STOP_KILL_MS

  const connections = createClientConnections(() => native.changed(), options.log)
  const { clients, bind, syncTarget, onSnapshot, dropClient } = connections
  const executors = new Set<Executor>()

  const lastRuns = new Map<string, RunRecord>()

  let nextGen = 1
  let available = false
  let stopped = false
  /**
   * 手上那份库连接关了没有——**收摊那一路还要读运行事实**（`rows()` 按目录说话那一跳
   * 要查库），而库在收摊的前半段就关了。关了之后**不筛**：那时该照列（拿不到的不编）。
   */
  let storeClosed = false
  let settle: () => void = () => { }
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })

  // 先独占控制端点，再打开唯一记录连接；并发入口不同时迁移 SQLite。
  let server: ReturnType<typeof Bun.listen>
  try {
    server = Bun.listen({ unix: paths.socket, socket: socketHandlers(socket => accept(socket as Socket<unknown>)) })
  } catch { return undefined }
  let store: ReturnType<typeof createRecordsStore>
  let savedRuns: readonly StoredRun[]
  let initialConfig: ReturnType<typeof loadConfig>
  try {
    savedRuns = readRuns(paths)
    initialConfig = loadConfig({ magic: options.magic })
    store = createRecordsStore({ dataDir: options.magic.base, workspace: [] })
  } catch (error) {
    server.stop(true)
    clearStale(paths.socket)
    throw new Error(`记录库不可用：${String(error)}`)
  }

  tightenSocket(paths.socket)

  const identity: ServiceIdentity = {
    protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source: softwareSource(),
    serviceInstance: crypto.randomUUID(), base: options.magic.base,
  }
  const diagnosticLog = new DiagnosticLog('manager', options.magic.base, diagnosticsOf(initialConfig.config).logLevel)
  diagnosticLog.write('info', 'manager.started', identity)
  const record: ManagerRecord = {
    pid: process.pid,
    at: now(),
    dataDir: normalizeDataDir(options.magic.base),
    socket: paths.socket,
    v: RECORD_VERSION,
  }
  writeRecord(paths, record)

  // 旧 Agent 已随 Engine 退出，持久工具责任在开放准入前逐项核对。
  for (const stored of savedRuns) {
    const record = reconcile(stored, now())
    lastRuns.set(record.session ?? record.executionId!, record)

    if (record.ended !== undefined && record.owned.length > 0) {
      record.reclaimPending = true
      refresh(record, now())
      // afterEnd 在初始化完成后统一接续该代核销。
    }
  }

  // 尚无工作环境时只列配置；连接与归属登记在工作装配时完成。
  const mcpCatalog: readonly McpCatalogRow[] = Object.entries(options.mcp ?? {}).map(([server, config]) => ({
    server, transport: 'url' in config ? 'http' : 'stdio', state: { status: 'idle' }, tools: [], rejected: [],
  }))
  const probed: readonly McpProbeRow[] = mcpCatalog.map(row => ({ server: row.server, state: row.state, rejected: 0 }))

  // —— 运行事实：一处产出、两处用（推给窗口 ＋ 落盘）——

  const environments = new Map<string, WorkEnvironment>()
  const closingEnvironments = new Set<Promise<void>>()
  const sessions = createSessionManagement({
    store, now, liveOf, lastRuns, accepting: () => !stopped,
    terminalOpen: session => terminalClients(session).length > 0,
    onArchived(session) {
      for (const executor of executors) {
        if (executor.run.session !== null && workRoot(executor.run.session) === session) stopContent.delete(executor.run)
      }
    },
    changed(data) {
      for (const conn of clients.values()) conn.link.send({
        t: 'ev', gen: null,
        event: { id: 0, at: now(), turn: null, session: data.session, kind: 'session.changed', data },
      })
      native.changed()
    },
  })
  const { workRoot, isArchived, canArchive, manageSession } = sessions

  const environmentFor = (session: string): WorkEnvironment | undefined => environments.get(workRoot(session))
  function releaseEnvironments(): void {
    for (const [root, network] of environments) {
      if ([...executors].some(one => one.network === network)) continue
      const work = store.collaboration.collaborationForSession(root)
      if (work?.state === 'open' || work?.state === 'closing') continue
      if ([...lastRuns.values()].some(run => run.session !== null && workRoot(run.session) === root && (run.owned.length > 0 || run.reclaimPending))) continue
      environments.delete(root)
      const closing = network.close()
      closingEnvironments.add(closing)
      void closing.then(() => closingEnvironments.delete(closing), error => options.log?.(`工作网络连接尚未收妥：${String(error)}`))
    }
  }
  const collaborationInputs = new Map<string, { conn: ClientConn; session: string; target: string; ref?: string }>()
  const collaborationDecisions = new Map<number, Extract<KernelEvent, { kind: 'tool.decision.request' }>>()
  const control = createExecutorControl(executor => {
    executor.run.stopping = true
    send(executor, { t: 'bye', why: '成员启动超时' })
    void escalateStop(executor)
  })
  const collaboration = createManagedCollaboration({
    store, magic: options.magic, now, environment: session => environmentFor(session)?.env ?? {}, accepting: () => !stopped,
    start: startMember,
    wake: session => { if (isArchived(session)) return; const live = liveOf(session); if (live !== undefined) send(live, { t: 'collaboration.wake' }) },
    cancel: cancelMembers,
    input: (session, input, shared) => {
      if (isArchived(session)) throw new Error(ARCHIVED_NOTE)
      const live = liveOf(session)
      if (live === undefined || live.link.closed) throw new Error('输入目标已失联')
      live.run.busy = true
      refresh(live.run, now())
      clearTurnNotice(session)
      stopGenerations.set(live.run, nextStopGeneration++)
      send(live, { t: 'collaboration.input', input, shared })
    },
    configure: async (session, model) => {
      const live = liveOf(session)
      if (live === undefined) return
      await control.configure(live, model)
    },
    runs: () => [...executors].map(e => runRowOf(e.run)),
    decisions: session => liveOf(session)?.run.decisions.size ?? 0,
    changed: () => {
      releaseEnvironments()
      native.changed(); for (const conn of clients.values()) void publishCollaboration(conn)
      for (const executor of executors) { const session = executor.run.session; if (session !== null && !isArchived(session) && store.serviceFor(session).inputs.list().some(one => one.state === 'pending' && one.purpose === 'next')) send(executor, { t: 'collaboration.wake' }) }
    },
  })
  const recovering = collaboration.recover()

  async function startMember(agent: AgentIdentity): Promise<void> {
    if (stopped) throw new Error('管理者正在退出')
    if (isArchived(agent.sessionId)) throw new Error(ARCHIVED_NOTE)
    let existing = liveOf(agent.sessionId)
    if (existing?.run.stopping) { await cancelMembers([agent.sessionId]); existing = liveOf(agent.sessionId) }
    const previous = lastRuns.get(agent.sessionId)
    if (existing === undefined && previous !== undefined && (previous.ended === undefined || previous.reclaimPending || previous.reclaimNote !== undefined)) throw new Error('该成员上一代资源仍待核实')
    if (stopped) throw new Error('管理者正在退出')
    if (isArchived(agent.sessionId)) throw new Error(ARCHIVED_NOTE)
    const executor = existing ?? spawn({
      session: agent.sessionId, explicit: true,
      cwd: agent.workspace[0] ?? ''
    })
    if (executor === undefined) throw new Error('无法启动成员执行者')
    for (const conn of clients.values()) if (conn.selectedSession === agent.sessionId && conn.target !== executor) bind(conn, executor)
    if (executor.run.ready) return
    return control.waitUntilReady(executor)
  }
  async function cancelMembers(sessions: readonly string[]): Promise<void> {
    await Promise.all(sessions.map(session => new Promise<void>((resolve, reject) => {
      const id = nextStopRequest--
      const timer = setTimeout(() => {
        stopReports.delete(id)
        reject(new Error('成员资源退出尚未核实'))
      }, 30_000)
      stopReports.set(id, (phase, note) => {
        if (phase === 'accepted') return
        clearTimeout(timer)
        stopReports.delete(id)
        if (phase === 'done') resolve()
        else reject(new Error(note ?? '成员资源退出尚未核实'))
      })
      // 与客户端和原生停止复用同一 RunRecord 等待及核销出口。
      stopExecution({ id }, session, 'run')
    })))
  }
  function backgroundView(session: string): BackgroundView {
    const root = workRoot(session)
    const current = new Map([...lastRuns.values()].map(run => [run.session ?? run.executionId, run]))
    for (const executor of executors) current.set(executor.run.session ?? executor.executionId, executor.run)
    const runs = [...current.values()].filter(run => run.session !== null && workRoot(run.session) === root
      && (run.ended === undefined || run.reclaimPending || run.reclaimNote !== undefined))
    const commands = runs.flatMap(run => (run.backgroundView?.commands ?? []).filter(command => command.execution === run.executionId && command.session === run.session).map(command => {
      const member = command.session === root ? undefined : store.collaboration.agentForSession(command.session)
      return { ...command, ...(member ? { member: member.name, agent: member.agentId } : {}) }
    })).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || `${a.execution}:${a.id}`.localeCompare(`${b.execution}:${b.id}`))
    return {
      commands, waiting: runs.flatMap(run => run.backgroundView?.waiting ?? []),
      ...(runs.some(run => !run.connected || run.backgroundView === undefined || run.reclaimPending || run.reclaimNote !== undefined) ? { unknown: true as const } : {})
    }
  }
  function publishBackground(conn: ClientConn, result?: BackgroundView['result']): void {
    if (conn.selectedSession === null || conn.link.closed) return
    const session = workRoot(conn.selectedSession)
    conn.link.send({
      t: 'ev', gen: conn.target?.gen ?? null, event: {
        kind: 'background.state', id: 0, turn: null, at: now(), session,
        data: { ...backgroundView(session), ...(result ? { result } : {}) }
      }
    })
  }
  function backgroundCommand(conn: ClientConn, command: Extract<Command, { type: `background.${string}` }>): void {
    if (command.type === 'background.list') { publishBackground(conn); return }
    const target = command.target
    const executor = liveOf(target.session)
    if (!executor && conn.selectedSession !== null && workRoot(target.session) === workRoot(conn.selectedSession)) {
      const fact = store.serviceFor(target.session).inputs.get(`background:${target.execution}:${target.id}`)?.input.background
      if (fact && !('state' in fact)) {
        publishBackground(conn, { target, outcome: { ok: true, already: true, note: `${target.id} 已经结束`, finish: fact } })
        return
      }
    }
    const problem = conn.selectedSession === null || workRoot(target.session) !== workRoot(conn.selectedSession)
      ? '目标不属于当前整件工作'
      : executor?.executionId !== target.execution ? '执行代次已改变或已经结束'
        : !executor.run.connected || executor.link.closed ? '执行实例失联，无法确认命令状态' : undefined
    if (problem || !executor) { publishBackground(conn, { target, outcome: { ok: false, reason: problem ?? '目标不存在' } }); return }
    deliver(executor, command)
  }
  function collaborationEvent(conn: ClientConn, view: CollaborationView): boolean {
    const selected = conn.selectedSession
    if (conn.link.closed || selected == null ||
      (store.collaboration.collaborationForSession(selected)?.originSessionId ?? selected) !== view.originSession) return false
    return conn.link.send({
      t: 'ev', gen: conn.target?.gen ?? null, event: {
        kind: 'collaboration.view', data: view, session: view.originSession,
        id: 0, turn: null, at: now(),
      }
    })
  }
  async function publishCollaboration(conn: ClientConn): Promise<void> {
    if (stopped || storeClosed) return
    publishBackground(conn)
    const session = conn.selectedSession
    if (session === undefined || session === null) return
    try {
      const member = conn.collaborationMember
      const view = await collaboration.view(session, member)
      if (member !== conn.collaborationMember) return
      if (view.collaboration !== undefined && collaborationEvent(conn, view)) {
        for (const event of collaborationDecisions.values()) if (view.members.some(m => m.agent.sessionId === event.session)) {
          conn.link.send({ t: 'ev', gen: conn.target?.gen ?? null, event })
        }
      }
    } catch { /* 离开或停止过程中不启动新的执行。 */ }
  }
  async function collaborationCommand(conn: ClientConn, command: CollaborationCommand): Promise<void> {
    const session = conn.selectedSession
    if (session === undefined || session === null) return
    if (command.type === 'collaboration.read') connections.selectMember(conn, command.member)
    let submitted = command
    let inputKey: string | undefined
    if (command.type === 'collaboration.input') {
      inputKey = command.input.ref ?? crypto.randomUUID()
      const work = store.collaboration.collaborationForSession(session)
      const target = command.shared === true || command.member === undefined ? work?.originSessionId
        : store.collaboration.getAgent(command.member)?.sessionId
      collaborationInputs.set(inputKey, { conn, session, target: target ?? session, ...(command.input.ref === undefined ? {} : { ref: command.input.ref }) })
      submitted = { ...command, input: { ...command.input, ref: inputKey } }
    }
    try {
      const view = await collaboration.command(session, submitted)
      if (command.type === 'collaboration.read' && command.member !== conn.collaborationMember) return
      if (command.type === 'collaboration.resume') {
        const live = liveOf(view.originSession)
        if (live !== undefined && conn.target !== live) bind(conn, live)
      }
      collaborationEvent(conn, view)
    }
    catch (error) {
      if (command.type === 'collaboration.input') {
        if (inputKey !== undefined) collaborationInputs.delete(inputKey)
        conn.link.send({
          t: 'ev', gen: conn.target?.gen ?? null, event: {
            kind: 'input.settled', data: { ok: false, ...(command.input.ref === undefined ? {} : { ref: command.input.ref }), reason: String(error) },
            session, id: store.serviceFor(session).nextId(), at: now(), turn: null,
          }
        })
      }
      collaborationEvent(conn, await collaboration.view(session, conn.collaborationMember, String(error)))
    }
  }

  function rows(): readonly RunRow[] {
    const out: RunRow[] = []
    const live = new Set<string>()

    const known = (session: string): boolean =>
      storeClosed ? true : store.hasSession(session)

    for (const executor of executors) {
      const session = executor.run.session
      if (session === null || !known(session)) continue
      live.add(session)
      out.push(runRowOf(executor.run))
    }

    for (const [session, run] of lastRuns) {
      if (live.has(session) || !known(session)) continue
      out.push(runRowOf(run))
    }

    return out
  }

  /** 这一推的定时器——合并窗见 `RUNS_PUSH_MS`。 */
  let pushTimer: ReturnType<typeof setTimeout> | undefined

  function pushRuns(immediate = false): void {
    if (pushTimer !== undefined) {
      if (!immediate) return
      clearTimeout(pushTimer)
      pushTimer = undefined
    }
    if (stopped) return

    if (!immediate) {
      pushTimer = setTimeout(() => {
        pushTimer = undefined
        pushRuns(true)
      }, RUNS_PUSH_MS)
      pushTimer.unref?.()
      return
    }

    native.changed()
    for (const conn of clients.values()) publishBackground(conn)
    const payload = rows()
    for (const conn of clients.values()) conn.link.send({ t: 'runs', rows: payload })
  }

  /** 落盘的合并窗定时器——见 `saveRuns`。 */
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  function saveRuns(immediate = false): void {
    if (saveTimer !== undefined) {
      if (!immediate) return
      clearTimeout(saveTimer)
      saveTimer = undefined
    }

    if (!immediate) {
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        try { saveRuns(true) } catch (error) { options.log?.(`运行状态保存失败：${String(error)}`); diagnosticLog.write('error', 'runs.save.failed', identity) }
      }, RUNS_SAVE_MS)
      saveTimer.unref?.()
      return
    }

    // 最近历史有界；尚未核销的责任与活执行者必须全部保留。
    const history: StoredRun[] = []
    const outstanding: StoredRun[] = []
    for (const run of lastRuns.values()) {
      const one = storedRunOf(run)
      if (one !== undefined) (run.ended === undefined || run.reclaimPending || run.reclaimNote !== undefined ? outstanding : history).push(one)
    }
    for (const executor of executors) {
      const one = storedRunOf(executor.run)
      if (one !== undefined) outstanding.push(one)
    }
    writeRuns(paths, [...history.slice(-STORED_RUNS_LIMIT), ...outstanding], now())
  }

  /** 一摊运行的那几件工具——`stop` 与各自的收尾都要它们，故在闭包里立。 */
  const manager: Manager = {
    identity,
    ready: async () => { },
    record,
    socketPath: paths.socket,
    clients: () => clients.size,
    executors: () =>
      [...executors]
        .filter((one) => one.run.ended === undefined)
        .map((one) => ({ session: one.run.session, gen: one.gen })),
    runs: () => rows(),
    stop,
    waitUntilExit: () => exited,
  }

  function accept(socket: Socket<unknown>): void {
    const link = linkOf<Wire>(socket)
    if (!available) { link.close(); return }
    /** 这条连接立起来的时候是谁的——`hello` 那一刻定下，之后不再变。 */
    let greeted = false
    let client: ClientConn | undefined

    link.onMessage((message) => {
      try {
        if (message.t === 'hello') {
          if (greeted) { link.close(); return }
          greeted = true
        }
        if (native.receive(link, message)) return
        if (message.t === 'hello' && message.role === 'observer') return
        if (message.t === 'hello') {
          if (stopped) { link.send({ t: 'line', text: 'Magic Code 正在退出' }); link.close(); return }
          if (message.protocol !== identity.protocol || message.version !== identity.version || message.source !== identity.source) {
            link.send({ t: 'line', text: 'App 与终端版本或来源不同，请退出原版后重试' }); link.close(); return
          }
          const conn = connections.create({
            link: link as unknown as Link<ClientToManager>,
            selectedSession: message.session ?? null,
            cwd: message.cwd,
            switch: message.switch,
            allowAll: message.allowAll,
          })
          client = conn

          if (message.session !== undefined && (!store.hasSession(message.session) || (isArchived(message.session) && !message.reattach))) {
            link.send({
              t: 'welcome',
              identity,
              conn: conn.id,
              base: options.magic.base,
              // 回绝这一条不必等预检（它连不上就是连不上，与外部工具无关）
              mcp: probed,
              // 这一条**不是给窗口的读数**（连接当场就关了）——给一份空的，形态上照旧
              runs: [],
              notices: [],
              refuse: isArchived(message.session) ? ARCHIVED_NOTE :
                `没有这条会话：${message.session}——` +
                `magic resume 收的是会话 id（/resume 那张列表里那串）；库里没有它，本次一步都没走`,
            })
            link.close()
            return
          }

          connections.accept(conn)

          link.send({
            t: 'welcome',
            identity,
            conn: conn.id,
            base: options.magic.base,
            mcp: probed,
            // 开屏那张摘要据它说「这一摊有几项在跑」——**接上就读得到**，不必先问一次
            runs: rows(),
            // 汇总只读；具体事项另行确认已读。
            notices: store.attention.list().filter((one) => one.unread),
          })
          if (message.openRequest !== undefined) native.attached(message.openRequest, message.session ?? null)

          // 已在运行则接回；完成的会话只读历史，直到下一次明确输入。
          if (message.session !== undefined) {
            if (message.reattach && isArchived(message.session)) {
              conn.link.send({ t: 'target', gen: null, session: message.session })
              void catalog(conn).then(() => readHistory(conn, message.session!))
              native.changed()
            } else retarget(conn, message.session)
          }
          return
        }

        if (client !== undefined) {
          if (stopped) { link.send({ t: 'line', text: 'Magic Code 正在退出' }); return }
          if (message.t === 'read') { store.attention.markRead(message.ids); native.changed() }
          if (message.t === 'cmd' && 'gen' in message) {
            if (message.environment !== undefined) connections.updateEnvironment(client, message.environment)
            onCommand(client, message.gen, message.cmd)
          }
          if (message.t === 'stop') stopRun(client, message.session, message.scope)
          if (message.t === 'bye') dropClient(client.id)
          return
        }

      } catch (error) {
        link.send({ t: 'line', text: `操作未完成：${String(error)}` })
        diagnosticLog.write('error', 'client.operation.failed', identity)
      }
    })
    link.onClose(() => { if (client !== undefined) dropClient(client.id) })
  }

  const stopReports = new Map<number, (phase: StopPhase, note?: string) => void>()
  let nextStopRequest = -1
  let nextStopGeneration = 1
  const stopGenerations = new WeakMap<RunRecord, number>()
  const stopGeneration = (run: RunRecord): number => {
    let gen = stopGenerations.get(run)
    if (gen === undefined) { gen = nextStopGeneration++; stopGenerations.set(run, gen) }
    return gen
  }
  const collaborationStopVersions = new Map<string, { signature: string; gen: number }>()
  function workStopGeneration(session: string,
    group = captureCollaborationNative(store.collaboration, [session]).groups[0] as CollaborationNativeGroup | undefined,
  ): number | null {
    if (group === undefined) {
      const run = liveOf(session)?.run ?? lastRuns.get(session)
      return run === undefined ? null : stopGeneration(run)
    }
    const work = group.collaboration
    // 只是停止目标的版本，不另存工作状态；任何成员换代或新输入使旧菜单失效。
    const signature = JSON.stringify([
      work.state,
      group.members.map(member => {
        const run = liveOf(member.sessionId)?.run ?? lastRuns.get(member.sessionId)
        return [member.agentId, member.reachability, run === undefined ? null : stopGeneration(run)]
      }),
      group.delegations.map(item => [item.delegationId, item.state]),
      group.waits.map(item => [item.waitId, item.state]),
    ])
    const previous = collaborationStopVersions.get(work.collaborationId)
    if (previous?.signature === signature) return previous.gen
    const gen = nextStopGeneration++
    collaborationStopVersions.set(work.collaborationId, { signature, gen })
    return gen
  }
  function publishPreferences(except?: ClientConn): void {
    const config = loadConfig({ magic: options.magic }).config
    for (const conn of clients.values()) if (conn !== except) conn.link.send({
      t: 'ev', gen: null, event: {
        id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'prefs.state', data: {
          ...(config.statusLine === undefined ? {} : { statusLine: config.statusLine }), turnDuration: config.turnDuration ?? 'elapsed', reducedMotion: config.motion?.reduced === true,
        }
      }
    })
  }
  /** 连接真源仍是 clients；执行者结束不影响正在查看该会话的终端。 */
  function terminalClients(session: string): ClientConn[] {
    const origin = store.collaboration.collaborationForSession(session)?.originSessionId ?? session
    return [...clients.values()].filter(conn => !conn.link.closed &&
      (conn.selectedSession !== null && workRoot(conn.selectedSession) === origin))
  }
  function currentRequests(session: string): readonly Extract<KernelEvent, { kind: 'tool.decision.request' }>[] {
    const root = workRoot(session)
    return [...collaborationDecisions.values()].filter(event => workRoot(event.session) === root && liveOf(event.session)?.run.decisions.has(event.id))
  }
  /** 当前提醒只能引用原事实；旧通知行本身不能证明还有一个停点。 */
  function reconcileNotice(session: string): AttentionItem | undefined {
    const root = workRoot(session)
    const notice = store.attention.list({ sessions: [root] })[0]
    if (notice === undefined) return undefined
    const source = notice.source ?? (/^\d+$/.test(notice.fact) ? { session: root, event: Number(notice.fact) } : undefined)
    const event = source?.event === undefined ? undefined : store.readEvent(source.session, source.event)
    const boundary = source === undefined ? undefined : store.latestEvent(source.session, ['turn.start', 'turn.end', 'message.user'])
    let valid = !isArchived(root) && source !== undefined && workRoot(source.session) === root
    if (notice.kind === 'needs-you') valid &&= event?.kind === 'tool.decision.request' && liveOf(source!.session)?.run.decisions.has(event.id) === true
    else if (notice.kind === 'done') valid &&= event?.kind === 'turn.end' && event.data.reason === 'settled' && !event.data.continues && boundary?.id === event.id && canArchive(root)
    else if (event !== undefined) valid &&= (event.kind === 'error' || event.kind === 'model.error' || event.kind === 'turn.end') && boundary?.kind === 'turn.end' && boundary.data.reason === 'error' && (event.turn === boundary.turn || event.id === boundary.id)
    else {
      const run = lastRuns.get(source?.session ?? root) ?? liveOf(root)?.run
      valid &&= run?.ended?.kind === 'crashed' && notice.fact === `${run.gen}@${run.ended.at}`
    }
    if (!valid) { store.attention.clear(root); return undefined }
    if (notice.source === undefined && source !== undefined) {
      const current = { ...notice, source }
      store.attention.clear(root)
      store.attention.put(current)
      return current
    }
    return notice
  }
  async function nativeWorks(): Promise<readonly NativeWork[]> {
    const metadata = await store.listSessions({ archived: false })
    const allGroups = captureCollaborationNative(store.collaboration, metadata.map(session => session.id))
    for (const notice of store.attention.list()) reconcileNotice(notice.session)
    const runs = rows()
    const candidates = [...new Set([
      ...runs.filter(run => run.holds).map(run => run.session),
      ...mergeCollaborationNative([], allGroups).filter(work => work.affected).map(work => work.session),
      ...store.attention.list({ unread: true }).map(notice => notice.session),
      ...[...clients.values()].flatMap(conn => conn.link.closed || conn.selectedSession === null ? [] : [conn.selectedSession]),
    ])]
    const snapshot = captureCollaborationNative(store.collaboration, candidates)
    const generations = new Map(snapshot.sessions.map(session => [session, workStopGeneration(workRoot(session))]))
    const works = await projectWorks(store, runs, session => generations.get(session) ?? null, {
      candidates: snapshot.sessions, terminalOpen: session => terminalClients(session).length > 0, canArchive,
    })
    const affected = await (options.lifecycle?.affected() ?? Promise.resolve([]))
    return [...mergeCollaborationNative(works, snapshot).map(work => ({
      ...work,
      archived: isArchived(work.session), canArchive: canArchive(work.session), terminalOpen: terminalClients(work.session).length > 0,
      gen: generations.get(work.session) ?? null,
    })).filter(work => !work.archived && (work.affected || work.terminalOpen || work.currentNotice?.unread)), ...affected]
  }
  async function nativeSessions(query: { archived?: boolean; workspace?: readonly string[]; search?: string; ids?: readonly string[] }): Promise<readonly NativeSession[]> {
    const metadata = await store.listSessions({ archived: query.archived ?? false, ...(query.ids === undefined ? {} : { ids: query.ids }), ...(query.workspace === undefined ? {} : { workspace: query.workspace }) })
    const roots = metadata.filter(session => workRoot(session.id) === session.id).map(session => session.id)
    const catalog = await readSessionCatalog(store, undefined, { ids: roots })
    const runs = rows()
    const snapshot = captureCollaborationNative(store.collaboration, catalog.map(s => s.id))
    const summaries = new Map(catalog.map(session => [session.id, session]))
    const raw: NativeWork[] = snapshot.sessions.map(session => {
      const s = summaries.get(session)
      const run = runs.find(r => r.session === session)
      return {
        session, title: s?.title ?? '未命名工作', workspace: s?.workspace ?? run?.workspace ?? [], archived: isArchived(session),
        canArchive: canArchive(session), terminalOpen: terminalClients(session).length > 0,
        background: run?.backgroundUnknown ? undefined : run?.background ?? 0,
        state: run?.state ?? 'idle', since: run?.since ?? s?.at ?? 0, gen: null, affected: run?.holds ?? false,
        ...(run?.reason === undefined ? {} : { reason: run.reason }),
      }
    })
    const states = new Map(mergeCollaborationNative(raw, snapshot).map(w => [w.session, w]))
    const attention = new Set(query.archived ? [] : catalog.filter(session => states.get(session.id)?.affected || terminalClients(session.id).length > 0 || reconcileNotice(session.id)?.unread).map(session => session.id))
    return catalog.filter(s => workRoot(s.id) === s.id && (!query.search || (s.title ?? '').toLocaleLowerCase().includes(query.search.toLocaleLowerCase()))).map(s => {
      const work = states.get(s.id)!
      return { ...s, background: work.background, state: work.state, canArchive: canArchive(s.id), terminalOpen: terminalClients(s.id).length > 0, ...(work.reason === undefined ? {} : { reason: work.reason }) }
    }).sort((left, right) => {
      const priority = Number(attention.has(right.id)) - Number(attention.has(left.id))
      return priority || right.at - left.at || left.id.localeCompare(right.id)
    })
  }
  const runtime = {
    read: async () => {
      const current = [...executors].filter(executor => !executor.exited && !executor.run.stopping)
      await Promise.all(current.map(executor => control.settings(executor, undefined, true)))
      return {
        canChangeData: !(await nativeWorks()).some(work => work.affected) && executors.size === 0,
        mcp: current.flatMap(executor => executor.run.session === null ? [] : [{
          session: executor.run.session, gen: workStopGeneration(executor.run.session), servers: control.servers(executor) ?? [],
        }]),
      }
    },
    reconnect: async (session: string, gen: number, name: string) => {
      const executor = liveOf(session)
      if (executor === undefined || workStopGeneration(session) !== gen || executor.run.stopping) throw new Error('该工作已结束或换代，未重连')
      return control.settings(executor, name)
    },
  }
  let configuration: { stamp: string | null; error?: string } = { stamp: null }
  const native = createNativeServer({
    configuration: () => configuration,
    identity, store, accepting: () => !stopped, runtime,
    async engineStop(request, idleOnly) {
      // 核责任与关闭准入之间没有 await，新提交不能穿过实例切换。
      if (idleOnly) {
        const sessions = await store.listSessions()
        const groups = captureCollaborationNative(store.collaboration, sessions.map(session => session.id))
        if (executors.size > 0 || [...lastRuns.values()].some(run => run.owned.length > 0 || run.ended === undefined) || mergeCollaborationNative([], groups).some(work => work.affected)) throw new Error('仍有所属工作责任，不能切换基础路径')
      }
      const completion = beginStop('停止 Magic Engine')
      return (async () => {
        await options.engineState?.('stopping', request)
        try { await completion; await options.engineState?.('stopped', request) }
        catch (error) { await options.engineState?.('failed', request, String(error)); throw error }
      })()
    },
    record: (level, event, request) => diagnosticLog.write(level, event, { ...identity, request }),
    works: nativeWorks,
    sessions: nativeSessions,
    manage: manageSession,
    currentRequests,
    async inspect(session) {
      if (!store.hasSession(session)) return undefined
      const root = workRoot(session)
      const summary = (await nativeSessions({ ids: [root], archived: isArchived(root) }))[0]
      if (summary === undefined) return undefined
      const notice = reconcileNotice(root)
      const run = liveOf(root)?.run ?? lastRuns.get(root)
      return {
        session: root, title: summary.title ?? '未命名工作', workspace: summary.workspace ?? [],
        archived: summary.archived, canArchive: summary.canArchive, terminalOpen: summary.terminalOpen,
        state: summary.state, since: run?.since ?? summary.at, gen: workStopGeneration(root),
        affected: !summary.archived && !summary.canArchive,
        ...(summary.reason === undefined ? {} : { reason: summary.reason }),
        ...(notice === undefined ? {} : { currentNotice: notice }),
      }
    },
    stop(session, gen, report) {
      if (workStopGeneration(session) !== gen) {
        report('unconfirmed', '目标已经结束或换代，请刷新当前状态')
        native.changed()
        return
      }
      const id = nextStopRequest--
      stopReports.set(id, (phase, note) => {
        report(phase, note)
        if (phase !== 'accepted') stopReports.delete(id)
      })
      stopRun({ id }, session, 'run')
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  })

  const closeConfigWatch = watchConfig(`${options.magic.base}/config.json`, () => loadConfig({ magic: options.magic }), async loaded => {
    const diagnostics = diagnosticsOf(loaded.config)
    diagnosticLog.setLevel(diagnostics.logLevel)
    const current = [...executors].filter(executor => !executor.exited && !executor.run.stopping)
    await Promise.all(current.map(async executor => {
      await control.settings(executor, undefined, false, diagnostics)
      await control.settings(executor)
    }))
    publishPreferences()
    configuration = { stamp: loaded.stamp ?? null }
    native.changed()
  }, error => {
    configuration = { ...configuration, error: String(error) }
    native.changed()
    diagnosticLog.write('error', 'configuration.apply.failed', identity)
    options.log?.(`配置采用失败：${String(error)}`)
  })

  function clearTurnNotice(session: string): void {
    const root = workRoot(session)
    const current = store.attention.list({ sessions: [root] })[0]
    if (current?.kind === 'needs-you' && current.source?.session !== session) return
    store.attention.clear(root)
  }
  // 只保存当前轮的来源引用，正文在实际停点按该条目读取。
  const stopContent = new WeakMap<RunRecord, { entry?: number; event?: number; error?: string; stop?: KernelEvent }>()
  function notify(session: string, kind: NoticeKind, fact: string | number, detail?: string, source?: { session: string; event?: number; entry?: number }, at = now()): void {
    const root = workRoot(session)
    if (isArchived(root)) return
    if (session !== root && kind !== 'needs-you') return
    const origin = source ?? { session, ...(typeof fact === 'number' ? { event: fact } : {}) }
    const notice = {
      id: noticeKey(session, kind, fact), session: root, source: origin, kind, fact: String(fact), at, unread: true, delivered: false,
      detail: `${session === root ? '' : `${store.collaboration.agentForSession(session)?.name ?? '成员'}：`}${summarize(detail ?? '本轮已收束，原内容暂不可用', 500) ?? ''}`,
    }
    if (!store.attention.put(notice)) return
    for (const conn of terminalClients(root)) conn.link.send({ t: 'notice', notice })
    native.changed()
  }
  async function notifyStop(run: RunRecord, event: KernelEvent): Promise<void> {
    const session = run.session
    if (session === null || (run.lastTurn !== 'settled' && run.lastTurn !== 'error')) return
    if (event.kind === 'turn.end' && event.data.continues) return
    const content = stopContent.get(run)
    const stop = content?.stop ?? event
    if (stop.kind === 'turn.end' && stop.data.continues) return
    const at = run.lastTurnAt
    const kind = run.lastTurn === 'error' ? 'failed' : 'done'
    let detail = content?.error
    if (kind === 'done' && content?.entry !== undefined) {
      for await (const entry of readSessionDisplayHistory(store, session, { from: content.entry, to: content.entry })) {
        detail = 'text' in entry.content ? entry.content.text : undefined
      }
    }
    if (stopContent.get(run) !== content || run.lastTurnAt !== at || run.turnActive || run.busy || run.backgroundView?.waiting.length || isArchived(session)) return
    const group = store.collaboration.collaborationForSession(session)
    if (group !== undefined && kind === 'done' && (group.originSessionId !== session
      || store.collaboration.listDelegations(group.collaborationId).some(one => !['received', 'rejected', 'cancelled'].includes(one.state))
      || backgroundView(session).waiting.length > 0)) return
    notify(session, kind, stop.id, detail ?? (kind === 'failed' ? '本轮无法继续，具体错误暂不可用' : '本轮已收束，面向用户的回复暂不可用'),
      { session, event: kind === 'failed' ? content?.event ?? stop.id : stop.id, ...(kind === 'done' && content?.entry !== undefined ? { entry: content.entry } : {}) }, stop.at)
  }

  /** 等待者绑定具体执行者代次，旧代异步核销不能兑现同会话的后继代。 */
  const settledRuns = new WeakSet<RunRecord>()

  /** 回一句「停到哪一拍」——按会话 ＋ 范围，话由外壳按它自己的目录拼（见 `wire.ts`）。 */
  function reportStop(
    connId: number,
    session: string,
    scope: StopScope,
    phase: StopPhase,
    note?: string,
  ): void {
    stopReports.get(connId)?.(phase, note)
    clients.get(connId)?.link.send({
      t: 'stopped',
      session,
      scope,
      phase,
      ...(note === undefined ? {} : { note }),
    })
  }

  /** 核销之后回「已完成」——**这一拍才算「已停」**（设计：「资源确认退出后才报已停止」）。 */
  const runStops = createRunStops({
    now, liveOf, lastRuns, stopGraceMs, stopKillMs, deliver,
    reportStop,
    changed: (immediate = false) => { saveRuns(immediate); pushRuns() },
    log: options.log,
    onSettled(run, note) {
      if (note === undefined && run.ended !== undefined && !run.reclaimPending && run.reclaimNote === undefined &&
        run.session !== null && run.executionId !== undefined && !storeClosed && !settledRuns.has(run)) {
        void collaboration.executorExited(run.session, run.executionId, run.ended.why,
          run.ended.kind === 'crashed' && lastRuns.get(run.session) === run && liveOf(run.session) === undefined).catch(error => options.log?.(`中断回报尚未核实：${String(error)}`))
        settledRuns.add(run)
      }
    },
  })
  const { stopExecution, settleStop, reclaimStale, reclaimRun, escalateStop } = runStops

  function stopRun(conn: Pick<ClientConn, 'id'>, session: string, scope: StopScope): void {
    const work = store.collaboration.collaborationForSession(session)
    if (work !== undefined) {
      const agent = store.collaboration.agentForSession(session)
      const delegation = agent?.agentId === work.coordinatorId ? undefined : store.collaboration.listDelegations(work.collaborationId).find(d => d.assigneeId === agent?.agentId && d.state === 'accepted')?.delegationId
      if (agent?.agentId !== work.coordinatorId && delegation === undefined) {
        reportStop(conn.id, session, scope, 'unconfirmed', '此成员没有当前委派，无法推断停止范围')
        return
      }
      store.attention.clear(workRoot(session))
      reportStop(conn.id, session, scope, 'accepted')
      void collaboration.command(work.originSessionId, { type: 'collaboration.stop', ...(delegation === undefined ? {} : { delegation }) }).then(
        () => reportStop(conn.id, session, scope, 'done'),
        error => reportStop(conn.id, session, scope, 'unconfirmed', String(error)),
      )
      return
    }
    stopExecution(conn, session, scope)
  }

  // —— 命令：路由 ——

  async function catalog(conn: ClientConn, archived = false): Promise<void> {
    try {
      const sessions = await nativeSessions({ archived })
      if (conn.link.closed) return
      conn.link.send({
        t: 'ev', gen: null, event: {
          id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'session.state',
          data: { active: conn.selectedSession ?? '', sessions },
        }
      })
      if (conn.selectedSession !== null) { const session = conn.selectedSession; conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.changed', data: { session: workRoot(session), archived: isArchived(session), canArchive: canArchive(session), terminalOpen: terminalClients(session).length > 0 } } }) }
      if (conn.selectedSession !== null) conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: conn.selectedSession, kind: 'input.pending', data: { inputs: store.serviceFor(conn.selectedSession).inputs.list() } } })
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session: conn.selectedSession ?? '', kind: 'session.state', data: { active: conn.selectedSession ?? '', sessions: [], note: '无法读取会话目录' } } }) }
  }

  async function readHistory(conn: ClientConn, session: string): Promise<void> {
    if (!store.hasSession(session)) { conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '会话已不可达' } } }); return }
    const revision = connections.beginHistory(conn, session)
    if (revision === undefined) return
    try {
      let entries: Entry[] = []
      const inputs: Extract<KernelEvent, { kind: 'input.local' }>[] = []
      const timing: TurnTimingEvent[] = []
      for await (const event of store.serviceFor(session).readEvents(session)) {
        if (event.kind === 'input.local') inputs.push(event)
        if (isTurnTimingEvent(event)) timing.push(event)
      }
      const send = (done: boolean): void => {
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, turn: null, at: now(), session, kind: 'session.history', data: { session, entries, done, ...(done ? { inputs, timing } : {}) },
          }
        })
        entries = []
      }
      for await (const entry of readSessionDisplayHistory(store, session)) {
        if (!connections.historyCurrent(conn, revision)) return
        entries.push(entry)
        if (entries.length === 50) send(false)
      }
      if (connections.historyCurrent(conn, revision)) send(true)
    } catch { if (!conn.link.closed) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'session.history', data: { session, entries: [], done: true, error: '无法读取会话记录' } } }) }
    finally { connections.finishHistory(conn, revision) }
  }

  async function onCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void> {
    const session = conn.selectedSession
    const execution = command.type === 'input.submit' || command.type === 'decision.answer' || command.type === 'collaboration.input' || command.type === 'collaboration.resume' || (command.type === 'input.manage' && command.action !== 'list')
    if (session !== null && execution && isArchived(session)) {
      const input = command.type === 'input.submit' ? command : command.type === 'collaboration.input' ? command.input : undefined
      if (input !== undefined) conn.link.send({ t: 'ev', gen: null, event: { id: 0, at: now(), turn: null, session, kind: 'input.settled', data: { ok: false, ref: input.ref, reason: ARCHIVED_NOTE } } })
      else conn.link.send({ t: 'line', text: ARCHIVED_NOTE })
      return
    }
    const root = session !== null && execution ? workRoot(session) : undefined
    const release = root === undefined ? undefined : sessions.admit(root)
    try { await acceptCommand(conn, gen, command) }
    finally { release?.() }
  }
  async function acceptCommand(conn: ClientConn, gen: number | null, command: Command): Promise<void> {
    if (command.type === 'background.list' || command.type === 'background.stop') { backgroundCommand(conn, command); return }
    if (command.type === 'history.read') {
      const session = command.session ?? conn.selectedSession
      if (session !== null && session !== undefined) void readHistory(conn, session)
      return
    }
    if (command.type === 'session.list') { void catalog(conn, command.archived ?? false); return }
    if (command.type === 'session.archive' || command.type === 'session.restore' || command.type === 'session.rename') {
      const result = manageSession({ session: command.session, action: command.type === 'session.archive' ? 'archive' : command.type === 'session.restore' ? 'restore' : 'rename', ...('title' in command ? { title: command.title } : {}) })
      conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session: result.session, kind: 'session.managed', data: result } })
      return
    }
    // 界面偏好只写配置，不依附一代任务执行者，也不创建会话。
    if (command.type === 'prefs.set') {
      try {
        const loaded = loadConfig({ magic: options.magic })
        const outcome = await setPrefs({ path: loaded.path, expectedStamp: loaded.stamp, request: command })
        if (outcome.ok) publishPreferences(conn)
        const config = outcome.ok ? loadConfig({ magic: options.magic }).config : loaded.config
        const changed = [command.statusLine === undefined ? '' : '状态行', command.reducedMotion === undefined ? '' : '动效', command.turnDuration === undefined ? '' : '本轮耗时'].filter(Boolean).join(' · ')
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, turn: null, at: now(), session: conn.selectedSession ?? '', kind: 'prefs.state', data: {
              ...(config.statusLine === undefined ? {} : { statusLine: config.statusLine }),
              turnDuration: config.turnDuration ?? 'elapsed', reducedMotion: config.motion?.reduced === true,
              note: outcome.ok ? `已更新：${changed}` : `${changed}没改成——${outcome.reason}`,
            }
          }
        })
      } catch (error) { conn.link.send({ t: 'line', text: `界面设置没改成：${error instanceof Error ? error.message : String(error)}` }) }
      return
    }

    if (conn.target === undefined && ['model.list', 'provider.list', 'skills.list', 'paths.list', 'grants.list', 'mcp.list'].includes(command.type)) {
      const session = conn.selectedSession
      void observe(command, {
        magic: options.magic, cwd: conn.cwd, store, session, mcp: mcpCatalog, now,
        ...(conn.switch === undefined ? {} : { switch: conn.switch }),
      }).then((event) => {
        if (event !== undefined && !conn.link.closed && conn.selectedSession === session) conn.link.send({ t: 'ev', gen: null, event })
      }).catch((error) => { if (!conn.link.closed) conn.link.send({ t: 'line', text: `读取失败：${String(error)}` }) })
      return
    }
    const originSession = conn.selectedSession
    const activeCollaboration = originSession == null ? undefined : store.collaboration.collaborationForSession(originSession)
    // 有效成员卡归持卡执行者；入口退代不能让这张仍有效的卡答不进去。
    if (activeCollaboration !== undefined && command.type === 'decision.answer') {
      const memberSessions = new Set(store.collaboration.listMembers(activeCollaboration.collaborationId).map(a => a.sessionId))
      const owner = [...executors].find(e => e.run.session !== null && memberSessions.has(e.run.session) && e.run.decisions.has(command.id))
      if (owner !== undefined) { deliver(owner, command); return }
      if ([...executors].some(e => e.run.session !== null && memberSessions.has(e.run.session) && e.run.resolvedDecisions.has(command.id))) {
        conn.link.send({ t: 'line', text: '这一件已经处理过了——答复只算第一次' })
        return
      }
    }

    if (gen !== null && (conn.target === undefined || gen !== conn.target.gen)) {
      conn.link.send({
        t: 'line',
        text:
          conn.target === undefined
            ? '这一代已经不在了——它那条命令没生效（接着敲就是，会给你起新的一代）'
            : `这一代已经过去了（那是第 ${gen} 代，现在是第 ${conn.target.gen} 代）——它那条命令没生效`,
      })
      return
    }

    const localInput = command.type === 'input.submit' && command.local === true ? command : command.type === 'collaboration.input' && command.input.local === true ? command.input : undefined
    if (localInput !== undefined) {
      const origin = conn.selectedSession
      const work = origin === null ? undefined : store.collaboration.collaborationForSession(origin)
      const member = command.type === 'collaboration.input' ? command.member : undefined
      const session = member === undefined ? origin : work === undefined ? undefined : store.collaboration.listMembers(work.collaborationId).find(one => one.agentId === member)?.sessionId
      if (session != null) { const records = store.serviceFor(session); records.appendEvent({ session, id: records.nextId(), turn: null, at: now(), kind: 'input.local', data: { text: localInput.text, refs: localInput.refs ?? [], ref: localInput.ref ?? crypto.randomUUID() } }) }
      return
    }

    if (command.type.startsWith('collaboration.')) {
      if (conn.selectedSession !== null && (command.type === 'collaboration.resume' || command.type === 'collaboration.input') && environmentFor(conn.selectedSession) === undefined) environments.set(workRoot(conn.selectedSession), createWorkEnvironment(conn.environment))
      await collaborationCommand(conn, command as CollaborationCommand)
      return
    }
    if (command.type === 'session.new') connections.selectMember(conn, undefined)

    if (command.type === 'input.manage') {
      const origin = conn.selectedSession
      const work = origin === null ? undefined : store.collaboration.collaborationForSession(origin)
      const member = command.member === undefined ? undefined : work === undefined ? undefined : store.collaboration.listMembers(work.collaborationId).find(one => one.agentId === command.member)
      const session = command.member === undefined ? origin : member?.sessionId
      if (session == null) { conn.link.send({ t: 'line', text: '当前输入目标不存在，未修改' }); return }
      if (member?.purpose === 'consultation' && command.action !== 'list') { conn.link.send({ t: 'line', text: '咨询详情只供查看；相关纠正请补充给原工作' }); return }
      const inputs = store.serviceFor(session).inputs
      let note: string | undefined
      if (command.action === 'edit') note = inputs.edit(command.ref, command.revision, command.input) ? '已保存未消费输入' : '输入已消费或已改变，未修改'
      if (command.action === 'withdraw') note = inputs.withdraw(command.ref, command.revision) ? '已撤回未消费输入' : '输入已消费或已改变，未撤回'
      if (command.action === 'continue') {
        const row = inputs.get(command.ref)
        if (row?.state !== 'pending' || row.revision !== command.revision) note = '输入已消费或已改变，未继续'
        else if (work?.state === 'stopped') note = '这份工作已停止，请先明确继续工作'
        else {
          const executor = liveOf(session) ?? spawn({ session, explicit: true, cwd: member?.workspace[0] ?? conn.cwd, environment: conn.environment })
          if (executor === undefined) note = '当前执行者不可用，输入保留'
          else {
            if (member === undefined) bind(conn, executor)
            else collaborationInputs.set(row.ref, { conn, session: origin!, target: session, ref: row.ref })
            deliver(executor, command)
          }
        }
      }
      conn.link.send({ t: 'ev', gen: null, event: { id: 0, turn: null, at: now(), session, kind: 'input.pending', data: { inputs: inputs.list(), ...(note === undefined ? {} : { note }) } } })
      return
    }
    if (activeCollaboration !== undefined && command.type === 'input.submit') {
      await collaborationCommand(conn, { type: 'collaboration.input', input: command, shared: true })
      return
    }
    if (activeCollaboration !== undefined && command.type === 'turn.interrupt') {
      void collaborationCommand(conn, { type: 'collaboration.stop' })
      return
    }

    // 已完成工作的短暂收缩余量不属于执行责任；下一次明确输入先收妥旧实例，
    // 再按发起终端的环境建立下一代。后台工具、队列及协作责任仍沿用原环境。
    const previous = conn.target
    if (command.type === 'input.submit' && previous?.run.session != null && activeCollaboration === undefined &&
      previous.run.lastTurn !== undefined && !previous.run.busy && !previous.run.turnActive &&
      backgroundOf(previous.run) === 0 && previous.run.decisions.size === 0 &&
      !store.serviceFor(previous.run.session).inputs.list().some(input => input.state === 'pending')) {
      const selected = conn.selectedSession
      // 该输入由管理者等待接续，不属于旧 Agent；旧实例释放不能给它发送拒收回执。
      connections.unbind(conn)
      const closed = new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 15000)
        previous.spawned.onExit(() => { clearTimeout(timer); resolve(true) })
      })
      send(previous, { t: 'bye', why: '已完成工作，释放旧环境后继续' })
      if (!await closed || stopped || conn.selectedSession !== selected) {
        conn.link.send({
          t: 'ev', gen: null, event: {
            id: 0, session: selected ?? '', turn: null, at: now(),
            kind: 'input.settled', data: { ok: false, ref: command.ref, reason: '旧工作收尾未确认或入口已改变，未受理新输入' }
          }
        })
        return
      }
      await onCommand(conn, null, command)
      return
    }

    if (command.type === 'decision.answer' && conn.target !== undefined) {
      const run = conn.target.run
      if (!run.decisions.has(command.id) && run.resolvedDecisions.has(command.id)) {
        conn.link.send({
          t: 'line',
          text: '这一件已经处理过了——答复只算第一次，那件工具不会再跑一遍',
        })
        return
      }
      deliver(conn.target, command)
      return
    }

    // **换目标的只有这两条**（见文件头注）
    if (command.type === 'session.open' || command.type === 'session.new') {
      if (conn.target !== undefined && conn.target.run.busy) {
        deliver(conn.target, command)
        return
      }

      if (command.type === 'session.open') {
        retarget(conn, command.session)
        return
      }

      // 新对话只是清空连接目标；首条明确输入才启动执行者并创建持久会话。
      connections.selectSession(conn, null)
      void catalog(conn)
      return
    }

    if (conn.target === undefined && conn.selectedSession !== null) {
      // **用户明确继续 ⇒ 建立下一次运行**（同上面那句设计原文）——走到这一支的就是**一条真交代**：
      // 观察类命令在上面 `history.read` / `session.list` 那两处已经返回，到不了这儿。
      const session = conn.selectedSession
      const held = lastRuns.get(session)
      if (held !== undefined && held.ended === undefined) {
        conn.link.send({
          t: 'line',
          text:
            `没接上 ${session}：上一次那条执行者还没有证实结束（它可能正在收尾）` +
            '——同一个会话不能同时起两个。/resume 里那一行标着「状态待确认」',
        })
        return
      }

      // 这一支的前提就是「没有目标」（上面那个 if），故没有可复用的当下那一代——
      // main 的 `retarget` 里有这一段是因为它那儿 `current` 可能还在。
      const spawned = spawn({
        session,
        explicit: true,
        cwd: conn.cwd, environment: conn.environment,
        ...(conn.switch === undefined ? {} : { switch: conn.switch }),
        ...(conn.allowAll === true ? { allowAll: true } : {}),
      })
      if (spawned === undefined) {
        conn.link.send({ t: 'line', text: `起不了执行者——没接上 ${session}` })
        return
      }
      bind(conn, spawned)
      deliver(spawned, command)
      // ⚠️ **这一条不能省**（main 的 `retarget` 新起一代那一支末尾也有它）：为这条会话新起的
      // 那一代是**带着会话号装配**的，`switchTo` 判「已经在的那条 ＝ 无事」——`session.open`
      // 过去一声不响，窗口就此停在旧那一页上。`session.list` 一定会报一次状态，窗口据此重画。
      deliver(spawned, { type: 'session.list' })
      return
    }

    const target = conn.target ?? spawnFresh(conn)
    if (target === undefined) {
      conn.link.send({ t: 'line', text: '起不了执行者——这条命令没能送到' })
      return
    }

    deliver(target, command)
  }

  /** 接回已有会话；查看历史不触发执行，明确输入才启动下一代。 */
  function retarget(conn: ClientConn, session: string): void {
    if (isArchived(session)) { conn.link.send({ t: 'line', text: ARCHIVED_NOTE }); return }
    if (!store.hasSession(session)) {
      conn.link.send({ t: 'line', text: '该会话已不可达，未切换当前工作。' })
      return
    }
    const live = liveOf(session)
    if (live !== undefined) {
      bind(conn, live)
      void catalog(conn).then(() => readHistory(conn, session)).then(() => publishCollaboration(conn))
      return
    }

    connections.selectSession(conn, session)
    void catalog(conn).then(() => readHistory(conn, session)).then(() => publishCollaboration(conn))
  }

  function liveOf(session: string): Executor | undefined {
    for (const one of executors) {
      if (one.run.ended === undefined && one.run.session === session) return one
    }
    return undefined
  }

  /** 起一个还没开张的执行者——**窗口的第一条命令**走它（空白启动页此时才有进程）。 */
  function spawnFresh(conn: ClientConn): Executor | undefined {
    const spawned = spawn({
      session: null,
      explicit: false,
      environment: conn.environment,
      cwd: conn.cwd,
      ...(conn.switch === undefined ? {} : { switch: conn.switch }),
      ...(conn.allowAll === true ? { allowAll: true } : {}),
    })
    if (spawned !== undefined) bind(conn, spawned)
    return spawned
  }

  /** 真起一个——登记在**发车那一刻**（不是等它连上来）：两个窗口同时要同一条会话时，
   *  第二个必须**当场**看得见第一个，否则会各起一个。 */
  function spawn(input: {
    readonly session: string | null
    readonly explicit: boolean
    readonly environment?: Readonly<Record<string, string>>
    readonly cwd: string
    readonly switch?: ModelSwitchRequest | undefined
    readonly allowAll?: boolean | undefined
  }): Executor | undefined {
    if (input.session !== null && isArchived(input.session)) return undefined
    const root = input.session === null ? undefined : workRoot(input.session)
    let network: WorkEnvironment
    try { network = (root === undefined ? undefined : environments.get(root)) ?? createWorkEnvironment(input.environment ?? {}) }
    catch (error) { options.log?.(`工作网络配置不可用：${String(error)}`); return undefined }
    const gen = nextGen
    nextGen += 1
    const executionId = `${gen}-${crypto.randomUUID()}`
    const [link, agentLink] = localLinks<ExecutorToManager, ManagerToExecutor>()
    const ledger = createProcessLedger(owned => {
      executor.run.owned = owned
      refresh(executor.run, now())
      saveRuns(true)
      pushRuns()
    })
    let spawned: SpawnedExecutor
    try {
      spawned = (options.launch ?? createAgentLauncher()).spawn({
        gen, executionId, network, environment: network.env,
        session: input.session, cwd: input.cwd, magic: options.magic,
        link: agentLink, records: store, ledger,
        ...(input.switch === undefined ? {} : { switch: input.switch }),
        ...(input.allowAll === true ? { allowAll: true } : {}),
      })
    } catch (error) {
      options.log?.(`装配 Agent 不成：${String(error)}`)
      if (![...environments.values()].includes(network)) {
        const closing = network.close()
        closingEnvironments.add(closing)
        void closing.then(() => closingEnvironments.delete(closing), error => options.log?.(String(error)))
      }
      return undefined
    }

    const executor: Executor = {
      ledger, network,
      gen,
      executionId,
      run: newRunRecord({
        gen,
        executionId,
        session: input.session,
        startedAt: now(),
        explicit: input.explicit,
      }),
      spawned,
      exited: false,
      link,
      queued: [],
    }

    environments.set(root ?? executionId, network)
    executors.add(executor)
    const failed = (error: unknown) => {
      executor.run.stopping = true
      executor.run.reclaimNote = `工作记录处理失败：${String(error)}`
      for (const conn of connections.watching(executor)) conn.link.send({ t: 'line', text: executor.run.reclaimNote })
      executor.spawned.cancel()
      diagnosticLog.write('error', 'executor.record.failed', { ...identity, run: String(gen) })
    }
    link.onMessage(message => { try { onExecutorMessage(executor, message) } catch (error) { failed(error) } })

    spawned.onExit((reason) => {
      executor.exited = true
      control.exited(executor)
      try { retire(executor, reason) } catch (error) { failed(error) }
    })

    diagnosticLog.write('info', 'executor.started', { ...identity, run: String(gen), ...(input.session === null ? {} : { session: input.session }) })
    options.log?.(`起了执行者 第 ${gen} 代 会话=${input.session ?? '（还没开张）'}`)
    try { saveRuns(true) } catch (error) { failed(error); return undefined }
    pushRuns()
    return executor
  }

  /** 送一条**命令**——`send` 的那一层皮（读起来仍是「送一条命令」）。 */
  function deliver(executor: Executor, command: Command): void {
    // 旧菜单观察到的责任在下一次输入受理时失效，即使复用同一执行者也不能误停下一轮。
    if (command.type === 'input.submit' || (command.type === 'input.manage' && command.action === 'continue')) {
      executor.run.busy = true
      refresh(executor.run, now())
      stopGenerations.set(executor.run, nextStopGeneration++)
      if (executor.run.session !== null) clearTurnNotice(executor.run.session)
    }
    if (command.type === 'turn.interrupt' && executor.run.session !== null) clearTurnNotice(executor.run.session)
    send(executor, { t: 'cmd', cmd: command })
  }

  // —— 执行者那一路 ——

  function onExecutorMessage(executor: Executor, message: ExecutorToManager): void {

    switch (message.t) {
      case 'collaboration.request': {
        const session = executor.run.session
        if (session === null) { send(executor, { t: 'collaboration.reply', requestId: message.requestId, reply: { ok: false, reason: '执行身份尚未绑定' } }); return }
        void collaboration.request(session, message.request).then(reply => {
          send(executor, { t: 'collaboration.reply', requestId: message.requestId, reply })
        })
        return
      }
      case 'collaboration.configured':
        control.configured(executor, message)
        return
      case 'collaboration.changed':
        collaboration.changed()
        return
      case 'assembled':
        if (message.session !== null && store.hasSession(message.session)) executor.run.session = message.session
        executor.run.workspace = message.workspace
        executor.run.everConnected = true
        executor.run.connected = true
        refresh(executor.run, now())
        saveRuns(true)
        pushRuns()
        return
      case 'ready': {
        control.ready(executor)
        executor.run.ready = true
        // 起来那一刻「正在起执行者」这件事就完了（那一格由 `actionOf` 之外的一处写，
        // 故在这儿清）——`busy` 不动：它说的是**内核**手上有活没有，与本跳无关
        executor.run.action = undefined
        refresh(executor.run, now())
        const queued = executor.queued
        executor.queued = []
        for (const one of queued) {
          if (executor.run.ended !== undefined) break
          executor.link.send(one)
        }
        saveRuns()
        pushRuns()
        return
      }
      case 'bound':
        if (!store.hasSession(message.session)) return
        executor.run.session = message.session
        syncTarget(executor)
        bindEnvironment(executor, message.session)
        refresh(executor.run, now())
        saveRuns(true)
        pushRuns()
        return
      case 'settings.synced': {
        diagnosticLog.write(message.error ? 'warn' : 'debug', 'settings.ack', { ...identity, request: message.request, run: String(executor.gen) })
        control.synced(executor, message)
        return
      }
      case 'ev':
        onEvent(executor, message.event)
        return
      case 'done':
        if (!executor.run.ready) {
          for (const conn of connections.watching(executor)) conn.link.send({ t: 'line', text: message.why })
        }
        // **自己受理了收摊**——记成「停止中」，核销等进程真退（见 `retire`）
        markStopping(executor, message.why)
        return
      case 'stopping':
        markStopping(executor, message.why)
        return
      case 'snapshot':
        onSnapshot(executor, message.seq, message.snapshot)
        return
      default:
        return
    }
  }

  /** 记下「已受理停止」——**停止中**那一行的来处（`ended` 一到它就跳过去了）。 */
  function markStopping(executor: Executor, why: string): void {
    if (executor.run.ended !== undefined) return
    executor.run.stopping = true
    refresh(executor.run, now())
    options.log?.(`第 ${executor.gen} 代受理了停止：${why}`)
    saveRuns()
    pushRuns()
  }

  function bindEnvironment(executor: Executor, session: string | null): void {
    if (session === null) return
    environments.delete(executor.executionId)
    environments.set(workRoot(session), executor.network)

  }

  /** 一条内核事件——**广播给盯着这一代的窗口**，顺带把登记里那几格更新到与内核一致。 */
  function onEvent(executor: Executor, event: KernelEvent): void {
    diagnosticLog.write(event.kind === 'error' ? 'error' : 'trace', `kernel.${event.kind}`, { ...identity, run: String(executor.gen), ...(event.session ? { session: event.session } : {}) })
    if (event.kind === 'background.state') {
      executor.run.backgroundView = event.data
      refresh(executor.run, now())
      pushRuns()
      for (const conn of clients.values()) if (conn.selectedSession !== null && workRoot(conn.selectedSession) === workRoot(event.session)) publishBackground(conn, event.data.result)
      return
    }
    if (event.kind === 'mcp.catalog') control.observe(executor, event.data.servers)
    if (event.kind === 'input.settled' && event.data.ref !== undefined) {
      const owner = collaborationInputs.get(event.data.ref)
      if (owner !== undefined) {
        if (event.data.stage !== 'accepted') collaborationInputs.delete(event.data.ref)
        const { ref: _transportRef, ...settled } = event.data
        owner.conn.link.send({
          t: 'ev', gen: owner.conn.target?.gen ?? null, event: {
            ...event, data: { ...settled, ...(owner.ref === undefined ? {} : { ref: owner.ref }) },
          }
        })
        owner.conn.link.send({ t: 'ev', gen: null, event: { session: owner.target, id: 0, at: now(), turn: null, kind: 'input.pending', data: { inputs: store.serviceFor(owner.target).inputs.list() } } })
        return
      }
    }
    const run = executor.run
    const previousSession = run.session
    const at = now()

    // 会话从事件里认（这就是 `bound` 那条路的日常形态：首条消息一按下回车，
    // 事件就带上了真会话号）——**不另立一份「它现在在哪条会话」的真源**。
    if (event.kind === 'session.state') {
      const active = event.data.active
      run.session = active !== '' && store.hasSession(active) ? active : null
      // 查询/配置动作可能产生临时信封；它不是可恢复的持久会话。
      event = { ...event, session: run.session ?? '', data: { ...event.data, active: run.session ?? '' } }
    } else if (run.session === null && event.session !== '' && store.hasSession(event.session)) {
      run.session = event.session
    }
    syncTarget(executor)
    bindEnvironment(executor, run.session)

    if (run.session !== previousSession) saveRuns(true)

    switch (event.kind) {
      case 'agent.state':
        run.busy = event.data.state !== 'waiting'
        if (!run.busy && stopContent.get(run)?.stop !== undefined) queueMicrotask(() => { void notifyStop(run, stopContent.get(run)!.stop!).catch(error => options.log?.(String(error))) })
        break
      case 'turn.start':
        stopContent.set(run, {})
        if (run.session !== null) clearTurnNotice(run.session)
        stopGenerations.set(run, nextStopGeneration++)
        run.turnActive = true
        // 新的一轮开始 ⇒ 上一轮那些「已答复」的记账清掉（它们只在本轮之内管用）
        run.resolvedDecisions.clear()
        break
      case 'message.assistant':
        stopContent.set(run, { ...stopContent.get(run), entry: event.data.entry })
        break
      case 'error':
        stopContent.set(run, { ...stopContent.get(run), event: event.id, error: event.data.message })
        break
      case 'model.error':
        if (event.data.tier !== 'transient') stopContent.set(run, { ...stopContent.get(run), event: event.id, error: event.data.message })
        break
      case 'turn.end':
        stopContent.set(run, { ...stopContent.get(run), stop: event })
        run.turnActive = false
        run.lastTurn = event.data.reason
        run.lastTurnAt = event.at
        // **轮收束 ⇒ 悬着的裁决作废**——与执行者那一侧同一条口径（`executor.ts`）：
        // 卡挂着的时候这一轮没结束，故那条「等你」照旧成立。
        run.decisions.clear()

        if (run.session !== null) {
          const current = store.attention.list({ sessions: [workRoot(run.session)] })[0]
          // 同一停点重放保留已读与送达事实；新一轮仍由 turn.start 清除旧原因。
          if (current?.source?.session !== event.session || current.fact !== String(event.id)) clearTurnNotice(run.session)
          if (!event.data.continues && (event.data.reason === 'settled' || event.data.reason === 'error')) queueMicrotask(() => { void notifyStop(run, event).catch(error => options.log?.(`当前原因读取失败：${String(error)}`)) })
        }
        break
      case 'tool.decision.request':
        run.decisions.set(event.id, event.data.call)
        if (run.session !== null) notify(run.session, 'needs-you', event.id, event.data.material || event.data.name, { session: run.session, event: event.id }, event.at)
        break
      case 'tool.decision': {
        if (run.session !== null) {
          const current = store.attention.list({ sessions: [workRoot(run.session)] })[0]
          if (current?.source?.session === run.session && run.decisions.get(current.source.event ?? -1) === event.data.call) store.attention.clear(workRoot(run.session))
        }
        // 答复落地——请求那一条从「挂着」挪到「已处理」（晚到的答复据此被认出来）
        for (const [id, call] of run.decisions) {
          if (call === event.data.call) {
            run.decisions.delete(id)
            run.resolvedDecisions.add(id)
          }
        }
        break
      }
      case 'tool.output.delta':
        run.output = { at, sample: tailOf(run.output?.sample, event.data.text) }
        break
      default:
        break
    }

    const action = actionOf(event)
    if (action !== undefined) run.action = action ?? undefined

    if (isProgress(event)) {
      const what = progressOf(event)
      if (what !== undefined) run.progress = { at, what }
    }

    refresh(run, at)

    connections.publish(executor, event)

    if (event.kind === 'tool.decision.request') collaborationDecisions.set(event.id, event)
    if (event.kind === 'tool.decision') for (const [id, pending] of collaborationDecisions) {
      if (pending.session === event.session && pending.data.call === event.data.call) collaborationDecisions.delete(id)
    }
    if (event.kind === 'turn.end') for (const [id, pending] of collaborationDecisions) {
      if (pending.session === event.session) collaborationDecisions.delete(id)
    }

    const shared = event.session === undefined ? undefined : store.collaboration.collaborationForSession(event.session)
    if (shared !== undefined && (event.kind === 'tool.decision.request' || event.kind === 'tool.decision')) {
      for (const conn of clients.values()) {
        if (conn.target === executor) continue
        if ((conn.selectedSession) === shared.originSessionId) conn.link.send({ t: 'ev', gen: conn.target?.gen ?? null, event })
      }
    }
    if (shared !== undefined && event.kind === 'turn.end' && event.data.reason === 'settled' && !event.data.continues) {
      void collaboration.settled(event.session!, event.turn).catch(error => options.log?.(`咨询回报尚未核实：${String(error)}`))
    }
    if (shared !== undefined && ((event.kind === 'turn.end' && event.data.reason === 'error') || event.kind === 'error')) {
      void collaboration.failed(event.session!, event.kind === 'error' ? event.data.message : '成员本轮执行失败，需要核对停点').catch(error => options.log?.(`失败回报尚未核实：${String(error)}`))
    }
    if (shared !== undefined && ['agent.state', 'turn.start', 'turn.end', 'tool.decision.request', 'tool.decision', 'message.assistant', 'message.user', 'model.usage'].includes(event.kind)) {
      collaboration.changed()
      if (event.kind === 'agent.state' && event.data.state === 'waiting') {
        void collaboration.idle(shared.originSessionId).then(closed => {
          if (closed) void notifyStop(run, event)
        }).catch(error => options.log?.(`协作收尾尚未核实：${String(error)}`))
      }
    }

    saveRuns()
    pushRuns()
  }

  function retire(executor: Executor, reason: string): void {
    if (executor.run.ended !== undefined) return
    for (const [key, owner] of collaborationInputs) if (owner.target === executor.run.session) {
      collaborationInputs.delete(key)
      owner.conn.link.send({
        t: 'ev', gen: owner.conn.target?.gen ?? null, event: {
          kind: 'input.settled', data: { ok: false, ...(owner.ref === undefined ? {} : { ref: owner.ref }), reason: '输入目标已退出，未确认接收；原稿保留' },
          session: owner.session, id: store.serviceFor(owner.session).nextId(), at: now(), turn: null,
        }
      })
    }
    control.retire(executor, reason)

    const at = now()
    const kind = executor.run.stopping
      ? // **收摊那一刻这一轮还开着**也算被打断（U50）：收尾那两跳可能抢在
      // `turn.end` 前面，光看 `lastTurn` 会把一次真停读成「当前空闲」
      endKindOf(executor.run.lastTurn, executor.run.turnActive)
      : executor.run.lastTurn === 'aborted'
        ? ('aborted' as const)
        : ('crashed' as const)

    executor.run.ended = { at, why: reason, kind }
    executor.run.reclaimPending = executor.run.owned.length > 0
    executor.run.connected = false
    executor.run.busy = false
    executor.run.turnActive = false
    executor.run.decisions.clear()
    executor.run.action = undefined
    refresh(executor.run, at)

    executors.delete(executor)
    executor.queued = []

    // **留一条「最近一次运行」**——列表上「当前/最近状态」那一格要它
    lastRuns.set(executor.run.session ?? executor.executionId, executor.run)

    connections.detach(executor, reason)
    executor.link.close()

    options.log?.(`核销第 ${executor.gen} 代执行者（${reason}）`)
    saveRuns()

    pushRuns(true)

    if (executor.run.ended?.kind === 'crashed' && executor.run.session !== null) {
      notify(
        executor.run.session,
        'failed',
        `${executor.gen}@${executor.run.ended.at}`,
        `异常退出：${reason}`,
      )
    }

    afterEnd(executor.run)
  }

  function afterEnd(run: RunRecord): void {
    releaseEnvironments()
    void reclaimRun(run).then((note) => { releaseEnvironments(); settleStop(run, note) })
  }

  /** 核对工具归属与可释放环境，刷新投影；静默不代表执行结束。 */
  const probe = setInterval(() => {
    for (const executor of executors) executor.ledger.list()
    releaseEnvironments()
    pushRuns()
  }, probeIntervalMs)
  probe.unref?.()

  let shutdownInFlight: Promise<void> | undefined
  let admissionClosed = false
  function stop(why: string): void {
    void beginStop(why).catch(error => {
      const reason = `未能确认全部工作已停止：${String(error)}`
      options.log?.(reason)
      diagnosticLog.write('error', 'manager.shutdown.failed', identity)
      options.onShutdownError?.(reason)
    })
  }
  function beginStop(why: string): Promise<void> {
    if (storeClosed) return Promise.resolve()
    if (shutdownInFlight !== undefined) return shutdownInFlight
    stopped = true
    clearInterval(probe)
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    native.changed()
    try {
      if (!admissionClosed) {
        collaboration.shutdown(why)
        options.lifecycle?.closeAdmission()
        admissionClosed = true
      }
    } catch (error) { return Promise.reject(error) }
    shutdownInFlight = shutdown(why).finally(() => { shutdownInFlight = undefined })
    return shutdownInFlight
  }

  async function shutdown(why: string): Promise<void> {
    const owned = [...executors]
    for (const executor of owned) {
      executor.run.stopping = true
      refresh(executor.run, now())
      executor.link.send({ t: 'bye', why })
    }
    saveRuns(true)
    // 扩展收尾与所属工具回收并行，扩展不能阻止目标 Agent 取消。
    const extension = Promise.resolve().then(() => options.lifecycle?.shutdown())
    let extensionTimer: ReturnType<typeof setTimeout> | undefined
    const extensionResult = Promise.race([
      extension.then(() => undefined, (error: unknown) => String(error)),
      new Promise<string>((resolve) => {
        extensionTimer = setTimeout(() => resolve('协作收尾尚未确认'), stopGraceMs + 2 * stopKillMs)
      }),
    ]).finally(() => { if (extensionTimer !== undefined) clearTimeout(extensionTimer) })
    await Promise.all(owned.map(executor => escalateStop(executor)))
    if (owned.some((one) => !one.exited && one.run.ended === undefined)) throw new Error('仍有执行资源未核销')
    await runStops.drainReclaims()
    for (const run of lastRuns.values()) {
      if (run.ended === undefined) {
        await reclaimStale(run)
      }
      if (run.owned.length > 0) await reclaimRun(run)
      if (run.reclaimNote !== undefined) throw new Error(run.reclaimNote)
      settleStop(run)
    }
    const extensionError = await extensionResult
    if (extensionError !== undefined) throw new Error(extensionError)
    await Promise.all([...environments.values()].map(network => network.close()))
    await Promise.all([...closingEnvironments])
    environments.clear()
    if (saveTimer !== undefined) clearTimeout(saveTimer)
    saveRuns(true)
    // 关闭连接后由客户端呈现断线状态，保留其草稿与重连入口。
    connections.close()
    await closeConfigWatch()
    native.close()
    server.stop(true)
    clearRecord(paths)
    storeClosed = true
    store.close()
    options.log?.(`管理者收摊（${why}）`)
    diagnosticLog.write('info', 'manager.stopped', identity)
    await diagnosticLog.close()
    await options.beforeExit?.()
    settle()
  }

  await recovering
  await Promise.all([...lastRuns.values()].map(async run => {
    if (run.ended === undefined) return
    const note = run.owned.length > 0 ? await reclaimRun(run) : undefined
    settleStop(run, note)
  }))
  available = true
  options.log?.(`管理者就位 pid=${manager.record.pid} socket=${paths.socket}`)
  return manager
}

/** 那条路径上有人 listen 吗——**用「连得上」判**（比 `stat` 准：尸首也 `stat` 得到）。 */
async function someoneListens(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false

  try {
    const socket = await Bun.connect({ unix: socketPath, socket: socketHandlers() })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** 清掉路径上的尸首——**只在连也连不上时调**（判据在调用方，见 `startManager` 的注）。 */
function clearStale(socketPath: string): void {
  try {
    unlinkSync(socketPath)
  } catch {
    // 别人抢先清了 / 路径本来就没了：两种都等于「已经干净了」
  }
}

/** 自报身份那一份读得回来就读（读不懂＝没有——**它不是权威状态**，坏了不该拦住启动）。 */
export function readRecord(paths: RunPaths): ManagerRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.record, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Partial<ManagerRecord>
    if (typeof record.pid !== 'number' || typeof record.socket !== 'string') return undefined
    return record as ManagerRecord
  } catch {
    return undefined
  }
}

function writeRecord(paths: RunPaths, record: ManagerRecord): void {
  try {
    writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // 写不下去只影响诊断（谁在管、什么时候起的）——它为这个把管理者拦下来说不过去
  }
}

function clearRecord(paths: RunPaths): void {
  try {
    unlinkSync(paths.record)
  } catch {
    // 同上
  }
}

/** 持久工具归属；存在但格式无效时拒绝启动，不能把未读懂的责任当作不存在。 */
export function readRuns(paths: RunPaths): readonly StoredRun[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.runs, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new Error(`运行归属记录不可读：${paths.runs}`, { cause: error })
  }

  if (typeof parsed !== 'object' || parsed === null) throw new Error('运行归属记录形状无效')
  const runs = (parsed as Partial<StoredRuns>).runs
  if (!Array.isArray(runs)) throw new Error('运行归属记录缺少 runs')

  const kept: StoredRun[] = []
  for (const one of runs) {
    if (typeof one !== 'object' || one === null) throw new Error('运行归属条目无效')
    const run = one as Partial<StoredRun>
    if (run.session !== null && (typeof run.session !== 'string' || run.session === '')) throw new Error('运行归属缺少会话身份')
    if (typeof run.gen !== 'number' || typeof run.startedAt !== 'number') throw new Error('运行归属代次无效')
    if (!Array.isArray(run.workspace) || !run.workspace.every(root => typeof root === 'string')) throw new Error('运行归属工作区无效')

    const owned = ownedOf(run.owned)
    kept.push({
      session: run.session,
      gen: run.gen,
      ...(typeof run.executionId === 'string' ? { executionId: run.executionId } : {}),
      startedAt: run.startedAt,
      workspace: run.workspace,
      state: run.state ?? 'idle',
      since: typeof run.since === 'number' ? run.since : run.startedAt,
      ...(run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn }),
      ...(typeof run.why === 'string' ? { why: run.why } : {}),
      ...(run.kind === undefined ? {} : { kind: run.kind }),
      ...(owned === undefined ? {} : { owned }),
    })
  }
  return kept
}

/**
 * 读上一次留下的那份**未读事项**——**读不懂＝没有**（同 `runs.json` 那条口径）。
 *
 * 一条一条校验（`noticeOf`）：坏一条丢一条，其余照收——它是便条，不是权威状态。
 */
function ownedOf(raw: unknown): readonly OwnedProcess[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new Error('工具归属账无效')

  const kept: OwnedProcess[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) throw new Error('工具归属条目无效')
    const group = one as Partial<OwnedProcess>
    if (typeof group.pgid !== 'number' || !Number.isInteger(group.pgid) || group.pgid <= 0) throw new Error('工具归属进程组无效')
    if (typeof group.what !== 'string') throw new Error('工具归属名称无效')
    // `kind` 是三位里的一个——**认不出的整条丢**（拿不准的那一组不当数：它的用途是
    // 「这条会话还有没有后台命令在跑」，猜一个只会让那句实话变成假话）
    if (group.kind !== 'exec' && group.kind !== 'background' && group.kind !== 'mcp') throw new Error('工具归属种类无效')
    kept.push({
      pgid: group.pgid,
      startedAt: typeof group.startedAt === 'number' ? group.startedAt : undefined,
      kind: group.kind,
      what: group.what,
    })
  }

  return kept.length === 0 ? undefined : kept
}

export function writeRuns(paths: RunPaths, runs: readonly StoredRun[], at: number): void {
  const body: StoredRuns = { v: RUNS_VERSION, at, runs }
  const temp = `${paths.runs}.tmp-${process.pid}`
  try {
    writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(temp, paths.runs)
  } catch (error) {
    try { unlinkSync(temp) } catch { }
    throw new Error(`运行归属登记失败：${String(error)}`)
  }
}
