/**
 * 连接内核 —— **两种传输共用的一条链**。
 *
 * 发现 · 调用 · 结果转换 · 状态与释放的规矩都在这一层，与传输无关；换传输只换
 * `TransportDriver` 那三件（怎么造一条传输、起不来的缘由怎么说、连接自己没了怎么说）。
 * stdio（`stdio.ts`）与 Streamable HTTP（`http.ts`）各是这一份的一个驱动。
 *
 * 两条贯穿全文件的姿势：
 * - **调用与起手都不抛**：「没收到结果」是结果的一种（模型要据此决定下一步），
 *   起不来是**这一条连接不可用**（报缘由、别拖垮内置工具与其他连接）。
 * - **读数跟着连接走**：服务器退了 / 我们放了手，状态当场作废——`available` 挂在一条
 *   没有对端的连接上是假账。**本次没发出**与**发出去后没了**是两种结果（契约 `McpFailure`）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type {
  McpCallOutcome,
  McpConnection,
  McpConnectionState,
  McpPart,
  McpToolInfo,
  McpToolRejection,
} from '@magic/contracts'
import { isValidMcpToolName, sanitizeForDisplay } from '@magic/contracts'

/** 客户端自报的名字（服务器侧日志里看到的就是这个）。 */
const CLIENT_INFO = { name: 'magic-code', version: '0.0.0' } as const

/** 连接 / 发现的上限（毫秒）——连不上、不应答的服务器不能把启动拖住。 */
export const MCP_CONNECT_TIMEOUT_MS = 10_000

/** 一次工具调用的上限（毫秒）——缺省值，装配可覆盖（用例不必真等两分钟）。 */
export const MCP_CALL_TIMEOUT_MS = 120_000

/**
 * 工具分页的**页数**上限（实现级常量）——坏游标的第二道防线。
 *
 * 主防线是「游标不许重复」（同一个游标回来＝不前进，当场停）；这一道防的是**一直给新游标**
 * 那种（每页一件、游标无穷）。两道都到不了「无限等」。
 */
export const MCP_MAX_TOOL_PAGES = 50

/** 我们放的还是它自己走的——读数上分得开。 */
const RELEASED = '连接已释放'

/**
 * 一条**自己造、自己收**的传输：官方的 `Transport` 三件 ＋ `shutdown()`。
 *
 * `shutdown()` 交回**没收干净**那一句（`undefined`＝收干净了）——收尾结果如实写进读数。
 * 幂等、有界，且**不碰用户自己的服务**（各传输自己保证：stdio 只收自有进程组，
 * HTTP 只断自己的流与自己的会话）。
 */
export interface OwnedTransport extends Transport {
  shutdown(): Promise<string | undefined>
}

/** 一种传输要告诉内核的四件事。 */
export type TransportDriver = {
  /** 哪一种接入——读数上要说得出来（`/mcp` 那一屏按它分列）。 */
  readonly kind: 'stdio' | 'http'
  /** 造一条**新**传输（每一趟起手各一条）。**造了不等于连了**。 */
  open(): OwnedTransport
  /** 起手那一趟失败 → 一句人话（会上屏：开屏回执与 `--check` 都读它）。 */
  startupReason(error: unknown): string
  /** 这条连接**自己没了**时那句缘由（stdio 是「服务器退出了」，HTTP 是「连不上了」）。 */
  readonly goneReason: string
}

export type ConnectionOptions = {
  /** 配置里的条目名（身份）。 */
  readonly server: string
  readonly driver: TransportDriver
  /** 连接 / 发现的上限（毫秒）——缺省 `MCP_CONNECT_TIMEOUT_MS`。 */
  readonly connectTimeoutMs?: number
  /** 一次调用的上限（毫秒）——缺省 `MCP_CALL_TIMEOUT_MS`。 */
  readonly callTimeoutMs?: number
}

/** 内核造出来的那一条连接：端口六件 ＋ 起手与重连。 */
export interface Connection extends McpConnection {
  /** 起手 —— 拉起传输 · 握手 · 发现。**不抛**：失败落成 `state.unavailable`。 */
  start(): Promise<void>
}

/** 造一条连接——**造了不等于连了**（`start()` 才起手；重连走 `reconnect()`）。 */
export function createConnection(options: ConnectionOptions): Connection {
  const connectTimeoutMs = options.connectTimeoutMs ?? MCP_CONNECT_TIMEOUT_MS
  const callTimeoutMs = options.callTimeoutMs ?? MCP_CALL_TIMEOUT_MS

  let state: McpConnectionState = { status: 'connecting' }
  let discovered: readonly McpToolInfo[] = []
  /** 发现时拒收的那些（名字不合规 / 同一台服务器重名）——连同缘由交回装配。 */
  let rejected: readonly McpToolRejection[] = []
  let client: Client | undefined
  /** 当下这一条传输（收尾与复入都按它说）。 */
  let transport: OwnedTransport | undefined
  let started = false
  /** 这一次关闭是不是**我们自己发起的**（决定那句缘由怎么说）。 */
  let releasing = false
  /** **收尾那一个 promise**（复入 close 共享它——见 `release`）。 */
  let closing: Promise<void> | undefined
  /**
   * 起手的**第几趟**——重连会让它 +1。
   *
   * 旧趟的一切回落（起手失败 / 传输的 `onclose`）都拿这个数与自己那一趟对：对不上就只收
   * 自己的摊，**不写读数**（否则一次重连就能被上一趟的迟到回落盖掉）。
   */
  let generation = 0

  /**
   * 这条连接不再是「可用」——客户端一定作废；**工具表分两种情况**：
   *
   * - **断了**（服务器自己退了 / 传输断了）：工具表**留着**。「这条连接上有什么」是它上一次
   *   说过的实话；留着它，模型下一轮照旧调得到、且拿到的是一句说清楚了的话
   *   （`未发出——本次调用没有送出去（服务器退出了）`），而不是「未注册的工具」那种
   *   像是自己写错名字的答复。
   * - **我们放了**（`release()`）：工具表**清空**。这一条连接到此为止，不会再被用——
   *   留着一份永远不会被调通的名录是假账（读数上「不可用 ＋ 空表」才是它的实况）。
   */
  function markUnavailable(reason: string, opts: { readonly keepTools?: boolean } = {}): void {
    client = undefined
    if (opts.keepTools !== true) {
      discovered = []
      rejected = []
    }
    state = { status: 'unavailable', reason }
  }

  /** 收尾那句话接到当下读数上（只接在「不可用」上——别的状态没有它的位置）。 */
  function noteCleanup(line: string | undefined): void {
    if (line === undefined || state.status !== 'unavailable') return
    state = { status: 'unavailable', reason: `${state.reason}；${line}` }
  }

  /**
   * 一趟起手：造传输 → 握手 → 发现。**失败一律落成「不可用 ＋ 缘由」**，绝不抛给调用方。
   *
   * 一个服务器起不来是**常态**（命令写错、包里没装、地址不对、对端要登录），而它不是本进程
   * 的异常——它是「这一条连接不可用」，报出来、别拖垮别的工具。
   */
  async function attempt(): Promise<void> {
    const mine = (generation += 1)
    const owned = options.driver.open()
    transport = owned

    try {
      const connecting = new Client(CLIENT_INFO, { capabilities: {} })
      // 连接的生死投影到读数上。绑的是**这一条**传输（`owned`）——重连之后旧那条的 onclose
      // 不许去收新的那条，也不许改新那一趟的读数。
      connecting.onclose = (): void => {
        if (mine !== generation) return
        // 它自己没的（不是我们关的）：这一条传输当场收摊，收得怎么样如实记在读数上
        // （不许拿空的收尾结果冒充已收干净）
        if (!releasing) void owned.shutdown().then(noteCleanup)
        if (state.status !== 'available') return
        if (releasing) markUnavailable(RELEASED)
        else markUnavailable(options.driver.goneReason, { keepTools: true })
      }

      // 起手有界：连不上 / 不应答的服务器不能把启动拖住
      await deadline(
        connecting.connect(owned, { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `连接超时（${connectTimeoutMs}ms）`,
      )

      // **翻完分页才算发现完**——没取全就放行，等于给模型一份假表
      const found = await discover(connecting, connectTimeoutMs)
      const screened = screen(found)

      client = connecting
      discovered = screened.tools
      rejected = screened.rejected
      state = { status: 'available' }
    } catch (error) {
      const note = await drop(owned)
      if (mine !== generation) return
      state = { status: 'unavailable', reason: options.driver.startupReason(error) }
      noteCleanup(note)
    }
  }

  /** 收掉一条**没连成**的传输（连到一半也算「本进程拉起过它」），交回收尾那句话。 */
  async function drop(owned: OwnedTransport): Promise<string | undefined> {
    if (transport === owned) transport = undefined
    return owned.shutdown()
  }

  async function start(): Promise<void> {
    if (started) return
    started = true
    await attempt()
  }

  /**
   * 显式重连——**放掉旧的、再走一趟起手与发现**（不重放任何一次业务调用）。
   *
   * 工具表在重连期间作废：发现没回来就不知道这条连接上有什么，留一份旧名录是假账。
   */
  async function reconnect(): Promise<void> {
    await release()
    closing = undefined
    releasing = false
    discovered = []
    rejected = []
    state = { status: 'connecting' }
    await attempt()
  }

  /**
   * 释放（幂等）——**复入共享同一个 promise**：收尾要真等（stdio 那一侧一次正常收尾约 2 秒），
   * 第二次 `close()` 几毫秒后再来是常事。若它另起一趟、或看见传输已置空就直接返回，
   * 那就成了「没等却宣称已释放」——服务器还活着，读数已经写「连接已释放」。故这一支整体
   * 只跑一次，谁调都拿同一个 `closing`：**要等就一起等**。
   *
   * 读数也只在**收尾落定之后**才改：顺序是「先收干净，再说已释放」。
   */
  function release(): Promise<void> {
    closing ??= releaseOnce()
    return closing
  }

  async function releaseOnce(): Promise<void> {
    const owned = transport
    transport = undefined
    client = undefined
    let note: string | undefined

    if (owned !== undefined) {
      releasing = true
      // 传输那一层自己就走完整段收尾，并把它没能收掉的说成一句话交回来
      note = await owned.shutdown()
      releasing = false
    }

    // 放了手：工具表与拒收表都清空。缘由保留说得更多的那一份（起手失败 / 服务器自己没了
    // 都比「连接已释放」说得更多），**收尾结果接在后面**：没收干净就说没收干净。
    discovered = []
    rejected = []
    const reason = state.status === 'unavailable' ? state.reason : RELEASED
    state = { status: 'unavailable', reason: note === undefined ? reason : `${reason}；${note}` }
  }

  return {
    start,
    reconnect,
    server: options.server,
    transport: options.driver.kind,

    get state() {
      return state
    },

    tools: () => discovered,

    get rejected() {
      return rejected
    },

    async call(tool, args, opts): Promise<McpCallOutcome> {
      const connecting = client
      if (connecting === undefined) {
        // 没连上 / 已经断了 / 已经放了手——**这一次调用没发出去**（与「效果未知」分开报）
        return {
          kind: 'failed',
          failure: 'not-sent',
          reason: state.status === 'unavailable' ? state.reason : '连接尚未就绪',
        }
      }

      // 取消在入口就已经落定的，问都不问。这一路**没有发出去**——故归 `not-sent`
      // （「已发出取消请求」那句话在这儿不成立）
      if (opts?.signal?.aborted === true) {
        return { kind: 'failed', failure: 'not-sent', reason: '取消发生在发出去之前' }
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
 * 发现 —— **翻完每一页**。
 *
 * 只读第一页等于给模型一份**假的**工具表：它没看见的那些不是「服务器没有」，是**我们没取**。
 * 三道闸都在这一处，缺一个就能被服务器拖住：
 * - **整体预算**（`budgetMs`）——分页的等待与连接共用同一笔预算（翻到超时＝发现不完整，当场停）；
 * - **游标不重复**——同一个游标回来＝它不前进，停；
 * - **页数上限**——一直给新游标也停。
 *
 * 停下来的方式一律是**抛**：由 `attempt()` 的 catch 收敛成「不可用 ＋ 缘由」——
 * 发现不全的连接**不当成可用**（首轮模型请求前完成发现）。
 */
async function discover(connecting: Client, budgetMs: number): Promise<readonly McpToolInfo[]> {
  const found: McpToolInfo[] = []
  const visited = new Set<string>()
  const deadlineAt = Date.now() + budgetMs
  let cursor: string | undefined

  for (let page = 0; ; page += 1) {
    if (page >= MCP_MAX_TOOL_PAGES) {
      throw new Error(`工具分页超过 ${MCP_MAX_TOOL_PAGES} 页——停止发现（服务器给的游标可疑）`)
    }

    const left = deadlineAt - Date.now()
    if (left <= 0) throw new Error(`列工具超时（整体 ${budgetMs}ms 内只取到 ${found.length} 件）——发现不完整`)

    const listed = await deadline(
      connecting.listTools(cursor === undefined ? undefined : { cursor }, { timeout: left }),
      left,
      `列工具超时（整体 ${budgetMs}ms）——发现不完整`,
    )

    found.push(...toolsOf(listed.tools))

    const next = listed.nextCursor
    // 末页：`nextCursor` 缺席 / 空串 / `null` 三种写法都算到头（规范说它是可选位）
    if (next === undefined || next === null || next === '') return found
    if (visited.has(next)) {
      throw new Error(`服务器把游标指回了取过的那一页（${next}）——分页不前进，停止发现`)
    }

    visited.add(next)
    cursor = next
  }
}

/**
 * 一条**有界**的等待——到点即拒（`reason` 是拒的理由）。
 *
 * 为什么不直接用 SDK 的 `timeout`：`connect()` 那一跳的传输启动不在它的请求超时之内
 * （进程起不来 / 地址写错时它压根没有请求可超时），故这一层自己上闸。
 */
export async function deadline<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
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

/**
 * 一次失败 → 确定的结果。**分类次序**：取消 → 超时 → 断连 → 其余（保守：未收到结果）。
 *
 * 注意这儿**没有**「没发出去」那一支——那个判断在 `call` 的门口就做完了（连接不在，
 * 压根走不到这里）。能走到这儿的都是**已经发出去**的请求：故归「效果未知」那一侧。
 */
function failureOf(error: unknown, signal: AbortSignal | undefined): McpCallOutcome {
  // 我们主动停的——与「效果未知」是两件事，分开说（取消不等于远端撤销）
  if (signal?.aborted === true) {
    return { kind: 'failed', failure: 'canceled', reason: '已发出取消请求' }
  }

  if (error instanceof McpError) {
    // SDK 给的是 `MCP error -32000: Connection closed` 那一串——那是给写代码的人看的，
    // 而这条会上屏、也会进模型。服务器自己报的错不在此列（见下）：那时「服务器说了什么」
    // 才是要原样带出的东西。
    if (error.code === ErrorCode.RequestTimeout) {
      return { kind: 'failed', failure: 'timeout', reason: '等超时了——一直没等到回应' }
    }
    if (error.code === ErrorCode.ConnectionClosed) {
      return { kind: 'failed', failure: 'unreachable', reason: '请求发出之后连接断了' }
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
    if (typeof tool.name !== 'string' || tool.name.trim() === '') continue // 无名工具不可调用

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

/**
 * **过筛** ——把服务器报来的那一份筛成「可以进注册表的那一份」。
 *
 * 两条规矩：
 *
 * 1. **名字不合规的不进**（`isValidMcpToolName`）：控制字节（换行 / ESC）能让服务端返回的
 *    文字在审批卡上**伪装成界面自己的话**。只按字符集判，不另加「首字符」那一条。
 * 2. **同一台服务器重名的，冲突的那几件全拒**（不是「取先到的一件」）：重名意味着
 *    「哪一件在跑」说不清——留一件就是让展示给模型的那份契约与服务端实际执行的含义对不上。
 *
 * **拒的是这一件，不是这一台服务器**：其余合法工具照常，内置工具更不受影响。
 */
function screen(found: readonly McpToolInfo[]): {
  readonly tools: readonly McpToolInfo[]
  readonly rejected: readonly McpToolRejection[]
} {
  const rejected: McpToolRejection[] = []
  const kept: McpToolInfo[] = []
  /** 名字 → 出现几次（先数一遍：重名要**全拒**，不能边看边留）。 */
  const counts = new Map<string, number>()
  for (const tool of found) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1)

  for (const tool of found) {
    if (!isValidMcpToolName(tool.name)) {
      rejected.push({
        tool: tool.name,
        reason: `工具名不合规（${describeName(tool.name)}）——只许字母、数字、下划线、连字符与点`,
      })
      continue
    }

    if ((counts.get(tool.name) ?? 0) > 1) {
      rejected.push({
        tool: tool.name,
        reason: `与同一台服务器上的另一件重名（共 ${counts.get(tool.name)} 件）——重名的都拒收，不替谁挑一件`,
      })
      continue
    }

    kept.push(tool)
  }

  return { tools: kept, rejected }
}

/** 把不合规的名字说清楚——带控制字节时**只说「哪里有控制字节」**，不把原样贴出来。 */
function describeName(name: string): string {
  const printable = sanitizeForDisplay(name)
  return printable === name ? `「${name}」` : `「${printable}」里有控制字节`
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
 * **非文本部件不解析内容，但要报出它来过**（类型 / 媒体类型 / 字节数）——「明确标示暂不支持」
 * 是设计给的那条等价路（不静默丢弃）。字节数按 base64 的长度算（不真解码，省一次无谓拷贝）。
 */
function partsOf(result: unknown): readonly McpPart[] {
  // SDK 的结果类型带索引签名——按结构取，不引它的类型（不外传）
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
