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

import type { Content, SessionSummary } from './entries.ts'
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
  // model · 实时——**退避重试中**（瞬时档）：是「正在等」的信号，不是重放事实（重放只看终局）
  | 'model.retry'
  // tool——请求 → 裁决询问（带呈现材料）→ 裁决（批准 / 拒绝 + 裁者 + 耗时）→ 结果
  | 'tool.call'
  | 'tool.decision.request'
  | 'tool.decision'
  | 'tool.result'
  // tool · 实时——执行输出增量；**不落库**
  | 'tool.output.delta'
  // model · 会话——换模型的**结果**（用户命令）；**落库**
  | 'model.switched'
  // session——会话面（阶段 2 · U16）：此刻有哪些会话、当前在哪条；**不落库**
  | 'session.state'
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
  'model.call.start': {
    readonly model: string
    /**
     * 这条条目叫什么（`providers` 的键）——**只增不改**（技术方案 · 代码治理 · 契约生长受控）。
     *
     * 由头：外壳状态行要显示**当前供应商 / 模型**（技术方案 · 领域划分：「运行时切换」锚定），
     * 而外壳够不着注册表（那是装配的把手）。**取「真跑过的那一次」而不是命令的自我报告**：
     * 切不动就不动——若拿用户的意图当状态，屏上会显示一个并没在用的条目。
     *
     * 缺省＝未给（Faux 与直接喂 chunk 的用例不记这个）；取件层真实现一律给。
     */
    readonly provider?: string
  }
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
  'model.retry': {
    // 不落库——实时订阅专用
    /** 第几次尝试即将开工（**从 2 起**——第 1 次是首发，谈不上「重试」）。 */
    readonly attempt: number
    /** 这次退避等多久（毫秒）——呈现「x 秒后」的直接来源。 */
    readonly delayMs: number
    /** 必为 `transient`（退避只对瞬时档；超限 / 终态不重试）——留给渲染侧据以措辞。 */
    readonly tier: ModelErrorTier
  }
  // model · 会话——换模型的结果（用户命令）。**落库**（技术方案 · 记录 · kind 族）：
  // 切换是**会话的可观测事实**——`model.call.start` 只说「这次用了谁」，
  // 说不出「何时改的、为什么没改成」；而用户命令不成立**不是内核异常**，
  // 混进 `error` 会污染观测（那一条的语义专留给「内核自身异常」）。
  'model.switched': {
    /** 换成了没有。`false` 时**原选原样保留**（切不动就不动）——`reason` 说为什么。 */
    readonly ok: boolean
    /** 落地后的选中（`ok: true` 时有 —— 也是「现在走的哪一格」）。 */
    readonly provider?: string
    readonly model?: string
    /** 没换成的缘由（**说给人听**的一句话，含已注册的条目名）。 */
    readonly reason?: string
  }
  // session——会话面（阶段 2 · U16）。**查询答复 ＋ 变更通报**两种时机共用一个 kind：
  // 外壳问一次（`session.list`）、内核切一条（`session.new` / `session.open`）都回这一条
  // ——三处各立一个 kind 只会让渲染侧写三遍同一段（列表 ＋ 当前）。
  'session.state': {
    /** 当前活跃会话（**单活跃**——同一时刻只有一条）。 */
    readonly active: SessionId
    /** 会话目录——最近在前；标题用 `SessionSummary.title`（改过的取存值，否则按首条消息现算）。 */
    readonly sessions: readonly SessionSummary[]
    /**
     * 一句话说明——**只在有事要说时给**（没开成 / 新建好了 / 改名落定）。
     *
     * 不给＝状态自明，不必赘述。失败**不静默**（打不开就不打开，但得说为什么）——
     * 且**不借 `error`**：那个 kind 的语义是「内核自身异常」，用户命令未成立混进去会污染观测。
     */
    readonly note?: string
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

/**
 * 规则 ① 的清单——**不落库**的事件 kind（实时订阅专用）。
 *
 * `model.retry` 与 `model.delta` 同列的理由：退避期间那个「正在等」**是实时信号、
 * 不是重放事实**——重放只看终局（这次调用成了没有、内容是什么）。重试次数另落
 * `ModelCallResult.attempts`（可断），故不落库不丢信息。
 */
export const TRANSIENT_EVENT_KINDS: readonly EventKind[] = [
  'model.delta',
  'model.retry',
  'tool.output.delta',
  // 会话状态同列的理由：它是「此刻有哪些会话、当前在哪条」的**快照**，
  // 而重放要的从来不是快照——是过程（谁切到了哪条）。落库只会把同一张表存 N 遍，
  // 且重放时越读越乱（旧快照会把新快照盖回去）。
  'session.state',
]

/** 记录库 schema 版本（`user_version` 自始写入——技术方案 · 记录 · schema 演进）。 */
export const RECORD_SCHEMA_VERSION = 0
