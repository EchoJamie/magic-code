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
 * ## 七条规矩，各有出处
 *
 * 前四条出在首轮（传输规范 · stdio 的 Shutdown 与 stderr 两条）：
 * 1. **stderr 不外泄**——规范允许客户端忽略服务器的 stderr；而本进程正跑着全屏 TUI，
 *    子进程往 stderr 写一行就能把屏面搅乱。故固定 `stderr: 'ignore'`。
 * 2. **环境不外溢**——SDK 的默认环境只带 PATH / HOME 一类，配置里 `env` 的那些**追加**
 *    在它之上。**用户自己的凭据不因为「起了一个 MCP 服务器」就跟着过去。
 * 3. **关闭照规范的次序**——关 stdin → 等 → 杀（SDK 的 `close()` 就是这一套）。
 * 4. **起手有界**——连不上 / 不应答的服务器**不能把启动拖住**（`connectTimeoutMs`）。
 *
 * 后三条是返工 A 补的（独立验收：接续漏工具、只读第一页、后代残留、断连仍报可用）：
 * 5. **发现要翻完分页**（`discover`）——只读第一页等于给模型一份**假的**工具表：它没看见的
 *    那些不是「服务器没有」，是**我们没取**。整体预算 ＋ 坏游标边界，两条都写死在 `discover`。
 * 6. **读数跟着连接走**（`markUnavailable`）——服务器退了 / 我们放了，状态当场作废
 *    （`available` 挂在一条没有对端的连接上是假账）；**本次没发出**与**发出去后没了**
 *    也分成两种结果（契约 `McpFailure`）。
 * 7. **自有进程组一起收**（`stdio-transport.ts`）——归属在**启动那一刻**定死（自己 spawn、
 *    `detached` 自成一组）；收尾按**组**发信号，服务器再拉的那一层（`npx` → `node`、
 *    用户脚本起的后台件、**调用中途刚起就随父崩掉的那些**）一并收走。
 *
 * 调用这一层**不抛**——「没收到结果」是结果的一种，模型要据此决定下一步（同沙箱原语
 * 那条「失败形态分两路」的姿势）。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import type {
  McpCallOutcome,
  McpConnection,
  McpConnectionState,
  McpPart,
  McpServerConfig,
  McpToolInfo,
  McpToolRejection,
} from '@magic/contracts'
import { isValidMcpToolName, sanitizeForDisplay } from '@magic/contracts'
import { createOwnedStdioTransport } from './stdio-transport.ts'
import type { OwnedStdioTransport } from './stdio-transport.ts'

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

/**
 * 工具分页的**页数**上限（实现级常量）——坏游标的第二道防线。
 *
 * 主防线是「游标不许重复」（同一个游标回来＝不前进，当场停）；这一道防的是
 * **一直给新游标**那种（每页一件、游标无穷）。两道都到不了「无限等」。
 */
export const MCP_MAX_TOOL_PAGES = 50

/** 连接没了的两句缘由——**我们放的**还是**它自己走的**，读数上分得开。 */
const RELEASED = '连接已释放'
const SERVER_GONE = '服务器退出了'

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
  /**
   * 发现时**拒收**的那些（名字不合规 / 同一台服务器重名）——连缘由一起交回装配，
   * 由它报在 `--check` 与开屏那一句上（见契约 `McpToolRejection`）。
   */
  let rejected: readonly McpToolRejection[] = []
  let client: Client | undefined
  let transport: OwnedStdioTransport | undefined
  let started = false
  /** 这一次关闭是不是**我们自己发起的**（决定那句缘由怎么说）。 */
  let releasing = false
  /** **收尾那一个 promise**（复入 close 共享它——见 `release`）。 */
  let closing: Promise<void> | undefined
  /**
   * **自有进程组**那一支（见 `stdio-transport.ts`）——归属只有这一个判据：
   * 组是我们 spawn 出来的那个（`detached`），组里有什么就收什么。
   */
  let owned: OwnedStdioTransport | undefined

  /**
   * 这条连接不再是「可用」——客户端一定作废；**工具表分两种情况**（返工 A）：
   *
   * - **断了**（服务器自己退了 / 传输断了）：工具表**留着**。「这条连接上有什么」是它上一次
   *   说过的实话；留着它，模型下一轮照旧调得到、且拿到的是一句**说清楚了的话**
   *   （`未发出——服务器未连接（服务器退出了）`，见契约 `McpFailure` 的 `not-sent`），
   *   而不是「未注册的工具」那种像是自己写错名字的答复。U39 的显式重连也接在这一处
   *   ——重连之前，这份表就是「它曾经有什么」。
   * - **我们放了**（`release()`）：工具表**清空**。这一条连接到此为止，不会再被用——
   *   留着一份永远不会被调通的名录是假账（读数上「不可用 ＋ 空表」才是它的实况）。
   */
  function markUnavailable(reason: string, options: { readonly keepTools?: boolean } = {}): void {
    client = undefined
    if (options.keepTools !== true) {
      discovered = []
      rejected = []
    }
    state = { status: 'unavailable', reason }
  }

  /** 收尾那句话——**没收干净就说没收干净**（不拿空表冒充「已收干净」）。 */
  function cleanupNote(survivors: readonly number[]): string | undefined {
    if (survivors.length === 0) return undefined
    return `有进程没能收掉（进程组 ${survivors.join(' ')}）`
  }

  /** 把收尾那句话接到当下读数上（崩了那一路是异步收的，收完再补这句话）。 */
  function noteCleanup(line: string | undefined): void {
    if (line === undefined || state.status !== 'unavailable') return
    state = { status: 'unavailable', reason: `${state.reason}；${line}` }
  }

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
      // **自有 stdio 传输**（见 `stdio-transport.ts`）：自己 spawn、自成进程组——
      // 归属在启动那一刻定死，收尾按组收（不靠事后数进程树那样的时点与复用赌博）。
      // 环境（默认那几个 ＋ 配置里的）、stderr 不外泄（头注 1 / 2）都在那一层里。
      const spawned = createOwnedStdioTransport({
        command: options.config.command,
        ...(options.config.args === undefined ? {} : { args: [...options.config.args] }),
        ...(options.config.env === undefined ? {} : { env: { ...options.config.env } }),
      })
      owned = spawned
      transport = spawned

      const connecting = new Client(CLIENT_INFO, { capabilities: {} })
      // **连接的生死投影到读数上**（头注 6）：服务器自己退了 / 传输断了，这儿当场改状态。
      // 起手那一趟的失败不归它说（那条路由 `catch` 给更准的缘由——ENOENT 一类）。
      connecting.onclose = (): void => {
        // **它自己崩了**：传输那一层**当场按组收**（组员还在组里，谁都跑不掉——
        // 「服务器先崩，之后再 close」再不是漏洞：收的是组，不靠崩前数过什么）。
        // 收得怎么样**如实记在读数上**：还有没退的就说出来（不许拿空表冒充已收干净）。
        if (!releasing && owned !== undefined) {
          void owned.shutdown().then((survivors) => noteCleanup(cleanupNote(survivors)))
        }

        if (state.status !== 'available') return
        // **我们放的**（`release()` 那条路）与**它自己走的**是两件事：缘由不同，
        // 工具表也两样（放了＝清空，断了＝留着——见 `markUnavailable`）
        if (releasing) markUnavailable(RELEASED)
        else markUnavailable(SERVER_GONE, { keepTools: true })
      }

      await deadline(
        connecting.connect(spawned, { timeout: connectTimeoutMs }),
        connectTimeoutMs,
        `连接超时（${connectTimeoutMs}ms）`,
      )

      // **翻完分页才算发现完**（头注 5）——没取全就放行，等于给模型一份假表
      const found = await discover(connecting, connectTimeoutMs)
      // **收进注册表之前先过筛**（返工 B）：不合规的、重名的，一件都不进——
      // 于是 `tools()` 与实际注册的那一份**从构造上一致**
      const screened = screen(found)

      client = connecting
      discovered = screened.tools
      rejected = screened.rejected
      state = { status: 'available' }
    } catch (error) {
      state = { status: 'unavailable', reason: startupReason(error, options.config) }
      // 半途死掉的进程要收干净（连到一半也算「本进程拉起过它」）
      await release()
    }
  }

  /**
   * 释放（幂等）——**自有进程组**那一支走完整段（关 stdin → 等 → 组 TERM → 等 → 组 KILL）。
   *
   * ⚠️ **复入共享同一个 promise**（复验点过的那一条）：收尾要真等（本机实测一次正常收尾
   * 约 2 秒），第二次 `close()` 5 毫秒后再来是常事。若它另起一趟、或看见 `transport` 已经
   * 置空就**直接返回**，那就成了「没等却宣称已释放」——服务器还活着，读数已经写「连接已释放」。
   * 故这一支整体只跑一次，谁调都拿同一个 `closing`：**要等就一起等**。
   *
   * 读数也**只在收尾落定之后**才改（写在同一段里）——顺序是「先收干净，再说已释放」。
   */
  function release(): Promise<void> {
    closing ??= releaseOnce()
    return closing
  }

  async function releaseOnce(): Promise<void> {
    const spawned = transport
    transport = undefined
    client = undefined
    let note: string | undefined

    if (spawned !== undefined) {
      releasing = true
      // 传输那一层自己就走完整段（关 stdin → 等 → 组 TERM → 等 → 组 KILL），
      // 并把它**没收掉的**交回来——收尾结果据此如实写进读数
      const survivors = await spawned.shutdown()
      releasing = false
      note = cleanupNote(survivors)
    }

    // **放了手：工具表一定清空**（复验退回的第二条：断了之后再 close，表也得清——
    // 「断了留着」只在**还活着的那条连接**上成立，一放就不是那个处境了）。
    // 缘由则保留更好的那一份（起手失败 / 服务器退出都比「连接已释放」说得更多）；
    // **收尾结果接在后面**：没收干净就说没收干净。
    discovered = []
    const reason = state.status === 'unavailable' ? state.reason : RELEASED
    state = { status: 'unavailable', reason: note === undefined ? reason : `${reason}；${note}` }
  }

  return {
    start,
    server: options.server,

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

      // 取消在入口就已经落定的，问都不问（同沙箱那条「已中止的信号不启动进程」）。
      // ⚠️ 这一路**没有发出去**——故归 `not-sent`（「已发出取消请求」那句话在这儿不成立）
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
 * 发现 —— **翻完每一页**（头注 5）。
 *
 * 三道闸都在这一处，缺一个就能被服务器拖住：
 * - **整体预算**（`budgetMs`）——分页的等待与连接共用同一笔预算：翻页翻到超时＝发现不完整，
 *   当场停（不是「取到多少算多少」——那正是给模型一份假表的来路）；
 * - **游标不重复**——同一个游标回来＝它不前进，停；
 * - **页数上限**——一直给新游标（每页一件、游标无穷）也停。
 *
 * 停下来的方式一律是**抛**：由 `start()` 的 catch 收敛成「不可用 ＋ 缘由」——
 * 发现不全的连接**不当成可用**（「首轮模型请求前完成发现」是设计的明文）。
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

/**
 * 一次失败 → 确定的结果。**分类次序**：取消 → 超时 → 断连 → 其余（保守：未收到结果）。
 *
 * 注意这儿**没有**「没发出去」那一支——那个判断在 `call` 的门口就做完了（连接不在，
 * 压根走不到这里）。能走到这儿的都是**已经发出去**的请求：故归「效果未知」那一侧。
 */
function failureOf(error: unknown, signal: AbortSignal | undefined): McpCallOutcome {
  // 我们主动停的——与「效果未知」是两件事，分开说（交互约束：取消不等于远端撤销）
  if (signal?.aborted === true) {
    return { kind: 'failed', failure: 'canceled', reason: '已发出取消请求' }
  }

  if (error instanceof McpError) {
    // **这两句说人话**（返工 B 看帧时改的）：SDK 给的是 `MCP error -32000: Connection closed`
    // 那一串——那是给写代码的人看的，而这条**会上屏、也会进模型**（超时 / 断连那两句的括号里）。
    // 服务器自己报的错不在此列（见下）：那时「服务器说了什么」才是要原样带出的东西。
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

/**
 * **过筛**（U38 返工 B）——把服务器报来的那一份筛成「可以进注册表的那一份」。
 *
 * 两条规矩，各自都有独立验收的固定反例：
 *
 * 1. **名字不合规的不进**（`isValidMcpToolName`）：控制字节（换行 / ESC）能让服务端返回的
 *    文字在审批卡上**伪装成界面自己的话**（反例：名字里带换行 ＋ `│ n 批准全部`）；
 *    这个名字还会被拼进送给模型的工具名，各家供应商对函数名字符集也有限制。
 * 2. **同一台服务器重名的，冲突的那几件全拒**（不是「取先到的一件」）：重名意味着
 *    「哪一件在跑」说不清——留一件就是让展示给模型的那份契约与服务端实际执行的含义
 *    对不上（反例：两件 `echo` 描述不同，旧的实现静默取了第一件，而 `tools()` 报两件）。
 *
 * **拒的是这一件，不是这一台服务器**：其余合法工具照常，内置工具更不受影响。
 * 缘由都记进 `rejected`——诊断要有，且要能说清「哪一件、为什么」。
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
        reason: `工具名不合规（${describeName(tool.name)}）——须是字母数字开头、只含字母数字与 . _ -`,
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
