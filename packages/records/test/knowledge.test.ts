import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KnowledgeChange } from '@magic/contracts'
import { createRecordsStore, type RecordsStore } from '../src/store.ts'
import { createKnowledgeRecords } from '../src/knowledge.ts'
import { initKnowledgeSchema } from '../src/knowledge-schema.ts'

const resources: { dir: string; store: RecordsStore; db: Database }[] = []
afterEach(() => { for (const { dir, store, db } of resources.splice(0)) { db.close(); store.close(); rmSync(dir, { recursive: true, force: true }) } })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'magic-knowledge-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'] })
  const records = store.serviceFor('source')
  const entry = records.appendEntry({ kind: 'user', content: { text: '所有项目答复均用中文。认证排查用 AuthorizationDeniedException。' }, at: 1 })
  const db = new Database(store.paths.database)
  const knowledge = createKnowledgeRecords(db, ['/project/a'])
  resources.push({ dir, store, db })
  const change = (id = 'auth', extra: Partial<KnowledgeChange> = {}): KnowledgeChange => ({
    id, scope: { kind: 'project', workspace: ['/project/a'] }, topic: '认证排查', terms: ['鉴权', '登录', 'AuthorizationDeniedException'],
    conclusion: '异步请求检查认证分派', conditions: '仅适用于异步请求', evidence: 'fact', status: 'active', expectedRevision: 0,
    sources: [{ session: 'source', entry }], dependencies: [], ...extra,
  })
  return { dir, store, records, entry, db, knowledge, change }
}

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
    expect(f.store.knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'forget-cross-project' }).status).toBe('completed')
    expect(target.knowledge.isCurrent({ id: 'auth', revision: 1 })).toBe(false)
    expect(target.knowledge.read('case')?.status).toBe('invalid')
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
    const unrelated = createKnowledgeRecords(f.db, ['/project/b'])
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
    const another = createKnowledgeRecords(f.db, ['/project/b'])
    expect(another.read('preference')?.sources).toHaveLength(1)
    expect(another.search().items.map(item => item.id)).toEqual(['preference'])
  })

test('批次修订冲突回滚内容与索引', () => {
    const f = fixture()
    expect(f.knowledge.write([f.change()]).ok).toBe(true)
    expect(f.knowledge.write([f.change('new'), f.change()]).ok).toBe(false)
    expect(f.knowledge.read('new')).toBeUndefined()
    expect(f.knowledge.search().items).toHaveLength(1)
  })

test('快照整批修正保留新版输出，统一使旧派生失效，id引用回环遗忘可终止且重开不复活', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('A'), f.change('unrelated')]).ok).toBe(true)
    expect(knowledge.write([f.change('B', { dependencies: [{ id: 'A', revision: 1 }] })]).ok).toBe(true)
    expect(knowledge.write([f.change('old-derived', { dependencies: [{ id: 'B', revision: 1 }] })]).ok).toBe(true)
    const batch = [f.change('A', { expectedRevision: 1, dependencies: [{ id: 'B', revision: 1 }] }),
      f.change('B', { expectedRevision: 1, dependencies: [{ id: 'A', revision: 1 }] }),
      f.change('new-derived', { dependencies: [{ id: 'A', revision: 1 }] })]
    const result = knowledge.write(batch)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.reason)
    expect(result.items).toEqual(batch.map(change => knowledge.read(change.id)!))
    expect(result.items.map(item => [item.id, item.revision, item.status])).toEqual([['A', 2, 'active'], ['B', 2, 'active'], ['new-derived', 1, 'active']])
    expect(knowledge.read('old-derived')).toMatchObject({ revision: 2, status: 'invalid' })
    expect(knowledge.read('unrelated')).toMatchObject({ revision: 1, status: 'active' })
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

test('整批保存中途或统一失效失败时，正文与索引全部回滚', () => {
    const f = fixture()
    const knowledge = f.store.knowledge
    expect(knowledge.write([f.change('A'), f.change('B')]).ok).toBe(true)
    expect(knowledge.write([f.change('old-derived', { dependencies: [{ id: 'B', revision: 1 }] })]).ok).toBe(true)
    const before = knowledge.search()
    const changes = [f.change('A', { expectedRevision: 1, conclusion: '本批新结论A', dependencies: [{ id: 'B', revision: 1 }] }),
      f.change('B', { expectedRevision: 1, conclusion: '本批新结论B', dependencies: [{ id: 'A', revision: 1 }] })]
    for (const condition of ["NEW.id='B' AND NEW.revision=2", "NEW.id='old-derived' AND NEW.status='invalid'"]) {
      f.db.exec(`CREATE TRIGGER fail_publication BEFORE INSERT ON knowledge WHEN ${condition} BEGIN SELECT RAISE(ABORT,'publication failure'); END`)
      try {
        expect(() => knowledge.write(changes)).toThrow('publication failure')
        expect(knowledge.search()).toEqual(before)
        expect(knowledge.search({ query: '本批新结论' }).items).toEqual([])
      } finally { f.db.exec('DROP TRIGGER fail_publication') }
    }
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
      const knowledge = createKnowledgeRecords(reopened, ['/project/a'])
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
    f.db.exec("CREATE TRIGGER fail_forget BEFORE INSERT ON knowledge WHEN NEW.status='forgotten' BEGIN SELECT RAISE(ABORT,'invalidation failed'); END")
    const request = { id: 'auth', expectedRevision: 1, requestId: 'failure' }
    expect(() => f.knowledge.forget(request)).toThrow('invalidation failed')
    expect(f.knowledge.read('auth')?.status).toBe('active')
    expect(f.knowledge.forgetResult(request).status).toBe('unconfirmed')
    expect(f.knowledge.search({ query: '认证排查' }).items).toHaveLength(1)
  })
