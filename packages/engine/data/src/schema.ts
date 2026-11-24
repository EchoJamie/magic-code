/**
 * 记录库 schema v2——一次建齐，只认新库。
 *
 * 0.2.0 不迁移旧库：启动前由 `bootstrap.ts` 备份并移走 `records.db`；本文件遇到
 * 已有表但没有 `schema_version = 2` 的库直接拒绝，不 ALTER、不补列、不双读。
 *
 * 列口径以《0.2.0 迁移执行计划》§2 为准：
 * - `turns`：id、session、seq、status、started_at、ended_at、run、generation；
 * - `steps`：id、turn、seq、status、started_at、ended_at、provider、model；
 * - `entries`：正文与引用，`turn_id`；
 * - `events`：turn_id、step_id、generation；
 * - `inputs`：待提交输入，`turn`；
 * - `attention_items`：未读/通知；
 * - `records_meta`：schema_version = 2、next_id；
 * - `runs` / `run_journal`：执行状态与恢复索引；
 * - 协作 ledger：ledgers / ledger_members / ledger_entries / ledger_refs。
 */
import type { Database } from 'bun:sqlite'

const SCHEMA_VERSION = '2'

export const SESSIONS_TABLE = 'sessions'
export const TURNS_TABLE = 'turns'
export const STEPS_TABLE = 'steps'
export const ENTRIES_TABLE = 'entries'
export const EVENTS_TABLE = 'events'
export const META_TABLE = 'records_meta'
export const ATTENTION_TABLE = 'attention_items'
export const RUNS_TABLE = 'runs'
export const RUN_JOURNAL_TABLE = 'run_journal'

/**
 * 会话工作区列——**建立时锚定的那组根**（JSON 一列）。
 * 归属未记录时为 `NULL`，不从当前工作区推断。
 */
export const SESSION_WORKSPACE_COLUMN = 'workspace'

/** id 空间在 `records_meta` 里的键（预留水位——见 `ids.ts`）。 */
export const NEXT_ID_KEY = 'next_id'
const SCHEMA_VERSION_KEY = 'schema_version'

/** 具名参数——`bun:sqlite` 收 `Record<string, 标量>`。 */
export type NamedParams = Record<string, string | number | null>

const DDL = `
CREATE TABLE IF NOT EXISTS ${SESSIONS_TABLE} (
  id         TEXT    PRIMARY KEY,
  at         INTEGER NOT NULL,
  title      TEXT,
  workspace  TEXT,
  archived   INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE IF NOT EXISTS ${TURNS_TABLE} (
  id         INTEGER NOT NULL,
  session    TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  status     TEXT    NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  run        TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, id),
  UNIQUE(session, seq)
);
CREATE INDEX IF NOT EXISTS turns_by_session ON ${TURNS_TABLE} (session, id);

CREATE TABLE IF NOT EXISTS ${STEPS_TABLE} (
  id         INTEGER NOT NULL,
  turn       INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  status     TEXT    NOT NULL,
  started_at INTEGER,
  ended_at   INTEGER,
  provider   TEXT,
  model      TEXT,
  PRIMARY KEY (turn, id),
  UNIQUE(turn, seq)
);
CREATE INDEX IF NOT EXISTS steps_by_turn ON ${STEPS_TABLE} (turn, id);

CREATE TABLE IF NOT EXISTS ${ENTRIES_TABLE} (
  id            INTEGER PRIMARY KEY,
  session       TEXT    NOT NULL,
  turn_id       INTEGER,
  kind          TEXT    NOT NULL,
  content_kind  TEXT    NOT NULL,
  content_text  TEXT,
  content_blob  TEXT,
  payload       TEXT,
  at            INTEGER NOT NULL,
  source        TEXT
);
CREATE INDEX IF NOT EXISTS entries_by_session ON ${ENTRIES_TABLE} (session, id);
CREATE INDEX IF NOT EXISTS entries_by_turn ON ${ENTRIES_TABLE} (turn_id, id);
-- 会话目录的 at 取自每会话最新条目（相关子查询 MAX(e.at)）——
-- 只有 (session, at) 索引能让它从「扫全会话条目」变索引定位。
CREATE INDEX IF NOT EXISTS entries_by_session_at ON ${ENTRIES_TABLE} (session, at);

CREATE TABLE IF NOT EXISTS ${EVENTS_TABLE} (
  id         INTEGER PRIMARY KEY,
  session    TEXT    NOT NULL,
  turn_id    INTEGER,
  step_id    INTEGER,
  generation INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  data       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_session ON ${EVENTS_TABLE} (session, id);
CREATE INDEX IF NOT EXISTS events_by_turn ON ${EVENTS_TABLE} (turn_id, id);
-- 按 kind 取材的读面（tool.decision 历史累计、latestEvent 的 kind 过滤）——
-- 无此索引时这些查询全表扫 events，且都发生在共享事件循环上。
CREATE INDEX IF NOT EXISTS events_by_kind ON ${EVENTS_TABLE} (kind, id);

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

CREATE TABLE IF NOT EXISTS ${RUNS_TABLE} (
  id          TEXT    PRIMARY KEY,
  pid         INTEGER,
  proc_started_at INTEGER,
  socket      TEXT,
  session     TEXT,
  turn_id     INTEGER,
  step_id     INTEGER,
  state       TEXT    NOT NULL,
  started_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  stop_reason TEXT,
  exit_code   INTEGER,
  background  INTEGER NOT NULL DEFAULT 0 CHECK (background IN (0, 1)),
  generation  INTEGER NOT NULL DEFAULT 0,
  workspace   TEXT,
  kind        TEXT,
  last_turn   TEXT,
  owned       TEXT
);
CREATE INDEX IF NOT EXISTS runs_by_session ON ${RUNS_TABLE} (session, started_at DESC);

CREATE TABLE IF NOT EXISTS ${RUN_JOURNAL_TABLE} (
  id    INTEGER PRIMARY KEY,
  run   TEXT    NOT NULL,
  seq   INTEGER NOT NULL,
  at    INTEGER NOT NULL,
  kind  TEXT    NOT NULL,
  data  TEXT,
  UNIQUE(run, seq)
);
CREATE INDEX IF NOT EXISTS journal_by_run ON ${RUN_JOURNAL_TABLE} (run, seq);

-- 协作账本：独立记录流；成员会话用自己的记录流引用账本条目。
CREATE TABLE IF NOT EXISTS ledgers (
  id            TEXT PRIMARY KEY,
  origin_session TEXT NOT NULL UNIQUE,
  title         TEXT,
  data          TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE TABLE IF NOT EXISTS ledger_members (
  ledger     TEXT    NOT NULL,
  session    TEXT    NOT NULL,
  id         TEXT,
  role       TEXT,
  data       TEXT    NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (ledger, session)
);
CREATE UNIQUE INDEX IF NOT EXISTS ledger_members_by_id ON ledger_members(id);
CREATE INDEX IF NOT EXISTS ledger_members_by_session ON ledger_members(session);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id       INTEGER PRIMARY KEY,
  ledger   TEXT    NOT NULL,
  seq      INTEGER NOT NULL,
  actor    TEXT,
  turn_id  INTEGER,
  kind     TEXT    NOT NULL,
  at       INTEGER NOT NULL,
  data     TEXT    NOT NULL,
  UNIQUE (ledger, seq)
);
CREATE INDEX IF NOT EXISTS ledger_entries_by_ledger ON ledger_entries (ledger, id);
CREATE INDEX IF NOT EXISTS ledger_entries_by_kind ON ledger_entries (ledger, kind, id);

-- 收件（原 inbox）：账本条目发给某成员后的送达/消费状态。
CREATE TABLE IF NOT EXISTS ledger_deliveries (
  position     INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient    TEXT    NOT NULL,
  ledger_entry INTEGER NOT NULL,
  state        TEXT    NOT NULL DEFAULT 'pending',
  entry        INTEGER,
  consumed_at  INTEGER,
  included_at  INTEGER,
  UNIQUE(recipient, ledger_entry)
);
CREATE INDEX IF NOT EXISTS ledger_deliveries_by_recipient ON ledger_deliveries(recipient, position);

-- 幂等操作结果（原 operations）。
CREATE TABLE IF NOT EXISTS ledger_operations (
  id     TEXT PRIMARY KEY,
  actor  TEXT NOT NULL,
  kind   TEXT NOT NULL,
  result TEXT NOT NULL
);

-- 一个成员只许一条已接受的委派。
CREATE UNIQUE INDEX IF NOT EXISTS ledger_one_accepted_delegation
  ON ledger_entries(json_extract(data, '$.assigneeId'))
  WHERE kind='delegation' AND json_extract(data, '$.state')='accepted';

CREATE TABLE IF NOT EXISTS ledger_refs (
  entry         INTEGER NOT NULL,
  ledger_entry  INTEGER NOT NULL,
  PRIMARY KEY (entry, ledger_entry)
);
CREATE INDEX IF NOT EXISTS ledger_refs_by_ledger_entry ON ledger_refs (ledger_entry);
`

export function initSchema(db: Database, databasePath: string): void {
  db.transaction(() => {
    const tables = db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all()

    if (tables.length === 0) {
      db.exec(DDL)
      db.query(`INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)`).run(SCHEMA_VERSION_KEY, SCHEMA_VERSION)
      return
    }

    const meta = tables.some(table => table.name === META_TABLE)
      ? db.query<{ value: string }, [string]>(`SELECT value FROM ${META_TABLE} WHERE key = ?`).get(SCHEMA_VERSION_KEY)
      : null
    if (meta?.value !== SCHEMA_VERSION) {
      throw new Error(`记录库结构不符：需要 schema ${SCHEMA_VERSION} 的新库；不自动重建：${databasePath}`)
    }
    // 已确认是新库：补齐本 schema 内新增的表（仍不 ALTER 旧列）。
    db.exec(DDL)
    assertColumns(db, SESSIONS_TABLE, ['id', 'at', 'title', 'workspace', 'archived'], databasePath)
    assertColumns(db, ENTRIES_TABLE, ['id', 'session', 'turn_id', 'kind', 'content_kind', 'content_text', 'content_blob', 'payload', 'at', 'source'], databasePath)
    assertColumns(db, EVENTS_TABLE, ['id', 'session', 'turn_id', 'step_id', 'generation', 'at', 'kind', 'data'], databasePath)
    assertColumns(db, ATTENTION_TABLE, ['id', 'session', 'kind', 'fact', 'at', 'detail', 'source', 'unread', 'delivered'], databasePath)
  }).immediate()
}

function assertColumns(db: Database, table: string, required: readonly string[], databasePath: string): void {
  const columns = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name))
  if (required.some(column => !columns.has(column))) {
    throw new Error(`记录库结构不符：${table} 缺少 schema ${SCHEMA_VERSION} 的字段；不自动重建：${databasePath}`)
  }
}

/** 只读校验：旧库或半建库直接拒绝，读侧不猜结构。 */
export function assertCurrentSchema(db: Database, databasePath: string): void {
  let row: { value: string } | null = null
  try {
    row = db.query<{ value: string }, [string]>(
      `SELECT value FROM ${META_TABLE} WHERE key = ?`,
    ).get(SCHEMA_VERSION_KEY)
  } catch {
    // 连元数据表都没有——旧库 / 半建库，与版本不符同一结果。
  }
  if (row?.value !== SCHEMA_VERSION) {
    throw new Error(`记录库结构不符：需要 schema ${SCHEMA_VERSION} 的新库；不自动重建：${databasePath}`)
  }
}
