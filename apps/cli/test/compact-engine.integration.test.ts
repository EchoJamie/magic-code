/** 主动压缩走真实 Unix socket、执行器桥及本地 HTTP，客户端不持有执行责任。 */
import { expect, test } from 'bun:test'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompactCommand, KernelEvent, ModelRequest } from '@magic/contracts'
import { createRecordsStore } from '@magic/data'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { createAgentLauncher } from '../src/run/launch.ts'
import { startManager, type Manager } from '../src/run/manager.ts'
import { runPathsOf } from '@magic/host'
import { startFixture, type Fixture, type FixtureTurn } from './ui/fixture.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { continuationTurn } from './notes-support.ts'

async function waitFor(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`等待${label}超时`)
    await Bun.sleep(5)
  }
}

test('真实Engine准备中收到新纠正，普通输入保存后沿原compact请求重新准备并只提交一次', async () => {
  const { collaborationRuntime, latch } = await import('./run-collaboration-fixture.ts')
  const gate = latch()
  let waiting = false, released = false, note = ''
  const correction = '新增纠正：先核实再继续，不能使用旧结论'
  const f = await collaborationRuntime('compact-original-request', async call => {
    const messages = call.body['messages'] as { role: string; content: string; tool_call_id?: string; tool_calls?: { id: string; function: { name: string } }[] }[]
    if (call.kind === 'agent') {
      if (call.index === 0) return { text: '新工作已建立' }
      if (call.index === 1) return { tool: 'read', args: { path: note } }
      if (call.index === 2) {
        const content = messages.findLast(message => message.role === 'tool')!.content
        return { tool: 'write', args: { path: note, content: content.slice(content.indexOf('\n') + 1) + '\n' + correction } }
      }
      return { text: '已通过真实工具保存新纠正' }
    }
    const calls = new Map(messages.flatMap(message => (message.tool_calls ?? []).map(tool => [tool.id, tool.function.name] as const)))
    const request: ModelRequest = { messages: messages.map(message => message.role === 'tool'
      ? { role: 'tool', callId: message.tool_call_id!, name: calls.get(message.tool_call_id!)!, output: message.content, ok: true }
      : { role: message.role as 'system' | 'user' | 'assistant', content: message.content }) }
    if (!released && request.messages.some(message => message.role === 'tool' && message.name === 'write')) {
      waiting = true
      await gate.promise
      released = true
    }
    const turn = continuationTurn(request)
    return turn.toolCalls ? { tools: turn.toolCalls.map(tool => ({ tool: tool.name, args: tool.args ?? {} })) } : { text: typeof turn.text === 'string' ? turn.text : turn.text?.join('') ?? '' }
  })
  try {
    f.client.send({ type: 'input.submit', ref: 'initial', text: '新建后准备接续' })
    await f.wait('初始工作空闲', () => f.calls.length === 1 && f.manager.runs().some(run => run.session === f.session() && run.state === 'idle'))
    const session = f.session()!, records = f.store.serviceFor(session)
    const generation = f.manager.executors()[0]!.gen
    for (let n = 0; n < 24; n++) records.appendEntry({ kind: n % 2 ? 'assistant' : 'user', content: { text: `历史要求 ${n}` }, at: n + 1 })
    note = join(f.magic.base, 'notes', session, 'MEMORY.md')
    const requestId = 'one-compact-request'
    f.client.send({ type: 'compact.request', session, requestId })
    await f.wait('第一批已保存但尚未完成', () => waiting)
    f.client.send({ type: 'input.submit', ref: 'final-correction', text: correction })
    await f.wait('新纠正持久受理', () => records.inputs.get('final-correction') !== undefined)
    expect(f.manager.executors()).toEqual([{ session, gen: generation }])
    expect(records.coverage.read().summary).toBeNull()
    gate.release()
    await f.wait('原请求完成', () => f.events.some(event => event.kind === 'compact.state' && event.data.requestId === requestId && event.data.state === 'completed'))
    expect(records.inputs.get('final-correction')?.state).toBe('included')
    expect(readFileSync(note, 'utf8')).toContain(correction)
    const lastOrdinary = f.calls.findLastIndex(call => call.kind === 'agent')
    expect(lastOrdinary).toBeGreaterThan(1)
    expect(f.calls.slice(lastOrdinary + 1).every(call => call.kind === 'internal')).toBe(true)
    expect(f.calls.slice(lastOrdinary + 1).length).toBeGreaterThan(0)
    const states = (await Array.fromAsync(records.readEvents(session))).filter(event => event.kind === 'compact.state')
    expect(new Set(states.map(event => event.data.requestId))).toEqual(new Set([requestId]))
    expect(states.filter(event => event.data.state === 'completed')).toHaveLength(1)
    expect((await Array.fromAsync(records.readEntries(session))).filter(entry => entry.kind === 'summary')).toHaveLength(1)
    const count = f.calls.length, offset = f.events.length
    f.client.send({ type: 'compact.query', session, requestId })
    await f.wait('同请求查询已提交结果', () => f.events.slice(offset).some(event => event.kind === 'compact.state' && event.data.requestId === requestId && event.data.state === 'completed'))
    expect(f.calls).toHaveLength(count)
    expect(f.errors).toEqual([])
  } finally { gate.release(); await f.close() }
}, 30000)

test('空闲会话主动压缩：断开继续，重连同请求不重放，摘要原子落库并释放执行责任', async () => {
  const root = realpathSync(mkdtempSync('/tmp/magic-c-'))
  const home = join(root, 'home'), base = join(root, 'data'), workspace = join(root, 'project')
  for (const dir of [home, base, workspace]) mkdirSync(dir)
  const magic = { home, base }
  const paths = runPathsOf(magic, '/tmp')
  const session = 'stored-idle-session', requestId = 'compact-without-client'
  const model = 'deepseek-flash'
  const note = join(base, 'notes', session, 'MEMORY.md')
  const environment = { HOME: home, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', NO_PROXY: '127.0.0.1,localhost' }
  let releaseSummary!: () => void
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve })
  let summaryReached = false
  let fixture: Fixture | undefined
  let manager: Manager | undefined
  let client: ManagerClient | undefined
  let store: ReturnType<typeof createRecordsStore> | undefined
  const starts: number[] = [], exits: { gen: number; reason: string }[] = []
  const events: KernelEvent[] = []
  try {
    const turns: FixtureTurn[] = []
    fixture = startFixture({ model, turns })
    writeFileSync(join(base, 'config.json'), JSON.stringify({ dataDir: base, workspaceRoots: [workspace],
      models: Object.fromEntries(['default', 'cantrip', 'spell', 'arcane'].map(choice => [choice, { provider: 'local', model }])),
      providers: { local: { vendor: 'deepseek', protocol: 'chat-completions', baseURL: fixture.baseURL, apiKey: FAKE_API_KEY,
        modelOverrides: { [model]: { reasoningSupport: { disable: true, levels: ['high'] } } },
      } },
    }))
    store = createRecordsStore({ dataDir: base, workspace: [workspace] })
    const records = store.serviceFor(session)
    const originalIds: number[] = []
    for (let index = 0; index < 12; index++) {
      originalIds.push(records.appendEntry({ kind: 'user', content: { text: `阶段 ${index} 的用户要求` }, at: index * 2 + 1 }))
      originalIds.push(records.appendEntry({ kind: 'assistant', content: { text: `阶段 ${index} 已完成` }, at: index * 2 + 2 }))
    }
    turns.push({ kind: 'tool', name: 'history_read', args: { entry: originalIds[0] }, following: [
      ...originalIds.slice(1, 4).map(entry => ({ name: 'history_read', args: { entry } })),
      { name: 'plan_read', args: {} }, { name: 'ls', args: { path: join(base, 'notes', session) } },
    ], text: '开始实际接续准备', chunks: 1, chunkDelayMs: 0, beforeChunk: async () => { summaryReached = true; await summaryGate } },
    { kind: 'tool', name: 'write', args: { path: note, content: originalIds.slice(0, 4).map(id => `已读取原文 [来源](${session}#${id})`).join('\n') } },
    { kind: 'text', text: '本批已保存', chunks: 1, chunkDelayMs: 0 })
    store.collaboration.registerAgent({ operationId: 'seed-agent', sessionId: session, name: '已存工作', role: '',
      model: { protocol: 'chat-completions', endpoint: fixture.baseURL, choice: 'default', provider: 'local', model }, at: 1,
    })
    const launcher = createAgentLauncher()
    const started = await startManager({ paths, magic, stopGraceMs: 1_000, stopKillMs: 1_000, launch: {
      spawn(request) {
        starts.push(request.gen)
        const child = launcher.spawn(request)
        child.onExit(reason => exits.push({ gen: request.gen, reason }))
        return child
      },
    } })
    if (started.role !== 'manager') throw new Error(`隔离 Engine 未启动：${started.role}`)
    manager = started.manager
    client = await connectManager(paths.socket, { cwd: workspace, environment, expectedIdentity: manager.identity })
    if (!client) throw new Error('连接隔离 Engine 失败')
    client.onEvent(event => events.push(event))
    expect(manager.executors()).toEqual([])
    expect(starts).toEqual([])
    expect(fixture.requests().filter(request => request.path.endsWith('/chat/completions'))).toEqual([])
    const states = async () => (await Array.fromAsync(records.readEvents(session)))
      .filter((event): event is Extract<KernelEvent, { kind: 'compact.state' }> => event.kind === 'compact.state' && event.data.requestId === requestId)
    const chats = () => fixture!.requests().filter(request => request.path.endsWith('/chat/completions'))

    // 真实 provider/SDK 接受独立准备输入，工具往返保存后才提交覆盖。
    client.send({ type: 'compact.request', session, requestId })
    await waitFor('真实摘要 HTTP 请求', () => summaryReached)
    await waitFor('压缩运行事实落库', async () => (await states()).at(-1)?.data.state === 'running')
    expect(starts).toHaveLength(1)
    expect(manager.executors()).toEqual([{ session, gen: starts[0]! }])
    expect(records.coverage.read().summary).toBeNull()
    expect(chats()).toHaveLength(1)
    expect(JSON.stringify(chats()[0]!.body['messages'])).toContain('这是当前模型的独立接续准备')
    expect(chats()[0]!.tools).toBe(8)

    client.close(); client = undefined
    await waitFor('客户端断开', () => manager!.clients() === 0)
    expect(manager.executors()).toHaveLength(1)
    expect((await states()).at(-1)?.data.state).toBe('running')
    releaseSummary()
    await waitFor('无客户端时摘要完成', async () => (await states()).at(-1)?.data.state === 'completed')
    expect(manager.clients()).toBe(0)
    const completed = (await states()).at(-1)!.data
    const memory = records.coverage.read()
    const entries = await Array.fromAsync(records.readEntries(session))
    const summaries = entries.filter(entry => entry.kind === 'summary')
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]!
    if (completed.summary === undefined || summary.payload === undefined || !('coveredThrough' in summary.payload)
      || !('text' in summary.content)) throw new Error('摘要事务缺少正文、覆盖或成功引用')
    expect(completed.summary).toBe(summary.id)
    expect(memory.summary).toBe(completed.summary)
    expect(memory.coveredThrough).toBe(summary.payload.coveredThrough)
    expect(memory.coveredThrough).toBeGreaterThan(0)
    expect(readFileSync(note, 'utf8')).toContain(`${session}#${originalIds[3]}`)
    expect(summary.content.text).not.toContain('已读取原文')
    expect(completed.notesSaved).toBe(true)
    expect(entries.filter(entry => entry.kind !== 'summary').map(entry => entry.id)).toEqual(originalIds)
    expect((await states()).map(event => event.data.state)).toEqual(['pending', 'running', 'running', 'completed'])
    await waitFor('执行责任正常释放', () => manager!.executors().length === 0 && manager!.runs().every(run => !run.holds) && exits.length === 1)
    expect(exits).toEqual([{ gen: starts[0]!, reason: '执行实例已释放' }])

    client = await connectManager(paths.socket, { cwd: workspace, environment, expectedIdentity: manager.identity })
    if (!client) throw new Error('重连隔离 Engine 失败')
    client.onEvent(event => events.push(event))
    const requestState = async (command: CompactCommand) => {
      const offset = events.length
      client!.send(command)
      let response: Extract<KernelEvent, { kind: 'compact.state' }> | undefined
      await waitFor(`${command.type} 回执`, () => {
        response = events.slice(offset).find((event): event is Extract<KernelEvent, { kind: 'compact.state' }> =>
          event.kind === 'compact.state' && event.data.requestId === requestId)
        return response !== undefined
      })
      return response!.data
    }
    expect(await requestState({ type: 'compact.query', session, requestId })).toEqual(completed)
    expect(await requestState({ type: 'compact.request', session, requestId })).toEqual(completed)
    expect(chats()).toHaveLength(3)
    expect(starts).toHaveLength(1)
    expect(manager.executors()).toEqual([])
    expect(manager.runs().every(run => !run.holds)).toBe(true)
    expect(await states()).toHaveLength(4)
    expect(records.coverage.read()).toEqual(memory)
    expect((await Array.fromAsync(records.readEntries(session))).map(entry => entry.id)).toEqual(entries.map(entry => entry.id))
    expect(events.filter(event => event.kind === 'error')).toEqual([])
    client.close(); client = undefined
    manager.stop('测试完成'); await manager.waitUntilExit(); manager = undefined
    expect(existsSync(paths.socket)).toBe(false)
  } finally {
    releaseSummary()
    client?.close()
    try {
      if (manager) { manager.stop('测试清场'); await manager.waitUntilExit() }
    } finally {
      try { await fixture?.stop() } finally { store?.close(); rmSync(root, { recursive: true, force: true }) }
    }
  }
  expect(existsSync(root)).toBe(false)
}, 30_000)

test('成员忙时主动压缩固定提交目标，切回整体后查询和取消不打断成员业务', async () => {
  const { collaborationRuntime, latch } = await import('./run-collaboration-fixture.ts')
  const gate = latch()
  const f = await collaborationRuntime('compact-member-boundary', async call => {
    if (call.kind === 'agent') { await gate.promise; return { text: '成员原业务正常结束' } }
    return { text: '不应发生的整理调用' }
  })
  try {
    const model = { protocol: 'chat-completions' as const, endpoint: (JSON.parse(await Bun.file(join(f.magic.base, 'config.json')).text()).providers.controlled.baseURL as string),
      choice: 'default' as const, provider: 'controlled', model: 'entry-model' }
    const rootRecords = f.store.serviceFor('origin')
    const origin = { sessionId: 'origin', entryId: rootRecords.appendEntry({ kind: 'user', at: 1, content: { text: '整体原始要求' } }) }
    const coordinator = f.store.collaboration.registerAgent({ operationId: 'root', sessionId: 'origin', name: '整体', role: '', model, at: 1 })
    f.store.collaboration.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 1 })
    const member = f.store.collaboration.spawn(coordinator.agentId, { operationId: 'member', sessionId: 'member', name: '成员', role: '', model,
      scope: '成员工作', source: origin, authorization: [origin], body: [{ kind: 'text', text: '成员原工作' }], at: 2 })
    f.store.collaboration.respondToDelegation(member.agent.agentId, { operationId: 'accept', delegationId: member.delegation.delegationId, response: 'accept', at: 3 })
    f.store.collaboration.consumeInbox(member.agent.agentId, 4)
    const memberRecords = f.store.serviceFor('member')
    f.client.send({ type: 'session.open', session: 'member' })
    await f.wait('进入成员会话', () => f.shell.getView().sessionId === 'member')
    for (const char of '继续成员原业务') f.shell.key({ kind: 'char', char })
    f.shell.key({ kind: 'enter' })
    await f.wait('成员业务在途', () => f.calls.some(call => call.kind === 'agent'))
    for (const char of '/compact 保留成员重点') f.shell.key({ kind: 'char', char })
    f.shell.key({ kind: 'enter' })
    const request = f.commands.findLast(command => command.type === 'compact.request')
    if (request?.type !== 'compact.request') throw new Error('未提交压缩请求')
    expect(request.session).toBe('member')
    await f.wait('忙时压缩已受理', () => f.events.some(event => event.kind === 'compact.state' && event.data.requestId === request.requestId && event.data.state === 'pending'))
    f.client.send({ ...request, focus: '重复投递不能改重点' })
    f.client.send({ type: 'session.open', session: 'origin' })
    await f.wait('查看整体不停止成员', () => f.shell.getView().sessionId === 'origin')
    for (const char of '整体新草稿') f.shell.key({ kind: 'char', char })
    const offset = f.events.length
    f.client.send({ type: 'compact.query', session: 'member', requestId: request.requestId })
    await f.wait('从整体查询成员请求', () => f.events.slice(offset).some(event => event.kind === 'compact.state' && event.data.requestId === request.requestId))
    expect(f.events.slice(offset).find(event => event.kind === 'compact.state')).toMatchObject({ session: 'member', data: { state: 'pending', focus: '保留成员重点' } })
    expect(f.shell.getView().draft).toBe('整体新草稿')
    f.client.send({ type: 'compact.cancel', session: 'member', requestId: request.requestId })
    await f.wait('取消仅对应压缩', () => f.events.some(event => event.kind === 'compact.state' && event.data.requestId === request.requestId && event.data.state === 'cancelled'))
    expect(f.calls.filter(call => call.kind !== 'agent')).toEqual([])
    expect(memberRecords.coverage.read().summary).toBeNull()
    expect(rootRecords.coverage.read().summary).toBeNull()
    expect(f.manager.runs().some(run => run.session === 'member' && run.state !== 'idle')).toBe(true)
    gate.release()
    await f.wait('原业务继续完成', () => f.manager.runs().some(run => run.session === 'member' && run.state === 'idle'))
    const entries = await Array.fromAsync(memberRecords.readEntries('member'))
    expect(entries.some(entry => entry.kind === 'assistant' && 'text' in entry.content && entry.content.text === '成员原业务正常结束')).toBe(true)
    expect(entries.some(entry => entry.kind === 'user' && 'text' in entry.content && entry.content.text.includes('保留成员重点'))).toBe(false)
    const states = (await Array.fromAsync(memberRecords.readEvents('member'))).filter(event => event.kind === 'compact.state')
    expect(states.map(event => event.data.state)).toEqual(['pending', 'cancelled'])
    expect((await Array.fromAsync(rootRecords.readEvents('origin'))).some(event => event.kind === 'compact.state')).toBe(false)
    expect(f.calls.filter(call => call.kind === 'agent')).toHaveLength(1)
    expect(f.calls.filter(call => call.kind !== 'agent')).toEqual([])
    expect(f.shell.getView().sessionId).toBe('origin')
    expect(f.shell.getView().draft).toBe('整体新草稿')
    expect(f.errors).toEqual([])
  } finally { gate.release(); await f.close() }
}, 30_000)

test('新建工作复用当前执行器压缩，真实SDK发辅助请求；部分保存取消保留文件与原覆盖', async () => {
  const { collaborationRuntime, latch } = await import('./run-collaboration-fixture.ts')
  const gate = latch()
  let note = ''
  const f = await collaborationRuntime('compact-new-session', async call => {
    if (call.kind === 'agent') return { text: '新工作已建立' }
    if (call.index === 0) return { tool: 'write', args: { path: note, content: '实际部分保存；原历史仍保留' } }
    await gate.promise
    return { text: '尚未完整准备' }
  })
  try {
    expect(f.session()).toBeNull()
    f.client.send({ type: 'input.submit', ref: 'new-work', text: '新建工作后压缩' })
    await f.wait('新工作空闲', () => f.calls.length === 1 && f.manager.runs().some(run => run.session === f.session() && run.state === 'idle'))
    const session = f.session()!, records = f.store.serviceFor(session)
    const generation = f.manager.executors()[0]?.gen
    expect(generation).toBeDefined()
    for (let n = 0; n < 24; n++) records.appendEntry({ kind: n % 2 ? 'assistant' : 'user', content: { text: `接续材料 ${n}` }, at: n + 1 })
    note = join(f.magic.base, 'notes', session, 'MEMORY.md')
    const requestId = 'new-work-compact'
    f.client.send({ type: 'compact.request', session, requestId })
    await f.wait('部分保存持久事实', () => f.events.some(event => event.kind === 'compact.state' && event.data.requestId === requestId && event.data.notesSaved === true))
    expect(f.manager.executors()).toEqual([{ session, gen: generation! }])
    const prepare = f.calls.find(call => call.kind === 'internal')!
    expect(prepare.model).toBe('entry-model')
    const messages = prepare.body['messages'] as { role: string; content: string }[]
    expect(messages.some(message => message.role === 'user')).toBe(true)
    expect((prepare.body['tools'] as { function: { name: string } }[]).map(tool => tool.function.name).sort()).toEqual(['edit', 'glob', 'grep', 'history_read', 'ls', 'plan_read', 'read', 'write'])
    f.client.send({ type: 'compact.cancel', session, requestId })
    await f.wait('同请求取消', () => f.events.some(event => event.kind === 'compact.state' && event.data.requestId === requestId && event.data.state === 'cancelled'))
    expect(readFileSync(note, 'utf8')).toBe('实际部分保存；原历史仍保留')
    expect(records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
    const states = (await Array.fromAsync(records.readEvents(session))).filter(event => event.kind === 'compact.state')
    expect(new Set(states.map(event => event.data.requestId))).toEqual(new Set([requestId]))
    expect(states.at(-1)?.data).toMatchObject({ state: 'cancelled', notesSaved: true })
  } finally { gate.release(); await f.close() }
}, 30_000)
