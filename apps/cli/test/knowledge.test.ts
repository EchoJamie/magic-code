import { expect, test } from 'bun:test'
import { createFauxGateway } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { makeStage } from './support.ts'

test('知识工具的大blob结果落修订来源，派生知识继承后随遗忘退出', async () => {
  const stage = makeStage()
  const assembly = stage.assemble({ turns: [{ toolCalls: [{ name: 'knowledge_read', args: { id: 'large' } }] }, { text: '已核对完整知识' }] })
  const shell = attachShell(assembly.shell)
  try {
    const source = assembly.records.serviceFor('large-source')
    const entry = source.appendEntry({ kind: 'user', content: { text: '明确的原始依据' }, at: 1 })
    const change = { id: 'large', expectedRevision: 0, scope: { kind: 'project' as const, workspace: assembly.workspaceRoots }, topic: '大知识',
      terms: ['知识'], conclusion: '完整知识正文'.repeat(10000), conditions: '已核对条件', evidence: 'fact' as const, status: 'active' as const,
      sources: [{ session: 'large-source', entry }], dependencies: [] }
    expect(assembly.records.knowledge.write([change]).ok).toBe(true)
    await shell.submit('读取 large 的完整内容')
    const session = assembly.session!
    const records = assembly.records.serviceFor(session)
    const result = (await Array.fromAsync(records.readEntries(session))).find(entry => entry.kind === 'tool-result')!
    expect(result.payload).toMatchObject({ knowledge: [{ id: 'large', revision: 1 }] })
    expect(result.payload !== undefined && 'output' in result.payload && 'blob' in result.payload.output).toBe(true)
    const adopted = { id: 'adopted', kind: 'fact' as const, text: '采用有依据认识', evidence: 'fact' as const, status: 'active' as const, sources: [{ session, entry: result.id }] }
    expect(assembly.records.knowledge.write([{ ...change, id: 'derived', conclusion: '从完整知识派生', sources: adopted.sources }]).ok).toBe(true)
    expect(assembly.records.knowledge.read('derived')?.dependencies).toEqual([{ id: 'large', revision: 1, provided: true }])
    assembly.records.knowledge.forget({ id: 'large', expectedRevision: 1, requestId: 'forget-large' })
    expect(assembly.records.knowledge.read('derived')?.status).toBe('invalid')
    expect(assembly.records.knowledge.write([{ ...change, id: 'revived', sources: adopted.sources }]).ok).toBe(false)
  } finally { shell.dispose(); await assembly.shutdown(); stage.dispose() }
})

test('真实工作输入明确重新记住，经精读和更新原子恢复；普通更新不解除遗忘', async () => {
  const stage = makeStage()
  let assembly: Assembly | undefined
  let turn = 0
  try {
    assembly = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
      turn += 1
      if (turn === 2) {
        const read = request.messages.find(message => message.role === 'tool' && message.name === 'knowledge_read')
        if (read?.role !== 'tool') throw new Error('未实际交付知识读取结果')
        expect(read.output).toContain('"revision":2')
        expect(read.output).toContain('"conditions":""')
        expect(JSON.stringify(read)).toContain('forgotten')
      }
      const session = assembly!.session!
      const records = assembly!.records.serviceFor(session)
      const entry = records.inputs.list().find(row => row.entry !== undefined)!.entry!
      const changes = { topic: '认证', terms: ['鉴权'], conclusion: '重新确认异步认证结论', conditions: '只用于异步请求', evidence: 'fact', status: 'active' }
      const response = turn === 1 ? { toolCalls: [{ name: 'knowledge_read', args: { id: 'auth' } }] }
        : turn === 2 ? { toolCalls: [{ name: 'knowledge_update', args: { id: 'auth', expectedRevision: 2, changes } }] }
        : turn === 3 ? { toolCalls: [{ name: 'knowledge_update', args: { id: 'auth', expectedRevision: 2, changes, remember: { session, entry, part: -1 } } }] }
        : { text: '已按本次明确要求重新保存' }
      return createFauxGateway({ stamper, turns: [response] }).stream(request, options)
    } }) })
    const records = assembly.records.serviceFor('original')
    const entry = records.appendEntry({ kind: 'user', content: { text: '最初确认认证认识' }, at: 1 })
    expect(assembly.records.knowledge.write([{ id: 'auth', expectedRevision: 0, scope: { kind: 'project', workspace: assembly.workspaceRoots },
      topic: '认证', terms: [], conclusion: '原结论', conditions: '异步请求', evidence: 'fact', status: 'active', sources: [{ session: 'original', entry }], dependencies: [] }]).ok).toBe(true)
    assembly.records.knowledge.forget({ id: 'auth', expectedRevision: 1, requestId: 'forget-auth' })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit({ text: '请重新记住 auth：已重新确认异步认证结论，只用于异步请求 @auth', refs: [{ kind: 'memory', marker: '@auth', at: '请重新记住 auth：已重新确认异步认证结论，只用于异步请求 '.length, source: 'auth', revision: 2, scope: { kind: 'project', workspace: assembly.workspaceRoots } }] })
      const current = assembly.records.knowledge.read('auth')!
      expect(current).toMatchObject({ revision: 3, status: 'active', conclusion: '重新确认异步认证结论' })
      expect(current.sources.some(source => source.session === assembly!.session)).toBe(true)
      const outputs = (await Array.fromAsync(assembly.records.serviceFor(assembly.session!).readEntries(assembly.session!)))
        .filter(entry => entry.kind === 'tool-result').map(entry => entry.payload)
      expect(outputs[1]).toMatchObject({ ok: false })
      expect(outputs[2]).toMatchObject({ ok: true })
    } finally { shell.dispose() }
  } finally { await assembly?.shutdown(); stage.dispose() }
})
