import type { Socket } from 'bun'
import { decodeNativeMessage } from '@magic/contracts'
import type { Wire } from '@magic/contracts'
export type { Wire, ClientToManager, ManagerToClient, ExecutorToManager, ManagerToExecutor, McpProbeRow } from '@magic/contracts'

/** 收一条线上的帧——**解不出来就是 `undefined`**（不是抛：坏行不该把连接带死）。 */
export function wireOf(line: string): Wire | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const one = parsed as Record<string, unknown>
    const t = one.t
    if (typeof t !== 'string') return undefined
    if (t.startsWith('native.') || one.role === 'observer') return decodeNativeMessage(one) as Wire | undefined
    if (t === 'hello') {
      if (one.role === 'client' && (typeof one.cwd !== 'string' || typeof one.protocol !== 'number' || typeof one.version !== 'string' || typeof one.source !== 'string')) return undefined
      if (one.role === 'executor' && typeof one.token !== 'string') return undefined
      if (one.role !== 'client' && one.role !== 'executor') return undefined
    }
    if (t === 'cmd' && (typeof one.cmd !== 'object' || one.cmd === null || typeof (one.cmd as { type?: unknown }).type !== 'string')) return undefined
    if (t === 'read' && (!Array.isArray(one.ids) || !one.ids.every((id) => typeof id === 'string'))) return undefined
    return one as Wire
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
  const encoder = new TextEncoder()
  let closed = false
  let listeners: ((message: Wire) => void)[] = []
  let closeListeners: ((error?: Error) => void)[] = []

  /**
   * **还没送出去的那一截**（空＝没有欠账）——见 `pump` 那段注。
   *
   * 收在**字节**这一层（不是字符串）：`socket.write` 报回来的是**字节数**，
   * 而按字符切一个含中文的串会切在**码点的中间**（一个汉字三个字节、一个字符）。
   */
  let pending: Uint8Array = EMPTY_BYTES
  let projection: Uint8Array | undefined

  const settle = (error?: Error): void => {
    if (closed) return
    closed = true
    // 人都走了，欠着的那一截没有送出去的地方了——丢掉（**不是悄悄丢**：对面收不全
    // 整条消息，它那一侧的断句本来就会把它认成坏行，与「这条连接断了」是同一件事）。
    pending = EMPTY_BYTES
    projection = undefined
    for (const listener of [...closeListeners]) listener(error)
    closeListeners = []
    listeners = []
  }

  /**
   * **把欠着的那一截尽量送出去**（`send` 与 `drain` 两处都走它）。
   *
   * ⚠️ **这是这一层唯一容易做错的地方**（U75 的真因）：`socket.write` **一次只收得下
   * 发送缓冲装得下的那么多**，返回的是**真收下的字节数**——**超出的那一截它不会替你留着**
   * （实测：这条路上一次写 30 468 字节，对面只收到 8 192；再写第二条又把缓冲装到 8 192 为止）。
   * 早先那一版把整条消息交给一次 `write`、**返回值看都不看**，于是**消息一超过那个缓冲就少一截**：
   * 对面收到半行 JSON、按坏行丢掉（这一层的既定口径），而**那半行后面的一切也跟着错位**——
   * 症状是「小消息一直好好的，大的那一条**一个字都到不了**」。
   *
   * 故两条：**写不完的留成欠账**（`pending`），**缓冲满了就等 `drain`**（Bun 在那条路上
   * 回调 `socket.data.drain`，见 `socketHandlers`）——这一跳是**同步**的（`send` 各处都当
   * 它立刻送出），等的责任只能在连接自己身上。
   *
   * 次序不变：欠账与后来的消息**首尾相接**地攒在一起，先欠的先出。
   */
  const pump = (): void => {
    while (!closed && (pending.length > 0 || projection !== undefined)) {
      if (pending.length === 0) { pending = projection!; projection = undefined }
      let accepted: number
      try {
        accepted = socket.write(pending)
      } catch {
        settle(new Error('写不进去'))
        return
      }
      // **0 ＝ 这一下一点都塞不进去**（发送缓冲满）——欠账留着，等 `drain` 那一跳
      if (accepted <= 0) break
      pending = accepted >= pending.length ? EMPTY_BYTES : pending.slice(accepted)
    }

    if (closed) return
    // **每条都 flush**（实测要的）：不 flush 的话小消息躺在用户态缓冲里等下一次写，
    // 而「下一次写」可能是几秒之后——线上就成了「发出去半分钟没动静」。
    socket.flush()
  }

  const link: Link = {
    send(message) {
      if (closed) return false

      let wire: string
      try {
        wire = `${JSON.stringify(message)}\n`
      } catch {
        settle(new Error('写不进去'))
        return false
      }

      const bytes = encoder.encode(wire)
      // 已开始写的帧必须补完；尚未写出的完整投影只保留最新一份。
      if (message.t === 'native.projection' && pending.length > 0 && bytes.length <= 8 * 1024 * 1024) {
        projection = bytes
        return true
      }
      if (pending.length + bytes.length + (projection?.length ?? 0) > 8 * 1024 * 1024) {
        try { socket.terminate() } catch {}
        settle(new Error('客户端未及时接收数据，请重新连接以读取快照'))
        return false
      }
      pending = pending.length === 0 ? bytes : concat(pending, bytes)
      pump()
      return true
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
      if (buffered.length > 8 * 1024 * 1024) { socket.terminate(); settle(new Error('消息过大')); return }

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
    // **发送缓冲又能装了**（Bun 的回调）——欠着的那一截接着送（见 `pump` 的注）。
    drain: pump,
    gone: settle,
  }

  return link as Link<In>
}

/** 没欠账时那一格（**空数组不新造**——`pending.length === 0` 就是「不欠」的判据）。 */
const EMPTY_BYTES = new Uint8Array(0)

/** 两截字节接起来（欠账 ＋ 新来的那一条）。只在**真有欠账**时才走这一处。 */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

/** 挂在 `socket.data` 上的三件——`Bun.listen` / `Bun.connect` 的回调据以找到自己的 `Link`。 */
type LinkSlot = {
  chunk?: (bytes: Uint8Array) => void
  /** 发送缓冲腾出来了（`socket.write` 又能装了）——把欠着的那一截送出去。 */
  drain?: () => void
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
    /**
     * **发送缓冲腾出来了**——`socket.write` 收不下的那一截还欠着，这一跳接着送
     * （见 `pump` 的注）。⚠️ **少了它，超缓冲的消息就永远差着那一截**：收的人等到的是
     * 一条半行，按坏行丢掉——而发送那一侧看起来「已经送出去了」（`write` 没抛）。
     */
    drain(socket: Socket<LinkSlot>): void {
      socket.data?.drain?.()
    },
    close(socket: Socket<LinkSlot>): void {
      socket.data?.gone?.()
    },
    error(socket: Socket<LinkSlot>, error: Error): void {
      socket.data?.gone?.(error)
    },
  }
}
