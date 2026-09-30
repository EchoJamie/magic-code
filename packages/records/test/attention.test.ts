import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AttentionItem, KernelEvent } from '@magic/contracts'
import { createRecordsStore, type AttentionStore, type RecordsStore } from '../src/index.ts'
import { createAttentionStore } from '../src/attention.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

const T0 = 1_700_000_000_000

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    session: 'session-a',
    kind: 'needs-you',
    fact: `event:${id}`,
    at: T0,
    unread: true,
    delivered: false,
    ...overrides,
  }
}

describe('持久注意事项', () => {
  let dir: string
  let store: RecordsStore

  beforeEach(() => {
    dir = tempDataDir()
    store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  })

  afterEach(() => {
    store.close()
    removeDataDir(dir)
  })

  function reopen(): void {
    store.close()
    store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  }

  test('全字段与三类事项保存到 records.db，缺席/空详情和初始标记重开不丢', () => {
    const items = [
      item('a', { kind: 'done', unread: false, delivered: true }),
      item('b', { kind: 'failed', detail: '', delivered: true }),
      item('c', { detail: '等待确认\n含中文与单引号 \'', unread: false }),
      item('d'),
    ]
    const attention: AttentionStore = store.attention
    for (const value of items) expect(attention.put(value)).toBe(true)
    expect(attention.list()).toEqual(items)
    reopen()
    expect(store.attention.list()).toEqual(items)

    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      // 直接查库佐证持久落点；不是内存缓存或另一个文件。
      expect(db.query('SELECT * FROM attention_items ORDER BY at, id').all()).toEqual(
        items.map((value) => ({
          ...value,
          detail: value.detail ?? null,
          unread: Number(value.unread),
          delivered: Number(value.delivered),
        })),
      )
      expect(db.query('PRAGMA database_list').all()).toHaveLength(1)
      expect(readdirSync(dir).filter((name) => name.endsWith('.db'))).toEqual(['records.db'])
    } finally {
      db.close()
    }
  })

  test('来源 session 尚无行也可保存；事项不凭空建立会话', async () => {
    const value = item('orphan', { session: 'not-recorded-yet', kind: 'failed' })
    expect(store.attention.put(value)).toBe(true)
    expect(store.hasSession(value.session)).toBe(false)
    expect(await store.listSessions()).toEqual([])
    reopen()
    expect(store.attention.list()).toEqual([value])
    expect(store.hasSession(value.session)).toBe(false)

    store.serviceFor(value.session).appendEntry({
      kind: 'user', content: { text: '会话稍后落地' }, at: T0 + 1,
    })
    expect(store.hasSession(value.session)).toBe(true)
    expect(store.attention.list()).toEqual([value])
  })

  test('稳定 id 去重，重放不覆盖事实、未读或投递状态', () => {
    const value = item('same', { detail: '原始事实' })
    expect(store.attention.put(value)).toBe(true)
    expect(store.attention.put(item('same', {
      session: 'other-session', kind: 'failed', fact: 'other-fact', at: T0 + 100,
      detail: '错误的重放内容', unread: false, delivered: true,
    }))).toBe(false)
    expect(store.attention.list()).toEqual([value])

    store.attention.markRead([value.id])
    store.attention.markDelivered([value.id])
    reopen()
    expect(store.attention.put(value)).toBe(false)
    expect(store.attention.list()).toEqual([{ ...value, unread: false, delivered: true }])

    // 同一 session、kind 和时间下的新事实仍是独立事项。
    const next = item('next')
    expect(store.attention.put(next)).toBe(true)
    expect(store.attention.list()).toEqual([next, { ...value, unread: false, delivered: true }])
  })

  test('列表按 at/id 升序，每次都是纯读快照；只读数据库上同样能读取', () => {
    const ordered = [item('z', { at: T0 - 1 }), item('a'), item('b'), item('0', { at: T0 + 1 })]
    for (const value of [...ordered].reverse()) store.attention.put(value)

    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      const version = db.query('PRAGMA data_version').get()
      const first = store.attention.list()
      for (let i = 0; i < 3; i += 1) expect(store.attention.list()).toEqual(ordered)
      expect(db.query('PRAGMA data_version').get()).toEqual(version)
      expect(createAttentionStore(db).list()).toEqual(ordered)

      store.attention.markRead(['a'])
      expect(first).toEqual(ordered)
      expect(store.attention.list()).toEqual(ordered.map((value) => (
        value.id === 'a' ? { ...value, unread: false } : value
      )))
    } finally {
      db.close()
    }
  })

  test('按具体 id 独立确认，两种顺序都保留另一标记；空、重复与未知 id 幂等', () => {
    const values = [item('a'), item('b'), item('c'), item('other', { session: 'session-b' })]
    for (const value of values) store.attention.put(value)
    store.attention.markRead(['a', 'a', 'missing', 'session-a'])
    store.attention.markDelivered(['b', 'b', 'missing', 'session-b'])
    expect(store.attention.list()).toEqual([
      { ...values[0]!, unread: false },
      { ...values[1]!, delivered: true },
      values[2]!, values[3]!,
    ])

    store.attention.markDelivered(['a'])
    store.attention.markRead(['b'])
    const expected = values.map((value) => (
      value.id === 'a' || value.id === 'b' ? { ...value, unread: false, delivered: true } : value
    ))
    reopen()
    expect(store.attention.list()).toEqual(expected)

    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      const version = db.query('PRAGMA data_version').get()
      store.attention.markRead([])
      store.attention.markDelivered([])
      store.attention.markRead(['a', 'b', 'missing'])
      store.attention.markDelivered(['a', 'b', 'missing'])
      expect(store.attention.list()).toEqual(expected)
      expect(db.query('PRAGMA data_version').get()).toEqual(version)
    } finally {
      db.close()
    }

    const later = item('missing')
    expect(store.attention.put(later)).toBe(true)
    expect(store.attention.list().find((value) => value.id === later.id)).toEqual(later)
  })

  test('多连接及时看到写入和确认，旧快照重放不丢新事实与未读', () => {
    const other = createRecordsStore({ dataDir: dir, workspace: [dir] })
    try {
      const original = item('a')
      expect(store.attention.put(original)).toBe(true)
      const stale = other.attention.list()[0]!
      store.attention.markRead(['a'])
      other.attention.markDelivered(['a'])
      const next = item('b')
      expect(other.attention.put(next)).toBe(true)
      expect(other.attention.put(stale)).toBe(false)
      const expected = [{ ...original, unread: false, delivered: true }, next]
      expect(store.attention.list()).toEqual(expected)
      expect(other.attention.list()).toEqual(expected)
    } finally {
      other.close()
    }
    reopen()
    expect(store.attention.list()).toEqual([
      item('a', { unread: false, delivered: true }), item('b'),
    ])
  })

  test('批量确认在同库事务内，途中失败整批回滚', () => {
    const values = [item('a'), item('b')]
    for (const value of values) store.attention.put(value)
    const db = new Database(databasePathOf(dir))
    try {
      db.exec(`CREATE TRIGGER fail_ack BEFORE UPDATE ON attention_items
        WHEN OLD.id = 'b' BEGIN SELECT RAISE(ABORT, 'ack failed'); END`)
      expect(() => store.attention.markRead(['a', 'b'])).toThrow('ack failed')
      expect(store.attention.list()).toEqual(values)
      expect(() => store.attention.markDelivered(['a', 'b'])).toThrow('ack failed')
      expect(store.attention.list()).toEqual(values)
    } finally {
      db.close()
    }
  })

  test('已读待答仍保留 needs-you 与来源事实，不生成答复或改写记录', async () => {
    const service = store.serviceFor('session-a')
    service.appendEntry({ kind: 'user', content: { text: '请执行' }, at: T0 })
    const waiting: KernelEvent = {
      id: service.nextId(), session: 'session-a', turn: 1, at: T0,
      kind: 'tool.call', data: { name: 'exec', args: { cmd: 'echo test' } },
    }
    service.appendEvent(waiting)
    const request: KernelEvent = {
      id: service.nextId(), session: 'session-a', turn: 1, at: T0,
      kind: 'tool.decision.request',
      data: { call: waiting.id, name: 'exec', material: '执行测试命令', weight: 'light' },
    }
    service.appendEvent(request)
    const value = item('approval', { fact: `event:${request.id}` })
    store.attention.put(value)
    store.attention.markRead([value.id])
    store.attention.markDelivered([value.id])
    reopen()

    expect(store.attention.list()).toEqual([{ ...value, unread: false, delivered: true }])
    const entries = []
    for await (const entry of store.readEntries(value.session)) entries.push(entry)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.kind).toBe('user')
    const events = []
    for await (const event of store.serviceFor(value.session).readEvents(value.session)) events.push(event)
    expect(events).toEqual([waiting, request])
    const scan = await store.recoveryScan(value.session)
    expect(scan.calls[0]?.requested).toBe(true)
    expect(scan.calls[0]?.decision).toBeNull()
  })

  test('不读取或迁移旧 notices.json；无效 JSON 也不影响开库', () => {
    const path = join(dir, 'notices.json')
    const legacy = JSON.stringify([item('legacy')])
    writeFileSync(path, legacy)
    reopen()
    expect(store.attention.list()).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(legacy)

    writeFileSync(path, 'invalid legacy json')
    store.attention.put(item('current'))
    reopen()
    expect(store.attention.list()).toEqual([item('current')])
    expect(readFileSync(path, 'utf8')).toBe('invalid legacy json')
  })
})
