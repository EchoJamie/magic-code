/**
 * **终端侧那一端的连接**（U48）——窗口经本机连接接入管理者。
 *
 * 这一层只做三件：**连上、说声我是谁、把话递来递去**。它**不认识任何域**，也不持有
 * 任何执行状态——「窗口只是展示入口」这条（设计 · 会话与运行管理）在这里是结构上的
 * 事实：本文件里一个字都没有「会话 / 运行 / 执行者」的概念，它只有一条连接与一个
 * **代次**（那个代次是机器要的：过期连接的命令一律拒绝，见 `manager.ts` 的 `onCommand`）。
 *
 * 转成外壳要的 `ControlTransport` 是**下一跳**的事（`./terminal.ts`）：那一跳要把
 * 「哪条事件属于我正看的那条会话」「失联怎么显示」这些加上去，而它们不属于
 * 「一条连接怎么说话」。
 *
 * ## 代次为什么由这一层自己记
 *
 * 「我认的是哪一代」不是调用方要操心的东西——它是**连接的状态**，由管理者告知
 * （`welcome` / `target` / `detached` 三条），也由这一层在每条命令上原样带上。
 * 让每个调用点自己记一个数，迟早有一处忘了更新——而那一处的症状是**命令被静默拒绝**。
 */

import type { Socket } from 'bun'
import type { Command, KernelEvent } from '@magic/contracts'
import { linkOf, socketHandlers } from './wire.ts'
import type { Link, ManagerToClient } from './wire.ts'

export type ManagerClient = {
  /** 管理者给的连接编号（诊断用）。 */
  readonly conn: number
  /** 这一摊运行的数据目录（管理者的自报）。 */
  readonly dataDir: string
  /** 我此刻认的执行者代次（`null` ＝ 还没有目标）。 */
  gen(): number | null
  /** 管理者指派的目标换了一条会话——外壳据以认「我现在在看哪条」（`null` ＝ 还没开张）。 */
  onTarget(listener: (session: string | null) => void): void
  /** 内核来的事件 ＋ 它的**执行者代次**。 */
  onEvent(listener: (event: KernelEvent, gen: number | null) => void): void
  /** 管理者**给人看**的话（代次过期、它要退了……）——外壳落成一行回执。 */
  onLine(listener: (text: string) => void): void
  /** 连接断了（**只报一次**）——「管理者不可达」那一路。 */
  onClose(listener: (error?: Error) => void): void
  /** 发一条命令（代次由这一层带上）。 */
  send(command: Command): void
  close(): void
  readonly closed: boolean
}

export type ConnectOptions = {
  /** 启动目录——管理者按它起执行者（工作区默认根的缺省）。缺省 `process.cwd()`。 */
  readonly cwd?: string | undefined
  /** 诊断用的标签（哪一类窗口）——缺省不给。 */
  readonly label?: string | undefined
  readonly timeoutMs?: number | undefined
}

/** 连上管理者——连不上（没人 listen / 路径是尸首）返回 `undefined`，不抛。 */
export async function connectManager(
  socketPath: string,
  options: ConnectOptions = {},
): Promise<ManagerClient | undefined> {
  let socket: Socket<unknown>
  try {
    socket = (await Bun.connect({
      unix: socketPath,
      socket: socketHandlers(),
    })) as Socket<unknown>
  } catch {
    return undefined
  }

  const link = linkOf<ManagerToClient>(socket)
  const greeted = await greet(
    link,
    {
      cwd: options.cwd ?? process.cwd(),
      ...(options.label === undefined ? {} : { label: options.label }),
    },
    options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  )
  if (greeted === undefined) {
    link.close()
    return undefined
  }

  /** 我认的执行者代次——由管理者那三条消息维护（见文件头注）。 */
  let gen: number | null = null
  const targetListeners: ((session: string | null) => void)[] = []
  const eventListeners: ((event: KernelEvent, gen: number | null) => void)[] = []
  const lineListeners: ((text: string) => void)[] = []

  link.onMessage((message) => {
    switch (message.t) {
      case 'target':
        gen = message.gen
        for (const listener of [...targetListeners]) listener(message.session)
        return
      case 'detached':
        // 那一代收了——**当下就作废旧号**（不作废的话，下一条命令会被当成过期误操作
        // 挡下来，而这个窗口其实只是想接着干，见 `manager.ts` 的 `retire`）。
        gen = null
        for (const listener of [...targetListeners]) listener(null)
        for (const listener of [...lineListeners]) listener(message.why)
        return
      case 'ev':
        for (const listener of [...eventListeners]) listener(message.event, message.gen)
        return
      case 'line':
        for (const listener of [...lineListeners]) listener(message.text)
        return
      default:
        // `welcome` 已经在上面的往返里收掉了
        return
    }
  })

  return {
    conn: greeted.conn,
    dataDir: greeted.dataDir,
    gen: () => gen,
    onTarget(listener) {
      targetListeners.push(listener)
    },
    onEvent(listener) {
      eventListeners.push(listener)
    },
    onLine(listener) {
      lineListeners.push(listener)
    },
    onClose(listener) {
      link.onClose(listener)
    },
    send(command) {
      link.send({ t: 'cmd', gen, cmd: command })
    },
    close() {
      link.send({ t: 'bye', why: '窗口收摊' })
      link.close()
    },
    get closed() {
      return link.closed
    },
  }
}

/** 握手的等待上限——本机 socket，一秒已是千倍余量；到点当「这个过程序不对」处理。 */
const HANDSHAKE_TIMEOUT_MS = 3_000

/**
 * 说一声「我是窗口」，等管理者回话。
 *
 * 超时**当场放弃**（不是重试、也不是降级成一个没有 `conn` 的客户端）：回话没来意味着
 * 对面那条路不对，而拿一个半开的东西去跑界面，只会把故障拖到用户按第一个键那一刻。
 */
async function greet(
  link: Link<ManagerToClient>,
  hello: { readonly cwd: string; readonly label?: string },
  timeoutMs: number,
): Promise<{ readonly conn: number; readonly dataDir: string } | undefined> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: { readonly conn: number; readonly dataDir: string } | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    link.onMessage((message) => {
      if (message.t !== 'welcome') return
      finish({ conn: message.conn, dataDir: message.dataDir })
    })
    link.onClose(() => finish(undefined))

    link.send({ t: 'hello', role: 'client', ...hello })
  })
}
