import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { createShell } from '@magic/tui'
import { resolveMagicHome, type Command, type KernelEvent } from '@magic/contracts'
import { startManager } from '../src/run/manager.ts'
import { connectManager } from '../src/run/client.ts'
import { clientTransport } from '../src/run/terminal.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { tempDir, removeDir } from './tmp.ts'

async function until(check: () => boolean) {
  const end = Date.now() + 2500
  while (!check() && Date.now() < end) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('遗忘提交后同步所有受影响订阅计划，保留无关计划和用户要求，回查不再写入', async () => {
  const root = tempDir('magic-forget-plan-'), magic = resolveMagicHome({}, root)
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  const scope = { kind: 'project' as const, workspace: [root] }
  const source = store.serviceFor('first').appendEntry({ kind: 'user', at: 1, content: { text: '原始知识依据' } })
  expect(store.knowledge.write([{ id: 'knowledge', expectedRevision: 0, scope, topic: '条件', terms: [], conclusion: '旧经验', conditions: '已核实条件',
    evidence: 'fact', status: 'active', sources: [{ session: 'first', entry: source }], dependencies: [] }]).ok).toBe(true)
  expect(store.knowledge.write([{ id: 'derived', expectedRevision: 0, scope, topic: '派生', terms: [], conclusion: '派生经验', conditions: '同条件',
    evidence: 'fact', status: 'active', sources: [{ session: 'first', entry: source }], dependencies: [{ id: 'knowledge', revision: 1 }] }]).ok).toBe(true)
  for (const session of ['first', 'second', 'unrelated']) {
    const records = store.serviceFor(session)
    const entry = records.appendEntry({ kind: 'user', at: 2, content: { text: `${session}明确目标与要求` } })
    const knowledge = session === 'unrelated' ? [] : [{ id: session === 'first' ? 'knowledge' : 'derived', revision: 1 }]
    expect(records.memory.update({ expectedRevision: 0, inspectedThrough: entry, changes: [
      { id: 'goal', kind: 'goal', text: `${session}目标`, evidence: 'fact', status: 'active', sources: [{ session, entry }], knowledge },
      { id: 'requirement', kind: 'requirement', text: '用户要求必须保留', evidence: 'fact', status: 'active', sources: [{ session, entry }], knowledge },
      { id: 'dependent', kind: 'step', text: '依赖旧经验的步骤', progress: 'in_progress', order: 0, evidence: 'fact', status: 'active', sources: [{ session, entry }], knowledge },
      { id: 'independent', kind: 'step', text: '无关步骤', progress: 'pending', order: 1, evidence: 'fact', status: 'active', sources: [{ session, entry }] },
    ] }).ok).toBe(true)
  }
  const unrelated = store.serviceFor('unrelated').memory.read()
  let launches = 0
  const paths = runPathsOf(magic, '/tmp')
  const started = await startManager({ magic, paths, launch: { spawn() { launches++; throw new Error('遗忘不得启动执行者') } } })
  if (started.role !== 'manager') { store.close(); removeDir(paths.dir); removeDir(root); throw new Error(`Engine 未启动：${JSON.stringify(started)}`) }
  const views: { client: NonNullable<Awaited<ReturnType<typeof connectManager>>>; shell: ReturnType<typeof createShell>; events: KernelEvent[] }[] = []
  const open = async (session: string) => {
    const client = await connectManager(started.manager.socketPath, { session, cwd: root })
    if (!client) throw new Error('连接失败')
    const events: KernelEvent[] = []
    client.onEvent(event => events.push(event))
    const shell = createShell(clientTransport(client), { magicBase: magic.base, inputReady: true })
    const view = { client, shell, events }
    views.push(view)
    client.send({ type: 'history.read', session })
    await until(() => shell.getView().sessionId === session && shell.getView().plan.revision !== undefined)
    return view
  }
  try {
    const first = await open('first'), second = await open('second'), other = await open('unrelated'), mirror = await open('second')
    for (const view of views) expect(view.shell.getView().plan.plan?.steps).toHaveLength(2)
    const request = async (command: Command & { requestId: string }) => {
      const start = first.events.length
      first.client.send(command)
      await until(() => first.events.slice(start).some(event => event.kind === 'knowledge.forgotten' && event.data.requestId === command.requestId))
      return first.events.slice(start).find((event): event is Extract<KernelEvent, { kind: 'knowledge.forgotten' }> => event.kind === 'knowledge.forgotten' && event.data.requestId === command.requestId)!.data
    }
    const forget = { type: 'knowledge.forget' as const, requestId: 'forget', session: 'first', id: 'knowledge', scope, expectedRevision: 1 }
    expect((await request({ ...forget, requestId: 'stale', expectedRevision: 9 })).result?.status).toBe('changed')
    expect((await request({ ...forget, requestId: 'wrong-scope', scope: { kind: 'user' } })).error).toContain('范围')
    expect(views.flatMap(view => view.events.filter(event => event.kind === 'plan.changed'))).toEqual([])
    expect((await request(forget)).result?.status).toBe('completed')
    // 反例要求数据库确已失效，再检查真实 shell；不能把等待新事件超时当修前证据。
    expect(store.serviceFor('first').memory.read().items.find(item => item.id === 'dependent')?.status).toBe('invalid')
    expect(store.serviceFor('second').memory.read().items.find(item => item.id === 'dependent')?.status).toBe('invalid')
    for (const [session, view] of [['first', first], ['second', second], ['second', mirror]] as const) {
      expect(view.shell.getView().plan.revision).toBe(2)
      expect(view.shell.getView().plan.plan).toEqual({ goal: `${session}目标`, notes: '用户要求必须保留', steps: [{ text: '无关步骤', status: 'pending' }] })
      const events = view.events.filter(event => event.kind === 'plan.changed')
      expect(events).toHaveLength(1)
      expect(events[0]!.session).toBe(session)
      expect(events[0]!.id).toBeGreaterThan(0)
      expect(events[0]!.turn).toBeNull()
    }
    expect(other.events.filter(event => event.kind === 'plan.changed')).toEqual([])
    expect(other.shell.getView().plan.revision).toBe(1)
    expect(store.serviceFor('unrelated').memory.read()).toEqual(unrelated)
    second.client.close(); second.shell.dispose()
    const reconnected = await open('second')
    expect(reconnected.shell.getView().plan).toEqual(mirror.shell.getView().plan)
    const before = store.serviceFor('first').memory.read()
    const eventCount = (await Array.fromAsync(store.readEvents('first'))).length
    expect((await request({ ...forget, type: 'knowledge.forget-result' })).result?.status).toBe('completed')
    expect((await request(forget)).result?.status).toBe('completed')
    expect(store.serviceFor('first').memory.read()).toEqual(before)
    expect((await Array.fromAsync(store.readEvents('first')))).toHaveLength(eventCount)
    expect(first.events.filter(event => event.kind === 'plan.changed')).toHaveLength(1)
    expect(await store.listSessions()).toHaveLength(3)
    expect(launches).toBe(0)
    expect(started.manager.executors()).toEqual([])
    expect(started.manager.runs()).toEqual([])
  } finally {
    for (const view of views) { view.shell.dispose(); view.client.close() }
    started.manager.stop('隔离检查完成'); await started.manager.waitUntilExit(); store.close(); removeDir(paths.dir); removeDir(root)
  }
})

test('实际Agent经共享工作区store纠正和失效知识，其他订阅会话计划同步且不启动观察对象', async () => {
  const { collaborationRuntime } = await import('./run-collaboration-fixture.ts')
  const f = await collaborationRuntime('knowledge-plan-write', call => {
    if (call.kind !== 'agent') return { text: '{"changes":[]}' }
    if (call.index === 0) return { tool: 'knowledge_read', args: { id: 'corrected' } }
    if (call.index === 1) return { tool: 'knowledge_update', args: { id: 'corrected', expectedRevision: 1, changes: { conclusion: '新证据修正后的认识' } } }
    if (call.index === 2) return { tool: 'knowledge_read', args: { id: 'invalidated' } }
    if (call.index === 3) return { tool: 'knowledge_update', args: { id: 'invalidated', expectedRevision: 1, changes: { status: 'invalid' } } }
    return { text: '知识已按本次要求更新。' }
  })
  const views: { client: NonNullable<Awaited<ReturnType<typeof connectManager>>>; shell: ReturnType<typeof createShell>; events: KernelEvent[] }[] = []
  try {
    const source = f.store.serviceFor('source').appendEntry({ kind: 'user', at: 1, content: { text: '两条经验的独立来源' } })
    const scope = { kind: 'project' as const, workspace: [f.workspace] }
    expect(f.store.knowledge.write(['corrected', 'invalidated'].map(id => ({ id, expectedRevision: 0, scope, topic: id, terms: [], conclusion: '旧经验', conditions: '原条件',
      evidence: 'fact' as const, status: 'active' as const, sources: [{ session: 'source', entry: source }], dependencies: [] }))).ok).toBe(true)
    for (const session of ['corrected', 'invalidated', 'unrelated']) {
      const records = f.store.serviceFor(session)
      const entry = records.appendEntry({ kind: 'user', at: 2, content: { text: '观察会话原交代' } })
      expect(records.memory.update({ expectedRevision: 0, inspectedThrough: entry, changes: [{ id: 'step', kind: 'step', text: `${session}步骤`, order: 0, progress: 'pending',
        evidence: 'fact', status: 'active', sources: [{ session, entry }], knowledge: session === 'unrelated' ? [] : [{ id: session, revision: 1 }] }] }).ok).toBe(true)
      const client = await connectManager(f.manager.socketPath, { session, cwd: f.workspace })
      if (!client) throw new Error('观察会话连接失败')
      const events: KernelEvent[] = []
      client.onEvent(event => events.push(event))
      const shell = createShell(clientTransport(client), { magicBase: f.magic.base, inputReady: true })
      views.push({ client, shell, events })
      client.send({ type: 'history.read', session })
      await f.wait('观察会话原计划', () => shell.getView().plan.revision === 1)
    }
    for (const char of '按新证据纠正并撤回已失效的知识') f.shell.key({ kind: 'char', char })
    f.shell.key({ kind: 'enter' })
    await f.wait('真实知识工具写入与计划通知', () => f.store.knowledge.read('corrected')?.revision === 2
      && f.store.knowledge.read('invalidated')?.status === 'invalid'
      && f.manager.runs().some(run => run.session === f.session() && run.state === 'idle'))
    expect(f.calls.filter(call => call.kind === 'agent')).toHaveLength(5)
    expect(f.store.knowledge.read('corrected')?.conclusion).toBe('新证据修正后的认识')
    for (const [index, session] of ['corrected', 'invalidated'].entries()) {
      const view = views[index]!
      expect(f.store.serviceFor(session).memory.read().items[0]?.status).toBe('invalid')
      expect(view.shell.getView().plan).toMatchObject({ revision: 2, plan: null })
      const events = view.events.filter(event => event.kind === 'plan.changed')
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ session, turn: null, data: { revision: 2, plan: null } })
      expect((await Array.fromAsync(f.store.readEvents(session))).filter(event => event.kind === 'plan.changed')).toEqual([])
      view.shell.dispose(); view.client.close()
      const client = await connectManager(f.manager.socketPath, { session, cwd: f.workspace })
      if (!client) throw new Error('计划观察者重连失败')
      const received: KernelEvent[] = []
      client.onEvent(event => received.push(event))
      const shell = createShell(clientTransport(client), { magicBase: f.magic.base, inputReady: true })
      views.push({ client, shell, events: received })
      client.send({ type: 'history.read', session })
      await f.wait('重连从工作记忆重新投影', () => shell.getView().sessionId === session && shell.getView().plan.revision === 2)
      expect(shell.getView().plan).toEqual(view.shell.getView().plan)
      expect(received.some(event => event.kind === 'session.history' && event.data.done && event.data.plan?.revision === 2)).toBe(true)
    }
    expect(views[2]!.events.filter(event => event.kind === 'plan.changed')).toEqual([])
    expect(views[2]!.shell.getView().plan.revision).toBe(1)
    expect(f.manager.runs().map(run => run.session)).toEqual([f.session()!])
    expect(f.events.filter(event => event.kind === 'error')).toEqual([])
    expect(f.errors).toEqual([])
  } finally {
    for (const view of views) { view.shell.dispose(); view.client.close() }
    await f.close()
  }
}, 30000)
