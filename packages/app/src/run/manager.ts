/**
 * **本机执行管理者**（U48）——一摊运行里**唯一**的那一个。
 *
 * 设计（会话与运行管理 · 本机执行结构）：
 *
 * > **管理者**：同一用户、同一规范化 dataDir 只有一个。启动以操作系统独占锁判归属，
 * > 本机 socket 限该用户访问；启动竞争的一方连接已有实例，不另起管理者。保存执行身份、
 * > 绑定关系、连接和子进程句柄，**不复制**对话、计划笔记与审批事实。
 *
 * ## 唯一性凭什么成立
 *
 * **靠 `bind` 那条路径**——Unix socket 的路径在一个时刻**只允许一个持有者**，这是内核
 * 给的（实测：第二次 `Bun.listen` 同一条路径当场抛）。故这里不另造一把锁文件：
 * 锁文件要自己处理残骸（谁死了、残骸什么时候能删、删的时候另一个人会不会刚好在拿），
 * 而 socket 路径**自带**这套语义——持有人在，`listen` 就失败；持有人没了，
 * 路径上那个尸首由**下一个**想当管理者的人清掉（且只在「连也连不上」时才清）。
 *
 * 三步走（启动竞争的全过程）：
 * 1. `listen` 成了 ⇒ **我是管理者**；
 * 2. 没成 ⇒ `connect` 那条既有实例——**连接它，不另起**；
 * 3. 连也连不上 ⇒ 那是**上一次没收拾干净的尸首**（进程被 SIGKILL 之后 socket 文件还在，
 *    但没人 listen）⇒ 清掉它，重试第 1 步（有界）。
 *
 * ⚠️ **第 3 步只在第 2 步失败时走**。反过来的话，两个进程同时启动时会各自清掉对方
 * 刚拿到的 socket——那就成了「谁跑得快谁说了算」，唯一性当场不成立。
 *
 * ## 它保存什么、不保存什么
 *
 * 保存：**执行身份、绑定关系、连接与子进程句柄**——也就是「谁在跑、跑到第几代、
 * 哪条连接还挂着」这一层事实。
 *
 * **不复制**对话、计划笔记与审批事实：那些归记录域（`records.db`），管理者只**读**
 * 它答「有哪几条会话」这类问题，不另存一份。这一条是设计的明文，也是「管理者不是
 * 第二个数据库」那条边界的落点。
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'bun'
import { ensureRunDir, tightenSocket } from './paths.ts'
import type { RunPaths } from './paths.ts'
import { linkOf, socketHandlers } from './wire.ts'
import type { ClientToManager, ExecutorToManager, Link, ManagerToClient } from './wire.ts'

/**
 * 管理者这一端**可能收到的那一族**——一条连接上说的是客户端的话还是执行者的话，
 * 由它那条 `hello` 说定（见 `attachClient`）。两族的并在这里收成一个类型：
 * `t: 'cmd'` 只有客户端会发、`t: 'bound'` 只有执行者会发，判别收窄照旧成立。
 */
type Inbound = ClientToManager | ExecutorToManager

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
type ClientConn = {
  readonly id: number
  readonly link: Link<Inbound>
  /** 它认的执行者代次（`null` ＝ 还没认过任何一代）。 */
  gen: number | null
  readonly label: string | undefined
}

export type ManagerOptions = {
  /** 这一摊运行的三条路径（`runPathsOf` 算出来的）。 */
  readonly paths: RunPaths
  /** 数据目录的规范形——写进自报的那一份里。 */
  readonly dataDir: string
  /** 起执行者的方式——见 `ExecutorLauncher`。 */
  readonly launch: ExecutorLauncher
  /** 时钟——缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined
  /** 诊断 —— 缺省不打印（**这条线上不写业务日志**，日志归宿主进程的收尾那一跳）。 */
  readonly log?: ((line: string) => void) | undefined
}

/**
 * 起一个执行者。
 *
 * 收成端口是为了**用例能把真进程换成进程内的假执行者**：多进程的用例贵在「真的分了
 * 进程」（那是要证的东西），而路由、代次、收缩这些**不该每条用例都拖一个真进程**。
 * 两者都实现同一个 `ExecutorLauncher`，管理者这一层看不见差别。
 */
export type ExecutorLauncher = {
  /**
   * 开一个执行者。
   *
   * @param request 发给执行者的第一条**命令**（`input.submit` / `session.open` 那条路）
   * 与它的开工参数。
   */
  launch(request: ExecutorRequest): ExecutorHandle
}

/** 开一个执行者时给它的那几件——「哪一代、哪条会话、在哪个工作区」。 */
export type ExecutorRequest = {
  /** 代次——管理者发的号（同一条会话换一个执行者就换一代）。 */
  readonly gen: number
  /** 开工那条会话（显式接续时就有）；`null` ＝ 让它自己开张（D5）。 */
  readonly session: string | null
  /**
   * **工作区整组根**——缺省由执行者按配置现算（与今天的 `assemble` 同一条路）。
   * 显式接续时管理者不预先读记录域里的归属：那条会话的执行根由**执行者**装载之后
   * 才认得出（记录域里那一列），在这一层猜一个只会多一处真源。
   */
  readonly workspace?: readonly string[] | undefined
}

/** 一个跑着的执行者的把手——管理者侧那一半。 */
export type ExecutorHandle = {
  /** 收管理者来的话（命令 / ping / bye）。 */
  onMessage(listener: (message: ExecutorToManagerView) => void): void
  /** 断开时告知（**只报一次**）——「自有子进程退出与 IPC 断开」两路都汇到这儿。 */
  onExit(listener: (error?: Error) => void): void
  /** 送一句话给执行者；它没了返回 `false`。 */
  send(message: ManagerToExecutorView): boolean
  /** 让它收摊（先礼后兵由实现决定——管理者只说「退」）。 */
  stop(): void
  /** 进程号——**仅作诊断**（用户按会话 / 工作操作，不按 PID）。 */
  readonly pid: number | undefined
}

/** 执行者能发上来的那几件（`wire.ts` 的那一族，这里只取管理者关心的几支）。 */
export type ExecutorToManagerView =
  | { readonly t: 'hello'; readonly role: 'executor'; readonly session: string | null; readonly workspace: readonly string[] }
  | { readonly t: 'bound'; readonly session: string }
  | { readonly t: 'ev'; readonly event: import('@magic/contracts').KernelEvent }
  | { readonly t: 'pong'; readonly seq: number }
  | { readonly t: 'done'; readonly why: string }

/** 管理者能发给执行者的那几件。 */
export type ManagerToExecutorView =
  | { readonly t: 'cmd'; readonly cmd: import('@magic/contracts').Command }
  | { readonly t: 'ping'; readonly seq: number }
  | { readonly t: 'bye'; readonly why: string }

/**
 * 一个立起来的管理者。
 *
 * 三个读数给**诊断与验收装置**（客户端自己看不到这些——它只需要 `ControlTransport`）：
 * 有几条连接挂着、起了几个执行者、各是哪一代。
 */
export type Manager = {
  readonly record: ManagerRecord
  readonly socketPath: string
  /** 挂着的客户端连接数。 */
  clients(): number
  /** 这一摊里活着的执行者（按会话归）。 */
  executors(): readonly { readonly session: string | null; readonly gen: number }[]
  /** 显式收摊（收缩那条路与用例的收尾都走它）。 */
  stop(why: string): void
  /** 等它真退干净（socket 摘掉、连接关光）。 */
  waitUntilExit(): Promise<void>
}

export type StartResult =
  | { readonly role: 'manager'; readonly manager: Manager }
  /** 已经有一个管理者了——**连接它，不另起**。 */
  | { readonly role: 'existing'; readonly record: ManagerRecord | undefined }
  | { readonly role: 'failed'; readonly reason: string }

/** 重试次数——「尸首清掉再 bind」那一步；给三次是因为它只该有一次成功或彻底失败。 */
const BIND_ATTEMPTS = 3

/**
 * **立一个管理者，或者认出已经有的那一个**。
 *
 * 返回 `existing` 时调用方该去 `connectManager`（见 `client.ts`）——本函数**不替它连**：
 * 「谁是管理者」与「客户端怎么用这条连接」是两件事，混在一起会让用例没法只验前一件。
 */
export async function startManager(options: ManagerOptions): Promise<StartResult> {
  const { paths } = options
  const now = options.now ?? Date.now

  ensureRunDir(paths.dir)

  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const bound = bindManager(options, now)
    if (bound !== undefined) return { role: 'manager', manager: bound }

    // bind 没成——**先问「是不是有人在」**，问到就连接它，一句都不清
    if (await someoneListens(paths.socket)) {
      return { role: 'existing', record: readRecord(paths) }
    }

    // 连也连不上 ⇒ 路径上是上一次的尸首。**清掉它**，下一轮重新 bind。
    // 清之前再确认一次「真的没人 listen」——这一步与上面那次探测之间有一瞬，
    // 而那一瞬里另一个进程可能刚好 bind 上（探测与清理不能合成一次原子动作，
    // 故宁可多探一次；探测失败的方向是**保守**的：连不上才清）。
    if (!(await someoneListens(paths.socket))) clearStale(paths.socket)
  }

  return { role: 'failed', reason: `连着 ${BIND_ATTEMPTS} 次都没能占住 ${paths.socket}` }
}

/** bind 成了就返回一个立好的管理者；没成返回 `undefined`（判归属的那三步在调用方）。 */
function bindManager(options: ManagerOptions, now: () => number): Manager | undefined {
  const { paths } = options
  const clients = new Map<number, ClientConn>()
  let nextConn = 1
  let stopped = false
  let settle: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })

  let server: ReturnType<typeof Bun.listen>
  try {
    server = Bun.listen({
      unix: paths.socket,
      socket: socketHandlers((socket) => {
        // 接进来的一条连接：先包成 `Link`，**回话是等它的 `hello` 之后**——
        // 「谁在说话」由 `hello` 说，管理者不按「谁先连上」猜。
        const conn: ClientConn = {
          id: nextConn,
          link: linkOf<Inbound>(socket as Socket<unknown>),
          gen: null,
          label: undefined,
        }
        nextConn += 1
        clients.set(conn.id, conn)
        attachClient(options, clients, conn)
      }),
    })
  } catch {
    return undefined
  }

  tightenSocket(paths.socket)

  const record: ManagerRecord = {
    pid: process.pid,
    at: now(),
    dataDir: options.dataDir,
    socket: paths.socket,
    v: RECORD_VERSION,
  }
  writeRecord(paths, record)

  const manager: Manager = {
    record,
    socketPath: paths.socket,
    clients: () => clients.size,
    // 执行者表在下一段接上（U48 第二段「执行者拆出去并登记」）——这一处先如实报空
    executors: () => [],
    stop(why) {
      if (stopped) return
      stopped = true

      for (const conn of [...clients.values()]) {
        conn.link.send({ t: 'line', text: `管理者收摊：${why}` })
        conn.link.close()
      }
      clients.clear()

      try {
        server.stop(true)
      } catch {
        // 已经停了
      }
      clearRecord(paths)
      options.log?.(`管理者收摊（${why}）`)
      settle()
    },
    waitUntilExit: () => exited,
  }

  options.log?.(`管理者就位 pid=${record.pid} socket=${paths.socket}`)
  return manager
}

/** 处理一条客户端连接上的消息——`hello` 之后它才进 `clients`（见 `bindManager`）。 */
function attachClient(options: ManagerOptions, clients: Map<number, ClientConn>, conn: ClientConn): void {
  /** 这条连接说定自己是执行者了吗——执行者那几支只在这条路上受理（见 `wire.ts` 的方向表）。 */
  let executor = false

  conn.link.onMessage((message) => {
    switch (message.t) {
      case 'hello': {
        if (message.role === 'executor') {
          executor = true
          return
        }

        const greeted: ManagerToClient = {
          t: 'welcome',
          conn: conn.id,
          dataDir: options.dataDir,
        }
        conn.link.send(greeted)
        return
      }
      case 'cmd': {
        if (executor) return // 执行者不发命令
        conn.gen = message.gen
        // 路由在下一段接上（U48 第二段）——这一处**不静默吞**：客户端据 `line` 知道
        // 自己那句话没人接，而不是对着一个不动的屏发呆。
        conn.link.send({ t: 'line', text: '这条路还没接上（U48 第二段）' })
        return
      }
      case 'bye': {
        clients.delete(conn.id)
        conn.link.close()
        return
      }
      default:
        // 执行者那几支（`bound` / `done` / `pong`）在这一段还没接上——忽略；
        // 它们到 U48 第二段才有主，早于那一段不该在路上出现。
        return
    }
  })

  conn.link.onClose(() => {
    clients.delete(conn.id)
  })
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
