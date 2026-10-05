/** 同一工作的身份、持久通信与准入事实。仅宿主持有写端口；actor 由执行连接注入。 */
import type { AgentId, CollaborationId, DelegationId, MessageId, OperationId, RecordId, SessionId, Timestamp, WaitId } from './ids.ts'
import type { ModelAlias, ReasoningSetting } from './model.ts'

export type AgentModelConfig = { readonly alias: ModelAlias; readonly provider: string; readonly model: string; readonly reasoning?: ReasoningSetting }
export type EntryReference = { readonly sessionId: SessionId; readonly entryId: RecordId }
export type AgentReachability = 'active' | 'suspended' | 'historical'
export type AgentIdentity = {
  readonly agentId: AgentId
  readonly sessionId: SessionId
  readonly name: string
  readonly role: string
  readonly responsibility?: string
  readonly model: AgentModelConfig
  readonly workspace: readonly string[]
  readonly collaborationId?: CollaborationId
  readonly createdBy?: AgentId
  readonly reachability: AgentReachability
  readonly at: Timestamp
}
export type Collaboration = {
  readonly collaborationId: CollaborationId
  readonly originSessionId: SessionId
  readonly origin: EntryReference
  readonly coordinatorId: AgentId
  readonly defaultModel: AgentModelConfig
  readonly state: 'open' | 'closing' | 'stopped' | 'closed'
  readonly reason?: string
  readonly at: Timestamp
}
export type MessagePart =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'blob'; readonly blob: string }
  | { readonly kind: 'entry'; readonly ref: EntryReference; readonly label?: string }
export type MessagePurpose = 'inform' | 'question' | 'reply' | 'delegation' | 'clarification' | 'delivery' | 'receipt' | 'constraint' | 'decision'
export type AgentMessage = {
  readonly messageId: MessageId
  readonly collaborationId: CollaborationId
  readonly senderId: AgentId
  readonly recipients: readonly AgentId[]
  readonly purpose: MessagePurpose
  readonly body: readonly MessagePart[]
  readonly replyTo?: MessageId
  /** 首条讨论消息自身作根；后续消息显式沿用。 */
  readonly discussionRoot?: MessageId
  readonly delegationId?: DelegationId
  readonly userSource?: EntryReference
  readonly at: Timestamp
  readonly withdrawn: boolean
}
/** 条目只含引用，content 为 {text:''}，正文须经 readMessage 读取。source 仍是发送方 SessionId。 */
export type AgentMessagePayload = { readonly messageId: MessageId; readonly collaborationId: CollaborationId; readonly senderId: AgentId }
export type InboxItem = {
  /** 数据库持久入队序号；不可用 messageId 代替。 */
  readonly position: number
  readonly recipientId: AgentId
  readonly messageId: MessageId
  readonly state: 'pending' | 'consumed' | 'withdrawn'
  readonly entryId?: RecordId
  readonly consumedAt?: Timestamp
  readonly includedAt?: Timestamp
}
export type Delegation = {
  /** 初始委派消息的 id，同时是委派身份。 */
  readonly delegationId: DelegationId
  readonly collaborationId: CollaborationId
  readonly delegatorId: AgentId
  readonly assigneeId: AgentId
  readonly parentDelegationId?: DelegationId
  readonly source: EntryReference | { readonly messageId: MessageId }
  readonly authorization: readonly EntryReference[]
  readonly scope: string
  readonly state: 'queued' | 'clarification' | 'accepted' | 'rejected' | 'delivered' | 'received' | 'cancelled'
  readonly deliveryMessageId?: MessageId
  readonly acceptedAt?: Timestamp
  readonly deliveredAt?: Timestamp
  readonly receivedAt?: Timestamp
  readonly reason?: string
  readonly at: Timestamp
}
export type CollaborationWait = {
  readonly waitId: WaitId
  readonly collaborationId: CollaborationId
  readonly agentId: AgentId
  readonly delegationId?: DelegationId
  readonly forAgents: readonly AgentId[]
  readonly forMessageId?: MessageId
  readonly expectation: string
  readonly deadline: Timestamp
  readonly state: 'waiting' | 'resolved' | 'expired' | 'interrupted'
  readonly reason?: string
  readonly resultMessageId?: MessageId
  /** 终态已由宿主领取；不代表已带入模型请求、模型理解或行动。 */
  readonly handledAt?: Timestamp
  /** 宿主确认终态实际进入模型请求；与领取事实分开，保留首次确认时间。 */
  readonly includedAt?: Timestamp
  readonly at: Timestamp
}
export type SharedConstraint = {
  readonly messageId: MessageId
  readonly collaborationId: CollaborationId
  readonly active: boolean
  /** undefined 表示所有成员，包括后加入者。 */
  readonly affectedAgents?: readonly AgentId[]
}
export type CollaborationScope =
  | { readonly kind: 'host' }
  | { readonly kind: 'collaboration'; readonly collaborationId: CollaborationId }
  | { readonly kind: 'delegation'; readonly delegationId: DelegationId }
export type ExecutionAdmission = {
  readonly operationId: OperationId
  readonly agentId: AgentId
  readonly delegationId?: DelegationId
  readonly runId: string
  /** 停止墓碑；明确继续也不清除此运行代次的失效事实。 */
  readonly cancelledAt?: Timestamp
  readonly kind: 'model' | 'tool' | 'wake'
  readonly mode?: 'work' | 'coordination'
  readonly state: 'running' | 'cancel-requested' | 'finished'
  readonly at: Timestamp
  readonly reason?: string
}
export type AdmissionDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string }
export type StopResult = {
  /** 实际需要取消/收尾的成员；局部撤回排队委派不取消该成员正在承担的其他责任。 */
  readonly agents: readonly AgentId[]
  /** 已撤回的委派来源闭包；不等同于 agents 的全部历史责任。 */
  readonly delegations: readonly DelegationId[]
  readonly executions: readonly ExecutionAdmission[]
}
export type OperationResult =
  | { readonly kind: 'delegation-response'; readonly delegationId: DelegationId; readonly accepted: boolean; readonly reason?: string }
  | { readonly kind: 'identity'; readonly agentId: AgentId }
  | { readonly kind: 'collaboration'; readonly collaborationId: CollaborationId }
  | { readonly kind: 'spawn'; readonly agentId: AgentId; readonly delegationId: DelegationId }
  | { readonly kind: 'delegation'; readonly delegationId: DelegationId }
  /** 按受理动作区分；message 仅用于 send，不能跨动作复用 operationId。 */
  | { readonly kind: 'message' | 'delivery' | 'constraint'; readonly messageId: MessageId }
  | { readonly kind: 'wait'; readonly waitId: WaitId }
  | { readonly kind: 'execution'; readonly operationId: OperationId }
export type OperationInput = { readonly operationId: OperationId; readonly at: Timestamp }
export type RegisterAgentInput = OperationInput & { readonly sessionId: SessionId; readonly name: string; readonly role: string; readonly responsibility?: string; readonly model: AgentModelConfig }
export type SendMessageInput = OperationInput & {
  readonly recipients: readonly AgentId[]
  readonly purpose: 'inform' | 'question' | 'reply' | 'receipt' | 'decision'
  readonly body: readonly MessagePart[]
  readonly replyTo?: MessageId
  readonly discussionRoot?: MessageId
  readonly startDiscussion?: boolean
  readonly delegationId?: DelegationId
}
export type DelegateInput = OperationInput & {
  readonly assigneeId: AgentId
  readonly body: readonly MessagePart[]
  readonly scope: string
  readonly source: EntryReference | { readonly messageId: MessageId }
  readonly authorization: readonly EntryReference[]
  readonly parentDelegationId?: DelegationId
}
export type SpawnAgentInput = Omit<DelegateInput, 'assigneeId'> & {
  readonly sessionId: SessionId
  readonly name: string
  readonly role: string
  readonly responsibility?: string
  readonly model: AgentModelConfig
}

/**
 * 同一 SQLite 记录域的同步短事务端口。没有网络/模型/工具执行。
 * actor 必须由宿主绑定，禁止直接使用模型参数。消息本体不接受 sender 或用户身份。
 * 稳定 operationId 在整个记录库唯一；重试返回原受理结果，不代表允许重放副作用。
 * 错误抛出 Error；并发可预期裁决（接受、等待、准入、编辑）用显式结果返回。
 */
export interface CollaborationRecords {
  registerAgent(input: RegisterAgentInput): AgentIdentity
  getAgent(agentId: AgentId): AgentIdentity | undefined
  agentForSession(sessionId: SessionId): AgentIdentity | undefined
  updateAgent(agentId: AgentId, patch: { readonly name?: string; readonly role?: string; readonly responsibility?: string; readonly model?: AgentModelConfig }): AgentIdentity
  setReachability(agentId: AgentId, state: AgentReachability): void
  openCollaboration(actor: AgentId, input: OperationInput & { readonly origin: EntryReference }): Collaboration
  updateDefaultModel(collaborationId: CollaborationId, config: AgentModelConfig): Collaboration
  getCollaboration(collaborationId: CollaborationId): Collaboration | undefined
  collaborationForSession(sessionId: SessionId): Collaboration | undefined
  listMembers(collaborationId: CollaborationId): readonly AgentIdentity[]
  spawn(actor: AgentId, input: SpawnAgentInput): { readonly agent: AgentIdentity; readonly delegation: Delegation }
  delegate(actor: AgentId, input: DelegateInput): Delegation
  getDelegation(delegationId: DelegationId): Delegation | undefined
  listDelegations(collaborationId: CollaborationId): readonly Delegation[]
  respondToDelegation(actor: AgentId, input: OperationInput & { readonly delegationId: DelegationId; readonly response: 'accept' | 'reject' | 'clarify'; readonly body?: readonly MessagePart[]; readonly reason?: string }): { readonly delegation: Delegation; readonly accepted: boolean; readonly reason?: string }
  deliver(actor: AgentId, input: OperationInput & { readonly delegationId: DelegationId; readonly body: readonly MessagePart[] }): AgentMessage
  receiveDelivery(actor: AgentId, delegationId: DelegationId, at: Timestamp): Delegation
  send(actor: AgentId, input: SendMessageInput): AgentMessage
  readMessage(actor: AgentId, messageId: MessageId): AgentMessage | undefined
  /** 本成员有权读取的发出、收件、共同约束及关联讨论；不扩大到全协作日志。 */
  listMessages(agentId: AgentId): readonly AgentMessage[]
  listDiscussion(actor: AgentId, root: MessageId): readonly AgentMessage[]
  inbox(agentId: AgentId, after?: number): readonly InboxItem[]
  consumeInbox(agentId: AgentId, at: Timestamp, limit?: number): readonly InboxItem[]
  markIncluded(agentId: AgentId, messageIds: readonly MessageId[], at: Timestamp): void
  editMessage(actor: AgentId, messageId: MessageId, body: readonly MessagePart[]): boolean
  withdrawMessage(actor: AgentId, messageId: MessageId): boolean
  /** 宿主确认的真实 user 条目；代理转述无法创建用户来源。 */
  publishConstraint(actor: AgentId, input: OperationInput & { readonly source: EntryReference; readonly body: readonly MessagePart[]; readonly affectedAgents?: readonly AgentId[]; readonly replaces?: MessageId }): AgentMessage
  listConstraints(collaborationId: CollaborationId): readonly SharedConstraint[]
  constraintStatus(messageId: MessageId): readonly { readonly agentId: AgentId; readonly state: 'pending' | 'consumed' | 'included' }[]
  registerWait(actor: AgentId, input: OperationInput & { readonly forAgents: readonly AgentId[]; readonly forMessageId?: MessageId; readonly delegationId?: DelegationId; readonly expectation: string; readonly deadline: Timestamp }): { readonly ok: true; readonly wait: CollaborationWait } | { readonly ok: false; readonly cycle: readonly AgentId[] }
  listWaits(collaborationId: CollaborationId): readonly CollaborationWait[]
  expireWaits(at: Timestamp): readonly CollaborationWait[]
  /** 原子领取尚未领取的等待终态，不伪造成员消息，也不标记实际请求带入。 */
  consumeWaitOutcomes(agentId: AgentId, at: Timestamp): readonly CollaborationWait[]
  /** 仅确认本 actor 已领取的终态；整批原子、幂等，空数组无事。 */
  markWaitOutcomesIncluded(agentId: AgentId, waitIds: readonly WaitId[], at: Timestamp): void
  interruptWaits(agentId: AgentId, reason: string): readonly CollaborationWait[]
  checkAdmission(agentId: AgentId, delegationId?: DelegationId, mode?: 'work' | 'coordination'): AdmissionDecision
  beginExecution(actor: AgentId, input: OperationInput & { readonly delegationId?: DelegationId; readonly runId: string; readonly kind: ExecutionAdmission['kind']; readonly mode?: 'work' | 'coordination' }): ExecutionAdmission
  finishExecution(operationId: OperationId, reason?: string): void
  listExecutions(collaborationId: CollaborationId): readonly ExecutionAdmission[]
  stop(scope: CollaborationScope, reason: string, at: Timestamp): StopResult
  /** 显式用户继续；只开放指定范围，不清除旧执行的取消事实，不自动接受排队委派。 */
  resume(scope: CollaborationScope, at: Timestamp): void
  beginClosing(collaborationId: CollaborationId, at: Timestamp): void
  closeCollaboration(collaborationId: CollaborationId, at: Timestamp): { readonly closed: boolean; readonly blockers: readonly string[] }
  operation(operationId: OperationId): OperationResult | undefined
}
