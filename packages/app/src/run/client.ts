/**
 * **终端侧那一端的连接**（U48）——窗口经本机连接接入管理者。
 *
 * 这一层只做三件：**连上、说声我是谁、把话递来递去**。它**不认识任何域**，也不持有
 * 任何执行状态——「窗口只是展示入口」这条（设计 · 会话与运行管理）在这里是结构上的
 * 事实：`client.ts` 里一个字都没有「会话 / 运行 / 执行者」的概念，它只有一条连接。
 *
 * 转成外壳要的 `ControlTransport` 是**下一跳**的事（`./terminal.ts`）：那一跳要把
 * 「哪条事件属于我正看的那条会话」「代次过期怎么回话」这些判断加上去，而它们不属于
 * 「一条连接怎么说话」。
 *
 * ## 为什么 `hello` 与 `welcome` 是一次往返
 *
 * 连上之后**先报身份、再受理命令**：管理者要说得出「这条连接是谁」，而客户端要说得出
 * 「我连上的是哪一摊」（数据目录）——两句话在**同一次往返**里说完，免得出现
 * 「已经能发命令了，可我还不知道自己在跟谁说话」那一小段。
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
  /** 内核来的事件 ＋ 它的**执行者代次**（`null` ＝ 与代次无关的读数）。 */
  onEvent(listener: (event: KernelEvent, gen: number | null) => void): void
  /** 管理者**给人看**的话（代次过期、它要退了……）——外壳落成一行回执。 */
  onLine(listener: (text: string) => void): void
  /** 连接断了（**只报一次**）——「管理者不可达」那一路。 */
  onClose(listener: (error?: Error) => void): void
  /** 发一条命令，带上我认的代次（`null` ＝ 还没认过任何一代）。 */
  send(command: Command, gen: number | null): void
  close(): void
  readonly closed: boolean
}

/** 连上管理者——连不上（没人 listen / 路径是尸首）返回 `undefined`，不抛。 */
export async function connectManager(
  socketPath: string,
  options: { readonly label?: string | undefined; readonly timeoutMs?: number | undefined } = {},
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
  const greeted = await greet(link, options.label, options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS)
  if (greeted === undefined) {
    link.close()
    return undefined
  }

  const eventListeners: ((event: KernelEvent, gen: number | null) => void)[] = []
  const lineListeners: ((text: string) => void)[] = []

  link.onMessage((message) => {
    switch (message.t) {
      case 'ev':
        for (const listener of [...eventListeners]) listener(message.event, message.gen)
        return
      case 'line':
        for (const listener of [...lineListeners]) listener(message.text)
        return
      default:
        // `welcome` 已经在上面的往返里收掉了；执行者那几支不该出现在客户端的连接上
        return
    }
  })

  return {
    conn: greeted.conn,
    dataDir: greeted.dataDir,
    onEvent(listener) {
      eventListeners.push(listener)
    },
    onLine(listener) {
      lineListeners.push(listener)
    },
    onClose(listener) {
      link.onClose(listener)
    },
    send(command, gen) {
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
  label: string | undefined,
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

    link.send(label === undefined ? { t: 'hello', role: 'client' } : { t: 'hello', role: 'client', label })
  })
}
