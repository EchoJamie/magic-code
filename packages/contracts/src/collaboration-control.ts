import type { AgentId, DelegationId, MessageId, SessionId } from './ids.ts'
import type { AgentIdentity, AgentMessage, Collaboration, CollaborationWait, Delegation, MessagePart } from './collaboration.ts'
import type { ModelSwitchRequest, UserInput } from './control.ts'
import type { Entry } from './entries.ts'
import type { RunRow } from './runs.ts'
import type { ModelUsage } from './ports.ts'
import type { ReasoningSetting } from './model.ts'

/** 模型入口不接受 sender、工作区、授权来源或当前委派覆盖值。它们由宿主绑定。 */
export type CollaborationRequest =
  | { readonly action: 'list' }
  | { readonly action: 'consult'; readonly operationId: string; readonly question: string; readonly body?: readonly MessagePart[]; readonly reasoning?: ReasoningSetting }
  | { readonly action: 'spawn'; readonly operationId: string; readonly name: string; readonly role?: string; readonly responsibility: string; readonly scope: string; readonly body: readonly MessagePart[]; readonly model?: ModelSwitchRequest; readonly modelReason?: string }
  | { readonly action: 'delegate'; readonly operationId: string; readonly recipient: AgentId; readonly scope: string; readonly body: readonly MessagePart[] }
  | { readonly action: 'send'; readonly operationId: string; readonly recipients: readonly AgentId[]; readonly purpose: 'inform' | 'question' | 'reply' | 'decision'; readonly body: readonly MessagePart[]; readonly replyTo?: MessageId; readonly discussionRoot?: MessageId; readonly startDiscussion?: boolean }
  | { readonly action: 'respond'; readonly operationId: string; readonly delegation: DelegationId; readonly response: 'accept' | 'reject' | 'clarify'; readonly reason?: string }
  | { readonly action: 'deliver'; readonly operationId: string; readonly delegation: DelegationId; readonly conclusion: string; readonly artifacts: readonly string[]; readonly verified: readonly string[]; readonly unresolved: readonly string[] }
  | { readonly action: 'receive'; readonly delegation: DelegationId }
  | { readonly action: 'read'; readonly message: MessageId; readonly discussion?: boolean }
  | { readonly action: 'wait'; readonly operationId: string; readonly agents: readonly AgentId[]; readonly message?: MessageId; readonly expectation: string; readonly deadline: number }
  | { readonly action: 'stop'; readonly delegation?: DelegationId; readonly reason: string }
  | { readonly action: 'close' }

export type CollaborationReply = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }
export type CollaborationClient = { request(input: CollaborationRequest): Promise<CollaborationReply> }

/** 仅从实际模型事件汇总；任一调用未报告的字段保持未知。 */
export type CollaborationUsage = ModelUsage & { readonly calls: number; readonly reportedCalls: number }
export type CollaborationMemberView = {
  readonly usage?: CollaborationUsage
  readonly agent: AgentIdentity
  readonly runtime?: RunRow
  readonly delegation?: Delegation
  readonly waiting?: CollaborationWait
  readonly pendingDecisions: number
}
/** 关系查询的快照。成员正文仅在明确查看时取，不能复制为整体日志。 */
export type CollaborationView = {
  readonly usage?: CollaborationUsage
  readonly originSession: SessionId
  readonly collaboration?: Collaboration
  readonly members: readonly CollaborationMemberView[]
  readonly delegations: readonly Delegation[]
  readonly waits: readonly CollaborationWait[]
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
