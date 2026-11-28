/** 真配置、记录、工具与对话循环；受控模型验证一次简报、重注与连续压缩接线。 */
import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { realpathSync } from 'node:fs'
import { createRecordsStore } from '@magic/data'
import { createMaterialReader } from '@magic/conversation'
import { createFauxGateway } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase } from './support.ts'

const textOf = (request: ModelRequest) => request.messages.map(message => message.role === 'tool' ? message.output : message.content).join('\n')

test('39KB协作正文与27未决点经过真实工作循环：一次简报、重注、连续两次压缩', async () => {
  const stage = makeStage()
  const seeded = createRecordsStore({ dataDir: stage.dataDir, workspace: [realpathSync(stage.workspace)] })
  const origin = { sessionId: 'origin', entryId: seeded.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '始终只读检查，禁止写入' }, at: 1 }) }
  const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'cantrip' as const, provider: 'test', model: 'test' }
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

  const brief = `## 目标与阶段\n始终只读检查，禁止写入\n## 未决问题与分歧\n${questions.join('\n')}\n## 下一步\n继续`
  const main: ModelRequest[] = [], preparations: ModelRequest[] = []
  let app!: Assembly, replies = 0
  app = stage.assemble({ session: 'origin', context: { compactAtTokens: 100, nearTokens: 0 }, modelGateway: stamper => ({ stream(request, options) {
    const last = request.messages.at(-1)
    const auxiliary = last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('【系统交接整理指令')
    if (auxiliary) {
      preparations.push(request)
      return createFauxGateway({ stamper, turns: [{ text: brief }] }).stream(request, options)
    }
    main.push(request)
    return createFauxGateway({ stamper, turns: [{ text: `答复 ${++replies}`, usage: { inputTokens: replies >= 6 ? 400 : 10, outputTokens: 5 } }] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    for (const input of ['始终只读检查，禁止写入', '第二件事', '第三件事', '第四件事', '第五件事', '第六件事', '第七件事', '第八件事']) await shell.submit(input)
    expect(replies).toBe(8)
    expect(textOf(main[0]!)).toContain(body)
    expect(textOf(main.at(-1)!)).toContain('第八件事')

    // 一次压缩走同前缀内联请求（保留 tools 命中缓存，且不会执行工具）。
    expect(preparations.length).toBeGreaterThanOrEqual(2)
    for (const request of preparations) expect(request.tools?.length).toBeGreaterThan(0)
    expect(preparations.some(request => textOf(request).includes('未决点 27'))).toBe(true)

    // 下一次主请求的第一句用户消息就是交接材料；原文仍可回查。
    expect(main.some(request => request.messages.some(message => message.role === 'user'
      && typeof message.content === 'string' && message.content.includes('## 目标与阶段\n始终只读检查')))).toBe(true)
    const reader = createMaterialReader({ records: app.records.serviceFor('origin'), session: 'origin' })
    let restored = ''; let offset = 0
    for (;;) { const page = await reader({ ...source, offset, limit: 8000 }); restored += page.text; if (page.next === undefined) break; offset = page.next }
    expect(restored).toContain(body)

    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    expect(eventsOfKind(shell.events, 'context.compacted')).toHaveLength(2)
    expect(eventsOfKind(shell.events, 'memory.model').every(event => event.data.purpose === 'compact')).toBe(true)
    const db = readDatabase(app.paths.database)
    try {
      expect(db.entries.filter(entry => entry.kind === 'summary')).toHaveLength(2)
      // 交接材料原子保存在 summary 条目中，不再伪装 user 条目。
      expect(db.entries.filter(entry => entry.kind === 'summary' && entry.content_text?.includes('未决点 27')).length).toBeGreaterThan(0)
      // 只有真实的用户交代（1 预置 + 8 轮提交），不再混入假 handoff 用户条目
      expect(db.entries.filter(entry => entry.kind === 'user')).toHaveLength(9)
      expect(app.records.serviceFor(app.session!).coverage.read().summary).toBe(db.entries.filter(entry => entry.kind === 'summary').at(-1)!.id)
    } finally { db.close() }
    expect(eventsOfKind(shell.events, 'turn.end').every(event => event.data.reason === 'settled')).toBe(true)
  } finally { shell.dispose(); app.close(); stage.dispose() }
}, 30000)
