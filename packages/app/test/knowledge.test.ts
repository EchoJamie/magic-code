import { expect, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import type { ModelRequest } from '@magic/contracts'
import { createFauxGateway } from '@magic/faux'
import { attachShell, type Assembly } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'
import { requestFromStoredSession } from './conversation-request.ts'

test('知识工具的大blob结果落修订来源，事项和派生知识继承后随遗忘退出', async () => {
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
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [adopted] }).ok).toBe(true)
    expect(records.memory.read().items.find(item => item.id === 'adopted')?.knowledge).toEqual([{ id: 'large', revision: 1, provided: true }])
    expect(assembly.records.knowledge.write([{ ...change, id: 'derived', conclusion: '从完整知识派生', sources: adopted.sources }]).ok).toBe(true)
    expect(assembly.records.knowledge.read('derived')?.dependencies).toEqual([{ id: 'large', revision: 1, provided: true }])
    assembly.records.knowledge.forget({ id: 'large', expectedRevision: 1, requestId: 'forget-large' })
    expect(records.memory.read().items.find(item => item.id === 'adopted')?.status).toBe('invalid')
    expect(assembly.records.knowledge.read('derived')?.status).toBe('invalid')
    expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [adopted] }).ok).toBe(false)
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
        expect(JSON.stringify(read)).toContain('本次明确读取的已失效历史证据')
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

for (const compressed of [true, false]) test(`初次候选直接生成答复，${compressed ? '已压缩' : '未压缩'}遗忘后不自动复活`, async () => {
  const stage = makeStage()
  const requests: ModelRequest[] = []
  let assembly!: Assembly
  let closed = false
  assembly = stage.assemble({ context: { nearEntries: 1 }, modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    const system = request.messages[0]?.role === 'system' ? request.messages[0].content : ''
    if (system.includes('这是当前工作的受限记忆整理')) {
      if (!compressed) expect(JSON.stringify(request.messages)).not.toContain('派生答复：认证应核对异步分派')
      const frozen = JSON.stringify(request.messages).match(/冻结上界：(\d+)；预期修订：(\d+)/)
      if (!frozen) throw new Error('整理请求缺少冻结范围')
      return createFauxGateway({ stamper, turns: [{ toolCalls: [{ name: 'memory_update', args: {
        expectedRevision: Number(frozen[2]), inspectedThrough: Number(frozen[1]), changes: [],
      } }] }] }).stream(request, options)
    }
    return createFauxGateway({ stamper, turns: [{ text: system.includes('你是会话压缩器')
      ? '摘要派生旧认证结论' : '派生答复：认证应核对异步分派' }] }).stream(request, options)
  } }) })
  const shell = attachShell(assembly.shell)
  try {
    const source = assembly.records.serviceFor('source')
    const entry = source.appendEntry({ kind: 'user', content: { text: '确认异步认证结论' }, at: 1 })
    expect(assembly.records.knowledge.write([{ id: 'async-auth', expectedRevision: 0, scope: { kind: 'project', workspace: [realpathSync(stage.workspace)] },
      topic: '认证', terms: ['鉴权'], conclusion: '候选结论：认证应核对异步分派', conditions: '异步请求', evidence: 'fact', status: 'active',
      sources: [{ session: 'source', entry }], dependencies: [] }]).ok).toBe(true)
    await shell.submit('检查鉴权条件后答复')
    const session = assembly.session!
    const records = assembly.records.serviceFor(session)
    const entries = await Array.fromAsync(records.readEntries(session))
    const answer = entries.find(entry => entry.kind === 'assistant')!
    expect(answer.payload).toEqual({ knowledge: [{ id: 'async-auth', revision: 1 }] })
    expect(entries.some(entry => entry.kind === 'tool-call')).toBe(false)
    expect(records.memory.read().items.some(item => item.knowledge?.length)).toBe(false)
    expect(JSON.stringify(requests[0]!.messages)).toContain('候选结论：认证应核对异步分派')
    records.appendEntry({ kind: 'user', content: { text: '继续检查新的独立问题' }, at: 2 })
    if (compressed) {
      expect((await assembly.compact(session, { requestId: 'compact-direct', focus: '保留知识依据' }, new AbortController().signal, () => {})).state).toBe('completed')
      expect(records.memory.read().inspectedThrough).toBeGreaterThanOrEqual(answer.id)
      const summary = (await Array.fromAsync(records.readEntries(session))).find(entry => entry.kind === 'summary')!
      expect(summary.payload).toMatchObject({ knowledge: [{ id: 'async-auth', revision: 1 }] })
      expect((await Array.fromAsync(records.readEvents(session))).filter(event => event.kind === 'compact.state').map(event => event.data))
        .toEqual([{ requestId: 'compact-direct', focus: '保留知识依据', accepted: true, state: 'completed', summary: summary.id }])
    }
    expect(assembly.records.knowledge.forget({ id: 'async-auth', expectedRevision: 1, requestId: 'forget-direct' }).status).toBe('completed')
    expect(records.memory.read().summary).toBeNull()
    const attempted = records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{
      id: 'revived', kind: 'fact', text: '错误再提炼', evidence: 'fact', status: 'active', sources: [{ session, entry: answer.id }],
    }] })
    expect(attempted.ok).toBe(false)
    if (!compressed) {
      expect((await assembly.compact(session, { requestId: 'compact-after-forget' }, new AbortController().signal, () => {})).state).toBe('completed')
      expect(records.memory.read().inspectedThrough).toBeGreaterThanOrEqual(answer.id)
      const summaryRequests = requests.filter(request => JSON.stringify(request.messages[0]).includes('你是会话压缩器'))
      expect(summaryRequests).toHaveLength(1)
      expect(JSON.stringify(summaryRequests)).not.toContain('派生答复：认证应核对异步分派')
    }
    shell.dispose(); await assembly.shutdown(); closed = true
    const reopened = stage.assemble({ session, turns: [{ text: '已核对当前工作' }] })
    const continued = attachShell(reopened.shell)
    try {
      await continued.submit('继续核对已存工作')
      const next = stage.models.at(-1)!.requests
      expect(next).toHaveLength(1)
      const text = JSON.stringify(next[0]!.messages)
      expect(text).not.toContain('派生答复：认证应核对异步分派')
      if (compressed) expect(text).not.toContain('摘要派生旧认证结论')
      expect(text).toContain('继续检查新的独立问题')
      expect((await Array.fromAsync(reopened.records.serviceFor(session).readEntries(session))).find(entry => entry.id === answer.id)?.content).toEqual(answer.content)
    } finally { continued.dispose(); await reopened.shutdown() }
  } finally { shell.dispose(); if (!closed) await assembly.shutdown(); stage.dispose() }
})

test('真实装配工作循环形成知识，收尾完成后新会话发现并精读证据', async () => {
  const stage = makeStage()
  let assembly: Assembly | undefined
  const requests: ModelRequest[] = []
  let business = 0
  try {
    assembly = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
      requests.push(request)
      const knowledge = request.messages[0]?.role === 'system' && request.messages[0].content.includes('阶段知识整理器')
      const live = assembly!
      const session = live.session!
      const records = live.records.serviceFor(session)
      const snapshot = records.memory.read()
      let turn
      if (knowledge) {
        turn = { text: JSON.stringify({ changes: [{ id: 'async-auth', expectedRevision: 0, candidateIds: ['finding'], topic: '认证排查', terms: ['鉴权', 'async'],
          conclusion: '认证排查需要检查异步分派', conditions: '仅在异步请求中适用', evidence: 'fact', status: 'active', dependencies: [] }] }), usage: { inputTokens: 31 } }
      } else {
        business += 1
        if (business === 1) {
          const input = records.inputs.list().find(row => row.entry !== undefined)!
          turn = { toolCalls: [{ name: 'memory_update', args: { expectedRevision: snapshot.revision, changes: [{
            id: 'finding', kind: 'fact', text: '认证排查需要检查异步分派', evidence: 'fact', status: 'active', reuse: 'project', sources: [{ session, entry: input.entry }],
          }] } }] }
        } else if (business === 2) turn = { text: '本阶段检查已完成' }
        else if (business === 3) turn = { toolCalls: [{ name: 'knowledge_read', args: { id: 'async-auth' } }] }
        else if (business === 4) {
          const source = live.records.knowledge.read('async-auth')!.sources[0]!
          turn = { toolCalls: [{ name: 'knowledge_source', args: { id: 'async-auth', ...source } }] }
        } else turn = { text: '已核对来源与异步请求条件，采用该认识' }
      }
      return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
    } }) })
    const shell = attachShell(assembly.shell)
    try {
      await shell.submit('已验证认证故障与异步分派有关，请保存认识')
      expect(assembly.records.knowledge.search({ query: '鉴权' }).items.map(item => item.id)).toEqual(['async-auth'])
      const internal = eventsOfKind(shell.events, 'memory.model').filter(event => event.data.purpose === 'knowledge')
      expect(internal).toHaveLength(1)
      expect(internal[0]?.data).toMatchObject({ ok: true, usage: { inputTokens: 31 } })
      expect(eventsOfKind(shell.events, 'model.usage')).toHaveLength(0)
      const oldSession = assembly.session
      const changed = shell.until(event => event.kind === 'session.state')
      shell.send({ type: 'session.new' })
      await changed
      await shell.submit('另一个异步请求出现鉴权问题，参考适用知识')
      expect(assembly.session).not.toBe(oldSession)
      const nextRequest = requests.find(request => JSON.stringify(request.messages).includes('〔有关知识候选〕'))!
      expect(nextRequest).toBeDefined()
      expect(JSON.stringify(nextRequest.messages)).toContain('仅在异步请求中适用')
      const tools = requests.flatMap(request => request.messages).filter(message => message.role === 'tool')
      expect(tools.some(message => message.role === 'tool' && message.name === 'knowledge_read' && message.output.includes('async-auth'))).toBe(true)
      expect(tools.some(message => message.role === 'tool' && message.name === 'knowledge_source' && message.output.includes('已验证认证故障与异步分派有关'))).toBe(true)
      expect(eventsOfKind(shell.events, 'memory.model').filter(event => event.data.purpose === 'knowledge')).toHaveLength(1)
    } finally { shell.dispose() }
  } finally { await assembly?.shutdown(); stage.dispose() }
})

test('真实收尾期间保持工作责任，停止取消Cantrip且不推进整理位置', async () => {
  const stage = makeStage()
  let assembly: Assembly | undefined
  let started!: () => void
  const arranging = new Promise<void>(resolve => { started = resolve })
  let business = 0
  try {
    assembly = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
      const knowledge = request.messages[0]?.role === 'system' && request.messages[0].content.includes('阶段知识整理器')
      if (knowledge) {
        started()
        let finish!: () => void
        const stopped = new Promise<void>(resolve => { finish = resolve })
        if (options.signal?.aborted) finish()
        else options.signal?.addEventListener('abort', finish, { once: true })
        return { events: (async function* () { await stopped })(), result: stopped.then(() => ({ complete: false, finishReason: 'error' as const })) }
      }
      business += 1
      const records = assembly!.records.serviceFor(assembly!.session!)
      const first = records.inputs.list().find(row => row.entry !== undefined)!
      const turn = business === 1 ? { toolCalls: [{ name: 'memory_update', args: { expectedRevision: records.memory.read().revision, changes: [{
        id: 'finding', kind: 'fact', text: '本阶段认识', evidence: 'fact', status: 'active', sources: [{ session: assembly!.session, entry: first.entry }],
      }] } }] } : { text: '阶段结束' }
      return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
    } }) })
    const shell = attachShell(assembly.shell)
    try {
      const submission = shell.submit('开始阶段任务')
      await Promise.race([arranging, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('知识整理未开始')), 2000); arranging.finally(() => clearTimeout(timer)) })])
      expect(eventsOfKind(shell.events, 'agent.state').at(-1)?.data.state).toBe('resumed')
      shell.send({ type: 'turn.interrupt' })
      await submission
      expect(assembly.records.knowledge.progress(assembly.session!).memoryRevision).toBe(0)
      expect(assembly.records.knowledge.search().items).toEqual([])
      expect(eventsOfKind(shell.events, 'memory.model').find(event => event.data.purpose === 'knowledge')?.data.ok).toBe(false)
      expect(eventsOfKind(shell.events, 'agent.state').at(-1)?.data.state).toBe('waiting')
    } finally { shell.dispose() }
  } finally { await assembly?.shutdown(); stage.dispose() }
})

for (const invalidation of ['none', 'revise', 'forget'] as const) test(`knowledge_source到memory_update到Cantrip保留跨会话具体证据授权：${invalidation}`, async () => {
  const stage = makeStage()
  let app!: Assembly
  let business = 0
  let sourceEntry = 0
  let otherEntry = 0
  const requests: ModelRequest[] = []
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    const knowledge = request.messages[0]?.role === 'system' && request.messages[0].content.includes('阶段知识整理器')
    if (knowledge) {
      if (invalidation === 'forget') app.records.knowledge.forget({ id: 'original', expectedRevision: 1, requestId: 'forget-during-organize' })
      if (invalidation === 'revise') {
        const prior = app.records.knowledge.read('original')!
        expect(app.records.knowledge.write([{ ...prior, expectedRevision: 1, status: 'active', conclusion: '修正后的认识' }]).ok).toBe(true)
      }
      return createFauxGateway({ stamper, turns: [{ text: JSON.stringify({ changes: [{ id: 'derived', expectedRevision: 0, candidateIds: ['adopted'],
        topic: '新认识', terms: [], conclusion: '核对原始证据后的认识', conditions: '原条件内', evidence: 'fact', status: 'active', dependencies: [] }] }) }] }).stream(request, options)
    }
    business += 1
    const memory = { id: 'adopted', kind: 'fact', text: '核对证据后的认识', evidence: 'fact', status: 'active', reuse: 'project',
      sources: [{ session: 'source', entry: sourceEntry }], knowledge: [{ id: 'original', revision: 1 }] }
    const turn = business === 1 ? { toolCalls: [{ name: 'knowledge_source', args: { id: 'original', session: 'source', entry: sourceEntry } }] }
      : business === 2 ? { toolCalls: [
        { name: 'knowledge_source', args: { id: 'original', session: 'source', entry: otherEntry } },
        { name: 'memory_update', args: { expectedRevision: 0, changes: [{ ...memory, sources: [{ session: 'source', entry: otherEntry }] }] } },
        { name: 'memory_update', args: { expectedRevision: 0, changes: [memory] } },
      ] } : { text: '本阶段完成' }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    const source = app.records.serviceFor('source')
    sourceEntry = source.appendEntry({ kind: 'user', content: { text: '可复用的原始具体证据' }, at: 1 })
    otherEntry = source.appendEntry({ kind: 'user', content: { text: '未授权的相邻秘密' }, at: 2 })
    expect(app.records.knowledge.write([{ id: 'original', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '原认识', terms: [],
      conclusion: '先前结论', conditions: '原条件内', evidence: 'fact', status: 'active', sources: [{ session: 'source', entry: sourceEntry }], dependencies: [] }]).ok).toBe(true)
    await shell.submit('核对已有知识的证据并保存新认识')
    expect(eventsOfKind(shell.events, 'tool.result').map(event => event.data.ok)).toEqual([true, false, false, true])
    const organized = requests.filter(request => JSON.stringify(request.messages[0]).includes('阶段知识整理器'))
    expect(organized).toHaveLength(1)
    expect(JSON.stringify(organized)).toContain('可复用的原始具体证据')
    expect(JSON.stringify(organized)).not.toContain('未授权的相邻秘密')
    expect(app.records.knowledge.read('derived')?.status).toBe(invalidation === 'none' ? 'active' : undefined)
    expect(app.records.knowledge.progress(app.session!).items).toEqual(invalidation === 'none' ? { adopted: 1 } : {})
    expect(eventsOfKind(shell.events, 'memory.model').find(event => event.data.purpose === 'knowledge')?.data.ok).toBe(invalidation === 'none')
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})

for (const failSecond of [false, true]) test(`混合范围阶段整理逐次发布实际Cantrip用量，整轮${failSecond ? '失败' : '成功'}`, async () => {
  const stage = makeStage()
  let app!: Assembly
  let business = 0
  let knowledgeCalls = 0
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    const knowledge = request.messages[0]?.role === 'system' && request.messages[0].content.includes('阶段知识整理器')
    let turn
    if (knowledge) {
      knowledgeCalls += 1
      const body = JSON.parse((request.messages[1] as { content: string }).content)
      const candidate = body.candidates[0]
      turn = { text: failSecond && knowledgeCalls === 2 ? 'not-json' : JSON.stringify({ changes: [{ id: `knowledge-${candidate.id}`, expectedRevision: 0,
        candidateIds: [candidate.id], topic: candidate.text, terms: [], conclusion: candidate.text, conditions: '明确范围', evidence: 'fact', status: 'active', dependencies: [] }] }),
        usage: { inputTokens: knowledgeCalls * 17 } }
    } else {
      business += 1
      const records = app.records.serviceFor(app.session!)
      const entry = records.inputs.list().find(row => row.entry !== undefined)!.entry!
      const source = { session: app.session!, entry }
      turn = business === 1 ? { toolCalls: [{ name: 'memory_update', args: { expectedRevision: 0, changes: [
        { id: 'language', kind: 'requirement', text: '所有工作中文回复', evidence: 'fact', status: 'active', reuse: 'user', sources: [source] },
        { id: 'finding', kind: 'fact', text: '本项目已验证的结论', evidence: 'fact', status: 'active', reuse: 'project', sources: [source] },
      ] } }] } : { text: '阶段完成' }
    }
    return createFauxGateway({ stamper, turns: [turn] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('所有工作中文回复；本项目已有验证结论，请保存各自认识')
    expect(knowledgeCalls).toBe(2)
    const calls = eventsOfKind(shell.events, 'memory.model').filter(event => event.data.purpose === 'knowledge')
    expect(calls.map(event => event.data.usage?.inputTokens)).toEqual([17, 34])
    expect(calls.map(event => event.data.ok)).toEqual([!failSecond, !failSecond])
    expect(calls.every(event => event.data.usage?.outputTokens === undefined)).toBe(true)
    expect(app.records.knowledge.progress(app.session!).items).toEqual(failSecond ? {} : { language: 1, finding: 1 })
    expect(app.records.knowledge.search().items).toHaveLength(failSecond ? 0 : 2)
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})

for (const method of ['memory_read', 'memory_update', 'failed-update', 'source_read', 'history_read', 'plan_read'] as const) test(`真实 ${method} 返回记忆材料保留知识修订，遗忘后重放与再保存不能绕过`, async () => {
  const stage = makeStage()
  let app!: Assembly
  let calls = 0
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    calls += 1
    const records = app.records.serviceFor(app.session!)
    if (calls === 1) {
      const entry = records.inputs.list().find(row => row.entry !== undefined)!.entry!
      const source = { session: app.session!, entry }
      expect(app.records.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '知识', terms: [],
        conclusion: '待遗忘知识', conditions: '测试条件', evidence: 'fact', status: 'active', sources: [source], dependencies: [] }]).ok).toBe(true)
      expect(records.memory.update({ expectedRevision: 0, changes: [
        { id: 'dependent', kind: 'question', text: '材料中的旧知识独有正文', detail: '完整材料'.repeat(5000), evidence: 'hypothesis', status: 'active', sources: [source], knowledge: [{ id: 'K', revision: 1 }] },
        { id: 'goal', kind: 'goal', text: '用户明确目标继续有效', evidence: 'fact', status: 'active', sources: [source] },
        { id: 'independent', kind: 'question', text: '独立问题继续保留', evidence: 'unresolved', status: 'active', sources: [source] },
      ] }).ok).toBe(true)
      const prior = records.appendEntry({ kind: 'assistant', content: { text: '材料中的旧知识独有正文' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 1 })
      const name = method === 'failed-update' ? 'memory_update' : method
      const args = method === 'source_read' ? { session: app.session!, entry: prior }
        : method === 'history_read' ? { entry: prior }
        : method === 'memory_update' || method === 'failed-update' ? { expectedRevision: method === 'failed-update' ? 99 : 1, changes: [] } : {}
      return createFauxGateway({ stamper, turns: [{ toolCalls: [{ name, args }] }] }).stream(request, options)
    }
    if (calls === 2 || calls === 3) {
      const stream = Array.fromAsync(records.readEntries(app.session!)).then(entries => {
        const prior = entries.filter(entry => entry.kind === 'tool-result').at(-1)!
        return createFauxGateway({ stamper, turns: [{ toolCalls: [{ name: 'source_read', args: { session: app.session!, entry: prior.id, limit: 32000 } }] }] }).stream(request, options)
      })
      return { events: (async function* () { yield* (await stream).events })(), result: stream.then(value => value.result) }
    }
    return createFauxGateway({ stamper, turns: [{ text: '本轮完成' }] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('保留本次工作要求')
    const session = app.session!
    const records = app.records.serviceFor(session)
    const results = (await Array.fromAsync(records.readEntries(session))).filter(entry => entry.kind === 'tool-result')
    expect(results).toHaveLength(3)
    for (const result of results) expect(result.payload).toMatchObject({ knowledge: [{ id: 'K', revision: 1 }] })
    const result = results[0]!
    if (['memory_read', 'memory_update', 'failed-update'].includes(method)) expect(result.payload !== undefined && 'output' in result.payload && 'blob' in result.payload.output).toBe(true)
    expect(app.records.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: `forget-${method}` }).status).toBe('completed')
    await shell.submit('继续独立问题')
    // 实际网关的请求由下面单独绑定的会话入口取回，避免模型自报作为证据。
    const next = await requestFromStoredSession({ records, session, cwd: stage.workspace, knowledge: app.records.knowledge, text: '核对现有材料' })
    expect(JSON.stringify(next.messages)).not.toContain('材料中的旧知识独有正文')
    expect(JSON.stringify(next.messages)).toContain('用户明确目标继续有效')
    expect(JSON.stringify(next.messages)).toContain('独立问题继续保留')
    const adopted = { id: 'revive', kind: 'fact' as const, text: '不能从旧工具结果再保存', evidence: 'fact' as const, status: 'active' as const, sources: [{ session, entry: result.id }] }
    for (const result of results) expect(records.memory.update({ expectedRevision: records.memory.read().revision, changes: [{ ...adopted, sources: [{ session, entry: result.id }] }] }).ok).toBe(false)
    expect(app.records.knowledge.write([{ id: 'revived', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '再提炼', terms: [], conclusion: '禁止恢复', conditions: '旧结果', evidence: 'fact', status: 'active', sources: adopted.sources, dependencies: [] }]).ok).toBe(false)
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})

for (const tool of ['source_read', 'history_read', 'knowledge_source', 'knowledge_read']) test(`遗忘后明确 ${tool} 的原文出口与下一请求自动投影分别核对`, async () => {
  const stage = makeStage()
  let app!: Assembly
  const requests: ModelRequest[] = []
  app = stage.assemble({ modelGateway: stamper => ({ stream(request, options) {
    requests.push(request)
    if (requests.length > 1) return createFauxGateway({ stamper, turns: [{ text: '完成' }] }).stream(request, options)
    const records = app.records.serviceFor(app.session!)
    const entry = records.inputs.list().find(row => row.entry !== undefined)!.entry!
    app.records.knowledge.write([{ id: 'K', expectedRevision: 0, scope: { kind: 'project', workspace: app.workspaceRoots }, topic: '旧依据', terms: [], conclusion: '显式请求的原文独有正文', conditions: '旧条件', evidence: 'fact', status: 'active', sources: [{ session: app.session!, entry }], dependencies: [] }])
    const original = records.appendEntry({ kind: 'assistant', content: { text: '显式请求的原文独有正文' }, payload: { knowledge: [{ id: 'K', revision: 1 }] }, at: 2 })
    app.records.knowledge.forget({ id: 'K', expectedRevision: 1, requestId: 'forget-before-read' })
    return createFauxGateway({ stamper, turns: [{ toolCalls: [{ name: tool, args: tool === 'knowledge_read' ? { id: 'K' } : tool === 'knowledge_source' ? { id: 'K', session: app.session!, entry } : { ...(tool === 'source_read' ? { session: app.session! } : {}), entry: original } }] }] }).stream(request, options)
  } }) })
  const shell = attachShell(app.shell)
  try {
    await shell.submit('显式请求的原文独有正文')
    const records = app.records.serviceFor(app.session!)
    const output = (await Array.fromAsync(records.readEntries(app.session!))).find(entry => entry.kind === 'tool-result')!
    expect(JSON.stringify(output)).toContain(tool === 'knowledge_read' ? 'forgotten' : '显式请求的原文独有正文')
    const delivered = requests[1]!.messages.filter(message => message.role === 'tool')
    expect(JSON.stringify(delivered)).toContain('本次明确读取的已失效历史证据')
    expect(JSON.stringify(delivered)).toContain(tool === 'knowledge_read' ? 'forgotten' : '显式请求的原文独有正文')
    const next = await requestFromStoredSession({ records, session: app.session!, cwd: stage.workspace, knowledge: app.records.knowledge, text: '后续自动接续' })
    expect(JSON.stringify(next.messages.filter(message => message.role === 'tool'))).not.toContain('显式请求的原文独有正文')
  } finally { shell.dispose(); await app.shutdown(); stage.dispose() }
})
