import type { Database } from 'bun:sqlite'
import type { CoverageRecords, NewEntry, RecordId, SessionId, RecordsService } from '@magic/contracts'

/** 复用 summary 记录表示一次已提交覆盖，不保存笔记正文或另一份准备账本。 */
export function createCoverageRecords(db: Database, session: SessionId, append: (entry: NewEntry) => RecordId,
  events: Pick<RecordsService, 'nextId' | 'appendEvent'>): CoverageRecords {
  const read = () => {
    const row = db.query<{ id: number; covered: number }, [string]>(`SELECT id,json_extract(payload,'$.coveredThrough') AS covered
      FROM entries WHERE session=? AND kind='summary' AND json_extract(payload,'$.notesSaved')=1 AND json_extract(payload,'$.coveredThrough') IS NOT NULL ORDER BY id DESC LIMIT 1`).get(session)
    return { summary: row?.id ?? null, coveredThrough: row?.covered ?? null }
  }
  const publish = db.transaction((input: Parameters<CoverageRecords['publish']>[0]) => {
    if (!input.notesSaved) throw new Error('笔记尚未保存，未提交覆盖')
    const current = read()
    if (current.summary !== input.previousSummary) throw new Error('接续覆盖依据已改变，未提交')
    const row = db.query<{ archived: number }, [string]>(`SELECT COALESCE(root.archived,s.archived) AS archived FROM sessions s
      LEFT JOIN collaboration_agents a ON a.session=s.id LEFT JOIN collaborations c ON c.id=a.collaboration
      LEFT JOIN sessions root ON root.id=c.origin_session WHERE s.id=?`).get(session)
    if (!row || row.archived) throw new Error('会话不存在或已归档，未提交覆盖')
    if (!Number.isSafeInteger(input.through) || input.through <= (current.coveredThrough ?? 0) || input.from > input.through
      || !db.query('SELECT 1 FROM entries WHERE session=? AND id=? AND kind NOT IN (\'continuation\',\'summary\')').get(session, input.through)) throw new Error('接续覆盖范围无效')
    const summary = append({ kind: 'summary', content: { text: '接续材料已保存于本会话工作笔记；通过真实工具读取后继续。' }, at: input.at,
      payload: { from: input.from, coveredThrough: input.through, previousSummary: current.summary, notesSaved: true, sources: [] } })
    if (input.compact) events.appendEvent({ id: events.nextId(), session, turn: null, at: input.at, kind: 'compact.state',
      data: { ...input.compact, accepted: true, state: 'completed', summary, notesSaved: input.notesSaved } })
    return summary
  })
  return { read, publish: input => publish.immediate(input) }
}
