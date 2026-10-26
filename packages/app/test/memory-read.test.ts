import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import type { Wire } from '@magic/contracts'
import { createNativeServer } from '../src/run/native-server.ts'
import { readMemory, readMemorySource } from '../src/run/memory.ts'
import { tempDir, removeDir } from './tmp.ts'
import type { Link } from '../src/run/wire.ts'
import { createFauxGateway } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'

test('真实 memory_update 确认全部业务后，内务尾部不显示未整理，后续公开答复仍显示', async () => {
  const stage = makeStage()
  let app!: Assembly
  let observed: ReturnType<typeof readMemory> | undefined
  let calls = 0
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    const records = app.records.serviceFor(app.session!)
    const entry = records.inputs.list().at(-1)!.entry!
    calls += 1
    const stream = createFauxGateway({ stamper, turns: [calls === 1 ? {
      toolCalls: [{ name: 'memory_update', args: { expectedRevision: 0, inspectedThrough: entry, changes: [
        { id: 'requirement', kind: 'requirement', text: '只做检查', evidence: 'fact', status: 'active', sources: [{ session: app.session!, entry }] },
      ] } }],
    } : { text: '检查完成，新增公开结果' }] }).stream(request, options)
    if (calls === 1) return stream
    const snapshot = observed = readMemory(app.records, app.session)
    return { ...stream, events: (async function* () { await snapshot; yield* stream.events })() }
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('只做检查')
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    expect(calls).toBe(2)
    const snapshot = await observed
    expect(snapshot?.memory?.items[0]?.text).toBe('只做检查')
    expect(snapshot?.memory?.inspectedThrough).toBe(app.records.serviceFor(app.session!).inputs.list()[0]!.entry)
    expect(snapshot?.unprocessed).toBe(false)
    expect((await readMemory(app.records, app.session)).unprocessed).toBe(true)
  } finally { shell.dispose(); try { await app.shutdown() } finally { stage.dispose() } }
})

test('检查边界切入内务配对仍无待整理，真正新增正文、业务结果和穿插的协作材料仍待整理', async () => {
  const dir = tempDir('magic-memory-pending-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  try {
    const session = 'pending', records = store.serviceFor(session)
    const origin = records.appendEntry({ kind: 'user', at: 1, content: { text: '检查已有材料' } })
    const inspect = (through: number) => {
      expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [], inspectedThrough: through }).ok).toBe(true)
    }
    let through = origin
    for (const name of ['memory_read', 'memory_update', 'source_read']) {
      const anchor = records.appendEntry({ kind: 'assistant', at: 2, content: { text: '' } })
      const call = records.appendEntry({ kind: 'tool-call', at: 3, content: { text: '' }, payload: { name, args: {} } })
      const result = records.appendEntry({ kind: 'tool-result', at: 4, content: { text: '{}' }, payload: { ok: true, output: { text: '{}' } } })
      for (const boundary of [through, anchor, call, result]) {
        inspect(boundary)
        expect((await readMemory(store, session)).unprocessed).toBe(false)
      }
      through = result
    }
    for (const kind of ['user', 'assistant'] as const) {
      const entry = records.appendEntry({ kind, at: 5, content: { text: '新的业务正文' } })
      expect((await readMemory(store, session)).unprocessed).toBe(true)
      inspect(entry)
      expect((await readMemory(store, session)).unprocessed).toBe(false)
    }
    const businessCall = records.appendEntry({ kind: 'tool-call', at: 6, content: { text: '' }, payload: { name: 'exec', args: { cmd: 'fixture-only' } } })
    inspect(businessCall)
    const businessResult = records.appendEntry({ kind: 'tool-result', at: 7, content: { text: '新的检查结果' }, payload: { ok: true, output: { text: '新的检查结果' } } })
    expect((await readMemory(store, session)).unprocessed).toBe(true)
    inspect(businessResult)
    expect((await readMemory(store, session)).unprocessed).toBe(false)

    const collaboration = store.collaboration
    const agent = collaboration.registerAgent({ operationId: 'identity', sessionId: session, name: '检查者', role: '', at: 8,
      model: { protocol: 'chat-completions', endpoint: 'https://models.example/v1', choice: 'default', provider: 'test', model: 'test' } })
    collaboration.openCollaboration(agent.agentId, { operationId: 'open', origin: { sessionId: session, entryId: origin }, at: 9 })
    records.appendEntry({ kind: 'assistant', at: 10, content: { text: '' } })
    const internalCall = records.appendEntry({ kind: 'tool-call', at: 11, content: { text: '' }, payload: { name: 'memory_read', args: {} } })
    inspect(internalCall)
    collaboration.send(agent.agentId, { operationId: 'report', recipients: [agent.agentId], purpose: 'inform', body: [{ kind: 'text', text: '新的协作检查结果' }], at: 12 })
    collaboration.consumeInbox(agent.agentId, 13)
    const message = (await Array.fromAsync(records.readEntries(session))).findLast(entry => entry.kind === 'agent-message')!
    expect(message).toBeDefined()
    records.appendEntry({ kind: 'tool-result', at: 14, content: { text: '{}' }, payload: { ok: true, output: { text: '{}' } } })
    expect((await readMemory(store, session)).unprocessed).toBe(true)
    inspect(message.id)
    expect((await readMemory(store, session)).unprocessed).toBe(false)
  } finally { store.close(); removeDir(dir) }
})

test('原生真实记忆读面与来源分页不创建会话或触发执行，归档仍可读，来源权限不扩大', async () => {
  const dir = tempDir('magic-memory-native-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const sent: Wire[] = []
  const link = { closed: false, send: (value: Wire) => { sent.push(value); return true }, onClose() {}, close() {} } as unknown as Link
  let execution = 0
  const identity = { protocol: 1, version: 'test', source: 'test', base: dir, serviceInstance: 'engine' }
  const server = createNativeServer({ identity, store, accepting: () => true, inspect: async () => undefined, works: async () => [], sessions: async () => [], manage: item => ({ ...item, ok: false }), stop: () => { execution++ } })
  const receive = async (message: Wire) => {
    server.receive(link, message)
    for (let n = 0; n < 20; n++) {
      await new Promise(resolve => setTimeout(resolve, 1))
      const result = sent.findLast(one => one.t === 'native.memory.result' && 'request' in message && one.request === message.request)
      if (result?.t === 'native.memory.result') return result
    }
    throw new Error('未取得原生读取回执')
  }
  try {
    const records = store.serviceFor('session')
    const entry = records.appendEntry({ kind: 'user', content: { text: '原文材料需要分页读取' }, at: 1 })
    const other = records.appendEntry({ kind: 'assistant', content: { text: '没有授权的另一条材料' }, at: 2 })
    expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'fact', kind: 'fact', text: '有来源的事项', evidence: 'fact', status: 'active', sources: [{ session: 'session', entry }] }], inspectedThrough: entry }).ok).toBe(true)
    store.setSessionArchived('session', true)
    server.receive(link, { t: 'hello', role: 'observer', ...identity })
    const before = await store.listSessions()
    const result = await receive({ t: 'native.memory', request: 'read', session: 'session' })
    expect(result.memory?.items[0]?.id).toBe('fact')
    expect(result.unprocessed).toBe(true)
    const first = await receive({ t: 'native.memory.source', request: 'source', session: 'session', item: 'fact', source: { session: 'session', entry }, limit: 4 })
    expect(first.material?.text).toBe('原文材料')
    const next = await receive({ t: 'native.memory.source', request: 'next', session: 'session', item: 'fact', source: { session: 'session', entry, offset: first.material?.next } })
    expect(first.material!.text + next.material!.text).toBe('原文材料需要分页读取')
    const denied = await receive({ t: 'native.memory.source', request: 'denied', session: 'session', item: 'fact', source: { session: 'session', entry: other } })
    expect(denied.error).toContain('范围')
    expect(execution).toBe(0)
    expect((await store.listSessions()).map(one => one.id)).toEqual(before.map(one => one.id))
    await expect(readMemorySource(store, { session: 'session', source: { session: 'session', entry } })).rejects.toThrow('明确')
  } finally { server.close(); store.close(); removeDir(dir) }
})

test('无会话阅读不建立会话，缺失会话明确报错', async () => {
  const dir = tempDir('magic-memory-empty-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  try {
    expect(await readMemory(store, undefined, [dir])).toEqual({ workspace: [dir] })
    await expect(readMemory(store, 'missing')).rejects.toThrow('不可读取')
    expect(await store.listSessions()).toHaveLength(0)
  } finally { store.close(); removeDir(dir) }
})

test('已受理引用的读面目录与模型来源读取都保留原范围，后来追加不能进入', async () => {
  const { createMemoryAccess } = await import('@magic/conversation')
  const dir = tempDir('magic-memory-reference-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  try {
    const records = store.serviceFor('target'), origin = store.serviceFor('origin')
    const entry = origin.appendEntry({ kind: 'user', at: 1, content: { text: '原要求' } })
    const input = records.inputs.accept({ ref: 'fixed', text: '引用@历史', refs: [{ kind: 'session', source: 'origin', through: entry, at: 2, marker: '@历史' }] }, 2)
    records.inputs.consume(input.ref, input.revision, { kind: 'user', at: 3, content: { text: input.input.text } })
    const later = origin.appendEntry({ kind: 'assistant', at: 4, content: { text: '后来的内容' } })
    const result = await readMemory(store, 'target')
    expect(result.references).toEqual([{ inputRef: 'fixed', title: '@历史', source: 'origin', through: entry, sources: [{ session: 'origin', entry }] }])
    const reader = createMemoryAccess({ records, session: 'target' })
    expect((await reader.source({ session: 'origin', entry })).text).toBe('原要求')
    expect((await readMemorySource(store, { session: 'target', inputRef: 'fixed', source: { session: 'origin', entry } })).text).toBe('原要求')
    await expect(reader.source({ session: 'origin', entry: later })).rejects.toThrow('范围')
    await expect(readMemorySource(store, { session: 'target', inputRef: 'fixed', source: { session: 'origin', entry: later } })).rejects.toThrow('范围')
  } finally { store.close(); removeDir(dir) }
})
