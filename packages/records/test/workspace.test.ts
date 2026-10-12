/** 工作区身份保持完整根组，改变会话管理属性不改变归属。 */

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

test('Engine 的工作区视图共用编号与连接；关闭一个视图不关闭其它视图', async () => {
  const dir = tempDataDir()
  const owner = createRecordsStore({ dataDir: dir, workspace: [] })
  try {
    const alpha = owner.forWorkspace([ALPHA])
    const beta = owner.forWorkspace([BETA])
    const a = alpha.serviceFor(A)
    const b = beta.serviceFor(B)
    const first = a.nextId()
    expect(b.nextId()).toBe(first + 1)
    a.appendEntry(userEntry('alpha', T0))
    alpha.close()
    b.appendEntry(userEntry('beta', T0 + 1))
    expect((await owner.listSessions()).map(row => row.workspace).sort()).toEqual([[ALPHA], [BETA]])
  } finally { owner.close(); removeDataDir(dir) }
})

test('外部写锁立即返回操作失败；释放后不重放失败的输入', async () => {
  const dir = tempDataDir()
  const owner = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
  const other = new Database(databasePathOf(dir))
  try {
    other.exec('BEGIN IMMEDIATE')
    const started = performance.now()
    expect(() => owner.serviceFor(A).appendEntry(userEntry('blocked', T0))).toThrow()
    expect(performance.now() - started).toBeLessThan(200)
    other.exec('ROLLBACK')
    expect(await owner.listSessions()).toHaveLength(0)
    owner.serviceFor(B).appendEntry(userEntry('accepted', T0 + 1))
    expect((await owner.listSessions()).map(row => row.id)).toEqual([B])
  } finally { other.close(); owner.close(); removeDataDir(dir) }
})

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

  test('只命名尚未写内容的会话没有归属，不从当前工作区猜测', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: [ALPHA] })
      store.setSessionTitle(A, '只命名', T0)
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

describe('当前结构', () => {
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
        ).toEqual(['id', 'at', 'title', 'workspace', 'archived'])
      } finally {
        db.close()
      }
    } finally {
      removeDataDir(dir)
    }
  })
})
