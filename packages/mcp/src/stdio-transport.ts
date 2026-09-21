/**
 * 自有 stdio 传输 —— **归属在启动那一刻就定死**（U38 返工 A 补正）。
 *
 * ## 为什么自己写这一层（而不是用 SDK 的 `StdioClientTransport`）
 *
 * 官方那支传输**不开放 `detached`**：子进程落在**我们自己的进程组**里，于是「哪些进程算是
 * 这条服务器带起来的」只能靠**事后数进程树**去凑。数进程树有两处补不上的洞（独立复验
 * 两次点到）：
 *
 * 1. **时点**——父一崩，PPID 链就断（孙子被过继给 1 号）。「起手时数一次、每次调用前再数一次」
 *    仍会漏掉**调用中途才起、起完立刻崩**的那一个：它只在崩与下一次观察之间存在；
 * 2. **复用**——记下来的一串 pid 到收尾时未必还是那几个进程（pid 会被系统回收再分配），
 *    拿 `kill(pid, 0)` 判「还是不是自有的」本身就是错的。
 *
 * 故把归属**收在启动边界**：`detached: true` ⇒ 子进程**自成进程组**（组长 ＝ 子进程 pid），
 * 它此后拉起的一切都在这个组里。收尾时按**组**发信号——**不需要数、不需要快照、
 * 也没有时点可漏**：组里有什么就收什么。
 *
 * ## 这一层有多薄
 *
 * 只做「进程 ＋ 两根管子的接法」，协议一件不碰：
 * - **分帧与编解码**取官方 `shared/stdio`（`ReadBuffer` / `serializeMessage`——含最大缓冲上限）；
 * - **协议状态机 · 握手 · 分页**全在官方 `Client` 那一侧（本层只实现它要的 `Transport` 三件）；
 * - **环境**取官方 `client/stdio` 的 `getDefaultEnvironment()`（只带 PATH / HOME 一类，
 *   用户凭据不外溢——与原来那支传输同一把尺子）；
 * - **不碰 SDK 私有字段**（原来那条路要读 `transport.pid`，SDK 一改就悄悄失效）。
 *
 * ## 收尾次序（与传输规范给直接子进程的那一套同一把尺子，只是**按组**）
 *
 * 关 stdin（规范里的头号优雅信号）→ 等它自己退 → **组 TERM** → 等 → **组 KILL** → 复读。
 * 崩溃那条路（组长先没了）也走同一段：组还在（组员还活着）就照样收得到——
 * 这正是「数进程树」补不上的那一格。
 *
 * ⚠️ **只碰这一组**：信号一律发给 `-pgid`，而 `pgid` 是**我们自己 spawn 出来的那个**
 * （`detached` 保证它自成一组）。外部无关进程不在组里，扫不到也杀不着。
 */

import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** 关 stdin 之后等它自己退多久（毫秒）——到点即按组收。 */
export const STDIO_EXIT_GRACE_MS = 2_000

/** 组内 TERM / KILL 各等多久（毫秒）——收尾这一步**有界**，不能挂住退出。 */
const GROUP_TERM_GRACE_MS = 1_000
const GROUP_KILL_GRACE_MS = 1_000

/** 收尾复读的步长（毫秒）。 */
const POLL_MS = 25

export type OwnedStdioOptions = {
  readonly command: string
  readonly args?: readonly string[]
  /** 追加给子进程的环境（密钥从这儿进）——在官方默认环境之上。 */
  readonly env?: Readonly<Record<string, string>>
}

/** 端口 —— 官方 `Transport` 三件（`start` / `send` / `close`）＋ 归属与收尾。 */
export interface OwnedStdioTransport extends Transport {
  /** **自有进程组 id**（＝子进程 pid）——「哪些算它的」只有这一个判据。未起／已收＝`undefined`。 */
  readonly pgid: number | undefined
  /**
   * 收尾：关 stdin → 等 → **按组** TERM → 等 → **按组** KILL。
   *
   * 返回**没收掉的组**（空表＝收干净了）——调用方据此如实写在读数上，
   * 不许拿一个空表冒充「已收干净」。幂等（第二次直接给上一次的结果）。
   */
  shutdown(): Promise<readonly number[]>
}

/** 造一条自有 stdio 传输——**造了不等于起了**（`start()` 才拉进程）。 */
export function createOwnedStdioTransport(options: OwnedStdioOptions): OwnedStdioTransport {
  let child: Bun.Subprocess<'pipe', 'pipe', 'ignore'> | undefined
  let pgid: number | undefined
  let closing: Promise<readonly number[]> | undefined
  let closed = false
  const buffer = new ReadBuffer()

  const transport: OwnedStdioTransport = {
    // 三件回调由消费者（官方 `Client`）挂上——本层只负责喊
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,

    get pgid() {
      return pgid
    },

    async start(): Promise<void> {
      if (child !== undefined) throw new Error('这条传输已经起过了')

      const spawned = Bun.spawn([options.command, ...(options.args ?? [])], {
        // 默认环境（PATH / HOME 一类）＋ 配置里那几个——**用户凭据不外溢**
        env: { ...getDefaultEnvironment(), ...options.env },
        stdin: 'pipe',
        stdout: 'pipe',
        // TUI 在跑：子进程的 stderr 一行都不能漏到这块屏上（同原传输那一跳）
        stderr: 'ignore',
        // **自成进程组**：组长 ＝ 子进程 pid，此后它拉起的一切都在这个组里（见文件头注）
        detached: true,
      })

      child = spawned
      pgid = spawned.pid

      void pump(spawned)
      void watchExit(spawned)
    },

    async send(message: JSONRPCMessage): Promise<void> {
      const sink = child?.stdin
      if (sink === undefined) throw new Error('这条连接已经关了——没有可写的 stdin')

      sink.write(serializeMessage(message))
      await sink.flush()
    },

    // 官方 `Transport` 的 `close()` 是 `Promise<void>`——收尾那一段共用 `shutdown()`，
    // **收没收到**由它交回（`close()` 这一支只等它落定）
    async close(): Promise<void> {
      await shutdown()
    },

    shutdown,
  }

  /** 读 stdout → 分帧 → 交 `onmessage`（分帧与校验都在官方 `ReadBuffer` 里）。 */
  async function pump(spawned: Bun.Subprocess<'pipe', 'pipe', 'ignore'>): Promise<void> {
    const reader = spawned.stdout.getReader()

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value === undefined) continue

        buffer.append(Buffer.from(value))
        let message: JSONRPCMessage | null
        while ((message = buffer.readMessage()) !== null) transport.onmessage?.(message)
      }
    } catch (error) {
      // 分帧层坏了（超上限 / 收到不成形的报文）——当场说，并收摊（同原传输的处置）
      transport.onerror?.(asError(error))
      void shutdown()
    }
  }

  /**
   * 组长退了 —— **不管是谁先走的**：组里还有谁就收谁。
   *
   * 这正是补上的那一格：服务器**在调用中途**起了个普通后代、随即自己崩掉时，
   * 组员仍在组里（`-pgid` 照样达得到），不需要任何「之前数过什么」。
   */
  async function watchExit(spawned: Bun.Subprocess<'pipe', 'pipe', 'ignore'>): Promise<void> {
    await spawned.exited

    // 组长那一支已经没了：这里给孩子那一侧留个明白账（`send` 之后会按「已关」拒）
    if (child === spawned) child = undefined

    // 自己走的（不是我们关的）⇒ 当场按组收（bounded，不阻塞谁）
    if (closing === undefined) void reapGroup(spawned.pid)

    if (!closed) {
      closed = true
      transport.onclose?.()
    }
  }

  /** 收尾（幂等）——见 `OwnedStdioTransport.shutdown`。 */
  function shutdown(): Promise<readonly number[]> {
    closing ??= closeOnce()
    return closing
  }

  async function closeOnce(): Promise<readonly number[]> {
    const spawned = child
    if (spawned === undefined) {
      // 没起过 / 已经收过：**组还在就再确认一次**（组长崩了但组员还在的那种局面）
      return pgid === undefined ? [] : reapGroup(pgid)
    }

    // ① 优雅：关 stdin（规范里的头号信号——服务器收到 EOF 自己退）
    try {
      spawned.stdin?.end()
    } catch {
      // 已经关了 / 已死——两种都不该让收尾中断
    }

    // ② 等它自己退（这一段不给信号：正常收尾绝大多数走的就是这一条）
    await Promise.race([spawned.exited, sleep(STDIO_EXIT_GRACE_MS)])

    // ③ **按组收**：等不到就 TERM，再不退就 KILL（组内普通后代一并收走）
    return reapGroup(spawned.pid)
  }

  return transport
}

/** 组还在不在——`kill(-pgid, 0)` 只探活：组里**还有成员**就成（组长没了也一样）。 */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    // 没权限发信号 ⇒ 这一组还在（只是我们发不进去）——如实算「还在」
    return (error as { readonly code?: string }).code === 'EPERM'
  }
}

/** 给整组发信号——组里恰好一个成员都没有也算成功（ESRCH 是收尾路上的常态）。 */
function signalGroup(pgid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pgid, name)
  } catch {
    // 已经收干净 / 发不进去——两种都不该让收尾中断（后一种由 `groupAlive` 如实报出来）
  }
}

/** 按组收命（TERM → 等 → KILL → 复读）——**只碰这一组**。 */
async function reapGroup(pgid: number): Promise<readonly number[]> {
  if (!groupAlive(pgid)) return []

  signalGroup(pgid, 'SIGTERM')
  await untilGroupGone(pgid, GROUP_TERM_GRACE_MS)
  if (!groupAlive(pgid)) return []

  signalGroup(pgid, 'SIGKILL')
  await untilGroupGone(pgid, GROUP_KILL_GRACE_MS)

  return groupAlive(pgid) ? [pgid] : []
}

/** 等这一组没了（有界：到点即返回，让调用方按实况报）。 */
async function untilGroupGone(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && groupAlive(pgid)) await sleep(POLL_MS)
}

function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

/** 出一句人话——`Error` 取 message，其余照字面（与工具域同一口径）。 */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
