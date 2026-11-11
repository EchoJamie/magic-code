/** 按实际结构初始化记录库；只补充字段与表，不重建已有记录。 */
import type { Database } from 'bun:sqlite'

export const SESSIONS_TABLE = 'sessions'
export const ENTRIES_TABLE = 'entries'
export const EVENTS_TABLE = 'events'
export const META_TABLE = 'records_meta'
export const ATTENTION_TABLE = 'attention_items'

/**
 * 会话工作区列（U26）——**建立时锚定的那组根**（JSON 一列，同 `events.data` 的姿势）。
 * 归属未记录时为 `NULL`，不从当前工作区推断。
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
  workspace  TEXT,
  archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
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

CREATE TABLE IF NOT EXISTS ${ATTENTION_TABLE} (
  id         TEXT    PRIMARY KEY NOT NULL,
  session    TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  fact       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  detail     TEXT,
  source     TEXT,
  unread     INTEGER NOT NULL CHECK (unread IN (0, 1)),
  delivered  INTEGER NOT NULL CHECK (delivered IN (0, 1))
);
CREATE INDEX IF NOT EXISTS attention_by_session ON ${ATTENTION_TABLE} (session, at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ${META_TABLE} (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
`

export function initSchema(db: Database, databasePath: string): void {
  db.transaction(() => {
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all()
    if (tables.length > 0 && !tables.some(table => table.name === SESSIONS_TABLE)) {
      throw new Error(`记录库结构不符：已有库缺少会话表；不自动重建：${databasePath}`)
    }
    db.exec(DDL)
    for (const [table, additions] of [
      [SESSIONS_TABLE, { title: 'TEXT', workspace: 'TEXT', archived: 'INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))' }],
      [ATTENTION_TABLE, { source: 'TEXT' }],
    ] as const) {
      const columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name))
      for (const [column, definition] of Object.entries(additions)) {
        if (!columns.has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      }
    }
    assertCurrentSchema(db, databasePath)
  }).immediate()
}

export function assertCurrentSchema(db: Database, databasePath: string): void {
  for (const [table, required] of [
    [SESSIONS_TABLE, ['id', 'at', 'title', 'workspace', 'archived']],
    [ATTENTION_TABLE, ['id', 'session', 'kind', 'fact', 'at', 'detail', 'source', 'unread', 'delivered']],
  ] as const) {
    const columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name))
    if (required.some(column => !columns.has(column))) {
      throw new Error(`记录库结构不符：${table} 缺少当前字段；不自动重建：${databasePath}`)
    }
  }
}
