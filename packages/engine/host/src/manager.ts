import { NATIVE_PROTOCOL, PENDING_INPUT_LIMIT, SOFTWARE_VERSION, diagnosticsOf } from '@magic/contracts'
import type { McpCatalogRow, ServiceIdentity } from '@magic/contracts'
import { loadConfig, watchConfig } from '@magic/state'
import { createRecordsStore, prepareRecordsDir } from '@magic/data'
import { ARCHIVED_NOTE, reconcile, refresh, runRowOf } from '@magic/host'
import type { McpProbeRow, RunRecord, StoredRun, WorkEnvironment } from '@magic/host'
import type { Socket } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureRunDir, normalizeDataDir, tightenSocket } from './paths.ts'
import { DiagnosticLog } from './diagnostic-log.ts'
import { createClientConnections, type ClientConn } from './connections.ts'
import { createExecutorControl, sendToExecutor as send, type Executor } from './executor-control.ts'
import { createSessionManagement } from './session-management.ts'
import { createCompactController } from './compact.ts'
import { createManagedCollaboration } from './collaboration.ts'
import { captureCollaborationNative, mergeCollaborationNative } from './collaboration-native.ts'
import { createNativeServer } from './native-server.ts'
import { socketHandlers } from './wire.ts'
import { softwareSource } from './runtime-launch.ts'
import { RECORD_VERSION, clearStale, readRecord, readRuns, writeRecord, type ManagerRecord } from './run-store.ts'
import type { Manager, ManagerContext, ManagerOptions, StartResult } from './manager/context.ts'
import { installNotices } from './manager/notices.ts'
import { installProjection } from './manager/projection.ts'
import { installPlacement } from './manager/placement.ts'
import { installCommands } from './manager/commands.ts'
import { installLifecycle } from './manager/lifecycle.ts'

export type { Manager, ManagerOptions, StartResult } from './manager/context.ts'
export type { ExecutorLauncher, ExecutorSpawn, ExecutorSpawned } from './launch.ts'

/** 重试次数——「尸首清掉再 bind」那一步；给三次是因为它只该有一次成功或彻底失败。 */
const BIND_ATTEMPTS = 3

const PROBE_INTERVAL_MS = 5_000

const STOP_GRACE_MS = 8_000

/** 工具 TERM/KILL 回收各阶段的等待预算。 */
const STOP_KILL_MS = 3_000

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
  // T1.2 对账器时限（§附：心跳 5s < 假死 15s < 慢消费者 30s，无冲突）。
  const HEARTBEAT_TIMEOUT_MS = 15_000
  const RECONCILE_INTERVAL_MS = 1_000
  const WAKE_COOLDOWN_MS = 5_000

  // 共享上下文：可变状态与跨模块助手都挂在这一份对象上。
  const ctx = {} as ManagerContext
  ctx.options = options
  ctx.paths = paths
  ctx.now = now
  ctx.probeIntervalMs = probeIntervalMs
  ctx.stopGraceMs = stopGraceMs
  ctx.stopKillMs = stopKillMs

  const connections = createClientConnections(() => ctx.native.changed(), options.log, (executor) => {
    for (const [requestId, request] of ctx.sudoRequests) {
      if (request.executor !== executor) continue
      for (const conn of ctx.connections.watching(executor)) conn.link.send({ t: 'sudo.request', requestId, command: request.command })
    }
  })
  ctx.connections = connections
  const { clients } = connections

  const executors = new Set<Executor>()
  const lastRuns = new Map<string, RunRecord>()
  ctx.executors = executors
  ctx.lastRuns = lastRuns
  ctx.nextGen = 1
  ctx.available = false
  ctx.stopped = false
  ctx.storeClosed = false
  let settle: () => void = () => { }
  ctx.exited = new Promise<void>((resolve) => {
    settle = resolve
  })
  ctx.settle = () => settle()

  // 先独占控制端点，再打开唯一记录连接；并发入口不同时迁移 SQLite。
  let server: ReturnType<typeof Bun.listen>
  try {
    server = Bun.listen({ unix: paths.socket, socket: socketHandlers(socket => ctx.accept(socket as Socket<unknown>)) })
  } catch { return undefined }
  ctx.server = server
  let store: ReturnType<typeof createRecordsStore>
  let savedRuns: readonly StoredRun[]
  let initialConfig: ReturnType<typeof loadConfig>
  try {
    // 先让数据服务引导旧库（备份移走并建新库），再读运行登记与配置。
    // 引导只 engine 启动做一次；执行者与其它连接一律零锁直连（createRecordsStore）。
    prepareRecordsDir(options.magic.base)
    store = createRecordsStore({ dataDir: options.magic.base, workspace: [], busyTimeoutMs: 5_000 })
    savedRuns = readRuns(paths)
    initialConfig = loadConfig({ magic: options.magic })
  } catch (error) {
    server.stop(true)
    clearStale(paths.socket)
    throw new Error(`记录库不可用：${String(error)}`)
  }
  ctx.store = store

  tightenSocket(paths.socket)

  const identity: ServiceIdentity = {
    protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION, source: softwareSource(),
    serviceInstance: crypto.randomUUID(), base: options.magic.base,
  }
  ctx.identity = identity
  const diagnosticLog = new DiagnosticLog('manager', options.magic.base, diagnosticsOf(initialConfig.config).logLevel)
  diagnosticLog.write('info', 'manager.started', identity)
  ctx.diagnosticLog = diagnosticLog
  const record: ManagerRecord = {
    pid: process.pid,
    at: now(),
    dataDir: normalizeDataDir(options.magic.base),
    socket: paths.socket,
    v: RECORD_VERSION,
  }
  ctx.record = record
  writeRecord(paths, record)

  // 旧 Agent 已随 Engine 退出，持久工具责任在开放准入前逐项核对。
  for (const stored of savedRuns) {
    const run = reconcile(stored, now())
    lastRuns.set(run.session ?? run.executionId!, run)

    if (run.ended !== undefined && run.owned.length > 0) {
      run.reclaimPending = true
      refresh(run, now())
      // afterEnd 在初始化完成后统一接续该代核销。
    }
  }

  // 尚无工作环境时只列配置；连接与归属登记在工作装配时完成。
  const mcpCatalog: readonly McpCatalogRow[] = Object.entries(options.mcp ?? {}).map(([server, config]) => ({
    server, transport: 'url' in config ? 'http' : 'stdio', state: { status: 'idle' }, tools: [], rejected: [],
  }))
  const probed: readonly McpProbeRow[] = mcpCatalog.map(row => ({ server: row.server, state: row.state, rejected: 0 }))
  ctx.mcpCatalog = mcpCatalog
  ctx.probed = probed

  const environments = new Map<string, WorkEnvironment>()
  const closingEnvironments = new Set<Promise<void>>()
  ctx.environments = environments
  ctx.closingEnvironments = closingEnvironments

  const stopReports = new Map<number, (phase: import('@magic/contracts').StopPhase, note?: string) => void>()
  ctx.stopReports = stopReports
  ctx.nextStopRequest = -1
  ctx.nextStopGeneration = 1
  ctx.stopGenerations = new WeakMap()
  ctx.collaborationStopVersions = new Map()
  ctx.stopContent = new WeakMap()
  ctx.settledRuns = new WeakSet()
  ctx.shutdownInFlight = undefined
  ctx.admissionClosed = false

  const collaborationInputs = new Map<string, { conn: ClientConn; session: string; target: string; ref?: string }>()
  /**
   * 在途 sudo 认证（U129）——`requestId → 发起它的执行者`。
   *
   * 密码不在这里留：`sudo.answer` 一进来就原样转给执行者，表里删掉这一条。
   */
  const sudoRequests = new Map<string, { readonly executor: Executor; readonly command: string }>()
  ctx.collaborationInputs = collaborationInputs
  ctx.sudoRequests = sudoRequests

  const sessions = createSessionManagement({
    store, now, liveOf: session => ctx.liveOf(session), lastRuns, accepting: () => !ctx.stopped,
    terminalOpen: session => ctx.terminalClients(session).length > 0,
    onArchived(session) {
      for (const executor of executors) {
        if (executor.run.session !== null && sessions.workRoot(executor.run.session) === session) ctx.stopContent.delete(executor.run)
      }
    },
    changed(data) {
      for (const conn of clients.values()) conn.link.send({
        t: 'ev', gen: null,
        event: { id: 0, at: now(), turn: null, session: data.session, kind: 'session.changed', data },
      })
      ctx.native.changed()
    },
  })
  ctx.sessions = sessions

  const compactions = createCompactController({
    store, now,
    publish: event => {
      for (const conn of clients.values()) if (conn.selectedSession === event.session) conn.link.send({ t: 'ev', gen: null, event })
    },
  })
  ctx.compactions = compactions

  const control = createExecutorControl(executor => {
    executor.run.stopping = true
    send(executor, { t: 'bye', why: '成员启动超时' })
    void ctx.runStops.escalateStop(executor)
  })
  ctx.control = control

  const collaboration = createManagedCollaboration({
    store, magic: options.magic, now, environment: session => ctx.environmentFor(session)?.env ?? {}, accepting: () => !ctx.stopped,
    start: agent => ctx.startMember(agent),
    wake: session => { if (sessions.isArchived(session)) return; const live = ctx.liveOf(session); if (live !== undefined) send(live, { t: 'collaboration.wake' }) },
    cancel: ids => ctx.cancelMembers(ids),
    input: (session, input, shared) => {
      const records = store.serviceFor(session)
      // **受理前移**（边界方案 §四#1/§五）：拒收与受理都是 engine 落账——帧只是加速信号。
      const durable = { ...input, ref: input.ref ?? crypto.randomUUID() }
      const work = store.collaboration.collaborationForSession(session)
      const rejectWith = (reason: string, kind: 'capacity' | 'closing' | 'archived'): never => {
        records.inputs.reject(durable, reason, now(), kind)
        const error = new Error(reason) as Error & { rejectedKind?: 'capacity' | 'closing' | 'archived' }
        error.rejectedKind = kind
        throw error
      }
      if (sessions.isArchived(session)) rejectWith(ARCHIVED_NOTE, 'archived')
      if (work?.state === 'closing' || work?.state === 'closed') rejectWith('工作收尾中，未受理新输入', 'closing')
      // 容量：每会话 pending 上限（PENDING_INPUT_LIMIT）——到限当场拒，原稿留输入位。
      if (records.inputs.list().filter(one => one.state === 'pending').length >= PENDING_INPUT_LIMIT) rejectWith('待办已满', 'capacity')
      // 受理即落账（事务性发件箱：受理事实持久存在；同 ref 幂等，执行者侧 enqueue 再
      // accept 不冲突）。落账后送达失败不再是受理失败——成员没起/失联时等它起来消费，
      // 对账器兜底（界面只说「已受理，重启后自动继续」，N25）。
      records.inputs.accept(durable, now())
      const live = ctx.liveOf(session)
      if (live === undefined || live.link.closed) return
      live.run.busy = true
      refresh(live.run, now())
      ctx.clearTurnNotice(session)
      ctx.stopGenerations.set(live.run, ctx.nextStopGeneration++)
      // 帧已退化为信号（正文在账上）；shared 位随信号走（消费侧据此走 publish 语义）。
      send(live, { t: 'collaboration.input', shared })
    },
    configure: async (session, model) => {
      const live = ctx.liveOf(session)
      if (live === undefined) return
      await control.configure(live, model)
    },
    runs: () => [...executors].map(e => runRowOf(e.run)),
    decisions: () => 0,
    changed: () => {
      ctx.releaseEnvironments()
      ctx.native.changed(); for (const conn of clients.values()) void ctx.publishCollaboration(conn)
      for (const executor of executors) { const session = executor.run.session; if (session !== null && !sessions.isArchived(session) && store.serviceFor(session).inputs.list().some(one => one.state === 'pending' && one.purpose === 'next')) send(executor, { t: 'collaboration.wake' }) }
    },
  })
  ctx.collaboration = collaboration
  const recovering = collaboration.recover()

  // —— 模块装配：共享上下文只此一份，模块按职责读写它 ——

  installProjection(ctx)
  installPlacement(ctx)
  installNotices(ctx)
  installLifecycle(ctx)
  installCommands(ctx)

  const runtime = {
    read: async () => {
      const current = [...executors].filter(executor => !executor.exited && !executor.run.stopping)
      await Promise.all(current.map(executor => control.settings(executor, undefined, true)))
      return {
        canChangeData: !(await ctx.nativeWorks()).some(work => work.affected) && executors.size === 0,
        mcp: current.flatMap(executor => executor.run.session === null ? [] : [{
          session: executor.run.session, gen: ctx.workStopGeneration(executor.run.session), servers: control.servers(executor) ?? [],
        }]),
      }
    },
    reconnect: async (session: string, gen: number, name: string) => {
      const executor = ctx.liveOf(session)
      if (executor === undefined || ctx.workStopGeneration(session) !== gen || executor.run.stopping) throw new Error('该工作已结束或换代，未重连')
      return control.settings(executor, name)
    },
  }
  ctx.runtime = runtime
  ctx.configuration = { stamp: null }

  const native = createNativeServer({
    configuration: () => ctx.configuration,
    evidencePaths: () => [join(options.magic.base, 'logs')],
    identity, store, accepting: () => !ctx.stopped, runtime,
    async engineStop(request, idleOnly) {
      // 核责任与关闭准入之间没有 await，新提交不能穿过实例切换。
      if (idleOnly) {
        const sessions = await store.listSessions()
        const groups = captureCollaborationNative(store.collaboration, sessions.map(session => session.id))
        if (executors.size > 0 || [...lastRuns.values()].some(run => run.owned.length > 0 || run.ended === undefined) || mergeCollaborationNative([], groups).some(work => work.affected)) throw new Error('仍有所属工作责任，不能切换基础路径')
      }
      const completion = ctx.beginStop('停止 Magic Engine')
      return (async () => {
        await options.engineState?.('stopping', request)
        try { await completion; await options.engineState?.('stopped', request) }
        catch (error) { await options.engineState?.('failed', request, String(error)); throw error }
      })()
    },
    record: (level, event, request) => diagnosticLog.write(level, event, { ...identity, request }),
    works: () => ctx.nativeWorks(),
    sessions: query => ctx.nativeSessions(query),
    manage: sessions.manageSession,
    async inspect(session) {
      if (!store.hasSession(session)) return undefined
      const root = sessions.workRoot(session)
      const summary = (await ctx.nativeSessions({ ids: [root], archived: sessions.isArchived(root) }))[0]
      if (summary === undefined) return undefined
      const notice = ctx.reconcileNotice(root)
      const run = ctx.liveOf(root)?.run ?? lastRuns.get(root)
      return {
        session: root, title: summary.title ?? '未命名工作', workspace: summary.workspace ?? [],
        archived: summary.archived, canArchive: summary.canArchive, terminalOpen: summary.terminalOpen,
        state: summary.state, since: run?.since ?? summary.at, gen: ctx.workStopGeneration(root),
        affected: !summary.archived && !summary.canArchive,
        ...(summary.reason === undefined ? {} : { reason: summary.reason }),
        ...(notice === undefined ? {} : { currentNotice: notice }),
      }
    },
    stop(session, gen, report) {
      if (ctx.workStopGeneration(session) !== gen) {
        report('unconfirmed', '目标已经结束或换代，请刷新当前状态')
        ctx.native.changed()
        return
      }
      const id = ctx.nextStopRequest--
      ctx.stopReports.set(id, (phase, note) => {
        report(phase, note)
        if (phase !== 'accepted') ctx.stopReports.delete(id)
      })
      ctx.stopRun({ id }, session, 'run')
    },
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  ctx.native = native

  ctx.closeConfigWatch = watchConfig(`${options.magic.base}/config.json`, () => loadConfig({ magic: options.magic }), async loaded => {
    const diagnostics = diagnosticsOf(loaded.config)
    diagnosticLog.setLevel(diagnostics.logLevel)
    const current = [...executors].filter(executor => !executor.exited && !executor.run.stopping)
    await Promise.all(current.map(async executor => {
      await control.settings(executor, undefined, false, diagnostics)
      await control.settings(executor)
    }))
    ctx.publishPreferences()
    ctx.configuration = { stamp: loaded.stamp ?? null }
    ctx.native.changed()
  }, error => {
    ctx.configuration = { ...ctx.configuration, error: String(error) }
    ctx.native.changed()
    diagnosticLog.write('error', 'configuration.apply.failed', identity)
    options.log?.(`配置采用失败：${String(error)}`)
  })

  ctx.manager = {
    identity,
    ready: async () => { },
    record,
    socketPath: paths.socket,
    clients: () => ctx.connections.clients.size,
    executors: () =>
      [...executors]
        .filter((one) => one.run.ended === undefined)
        .map((one) => ({ session: one.run.session, gen: one.gen })),
    runs: () => ctx.rows(),
    stop: why => ctx.stop(why),
    waitUntilExit: () => ctx.exited,
  }

  // 核对工具归属与可释放环境，刷新投影；静默不代表执行结束。
  const probe = setInterval(() => {
    for (const executor of executors) executor.ledger.list()
    ctx.releaseEnvironments()
    ctx.pushRuns()
  }, probeIntervalMs)
  probe.unref?.()
  ctx.probe = probe

  // **对账器**（T1.2 · 边界方案 §四#8/§五 N3/G5）：周期 1s，按执行者有界扫——
  // ① 该会话有 pending 待办而执行者空闲 → 补发消费信号（5s 冷却去抖；信号丢失的兜底）；
  // ② 有 executing 输入而心跳缺失超 15s（3 心跳）→ failed(执行中断/无进展)，failedFrom='executing'。
  // 判据是「心跳缺失 3 周期」不是「无事件」——长思考有心跳，不触发；lastSeenAt 缺省
  // （还没收到过任何心跳）不判死（保守，等第一个心跳）。
  const reconcileTimer = setInterval(() => {
    for (const executor of executors) {
      if (executor.run.ended !== undefined || !executor.run.ready) continue
      const session = executor.run.session
      if (session === null || sessions.isArchived(session)) continue
      const records = store.serviceFor(session)
      const executing = records.inputs.list().filter(one => one.state === 'executing')
      const lastSeen = executor.lastSeenAt
      if (executing.length > 0 && lastSeen !== undefined && now() - lastSeen > HEARTBEAT_TIMEOUT_MS) {
        for (const row of executing) records.inputs.fail(row.ref, '执行中断/无进展')
        ctx.saveRuns()
        ctx.pushRuns()
        continue
      }
      const hasPending = records.inputs.list().some(one => one.state === 'pending')
      const lastWake = executor.lastWakeAt
      if (hasPending && !executor.run.busy && (lastWake === undefined || now() - lastWake >= WAKE_COOLDOWN_MS)) {
        executor.lastWakeAt = now()
        send(executor, { t: 'collaboration.wake' })
      }
    }
  }, RECONCILE_INTERVAL_MS)
  reconcileTimer.unref?.()
  ctx.reconcileTimer = reconcileTimer

  await recovering
  await compactions.recover()
  await Promise.all([...lastRuns.values()].map(async run => {
    if (run.ended === undefined) return
    const note = run.owned.length > 0 ? await ctx.runStops.reclaimRun(run) : undefined
    ctx.runStops.settleStop(run, note)
  }))
  ctx.available = true
  options.log?.(`管理者就位 pid=${ctx.manager.record.pid} socket=${paths.socket}`)
  return ctx.manager
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
