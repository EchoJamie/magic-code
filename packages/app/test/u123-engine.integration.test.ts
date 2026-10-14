import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMagicHome, type EventDataOf, type EventKind, type KernelEvent, type NativeRequest, type NativeResponse, type SessionManagement, type Wire } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startManager, type ExecutorRequest } from '../src/run/manager.ts'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { canArchiveRun, newRunRecord, refresh } from '../src/run/facts.ts'

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5)
  expect(predicate()).toBe(true)
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'u123-engine-'))
  const magic = resolveMagicHome({}, root)
  const paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  for (const session of ['a', 'b']) store.setSessionTitle(session, session, 1)
  const launches: ExecutorRequest[] = []
  const commands: Wire[] = []
  const started = await startManager({ magic, paths, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn(request) {
      launches.push(request)
      const endings: ((reason: string) => void)[] = []
      request.link.onMessage(message => {
        commands.push(message)
        if (message.t === 'snapshot') request.link.send({ t: 'snapshot', seq: message.seq, snapshot: { watermark: 0, turnOpen: false, tools: [], decisions: [] } })
        if (message.t === 'bye') for (const end of endings) end(message.why)
      })
      return { onExit(end) { endings.push(end) }, cancel() { for (const end of endings) end('受控执行者已结束') } }
    } },
  })
  if (started.role !== 'manager') throw new Error('隔离 Engine 未启动')
  const manager = started.manager
  const observer = linkOf<NativeResponse>(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }) as never)
  const responses: NativeResponse[] = []
  observer.onMessage(message => responses.push(message))
  observer.send({ t: 'hello', role: 'observer', ...manager.identity })
  await until(() => responses.some(message => message.t === 'native.welcome'))
  let sequence = 0
  type Query = Extract<NativeRequest, { request: string }>
  type WithoutRequest<T> = T extends Query ? Omit<T, 'request'> : never
  async function request<T extends NativeResponse['t']>(message: WithoutRequest<Query>, kind: T): Promise<Extract<NativeResponse, { t: T }>> {
    const request = `u123-${++sequence}`
    observer.send({ ...message, request } as NativeRequest)
    await until(() => responses.some(result => result.t === kind && 'request' in result && result.request === request))
    return responses.find(result => result.t === kind && 'request' in result && result.request === request) as Extract<NativeResponse, { t: T }>
  }
  const clients: ManagerClient[] = []
  async function connect(session = 'a', reattach = false) {
    const client = await connectManager(paths.socket, { session, reattach })
    if (!client) throw new Error('隔离终端连接失败')
    clients.push(client)
    return client
  }
  function event<K extends EventKind>(session: string, kind: K, data: EventDataOf[K], turn: number | null = 1) {
    const event = { id: store.serviceFor(session).nextId(), at: Date.now(), turn, session, kind, data } as KernelEvent
    store.appendEvent(event)
    launches.findLast(request => request.session === session)?.link.send({ t: 'ev', event })
    return event
  }
  function ready(index = 0) {
    const launch = launches[index]!
    launch.link.send({ t: 'assembled', session: launch.session, workspace: [root] })
    launch.link.send({ t: 'ready' })
  }
  async function manage(items: readonly SessionManagement[], serviceInstance = manager.identity.serviceInstance) {
    return request({ t: 'native.session.manage', items, serviceInstance }, 'native.session.managed')
  }
  async function inspect(session = 'a', notice?: string) {
    return request({ t: 'native.inspect', session, ...(notice ? { notice } : {}) }, 'native.inspected')
  }
  async function close() {
    for (const client of clients) client.close()
    observer.close()
    manager.stop('隔离测试收尾')
    await manager.waitUntilExit()
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
  return { root, store, manager, observer, responses, launches, commands, connect, request, manage, inspect, event, ready, close }
}

test('归档先受理：广播只读、拒输入与普通接回、只读重连；恢复不执行且归档不改名', async () => {
  const f = await fixture()
  try {
    const client = await f.connect()
    const events: KernelEvent[] = []
    client.onEvent(event => events.push(event))
    const archived = await f.manage([{ session: 'a', action: 'archive' }])
    expect(archived.results[0]).toMatchObject({ ok: true, archived: true })
    await until(() => events.some(event => event.kind === 'session.changed' && event.data.archived))
    client.send({ type: 'input.submit', text: '保留原稿', ref: 'draft' })
    await until(() => events.some(event => event.kind === 'input.settled' && event.data.ref === 'draft'))
    expect(events.find(event => event.kind === 'input.settled' && event.data.ref === 'draft')?.data).toMatchObject({ ok: false, reason: expect.stringContaining('已归档') })
    expect(f.launches).toHaveLength(0)
    expect((await f.manage([{ session: 'a', action: 'rename', title: '不能改名' }])).results[0]).toMatchObject({ ok: false, error: expect.stringContaining('先恢复') })
    await expect(f.connect()).rejects.toThrow('已归档')
    const reconnected = await f.connect('a', true)
    reconnected.send({ type: 'history.read', session: 'b' })
    const history: KernelEvent[] = []
    reconnected.onEvent(event => history.push(event))
    await until(() => history.some(event => event.kind === 'session.history' && event.data.session === 'b'))
    expect(f.launches).toHaveLength(0)
    expect((await f.manage([{ session: 'a', action: 'restore' }])).results[0]).toMatchObject({ ok: true, archived: false })
    expect(f.launches).toHaveLength(0)
    expect((await f.inspect()).work).toMatchObject({ archived: false, terminalOpen: true, canArchive: true })
  } finally { await f.close() }
})

test('输入先受理：启动与投递消费间隙都拒归档，结束后才归档；批量独立核定和旧实例拒写', async () => {
  const f = await fixture()
  try {
    const client = await f.connect()
    const events: KernelEvent[] = []
    client.onEvent(event => events.push(event))
    client.send({ type: 'input.submit', text: '先受理', ref: 'accepted-first' })
    client.send({ type: 'session.archive', session: 'a' })
    await until(() => events.some(event => event.kind === 'session.managed'))
    expect(events.find(event => event.kind === 'session.managed')?.data).toMatchObject({ ok: false })
    expect(f.launches).toHaveLength(1)
    expect(f.store.isSessionArchived('a')).toBe(false)
    f.ready()
    expect(f.commands.some(message => message.t === 'cmd' && message.cmd.type === 'input.submit')).toBe(true)
    // 执行者已收到命令但尚未发 turn.start；不能借此间隙归档。
    expect((await f.manage([{ session: 'a', action: 'archive' }, { session: 'b', action: 'archive' }])).results.map(result => result.ok)).toEqual([false, true])
    expect((await f.manage([{ session: 'b', action: 'restore' }], 'old-instance')).results[0]?.ok).toBe(false)
    expect(f.store.isSessionArchived('b')).toBe(true)
    f.event('a', 'turn.start', {})
    f.event('a', 'turn.end', { reason: 'aborted' })
    f.event('a', 'agent.state', { state: 'waiting' })
    expect((await f.manage([{ session: 'a', action: 'archive' }])).results[0]?.ok).toBe(true)
    expect(f.store.isSessionArchived('a')).toBe(true)
  } finally { await f.close() }
})

test('只读分页和旧通知 inspect 可达普通历史与归档目标，不切终端当前会话', async () => {
  const f = await fixture()
  try {
    const records = f.store.serviceFor('b')
    const ids = Array.from({ length: 121 }, (_, index) => records.appendEntry({ kind: 'assistant', content: { text: `保存内容 ${index}` }, at: index + 1 }))
    const client = await f.connect('a')
    const targets: (string | null)[] = []
    const events: KernelEvent[] = []
    client.onTarget(session => targets.push(session))
    client.onEvent(event => events.push(event))
    const page1 = await f.request({ t: 'native.history', session: 'b' }, 'native.history.result')
    expect(page1.entries?.map(entry => entry.id)).toEqual(ids.slice(0, 50))
    expect(page1.done).toBe(false)
    const page2 = await f.request({ t: 'native.history', session: 'b', after: page1.next }, 'native.history.result')
    expect(page2.entries?.map(entry => entry.id)).toEqual(ids.slice(50, 100))
    await f.manage([{ session: 'b', action: 'archive' }])
    expect((await f.inspect('b', 'old-replaced-source')).work).toMatchObject({ session: 'b', archived: true, terminalOpen: false })
    client.send({ type: 'history.read', session: 'b' })
    await until(() => events.some(event => event.kind === 'session.history' && event.data.session === 'b' && event.data.done))
    expect(events.filter(event => event.kind === 'session.history').flatMap(event => event.data.entries.map(entry => entry.id))).toEqual(ids)
    client.send({ type: 'session.list', archived: true })
    await until(() => events.some(event => event.kind === 'session.state' && event.data.sessions.some(session => session.id === 'b')))
    expect(events.findLast(event => event.kind === 'session.state')?.data.active).toBe('a')
    expect(targets.every(target => target === 'a')).toBe(true)
    expect(f.launches).toHaveLength(0)
  } finally { await f.close() }
})

test('当前通知取真实回复、替换旧来源；新轮及历史失效审批退出，旧呈现不清新原因', async () => {
  const f = await fixture()
  try {
    const client = await f.connect()
    client.send({ type: 'input.submit', text: '开始', ref: 'input' })
    await until(() => f.launches.length === 1)
    f.ready()
    f.event('a', 'turn.start', {})
    const entry = f.store.serviceFor('a').appendEntry({ kind: 'assistant', content: { text: '这里是本轮真实答复。' }, at: Date.now() })
    f.event('a', 'message.assistant', { entry })
    const stop = f.event('a', 'turn.end', { reason: 'settled' })
    f.event('a', 'agent.state', { state: 'waiting' })
    await until(() => f.store.attention.list({ sessions: ['a'] })[0]?.kind === 'done')
    const notice = f.store.attention.list({ sessions: ['a'] })[0]!
    expect(notice.detail).toBe('这里是本轮真实答复。')
    expect(notice.source).toEqual({ session: 'a', event: stop.id, entry })
    expect((await f.inspect()).work).toMatchObject({ currentNotice: notice, terminalOpen: true })
    f.event('a', 'turn.start', {}, 2)
    expect(f.store.attention.list({ sessions: ['a'] })).toEqual([])
    const approval1 = f.event('a', 'tool.decision.request', { call: 101, name: 'exec', material: '是否允许操作一', weight: 'heavy' }, 2)
    const first = f.store.attention.list({ sessions: ['a'] })[0]!
    const approval2 = f.event('a', 'tool.decision.request', { call: 102, name: 'exec', material: '是否允许操作二', weight: 'heavy' }, 2)
    const second = f.store.attention.list({ sessions: ['a'] })[0]!
    expect(second.id).not.toBe(first.id)
    f.observer.send({ t: 'native.read', serviceInstance: f.manager.identity.serviceInstance, ids: [first.id] })
    const history = await f.request({ t: 'native.history', session: 'a', source: { session: 'a', event: approval1.id } }, 'native.history.result')
    expect(history.events?.map(event => event.id)).toEqual([approval1.id])
    expect(history.currentRequests?.map(event => event.id)).toEqual([approval1.id, approval2.id])
    expect(f.store.attention.list({ sessions: ['a'] })[0]?.unread).toBe(true)
    f.observer.send({ t: 'native.read', serviceInstance: f.manager.identity.serviceInstance, ids: [second.id] })
    expect((await f.inspect()).work).toMatchObject({ state: 'waiting', affected: true, canArchive: false })
    expect(f.store.attention.list({ sessions: ['a'] })[0]?.unread).toBe(false)
    f.event('a', 'tool.decision', { call: 102, decision: 'approve', decider: 'user', elapsedMs: 0 }, 2)
    const remaining = await f.request({ t: 'native.history', session: 'a', source: { session: 'a', event: approval1.id } }, 'native.history.result')
    expect(remaining.currentRequests?.map(event => event.id)).toEqual([approval1.id])
    expect((await f.inspect()).work).toMatchObject({ state: 'waiting', affected: true })
    expect(f.store.attention.list({ sessions: ['a'] })).toEqual([])
    f.event('a', 'turn.end', { reason: 'aborted' }, 2)
    f.event('a', 'agent.state', { state: 'waiting' })
    expect((await f.inspect()).work?.currentNotice).toBeUndefined()
    // 存量无来源，或原事件之后有新轮，不能靠 unread 撑起当前工作。
    f.store.attention.put({ id: 'stale', session: 'b', kind: 'needs-you', fact: 'unknown', at: Date.now(), unread: true, delivered: false })
    f.store.attention.put({ ...notice, id: 'old-stop-reappeared', at: Date.now() })
    f.observer.send({ t: 'native.refresh' })
    await f.inspect('b', 'stale')
    expect(f.store.attention.list({ sessions: ['b'] })).toEqual([])
    expect((await f.inspect()).work?.currentNotice).toBeUndefined()
  } finally { await f.close() }
})

test('协作归档按根原子核资格，成员执行未收尾阻塞；恢复与迟到协作不会隐式启动', async () => {
  const f = await fixture()
  try {
    const records = f.store.collaboration
    const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
    const origin = { sessionId: 'a', entryId: f.store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '根交代' }, at: 2 }) }
    const coordinator = records.registerAgent({ operationId: 'root', sessionId: 'a', name: '协调', role: '', model, at: 3 })
    const work = records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 4 })
    const child = records.spawn(coordinator.agentId, { operationId: 'member', sessionId: 'member', name: '成员', role: '', model, body: [{ kind: 'text', text: '核对' }], scope: '核对', source: origin, authorization: [origin], at: 5 })
    records.respondToDelegation(child.agent.agentId, { operationId: 'accept', delegationId: child.delegation.delegationId, response: 'accept', at: 6 })
    records.beginExecution(child.agent.agentId, { operationId: 'execution', runId: 'controlled-run', kind: 'model', delegationId: child.delegation.delegationId, at: 7 })
    expect((await f.manage([{ session: 'member', action: 'archive' }])).results[0]).toMatchObject({ session: 'a', ok: false })
    records.stop({ kind: 'collaboration', collaborationId: work.collaborationId }, '已结束', 8)
    records.finishExecution('execution')
    expect((await f.manage([{ session: 'member', action: 'archive' }])).results[0]).toMatchObject({ session: 'a', ok: true, archived: true })
    expect(f.store.isSessionArchived('member')).toBe(true)
    const client = await f.connect('a', true)
    const events: KernelEvent[] = []
    client.onEvent(event => events.push(event))
    client.send({ type: 'collaboration.resume' })
    client.send({ type: 'collaboration.input', input: { text: '迟到交代', ref: 'late' } })
    await until(() => events.some(event => event.kind === 'input.settled' && event.data.ref === 'late'))
    expect(f.launches).toHaveLength(0)
    expect(records.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect((await f.manage([{ session: 'member', action: 'restore' }])).results[0]?.ok).toBe(true)
    expect(records.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.launches).toHaveLength(0)
  } finally { await f.close() }
})

test('归档资格保留后台、未知与资源收尾保护；已结束的失效裁决不阻止归档', () => {
  const run = newRunRecord({ gen: 1, session: 'a', startedAt: 1, explicit: false })
  expect(canArchiveRun(run)).toBe(false)
  run.ready = true; run.connected = true; run.everConnected = true; run.busy = false
  refresh(run, 2)
  expect(canArchiveRun(run)).toBe(true)
  run.owned = [{ pgid: 4242, startedAt: 1, kind: 'background', what: '后台测试' }]; refresh(run, 3)
  expect(canArchiveRun(run)).toBe(false)
  run.owned = []; run.reclaimPending = true; refresh(run, 4)
  expect(canArchiveRun(run)).toBe(false)
  run.reclaimPending = false; run.state = 'unknown'
  expect(canArchiveRun(run)).toBe(false)
  run.ended = { kind: 'aborted', at: 5, why: '已确认退出' }; run.state = 'stopped'; run.decisions.set(4, 3)
  expect(canArchiveRun(run)).toBe(true)
})

test('普通目录当前关注优先，归档目录按内容时间；开放协作空闲停点无需正式 closed 也提醒', async () => {
  const f = await fixture()
  try {
    f.store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '较早' }, at: 2 })
    f.store.serviceFor('b').appendEntry({ kind: 'user', content: { text: '较新' }, at: 100 })
    const client = await f.connect('a')
    const directory = await f.request({ t: 'native.sessions' }, 'native.sessions.result')
    expect(directory.sessions?.map(session => session.id)).toEqual(['a', 'b'])
    await f.manage([{ session: 'a', action: 'archive' }, { session: 'b', action: 'archive' }])
    const archived = await f.request({ t: 'native.sessions', archived: true }, 'native.sessions.result')
    expect(archived.sessions?.map(session => session.id)).toEqual(['b', 'a'])
    await f.manage([{ session: 'a', action: 'restore' }])
    client.send({ type: 'input.submit', text: '开始协作' })
    await until(() => f.launches.length === 1)
    f.ready()
    const records = f.store.collaboration
    const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
    const origin = { sessionId: 'a', entryId: f.store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '独立协调' }, at: Date.now() }) }
    const agent = records.registerAgent({ operationId: 'root', sessionId: 'a', name: '协调', role: '', model, at: Date.now() })
    const work = records.openCollaboration(agent.agentId, { operationId: 'open', origin, at: Date.now() })
    f.event('a', 'turn.start', {})
    const entry = f.store.serviceFor('a').appendEntry({ kind: 'assistant', content: { text: '等待下一次交代的实际说明。' }, at: Date.now() })
    f.event('a', 'message.assistant', { entry })
    f.event('a', 'turn.end', { reason: 'settled' })
    f.event('a', 'agent.state', { state: 'waiting' })
    await until(() => f.store.attention.list({ sessions: ['a'] })[0]?.kind === 'done')
    expect(records.getCollaboration(work.collaborationId)?.state).toBe('open')
    expect((await f.inspect()).work?.currentNotice?.detail).toBe('等待下一次交代的实际说明。')
  } finally { await f.close() }
})
