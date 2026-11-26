/**
 * 执行状态与恢复索引——`runs` / `run_journal`。
 *
 * 它们**不是会话事实**：Turn / Step / 记录才是。`runs` 只回答「哪个执行者、什么状态、
 * 什么时候起止」；`run_journal` 是恢复用的追加流水。唯一写者是数据服务（本模块）。
 */
import type { Database } from 'bun:sqlite'
import type { BlockedState, RunId, SessionId, StepId, Timestamp, TurnId } from '@magic/contracts'
import { RUNS_TABLE, RUN_JOURNAL_TABLE } from './schema.ts'

export type RunState = 'starting' | 'running' | 'waiting' | 'stopping' | 'stopped' | 'idle' | 'failed'

export type RunRecord = {
  readonly id: RunId
  readonly pid?: number
  readonly procStartedAt?: number
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
  readonly workspace?: readonly string[]
  readonly kind?: string
  readonly lastTurn?: string
  readonly owned?: unknown
  /** 阻塞态（账本三字段的形状：kind/by/since；engine 写，重启后计时保留——P33）。 */
  readonly blocked?: BlockedState
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
  /** 以这一份为全量快照替换（运行登记文件的原语义）。 */
  replaceAll(records: readonly RunRecord[]): void
  /** 收束一次执行（幂等；已结束的不再改）。 */
  finish(id: RunId, input: { state: RunState; at: Timestamp; stopReason?: string; exitCode?: number }): void
  /**
   * 阻塞态定向更新（进入写、退出清 `undefined`）——不经全量 upsert，避免把并发更新
   * 的其它列覆盖回旧值（§3.1：blocked 三字段落账本，重启后计时保留）。
   *
   * 两层关系：协作账本（ledgers/ledger_deliveries）是**等认收等事实的持久源**——
   * delivered 未 received、pending 未消费的权威事实在那；`runs.blocked` 是**投影面向
   * 的当前阻塞**——engine 从账本事实推出「此刻在等什么」，写进这一槽给 TUI/App 读
   * （单槽，并存按 state.ts 的优先级取最高者）。账本是源，这一槽是面；面由源推出，
   * 不反向。
   */
  setBlocked(id: RunId, blocked: BlockedState | undefined, at?: Timestamp): void
  get(id: RunId): RunRecord | undefined
  list(session?: SessionId): readonly RunRecord[]
  /** 追加一条恢复流水（`seq` 按 run 递增）。 */
  journal(entry: RunJournalEntry): void
  readJournal(run: RunId): readonly RunJournalEntry[]
}

type RunRow = {
  id: string
  pid: number | null
  proc_started_at: number | null
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
  workspace: string | null
  kind: string | null
  last_turn: string | null
  owned: string | null
  blocked_kind: string | null
  blocked_by: string | null
  blocked_since: number | null
}

function ofRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.proc_started_at === null ? {} : { procStartedAt: row.proc_started_at }),
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
    ...(row.workspace === null ? {} : { workspace: JSON.parse(row.workspace) as readonly string[] }),
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.last_turn === null ? {} : { lastTurn: row.last_turn }),
    ...(row.owned === null ? {} : { owned: JSON.parse(row.owned) as unknown }),
    ...(row.blocked_kind === null ? {} : { blocked: { kind: row.blocked_kind, ...(row.blocked_by === null ? {} : { by: row.blocked_by }), since: row.blocked_since ?? 0 } as BlockedState }),
  }
}

export function createRunRecords(db: Database): RunRecords {
  const upsert = db.query<never, Record<string, string | number | null>>(
    `INSERT INTO ${RUNS_TABLE}
       (id, pid, proc_started_at, socket, session, turn_id, step_id, state, started_at, updated_at, ended_at, stop_reason, exit_code, background, generation, workspace, kind, last_turn, owned, blocked_kind, blocked_by, blocked_since)
     VALUES ($id, $pid, $procStartedAt, $socket, $session, $turn, $step, $state, $startedAt, $updatedAt, $endedAt, $stopReason, $exitCode, $background, $generation, $workspace, $kind, $lastTurn, $owned, $blockedKind, $blockedBy, $blockedSince)
     ON CONFLICT(id) DO UPDATE SET
       pid=excluded.pid, proc_started_at=excluded.proc_started_at, socket=excluded.socket, session=excluded.session, turn_id=excluded.turn_id,
       step_id=excluded.step_id, state=excluded.state, updated_at=excluded.updated_at,
       ended_at=excluded.ended_at, stop_reason=excluded.stop_reason, exit_code=excluded.exit_code,
       background=excluded.background, generation=excluded.generation,
       workspace=excluded.workspace, kind=excluded.kind, last_turn=excluded.last_turn, owned=excluded.owned,
       blocked_kind=excluded.blocked_kind, blocked_by=excluded.blocked_by, blocked_since=excluded.blocked_since`,
  )
  const clear = db.query('DELETE FROM ' + RUNS_TABLE)
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
  const updateBlocked = db.query<never, [string | null, string | null, number | null, number, string]>(
    `UPDATE ${RUNS_TABLE} SET blocked_kind=?, blocked_by=?, blocked_since=?, updated_at=? WHERE id=?`,
  )

  const upsertRecord = (record: RunRecord): void => {
      upsert.run({
        $id: record.id,
        $pid: record.pid ?? null,
        $procStartedAt: record.procStartedAt ?? null,
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
        $workspace: record.workspace === undefined ? null : JSON.stringify(record.workspace),
        $kind: record.kind ?? null,
        $lastTurn: record.lastTurn ?? null,
        $owned: record.owned === undefined ? null : JSON.stringify(record.owned),
        $blockedKind: record.blocked?.kind ?? null,
        $blockedBy: record.blocked?.by ?? null,
        $blockedSince: record.blocked?.since ?? null,
      })
  }

  return {
    replaceAll(records) {
      db.transaction(() => { clear.run(); for (const record of records) upsertRecord(record) }).immediate()
    },
    upsert(record) { upsertRecord(record) },
    finish(id, input) {
      finish.run(input.state, input.at, input.at, input.stopReason ?? null, input.exitCode ?? null, id)
    },
    setBlocked(id, blocked, at = Date.now()) {
      updateBlocked.run(blocked?.kind ?? null, blocked?.by ?? null, blocked?.since ?? null, at, id)
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
