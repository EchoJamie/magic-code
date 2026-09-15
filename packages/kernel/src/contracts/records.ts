/**
 * 记录 schema v0 —— **记录契约**（已冻结）。
 *
 * 出处：技术方案 · 记录：会话与事件（「记录 schema v0（会话条目 + 事件）」）。
 * 两条 append-only 流——**内容**（会话条目）与**过程**（事件流）；恢复＝由会话记录重建。
 *
 * 本文件是**转写**：只落技术方案已冻结之名与结构，不加设计。
 */

// —— 标识与标量 ——

/** 记录标识（条目 / 事件共用）——单调，排序权威。 */
export type RecordId = number

/** 会话标识（事件分束预留——技术方案 · 多智能体协作预留）。 */
export type SessionId = string

/** 轮标识——一个 Turn ＝ 一次模型调用 + 它请求的工具执行（可为 0 个）。 */
export type TurnId = number

/** 时间戳——**epoch 毫秒**（`at` 与事件时间；技术方案 · 记录 · 标量口径 v0）。 */
export type Timestamp = number

/**
 * 大负载引用——大负载（长输出 / 大 diff）落文件 blob，条目与事件只存引用。
 * **对契约消费者不透明**——实现由记录模块定（`blobs/` 下键）；消费方不得解析
 * （技术方案 · 记录 · 标量口径 v0）。
 */
export type BlobRef = string

/** 内容承载——正文内联，或大负载转 blob 引用。 */
export type Content = { readonly text: string } | { readonly blob: BlobRef }

// —— 会话条目（内容流）——

/** 条目 kind。 */
export type EntryKind =
  | 'user' // 用户输入
  | 'assistant' // 助手产出
  | 'tool-call' // 名 + 参数
  | 'tool-result' // ok / error + 输出
  | 'summary' // 压缩摘要（阶段 3 留位）

/** 会话条目——对话、工具调用与结果的持久形态（append-only）。 */
export type Entry = {
  readonly id: RecordId
  readonly kind: EntryKind
  readonly content: Content
  readonly at: Timestamp
  /** 来源引用（协作立条前的占位——委派关系可表达为引用链）。 */
  readonly source?: SessionId
}

// —— 事件流（过程流）——

/** `agent.state` 携带的状态。 */
export type AgentState = 'waiting' | 'paused' | 'resumed'

/** `turn.end` 携带的结束方式（收束 · 中止 · 错误）。 */
export type TurnEndReason = 'settled' | 'aborted' | 'error'

/** 裁决——首站＝人工裁决（批准 / 拒绝）；「总是允许」归阶段 2。 */
export type Decision = 'approve' | 'reject'

/** 事件 kind 族——命名以词典规范名族为准。 */
export type EventKind =
  // agent——起 / 状态 / 止
  | 'agent.start'
  | 'agent.state'
  | 'agent.end'
  // turn——轮起止；end 带结束方式（收束 · 中止 · 错误）
  | 'turn.start'
  | 'turn.end'
  // message——内容事件：正文归条目 / blob，事件只记「发生 + 引用」
  | 'message.user'
  | 'message.assistant'
  // model——调用级；供应商细节不出接缝
  | 'model.call.start'
  | 'model.call.end'
  | 'model.usage'
  | 'model.error'
  // model · 实时——供渲染订阅；**不落库**（落库收束为调用级）
  | 'model.delta'
  // tool——请求 → 裁决询问（带呈现材料）→ 裁决（批准 / 拒绝 + 裁者 + 耗时）→ 结果（ok / error + 输出引用）
  | 'tool.call'
  | 'tool.decision.request'
  | 'tool.decision'
  | 'tool.result'
  // 兜底——内核自身异常（非模型 / 工具域）
  | 'error'
  // 预留——压缩（阶段 3 留位）
  | 'context.compacted'

// —— 事件负载（v0 锚定 · 逐 kind）——

/** 空负载——技术方案 · 记录：空负载＝`Record<string, never>`。 */
export type EmptyPayload = Readonly<Record<string, never>>

/** `model.error` 的错误分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export type ModelErrorTier = 'transient' | 'context-limit' | 'terminal'

/** `model.delta` 的通道（text / thinking / toolcall——技术方案 · 记录 · kind 族）。 */
export type DeltaChannel = 'text' | 'thinking' | 'toolcall'

/** 裁决询问的**呈现轻重**（轻 / 重——技术方案 · 权限：摩擦对准高危）。 */
export type DecisionWeight = 'light' | 'heavy'

/** 裁者——首站恒 `user`；`auto` 为阶段 2 规则化的留位。 */
export type Decider = 'user' | 'auto'

/**
 * 事件负载映射——逐 kind 的 `data` 形态（技术方案 · 记录 · data 字段 v0）。
 *
 * `entry` / `call` / `summary` 皆为**引用**（`RecordId` 空间共用）；
 * `call` ＝该次调用的 `tool.call` 事件 `id`——贯穿请求 / 询问 / 裁决 / 结果
 * （注：**裁决配对**仍按**请求事件** `id`，见控制面契约）。
 */
export type EventDataOf = {
  // agent——起 / 状态 / 止
  'agent.start': EmptyPayload
  'agent.state': { readonly state: AgentState }
  'agent.end': EmptyPayload
  // turn——轮起止；end 带结束方式
  'turn.start': EmptyPayload
  'turn.end': { readonly reason: TurnEndReason }
  // message——内容事件：正文归条目 / blob，事件只记「发生 + 引用」
  'message.user': { readonly entry: RecordId }
  'message.assistant': { readonly entry: RecordId }
  // model——调用级
  'model.call.start': { readonly model: string }
  'model.call.end': EmptyPayload
  'model.usage': { readonly inputTokens: number; readonly outputTokens: number }
  'model.error': { readonly tier: ModelErrorTier; readonly message: string }
  'model.delta': {
    // 不落库——实时订阅专用
    readonly channel: DeltaChannel
    readonly text: string
    /** toolcall 通道——工具名。 */
    readonly name?: string
  }
  // tool——请求 → 裁决询问 → 裁决 → 结果
  'tool.call': {
    readonly name: string
    /** 工具各自的参数模式。 */
    readonly args: Readonly<Record<string, unknown>>
  }
  'tool.decision.request': {
    readonly call: RecordId
    readonly name: string
    /** 判断材料——diff / 命令分解 / 影响面。 */
    readonly material: string
    readonly weight: DecisionWeight
  }
  'tool.decision': {
    readonly call: RecordId
    readonly decision: Decision
    readonly decider: Decider
    /** 提示 → 答复。 */
    readonly elapsedMs: number
  }
  'tool.result': {
    readonly call: RecordId
    readonly ok: boolean
    /** 内联或 blob 引用。 */
    readonly output: Content
  }
  // 兜底——内核自身异常（非模型 / 工具域）
  error: { readonly message: string }
  // 预留——压缩（阶段 3 留位）
  'context.compacted': { readonly summary: RecordId }
}

/**
 * 事件信封——每事件必带。
 * 泛型 `K` 可收窄到单个 kind 以取得该 kind 的 `data` 形态；省略即全 kind 的联合。
 */
export type EventEnvelope<K extends EventKind = EventKind> = {
  readonly id: RecordId
  readonly session: SessionId
  readonly turn: TurnId | null
  readonly at: Timestamp
  readonly kind: K
  readonly data: EventDataOf[K]
}

// —— 规则（记录 schema v0）——

/**
 * 规则：
 * ① 流式增量**不逐条落库**（实时走订阅）；
 * ② 大负载落 blob（阈值＝实现级常量）；
 * ③ 裁决与用量**只走事件**；
 * ④ 命名以词典规范名族为准。
 */

/** 规则 ① 的清单——不落库的事件 kind（实时订阅专用）。 */
export const TRANSIENT_EVENT_KINDS: readonly EventKind[] = ['model.delta']

/** 记录库 schema 版本（`user_version` 自始写入——技术方案 · 记录 · schema 演进）。 */
export const RECORD_SCHEMA_VERSION = 0
