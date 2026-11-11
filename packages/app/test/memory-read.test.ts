import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { createWorkingNotes } from '@magic/execution'
import { createMaterialReader } from '@magic/conversation'
import type { Wire } from '@magic/contracts'
import { createNativeServer } from '@magic/host'
import { readMemory, readMemorySource } from '@magic/host'
import { tempDir, removeDir } from './tmp.ts'
import type { Link } from '@magic/host'

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
    const other = store.serviceFor('other').appendEntry({ kind: 'assistant', content: { text: '没有授权的另一条材料' }, at: 2 })
    const notes = createWorkingNotes(dir, 'session'), path = join(notes.directory, 'MEMORY.md')
    await notes.bindTarget(notes.resolve(path)!, 'write').sandbox.write(path, { text: `[来源](session#${entry})` })
    store.setSessionArchived('session', true)
    server.receive(link, { t: 'hello', role: 'observer', ...identity })
    const before = await store.listSessions()
    const result = await receive({ t: 'native.memory', request: 'read', session: 'session' })
    expect(result.notes?.page?.path).toBe('MEMORY.md')
    const first = await receive({ t: 'native.memory.source', request: 'source', session: 'session', path: 'MEMORY.md', source: { session: 'session', entry }, limit: 4 })
    expect(first.material?.text).toBe('原文材料')
    const next = await receive({ t: 'native.memory.source', request: 'next', session: 'session', path: 'MEMORY.md', source: { session: 'session', entry, offset: first.material?.next } })
    expect(first.material!.text + next.material!.text).toBe('原文材料需要分页读取')
    const denied = await receive({ t: 'native.memory.source', request: 'denied', session: 'session', path: 'MEMORY.md', source: { session: 'other', entry: other } })
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
    const reader = createMaterialReader({ records, session: 'target', references: [{ kind: 'session', source: 'origin', through: entry, at: 2, marker: '@历史' }] })
    expect((await reader({ session: 'origin', entry })).text).toBe('原要求')
    expect((await readMemorySource(store, { session: 'target', inputRef: 'fixed', source: { session: 'origin', entry } })).text).toBe('原要求')
    await expect(reader({ session: 'origin', entry: later })).rejects.toThrow('范围')
    await expect(readMemorySource(store, { session: 'target', inputRef: 'fixed', source: { session: 'origin', entry: later } })).rejects.toThrow('范围')
  } finally { store.close(); removeDir(dir) }
})
