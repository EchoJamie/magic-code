import type { Database } from 'bun:sqlite'

/** 直接扩展当前记录库，不另开库、不建设旧身份迁移链。 */
export function initCollaborationSchema(db: Database): void {
  db.transaction(() => db.exec(`
    CREATE TABLE IF NOT EXISTS collaboration_agents (
      id TEXT PRIMARY KEY, session TEXT NOT NULL UNIQUE, collaboration TEXT, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agents_by_collaboration ON collaboration_agents(collaboration);
    CREATE TABLE IF NOT EXISTS collaborations (
      id TEXT PRIMARY KEY, origin_session TEXT NOT NULL UNIQUE, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_operations (
      id TEXT PRIMARY KEY, actor TEXT NOT NULL, result TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_messages (
      id INTEGER PRIMARY KEY, collaboration TEXT NOT NULL, sender TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_inbox (
      position INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, message INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', entry INTEGER, consumed_at INTEGER, included_at INTEGER,
      UNIQUE(recipient, message)
    );
    CREATE INDEX IF NOT EXISTS inbox_by_recipient ON collaboration_inbox(recipient, position);
    CREATE UNIQUE INDEX IF NOT EXISTS one_message_reference_per_session
      ON entries(session, json_extract(payload, '$.messageId')) WHERE kind='agent-message';
    CREATE TABLE IF NOT EXISTS collaboration_delegations (
      id INTEGER PRIMARY KEY, collaboration TEXT NOT NULL, parent INTEGER, assignee TEXT NOT NULL,
      state TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_accepted_delegation ON collaboration_delegations(assignee) WHERE state = 'accepted';
    CREATE INDEX IF NOT EXISTS delegations_by_parent ON collaboration_delegations(parent);
    CREATE TABLE IF NOT EXISTS collaboration_waits (
      id INTEGER PRIMARY KEY, collaboration TEXT NOT NULL, agent TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_constraints (
      message INTEGER PRIMARY KEY, collaboration TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collaboration_executions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, collaboration TEXT NOT NULL, delegation INTEGER,
      state TEXT NOT NULL, data TEXT NOT NULL
    );
  `)).immediate()
}
