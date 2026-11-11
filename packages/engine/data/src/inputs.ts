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
  reason: string | null
}

export function initInputSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS inputs (
    session TEXT NOT NULL, ref TEXT NOT NULL, body TEXT NOT NULL, purpose TEXT NOT NULL,
    at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending', entry INTEGER, reason TEXT,
    PRIMARY KEY(session,ref)
  )`)
}

export function createInputRecords(
  db: Database,
  session: string,
  append: (entry: NewEntry) => RecordId,
  ensure: (at: number) => void,
): InputRecords {
  const get = (ref: string): StoredInput | undefined => {
    const row = db.query('SELECT * FROM inputs WHERE session=? AND ref=?').get(session, ref) as InputRow | null
    if (row === null) return undefined
    return {
      ref: row.ref,
      input: JSON.parse(row.body),
      purpose: row.purpose,
      at: row.at,
      revision: row.revision,
      state: row.state,
      ...(row.entry === null ? {} : { entry: row.entry }),
      ...(row.reason === null ? {} : { reason: row.reason }),
    }
  }
  const list = (): StoredInput[] =>
    (db.query('SELECT ref FROM inputs WHERE session=? ORDER BY at, rowid').all(session) as { ref: string }[])
      .map(row => get(row.ref)!)

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
    edit(ref, revision, input) {
      return db.query("UPDATE inputs SET body=?,revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state='pending'")
        .run(JSON.stringify({ ...input, ref, purpose: get(ref)?.purpose ?? 'current' }), session, ref, revision).changes === 1
    },
    withdraw(ref, revision) {
      return db.query("UPDATE inputs SET state='withdrawn',revision=revision+1 WHERE session=? AND ref=? AND revision=? AND state='pending'")
        .run(session, ref, revision).changes === 1
    },
    consume(ref, revision, entry) {
      return db.transaction(() => {
        const row = get(ref)
        if (row?.state !== 'pending' || row.revision !== revision) return undefined
        const id = append(entry)
        db.query("UPDATE inputs SET state='consumed',entry=?,revision=revision+1 WHERE session=? AND ref=? AND state='pending'")
          .run(id, session, ref)
        return id
      }).immediate()
    },
    hold(ref, reason) {
      db.query("UPDATE inputs SET reason=? WHERE session=? AND ref=? AND state='pending'").run(reason ?? null, session, ref)
    },
    fail(ref, reason) {
      db.query("UPDATE inputs SET state='failed',reason=?,revision=revision+1 WHERE session=? AND ref=? AND state='pending'")
        .run(reason, session, ref)
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
