import type { AgentId, DelegationId, MessageId, OperationId, SessionId, Timestamp } from '../shared/ids.ts'
import type { AgentIdentity, AgentMessage, Collaboration, Delegation, MessagePart } from './collaboration.ts'
import type { ModelSwitchRequest, UserInput } from './control.ts'
import type { Entry } from './entries.ts'
import type { RunRow } from './runs.ts'
import type { ModelUsage } from '../ports.ts'
import type { ReasoningSetting } from '../shared/model.ts'

/** 模型入口不接受 sender、工作区、授权来源或当前委派覆盖值。它们由宿主绑定。 */
export type CollaborationRequest = CollaborationOperation & {
  /** 执行宿主注入的本次调用记录；不在模型参数 schema 中。 */
  readonly generatedFrom?: import('./collaboration.ts').EntryReference
}
/**
 * 协作命令目录——前半是模型/用户可见的操作；`registry` 段是**执行宿主边界的账本写**
 * （边界方案 §四#5「回执配对表补齐」）：执行者经 `collaboration.request` 帧请求写账本，
 * **身份（actor）由宿主按连接绑定**，不在载荷里自报；每条带 `operationId`，回执经
 * `collaboration.reply` 按它配对（`CollaborationReply`）。
 */
type CollaborationOperation =
  | { readonly action: 'list' }
  | { readonly action: 'consult'; readonly operationId: string; readonly question: string; readonly body?: readonly MessagePart[]; readonly reasoning?: ReasoningSetting }
  | { readonly action: 'spawn'; readonly operationId: string; readonly name: string; readonly role?: string; readonly responsibility: string; readonly scope: string; readonly body: readonly MessagePart[]; readonly model?: ModelSwitchRequest; readonly modelReason?: string }
  | { readonly action: 'delegate'; readonly operationId: string; readonly recipient: AgentId; readonly scope: string; readonly body: readonly MessagePart[] }
  | { readonly action: 'send'; readonly operationId: string; readonly recipients: readonly AgentId[]; readonly purpose: 'inform' | 'question' | 'reply' | 'decision'; readonly body: readonly MessagePart[]; readonly replyTo?: MessageId; readonly discussionRoot?: MessageId; readonly startDiscussion?: boolean }
  | { readonly action: 'respond'; readonly operationId: string; readonly delegation: DelegationId; readonly response: 'accept' | 'reject' | 'clarify'; readonly reason?: string }
  | { readonly action: 'deliver'; readonly operationId: string; readonly delegation: DelegationId; readonly conclusion: string; readonly artifacts: readonly string[]; readonly verified: readonly string[]; readonly unresolved: readonly string[] }
  | { readonly action: 'receive'; readonly delegation: DelegationId }
  | { readonly action: 'read'; readonly message: MessageId; readonly discussion?: boolean }
  | { readonly action: 'stop'; readonly delegation?: DelegationId; readonly reason: string }
  | { readonly action: 'close' }
// —— 执行宿主边界的账本写（actor 由宿主绑定；operationId 配对回执）——
  /** 消费本成员收件箱：pending → consumed（engine 是账本唯一写者，执行者请求写）。 */
  | { readonly action: 'consumeInbox'; readonly operationId: OperationId; readonly at: Timestamp; readonly limit?: number }
  /** 消费后的条目已带入当前轮：落「已并入」持久痕迹（对应 InboxItem.includedAt）。 */
  | { readonly action: 'markIncluded'; readonly operationId: OperationId; readonly messageIds: readonly MessageId[]; readonly at: Timestamp }
  /** 准入登记（**在 dequeue 之前**）：一次执行的准入事实；回执给 `ExecutionAdmission`。 */
  | { readonly action: 'beginExecution'; readonly operationId: OperationId; readonly at: Timestamp; readonly delegationId?: DelegationId; readonly runId: string; readonly kind: import('./collaboration.ts').ExecutionAdmission['kind']; readonly mode?: 'work' | 'coordination' }
  /** 结束一次执行；`execution` ＝ 要结束的那次准入的 operationId（与帧幂等键分开）。 */
  | { readonly action: 'finishExecution'; readonly operationId: OperationId; readonly execution: OperationId; readonly reason?: string }
  /** 宿主确认的真实 user 条目发布为共同约束（代理转述不能创建用户来源）。 */
  | { readonly action: 'publishConstraint'; readonly operationId: OperationId; readonly at: Timestamp; readonly source: import('./collaboration.ts').EntryReference; readonly body: readonly MessagePart[]; readonly affectedAgents?: readonly AgentId[]; readonly replaces?: MessageId }
  /** 执行者登记身份（连回后第一件事；身份归属由宿主核对，不在载荷自报）。 */
  | { readonly action: 'registerIdentity'; readonly operationId: OperationId; readonly at: Timestamp; readonly session: SessionId }

export type CollaborationReply = { readonly ok: true; readonly value: unknown; readonly knowledge?: readonly import('./knowledge.ts').KnowledgeReference[] } | { readonly ok: false; readonly reason: string }
export type CollaborationClient = { request(input: CollaborationRequest): Promise<CollaborationReply> }

/** 仅从实际模型事件汇总；任一调用未报告的字段保持未知。 */
export type CollaborationUsage = ModelUsage & { readonly calls: number; readonly reportedCalls: number }
export type CollaborationMemberView = {
  readonly usage?: CollaborationUsage
  readonly agent: AgentIdentity
  readonly runtime?: RunRow
  readonly delegation?: Delegation
  readonly pendingDecisions: number
}
/** 关系查询的快照。成员正文仅在明确查看时取，不能复制为整体日志。 */
export type CollaborationView = {
  readonly usage?: CollaborationUsage
  readonly originSession: SessionId
  readonly collaboration?: Collaboration
  readonly members: readonly CollaborationMemberView[]
  readonly delegations: readonly Delegation[]
  readonly constraints: readonly { readonly messageId: MessageId; readonly states: readonly { readonly agentId: AgentId; readonly state: 'pending' | 'consumed' | 'included' }[] }[]
  readonly selectedMember?: AgentId
  readonly entries?: readonly Entry[]
  readonly messages?: readonly AgentMessage[]
  readonly note?: string
}

export type CollaborationCommand =
  | { readonly type: 'collaboration.read'; readonly member?: AgentId }
  | { readonly type: 'collaboration.input'; readonly member?: AgentId; readonly input: UserInput; readonly shared?: boolean }
  | { readonly type: 'collaboration.stop'; readonly delegation?: DelegationId }
  | { readonly type: 'collaboration.resume' }
  | { readonly type: 'collaboration.configure'; readonly member?: AgentId; readonly model: ModelSwitchRequest }
