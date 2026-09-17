/**
 * 库表与 schema 版本协议（判据 4）。
 *
 * 出处：技术方案 · 记录（存储 · schema 演进）。三表 ＋ 一表内务：
 * - `sessions`——会话（`at` ＝首次写入的时间，不另取时钟）；
 * - `entries`——条目（内容两列 ＋ 判别列：内联正文 / blob 引用只居其一）；
 * - `events`——事件（信封逐字段落列，`data` 一列 JSON）；
 * - `records_meta`——库内务（当前只有 id 空间的预留水位）。
 *
 * **`user_version` 自始写入**：建库即写 `RECORD_SCHEMA_VERSION`，此后只认这个版本号——
 * 库比程序新则**拒开**（免降级写坏），库比程序旧则顺序迁移（冻结点＝阶段 2 末，
 * 此前结构变更＝重建库；当前 `RECORD_SCHEMA_VERSION = 0` 即最低版本，走不到迁移支）。
 *
 * ⚠️ 版本 0 与 SQLite 默认值同形——「写没写过」在单点上不可判定，故本协议的实测证据取
 * 三处合证：新建即初始化（表在）· 版本超前即拒开 · 重开续写不回头（见 test/schema.test.ts）。
 */

import type { Database } from 'bun:sqlite'
import { RECORD_SCHEMA_VERSION } from '@magic/contracts'

export const SESSIONS_TABLE = 'sessions'
export const ENTRIES_TABLE = 'entries'
export const EVENTS_TABLE = 'events'
export const META_TABLE = 'records_meta'

/** id 空间在 `records_meta` 里的键（预留水位——见 `ids.ts`）。 */
export const NEXT_ID_KEY = 'next_id'

/** 具名参数——`bun:sqlite` 收 `Record<string, 标量>`（`SQLQueryBindings` 的对象支）。 */
export type NamedParams = Record<string, string | number | null>

const DDL = `
CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
  id  TEXT    PRIMARY KEY,
  at  INTEGER NOT NULL
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
 * 建表 ＋ 认版本。幂等（`IF NOT EXISTS`）——重开同一目录不改动已有结构（append-only 不回改）。
 */
export function initSchema(db: Database, databasePath: string): void {
  const version = readSchemaVersion(db)

  if (version > RECORD_SCHEMA_VERSION) {
    throw new Error(
      `记录库 schema 较本程序新（user_version=${version} > ${RECORD_SCHEMA_VERSION}）——` +
        `拒绝打开，免降级写坏：${databasePath}`,
    )
  }
  if (version < RECORD_SCHEMA_VERSION) {
    throw new Error(
      `记录库 schema 待顺序迁移（user_version=${version} → ${RECORD_SCHEMA_VERSION}）——` +
        `迁移归阶段 2（冻结点＝阶段 2 末；此前结构变更＝重建库）：${databasePath}`,
    )
  }

  db.exec(DDL)
  db.exec(`PRAGMA user_version = ${RECORD_SCHEMA_VERSION}`)
}
