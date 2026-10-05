import {readSessionDisplayHistory} from '@magic/conversation'
import type {
  AgentIdentity, AgentModelConfig, CollaborationCommand, CollaborationReply, CollaborationRequest,
  CollaborationView, CollaborationUsage, Entry, MagicHome, ModelUsage, RunRow, StopResult, UserInput,
} from '@magic/contracts'
import { createCollaborationActions } from '@magic/actions'
import type { RecordsStore } from '@magic/records'
import { managedModelChoices, resolveManagedModel } from '../agent-models.ts'

export type CollaborationHost = {
  readonly store: RecordsStore
  readonly magic: MagicHome
  readonly now: () => number
  readonly accepting: () => boolean
  readonly start: (agent: AgentIdentity) => Promise<void>
  readonly wake: (session: string) => void
  readonly cancel: (sessions: readonly string[]) => Promise<void>
  readonly input: (session: string, input: UserInput, shared: boolean) => void
  readonly configure: (session: string, model: AgentModelConfig) => Promise<void>
  readonly runs: () => readonly RunRow[]
  readonly decisions: (session: string) => number
  readonly changed: () => void
}

/** 由 App 管理者持有的协作运行适配；定时器只服务持久截止点，不轮询模型。 */
export function createManagedCollaboration(host: CollaborationHost) {
  const records = host.store.collaboration
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let closing = false
  const waking = new Map<string, Promise<void>>()
  const finishing = new Set<string>()
  const actions = createCollaborationActions({
    records, now: host.now,
    modelChoices: () => managedModelChoices(host.magic),
    origin: async actor => {
      for await (const entry of host.store.readEntries(actor.sessionId)) if (entry.kind === 'user') return { sessionId: actor.sessionId, entryId: entry.id }
      throw new Error('找不到这份工作的原始用户交代')
    },
    resolveModel: input => resolveManagedModel({ magic: host.magic, ...input }),
    start: async agent => {
      if (closing || !host.accepting()) throw new Error('宿主正在退出')
      await host.start(agent)
    },
    wake,
    cancel: cancelResult,
    changed,
  })

  function admission(agent: AgentIdentity): boolean {
    if (closing || !host.accepting() || agent.collaborationId === undefined) return false
    const active = records.listDelegations(agent.collaborationId).find(d => d.assigneeId === agent.agentId && d.state === 'accepted')
    return records.checkAdmission(agent.agentId, active?.delegationId, 'coordination').allowed
  }
  function wake(agentId: string): void {
    const agent = records.getAgent(agentId)
    if (agent === undefined || !admission(agent) || waking.has(agentId)) return
    const pending = (async () => {
      try { await host.start(agent); if (admission(agent)) host.wake(agent.sessionId) }
      catch (error) {
        for (const wait of records.interruptWaits(agentId, String(error))) if (wait.agentId !== agentId) wake(wait.agentId)
        host.changed()
      }
    })().finally(() => waking.delete(agentId))
    waking.set(agentId, pending)
  }
  async function cancelResult(stopped: StopResult): Promise<void> {
    await host.cancel(stopped.agents.flatMap(id => { const a = records.getAgent(id); return a === undefined ? [] : [a.sessionId] }))
  }
  function changed(): void {
    host.changed()
    void schedule()
  }
  async function collaborations() {
    const ids = new Set<string>()
    const sessions = await host.store.listSessions()
    if (closing) return []
    for (const session of sessions) {
      const agent = records.agentForSession(session.id)
      if (agent?.collaborationId !== undefined) ids.add(agent.collaborationId)
    }
    return [...ids]
  }
  async function schedule(): Promise<void> {
    if (closing) return
    const ids = await collaborations()
    if (closing) return
    const outcomes = ids.flatMap(id => records.listWaits(id))
    for (const wait of outcomes) if (wait.state !== 'waiting' && wait.handledAt === undefined) wake(wait.agentId)
    for (const id of ids) for (const member of records.listMembers(id)) {
      if (records.inbox(member.agentId).some(i => i.state === 'pending' && records.readMessage(member.agentId, i.messageId)?.purpose !== 'receipt')) wake(member.agentId)
    }
    const waits = outcomes.filter(w => w.state === 'waiting')
    const live = new Set(waits.map(w => w.waitId))
    for (const [id, timer] of timers) if (!live.has(id)) { clearTimeout(timer); timers.delete(id) }
    for (const wait of waits) {
      if (timers.has(wait.waitId)) continue
      const agent = records.getAgent(wait.agentId)
      if (agent === undefined || !admission(agent)) continue
      const timer = setTimeout(() => {
        timers.delete(wait.waitId)
        if (closing) return
        for (const expired of records.expireWaits(host.now())) wake(expired.agentId)
        changed()
      }, Math.min(2_147_483_647, Math.max(0, wait.deadline - host.now())))
      timer.unref?.()
      timers.set(wait.waitId, timer)
    }
  }
  async function view(session: string, member?: string, note?: string): Promise<CollaborationView> {
    const collaboration = records.collaborationForSession(session)
    if (collaboration === undefined) return { originSession: session, members: [], delegations: [], waits: [], constraints: [], ...(note === undefined ? {} : { note }) }
    const id = collaboration.collaborationId
    const members = records.listMembers(id)
    const usage = await Promise.all(members.map(async agent => {
      let calls = 0
      const reports: ModelUsage[] = []
      for await (const event of host.store.serviceFor(agent.sessionId).readEvents(agent.sessionId)) {
        if (event.kind === 'model.call.start') calls++
        if (event.kind === 'model.usage') reports.push(event.data)
      }
      return usageOf(reports, calls)
    }))
    const delegations = records.listDelegations(id)
    const waits = records.listWaits(id)
    const memberDelegation = (agent: string) => delegations.find(d => d.assigneeId === agent && d.state === 'accepted')
      ?? delegations.filter(d => d.assigneeId === agent).at(-1)
    const memberWait = (agent: string) => waits.find(w => w.agentId === agent && w.state === 'waiting')
      ?? waits.filter(w => w.agentId === agent && w.handledAt === undefined).at(-1)
    const selected = member === undefined ? undefined : members.find(a => a.agentId === member)
    if (member !== undefined && selected === undefined) throw new Error('成员不属于这份工作')
    const entries: Entry[] = []
    if (selected !== undefined) for await (const entry of readSessionDisplayHistory(host.store,selected.sessionId)) entries.push(entry)
    const messages = selected === undefined ? [] : records.listMessages(selected.agentId)
    return {
      originSession: collaboration.originSessionId, collaboration, usage: sumUsage(usage),
      members: members.map((agent, index) => ({ agent, usage: usage[index]!,
        ...(host.runs().find(run => run.session === agent.sessionId) === undefined ? {} : { runtime: host.runs().find(run => run.session === agent.sessionId)! }),
        ...(memberDelegation(agent.agentId) === undefined ? {} : { delegation: memberDelegation(agent.agentId)! }),
        ...(memberWait(agent.agentId) === undefined ? {} : { waiting: memberWait(agent.agentId)! }),
        pendingDecisions: host.decisions(agent.sessionId),
      })), delegations, waits,
      constraints: records.listConstraints(id).filter(c => c.active).map(c => ({ messageId: c.messageId, states: records.constraintStatus(c.messageId) })),
      ...(selected === undefined ? {} : { selectedMember: selected.agentId, entries, messages }),
      ...(note === undefined ? {} : { note }),
    }
  }
  return {
    view, changed,
    failed(session: string, reason: string) {
      const agent = records.agentForSession(session)
      if (agent?.collaborationId === undefined) return
      for (const wait of records.interruptWaits(agent.agentId, reason)) if (wait.agentId !== agent.agentId) wake(wait.agentId)
      changed()
    },
    async idle(session: string): Promise<boolean> {
      const work = records.collaborationForSession(session)
      if (work?.state !== 'closing' || work.originSessionId !== session || finishing.has(work.collaborationId)) return false
      // 收齐结果且工作调用已结算后才释放空闲宿主资源；闭合事实要晚于资源确证。
      const unresolved = records.listDelegations(work.collaborationId).some(d =>
        !['received', 'rejected', 'cancelled'].includes(d.state) || (d.deliveryMessageId !== undefined && d.receivedAt === undefined))
      if (unresolved || records.listExecutions(work.collaborationId).some(e => e.state !== 'finished')) return false
      finishing.add(work.collaborationId)
      try {
        await host.cancel(records.listMembers(work.collaborationId).map(a => a.sessionId))
        if (closing || records.getCollaboration(work.collaborationId)?.state !== 'closing') return false
        const outcome = records.closeCollaboration(work.collaborationId, host.now())
        changed()
        return outcome.closed
      } finally { finishing.delete(work.collaborationId) }
    },
    async request(session: string, request: CollaborationRequest): Promise<CollaborationReply> {
      const agent = records.agentForSession(session)
      if (agent === undefined) return { ok: false, reason: '执行连接尚未绑定 Agent 身份' }
      if ((closing || !host.accepting()) && request.action !== 'deliver' && request.action !== 'read') return { ok: false, reason: '宿主正在退出' }
      return actions.request(agent.agentId, request)
    },
    async command(session: string, command: CollaborationCommand): Promise<CollaborationView> {
      const collaboration = records.collaborationForSession(session)
      if (command.type === 'collaboration.read') return view(session, command.member)
      if (collaboration === undefined) throw new Error('当前会话尚未展开协作')
      if (closing || !host.accepting()) throw new Error('宿主正在退出')
      switch (command.type) {
        case 'collaboration.input': {
          const target = command.member === undefined ? records.getAgent(collaboration.coordinatorId)
            : records.listMembers(collaboration.collaborationId).find(a => a.agentId === command.member)
          if (target === undefined) throw new Error('成员不属于当前工作')
          if (!admission(target)) throw new Error('这份工作已停止；请先明确继续')
          const shared = command.shared === true || command.member === undefined
          const receiver = shared ? records.getAgent(collaboration.coordinatorId)! : target
          await host.start(receiver)
          if (!admission(receiver)) throw new Error('这份工作已停止；原稿保留')
          host.input(receiver.sessionId, command.input, shared)
          break
        }
        case 'collaboration.stop': {
          if (command.delegation !== undefined && records.getDelegation(command.delegation)?.collaborationId !== collaboration.collaborationId) throw new Error('委派不属于当前工作')
          await cancelResult(records.stop(command.delegation === undefined
            ? { kind: 'collaboration', collaborationId: collaboration.collaborationId }
            : { kind: 'delegation', delegationId: command.delegation }, '用户停止', host.now()))
          break
        }
        case 'collaboration.resume':
          records.resume({ kind: 'collaboration', collaborationId: collaboration.collaborationId }, host.now())
          // 只接回入口；不重启所有旧成员、不重放工具。
          await host.start(records.getAgent(collaboration.coordinatorId)!)
          break
        case 'collaboration.configure': {
          const actor = command.member === undefined ? undefined : records.listMembers(collaboration.collaborationId).find(a => a.agentId === command.member)
          if (command.member !== undefined && actor === undefined) throw new Error('成员不属于当前工作')
          const selection = await resolveManagedModel({ magic: host.magic, defaults: actor?.model ?? collaboration.defaultModel, model: command.model })
          if (actor === undefined) records.updateDefaultModel(collaboration.collaborationId, selection)
          else { await host.configure(actor.sessionId, selection); records.updateAgent(actor.agentId, { model: selection }) }
          break
        }
      }
      changed()
      return view(collaboration.originSessionId)
    },
    /** 宿主停止受理时同步关闭持久准入，随后由管理者核销实际执行者。 */
    shutdown(reason: string) {
      closing = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      return records.stop({ kind: 'host' }, reason, host.now())
    },
    async recover() {
      // 新宿主先留下旧执行停点，再开放宿主本身；旧协作仍为 stopped。
      records.stop({ kind: 'host' }, '宿主中断，等待用户明确继续', host.now())
      records.resume({ kind: 'host' }, host.now())
    },
    executorExited(session: string, runId: string, reason: string, abnormal = false) {
      const agent = records.agentForSession(session)
      if (agent?.collaborationId === undefined) return
      if (abnormal) {
        records.setReachability(agent.agentId, 'suspended')
        for (const wait of records.interruptWaits(agent.agentId, reason)) if (wait.agentId !== agent.agentId) wake(wait.agentId)
      }
      for (const execution of records.listExecutions(agent.collaborationId)) {
        if (execution.agentId === agent.agentId && execution.runId === runId && execution.state !== 'finished') records.finishExecution(execution.operationId, reason)
      }
      changed()
    },
  }
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
function usageOf(reports: readonly ModelUsage[], calls: number): CollaborationUsage {
  const totals: Partial<Record<typeof USAGE_KEYS[number], number>> = {}
  for (const key of USAGE_KEYS) {
    if (reports.length === calls && reports.every(report => report[key] !== undefined)) totals[key] = reports.reduce((sum, report) => sum + report[key]!, 0)
  }
  return { calls, reportedCalls: reports.length, ...totals }
}
function sumUsage(members: readonly CollaborationUsage[]): CollaborationUsage {
  const totals: Partial<Record<typeof USAGE_KEYS[number], number>> = {}
  for (const key of USAGE_KEYS) if (members.every(member => member[key] !== undefined)) totals[key] = members.reduce((sum, member) => sum + member[key]!, 0)
  return { calls: members.reduce((sum, member) => sum + member.calls, 0), reportedCalls: members.reduce((sum, member) => sum + member.reportedCalls, 0), ...totals }
}
