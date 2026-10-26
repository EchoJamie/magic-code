import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('主动压缩摘要、水位和成功终态同事务，事件写入失败全回滚，重开可查成功', async () => {
  const dataDir = await tempDataDir()
  const store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
  const db = new Database(store.paths.database)
  try {
    const service = store.serviceFor('atomic-compact')
    const entry = service.appendEntry({ kind: 'user', content: { text: '待压缩材料' }, at: 1 })
    service.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: entry })
    const before = service.memory.read()
    const input = { expectedRevision: before.revision, previousSummary: null, content: { text: '完整摘要' }, at: 2,
      coverage: { from: entry, coveredThrough: entry, memoryRevision: before.revision, previousSummary: null, sources: [{ session: 'atomic-compact', entry }] },
      compact: { requestId: 'compact-atomic', focus: '保留最新约束' } }
    db.exec("CREATE TRIGGER reject_compact BEFORE INSERT ON events WHEN NEW.kind='compact.state' BEGIN SELECT RAISE(ABORT,'test event failure'); END")
    expect(() => service.memory.publishSummary(input)).toThrow('test event failure')
    expect(service.memory.read()).toEqual(before)
    expect((await Array.fromAsync(service.readEntries('atomic-compact'))).map(entry => entry.kind)).toEqual(['user'])
    expect(await Array.fromAsync(service.readEvents('atomic-compact'))).toEqual([])
    db.exec('DROP TRIGGER reject_compact')
    const completed = service.memory.publishSummary(input)
    expect(completed.ok).toBe(true)
    const events = await Array.fromAsync(service.readEvents('atomic-compact'))
    expect(events).toHaveLength(1)
    expect(events[0]?.data).toEqual({ ...input.compact, accepted: true, state: 'completed', summary: completed.snapshot.summary! })
    const reopened = createRecordsStore({ dataDir, workspace: ['/isolated'] })
    try {
      expect(reopened.serviceFor('atomic-compact').memory.read()).toEqual(completed.snapshot)
      expect(await Array.fromAsync(reopened.serviceFor('atomic-compact').readEvents('atomic-compact'))).toEqual(events)
    } finally { reopened.close() }
  } finally { db.close(); store.close(); await removeDataDir(dataDir) }
})

test('事项增量、来源、整理位置原子保存，旧修订不覆盖，重新打开仍可读', async () => {
  const dataDir = await tempDataDir()
  let store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
  try {
    const service = store.serviceFor('memory-test')
    const entry = service.appendEntry({ kind: 'user', content: { text: '保留全部要求' }, at: 1 })
    const sources = [{ session: 'memory-test', entry }]
    const first = service.memory.update({ expectedRevision: 0, inspectedThrough: entry, changes: [{ id: 'r1', kind: 'requirement', text: '保留全部要求', evidence: 'fact', status: 'active', sources }] })
    expect(first.ok).toBe(true)
    const conflict = service.memory.update({ expectedRevision: 0, changes: [] })
    expect(conflict.ok).toBe(false)
    expect(conflict.snapshot.items[0]?.text).toBe('保留全部要求')
    const failed = service.memory.update({ expectedRevision: 1, changes: [{ ...first.snapshot.items[0]!, text: '不应写入' }, { id: 'bad', kind: 'fact', text: '失效来源', evidence: 'fact', status: 'active', sources: [{ session: 'other', entry }] }] })
    expect(failed.ok).toBe(false)
    expect(service.memory.read()).toEqual(first.snapshot)
    store.close()
    store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
    expect(store.serviceFor('memory-test').memory.read()).toEqual(first.snapshot)
  } finally { store.close(); await removeDataDir(dataDir) }
})

test('摘要发布校验记忆/前摘要与整理覆盖，失败不推进', async () => {
  const dataDir = await tempDataDir()
  const store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
  try {
    const service = store.serviceFor('summary-test')
    const entry = service.appendEntry({ kind: 'user', content: { text: '要求' }, at: 1 })
    service.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: entry })
    const input = { expectedRevision: 1, previousSummary: null, content: { text: '摘要' }, coverage: { from: entry, coveredThrough: entry, memoryRevision: 1, previousSummary: null, sources: [{ session: 'summary-test', entry }] }, at: 2 }
    const result = service.memory.publishSummary(input)
    expect(result.ok).toBe(true)
    expect(result.snapshot.coveredThrough).toBe(entry)
    expect(service.memory.publishSummary(input).ok).toBe(false)
    expect(service.memory.read()).toEqual(result.snapshot)
  } finally { store.close(); await removeDataDir(dataDir) }
})

test('事项与摘要来源仅接受非负安全整数 offset，拒绝后保持原记录', async () => {
  const dataDir = await tempDataDir()
  const store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
  try {
    const service = store.serviceFor('source-offset')
    const entry = service.appendEntry({ kind: 'user', content: { text: '完整来源正文' }, at: 1 })
    const source = { session: 'source-offset', entry }
    for (const offset of [undefined, 0, 1]) {
      const before = service.memory.read()
      expect(service.memory.update({ expectedRevision: before.revision, inspectedThrough: entry, changes: [
        { id: 'fact', kind: 'fact', text: '来源事实', evidence: 'fact', status: 'active', sources: [{ ...source, ...(offset === undefined ? {} : { offset }) }] },
      ] }).ok).toBe(true)
    }
    const before = service.memory.read()
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      const sources = [{ ...source, offset }]
      expect(service.memory.update({ expectedRevision: before.revision, changes: [{ ...before.items[0]!, sources }] }).ok).toBe(false)
      expect(service.memory.publishSummary({ expectedRevision: before.revision, previousSummary: null, content: { text: '不得发布' }, at: 2,
        coverage: { from: entry, coveredThrough: entry, memoryRevision: before.revision, previousSummary: null, sources } }).ok).toBe(false)
      expect(service.memory.read()).toEqual(before)
    }
    expect((await Array.fromAsync(service.readEntries('source-offset'))).map(value => value.kind)).toEqual(['user'])
  } finally { store.close(); await removeDataDir(dataDir) }
})
