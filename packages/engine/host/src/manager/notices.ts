import type { AttentionItem, BackgroundView, CollaborationView, Command, KernelEvent, NoticeKind } from '@magic/contracts'
import { noticeKey } from '@magic/host'
import { readSessionDisplayHistory } from '@magic/conversation'
import type { ClientConn } from '../connections.ts'
import type { ManagerContext } from './context.ts'

/** 提醒、后台视图与协作事件——只读现有事实，不另立状态。 */
export function installNotices(ctx: ManagerContext): void {
  const { now, store, executors, lastRuns, connections, sessions } = ctx
  const { workRoot, isArchived, canArchive } = sessions

  function backgroundView(session: string): BackgroundView {
    const root = workRoot(session)
    const current = new Map([...lastRuns.values()].map(run => [run.session ?? run.executionId, run]))
    for (const executor of executors) current.set(executor.run.session ?? executor.executionId, executor.run)
    const runs = [...current.values()].filter(run => run.session !== null && workRoot(run.session) === root
      && (run.ended === undefined || run.reclaimPending || run.reclaimNote !== undefined))
    const commands = runs.flatMap(run => (run.backgroundView?.commands ?? []).filter(command => command.execution === run.executionId && command.session === run.session).map(command => {
      const member = command.session === root ? undefined : store.collaboration.agentForSession(command.session)
      return { ...command, ...(member ? { member: member.name, agent: member.agentId } : {}) }
    })).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || `${a.execution}:${a.id}`.localeCompare(`${b.execution}:${b.id}`))
    return {
      commands, waiting: runs.flatMap(run => run.backgroundView?.waiting ?? []),
      ...(runs.some(run => !run.connected || run.backgroundView === undefined || run.reclaimPending || run.reclaimNote !== undefined) ? { unknown: true as const } : {})
    }
  }

  function publishBackground(conn: ClientConn, result?: BackgroundView['result']): void {
    if (conn.selectedSession === null || conn.link.closed) return
    const session = workRoot(conn.selectedSession)
    conn.link.send({
      t: 'ev', gen: conn.target?.gen ?? null, event: {
        kind: 'background.state', id: 0, turn: null, at: now(), session,
        data: { ...backgroundView(session), ...(result ? { result } : {}) }
      }
    })
  }

  function backgroundCommand(conn: ClientConn, command: Extract<Command, { type: `background.${string}` }>): void {
    if (command.type === 'background.list') { publishBackground(conn); return }
    const target = command.target
    const executor = ctx.liveOf(target.session)
    if (!executor && conn.selectedSession !== null && workRoot(target.session) === workRoot(conn.selectedSession)) {
      const fact = store.serviceFor(target.session).inputs.get(`background:${target.execution}:${target.id}`)?.input.background
      if (fact && !('state' in fact)) {
        publishBackground(conn, { target, outcome: { ok: true, already: true, note: `${target.id} 已经结束`, finish: fact } })
        return
      }
    }
    const problem = conn.selectedSession === null || workRoot(target.session) !== workRoot(conn.selectedSession)
      ? '目标不属于当前整件工作'
      : executor?.executionId !== target.execution ? '执行代次已改变或已经结束'
        : executor === undefined || !executor.run.connected || executor.link.closed ? '执行实例失联，无法确认命令状态' : undefined
    if (problem || !executor) { publishBackground(conn, { target, outcome: { ok: false, reason: problem ?? '目标不存在' } }); return }
    ctx.deliver(executor, command)
  }

  function collaborationEvent(conn: ClientConn, view: CollaborationView): boolean {
    const selected = conn.selectedSession
    if (conn.link.closed || selected == null ||
      (store.collaboration.collaborationForSession(selected)?.originSessionId ?? selected) !== view.originSession) return false
    return conn.link.send({
      t: 'ev', gen: conn.target?.gen ?? null, event: {
        kind: 'collaboration.view', data: view, session: view.originSession,
        id: 0, turn: null, at: now(),
      }
    })
  }

  /** D68：任何把「当前会话自身」当成要查看成员的请求都按没有选择处理。 */
  function viewingSelfGuard(conn: ClientConn, member: string | undefined): string | undefined {
    if (member === undefined || conn.selectedSession === null) return member
    if (store.collaboration.getAgent(member)?.sessionId !== conn.selectedSession) return member
    connections.selectMember(conn, undefined)
    return undefined
  }

  async function publishCollaboration(conn: ClientConn): Promise<void> {
    if (ctx.stopped || ctx.storeClosed) return
    publishBackground(conn)
    const session = conn.selectedSession
    if (session === undefined || session === null) return
    try {
      const member = viewingSelfGuard(conn, conn.collaborationMember)
      const view = await ctx.collaboration.view(session, member)
      if (member !== conn.collaborationMember) return
      if (view.collaboration !== undefined) collaborationEvent(conn, view)
    } catch { /* 离开或停止过程中不启动新的执行。 */ }
  }

  /** 当前提醒只能引用原事实；旧通知行本身不能证明还有一个停点。 */
  function reconcileNotice(session: string): AttentionItem | undefined {
    const root = workRoot(session)
    const notice = store.attention.list({ sessions: [root] })[0]
    if (notice === undefined) return undefined
    const source = notice.source ?? (/^\d+$/.test(notice.fact) ? { session: root, event: Number(notice.fact) } : undefined)
    const event = source?.event === undefined ? undefined : store.readEvent(source.session, source.event)
    const boundary = source === undefined ? undefined : store.latestEvent(source.session, ['turn.start', 'turn.end', 'message.user'])
    let valid = !isArchived(root) && source !== undefined && workRoot(source.session) === root
    // U129 起「需要你」不再由逐次授权产生；旧的这一类提醒一律失效。
    if (notice.kind === 'needs-you') valid = false
    else if (notice.kind === 'done') valid &&= event?.kind === 'turn.end' && event.data.reason === 'settled' && !event.data.continues && boundary?.id === event.id && canArchive(root)
    else if (event !== undefined) valid &&= (event.kind === 'error' || event.kind === 'model.error' || event.kind === 'turn.end') && boundary?.kind === 'turn.end' && boundary.data.reason === 'error' && (event.turn === boundary.turn || event.id === boundary.id)
    else {
      const run = lastRuns.get(source?.session ?? root) ?? ctx.liveOf(root)?.run
      valid &&= run?.ended?.kind === 'crashed' && notice.fact === `${run.gen}@${run.ended.at}`
    }
    if (!valid) { store.attention.clear(root); return undefined }
    if (notice.source === undefined && source !== undefined) {
      const current = { ...notice, source }
      store.attention.clear(root)
      store.attention.put(current)
      return current
    }
    return notice
  }

  function clearTurnNotice(session: string): void {
    const root = workRoot(session)
    const current = store.attention.list({ sessions: [root] })[0]
    if (current?.kind === 'needs-you' && current.source?.session !== session) return
    store.attention.clear(root)
  }

  // 只保存当前轮的来源引用，正文在实际停点按该条目读取。
  function notify(session: string, kind: NoticeKind, fact: string | number, detail?: string, source?: { session: string; event?: number; entry?: number }, at = now()): void {
    const root = workRoot(session)
    if (isArchived(root)) return
    if (session !== root && kind !== 'needs-you') return
    const origin = source ?? { session, ...(typeof fact === 'number' ? { event: fact } : {}) }
    const notice = {
      id: noticeKey(session, kind, fact), session: root, source: origin, kind, fact: String(fact), at, unread: true, delivered: false,
      detail: `${session === root ? '' : `${store.collaboration.agentForSession(session)?.name ?? '成员'}：`}${detail ?? '本轮已收束，原内容暂不可用'}`,
    }
    if (!store.attention.put(notice)) return
    for (const conn of ctx.terminalClients(root)) conn.link.send({ t: 'notice', notice })
    ctx.native.changed()
  }

  async function notifyStop(run: import('@magic/host').RunRecord, event: KernelEvent): Promise<void> {
    const session = run.session
    if (session === null || (run.lastTurn !== 'settled' && run.lastTurn !== 'error')) return
    if (event.kind === 'turn.end' && event.data.continues) return
    const content = ctx.stopContent.get(run)
    const stop = content?.stop ?? event
    if (stop.kind === 'turn.end' && stop.data.continues) return
    const at = run.lastTurnAt
    const kind = run.lastTurn === 'error' ? 'failed' : 'done'
    let detail = content?.error
    if (kind === 'done' && content?.entry !== undefined) {
      for await (const entry of readSessionDisplayHistory(store, session, { from: content.entry, to: content.entry })) {
        detail = 'text' in entry.content ? entry.content.text : undefined
      }
    }
    if (ctx.stopContent.get(run) !== content || run.lastTurnAt !== at || run.turnActive || run.busy || run.backgroundView?.waiting.length || isArchived(session)) return
    const group = store.collaboration.collaborationForSession(session)
    if (group !== undefined && kind === 'done' && (group.originSessionId !== session
      || store.collaboration.listDelegations(group.collaborationId).some(one => !['received', 'rejected', 'cancelled'].includes(one.state))
      || backgroundView(session).waiting.length > 0)) return
    notify(session, kind, stop.id, detail ?? (kind === 'failed' ? '本轮无法继续，具体错误暂不可用' : '本轮已收束，面向用户的回复暂不可用'),
      { session, event: kind === 'failed' ? content?.event ?? stop.id : stop.id, ...(kind === 'done' && content?.entry !== undefined ? { entry: content.entry } : {}) }, stop.at)
  }

  ctx.backgroundView = backgroundView
  ctx.publishBackground = publishBackground
  ctx.backgroundCommand = backgroundCommand
  ctx.collaborationEvent = collaborationEvent
  ctx.viewingSelfGuard = viewingSelfGuard
  ctx.publishCollaboration = publishCollaboration
  ctx.reconcileNotice = reconcileNotice
  ctx.clearTurnNotice = clearTurnNotice
  ctx.notify = notify
  ctx.notifyStop = notifyStop
}
