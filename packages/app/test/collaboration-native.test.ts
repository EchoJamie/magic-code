import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AttentionItem, NativeWork, RunRow } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { captureCollaborationNative, mergeCollaborationNative } from '../src/run/collaboration-native.ts'
import { projectWorks } from '../src/run/native-projection.ts'
import { removeDir, tempDir } from './tmp.ts'

function fixture() {
  const dir = tempDir('magic-collaboration-native-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const records = store.collaboration
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
  const origin = { sessionId: 'origin', entryId: store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '整项工作' }, at: 1 }) }
  const coordinator = records.registerAgent({ operationId: 'register', sessionId: 'origin', name: '协调', role: '', model, at: 2 })
  const collaboration = records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 3 })
  function spawn(sessionId: string, name = '实现成员') {
    return records.spawn(coordinator.agentId, { operationId: `spawn:${sessionId}`, sessionId, name, role: '', model,
      body: [{ kind: 'text', text: '完成独立部分' }], scope: name, source: origin, authorization: [origin], at: 4 })
  }
  function respond(child: ReturnType<typeof spawn>, response: 'accept' | 'reject') {
    return records.respondToDelegation(child.agent.agentId, { operationId: `${response}:${child.agent.agentId}`,
      delegationId: child.delegation.delegationId, response, reason: '本轮决定', at: 5 })
  }
  return { dir, store, records, origin, coordinator, collaboration, spawn, respond,
    snapshot: (...extra: string[]) => captureCollaborationNative(records, ['origin', ...extra]),
    close() { store.close(); removeDir(dir) },
  }
}

function work(session: string, patch: Partial<NativeWork> = {}): NativeWork {
  return { background: 0, session, title: session === 'origin' ? '整项工作' : '独立工作', workspace: ['/root'],
    state: 'idle', since: 10, gen: null, affected: false, archived: false, canArchive: false, terminalOpen: false, ...patch }
}
function notice(session: string, patch: Partial<AttentionItem> = {}): AttentionItem {
  return { id: `notice:${session}`, session, kind: 'needs-you', at: 20, fact: 'event:42',
    unread: true, delivered: false, detail: '批准执行测试', ...patch }
}

describe('协作 Native 整项工作投影', () => {
  let f: ReturnType<typeof fixture>
  beforeEach(() => { f = fixture() })
  afterEach(() => { f.close() })

  test('根目录行和所有成员合为一项；入口 idle 不掩盖成员 running，不借成员 gen', () => {
    const child = f.spawn('member-session-secret')
    const another = f.spawn('review-session-secret', '审查')
    f.respond(child, 'accept')
    const snapshot = f.snapshot('ordinary')
    expect(snapshot.sessions).toEqual(['origin', 'ordinary', child.agent.sessionId, another.agent.sessionId])
    expect(snapshot.groups).toHaveLength(1)
    expect(snapshot.groups[0]?.delegations).toHaveLength(2)
    expect(snapshot.groups[0]?.members).toHaveLength(3)
    const plain = work('ordinary', { state: 'running', affected: true })
    const rows = mergeCollaborationNative([
      work(child.agent.sessionId, { state: 'running', action: '运行测试', affected: true, gen: 99, since: 12 }),
      plain, work('origin', { gen: 7 }), work(another.agent.sessionId),
    ], snapshot)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual(work('origin', { state: 'running', action: '实现成员：运行测试', affected: true, gen: 7, since: 12, members: [
      { session: 'origin', name: '协调', state: 'idle' },
      { session: child.agent.sessionId, name: '实现成员', state: 'running', action: '运行测试' },
      { session: another.agent.sessionId, name: '审查', state: 'idle' },
    ] }))
    expect(rows[1]).toBe(plain)
  })

  test('成员摘要使用同拍真实名称与运行事实；缺席或未核销成员不补成空闲', () => {
    const child = f.spawn('child', '真实实现成员')
    const missing = f.spawn('missing', '尚未取得运行状态')
    const snapshot = f.snapshot()
    f.records.updateAgent(child.agent.agentId, { name: '下一拍才改名' })
    const row = mergeCollaborationNative([work('origin'), work('child', {
      state: 'waiting', action: '确认是否写入外部路径', affected: true,
    })], snapshot)[0]!
    expect(row.members).toEqual([
      { session: 'origin', name: '协调', state: 'idle' },
      { session: 'child', name: '真实实现成员', state: 'waiting', action: '确认是否写入外部路径' },
      { session: missing.agent.sessionId, name: '尚未取得运行状态', state: 'unknown', reason: '成员状态待核实' },
    ])
    f.respond(child, 'accept')
    f.records.beginExecution(child.agent.agentId, { operationId: 'unsettled', runId: 'run', kind: 'model', delegationId: child.delegation.delegationId, at: 8 })
    expect(mergeCollaborationNative([work('origin'), work('child')], f.snapshot())[0]?.members?.find(one => one.session === 'child'))
      .toMatchObject({ state: 'unknown', reason: '成员状态待核实' })
  })

  test('当前原因只由根持有，成员来源保留；归并不重造历史提醒', () => {
    const child = f.spawn('member-session-secret')
    const current = notice('origin', { id: 'root-item', source: { session: child.agent.sessionId, event: 42 }, detail: '实现成员：批准执行测试' })
    const rows = [work('origin', { currentNotice: current, state: 'running', affected: true }),
      work(child.agent.sessionId, { state: 'waiting', terminalOpen: true, action: '批准执行测试', affected: true })]
    const merged = mergeCollaborationNative(rows, f.snapshot())[0]!
    expect(merged).toMatchObject({ session: 'origin', state: 'waiting', affected: true, terminalOpen: true, canArchive: false })
    expect(merged.currentNotice).toEqual(current)
    expect(merged.currentNotice?.source?.session).toBe(child.agent.sessionId)
    expect('notices' in merged).toBe(false)
    expect(mergeCollaborationNative(rows.map(row => ({ ...row, state: 'idle' as const })), f.snapshot())[0]?.state).toBe('idle')
  })

  test('有效 wait 没有 executor 仍 affected；期限只能由持久终态解除，不靠投影时钟猜测', () => {
    const child = f.spawn('child')
    f.respond(child, 'reject')
    expect(f.records.registerWait(f.coordinator.agentId, { operationId: 'wait', forAgents: [child.agent.agentId],
      expectation: '等待补充说明', deadline: 100, at: 10 }).ok).toBe(true)
    const snapshot = f.snapshot()
    expect(snapshot.groups[0]?.waits[0]?.state).toBe('waiting')
    expect(snapshot.groups[0]?.executions).toEqual([])
    expect(mergeCollaborationNative([work('origin'), work('child')], snapshot)[0]).toMatchObject({
      state: 'idle', action: '等待：等待补充说明', affected: true, gen: null,
    })
    f.records.expireWaits(101)
    expect(mergeCollaborationNative([work('origin')], snapshot)[0]?.affected).toBe(true)
    expect(mergeCollaborationNative([work('origin')], f.snapshot())[0]).toMatchObject({ state: 'idle', affected: false })
  })

  test('协调者 suspended 时整体待核实，其他成员继续执行的动作仍可见', () => {
    const child = f.spawn('child')
    f.records.setReachability(f.coordinator.agentId, 'suspended')
    const row = mergeCollaborationNative([work('origin'), work(child.agent.sessionId, {
      state: 'running', action: '独立测试', affected: true,
    })], f.snapshot())[0]!
    expect(row).toMatchObject({ state: 'unknown', reason: '协调承接待核实', action: '实现成员：独立测试', affected: true })
    expect(f.records.getAgent(f.coordinator.agentId)?.reachability).toBe('suspended')
  })

  test('queued、accepted 与 delivered 未收下仍在整项范围；全员空闲不冒充 closed', () => {
    const child = f.spawn('child')
    const idle = [work('origin'), work('child')]
    expect(mergeCollaborationNative(idle, f.snapshot())[0]).toMatchObject({ state: 'idle', affected: true })
    f.respond(child, 'accept')
    expect(mergeCollaborationNative(idle, f.snapshot())[0]?.affected).toBe(true)
    f.records.deliver(child.agent.agentId, { operationId: 'delivery', delegationId: child.delegation.delegationId,
      body: [{ kind: 'text', text: '交付待核验' }], at: 11 })
    const delivered = mergeCollaborationNative(idle, f.snapshot())[0]!
    expect(delivered.affected).toBe(true)
    expect(delivered.reason).not.toBe('已收尾')
    expect(delivered.currentNotice).toBeUndefined()
    f.records.receiveDelivery(f.coordinator.agentId, child.delegation.delegationId, 12)
    expect(mergeCollaborationNative(idle, f.snapshot())[0]?.affected).toBe(false)
    f.records.beginClosing(f.collaboration.collaborationId, 13)
    expect(mergeCollaborationNative(idle, f.snapshot())[0]).toMatchObject({ state: 'idle', action: '收尾中', affected: true })
  })

  test('closed 只投影已收尾，不把正常收尾标成异常停止，也不凭空产生完成事项', () => {
    const child = f.spawn('child')
    f.respond(child, 'reject')
    expect(f.records.closeCollaboration(f.collaboration.collaborationId, 15).closed).toBe(true)
    const row = mergeCollaborationNative([work('origin', { state: 'stopped', reason: '资源释放', gen: 7 }),
      work('child', { state: 'stopped' })], f.snapshot())[0]!
    expect(row).toMatchObject({ state: 'idle', affected: false, reason: '已收尾', gen: 7 })
    expect(row.action).toBeUndefined()
  })

  test('execution 尚未核销而 executor 缺席，保持待核实与 affected；finished 才清除这份阻塞', () => {
    f.records.beginExecution(f.coordinator.agentId, { operationId: 'execution', runId: 'run', kind: 'model', at: 8 })
    const snapshot = f.snapshot()
    expect(snapshot.groups[0]?.executions[0]?.state).toBe('running')
    expect(mergeCollaborationNative([work('origin')], snapshot)[0]).toMatchObject({ state: 'unknown', affected: true, reason: '执行收尾待核实' })
    f.records.finishExecution('execution')
    expect(mergeCollaborationNative([work('origin')], f.snapshot())[0]?.affected).toBe(false)
  })

  test('停止先留取消事实，运行仍在时不能报已停；失联高于停止受理，核销后才已停', () => {
    const child = f.spawn('child')
    f.respond(child, 'accept')
    f.records.beginExecution(child.agent.agentId, { operationId: 'execution', runId: 'child-run', kind: 'tool',
      delegationId: child.delegation.delegationId, at: 8 })
    f.records.stop({ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, '用户停止', 12)
    const snapshot = f.snapshot()
    expect(mergeCollaborationNative([work('origin'), work('child', { state: 'running', affected: true })], snapshot)[0])
      .toMatchObject({ state: 'stopping', affected: true, reason: '用户停止', since: 12 })
    expect(mergeCollaborationNative([work('origin'), work('child', { state: 'unknown', reason: '连接失效', affected: true })], snapshot)[0])
      .toMatchObject({ state: 'unknown', affected: true, reason: '实现成员：连接失效' })
    expect(mergeCollaborationNative([work('origin')], snapshot)[0]?.state).toBe('unknown')
    f.records.finishExecution('execution', '资源退出')
    expect(mergeCollaborationNative([work('origin', { state: 'stopped' }), work('child', { state: 'stopped' })], f.snapshot())[0])
      .toMatchObject({ state: 'stopped', affected: false, reason: '用户停止' })
  })

  test('只有成员目录行时补出根工作，根 gen 留空，不借成员停止版本或标题', () => {
    const child = f.spawn('child')
    const snapshot = captureCollaborationNative(f.records, ['child'])
    const result = mergeCollaborationNative([work('child', { gen: 999, title: '成员局部标题', state: 'running', affected: true })], snapshot)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ session: 'origin', gen: null, title: '协调', workspace: [f.dir], state: 'running', affected: true })
    expect(snapshot.groups[0]?.members.some(member => member.agentId === child.agent.agentId)).toBe(true)
  })

  test('普通身份未展开协作时原样保留；未知新目录行不混入既有快照', () => {
    f.store.serviceFor('ordinary').appendEntry({ kind: 'user', content: { text: '普通工作' }, at: 1 })
    f.records.registerAgent({ operationId: 'ordinary-id', sessionId: 'ordinary', name: '普通', role: '', model: f.coordinator.model, at: 2 })
    const snapshot = captureCollaborationNative(f.records, ['ordinary'])
    expect(snapshot.groups).toEqual([])
    const ordinary = work('ordinary')
    expect(mergeCollaborationNative([ordinary, work('new-session')], snapshot)).toEqual([ordinary])
    expect(mergeCollaborationNative([ordinary], snapshot)[0]).toBe(ordinary)
  })

  test('不同 origin 的协作分别成行；同名成员的运行与事项不串到另一项工作', () => {
    const child = f.spawn('child')
    const origin = { sessionId: 'other-origin', entryId: f.store.serviceFor('other-origin').appendEntry({
      kind: 'user', content: { text: '另一项工作' }, at: 1,
    }) }
    const coordinator = f.records.registerAgent({ operationId: 'other-identity', sessionId: origin.sessionId,
      name: '协调', role: '', model: f.coordinator.model, at: 2 })
    f.records.openCollaboration(coordinator.agentId, { operationId: 'other-open', origin, at: 3 })
    const other = f.records.spawn(coordinator.agentId, { operationId: 'other-spawn', sessionId: 'other-child',
      name: child.agent.name, role: '', model: f.coordinator.model, body: [{ kind: 'text', text: '另一项' }],
      scope: '另一项', source: origin, authorization: [origin], at: 4 })
    const snapshot = f.snapshot(origin.sessionId)
    expect(snapshot.groups).toHaveLength(2)
    const rows = mergeCollaborationNative([work('origin'), work('child', { state: 'running', affected: true }),
      work(origin.sessionId, { currentNotice: notice(origin.sessionId, { source: { session: other.agent.sessionId, event: 42 } }) }), work(other.agent.sessionId, { state: 'waiting', affected: true })], snapshot)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ session: 'origin', state: 'running' })
    expect(rows[1]).toMatchObject({ session: origin.sessionId, state: 'waiting' })
    expect(rows[1]?.currentNotice?.source?.session).toBe(other.agent.sessionId)
  })

  test('异步目录期间新增成员、事项和停止换代，归并仍只使用原快照、原 runs 与原 gen', async () => {
    const child = f.spawn('child')
    f.respond(child, 'accept')
    const oldNotice = notice('origin', { source: { session: 'child', event: 42 } })
    f.store.attention.put(oldNotice)
    const snapshot = f.snapshot()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const delayedStore = { ...f.store, async listSessions() { await gate; return f.store.listSessions() } }
    let generation = 7
    const runs: readonly RunRow[] = [
      { session: 'origin', state: 'idle', since: 6, startedAt: 1, workspace: [f.dir], holds: true },
      { session: 'child', state: 'running', action: '旧轮测试', since: 8, startedAt: 2, workspace: [f.dir], holds: true },
    ]
    const pending = projectWorks(delayedStore, runs, () => generation)
    generation = 9
    f.spawn('late-child', '后来成员')
    f.store.setSessionTitle('late-ordinary', '后来普通工作', 9)
    f.records.updateAgent(child.agent.agentId, { name: '新名字' })
    f.store.attention.put(notice('origin', { id: 'late-notice' }))
    f.records.stop({ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, '后来停止', 10)
    release()
    const rows = mergeCollaborationNative(await pending, snapshot)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ session: 'origin', state: 'running', action: '实现成员：旧轮测试', affected: true, gen: 7 })
    expect(rows[0]?.currentNotice).toEqual(oldNotice)
    expect(snapshot.groups[0]?.collaboration.state).toBe('open')
    expect(snapshot.groups[0]?.members).toHaveLength(2)
    expect(f.snapshot().groups[0]?.members).toHaveLength(3)
    expect(f.snapshot().groups[0]?.collaboration.state).toBe('stopped')
  })
})

test('App 后台数按工作合并且同一成员不重复计数；任一未知时整体未知', () => {
  const f = fixture()
  try {
    f.spawn('member-a', '同名'); f.spawn('member-b', '同名')
    const snapshot = f.snapshot('member-a', 'member-b')
    const rows = [work('origin', { background: 1 }), work('member-a', { background: 2 }), work('member-b', { background: 3 })]
    expect(mergeCollaborationNative([...rows, rows[1]!], snapshot)[0]?.background).toBe(6)
    expect(mergeCollaborationNative([rows[0]!, { ...rows[1]!, background: undefined }, rows[2]!], snapshot)[0]?.background).toBeUndefined()
  } finally { f.close() }
})
