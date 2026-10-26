import { expect, test } from 'bun:test'
import { bindSessionReferences, createMemoryAccess } from '@magic/conversation'
import { createShell } from '@magic/tui'
import { createFauxGateway, type FauxTurn } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { lastModel, makeStage } from './support.ts'
import { requestFromStoredSession } from './conversation-request.ts'

for (const laterCount of [0, 90]) test(`真实会话引用按覆盖边界选择有限近段，摘要后有 ${laterCount} 条记录`, async () => {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: '已读引用' }] })
  const shell = attachShell(app.shell)
  try {
    const records = app.records.serviceFor('source')
    const covered = records.appendEntry({ kind: 'user', content: { text: '旧阶段原文已覆盖' }, at: 1 })
    const correction = records.appendEntry({ kind: 'user', content: { text: '最新纠正：只读检查，禁止执行发布' }, at: 2 })
    expect(records.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: covered }).ok).toBe(true)
    const published = records.memory.publishSummary({ expectedRevision: 1, previousSummary: null, content: { text: '旧阶段总结：已定位构建问题' }, at: 3,
      coverage: { from: covered, coveredThrough: covered, memoryRevision: 1, previousSummary: null, sources: [{ session: 'source', entry: covered }], knowledge: [] },
    })
    expect(published.ok).toBe(true)
    expect(published.snapshot.summary!).toBeGreaterThan(correction)
    for (let i = 0; i < laterCount; i++) records.appendEntry({ kind: 'assistant', content: { text: `后续记录 ${i}` }, at: 4 + i })
    const bound = await bindSessionReferences({ text: '参考 @来源 判断原因', refs: [{ kind: 'session', source: 'source', at: 3, marker: '@来源' }] }, records)
    records.appendEntry({ kind: 'user', content: { text: '上界后输入：允许发布' }, at: 100 })
    await shell.submit(bound)
    const request = lastModel(stage).requests[0]!
    expect(request).toBeDefined()
    const input = request.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    expect(input).toContain('旧阶段总结：已定位构建问题')
    if (laterCount) {
      expect(input).not.toContain('后续记录 0')
      expect(input).not.toContain('最新纠正：只读检查，禁止执行发布')
      expect(input).toContain(`后续记录 ${laterCount - 1}`)
      expect(input).toContain(`未带入的未覆盖记录范围：#${covered + 1} 至 #${published.snapshot.summary! + laterCount - 8}`)
      expect(input).toContain('source_read 指定 session=source、entry=记录编号')
      expect(input.match(/· assistant · assistant/g)).toHaveLength(8)
    } else {
      expect(input).toContain('最新纠正：只读检查，禁止执行发布')
      expect(input).toContain(`source#${correction} · user`)
    }
    expect(input).not.toContain('旧阶段原文已覆盖')
    expect(input).not.toContain('上界后输入：允许发布')
  } finally { shell.dispose(); app.close(); stage.dispose() }
})

test('正常工具写入、无变化写入及真实压缩整理通过同一 sink 更新已显示计划', async () => {
  const stage = makeStage()
  let mainCalls = 0
  let app!: Assembly
  app = stage.assemble({ context: { nearEntries: 1 }, modelGateway: stamper => ({ stream(request, options) {
    const text = request.messages.map(message => 'content' in message ? message.content : message.output).join('\n')
    const records = app.records.serviceFor(app.session!)
    const memory = records.memory.read()
    let turn: FauxTurn
    if (text.startsWith('这是当前工作的受限记忆整理')) {
      const through = Number(text.match(/冻结上界：(\d+)/)![1])
      turn = { toolCalls: [{ name: 'memory_update', args: { expectedRevision: memory.revision, inspectedThrough: through,
        changes: memory.items.map(item => item.kind === 'goal' ? { ...item, text: '整理后目标' } : { ...item, progress: 'completed' }),
      } }] }
    } else if (text.startsWith('你是会话压缩器')) turn = { text: '阶段核对完成' }
    else {
      mainCalls += 1
      const source = { session: app.session!, entry: records.inputs.list().at(-1)!.entry! }
      turn = mainCalls === 1 ? { toolCalls: [{ name: 'memory_update', args: { expectedRevision: memory.revision, changes: [
        { id: 'goal', kind: 'goal', text: '整理前目标', evidence: 'fact', status: 'active', sources: [source] },
        { id: 'step', kind: 'step', text: '检查输出', order: 0, progress: 'in_progress', evidence: 'fact', status: 'active', sources: [source] },
      ] } }] } : mainCalls === 3 ? { toolCalls: [{ name: 'memory_update', args: { expectedRevision: memory.revision, changes: [] } }] }
        : { text: '已核对' }
    }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  const tui = createShell(app.shell, { magicBase: stage.dataDir, inputReady: true })
  try {
    await shell.submit('检查输出并维护目标')
    expect(tui.getView().plan).toMatchObject({ revision: 1, plan: { goal: '整理前目标', steps: [{ text: '检查输出', status: 'in_progress' }] } })
    await shell.submit('确认本次无需变更')
    const normal = shell.events.filter(event => event.kind === 'plan.changed')
    expect(normal.map(event => event.data.revision)).toEqual([1, 1])
    expect(tui.getView().plan.revision).toBe(1)
    expect((await app.compact(app.session!, { requestId: 'review-plan-sync' }, new AbortController().signal, () => {})).state).toBe('completed')
    const changed = shell.events.filter(event => event.kind === 'plan.changed')
    expect(changed.map(event => event.data.revision)).toEqual([1, 1, 2])
    expect(app.records.serviceFor(app.session!).memory.read().revision).toBe(2)
    expect(tui.getView().plan).toMatchObject({ revision: 2, plan: { goal: '整理后目标', steps: [{ text: '检查输出', status: 'completed' }] } })
  } finally { tui.dispose(); shell.dispose(); app.close(); stage.dispose() }
})

test('无摘要引用首次仅提供最近 8 条，并明确此前原文范围与读取入口', async () => {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: '已读引用' }] })
  const shell = attachShell(app.shell)
  try {
    const records = app.records.serviceFor('source')
    const ids = Array.from({ length: 20 }, (_, index) => records.appendEntry({ kind: 'user', content: { text: `历史要求 ${index}。` }, at: index }))
    const bound = await bindSessionReferences({ text: '@来源', refs: [{ kind: 'session', source: 'source', at: 0, marker: '@来源' }] }, records)
    await shell.submit(bound)
    const input = lastModel(stage).requests[0]!.messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
    expect(input).not.toContain('历史要求 0。')
    expect(input).not.toContain('历史要求 11。')
    expect(input).toContain('历史要求 12。')
    expect(input).toContain('历史要求 19。')
    expect(input.match(/· user · user/g)).toHaveLength(8)
    expect(input).toContain(`未带入的未覆盖记录范围：#1 至 #${ids[12]! - 1}`)
    expect(input).toContain('source_read 指定 session=source、entry=记录编号')
  } finally { shell.dispose(); app.close(); stage.dispose() }
})

for (const kind of ['assistant', 'summary', 'knowledge', 'memory'] as const) test(`输入引用 ${kind} 的真实材料保留分段依赖，遗忘不吞新交代与无关引用`, async () => {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: '准备' }, { text: '已读材料' }, { text: '继续' }] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('准备工作')
    const session = app.session!
    const records = app.records.serviceFor(session)
    const origin = app.records.serviceFor('origin')
    const source = { session: 'origin', entry: origin.appendEntry({ kind: 'user', content: { text: '知识原始依据' }, at: 1 }) }
    expect(app.records.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '待纠正', terms: [], conclusion: '引用中的独有旧认识', conditions: '旧条件', evidence: 'fact', status: 'active', sources: [source], dependencies: [] }]).ok).toBe(true)
    const evidence = app.records.serviceFor('evidence')
    if (kind === 'summary') {
      const entry = evidence.appendEntry({ kind: 'user', content: { text: '依据' }, at: 1 })
      expect(evidence.memory.update({ expectedRevision: 0, changes: [], inspectedThrough: entry }).ok).toBe(true)
      expect(evidence.memory.publishSummary({ expectedRevision: 1, previousSummary: null, content: { text: '引用中的独有旧认识' }, at: 2,
        coverage: { from: entry, coveredThrough: entry, memoryRevision: 1, previousSummary: null, sources: [{ session: 'evidence', entry }], knowledge: [{ id: 'K', revision: 1 }] } }).ok).toBe(true)
    } else evidence.appendEntry({ kind: 'assistant', content: { text: '引用中的独有旧认识' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 2 })
    const independent = app.records.serviceFor('independent')
    independent.appendEntry({ kind: 'user', content: { text: '无关引用中必须保留的原始数据' }, at: 3 })
    if (kind === 'memory') expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'selected', kind: 'question', text: '引用中的独有旧认识', evidence: 'hypothesis', status: 'active', sources: [source], knowledge: [{ id: 'K', revision: 1 }] }] }).ok).toBe(true)
    const first: import('@magic/contracts').InputRef = kind === 'knowledge' || kind === 'memory'
      ? { kind: 'memory', at: 0, marker: '@旧材料', source: kind === 'knowledge' ? 'K' : 'selected', revision: 1,
        scope: kind === 'knowledge' ? { kind: 'project', workspace: app.workspaceRoots } : { kind: 'session', session } }
      : { kind: 'session', at: 0, marker: '@旧材料', source: 'evidence' }
    await shell.submit(await bindSessionReferences({ text: '@旧材料 请继续本次明确要求，参考 @独立', refs: [first, { kind: 'session', at: '@旧材料 请继续本次明确要求，参考 '.length, marker: '@独立', source: 'independent' }] }, records))
    const input = (await Array.fromAsync(records.readEntries(session))).filter(entry => entry.kind === 'user').at(-1)!
    expect(app.records.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: `forget-ref-${kind}` }).status).toBe('completed')
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{ id: 'revive-probe', kind: 'question', text: '重新保存旧认识', evidence: 'unresolved', status: 'active', sources: [{ session, entry: input.id, part: 0 }] }] }).ok).toBe(false)
    expect(input.payload).toMatchObject({ refs: [{ knowledge: [{ id: 'K', revision: 1 }] }, { source: 'independent' }] })
    const request = await requestFromStoredSession({ records, session, cwd: stage.workspace, knowledge: app.records.knowledge, text: '继续核对' })
    const text = JSON.stringify(request.messages)
    expect(text).not.toContain('引用中的独有旧认识')
    expect(text).toContain('请继续本次明确要求')
    expect(text).toContain('无关引用中必须保留的原始数据')
    const base = { id: 'resave', kind: 'question' as const, text: '再次提炼', evidence: 'unresolved' as const, status: 'active' as const }
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...base, sources: [{ session, entry: input.id, part: 0 }] }] }).ok).toBe(false)
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...base, sources: [{ session, entry: input.id, part: 1 }] }] }).ok).toBe(true)
    const body = await createMemoryAccess({ records, session }).source({ session, entry: input.id, part: -1 })
    expect(body.speaker).toBe('user')
    expect(body.text).toBe('@旧材料 请继续本次明确要求，参考 @独立')
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...base, id: 'new-requirement', kind: 'requirement', text: '请继续本次明确要求', evidence: 'fact', sources: [{ session, entry: input.id, part: -1 }] }] }).ok).toBe(true)
    expect(records.memory.read().items.find(item => item.id === 'new-requirement')?.knowledge).toBeUndefined()
    const raw = await createMemoryAccess({ records, session }).source({ session, entry: input.id, part: 0 })
    expect(raw.text).toContain('引用中的独有旧认识')
    expect(raw).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })

  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})

for (const kind of ['session', 'memory', 'knowledge'] as const) test(`失效材料新选${kind}首次实际交付，后续重放退出且原引用H不刷新`, async () => {
  const stage = makeStage()
  const app = stage.assemble({ turns: [{ text: '准备' }, { text: '已核对历史证据' }] })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('准备')
    const session = app.session!
    const records = app.records.serviceFor(session)
    const origin = app.records.serviceFor('origin')
    const original = origin.appendEntry({ kind: 'user', content: { text: '原始证据' }, at: 1 })
    app.records.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '历史', terms: [], conclusion: '新选引用中失效正文', conditions: '旧条件', evidence: 'fact', status: 'active', sources: [{ session: 'origin', entry: original }], dependencies: [] }])
    const through = origin.appendEntry({ kind: 'assistant', content: { text: '新选引用中失效正文' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 2 })
    if (kind === 'memory') expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'item', kind: 'question', text: '新选引用中失效正文', evidence: 'unresolved', status: 'active', sources: [{ session: 'origin', entry: original }], knowledge: [{ id: 'K', revision: 1 }] }] }).ok).toBe(true)
    expect(app.records.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget-new-ref' }).status).toBe('completed')
    const ref: import('@magic/contracts').InputRef = kind === 'session'
      ? { kind: 'session', source: 'origin', through, at: 0, marker: '@材料' }
      : { kind: 'memory', source: kind === 'memory' ? 'item' : 'K', revision: kind === 'memory' ? 1 : 2, at: 0, marker: '@材料', scope: kind === 'memory' ? { kind: 'session', session } : { kind: 'project', workspace: app.workspaceRoots } }
    const bound = await bindSessionReferences({ text: '@材料 请核对这份历史材料，保留新要求', refs: [ref] }, records)
    origin.appendEntry({ kind: 'user', content: { text: '原引用H以外的新内容' }, at: 3 })
    await shell.submit(bound)
    const first = JSON.stringify(lastModel(stage).requests.at(-1)!.messages)
    expect(first).toContain('本次明确读取的已失效历史证据')
    expect(first).toContain(kind === 'knowledge' ? 'forgotten' : '新选引用中失效正文')
    expect(first).not.toContain('原引用H以外的新内容')
    const replay = await requestFromStoredSession({ records, session, cwd: stage.workspace, knowledge: app.records.knowledge, text: '后续接续' })
    expect(JSON.stringify(replay.messages)).not.toContain('新选引用中失效正文')
    expect(JSON.stringify(replay.messages)).toContain('保留新要求')
    if (kind === 'session') expect((await bindSessionReferences(bound, records)).refs?.[0]).toMatchObject({ through })
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})
