/**
 * 共享语言 · MCP 外部工具（U38）—— **形制 · 命名 · 连接端口**。
 *
 * 出处：首批功能建设 ·「MCP 外部工具」（应用层管理连接生命周期，客户端藏在适配器后；
 * 工具域复用注册、审批、调用、取消、记录和结果回填）；交互约束 ·「MCP 查询、审批与失败恢复」。
 *
 * 本文件只放**跨包要说的那几件**（客户端封在适配器后，SDK 的类型一件都不进来）：
 *
 * - **命名与身份**（`mcpToolName` / `parseMcpToolName`）——工具唯一名里带着**已配置服务器身份**，
 *   跨服务器同名不碰撞；来源由此**可判**，不认模型参数里的自报。
 * - **配置形制**（`McpServerConfig`）——用户显式配置那一份（键在才连：**仓库里出现配置文件
 *   不等于获准运行其中的启动命令**，见 `MagicConfig.mcp`）。
 * - **连接端口**（`McpConnection`）——适配器（`@magic/mcp`）实现、工具域据以造工具定义、
 *   装配据以编排生命周期。U39 的 Streamable HTTP 是**同一个端口的另一个实现**。
 *
 * 工具名为什么长这样：内核的注册表**重名即拒**（`registry.ts`），而外部工具的名字是**服务器
 * 自己报的**——两个服务器各有一个 `echo` 是常态。加前缀与服务器名之后，两者在注册表里是
 * 两个键，模型也分得清谁是谁；前缀也把外部工具与内置工具（`exec` / `read` / …）隔开，
 * 不占它们的名字。
 */

import type { JsonSchema } from './ports.ts'

// ══ 命名与身份 ═══════════════════════════════════════════════════════

/** 外部工具名的前缀——**唯一名的一部分**（注册名 · 送模型的名字 · 记录里的名字都是它）。 */
export const MCP_TOOL_PREFIX = 'mcp__'

/**
 * 服务器名与工具名之间的分隔符。
 *
 * ⚠️ **服务器名不许含它**（配置加载器拦下并报错，见 `McpConfig`）——否则
 * `mcp__a__b__c` 就说不清是「服务器 a 的工具 b__c」还是「服务器 a__b 的工具 c」。
 * 工具名（服务器自报的那一半）不受限：解析只切**第一刀**。
 */
export const MCP_NAME_SEPARATOR = '__'

/**
 * 一个外部工具的身份——**服务器 ＋ 工具名**。
 *
 * 这一位**只从注册表来**：分发查到工具定义之后附在调用上（`ToolCall.external`），
 * 权限域据它取真实来源。模型侧给不出它（模型给的是名字，名字对不对由注册表说了算——
 * 参数里写一个 `server` 字段冒充来源，在这儿一文不值）。
 */
export type ExternalToolRef = {
  /** 配置里那个条目名（`mcp.servers` 的键）——**身份**，不是可执行文件的路径。 */
  readonly server: string
  /** 服务器自报的工具名（未加前缀的那个）。 */
  readonly tool: string
}

/** 外部工具的**注册名**——跨服务器唯一（服务器名 ＋ 工具名两件都在里面）。 */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}${MCP_NAME_SEPARATOR}${tool}`
}

/**
 * 外部工具**给人看**的那一行——`服务器 / 工具`。
 *
 * 两处同形（审批卡的标题 · 记录里那一行的名字），故只此一处产出：名字里的前缀是**注册用的
 * 编码**（为的是跨服务器唯一），不是给人读的——屏上照抄注册名就是把内部编码摊给用户看。
 *
 * ⚠️ **洗一遍控制字节**（U38 返工 B）：工具名与服务器名都可能带着**别人写的东西**
 * （服务器自报 / 模型自报），而这一行会被画进审批卡——一个换行就能伪造出一行「批准全部」。
 * 发现那一侧已经把不合规的名字**拒收**了（见 `isValidMcpToolName`），这儿再洗一道是
 * **兜底**：模型自己拼一个带换行的名字（注册表里没有它）时，画出来的仍是干干净净一行。
 */
export function mcpToolLabel(ref: ExternalToolRef): string {
  return `${sanitizeForDisplay(ref.server)} / ${sanitizeForDisplay(ref.tool)}`
}

/**
 * 送进屏面之前把**控制字节**换掉——换行 / 制表 / ESC / 行分隔符都不许原样过。
 *
 * 换成一个可见的点（`·`）而不是删掉：删掉会让 `echo\nn` 变成 `echon`（看着像个正常名字），
 * 换成点则**看得出这里原本有东西**（「拿不准的不编」那条的同一条分寸）。
 */
export function sanitizeForDisplay(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '·')
}

/**
 * 工具名那一把尺子——**服务器自报的名字也要能当工具名使**（U38 返工 B，返工 C 收窄）。
 *
 * **只许**：字母、数字、下划线、连字符、点（至少一个字符）。这是[MCP 工具命名的口径]
 * ——名字由**服务器**定，官方没要求首字符是字母数字，实际工具名里 `_echo`、`.hidden`
 * 一类都合法。
 *
 * ⚠️ **首字符不受限**（返工 C 删掉的那一条）：原先把**配置条目名**那一把尺子（配置键要
 * 拼进可执行名，另有理由）照抄到远端工具名上，`_echo` 这类**本就合法**的名字被连带拒收
 * ——多丢能力，而控制字符那件事跟首字符无关。注册名一律是 `mcp__<服务器>__<工具>`：
 * 送出去的名字**本来就以字母开头**（前缀那三个字符），首字符那一条在这儿没有要防的东西。
 *
 * 这一条要防的只有一件事：**控制字节能让服务端的话伪装成界面的话**（独立验收的固定反例：
 * 名字里带换行 + `│ n 批准全部`，渲染出来就是一行像是卡上印的选项）——字符集就是这道防线。
 *
 * **拒收的是这一件，不是这一台服务器**：其余合法工具照常注册（设计明文：单个连接失败
 * 不拖垮内置工具，同一条分寸也适用于单件工具）。
 */
export function isValidMcpToolName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name)
}

/**
 * 外部操作在审批卡上的口径——**交互约束给的那一句原话**（「文案用 `外部操作 · 效果由服务器决定`」）。
 *
 * 一处产出：卡的副题（外壳）与判据（权限域的材料）读的是同一串字——
 * 「外部工具**不假定效果可逆**」那句裁决，落到用户眼前就是这几个字。
 */
export const MCP_EXTERNAL_CAVEAT = '外部操作 · 效果由服务器决定'

/**
 * 认出一个外部工具名——不是这个形态就返回 `undefined`（内置工具名照旧是它们自己）。
 *
 * **第一刀切在服务器名之后**（服务器名不含分隔符，见 `MCP_NAME_SEPARATOR`），
 * 故工具名里带 `__` 也解析得回来。
 */
export function parseMcpToolName(name: string): ExternalToolRef | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined

  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const cut = rest.indexOf(MCP_NAME_SEPARATOR)
  // 切不出服务器名 / 工具名（`mcp__` · `mcp__x` · `mcp__x__`）＝不是一个成形的外部工具名
  if (cut <= 0 || cut >= rest.length - MCP_NAME_SEPARATOR.length) return undefined

  const tool = rest.slice(cut + MCP_NAME_SEPARATOR.length)
  if (tool === '') return undefined

  return { server: rest.slice(0, cut), tool }
}

// ══ 配置形制 ═════════════════════════════════════════════════════════

/**
 * 一个 **stdio** 服务器条目——**用户显式配置**的那一份（U38）。
 *
 * 只从配置建立连接（不扫文件、不猜）：**仓库里出现 `.mcp.json` 一类文件不等于获准运行
 * 启动命令**（设计明文）。
 *
 * `env` 里的密钥**只往子进程传**：不进日志、不进事件、不进记录、不进提示词。
 * 未列出的环境变量不外传——适配器走 SDK 的默认环境（PATH / HOME 一类），
 * **用户自己的凭据不因「起了一个 MCP 服务器」而跟着过去**。
 */
export type McpStdioConfig = {
  /** 要拉起的可执行文件（`bun` / `npx` / 某个绝对路径）。 */
  readonly command: string
  /** 命令行参数。 */
  readonly args?: readonly string[]
  /** 追加给子进程的环境变量（密钥从这儿进）。 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 一个 **Streamable HTTP** 服务器条目——**用户显式配置**的那一份（U39）。
 *
 * 与 stdio 同一条边界：**地址写在这儿才算获准连**（用户显式配置；不扫文件、不猜、不探）。
 * 不给 `authProvider`、也不走 OAuth 登录流程（首版明文不做）——**需要登录的服务明确报
 * 尚未支持**，不拿任意外部访问补足（设计明文）。要密钥就写进 `headers`。
 *
 * `headers` 里的值**是凭据**：与 stdio 的 `env` 同一条纪律——只往请求上带，
 * 不进日志、不进事件、不进记录、不进提示词（查询那一屏报的是**名字**，不是地址与头）。
 */
export type McpHttpConfig = {
  /** MCP 端点地址（`https://…/mcp` 一类，Streamable HTTP 的那一个端点）。 */
  readonly url: string
  /** 请求头（凭据从这儿进：`Authorization: Bearer …` 一类）。 */
  readonly headers?: Readonly<Record<string, string>>
}

/**
 * 一个外部服务器条目——**两种接入共用一张配置表**（U39）。
 *
 * **形制由「写了哪一位」分**：有 `url` ＝ Streamable HTTP，有 `command` ＝ stdio；
 * 两位都给 / 都不给由配置加载器当场报错（不降级、不猜——名字与接入方式都是身份，
 * 猜错一次就是接到另一台上去）。
 *
 * 为什么不做成一个带 `transport` 判别位的形状：既有配置（U38 已合主干）里没有那一位，
 * 加一个「必须写」的新位会把用户已经写好的配置**判成错的**；而 `url` / `command` 本就在
 * 那一张表里，各自只可能属于一种接入。
 */
export type McpServerConfig = McpStdioConfig | McpHttpConfig

/**
 * 这一条配置是不是 Streamable HTTP——**配置形制分家的唯一一处**（适配器按它分派）。
 *
 * 判据就是「写了 `url` 没有」，故它同时是一把**类型窄化**的尺子：分出哪一支之后，
 * 各自那几位（`url` / `command`）在类型上也跟着到位。
 */
export function isHttpConfig(config: McpServerConfig): config is McpHttpConfig {
  return 'url' in config
}

/**
 * 配置里的 `mcp` 段——`{ servers: { <条目名>: <两种接入之一的条目> } }`。
 *
 * **条目名就是身份**（工具名里带的那一段），故不许含 `__`、不许为空——形制那半归配置加载器
 * 判（报错不降级，照既有两条键的先例）。
 */
export type McpConfig = {
  readonly servers: Readonly<Record<string, McpServerConfig>>
}

// ══ 连接端口 ═════════════════════════════════════════════════════════

/**
 * 一条连接的当下状态。
 *
 * `unavailable` 带缘由（**说给人听**的一句话：起不来 / 连不上 / 没应答）。
 * 单条失败**不拖垮内置工具**——它的工具不出现在工具表里，其余照常。
 */
export type McpConnectionState =
  | { readonly status: 'connecting' }
  | { readonly status: 'available' }
  | { readonly status: 'unavailable'; readonly reason: string }

/**
 * 服务器自报的一件工具——**发现的结果**（未经内核加工的原文摘录）。
 *
 * `name` 是**服务器那边的**名字（`echo`），不是注册名（`mcp__<服务器>__echo`）——
 * 后者由工具域按 `mcpToolName` 合成。
 */
export type McpToolInfo = {
  readonly name: string
  /** 服务器给的说明；没给＝缺席（不编一句「外部工具」顶上——那种话对模型无用）。 */
  readonly description?: string
  /** 参数模式（MCP 的 `inputSchema` 就是 JSON Schema——原样带过，不翻译、不校验）。 */
  readonly parameters: JsonSchema
}

/**
 * **一件被拒收的外部工具**（U38 返工 B）——服务器报了它，我们没用。
 *
 * `tool` 是服务器自报的**原文**（可能带控制字节 —— 要显示请先过 `sanitizeForDisplay`：
 * 这条读数本身是给诊断用的，不直接进屏面）。
 */
export type McpToolRejection = {
  readonly tool: string
  /** 缘由（说给人听的一句话：哪儿不合规 / 与谁重名）。 */
  readonly reason: string
}

/**
 * 一次调用回来的**一个部件**（记录侧形态）。
 *
 * 非文本部件（图片 / 音频 / 资源）**不解析内容**，但**必须说出它来过**——
 * 「明确标示暂不支持」是设计给的另一条等价路（`首批功能建设` · MCP：非文本结果明确保留 /
 * 标明暂不支持的部件，不静默丢弃）。故这里报类型与字节数，正文不落地。
 */
export type McpPart =
  | { readonly kind: 'text'; readonly text: string }
  /** 结构化结果（`structuredContent`）——序列化成 JSON 文本交出（消费侧不引第二套形态）。 */
  | { readonly kind: 'structured'; readonly text: string }
  /** 非文本部件：类型 ＋ 媒体类型 ＋ 字节数（**算不出字节数就不给这一位**——不编 0）。 */
  | {
      readonly kind: 'other'
      readonly type: string
      readonly mimeType?: string
      readonly bytes?: number
    }

/**
 * 调用**没做成**的三例——**效果未知**是它们的共同点，措辞各自不同（见工具域 `messages.ts`）。
 *
 * 与「服务器回了 `isError`」分得很开：那是**做成了、结果如此**（`McpCallOutcome.kind: 'result'`）。
 */
export type McpFailure =
  /** 等超时（**未收到结果，远端可能已执行**——不许重试副作用不明的调用）。 */
  | 'timeout'
  /** 取消（客户端已发取消请求；**取消不等于远端撤销**）。 */
  | 'canceled'
  /** 发出去之后连接没了（**效果未知**——请求上过路，可能已经执行）。 */
  | 'unreachable'
  /**
   * **这一次压根没发出去**（连接未建立 / 已释放 / 已断开）。
   *
   * 与 `unreachable` 分得很开，是返工 A 的一条判据：「后续调用区分**本次未发送**与
   * **已经发送但效果未知**」——后者要人核对，前者不用（什么都没发生）。
   */
  | 'not-sent'

/** 一次调用的结果——**判别式**（做成了 / 没做成两路，与沙箱原语同一姿势）。 */
export type McpCallOutcome =
  | {
      readonly kind: 'result'
      /** 服务器自己说这次是不是错（MCP 的 `isError`）——**调用是成了的**。 */
      readonly ok: boolean
      /** 部件（按收到序；文本 / 结构化 / 非文本混在一起）。 */
      readonly parts: readonly McpPart[]
    }
  | { readonly kind: 'failed'; readonly failure: McpFailure; readonly reason: string }

/**
 * 一条 MCP 连接——**适配器藏在它后面**（SDK 的类型一件都不出）。
 *
 * 三件事各有归属：`tools()` 是发现的结果（连接可用时才有内容）· `call` 是调用
 * （超时 / 取消 / 断连都收敛成确定的结果，**不抛**）· `close` 是释放
 * （stdio 是关 stdin → 等 → SIGTERM → SIGKILL；HTTP 是断流 ＋ 终止会话，见传输规范 · Shutdown）。
 *
 * 两种接入（stdio · Streamable HTTP）实现的是**同一个端口**：外面那条链（发现 → 审批 →
 * 调用 → 回填）一字不分叉——换的只是适配器里那一跳。
 */
export interface McpConnection {
  /** 配置里的条目名（身份）。 */
  readonly server: string
  /** 哪一种接入——两种连线在同一张表里，这一格说明它是怎么连上的。 */
  readonly transport: 'stdio' | 'http'
  readonly state: McpConnectionState
  /**
   * 发现到的工具（未连上＝空表）——**这一份就是会被注册的那一份**。
   *
   * 名字不合规的、同一台服务器重名的，在发现那一趟就**拒收**了（见 `rejected`）——
   * 故「列表」与「注册」从构造上一致：不会出现「查得到两件、只注册了一件」那种账
   * （独立验收的问题 6 要的正是这一条）。
   */
  tools(): readonly McpToolInfo[]
  /**
   * **发现时拒收的那些**（连同缘由）——**一处产出，两处要读**：`--check` 逐条报出来，
   * 开屏回执说一句「有几件没进来」。空表＝一件都没拒。
   */
  readonly rejected: readonly McpToolRejection[]
  /**
   * 调一次外部工具。
   *
   * `opts.signal` 取消在途（**已发出的取消请求照实报**，不称远端撤销）；
   * `opts.timeoutMs` 缺省＝实现级常量（装配可覆盖，为的是用例不必真等两分钟）。
   */
  call(
    tool: string,
    args: Readonly<Record<string, unknown>>,
    opts?: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
  ): Promise<McpCallOutcome>
  /** 释放**本进程创建**的子进程与资源（不碰用户自己的服务）。 */
  close(): Promise<void>
  /**
   * 显式重连（`/mcp reconnect <服务器>`）——**放掉旧的、再走一趟起手与发现**。
   *
   * 重做的是**连接与发现**，不是任何一次业务调用：断连 / 超时之后那次效果未知的调用
   * **不在这里重放**（设计明文）。工具表在重连完成前作废（发现没回来就不知道它有什么），
   * 回来后按新的那一份算。失败落成 `unavailable`（与起手同一条：不抛）。
   *
   * 不连上 / 已经断了 / 从没起过的连接都调得：那一趟就是一次起手。
   */
  reconnect(): Promise<void>
}
