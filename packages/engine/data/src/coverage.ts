import type { Database } from 'bun:sqlite'
import type { CoverageRecords, NewEntry, RecordId, SessionId, RecordsService } from '@magic/contracts'

/** 复用 summary 记录表示一次已提交覆盖，不保存笔记正文或另一份准备账本。 */
export function createCoverageRecords(db: Database, session: SessionId, append: (entry: NewEntry) => RecordId,
  events: Pick<RecordsService, 'nextId' | 'appendEvent'>): CoverageRecords {
  const pruneKey = `prune_through:${session}`
  const read = () => {
    const row = db.query<{ id: number; covered: number }, [string]>(`SELECT id,json_extract(payload,'$.coveredThrough') AS covered
      FROM entries WHERE session=? AND kind='summary' AND (json_extract(payload,'$.notesSaved')=1 OR json_extract(payload,'$.format')='compaction-v2') AND json_extract(payload,'$.coveredThrough') IS NOT NULL ORDER BY id DESC LIMIT 1`).get(session)
    return { summary: row?.id ?? null, coveredThrough: row?.covered ?? null }
  }
  const readPrunedThrough = () => {
    const row = db.query<{ value: string }, [string]>('SELECT value FROM records_meta WHERE key=?').get(pruneKey)
    if (row === null) return null
    const parsed = Number(row.value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
  }
  const advancePrunedThrough = db.transaction((through: number) => {
    if (!Number.isSafeInteger(through) || through <= 0) return
    const current = readPrunedThrough() ?? 0
    if (through <= current) return
    db.query('INSERT INTO records_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(pruneKey, String(through))
  })
  const publish = db.transaction((input: Parameters<CoverageRecords['publish']>[0]) => {
    const v2 = input.format === 'compaction-v2'
    if (!v2 && !input.notesSaved) throw new Error('笔记尚未保存，未提交覆盖')
    if (v2 && (!input.text || input.text.trim() === '')) throw new Error('压缩交接正文为空，未提交覆盖')
    const current = read()
    if (current.summary !== input.previousSummary) throw new Error('接续覆盖依据已改变，未提交')
    const row = db.query<{ archived: number }, [string]>(`SELECT COALESCE(root.archived,s.archived) AS archived FROM sessions s
      LEFT JOIN ledger_members a ON a.session=s.id LEFT JOIN ledgers c ON c.id=a.ledger
      LEFT JOIN sessions root ON root.id=c.origin_session WHERE s.id=?`).get(session)
    if (!row || row.archived) throw new Error('会话不存在或已归档，未提交覆盖')
    if (!Number.isSafeInteger(input.through) || input.through <= (current.coveredThrough ?? 0) || input.from > input.through
      || !db.query('SELECT 1 FROM entries WHERE session=? AND id=? AND kind NOT IN (\'continuation\',\'summary\')').get(session, input.through)) throw new Error('接续覆盖范围无效')
    const payload = v2
      ? {
          from: input.from, coveredThrough: input.through, previousSummary: current.summary, format: 'compaction-v2' as const,
          ...(input.retainedUsers?.length ? { retainedUsers: [...input.retainedUsers] } : {}),
          sources: [],
        }
      : { from: input.from, coveredThrough: input.through, previousSummary: current.summary, notesSaved: true, brief: input.text !== undefined, sources: [] }
    const summary = append({ kind: 'summary', content: { text: input.text ?? '接续材料已保存于本会话工作笔记；通过真实工具读取后继续。' }, at: input.at, payload })
    if (input.compact) events.appendEvent({ id: events.nextId(), session, turn: null, at: input.at, kind: 'compact.state',
      data: { ...input.compact, accepted: true, state: 'completed', summary, ...(v2 ? {} : { notesSaved: Boolean(input.notesSaved) }) } })
    return summary
  })
  return { read, readPrunedThrough, advancePrunedThrough: through => advancePrunedThrough.immediate(through), publish: input => publish.immediate(input) }
}
