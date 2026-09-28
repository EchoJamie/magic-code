import { expect, test } from 'bun:test'
import { createConversationSession } from '@magic/conversation'
import type { ConversationSession } from '@magic/conversation'
import { createRecordsStore } from '@magic/records'
import { createFauxGateway, makeFauxSink, makeFauxToolRuntime, makeTestStamper } from '@magic/faux'
import type { FauxTurn, FauxToolHandler, FauxSink } from '@magic/faux'
import { tempDir, removeDir } from './tmp.ts'
import { createCollaborationBoundary } from '../src/collaboration-boundary.ts'
import { createManagedCollaboration } from '../src/run/collaboration.ts'

function fixture() {
  const dir = tempDir('magic-collaboration-runtime-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const records = store.collaboration
  const origin = { sessionId: 'origin', entryId: store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '同一件工作' }, at: 1 }) }
  const model = { provider: 'controlled', model: 'test' }
  const coordinator = records.registerAgent({ operationId: 'identity', sessionId: 'origin', name: '入口', role: '', model, at: 2 })
  const collaboration = records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 3 })
  return { dir, store, records, coordinator, collaboration,
    spawn(name: string) { return records.spawn(coordinator.agentId, { operationId: `spawn:${name}`, sessionId: name, name, role: '', model,
      responsibility: name, body: [{ kind: 'text', text: '独立工作' }], scope: name, source: origin, authorization: [origin], at: 4 }) },
    close() { store.close(); removeDir(dir) },
  }
}
function makeStage(input: { turns: readonly FauxTurn[]; handlers: Readonly<Record<string, FauxToolHandler>> }) {
  const stamper = makeTestStamper()
  const sink = makeFauxSink()
  const gateway = createFauxGateway({ stamper, turns: input.turns })
  const toolDomain = makeFauxToolRuntime({ handlers: input.handlers,
    definitions: Object.keys(input.handlers).map(name => ({ name, summary: '测试动作', parameters: {}, danger: { level: 'light' } })),
  })
  return { stamper, sink, gateway, toolDomain, promptVars: { cwd: '/test', platform: 'test', date: '2026-09-26' } }
}
async function waitUntilIdle(sink: FauxSink) {
  const start = Date.now()
  // 这里只等测试进程完成；产品唤起来自持久事实变更。
  do {
    await new Promise(resolve => setImmediate(resolve))
    if (sink.byKind('agent.state').at(-1)?.data.state === 'waiting') return
  } while (Date.now() - start < 2000)
  throw new Error('入口没有让出')
}

for (const response of ['clarify', 'reject'] as const) test(`入口已让出且无TUI：成员${response}事件直接唤起入口，领取终态后不空转`, async () => {
  const f = fixture()
  const child = f.spawn('child')
  let root: ConversationSession
  let requests = 0
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: session => { if (session === 'origin') root.wake() },
    cancel: async () => undefined, input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  const stage = makeStage({ turns: [
    { toolCalls: [{ name: 'exec', args: { cmd: 'wait' } }] }, { text: `处理成员${response}` },
  ], handlers: { exec: async () => {
    const result = await managed.request('origin', { action: 'wait', operationId: 'wait', agents: [child.agent.agentId],
      message: child.delegation.delegationId, expectation: '成员响应', deadline: Date.now() + 3600000 })
    expect(result.ok).toBe(true)
    return { ok: true, output: '已登记，等事件', halt: true }
  } } })
  const boundary = createCollaborationBoundary({ records: f.records, session: 'origin', runId: 'root-run', model: () => f.coordinator.model,
    tools: () => undefined, now: Date.now, changed: managed.changed }).boundary
  root = createConversationSession({ session: 'origin', model: 'controlled', prompt: stage.promptVars,
    gateway: { stream(req, opts) { requests++; return stage.gateway.stream(req, opts) } }, tools: stage.toolDomain,
    records: f.store.serviceFor('origin'), sink: stage.sink, stamper: stage.stamper, collaboration: boundary,
  })
  try {
    root.submit({ text: '派好后等待' })
    await waitUntilIdle(stage.sink)
    expect(requests).toBe(1)
    expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.state).toBe('waiting')
    expect((await managed.request('child', { action: 'respond', operationId: response, delegation: child.delegation.delegationId, response, reason: '需要入口处置的事实' })).ok).toBe(true)
    await waitUntilIdle(stage.sink)
    expect(requests).toBe(2)
    const wait = f.records.listWaits(f.collaboration.collaborationId)[0]!
    expect(wait.state).not.toBe('waiting')
    expect(wait.handledAt).toBeDefined()
    expect(JSON.stringify(stage.gateway.requests[1])).toContain('需要入口处置的事实')
    root.wake()
    await waitUntilIdle(stage.sink)
    expect(requests).toBe(2)
  } finally { managed.shutdown('测试清理'); f.close() }
})

test('普通accept回执不唤起空闲入口，不产生模型请求', async () => {
  const f = fixture()
  const child = f.spawn('child')
  let rootWakes = 0
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: session => { if (session === 'origin') rootWakes++ },
    cancel: async () => undefined, input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  try {
    expect((await managed.request('child', { action: 'respond', operationId: 'accept', delegation: child.delegation.delegationId, response: 'accept' })).ok).toBe(true)
    await new Promise(resolve => setImmediate(resolve))
    expect(rootWakes).toBe(0)
  } finally { managed.shutdown('测试清理'); f.close() }
})

test('未登记wait的空闲入口也处理拒绝决定；普通accept和重复通知不调用模型', async () => {
  const f = fixture()
  const rejected = f.spawn('rejected-child')
  const accepted = f.spawn('accepted-child')
  let root: ConversationSession
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: session => { if (session === 'origin') root.wake() },
    cancel: async () => undefined, input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  const stage = makeStage({ turns: [{ text: '入口已经交代完毕' }, { text: '处理无法交付的原因' }], handlers: {} })
  const boundary = createCollaborationBoundary({ records: f.records, session: 'origin', runId: 'root-run', model: () => f.coordinator.model,
    tools: () => undefined, now: Date.now, changed: managed.changed }).boundary
  root = createConversationSession({ session: 'origin', model: 'controlled', prompt: stage.promptVars,
    gateway: stage.gateway, tools: stage.toolDomain, records: f.store.serviceFor('origin'), sink: stage.sink,
    stamper: stage.stamper, collaboration: boundary,
  })
  try {
    root.submit({ text: '分给成员后继续各自工作' })
    await waitUntilIdle(stage.sink)
    expect(f.records.listWaits(f.collaboration.collaborationId)).toEqual([])
    expect(stage.gateway.requests).toHaveLength(1)
    expect((await managed.request('accepted-child', { action: 'respond', operationId: 'accept', delegation: accepted.delegation.delegationId,
      response: 'accept' })).ok).toBe(true)
    root.wake()
    await waitUntilIdle(stage.sink)
    expect(stage.gateway.requests).toHaveLength(1)

    const request = { action: 'respond', operationId: 'reject', delegation: rejected.delegation.delegationId,
      response: 'reject', reason: '缺少运行环境，无法交付' } as const
    expect((await managed.request('rejected-child', request)).ok).toBe(true)
    await waitUntilIdle(stage.sink)
    expect(stage.gateway.requests).toHaveLength(2)
    expect(JSON.stringify(stage.gateway.requests[1])).toContain('缺少运行环境，无法交付')
    expect((await managed.request('rejected-child', request)).ok).toBe(true)
    root.wake()
    await waitUntilIdle(stage.sink)
    expect(stage.gateway.requests).toHaveLength(2)
  } finally { managed.shutdown('测试清理'); f.close() }
})

test('协作汇总实际模型用量：成员未报告的调用不补零、不拼出虚假总数', async () => {
  const f = fixture()
  const child = f.spawn('usage-child')
  const stamper = makeTestStamper()
  f.store.appendEvent({ ...stamper.stamp('model.call.start', { model: 'entry-model' }), session: 'origin' })
  f.store.appendEvent({ ...stamper.stamp('model.usage', { inputTokens: 12, outputTokens: 4, totalTokens: 16 }), session: 'origin' })
  f.store.appendEvent({ ...stamper.stamp('model.call.start', { model: 'member-model' }), session: child.agent.sessionId })
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: () => undefined, cancel: async () => undefined,
    input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  try {
    const view = await managed.view('origin')
    expect(view.members.find(m => m.agent.agentId === f.coordinator.agentId)?.usage).toMatchObject({ calls: 1, inputTokens: 12, outputTokens: 4 })
    expect(view.usage).toEqual({ calls: 2, reportedCalls: 1 })
  } finally { managed.shutdown('测试清理'); f.close() }
})

test('整体显式收尾要等资源确认；失败保留closing，可重试且不冒称交付', async () => {
  const f = fixture()
  const child = f.spawn('closing-child')
  f.records.respondToDelegation(child.agent.agentId, { operationId: 'decline', at: 10, delegationId: child.delegation.delegationId, response: 'reject', reason: '不需要此部分' })
  f.records.beginClosing(f.collaboration.collaborationId, 11)
  let cancelled = 0
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: () => undefined,
    cancel: async () => { cancelled++; if (cancelled === 1) throw new Error('自有资源未确认') },
    input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  try {
    await expect(managed.idle('origin')).rejects.toThrow('自有资源未确认')
    expect(f.records.getCollaboration(f.collaboration.collaborationId)?.state).toBe('closing')
    expect(await managed.idle('origin')).toBe(true)
    expect(f.records.getCollaboration(f.collaboration.collaborationId)?.state).toBe('closed')
  } finally { managed.shutdown('测试清理'); f.close() }
})

for (const kind of ['message', 'wait'] as const) test(`已领取${kind}在请求发出前失败：显式再唤起可补取，成功带入后不重放`, async () => {
  const f = fixture()
  const child = f.spawn('retry-child')
  if (kind === 'message') f.records.send(child.agent.agentId, { operationId: 'response', at: 5,
    recipients: [f.coordinator.agentId], purpose: 'inform', body: [{ kind: 'text', text: 'PENDING_RETRY_FACT' }] })
  else {
    f.records.registerWait(f.coordinator.agentId, { operationId: 'wait', at: 5, deadline: 6,
      forAgents: [child.agent.agentId], expectation: 'PENDING_RETRY_FACT' })
    f.records.expireWaits(7)
  }
  const stage = makeStage({ turns: [{ text: '已处理此前未能发出的事实' }], handlers: {} })
  let attempts = 0
  const build = () => createConversationSession({ session: 'origin', model: 'controlled', prompt: stage.promptVars,
    gateway: { stream(request, options) { if (++attempts === 1) throw new Error('HTTP前的本地配置失败'); return stage.gateway.stream(request, options) } },
    tools: stage.toolDomain, records: f.store.serviceFor('origin'), sink: stage.sink, stamper: stage.stamper,
    collaboration: createCollaborationBoundary({ records: f.records, session: 'origin', runId: 'retry-run',
      model: () => f.coordinator.model, tools: () => undefined, now: Date.now, changed: () => undefined }).boundary,
  })
  try {
    build().wake()
    await waitUntilIdle(stage.sink)
    expect(attempts).toBe(1)
    expect(stage.gateway.requests).toHaveLength(0)
    if (kind === 'wait') {
      expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.handledAt).toBeDefined()
      expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.includedAt).toBeUndefined()
    }
    // 重建实例，证明可重试事实在库中，不依赖失败实例内的标志。
    const resumed = build()
    resumed.wake()
    await waitUntilIdle(stage.sink)
    expect(attempts).toBe(2)
    expect(JSON.stringify(stage.gateway.requests[0])).toContain('PENDING_RETRY_FACT')
    if (kind === 'wait') expect(f.records.listWaits(f.collaboration.collaborationId)[0]?.includedAt).toBeDefined()
    resumed.wake()
    await waitUntilIdle(stage.sink)
    expect(attempts).toBe(2)
  } finally { f.close() }
})

test('有效等待期间收到新交代，协调者仍可执行点名停止', async () => {
  const f = fixture()
  const child = f.spawn('stop-child')
  f.records.respondToDelegation(child.agent.agentId, { operationId: 'accept', at: 5,
    delegationId: child.delegation.delegationId, response: 'accept' })
  f.records.registerWait(f.coordinator.agentId, { operationId: 'waiting', at: 6, deadline: Date.now() + 3600000,
    forAgents: [child.agent.agentId], expectation: '等待子工作' })
  let stops = 0
  const stage = makeStage({ turns: [{ toolCalls: [{ name: 'agent_control', args: { action: 'stop', delegation: child.delegation.delegationId, reason: '依赖变更' } }] }, { text: '已撤回并保留结果' }],
    handlers: { agent_control: () => { stops++; f.records.stop({ kind: 'delegation', delegationId: child.delegation.delegationId }, '依赖变更', 7); return { ok: true, output: '停止已受理' } } } })
  const root = createConversationSession({ session: 'origin', model: 'controlled', prompt: stage.promptVars,
    gateway: stage.gateway, tools: stage.toolDomain, records: f.store.serviceFor('origin'), sink: stage.sink, stamper: stage.stamper,
    collaboration: createCollaborationBoundary({ records: f.records, session: 'origin', runId: 'control-run',
      model: () => f.coordinator.model, tools: () => undefined, now: Date.now, changed: () => undefined }).boundary,
  })
  try {
    root.submit({ text: '有新情况，请撤回正在等待的这份委派' })
    await waitUntilIdle(stage.sink)
    expect(stops).toBe(1)
    expect(f.records.getDelegation(child.delegation.delegationId)?.state).toBe('cancelled')
    expect(stage.gateway.requests).toHaveLength(2)
  } finally { f.close() }
})


test('旧代资源核销重试仅结算该代 token，不结束后继执行记录', () => {
  const f = fixture()
  const managed = createManagedCollaboration({ store: f.store, magic: { home: f.dir, base: f.dir }, now: Date.now,
    accepting: () => true, start: async () => undefined, wake: () => undefined, cancel: async () => undefined,
    input: () => undefined, configure: async () => undefined, runs: () => [], decisions: () => 0, changed: () => undefined,
  })
  try {
    const actor = f.coordinator.agentId
    f.records.beginExecution(actor, { operationId: 'old-call', runId: 'old-token', kind: 'model', at: 4 })
    managed.executorExited('origin', 'old-token', '旧代资源已退出')
    f.records.beginExecution(actor, { operationId: 'next-call', runId: 'next-token', kind: 'model', at: 5 })
    managed.executorExited('origin', 'old-token', '重试旧代确认')
    const calls = f.records.listExecutions(f.collaboration.collaborationId)
    expect(calls.find(call => call.operationId === 'old-call')).toMatchObject({ state: 'finished', reason: '旧代资源已退出' })
    expect(calls.find(call => call.operationId === 'next-call')?.state).toBe('running')
    managed.executorExited('origin', 'next-token', '本代资源已退出')
    expect(f.records.listExecutions(f.collaboration.collaborationId).every(call => call.state === 'finished')).toBe(true)
  } finally { managed.shutdown('测试清理'); f.close() }
})
