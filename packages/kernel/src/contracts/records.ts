/**
 * 记录 schema v0 —— **记录契约**（已冻结）。
 *
 * 出处：技术方案 · 记录：会话与事件（「记录 schema v0（会话条目 + 事件）」）。
 * 两条 append-only 流——**内容**（会话条目）与**过程**（事件流）；恢复＝由会话记录重建。
 *
 * 本文件是**转写**：只落技术方案已冻结之名与结构，不加设计。
 * 未定之处标 `TODO(规划侧)` 并以最小占位承载——占位形态的内部结构不属契约，各单元不得依赖。
 */

// —— 标识与标量 ——

/** 记录标识（条目 / 事件共用）——单调，排序权威。 */
export type RecordId = number

/** 会话标识（事件分束预留——技术方案 · 多智能体协作预留）。 */
export type SessionId = string

/** 轮标识——一个 Turn ＝ 一次模型调用 + 它请求的工具执行（可为 0 个）。 */
export type TurnId = number

/**
 * 时间戳。
 *
 * TODO(规划侧)：技术方案只写「时间」/`at`，未定单位；占位为 epoch 毫秒（SQLite 友好）。
 */
export type Timestamp = number

/**
 * 大负载引用——大负载（长输出 / 大 diff）落文件 blob，条目与事件只存引用。
 *
 * TODO(规划侧)：引用形式（文件名 / 相对路径 / 内容寻址）未定；占位为不透明串。
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

/**
 * 事件小负载（小负载内联；大块内容一律 blob 引用）。
 *
 * TODO(规划侧)：技术方案冻结了 kind 与语义，未逐一冻结各 kind 的 `data` 字段；
 * 占位为可序列化的不透明负载——由 U02（落库）· U03（归一）· U08（推送）按 kind 落定后回正。
 */
export type EventData = Readonly<Record<string, unknown>>

/** 事件信封——每事件必带。 */
export type EventEnvelope = {
  readonly id: RecordId
  readonly session: SessionId
  readonly turn: TurnId | null
  readonly at: Timestamp
  readonly kind: EventKind
  readonly data: EventData
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
