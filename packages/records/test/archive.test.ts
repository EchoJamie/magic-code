import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore, readSessionSummary } from '../src/index.ts'
import { fixture } from './collaboration-fixture.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

test('归档/恢复持久化且不改内容时间、正文、标题和工作区', async () => {
  const dir = tempDataDir()
  let store = createRecordsStore({ dataDir: dir, workspace: ['/alpha', '/beta'] })
  try {
    const records = store.serviceFor('a')
    records.appendEntry({ kind: 'user', content: { text: '第一条' }, at: 10 })
    records.appendEntry({ kind: 'assistant', content: { text: '最后回复' }, at: 30 })
    store.serviceFor('b').appendEntry({ kind: 'user', content: { text: '另一件' }, at: 20 })
    store.setSessionTitle('a', '修改后的标题', 40)
    const before = await Array.fromAsync(store.readEntries('a'))
    expect((await store.listSessions()).map(row => row.id)).toEqual(['a', 'b'])
    store.setSessionArchived('a', true)
    store.setSessionArchived('a', true)
    expect((await store.listSessions({ archived: false })).map(row => row.id)).toEqual(['b'])
    expect(await store.listSessions({ archived: true, ids: ['a'], workspace: ['/alpha', '/beta'] })).toEqual([
      { id: 'a', at: 30, title: '修改后的标题', workspace: ['/alpha', '/beta'], archived: true },
    ])
    expect(await store.listSessions({ ids: [] })).toEqual([])
    expect(await store.listSessions({ workspace: ['/beta', '/alpha'] })).toEqual([])
    expect(store.latestSession()).toBe('b')
    store.close()
    store = createRecordsStore({ dataDir: dir, workspace: ['/changed'] })
    expect(store.isSessionArchived('a')).toBe(true)
    expect(await Array.fromAsync(store.readEntries('a'))).toEqual(before)
    store.setSessionArchived('a', false)
    expect(store.isSessionArchived('a')).toBe(false)
    expect((await store.listSessions({ ids: ['a'] }))[0]?.at).toBe(30)
    expect(store.latestSession()).toBe('a')
    expect(() => store.setSessionArchived('missing', true)).toThrow('会话不存在')
    expect(store.hasSession('missing')).toBe(false)
  } finally { store.close(); removeDataDir(dir) }
})

test('协作成员从入口派生管理属性，只写入口一行且恢复不修改协作事实', async () => {
  const f = fixture()
  try {
    const worker = f.spawn('member')
    f.store.serviceFor('member').appendEntry({ kind: 'assistant', content: { text: '成员保存记录' }, at: 10 })
    const work = f.records.collaborationForSession('member')
    f.store.setSessionArchived('member', true)
    expect(f.store.isSessionArchived('origin')).toBe(true)
    expect(f.store.isSessionArchived('member')).toBe(true)
    expect((await f.store.listSessions({ archived: true })).map(row => row.id).sort()).toEqual(['member', 'origin'])
    const db = new Database(databasePathOf(f.dir), { readonly: true })
    try { expect(db.query('SELECT id,archived FROM sessions ORDER BY id').all()).toEqual([{ id: 'member', archived: 0 }, { id: 'origin', archived: 1 }]) }
    finally { db.close() }
    f.store.setSessionArchived('origin', false)
    expect(f.store.isSessionArchived('member')).toBe(false)
    expect(f.records.collaborationForSession('member')).toEqual(work)
    expect(worker).toBeDefined()
  } finally { f.close() }
})

test('归档写失败保留状态；readonly 查询不新建文件或改变已有库', () => {
  const dir = tempDataDir()
  const missing = join(dir, 'not-created')
  expect(readSessionSummary(missing, 'a')).toBeUndefined()
  expect(existsSync(missing)).toBe(false)
  const store = createRecordsStore({ dataDir: dir, workspace: ['/alpha'] })
  try {
    store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '内容' }, at: 1 })
    const db = new Database(databasePathOf(dir))
    try { db.exec("CREATE TRIGGER fail_archive BEFORE UPDATE OF archived ON sessions BEGIN SELECT RAISE(ABORT,'archive failed'); END") }
    finally { db.close() }
    expect(() => store.setSessionArchived('a', true)).toThrow('archive failed')
    expect(store.isSessionArchived('a')).toBe(false)
    const bytes = readFileSync(databasePathOf(dir))
    expect(readSessionSummary(dir, 'a')).toEqual({ id: 'a', at: 1, workspace: ['/alpha'], archived: false })
    expect(readSessionSummary(dir, 'missing')).toBeUndefined()
    expect(readFileSync(databasePathOf(dir))).toEqual(bytes)
  } finally { store.close(); removeDataDir(dir) }
})
