import type { AgentIdentity, AgentModelConfig, Collaboration, CollaborationRecords, CollaborationReply, CollaborationRequest, Delegation, EntryReference, KnowledgeRecords, KnowledgeReference, RecordsService, StopResult, ToolCall } from '@magic/contracts'
import type { CollaborationBoundary } from '@magic/conversation'

/**
 * **准入拒绝理由 → 面向模型/用户的文案**（T2.2 · N14）。
 *
 * 账本层的拒绝理由是英文代码 token（`checkAdmission` 的 reason），原样漏进回执就是
 * 一句谁也读不懂的话。N14 的定案：准入失败＝**这一轮没有开始执行**（输入还在账本上，
 * 会自动继续——engine 对账兜底补发），用户的动作是**立即再试**（触发 consume，非 retry
 * ——输入没失败过，retry 是错误出口）。未知 token 原样带出（不吞原因）。
 */
function admissionRefusalOf(reason: string): string {
  const cause =
    reason === 'host admission closed' ? '宿主正在退出'
    : reason === 'collaboration or agent admission closed' ? '协作已停止或成员准入已关闭'
    : reason === 'delegation not accepted or cancelled' ? '当前委派未接受或已取消'
    : reason === 'active delegation binding required' ? '这一成员须先接受委派，才能执行工作操作'
    : reason === 'cancellation settling' ? '停止请求正在收尾'
    : reason
  return (
    `这一轮没有开始执行（${cause}）——这一条会自动继续，不需要重发。` +
    '需要用户：可在输入管理里「立即再试」（立即消费这条输入；不是重试——它没有失败过）。'
  )
}

/** 每个执行实例只认自己的持久身份。模型参数没有重绑身份/委派的入口。 */
export function createCollaborationBoundary(input: {
  readonly records: CollaborationRecords
  readonly ownNoteCall?: (call: ToolCall) => boolean
  readonly materials?: Pick<RecordsService, 'readEntries'>
  readonly knowledge?: KnowledgeRecords
  readonly session: string
  readonly runId: string
  readonly model: () => AgentModelConfig | undefined
  /** 装配端提供与模型工具和运行时相同的可用集合；此处仅叠加生命周期准入。 */
  readonly tools: () => readonly string[] | undefined
  readonly changed: () => void
  readonly now: () => number
}) {
  const resourceControl = (name: string) => name === 'background_stop' || name === 'background_wait'
  const coordinating = (call?: ToolCall) => call === undefined || call.name.startsWith('agent_') || ['plan_read', 'plan_update', 'history_read', 'source_read'].includes(call.name) || input.ownNoteCall?.(call) === true || resourceControl(call.name)
  const records = input.records
  const actor = (): AgentIdentity | undefined => {
    const existing = records.agentForSession(input.session)
    if (existing !== undefined) return existing
    const model = input.model()
    if (model === undefined) return undefined
    return records.registerAgent({ operationId: `identity:${input.session}`, sessionId: input.session,
      name: '入口', role: '', model, at: input.now() })
  }
  const binding = () => {
    const self = actor()
    if (self?.collaborationId === undefined) return undefined
    const collaboration = records.getCollaboration(self.collaborationId)
    if (collaboration === undefined) return undefined
    const delegation = records.listDelegations(collaboration.collaborationId).find(d => d.assigneeId === self.agentId && d.state === 'accepted')
    return { self, collaboration, delegation }
  }
  type Provided = (references: readonly KnowledgeReference[]) => void
  const description = async (text: string | undefined, source: EntryReference | undefined, provided?: Provided): Promise<string | undefined> => {
    if (text === undefined || source === undefined || input.materials === undefined) return text
    for await (const entry of input.materials.readEntries(source.sessionId, { from: source.entryId, to: source.entryId })) {
      const references = entry.payload !== undefined && 'knowledge' in entry.payload ? entry.payload.knowledge ?? [] : []
      provided?.(references)
    }
    return text
  }
  const scopeSource = (delegation: Delegation) => records.readMessage(delegation.assigneeId, delegation.delegationId)?.generatedFrom
  const projectDelegation = async (delegation: Delegation, provided?: Provided): Promise<Delegation> => ({ ...delegation,
    scope: (await description(delegation.scope, scopeSource(delegation), provided))!, reason: await description(delegation.reason, delegation.reasonFrom, provided) })
  const projectAgent = async (agent: AgentIdentity, provided?: Provided): Promise<AgentIdentity> => {
    const original = agent.collaborationId === undefined ? undefined : records.listDelegations(agent.collaborationId).find(d => d.assigneeId === agent.agentId)
    return { ...agent, responsibility: await description(agent.responsibility, original === undefined ? undefined : scopeSource(original), provided) }
  }
  const boundary: CollaborationBoundary = {
    async consume() {
      const state = binding()
      if (state === undefined) return false
      const fresh = records.consumeInbox(state.self.agentId, input.now())
      if (fresh.length > 0) input.changed()
      return records.inbox(state.self.agentId).some(item => item.state === 'consumed' && item.includedAt === undefined
        && records.readMessage(state.self.agentId, item.messageId)?.purpose !== 'receipt')
    },
    async context(provided) {
      const state = binding()
      if (state === undefined) return undefined
      const { self, collaboration, delegation } = state
      const allDelegations = records.listDelegations(collaboration.collaborationId)
      const assignments = await Promise.all(allDelegations.filter(d =>
        (d.assigneeId === self.agentId || d.delegatorId === self.agentId) && !['received', 'rejected', 'cancelled'].includes(d.state))
        .map(d => projectDelegation(d, provided)))
      const constraints = records.listConstraints(collaboration.collaborationId).filter(c => c.active &&
        (c.affectedAgents === undefined || c.affectedAgents.includes(self.agentId)))
      const displayedSelf = await projectAgent(self, provided)
      const current = assignments.find(item => item.delegationId === delegation?.delegationId)
      return `身份：${self.name}（${self.agentId}）。协调者：${collaboration.coordinatorId}。\n` +
        `原交代：${collaboration.origin.sessionId}#${collaboration.origin.entryId}\n` +
        `职责：${displayedSelf.responsibility ?? self.role}\n` +
        `当前委派：${delegation === undefined ? self.agentId === collaboration.coordinatorId ? '原入口负责推进、核验与整合，可自行执行原交代范围内的工作' : '尚无已接受委派；只能判断和澄清，不执行工作操作' : `${delegation.delegationId} · ${current?.scope}`}\n` +
        `未结束请求：${JSON.stringify(assignments)}\n` +
        `共同约束消息：${constraints.map(c => c.messageId).join('、') || '无'}`
    },
    admit(call) {
      const state = binding()
      if (state === undefined) return undefined
      if (call !== undefined) {
        const allowed = input.tools()
        if (allowed !== undefined && !allowed.includes(call.name)) return `当前执行者没有开放工具 ${call.name}`
      }
      const decision = records.checkAdmission(state.self.agentId, state.delegation?.delegationId,
        coordinating(call) ? 'coordination' : 'work')
      return decision.allowed ? undefined : admissionRefusalOf(decision.reason)
    },
    requested(messageIds = []) {
      const state = binding()
      if (state === undefined || messageIds.length === 0) return
      const consumed = new Set(records.inbox(state.self.agentId).filter(i => i.state === 'consumed').map(i => i.messageId))
      records.markIncluded(state.self.agentId, messageIds.filter(id => consumed.has(id)), input.now())
      input.changed()
    },
    userInput(entryId, shared) {
      if (!shared) return
      const state = binding()
      if (state === undefined) throw new Error('当前会话尚未展开协作')
      const source = { sessionId: input.session, entryId }
      records.publishConstraint(state.self.agentId, { operationId: `user:${input.session}:${entryId}`,
        source, body: [{ kind: 'entry', ref: source }], at: input.now() })
      input.changed()
    },
  }
  return {
    boundary,
    actor,
    /** 模型查询与系统描述使用同一投影；原始消息的显式 read 仍由消息依赖链处理。 */
    async projectReply(request: CollaborationRequest, reply: CollaborationReply): Promise<CollaborationReply> {
      if (!reply.ok || reply.value === undefined || reply.value === null) return reply
      const references = new Map((reply.knowledge ?? []).map(reference => [`${reference.id}\0${reference.revision}`, reference]))
      const provided: Provided = items => { for (const item of items) references.set(`${item.id}\0${item.revision}`, item) }
      let value = reply.value
      if (request.action === 'list') {
        const list = value as { self: AgentIdentity; members: readonly AgentIdentity[]; collaboration?: Collaboration; delegations?: readonly Delegation[] }
        value = { ...list, self: await projectAgent(list.self, provided), members: await Promise.all(list.members.map(agent => projectAgent(agent, provided))),
          ...(list.collaboration === undefined ? {} : { collaboration: { ...list.collaboration, reason: await description(list.collaboration.reason, list.collaboration.reasonFrom, provided) } }),
          ...(list.delegations === undefined ? {} : { delegations: await Promise.all(list.delegations.map(d => projectDelegation(d, provided))) }) }
      } else if (request.action === 'spawn') {
        const spawned = value as { agent: AgentIdentity; delegation: Delegation }
        value = { ...spawned, agent: await projectAgent(spawned.agent, provided), delegation: await projectDelegation(spawned.delegation, provided) }
      } else if (request.action === 'delegate' || request.action === 'receive') value = await projectDelegation(value as Delegation, provided)
      else if (request.action === 'respond') {
        const response = value as { delegation: Delegation; reason?: string }
        value = { ...response, delegation: await projectDelegation(response.delegation, provided), reason: await description(response.reason, request.generatedFrom, provided) }
      } else if (request.action === 'close') {
        const response = value as { pending: readonly Delegation[] }
        value = { ...response, pending: await Promise.all(response.pending.map(d => projectDelegation(d, provided))) }
      } else if (request.action === 'stop') {
        const stopped = value as StopResult
        value = { ...stopped, executions: await Promise.all(stopped.executions.map(async execution => ({ ...execution, reason: await description(execution.reason, execution.reasonFrom, provided) }))) }
      }
      return { ok: true, value, ...(references.size ? { knowledge: [...references.values()] } : {}) }
    },
    begin(call?: ToolCall): () => void {
      const state = binding()
      if (state === undefined) return () => undefined
      if (call !== undefined && !coordinating(call) && records.inbox(state.self.agentId).some(i => i.state === 'pending' && records.readMessage(state.self.agentId, i.messageId)?.purpose !== 'receipt')) throw new Error('等待期间收到新交代；先重新判断，再执行工具')
      const problem = boundary.admit(call)
      if (problem !== undefined) throw new Error(problem)
      const operationId = `${input.runId}:${crypto.randomUUID()}`
      records.beginExecution(state.self.agentId, { operationId, at: input.now(), runId: input.runId,
        kind: call === undefined ? 'model' : 'tool',
        mode: coordinating(call) ? 'coordination' : 'work',
        ...(state.delegation === undefined ? {} : { delegationId: state.delegation.delegationId }),
      })
      return () => { records.finishExecution(operationId); input.changed() }
    },
  }
}
