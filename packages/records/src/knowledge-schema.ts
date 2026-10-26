import type { Database } from 'bun:sqlite'

/** 与会话共用 records.db；检索表只保存可重建的投影。 */
export function initKnowledgeSchema(db: Database): void {
  db.transaction(() => {
    const rebuild = db.query("SELECT 1 FROM sqlite_master WHERE name='knowledge_search'").get() === null
    db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      topic TEXT NOT NULL,
      terms TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      conditions TEXT NOT NULL,
      basis TEXT NOT NULL,
      status TEXT NOT NULL,
      revision INTEGER NOT NULL,
      sources TEXT NOT NULL,
      dependencies TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS knowledge_scope ON knowledge(scope, status, topic, id);
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_search USING fts5(
      id UNINDEXED, topic, terms, conclusion, conditions, tokenize='trigram'
    );
    CREATE TABLE IF NOT EXISTS knowledge_forgetting (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      sources TEXT NOT NULL,
      request TEXT NOT NULL UNIQUE,
      expected_revision INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1))
    );
    CREATE TABLE IF NOT EXISTS knowledge_progress (
      session TEXT PRIMARY KEY,
      memory_revision INTEGER NOT NULL,
      items TEXT NOT NULL
    );
    `)
    if (rebuild) db.exec("INSERT INTO knowledge_search(id,topic,terms,conclusion,conditions) SELECT id,topic,terms,conclusion,conditions FROM knowledge WHERE status IN ('active','pending')")
  }).immediate()
}
