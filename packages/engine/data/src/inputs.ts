import type { Database } from 'bun:sqlite'
import type { InputRecords, NewEntry, RecordId, StoredInput } from '@magic/contracts'

type InputRow = {
  ref: string
  body: string
  purpose: StoredInput['purpose']
  at: number
  revision: number
  state: StoredInput['state']
  entry: number | null
  turn: number | null
  reason: string | null
  failed_from: string | null
  rejected_kind: string | null
}

export function initInputSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inputs (
    session TEXT NOT NULL, ref TEXT NOT NULL, body TEXT NOT NULL, purpose TEXT NOT NULL,
    at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending', entry INTEGER, turn INTEGER, reason TEXT,
    failed_from TEXT, rejected_kind TEXT,
    PRIMARY KEY(session,ref)
  )`)
}

function ofRow(row: InputRow): StoredInput {
  return {
    ref: row.ref,
    input: JSON.parse(row.body),
    purpose: row.purpose,
    at: row.at,
    revision: row.revision,
    state: row.state,
    ...(row.entry === null ? {} : { entry: row.entry }),
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.failed_from === null ? {} : { failedFrom: row.failed_from as 'pending' | 'executing' }),
    ...(row.rejected_kind === null ? {} : { rejectedKind: row.rejected_kind as 'capacity' | 'closing' | 'archived' }),
  }
}

/**
 * 输入七态状态机（边界方案 §五）——**每迁移一个写者**：
 * - 受理/拒收/出队/撤回/失败/重试/并入：engine（本模块，manager 进程持有写权）；
 * - 消费：executor（`consume` 与落条目同一事务，同时写 `turn`——`turn` 只在这一处写，
 *   消费前写 `turn` 的任何路径都违规，见 P2 反向断言）。
 */
export function createInputRecords(
  db: Database,
  session: string,
  append: (entry: NewEntry) => RecordId,
  ensure: (at: number) => void,
): InputRecords {
  const get = (ref: string): StoredInput | undefined => {
    const row = db.query('SELECT * FROM inputs WHERE session=? AND ref=?').get(session, ref) as InputRow | null
    if (row === null) return undefined
    return ofRow(row)
  }
  const list = (): StoredInput[] =>
    (db.query('SELECT ref FROM inputs WHERE session=? ORDER BY at, rowid').all(session) as { ref: string }[])
      .map(one => get(one.ref)!)

  return {
    get,
    list,
    accept(input, at) {
      return db.transaction(() => {
        ensure(at)
        db.query('INSERT INTO inputs(session,ref,body,purpose,at) VALUES (?,?,?,?,?) ON CONFLICT(session,ref) DO NOTHING')
          .run(session, input.ref, JSON.stringify(input), input.purpose ?? 'current', at)
        return get(input.ref)!
      }).immediate()
    },
    /** 受理即拒（容量/closing/archived）：不经 pending 直接落 `rejected` 行，原稿留在账上。 */
    reject(input, reason, at, kind) {
      return db.transaction(() => {
        ensure(at)
        db.query("INSERT INTO inputs(session,ref,body,purpose,at,state,reason,rejected_kind) VALUES (?,?,?,?,?,'rejected',?,?) ON CONFLICT(session,ref) DO NOTHING")
          .run(session, input.ref, JSON.stringify(input), input.purpose ?? 'current', at, reason, kind)
        return get(input.ref)!
      }).immediate()
    },
    edit(ref, revision, input) {
      return db.query("UPDATE inputs SET body=?,revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state='pending'")
        .run(JSON.stringify({ ...input, ref, purpose: get(ref)?.purpose ?? 'current' }), session, ref, revision).changes === 1
    },
    /** pending → withdrawn。**只从 pending**（N18：不存在 executing→withdrawn 迁移）。 */
    withdraw(ref, revision) {
      return db.query("UPDATE inputs SET state='withdrawn',failed_from=NULL,revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state='pending'")
        .run(session, ref, revision).changes === 1
    },
    /** pending → rejected（已受理后拒：closing/archived）。回执 (session,ref) 由调用方发。 */
    rejectPending(ref, reason, kind) {
      return db.query("UPDATE inputs SET state='rejected',reason=?,rejected_kind=?,revision=revision+1 WHERE session=? AND ref=? AND state='pending'")
        .run(reason, kind, session, ref).changes === 1
    },
    /** pending → executing（engine；准入 `beginExecution` 在 dequeue 之前）。 */
    dequeue(ref, revision) {
      return db.query("UPDATE inputs SET state='executing',revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state='pending'")
        .run(session, ref, revision).changes === 1
    },
    consume(ref, revision, entry) {
      return db.transaction(() => {
        const row = get(ref)
        // 合法来源：executing（状态机终版）。pending 是过渡期执行者直通消费的现状路径，
        // 待执行者侧（T2.3）改为「正文从账本读」后收窄为 executing-only。
        if ((row?.state !== 'executing' && row?.state !== 'pending') || row.revision !== revision) return undefined
        const id = append(entry)
        db.query("UPDATE inputs SET state='consumed',entry=?,turn=?,revision=revision+1,failed_from=NULL WHERE session=? AND ref=? AND state IN ('pending','executing')")
          .run(id, entry.turn ?? null, session, ref)
        return id
      }).immediate()
    },
    /** 并入既有条目（队列合并）：行转 consumed 指向已存在的条目，不另落条目；`turn` 由调用方给。 */
    attach(ref, revision, entry, turn) {
      return db.transaction(() => {
        const row = get(ref)
        if ((row?.state !== 'executing' && row?.state !== 'pending') || row.revision !== revision) return false
        db.query("UPDATE inputs SET state='consumed',entry=?,turn=?,revision=revision+1,failed_from=NULL WHERE session=? AND ref=? AND state IN ('pending','executing')")
          .run(entry, turn, session, ref)
        return true
      }).immediate()
    },
    hold(ref, reason) {
      db.query("UPDATE inputs SET reason=? WHERE session=? AND ref=? AND state='pending'").run(reason ?? null, session, ref)
    },
    /** pending/executing → failed；`failedFrom` 记失败前状态（G3/M4：retry 按 it 区分文案）。 */
    fail(ref, reason) {
      db.query("UPDATE inputs SET state='failed',failed_from=state,reason=?,revision=revision+1 WHERE session=? AND ref=? AND state IN ('pending','executing')")
        .run(reason, session, ref)
    },
    /** failed/rejected → pending（用户重试/重发）；清 `failedFrom` 与 `reason`。 */
    retry(ref, revision) {
      return db.query("UPDATE inputs SET state='pending',failed_from=NULL,reason=NULL,revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state IN ('failed','rejected')")
        .run(session, ref, revision).changes === 1
    },
    included(entries) {
      return db.transaction(() => {
        const rows = list().filter(row => row.state === 'consumed' && row.entry !== undefined && entries.includes(row.entry))
        for (const row of rows) {
          db.query("UPDATE inputs SET state='included' WHERE session=? AND ref=? AND state='consumed'").run(session, row.ref)
        }
        return rows
      }).immediate()
    },
  }
}
