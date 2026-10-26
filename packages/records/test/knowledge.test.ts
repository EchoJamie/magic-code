import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knowledge, KnowledgeChange } from '@magic/contracts'
import { createRecordsStore, type RecordsStore } from '../src/store.ts'
import { createKnowledgeRecords } from '../src/knowledge.ts'
import { initKnowledgeSchema } from '../src/knowledge-schema.ts'

const resources: { dir: string; store: RecordsStore; db: Database }[] = []
afterEach(() => { for (const { dir, store, db } of resources.splice(0)) { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }) } })
function fixture(onKnowledgeMemoryChanged?: (sessions: readonly string[]) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'magic-knowledge-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'], onKnowledgeMemoryChanged })
  const records = store.serviceFor('source')
  const entry = records.appendEntry({ kind: 'user', content: { text: '所有项目答复均用中文。认证排查用 AuthorizationDeniedException。' }, at: 1 })
  const db = new Database(store.paths.database)
  const invalidated: Knowledge[][] = []
  const knowledge = createKnowledgeRecords(db, ['/project/a'], items => { invalidated.push([...items]); return [] })
  resources.push({ dir, store, db })
  const change = (id = 'auth', extra: Partial<KnowledgeChange> = {}): KnowledgeChange => ({
    id, scope: { kind: 'project', workspace: ['/project/a'] }, topic: '认证排查', terms: ['鉴权', '登录', 'AuthorizationDeniedException'],
    conclusion: '异步请求检查认证分派', conditions: '仅适用于异步请求', evidence: 'fact', status: 'active', expectedRevision: 0,
    sources: [{ session: 'source', entry }], dependencies: [], ...extra,
  })
  return { dir, store, records, entry, db, invalidated, knowledge, change }
}

describe('知识存取与发现', () => {
  test('跨项目仅提供关系须继承真实绑定来源，默认发现和主动采用范围保持不变', () => {
    const f = fixture()
    expect(f.store.knowledge.write([f.change()]).ok).toBe(true)
    const external = f.records.appendEntry({ kind: 'assistant', content: { text: 'A案例原文' }, payload: { knowledge: [{ id: 'auth', revision: 1 }] }, at: 2 })
    const target = f.store.forWorkspace(['/project/b'])
    const records = target.serviceFor('target')
    const own = records.appendEntry({ kind: 'user', content: { text: 'B只核对案例适用条件' }, at: 3 })
    const source = { session: 'source', entry: external }
    const candidate = f.change('case', { scope: { kind: 'project', workspace: ['/project/b'] }, conclusion: '核对案例适用条件', evidence: 'unresolved', status: 'pending', sources: [source] })
    expect(target.knowledge.read('auth')).toBeUndefined()
    expect(target.knowledge.search({ query: '认证' }).items).toEqual([])
    expect(target.knowledge.isCurrent({ id: 'auth', revision: 1 })).toBe(true)
    expect(target.knowledge.write([candidate]).ok).toBe(false)
    expect(target.knowledge.write([{ ...candidate, sources: [{ session: 'target', entry: own }], dependencies: [{ id: 'auth', revision: 1, provided: true }] }]).ok).toBe(false)
    const accepted = records.inputs.accept({ ref: 'explicit-A', text: '参考 @A', refs: [{ kind: 'session', marker: '@A', at: 3, source: 'source', through: external }] }, 4)
    records.inputs.consume(accepted.ref, accepted.revision, { kind: 'user', content: { text: '参考 @A' }, at: 4 })
    expect(target.knowledge.write([candidate]).ok).toBe(true)
    expect(target.knowledge.read('case')?.dependencies).toEqual([{ id: 'auth', revision: 1, provided: true }])
    expect(target.knowledge.read('case')?.sources).toEqual([source])
    expect(target.knowledge.write([{ ...candidate, id: 'adopted', dependencies: [{ id: 'auth', revision: 1 }] }]).ok).toBe(false)
    expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'foreign-rule', kind: 'requirement', text: '将A规则当B要求', evidence: 'fact', status: 'active', sources: [source] }] }).ok).toBe(false)
    expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'question', kind: 'question', text: '核对A条件', evidence: 'unresolved', status: 'active', sources: [source] }] }).ok).toBe(true)
    expect(f.store.knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'forget-cross-project' }).status).toBe('completed')
    expect(target.knowledge.isCurrent({ id: 'auth', revision: 1 })).toBe(false)
    expect(target.knowledge.read('case')?.status).toBe('invalid')
    expect(records.memory.read().items[0]?.status).toBe('invalid')
    expect(target.knowledge.write([{ ...candidate, id: 'revived' }]).ok).toBe(false)
  })

  test('中文短词、三字以上、英文标识、主题分页均按范围查找', () => {
    const f = fixture()
    expect(f.knowledge.write([f.change(), f.change('other', { topic: '发布', conclusion: '发布流程', terms: [] })]).ok).toBe(true)
    for (const query of ['鉴权', '登录', '认证排查', 'AuthorizationDeniedException', '异步请求']) {
      expect(f.knowledge.search({ query }).items.map(item => item.id)).toContain('auth')
    }
    expect(f.knowledge.search({ topic: '发布' }).items.map(item => item.id)).toEqual(['other'])
    const page = f.knowledge.search({ limit: 1 })
    expect(page.next).toBe(1)
    expect(f.knowledge.search({ offset: page.next, limit: 1 }).items[0]?.id).not.toBe(page.items[0]?.id)
    const unrelated = createKnowledgeRecords(f.db, ['/project/b'], () => [])
    expect(unrelated.search().items).toEqual([])
    expect(unrelated.read('auth')).toBeUndefined()
    expect(unrelated.write([f.change('bad')]).ok).toBe(false)
    f.db.exec('DROP TABLE knowledge_search')
    initKnowledgeSchema(f.db)
    expect(f.knowledge.search({ query: '认证排查' }).items).toHaveLength(1)
  })

  test('同源只保留一次，用户范围必须附用户通用要求来源', () => {
    const f = fixture()
    expect(f.knowledge.write([f.change('preference', { scope: { kind: 'user' } })]).ok).toBe(false)
    const source = { session: 'source', entry: f.entry }
    expect(f.knowledge.write([f.change('preference', { scope: { kind: 'user' }, sources: [source, source], generalPreference: source })]).ok).toBe(true)
    const another = createKnowledgeRecords(f.db, ['/project/b'], () => [])
    expect(another.read('preference')?.sources).toHaveLength(1)
    expect(another.search().items.map(item => item.id)).toEqual(['preference'])
  })

  test('批次修订冲突回滚内容、索引和整理位置', () => {
    const f = fixture()
    expect(f.knowledge.write([f.change()]).ok).toBe(true)
    expect(f.knowledge.write([f.change('new'), f.change()]).ok).toBe(false)
    expect(f.knowledge.read('new')).toBeUndefined()
    expect(f.knowledge.search().items).toHaveLength(1)
    expect(f.knowledge.write([], { session: 'source', expectedMemoryRevision: 99, previousRevision: 0, items: {} }).ok).toBe(false)
    expect(f.knowledge.progress('source').memoryRevision).toBe(0)
  })
})

describe('知识纠正与遗忘', () => {
  test('共享工作区视图提交后只通知真正改变的会话，包括跨项目用户知识和仅摘要依赖', () => {
    const notifications: string[][] = []
    const committed: number[] = []
    const f = fixture(sessions => {
      notifications.push([...sessions].sort())
      // 用独立连接读，证明通知发生在提交后。
      committed.push(f.db.query<{ revision: number }, []>("SELECT revision FROM knowledge WHERE id='preference'").get()!.revision)
    })
    const user = f.change('preference', { scope: { kind: 'user' }, generalPreference: { session: 'source', entry: f.entry } })
    expect(f.store.knowledge.write([user]).ok).toBe(true)
    const foreign = f.store.forWorkspace(['/project/b'])
    for (const session of ['source', 'foreign', 'already-invalid', 'summary-only', 'unrelated']) {
      const records = (session === 'foreign' ? foreign : f.store).serviceFor(session)
      const entry = records.appendEntry({ kind: 'user', at: 2, content: { text: '独立用户依据' } })
      expect(records.memory.update({ expectedRevision: 0, inspectedThrough: entry, changes: session === 'summary-only' ? [] : [{
        id: 'fact', kind: 'fact', text: '此前认识', evidence: 'fact', status: session === 'already-invalid' ? 'invalid' : 'active', sources: [{ session, entry }],
        knowledge: session === 'unrelated' ? [] : [{ id: user.id, revision: 1 }],
      }] }).ok).toBe(true)
      if (session === 'summary-only') expect(records.memory.publishSummary({ expectedRevision: 1, previousSummary: null, at: 3, content: { text: '引用旧经验的摘要' },
        coverage: { from: entry, coveredThrough: entry, memoryRevision: 1, previousSummary: null, sources: [{ session, entry }], knowledge: [{ id: user.id, revision: 1 }] } }).ok).toBe(true)
    }
    const request = { id: user.id, expectedRevision: 1, requestId: 'foreign-forget' }
    expect(foreign.knowledge.forget(request).status).toBe('completed')
    expect(notifications).toEqual([['foreign', 'source', 'summary-only']])
    expect(committed).toEqual([2])
    expect(foreign.serviceFor('foreign').memory.read().revision).toBe(2)
    expect(f.store.serviceFor('summary-only').memory.read()).toMatchObject({ revision: 2, summary: null })
    for (const session of ['already-invalid', 'unrelated']) expect(f.store.serviceFor(session).memory.read().revision).toBe(1)
    expect(f.store.knowledge.forgetResult(request).status).toBe('completed')
    expect(foreign.knowledge.forget(request).status).toBe('completed')
    expect(notifications).toHaveLength(1)
    // 已失效的旧依赖不会在明确重新记住或后续修订时凭空再升记忆修订。
    const entry = f.records.appendEntry({ kind: 'user', at: 4, content: { text: '明确重新记住新的认识' } })
    expect(foreign.knowledge.remember({ ...user, expectedRevision: 2, sources: [{ session: 'source', entry }] }, { session: 'source', entry }).ok).toBe(true)
    expect(notifications).toHaveLength(1)
  })

  test('纠正和遗忘在失效后提交失败不广播，成功纠正沿同一入口通知，重复失效不造修订', () => {
    const notifications: string[][] = []
    const f = fixture(sessions => { notifications.push([...sessions]) })
    const knowledge = f.store.forWorkspace(['/project/a']).knowledge
    expect(knowledge.write([f.change()]).ok).toBe(true)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ id: 'derived', kind: 'fact', text: '旧认识', evidence: 'fact', status: 'active',
      sources: [{ session: 'source', entry: f.entry }], knowledge: [{ id: 'auth', revision: 1 }] }] }).ok).toBe(true)
    const before = f.records.memory.read()
    const correction = f.change('auth', { expectedRevision: 1, conclusion: '新认识' })
    f.db.exec("CREATE TRIGGER fail_progress BEFORE INSERT ON knowledge_progress BEGIN SELECT RAISE(ABORT,'after invalidation'); END")
    try {
      expect(() => knowledge.write([correction], { session: 'source', expectedMemoryRevision: 1, previousRevision: 0, items: {} })).toThrow('after invalidation')
    } finally { f.db.exec('DROP TRIGGER fail_progress') }
    f.db.exec("CREATE TRIGGER fail_forget BEFORE INSERT ON knowledge_forgetting BEGIN SELECT RAISE(ABORT,'after invalidation'); END")
    try {
      expect(() => knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'failed' })).toThrow('after invalidation')
    } finally { f.db.exec('DROP TRIGGER fail_forget') }
    expect(notifications).toEqual([])
    expect(f.records.memory.read()).toEqual(before)
    expect(knowledge.read('auth')?.revision).toBe(1)
    expect(knowledge.write([correction]).ok).toBe(true)
    expect(notifications).toEqual([['source']])
    const invalid = f.records.memory.read()
    expect(invalid.revision).toBe(2)
    expect(knowledge.write([{ ...correction, expectedRevision: 2, status: 'invalid' }]).ok).toBe(true)
    expect(f.records.memory.read()).toEqual(invalid)
    expect(notifications).toHaveLength(1)
  })

  for (const evidence of ['hypothesis', 'unresolved'] as const) test(`事项从公开答复继承${evidence}仅提供血缘，独立事实可保存但显式采用不得提升`, () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('uncertain', { evidence, status: evidence === 'hypothesis' ? 'active' : 'pending' })]).ok).toBe(true)
    const reference = { id: 'uncertain', revision: 1 }
    const output = f.records.appendEntry({ kind: 'assistant', content: { text: '根据独立原始来源确认的新事实；请求中曾提供旁支推测' },
      payload: { knowledge: [reference] }, at: 2 })
    const item = { id: 'independent', kind: 'fact' as const, text: '独立核对的事实', evidence: 'fact' as const, status: 'active' as const,
      sources: [{ session: 'source', entry: output }, { session: 'source', entry: f.entry }] }
    expect(f.records.memory.update({ expectedRevision: 0, changes: [item] }).ok).toBe(true)
    expect(f.records.memory.read().items[0]?.knowledge).toEqual([{ ...reference, provided: true }])
    for (const references of [[reference, { ...reference, provided: true as const }], [{ ...reference, provided: true as const }, reference]]) {
      expect(f.records.memory.update({ expectedRevision: 1, changes: [{ ...item, knowledge: references }] }).ok).toBe(false)
      expect(knowledge.write([f.change('adopted', { dependencies: references })]).ok).toBe(false)
    }
    expect(f.records.memory.update({ expectedRevision: 1, changes: [{ ...item, knowledge: [{ ...reference, provided: true }] }] }).ok).toBe(true)
    expect(f.records.memory.update({ expectedRevision: 2, changes: [{ ...item, knowledge: [{ ...reference, revision: 99, provided: true }] }] }).ok).toBe(false)
    const other = f.store.forWorkspace(['/project/b']).serviceFor('other-scope')
    const otherEntry = other.appendEntry({ kind: 'user', content: { text: '无相关知识授权的项目' }, at: 3 })
    expect(other.memory.update({ expectedRevision: 0, changes: [{ ...item, sources: [{ session: 'other-scope', entry: otherEntry }],
      knowledge: [{ ...reference, provided: true }] }] }).ok).toBe(false)
    expect(knowledge.forget({ id: reference.id, expectedRevision: 1, requestId: 'forget-provided-memory' }).status).toBe('completed')
    expect(f.records.memory.read().items[0]?.status).toBe('invalid')
    expect(f.records.memory.update({ expectedRevision: f.records.memory.read().revision, changes: [item] }).ok).toBe(false)
  })

  test('快照整批修正保留新版输出，统一使旧派生和记忆失效，id引用回环遗忘可终止且重开不复活', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('A'), f.change('unrelated')]).ok).toBe(true)
    expect(knowledge.write([f.change('B', { dependencies: [{ id: 'A', revision: 1 }] })]).ok).toBe(true)
    expect(knowledge.write([f.change('old-derived', { dependencies: [{ id: 'B', revision: 1 }] })]).ok).toBe(true)
    const sources = [{ session: 'source', entry: f.entry }]
    expect(f.records.memory.update({ expectedRevision: 0, inspectedThrough: f.entry, changes: [{ id: 'old-memory', kind: 'fact', text: '旧版认识',
      evidence: 'fact', status: 'active', sources, knowledge: [{ id: 'B', revision: 1 }] }] }).ok).toBe(true)
    expect(f.records.memory.publishSummary({ expectedRevision: 1, previousSummary: null, at: 2, content: { text: '旧版摘要' },
      coverage: { from: f.entry, coveredThrough: f.entry, memoryRevision: 1, previousSummary: null, sources, knowledge: [{ id: 'B', revision: 1 }] } }).ok).toBe(true)
    const batch = [f.change('A', { expectedRevision: 1, dependencies: [{ id: 'B', revision: 1 }] }),
      f.change('B', { expectedRevision: 1, dependencies: [{ id: 'A', revision: 1 }] }),
      f.change('new-derived', { dependencies: [{ id: 'A', revision: 1 }] })]
    const result = knowledge.write(batch, { session: 'source', expectedMemoryRevision: 1, previousRevision: 0, items: { 'old-memory': 1 } })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.items).toEqual(batch.map(change => knowledge.read(change.id)!))
    expect(result.items.map(item => [item.id, item.revision, item.status])).toEqual([['A', 2, 'active'], ['B', 2, 'active'], ['new-derived', 1, 'active']])
    expect(knowledge.read('old-derived')).toMatchObject({ revision: 2, status: 'invalid' })
    expect(knowledge.read('unrelated')).toMatchObject({ revision: 1, status: 'active' })
    expect(f.records.memory.read()).toMatchObject({ revision: 2, summary: null, coveredThrough: f.entry })
    expect(f.records.memory.read().items[0]?.status).toBe('invalid')
    expect(knowledge.progress('source')).toEqual({ memoryRevision: 1, items: { 'old-memory': 1 } })
    expect(knowledge.search().items.map(item => item.id).sort()).toEqual(['A', 'B', 'new-derived', 'unrelated'])

    const request = { id: 'A', expectedRevision: 2, requestId: 'forget-cycle' }
    const forgotten = knowledge.forget(request)
    expect(forgotten.status).toBe('completed')
    expect([...(forgotten.affected ?? [])].sort()).toEqual(['A', 'B', 'new-derived'])
    expect(knowledge.read('A')).toMatchObject({ revision: 3, status: 'forgotten' })
    expect(knowledge.read('B')).toMatchObject({ revision: 3, status: 'invalid' })
    expect(knowledge.read('new-derived')).toMatchObject({ revision: 2, status: 'invalid' })
    const reopened = createRecordsStore({ dataDir: f.dir, workspace: ['/project/a'] })
    try {
      expect(reopened.knowledge.forgetResult(request).status).toBe('completed')
      expect(reopened.knowledge.forget(request).status).toBe('completed')
      expect(reopened.knowledge.search().items.map(item => item.id)).toEqual(['unrelated'])
      expect(reopened.knowledge.write([f.change('resurrected')]).ok).toBe(false)
      expect(reopened.knowledge.write([f.change('B', { expectedRevision: 3 })]).ok).toBe(false)
    } finally { reopened.close() }
  })

  test('整批校验拒绝未来或不存在的修订，外部目标和依赖变化均不发布前面的输出', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('A'), f.change('B')]).ok).toBe(true)
    const before = knowledge.search()
    // 若校验未完成就尝试保存任何一项，该触发器会暴露提前写入。
    f.db.exec("CREATE TRIGGER no_early_write BEFORE INSERT ON knowledge BEGIN SELECT RAISE(ABORT,'write before full validation'); END")
    try {
      for (const dependency of [{ id: 'A', revision: 2 }, { id: 'missing', revision: 1 }, { id: 'new-first', revision: 1 },
        { id: 'A', revision: 2, provided: true as const }, { id: 'missing', revision: 1, provided: true as const }]) {
        expect(knowledge.write([f.change('new-first'), f.change('B', { expectedRevision: 1, dependencies: [dependency] })]))
          .toEqual({ ok: false, reason: '依赖知识已改变或不可用' })
        expect(knowledge.search()).toEqual(before)
      }
    } finally { f.db.exec('DROP TRIGGER no_early_write') }
    // 独立连接提交发生在本批生成依据取得之后。
    expect(f.knowledge.write([f.change('B', { expectedRevision: 1, conclusion: '其他连接已纠正B' })]).ok).toBe(true)
    const changed = knowledge.search()
    f.db.exec("CREATE TRIGGER no_early_write BEFORE INSERT ON knowledge BEGIN SELECT RAISE(ABORT,'write before full validation'); END")
    try {
      expect(knowledge.write([f.change('new-first'), f.change('B', { expectedRevision: 1 })]))
        .toEqual({ ok: false, reason: '知识修订冲突，请先读取最新内容' })
      expect(knowledge.write([f.change('new-first'), f.change('A', { expectedRevision: 1, dependencies: [{ id: 'B', revision: 1 }] })]))
        .toEqual({ ok: false, reason: '依赖知识已改变或不可用' })
      expect(knowledge.search()).toEqual(changed)
      expect(knowledge.read('new-first')).toBeUndefined()
      expect(knowledge.progress('source')).toEqual({ memoryRevision: 0, items: {} })
    } finally { f.db.exec('DROP TRIGGER no_early_write') }
  })

  test('依赖修订仍相同但具体来源已不存在时拒绝整批，不能发布只复制来源身份的知识', () => {
    const f = fixture()
    expect(f.store.knowledge.write([f.change('parent')]).ok).toBe(true)
    const current = f.records.appendEntry({ kind: 'user', content: { text: '本轮真实来源' }, at: 2 })
    f.db.query('DELETE FROM entries WHERE id=?').run(f.entry)
    const sources = [{ session: 'source', entry: current }]
    expect(f.store.knowledge.write([f.change('first', { sources }), f.change('derived', { sources, dependencies: [{ id: 'parent', revision: 1, provided: true }] })]))
      .toEqual({ ok: false, reason: '依赖知识的具体来源已不存在' })
    expect(f.store.knowledge.search().items.map(item => item.id)).toEqual(['parent'])
    expect(f.store.knowledge.read('first')).toBeUndefined()
  })

  test('整批保存中途或统一失效失败时，正文索引记忆和整理进度全部回滚', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('A'), f.change('B')]).ok).toBe(true)
    expect(knowledge.write([f.change('old-derived', { dependencies: [{ id: 'B', revision: 1 }] })]).ok).toBe(true)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ id: 'old', kind: 'fact', text: '旧认识', evidence: 'fact', status: 'active',
      sources: [{ session: 'source', entry: f.entry }], knowledge: [{ id: 'B', revision: 1 }] }] }).ok).toBe(true)
    const before = knowledge.search()
    const memory = f.records.memory.read()
    const changes = [f.change('A', { expectedRevision: 1, conclusion: '本批新结论A', dependencies: [{ id: 'B', revision: 1 }] }),
      f.change('B', { expectedRevision: 1, conclusion: '本批新结论B', dependencies: [{ id: 'A', revision: 1 }] })]
    for (const condition of ["NEW.id='B' AND NEW.revision=2", "NEW.id='old-derived' AND NEW.status='invalid'"]) {
      f.db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON knowledge WHEN ${condition} BEGIN SELECT RAISE(ABORT,'publication failure'); END`)
      try {
        expect(() => knowledge.write(changes, { session: 'source', expectedMemoryRevision: memory.revision, previousRevision: 0, items: { old: 1 } })).toThrow('publication failure')
        expect(knowledge.search()).toEqual(before)
        expect(knowledge.search({ query: '本批新结论' }).items).toEqual([])
        expect(f.records.memory.read()).toEqual(memory)
        expect(knowledge.progress('source')).toEqual({ memoryRevision: 0, items: {} })
      } finally { f.db.exec('DROP TRIGGER fail_publication') }
    }
  })

  test('事项和摘要写入验证实际知识修订、范围与事实等级，遗忘期间的候选不能发布', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    knowledge.write([f.change(), f.change('pending', { evidence: 'unresolved', status: 'pending' })])
    const source = { session: 'source', entry: f.entry }
    const item = { id: 'fact', kind: 'fact' as const, text: '新认识', evidence: 'fact' as const, status: 'active' as const, sources: [source] }
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ ...item, knowledge: [{ id: 'auth', revision: 99 }] }] }).ok).toBe(false)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ ...item, knowledge: [{ id: 'pending', revision: 1 }] }] }).ok).toBe(false)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ ...item, evidence: 'unresolved', knowledge: [{ id: 'pending', revision: 1 }] }], inspectedThrough: f.entry }).ok).toBe(true)
    const other = f.store.forWorkspace(['/project/b']).serviceFor('outside')
    const otherEntry = other.appendEntry({ kind: 'user', content: { text: '别的项目' }, at: 4 })
    expect(other.memory.update({ expectedRevision: 0, changes: [{ ...item, sources: [{ session: 'outside', entry: otherEntry }], knowledge: [{ id: 'auth', revision: 1 }] }] }).ok).toBe(false)
    const coverage = { from: f.entry, coveredThrough: f.entry, memoryRevision: 1, previousSummary: null, sources: [source], knowledge: [{ id: 'auth', revision: 1 }] }
    knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'during-summary' })
    // auth 不是当前事项依赖，总记忆修订未变；摘要仍须因实际材料知识失效而拒绝。
    expect(f.records.memory.read().revision).toBe(1)
    expect(f.records.memory.publishSummary({ expectedRevision: 1, previousSummary: null, content: { text: '旧候选' }, coverage, at: 5 }).ok).toBe(false)
    expect(f.records.memory.read().summary).toBeNull()
  })

  test('user复用标记须为用户通用要求；系统通知和模型认识不能提升范围', () => {
    const f = fixture()
    const item = { id: 'preference', kind: 'requirement' as const, text: '所有项目用中文', evidence: 'fact' as const, status: 'active' as const, reuse: 'user' as const, sources: [{ session: 'source', entry: f.entry }] }
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ ...item, kind: 'fact' }] }).ok).toBe(false)
    const notice = f.records.appendEntry({ kind: 'user', content: { text: '系统内部通知' }, payload: { notice: true }, at: 2 })
    expect(f.records.memory.update({ expectedRevision: 0, changes: [{ ...item, sources: [{ session: 'source', entry: notice }] }] }).ok).toBe(false)
    expect(f.records.memory.update({ expectedRevision: 0, changes: [item] }).ok).toBe(true)
  })

  test('通过真实记录服务遗忘，依赖事项和摘要退出，明确要求与无关认识保留', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change()]).ok).toBe(true)
    const source = { session: 'source', entry: f.entry }
    expect(f.records.memory.update({ expectedRevision: 0, inspectedThrough: f.entry, changes: [
      { id: 'derived', kind: 'fact', text: '采用旧认证结论', evidence: 'fact', status: 'active', sources: [source], knowledge: [{ id: 'auth', revision: 1 }] },
      { id: 'requirement', kind: 'requirement', text: '保留用户原有要求', evidence: 'fact', status: 'active', sources: [source], knowledge: [{ id: 'auth', revision: 1 }] },
      { id: 'unrelated', kind: 'fact', text: '其他有依据认识', evidence: 'fact', status: 'active', sources: [source] },
    ] }).ok).toBe(true)
    expect(f.records.memory.publishSummary({ expectedRevision: 1, previousSummary: null, content: { text: '旧认证结论和其他背景' }, at: 2,
      coverage: { from: f.entry, coveredThrough: f.entry, memoryRevision: 1, previousSummary: null, sources: [source], knowledge: [{ id: 'auth', revision: 1 }] } }).ok).toBe(true)
    expect(knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'actual-forget' }).status).toBe('completed')
    const memory = f.records.memory.read()
    expect(memory.items.find(item => item.id === 'derived')?.status).toBe('invalid')
    expect(memory.items.find(item => item.id === 'requirement')).toMatchObject({ text: '保留用户原有要求', status: 'active', knowledge: [] })
    expect(memory.items.find(item => item.id === 'unrelated')?.status).toBe('active')
    expect(memory.summary).toBeNull()
    expect(memory.coveredThrough).toBe(f.entry)
    expect(memory.revision).toBe(2)
    expect(f.records.memory.update({ expectedRevision: 1, changes: [] }).ok).toBe(false)
  })

  test('纠正使派生内容退出；旧修订不能继续写入', () => {
    const f = fixture()
    expect(f.knowledge.write([f.change()]).ok).toBe(true)
    expect(f.knowledge.write([f.change('derived', { dependencies: [{ id: 'auth', revision: 1 }] })]).ok).toBe(true)
    expect(f.knowledge.write([f.change('auth', { expectedRevision: 1, conditions: '仅适用于异步 Servlet 分派' })]).ok).toBe(true)
    expect(f.knowledge.read('derived')?.status).toBe('invalid')
    expect(f.knowledge.search().items.map(item => item.id)).toEqual(['auth'])
    expect(f.knowledge.write([f.change('auth', { expectedRevision: 1 })]).ok).toBe(false)
    expect(f.knowledge.read('auth')?.conditions).toBe('仅适用于异步 Servlet 分派')
  })

  test('遗忘、回查、重投和重开不恢复旧来源；原文仍可读取', async () => {
    const f = fixture()
    f.knowledge.write([f.change()])
    f.knowledge.write([f.change('derived', { dependencies: [{ id: 'auth', revision: 1 }] })])
    const request = { id: 'auth', expectedRevision: 1, requestId: 'forget-auth' }
    expect(f.knowledge.forgetResult(request).status).toBe('unconfirmed')
    expect(f.knowledge.forget(request)).toMatchObject({ status: 'completed', affected: ['auth', 'derived'] })
    expect(f.knowledge.search().items).toEqual([])
    expect(f.knowledge.forget(request).status).toBe('completed')
    expect(f.knowledge.read('auth')?.revision).toBe(2)
    expect(f.knowledge.write([f.change('revived')]).ok).toBe(false)
    expect(f.knowledge.write([f.change('offset-revival', { sources: [{ session: 'source', entry: f.entry, offset: 1 }] })]).ok).toBe(false)
    expect(f.knowledge.write([f.change('auth', { expectedRevision: 2 })]).ok).toBe(false)
    const reopened = new Database(f.store.paths.database)
    try {
      const knowledge = createKnowledgeRecords(reopened, ['/project/a'], () => [])
      expect(knowledge.forgetResult(request).status).toBe('completed')
      expect(knowledge.search().items).toEqual([])
      const requested = f.records.appendEntry({ kind: 'user', content: { text: '明确重新记住认证知识，条件仍为异步请求' }, at: 3 })
      const restored = f.change('auth', { expectedRevision: 2 })
      expect(knowledge.remember(restored, { session: 'source', entry: f.entry }).ok).toBe(false)
      expect(knowledge.remember({ ...restored, conclusion: '' }, { session: 'source', entry: requested }).ok).toBe(false)
      expect(knowledge.read('auth')?.status).toBe('forgotten')
      expect(knowledge.forgetResult(request).status).toBe('completed')
      expect(knowledge.remember(restored, { session: 'source', entry: requested }).ok).toBe(true)
      expect(knowledge.forget(request).status).toBe('changed')
      expect(knowledge.read('auth')?.revision).toBe(3)
    } finally { reopened.close() }
    const entries = await Array.fromAsync(f.records.readEntries('source'))
    expect(entries.some(entry => entry.id === f.entry)).toBe(true)
  })

  test('失效事务失败时遗忘标记和有效知识均不半提交', () => {
    const f = fixture()
    f.knowledge.write([f.change()])
    const failing = createKnowledgeRecords(f.db, ['/project/a'], () => { throw new Error('invalidation failed') })
    const request = { id: 'auth', expectedRevision: 1, requestId: 'failure' }
    expect(() => failing.forget(request)).toThrow('invalidation failed')
    expect(f.knowledge.read('auth')?.status).toBe('active')
    expect(f.knowledge.forgetResult(request).status).toBe('unconfirmed')
    expect(f.knowledge.search({ query: '认证排查' }).items).toHaveLength(1)
  })
})
