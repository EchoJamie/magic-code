import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RECORD_SCHEMA_VERSION } from '@magic/contracts'
import type { NewEntry } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

/** 本文件里那组根——归属与迁移无关，取一件固定的即可（专测见 `workspace.test.ts`）。 */
const ROOTS = ['/work/alpha']

const A = 's-alpha'
const B = 's-beta'
const T0 = 1_700_000_000_000

/** 一条用户条目——标题派生的取材物（此处只当普通条目写）。 */
function userEntry(text: string, at: number): NewEntry {
  return { kind: 'user', content: { text }, at }
}

describe('标题列（改过的标题存这儿）', () => {
  test('落定 · 读回 · 重开仍在', async () => {
    const dir = tempDataDir()
    try {
      const first = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      first.serviceFor(A).appendEntry(userEntry('看看工作区里有什么', T0))
      // 没改过＝没有标题（不是空串——缺席可辨，空串不可辨）
      expect((await first.listSessions())[0]?.title).toBeUndefined()

      first.setSessionTitle(A, '看看工作区', T0 + 5)
      expect((await first.listSessions())[0]?.title).toBe('看看工作区')
      first.close()

      // 重开——标题是**持久事实**（append-only 库里少有的可改位；改的是会话属性，不是内容）
      const second = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect((await second.listSessions())[0]?.title).toBe('看看工作区')
      second.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('改两次＝后写的说了算（就地更新，不追加）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      store.serviceFor(A).appendEntry(userEntry('第一件', T0))

      store.setSessionTitle(A, '甲', T0 + 1)
      store.setSessionTitle(A, '乙', T0 + 2)
      expect((await store.listSessions())[0]?.title).toBe('乙')
      // 会话表不因改名多出行——一条会话一行
      expect((await store.listSessions()).length).toBe(1)
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('改一条没写过的会话——建行，标题落定（不静默丢）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      store.setSessionTitle(A, '空会话也有名字', T0)

      const listed = await store.listSessions()
      expect(listed.map((row) => [row.id, row.title])).toEqual([[A, '空会话也有名字']])
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('最近会话（启动流转的取材口）', () => {
  test('时间降序取第一——没有会话则 undefined', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(store.latestSession()).toBeUndefined()

      store.serviceFor(A).appendEntry(userEntry('先来的', T0))
      store.serviceFor(B).appendEntry(userEntry('后来的', T0 + 1000))

      expect(store.latestSession()).toBe(B)
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('schema 边界', () => {
  test('旧结构明确拒开，不迁移、不删除或重建内容', () => {
    const dir = tempDataDir()
    try {
      const db = new Database(databasePathOf(dir), { create: true })
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
      db.query('INSERT INTO sessions VALUES (?, ?)').run(A, T0)
      db.close()
      expect(() => createRecordsStore({ dataDir: dir, workspace: ROOTS })).toThrow('不自动迁移或重建')
      const original = new Database(databasePathOf(dir), { readonly: true })
      try {
        expect(original.query('SELECT * FROM sessions').all()).toEqual([{ id: A, at: T0 }])
        expect(original.query('PRAGMA table_info(sessions)').all().map((row: any) => row.name)).toEqual(['id', 'at'])
        expect(original.query('PRAGMA user_version').get()).toEqual({ user_version: 0 })
      } finally { original.close() }
    } finally { removeDataDir(dir) }
  })
  test('即使版本相同，缺字段也拒开', () => {
    const dir = tempDataDir()
    try {
      const db = new Database(databasePathOf(dir), { create: true })
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
      db.exec(`PRAGMA user_version=${RECORD_SCHEMA_VERSION}`)
      db.close()
      expect(() => createRecordsStore({ dataDir: dir, workspace: ROOTS })).toThrow('结构不符')
    } finally { removeDataDir(dir) }
  })
})
