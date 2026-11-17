/** 真配置、记录、工具与对话循环；受控模型验证自动整理及连续压缩接线。 */
import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { realpathSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { continuationTurn, continuationCounts } from './notes-support.ts'
import { createRecordsStore } from '@magic/data'
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
  const main: ModelRequest[] = [], preparations: ModelRequest[] = []
  let app!: Assembly, replies = 0, readCoverage: number | null = null
  app = stage.assemble({ session: 'origin', context: { compactAtTokens: 100, nearEntries: 1 }, modelGateway: stamper => ({ stream(request, options) {
    const system = request.messages[0]
    const auxiliary = system?.role === 'system' && typeof system.content === 'string' && system.content.startsWith('这是当前模型的独立接续准备')
    let turn: FauxTurn
    if (auxiliary) {
      preparations.push(request)
      turn = continuationTurn(request, (text, speaker) => speaker === 'tool-result' ? '已读取笔记与计划，原内容保留' : text.replace(/x/g, ''))
    } else {
      main.push(request)
      const covered = app.records.serviceFor('origin').coverage.read().summary
      if (covered !== null && covered !== readCoverage) {
        readCoverage = covered
        turn = { toolCalls: [{ name: 'read', args: { path: join(stage.dataDir, 'notes', 'origin', 'MEMORY.md') } }, { name: 'plan_read', args: {} }] }
      } else turn = { text: `答复 ${++replies}`, usage: { inputTokens: replies >= 6 ? 400 : 10, outputTokens: 5 } }
    }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    for (const input of ['始终只读检查，禁止写入', '第二件事', '第三件事', '第四件事', '第五件事', '第六件事', '第七件事', '第八件事']) await shell.submit(input)
    expect(replies).toBe(8)
    expect(textOf(main[0]!)).toContain(body)
    expect(preparations.every(request => request.messages[0]?.role === 'system')).toBe(true)
    expect(JSON.stringify(preparations)).toContain(`agent:${member.agent.agentId}`)
    expect(textOf(main.at(-1)!)).toContain('第八件事')
    const note = readFileSync(join(stage.dataDir, 'notes', 'origin', 'MEMORY.md'), 'utf8')
    expect(note).toContain('始终只读检查，禁止写入')
    for (const question of questions) expect(note).toContain(question)
    expect(note).toContain(`origin#${source.entry}`)
    expect(main.at(-1)!.messages.some(message => message.role === 'tool' && message.name === 'read' && message.output.includes('未决点 27'))).toBe(true)
    const reader = createMaterialReader({ records: app.records.serviceFor('origin'), session: 'origin' })
    let restored = ''; let offset = 0
    for (;;) { const page = await reader({ ...source, offset, limit: 8000 }); restored += page.text; if (page.next === undefined) break; offset = page.next }
    expect(restored).toContain(body)
    for (const request of preparations) expect(request.tools!.map(tool => tool.name).sort()).toEqual(['edit', 'glob', 'grep', 'history_read', 'ls', 'plan_read', 'read', 'write'])
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(2)
    expect(eventsOfKind(shell.events, 'memory.model').every(event => event.data.purpose === 'compact')).toBe(true)
    const db = readDatabase(app.paths.database)
    try {
      expect(db.entries.filter(entry => entry.kind === 'summary')).toHaveLength(2)
      expect(db.entries.filter(entry => entry.kind === 'user')).toHaveLength(9)
      for (const [index, entry] of db.entries.entries()) if (entry.kind === 'tool-call') expect(db.entries[index + 1]?.kind).toBe('tool-result')
      expect(db.events.filter(event => event.kind === 'context.compacted')).toHaveLength(2)
      const finalSummary = db.entries.filter(entry => entry.kind === 'summary').at(-1)!
      expect(app.records.serviceFor(app.session!).coverage.read().summary).toBe(finalSummary.id)
    } finally { db.close() }
    const counts = continuationCounts(await Array.fromAsync(app.records.serviceFor('origin').readEntries('origin', { auxiliary: true })), preparations)
    // 这几个数是**这份夹具**的轮数快照：接续按「记录 + 字符区间」切块，所以任何一次
    // 工具回执的**文字长度**变化都会挪动切块边界（`read` 回执改成行范围之后就是如此），
    // 多/少一块就多/少一轮。判据本身是上面那几条（正文、来源、两次压缩、无错误）。
    expect(counts).toEqual({ contexts: 9, requests: 35, saves: 9, coverages: 2 })
    expect(eventsOfKind(shell.events, 'turn.end').every(event => event.data.reason === 'settled')).toBe(true)
  } finally { shell.dispose(); app.close(); stage.dispose() }
}, 30000)
