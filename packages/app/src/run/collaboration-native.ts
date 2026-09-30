import type {
  AgentIdentity, Collaboration, CollaborationRecords, CollaborationWait, Delegation,
  ExecutionAdmission, NativeWork, SessionId,
} from '@magic/contracts'

export type CollaborationNativeGroup = {
  readonly collaboration: Collaboration
  readonly members: readonly AgentIdentity[]
  readonly delegations: readonly Delegation[]
  readonly waits: readonly CollaborationWait[]
  readonly executions: readonly ExecutionAdmission[]
}

export type CollaborationNativeSnapshot = {
  /** 本拍已知目录及成员；异步读目录期间出现的新会话留到下一拍。 */
  readonly sessions: readonly SessionId[]
  /** manager 同拍取这些事实与 runs，计算整项工作停止版本。 */
  readonly groups: readonly CollaborationNativeGroup[]
}

/** 必须在 await projectWorks 前，与 runs / 整项 stop gen 一起同步捕获。 */
export function captureCollaborationNative(
  records: CollaborationRecords,
  sessions: readonly SessionId[],
): CollaborationNativeSnapshot {
  const known = new Set(sessions)
  const groups = new Map<string, CollaborationNativeGroup>()
  for (const session of sessions) {
    const collaboration = records.collaborationForSession(session)
    if (collaboration === undefined || groups.has(collaboration.collaborationId)) continue
    const id = collaboration.collaborationId
    const members = records.listMembers(id)
    known.add(collaboration.originSessionId)
    for (const member of members) known.add(member.sessionId)
    groups.set(id, {
      collaboration, members, delegations: records.listDelegations(id),
      waits: records.listWaits(id), executions: records.listExecutions(id),
    })
  }
  return { sessions: [...known], groups: [...groups.values()] }
}

/** 纯投影，不读取后来的记录或停止版本，不写事项、不推断产物已验收。 */
export function mergeCollaborationNative(
  works: readonly NativeWork[],
  snapshot: CollaborationNativeSnapshot,
): readonly NativeWork[] {
  const known = new Set(snapshot.sessions)
  const bySession = new Map(works.filter(work => known.has(work.session)).map(work => [work.session, work]))
  const groupFor = new Map<SessionId, CollaborationNativeGroup>()
  for (const group of snapshot.groups) {
    groupFor.set(group.collaboration.originSessionId, group)
    for (const member of group.members) groupFor.set(member.sessionId, group)
  }
  const emitted = new Set<CollaborationNativeGroup>()
  const result: NativeWork[] = []
  for (const work of bySession.values()) {
    const group = groupFor.get(work.session)
    if (group === undefined) result.push(work)
    else if (!emitted.has(group)) {
      emitted.add(group)
      result.push(mergeGroup(group, bySession))
    }
  }
  for (const group of snapshot.groups) if (!emitted.has(group)) result.push(mergeGroup(group, bySession))
  return result
}

function mergeGroup(group: CollaborationNativeGroup, bySession: ReadonlyMap<SessionId, NativeWork>): NativeWork {
  const { collaboration, members, delegations, waits, executions } = group
  const root = collaboration.originSessionId
  const coordinator = members.find(member => member.agentId === collaboration.coordinatorId)
  const rootWork = bySession.get(root)
  const sessions = new Set([root, ...members.map(member => member.sessionId)])
  const rows = [...sessions].flatMap(session => { const work = bySession.get(session); return work === undefined ? [] : [work] })
  const memberDetail = (session: SessionId, detail: string): string => session === root
    ? detail : `${members.find(member => member.sessionId === session)?.name ?? '成员'}${detail ? `：${detail}` : ''}`
  const agentDetail = (agentId: string, detail: string): string => {
    const member = members.find(member => member.agentId === agentId)
    return member?.sessionId === root ? detail : `${member?.name ?? '成员'}：${detail}`
  }
  const active = executions.filter(execution => execution.state !== 'finished')
  const pending = delegations.filter(delegation => !['received', 'rejected', 'cancelled'].includes(delegation.state)
    || (delegation.deliveryMessageId !== undefined && delegation.receivedAt === undefined))
  const open = collaboration.state === 'open' || collaboration.state === 'closing'
  const waiting = open ? waits.find(wait => wait.state === 'waiting') : undefined
  const current = ['unknown', 'stopping', 'waiting', 'running'].flatMap(state => rows.filter(row => row.state === state))[0]
  const unconfirmed = active.find(execution => {
    const member = members.find(member => member.agentId === execution.agentId)
    const row = member === undefined ? undefined : bySession.get(member.sessionId)
    return row === undefined || row.state === 'idle' || row.state === 'stopped'
  })
  const cancelling = active.find(execution => execution.state === 'cancel-requested')
  let status: Pick<NativeWork, 'state' | 'since' | 'affected' | 'action' | 'reason'>
  if (open && coordinator?.reachability === 'suspended') {
    status = { state: 'unknown', affected: true, since: rootWork?.since ?? collaboration.at, reason: '协调承接待核实',
      ...(current?.action === undefined ? {} : { action: memberDetail(current.session, current.action) }) }
  } else if (current?.state === 'unknown') {
    status = { state: 'unknown', affected: true, since: current.since,
      reason: memberDetail(current.session, current.reason ?? '执行状态待核实') }
  } else if (unconfirmed !== undefined) {
    status = { state: 'unknown', affected: true, since: unconfirmed.cancelledAt ?? unconfirmed.at,
      reason: agentDetail(unconfirmed.agentId, unconfirmed.reason ?? '执行收尾待核实') }
  } else if (current?.state === 'stopping' || cancelling !== undefined || (collaboration.state === 'stopped' && current !== undefined)) {
    status = { state: 'stopping', affected: true, since: cancelling?.cancelledAt ?? current?.since ?? collaboration.at,
      reason: collaboration.reason ?? cancelling?.reason ?? current?.reason ?? '等待成员退出' }
  } else if (current !== undefined) {
    status = { state: current.state, affected: true, since: current.since,
      ...(current.action === undefined ? {} : { action: memberDetail(current.session, current.action) }),
      ...(current.reason === undefined ? {} : { reason: memberDetail(current.session, current.reason) }) }
  } else if (collaboration.state === 'closed') {
    status = { state: 'idle', affected: false, since: rootWork?.since ?? collaboration.at, reason: '已收尾' }
  } else if (collaboration.state === 'stopped') {
    status = { state: 'stopped', affected: false, since: rootWork?.since ?? collaboration.at,
      ...(collaboration.reason === undefined ? {} : { reason: collaboration.reason }) }
  } else if (waiting !== undefined) {
    // RunState.waiting 表示用户仍有待答项；成员等待不会凭空生成用户审批。
    status = { state: 'idle', affected: true, since: waiting.at, action: agentDetail(waiting.agentId, `等待：${waiting.expectation}`) }
  } else {
    status = { state: pending.length > 0 || collaboration.state === 'closing' ? 'idle' : rootWork?.state ?? 'idle',
      affected: pending.length > 0 || collaboration.state === 'closing',
      since: rootWork?.since ?? collaboration.at,
      ...(collaboration.state === 'closing' ? { action: '收尾中' } : {}),
      ...(rootWork?.reason === undefined ? {} : { reason: rootWork.reason }) }
  }
  return {
    session: root, title: rootWork?.title ?? coordinator?.name ?? '未命名工作',
    workspace: rootWork?.workspace ?? coordinator?.workspace ?? [],
    // 成员代次从不冒充整项工作；manager 用此前同拍捕获的整项版本覆盖这一格。
    gen: rootWork?.gen ?? null, ...status,
    notices: rows.flatMap(row => row.notices.map(notice => notice.session === root ? notice : {
      ...notice, session: root, detail: memberDetail(notice.session, notice.detail ?? ''),
    })).sort((left, right) => left.at - right.at || left.id.localeCompare(right.id)),
  }
}
