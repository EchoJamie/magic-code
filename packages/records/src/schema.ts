/**
 * 库表与 schema 版本协议（判据 4）。
 *
 * 出处：技术方案 · 记录（存储 · schema 演进）。三表 ＋ 一表内务：
 * - `sessions`——会话（`at` ＝首次写入的时间，不另取时钟；`title` ＝**改过的标题**，U16 加）；
 * - `entries`——条目（内容两列 ＋ 判别列：内联正文 / blob 引用只居其一）；
 * - `events`——事件（信封逐字段落列，`data` 一列 JSON）；
 * - `records_meta`——库内务（当前只有 id 空间的预留水位）。
 *
 * **`user_version` 自始写入**：建库即写 `RECORD_SCHEMA_VERSION`，此后只认这个版本号——
 * 库比程序新则**拒开**（免降级写坏），库比程序旧则**顺序迁移**（冻结点＝阶段 2 末，
 * 此前结构变更＝重建库；**U26 起走迁移链**：0 → 1）。
 *
 * **新库与既有库的分界＝表在不在**（不是版本号）：版本 0 与 SQLite 的默认值同形——
 * 「写没写过」在单点上不可判定，故本协议的实测证据取三处合证：新建即初始化（表在）·
 * 版本超前即拒开 · 重开续写不回头（见 test/schema.test.ts）。
 * 于是 `initSchema` 的分岔也就有了判据：**空文件＝新库**（建表即当前形状，**一步迁移都不走**）；
 * **表在＝既有库**（该补的按版本号顺序补上）。拿版本号当分界会走反：新库的 0 也是「旧」。
 */

import type { Database } from 'bun:sqlite'
import { RECORD_SCHEMA_VERSION } from '@magic/contracts'

export const SESSIONS_TABLE = 'sessions'
export const ENTRIES_TABLE = 'entries'
export const EVENTS_TABLE = 'events'
export const META_TABLE = 'records_meta'

/** 会话标题列（U16）——**改过的标题**存这儿；没改过的缺席（默认标题由对话域现算）。 */
export const SESSION_TITLE_COLUMN = 'title'

/**
 * 会话工作区列（U26）——**建立时锚定的那组根**（JSON 一列，同 `events.data` 的姿势）。
 * 没写过的（列加上之前落账的会话）为 `NULL`——**不补**（见 `ensureSessionWorkspaceColumn`）。
 */
export const SESSION_WORKSPACE_COLUMN = 'workspace'

/** id 空间在 `records_meta` 里的键（预留水位——见 `ids.ts`）。 */
export const NEXT_ID_KEY = 'next_id'

/** 具名参数——`bun:sqlite` 收 `Record<string, 标量>`（`SQLQueryBindings` 的对象支）。 */
export type NamedParams = Record<string, string | number | null>

const DDL = `
CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
  id         TEXT    PRIMARY KEY,
  at         INTEGER NOT NULL,
  title      TEXT,
  workspace  TEXT
);

CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
  id            INTEGER PRIMARY KEY,
  session       TEXT    NOT NULL,
  kind          TEXT    NOT NULL,
  content_kind  TEXT    NOT NULL,
  content_text  TEXT,
  content_blob  TEXT,
  payload       TEXT,
  at            INTEGER NOT NULL,
  source        TEXT
);
CREATE INDEX IF NOT EXISTS entries_by_session ON ${ENTRIES_TABLE} (session, id);

CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
  id       INTEGER PRIMARY KEY,
  session  TEXT    NOT NULL,
  turn     INTEGER,
  at       INTEGER NOT NULL,
  kind     TEXT    NOT NULL,
  data     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON ${EVENTS_TABLE} (session, id);

CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

export function readSchemaVersion(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  return row?.user_version ?? 0
}

/**
 * **顺序迁移链**——下标 ＝ 起始版本，一步进一版（走哪几步由 `user_version` 说了算）。
 *
 * 冻结点＝阶段 2 末（恢复承诺落地）：此前结构变更＝重建库，此后**一律走这条链**
 * （技术方案 · 记录 · schema 演进）。
 *
 * **只增不改 · 步内幂等**：每步只 `ADD COLUMN` / 建索引，不重建表、不搬数据；重跑同一步
 * 与没跑过同效（版本号只在整条链跑完之后推进，中途崩了下次从头跑，不会走到半截的库上）。
 */
const MIGRATIONS: readonly ((db: Database) => void)[] = [
  /**
   * 0 → 1（U26）：**会话归属工作区**——`sessions` 加 `workspace` 列。
   *
   * 顺带把 `title` 一并补齐（U16 那一列）：**版本 0 的库本身有两形**——阶段 1 建的
   * （连 `title` 都没有）与 U16 之后建的（有 `title`，而当时走的是「补齐」、版本号仍写 0）。
   * 两种都是**版本 0 的既有库**，故这一步对 `title` 用幂等探列：缺就补、在不碰。
   */
  (db) => {
    ensureSessionTitleColumn(db)
    ensureSessionWorkspaceColumn(db)
  },
]

/**
 * 建表 ＋ 认版本。幂等（`IF NOT EXISTS`）——重开同一目录不改动已有结构（append-only 不回改）。
 *
 * 两岔（判据＝**表在不在**，见文件头注）：
 * - **新库**——建表即当前形状，**一步迁移都不走**（它的版本号直接写当前那个）；
 * - **既有库**——按版本号把欠的迁移步顺序跑完，再让 DDL 收一次尾（索引等幂等件）。
 */
export function initSchema(db: Database, databasePath: string): void {
  const version = readSchemaVersion(db)

  if (version > RECORD_SCHEMA_VERSION) {
    throw new Error(
      `记录库 schema 较本程序新（user_version=${version} > ${RECORD_SCHEMA_VERSION}）——` +
        `拒绝打开，免降级写坏：${databasePath}`,
    )
  }
  // 既有库才欠迁移——新库的空表不该被当成「版本 0 的老库」（两者的版本号同为 0）
  if (hasSessionsTable(db)) migrate(db, version, databasePath)

  db.exec(DDL)
  db.exec(`PRAGMA user_version = ${RECORD_SCHEMA_VERSION}`)
}

/** 库里有没有 `sessions` 表——**新库 / 既有库的分界**（本程序建的库必有它；空文件没有）。 */
function hasSessionsTable(db: Database): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(SESSIONS_TABLE)

  return row !== null
}

/** 把 `from` 版欠的迁移步顺序跑完——缺步即抛（链断了不能装作到了）。 */
function migrate(db: Database, from: number, databasePath: string): void {
  for (let version = from; version < RECORD_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version]
    if (step === undefined) {
      throw new Error(
        `记录库缺 ${version} → ${version + 1} 的迁移步（本程序到 ${RECORD_SCHEMA_VERSION}）——` +
          `链断了不能装作到了：${databasePath}`,
      )
    }
    step(db)
  }
}

/**
 * **`title` 列的补齐**（U16）——给加列之前建的库补上，数据一件不丢。
 * 现为迁移步 0 → 1 的一半（见 `MIGRATIONS`）：**幂等**（探到列在就什么都不做）·
 * **只增不改**（只 `ADD COLUMN`，不重建表、不搬数据）。
 *
 * 为什么不留「删库重建」那条路当唯一出口：`~/.magic/records.db` 是**用户的真记录**
 * （阶段 1 的联合冒烟就跑在它上面）。为加一列让人删掉全部对话，不合算——
 * 而这条补齐只有五行，代价远小于丢掉的东西。
 *
 * 由头（U02 备案）：「在 `sessions` 表加一列 ＋ 首写时填一次即可，一句话的活」。
 */
function ensureSessionTitleColumn(db: Database): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${SESSIONS_TABLE})`).all()
  if (columns.some((column) => column.name === SESSION_TITLE_COLUMN)) return

  db.exec(`ALTER TABLE ${SESSIONS_TABLE} ADD COLUMN ${SESSION_TITLE_COLUMN} TEXT`)
}

/**
 * **`workspace` 列的补齐**（U26）——同上法（幂等 · 只增不改）。
 *
 * ⚠️ **老行不补归属**：那批会话建立时这一列还不存在，它们属于哪个工作区**无法知道**
 * ——拿「当下的启动目录」顶上去就是编，而这一列正是为了「恢复回到原位、不由当下的启动目录
 * 说了算」才立的。故缺着，读出来即**缺席**（同 `title` 的辨法：可辨的没有 ≠ 空值）。
 */
function ensureSessionWorkspaceColumn(db: Database): void {
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${SESSIONS_TABLE})`).all()
  if (columns.some((column) => column.name === SESSION_WORKSPACE_COLUMN)) return

  db.exec(`ALTER TABLE ${SESSIONS_TABLE} ADD COLUMN ${SESSION_WORKSPACE_COLUMN} TEXT`)
}
