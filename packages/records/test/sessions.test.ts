/**
 * U16 · 记录库 —— **会话面**（标题列 · 最近会话 · 老库补列）。
 *
 * 出处：技术方案 · 会话与多会话（「标题＝首条消息摘要、**可改**」）· 记录 schema v0。
 *
 * 三件：
 * ① `sessions` 加 `title` 列——**改过的标题**存这儿（默认标题由对话域按首条消息现算，
 *    不落库：那是派生物，存两份迟早分叉）；
 * ② `latestSession()`——启动流转「接着最近一条」的取材口；
 * ③ **老库**（加列之前建的）**就地补列**——不丢数据、不动 `user_version`。加列是**结构增列
 *    的补齐**（幂等探测），不是顺序迁移（顺序迁移自冻结点起，那之后走版本号）。
 *
 * 扫描面：测试用 fs 不受守护拦（守护面＝各包 `src/`）——老库要**手工建**才造得出。
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { NewEntry } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

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
      const first = createRecordsStore({ dataDir: dir })
      first.serviceFor(A).appendEntry(userEntry('看看工作区里有什么', T0))
      // 没改过＝没有标题（不是空串——缺席可辨，空串不可辨）
      expect((await first.listSessions())[0]?.title).toBeUndefined()

      first.setSessionTitle(A, '看看工作区', T0 + 5)
      expect((await first.listSessions())[0]?.title).toBe('看看工作区')
      first.close()

      // 重开——标题是**持久事实**（append-only 库里少有的可改位；改的是会话属性，不是内容）
      const second = createRecordsStore({ dataDir: dir })
      expect((await second.listSessions())[0]?.title).toBe('看看工作区')
      second.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('改两次＝后写的说了算（就地更新，不追加）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
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
      const store = createRecordsStore({ dataDir: dir })
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
      const store = createRecordsStore({ dataDir: dir })
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

describe('老库补列（加列之前的库照开）', () => {
  /** 照**加列之前**的 DDL 手工建一个库——老库的忠实样本。 */
  function makeLegacyDatabase(dir: string, session: string, at: number): void {
    const db = new Database(databasePathOf(dir), { create: true })
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL)')
    db.exec(`INSERT INTO sessions (id, at) VALUES ('${session}', ${at})`)
    db.exec('PRAGMA user_version = 0')
    db.close()
  }

  test('老库就地补列——数据不丢、标题可写、版本号不动', async () => {
    const dir = tempDataDir()
    try {
      makeLegacyDatabase(dir, A, T0)

      // 开库不该抛（加列之前建的库照开——「重建路径可用」的另一半：**不逼人删库**）
      const store = createRecordsStore({ dataDir: dir })
      const listed = await store.listSessions()
      expect(listed.map((row) => [row.id, row.at])).toEqual([[A, T0]])

      store.setSessionTitle(A, '补列之后照样能改', T0 + 1)
      expect((await store.listSessions())[0]?.title).toBe('补列之后照样能改')
      store.close()

      // 版本号不动——**这不是顺序迁移**（迁移自冻结点起走版本号；此处只是把缺的列补上）
      const db = new Database(databasePathOf(dir))
      expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(0)
      db.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('补列幂等——旧库开两次不多补、不报错', async () => {
    const dir = tempDataDir()
    try {
      makeLegacyDatabase(dir, A, T0)

      createRecordsStore({ dataDir: dir }).close()
      const store = createRecordsStore({ dataDir: dir })
      expect(store.latestSession()).toBe(A)
      store.close()

      // 列只有一个 title——补列语句没有跑第二遍（真跑第二遍 SQLite 会抛 duplicate column）
      const db = new Database(databasePathOf(dir))
      const names = db
        .query<{ name: string }, []>('PRAGMA table_info(sessions)')
        .all()
        .map((row) => row.name)
      db.close()
      expect(names.filter((name) => name === 'title').length).toBe(1)
    } finally {
      removeDataDir(dir)
    }
  })

  test('重建路径——空目录建新库，标题列即到位', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir })
      store.serviceFor(A).appendEntry(userEntry('头一件', T0))
      store.setSessionTitle(A, '甲', T0 + 1)
      expect((await store.listSessions())[0]?.title).toBe('甲')
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})
