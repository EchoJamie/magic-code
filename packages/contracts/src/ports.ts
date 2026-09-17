/**
 * 跨域端口（九签名 ＋ 端口内类型）——已冻结 v0。
 *
 * 出处：技术方案 · 领域划分（「契约（耦合契约）」· 端口签名 v0 · 依赖规则）。
 * **依赖倒置的落点**——域包只 import `@magic/contracts`（＋许可外部库）；域之间互不 import、
 * 域不认知外壳与装配；**装配根是唯一 import 具体实现的地方**。
 *
 * 两个端口之外的东西也在此（技术方案 · 领域划分：端口内类型）——
 * **沙箱原语**（`exec` / 读 / 写 / 列 / 匹配）与**工具规格**（`ToolSpec` / 危险归类 / 工具集 v1）。
 *
 * **三个 id 各有空间，不许混**（技术方案 · 领域划分 · 端口内类型）：
 * ① `ToolCall.id` ＝**供应商侧**调用 id（只用于回填配对）；
 * ② 事件的 `call`（`RecordId` 空间）＝贯穿调用链（请求 / 询问 / 裁决 / 结果）的那次调用；
 * ③ `DecisionId` ＝裁决配对的**请求事件** id。
 */

import type { Command, UserInput } from './control.ts'
import type { Content, Entry, EntryRange, NewEntry, SessionSummary } from './entries.ts'
import type { Decision, EventDataOf, EventKind, KernelEvent, OutputDelta } from './events.ts'
import type { BlobRef, DecisionId, RecordId, SessionId, TurnId } from './ids.ts'

// ══ 端口 ══════════════════════════════════════════════════════════════

/** 各域 → 装配扇出（技术方案 · 领域划分：事件不经调用箭头，各域直发 `EventSink`）。 */
export type EventSink = {
  emit(event: KernelEvent): void
}

/** 控制域 → 对话域。多会话（阶段 2）的新建 / 切换 / 列表在此扩展。 */
export interface ConversationService {
  submit(input: UserInput): void // input.submit
  interrupt(): void // turn.interrupt
}

/** 对话域 → 模型域。 */
export interface ModelGateway {
  stream(req: ModelRequest, opts: { signal?: AbortSignal }): ModelStream
}

/** 对话域 → 工具域。闸门在 `invoke` 路径内（不可绕过）。 */
export interface ToolRuntime {
  definitions(): readonly ToolSpec[]
  invoke(
    call: ToolCall,
    opts: { signal?: AbortSignal; onOutput?: (d: OutputDelta) => void },
  ): Promise<ToolResult>
}

/** 工具域 → 权限域。 */
export interface PermissionGate {
  /**
   * 请裁决。
   *
   * `callRef` ＝**该次 `tool.call` 事件的 id**（事件载荷 `call` 的来处）——「请求 → 询问 →
   * 裁决 → 结果」四事件串链的依据（审计与阶段 2 恢复的**在途识别**都按它找）。
   * 权限域自己拿不到（那是工具域发的事件），故由调用方传入；**必填**——
   * 不设哨兵兜底：静默的 `-1` 比缺参更坏，接线漏了应当在**编译期**就报。
   */
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision>
  /**
   * 控制域答复路由至此。
   *
   * 第三参 `opts.remember` ＝答复上的**「总是允许」位**（见 `control.ts` · `DecisionAnswer.remember`）
   * ——控制域**原样转手**、不翻译；**会话级记忆归权限域**（凝成会话规则，按
   * 工具 × 路径模式 × 操作类型 记）。**缺省＝不给＝一次性**（向后兼容）。
   */
  resolve(requestId: DecisionId, decision: Decision, opts?: { remember?: boolean }): void
}

/** 对话域 → 记录域。 */
export interface RecordsService {
  /**
   * 取下一个记录 id——**id 空间归记录域**（条目 / 事件共用）。
   * 装配据以构造 `EventStamper`（技术方案 · 领域划分 · 信封的归属）。
   */
  nextId(): RecordId
  appendEntry(entry: NewEntry): RecordId
  appendEvent(event: KernelEvent): void
  readEntries(sessionId: SessionId, range?: EntryRange): AsyncIterable<Entry>
  /** 恢复 / 审计。 */
  readEvents(sessionId: SessionId): AsyncIterable<KernelEvent>
  listSessions(): Promise<readonly SessionSummary[]>
  /** put / get——**写权唯一**（各域大块转存皆经此）。 */
  blobs: BlobStore
}

/**
 * 工具域 → 执行域。
 *
 * **失败形态分两路**（技术方案 · 执行 · 原语形态）——**正常结果用判别式 · 调用不成立用抛**：
 * - **判别式**载正常结果里的失败——命令跑了但 `exit` 非 0、超时（`ExecResult` 的 `ok` /
 *   `reason`）、读到上限（`ReadResult.truncated`）。这些是「做成了，结果如此」。
 * - **调用不成立＝抛**——越界 · 不存在 · 是否目录 · 无权限 · 参数无效：沙箱侧抛**精确报文**，
 *   由**工具边界**捕之、收敛为 `ToolResult` 的判别式。故对模型与其余消费者，
 *   「错误＝返回值」照旧成立；抛只发生在原语这一层。
 *
 * 由头：`write` 的返回是 `void`、`list` / `match` 是数组——**冻签名载不下失败位**，
 * 兜一个哨兵值比抛更坏（静默的空数组会被当成「这个目录就是空的」）。
 */
export interface Sandbox {
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>
  /**
   * 读文件——`opts.maxBytes` 缺省＝**实现常量**（64 KiB）。
   *
   * **为什么要有这个口子**：`write` / `edit` 走「读 → 改 → 写回」时，按缺省上限读到的
   * 是**截断文本**——原样写回即**抹掉尾巴**（数据安全件）。故 `edit` 显式放大上限
   * （实现常量 1 MiB），仍超限则**即拒并指出出口**（走 `exec`）。
   */
  read(path: string, opts?: { maxBytes?: number }): Promise<ReadResult>
  write(path: string, data: WriteData): Promise<void>
  list(path: string): Promise<readonly ListEntry[]>
  match(pattern: string, opts: MatchOptions): Promise<readonly MatchHit[]>
}

/** 工具域 / 装配 → 执行域。 */
export interface WorkspaceService {
  roots(): readonly string[]
  defaultRoot(): string
  /**
   * 解析路径——**越界即拒：抛**（沙箱侧捕之、归 `reason: 'out-of-bounds'`）。
   * 越界判据与执行域**同源**：相对按默认根 · 绝对须落根内。
   */
  resolve(path: string): ResolvedPath
}

/** 装配 → 控制域（外壳经传输接入）。 */
export interface ControlHub {
  /** 命令 → 各域。 */
  bind(routes: CommandRoutes): void
  /** 接**内核侧**一端（`KernelTransport`）——外壳侧一端由外壳自持。 */
  attach(transport: KernelTransport): void
}

// ══ 端口内类型 ════════════════════════════════════════════════════════

// —— 对话域 ——

// `UserInput` 与命令负载 `InputSubmit` 同一形态，定义在 control.ts（不在此重复）。

// —— 模型域 ——

/**
 * 模型消息（内核侧形态——供应商无关）。
 *
 * **上下文由对话域装配**——系统提示词即 `role:'system'` 的首条消息；工具结果回填即
 * `role:'tool'`（`callId` 配对**供应商侧**调用 id——见文件头注 ①）；条目里的 blob 引用
 * 在装配时解析为文本（按策略截断）（技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: readonly ToolCall[]
    }
  | {
      readonly role: 'tool'
      /** **供应商侧**调用 id——与发起它的 assistant 消息里的 `ToolCall.id` 配对。 */
      readonly callId: string
      /**
       * 工具名——**取件层回填需要**。不补就得从上下文里的 assistant 消息反查，
       * 而上下文压缩（阶段 3）正是设计目标——反查届时会**静默退化成空串**。
       */
      readonly name: string
      readonly ok: boolean
      readonly output: string
    }

/** 模型请求（内核侧请求形制）。 */
export type ModelRequest = {
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolSpec[]
}

/**
 * 模型流——**双出口**：事件序列 ＋ 聚合结果。
 *
 * 结果随事件被消费而落定；提前 `break` 亦落定（以未完成态）——见技术方案 · 领域划分。
 */
export type ModelStream = {
  readonly events: AsyncIterable<KernelEvent>
  readonly result: Promise<ModelResult>
}

/**
 * 模型结束原因——词表**对齐取件层（SDK）的结束原因，接缝近恒等映射**
 * （技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelFinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'other'

/**
 * 模型聚合结果。
 * `finishReason` **可缺**——供应商未给 / 出错 / 提前 `break` 时缺省；
 * 「是否走完」由 `complete` 表述（技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelResult = {
  readonly finishReason?: ModelFinishReason
  readonly usage?: ModelUsage
  readonly complete: boolean
  /**
   * 模型本轮请求的工具调用——**循环据以回填**（面向端口者不解析事件流拼装）。
   * 注：`model.delta(toolcall)` 是**流式片段**，事件流拼不出归属——故聚合结果必须载它
   * （双出口设计的完成，非重复）。
   */
  readonly toolCalls?: readonly ToolCall[]
}

/**
 * 模型特征标记——**覆盖位**（技术方案 · 领域划分 · 端口内类型 · 模型策略）。
 *
 * **内置表**（模型域持有 · **不入契约**）给默认；判据取「**键在即接管**」——
 * `traits` 存在就**整组覆盖**（含 `{}` ＝**显式声明无特征**）；两处皆无 → 常规行为（不猜、不切）。
 *
 * 理由——一条规则胜过一个二级判据，且**内置表判错时用户关得掉**：若 `{}` 回落内置表，
 * 错的模型就没有出口。
 *
 * 首站一条：`inlineThinking`——思考**内嵌在正文**（`<think>…</think>` 是少数模型的行为，
 * 不当通例处理）；`tag` 给出包裹标签，归一据它把标签内容切出到 `thinking` 通道
 * （`text` 通道不带标签）。
 */
export type ModelTraits = {
  readonly inlineThinking?: { readonly tag: string }
}

/** token 用量。 */
export type ModelUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
}

// —— 工具域 ——

/**
 * 工具调用（模型请求的一次调用）。
 * `id` ＝**供应商侧**调用 id——只用于回填配对（三个 id 空间见文件头注）。
 */
export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /**
   * 参数**解析不出**（模式不符 / JSON 残缺）——工具域据以决定回填什么。
   * 不靠各消费者重新解析参数串（重复劳动，且丢掉「哪一次调用坏了」的定位）。
   */
  readonly invalid?: boolean
}

/**
 * 工具结果——**载两样输出**（一字之差，别混）。
 *
 * - `output` ＝**面向模型的文本**（按上限截断）——回填给模型看的那份；
 * - `content` ＝**记录侧形态**（内联或 blob 引用）——**即该次 `tool.result` 事件的
 *   `output`，两者同物**。
 *
 * **两样都要**：只给文本，条目就只能当内联记——大输出下条目与事件**当场分叉**、重放丢尾巴；
 * 只给 Content，模型侧拿不到截断文本（blob 要取回才知道长度）。
 * `callRef` 同理——条目侧 `tool-result` 的 `call` 字段取它，**四事件才串得成一条链**。
 */
export type ToolResult = {
  readonly ok: boolean
  /** 面向模型的文本（按上限截断）。 */
  readonly output: string
  /** 记录侧形态（内联或 blob 引用）——即 `tool.result` 事件的 `output`。 */
  readonly content: Content
  /** 该次 `tool.call` 事件的 id（链引用）。 */
  readonly callRef: RecordId
}

// —— 权限域 ——

/**
 * 裁决上下文——**纯数据**（技术方案 · 领域划分 · 端口内类型）。
 *
 * 越界判定所需的根视图由**调用方（工具域）给出**：**不传端口进端口**。
 * 越界判据与执行域**同源**（相对按默认根 · 绝对须落根内）——两处须一致。
 */
export type PermissionContext = {
  readonly roots: readonly string[]
  readonly defaultRoot: string
}

// —— 记录域 ——

/**
 * blob 存取——**写权唯一归记录域**（技术方案 · 记录 · 标量口径 v0）。
 * **取异步**——`bun:sqlite` 同步、文件读写异步，异步面容两者（技术方案 · 领域划分 · 端口内类型）。
 */
export type BlobStore = {
  put(data: Uint8Array | string): Promise<BlobRef>
  get(ref: BlobRef): Promise<Uint8Array>
}

// —— 执行域（沙箱原语）——

/**
 * `exec` 返回——**判别式**（技术方案 · 执行 · 原语形态）。
 *
 * 命令跑了 ＝ `ok: true`（`exit` 非 0 ＝**命令失败**，不是沙箱失败）；
 * 沙箱级失败 ＝ `ok: false` + `reason`。**错误＝返回值**（不抛）。
 */
export type ExecResult =
  | {
      readonly ok: true
      readonly exit: number
      readonly stdout: string
      readonly stderr: string
      /** 超限截断（到 `maxOutputBytes` 为止）；大块转存归调用方。 */
      readonly truncated?: boolean
    }
  | {
      readonly ok: false
      readonly reason: ExecFailureReason
      readonly message: string
    }

/** 沙箱级失败三例（技术方案 · 执行 · 原语形态）。 */
export type ExecFailureReason =
  | 'timeout' // 超时
  | 'out-of-bounds' // cwd 越界（进程不启动）
  | 'spawn' // 启动失败

/**
 * `exec` 选项——cwd 约束 · 流式回调 · 取消 · 超时 / 输出上限。
 * **毫秒 / 字节**；缺省＝实现级常量（技术方案 · 执行 · 原语形态）。
 */
export type ExecOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** 流式增量——实时回调；消费方转 `tool.output.delta` 事件（**不落库**）。 */
  readonly onOutput?: (delta: OutputDelta) => void
  /** 取消——中止在途（**返回不抛**）。 */
  readonly signal?: AbortSignal
}

/**
 * `read` 返回——读文件（超长截断）。
 *
 * TODO(规划侧)：截断标记与「超长转存」的规则未定；占位如下。
 */
export type ReadResult = {
  readonly content: string
  readonly truncated?: boolean
}

/**
 * `write` 入参内容——**收字节，不收引用**。
 *
 * 两选一：文本，或字节（`Uint8Array`）。
 *
 * **原 `blob` 支已撤**（技术方案 · 领域划分 · 端口内类型）：blob 存取归记录域、**写权唯一**，
 * 沙箱手上根本没有 blob 面、域间也不许私连——要写 blob 内容 ＝ **调用方先取回字节**再传。
 * 留着那一支只会让人以为传个引用就能落地，实际写个静默的空文件。
 */
export type WriteData = { readonly text: string } | { readonly bytes: Uint8Array }

/**
 * `list` 条目。
 *
 * TODO(规划侧)：条目形态（名 / 类型 / 尺寸）未定；占位仅名。
 */
export type ListEntry = {
  readonly name: string
}

/**
 * `match` 命中。
 *
 * TODO(规划侧)：命中形态（路径 / 行号 / 片段）未定；占位仅路径。
 */
export type MatchHit = {
  readonly path: string
}

/**
 * `match` 选项（grep / glob 共用底）。
 *
 * TODO(规划侧)：字段未定；占位为不透明负载。
 */
export type MatchOptions = Readonly<Record<string, unknown>>

/**
 * 已解析的工作区路径。
 *
 * TODO(规划侧)：形态未定；占位为绝对路径 + 承载它的根。
 */
export type ResolvedPath = {
  readonly absolute: string
  readonly root: string
}

// —— 控制域 ——

/**
 * 命令路由（装配 → 控制域，技术方案 · 领域划分 · 装配视图：`input.submit` / `turn.interrupt`
 * → 对话域；`decision.answer` → 权限域）。
 */
export type CommandRoutes = {
  onInput(input: UserInput): void
  onInterrupt(): void
  /**
   * 裁决答复 → 权限域。
   *
   * `opts` 是**答复上的加宽位**（目前只有「总是允许」）——控制域**原样转手**给
   * `PermissionGate.resolve`，**不由它翻译**（技术方案 · 领域划分 · 端口内类型）。
   */
  onDecision(id: DecisionId, decision: Decision, opts?: { remember?: boolean }): void
}

/**
 * 控制传输 · **外壳侧**一端——首站同进程直连；跨进程（第二站）/ 跨设备（第三站）接同一接口。
 */
export type ControlTransport = {
  send(command: Command): void
  /** 订阅事件；返回**退订**。 */
  subscribe(listener: (event: KernelEvent) => void): () => void
}

/**
 * 控制传输 · **内核侧**一端（镜像：收命令 / 出事件）——`ControlHub.attach` 的入参。
 */
export type KernelTransport = {
  send(event: KernelEvent): void
  /** 订阅命令；返回**退订**。 */
  subscribe(handler: (command: Command) => void): () => void
}

// —— 信封铸造 ——

/**
 * 信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
 *
 * **为什么必须产出方铸**——裁决配对要求产出方**当场知道事件 id**：权限域发
 * `tool.decision.request`，外壳的答复按**该事件的 id** 回来（`PermissionGate.resolve`）。
 * id 若由扇出处或落库处后配，这条回路就断了。
 *
 * 铸造器由**装配按会话实例**构造并注入各域：
 * - `id` 取自记录域（`RecordsService.nextId()`）；
 * - 上下文（`session` / `turn`）按实例持有——装配设 `session`，对话域在轮起止时调 `beginTurn`；
 * - `at` 由铸造器盖——**产出方不各自取时钟**。
 *
 * **跨实例不共享**——多会话 / 多 Agent 时各持一份。
 */
export type EventStamper = {
  stamp<K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent
  /** 对话域在轮起止时调。 */
  beginTurn(turn: TurnId | undefined): void
}

// ══ 工具规格（端口内类型）════════════════════════════════════════════

/** 必闸判据（危险分级 v0）——命中其一即须闸。 */
export type DangerReason =
  | 'irreversible' // 不可逆（收不回）
  | 'out-of-bounds' // 越界（工作区之外）
  | 'system' // 系统级（机器全局 / 已装环境）
  | 'outbound' // 外发（出去即收不回）
  | 'unknown' // 看不懂（无法归类 → 按不可逆假定问）

/**
 * 危险归类——「轻」（放行区）·「必闸」·「**按调用判定**」（技术方案 · 工具 · 机制）。
 *
 * `by-call` 支承载**随调用参数而变**的归类（如 `exec` 按命令解析 · `write` 新建＝轻、覆盖＝必闸）。
 * 阶段 1 全人工门下，本节定**呈现轻重**；阶段 2 起，必闸清单＝自动放行禁区。
 */
export type DangerClass =
  | { readonly level: 'light' }
  | { readonly level: 'gated'; readonly reason?: DangerReason }
  /** 按调用判定——`note` 说明判定依据。 */
  | { readonly level: 'by-call'; readonly note: string }

/**
 * 参数模式——取**自写朴素 JSON Schema**（技术方案 · 领域划分 · 端口内类型）。
 *
 * 工具参数模式只需要「**类型 ＋ 必填 ＋ 描述**」这一层：手写对象字面量本就落在本形态内，
 * **不取件**（取件会为几个字段背一整套校验器）、不加依赖；送模型即 JSON 往返不变量。
 */
export type JsonSchema = Readonly<Record<string, unknown>>

/** 工具规格——定义随每次调用送模型（名称 · 描述 · 参数模式 · 危险归类）。 */
export type ToolSpec = {
  readonly name: string
  readonly summary: string
  readonly parameters: JsonSchema
  readonly danger: DangerClass
}

/**
 * 工具集规格表的行——**只列静态可判的部分**（名称 / 语义 / 危险归类）；
 * 参数模式由各工具实现时给出。
 */
export type ToolSetRow = Omit<ToolSpec, 'parameters'>

/**
 * **参数键（部分锚定）**——`exec` 的命令字段名＝**`cmd`**（阶段 1 唯一工具）。
 *
 * 工具域**分发**与权限域**分析**都按它取命令（危险归类＝按命令解析，见 `by-call` 支）；
 * 已按候选键兜底者**收窄为单一键**。
 * 其余工具的键名随 U13 定（与 `JsonSchema` 承载形态一并）——未定处不得依赖。
 */

/**
 * 工具集 v1 规格（阶段 2 · 已冻结）——供并行实现。
 * 归类随调用而变的条目取 `by-call`（判定在调用时落定）。
 */
export const TOOLSET_V1 = [
  {
    name: 'exec',
    summary: '命令执行（经沙箱 · 工作目录约束）',
    danger: { level: 'by-call', note: '按命令解析' },
  },
  { name: 'read', summary: '读文件（超长截断）', danger: { level: 'light' } },
  {
    name: 'write',
    summary: '新建 / 整写文件',
    danger: { level: 'by-call', note: '新建＝轻；覆盖＝必闸' },
  },
  { name: 'edit', summary: '串替换增量编辑（唯一定位 · 失配即报）', danger: { level: 'light' } },
  { name: 'grep', summary: '内容搜索（正则 · 输出截断）', danger: { level: 'light' } },
  { name: 'glob', summary: '文件名匹配', danger: { level: 'light' } },
  { name: 'ls', summary: '列目录', danger: { level: 'light' } },
] as const satisfies readonly ToolSetRow[]
