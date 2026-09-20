/**
 * U02 · 记录库 —— **判据 3（不落库清单）· 判据 4（schema）· 判据 6（数据落点）**。
 *
 * 判据 3：`model.delta` · `tool.output.delta` 不落库（按 `TRANSIENT_EVENT_KINDS`）——
 * 且**别的 kind 照落**（清单是白名单式的排除，不是「什么都不写」）。
 * 判据 4：`user_version` 自始写入；重开连接**续写**（append-only，不回改）。
 * 判据 6：`dataDir` 的前导 `~` 由**配置加载器**展开，**库不展开**。
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  RECORD_SCHEMA_VERSION,
  TRANSIENT_EVENT_KINDS,
  expandHome,
} from '@magic/contracts'
import type {
  Entry,
  EventDataOf,
  EventEnvelope,
  EventKind,
  KernelEvent,
  RecordId,
} from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import {
  databasePathOf,
  hasTildeDir,
  removeDataDir,
  tempDataDir,
} from './tmp.ts'

const SESSION = 's-schema'
const T0 = 1_700_000_000_000

/** 工作区根（U26 起 `createRecordsStore` 必给）——本文件量的是库表与版本，与归属无关。 */
const ROOTS = ['/work/alpha']

/** 条目的内联正文——`Content` 是两选一，测试里按判别取文本（取不到即空串）。 */
function textOf(entry: Entry): string {
  return 'text' in entry.content ? entry.content.text : ''
}

describe('判据 3 · 不落库清单', () => {
  test('瞬时事件不落库，其余 kind 照落（读回与直读两路同证）', async () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      const records = store.serviceFor(SESSION)

      let clock = T0
      const stamp = <K extends EventKind>(kind: K, data: EventDataOf[K]): EventEnvelope<K> => {
        clock += 1
        return { id: records.nextId(), session: SESSION, turn: 1, at: clock, kind, data }
      }

      const persisted: KernelEvent[] = [
        stamp('model.call.start', { model: 'MiniMax-M3' }),
        stamp('model.usage', { inputTokens: 10, outputTokens: 20 }),
        stamp('tool.call', { name: 'exec', args: { cmd: 'ls' } }),
        stamp('tool.result', { call: 1, ok: true, output: { text: 'ok' } }),
      ]
      const transient: KernelEvent[] = [
        stamp('model.delta', { channel: 'text', text: '半句' }),
        stamp('model.delta', { channel: 'thinking', text: '想一下' }),
        stamp('model.delta', { channel: 'toolcall', text: '{"cmd"', name: 'exec', id: 'call_1' }),
        stamp('tool.output.delta', { call: 1, channel: 'stdout', text: '流式片段' }),
      ]

      // 交替投递——顺序无关，过滤只看 kind
      for (const event of [...persisted, ...transient]) records.appendEvent(event)

      const readBack: KernelEvent[] = []
      for await (const event of records.readEvents(SESSION)) readBack.push(event)
      expect(readBack).toEqual(persisted)

      const transientKinds = new Set(TRANSIENT_EVENT_KINDS)
      expect(readBack.some((event) => transientKinds.has(event.kind))).toBe(false)

      store.close()

      // 直读库表——不经读 API，防「读侧自己滤掉了」的假绿
      const db = new Database(databasePathOf(dir), { readonly: true })
      try {
        const rows = db.query<{ kind: string }, []>('SELECT kind FROM events ORDER BY id').all()
        expect(rows.map((row) => row.kind)).toEqual([
          'model.call.start',
          'model.usage',
          'tool.call',
          'tool.result',
        ])
        // 瞬时事件连号都不占：id 只发给落库的（其余号给了不落库者也不在表里）
        const ids = db.query<{ id: number }, []>('SELECT id FROM events ORDER BY id').all()
        expect(ids.length).toBe(4)
      } finally {
        db.close()
      }
    } finally {
      removeDataDir(dir)
    }
  })

  test('不落库清单＝契约常量（九个 kind，一字不差）', () => {
    // 第 17 轮补锚：`model.retry` 与两个实时增量同列——退避期间那个「正在等」是实时信号、
    // 不是重放事实；重试次数另落 `ModelCallResult.attempts`，故不落库不丢信息。
    // U16 补锚：`session.state` 同列；第 19 轮：`session.history` 同列（读出来的，不是过程事实）——它是**快照**（此刻有哪些会话、当前在哪条），
    // 而重放要的是过程；落库只会把同一张表存 N 遍、重放时越读越乱。
    // D10 · 第 3 样补锚：`model.catalog` 同列——**原锚**是「读出来的不落库」（表在内存里，
    // 不在库里）；**为何变**：模型面也开了一条读面（`/model` 要看注册表全量）；
    // **新锚**：同一判据多一格，字面一个没动（记录域拦它的那一道因此照样生效）。
    // U22 补锚：`grants.catalog` 同列——**还是同一条判据**（授权表在盘上的 `grants.json` 里、
    // 不在库里）；`/grants` 也是反复看的抽屉，落库＝把同一张表存 N 遍。
    // U33 补锚：`skill.used`（依据在**条目载荷**里，同「读出来的不落库」）＋
    // `input.settled`（一次答复，同 `session.state`；配对键是外壳给的，落库就没人认领了）。
    expect([...TRANSIENT_EVENT_KINDS].sort()).toEqual([
      'grants.catalog',
      'input.settled',
      'model.catalog',
      'model.delta',
      'model.retry',
      'session.history',
      'session.state',
      'skill.used',
      'tool.output.delta',
    ])
  })
})

describe('判据 4 · schema（版本 · 重开续写）', () => {
  test('新建即认版本：三表在、文件在、版本号＝契约常量', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(store.paths.database).toBe(databasePathOf(dir))
      store.close()

      const db = new Database(databasePathOf(dir), { readonly: true })
      try {
        const tables = db
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
          )
          .all()
          .map((row) => row.name)
          .filter((name) => !name.startsWith('sqlite_'))

        expect(tables).toEqual(['entries', 'events', 'records_meta', 'sessions'])
        expect(db.query<{ user_version: number }, []>('PRAGMA user_version').get()).toEqual({
          user_version: RECORD_SCHEMA_VERSION,
        })
      } finally {
        db.close()
      }
    } finally {
      removeDataDir(dir)
    }
  })

  test('库比程序新即拒开（版本协议是活的——不然这列只是摆设）', () => {
    const dir = tempDataDir()
    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      store.close()

      const db = new Database(databasePathOf(dir))
      db.exec(`PRAGMA user_version = ${RECORD_SCHEMA_VERSION + 1}`)
      db.close()

      expect(() => createRecordsStore({ dataDir: dir, workspace: ROOTS })).toThrow(/较本程序新/)
    } finally {
      removeDataDir(dir)
    }
  })

  test('重开连接续写：旧行原样（append-only 不回改）· 新号更大', async () => {
    const dir = tempDataDir()
    const T1 = T0 + 1

    const firstRun = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    const firstRecords = firstRun.serviceFor(SESSION)
    const oldIds: RecordId[] = [1, 2, 3].map((n) =>
      firstRecords.appendEntry({ kind: 'user', content: { text: `第 ${n} 条` }, at: T1 + n }),
    )
    firstRecords.appendEvent({
      id: firstRecords.nextId(),
      session: SESSION,
      turn: null,
      at: T1 + 9,
      kind: 'agent.start',
      data: {},
    })
    firstRun.close()

    const secondRun = createRecordsStore({ dataDir: dir, workspace: ROOTS })
    const secondRecords = secondRun.serviceFor(SESSION)

    // 旧行原样
    const replayed: string[] = []
    for await (const entry of secondRecords.readEntries(SESSION)) replayed.push(textOf(entry))
    expect(replayed).toEqual(['第 1 条', '第 2 条', '第 3 条'])

    // 新号更大——id 水位不回退
    const fresh = secondRecords.appendEntry({
      kind: 'assistant',
      content: { text: '接着写' },
      at: T1 + 100,
    })
    expect(fresh).toBeGreaterThan(Math.max(...oldIds))

    // 会话表不重复、列表照旧
    // **原锚**：`[{ id, at }]`（摘要当时的全部字段）；**为何变**：U26 加了 `workspace`
    // ——续写那一次**碰不到它**（`ON CONFLICT DO NOTHING`），故重开仍是首写锚下的那一组；
    // **新锚**：同一条规格（不重复 · 行原样），**全等照旧**。
    expect(await secondRun.listSessions()).toEqual([
      { id: SESSION, at: T1 + 1, workspace: ROOTS },
    ])

    secondRun.close()

    const db = new Database(databasePathOf(dir), { readonly: true })
    try {
      const rows = db
        .query<{ id: number; kind: string; content_text: string | null; at: number }, []>(
          'SELECT id, kind, content_text, at FROM entries ORDER BY id',
        )
        .all()

      // 前三条逐列与首次写入时一致（没有被改写），第四条是续写
      expect(rows.map((row) => row.id)).toEqual([...oldIds, fresh])
      expect(rows.map((row) => row.kind)).toEqual(['user', 'user', 'user', 'assistant'])
      expect(rows.map((row) => row.content_text)).toEqual([
        '第 1 条',
        '第 2 条',
        '第 3 条',
        '接着写',
      ])
      expect(rows.map((row) => row.at)).toEqual([T1 + 1, T1 + 2, T1 + 3, T1 + 100])
    } finally {
      db.close()
    }

    removeDataDir(dir)
  })
})

describe('判据 6 · 数据落点（`~` 展开归配置加载器）', () => {
  test('配置加载器展开在前·库照字面用——落在展开后的目录里', () => {
    const home = tempDataDir()
    const dir = expandHome('~/magic-probe', home)

    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(store.paths.database).toBe(join(home, 'magic-probe', 'records.db'))
      expect(store.paths.blobs).toBe(join(home, 'magic-probe', 'blobs'))
      expect(existsSync(join(home, 'magic-probe', 'records.db'))).toBe(true)
      expect(existsSync(join(home, 'magic-probe', 'blobs'))).toBe(true)
      store.close()

      // 展开之后进库的已是字面路径——家目录下没有多出来的 `~` 目录
      expect(hasTildeDir(home)).toBe(false)

      // 加载器的展开口径（纯函数，拿真家目录对一次）——库这边只是照字面用
      expect(expandHome('~/.magic', homedir())).toBe(join(homedir(), '.magic'))
      expect(expandHome('~', homedir())).toBe(homedir())
      expect(expandHome('/tmp/字面', homedir())).toBe('/tmp/字面')
    } finally {
      removeDataDir(home)
    }
  })

  test('库自己不展开：字面 `~` ＝一声响，而不是 cwd 下的垃圾目录', () => {
    const home = tempDataDir()
    try {
      expect(() => createRecordsStore({ dataDir: '~/.magic', workspace: ROOTS })).toThrow(/前导/)
      expect(() => createRecordsStore({ dataDir: '~', workspace: ROOTS })).toThrow(/前导/)
      expect(() => createRecordsStore({ dataDir: '  ', workspace: ROOTS })).toThrow(/不得为空/)

      // 坑的样子：静默在 cwd 下造一个名为 `~` 的目录——此处必须没有
      expect(hasTildeDir(process.cwd())).toBe(false)
      expect(existsSync(join(home, '.magic'))).toBe(false)
    } finally {
      removeDataDir(home)
    }
  })

  test('数据目录不存在即建（含中间层级）', () => {
    const root = tempDataDir()
    const dir = join(root, 'nested', 'deeper', 'magic')

    try {
      const store = createRecordsStore({ dataDir: dir, workspace: ROOTS })
      expect(existsSync(databasePathOf(dir))).toBe(true)
      expect(existsSync(join(dir, 'blobs'))).toBe(true)
      store.close()

      // 库是二进制文件，但页头带着 SQLite 的魔数——落对了地方
      expect(readFileSync(databasePathOf(dir)).subarray(0, 15).toString()).toBe('SQLite format 3')
    } finally {
      removeDataDir(root)
    }
  })
})
