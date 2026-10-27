import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

test('覆盖与原请求成功终态同事务，事件失败全部回滚，重开只认实际提交', async () => {
  const dataDir = await tempDataDir(), store = createRecordsStore({ dataDir, workspace: ['/isolated'] })
  const db = new Database(store.paths.database)
  try {
    const records = store.serviceFor('work')
    const entry = records.appendEntry({ kind: 'user', content: { text: '真实要求' }, at: 1 })
    const input = { previousSummary: null, from: entry, through: entry, at: 2, notesSaved: true, compact: { requestId: 'request' } }
    db.exec("CREATE TRIGGER reject_compact BEFORE INSERT ON events WHEN NEW.kind='compact.state' BEGIN SELECT RAISE(ABORT,'test event failure'); END")
    expect(() => records.coverage.publish(input)).toThrow('test event failure')
    expect(records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
    expect((await Array.fromAsync(records.readEntries('work'))).map(entry => entry.kind)).toEqual(['user'])
    db.exec('DROP TRIGGER reject_compact')
    const summary = records.coverage.publish(input)
    expect(records.coverage.read()).toEqual({ summary, coveredThrough: entry })
    expect(() => records.coverage.publish(input)).toThrow('依据已改变')
    const reopened = createRecordsStore({ dataDir, workspace: ['/isolated'] })
    try {
      expect(reopened.serviceFor('work').coverage.read()).toEqual({ summary, coveredThrough: entry })
      const events = await Array.fromAsync(reopened.serviceFor('work').readEvents('work'))
      expect(events).toHaveLength(1)
      expect(events[0]?.data).toEqual({ requestId: 'request', accepted: true, state: 'completed', notesSaved: true, summary })
    } finally { reopened.close() }
  } finally { db.close(); store.close(); await removeDataDir(dataDir) }
})

test('旧事项和知识进度数据保持原样，不转换、不删除、不成为当前覆盖真源', async () => {
  const dataDir = await tempDataDir()
  let store = createRecordsStore({ dataDir, workspace: [] })
  const db = new Database(store.paths.database)
  try {
    db.exec("CREATE TABLE working_memory(session TEXT PRIMARY KEY, items TEXT, summary INTEGER, covered_through INTEGER); INSERT INTO working_memory VALUES ('old','用户历史事项',99,88); CREATE TABLE knowledge_progress(session TEXT PRIMARY KEY, items TEXT); INSERT INTO knowledge_progress VALUES ('old','原进度');")
    const records = store.serviceFor('old')
    const entry = records.appendEntry({ kind: 'user', content: { text: '用户原始要求' }, at: 1 })
    records.appendEntry({ kind: 'summary', content: { text: '旧摘要不能代表新笔记已经保存' }, payload: { from: entry, coveredThrough: entry, memoryRevision: 1, previousSummary: null, sources: [] }, at: 2 })
    store.close(); store = createRecordsStore({ dataDir, workspace: [] })
    expect(store.serviceFor('old').coverage.read()).toEqual({ summary: null, coveredThrough: null })
    expect(db.query('SELECT * FROM working_memory').all()).toEqual([{ session: 'old', items: '用户历史事项', summary: 99, covered_through: 88 }])
    expect(db.query('SELECT * FROM knowledge_progress').all()).toEqual([{ session: 'old', items: '原进度' }])
  } finally { db.close(); store.close(); await removeDataDir(dataDir) }
})
