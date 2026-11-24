import { expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { createRecordsStore } from '@magic/data'
import { createMaterialReader, createPlanReader } from '@magic/conversation'
import { createFauxGateway } from '@magic/faux'
import { createCollaborationActions } from '@magic/host'
import type { EntryReference, ModelRequest } from '@magic/contracts'
import { attachShell } from '../src/index.ts'
import { lastModel, makeStage } from './support.ts'
import { requestFromStoredSession } from './conversation-request.ts'

const OLD = 'collaboration-derived-K-unique'
function fixture() {
  const stage = makeStage()
  const workspace = [realpathSync(stage.workspace)]
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace })
  const records = store.collaboration
  const service = store.serviceFor('origin')
  const origin = { sessionId: 'origin', entryId: service.appendEntry({ kind: 'user', content: { text: '共同用户要求：仅核对，不修改业务' }, at: 1 }) }
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'cantrip' as const, provider: 'test', model: 'test' }
  const coordinator = records.registerAgent({ operationId: 'identity', sessionId: 'origin', name: '入口', role: '', model, at: 2 })
  const collaboration = records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 3 })
  const change = { id: 'K', expectedRevision: 0, scope: { kind: 'project' as const, workspace }, topic: '已有经验', terms: [], conclusion: OLD,
    conditions: '需核对条件', evidence: 'fact' as const, status: 'active' as const, sources: [{ session: 'origin', entry: origin.entryId }], dependencies: [] }
  expect(store.knowledge.write([change]).ok).toBe(true)
  function spawn(session: string, generatedFrom?: EntryReference) {
    const child = records.spawn(coordinator.agentId, { operationId: `spawn:${session}`, sessionId: session, name: session, role: '', model,
      responsibility: generatedFrom ? OLD : '独立核对', scope: generatedFrom ? OLD : '独立范围', source: origin, authorization: [origin],
      body: [{ kind: 'text', text: '成员工作交代' }], at: 4, ...(generatedFrom === undefined ? {} : { generatedFrom }) })
    records.respondToDelegation(child.agent.agentId, { operationId: `accept:${session}`, delegationId: child.delegation.delegationId, response: 'accept', at: 5 })
    return child
  }
  return { stage, workspace, store, records, service, origin, model, coordinator, collaboration, change, spawn,
    close() { store.close(); stage.dispose() } }
}

for (const form of ['entry', 'blob', 'nested'] as const) test(`协作${form}真实材料保留修订，遗忘后仍保留原始交代与回报`, async () => {
  const f = fixture()
  try {
    const member = f.spawn('member')
    const original = f.service.appendEntry({ kind: 'assistant', content: form === 'blob' ? { blob: await f.service.blobs.put(OLD) } : { text: OLD },
      payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 10 })
    let target = member
    let actor = f.coordinator
    let ref = { sessionId: 'origin', entryId: original }
    if (form === 'nested') {
      target = f.spawn('target')
      const first = f.records.send(actor.agentId, { operationId: 'first', recipients: [member.agent.agentId, target.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref }], at: 11 })
      f.records.consumeInbox(member.agent.agentId, 12)
      ref = { sessionId: 'member', entryId: f.records.inbox(member.agent.agentId).find(item => item.messageId === first.messageId)!.entryId! }
      actor = member.agent
    }
    const sent = f.records.send(actor.agentId, { operationId: 'send', recipients: [target.agent.agentId], purpose: 'inform', body: [{ kind: 'entry', ref }], at: 13 })
    f.records.send(f.coordinator.agentId, { operationId: 'independent', recipients: [target.agent.agentId], purpose: 'inform', body: [{ kind: 'text', text: '独立回报：现场文件未变' }], at: 14 })
    f.records.send(f.coordinator.agentId, { operationId: 'mixed', recipients: [target.agent.agentId], purpose: 'inform',
      body: [{ kind: 'entry', ref: f.origin }, { kind: 'entry', ref: { sessionId: 'origin', entryId: original } }], at: 15 })
    f.records.consumeInbox(target.agent.agentId, 16)
    const inbox = f.records.inbox(target.agent.agentId)
    const session = target.agent.sessionId
    const receiver = f.store.serviceFor(session)
    const source = { session, entry: inbox.find(item => item.messageId === sent.messageId)!.entryId! }
    const before = await createMaterialReader({ records: receiver, session })(source)
    expect(before.text).toContain(OLD)
    expect(before.knowledge).toContainEqual({ id: 'K', revision: 1 })
    expect(f.store.knowledge.write([{ ...f.change, id: 'derived', conclusion: '收到的认识', sources: [source] }]).ok).toBe(true)
    f.records.markIncluded(target.agent.agentId, inbox.map(item => item.messageId), 17)
    const delegation = f.records.getDelegation(target.delegation.delegationId)
    expect(f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' }).status).toBe('completed')
    expect(f.records.getDelegation(target.delegation.delegationId)).toEqual(delegation)
    expect(f.records.getAgent(target.agent.agentId)?.reachability).toBe('active')
    expect(f.store.knowledge.read('derived')?.status).toBe('invalid')
    const request = await requestFromStoredSession({ records: receiver, session, cwd: f.stage.workspace, knowledge: f.store.knowledge, text: '继续独立工作' })
    expect(JSON.stringify(request.messages)).toContain(OLD)
    expect(JSON.stringify(request.messages)).toContain('独立回报：现场文件未变')
    expect(JSON.stringify(request.messages)).toContain('共同用户要求：仅核对，不修改业务')
    const historical = await createPlanReader({ records: receiver, session }).readHistory({ entry: source.entry })
    expect(historical.entries[0]?.text).toContain(OLD)
    expect(historical.entries[0]?.knowledge).toContainEqual({ id: 'K', revision: 1 })
    expect(f.store.knowledge.write([{ ...f.change, id: 'revive', sources: [source] }]).ok).toBe(false)

  } finally { f.close() }
})

test('实际模型调用参数与协作发送绑定同次请求；text/blob继承调用记录且不能伪造来源', async () => {
  const f = fixture()
  const member = f.spawn('member')
  const actions = createCollaborationActions({ records: f.records, now: Date.now, origin: async () => f.origin,
    resolveModel: async () => f.model, start: async () => {}, wake: () => {}, cancel: async () => {}, changed: () => {} })
  const app = f.stage.assemble({ session: 'origin', collaboration: (session, request) => actions.request(f.records.agentForSession(session)!.agentId, request), turns: [
    { toolCalls: [{ name: 'knowledge_read', args: { id: 'K' } }] },
    { toolCalls: [{ name: 'agent_message', args: { action: 'send', operationId: 'model-send', recipients: [member.agent.agentId], purpose: 'inform', body: [{ kind: 'text', text: OLD }] } }] },
    { toolCalls: [{ name: 'knowledge_update', args: { id: 'K', expectedRevision: 99, changes: { conclusion: OLD } } }] },
    { text: '完成核对' },
  ] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('读取K后通知成员')
    const entries = await Array.fromAsync(app.records.serviceFor('origin').readEntries('origin'))
    const call = entries.find(entry => entry.kind === 'tool-call' && entry.payload !== undefined && 'name' in entry.payload && entry.payload.name === 'agent_message')!
    expect(call.payload).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })
    const sent = f.records.listMessages(member.agent.agentId).find(message => message.purpose === 'inform')!
    expect(sent.generatedFrom).toEqual({ sessionId: 'origin', entryId: call.id })
    expect(sent.body[0]?.knowledge).toEqual([{ id: 'K', revision: 1, provided: true }])
    const generatedFrom = sent.generatedFrom!
    const blob = await f.service.blobs.put(OLD)
    const blobMessage = f.records.send(f.coordinator.agentId, { operationId: 'blob', recipients: [member.agent.agentId], purpose: 'inform', generatedFrom,
      body: [{ kind: 'blob', blob }], at: 20 })
    expect(blobMessage.body[0]?.knowledge).toEqual(sent.body[0]?.knowledge)
    expect(() => f.records.send(f.coordinator.agentId, { operationId: 'fake', recipients: [member.agent.agentId], purpose: 'inform',
      generatedFrom: f.origin, body: [{ kind: 'text', text: OLD }], at: 21 })).toThrow('sender tool call')
    f.records.consumeInbox(member.agent.agentId, 22)
    const update = entries.find(entry => entry.kind === 'tool-call' && entry.payload !== undefined && 'name' in entry.payload && entry.payload.name === 'knowledge_update')!
    const source = { session: 'origin', entry: update.id }
    f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' })
    const page = await createMaterialReader({ records: f.service, session: 'origin' })(source)
    expect(page.text).toContain(OLD)
    expect(page.knowledge).toEqual([{ id: 'K', revision: 1, provided: true }])
    const request = await requestFromStoredSession({ records: f.service, session: 'origin', cwd: f.stage.workspace, knowledge: f.store.knowledge, text: '下一件事' })
    expect(JSON.stringify(request.messages)).toContain(OLD)
    const calls = request.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : [])
    const results = request.messages.filter(message => message.role === 'tool')
    expect(calls.map(call => call.name)).toContain('knowledge_update')
    expect(calls.map(call => call.id)).toEqual(results.map(result => result.callId))
    expect(calls.find(call => call.name === 'knowledge_update')?.args).toEqual({ id: 'K', expectedRevision: 99, changes: { conclusion: OLD } })
    const receiver = await requestFromStoredSession({ records: f.store.serviceFor('member'), session: 'member', cwd: f.stage.workspace, knowledge: f.store.knowledge, text: '继续独立工作' })
    expect(JSON.stringify(receiver.messages)).toContain(OLD)
  } finally { shell.dispose(); await app.shutdown(); f.close() }
})

test('实际系统请求中的职责/委派范围/等待描述保留，身份与原责任仍保留', async () => {
  const f = fixture()
  let app: ReturnType<typeof f.stage.assemble> | undefined
  let shell: ReturnType<typeof attachShell> | undefined
  try {
    const entryId = f.service.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: 'call-fixture-1', name: 'agent_spawn', args: { responsibility: OLD, scope: OLD }, knowledge: [{ id: 'K', revision: 1 }] }, at: 10 })
    const child = f.spawn('child', { sessionId: 'origin', entryId })
    expect(f.store.knowledge.write([{ ...f.change, id: 'local', topic: '下一步', conclusion: '独立当前认识' }]).ok).toBe(true)
    const own = f.store.serviceFor('child')
    own.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: 'call-fixture-2', name: 'agent_list', args: {}, knowledge: [{ id: 'K', revision: 1 }] }, at: 11 })
    f.records.publishConstraint(f.coordinator.agentId, { operationId: 'user-constraint', source: f.origin, body: [{ kind: 'entry', ref: f.origin }], at: 13 })
    // 将既有消息放到覆盖范围之后只留下系统描述，证明来源不是被普通正文碰巧补上。
    f.records.consumeInbox(child.agent.agentId, 14)
    const through = (await Array.fromAsync(own.readEntries('child'))).at(-1)!.id
    f.records.markIncluded(child.agent.agentId, f.records.inbox(child.agent.agentId).map(item => item.messageId), 15)
    own.coverage.publish({ previousSummary: null, from: 1, through, at: 16, notesSaved: true })
    const requests: ModelRequest[] = []
    const actions = createCollaborationActions({ records: f.records, now: Date.now, origin: async () => f.origin,
      resolveModel: async () => f.model, start: async () => {}, wake: () => {}, cancel: async () => {}, changed: () => {} })
    app = f.stage.assemble({ session: 'child', collaboration: (session, request) => actions.request(f.records.agentForSession(session)!.agentId, request), modelGateway: stamper => ({ stream(request, options) {
      requests.push(request)
      return createFauxGateway({ stamper, turns: [requests.length % 2 === 1 ? { toolCalls: [{ name: 'agent_list', args: {} }] } : { text: '继续独立核对' }] }).stream(request, options)
    } }) })
    shell = attachShell(app.shell)
    await shell.submit('下一步')
    expect(JSON.stringify(requests[0]!.messages[0])).toContain(OLD)
    expect(JSON.stringify(requests[0]!.messages.slice(1))).not.toContain(OLD)
    const first = (await Array.fromAsync(own.readEntries('child'))).find(entry => entry.kind === 'assistant' && entry.id > through)!
    expect(first.payload !== undefined && 'knowledge' in first.payload && first.payload.knowledge?.some(reference => reference.id === 'K')).toBe(true)
    f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' })
    await shell.submit('继续核对当前工作')
    expect(requests).toHaveLength(4)
    const system = requests[2]!.messages[0]!
    expect(JSON.stringify(system)).toContain(OLD)
    expect(JSON.stringify(system)).toContain(child.agent.agentId)
    expect(JSON.stringify(system)).toContain(String(child.delegation.delegationId))
    expect(JSON.stringify(requests[3]!.messages)).toContain(OLD)
    expect(requests[3]!.messages.some(message => message.role === 'tool' && message.name === 'agent_list' && message.ok)).toBe(true)
    expect(f.records.getDelegation(child.delegation.delegationId)?.state).toBe('accepted')
    const last = (await Array.fromAsync(own.readEntries('child'))).findLast(entry => entry.kind === 'assistant')!
    expect(last.payload !== undefined && 'knowledge' in last.payload && last.payload.knowledge?.some(reference => reference.id === 'K')).toBe(true)
  } finally { shell?.dispose(); await app?.shutdown(); f.close() }
})

test('模型生成label的显式来源带修订，遗忘后label及entry正文保持原样', async () => {
  const f = fixture()
  try {
    const child = f.spawn('child')
    const entryId = f.service.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: 'call-fixture-3', name: 'agent_message', args: { label: OLD }, knowledge: [{ id: 'K', revision: 1 }] }, at: 10 })
    const message = f.records.send(f.coordinator.agentId, { operationId: 'label', recipients: [child.agent.agentId], purpose: 'inform',
      generatedFrom: { sessionId: 'origin', entryId }, body: [{ kind: 'entry', ref: f.origin, label: OLD }], at: 11 })
    f.records.consumeInbox(child.agent.agentId, 12)
    const receipt = f.records.inbox(child.agent.agentId).find(item => item.messageId === message.messageId)!
    const own = f.store.serviceFor('child')
    const access = createMaterialReader({ records: own, session: 'child' })
    const page = await access({ session: 'child', entry: receipt.entryId! })
    expect(page.text).toContain(OLD)
    expect(page.knowledge).toContainEqual({ id: 'K', revision: 1 })
    const before = await requestFromStoredSession({ records: own, session: 'child', knowledge: f.store.knowledge, cwd: f.stage.workspace, text: '查看标签' })
    expect(JSON.stringify(before.messages)).toContain(OLD)
    f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' })
    const after = await requestFromStoredSession({ records: own, session: 'child', knowledge: f.store.knowledge, cwd: f.stage.workspace, text: '继续独立工作' })
    expect(JSON.stringify(after.messages)).toContain(OLD)
    expect(JSON.stringify(after.messages)).toContain('共同用户要求：仅核对，不修改业务')
    const historical = await access({ session: 'child', entry: receipt.entryId! })
    expect(historical.text).toContain(OLD)
    expect(historical.knowledge).toContainEqual({ id: 'K', revision: 1 })
  } finally { f.close() }
})

test('实际模型交付沿调用保留来源，交付/接收事实不随遗忘撤回', async () => {
  const f = fixture()
  const member = f.spawn('member')
  const actions = createCollaborationActions({ records: f.records, now: Date.now, origin: async () => f.origin,
    resolveModel: async () => f.model, start: async () => {}, wake: () => {}, cancel: async () => {}, changed: () => {} })
  const app = f.stage.assemble({ session: 'member', collaboration: (session, request) => actions.request(f.records.agentForSession(session)!.agentId, request), turns: [
    { toolCalls: [{ name: 'knowledge_read', args: { id: 'K' } }] },
    { toolCalls: [{ name: 'agent_message', args: { action: 'deliver', operationId: 'delivery', delegation: member.delegation.delegationId, conclusion: OLD, artifacts: [], verified: [], unresolved: [] } }] },
    { text: '已交付' },
  ] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('交付所核对结果')
    const delivered = f.records.getDelegation(member.delegation.delegationId)!
    expect(delivered.state).toBe('delivered')
    const message = f.records.readMessage(f.coordinator.agentId, delivered.deliveryMessageId!)!
    expect(message.generatedFrom?.sessionId).toBe('member')
    expect(message.body[0]?.knowledge?.some(reference => reference.id === 'K')).toBe(true)
    f.records.consumeInbox(f.coordinator.agentId, 20)
    f.records.receiveDelivery(f.coordinator.agentId, member.delegation.delegationId, 21)
    f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' })
    const request = await requestFromStoredSession({ records: f.service, session: 'origin', knowledge: f.store.knowledge, cwd: f.stage.workspace, text: '继续独立工作' })
    expect(JSON.stringify(request.messages)).toContain(OLD)
    expect(f.records.getDelegation(member.delegation.delegationId)?.state).toBe('received')
  } finally { shell.dispose(); await app.shutdown(); f.close() }
})

test('模型停止理由沿本次调用保留依赖，固定宿主理由独立保留且停止事实不变', async () => {
  const f = fixture()
  const child = f.spawn('child')
  const actions = createCollaborationActions({ records: f.records, now: Date.now, origin: async () => f.origin,
    resolveModel: async () => f.model, start: async () => {}, wake: () => {}, cancel: async () => {}, changed: () => {} })
  const app = f.stage.assemble({ session: 'origin', collaboration: (session, request) => actions.request(f.records.agentForSession(session)!.agentId, request), turns: [
    { toolCalls: [{ name: 'agent_control', args: { action: 'stop', delegation: child.delegation.delegationId, reason: OLD } }] }, { text: '已停止指定委派' },
    { toolCalls: [{ name: 'agent_list', args: {} }] }, { text: '已核对当前责任' },
    { toolCalls: [{ name: 'agent_list', args: {} }] }, { text: '保留用户停点' },
  ] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('按已有认识停止这份委派')
    const stopped = f.records.getDelegation(child.delegation.delegationId)!
    expect(stopped.state).toBe('cancelled')
    expect(stopped.reasonFrom?.sessionId).toBe('origin')
    f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget-stop' })
    await shell.submit('核对当前责任')
    expect(JSON.stringify(lastModel(f.stage).requests.slice(2).flatMap(request => request.messages))).toContain(OLD)
    expect(f.records.getDelegation(child.delegation.delegationId)?.state).toBe('cancelled')
  } finally { shell.dispose(); await app.shutdown(); f.close() }
})
