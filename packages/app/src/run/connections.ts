import type { KernelEvent, ModelSwitchRequest, RunSnapshot } from '@magic/contracts'
import { sendToExecutor as send, type Executor } from './executor-control.ts'
import type { ClientToManager, Link } from './wire.ts'

/** 管理者只读连接事实；目标、订阅、历史读取水位由连接目录独占。 */
export type ClientConn = Readonly<{
  id: number
  link: Link<ClientToManager>
  cwd: string
  switch: ModelSwitchRequest | undefined
  allowAll: boolean | undefined
  environment: Readonly<Record<string, string>>
  collaborationMember: string | undefined
  target: Executor | undefined
  /** 执行者停止后仍保留用户正在查看的会话。 */
  selectedSession: string | null
}>

type ConnectionState = {
  -readonly [K in keyof ClientConn]: ClientConn[K]
} & {
  readRevision: number
  readingSession: string | null
  awaiting: number | null
  buffered: KernelEvent[]
}

/** 终端连接、执行代绑定与快照水位；断开连接不取消执行。 */
export function createClientConnections(changed: () => void, log?: (line: string) => void) {
  const clients = new Map<number, ConnectionState>()
  const snapshots = new WeakMap<Executor, { seq: number; asking: Map<number, number> }>()
  let nextConn = 1

  // 订阅由连接目标直接推导，不再在执行者上独立维护第二份成员集合。
  function watching(executor: Executor): readonly ClientConn[] {
    return [...clients.values()].filter(conn => conn.target === executor)
  }

  function releaseTarget(conn: ConnectionState): void {
    conn.target = undefined
    conn.awaiting = null
    conn.buffered = []
  }

  function dropClient(id: number): void {
    const conn = clients.get(id)
    if (conn === undefined) return
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
      if (conn.awaiting !== null) conn.buffered.push(event)
      else conn.link.send({ t: 'ev', gen: executor.gen, event })
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
    create(input: Pick<ClientConn, 'link' | 'cwd' | 'switch' | 'allowAll' | 'selectedSession'>): ClientConn {
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
