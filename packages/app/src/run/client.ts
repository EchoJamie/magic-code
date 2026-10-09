import { normalizeDataDir } from './paths.ts'
/** 终端连接：核对 App 身份、缓存接入快照，转交真实消息；不创建会话或自动重开 App。 */
import type { Socket } from 'bun'
import type {
  ClientToManager, Command, KernelEvent, ModelSwitchRequest, RunNotice, RunRow,
  RunSnapshot, ServiceIdentity, SessionId, StopPhase, StopScope,
} from '@magic/contracts'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION } from '@magic/contracts'
import { softwareSource } from './runtime-launch.ts'
import { assertHostIdentity } from './host-discovery.ts'
import { linkOf, socketHandlers } from './wire.ts'
import type { Link, ManagerToClient, McpProbeRow } from './wire.ts'

export class ManagerRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'ManagerRefused'
  }
}

export type StopReport = {
  readonly session: SessionId
  readonly scope: StopScope
  readonly phase: StopPhase
  readonly note?: string
}

export type ManagerClient = {
  readonly conn: number
  readonly base: string
  readonly identity: ServiceIdentity
  readonly mcp: readonly McpProbeRow[]
  gen(): number | null
  runs(): readonly RunRow[]
  onRuns(listener: (rows: readonly RunRow[]) => void): void
  onResumed(listener: (gen: number, snapshot: RunSnapshot) => void): void
  onTarget(listener: (session: string | null) => void): void
  onDetached(listener: (why: string) => void): void
  onEvent(listener: (event: KernelEvent, gen: number | null) => void): void
  stop(session: SessionId, scope: StopScope): void
  onStopped(listener: (report: StopReport) => void): void
  readonly unread: readonly RunNotice[]
  onNotice(listener: (notice: RunNotice) => void): void
  onLine(listener: (text: string) => void): void
  onClose(listener: (error?: Error) => void): void
  send(command: Command): void
  /** 仅供实际呈现后的明确确认；握手、列表与摘要不调用。 */
  markRead(ids: readonly string[]): void
  close(): void
  readonly closed: boolean
}

export type ConnectOptions = {
  readonly openRequest?: string
  readonly expectedIdentity?: ServiceIdentity
  /** 只有明确工作接入才传；本层仍收窄白名单，不传播凭据。 */
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly session?: string | undefined
  readonly switch?: ModelSwitchRequest | undefined
  readonly allowAll?: boolean | undefined
  readonly cwd?: string | undefined
  readonly label?: string | undefined
  readonly timeoutMs?: number | undefined
}

const EXECUTION_ENV = [
  'PATH', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES',
  'LC_MONETARY', 'LC_NUMERIC', 'LC_TIME', 'LC_ADDRESS', 'LC_IDENTIFICATION',
  'LC_MEASUREMENT', 'LC_NAME', 'LC_PAPER', 'LC_TELEPHONE',
] as const

export function executionEnvironment(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {}
  for (const key of EXECUTION_ENV) if (env[key] !== undefined) selected[key] = env[key]
  return selected
}

/** 无监听端点返回 undefined；握手拒绝、身份不符和超时均具体报错，不能冒充离线重开 App。 */
export async function connectManager(socketPath: string, options: ConnectOptions = {}): Promise<ManagerClient | undefined> {
  let socket: Socket<unknown>
  try {
    socket = (await Bun.connect({ unix: socketPath, socket: socketHandlers() })) as Socket<unknown>
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ECONNREFUSED') return undefined
    throw new Error(`无法连接 Magic Code 服务 ${socketPath}：${error instanceof Error ? error.message : String(error)}`)
  }
  const link = linkOf<ManagerToClient>(socket)
  let gen: number | null = null
  let target: string | null | undefined
  let targetRevision = 0
  let runRows: readonly RunRow[] = []
  let runRevision = 0
  let closeError: Error | undefined
  let pendingEvents: { event: KernelEvent; gen: number | null }[] = []
  let eventsReady = false
  const eventListeners: ((event: KernelEvent, gen: number | null) => void)[] = []
  const targetListeners: ((session: string | null) => void)[] = []
  const runListeners: ((rows: readonly RunRow[]) => void)[] = []
  const resumedListeners: ((gen: number, snapshot: RunSnapshot) => void)[] = []
  const noticeListeners: ((notice: RunNotice) => void)[] = []
  const stoppedListeners: ((report: StopReport) => void)[] = []
  const detachedListeners: ((why: string) => void)[] = []
  let lateDetached: string | undefined
  const lineListeners: ((text: string) => void)[] = []
  let lateResumed: { gen: number; snapshot: RunSnapshot } | undefined

  // hello 前接收；welcome 前后到来的 session.state/history 都保留到 TUI 订阅。
  link.onMessage((message) => {
    switch (message.t) {
      case 'welcome': runRows = message.runs; runRevision += 1; return
      case 'runs':
        runRows = message.rows
        runRevision += 1
        for (const listener of [...runListeners]) listener(runRows)
        return
      case 'target':
        gen = message.gen
        target = message.session
        targetRevision += 1
        lateDetached = undefined
        if (lateResumed?.gen !== gen) lateResumed = undefined
        for (const listener of [...targetListeners]) listener(target)
        return
      case 'detached':
        gen = null
        lateResumed = undefined
        // 执行代次消失不等于所选 session 消失；不伪造 target/session。
        lateDetached = message.why
        for (const listener of [...detachedListeners]) listener(message.why)
        return
      case 'ev':
        if (!eventsReady) pendingEvents.push({ event: message.event, gen: message.gen })
        else for (const listener of [...eventListeners]) listener(message.event, message.gen)
        return
      case 'resumed':
        lateResumed = { gen: message.gen, snapshot: message.snapshot }
        for (const listener of [...resumedListeners]) listener(message.gen, message.snapshot)
        return
      case 'notice':
        for (const listener of [...noticeListeners]) listener(message.notice)
        return
      case 'stopped':
        for (const listener of [...stoppedListeners]) {
          listener({
            session: message.session,
            scope: message.scope,
            phase: message.phase,
            ...(message.note === undefined ? {} : { note: message.note }),
          })
        }
        return
      case 'line':
        for (const listener of [...lineListeners]) listener(message.text)
        return
    }
  })
  link.onClose((error) => { closeError = error })

  const expected = options.expectedIdentity ?? { source: softwareSource() }
  let welcome: Welcome
  try {
    welcome = await greet(link, {
      t: 'hello', role: 'client', protocol: NATIVE_PROTOCOL, version: SOFTWARE_VERSION,
      source: expected.source,
      cwd: options.cwd ?? process.cwd(),
      ...(options.openRequest === undefined ? {} : { openRequest: options.openRequest }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.switch === undefined ? {} : { switch: options.switch }),
      ...(options.allowAll === true ? { allowAll: true } : {}),
      ...(options.environment === undefined ? {} : { environment: executionEnvironment(options.environment) }),
    }, options.timeoutMs ?? 30_000)
    assertHostIdentity(welcome.identity, expected)
    if (normalizeDataDir(welcome.base) !== normalizeDataDir(welcome.identity.base)) throw new Error('Magic Code welcome 的数据目录与服务身份不一致')
    if (welcome.refuse !== undefined) throw new ManagerRefused(welcome.refuse)
  } catch (error) {
    link.close()
    throw error
  }

  return {
    conn: welcome.conn, base: welcome.base, identity: welcome.identity,
    mcp: welcome.mcp, unread: welcome.notices,
    gen: () => gen,
    runs: () => runRows,
    onRuns(listener) {
      runListeners.push(listener)
      const revision = runRevision
      queueMicrotask(() => { if (revision === runRevision) listener(runRows) })
    },
    onResumed(listener) {
      resumedListeners.push(listener)
      const snapshot = lateResumed
      if (snapshot !== undefined) queueMicrotask(() => {
        if (!link.closed && lateResumed === snapshot) listener(snapshot.gen, snapshot.snapshot)
      })
    },
    onTarget(listener) {
      targetListeners.push(listener)
      const revision = targetRevision
      queueMicrotask(() => {
        if (revision === targetRevision && target !== undefined) listener(target)
      })
    },
    onDetached(listener) {
      detachedListeners.push(listener)
      const why = lateDetached
      if (why !== undefined) queueMicrotask(() => {
        if (!link.closed && lateDetached === why) listener(why)
      })
    },
    onEvent(listener) {
      eventListeners.push(listener)
      if (eventListeners.length !== 1) return
      // createShell 的订阅位于构造中段；同步回放会碰到尚未初始化的历史重建函数。
      queueMicrotask(() => {
        eventsReady = true
        const queued = pendingEvents
        pendingEvents = []
        for (const value of queued) for (const receive of [...eventListeners]) receive(value.event, value.gen)
      })
    },
    onNotice: (listener) => { noticeListeners.push(listener) },
    onStopped: (listener) => { stoppedListeners.push(listener) },
    onLine: (listener) => { lineListeners.push(listener) },
    onClose: (listener) => { link.onClose((error) => listener(error ?? closeError)) },
    send: (cmd) => { link.send({ t: 'cmd', gen, cmd }) },
    stop: (session, scope) => { link.send({ t: 'stop', session, scope }) },
    markRead(ids) { if (ids.length > 0) link.send({ t: 'read', ids }) },
    close() {
      link.send({ t: 'bye', why: '窗口收摊' })
      link.close()
    },
    get closed() { return link.closed },
  }
}

type Welcome = Extract<ManagerToClient, { t: 'welcome' }>

function greet(
  link: Link<ManagerToClient>,
  hello: Extract<ClientToManager, { t: 'hello' }>,
  timeoutMs: number,
): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    let done = false
    let reason: string | undefined
    const finish = (value: Welcome | Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (value instanceof Error) reject(value)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new ManagerRefused(reason ?? `等待 Magic Code 握手超时（${timeoutMs}ms）`)), timeoutMs)
    link.onMessage((message) => {
      if (message.t === 'line') reason = message.text
      if (message.t === 'welcome') finish(message)
    })
    link.onClose((error) => finish(new ManagerRefused(reason ?? error?.message ?? 'Magic Code 在握手完成前关闭了连接')))
    link.send(hello)
  })
}
