import type {
  AgentIdentity, AgentModelConfig, CollaborationCommand, CollaborationReply, CollaborationRequest,
  CollaborationView, CollaborationUsage, MagicHome, ModelUsage, RunRow, StopResult, UserInput,
} from '@magic/contracts'
import { mergeMemberState } from './collaboration-native.ts'
import { createCollaborationActions } from '@magic/host'
import { blocksClose, type RecordsStore } from '@magic/data'
import { managedModelChoices, resolveManagedModel } from '@magic/host'

export type CollaborationHost = {
  readonly store: RecordsStore
  readonly magic: MagicHome
  readonly environment: (session: string) => Readonly<Record<string, string>>
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
  /** 逃逸口的推送（P27）——attention 落账之外同时走一次通知通道；缺省＝只落账不推送。 */
  readonly notify?: (session: string, fact: string) => void
}

/** 由 App 管理者持有的协作运行适配；定时器只服务持久截止点，不轮询模型。 */
export function createManagedCollaboration(host: CollaborationHost) {
  const records = host.store.collaboration
  let closing = false
  const waking = new Map<string, Promise<void>>()
  const finishing = new Set<string>()
  const actions = createCollaborationActions({
    records, now: host.now,
    escapeAttention: (sessionId, item) => {
      host.store.attention.put({ id: item.id, session: sessionId, kind: item.kind, fact: item.fact, at: host.now(), unread: true, delivered: false, ...(item.detail === undefined ? {} : { detail: item.detail }) })
      host.notify?.(sessionId, item.fact)
    },
    clearAttention: (_sessionId, ids) => { if (ids.length > 0) host.store.attention.markRead(ids) },
    modelChoices: session => managedModelChoices(host.magic, host.environment(session)),
    origin: async actor => {
      for await (const entry of host.store.readEntries(actor.sessionId)) if (entry.kind === 'user') return { sessionId: actor.sessionId, entryId: entry.id }
      throw new Error('找不到这份工作的原始用户交代')
    },
    resolveModel: input => resolveManagedModel({ magic: host.magic, environment: host.environment(input.session), ...input }),
    start: async agent => {
      if (closing || !host.accepting()) throw new Error('宿主正在退出')
      if (host.store.isSessionArchived(agent.sessionId)) throw new Error('会话已归档，请先明确恢复')
      await host.start(agent)
    },
    wake,
    cancel: cancelResult,
    changed,
  })

  const completing = new Set<string>()
  /** **接管/重启成员时撤下进程失败的逃逸口**（P27 读面与账本对齐）：该成员的
   * collab-fail 项在新一代开工那一刻已由接管者接手，不再需要入口关注。 */
  function clearCollabFail(agent: AgentIdentity): void {
    const work = records.collaborationForSession(agent.sessionId)
    const originSession = work?.originSessionId
    if (originSession === undefined) return
    const stale = host.store.attention
      .list({ sessions: [originSession] })
      .filter(one => one.id.startsWith('collab-fail:') && one.fact.includes(agent.name))
    if (stale.length > 0) host.store.attention.markRead(stale.map(one => one.id))
  }
  /** 入口结束自动认收（N9）：coordinator 名下 delivered 未 received 的委派代收，标「自动认收」。 */
  function autoReceiveDeliveries(collaborationId: import('@magic/contracts').CollaborationId): void {
    const work = records.getCollaboration(collaborationId)
    if (work === undefined) return
    for (const d of records.listDelegations(collaborationId)) {
      if (d.delegatorId === work.coordinatorId && d.state === 'delivered' && d.deliveryMessageId !== undefined) {
        try { records.receiveDelivery(work.coordinatorId, d.delegationId, host.now(), 'auto') } catch { /* 已终局的跳过 */ }
      }
    }
  }
  /** 交付了结（认收/放弃/自动认收）后撤下逃逸口提醒（P27 读面与账本对齐）。 */
  function markDeliverAttention(delegationId: import('@magic/contracts').DelegationId): void {
    host.store.attention.markRead([`collab-deliver:${delegationId}`])
  }
  async function completeConsultation(session: string, reason?: string, turn?: number): Promise<void> {
    const agent = records.agentForSession(session)
    if (agent?.purpose !== 'consultation' || agent.collaborationId === undefined || completing.has(session)) return
    const delegation = records.listDelegations(agent.collaborationId).find(d => d.assigneeId === agent.agentId && d.acceptedAt !== undefined)
    if (delegation === undefined || delegation.deliveryMessageId !== undefined) return
    completing.add(session)
    try {
      let entryId: number | undefined
      if (reason === undefined) {
        for await (const event of host.store.serviceFor(session).readEvents(session)) {
          if (event.kind === 'message.assistant' && event.turn === turn) entryId = event.data.entry
        }
        if (entryId === undefined) reason = '未形成完整的顾问正文'
      }
      const result = records.deliver(agent.agentId, { operationId: `consultation:${delegation.delegationId}:terminal`,
        at: host.now(), delegationId: delegation.delegationId,
        ...(reason === undefined ? {} : { reason: `咨询未完成：${reason}` }),
        body: reason === undefined ? [{ kind: 'text', text: '咨询 Arcane 已完成；这是顾问建议，采纳前请核对最新现场。' },
          { kind: 'entry', ref: { sessionId: session, entryId: entryId! }, label: '顾问最终建议' }]
          : [{ kind: 'text', text: `咨询 Arcane 未完成：${reason}。不能将半截内容当成建议或绕过依赖要求。` }],
      })
      records.setReachability(agent.agentId, 'historical')
      changed()
      if (delegation.state !== 'cancelled') for (const recipient of result.recipients) wake(recipient)
      await host.cancel([session])
    } finally { completing.delete(session) }
  }

  function admission(agent: AgentIdentity): boolean {
    if (closing || !host.accepting() || host.store.isSessionArchived(agent.sessionId) || agent.collaborationId === undefined) return false
    const active = records.listDelegations(agent.collaborationId).find(d => d.assigneeId === agent.agentId && d.state === 'accepted')
    return records.checkAdmission(agent.agentId, active?.delegationId, 'coordination').allowed
  }
  function wake(agentId: string): void {
    const agent = records.getAgent(agentId)
    if (agent === undefined || !admission(agent) || waking.has(agentId)) return
    // **总闸：工作已整体停止，协作唤醒到此为止**——收件留在账本，等用户明确继续
    // （新一代接管或恢复）后再消费。不设这一闸，「停止后借迟到的协作消息恢复执行」
    // 会在每一个 wake 调用点各漏一遍（2026-11-25 实锤：迟到的交付唤醒入口发起了
    // 模型调用）。协调者的准入例外只保证**用户会话**仍可达，不豁免协作唤醒。
    // closing 一并挡（收尾中的工作同样不该被协作消息拉回模型）。
    const work = agent.collaborationId === undefined ? undefined : records.getCollaboration(agent.collaborationId)
    if (work !== undefined && work.state !== 'open') return
    const pending = (async () => {
      try { await host.start(agent); if (admission(agent)) host.wake(agent.sessionId) }
      catch { host.changed() }
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
    // **墓碑收件不唤醒的裁决由 wake() 的生命周期总闸承担**（develop c419cf0）——
    // schedule 只是唤醒触发点之一，逐点设门会漏（总闸口径见 wake）。
    for (const id of ids) for (const member of records.listMembers(id)) {
      if (records.inbox(member.agentId).some(i => {
        if (i.state !== 'pending') return false
        const message = records.readMessage(member.agentId, i.messageId)
        if (message === undefined || message.purpose === 'receipt') return false
        // **已取消委派的交付不唤醒**（保存仍在账本，明确继续后再消费）——原只排除咨询
        // 路径的取消后交付，普通成员的同款迟到交付漏了同款防护（2026-11-25 与 consult
        // 排除对齐）：停止的工作不借迟到的交付恢复执行。
        if (message.purpose === 'delivery' && message.delegationId !== undefined
          && records.getDelegation(message.delegationId)?.state === 'cancelled') return false
        return message.purpose !== 'delivery' || records.getAgent(message.senderId)?.purpose !== 'consultation'
      })) wake(member.agentId)
    }
  }
  async function view(session: string, member?: string, note?: string, requestId?: string): Promise<CollaborationView> {
    const collaboration = records.collaborationForSession(session)
    if (collaboration === undefined) return { originSession: session, members: [], delegations: [], constraints: [], ...(note === undefined ? {} : { note }) }
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
    const memberDelegation = (agent: string) => delegations.find(d => d.assigneeId === agent && d.state === 'accepted')
      ?? delegations.filter(d => d.assigneeId === agent).at(-1)
    // 当前会话本身若就是某个成员，不能再当「查看这个成员」——那条路会重读并重发
    // 它自己的完整历史（D68）。当前会话的内容走会话历史分片与实时事件。
    const current = records.agentForSession(session)
    const selfRequest = member !== undefined && member === current?.agentId
    const selected = member === undefined || selfRequest ? undefined : members.find(a => a.agentId === member)
    if (member !== undefined && !selfRequest && selected === undefined) throw new Error('成员不属于这份工作')
    // 子会话正文里的讨论消息按来源并入；主会话不在这里携带成员历史。
    const owner = selected ?? (current !== undefined && current.collaborationId !== undefined
      && current.agentId !== collaboration.coordinatorId ? current : undefined)
    const messages = owner === undefined ? [] : records.listMessages(owner.agentId)
    return {
      originSession: collaboration.originSessionId, collaboration, usage: sumUsage(usage),
      // **总览归并委托**（T1.4）：成员格状态走同一归并语义（mergeMemberState 与 App 投影共用），
      // TUI 不再自己从 runtime 直取降级——同一协作在两边不会出现两种叙述（P12/P25）。
      members: members.map((agent, index) => {
        const row = host.runs().find(run => run.session === agent.sessionId)
        const execution = records.listExecutions(id).find(one => one.agentId === agent.agentId && one.state !== 'finished')
        return { agent, usage: usage[index]!,
          ...(row === undefined ? {} : { runtime: row }),
          merged: mergeMemberState(agent, row, execution),
          ...(memberDelegation(agent.agentId) === undefined ? {} : { delegation: memberDelegation(agent.agentId)! }),
          pendingDecisions: host.decisions(agent.sessionId),
        }
      }), delegations,
      constraints: records.listConstraints(id).filter(c => c.active).map(c => ({ messageId: c.messageId, states: records.constraintStatus(c.messageId) })),
      ...(messages.length === 0 ? {} : { messages }),
      ...(note === undefined ? {} : { note }),
      ...(requestId === undefined ? {} : { requestId }),
    }
  }
  return {
    view, changed,
    settled(session: string, turn: number | null) { return completeConsultation(session, undefined, turn ?? undefined) },
    async failed(session: string, reason: string) {
      const agent = records.agentForSession(session)
      if (agent?.collaborationId === undefined) return
      if (agent.purpose === 'consultation') { await completeConsultation(session, reason); return }
      changed()
    },
    async idle(session: string): Promise<boolean> {
      const work = records.collaborationForSession(session)
      if (work?.state !== 'closing' || work.originSessionId !== session || finishing.has(work.collaborationId)) return false
      // **收尾是发起会话的决定**，不是一次征询：不向协作者「告知」、不等它们的手头活干完、
      // 也不等它们把收到的消息读完。这里只做两件——把它们的资源收掉，然后结账。
      //
      // 唯一的前置判据是「委派了结没有」（记录域那条 `blocksClose`）：已取消的不等回执，
      // 否则等一个不会来的回执会把 closing 钉死。
      if (records.listDelegations(work.collaborationId).some(blocksClose)) return false
      finishing.add(work.collaborationId)
      try {
        // 先收资源、再结账：反过来的话，「成员还在跑」会让收尾永远等下去——
        // 而成员此刻在跑什么、跑到哪一步，本来也不该由收尾来等。
        await host.cancel(records.listMembers(work.collaborationId).map(a => a.sessionId))
        if (closing || records.getCollaboration(work.collaborationId)?.state !== 'closing') return false
        // 收的是**资源**，不是「协作者的态度」：资源没核销干净就说没干净，保留 closing 下一拍再来，
        // 不冒称收尾。这一条查的是我们自己的进程/后台命令，不是谁还没把消息读完。
        const leftover = host.runs().some(run => records.agentForSession(run.session)?.collaborationId === work.collaborationId
          && (run.holds || (run.background ?? 0) > 0 || run.backgroundUnknown || run.backgroundWaiting))
        if (leftover) return false
        const outcome = records.closeCollaboration(work.collaborationId, host.now())
        autoReceiveDeliveries(work.collaborationId)
        changed()
        return outcome.closed
      } finally { finishing.delete(work.collaborationId) }
    },
    async request(session: string, request: CollaborationRequest): Promise<CollaborationReply> {
      const agent = records.agentForSession(session)
      if (agent === undefined) return { ok: false, reason: '执行连接尚未绑定 Agent 身份' }
      if ((closing || !host.accepting()) && request.action !== 'deliver' && request.action !== 'read') return { ok: false, reason: '宿主正在退出' }
      if (host.store.isSessionArchived(session) && request.action !== 'deliver' && request.action !== 'read') return { ok: false, reason: '会话已归档，请先明确恢复' }
      return actions.request(agent.agentId, request)
    },
    async command(session: string, command: CollaborationCommand): Promise<CollaborationView> {
      let awaitRequestId: string | undefined
      const collaboration = records.collaborationForSession(session)
      if (command.type === 'collaboration.read') return view(session, command.member)
      if (collaboration === undefined) throw new Error('当前会话尚未展开协作')
      if (host.store.isSessionArchived(session) && command.type !== 'collaboration.receive' && command.type !== 'collaboration.abandon') throw new Error('会话已归档，请先明确恢复')
      if ((closing || !host.accepting()) && command.type !== 'collaboration.receive' && command.type !== 'collaboration.abandon') throw new Error('宿主正在退出')
      switch (command.type) {
        case 'collaboration.input': {
          const target = command.member === undefined ? records.getAgent(collaboration.coordinatorId)
            : records.listMembers(collaboration.collaborationId).find(a => a.agentId === command.member)
          if (target === undefined) throw new Error('成员不属于当前工作')
          if (target.purpose === 'consultation') throw new Error('咨询详情只供查看；相关纠正请补充给原工作')
          // **直接打字即继续**（2026-11-24 裁定）：停止的工作上，用户的输入就是新一代接管——
          // 不再要求「先明确继续」的独立步骤；归档的拦截在更上游（isSessionArchived）保留。
          const shared = command.shared === true
          const receiver = shared ? records.getAgent(collaboration.coordinatorId)! : target ?? records.getAgent(collaboration.coordinatorId)!
          // **直接打字即接管**（2026-11-24 裁定）：新一代开工，成员此前的进程失败逃逸口撤下。
          clearCollabFail(receiver)
          await host.start(receiver)
          host.input(receiver.sessionId, command.input, shared)
          break
        }
        case 'collaboration.stop': {
          if (command.delegation !== undefined && records.getDelegation(command.delegation)?.collaborationId !== collaboration.collaborationId) throw new Error('委派不属于当前工作')
          await cancelResult(records.stop(command.delegation === undefined
            ? { kind: 'collaboration', collaborationId: collaboration.collaborationId }
            : { kind: 'delegation', delegationId: command.delegation }, '用户停止', host.now()))
          if (command.delegation === undefined) autoReceiveDeliveries(collaboration.collaborationId)
          break
        }
        case 'collaboration.resume':
          // **resume 只切界面**（2026-11-24 裁定）：不恢复运行、不动协作状态——继续一件
          // 已停止的工作靠明确输入（新一代接管原工作）。这一支只回协作视图，界面照实显示。
          break
        case 'collaboration.receive':
        case 'collaboration.abandon': {
          // N9 出口（T3.3）：认收 → receivedAt 落账（结局「已完成」）；放弃 → received + reason='放弃认收'（结局「未完成」）。
          // coordinator 才是收/放的主体；closing/stopped 下仍可用（收敛动作）。
          const d = records.getDelegation(command.delegation)
          if (d?.collaborationId !== collaboration.collaborationId || d.delegatorId !== collaboration.coordinatorId) throw new Error('委派不属于当前工作')
          if (command.type === 'collaboration.receive') records.receiveDelivery(collaboration.coordinatorId, command.delegation, host.now(), 'manual')
          else records.abandonDelivery(collaboration.coordinatorId, command.delegation, host.now())
          markDeliverAttention(command.delegation)
          awaitRequestId = command.requestId
          break
        }
        case 'collaboration.configure': {
          const actor = command.member === undefined ? undefined : records.listMembers(collaboration.collaborationId).find(a => a.agentId === command.member)
          if (command.member !== undefined && actor === undefined) throw new Error('成员不属于当前工作')
          if (actor?.purpose === 'consultation') throw new Error('咨询固定使用启动时解析的 Arcane，不开放成员换模')
          const selection = await resolveManagedModel({ magic: host.magic, environment: host.environment(collaboration.originSessionId), defaults: actor?.model ?? collaboration.defaultModel, model: command.model })
          if (actor === undefined) records.updateDefaultModel(collaboration.collaborationId, selection)
          else { await host.configure(actor.sessionId, selection); records.updateAgent(actor.agentId, { model: selection }) }
          break
        }
      }
      changed()
      // 从子会话发来的命令要回给这条子会话（它的正文消息只属于它自己）。
      return view(session, undefined, undefined, awaitRequestId)
    },
    /** 宿主停止受理时同步关闭持久准入，随后由管理者核销实际执行者。 */
    shutdown(reason: string) {
      closing = true
      return records.stop({ kind: 'host' }, reason, host.now())
    },
    async recover() {
      // 新宿主先留下旧执行停点，再开放宿主本身；旧协作仍为 stopped。
      const interruption = '宿主中断，等待用户明确继续'
      records.stop({ kind: 'host' }, interruption, host.now())
      const unfinished: AgentIdentity[] = []
      for (const id of await collaborations()) for (const agent of records.listMembers(id)) {
        if (agent.purpose === 'consultation' && records.listDelegations(id).some(d => d.assigneeId === agent.agentId && d.state === 'cancelled' && d.acceptedAt !== undefined && d.reason === interruption && d.deliveryMessageId === undefined)) unfinished.push(agent)
      }
      records.resume({ kind: 'host' }, host.now())
      for (const agent of unfinished) {
        let terminal: Extract<import('@magic/contracts').KernelEvent, { kind: 'turn.end' }> | undefined
        for await (const event of host.store.serviceFor(agent.sessionId).readEvents(agent.sessionId)) if (event.kind === 'turn.end') terminal = event
        await completeConsultation(agent.sessionId, terminal?.data.reason === 'settled' && !terminal.data.continues ? undefined : '宿主中断，咨询未完成；不会自动重发', terminal?.turn ?? undefined)
      }
    },
    async executorExited(session: string, runId: string, reason: string) {
      const agent = records.agentForSession(session)
      if (agent?.collaborationId === undefined) return
      // **业务终态判据**（§5 Q6/N2）：不按进程退出方式——看账上是否有未交付的委派、
      // 未 finished 的 execution。有 ⇒ 挂起待核实（「未完成/丢失」的事实源）；无 ⇒ 历史化。
      // ⚠️ 只适用于**协作成员**：coordinator 是入口自己，退出是正常收束（新一代接管），
      // reachability 保持 active，不影响后续准入。
      const collaboration = records.getCollaboration(agent.collaborationId)
      const isCoordinator = agent.agentId === collaboration?.coordinatorId
      let suspended = false
      if (!isCoordinator) {
        // 「已交付待确认」是协调者侧的认收状态（N9 ackTimeout 兜底），不是成员未完成——
        // 顾问交付即完成份内事（completeConsultation 已置 historical），不在此覆写。
        const unfinishedWork =
          records.listDelegations(agent.collaborationId).some(d => d.assigneeId === agent.agentId && ['queued', 'clarification', 'accepted'].includes(d.state)) ||
          records.listExecutions(agent.collaborationId).some(e => e.agentId === agent.agentId && e.state !== 'finished')
        records.setReachability(agent.agentId, unfinishedWork ? 'suspended' : 'historical')
        suspended = unfinishedWork
      }
      for (const execution of records.listExecutions(agent.collaborationId)) {
        if (execution.agentId === agent.agentId && execution.runId === runId && execution.state !== 'finished') records.finishExecution(execution.operationId, reason)
      }
      changed()
      // **进程死亡最需要入口知情的路径**（T4 缺口补齐 · P27 同款通道）：suspended 分支
      // 向发起会话写 attention + notify——对比成员轮次失败的对称推送（lifecycle.ts）。
      // ⚠️ **不自动唤醒入口模型**（成员失败≠工作停止，自动模型调用越 P17 边界）——
      // 入口 agent 在下一轮边界从账上读到成员结局，自行决定重派或接管。
      if (suspended) {
        const originSession = collaboration?.originSessionId ?? session
        const fact = `成员 ${agent.name} 未完成：${reason}`
        host.store.attention.put({
          id: `collab-fail:${runId}`, session: originSession, kind: 'needs-you',
          fact, at: host.now(), unread: true, delivered: false,
        })
        host.notify?.(originSession, fact)
      }
      if (!isCoordinator && agent.purpose === 'consultation') await completeConsultation(session, reason)
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
