/**
 * **运行连接的线上协议**（U48）——管理者 ↔ 执行者 ↔ 客户端三方之间的那一层线。
 *
 * ## 为什么不把 `Command` / `KernelEvent` 本身当消息
 *
 * 契约里那两件是**内核与外壳之间的语言**（冻结面，一字不动）。而这条线要运的是
 * **比它们多一层的东西**：谁在说话、说的是哪一代执行现场、这一句是不是一条生命探测。
 * 把那些塞进 `Command` 就是往冻结面里加字段；故线上一律是**信封**，`cmd` / `event`
 * 是信封里的一格。
 *
 * | 方向 | 消息 |
 * | --- | --- |
 * | 客户端 → 管理者 | `hello`（我是窗口）· `cmd`（带着我认的**代次**）· `bye` |
 * | 管理者 → 客户端 | `welcome`（你连上了谁）· `ev`（事件 ＋ 它的代次）· `line`（给人看的一句话） |
 * | 执行者 → 管理者 | `hello`（我是哪条会话的执行者）· `bound` · `ev` · `pong` · `done` |
 * | 管理者 → 执行者 | `cmd` · `ping` · `bye` |
 *
 * ## 帧
 *
 * 换行分隔的 JSON（`JSON.stringify` 把换行转义掉了，故一条消息永远落在一行里）。
 * 断句这一层只做一件事：**攒够一整行就交出去**——它也是字节流与消息之间那条缝，
 * 读不懂的行**丢**（一条坏行不该把整条连接带死）。
 *
 * ⚠️ **不做的事**：不重传、不管业务失败。这一层只管「一句话原样过去、原样过来」——
 * 次序与去重是上面那几层的事。
 */

import type { Socket } from 'bun'
import type { Command, KernelEvent } from '@magic/contracts'

/** 客户端 → 管理者。 */
export type ClientToManager =
  | {
      readonly t: 'hello'
      readonly role: 'client'
      readonly label?: string
      /**
       * **启动目录**——窗口在哪儿起的。执行者按它算工作区默认根
       * （配置没写 `workspaceRoots` 时「启动目录＝默认根」，U18 那条`??`）。
       * 它是**窗口的属性**，而窗口是客户端：不给的话执行者只能拿管理者自己那一份，
       * 于是「在 A 目录敲 magic」会落到管理者当初被唤起时的目录上。
       */
      readonly cwd: string
    }
  /** `gen` ＝ 这个窗口认的执行者代次（`null` ＝ 还没认过任何一代）。 */
  | { readonly t: 'cmd'; readonly gen: number | null; readonly cmd: Command }
  | { readonly t: 'bye'; readonly why: string }

/** 管理者 → 客户端。 */
export type ManagerToClient =
  | {
      readonly t: 'welcome'
      /** 这条连接的编号（诊断用——线上不长住任何用户可见的东西）。 */
      readonly conn: number
      /** 数据目录的规范形（管理者就是按它认的自己这一摊）。 */
      readonly dataDir: string
    }
  /**
   * **客户端换到了另一个执行者**——`gen` 是**当下**那一代的号，`session` 是它认的会话
   * （`null` ＝ 那条执行者还没开张）。
   *
   * 为什么要有这一条：代次是**窗口认的**（它发命令时得带上），而换目标是管理者做的
   * ——不告诉它换成了哪一代，它下一步发的命令就会被当成过期的那一代（U48 第三段）。
   * 它也是外壳「我现在在看哪条会话」那条读数的**权威来处**。
   */
  | { readonly t: 'target'; readonly gen: number; readonly session: string | null }
  /**
   * **窗口与它那一代脱开了**——那一代收了（自退 / 被杀 / 管理者收摊），而这个窗口还在。
   *
   * ⚠️ **窗口不是跟着死**：它下一次发命令时管理者会按需要起新的一代（见 `onCommand`）。
   * 但**它手上那个代次必须先作废**——不作废的话，它带着旧号发的下一条命令会被当成
   * 「过期连接误操作」挡下来（U48 第三段那条判据），而它其实只是想接着干。
   * 「什么时候该忘掉旧号」这件事只有管理者说了算，故由这一条说。
   */
  | { readonly t: 'detached'; readonly why: string }
  /** `gen` ＝ 这条事件出自哪一代执行者（没有代次可言时给 `null`）。 */
  | { readonly t: 'ev'; readonly gen: number | null; readonly event: KernelEvent }
  /** 一句**给人看**的话（代次过期、管理者要退了……）——客户端把它落成一行回执。 */
  | { readonly t: 'line'; readonly text: string }

/** 执行者 → 管理者。 */
export type ExecutorToManager =
  | {
      readonly t: 'hello'
      readonly role: 'executor'
      /** 管理者发车时给的令牌——认它是「我叫起来的那一个」。 */
      readonly token: string
      /** **开工那条会话**（显式接续时就有）；`null` ＝ 还没开张（首条消息按下回车才建立，D5）。 */
      readonly session: string | null
      /** 工作区整组根（规范形 · 声明序）——登记里要它。 */
      readonly workspace: readonly string[]
    }
  /**
   * **这一代开工了**——发现那一跳跑完、恢复跑完、可以收命令了。
   *
   * 管理者据它把攒下的命令放行：起进程到能干活那一段（装载 ＋ 发现 ＋ 恢复）是秒级，
   * 而窗口那边已经在等着了——**先攒着、到点了再送**，比「命令发出去无声落空」好。
   */
  | { readonly t: 'ready' }
  | { readonly t: 'ev'; readonly event: KernelEvent }
  | { readonly t: 'pong'; readonly seq: number }
  /** **跑起来之后才开张**（D5 那条路）——补一条登记，管理者据以把它挂到会话名下。 */
  | { readonly t: 'bound'; readonly session: string }
  /** 自己收摊了（收缩那条路）——管理者据以核销，不再等它。 */
  | { readonly t: 'done'; readonly why: string }

/** 管理者 → 执行者。 */
export type ManagerToExecutor =
  | { readonly t: 'cmd'; readonly cmd: Command }
  | { readonly t: 'ping'; readonly seq: number }
  /**
   * **还有几个窗口盯着你**——收缩那条路要看它（设计：「运行已结束、没有在途调用或待答项、
   * **也没有连接者** ⇒ 持久化状态后释放该执行者」）。
   *
   * 为什么由管理者说：连接是**它**在管，执行者看不见「外面还有没有人看」——而那正是
   * 收不收的**一半判据**。另一半（在途调用、待答项）归执行者自己（它看得见内核的状态）。
   */
  | { readonly t: 'watchers'; readonly count: number }
  | { readonly t: 'bye'; readonly why: string }

/** 线上消息的总表——判别收窄用得到它。 */
export type Wire = ClientToManager | ManagerToClient | ExecutorToManager | ManagerToExecutor

/** 收一条线上的帧——**解不出来就是 `undefined`**（不是抛：坏行不该把连接带死）。 */
export function wireOf(line: string): Wire | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const t = (parsed as { t?: unknown }).t
    return typeof t === 'string' ? (parsed as Wire) : undefined
  } catch {
    return undefined
  }
}

/**
 * 一条**已经通了信**的双向连接。
 *
 * 两个动作各说各话：`send` 是「往对端送」，`onMessage` 是「收对端来的」——名字与契约里
 * 那两个传输端口同一条口径（`ControlTransport` / `KernelTransport` 的两端也是这么分的）。
 */
export type Link<In extends Wire = Wire> = {
  /** 送一条消息；**对端没了**返回 `false`（不抛——收尾那几条路不该被一句送不出去的话打断）。 */
  send(message: Wire): boolean
  /**
   * 收对端来的消息。
   *
   * 泛型 `In` 是**这一端会收到的那一族**：四个方向里有两对判别联合（客户端收
   * `ManagerToClient`、管理者收 `ClientToManager | ExecutorToManager`……），
   * 而 `Wire` 是四者的并——不指出方向的话，`t: 'ev'` 那一支同时匹配两个形状，
   * 收窄当场退化。方向是**造这条连接的人知道的事**，故由他给。
   */
  onMessage(listener: (message: In) => void): void
  /** 断开时告知（**只报一次**，无论谁先断）。 */
  onClose(listener: (error?: Error) => void): void
  /** 关掉（先 FIN）。重复调用无害。 */
  close(): void
  readonly closed: boolean
}

/**
 * `socket` 与它的 `Link` 的对应表——**够不到 `socket.data` 那条路**。
 *
 * 为什么不用 `socket.data`：`Bun.listen` 的那个 `data` 是**监听器级**的一份，
 * 而每一条接进来的连接要有**自己**的一份——照那条路写，第二个连接会把第一个的
 * 收包回调顶掉，症状是「第一条连上的人永远收不到回话」。`WeakMap` 按 socket 认，
 * 各是各的，也不多占谁的生命周期。
 */
const LINKS = new WeakMap<Socket<unknown>, Link>()

/**
 * 把一个 Bun socket 包成 `Link`——**服务端接进来的与客户端连上的走同一条路**。
 *
 * 两处各写一份的代价是「服务端那条路忘了回报 `close`」这类只在一边出现的毛病。
 */
export function linkOf<In extends Wire = Wire>(socket: Socket<unknown>): Link<In> {
  const existing = LINKS.get(socket)
  if (existing !== undefined) return existing as Link<In>

  let buffered = ''
  const decoder = new TextDecoder()
  let closed = false
  let listeners: ((message: Wire) => void)[] = []
  let closeListeners: ((error?: Error) => void)[] = []

  const settle = (error?: Error): void => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener(error)
    closeListeners = []
    listeners = []
  }

  const link: Link = {
    send(message) {
      if (closed) return false
      try {
        socket.write(`${JSON.stringify(message)}\n`)
        // **每条都 flush**（实测要的）：不 flush 的话小消息躺在用户态缓冲里等下一次写，
        // 而「下一次写」可能是几秒之后——线上就成了「发出去半分钟没动静」。
        socket.flush()
        return true
      } catch {
        settle(new Error('写不进去'))
        return false
      }
    },

    onMessage(listener) {
      if (closed) return
      listeners.push(listener)
    },

    onClose(listener) {
      if (closed) {
        listener()
        return
      }
      closeListeners.push(listener)
    },

    close() {
      try {
        socket.end()
      } catch {
        // 已经断了 / 对端先断：收尾这一跳不该抛
      }
      settle()
    },

    get closed() {
      return closed
    },
  }

  LINKS.set(socket, link)

  // 收到的字节 → 整行 → 消息（坏行丢掉）
  ;(socket as Socket<LinkSlot>).data = {
    chunk: (bytes) => {
      buffered += decoder.decode(bytes, { stream: true })

      let at = buffered.indexOf('\n')
      while (at !== -1) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        if (line.trim() !== '') {
          const message = wireOf(line)
          if (message !== undefined) {
            for (const listener of [...listeners]) listener(message)
          }
        }
        at = buffered.indexOf('\n')
      }
    },
    gone: settle,
  }

  return link as Link<In>
}

/** 挂在 `socket.data` 上的两件——`Bun.listen` / `Bun.connect` 的回调据以找到自己的 `Link`。 */
type LinkSlot = {
  chunk?: (bytes: Uint8Array) => void
  gone?: (error?: Error) => void
}

/**
 * `Bun.listen` / `Bun.connect` 的 socket 回调——**两处共用这一份**。
 *
 * `close` 与 `error` 都收成同一次「这一条断了」：对上层来说那两件事的后果一样
 * （这一端没了），分开报只会让每处调用点各写一遍「两种都要当断」。
 *
 * `open` 那一跳由调用方给（服务端要在此把接进来的连接包成 `Link` 并挂上处理；
 * 客户端那头 `Bun.connect` 的 promise 已经交了 socket，用不上它）。
 */
export function socketHandlers(onOpen?: (socket: Socket<LinkSlot>) => void) {
  return {
    open(socket: Socket<LinkSlot>): void {
      onOpen?.(socket)
    },
    data(socket: Socket<LinkSlot>, bytes: Uint8Array): void {
      socket.data?.chunk?.(bytes)
    },
    close(socket: Socket<LinkSlot>): void {
      socket.data?.gone?.()
    },
    error(socket: Socket<LinkSlot>, error: Error): void {
      socket.data?.gone?.(error)
    },
  }
}
