import { expect, test } from 'bun:test'
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/data'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell } from '../src/index.ts'
import { makeStage } from './support.ts'

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

for (const limited of [false, true]) test(`可信用途优先于普通全工具角色，原许可交集 ${limited}，完整协作执行链允许知识读取且禁止实际写入`, async () => {
  const stage = makeStage({ config: { agentRoles: { all: { name: '普通全工具角色', instructions: '可以修改', tools: ['read', 'write', 'exec', 'plan_update'] },
    origin: { name: '发起角色', instructions: '查证', ...(limited ? { tools: ['read'] } : {}) } } } })
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const r = store.collaboration
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
  const entryId = store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '用户原工作' }, at: 1 })
  const root = r.registerAgent({ operationId: 'root', sessionId: 'origin', name: '原工作', role: 'origin', model, at: 1 })
  const origin = { sessionId: 'origin', entryId }
  r.openCollaboration(root.agentId, { operationId: 'open', origin, at: 1 })
  const advisor = r.spawn(root.agentId, { operationId: 'spawn', sessionId: 'advisor', name: '咨询', role: 'all', purpose: 'consultation', model,
    scope: '查证', source: origin, authorization: [origin], body: [{ kind: 'text', text: '只读问题' }], at: 1 })
  r.respondToDelegation(advisor.agent.agentId, { operationId: 'accept', delegationId: advisor.delegation.delegationId, response: 'accept', at: 1 })
  writeFileSync(join(stage.workspace, 'probe.txt'), '原值')
  store.serviceFor('advisor').appendEntry({ kind: 'user', content: { text: '只读核对并维护自身记忆' }, at: 2 })
  expect(store.knowledge.write([{ id: 'known', expectedRevision: 0, scope: { kind: 'project', workspace: [realpathSync(stage.workspace)] }, topic: '已知', terms: [], conclusion: '已有可复用认识', conditions: '核对后使用', evidence: 'fact', status: 'active', sources: [{ session: 'origin', entry: entryId }], dependencies: [] }]).ok).toBe(true)
  store.close()
  const turns: readonly FauxTurn[] = [{ toolCalls: [
    { name: 'knowledge_search', args: {} },
    { name: 'knowledge_read', args: { id: 'known' } },
    { name: 'knowledge_source', args: { id: 'known', session: 'origin', entry: entryId } },
    { name: 'knowledge_update', args: { id: 'known', expectedRevision: 1, changes: { conclusion: '越权修改' } } },
    { name: 'write', args: { path: 'probe.txt', content: '错误副作用' } }, { name: 'read', args: { path: 'probe.txt' } },
    { name: 'write', args: { path: join(stage.dataDir, 'notes', 'advisor', 'MEMORY.md'), content: '只读核对' } },
    { name: 'write', args: { path: join(stage.dataDir, 'notes', 'origin', 'MEMORY.md'), content: '越权写入' } },
  ] }, { text: '建议' }]
  let gateway: ReturnType<typeof createFauxGateway> | undefined
  const app = stage.assemble({ session: 'advisor', collaboration: async () => ({ ok: false, reason: '未调用协作操作' }), modelGateway(stamper) {
    gateway = createFauxGateway({ stamper, turns })
    return gateway
  } })

  const shell = attachShell(app.shell)
  try {
    await shell.submit('查证')
    expect(readFileSync(join(stage.workspace, 'probe.txt'), 'utf8')).toBe('原值')
    const outputs = shell.events.filter(event => event.kind === 'tool.result')
    expect(outputs).toHaveLength(8)
    const outcomes = outcomesOf(shell.events)
    expect(outcomes.size).toBe(8)
    expect(outcomes.get('knowledge_search')).toBe(true)
    expect(outcomes.get('knowledge_read')).toBe(true)
    expect(outcomes.get('knowledge_source')).toBe(true)
    expect(outcomes.get('knowledge_update')).toBe(false)
    expect(outcomes.get('write:probe.txt')).toBe(false)
    expect(outcomes.get('read:probe.txt')).toBe(true)
    expect(outcomes.get(`write:${join(stage.dataDir, 'notes', 'advisor', 'MEMORY.md')}`)).toBe(true)
    expect(outcomes.get(`write:${join(stage.dataDir, 'notes', 'origin', 'MEMORY.md')}`)).toBe(false)
    expect(readFileSync(join(stage.dataDir, 'notes', 'advisor', 'MEMORY.md'), 'utf8')).toBe('只读核对')
    expect(existsSync(join(stage.dataDir, 'notes', 'origin', 'MEMORY.md'))).toBe(false)
    expect(JSON.stringify(gateway!.requests)).toContain('原值')
    const names = gateway!.requests[0]!.tools!.map(tool => tool.name)
    expect(names).toContain('knowledge_search')
    expect(names).toContain('knowledge_read')
    expect(names).toContain('knowledge_source')
    expect(names).not.toContain('knowledge_update')
    expect(app.records.knowledge.read('known')?.conclusion).toBe('已有可复用认识')
    const evidence = process.env['MAGIC_CONSULT_ASSEMBLY_EVIDENCE']
    if (evidence) {
      mkdirSync(evidence, { recursive: true })
      writeFileSync(join(evidence, `u115-assembly-${limited}.json`), JSON.stringify({ proof: 'real-assembly-tool-runtime-faux-model-collaboration-boundary',
        limitedOriginTools: limited, consultationIdentity: advisor.agent, requests: gateway!.requests, events: shell.events,
        probe: readFileSync(join(stage.workspace, 'probe.txt'), 'utf8') }, null, 2))
    }
  } finally { shell.dispose(); app.close(); stage.dispose() }
})

test('普通角色仅开放read时仍可实际维护自身记忆，业务写入仍被白名单拒绝', async () => {
  const stage = makeStage({ config: { agentRoles: { reader: { name: '查证', instructions: '只读检查', tools: ['read'] } } } })
  const store = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  store.serviceFor('reader').appendEntry({ kind: 'user', content: { text: '只读要求' }, at: 1 })
  store.collaboration.registerAgent({ operationId: 'reader', sessionId: 'reader', name: '查证', role: 'reader',
    model: { protocol: 'chat-completions', endpoint: 'https://models.example/v1', choice: 'default', provider: 'test', model: 'test' }, at: 1 })
  store.close()
  writeFileSync(join(stage.workspace, 'probe.txt'), '原值')
  const app = stage.assemble({ session: 'reader', turns: [{ toolCalls: [
    { name: 'write', args: { path: join(stage.dataDir, 'notes', 'reader', 'MEMORY.md'), content: '只读要求' } },
    { name: 'write', args: { path: 'probe.txt', content: '不允许的改动' } },
  ] }, { text: '完成查证' }] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('继续只读检查')
    expect(shell.events.filter(event => event.kind === 'tool.result')).toHaveLength(2)
    const outcomes = outcomesOf(shell.events)
    expect(outcomes.size).toBe(2)
    expect(outcomes.get(`write:${join(stage.dataDir, 'notes', 'reader', 'MEMORY.md')}`)).toBe(true)
    expect(outcomes.get('write:probe.txt')).toBe(false)
    expect(readFileSync(join(stage.dataDir, 'notes', 'reader', 'MEMORY.md'), 'utf8')).toBe('只读要求')
    expect(readFileSync(join(stage.workspace, 'probe.txt'), 'utf8')).toBe('原值')
  } finally { shell.dispose(); app.close(); stage.dispose() }
})
