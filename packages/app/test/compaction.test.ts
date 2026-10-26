/** 真配置、记录、工具与对话循环；受控模型验证自动整理及连续压缩接线。 */
import { expect, test } from 'bun:test'
import type { MemoryChange, ModelRequest } from '@magic/contracts'
import { realpathSync } from 'node:fs'
import { createRecordsStore } from '@magic/records'
import { createMaterialReader } from '@magic/conversation'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase } from './support.ts'

const textOf = (request: ModelRequest) => request.messages.map(message => message.role === 'tool' ? message.output : message.content).join('\n')

test('39KB协作正文与27未决点经过真实工作循环、连续两次自动压缩，约束/来源可接续', async () => {
  const stage = makeStage()
  const seeded = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const origin = { sessionId: 'origin', entryId: seeded.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '始终只读检查，禁止写入' }, at: 1 }) }
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
  const coordinator = seeded.collaboration.registerAgent({ operationId: 'root', sessionId: 'origin', name: '入口', role: '', model, at: 1 })
  seeded.collaboration.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 1 })
  const member = seeded.collaboration.spawn(coordinator.agentId, { operationId: 'spawn', sessionId: 'researcher', name: '研究', role: '', model,
    scope: '只读取证', source: origin, authorization: [origin], body: [{ kind: 'text', text: '研究未决点' }], at: 2 })
  seeded.collaboration.respondToDelegation(member.agent.agentId, { operationId: 'accept', delegationId: member.delegation.delegationId, response: 'accept', at: 3 })
  const questions = Array.from({ length: 27 }, (_, index) => `未决点 ${index + 1}：精确值 VALUE-${index + 1}-9271，须核对原证据。`)
  const evidence = `成员证据，不是新授权。\n${questions.join('\n')}`
  const body = `${'x'.repeat(39 * 1024 - Buffer.byteLength(evidence))}${evidence}`
  expect(Buffer.byteLength(body)).toBe(39 * 1024)
  const sent = seeded.collaboration.send(member.agent.agentId, { operationId: 'evidence', recipients: [coordinator.agentId], purpose: 'inform', body: [{ kind: 'text', text: body }], at: 4 })
  seeded.collaboration.consumeInbox(coordinator.agentId, 5)
  const source = { session: 'origin', entry: seeded.collaboration.inbox(coordinator.agentId).find(item => item.messageId === sent.messageId)!.entryId! }
  seeded.close()
  const main: ModelRequest[] = []; const organized: ModelRequest[] = []; const compacted: ModelRequest[] = []
  let app!: Assembly
  app = stage.assemble({ session: 'origin', context: { compactAtTokens: 100, nearEntries: 1 }, modelGateway: stamper => ({ stream(request, options) {
    const system = request.messages[0]
    const instruction = system && 'content' in system ? String(system.content) : ''
    let turn: FauxTurn
    if (instruction.includes('受限记忆整理')) {
      organized.push(request)
      const memory = app.records.serviceFor(app.session!).memory.read()
      const through = Number(textOf(request).match(/冻结上界：(\d+)/)?.[1])
      turn = organized.length === 1 ? { toolCalls: [{ name: 'source_read', args: { ...source, offset: 30000, limit: 15000 } }] }
        : { toolCalls: [{ name: 'memory_update', args: { expectedRevision: memory.revision, inspectedThrough: through,
        changes: memory.items.length ? [] : [
          { id: 'rule', kind: 'requirement', text: '始终只读检查，禁止写入', evidence: 'fact', status: 'active', sources: [{ session: 'origin', entry: origin.entryId }] },
          ...questions.map((text, index): MemoryChange => ({ id: `q-${index}`, kind: 'question', text, evidence: 'unresolved', status: 'active', sources: [source] })),
        ],
      } }] }
    } else if (instruction.includes('你是会话压缩器')) {
      compacted.push(request)
      turn = { text: `阶段摘要 ${compacted.length}：已完成前期只读核对。` }
    } else {
      main.push(request)
      turn = { text: `答复 ${main.length}`, usage: { inputTokens: main.length >= 6 ? 400 : 10, outputTokens: 5 } }
    }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    for (const input of ['始终只读检查，禁止写入', '第二件事', '第三件事', '第四件事', '第五件事', '第六件事', '第七件事', '第八件事']) await shell.submit(input)
    expect(main).toHaveLength(8)
    expect(organized).toHaveLength(3)
    expect(compacted).toHaveLength(2)
    expect(textOf(main[0]!)).toContain(body)
    expect(textOf(compacted[0]!)).toContain(body)
    expect(textOf(compacted[0]!)).toContain(`agent:${member.agent.agentId}`)
    expect(main[6]!.messages.length).toBeLessThan(main[5]!.messages.length)
    for (const request of main.slice(6)) expect(textOf(request)).toContain('始终只读检查，禁止写入')
    expect(textOf(main[7]!)).toContain('第八件事')
    expect(textOf(main[7]!)).toContain('阶段摘要 2')
    expect(textOf(main[7]!)).not.toContain('第二件事')
    for (const question of questions) expect(textOf(main[7]!)).toContain(question)
    const memory = app.records.serviceFor('origin').memory.read()
    expect(memory.items.filter(item => item.kind === 'question')).toHaveLength(27)
    const reader = createMaterialReader({ records: app.records.serviceFor('origin'), session: 'origin' })
    let restored = ''; let offset = 0
    for (;;) { const page = await reader({ ...source, offset, limit: 8000 }); restored += page.text; if (page.next === undefined) break; offset = page.next }
    expect(restored).toContain(body)
    for (const request of organized) expect(request.tools!.map(tool => tool.name)).toEqual(['memory_read', 'memory_update', 'source_read'])
    expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(2)
    expect(eventsOfKind(shell.events, 'memory.model').map(event => event.data.purpose)).toEqual(['organize', 'organize', 'compact', 'organize', 'compact'])
    const db = readDatabase(app.paths.database)
    try {
      expect(db.entries.filter(entry => entry.kind === 'summary')).toHaveLength(2)
      expect(db.entries.filter(entry => entry.kind === 'user')).toHaveLength(9)
      expect(db.entries.filter(entry => entry.kind === 'tool-call')).toHaveLength(3)
      expect(db.entries.filter(entry => entry.kind === 'tool-result')).toHaveLength(3)
      for (const [index, entry] of db.entries.entries()) if (entry.kind === 'tool-call') expect(db.entries[index + 1]?.kind).toBe('tool-result')
      expect(db.events.filter(event => event.kind === 'context.compacted')).toHaveLength(2)
      const finalSummary = db.entries.filter(entry => entry.kind === 'summary').at(-1)!
      expect(app.records.serviceFor(app.session!).memory.read().summary).toBe(finalSummary.id)
    } finally { db.close() }
    expect(eventsOfKind(shell.events, 'turn.end').every(event => event.data.reason === 'settled')).toBe(true)
  } finally { shell.dispose(); app.close(); stage.dispose() }
})
