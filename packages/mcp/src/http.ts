/**
 * Streamable HTTP 连接 —— 与 stdio 同一个端口、同一条链（`connection.ts`）。
 *
 * 三件与 stdio 不一样的事：
 *
 * 1. **没有常驻连接**：每条消息各走各的 HTTP 请求，会话由服务端给的 `Mcp-Session-Id` 认。
 *    故「连接没了」不是某根管子断了，而是**一次请求证明了这条路走不通**——两种证法都算：
 *    请求当场失败（对端不可达 / 不认这个会话 / 不认这份凭据），或**发出去之后响应流断了**
 *    （见 `monitoredFetch`）。那一刻起这条连接作废（喊 `onclose`），与 stdio 那侧
 *    「子进程没了」是同一个处置。**没走到这两步之前，读数是最新一次事实**——HTTP 这一侧
 *    没有可以用来探活的长连接。
 * 2. **SDK 的隐含重连关掉**（`reconnectionOptions.maxRetries: 0`）：官方传输默认会在流断掉
 *    时自己补一次（GET 带 `Last-Event-ID` 续流，退避重试）。「未知远端效果不自动重试 /
 *    重放」是这一层的硬规矩——续流也是没人按过就自己又去问了一趟。
 * 3. **收尾终止会话**：断本端的流之外，按规范给端点发一次 DELETE（`terminateSession`）。
 *    终止的是**我们这一条会话**，不是用户的服务；对端不支持（405）不算失败。
 *
 * 认证：**首版不做 OAuth 登录**（不给 `authProvider`）——401 / 403 一律落成一句明确的
 * 「要认证，本版不支持登录」。
 */

import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { McpConnection, McpHttpConfig } from '@magic/contracts'
import { createConnection, deadline } from './connection.ts'
import type { OwnedTransport } from './connection.ts'

/** 它自己走了的那句缘由（我们放了手是另一句，见 `connection.ts` 的 `RELEASED`）。 */
const GONE = '连不上了'

/** 终止会话那一步的上限（毫秒）——收尾不许把退出挂住。 */
export const HTTP_TERMINATE_TIMEOUT_MS = 2_000

export type HttpConnectionOptions = {
  readonly server: string
  readonly config: McpHttpConfig
  readonly connectTimeoutMs?: number
  readonly callTimeoutMs?: number
}

/** HTTP 连接——端口 ＋ 起手（**启动那一步归编排者调**，端口本身不含它）。 */
export interface HttpConnection extends McpConnection {
  start(): Promise<void>
}

/** 造一条 Streamable HTTP 连接——**造了不等于连了**（`start()` 才起手握手）。 */
export function createHttpConnection(options: HttpConnectionOptions): HttpConnection {
  const config = options.config
  /**
   * **最近一次「这条路走不通」的原委**——传输记的，起手那一步读它。
   *
   * 由头：传输一作废就喊 `onclose`，SDK 那一侧**当场**把在途请求全按
   * `MCP error -32000: Connection closed` 拒掉——一句通用话，把真正的原因（要认证 /
   * 没有这个端点 / 连不上）盖掉了。故原委在传输这一层留一份，起手失败时优先说它。
   */
  let lost: unknown

  return createConnection({
    server: options.server,
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    driver: {
      kind: 'http',
      open: () => {
        lost = undefined
        return openTransport(config, (error) => {
          lost = error
        })
      },
      startupReason: (error) => startupReason(lost ?? error, config.url),
      goneReason: GONE,
    },
  })
}

/**
 * 造一条 Streamable HTTP 传输（**本进程的流与句柄都在它手上**）。
 *
 * `config.headers` 是**凭据**：只往请求上带，不进读数、不进事件、不进记录。
 * `onLost`＝这条路走不通了（带原委）——见 `createHttpConnection` 里那一位。
 */
function openTransport(config: McpHttpConfig, onLost: (error: unknown) => void): OwnedTransport {
  const inner = new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers === undefined ? {} : { requestInit: { headers: { ...config.headers } } }),
    // 见文件头注 2：一次都不补（SDK 默认会补两次）
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 0,
      maxReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
    // 盯一眼 POST 的响应流——见 `monitoredFetch`
    fetch: monitoredFetch((error) => lostThenGone(error)),
  })

  let closing: Promise<string | undefined> | undefined
  let closed = false

  const transport: OwnedTransport = {
    // 三件回调由消费者（官方 `Client`）挂上——本层只负责转发与喊
    onclose: undefined,
    onerror: undefined,
    onmessage: undefined,

    async start(): Promise<void> {
      await inner.start()
    },

    async send(message: JSONRPCMessage): Promise<void> {
      try {
        await inner.send(message)
      } catch (error) {
        // 原委留一份给起手那一步（它按状态码/网络层分类说人话，见 `startupReason`）
        onLost(error)
        // 这一趟失败**证明了这条路走不通**（对端不在 / 不认会话 / 不认凭据）——
        // 当场作废这条连接（见文件头注 1）。判定用**原始错**：那个分类认的是状态码。
        if (connectionLost(error)) markGone()
        // 往外走的用收敛过的那句（见 `transportFailure`：对端的响应正文一个字符都不许跟着走）
        throw transportFailure(error, config.url)
      }
    },

    // 官方 `Transport` 的 `close()` 是 `Promise<void>`——收尾那一段共用 `shutdown()`，
    // **收没收到**由它交回（`close()` 这一支只等它落定）
    async close(): Promise<void> {
      await shutdown()
    },

    shutdown,
  }

  // 底层传输出声的地方转给外面挂的那几个回调（SDK 的 `Client` 挂的是本对象）
  inner.onmessage = (message): void => transport.onmessage?.(message)
  inner.onerror = (error): void => transport.onerror?.(error)
  inner.onclose = (): void => markGone()

  /** POST 的响应流断了：记下原委 ＋ 作废这条连接（与 `send()` 抛错同一个处置）。 */
  function lostThenGone(error: unknown): void {
    onLost(error)
    markGone()
  }

  /** 喊一次「这条连接没了」（只喊一次；**收尾那一趟不算**——那是我们自己断的）。 */
  function markGone(): void {
    if (closed || closing !== undefined) return
    closed = true
    transport.onclose?.()
  }

  /** 收尾（幂等）——见 `OwnedTransport.shutdown`。 */
  function shutdown(): Promise<string | undefined> {
    closing ??= closeOnce()
    return closing
  }

  async function closeOnce(): Promise<string | undefined> {
    // ① 先终止会话（要趁流还没断、会话号还在）——有界；没能终止就如实说一句。
    // ⚠️ 这条路**已经走不通**时（`closed` 由那两处判定写下）就不试了：对端都没了，
    // 那一句「会话没能正常终止」只是噪音（它不是原因，是同一件事的另一种说法）。
    const note = closed ? undefined : await terminate(inner)

    // ② 再断本端的流（abort 掉在途的请求与 SSE）
    await inner.close()
    closed = true

    return note
  }

  return transport
}

/**
 * 终止会话（规范里的 DELETE）——**有界、不抛**。
 *
 * 交回**没能终止**那句（`undefined`＝终止了 / 压根没有会话可终止 / 对端明说不支持）。
 * 对端不认识 DELETE 时规范允许回 405（SDK 已按成功处理）——那不是「没收干净」。
 */
async function terminate(inner: StreamableHTTPClientTransport): Promise<string | undefined> {
  if (inner.sessionId === undefined) return undefined

  try {
    await deadline(inner.terminateSession(), HTTP_TERMINATE_TIMEOUT_MS, '终止会话超时')
    return undefined
  } catch (error) {
    return `会话没能正常终止（${transportFailure(error, '').message}）——远端可能还留着这一条`
  }
}

/**
 * 自己那一支 `fetch` —— **盯一眼 POST 的响应流**。
 *
 * 由头：Streamable HTTP 没有常驻连接，对端死没死只有**请求**才知道。一次**已经发出去**、
 * 而响应流中途断掉的调用（远端收了活儿、没答完就没了），官方传输只在内部喊一声 `onerror`
 * 就把那笔请求晾着——读数会一直停在「可用」，与记录里那句「未收到结果」对不上。
 * 故在响应体上接一根哨兵：流断了就报一声（连原委一起，与 `send()` 抛错同一个处置）。
 *
 * ⚠️ **只管 POST**：GET 那一条是服务端主动推消息的旁路（本版 `capabilities` 为空、不消费
 * 它），它断了不等于调用这条路断了——拿它作废整条连接是假账。
 */
function monitoredFetch(onBreak: (error: unknown) => void): FetchLike {
  return async (input, init) => {
    const response = await fetch(input as Parameters<typeof fetch>[0], init)
    if (init?.method !== 'POST' || response.body === null) return response

    return new Response(watchBody(response.body, onBreak), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

/**
 * 把响应体原样转出去，只在**读出错**那一路多喊一声。
 *
 * ⚠️ `finished` 这一位是必需的：**取消与在途的 `pull` 会抢跑**——消费方（官方传输）
 * 拿到答案之后会 `cancel()` 这个体，而那一刻可能正有一次 `read()` 在等；它回来时
 * 控制器已经关了，再 `close()` 就是 `Invalid state: Controller is already closed`，
 * 那一下会被错读成「流断了」。**取消不算断**（那是消费方说「我看完了」）。
 */
function watchBody(body: ReadableStream<Uint8Array>, onBreak: (error: unknown) => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let finished = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: { readonly done: boolean; readonly value?: Uint8Array }

      try {
        chunk = await reader.read()
      } catch (error) {
        if (finished) return
        finished = true
        onBreak(error)
        controller.error(error)
        return
      }

      if (finished) return // 等这一趟读回来的工夫，流已经收摊了——别碰控制器
      if (chunk.done || chunk.value === undefined) {
        finished = true
        controller.close()
        return
      }

      controller.enqueue(chunk.value)
    },

    cancel(reason) {
      finished = true
      return reader.cancel(reason)
    },
  })
}

/**
 * 这一趟失败是不是**证明了这条路走不通**（见文件头注 1）。
 *
 * - HTTP 状态码里只有三种算：**404**（不认这个会话）、**401 / 403**（不认这份凭据）；
 *   其余（400 / 406 / 5xx…）是**这一次请求**的事——对端答了，路还在。
 * - 不是 HTTP 状态码的那些（fetch 自己抛的：DNS、拒绝连接、TLS、断流）＝网络这一层过不去。
 *
 * ⚠️ **取消与超时走不到这儿**：那两条是 SDK 在**本地**把请求的 promise 拒掉，
 * 传输这一跳的 `send()` 照常返回（不中断在途的 HTTP）。
 */
function connectionLost(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 404 || error.code === 401 || error.code === 403
  }

  return true
}

/**
 * **起不来**那句缘由——**说人话**（这一句会上屏：开屏回执与 `--check` 都读它）。
 *
 * 这一层最常见的三种事故各有各的话：凭据没给对（401/403）、地址写错（404）、对端不可达
 * （fetch 抛出来的）。协议版本对不上时 SDK 抛的是带原话的 `Error`，也译一句。
 * 认不出的照原样带出（不编）——那种情形下原委就是唯一的线索。
 */
function startupReason(error: unknown, url: string): string {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403) {
      return `服务器要认证（HTTP ${error.code}）——本版不支持登录授权，要把凭据写进配置的 headers`
    }
    if (error.code === 404) return '这个地址上没有 MCP 端点（HTTP 404）——地址写错了，还是路径不对？'
    if (error.code === 406) return '服务器不接受这次请求的格式（HTTP 406）——它可能不是 MCP 端点'
    return `服务器回了 HTTP ${error.code}`
  }

  // fetch 那一层抛出来的（连不上 / DNS / TLS）：报**连的谁**，不带原话（原话可能含地址）
  if (networkFailure(error)) return `连不上 ${hostOf(url)}（这一趟没走通）`

  // 版本号是**对端说的**：只取一个受控记号（别把整句对端文本抄出去）
  const version = /protocol version is not supported: ([\w.\-]{1,32})/.exec(reasonOf(error))?.[1]
  if (version !== undefined) {
    return `服务器要的协议版本「${version}」本版不支持（按官方 SDK 支持的那几版协商）`
  }

  // 兜底：**不带对端文本**（响应正文可能带凭据——见 `transportFailure`）
  return '握手没走通——对端答的内容本版不认，或这条连接中途断了'
}

/**
 * 传输这一跳的失败 → **收敛过的缘由**。
 *
 * 为什么必须收敛：SDK 把失败响应的**正文**原样缀进错误里
 * （`Error POSTing to endpoint: <响应体>`），而这一句会一路走到工具结果、事件与记录，
 * 最后进模型请求——对端回什么就带什么。上游把凭据（`Authorization` 一类）抄回正文
 * 是真事，那就跟着泄出去了（本轮实测复现过）。故这一层只说**这一趟是什么性质**：
 * 状态码 / 网络层；正文与地址一个字不带。
 *
 * ⚠️ **只碰「这一趟没走通」的**：服务器**答了**的那些（JSON-RPC 报错、`isError` 结果、
 * 工具返回的正文）是它自己说的话，照旧原样交回——那是工具结果那一路，不是这一路。
 */
function transportFailure(error: unknown, url: string): Error {
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401 || error.code === 403) {
      return new Error(`服务器要认证（HTTP ${error.code}）——本版不支持登录授权，要把凭据写进配置的 headers`)
    }
    if (error.code === 404) return new Error('服务器不认这条连接了（HTTP 404）——会话没了或被终止了')
    return new Error(`服务器回了 HTTP ${error.code}`)
  }

  if (networkFailure(error)) return new Error(`连不上${url === '' ? '' : ` ${hostOf(url)}`}（这一趟没走通）`)

  // 认不出来的：**只说它是哪一类**，不带它自己那句话（那句话里可能就是对端的正文）
  return new Error(`HTTP 传输这一跳没走通（${error instanceof Error ? error.name : typeof error}）`)
}

/** fetch 自己抛的那些——`TypeError` 一类，不是服务端答的（本进程与对端之间没走通）。 */
function networkFailure(error: unknown): boolean {
  return error instanceof TypeError || /fetch|connect|socket|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(reasonOf(error))
}

/** 地址的主机那一段（**不带凭据与查询串**——这一句会上屏）。取不出来就退回原串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 出一句人话——`Error` 取 message，其余照字面（与工具域同一口径）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
