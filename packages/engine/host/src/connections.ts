import type { KernelEvent, ModelSwitchRequest, RunSnapshot } from '@magic/contracts'
import { sendToExecutor as send, type Executor } from './executor-control.ts'
import type { ClientToManager, Link } from '@magic/host'

/** 管理者只读连接事实；目标、订阅、历史读取水位由连接目录独占。 */
export type ClientConn = Readonly<{
  id: number
  link: Link<ClientToManager>
  cwd: string
  switch: ModelSwitchRequest | undefined
  environment: Readonly<Record<string, string>>
  collaborationMember: string | undefined
  target: Executor | undefined
  /** 执行者停止后仍保留用户正在查看的会话。 */
  selectedSession: string | null
  /**
   * **只读观察**（T1.6 · N5）：这条会话的执行器已被另一窗口占为写者——本连接明示
   * 「已在别处运行」，写类命令一律拒（不能静默变成旁观者，更不能双写）。
   */
  readonlyObserver?: true
  /** 连接自报的来源（hello 的 source）——占用方明示用（「占用方：终端 X / App」）。 */
  source?: string
}>

/** 等快照期间最多攒多少条事件——超过丢最旧（快照回来会按水位重建）。 */
const BUFFERED_EVENT_LIMIT = 500

type ConnectionState = {
  -readonly [K in keyof ClientConn]: ClientConn[K]
} & {
  readRevision: number
  readingSession: string | null
  awaiting: number | null
  buffered: KernelEvent[]
}

/** 终端连接、执行代绑定与快照水位；断开连接不取消执行。 */
export function createClientConnections(changed: () => void, log?: (line: string) => void, onBound?: (executor: Executor) => void) {
  const clients = new Map<number, ConnectionState>()
  const snapshots = new WeakMap<Executor, { seq: number; asking: Map<number, number> }>()
  let nextConn = 1

  // 订阅由连接目标直接推导，不再在执行者上独立维护第二份成员集合。
  function watching(executor: Executor): readonly ClientConn[] {
    return [...clients.values()].filter(conn => conn.target === executor)
  }

  function releaseTarget(conn: ConnectionState): void {
    // 写者离开时释放执行器写位（后来者 bind 接管为写者）。
    if (conn.target !== undefined && conn.target.writerConn === conn.id) conn.target.writerConn = undefined
    if (conn.target !== undefined) for (const other of clients.values()) {
      if (other.target === conn.target && other.readonlyObserver === true) other.readonlyObserver = undefined
    }
    conn.readonlyObserver = undefined
    conn.target = undefined
    conn.awaiting = null
    conn.buffered = []
  }

  function dropClient(id: number): void {
    const conn = clients.get(id)
    if (conn === undefined) return
    releaseTarget(conn)
    clients.delete(id)
    conn.awaiting = null
    conn.buffered = []
    conn.link.close()
    changed()
    // 最后一个看客走了也不取消执行；收缩由执行者按实际责任判断。
    log?.(`窗口 ${id} 断开（挂着的客户端 ${clients.size}）`)
  }

  function bind(client: ClientConn, executor: Executor): void {
    const conn = client as ConnectionState
    // **第二读者只读**（T1.6 · N5）：执行器的写位已被另一窗口占着——本连接绑定为只读
    // 观察，明示占用方；不静默变成旁观者，更不能双写。写位随写者断开释放（后来者接管）。
    if (executor.writerConn !== undefined && executor.writerConn !== client.id) {
      conn.readonlyObserver = true
      const occupant = clients.get(executor.writerConn)
      conn.link.send({
        t: 'line',
        text: `这条会话已在别处运行（占用方：${occupant?.source ?? `窗口 #${executor.writerConn}`}）——此处为只读浏览，发不出操作；要接管请先停掉那一处的运行`,
      })
    } else if (executor.writerConn === undefined) {
      executor.writerConn = client.id
      conn.readonlyObserver = undefined
    }
    conn.target = executor
    conn.selectedSession = executor.run.session
    changed()
    conn.link.send({ t: 'target', gen: executor.gen, session: executor.run.session })

    // 先登记订阅并缓冲，再请求快照，避免交接期间漏事件。
    const pending = snapshots.get(executor) ?? { seq: 0, asking: new Map<number, number>() }
    snapshots.set(executor, pending)
    const seq = ++pending.seq
    conn.awaiting = seq
    conn.buffered = []
    pending.asking.set(seq, conn.id)
    send(executor, { t: 'snapshot', seq })
    // 接回期间挂着的瞬时请求（sudo 认证）要能重放给新窗口——旧窗口可能已经走了。
    onBound?.(executor)
  }

  /** 同一代认领真实会话后同步窗口目标；不重新绑定或重置快照水位。 */
  function syncTarget(executor: Executor): void {
    const session = executor.run.session
    for (const conn of clients.values()) {
      if (conn.target !== executor || conn.selectedSession === session) continue
      conn.selectedSession = session
      changed()
      conn.link.send({ t: 'target', gen: executor.gen, session })
    }
  }

  function onSnapshot(executor: Executor, seq: number, snapshot: RunSnapshot): void {
    const asking = snapshots.get(executor)?.asking
    const connId = asking?.get(seq)
    asking?.delete(seq)
    if (connId === undefined) return
    const conn = clients.get(connId)
    if (conn === undefined || conn.awaiting !== seq) return

    conn.awaiting = null
    conn.link.send({ t: 'resumed', gen: executor.gen, snapshot })
    const seen = new Set<number>()
    const rest: KernelEvent[] = []
    for (const event of conn.buffered.sort((left, right) => left.id - right.id)) {
      if (event.id <= snapshot.watermark || seen.has(event.id)) continue
      seen.add(event.id)
      rest.push(event)
    }
    conn.buffered = []
    for (const event of rest) conn.link.send({ t: 'ev', gen: executor.gen, event })
  }

  function publish(executor: Executor, event: KernelEvent): void {
    for (const conn of clients.values()) {
      if (conn.target !== executor) continue
      if (conn.awaiting !== null) {
        // 快照迟迟不回时，等快照的事件不能无限攒内存；丢最旧的，快照/重同步补。
        conn.buffered.push(event)
        if (conn.buffered.length > BUFFERED_EVENT_LIMIT) {
          conn.buffered.splice(0, conn.buffered.length - BUFFERED_EVENT_LIMIT)
        }
      } else conn.link.send({ t: 'ev', gen: executor.gen, event })
    }
  }

  function detach(executor: Executor, reason: string): void {
    snapshots.delete(executor)
    for (const conn of clients.values()) {
      if (conn.target !== executor) continue
      releaseTarget(conn)
      conn.link.send({ t: 'detached', why: reason })
      if (!executor.run.stopping) conn.link.send({ t: 'line', text: `它那一代执行者收摊了（${reason}）` })
    }
  }

  return {
    clients: clients as ReadonlyMap<number, ClientConn>,
    create(input: Pick<ClientConn, 'link' | 'cwd' | 'switch' | 'selectedSession' | 'source'>): ClientConn {
      const conn: ConnectionState = {
        ...input, id: nextConn++, environment: {}, collaborationMember: undefined,
        target: undefined, awaiting: null, buffered: [], readRevision: 0, readingSession: null,
      }
      return conn
    },
    accept(client: ClientConn): void {
      clients.set(client.id, client as ConnectionState)
    },
    dropClient, bind, syncTarget, onSnapshot, publish, detach, watching,
    updateEnvironment(client: ClientConn, environment: Readonly<Record<string, string>>): void {
      const conn = client as ConnectionState
      conn.environment = Object.freeze({ ...environment })
    },
    selectMember(client: ClientConn, member: string | undefined): void {
      const conn = client as ConnectionState
      conn.collaborationMember = member
    },
    /** 旧执行实例收尾期间保留所选会话，新输入由管理者持有。 */
    unbind(client: ClientConn): void {
      const conn = client as ConnectionState
      releaseTarget(conn)
    },
    selectSession(client: ClientConn, session: string | null): void {
      const conn = client as ConnectionState
      releaseTarget(conn)
      conn.selectedSession = session
      changed()
      if (session === null) {
        conn.readRevision += 1
        conn.readingSession = null
      }
      conn.link.send({ t: 'target', gen: null, session })
    },
    beginHistory(client: ClientConn, session: string): number | undefined {
      const conn = client as ConnectionState
      if (conn.readingSession === session) return undefined
      conn.readingSession = session
      return ++conn.readRevision
    },
    historyCurrent(client: ClientConn, revision: number): boolean {
      const conn = client as ConnectionState
      return !conn.link.closed && conn.readRevision === revision
    },
    finishHistory(client: ClientConn, revision: number): void {
      const conn = client as ConnectionState
      if (conn.readRevision === revision) conn.readingSession = null
    },
    close() {
      for (const conn of clients.values()) conn.link.close()
      clients.clear()
    },
  }
}
