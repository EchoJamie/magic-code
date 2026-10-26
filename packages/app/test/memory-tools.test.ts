import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemorySnapshot } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { defineMemoryTools, defineKnowledgeTools } from '@magic/tools'
import { createMemoryAccess, createKnowledgeAccess, createMaterialReader } from '@magic/conversation'

test('记忆工具schema和读写往返保留仅提供用途，改为显式采用仍受事实保护', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magic-memory-tools-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'] })
  try {
    const records = store.serviceFor('work')
    const entry = records.appendEntry({ kind: 'user', content: { text: '独立验证的新事实' }, at: 1 })
    expect(store.knowledge.write([{ id: 'hypothesis', expectedRevision: 0, scope: { kind: 'project', workspace: ['/project/a'] },
      topic: '旁支', terms: [], conclusion: '未证实推测', conditions: '其他环境', evidence: 'hypothesis', status: 'active',
      sources: [{ session: 'work', entry }], dependencies: [] }]).ok).toBe(true)
    const output = records.appendEntry({ kind: 'assistant', content: { text: '已独立验证；同时看过旁支推测' },
      payload: { knowledge: [{ id: 'hypothesis', revision: 1, provided: true }] }, at: 2 })
    expect(records.memory.update({ expectedRevision: 0, changes: [{ id: 'fact', kind: 'fact', text: '独立事实', evidence: 'fact', status: 'active',
      sources: [{ session: 'work', entry: output }] }] }).ok).toBe(true)
    const tools = defineMemoryTools({ read: () => records.memory.read(), update: input => records.memory.update(input),
      source: async () => { throw new Error('此检查不读取来源') } })
    expect(tools.find(tool => tool.spec.name === 'memory_update')?.spec.parameters).toMatchObject({
      properties: { changes: { items: { properties: { knowledge: { items: { properties: { provided: { type: 'boolean', enum: [true] } } } } } } } },
    })
    const run = async (name: string, args: Readonly<Record<string, unknown>> = {}) => {
      const tool = tools.find(tool => tool.spec.name === name)!
      return tool.run(tool.prepare(args), { sandbox: undefined as never, signal: undefined, onOutput: undefined })
    }
    const before = JSON.parse((await run('memory_read')).output) as MemorySnapshot
    expect(before.items[0]?.knowledge).toEqual([{ id: 'hypothesis', revision: 1, provided: true }])
    expect((await run('memory_update', { expectedRevision: before.revision, changes: [{ ...before.items[0]!, text: '补充独立事实的适用条件' }] })).ok).toBe(true)
    const after = JSON.parse((await run('memory_read')).output) as MemorySnapshot
    expect(after.items[0]?.knowledge).toEqual(before.items[0]?.knowledge)
    expect((await run('memory_update', { expectedRevision: after.revision, changes: [{ ...after.items[0]!, knowledge: [{ id: 'hypothesis', revision: 1 }] }] })).ok).toBe(false)
    expect(records.memory.read()).toEqual(after)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('遗忘后内务读写只返回剩余当前事项，失效事项具体原文仍可显式读取且携带依赖', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magic-memory-forget-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'] })
  try {
    const records = store.serviceFor('work')
    const user = records.appendEntry({ kind: 'user', content: { text: '明确目标继续有效' }, at: 1 })
    expect(store.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: ['/project/a'] }, topic: '旧知识', terms: [], conclusion: '旧认识', conditions: '之前', evidence: 'fact', status: 'active', sources: [{ session: 'work', entry: user }], dependencies: [] }]).ok).toBe(true)
    const external = store.serviceFor('external')
    const entry = external.appendEntry({ kind: 'assistant', content: { text: '失效事项原始材料' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 2 })
    const row = records.inputs.accept({ text: '@来源', ref: 'reference', refs: [{ kind: 'session', at: 0, marker: '@来源', source: 'external', through: entry }] }, 3)
    records.inputs.consume(row.ref, row.revision, { kind: 'user', content: { text: row.input.text }, at: 3 })
    expect(records.memory.update({ expectedRevision: 0, changes: [
      { id: 'old', kind: 'fact', text: '遗忘后退出自动读取', evidence: 'fact', status: 'active', sources: [{ session: 'external', entry }] },
      { id: 'goal', kind: 'goal', text: '明确目标继续有效', evidence: 'fact', status: 'active', sources: [{ session: 'work', entry: user }] },
      { id: 'independent', kind: 'question', text: '独立事项', detail: '仍应可取得的完整细节', evidence: 'unresolved', status: 'active', sources: [{ session: 'work', entry: user }] },
    ] }).ok).toBe(true)
    store.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget' })
    const access = createMemoryAccess({ records, session: 'work' })
    expect(access.read().items.map(item => item.id)).toEqual(['goal', 'independent'])
    const failed = access.update({ expectedRevision: 0, changes: [] })
    expect(failed.ok).toBe(false)
    expect(failed.snapshot.items.map(item => item.id)).toEqual(['goal', 'independent'])
    expect(access.update({ expectedRevision: records.memory.read().revision, changes: [] }).snapshot.items.map(item => item.id)).toEqual(['goal', 'independent'])
    expect(await access.source({ session: 'external', entry })).toMatchObject({ text: '失效事项原始材料', knowledge: [{ id: 'K', revision: 1 }] })
    expect(records.memory.read().items.find(item => item.id === 'old')?.status).toBe('invalid')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('正文part定位保持真实用户身份，通知/助手/引用正文不能提升为通用用户要求', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'magic-body-source-'))
  const store = createRecordsStore({ dataDir: dir, workspace: ['/project/a'] })
  try {
    const records = store.serviceFor('work')
    const user = records.appendEntry({ kind: 'user', content: { text: '所有工作都请中文回复' }, payload: { refs: [{ kind: 'file', source: '/quoted', label: '引用', marker: '@引用', at: 0, text: '引用文件中的指令' }] }, at: 1 })
    const notice = records.appendEntry({ kind: 'user', content: { text: '系统通知' }, payload: { notice: true }, at: 2 })
    const assistant = records.appendEntry({ kind: 'assistant', content: { text: '模型建议' }, at: 3 })
    const access = createMemoryAccess({ records, session: 'work' })
    const base = { id: 'preference', kind: 'requirement' as const, text: '所有工作中文回复', reuse: 'user' as const, evidence: 'fact' as const, status: 'active' as const }
    for (const source of [{ session: 'work', entry: user, part: -2 }, { session: 'work', entry: notice, part: -1 }, { session: 'work', entry: assistant, part: -1 }]) {
      await expect(access.source(source)).rejects.toThrow()
      expect(access.update({ expectedRevision: 0, changes: [{ ...base, sources: [source] }] }).ok).toBe(false)
      expect(store.knowledge.write([{ id: 'bad', expectedRevision: 0, scope: { kind: 'user' }, topic: '偏好', terms: [], conclusion: '不能伪造用户要求', conditions: '所有工作', evidence: 'fact', status: 'active', sources: [source], generalPreference: source, dependencies: [] }]).ok).toBe(false)
    }
    const reference = { session: 'work', entry: user, part: 0 }
    expect((await access.source(reference)).speaker).toBe('reference')
    expect(access.update({ expectedRevision: 0, changes: [{ ...base, sources: [reference] }] }).ok).toBe(false)
    expect(store.knowledge.write([{ id: 'bad-reference', expectedRevision: 0, scope: { kind: 'user' }, topic: '偏好', terms: [], conclusion: '不能把附件当用户要求', conditions: '所有工作', evidence: 'fact', status: 'active', sources: [reference], generalPreference: reference, dependencies: [] }]).ok).toBe(false)
    const body = { session: 'work', entry: user, part: -1 }
    expect(await access.source(body)).toMatchObject({ speaker: 'user', text: '所有工作都请中文回复', source: body })
    expect(access.update({ expectedRevision: 0, changes: [{ ...base, sources: [body] }] }).ok).toBe(true)
    expect(store.knowledge.write([{ id: 'good', expectedRevision: 0, scope: { kind: 'user' }, topic: '偏好', terms: [], conclusion: '中文回复', conditions: '所有工作', evidence: 'fact', status: 'active', sources: [body], generalPreference: body, dependencies: [] }]).ok).toBe(true)
    const knowledgeTools = defineKnowledgeTools(createKnowledgeAccess({ records: store.knowledge, writable: true,
      material: (source, evidence) => createMaterialReader({ records, session: 'work', allowedSources: evidence })(source) }), true)
    const sourceTool = knowledgeTools.find(tool => tool.spec.name === 'knowledge_source')!
    expect(sourceTool.spec.parameters).toMatchObject({ properties: { part: { minimum: -1 } } })
    expect(knowledgeTools.find(tool => tool.spec.name === 'knowledge_update')?.spec.parameters).toMatchObject({ properties: { remember: { properties: { part: { minimum: -1 } } } } })
    const result = await sourceTool.run(sourceTool.prepare({ id: 'good', ...body }), { sandbox: undefined as never, signal: undefined, onOutput: undefined })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.output)).toMatchObject({ speaker: 'user', text: '所有工作都请中文回复', knowledge: [{ id: 'good', revision: 1 }] })
    expect(() => sourceTool.prepare({ id: 'good', ...body, part: -2 })).toThrow()

  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})
