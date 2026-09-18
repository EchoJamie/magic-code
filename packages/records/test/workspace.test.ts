/**
 * U26 · 记录库 —— **会话归属工作区**（`workspace` 列 · 建立时锚定 · 顺序迁移）。
 *
 * 出处：`项目字典.md` · Workspace / Session（2026-09-19 改）——**一个会话属于一个工作区**，
 * 归属在**建立时锚定 · 随记录持久**（**恢复据此回到原位**：崩溃 / 关掉后重建时，工作区由
 * 记录给出，不由「当下的启动目录」临时决定）；`技术方案.md` · 记录 · 存储
 * （「全局单库、**会话自带工作区关联**」）· 记录 · schema 演进（冻结点＝阶段 2 末，
 * 此后走**顺序迁移**）。
 *
 * ⚠️ **工作区是「≥ 1 条根的联合作用域」**（词典 · Workspace；`U18` 多根已落地）——
 * 故锚下的是**整组根**（绝对路径 · 声明序），不是单取默认根：只记默认根的话，
 * 多根工作区在恢复时就**重建不回去**，而「回到原位」正是这一列存在的理由。
 *
 * 两族：
 * - **归属**——建立时写、此后不变、老会话缺席（不编）；
 * - **迁移**——既有库**真跑一遍**（不许只测新库）：列到位 · 数据一件不丢 · 版本号推进。
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { RECORD_SCHEMA_VERSION } from '@magic/contracts'
import type { NewEntry } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { databasePathOf, removeDataDir, tempDataDir } from './tmp.ts'

const A = 's-alpha'
const B = 's-beta'
const T0 = 1_700_000_000_000

const ALPHA = '/work/alpha'
const BETA = '/work/beta'

/** 一条用户条目——会话「落过账」的最小证据（建立由它触发）。 */
function userEntry(text: string, at: number): NewEntry {
  return { kind: 'user', content: { text }, at }
}

/** 会话表的原始行——**直读库表**（防「读侧自己滤/自己编」的假绿，同判据 3 的做法）。 */
function rawSessions(dir: string): readonly { readonly id: string; readonly workspace: string | null }[] {
  const db = new Database(databasePathOf(dir), { readonly: true })
  try {
    return db.query<{ id: string; workspace: string | null }, []>(
      'SELECT id, workspace FROM sessions ORDER BY id',
    ).all()
  } finally {
    db.close()
  }
}

describe('归属（建立时锚定 · 随记录持久）', () => {
  test('会话建立时记下当时的工作区——列表里读得回来（整组根 · 声明序）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA, BETA] })
      store.serviceFor(A).appendEntry(userEntry('看看这个工作区里有什么', T0))

      expect((await store.listSessions()).map((row) => row.workspace)).toEqual([[ALPHA, BETA]])
      store.close()

      // 持久——重开同一目录仍读得到（不是进程内的记性）
      const reopened = createRecordsStore({ dataDir: dir, workspace: [ALPHA, BETA] })
      expect((await reopened.listSessions())[0]?.workspace).toEqual([ALPHA, BETA])
      reopened.close()

      // 直读库表——列真在库里（JSON 一行），不是读侧现算的
      expect(JSON.parse(rawSessions(dir)[0]?.workspace ?? 'null')).toEqual([ALPHA, BETA])
    } finally {
      removeDataDir(dir)
    }
  })

  test('归属在建立时锚定——换个目录再开库，旧会话不跟着改', async () => {
    const dir = tempDataDir()
    try {
      const first = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      first.serviceFor(A).appendEntry(userEntry('甲项目的事', T0))
      first.close()

      // 「换个目录启动」——同一台机器、同一个全局库，工作区成了另一组根
      const second = createRecordsStore({ dataDir: dir, workspace: [BETA] })
      second.serviceFor(B).appendEntry(userEntry('乙项目的事', T0 + 1))
      // 旧会话**再动一次**（换目录之后接着写它）——归属仍是最初那一次锚下的
      second.serviceFor(A).appendEntry(userEntry('接着甲那边写', T0 + 2))

      // 列表序是「最近在前」，与归属无关——按 id 收拢了看
      const byId = (await second.listSessions())
        .map((row) => [row.id, row.workspace] as const)
        .sort(([left], [right]) => left.localeCompare(right))
      expect(byId).toEqual([
        [A, [ALPHA]],
        [B, [BETA]],
      ])
      second.close()
    } finally {
      removeDataDir(dir)
    }
  })

  test('列加上之前落账的会话**没有归属**——缺席，不编一个', async () => {
    const dir = tempDataDir()
    try {
      makeLegacyDatabase(dir, A, T0)

      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      const listed = await store.listSessions()

      // 键不在（与 `title` 的缺席同法：缺席可辨，拿「当下的启动目录」顶上不可辨）
      expect(listed.map((row) => row.id)).toEqual([A])
      expect(listed[0]?.workspace).toBeUndefined()
      expect(Object.hasOwn(listed[0] as object, 'workspace')).toBe(false)
      store.close()
    } finally {
      removeDataDir(dir)
    }
  })
})

describe('顺序迁移（冻结点已过——既有库照开，不许重建库）', () => {
  test('既有库真跑一遍：`workspace` 列到位 · 老数据一件不丢 · 版本号 0 → 1', async () => {
    const dir = tempDataDir()
    const legacyEntryId = 7
    try {
      makeLegacyDatabase(dir, A, T0, { entryId: legacyEntryId })

      // 开库**不许抛**（既有库是要接着用的，不是要删的）
      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      expect((await store.listSessions()).map((row) => [row.id, row.at])).toEqual([[A, T0]])

      // 老数据一件不丢——条目读得回来
      const replayed: string[] = []
      for await (const entry of store.readEntries(A)) {
        replayed.push('text' in entry.content ? entry.content.text : '')
      }
      expect(replayed).toEqual(['老库里的那条'])

      // 迁移之后新写的会话带上归属（列是真在用的，不只是加上了）
      store.serviceFor(B).appendEntry(userEntry('迁移之后新开的', T0 + 1))
      expect((await store.listSessions()).find((row) => row.id === B)?.workspace).toEqual([ALPHA])
      store.close()

      const db = new Database(databasePathOf(dir))
      try {
        expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
          user_version: RECORD_SCHEMA_VERSION,
        })
        expect(RECORD_SCHEMA_VERSION).toBe(1) // 「冻结点已过」的那一步：0 → 1
        // 老行**没有被凭空补上归属**——迁移只加列，不猜数据
        expect(rawSessions(dir)).toEqual([
          { id: A, workspace: null },
          { id: B, workspace: JSON.stringify([ALPHA]) },
        ])
      } finally {
        db.close()
      }
    } finally {
      removeDataDir(dir)
    }
  })

  test('更老的库（连 `title` 都还没有）也同样一步到当前形状', async () => {
    const dir = tempDataDir()
    try {
      // 阶段 1 的样子：sessions 只有 id / at
      makeLegacyDatabase(dir, A, T0, { title: false })

      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      store.setSessionTitle(A, '补列之后照样能改', T0 + 1)
      expect((await store.listSessions())[0]?.title).toBe('补列之后照样能改')
      expect((await store.listSessions())[0]?.workspace).toBeUndefined()
      store.close()

      const db = new Database(databasePathOf(dir))
      const names = db
        .query<{ name: string }, []>('PRAGMA table_info(sessions)')
        .all()
        .map((row) => row.name)
      db.close()
      expect(names.filter((name) => name === 'title').length).toBe(1)
      expect(names.filter((name) => name === 'workspace').length).toBe(1)
    } finally {
      removeDataDir(dir)
    }
  })

  test('新库不欠迁移——建库即当前形状（版本号＝契约常量，两列齐）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      store.close()

      const db = new Database(databasePathOf(dir), { readonly: true })
      try {
        expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(
          RECORD_SCHEMA_VERSION,
        )
        expect(
          db
            .query<{ name: string }, []>('PRAGMA table_info(sessions)')
            .all()
            .map((row) => row.name),
        ).toEqual(['id', 'at', 'title', 'workspace'])
      } finally {
        db.close()
      }
    } finally {
      removeDataDir(dir)
    }
  })
})

/**
 * **老库的忠实样本**——照当时的 DDL 手工建（迁移只能在真既有库上验，测试用 fs 不受守护拦）。
 *
 * `title` 那位收两形：阶段 1 的库（只有 id / at）与 U16 之后的库（有 title、版本号**仍是 0**
 * ——那一列当时走的是「补齐」，不是顺序迁移）。两种都是**版本 0 的既有库**。
 */
function makeLegacyDatabase(
  dir: string,
  session: string,
  at: number,
  extra: { readonly entryId?: number; readonly title?: boolean } = {},
): void {
  const withTitle = extra.title ?? true
  const db = new Database(databasePathOf(dir), { create: true })

  db.exec(
    withTitle
      ? 'CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL, title TEXT)'
      : 'CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL)',
  )
  db.exec(`INSERT INTO sessions (id, at) VALUES ('${session}', ${at})`)

  db.exec(`CREATE TABLE entries (
    id            INTEGER PRIMARY KEY,
    session       TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    content_kind  TEXT    NOT NULL,
    content_text  TEXT,
    content_blob  TEXT,
    payload       TEXT,
    at            INTEGER NOT NULL,
    source        TEXT
  )`)
  db.exec(`CREATE TABLE events (
    id       INTEGER PRIMARY KEY,
    session  TEXT    NOT NULL,
    turn     INTEGER,
    at       INTEGER NOT NULL,
    kind     TEXT    NOT NULL,
    data     TEXT    NOT NULL
  )`)
  db.exec('CREATE TABLE records_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  if (extra.entryId !== undefined) {
    db.exec(
      `INSERT INTO entries (id, session, kind, content_kind, content_text, at)
       VALUES (${extra.entryId}, '${session}', 'user', 'text', '老库里的那条', ${at + 1})`,
    )
  }

  db.exec('PRAGMA user_version = 0')
  db.close()
}
