import { expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, ModelRequest } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { createRecordsStore } from '@magic/data'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

/** 按调用（名 ＋ 路径）取结果——并发与「扣下」都会让事件顺序不再等于调用顺序。 */
function outcomesOf(events: readonly KernelEvent[]): Map<string, boolean> {
  const calls = new Map<number, { name: string; args: Readonly<Record<string, unknown>> }>()
  for (const event of events) {
    if (event.kind === 'tool.call') calls.set(event.id, { name: event.data.name, args: event.data.args })
  }
  const out = new Map<string, boolean>()
  for (const event of events) {
    if (event.kind !== 'tool.result') continue
    const call = calls.get(event.data.call)
    if (call === undefined) continue
    const path = typeof call.args['path'] === 'string' ? `:${call.args['path']}` : ''
    out.set(`${call.name}${path}`, event.data.ok)
  }
  return out
}

for (const state of ['accepted', 'queued', 'stopped'] as const) test(`显式read角色的普通成员经完整协作链读取三种知识并维护自身记忆，生命周期 ${state}`, async () => {
  const stage = makeStage({ config: { agentRoles: { reader: { name: '查证', instructions: '只读核对业务材料', tools: ['read'] } } } })
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'cantrip' as const, provider: 'test', model: 'test' }
  const rootSource = store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '用户原工作证据' }, at: 1 })
  const origin = { sessionId: 'origin', entryId: rootSource }
  const root = store.collaboration.registerAgent({ operationId: 'root', sessionId: 'origin', name: '入口', role: '', model, at: 1 })
  const collaboration = store.collaboration.openCollaboration(root.agentId, { operationId: 'open', origin, at: 1 })
  const member = store.collaboration.spawn(root.agentId, { operationId: 'spawn', sessionId: 'member', name: '普通成员', role: 'reader', model,
    scope: '只读查证', source: origin, authorization: [origin], body: [{ kind: 'text', text: '核对知识' }], at: 1 })
  store.serviceFor('member').appendEntry({ kind: 'user', content: { text: '只读核对要求' }, at: 1 })
  if (state !== 'queued') store.collaboration.respondToDelegation(member.agent.agentId, { operationId: 'accept', delegationId: member.delegation.delegationId, response: 'accept', at: 1 })
  expect(store.knowledge.write([{ id: 'known', expectedRevision: 0, scope: { kind: 'project', workspace: [realpathSync(stage.workspace)] },
    topic: '已知', terms: [], conclusion: '可复用认识', conditions: '核对条件', evidence: 'fact', status: 'active', sources: [{ session: 'origin', entry: rootSource }], dependencies: [] }]).ok).toBe(true)
  store.close()
  writeFileSync(join(stage.workspace, 'probe.txt'), '原值')
  const turns: FauxTurn[] = [{ toolCalls: [
    { name: 'knowledge_search', args: {} },
    { name: 'knowledge_read', args: { id: 'known' } },
    { name: 'knowledge_source', args: { id: 'known', session: 'origin', entry: rootSource } },
    { name: 'write', args: { path: join(stage.dataDir, 'notes', 'member', 'MEMORY.md'), content: '只读核对要求' } },
    { name: 'read', args: { path: 'probe.txt' } },
    { name: 'write', args: { path: 'probe.txt', content: '越权修改' } },
  ] }, { text: '已核对' }]
  const requests: ModelRequest[] = []
  let app!: Assembly
  app = stage.assemble({ session: 'member', collaboration: async () => ({ ok: false, reason: '未调用协作操作' }), modelGateway(stamper) {
    const gateway = createFauxGateway({ stamper, turns })
    return { stream(request, options) {
      requests.push(request)
      if (state === 'stopped') app.records.collaboration.stop({ kind: 'collaboration', collaborationId: collaboration.collaborationId }, '用户停止整体工作', Date.now())
      return gateway.stream(request, options)
    } }
  } })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('核对知识并维护自身记忆')
    expect(requests.length).toBeGreaterThan(0)
    const names = requests[0]!.tools!.map(tool => tool.name)
    for (const name of ['knowledge_search', 'knowledge_read', 'knowledge_source', 'write']) expect(names).toContain(name)
    const outputs = eventsOfKind(shell.events, 'tool.result')
    const outcomes = outcomesOf(shell.events)
    if (state === 'accepted') {
      expect(outcomes.get('knowledge_search')).toBe(true)
      expect(outcomes.get('knowledge_read')).toBe(true)
      expect(outcomes.get('knowledge_source')).toBe(true)
      expect(outcomes.get(`write:${join(stage.dataDir, 'notes', 'member', 'MEMORY.md')}`)).toBe(true)
      expect(outcomes.get('read:probe.txt')).toBe(true)
      expect(outcomes.get('write:probe.txt')).toBe(false)
      const results = requests.flatMap(request => request.messages).filter(message => message.role === 'tool')
      expect(results.some(message => message.role === 'tool' && message.name === 'knowledge_source' && message.output.includes('用户原工作证据'))).toBe(true)
    } else if (state === 'queued') {
      expect(outcomes.get('knowledge_search')).toBe(false)
      expect(outcomes.get('knowledge_read')).toBe(false)
      expect(outcomes.get('knowledge_source')).toBe(false)
      expect(outcomes.get(`write:${join(stage.dataDir, 'notes', 'member', 'MEMORY.md')}`)).toBe(true)
      expect(outcomes.get('read:probe.txt')).toBe(false)
      expect(outcomes.get('write:probe.txt')).toBe(false)
      // 准入拒绝的文案（T2.2 · N14 定案）：英文 token 已在产生点映射为三段式，
      // 断言锁新文案里能锁语义的两段——「这一轮没有开始执行」与「立即再试」（非 retry）。
      expect(outputs.some(event => JSON.stringify(event.data).includes('这一轮没有开始执行'))).toBe(true)
      expect(outputs.some(event => JSON.stringify(event.data).includes('立即再试'))).toBe(true)
    } else {
      expect(outputs.some(event => event.data.ok)).toBe(false)
      expect(app.records.collaboration.getCollaboration(collaboration.collaborationId)?.state).toBe('stopped')
    }
    expect(existsSync(join(stage.dataDir, 'notes', 'member', 'MEMORY.md'))).toBe(state !== 'stopped')
    expect(existsSync(join(stage.dataDir, 'notes', 'origin', 'MEMORY.md'))).toBe(false)
    expect(readFileSync(join(stage.workspace, 'probe.txt'), 'utf8')).toBe('原值')
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})
