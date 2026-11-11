/**
 * 执行状态与恢复索引——`runs` / `run_journal`。
 *
 * 它们**不是会话事实**：Turn / Step / 记录才是。`runs` 只回答「哪个执行者、什么状态、
 * 什么时候起止」；`run_journal` 是恢复用的追加流水。唯一写者是数据服务（本模块）。
 */
import type { Database } from 'bun:sqlite'
import type { RunId, SessionId, StepId, Timestamp, TurnId } from '@magic/contracts'
import { RUNS_TABLE, RUN_JOURNAL_TABLE } from './schema.ts'

export type RunState = 'starting' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'idle' | 'failed'

export type RunRecord = {
  readonly id: RunId
  readonly pid?: number
  readonly socket?: string
  readonly session?: SessionId
  readonly turn?: TurnId
  readonly step?: StepId
  readonly state: RunState
  readonly startedAt: Timestamp
  readonly updatedAt: Timestamp
  readonly endedAt?: Timestamp
  readonly stopReason?: string
  readonly exitCode?: number
  readonly background?: boolean
  readonly generation?: number
}

export type RunJournalEntry = {
  readonly run: RunId
  readonly seq: number
  readonly at: Timestamp
  readonly kind: string
  readonly data?: unknown
}

export type RunRecords = {
  /** 插入或更新；同一 `id` 以最后一次为准。 */
  upsert(record: RunRecord): void
  /** 收束一次执行（幂等；已结束的不再改）。 */
  finish(id: RunId, input: { state: RunState; at: Timestamp; stopReason?: string; exitCode?: number }): void
  get(id: RunId): RunRecord | undefined
  list(session?: SessionId): readonly RunRecord[]
  /** 追加一条恢复流水（`seq` 按 run 递增）。 */
  journal(entry: RunJournalEntry): void
  readJournal(run: RunId): readonly RunJournalEntry[]
}

type RunRow = {
  id: string
  pid: number | null
  socket: string | null
  session: string | null
  turn_id: number | null
  step_id: number | null
  state: string
  started_at: number
  updated_at: number
  ended_at: number | null
  stop_reason: string | null
  exit_code: number | null
  background: number
  generation: number
}

function ofRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.socket === null ? {} : { socket: row.socket }),
    ...(row.session === null ? {} : { session: row.session }),
    ...(row.turn_id === null ? {} : { turn: row.turn_id }),
    ...(row.step_id === null ? {} : { step: row.step_id }),
    state: row.state as RunState,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.stop_reason === null ? {} : { stopReason: row.stop_reason }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    ...(row.background === 1 ? { background: true } : {}),
    ...(row.generation === 0 ? {} : { generation: row.generation }),
  }
}

export function createRunRecords(db: Database): RunRecords {
  const upsert = db.query<never, Record<string, string | number | null>>(
    `INSERT INTO ${RUNS_TABLE}
       (id, pid, socket, session, turn_id, step_id, state, started_at, updated_at, ended_at, stop_reason, exit_code, background, generation)
     VALUES ($id, $pid, $socket, $session, $turn, $step, $state, $startedAt, $updatedAt, $endedAt, $stopReason, $exitCode, $background, $generation)
     ON CONFLICT(id) DO UPDATE SET
       pid=excluded.pid, socket=excluded.socket, session=excluded.session, turn_id=excluded.turn_id,
       step_id=excluded.step_id, state=excluded.state, updated_at=excluded.updated_at,
       ended_at=excluded.ended_at, stop_reason=excluded.stop_reason, exit_code=excluded.exit_code,
       background=excluded.background, generation=excluded.generation`,
  )
  const finish = db.query<never, [string, number, number, string | null, number | null, string]>(
    `UPDATE ${RUNS_TABLE} SET state=?, ended_at=?, updated_at=?, stop_reason=?, exit_code=?
      WHERE id=? AND ended_at IS NULL`,
  )
  const selectOne = db.query<RunRow, [string]>(`SELECT * FROM ${RUNS_TABLE} WHERE id=?`)
  const selectAll = db.query<RunRow, []>(`SELECT * FROM ${RUNS_TABLE} ORDER BY started_at, id`)
  const selectBySession = db.query<RunRow, [string]>(`SELECT * FROM ${RUNS_TABLE} WHERE session=? ORDER BY started_at, id`)
  const maxSeq = db.query<{ seq: number }, [string]>(`SELECT COALESCE(MAX(seq),0) AS seq FROM ${RUN_JOURNAL_TABLE} WHERE run=?`)
  const insertJournal = db.query<never, [string, number, number, string, string | null]>(
    `INSERT INTO ${RUN_JOURNAL_TABLE} (run, seq, at, kind, data) VALUES (?, ?, ?, ?, ?)`,
  )
  const selectJournal = db.query<{ run: string; seq: number; at: number; kind: string; data: string | null }, [string]>(
    `SELECT run, seq, at, kind, data FROM ${RUN_JOURNAL_TABLE} WHERE run=? ORDER BY seq`,
  )

  return {
    upsert(record) {
      upsert.run({
        $id: record.id,
        $pid: record.pid ?? null,
        $socket: record.socket ?? null,
        $session: record.session ?? null,
        $turn: record.turn ?? null,
        $step: record.step ?? null,
        $state: record.state,
        $startedAt: record.startedAt,
        $updatedAt: record.updatedAt,
        $endedAt: record.endedAt ?? null,
        $stopReason: record.stopReason ?? null,
        $exitCode: record.exitCode ?? null,
        $background: record.background === true ? 1 : 0,
        $generation: record.generation ?? 0,
      })
    },
    finish(id, input) {
      finish.run(input.state, input.at, input.at, input.stopReason ?? null, input.exitCode ?? null, id)
    },
    get(id) {
      const row = selectOne.get(id)
      return row === null ? undefined : ofRow(row)
    },
    list(session) {
      return (session === undefined ? selectAll.all() : selectBySession.all(session)).map(ofRow)
    },
    journal(entry) {
      const seq = (maxSeq.get(entry.run)?.seq ?? 0) + 1
      insertJournal.run(entry.run, seq, entry.at, entry.kind, entry.data === undefined ? null : JSON.stringify(entry.data))
    },
    readJournal(run) {
      return selectJournal.all(run).map(row => ({
        run: row.run,
        seq: row.seq,
        at: row.at,
        kind: row.kind,
        ...(row.data === null ? {} : { data: JSON.parse(row.data) as unknown }),
      }))
    },
  }
}
