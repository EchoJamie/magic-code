/**
 * 协作账本（ledger）——独立记录流；成员 Session 自己的记录流用 `ledger_refs` 引用账本。
 *
 * 0.2.0 的新模型：协作不是会话分支，是多个执行者共享一条账本。每个成员仍拥有自己的
 * `entries` / `events`；账本只存协作事实（谁对谁说了什么、委派、约束、等待）。
 *
 * 表形状见 `schema.ts`：`ledgers` / `ledger_members` / `ledger_entries` / `ledger_refs`。
 * 写入唯一经本模块（data-service 是记录与账本的唯一写者）。
 */
import type { Database } from 'bun:sqlite'
import type { SessionId, Timestamp, TurnId } from '@magic/contracts'
import { randomUUID } from 'node:crypto'

export type LedgerId = string
type LedgerEntryId = number

export type Ledger = {
  readonly id: LedgerId
  readonly originSession: SessionId
  readonly title?: string
  readonly createdAt: Timestamp
  readonly archived: boolean
}

export type LedgerMember = {
  readonly ledger: LedgerId
  readonly session: SessionId
  readonly role?: string
  readonly joinedAt: Timestamp
}

export type LedgerEntry = {
  readonly id: LedgerEntryId
  readonly ledger: LedgerId
  readonly seq: number
  readonly actor?: string
  readonly turn?: TurnId
  readonly kind: string
  readonly at: Timestamp
  readonly data: unknown
}

export type LedgerRecords = {
  create(input: { originSession: SessionId; at: Timestamp; title?: string }): Ledger
  get(id: LedgerId): Ledger | undefined
  addMember(input: LedgerMember): void
  members(ledger: LedgerId): readonly LedgerMember[]
  append(input: Omit<LedgerEntry, 'id' | 'seq'>): LedgerEntry
  entries(ledger: LedgerId): readonly LedgerEntry[]
  /** 成员记录引用账本条目（一条入口可引用多条账本事实）。 */
  reference(entry: number, ledgerEntry: LedgerEntryId): void
  refsOf(entry: number): readonly LedgerEntryId[]
}

type LedgerRow = { id: string; origin_session: string; title: string | null; created_at: number; archived: number }
type MemberRow = { ledger: string; session: string; role: string | null; joined_at: number }
type EntryRow = { id: number; ledger: string; seq: number; actor: string | null; turn_id: number | null; kind: string; at: number; data: string }

function ledgerOf(row: LedgerRow): Ledger {
  return {
    id: row.id,
    originSession: row.origin_session,
    ...(row.title === null ? {} : { title: row.title }),
    createdAt: row.created_at,
    archived: row.archived === 1,
  }
}

function entryOf(row: EntryRow): LedgerEntry {
  return {
    id: row.id,
    ledger: row.ledger,
    seq: row.seq,
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.turn_id === null ? {} : { turn: row.turn_id }),
    kind: row.kind,
    at: row.at,
    data: JSON.parse(row.data) as unknown,
  }
}

export function createLedgerRecords(db: Database): LedgerRecords {
  const insertLedger = db.query<never, [string, string, string | null, string, number]>(
    'INSERT INTO ledgers (id, origin_session, title, data, created_at) VALUES (?, ?, ?, ?, ?)',
  )
  const selectLedger = db.query<LedgerRow, [string]>('SELECT * FROM ledgers WHERE id=?')
  const insertMember = db.query<never, [string, string, string | null, string | null, string, number]>(
    `INSERT INTO ledger_members (ledger, session, id, role, data, joined_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ledger, session) DO UPDATE SET role=excluded.role, data=excluded.data`,
  )
  const selectMembers = db.query<MemberRow, [string]>('SELECT * FROM ledger_members WHERE ledger=? ORDER BY joined_at, session')
  const maxSeq = db.query<{ seq: number }, [string]>('SELECT COALESCE(MAX(seq),0) AS seq FROM ledger_entries WHERE ledger=?')
  const insertEntry = db.query<{ id: number }, [string, number, string | null, number | null, string, number, string]>(
    `INSERT INTO ledger_entries (ledger, seq, actor, turn_id, kind, at, data)
     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  )
  const selectEntries = db.query<EntryRow, [string]>('SELECT * FROM ledger_entries WHERE ledger=? ORDER BY seq')
  const insertRef = db.query<never, [number, number]>(
    'INSERT INTO ledger_refs (entry, ledger_entry) VALUES (?, ?) ON CONFLICT DO NOTHING',
  )
  const selectRefs = db.query<{ ledger_entry: number }, [number]>(
    'SELECT ledger_entry FROM ledger_refs WHERE entry=? ORDER BY ledger_entry',
  )

  return {
    create(input) {
      const id = randomUUID()
      insertLedger.run(id, input.originSession, input.title ?? null, JSON.stringify({ id, originSession: input.originSession, ...(input.title === undefined ? {} : { title: input.title }), createdAt: input.at, archived: false }), input.at)
      return { id, originSession: input.originSession, ...(input.title === undefined ? {} : { title: input.title }), createdAt: input.at, archived: false }
    },
    get(id) {
      const row = selectLedger.get(id)
      return row === null ? undefined : ledgerOf(row)
    },
    addMember(input) {
      insertMember.run(input.ledger, input.session, null, input.role ?? null, JSON.stringify(input), input.joinedAt)
    },
    members(ledger) {
      return selectMembers.all(ledger).map(row => ({
        ledger: row.ledger,
        session: row.session,
        ...(row.role === null ? {} : { role: row.role }),
        joinedAt: row.joined_at,
      }))
    },
    append(input) {
      const seq = (maxSeq.get(input.ledger)?.seq ?? 0) + 1
      const row = insertEntry.get(input.ledger, seq, input.actor ?? null, input.turn ?? null, input.kind, input.at, JSON.stringify(input.data))
      if (row === null) throw new Error('账本条目未返回编号')
      return { id: row.id, seq, ...input }
    },
    entries(ledger) {
      return selectEntries.all(ledger).map(entryOf)
    },
    reference(entry, ledgerEntry) {
      insertRef.run(entry, ledgerEntry)
    },
    refsOf(entry) {
      return selectRefs.all(entry).map(row => row.ledger_entry)
    },
  }
}
