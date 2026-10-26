import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelGateway, ModelRequest } from '@magic/contracts'
import { createFauxGateway, makeTestStamper } from '@magic/faux'
import { createRecordsStore, type RecordsStore } from '@magic/records'
import { createKnowledgeAccess, createKnowledgeOrganizer, createMaterialReader } from '@magic/conversation'
import { requestFromStoredSession } from './conversation-request.ts'

const stores: { dir: string; store: RecordsStore }[] = []
afterEach(() => { for (const { dir, store } of stores.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }) } })
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'magic-knowledge-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'] })
  stores.push({ dir, store })
  const records = store.serviceFor('work')
  const entry = records.appendEntry({ kind: 'user', content: { text: '认证异常已验证与 async 分派有关。' }, at: 1 })
  const material = createMaterialReader({ records, session: 'work' })
  const seed = () => records.memory.update({ expectedRevision: 0, changes: [{ id: 'finding', kind: 'fact', text: '异步分派需检查认证过滤器', evidence: 'fact', status: 'active', sources: [{ session: 'work', entry }] }] })
  const response = (extra: Record<string, unknown> = {}) => JSON.stringify({ changes: [{
    id: 'async-auth', expectedRevision: 0, candidateIds: ['finding'], topic: '认证排查', terms: ['鉴权', '登录', 'async'],
    conclusion: '异步分派需检查过滤器', conditions: '仅适用于异步请求', evidence: 'fact', status: 'active', dependencies: [], ...extra,
  }] })
  const organizer = (gateway: ModelGateway, budget?: number) => createKnowledgeOrganizer({ session: 'work', scope: { kind: 'project', workspace: ['/project/a'] },
    memory: records.memory, knowledge: store.knowledge, material, compression: () => ({ identity: 'test-cantrip', gateway, inputBudget: budget }), now: () => 10 })
  return { dir, store, records, entry, material, seed, response, organizer }
}

test('无候选不调用，阶段整理保存后新工作能发现，重复阶段不调用', async () => {
  const f = fixture()
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response(), usage: { inputTokens: 123 } }] })
  const organize = f.organizer(gateway)
  expect((await organize()).status).toBe('unchanged')
  expect(gateway.requests).toHaveLength(0)
  expect(f.seed().ok).toBe(true)
  const result = await organize()
  expect(result.status).toBe('completed')
  expect(result.calls?.[0]).toMatchObject({ purpose: 'knowledge', identity: 'test-cantrip', usage: { inputTokens: 123 } })
  expect(result.calls?.[0]?.usage?.outputTokens).toBeUndefined()
  const next = await requestFromStoredSession({ records: f.store.serviceFor('new-work'), session: 'new-work', cwd: '/project/a', knowledge: f.store.knowledge, text: '鉴权' })
  expect(JSON.stringify(next.messages)).toContain('async-auth')
  expect((await organize()).status).toBe('unchanged')
  expect(gateway.requests).toHaveLength(1)
  expect(f.store.knowledge.progress('work').items).toEqual({ finding: 1 })
  const memory = f.records.memory.read()
  expect(f.records.memory.update({ expectedRevision: memory.revision, changes: [{ ...memory.items[0]!, text: '采用认证知识后的新认识', knowledge: [{ id: 'async-auth', revision: 1 }] }] }).ok).toBe(true)
  const derived = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ id: 'derived-auth' }) }] })
  expect((await f.organizer(derived)()).status).toBe('completed')
  expect(f.store.knowledge.read('derived-auth')?.dependencies).toEqual([{ id: 'async-auth', revision: 1 }])
  f.store.knowledge.forget({ id: 'async-auth', expectedRevision: 1, requestId: 'forget-adopted' })
  expect(f.store.knowledge.read('derived-auth')?.status).toBe('invalid')
})

test('生成期间事项纠正不发布旧候选；来源身份和完整正文交给Cantrip', async () => {
  const f = fixture()
  f.seed()
  let request: ModelRequest | undefined
  const faux = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response() }] })
  const gateway: ModelGateway = { stream(req, options) {
    request = req
    f.records.memory.update({ expectedRevision: 1, changes: [{ ...f.records.memory.read().items[0]!, text: '新证据已推翻', evidence: 'unresolved' }] })
    return faux.stream(req, options)
  } }
  const result = await f.organizer(gateway)()
  expect(result.status).toBe('failed')
  expect(result.reason).toContain('依据已变化')
  expect(f.store.knowledge.read('async-auth')).toBeUndefined()
  expect(f.store.knowledge.progress('work').memoryRevision).toBe(0)
  expect(JSON.stringify(request)).toContain('认证异常已验证与 async 分派有关')
  expect(JSON.stringify(request)).toContain('speaker')
})

for (const correcting of [false, true]) test(`Cantrip未自报related依赖时，${correcting ? '修正' : '新增'}知识仍随提供材料遗忘并在重开后失效`, async () => {
  const f = fixture()
  const source = f.store.serviceFor('prior-work')
  const entry = source.appendEntry({ kind: 'user', content: { text: '先前验证的认证结论' }, at: 2 })
  const prior = { id: 'provided-auth', expectedRevision: 0, scope: { kind: 'project' as const, workspace: ['/project/a'] }, topic: '认证排查',
    terms: ['异步分派需检查认证过滤器'], conclusion: '复用材料中的独有认证结论', conditions: '仅异步请求', evidence: 'fact' as const, status: 'active' as const,
    sources: [{ session: 'prior-work', entry }], dependencies: [] }
  expect(f.store.knowledge.write([prior, ...(correcting ? [{ ...prior, id: 'async-auth', conclusion: '待补充的既有认识' }] : [])]).ok).toBe(true)
  expect(f.seed().ok).toBe(true)
  expect(f.records.memory.read().items[0]?.knowledge).toBeUndefined()
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ expectedRevision: correcting ? 1 : 0,
    conclusion: '复用材料中的独有认证结论，并补充当前条件', dependencies: [] }) }] })
  expect((await f.organizer(gateway)()).status).toBe('completed')
  const body = gateway.requests[0]?.messages[1]
  if (body?.role !== 'user' || typeof body.content !== 'string') throw new Error('缺少实际Cantrip输入')
  expect(JSON.parse(body.content).related.map((item: { id: string }) => item.id)).toContain('provided-auth')
  expect(f.store.knowledge.read('async-auth')?.status).toBe('active')
  expect(f.store.knowledge.forget({ id: 'provided-auth', expectedRevision: 1, requestId: 'forget-provided' }).status).toBe('completed')
  const afterForget = f.store.knowledge.read('async-auth')
  f.store.close()
  const reopened = createRecordsStore({ dataDir: f.dir, workspace: ['/project/a'] })
  stores.find(resource => resource.store === f.store)!.store = reopened
  expect({ afterForget: afterForget?.status, reopened: reopened.knowledge.read('async-auth')?.status })
    .toEqual({ afterForget: 'invalid', reopened: 'invalid' })
  expect(reopened.knowledge.search().items).toEqual([])
  expect(reopened.knowledge.read('async-auth')?.dependencies).toEqual([{ id: 'provided-auth', revision: 1, provided: true }])
})

test('取消、容量不足与无变化失败不推进整理位置，不换模型', async () => {
  const f = fixture()
  f.seed()
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: 'not-json' }] })
  const small = f.organizer(gateway, 1)
  expect((await small()).reason).toContain('容量不足')
  expect(gateway.requests).toHaveLength(0)
  const organize = f.organizer(gateway)
  expect((await organize()).status).toBe('failed')
  expect((await organize()).status).toBe('failed')
  expect(gateway.requests).toHaveLength(1)
  expect(f.store.knowledge.progress('work').memoryRevision).toBe(0)
  const controller = new AbortController()
  controller.abort()
  expect((await f.organizer(gateway)(controller.signal)).status).toBe('canceled')
})

for (const scenario of [
  { name: '两个独立related按A/B顺序同时修正', ids: ['A', 'B'], derived: false },
  { name: '两个独立related按B/A顺序同时修正', ids: ['B', 'A'], derived: false },
  { name: 'B已依赖A且本轮只修正A', ids: ['A'], derived: true },
]) test(`${scenario.name}应能发布，不能被自动提供依赖阻塞`, async () => {
  const f = fixture()
  const source = f.store.serviceFor('prior-work')
  const entry = source.appendEntry({ kind: 'user', content: { text: '两条独立认证认识及其原始依据' }, at: 2 })
  const prior = { expectedRevision: 0, scope: { kind: 'project' as const, workspace: ['/project/a'] }, topic: '认证排查',
    terms: ['异步分派需检查认证过滤器'], conclusion: '既有认证认识', conditions: '异步请求', evidence: 'fact' as const, status: 'active' as const,
    sources: [{ session: 'prior-work', entry }], dependencies: [] }
  expect(f.store.knowledge.write([{ ...prior, id: 'A' }]).ok).toBe(true)
  expect(f.store.knowledge.write([{ ...prior, id: 'B', dependencies: scenario.derived ? [{ id: 'A', revision: 1 }] : [] }]).ok).toBe(true)
  expect(f.seed().ok).toBe(true)
  const template = JSON.parse(f.response()).changes[0]
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: JSON.stringify({ changes: scenario.ids.map(id => ({
    ...template, id, expectedRevision: 1, conclusion: `${id}根据本阶段新证据补充条件`, dependencies: [],
  })) }) }] })
  const result = await f.organizer(gateway)()
  const body = gateway.requests[0]?.messages[1]
  if (body?.role !== 'user' || typeof body.content !== 'string') throw new Error('缺少实际Cantrip输入')
  expect(JSON.parse(body.content).related.map((item: { id: string }) => item.id).sort()).toEqual(['A', 'B'])
  f.store.close()
  const reopened = createRecordsStore({ dataDir: f.dir, workspace: ['/project/a'] })
  stores.find(resource => resource.store === f.store)!.store = reopened
  expect(result).toMatchObject({ status: 'completed' })
  for (const id of scenario.ids) expect(reopened.knowledge.read(id)).toMatchObject({ revision: 2, status: 'active' })
  expect(reopened.knowledge.read('A')?.dependencies).toEqual([{ id: 'B', revision: 1, provided: true }])
  expect(reopened.knowledge.read('B')).toMatchObject({ revision: 2, status: scenario.derived ? 'invalid' : 'active',
    dependencies: [{ id: 'A', revision: 1, ...(scenario.derived ? {} : { provided: true }) }] })
})

for (const evidence of ['hypothesis', 'unresolved'] as const) test(`独立事实与${evidence}相关材料同时提供时不应自动升级依据或阻塞事实整理`, async () => {
  const f = fixture()
  const source = f.store.serviceFor('related-work')
  const entry = source.appendEntry({ kind: 'assistant', content: { text: '尚未验证的旁支推测' }, at: 2 })
  expect(f.store.knowledge.write([{ id: 'uncertain', expectedRevision: 0, scope: { kind: 'project', workspace: ['/project/a'] },
    topic: '认证排查', terms: ['异步分派需检查认证过滤器'], conclusion: '尚未验证的旁支推测', conditions: '另一种尚未确认的环境',
    evidence, status: evidence === 'hypothesis' ? 'active' : 'pending', sources: [{ session: 'related-work', entry }], dependencies: [] }]).ok).toBe(true)
  expect(f.seed().ok).toBe(true)
  expect(f.records.memory.read().items[0]?.knowledge).toBeUndefined()
  for (const dependency of [{ id: 'uncertain', revision: 1 }, { id: 'uncertain', revision: 1, provided: true }]) {
    const explicit = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ dependencies: [dependency] }) }] })
    expect((await f.organizer(explicit)()).status).toBe('failed')
    expect(f.store.knowledge.read('async-auth')).toBeUndefined()
    expect(f.store.knowledge.progress('work').memoryRevision).toBe(0)
  }
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ dependencies: [] }) }] })
  const result = await f.organizer(gateway)()
  const body = gateway.requests[0]?.messages[1]
  if (body?.role !== 'user' || typeof body.content !== 'string') throw new Error('缺少实际Cantrip输入')
  expect(JSON.parse(body.content).related.map((item: { id: string }) => item.id)).toEqual(['uncertain'])
  expect(result).toMatchObject({ status: 'completed' })
  expect(f.store.knowledge.read('async-auth')).toMatchObject({ evidence: 'fact', status: 'active', dependencies: [{ id: 'uncertain', revision: 1, provided: true }] })
  const access = createKnowledgeAccess({ records: f.store.knowledge, writable: true, material: f.material })
  access.read('async-auth')
  expect((await access.update({ id: 'async-auth', expectedRevision: 1,
    changes: { dependencies: [{ id: 'uncertain', revision: 1, provided: true }] } })).ok).toBe(false)
  expect(f.store.knowledge.forget({ id: 'uncertain', expectedRevision: 1, requestId: 'forget-uncertain' }).status).toBe('completed')
  expect(f.store.knowledge.read('async-auth')?.status).toBe('invalid')
})

test('连续整批修正使用本次实际提供的修订，不把同一知识的旧引用混入新提交', async () => {
  const f = fixture()
  const prior = { expectedRevision: 0, scope: { kind: 'project' as const, workspace: ['/project/a'] }, topic: '认证排查',
    terms: ['异步分派需检查认证过滤器'], conclusion: '旧认识', conditions: '异步请求', evidence: 'fact' as const, status: 'active' as const,
    sources: [{ session: 'work', entry: f.entry }], dependencies: [] }
  expect(f.store.knowledge.write([{ ...prior, id: 'A' }, { ...prior, id: 'B' }]).ok).toBe(true)
  f.seed()
  for (const revision of [1, 2]) {
    const template = JSON.parse(f.response()).changes[0]
    const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: JSON.stringify({ changes: ['A', 'B'].map(id => ({
      ...template, id, expectedRevision: revision, conclusion: `${id}的第${revision + 1}版结论`, dependencies: [],
    })) }) }] })
    expect(await f.organizer(gateway)()).toMatchObject({ status: 'completed' })
    expect(f.store.knowledge.read('A')?.dependencies).toEqual([{ id: 'B', revision, provided: true }])
    expect(f.store.knowledge.read('B')?.dependencies).toEqual([{ id: 'A', revision, provided: true }])
    if (revision === 1) {
      const memory = f.records.memory.read()
      expect(f.records.memory.update({ expectedRevision: memory.revision, changes: [{ ...memory.items[0]!, detail: '新增独立证据，请继续核对条件' }] }).ok).toBe(true)
    }
  }
})

test('材料来源和纠正绑定当前会话或知识具体证据，咨询不能写', async () => {
  const f = fixture()
  f.seed()
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response() }] })
  await f.organizer(gateway)()
  const foreign = f.store.serviceFor('foreign')
  const foreignEntry = foreign.appendEntry({ kind: 'user', content: { text: '同工作区的无关秘密' }, at: 2 })
  const access = createKnowledgeAccess({ records: f.store.knowledge, writable: true,
    material: (source, evidence) => evidence === undefined ? f.material(source)
      : createMaterialReader({ records: f.store.serviceFor(source.session), session: source.session })(source) })
  const current = f.store.knowledge.read('async-auth')!
  const change = { id: current.id, expectedRevision: 1, changes: { conclusion: '修正结论' } }
  expect((await access.update(change)).ok).toBe(false)
  access.read('async-auth')
  expect((await access.update({ ...change, changes: { sources: [...current.sources, { session: 'foreign', entry: foreignEntry }] } })).ok).toBe(false)
  await expect(access.source('async-auth', { session: 'foreign', entry: foreignEntry })).rejects.toThrow('具体证据')
  expect((await access.source('async-auth', { session: 'work', entry: f.entry })).text).toContain('async')
  expect((await access.update(change)).ok).toBe(true)
  expect(access.read('async-auth')?.conditions).toBe(current.conditions)
  const consultation = createKnowledgeAccess({ records: f.store.knowledge, writable: false, material: f.material })
  const latest = consultation.read('async-auth')!
  expect((await consultation.update({ id: latest.id, expectedRevision: latest.revision, changes: { conclusion: '不允许写' } })).ok).toBe(false)
})

test('Cantrip 不能发明候选来源或把冲突写成事实', async () => {
  const f = fixture()
  f.seed()
  for (const extra of [{ candidateIds: ['missing'] }, { status: 'pending', evidence: 'fact' }]) {
    const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response(extra) }] })
    expect((await f.organizer(gateway)()).status).toBe('failed')
    expect(f.store.knowledge.search().items).toEqual([])
  }
})

test('明确受理的跨工作区引用可成为知识依据，冻结上界之外仍被拒绝', async () => {
  const f = fixture()
  const external = f.store.forWorkspace(['/project/external']).serviceFor('external')
  const entry = external.appendEntry({ kind: 'user', content: { text: '获准跨项目参考的认证事实' }, at: 2 })
  const after = external.appendEntry({ kind: 'user', content: { text: '引用上界之后的新秘密' }, at: 3 })
  const reference = { kind: 'session' as const, source: 'external', through: entry, marker: '@参考', at: 0 }
  const accepted = f.records.inputs.accept({ text: '@参考仅核对适用条件', refs: [reference], ref: 'accepted-reference' }, 4)
  f.records.inputs.consume(accepted.ref, accepted.revision, { kind: 'user', content: { text: accepted.input.text }, at: 4 })
  const item = { id: 'finding', kind: 'fact' as const, text: '认证事实可参考', evidence: 'fact' as const, status: 'active' as const, sources: [{ session: 'external', entry }] }
  expect(f.records.memory.update({ expectedRevision: 0, changes: [item] }).ok).toBe(true)
  expect(f.records.memory.update({ expectedRevision: 1, changes: [{ ...item, sources: [{ session: 'external', entry: after }] }] }).ok).toBe(false)
  const material = createMaterialReader({ records: f.records, session: 'work', references: [reference] })
  expect((await material({ session: 'external', entry })).text).toContain('跨项目参考')
  await expect(material({ session: 'external', entry: after })).rejects.toThrow('绑定范围')
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response() }] })
  const organize = createKnowledgeOrganizer({ session: 'work', scope: { kind: 'project', workspace: ['/project/a'] }, memory: f.records.memory,
    knowledge: f.store.knowledge, material, compression: () => ({ gateway }), now: () => 5 })
  expect((await organize()).status).toBe('completed')
  expect(f.store.knowledge.read('async-auth')?.sources).toEqual([{ session: 'external', entry }])
  expect(JSON.stringify(gateway.requests)).toContain('获准跨项目参考的认证事实')
  expect(JSON.stringify(gateway.requests)).not.toContain('引用上界之后的新秘密')
})

test('遗忘后实际上下文和重开库均不拾回失效摘要，剩余认识与新输入仍在', async () => {
  const f = fixture()
  f.seed()
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response() }] })
  await f.organizer(gateway)()
  const current = f.records.memory.read()
  expect(f.records.memory.update({ expectedRevision: current.revision, inspectedThrough: f.entry, changes: [
    { ...current.items[0]!, knowledge: [{ id: 'async-auth', revision: 1 }] },
    { id: 'requirement', kind: 'requirement', text: '本次工作必须保留中文答复', evidence: 'fact', status: 'active', sources: [{ session: 'work', entry: f.entry }] },
  ] }).ok).toBe(true)
  const memory = f.records.memory.read()
  expect(f.records.memory.publishSummary({ expectedRevision: memory.revision, previousSummary: null, at: 2,
    content: { text: '不能自动复活的错误经验' }, coverage: { from: f.entry, coveredThrough: f.entry, memoryRevision: memory.revision,
      previousSummary: null, sources: [{ session: 'work', entry: f.entry }], knowledge: [{ id: 'async-auth', revision: 1 }] } }).ok).toBe(true)
  f.records.appendEntry({ kind: 'user', content: { text: '后续新输入继续核对' }, at: 3 })
  f.store.knowledge.forget({ id: 'async-auth', expectedRevision: 1, requestId: 'context-forget' })
  const assertContext = async (store: RecordsStore) => {
    const request = await requestFromStoredSession({ records: store.serviceFor('work'), session: 'work', cwd: '/project/a', knowledge: store.knowledge, text: '继续核对' })
    const text = JSON.stringify(request.messages)
    expect(text).not.toContain('不能自动复活的错误经验')
    expect(text).toContain('本次工作必须保留中文答复')
    expect(text).toContain('后续新输入继续核对')
  }
  await assertContext(f.store)
  const reopened = createRecordsStore({ dataDir: f.dir, workspace: ['/project/a'] })
  try { await assertContext(reopened) } finally { reopened.close() }
})

for (const matched of [true, false]) test(`用户通用要求只提供用户范围材料，项目知识${matched ? '命中' : '作为默认候选'}不污染用户依赖`, async () => {
  const f = fixture()
  expect(f.store.knowledge.write([{ id: 'project-only', expectedRevision: 0, scope: { kind: 'project', workspace: ['/project/a'] },
    topic: '项目认识', terms: matched ? ['所有工作中文回复'] : ['unrelated'], conclusion: '项目专用材料', conditions: '仅本项目',
    evidence: 'fact', status: 'active', sources: [{ session: 'work', entry: f.entry }], dependencies: [] }]).ok).toBe(true)
  const entry = f.records.appendEntry({ kind: 'user', content: { text: '所有工作中文回复' }, at: 2 })
  expect(f.store.knowledge.write([{ id: 'user-related', expectedRevision: 0, scope: { kind: 'user' }, topic: '用户习惯', terms: [],
    conclusion: '仅用户范围的已有材料', conditions: '所有工作', evidence: 'fact', status: 'active', sources: [{ session: 'work', entry }],
    generalPreference: { session: 'work', entry }, dependencies: [] }]).ok).toBe(true)
  expect(f.records.memory.update({ expectedRevision: 0, changes: [{ id: 'language', kind: 'requirement', text: '所有工作中文回复',
    evidence: 'fact', status: 'active', reuse: 'user', sources: [{ session: 'work', entry }] }] }).ok).toBe(true)
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ id: 'chinese', candidateIds: ['language'] }) }] })
  const result = await f.organizer(gateway)()
  expect(result).toMatchObject({ status: 'completed' })
  const body = gateway.requests[0]!.messages[1]!
  expect(body.role).toBe('user')
  expect(JSON.stringify(body)).not.toContain('项目专用材料')
  expect(f.store.knowledge.read('chinese')).toMatchObject({ scope: { kind: 'user' }, dependencies: [{ id: 'user-related', revision: 1, provided: true }] })
  expect(f.store.knowledge.progress('work').items).toEqual({ language: 1 })
})

for (const outcome of ['complete', 'failure', 'cancel'] as const) test(`同批用户与项目候选分别提供，${outcome}时整批发布及进度一致`, async () => {
  const f = fixture()
  f.seed()
  const entry = f.records.appendEntry({ kind: 'user', content: { text: '所有工作中文回复' }, at: 2 })
  expect(f.records.memory.update({ expectedRevision: 1, changes: [{ id: 'language', kind: 'requirement', text: '所有工作中文回复',
    evidence: 'fact', status: 'active', reuse: 'user', sources: [{ session: 'work', entry }] }] }).ok).toBe(true)
  const controller = new AbortController()
  const requests: ModelRequest[] = []
  const gateway: ModelGateway = { stream(request, options) {
    requests.push(request)
    const message = request.messages[1]!
    if (message.role !== 'user' || typeof message.content !== 'string') throw new Error('缺少整理输入')
    const body = JSON.parse(message.content)
    const user = body.candidates[0].reuse === 'user'
    const text = requests.length === 2 && outcome === 'failure' ? 'not-json'
      : f.response({ id: user ? 'chinese' : 'async-auth', candidateIds: [user ? 'language' : 'finding'] })
    if (requests.length === 2 && outcome === 'cancel') controller.abort()
    return createFauxGateway({ stamper: makeTestStamper(), turns: [{ text }] }).stream(request, options)
  } }
  const result = await f.organizer(gateway)(controller.signal)
  expect(requests).toHaveLength(2)
  expect(result.calls).toHaveLength(2)
  for (const request of requests) {
    const body = JSON.parse((request.messages[1] as { content: string }).content)
    expect(body.candidates).toHaveLength(1)
    expect(body.evidence).toHaveLength(1)
    expect(body.scope.kind).toBe(body.candidates[0].reuse === 'user' ? 'user' : 'project')
  }
  expect(result.status).toBe(outcome === 'complete' ? 'completed' : outcome === 'failure' ? 'failed' : 'canceled')
  expect(f.store.knowledge.progress('work').items).toEqual(outcome === 'complete' ? { finding: 1, language: 1 } : {})
  expect(f.store.knowledge.search().items).toHaveLength(outcome === 'complete' ? 2 : 0)
})

for (const part of [undefined, -1]) for (const multiple of [false, true]) test(`通用要求从真实用户来源取证，助手确认在前且多候选=${multiple}，正文=${part}`, async () => {
  const f = fixture()
  const assistant = f.records.appendEntry({ kind: 'assistant', content: { text: '确认所有工作使用中文' }, at: 2 })
  const user = f.records.appendEntry({ kind: 'user', content: { text: '所有工作都请用中文答复' }, at: 3 })
  const sources = [{ session: 'work', entry: assistant }, { session: 'work', entry: user, ...(part === undefined ? {} : { part }) }]
  const candidate = { id: 'language', kind: 'requirement' as const, text: '所有工作中文回复', evidence: 'fact' as const, status: 'active' as const, reuse: 'user' as const, sources }
  expect(f.records.memory.update({ expectedRevision: 0, changes: [candidate, ...(multiple ? [{ ...candidate, id: 'language2', sources: [...sources].reverse() }] : [])] }).ok).toBe(true)
  const gateway = createFauxGateway({ stamper: makeTestStamper(), turns: [{ text: f.response({ id: 'chinese', candidateIds: multiple ? ['language', 'language2'] : ['language'] }) }] })
  expect(await f.organizer(gateway)()).toMatchObject({ status: 'completed' })
  expect(f.store.knowledge.read('chinese')).toMatchObject({ scope: { kind: 'user' }, status: 'active' })
})
