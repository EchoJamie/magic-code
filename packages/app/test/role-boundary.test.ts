import { expect, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelRequest } from '@magic/contracts'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { createRecordsStore } from '@magic/data'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

for (const state of ['accepted', 'queued', 'stopped'] as const) test(`显式read角色的普通成员经完整协作链读取三种知识并维护自身记忆，生命周期 ${state}`, async () => {
  const stage = makeStage({ config: { agentRoles: { reader: { name: '查证', instructions: '只读核对业务材料', tools: ['read'] } } } })
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
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
    if (state === 'accepted') {
      expect(outputs.map(event => event.data.ok)).toEqual([true, true, true, true, true, false])
      const results = requests.flatMap(request => request.messages).filter(message => message.role === 'tool')
      expect(results.some(message => message.role === 'tool' && message.name === 'knowledge_source' && message.output.includes('用户原工作证据'))).toBe(true)
    } else if (state === 'queued') {
      expect(outputs.map(event => event.data.ok)).toEqual([false, false, false, true, false, false])
      expect(JSON.stringify(outputs[0]?.data)).toContain('active delegation binding required')
    } else {
      expect(outputs.some(event => event.data.ok)).toBe(false)
      expect(app.records.collaboration.getCollaboration(collaboration.collaborationId)?.state).toBe('stopped')
    }
    expect(existsSync(join(stage.dataDir, 'notes', 'member', 'MEMORY.md'))).toBe(state !== 'stopped')
    expect(existsSync(join(stage.dataDir, 'notes', 'origin', 'MEMORY.md'))).toBe(false)
    expect(readFileSync(join(stage.workspace, 'probe.txt'), 'utf8')).toBe('原值')
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})
