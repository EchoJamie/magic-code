import type { AgentIdentity, AgentModelConfig, CollaborationRecords, ToolCall } from '@magic/contracts'
import type { CollaborationBoundary } from '@magic/conversation'

/** 每个执行实例只认自己的持久身份。模型参数没有重绑身份/委派的入口。 */
export function createCollaborationBoundary(input: {
  readonly records: CollaborationRecords
  readonly session: string
  readonly runId: string
  readonly model: () => AgentModelConfig | undefined
  readonly tools: () => readonly string[] | undefined
  readonly changed: () => void
  readonly now: () => number
}) {
  const records = input.records
  let requestedWaits: readonly number[] = []
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
  const boundary: CollaborationBoundary = {
    async consume() {
      const state = binding()
      if (state === undefined) return false
      const fresh = records.consumeInbox(state.self.agentId, input.now())
      const outcomes = records.consumeWaitOutcomes(state.self.agentId, input.now())
      if (fresh.length > 0 || outcomes.length > 0) input.changed()
      return records.inbox(state.self.agentId).some(item => item.state === 'consumed' && item.includedAt === undefined
        && records.readMessage(state.self.agentId, item.messageId)?.purpose !== 'receipt')
        || records.listWaits(state.collaboration.collaborationId).some(wait => wait.agentId === state.self.agentId
          && wait.state !== 'waiting' && wait.handledAt !== undefined && wait.includedAt === undefined)
    },
    async context() {
      const state = binding()
      if (state === undefined) return undefined
      const { self, collaboration, delegation } = state
      const assignments = records.listDelegations(collaboration.collaborationId).filter(d =>
        (d.assigneeId === self.agentId || d.delegatorId === self.agentId) && !['received', 'rejected', 'cancelled'].includes(d.state))
      const constraints = records.listConstraints(collaboration.collaborationId).filter(c => c.active &&
        (c.affectedAgents === undefined || c.affectedAgents.includes(self.agentId)))
      const waits = records.listWaits(collaboration.collaborationId).filter(w => w.agentId === self.agentId)
      requestedWaits = waits.filter(w => w.state !== 'waiting' && w.handledAt !== undefined && w.includedAt === undefined).map(w => w.waitId)
      return `身份：${self.name}（${self.agentId}）。协调者：${collaboration.coordinatorId}。\n` +
        `原交代：${collaboration.origin.sessionId}#${collaboration.origin.entryId}\n` +
        `职责：${self.responsibility ?? self.role}\n` +
        `当前委派：${delegation === undefined ? self.agentId === collaboration.coordinatorId ? '原入口负责推进、核验与整合，可自行执行原交代范围内的工作' : '尚无已接受委派；只能判断和澄清，不执行工作操作' : `${delegation.delegationId} · ${delegation.scope}`}\n` +
        `未结束请求：${JSON.stringify(assignments)}\n` +
        `共同约束消息：${constraints.map(c => c.messageId).join('、') || '无'}\n` +
        `等待：${JSON.stringify(waits)}`
    },
    admit(call) {
      const state = binding()
      if (state === undefined) return undefined
      if (call !== undefined && !call.name.startsWith('agent_')) {
        const allowed = input.tools()
        if (allowed !== undefined && !allowed.includes(call.name)) return `角色没有开放工具 ${call.name}`
      }
      const decision = records.checkAdmission(state.self.agentId, state.delegation?.delegationId,
        call === undefined || call.name.startsWith('agent_') ? 'coordination' : 'work')
      return decision.allowed ? undefined : decision.reason
    },
    requested(messageIds = []) {
      const state = binding()
      if (state === undefined || (messageIds.length === 0 && requestedWaits.length === 0)) return
      const consumed = new Set(records.inbox(state.self.agentId).filter(i => i.state === 'consumed').map(i => i.messageId))
      records.markIncluded(state.self.agentId, messageIds.filter(id => consumed.has(id)), input.now())
      records.markWaitOutcomesIncluded(state.self.agentId, requestedWaits, input.now())
      requestedWaits = []
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
    begin(call?: ToolCall): () => void {
      const state = binding()
      if (state === undefined) return () => undefined
      if (call !== undefined && !call.name.startsWith('agent_') && records.inbox(state.self.agentId).some(i => i.state === 'pending' && records.readMessage(state.self.agentId, i.messageId)?.purpose !== 'receipt')) throw new Error('等待期间收到新交代；先重新判断，再执行工具')
      const problem = boundary.admit(call)
      if (problem !== undefined) throw new Error(problem)
      const operationId = `${input.runId}:${crypto.randomUUID()}`
      records.beginExecution(state.self.agentId, { operationId, at: input.now(), runId: input.runId,
        kind: call === undefined ? 'model' : 'tool',
        mode: call === undefined || call.name.startsWith('agent_') ? 'coordination' : 'work',
        ...(state.delegation === undefined ? {} : { delegationId: state.delegation.delegationId }),
      })
      return () => { records.finishExecution(operationId); input.changed() }
    },
  }
}
