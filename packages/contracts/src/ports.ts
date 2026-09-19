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

import type { Command, ModelSwitchRequest, SessionCommand, UserInput } from './control.ts'
import type { Content, Entry, EntryRange, NewEntry, SessionSummary } from './entries.ts'
import type { Decider, Decision, EventDataOf, EventKind, KernelEvent, OutputDelta } from './events.ts'
import type { BlobRef, DecisionId, RecordId, SessionId, TurnId } from './ids.ts'

// ══ 端口 ══════════════════════════════════════════════════════════════

/** 各域 → 装配扇出（技术方案 · 领域划分：事件不经调用箭头，各域直发 `EventSink`）。 */
export type EventSink = {
  emit(event: KernelEvent): void
}

/**
 * 控制域 → 对话域。
 *
 * **多会话（阶段 2 · U16）的「新建 / 切换 / 列表」在此扩展**（技术方案 · 领域划分 ·
 * 端口签名原话）——五件落在**同一个端口**上，不另立一个「会话端口」（同一件事两处各立
 * 一份＝两处各有一套语义，迟早分叉）。故本端口的实现是**会话主面**（单活跃：它持一个
 * 活跃会话，`submit` / `interrupt` 转发给它），而不是某一条会话的实例。
 */
export interface ConversationService {
  submit(input: UserInput): void // input.submit
  interrupt(): void // turn.interrupt
  /**
   * 会话目录——**最近在前**。
   *
   * 标题走既有的 `SessionSummary.title`（可选位）：改过的取存值，没改过的由对话域
   * **按首条消息现算**（技术方案 · 会话与多会话：标题＝首条消息摘要）。两处都没有
   * （首条消息不是用户输入 / 读不出）就缺席——**不拿空串占位**（缺席可辨，空串不可辨）。
   */
  listSessions(): Promise<readonly SessionSummary[]>
  /** 新建一条会话并切过去——返回新会话 id（外壳据以显示 / 记账）。 */
  newSession(): Promise<SessionId>
  /** 切换会话（**装载**该会话的上下文继续推进；在途处置是恢复的事，不在此捎带）。 */
  openSession(session: SessionId): Promise<void>
  /** 改标题（`title` 为原文——裁剪 / 归一归本域）。 */
  renameSession(session: SessionId, title: string): Promise<void>
  /**
   * **重建面** —— 恢复的**第 ⑤ 步**：「上下文由条目重建」（技术方案 · 领域划分 ·
   * 应用层：「首站唯一用例：恢复——照「记录」节那五步……⑤ 上下文由条目重建
   * （`ConversationService`）＋ 界面重建展示（外壳，经事件）」）。
   *
   * **它是什么**——把这条会话的**现场按记录重建**：装载该会话（单活跃，切过去即装载；
   * 已经是它＝无事）· **认下别处已经算好的两件事**（见 `RebuildHandoff`）。
   * 上下文本身**不必搬**——它每轮由条目装配（`context.ts`），本面只把「活的那部分」
   * 与记录对齐。
   *
   * **它不是什么**——① 在途识别（记录域的查询面）· ②③④ 处置（重放 / 落账 / 记中止）
   * 都由**应用层**（`@magic/actions`）编排，不在本面。恢复的**入口**（启动参数 `--session`）
   * 也归应用层受理——那是这一层立起来的意义（审计第 1 条：恢复入口没有归处）。
   *
   * 返回 `Promise<unknown>`——报告是**对话域的域内形态**，不进契约（U15 的分寸：没出，
   * 就没承诺）。`unknown` 是「有返回值、但契约不替它命名」的准确写法：实现可以给**更具体**的，
   * 而契约上的消费者拿不到任何未承诺的形状。
   */
  rebuild(session: SessionId, handoff: RebuildHandoff): Promise<unknown>
}

/**
 * **重建的递手**（`ConversationService.rebuild` 的入参）——应用层算好、交给对话域认下的两件。
 *
 * 为什么由调用方给而不是对话域自己再读一遍：两件都是**跨域编排的产物**，而编排归应用层
 * （它刚从记录域那趟扫描里拿到它们）。让对话域再扫一遍记录＝同一件事两个产地。
 *
 * - `lastTurn` —— 记录里出现过的**最大轮号**：本轮实例的轮号水位从这里接着走
 *   （不从 1 重来——同一会话重启两回不该把两轮都叫「第 1 轮」）。没有＝这条会话
 *   还没有过轮（新会话／空会话）。
 * - `announced` —— **开工是否已经宣告过**：恢复那趟有活可干时，应用层已经替这个实例
 *   发过 `agent.start`（U04 口径：首次干活前发一次）。对话域据此**别发第二遍**；
 *   干净会话（没有活）为 `false`——首次 `submit` 照旧自己发。
 */
export type RebuildHandoff = {
  readonly lastTurn: TurnId | null
  readonly announced: boolean
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
  /**
   * **在途识别**（恢复 ①）——有 `tool.call` 无 `tool.result` 的那几笔，连同它们走过的
   * 裁决轨迹与中断的轮（见 `RecoveryScan`）。
   *
   * **查询面归记录域**（技术方案 · 领域划分 · 各域结构规则：「恢复的查询面（在途识别）
   * 由它提供」）：处置（重放 / 落账）不在这里——那是应用层的编排（`@magic/actions`）。
   * 本条只**说不判**：把记录里读得出的事实说全，判定留给读的人。
   *
   * ⚠️ 与 `readEvents` 的分工：`readEvents` 是**逐条的流**（审计与重建展示要全量），
   * 本方法是**一次扫描的结论**（恢复只要那几笔在途）。两者不同物，不是一个方法的别名。
   */
  scanInFlight(session: SessionId): Promise<RecoveryScan>
  listSessions(): Promise<readonly SessionSummary[]>
  /** put / get——**写权唯一**（各域大块转存皆经此）。 */
  blobs: BlobStore
}

/**
 * **一笔在途调用**（恢复 ① 的产物）——「有调用、无结果」的那一次。
 *
 * 两侧各有一半，缺则如实为 `null`（**不猜**——恢复宁可见到「这笔说不全」，
 * 也不要一个看着圆满的错配对）：
 * - **事件侧**（链引用）说得出「问过闸门吗、裁决是什么」——处置要的就是这条轨迹；
 * - **条目侧**（配对）管的是上下文合法性（⑤）：助手消息的 `toolCalls` 得条条有回填。
 */
export type InFlightCall = {
  /** 该次 `tool.call` 事件的 id——**链引用**（请求 / 询问 / 裁决 / 结果四事件按它串）。缺则 `null`。 */
  readonly call: RecordId | null
  /** 该次 `tool-call` 条目的 id——**条目侧配对键**。缺则 `null`。 */
  readonly entry: RecordId | null
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** 该次调用属哪一轮（轮外为 `null`）。 */
  readonly turn: TurnId | null
  /** 问过闸门吗（`tool.decision.request` 在）——措辞用：问了没答与被拒不是同一件事。 */
  readonly requested: boolean
  /** 裁决结论。**未答复 / 未问 ＝ `null`**——④按它落账（保守）。 */
  readonly decision: Decision | null
  /** 裁者（与 `decision` 同来处；无裁决则 `null`）。 */
  readonly decider: Decider | null
}

/**
 * **恢复扫描的产物**（`RecordsService.scanInFlight` 的返回）——一次把「要处置什么」说全。
 *
 * 判据（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」① ③）：
 * ```
 *   有 `tool.call` 无 `tool.result`   ← 在途（①）
 *   有 `turn.start` 无 `turn.end`     ← 中断的轮（③「记中止」的落点）
 * ```
 */
export type RecoveryScan = {
  readonly session: SessionId
  /** **中断的轮**——有 `turn.start` 无 `turn.end` 的那个（多个取最大号）；没有＝`null`。 */
  readonly openTurn: TurnId | null
  /** 记录里出现过的**最大轮号**——轮号续跑用（见 `RebuildHandoff.lastTurn`）。没有＝`null`。 */
  readonly lastTurn: TurnId | null
  /** 在途调用（按出现序）。 */
  readonly calls: readonly InFlightCall[]
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
 * 落形态（U13）：`content` ＝**解码后的文本**；`truncated` ＝**到上限为止**，
 * **字段缺席＝没截**（与 `ExecResult.truncated` 同口径——缺省态不占位）。
 * 上限是**字节**：调用方可经 `Sandbox.read` 的 `opts.maxBytes` 指定（缺省＝实现常量 64 KiB）——
 * `truncated` 即「到上限为止」，工具侧据它措辞（`edit` 放大到 1 MiB 再读，仍超限才拒）。
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
 * `list` 条目——名（必给）＋ 类型 / 尺寸（可选）。
 *
 * 两个可选位是**只增不改的兼容位**（既有桩只给 `name`）；真实现两件都给。
 * 名**不是路径**——相对被列的那个目录。
 */
export type ListEntry = {
  readonly name: string
  readonly kind?: 'file' | 'directory' | 'other'
  /** 字节数（仅文件——`kind: 'file'` 时有意义）。 */
  readonly size?: number
}

/**
 * `match` 命中——`glob` 只给 `path`；`grep` 另给行 / 列 / 该行文本。
 *
 * `path` ＝**根内的绝对路径**（沙箱解析后的真身——消费方不必再拼）。
 * 行 / 列**从 1 起**（人看的数，不是偏移量）。
 */
export type MatchHit = {
  readonly path: string
  readonly line?: number
  readonly column?: number
  /** 命中行原文（不含行尾换行）。 */
  readonly text?: string
}

/** 匹配模式——`grep`（内容搜索）/ `glob`（文件名匹配）**共用一条底**（技术方案 · 执行）。 */
export type MatchMode = 'grep' | 'glob'

/**
 * `match` 选项（grep / glob 共用底）。
 *
 * - `mode` —— 判别式：按内容搜、还是按名匹配（同一条原语的两个面）；
 * - `path` —— 搜索起点；缺省＝**默认根**（相对按默认根 · 绝对须落根内——与执行域同一判据）；
 * - `maxResults` —— 命中数**上限**，至多返回这么多条（`grep` 的「输出截断」据此：
 *   取满即**可能**还有更多——消费方按此措辞，不当作「恰好这么多」）；缺省＝实现级常量；
 * - `signal` —— 取消：中止在途，**返回已收到的**（不抛——与 `exec` 的取消同一姿态）。
 */
export type MatchOptions = {
  readonly mode: MatchMode
  readonly path?: string
  readonly maxResults?: number
  readonly signal?: AbortSignal
}

/**
 * 已解析的工作区路径。
 *
 * `absolute` 已归一化（**词法**——同步纯词法判定，见 `WorkspaceService.resolve` 的限度）；
 * `root` ＝承载它的那条根。
 *
 * **越界即拒＝抛**（端口注释）——沙箱各原语捕之：`exec` 归 `reason: 'out-of-bounds'`；
 * 余四者的「正常结果 vs 调用不成立」两路之分见 `Sandbox` 头注（失败形态分两路）。
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
  /**
   * 换模型 → 模型域（装配接注册表的 `use()`）。
   *
   * 控制域**原样转手**（同 `onDecision` 的姿势）——它不认识注册表，也不知道换得成换不成；
   * 「切不动就不动」的判别式处置归**装配**（技术方案 · 领域划分 · 端口内类型）。
   */
  onModelSwitch(request: ModelSwitchRequest): void
  /**
   * 会话命令 → 对话域。
   *
   * 控制域**原样转手**（同 `onDecision` / `onModelSwitch` 的姿势）——它不认识会话，
   * 也不知道开得成开不成；「打不开就不打开」的处置归对话域。
   */
  onSession(command: SessionCommand): void
  /**
   * 读侧命令 → 对话域（技术方案 · 领域划分：「读面走控制面，不靠装配偷接」）。
   *
   * 控制域**原样转手**（同 `onSession` 的姿势）——它不认识记录域、也不读条目；
   * 答复走事件（`session.history`，**不落库**）：命令面只发不收，回话一律经事件流。
   */
  onHistoryRead(session?: SessionId): void
  /**
   * 模型条目表 → **装配**（它握着注册表——技术方案 · 装配视图 4）。
   *
   * 控制域**原样转手**（同 `onModelSwitch` 的姿势）——它不认识注册表，也不知道有哪些条目；
   * 答复走事件（`model.catalog`，**不落库**）：命令面只发不收，与 `onHistoryRead` 同一条路。
   *
   * **为什么归装配而不是模型域**：注册表是**进程级**的（选中的供应商不随会话漂，见
   * 装配的 `switchModel`），而模型域的网关是按会话实例造的那一束里的一件——
   * 条目表的真源在装配这一步，`model.switched` 的产出也早已收拢在这儿（缺陷 D16）。
   */
  onModelList(): void
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
 * **参数键（工具集 v1 全表 · U13 锚定）**——工具的参数模式按此命名：工具域**分发**与
 * 权限域**分析**都按它取字段（危险归类＝按命令 / 按路径判定，见 `by-call` 支）。
 *
 * - `exec` —— `cmd`（命令；阶段 1 即锚定，**收窄为单一键**，不按候选键兜底）
 * - `read` —— `path`
 * - `write` —— `path` · `content`（**整写**——不是追加；空串＝写空文件）
 * - `edit` —— `path` · `old` · `new`（`old` 须在文件中**唯一**出现；`new` 空串＝删除）
 * - `grep` —— `pattern`（正则）· `path?`（搜索起点）
 * - `glob` —— `pattern`（glob 模式）· `path?`
 * - `ls` —— `path?`
 *
 * 通例：`path` 一律按工作区规则解析（相对按默认根 · 绝对须落根内）；**可选键缺席即取缺省**
 * （不是空串）；**错键名不被猜中**——取不到即报「参数错误」，故键名不带方言
 * （没有 `file` / `filepath` / `query` / `old_string` 一类近义变体）。
 *
 * 承载形态＝**自写朴素 JSON Schema**（`JsonSchema` 的类型不动——手写对象字面量本就落在
 * 它的形态内：不取件、不加依赖，送模型即 JSON 往返不变量）。
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
