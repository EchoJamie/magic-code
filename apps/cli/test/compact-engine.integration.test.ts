/** 主动压缩走真实 Unix socket、执行器桥及本地 HTTP，客户端不持有执行责任。 */
import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompactCommand, KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/data'
import { connectManager, type ManagerClient } from '@magic/host'
import { createAgentLauncher } from '@magic/host'
import { startManager, type Manager } from '@magic/host'
import { runPathsOf } from '@magic/host'
import { startFixture, type Fixture, type FixtureTurn } from './ui/fixture.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'

async function waitFor(label: string, check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error(`等待${label}超时`)
    await Bun.sleep(5)
  }
}

test('空闲会话主动压缩：断开继续，重连同请求不重放，摘要原子落库并释放执行责任', async () => {
  const root = realpathSync(mkdtempSync('/tmp/magic-c-'))
  const home = join(root, 'home'), base = join(root, 'data'), workspace = join(root, 'project')
  for (const dir of [home, base, workspace]) mkdirSync(dir)
  const magic = { home, base }
  const paths = runPathsOf(magic, '/tmp')
  const session = 'stored-idle-session', requestId = 'compact-without-client'
  const model = 'deepseek-flash'
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
    const brief = `## 目标与阶段\n继续已存工作\n## 证据位置\n${originalIds.slice(0, 4).map(id => `${session}#${id}`).join('\n')}`
    turns.push({ kind: 'text', text: brief, chunks: 1, chunkDelayMs: 0, beforeChunk: async () => { summaryReached = true; await summaryGate } })
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
    expect(JSON.stringify(chats()[0]!.body['messages'])).toContain('你是接续简报的整理者')
    expect(chats()[0]!.tools).toBe(0)

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
    expect(summary.content.text).toContain(`${session}#${originalIds[3]}`)
    expect(completed.notesSaved).toBe(true)
    expect(entries.filter(entry => entry.kind !== 'summary').map(entry => entry.id)).toEqual(originalIds)
    expect((await states()).map(event => event.data.state)).toEqual(['pending', 'running', 'completed'])
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
    expect(chats()).toHaveLength(1)
    expect(starts).toHaveLength(1)
    expect(manager.executors()).toEqual([])
    expect(manager.runs().every(run => !run.holds)).toBe(true)
    expect(await states()).toHaveLength(3)
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
