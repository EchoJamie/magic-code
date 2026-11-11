import { expect, test, spyOn } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesFixture, continuationTurn, continuationCounts } from './notes-support.ts'
import { requestFromStoredSession } from './conversation-request.ts'
import { createCompactController } from '../src/run/compact.ts'

const textOf = (request: { messages: unknown }) => JSON.stringify(request.messages)

test('空正文不要求额外读取，有正文的来源仍完整读取后才提交覆盖', async () => {
  const f = notesFixture({ material: ['保留实际用户要求', '', '后续交代'], turn(request) {
    const turn = continuationTurn(request)
    return { ...turn, toolCalls: turn.toolCalls?.filter(call => call.name !== 'history_read' || call.args?.entry !== 2) }
  } })
  try {
    expect(await f.compact()).toMatchObject({ state: 'completed', notesSaved: true })
    expect(f.records.coverage.read().coveredThrough).toBe(2)
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('保留实际用户要求')
  } finally { await f.close() }
})

test('部分来源保存后的回执指出未读范围，模型可读完再保存而不丢已存笔记', async () => {
  const original = '原始交代：全部要求都要保留，不能只读开头'
  const f = notesFixture({ material: [original, '已检查范围仍需区分', '继续工作'], turn(request) {
    const results = request.messages.filter(message => message.role === 'tool')
    const saved = results.filter(message => message.name === 'write' && message.ok)
    if (saved.length > 1) return { text: '接续材料已完整保存' }
    if (saved.length === 1) {
      if (!saved[0]!.output.includes('尚未读取')) return { text: '保存后结束' }
      const system = request.messages[0]!
      const directory = /只维护自身笔记 (.+)，通常/.exec(String(system.role === 'system' ? system.content : ''))![1]!
      const rest = results.some(message => message.name === 'history_read' && JSON.parse(message.output).source.offset === 3)
      return rest ? { toolCalls: [{ name: 'write', args: { path: join(directory, 'MEMORY.md'), content: original + '\n已检查范围仍需区分' } }] }
        : { toolCalls: [{ name: 'history_read', args: { entry: 1, offset: 3 } }, { name: 'read', args: { path: join(directory, 'MEMORY.md') } }] }
    }
    const turn = continuationTurn(request)
    return { ...turn, toolCalls: turn.toolCalls?.map(call => call.name === 'history_read' && call.args?.entry === 1
      ? { ...call, args: { ...call.args, limit: 3 } } : call) }
  } })
  try {
    expect(await f.compact()).toMatchObject({ state: 'completed', notesSaved: true })
    expect(f.records.coverage.read().coveredThrough).toBe(2)
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain(original)
    const feedback = f.requests.flatMap(request => request.messages).filter(message => message.role === 'tool' && message.name === 'write')
    expect(feedback.some(message => message.role === 'tool' && message.ok && message.output.includes('offset=3'))).toBe(true)
  } finally { await f.close() }
})

test('最终笔记 I/O 返回前的新输入使旧候选作废，原请求处理输入后再提交', async () => {
  const f = notesFixture()
  const snapshot = f.notes.snapshot.bind(f.notes)
  let injected = false
  const spy = spyOn(f.notes, 'snapshot').mockImplementation(async () => {
    const final = !new Error().stack!.includes('organize.ts') && f.requests.some(request =>
      request.messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok))
    const files = await snapshot()
    if (final && !injected) {
      injected = true
      f.service.submit({ ref: 'review-final-boundary', text: '新增纠正：先核实再继续，不能使用旧结论' })
    }
    return files
  })
  try {
    expect(await f.compact('final-boundary')).toMatchObject({ state: 'completed', requestId: 'final-boundary' })
    expect(injected).toBe(true)
    expect(f.records.inputs.get('review-final-boundary')?.state).toBe('included')
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('不能使用旧结论')
    expect(f.records.coverage.read().coveredThrough).toBeGreaterThan(2)
    expect(f.events.filter(event => event.kind === 'context.compacted')).toHaveLength(1)
    expect(f.events.filter(event => event.kind === 'compact.state').every(event => event.data.requestId === 'final-boundary')).toBe(true)
  } finally { spy.mockRestore(); await f.close() }
})

for (const change of ['plan', 'coverage', 'recorded-user'] as const) test(`最终笔记 I/O 返回前 ${change} 改变，同步复核拒绝旧候选`, async () => {
  const f = notesFixture()
  const snapshot = f.notes.snapshot.bind(f.notes)
  let injected = false, priorContexts = 0
  const spy = spyOn(f.notes, 'snapshot').mockImplementation(async () => {
    const final = !new Error().stack!.includes('organize.ts') && f.requests.some(request =>
      request.messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok))
    const files = await snapshot()
    if (final && !injected) {
      injected = true
      priorContexts = f.requests.filter(request => request.messages.length === 2).length
      if (change === 'plan') f.records.appendEntry({ kind: 'tool-result', content: { text: '新计划已保存' },
        payload: { ok: true, output: { text: '新计划已保存' }, plan: { goal: '最终窗口的新计划', steps: [], notes: '' } }, at: 4 })
      else if (change === 'coverage') f.records.coverage.publish({ previousSummary: null, from: 1, through: 1, notesSaved: true, at: 4 })
      else f.records.appendEntry({ kind: 'user', content: { text: '最终窗口的新原始交代' }, at: 4 })
    }
    return files
  })
  try {
    expect(await f.compact(`final-${change}`)).toMatchObject({ state: 'completed', requestId: `final-${change}` })
    expect(injected).toBe(true)
    expect(f.requests.filter(request => request.messages.length === 2).length).toBeGreaterThan(priorContexts)
    if (change === 'plan') expect(JSON.stringify(f.requests.slice(-3))).toContain('最终窗口的新计划')
    expect(f.events.filter(event => event.kind === 'context.compacted')).toHaveLength(1)
  } finally { spy.mockRestore(); await f.close() }
})

test('当前模型真实工具准备后一次提交覆盖；辅助思考/工具配对独立保存，新窗口不伪造已读笔记', async () => {
  const f = notesFixture()
  try {
    const result = await f.compact()
    expect(result).toMatchObject({ state: 'completed', notesSaved: true })
    expect(f.records.coverage.read().coveredThrough).toBe(2)
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('焦点未验')
    const normal = await Array.fromAsync(f.records.readEntries(f.session))
    expect(normal.some(entry => entry.kind === 'continuation')).toBe(false)
    const all = await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true }))
    const auxiliary = all.filter(entry => entry.kind === 'continuation')
    expect(auxiliary.length).toBeGreaterThan(8)
    expect(JSON.stringify(auxiliary)).toContain('真实保存已确认')
    for (const request of f.requests) for (let index = 0; index < request.messages.length; index++) {
      const message = request.messages[index]!
      if (message.role === 'assistant' && message.toolCalls) for (const call of message.toolCalls) {
        expect(request.messages.slice(index + 1).some(result => result.role === 'tool' && result.callId === call.id)).toBe(true)
      }
    }
    expect(f.events.some(event => event.kind === 'turn.start' || event.kind === 'message.assistant')).toBe(false)
    const next = await requestFromStoredSession({ records: f.records, session: f.session, cwd: f.dir, text: '继续当前工作' })
    expect(textOf(next)).not.toContain('焦点未验')
    expect(textOf(next)).not.toContain('真实保存已确认')
    expect(textOf(next)).toContain('继续核对')
    expect(next.messages.some(message => message.role === 'tool')).toBe(false)
  } finally { await f.close() }
})

test('部分保存后取消保留文件和原覆盖，既有请求事件支持重启查询', async () => {
  const abort = new AbortController()
  const f = notesFixture({ turn(request) {
    if (request.messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok)) abort.abort()
    return continuationTurn(request)
  } })
  try {
    expect(await f.compact('partial', abort.signal)).toMatchObject({ state: 'cancelled', notesSaved: true })
    expect(f.records.coverage.read().summary).toBeNull()
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('用户要求')
    expect(f.events.some(event => event.kind === 'compact.state' && event.data.requestId === 'partial' && event.data.notesSaved)).toBe(true)
    const controller = createCompactController({ store: f.store, now: Date.now, publish() {} })
    await controller.recover()
    expect(await controller.query(f.session, 'partial')).toMatchObject({ state: 'interrupted', notesSaved: true })
    await controller.close()
  } finally { await f.close() }
})

test('准备时外部编辑使候选作废，沿原请求重读后提交；不覆盖外部内容', async () => {
  let changed = false
  const f = notesFixture({ gateway(base) { return { stream(request, options) {
    const stream = base.stream(request, options)
    return { ...stream, events: (async function* () {
      if (!changed && request.messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok)) {
        changed = true; await writeFile(join(f.notes.directory, 'MEMORY.md'), '外部纠正必须保留')
      }
      yield* stream.events
    })() }
  } } } })
  try {
    expect(await f.compact('same-request')).toMatchObject({ state: 'completed' })
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('外部纠正必须保留')
    expect(f.events.filter(event => event.kind === 'context.compacted')).toHaveLength(1)
    expect((await Array.fromAsync(f.records.readEvents(f.session))).filter(event => event.kind === 'compact.state' && event.data.state === 'completed')).toHaveLength(1)
  } finally { await f.close() }
})

test('最小请求仍超预算与没有工具调用均不推进覆盖、不换模型', async () => {
  for (const options of [{ budget: 100 }, { turn: () => ({ text: '自称已完成' }) }]) {
    const f = notesFixture(options)
    try {
      expect(await f.compact()).toMatchObject({ state: 'failed', notesSaved: false })
      expect(f.records.coverage.read().summary).toBeNull()
      expect((await f.notes.read()).status).toBe('empty')
      if ('budget' in options) expect(f.requests).toHaveLength(0)
    } finally { await f.close() }
  }
})

test('准备中新交代先走普通输入链，再沿同一请求重准备；新覆盖只能提交一次', async () => {
  let submitted = false
  const f = notesFixture({ gateway(base) { return { stream(request, options) {
    const stream = base.stream(request, options)
    return { ...stream, events: (async function* () {
      if (!submitted && request.messages.some(message => message.role === 'tool' && message.name === 'write' && message.ok)) {
        submitted = true
        f.service.submit({ ref: 'correction', text: '新增要求：尾部检查必须继续' })
      }
      yield* stream.events
    })() }
  } } } })
  try {
    expect(await f.compact('original')).toMatchObject({ state: 'completed', requestId: 'original', notesSaved: true })
    const ordinary = f.requests.findIndex(request => !(request.messages[0]?.role === 'system' && typeof request.messages[0].content === 'string' && request.messages[0].content.startsWith('这是当前模型的独立接续准备')))
    expect(ordinary).toBeGreaterThan(0)
    expect(f.requests.slice(ordinary + 1).some(request => textOf(request).includes('独立接续准备'))).toBe(true)
    expect(f.records.inputs.get('correction')?.state).toBe('included')
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('尾部检查必须继续')
    expect(f.events.filter(event => event.kind === 'context.compacted')).toHaveLength(1)
  } finally { await f.close() }
})

test('单条长材料有界分段，两次压缩后27个未决点及来源仍可由真实文件取回', async () => {
  const f = notesFixture({ budget: 20000, turn: request => continuationTurn(request, text => text.replace(/填/g, '').trim()) })
  try {
    const text = '填'.repeat(19000) + '\n' + Array.from({ length: 27 }, (_, i) => `未决${i + 1}：参数值=${8100 + i}，尚未验证`).join('\n')
    const source = f.records.appendEntry({ kind: 'user', content: { blob: await f.records.blobs.put(text) }, at: 10 })
    f.records.appendEntry({ kind: 'assistant', content: { text: '保留近段' }, at: 11 })
    expect(await f.compact('one')).toMatchObject({ state: 'completed' })
    const first = f.records.coverage.read()
    f.records.appendEntry({ kind: 'user', content: { text: '第二阶段继续，禁止把未验证写成完成' }, at: 12 })
    f.records.appendEntry({ kind: 'assistant', content: { text: '第二阶段近段' }, at: 13 })
    expect(await f.compact('two')).toMatchObject({ state: 'completed' })
    expect(f.records.coverage.read().coveredThrough).toBeGreaterThan(first.coveredThrough!)
    const saved = await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')
    for (let n = 1; n <= 27; n++) expect(saved).toContain(`未决${n}：参数值=${8099 + n}，尚未验证`)
    expect(saved).toContain(`work#${source}`)
    expect(saved).toContain('禁止把未验证写成完成')
    const initial = f.requests.filter(request => request.messages.length === 2)
    expect(initial.length).toBeGreaterThan(2)
    expect(initial.every(request => !textOf(request).includes('参数值='))).toBe(true)
    const sourceResults = f.requests.flatMap(request => request.messages.filter(message => message.role === 'tool' && message.name === 'history_read'))
    expect(sourceResults.every(result => result.role === 'tool' && JSON.parse(result.output).text.length < 19000)).toBe(true)
  } finally { await f.close() }
})

test('辅助流中途失败仍保留实际思考与正文，不伪造工具结果或提交覆盖', async () => {
  const f = notesFixture({ gateway() { return { stream() {
    return { events: (async function* () {
      yield f.stamper.stamp('model.delta', { channel: 'thinking', text: '已开始核对但未完成' })
      yield f.stamper.stamp('model.delta', { channel: 'text', text: '只到达的部分正文' })
      throw new Error('受控中途断流')
    })(), result: Promise.resolve({ complete: false, finishReason: 'error' as const }) }
  } } } })
  try {
    expect(await f.compact()).toMatchObject({ state: 'failed', notesSaved: false, reason: '受控中途断流' })
    expect(f.records.coverage.read().summary).toBeNull()
    const entries = await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true }))
    const messages = entries.flatMap(entry => entry.kind === 'continuation' && entry.payload && 'message' in entry.payload ? [entry.payload.message] : [])
    expect(messages).toContainEqual({ role: 'assistant', content: '只到达的部分正文', reasoning: '已开始核对但未完成' })
    expect(messages.some(message => message.role === 'tool')).toBe(false)
  } finally { await f.close() }
})

test('20条共218字的短记录按容量合并，19条旧记录只需一个辅助上下文及一次保存', async () => {
  const material = Array.from({ length: 20 }, (_, index) => `短记录${index + 1}：事实`.padEnd(index < 18 ? 11 : 10, '。'))
  expect(material.join('').length).toBe(218)
  const f = notesFixture({ material, near: 1, budget: 32000 })
  try {
    expect(await f.compact('short-batch')).toMatchObject({ state: 'completed' })
    expect(f.records.coverage.read().coveredThrough).toBe(19)
    const saved = await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')
    for (const text of material.slice(0, -1)) expect(saved).toContain(text)
    const counts = continuationCounts(await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true })), f.requests)
    expect(counts).toEqual({ contexts: 1, requests: 3, saves: 1, coverages: 1 })
  } finally { await f.close() }
})

test('一批中只读取部分记录，即使保存成功也不能提交整批覆盖', async () => {
  const f = notesFixture({ turn(request) {
    const turn = continuationTurn(request)
    let source = false
    return { ...turn, ...(turn.toolCalls ? { toolCalls: turn.toolCalls.filter(call => {
      if (call.name !== 'history_read') return true
      if (source) return false
      source = true; return true
    }) } : {}) }
  } })
  try {
    expect(await f.compact()).toMatchObject({ state: 'failed', notesSaved: true })
    expect(f.records.coverage.read().summary).toBeNull()
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain('用户要求')
  } finally { await f.close() }
})

test('实际容量仍充足时允许超过64轮真实分页读取，不另设调用额度', async () => {
  const material = ['要求'.repeat(40), '近段']
  const f = notesFixture({ material, budget: 64000, turn(request) {
    const pages = request.messages.flatMap(message => message.role === 'tool' && message.name === 'history_read' ? [message] : [])
    if (!pages.length) {
      const turn = continuationTurn(request)
      return { ...turn, toolCalls: turn.toolCalls!.map(call => call.name === 'history_read' ? { ...call, args: { ...call.args, limit: 1 } } : call) }
    }
    const last = JSON.parse(pages.at(-1)!.output)
    if (last.next !== undefined) return { toolCalls: [{ name: 'history_read', args: { entry: last.source.entry, offset: last.next, limit: 1 } }] }
    return continuationTurn(request)
  } })
  try {
    expect(await f.compact('capacity-only')).toMatchObject({ state: 'completed' })
    const counts = continuationCounts(await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true })), f.requests)
    expect(counts).toEqual({ contexts: 1, requests: 82, saves: 1, coverages: 1 })
    expect(await readFile(join(f.notes.directory, 'MEMORY.md'), 'utf8')).toContain(material[0]!)
  } finally { await f.close() }
})
