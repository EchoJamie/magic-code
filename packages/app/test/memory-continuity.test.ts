import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { createConversationSession, type ConversationSession } from '@magic/conversation'
import { createStamper } from '../src/agent-assembly/events.ts'
import { tempDir, removeDir } from './tmp.ts'
import { requestFromStoredSession } from './conversation-request.ts'
import { createFauxGateway, makeFauxSink, makeFauxToolRuntime } from '@magic/faux'
import type { ModelGateway, ModelRequest } from '@magic/contracts'

const textOf = (request: ModelRequest) => request.messages.map(message => message.role === 'tool' ? message.output : message.content).join('\n')

for (const mode of ['append', 'correct', 'cancel', 'failure'] as const) test(`摘要生成期间 ${mode}：冻结覆盖、修订检查与取消保护`, async () => {
  const dir = tempDir('memory-continuity-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  let service: ConversationSession | undefined
  let finish = () => {}
  try {
    const records = store.serviceFor('origin')
    const origin = records.appendEntry({ kind: 'user', content: { text: '原工作要求' }, at: 1 })
    const old = records.appendEntry({ kind: 'assistant', content: { text: '原阶段结果' }, at: 20 })
    records.appendEntry({ kind: 'user', content: { text: '保留当前交互' }, at: 21 })
    records.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: old })
    const original = records.memory.read()
    const stamper = createStamper({ records, session: 'origin', now: Date.now }); const sink = makeFauxSink()
    const abort = new AbortController()
    let start!: () => void
    const started = new Promise<void>(resolve => { start = resolve })
    const released = new Promise<void>(resolve => { finish = resolve })
    const base = createFauxGateway({ stamper, turns: mode === 'failure'
      ? [{ error: { tier: 'terminal', message: '受控摘要失败' } }]
      : [{ text: '旧阶段摘要' }] })
    const gateway: ModelGateway = { stream(request, options) {
      const stream = base.stream(request, options)
      return { result: stream.result, events: (async function* () { start(); await released; yield* stream.events })() }
    } }
    service = createConversationSession({ records, session: 'origin', compression: () => ({ gateway }), sink, stamper,
      gateway: createFauxGateway({ stamper, turns: [] }), tools: makeFauxToolRuntime(),
      prompt: { cwd: dir, platform: 'darwin', date: '2026-10-26' },
      now: () => 30, context: { blobThreshold: 1000, blobTextLimit: 10, nearEntries: 1, compactAtFraction: 0.8, compactAtTokens: 1000 } })
    const running = service.compact({ requestId: `concurrent-${mode}` }, abort.signal, () => {})
    await started
    let added: number | undefined
    if (mode === 'append') added = records.appendEntry({ kind: 'user', content: { text: '生成期间的新交代原样保留' }, at: 25 })
    if (mode === 'correct') records.memory.update({ expectedRevision: original.revision, changes: [{ id: 'correction', kind: 'requirement', text: '新的有效纠正', evidence: 'fact', status: 'active', sources: [{ session: 'origin', entry: origin }] }] })
    if (mode === 'cancel') abort.abort()
    finish()
    const outcome = await running
    expect(outcome.state).toBe(mode === 'append' ? 'completed' : mode === 'cancel' ? 'cancelled' : 'failed')
    if (mode === 'append') {
      expect(records.memory.read().coveredThrough).toBe(old)
      expect(added).toBeGreaterThan(old)
      const request = await requestFromStoredSession({ records, session: 'origin', cwd: dir, text: '继续核对新交代' })
      expect(textOf(request)).toContain('生成期间的新交代原样保留')
    } else {
      expect(records.memory.read().summary).toBe(original.summary)
      expect(records.memory.read().coveredThrough).toBe(original.coveredThrough)
      expect(sink.byKind('context.compacted')).toHaveLength(0)
    }
  } finally { finish(); await service?.shutdown(); store.close(); removeDir(dir) }
})
