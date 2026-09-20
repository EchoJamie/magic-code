/**
 * stdio 连接 —— **客户端封在适配器后**（U38）。
 *
 * 出处：首批功能建设 ·「MCP 外部工具」——「应用层管理连接生命周期，客户端藏在适配器后；
 * 工具域复用注册、审批、调用、取消、记录和结果回填。stdio 与 Streamable HTTP 是两种接入，
 * 按 MCP 传输规范与实现时官方 SDK 的支持版本核对，**不手写协议栈**」。
 *
 * 本文件是「藏」的那一层：官方 SDK 的类型**一件都不出去**，外面只看得到契约里的
 * `McpConnection`（`tools` / `call` / `close` 三件 ＋ 状态）。U39 的 Streamable HTTP
 * 是同一端口的另一个实现——换的是本文件的传输那一跳，外面那条链一字不动。
 *
 * 四条规矩，各有出处（传输规范 · stdio，2026-07-28 修订版的 Shutdown 与 stderr 两条）：
 *
 * 1. **stderr 不外泄**——规范允许客户端忽略服务器的 stderr；而本进程正跑着全屏 TUI，
 *    子进程往 stderr 写一行就能把屏面搅乱。故固定 `stderr: 'ignore'`（要看日志请把
 *    服务器自己的日志写文件——那是它的事，不是本客户端该替它决定的事）。
 * 2. **环境不外溢**——SDK 的默认环境只带 PATH / HOME 一类，配置里 `env` 的那些**追加**
 *    在它之上。**用户自己的凭据不因为「起了一个 MCP 服务器」就跟着过去。
 * 3. **关闭照规范的次序**——关 stdin → 等 → 杀（SDK 的 `close()` 就实现成
 *    关 stdin · 2s · SIGTERM · 2s · SIGKILL）。**只关本进程拉起的这一个**——
 *    用户自己的服务不归我们杀。
 * 4. **起手有界**——连不上 / 不应答的服务器**不能把启动拖住**：连接与发现各有一道上限
 *    （`connectTimeoutMs`），到点即判「不可用」，说清缘由，**内置工具照常**。
 *
 * 超时与取消都收敛成**确定的结果**（`McpCallOutcome` 的 `failed` 那一支）：
 * 调用这一层**不抛**——「没收到结果」是结果的一种，模型要据此决定下一步（同沙箱原语
 * 那条「失败形态分两路」的姿势）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpCallOutcome,
  McpConnection,
  McpConnectionState,
  McpPart,
  McpServerConfig,
  McpToolInfo,
} from '@magic/contracts'

/** 客户端自报的名字（服务器侧日志里看到的就是这个）。 */
const CLIENT_INFO = { name: 'magic-code', version: '0.0.0' } as const

/** 连接 / 发现的上限（毫秒）——**有界**是这一条的全部意思（见文件头注 4）。 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000

/**
 * 一次工具调用的上限（毫秒）——缺省值，装配可覆盖（用例不必真等两分钟）。
 *
 * 与 `exec` 的 `EXEC_TIMEOUT_MS` 同量级：**外部调用的等待不该比本机命令更宽**。
 */
export const MCP_CALL_TIMEOUT_MS = 120_000

export type StdioConnectionOptions = {
  readonly server: string
  readonly config: McpServerConfig
  readonly connectTimeoutMs?: number
  readonly callTimeoutMs?: number
}

/** stdio 连接——端口 ＋ 一条 `start()`（**启动那一步归编排者调**，端口本身不含它）。 */
export interface StdioConnection extends McpConnection {
  /** 拉起进程 · 握手 · 发现。**不抛**：失败落成 `state.unavailable`（起手有界，见头注 4）。 */
  start(): Promise<void>
}

/** 造一条 stdio 连接——**造了不等于连了**（`start()` 才拉进程）。 */
export function createStdioConnection(options: StdioConnectionOptions): StdioConnection {
  const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS

  let state: McpConnectionState = { status: 'connecting' }
  let discovered: readonly McpToolInfo[] = []
  let client: Client | undefined
  let transport: StdioClientTransport | undefined
  let started = false

  /**
   * 起手的那一趟——**失败一律落成「不可用 ＋ 缘由」**，绝不抛给调用方。
   *
   * 由头：一个服务器起不来是**常态**（命令写错、包里没装、机器上没有那个 bin），
   * 而它不是本进程的异常——它是「这一条连接不可用」，报出来、别拖垮别的工具。
   */
  async function start(): Promise<void> {
    if (started) return
    started = true

    try {
      const spawned = new StdioClientTransport({
        command: options.config.command,
        ...(options.config.args === undefined ? {} : { args: [...options.config.args] }),
        // 默认环境（PATH / HOME 一类）＋ 配置里那几个——**用户凭据不外溢**（头注 2）
        ...(options.config.env === undefined ? {} : { env: { ...options.config.env } }),
        // TUI 在跑：子进程的 stderr 一行都不能漏到这块屏上（头注 1）
        stderr: 'ignore',
      })
      transport = spawned

      const connecting = new Client(CLIENT_INFO, { capabilities: {} })
      await deadline(
        connecting.connect(spawned, { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `连接超时（${connectTimeoutMs}ms）`,
      )

      const listed = await deadline(
        connecting.listTools(undefined, { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `列工具超时（${connectTimeoutMs}ms）`,
      )

      client = connecting
      discovered = toolsOf(listed.tools)
      state = { status: 'available' }
    } catch (error) {
      state = { status: 'unavailable', reason: startupReason(error, options.config) }
      // 半途死掉的进程要收干净（连到一半也算「本进程拉起过它」）
      await release()
    }
  }

  /** 释放（幂等）——关 stdin → 等 → 杀（SDK 的次序），**只碰本进程拉起的这一个**。 */
  async function release(): Promise<void> {
    const spawned = transport
    transport = undefined
    client = undefined
    if (spawned === undefined) return

    try {
      await spawned.close()
    } catch {
      // 关不掉就算了（多半是已经死了）——收尾这一步没有可回的答，静默吞掉比抛出去干净
    }
  }

  return {
    start,
    server: options.server,

    get state() {
      return state
    },

    tools: () => discovered,

    async call(tool, args, opts): Promise<McpCallOutcome> {
      const connecting = client
      if (connecting === undefined) {
        // 从没连上 / 已经放了手——**这一次调用没发出去**，照实说（不复述「远端可能已执行」）
        return {
          kind: 'failed',
          failure: 'unreachable',
          reason:
            state.status === 'unavailable'
              ? `服务器「${options.server}」未连接：${state.reason}`
              : `服务器「${options.server}」未连接`,
        }
      }

      // 取消在入口就已经落定的，问都不问（同沙箱那条「已中止的信号不启动进程」）
      if (opts?.signal?.aborted === true) {
        return { kind: 'failed', failure: 'canceled', reason: '调用前已取消' }
      }

      try {
        const result = await connecting.callTool(
          { name: tool, arguments: { ...args } },
          undefined,
          {
            signal: opts?.signal,
            timeout: opts?.timeoutMs ?? callTimeoutMs,
          },
        )

        return { kind: 'result', ok: result.isError !== true, parts: partsOf(result) }
      } catch (error) {
        return failureOf(error, opts?.signal)
      }
    },

    close: release,
  }
}

/**
 * 一条**有界**的等待——到点即拒（`reason` 是拒的理由）。
 *
 * 为什么不直接用 SDK 的 `timeout`：`connect()` 那一跳的传输启动不在它的请求超时之内
 * （进程起不来时它压根没有请求可超时），故这一层自己上闸。**到点之后**
 * 由 `start()` 的 catch 收尾（`release()` 把半死的进程收掉）。
 */
async function deadline<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 一次失败 → 确定的结果。**分类次序**：取消 → 超时 → 断连 → 其余（保守：未收到结果）。 */
function failureOf(error: unknown, signal: AbortSignal | undefined): McpCallOutcome {
  // 我们主动停的——与「效果未知」是两件事，分开说（交互约束：取消不等于远端撤销）
  if (signal?.aborted === true) {
    return { kind: 'failed', failure: 'canceled', reason: '已发出取消请求' }
  }

  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      return { kind: 'failed', failure: 'timeout', reason: reasonOf(error) }
    }
    if (error.code === ErrorCode.ConnectionClosed) {
      return { kind: 'failed', failure: 'unreachable', reason: reasonOf(error) }
    }
    // 服务器答了，只是答的是「这次调用不成」——**调用是到了的**，按「结果如此」记
    return {
      kind: 'result',
      ok: false,
      parts: [{ kind: 'text', text: `服务器报错（${error.code}）：${reasonOf(error)}` }],
    }
  }

  // 认不出的错：**保守**——效果未知（可能已经执行），措辞交回工具域那一处定
  return { kind: 'failed', failure: 'unreachable', reason: reasonOf(error) }
}

/** 发现的结果 → 契约里的那三件（SDK 的形状到此为止，不外传）。 */
function toolsOf(listed: readonly { name: string; description?: string; inputSchema?: unknown }[]): readonly McpToolInfo[] {
  const tools: McpToolInfo[] = []

  for (const tool of listed) {
    if (typeof tool.name !== 'string' || tool.name.trim() === '') continue // 无名工具不可调用（同内核「无名即拒」）

    const description = typeof tool.description === 'string' ? tool.description : undefined
    tools.push({
      name: tool.name,
      ...(description === undefined ? {} : { description }),
      // 参数模式原样带过（MCP 的 inputSchema 就是 JSON Schema）；服务器没给＝空对象模式
      parameters: asSchema(tool.inputSchema),
    })
  }

  return tools
}

/** 模式那一件——**不校验、不翻译**（原样送模型；服务器自己的 schema 由它自己负责）。 */
function asSchema(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { type: 'object', properties: {} }
  }
  return value as Readonly<Record<string, unknown>>
}

/**
 * 结果里的部件 → 契约的 `McpPart`。
 *
 * **非文本部件不解析内容，但要报出它来过**（类型 / 媒体类型 / 字节数）——「明确标示
 * 暂不支持」是设计给的那条等价路（不静默丢弃）。字节数按 base64 的长度算
 * （`data` 是 base64——不真解码，省一次无谓的拷贝）。
 */
function partsOf(result: unknown): readonly McpPart[] {
  // SDK 的结果类型带索引签名（`[x: string]: unknown`）——按结构取，不引它的类型（不外传）
  const payload = (result ?? {}) as Record<string, unknown>
  const parts: McpPart[] = []
  const content = Array.isArray(payload['content']) ? payload['content'] : []

  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as Record<string, unknown>

    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push({ kind: 'text', text: block['text'] })
      continue
    }

    const type = typeof block['type'] === 'string' ? block['type'] : '未知'
    const mimeType = typeof block['mimeType'] === 'string' ? block['mimeType'] : undefined
    const data = typeof block['data'] === 'string' ? block['data'] : undefined
    const bytes = data === undefined ? undefined : base64Bytes(data)

    parts.push({
      kind: 'other',
      type,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(bytes === undefined ? {} : { bytes }),
    })
  }

  // 结构化结果（`structuredContent`）——序列化成 JSON 文本交出（消费侧不引第二套形态）
  const structured = payload['structuredContent']
  if (structured !== undefined && structured !== null) {
    const json = JSON.stringify(structured)
    if (json !== undefined) parts.push({ kind: 'structured', text: json })
  }

  return parts
}

/** base64 文本的字节数（不真解码——按长度算，去填充）。 */
function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

/** 出一句人话——`Error` 取 message，其余照字面（与工具域同一口径）。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * **起不来**那句缘由——**说人话**（这一句会上屏：开屏回执与 `--check` 都读它）。
 *
 * 由头：拉不起一个进程时，Node 抛的是 `ENOENT: no such file or directory, posix_spawn '…'`
 * ——那是**给写代码的人看的**（`posix_spawn` 对用户是噪音）。而这一类失败恰恰是 MCP 最常见的
 * 一种配置事故：命令写错、包里没装。故按 errno 译一句「哪条命令、怎么不对」——
 * **用户要改的就是那一条命令**，把它的名字摆出来。
 *
 * 认不出的错误照原样带出（不编）：那种情形下原委就是唯一的线索。
 */
function startupReason(error: unknown, config: McpServerConfig): string {
  const code = (error as { readonly code?: unknown } | null)?.code

  if (code === 'ENOENT') return `找不到可执行文件「${config.command}」（命令写错了，还是没装？）`
  if (code === 'EACCES') return `没有执行权限「${config.command}」`

  return reasonOf(error)
}
