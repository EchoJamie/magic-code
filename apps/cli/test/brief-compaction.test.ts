/** 压缩 ＝ 交接：一次调用写交接材料，材料落成新上下文的第一句用户输入，旧记录不动。 */
import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { notesFixture } from './notes-support.ts'

const handoffSystem = (request: ModelRequest) => {
  const system = request.messages[0]
  return system?.role === 'system' && typeof system.content === 'string' && system.content.startsWith('你是这次交接的记录者')
}
const handoffMaterial = (request: ModelRequest) => request.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : '').join('\n')

test('一次交接调用：材料写进笔记，并成为新上下文的第一句用户输入', async () => {
  const f = notesFixture({ turn: request => handoffSystem(request)
    ? { text: '## 目标与当前状态\n继续核对\n## 未完成与下一步\n完成' }
    : { text: '业务答复' } })
  try {
    expect(await f.compact('one')).toMatchObject({ state: 'completed', notesSaved: true })
    const handoffs = f.requests.filter(handoffSystem)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.tools).toBeUndefined()
    expect(f.requests.filter(request => !handoffSystem(request))).toHaveLength(0)

    // 笔记就是这份材料
    const noted = await f.notes.read({ path: 'MEMORY.md' })
    expect(noted.files).toEqual(['MEMORY.md'])
    expect(noted.page?.text).toBe('## 目标与当前状态\n继续核对\n## 未完成与下一步\n完成')

    // 覆盖点之后只剩交接材料与用户最新那句；装配时交接材料排在最前。
    const coverage = f.records.coverage.read()
    const rest = await Array.fromAsync(f.records.readEntries(f.session, { from: (coverage.coveredThrough ?? 0) + 1 }))
    const handoffEntries = rest.filter(entry => entry.kind === 'user' && entry.payload !== undefined && 'handoff' in entry.payload && entry.payload.handoff === true)
    expect(handoffEntries).toHaveLength(1)
    expect(handoffEntries[0]?.content).toEqual({ text: '## 目标与当前状态\n继续核对\n## 未完成与下一步\n完成' })
    // 装配把交接材料排在最前——由 `packages/runtime/conversation/test/compact.test.ts` 验。
  } finally { await f.close() }
})

test('交接材料为空时不提交覆盖，原始记录保留', async () => {
  const f = notesFixture({ turn: request => handoffSystem(request) ? { text: '   ' } : { text: '业务答复' } })
  try {
    expect(await f.compact('empty')).toMatchObject({ state: 'failed', notesSaved: false })
    expect(f.records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
  } finally { await f.close() }
})

test('旧的成功工具结果折叠成状态与位置；失败结果保留正文', async () => {
  const f = notesFixture({ turn: request => handoffSystem(request) ? { text: '## 目标与当前状态\n继续' } : { text: '业务答复' } })
  try {
    f.records.appendEntry({ kind: 'tool-result', content: { text: '成功输出'.repeat(1000) }, payload: { ok: true, call: 'call-ok', output: { text: '成功输出'.repeat(1000) } }, at: 10 })
    f.records.appendEntry({ kind: 'tool-result', content: { text: '错误：权限拒绝' }, payload: { ok: false, call: 'call-fail', output: { text: '错误：权限拒绝' } }, at: 11 })
    f.records.appendEntry({ kind: 'user', content: { text: '继续' }, at: 12 })
    expect(await f.compact('fold')).toMatchObject({ state: 'completed' })
    const material = handoffMaterial(f.requests.find(handoffSystem)!)
    expect(material).toContain('[工具结果 · 成功 · 4000 字符')
    expect(material).toContain('错误：权限拒绝')
  } finally { await f.close() }
})

test('连续交接带上一次材料，不丢掉已承接的内容', async () => {
  let text = '## 目标与当前状态\n第一版交接'
  const f = notesFixture({ turn: request => handoffSystem(request) ? { text } : { text: '业务答复' } })
  try {
    expect(await f.compact('one')).toMatchObject({ state: 'completed' })
    text = '## 目标与当前状态\n第二版交接'
    f.records.appendEntry({ kind: 'user', content: { text: '后续要求' }, at: 20 })
    f.records.appendEntry({ kind: 'assistant', content: { text: '后续完成' }, at: 21 })
    expect(await f.compact('two')).toMatchObject({ state: 'completed' })
    const handoffs = f.requests.filter(handoffSystem)
    expect(handoffs).toHaveLength(2)
    expect(handoffMaterial(handoffs[1]!)).toContain('第一版交接')
    expect(handoffMaterial(handoffs[1]!)).toContain('后续要求')
  } finally { await f.close() }
})

test('主动压缩的重点进入交接请求，不进入业务请求', async () => {
  const f = notesFixture({ turn: request => handoffSystem(request) ? { text: '## 目标与当前状态\n保留重点' } : { text: '业务答复' } })
  try {
    expect(await f.service.compact({ requestId: 'focus', focus: '保留重点' }, new AbortController().signal, () => {})).toMatchObject({ state: 'completed' })
    expect(JSON.stringify(f.requests.find(handoffSystem)!.messages)).toContain('保留重点')
    expect(f.requests.filter(request => !handoffSystem(request))).toHaveLength(0)
  } finally { await f.close() }
})
