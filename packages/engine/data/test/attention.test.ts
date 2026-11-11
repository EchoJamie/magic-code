import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { AttentionItem } from '@magic/contracts'
import { createRecordsStore, type RecordsStore } from '../src/index.ts'
import { createAttentionStore } from '../src/attention.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

const item = (event: number, overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: `s:event:${event}`, session: 's', kind: 'done', fact: `event:${event}`, at: event,
  detail: '实际回复', source: { session: 's', event }, unread: true, delivered: false, ...overrides,
})

describe('每件工作的当前提醒', () => {
  let dir: string
  let store: RecordsStore
  beforeEach(() => { dir = tempDataDir(); store = createRecordsStore({ dataDir: dir, workspace: [dir] }) })
  afterEach(() => { store.close(); removeDataDir(dir) })

  test('来源和独立投递/呈现事实持久化，同停点重放不重新提醒', () => {
    const notice = item(1, { source: { session: 'member', event: 1, entry: 2 } })
    expect(store.attention.put(notice)).toBe(true)
    store.attention.markRead([notice.id])
    store.attention.markDelivered([notice.id])
    store.close()
    store = createRecordsStore({ dataDir: dir, workspace: [dir] })
    expect(store.attention.put(notice)).toBe(false)
    expect(store.attention.list()).toEqual([{ ...notice, unread: false, delivered: true }])
    expect(store.hasSession('s')).toBe(false)
  })

  test('新原因替换同会话位置，旧来源和迟到回执都不覆盖新来源', () => {
    const old = item(1), next = item(2)
    store.attention.put(old)
    store.attention.markRead([old.id])
    store.attention.markDelivered([old.id])
    expect(store.attention.put(next)).toBe(true)
    store.attention.markRead([old.id])
    store.attention.markDelivered([old.id])
    expect(store.attention.put(old)).toBe(false)
    expect(store.attention.list()).toEqual([next])
    const db = new Database(databasePathOf(dir), { readonly: true })
    try { expect(db.query('SELECT COUNT(*) AS count FROM attention_items').get()).toEqual({ count: 1 }) }
    finally { db.close() }
  })

  test('同刻依原来源编号排序，不按文本键把 event:9 当成 event:10 之后', () => {
    store.attention.put(item(9, { at: 20 }))
    expect(store.attention.put(item(10, { at: 20 }))).toBe(true)
    expect(store.attention.put(item(9, { at: 20 }))).toBe(false)
    expect(store.attention.list()[0]?.id).toBe('s:event:10')
  })

  test('存量重复已读/未读只暴露最新来源；最新已呈现后旧未读不回流', () => {
    const db = new Database(databasePathOf(dir))
    try {
      const insert = db.query('INSERT INTO attention_items (id,session,kind,fact,at,source,unread,delivered) VALUES (?,?,?,?,?,?,?,?)')
      for (let i = 1; i <= 100; i++) insert.run(`old:${i}`, 's', 'done', `event:${i}`, i, JSON.stringify({ session: 's', event: i }), i % 2, 1)
    } finally { db.close() }
    expect(store.attention.list()).toHaveLength(1)
    expect(store.attention.list({ unread: true })).toEqual([])
    const next = item(101, { kind: 'needs-you' })
    store.attention.put(next)
    expect(store.attention.list({ unread: true })).toEqual([next])
    store.attention.markRead(['old:99'])
    expect(store.attention.list({ unread: true })).toEqual([next])
    store.attention.markRead([next.id])
    expect(store.attention.list({ unread: true })).toEqual([])
  })

  test('查询支持目标身份且是纯读；回执互不抹掉另一事实', () => {
    const a = item(1), b = item(2, { session: 'b' })
    store.attention.put(a); store.attention.put(b)
    store.attention.markRead([a.id])
    store.attention.markDelivered([b.id])
    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      const version = db.query('PRAGMA data_version').get()
      expect(createAttentionStore(db).list({ sessions: ['b'] })).toEqual([{ ...b, delivered: true }])
      expect(store.attention.list({ sessions: [] })).toEqual([])
      expect(store.attention.list({ sessions: ['s'] })).toEqual([{ ...a, unread: false }])
      expect(db.query('PRAGMA data_version').get()).toEqual(version)
    } finally { db.close() }
  })

  test('多连接旧快照重放不恢复已退出的来源', () => {
    const second = createRecordsStore({ dataDir: dir, workspace: [dir] })
    try {
      store.attention.put(item(1))
      const stale = second.attention.list()[0]!
      second.attention.put(item(2))
      store.attention.markRead([stale.id])
      expect(second.attention.put(stale)).toBe(false)
      expect(store.attention.list()).toEqual([item(2)])
    } finally { second.close() }
  })

  test('清当前提醒不改变原正文、审批或错误；批量回执写失败原子回滚', async () => {
    store.serviceFor('s').appendEntry({ kind: 'assistant', content: { text: '原始内容' }, at: 1 })
    const a = item(1), b = item(2, { session: 'b' })
    store.attention.put(a); store.attention.put(b)
    const db = new Database(databasePathOf(dir))
    try {
      db.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE ON attention_items WHEN OLD.session='b' BEGIN SELECT RAISE(ABORT,'ack failed'); END`)
      expect(() => store.attention.markRead([a.id, b.id])).toThrow('ack failed')
      expect(store.attention.list()).toEqual([a, b])
    } finally { db.close() }
    store.attention.clear('s')
    expect(store.attention.list()).toEqual([b])
    expect(await Array.fromAsync(store.readEntries('s'))).toHaveLength(1)
  })
})

test('来源查询按会话和种类定位原事件，最新停点不受别会话或无关事件影响', () => {
  const dir = tempDataDir()
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  try {
    const a = store.serviceFor('a'), b = store.serviceFor('b')
    const start = { id: a.nextId(), session: 'a', turn: 1, at: 1, kind: 'turn.start' as const, data: {} }
    const end = { id: a.nextId(), session: 'a', turn: 1, at: 2, kind: 'turn.end' as const, data: { reason: 'settled' as const } }
    a.appendEvent(start); a.appendEvent(end)
    b.appendEvent({ id: b.nextId(), session: 'b', turn: 1, at: 3, kind: 'turn.start', data: {} })
    a.appendEvent({ id: a.nextId(), session: 'a', turn: 1, at: 4, kind: 'error', data: { message: '具体错误' } })
    expect(store.readEvent('a', start.id)).toEqual(start)
    expect(store.readEvent('b', start.id)).toBeUndefined()
    expect(store.latestEvent('a', ['turn.start', 'turn.end'])).toEqual(end)
    expect(store.latestEvent('a', [])).toBeUndefined()
    expect(store.latestEvent('missing', ['turn.end'])).toBeUndefined()
  } finally { store.close(); removeDataDir(dir) }
})
