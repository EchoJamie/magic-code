import type { Database } from 'bun:sqlite'
import type {
  Knowledge, KnowledgeChange, KnowledgeForgetRequest, KnowledgeForgetResult, KnowledgePage,
  KnowledgeQuery, KnowledgeRecords, KnowledgeScope, KnowledgeWriteResult, MemorySource,
} from '@magic/contracts'
import { mergeKnowledgeReferences, sourceKnowledgeReferences, sourcePartExists, userBodySource } from './knowledge-memory.ts'

type Row = {
  id: string; scope: string; topic: string; terms: string; conclusion: string; conditions: string;
  basis: Knowledge['evidence']; status: Knowledge['status']; revision: number; sources: string; dependencies: string
}
type ForgetRow = { id: string; scope: string; sources: string; request: string; expected_revision: number; revision: number; active: number }
const scopeKey = (scope: KnowledgeScope): string => scope.kind === 'user' ? 'user' : JSON.stringify(scope.workspace)
const sourceKey = (source: MemorySource): string => JSON.stringify([source.session, source.entry, source.part ?? null, source.offset ?? null])
function uniqueSources(sources: readonly MemorySource[]): MemorySource[] {
  return [...new Map(sources.map(source => [sourceKey(source), source])).values()]
}
function knowledgeOf(row: Row): Knowledge {
  return { id: row.id, scope: row.scope === 'user' ? { kind: 'user' } : { kind: 'project', workspace: JSON.parse(row.scope) },
    topic: row.topic, terms: JSON.parse(row.terms), conclusion: row.conclusion, conditions: row.conditions,
    evidence: row.basis, status: row.status, revision: row.revision, sources: JSON.parse(row.sources), dependencies: JSON.parse(row.dependencies) }
}
class Rejected extends Error {}

/** 同一连接内完成正文、来源、修订、索引和遗忘。 */
export function createKnowledgeRecords(db: Database, workspace: readonly string[]): KnowledgeRecords {
  const project = JSON.stringify(workspace)
  const select = db.query<Row, [string]>('SELECT * FROM knowledge WHERE id=?')
  function allowed(scope: string): boolean { return scope === project || scope === 'user' }
  function read(id: string): Knowledge | undefined {
    const row = select.get(id)
    return row !== null && allowed(row.scope) ? knowledgeOf(row) : undefined
  }
  function index(item: Knowledge): void {
    db.query('DELETE FROM knowledge_search WHERE id=?').run(item.id)
    if (item.status === 'active' || item.status === 'pending') {
      db.query('INSERT INTO knowledge_search(id,topic,terms,conclusion,conditions) VALUES(?,?,?,?,?)')
        .run(item.id, item.topic, item.terms.join('\n'), item.conclusion, item.conditions)
    }
  }
  function save(item: Knowledge): void {
    db.query(`INSERT INTO knowledge VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      topic=excluded.topic, terms=excluded.terms, conclusion=excluded.conclusion, conditions=excluded.conditions,
      basis=excluded.basis, status=excluded.status, revision=excluded.revision, sources=excluded.sources, dependencies=excluded.dependencies`)
      .run(item.id, scopeKey(item.scope), item.topic, JSON.stringify(item.terms), item.conclusion, item.conditions, item.evidence,
        item.status, item.revision, JSON.stringify(item.sources), JSON.stringify(item.dependencies))
    index(item)
  }
  function sourceExists(source: MemorySource): boolean {
    if (!Number.isSafeInteger(source.entry) || source.entry <= 0 || !source.session) return false
    if (source.offset !== undefined && (!Number.isSafeInteger(source.offset) || source.offset < 0)) return false
    if (!sourcePartExists(db, source)) return false
    // 具体可读范围由对话域的绑定材料读取校验；记录域只核对原文真实存在。
    return db.query('SELECT 1 FROM entries WHERE session=? AND id=?').get(source.session, source.entry) !== null
  }
  function reject(reason: string): never { throw new Rejected(reason) }
  function writeInside(changes: readonly KnowledgeChange[]): KnowledgeWriteResult {
    const seen = new Set<string>()
    const output: Knowledge[] = []
    const replaced: Knowledge[] = []
    const forgotten = db.query<ForgetRow, []>('SELECT * FROM knowledge_forgetting WHERE active=1').all()
    // immediate 事务中先核验整批，期间不写正文或失效状态；所有引用均对应同一提交前快照。
    for (const change of changes) {
      const key = scopeKey(change.scope)
      if (!allowed(key)) reject('知识范围不属于当前工作区')
      if (!change.id?.trim() || !change.topic?.trim() || !change.conclusion?.trim() || typeof change.conditions !== 'string'
        || !Array.isArray(change.terms) || change.terms.some(term => typeof term !== 'string') || seen.has(change.id)) reject('知识身份或内容无效、重复')
      if (!['active', 'pending', 'invalid'].includes(change.status) || !['fact', 'hypothesis', 'unresolved'].includes(change.evidence)) reject('知识性质或状态无效')
      seen.add(change.id)
      const old = select.get(change.id)
      if (!Number.isSafeInteger(change.expectedRevision) || change.expectedRevision < 0 || (old?.revision ?? 0) !== change.expectedRevision) reject('知识修订冲突，请先读取最新内容')
      if (old !== null && old.scope !== key) reject('不能改变已有知识的范围')
      if (forgotten.some(mark => mark.id === change.id)) reject('该知识已明确遗忘，普通整理不能恢复')
      if (!Array.isArray(change.sources) || change.sources.length === 0 || change.sources.some(source => !sourceExists(source))) reject('知识来源不存在或未获当前工作区授权')
      if (key === 'user' && old === null) {
        const explicit = change.generalPreference
        if (explicit === undefined || !userBodySource(db, explicit) || !change.sources.some(source => sourceKey(source) === sourceKey(explicit))) reject('用户范围需要明确通用要求的用户交代来源')
      }
      if (!Array.isArray(change.dependencies)) reject('知识依赖无效')
      const sources = [...change.sources]
      const inherited = sourceKnowledgeReferences(db, sources)
      const dependencies = mergeKnowledgeReferences([...change.dependencies, ...inherited])
      for (const dependency of dependencies) {
        if (dependency.provided !== undefined && dependency.provided !== true) reject('知识依赖用途无效')
        const row = select.get(dependency.id)
        const local = row !== null && allowed(row.scope)
        // 跨项目仅承接已经获准材料的提供关系；不因自报 provided 或猜中 id 授权。
        const supplied = dependency.provided === true && inherited.some(reference => reference.id === dependency.id && reference.revision === dependency.revision)
          && sources.some(source => sourceKnowledgeReferences(db, [source]).some(reference => reference.id === dependency.id && reference.revision === dependency.revision)
            && (db.query('SELECT 1 FROM sessions WHERE id=? AND workspace=?').get(source.session, project) !== null
              || db.query(`SELECT 1 FROM inputs i JOIN sessions s ON s.id=i.session,json_each(i.body,'$.refs') r
                WHERE s.workspace=? AND i.state IN ('consumed','included') AND json_extract(r.value,'$.kind')='session'
                AND json_extract(r.value,'$.source')=? AND json_extract(r.value,'$.through')>=? LIMIT 1`).get(project, source.session, source.entry) !== null))
        const parent = row !== null && (local || supplied) ? knowledgeOf(row) : undefined
        if (parent === undefined || parent.revision !== dependency.revision || (parent.status !== 'active' && !(dependency.provided === true && parent.status === 'pending'))) reject('依赖知识已改变或不可用')
        if (key === 'user' && parent.scope.kind !== 'user') reject('项目认识不能提升为用户范围知识')
        if (dependency.provided !== true && change.evidence === 'fact' && parent.evidence !== 'fact') reject('不能提高所引知识的事实等级')
        if (parent.sources.some(source => !sourceExists(source))) reject('依赖知识的具体来源已不存在')
        // 仅提供案例不扩展为对外项目底层其他原文的读取授权。
        if (local) sources.push(...parent.sources)
      }
      const unique = uniqueSources(sources)
      if (forgotten.some(mark => allowed(mark.scope) && (JSON.parse(mark.sources) as MemorySource[]).some(source => unique.some(other =>
        source.session === other.session && source.entry === other.entry && (source.part === undefined || other.part === undefined || source.part === other.part))))) reject('来源包含已遗忘内容，不能自动重新提炼')
      const item: Knowledge = { id: change.id, scope: change.scope, topic: change.topic, terms: [...new Set(change.terms)], conclusion: change.conclusion,
        conditions: change.conditions, evidence: change.evidence, status: change.status, revision: change.expectedRevision + 1,
        sources: unique, dependencies }
      if (old !== null) replaced.push(knowledgeOf(old))
      output.push(item)
    }
    for (const item of output) save(item)
    // 旧版材料可生成同批新版；只撤回其他旧派生，不让本批输出被自身替换的旧值再次失效。
    if (replaced.length > 0) invalidateDependents(replaced, seen)

    return { ok: true, items: output }
  }
  function invalidateDependents(roots: readonly Knowledge[], published?: ReadonlySet<string>): Knowledge[] {
    const affected = new Map(roots.map(item => [item.id, item]))
    let changed = true
    while (changed) {
      changed = false
      for (const row of db.query<Row, []>("SELECT * FROM knowledge WHERE status IN ('active','pending')").all()) {
        if (affected.has(row.id) || published?.has(row.id)) continue
        const item = knowledgeOf(row)
        if (item.dependencies.some(parent => affected.has(parent.id))) {
          affected.set(item.id, item)
          save({ ...item, revision: item.revision + 1, status: 'invalid' })
          changed = true
        }
      }
    }
    return [...affected.values()]
  }
  function forgetResult(input: KnowledgeForgetRequest): KnowledgeForgetResult {
    const current = read(input.id)
    const mark = db.query<ForgetRow, [string]>('SELECT * FROM knowledge_forgetting WHERE request=?').get(input.requestId)
    if (mark !== null && allowed(mark.scope) && mark.id === input.id && mark.expected_revision === input.expectedRevision && mark.active === 1) {
      return { status: 'completed', ...(current === undefined ? {} : { current }) }
    }
    if (mark !== null && allowed(mark.scope)) return { status: 'changed', ...(current === undefined ? {} : { current }) }
    return { status: current !== undefined && current.revision !== input.expectedRevision ? 'changed' : 'unconfirmed', ...(current === undefined ? {} : { current }) }
  }
  const forget = db.transaction((input: KnowledgeForgetRequest): KnowledgeForgetResult => {
    if (!input.requestId?.trim() || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('遗忘请求身份或修订无效')
    const prior = forgetResult(input)
    if (prior.status !== 'unconfirmed') return prior
    // 一个请求即使曾作用于别的对象，也绝不能借重投递扩展范围。
    if (db.query('SELECT 1 FROM knowledge_forgetting WHERE request=?').get(input.requestId) !== null) return { status: 'changed' }
    const current = read(input.id)
    if (current === undefined) return { status: 'unconfirmed' }
    if (current.status === 'forgotten') return { status: 'changed', current }
    const affected = invalidateDependents([current])
    db.query(`INSERT INTO knowledge_forgetting VALUES (?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
      sources=excluded.sources, request=excluded.request, expected_revision=excluded.expected_revision, revision=excluded.revision, active=1`)
      .run(current.id, scopeKey(current.scope), JSON.stringify(uniqueSources(affected.flatMap(item => item.sources))), input.requestId, input.expectedRevision, current.revision + 1)
    const forgotten: Knowledge = { ...current, status: 'forgotten', revision: current.revision + 1, topic: '', terms: [], conclusion: '', conditions: '' }
    save(forgotten)
    return { status: 'completed', current: forgotten, affected: affected.map(item => item.id) }
  })
  const transaction = db.transaction(writeInside)
  function write(changes: readonly KnowledgeChange[]): KnowledgeWriteResult {
    try { return transaction.immediate(changes) }
    catch (error) { if (error instanceof Rejected) return { ok: false, reason: error.message }; throw error }
  }
  function search(query: KnowledgeQuery = {}): KnowledgePage {
    const offset = query.offset ?? 0
    const limit = query.limit ?? 20
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('知识分页无效')
    const text = query.query?.trim() ?? ''
    const params: Record<string, string | number> = { $scope: project, $limit: limit + 1, $offset: offset }
    let join = ''
    let where = "k.scope IN ($scope,'user') AND k.status IN ('active','pending')"
    let order = 'k.topic,k.id'
    if (query.topic !== undefined) { where += ' AND k.topic=$topic'; params.$topic = query.topic }
    if (Array.from(text).length >= 3) {
      join = 'JOIN knowledge_search ON knowledge_search.id=k.id'
      where += ' AND knowledge_search MATCH $query'
      params.$query = `"${text.replaceAll('"', '""')}"`
      order = 'knowledge_search.rank,k.topic,k.id'
    } else if (text !== '') {
      where += " AND (instr(lower(k.topic),lower($query))>0 OR instr(lower(k.terms),lower($query))>0 OR instr(lower(k.conclusion),lower($query))>0 OR instr(lower(k.conditions),lower($query))>0)"
      params.$query = text
    }
    const rows = db.query<Row, [typeof params]>(`SELECT k.* FROM knowledge k ${join} WHERE ${where} ORDER BY ${order} LIMIT $limit OFFSET $offset`).all(params)
    return { items: rows.slice(0, limit).map(knowledgeOf), ...(rows.length > limit ? { next: offset + limit } : {}) }
  }
  const restore = db.transaction((change: KnowledgeChange, source: MemorySource): KnowledgeWriteResult => {
    const current = read(change.id)
    if (current === undefined || current.status !== 'forgotten' || current.revision !== change.expectedRevision) reject('知识不是所见修订的已遗忘对象')
    const mark = db.query<ForgetRow, [string]>('SELECT * FROM knowledge_forgetting WHERE id=? AND active=1').get(change.id)
    if (mark === null || !userBodySource(db, source) || (JSON.parse(mark.sources) as MemorySource[]).some(prior => prior.session === source.session && prior.entry === source.entry)) reject('重新记住需要区别于旧依据的明确用户交代')
    db.query('UPDATE knowledge_forgetting SET active=0 WHERE id=?').run(change.id)
    return writeInside([{ ...change, sources: uniqueSources([...change.sources, source]) }])
  })
  return { read, isCurrent(reference) {
    const row = select.get(reference.id)
    return row !== null && row.revision === reference.revision && (row.status === 'active' || row.status === 'pending')
  }, search, write, forget: input => forget.immediate(input), forgetResult, remember(change, source) {
    try { return restore.immediate(change, source) }
    catch (error) { if (error instanceof Rejected) return { ok: false, reason: error.message }; throw error }
  } }
}
