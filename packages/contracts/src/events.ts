/**
 * 共享语言 · 事件（kind 族与载荷 · 信封 · 不落库清单）——已冻结 v0。
 *
 * 出处：技术方案 · 记录（「记录 schema v0」· 事件）· 领域划分（事件产出）。
 * **过程流**——每一步发生了什么（模型调用 / 工具执行 / 裁决 / 回填）；append-only。
 * **事件＝发布语言**（不是域）——各域产生、`EventSink` 直发；落库（持久类）与推送
 * （含瞬时增量）在装配扇出。
 *
 * 两个名字，各司其职：
 * - `EventEnvelope<K>`——**构造面**：造事件时用，泛型收窄到单 kind；
 * - `KernelEvent`——**消费面**：判别联合视图，按 `kind` 自动收窄。
 */

import type { Content } from './entries.ts'
import type { RecordId, SessionId, Timestamp, TurnId } from './ids.ts'

// —— 标量与枚举 ——

/** `agent.state` 携带的状态。 */
export type AgentState = 'waiting' | 'paused' | 'resumed'

/** `turn.end` 携带的结束方式（收束 · 中止 · 错误）。 */
export type TurnEndReason = 'settled' | 'aborted' | 'error'

/** 裁决——首站＝人工裁决（批准 / 拒绝）；「总是允许」归阶段 2。 */
export type Decision = 'approve' | 'reject'

/** `model.error` 的错误分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export type ModelErrorTier = 'transient' | 'context-limit' | 'terminal'

/** `model.delta` 的通道（text / thinking / toolcall）。 */
export type DeltaChannel = 'text' | 'thinking' | 'toolcall'

/** 执行输出的通道（`tool.output.delta` 与沙箱 `onOutput` 共用）。 */
export type OutputChannel = 'stdout' | 'stderr'

/** 裁决询问的**呈现轻重**（轻 / 重——技术方案 · 权限：摩擦对准高危）。 */
export type DecisionWeight = 'light' | 'heavy'

/** 裁者——首站恒 `user`；`auto` 为阶段 2 规则化的留位。 */
export type Decider = 'user' | 'auto'

// —— kind 族 ——

/**
 * 事件 kind 族——命名以词典规范名族为准。
 * 产生方见技术方案 · 领域划分（对话域 / 模型域 / 工具域 / 权限域 / 兜底）。
 */
export type EventKind =
  // agent——起 / 状态 / 止（对话域）
  | 'agent.start'
  | 'agent.state'
  | 'agent.end'
  // turn——轮起止；end 带结束方式（对话域）
  | 'turn.start'
  | 'turn.end'
  // message——内容事件：正文归条目 / blob，事件只记「发生 + 引用」（对话域）
  | 'message.user'
  | 'message.assistant'
  // model——调用级；供应商细节不出模型域
  | 'model.call.start'
  | 'model.call.end'
  | 'model.usage'
  | 'model.error'
  // model · 实时——供渲染订阅；**不落库**（落库收束为调用级）
  | 'model.delta'
  // tool——请求 → 裁决询问（带呈现材料）→ 裁决（批准 / 拒绝 + 裁者 + 耗时）→ 结果
  | 'tool.call'
  | 'tool.decision.request'
  | 'tool.decision'
  | 'tool.result'
  // tool · 实时——执行输出增量；**不落库**
  | 'tool.output.delta'
  // 兜底——内核自身异常（非模型 / 工具域；产生方就近）
  | 'error'
  // 预留——压缩（阶段 3 留位）
  | 'context.compacted'

// —— 事件负载（v0 锚定 · 逐 kind）——

/** 空负载——技术方案 · 记录：空负载＝`Record<string, never>`。 */
export type EmptyPayload = Readonly<Record<string, never>>

/**
 * 增量片段——`model.delta` / `tool.output.delta` 与沙箱 `onOutput` 的共用形态。
 * （`model.delta` 另带 `name?`——见其载荷。）
 */
export type OutputDelta = {
  readonly channel: OutputChannel
  readonly text: string
}

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
    /** toolcall 通道——**供应商侧调用 id**；渲染侧据以按调用分组（同轮可多次调用）。 */
    readonly id?: string
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
  'tool.output.delta': {
    // 不落库——实时订阅专用
    readonly call: RecordId
    readonly channel: OutputChannel
    readonly text: string
  }
  // 兜底——内核自身异常（非模型 / 工具域）
  error: { readonly message: string }
  // 预留——压缩（阶段 3 留位）
  'context.compacted': { readonly summary: RecordId }
}

// —— 信封与视图 ——

/**
 * 事件信封——每事件必带。
 *
 * **构造面**：泛型 `K` 收窄到单个 kind 以取得该 kind 的 `data` 形态。
 */
export type EventEnvelope<K extends EventKind = EventKind> = {
  readonly id: RecordId
  readonly session: SessionId
  readonly turn: TurnId | null
  readonly at: Timestamp
  readonly kind: K
  readonly data: EventDataOf[K]
}

/**
 * 内核事件——**判别联合视图**（消费侧按 `kind` 自动收窄）。
 *
 * 构造用 `EventEnvelope<K>`；消费用本类型——`if (e.kind === 'tool.call')` 即可收窄 `e.data`。
 * 全仓只此一个事件类型名（构造面与消费面是同一件事的两个视角，不是两个概念）。
 */
export type KernelEvent = { readonly [K in EventKind]: EventEnvelope<K> }[EventKind]

// —— 规则（记录 schema v0）——

/**
 * 规则：
 * ① 流式增量**不逐条落库**（实时走订阅）；
 * ② 大负载落 blob（阈值＝实现级常量）；
 * ③ 裁决与用量**只走事件**；
 * ④ 命名以词典规范名族为准。
 */

/** 规则 ① 的清单——**不落库**的事件 kind（实时订阅专用）。 */
export const TRANSIENT_EVENT_KINDS: readonly EventKind[] = ['model.delta', 'tool.output.delta']

/** 记录库 schema 版本（`user_version` 自始写入——技术方案 · 记录 · schema 演进）。 */
export const RECORD_SCHEMA_VERSION = 0
