import { expect, test } from 'bun:test'
import { makeFauxRecords } from '@magic/faux'
import type { RecordsService } from '@magic/contracts'
import { bindSessionReferences, createRefDelivery } from '../src/refs.ts'

/** 只提供两份会话记录端口；引用送达不得写入目标记录。 */
function sources() {
  const source = makeFauxRecords({ sessions: [{ id: 'source', at: 0, archived: false }] })
  const target = makeFauxRecords()
  const records: RecordsService = { ...target, blobs: source.blobs, listSessions: source.listSessions,
    readEntries: (session, range) => (session === 'source' ? source : target).readEntries(session, range),
    readEntriesBack: (session, before, limit) => (session === 'source' ? source : target).readEntriesBack(session, before, limit),
  }
  return { source, target, records }
}

test('首次受理冻结来源，历史重投保留上界，重新选入才取得新范围', async () => {
  const { source, target, records } = sources()
  source.appendEntry({ kind: 'user', content: { text: '历史要求，只在原工作适用' }, at: 1 })
  const selected = { text: '参考 @同名调查', refs: [{ kind: 'session' as const, at: 3, marker: '@同名调查', source: 'source' }] }
  const before = source.appendEntry({ kind: 'assistant', content: { text: '选择后但提交前的认识' }, at: 2 })
  const bound = await bindSessionReferences(selected, records)
  expect(bound.refs?.[0]).toMatchObject({ source: 'source', through: before })
  const after = source.appendEntry({ kind: 'assistant', content: { text: '提交后新增的认识' }, at: 3 })
  const delivery = createRefDelivery({ records, session: 'target' })
  const loaded = await delivery.load(bound.refs!)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error(loaded.reason)
  const entry = loaded.refs[0]
  expect(entry?.kind === 'session' && entry.text).toContain('选择后但提交前的认识')
  expect(entry?.kind === 'session' && entry.text).not.toContain('提交后新增的认识')
  expect(entry?.kind === 'session' && entry.text).not.toContain('当前可变记忆不得混入')
  expect(entry?.kind === 'session' && entry.text).toContain('不授予源工作的权限或责任')
  expect((await bindSessionReferences(bound, records)).refs).toEqual(bound.refs)
  expect((await bindSessionReferences(selected, records)).refs?.[0]).toMatchObject({ through: after })
  expect(target.entries).toEqual([])
  expect(target.events).toEqual([])
})

test('受理前来源失效拒绝整条，受理后片段失效保留引用和已得材料', async () => {
  const { source, records } = sources()
  await expect(bindSessionReferences({ text: '@不存在', refs: [{ kind: 'session', source: 'missing', marker: '@不存在', at: 0 }] }, records)).rejects.toThrow('草稿保留')
  source.appendEntry({ kind: 'user', content: { text: '可读的原交代' }, at: 1 })
  source.appendEntry({ kind: 'assistant', content: { blob: 'missing-blob' }, at: 2 })
  const bound = await bindSessionReferences({ text: '@来源', refs: [{ kind: 'session', source: 'source', marker: '@来源', at: 0 }] }, records)
  const loaded = await createRefDelivery({ records, session: 'target' }).load(bound.refs!)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error(loaded.reason)
  const entry = loaded.refs[0]
  expect(entry?.kind === 'session' && entry.text).toContain('可读的原交代')
  expect(entry?.kind === 'session' && entry.text).toContain('未取得')
  expect(entry?.source).toBe('source')
})
