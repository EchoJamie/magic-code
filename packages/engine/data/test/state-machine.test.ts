/**
 * T0.2 新迁移单测——输入七态状态机（failedFrom / retry 分离 / 拒收落账）、
 * 阻塞三字段落账本（重启计时保留）、构造与引导分离（prepareRecordsDir / createRecordsStore）。
 */
import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { basename, dirname, join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'
import { createRecordsStore, prepareRecordsDir } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

describe('输入七态状态机', () => {
  test('受理即拒（reject）：不经 pending 直接落 rejected 行，原稿留在账上', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      const row = inputs.reject({ text: '原文', ref: 'r1' }, '待办已满', 5)
      expect(row.state).toBe('rejected')
      expect(row.reason).toBe('待办已满')
      expect(row.input.text).toBe('原文')
      expect(inputs.get('r1')?.state).toBe('rejected')
      // 已拒的 ref 不被后续受理覆盖（DO NOTHING）。
      expect(inputs.accept({ text: '后到的', ref: 'r1' }, 6).state).toBe('rejected')
      // rejected 不能 withdraw / consume（迁移只从各自合法来源起）。
      expect(inputs.withdraw('r1', 0)).toBe(false)
      expect(inputs.consume('r1', 0, { kind: 'user', content: { text: '原文' }, at: 7 })).toBeUndefined()
    } finally { store.close(); removeDataDir(dir) }
  })

  test('pending → rejected（rejectPending）：只从 pending，reason 落账', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      inputs.accept({ text: '受理了', ref: 'r2' }, 1)
      expect(inputs.rejectPending('r2', '会话已归档')).toBe(true)
      expect(inputs.get('r2')).toMatchObject({ state: 'rejected', reason: '会话已归档' })
      // 已拒的再转一次：false（迁移唯一写者、状态不符即拒绝）。
      expect(inputs.rejectPending('r2', 'again')).toBe(false)
      // rejected → pending 走 retry（用户重发）。
      expect(inputs.retry('r2', 1)).toBe(true)
      expect(inputs.get('r2')).toMatchObject({ state: 'pending', revision: 2 })
    } finally { store.close(); removeDataDir(dir) }
  })

  test('dequeue：pending → executing；executing 后撤回被拒（无 executing→withdrawn）', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      inputs.accept({ text: '出队', ref: 'r3' }, 1)
      expect(inputs.dequeue('r3', 0)).toBe(true)
      expect(inputs.get('r3')?.state).toBe('executing')
      expect(inputs.dequeue('r3', 0)).toBe(false)
      expect(inputs.withdraw('r3', 1)).toBe(false)
    } finally { store.close(); removeDataDir(dir) }
  })

  test('fail 记 failedFrom：pending/executing 各自记失败前状态', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      inputs.accept({ text: '执行前失败', ref: 'r4' }, 1)
      inputs.fail('r4', '准入失败')
      expect(inputs.get('r4')).toMatchObject({ state: 'failed', failedFrom: 'pending' })
      inputs.accept({ text: '执行中断', ref: 'r5' }, 2)
      inputs.dequeue('r5', 0)
      inputs.fail('r5', '执行中断/无进展')
      expect(inputs.get('r5')).toMatchObject({ state: 'failed', failedFrom: 'executing' })
    } finally { store.close(); removeDataDir(dir) }
  })

  test('retry：failed/rejected → pending，清 failedFrom 与 reason；pending 下 retry 拒绝', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      inputs.accept({ text: 'one', ref: 'r6' }, 1)
      inputs.dequeue('r6', 0)
      inputs.fail('r6', '坏了')
      // fail 也推进 revision（与既有实现一致）；retry 认失败后的最新 revision。
      expect(inputs.retry('r6', 2)).toBe(true)
      expect(inputs.get('r6')).toMatchObject({ state: 'pending', revision: 3 })
      expect(inputs.get('r6')?.failedFrom).toBeUndefined()
      // 立即消费（pending 下）不走 retry：revision 已 +1，旧 revision 拒绝。
      expect(inputs.retry('r6', 2)).toBe(false)
      // rejected 同样可 retry。
      inputs.reject({ text: 'two', ref: 'r7' }, '容量', 3)
      expect(inputs.retry('r7', 0)).toBe(true)
      expect(inputs.get('r7')?.reason).toBeUndefined()
    } finally { store.close(); removeDataDir(dir) }
  })

  test('consume 从 executing 消费并写 turn；turn 只在 consume 事务里出现', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      const inputs = store.serviceFor('s').inputs
      inputs.accept({ text: '正在执行', ref: 'r8' }, 1)
      inputs.dequeue('r8', 0)
      const id = inputs.consume('r8', 1, { kind: 'user', content: { text: '正在执行' }, at: 2, turn: 9 })
      expect(id).toBeNumber()
      expect(inputs.get('r8')).toMatchObject({ state: 'consumed', entry: id, turn: 9 })
      // 消费前 turn 一直缺席（上面 dequeue 后、consume 前的状态）。
      inputs.accept({ text: '另一条', ref: 'r9' }, 3)
      inputs.dequeue('r9', 0)
      expect(inputs.get('r9')?.turn).toBeUndefined()
    } finally { store.close(); removeDataDir(dir) }
  })
})

describe('阻塞三字段落账本（runs 表）', () => {
  test('setBlocked 进入写、退出清；重启后计时保留', () => {
    const dir = tempDataDir()
    let store: ReturnType<typeof createRecordsStore> | undefined
    try {
      store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
      store.runs.upsert({ id: 'run-b', session: 's-b', state: 'waiting', startedAt: 10, updatedAt: 10 })
      store.runs.setBlocked('run-b', { kind: 'awaiting-receipt', by: 'member-x', since: 100 }, 110)
      expect(store.runs.get('run-b')?.blocked).toEqual({ kind: 'awaiting-receipt', by: 'member-x', since: 100 })

      store.close()
      store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
      // 重启后「等了多久」由账上的 since 算，不重置。
      expect(store.runs.get('run-b')?.blocked).toEqual({ kind: 'awaiting-receipt', by: 'member-x', since: 100 })

      store.runs.setBlocked('run-b', undefined, 120)
      expect(store.runs.get('run-b')?.blocked).toBeUndefined()
    } finally { store?.close(); removeDataDir(dir) }
  })

  test('全量 upsert 带 blocked 时一并落账；finish 后 blocked 不复活', () => {
    const dir = tempDataDir()
    const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
    try {
      store.runs.upsert({ id: 'run-c', state: 'running', startedAt: 1, updatedAt: 1, blocked: { kind: 'awaiting-approval', since: 0 } })
      expect(store.runs.get('run-c')?.blocked).toEqual({ kind: 'awaiting-approval', since: 0 })
      store.runs.setBlocked('run-c', undefined, 2)
      expect(store.runs.get('run-c')?.blocked).toBeUndefined()
    } finally { store.close(); removeDataDir(dir) }
  })
})

describe('构造与引导分离', () => {
  /** 造一个指定版本的旧库：v3 全形状（inputs/runs 为 v3 列），带一行用户数据。 */
  function seedOldDatabase(dir: string, version: string): void {
    const db = new Database(join(dir, 'records.db'))
    db.exec("CREATE TABLE records_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, at INTEGER NOT NULL, title TEXT, workspace TEXT, archived INTEGER NOT NULL DEFAULT 0)')
    db.exec(`CREATE TABLE entries (id INTEGER PRIMARY KEY, session TEXT NOT NULL, turn_id INTEGER, kind TEXT NOT NULL,
      content_kind TEXT NOT NULL, content_text TEXT, content_blob TEXT, payload TEXT, at INTEGER NOT NULL, source TEXT)`)
    db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, session TEXT NOT NULL, turn_id INTEGER, step_id INTEGER,
      generation INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)`)
    db.exec(`CREATE TABLE attention_items (id TEXT PRIMARY KEY NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL,
      fact TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT, source TEXT, unread INTEGER NOT NULL, delivered INTEGER NOT NULL)`)
    db.exec(`CREATE TABLE inputs (session TEXT NOT NULL, ref TEXT NOT NULL, body TEXT NOT NULL, purpose TEXT NOT NULL,
      at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending',
      entry INTEGER, turn INTEGER, reason TEXT, PRIMARY KEY(session,ref))`)
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, pid INTEGER, proc_started_at INTEGER, socket TEXT, session TEXT,
      turn_id INTEGER, step_id INTEGER, state TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      ended_at INTEGER, stop_reason TEXT, exit_code INTEGER, background INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 0, workspace TEXT, kind TEXT, last_turn TEXT, owned TEXT)`)
    db.query('INSERT INTO records_meta (key, value) VALUES (?, ?)').run('schema_version', version)
    db.query("INSERT INTO inputs (session, ref, body, purpose, at, revision, state) VALUES ('s-old', 'r-old', ?, 'current', 1, 0, 'pending')").run(JSON.stringify({ text: '用户原稿', ref: 'r-old' }))
    db.query("INSERT INTO runs (id, state, started_at, updated_at) VALUES ('run-old', 'idle', 1, 1)").run()
    db.close()
  }

  function versionOf(dir: string): string | undefined {
    const db = new Database(join(dir, 'records.db'), { readonly: true })
    try { return db.query<{ value: string }, []>("SELECT value FROM records_meta WHERE key='schema_version'").get()?.value }
    finally { db.close() }
  }

  test('v3 库原地迁移：createRecordsStore 直连即补列，用户数据原样保留', () => {
    const dir = tempDataDir()
    try {
      seedOldDatabase(dir, '3')
      const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
      try {
        // A3：不删不重建——老数据原样可读，版本已到 4。
        expect(versionOf(dir)).toBe('4')
        expect(store.serviceFor('s-old').inputs.get('r-old')?.input).toMatchObject({ text: '用户原稿' })
        // 新列可用：老行上写新字段。
        store.runs.setBlocked('run-old', { kind: 'awaiting-receipt', since: 9 }, 10)
        expect(store.runs.get('run-old')?.blocked).toEqual({ kind: 'awaiting-receipt', since: 9 })
      } finally { store.close() }
    } finally { removeDataDir(dir) }
  })

  test('prepareRecordsDir 对 v3 原地迁移（幂等、不移走原库、不产生备份目录）', () => {
    const dir = tempDataDir()
    const backupRoot = join(dirname(dir), `${basename(dir)}-backup`)
    try {
      seedOldDatabase(dir, '3')
      prepareRecordsDir(dir)
      prepareRecordsDir(dir) // 已是 v4：幂等零动作
      expect(existsSync(join(dir, 'records.db'))).toBe(true) // 原库还在——没被备份移走
      expect(existsSync(backupRoot)).toBe(false) // 没有备份目录
      expect(versionOf(dir)).toBe('4')
    } finally {
      removeDataDir(dir)
      rmSync(backupRoot, { recursive: true, force: true })
    }
  })

  test('真正不兼容的库（v2）：prepareRecordsDir 备份移走，createRecordsStore 拒绝不猜', () => {
    const dir = tempDataDir()
    const backupRoot = join(dirname(dir), `${basename(dir)}-backup`)
    try {
      seedOldDatabase(dir, '2')
      expect(() => createRecordsStore({ dataDir: dir, workspace: ['/w'] })).toThrow(/结构不符/)
      prepareRecordsDir(dir) // 引导：备份移走（A3 允许的唯一重建路径）
      expect(existsSync(join(dir, 'records.db'))).toBe(false)
      expect(existsSync(backupRoot)).toBe(true)
      const store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
      try { expect(store.serviceFor('s').inputs.list()).toEqual([]) } finally { store.close() }
    } finally {
      removeDataDir(dir)
      rmSync(backupRoot, { recursive: true, force: true })
    }
  })

  test('新库 / v4 库：prepareRecordsDir 零动作，createRecordsStore 零锁直连', async () => {
    const dir = tempDataDir()
    try {
      prepareRecordsDir(dir) // 空目录无事
      let store = createRecordsStore({ dataDir: dir, workspace: ['/w'] })
      store.close()
      prepareRecordsDir(dir) // v4 达标，零动作
      store = createRecordsStore({ dataDir: dir, workspace: ['/w'] }) // 重复连接（执行者形态）
      try { expect((await store.listSessions()).length).toBe(0) } finally { store.close() }
    } finally { removeDataDir(dir) }
  })
})
