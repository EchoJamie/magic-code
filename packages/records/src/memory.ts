import type { Database } from 'bun:sqlite'
import type { KnowledgeReference, MemoryRecords, MemorySnapshot, MemorySource, MemoryUpdate, MemoryWriteResult, NewEntry, RecordId, SessionId } from '@magic/contracts'
import { independentUserBody, knowledgeReferenceProblem, mergeKnowledgeReferences, sourceKnowledgeReferences, sourcePartExists, userBodySource } from './knowledge-memory.ts'

type Row = { revision: number; items: string; inspected_through: number | null; summary: number | null; covered_through: number | null }

export function createMemoryRecords(db: Database, session: SessionId, append: (entry: NewEntry) => RecordId,
  events: Pick<import('@magic/contracts').RecordsService, 'nextId' | 'appendEvent'>): MemoryRecords {
  const select = db.query<Row, [string]>('SELECT * FROM working_memory WHERE session=?')
  function read(): MemorySnapshot {
    const row = select.get(session)
    return { session, revision: row?.revision ?? 0, items: row ? JSON.parse(row.items) : [], inspectedThrough: row?.inspected_through ?? null, summary: row?.summary ?? null, coveredThrough: row?.covered_through ?? null }
  }
  function save(value: MemorySnapshot): void {
    db.query('INSERT INTO working_memory VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session) DO UPDATE SET revision=excluded.revision, items=excluded.items, inspected_through=excluded.inspected_through, summary=excluded.summary, covered_through=excluded.covered_through')
      .run(session, value.revision, JSON.stringify(value.items), value.inspectedThrough, value.summary, value.coveredThrough)
  }
  function sourceExists(source: MemorySource, knowledge: readonly KnowledgeReference[] = []): boolean {
    if (source === null || typeof source !== 'object' || !Number.isSafeInteger(source.entry) || source.entry < 1
      || db.query('SELECT 1 FROM entries WHERE session=? AND id=?').get(source.session, source.entry) === null) return false
    if (source.offset !== undefined && (!Number.isSafeInteger(source.offset) || source.offset < 0)) return false
    if (!sourcePartExists(db, source)) return false
    if (source.session === session) return true
    const referenced = db.query(`SELECT 1 FROM inputs i,json_each(i.body,'$.refs') r
      WHERE i.session=? AND i.state IN ('consumed','included') AND json_extract(r.value,'$.kind')='session'
      AND json_extract(r.value,'$.source')=? AND json_extract(r.value,'$.through')>=? LIMIT 1`).get(session, source.session, source.entry)
    if (referenced !== null) return true
    // 引用知识本身已通过范围/修订检查；它只授予列出的具体证据。
    return knowledge.some(reference => {
      const row = db.query<{ sources: string }, [string, string]>("SELECT sources FROM knowledge WHERE id=? AND (scope='user' OR scope=(SELECT workspace FROM sessions WHERE id=?))").get(reference.id, session)
      return row !== null && (JSON.parse(row.sources) as MemorySource[]).some(allowed => allowed.session === source.session && allowed.entry === source.entry
        && allowed.part === source.part && (source.offset ?? 0) >= (allowed.offset ?? 0))
    })
  }
  function writable(): boolean {
    const row = db.query<{ archived: number }, [string]>(`SELECT COALESCE(root.archived,s.archived) AS archived FROM sessions s
      LEFT JOIN collaboration_agents a ON a.session=s.id LEFT JOIN collaborations c ON c.id=a.collaboration
      LEFT JOIN sessions root ON root.id=c.origin_session WHERE s.id=?`).get(session)
    return row !== null && row.archived === 0
  }
  function refused(snapshot: MemorySnapshot, reason: string): MemoryWriteResult { return { ok: false, snapshot, reason } }
  const update = db.transaction((input: MemoryUpdate): MemoryWriteResult => {
    const current = read()
    if (!writable()) return refused(current, '会话不存在或已归档')
    if (input.expectedRevision !== current.revision) return refused(current, '工作记忆修订冲突，请读回最新版本')
    if (input.inspectedThrough !== undefined && (input.inspectedThrough < (current.inspectedThrough ?? 0) || !sourceExists({ session, entry: input.inspectedThrough }))) return refused(current, '整理位置不存在或倒退')
    const items = new Map(current.items.map(item => [item.id, item]))
    const seen = new Set<string>()
    for (const requested of input.changes) {
      if (!Array.isArray(requested.sources)) return refused(current, '事项来源须为数组')
      const inherited = sourceKnowledgeReferences(db, requested.sources)
      const change = inherited.length === 0 && requested.knowledge === undefined ? requested
        : { ...requested, knowledge: mergeKnowledgeReferences([...(requested.knowledge ?? []), ...inherited]) }
      if (!change.id?.trim() || !change.text?.trim() || seen.has(change.id)) return refused(current, '事项身份/正文无效或重复')
      if (!['goal', 'requirement', 'fact', 'decision', 'question', 'step', 'verification'].includes(change.kind)
        || !['fact', 'hypothesis', 'unresolved'].includes(change.evidence) || !['active', 'resolved', 'invalid'].includes(change.status)) return refused(current, '事项类别或状态无效')
      if (!Array.isArray(change.sources) || change.sources.length === 0 || change.sources.some(source => !sourceExists(source, change.knowledge))) return refused(current, '来源不存在或未获本会话、明确引用或知识具体证据授权；协作材料须引用获准收件条目')
      const referenceProblem = knowledgeReferenceProblem(db, session, change.knowledge, change.evidence !== 'fact', inherited)
      if (referenceProblem !== undefined) return refused(current, referenceProblem)
      if ((change.kind === 'goal' || change.kind === 'requirement') && !change.sources.some(source => independentUserBody(db, source))
        && knowledgeReferenceProblem(db, session, change.knowledge, change.evidence !== 'fact') !== undefined) return refused(current, '跨项目案例只作为待核材料，不能替代当前用户目标或要求')
      if (change.reuse !== undefined && change.reuse !== 'project' && change.reuse !== 'user') return refused(current, '知识复用范围无效')
      if (change.reuse === 'user' && (change.kind !== 'requirement' || change.evidence !== 'fact'
        || !change.sources.some(source => userBodySource(db, source)))) {
        return refused(current, '用户范围只能来自明确通用要求及其用户原始交代')
      }
      if (change.kind === 'step' && (change.order === undefined || !Number.isFinite(change.order) || !['pending', 'in_progress', 'completed'].includes(change.progress ?? ''))) return refused(current, '步骤缺少顺序或进展')
      seen.add(change.id)
      items.set(change.id, { ...change, revision: (items.get(change.id)?.revision ?? 0) + 1 })
    }
    if (input.changes.length === 0 && (input.inspectedThrough ?? current.inspectedThrough) === current.inspectedThrough) return { ok: true, snapshot: current }
    const snapshot = { ...current, revision: current.revision + 1, items: [...items.values()], inspectedThrough: input.inspectedThrough ?? current.inspectedThrough }
    save(snapshot)
    return { ok: true, snapshot }
  })
  const publish = db.transaction((input: Parameters<MemoryRecords['publishSummary']>[0]): MemoryWriteResult => {
    const current = read()
    if (!writable()) return refused(current, '会话不存在或已归档')
    if (current.revision !== input.expectedRevision || current.summary !== input.previousSummary) return refused(current, '摘要生成依据已失效')
    const coverage = input.coverage
    if (coverage.sources.some(source => !sourceExists(source, coverage.knowledge))) return refused(current, '摘要来源未获授权')
    const referenceProblem = knowledgeReferenceProblem(db, session, coverage.knowledge, true, sourceKnowledgeReferences(db, coverage.sources))
    if (referenceProblem !== undefined) return refused(current, referenceProblem)
    if (coverage.memoryRevision !== current.revision || coverage.previousSummary !== current.summary || coverage.coveredThrough <= (current.coveredThrough ?? 0)
      || coverage.from > coverage.coveredThrough || coverage.coveredThrough > (current.inspectedThrough ?? 0)
      || !sourceExists({ session, entry: coverage.coveredThrough }) || coverage.sources.some(source => !sourceExists(source, coverage.knowledge))) return refused(current, '摘要覆盖无效或仍有未整理材料')
    const summary = append({ kind: 'summary', content: input.content, payload: coverage, at: input.at })
    const snapshot = { ...current, summary, coveredThrough: coverage.coveredThrough }
    save(snapshot)
    if (input.compact !== undefined) events.appendEvent({
      id: events.nextId(), session, turn: null, at: input.at, kind: 'compact.state',
      data: { ...input.compact, accepted: true, state: 'completed', summary },
    })
    return { ok: true, snapshot }
  })
  return { read, update: input => update.immediate(input), publishSummary: input => publish.immediate(input) }
}
