import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { defineMemoryTools } from '@magic/tools'
import { createMemoryAccess, createConversationSession } from '@magic/conversation'
import { createShell } from '@magic/tui'
import { createStamper } from '../src/agent-assembly/events.ts'
import { createFauxGateway, makeFauxToolRuntime, makeFauxSink } from '@magic/faux'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { requestFromStoredSession } from './conversation-request.ts'
import type { Entry, KernelEvent, MemorySnapshot, ModelGateway } from '@magic/contracts'

function fixture(operations: boolean | 'housekeeping' = false) {
  const dataDir = mkdtempSync(join(tmpdir(), 'organize-memory-'))
  const store = createRecordsStore({ dataDir, workspace: [dataDir] })
  const records = store.serviceFor('organize')
  let through = records.appendEntry({ kind: 'user', content: { text: '必须保留精确值 2718，并核对输出' }, at: 1 })
  let operation: number | undefined
  if (operations === true) {
    records.appendEntry({ kind: 'assistant', content: { text: '核对操作结果' }, payload: { reasoning: '私有思考不得进入整理' }, at: 1 })
    operation = records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { name: 'exec', args: { cmd: 'printf operation-2718', cwd: dataDir } }, at: 1 })
    through = records.appendEntry({ kind: 'tool-result', content: { text: 'operation-2718' }, payload: { ok: true, output: { text: 'operation-2718' } }, at: 1 })
  } else if (operations === 'housekeeping') {
    records.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: through })
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: 1 })
    records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { name: 'memory_read', args: {} }, at: 1 })
    through = records.appendEntry({ kind: 'tool-result', content: { text: '{}' }, payload: { ok: true, output: { text: '{}' } }, at: 1 })
  }
  const tools = defineMemoryTools(createMemoryAccess({ records, session: 'organize' })).map(tool => tool.spec)
  records.appendEntry({ kind: 'user', content: { text: '当前近段原文保留' }, at: 2 })
  const stamper = createStamper({ records, session: 'organize', now: Date.now })
  const sink = makeFauxSink()
  let listener: ((event: KernelEvent) => void) | undefined
  const shell = createShell({ send() {}, subscribe(next) { listener = next; return () => { listener = undefined } } }, { magicBase: dataDir, inputReady: true })
  const publish = sink.emit
  sink.emit = event => { publish(event); listener?.(event) }
  sink.emit(stamper.stamp('session.state', { active: 'organize', sessions: [{ id: 'organize', at: 1, archived: false }] }))
  let beforeSummary: MemorySnapshot | undefined
  const cantrip = createFauxGateway({ stamper, turns: [{ text: '精确要求已转入工作记忆' }] })
  return { dataDir, store, records, through, operation, tools, stamper, sink, cantrip, shell, get beforeSummary() { return beforeSummary },
    async run(gateway: ModelGateway, signal = new AbortController().signal) {
      const service = createConversationSession({ records, session: 'organize', gateway, knowledge: store.knowledge,
        tools: makeFauxToolRuntime({ definitions: tools }), sink, stamper,
        prompt: { cwd: dataDir, platform: 'darwin', date: '2026-10-26' }, context: { nearEntries: 1 },
        compression: () => ({ gateway: { stream(request, options) {
          beforeSummary = records.memory.read()
          return cantrip.stream(request, options)
        } } }),
      })
      try { return await service.compact({ requestId: 'organize-before-compact' }, signal, () => {}) }
      finally { await service.shutdown() }
    }, close() { shell.dispose(); store.close(); rmSync(dataDir, { recursive: true, force: true }) },
  }
}

test('受限整理先读记忆和精确来源，再提交冻结范围；业务工具不开放', async () => {
  const f = fixture()
  try {
    const gateway = createFauxGateway({ stamper: f.stamper, turns: [
      { toolCalls: [{ name: 'memory_read' }] },
      { toolCalls: [{ name: 'source_read', args: { session: 'organize', entry: f.through, offset: 0, limit: 100 } }] },
      { toolCalls: [{ name: 'memory_update', args: { expectedRevision: 0, inspectedThrough: f.through, changes: [
        { id: 'value', kind: 'requirement', text: '必须保留精确值 2718', evidence: 'fact', status: 'active', sources: [{ session: 'organize', entry: f.through }] },
      ] } }] },
    ] })
    expect((await f.run(gateway)).state).toBe('completed')
    expect(gateway.requests).toHaveLength(3)
    expect(f.sink.byKind('memory.model').filter(event => event.data.purpose === 'organize')).toHaveLength(3)
    expect(f.cantrip.requests).toHaveLength(1)
    expect(f.sink.byKind('model.usage')).toHaveLength(0)
    expect(f.sink.byKind('model.delta')).toHaveLength(0)
    for (const request of gateway.requests) expect(request.tools?.map(tool => tool.name)).toEqual(['memory_read', 'memory_update', 'source_read'])
    expect(JSON.stringify(gateway.requests[2])).toContain('必须保留精确值 2718')
    expect(f.beforeSummary).toMatchObject({ revision: 1, inspectedThrough: f.through, coveredThrough: null, items: [{ id: 'value', text: '必须保留精确值 2718' }] })
    const entries: Entry[] = []
    for await (const entry of f.records.readEntries('organize')) entries.push(entry)
    expect(entries.filter(entry => entry.kind === 'tool-call')).toHaveLength(3)
    expect(entries.filter(entry => entry.kind === 'tool-result')).toHaveLength(3)
  } finally { f.close() }
})

test('受限整理与摘要取得真实操作名称参数，source_read 保持同一解释', async () => {
  const f = fixture(true)
  try {
    const gateway = createFauxGateway({ stamper: f.stamper, turns: [
      { toolCalls: [{ name: 'source_read', args: { session: 'organize', entry: f.operation, limit: 8000 } }] },
      { toolCalls: [{ name: 'memory_update', args: { expectedRevision: 0, inspectedThrough: f.through, changes: [] } }] },
    ] })
    expect((await f.run(gateway)).state).toBe('completed')
    const first = gateway.requests[0]!.messages.map(message => 'content' in message ? message.content : message.output).join('\n')
    expect(first).toContain(`organize#${f.operation} · tool-call`)
    expect(first).toContain('exec {"cmd":"printf operation-2718","cwd":')
    expect(first).not.toContain('私有思考不得进入整理')
    const source = gateway.requests[1]!.messages.find(message => message.role === 'tool')!
    expect(source.role).toBe('tool')
    if (source.role !== 'tool') throw new Error('未返回来源')
    expect(JSON.parse(source.output)).toMatchObject({ speaker: 'tool-call', kind: 'tool-call', complete: true })
    expect(first).toContain(JSON.parse(source.output).text)
    const summary = f.cantrip.requests[0]!.messages.map(message => 'content' in message ? message.content : message.output).join('\n')
    expect(summary).toContain(JSON.parse(source.output).text)
    expect(summary).not.toContain('私有思考不得进入整理')
  } finally { f.close() }
})

for (const change of [true, false]) test(`真实压缩整理成功同步 shell 计划与修订：事项变化=${change}`, async () => {
  const f = fixture()
  try {
    const gateway = createFauxGateway({ stamper: f.stamper, turns: [{ toolCalls: [{ name: 'memory_update', args: {
      expectedRevision: 0, inspectedThrough: f.through, changes: change ? [
        { id: 'goal', kind: 'goal', text: '核对精确输出', evidence: 'fact', status: 'active', sources: [{ session: 'organize', entry: f.through }] },
        { id: 'step', kind: 'step', text: '检查值 2718', progress: 'in_progress', order: 0, evidence: 'fact', status: 'active', sources: [{ session: 'organize', entry: f.through }] },
      ] : [],
    } }] }] })
    expect((await f.run(gateway)).state).toBe('completed')
    const events = f.sink.byKind('plan.changed')
    expect(events).toHaveLength(1)
    expect(events[0]!.data.revision).toBe(f.records.memory.read().revision)
    expect(f.shell.getView().plan.revision).toBe(f.records.memory.read().revision)
    expect(f.shell.getView().plan.plan).toEqual(change ? { goal: '核对精确输出', steps: [{ text: '检查值 2718', status: 'in_progress' }], notes: '' } : null)
    const entries: Entry[] = []
    for await (const entry of f.records.readEntries('organize')) entries.push(entry)
    expect(entries.find(entry => entry.id === events[0]!.data.entry)).toMatchObject({ kind: 'tool-result', payload: { ok: true } })
  } finally { f.close() }
})

test('未整理范围仅有内务工具时不调用整理模型，成功推进位置同步 shell 修订', async () => {
  const f = fixture('housekeeping')
  try {
    const gateway = createFauxGateway({ stamper: f.stamper, turns: [] })
    expect((await f.run(gateway)).state).toBe('completed')
    expect(gateway.requests).toHaveLength(0)
    expect(f.records.memory.read()).toMatchObject({ revision: 2, inspectedThrough: f.through })
    expect(f.sink.byKind('plan.changed')).toHaveLength(1)
    expect(f.shell.getView().plan).toMatchObject({ revision: 2, plan: null, entry: f.through })
  } finally { f.close() }
})

for (const mode of ['cancel', 'source-error', 'model-error', 'update-error'] as const) test(`受限整理 ${mode} 不推进整理位置或摘要覆盖`, async () => {
  const f = fixture()
  try {
    const abort = new AbortController()
    const base = createFauxGateway({ stamper: f.stamper, turns: mode === 'source-error'
      ? [{ toolCalls: [{ name: 'source_read', args: { session: 'organize', entry: f.through + 1 } }] }]
      : mode === 'model-error' ? [{ error: { tier: 'terminal', message: '受控故障' } }]
      : mode === 'update-error' ? [{ toolCalls: [{ name: 'memory_update', args: { expectedRevision: 0, inspectedThrough: f.through, changes: [
        { id: 'invalid', kind: 'goal', text: '缺少有效来源', evidence: 'fact', status: 'active', sources: [] },
      ] } }] }]
      : [{ toolCalls: [{ name: 'source_read', args: { session: 'organize', entry: f.through } }] }] })
    let calls = 0
    const gateway: ModelGateway = { stream(request, options) {
      calls += 1
      if (mode === 'cancel' && calls === 2) abort.abort()
      return base.stream(request, options)
    } }
    expect((await f.run(gateway, abort.signal)).state).toBe(mode === 'cancel' ? 'cancelled' : 'failed')
    expect(f.cantrip.requests).toHaveLength(0)
    expect(f.sink.byKind('plan.changed')).toHaveLength(0)
    expect(f.records.memory.read()).toMatchObject({ revision: 0, inspectedThrough: null, summary: null, coveredThrough: null, items: [] })
  } finally { f.close() }
})

for (const bound of ['reference', 'evidence'] as const) test(`受限整理复用冻结的${bound}来源，合法跨会话读取可完成压缩`, async () => {
  const f = fixture()
  try {
    const external = f.store.serviceFor('external')
    const entry = external.appendEntry({ kind: 'user', content: { text: '获准读取的具体证据' }, at: 1 })
    const source = { session: 'external', entry }
    if (bound === 'reference') {
      const accepted = f.records.inputs.accept({ ref: 'reference-before', text: '@证据', refs: [{ kind: 'session', source: 'external', through: entry, marker: '@证据', at: 0 }] }, 2)
      f.records.inputs.consume(accepted.ref, accepted.revision, { kind: 'user', content: { text: '@证据' }, at: 2 })
    } else {
      expect(f.store.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: [f.dataDir] }, topic: '证据', terms: [], conclusion: '依据', conditions: '本次', evidence: 'fact', status: 'active', sources: [source], dependencies: [] }]).ok).toBe(true)
      expect(f.records.memory.update({ expectedRevision: 0, changes: [{ id: 'known', kind: 'question', text: '核对证据', evidence: 'unresolved', status: 'active', sources: [source], knowledge: [{ id: 'K', revision: 1 }] }] }).ok).toBe(true)
    }
    // 保留最近一条，冻结范围包含此前已受理的引用。
    f.records.appendEntry({ kind: 'user', content: { text: '当前工作' }, at: 3 })
    let read = false
    const gateway: ModelGateway = { stream(request, options) {
      const text = JSON.stringify(request.messages)
      const frozen = text.match(/冻结上界：(\d+)；预期修订：(\d+)/)!
      const turn = !read ? { toolCalls: [{ name: 'source_read', args: source }] }
        : { toolCalls: [{ name: 'memory_update', args: { expectedRevision: Number(frozen[2]), inspectedThrough: Number(frozen[1]), changes: [] } }] }
      read = true
      return createFauxGateway({ stamper: f.stamper, turns: [turn] }).stream(request, options)
    } }
    expect((await f.run(gateway)).state).toBe('completed')
    const results = (await Array.fromAsync(f.records.readEntries('organize'))).filter(entry => entry.kind === 'tool-result')
    expect(results[0]?.payload).toMatchObject({ ok: true })
    expect(JSON.stringify(results[0])).toContain('获准读取的具体证据')
  } finally { f.close() }
})

for (const timing of ['before', 'during', 'beyond-reference', 'unrelated'] as const) test(`整理冻结引用集合：近段引用 ${timing}`, async () => {
  const f = fixture()
  try {
    const external = f.store.serviceFor('external')
    const entry = external.appendEntry({ kind: 'user', content: { text: '冻结引用内原文' }, at: 1 })
    const later = external.appendEntry({ kind: 'user', content: { text: '引用自身上界以外原文' }, at: 2 })
    const accept = () => {
      const row = f.records.inputs.accept({ ref: 'near-reference', text: '@近段引用', refs: [{ kind: 'session', source: 'external', through: entry, marker: '@近段引用', at: 0 }] }, 3)
      f.records.inputs.consume(row.ref, row.revision, { kind: 'user', content: { text: '@近段引用' }, at: 3 })
    }
    if (timing !== 'during' && timing !== 'unrelated') accept()
    let calls = 0
    let frozenThrough = 0
    const gateway: ModelGateway = { stream(request, options) {
      const frozen = JSON.stringify(request.messages).match(/冻结上界：(\d+)；预期修订：(\d+)/)!
      frozenThrough = Number(frozen[1])
      if (++calls === 1 && timing === 'during') accept()
      const turn = calls === 1 ? { toolCalls: [{ name: 'source_read', args: { session: 'external', entry: timing === 'beyond-reference' ? later : entry } }] }
        : { toolCalls: [{ name: 'memory_update', args: { expectedRevision: Number(frozen[2]), inspectedThrough: frozenThrough, changes: [] } }] }
      return createFauxGateway({ stamper: f.stamper, turns: [turn] }).stream(request, options)
    } }
    const result = await f.run(gateway)
    if (timing !== 'unrelated') expect(f.records.inputs.get('near-reference')!.entry!).toBeGreaterThan(frozenThrough)
    expect(result.state).toBe(timing === 'before' ? 'completed' : 'failed')
    expect(f.cantrip.requests).toHaveLength(timing === 'before' ? 1 : 0)
  } finally { f.close() }
})

test('受限整理的记忆读写和来源结果均保存实际修订，遗忘阻断来源再提炼及摘要重放', async () => {
  const f = fixture()
  try {
    const source = { session: 'organize', entry: f.through }
    expect(f.store.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: [f.dataDir] }, topic: '知识', terms: [], conclusion: '旧知识', conditions: '之前', evidence: 'fact', status: 'active', sources: [source], dependencies: [] }]).ok).toBe(true)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [
      { id: 'old', kind: 'fact', text: '内务返回中的独有旧认识', evidence: 'fact', status: 'active', sources: [source], knowledge: [{ id: 'K', revision: 1 }] },
      { id: 'requirement', kind: 'requirement', text: '用户要求继续保留', evidence: 'fact', status: 'active', sources: [source] },
      { id: 'independent', kind: 'question', text: '另一独立事项', evidence: 'unresolved', status: 'active', sources: [source] },
    ] }).ok).toBe(true)
    const original = f.records.appendEntry({ kind: 'assistant', content: { text: '内务返回中的独有旧认识' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 2 })
    f.records.appendEntry({ kind: 'user', content: { text: '保持近段' }, at: 3 })
    let calls = 0
    const gateway: ModelGateway = { stream(request, options) {
      const frozen = JSON.stringify(request.messages).match(/冻结上界：(\d+)；预期修订：(\d+)/)!
      const call = ++calls === 1 ? { name: 'memory_read', args: {} }
        : calls === 2 ? { name: 'source_read', args: { session: 'organize', entry: original } }
        : { name: 'memory_update', args: { expectedRevision: Number(frozen[2]), inspectedThrough: Number(frozen[1]), changes: [] } }
      return createFauxGateway({ stamper: f.stamper, turns: [{ toolCalls: [call] }] }).stream(request, options)
    } }
    expect((await f.run(gateway)).state).toBe('completed')
    const entries = await Array.fromAsync(f.records.readEntries('organize'))
    const outputs = entries.filter(entry => entry.kind === 'tool-result')
    expect(outputs).toHaveLength(3)
    for (const output of outputs) expect(output.payload).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })
    expect(entries.find(entry => entry.kind === 'summary')?.payload).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })
    expect(f.store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget-organized' }).status).toBe('completed')
    expect(f.records.memory.read().summary).toBeNull()
    for (const output of outputs) {
      expect(await createMemoryAccess({ records: f.records, session: 'organize' }).source({ session: 'organize', entry: output.id })).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })
      expect(f.records.memory.update({ expectedRevision: f.records.memory.read().revision, changes: [{ id: 'revived', kind: 'fact', text: '不能重新提炼', evidence: 'fact', status: 'active', sources: [{ session: 'organize', entry: output.id }] }] }).ok).toBe(false)
    }
    const request = await requestFromStoredSession({ records: f.records, session: 'organize', cwd: f.dataDir, knowledge: f.store.knowledge, text: '继续核对' })
    expect(JSON.stringify(request.messages)).not.toContain('内务返回中的独有旧认识')
    expect(JSON.stringify(request.messages)).toContain('用户要求继续保留')
    expect(JSON.stringify(request.messages)).toContain('另一独立事项')
  } finally { f.close() }
})
