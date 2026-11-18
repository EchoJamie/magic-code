/** 一次有界接续简报：旧工具结果折叠、失败不提交、重点进请求。 */
import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { notesFixture } from './notes-support.ts'

const briefSystem = (request: ModelRequest) => {
  const system = request.messages[0]
  return system?.role === 'system' && typeof system.content === 'string' && system.content.startsWith('你是接续简报的整理者')
}
const briefMaterial = (request: ModelRequest) => request.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : '').join('\n')

test('旧段只发一次简报请求，成功即提交简报；不写接续记录', async () => {
  const f = notesFixture({ near: 1, turn: request => briefSystem(request)
    ? { text: '## 目标与阶段\n继续核对\n## 下一步\n完成' }
    : { text: '业务答复' } })
  try {
    expect(await f.compact('one')).toMatchObject({ state: 'completed', notesSaved: true })
    const briefs = f.requests.filter(briefSystem)
    expect(briefs).toHaveLength(1)
    expect(briefs[0]!.tools).toBeUndefined()
    expect(f.requests.filter(request => !briefSystem(request))).toHaveLength(0)
    const entries = await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true }))
    expect(entries.filter(entry => entry.kind === 'summary')).toHaveLength(1)
    expect(entries.find(entry => entry.kind === 'summary')?.content).toEqual({ text: '## 目标与阶段\n继续核对\n## 下一步\n完成' })
    expect(entries.filter(entry => entry.kind === 'continuation')).toHaveLength(0)
  } finally { await f.close() }
})

test('简报为空时不提交覆盖，原始记录保留', async () => {
  const f = notesFixture({ near: 1, turn: request => briefSystem(request) ? { text: '   ' } : { text: '业务答复' } })
  try {
    expect(await f.compact('empty')).toMatchObject({ state: 'failed', notesSaved: false })
    expect(f.records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
    expect((await Array.fromAsync(f.records.readEntries(f.session, { auxiliary: true }))).some(entry => entry.kind === 'summary')).toBe(false)
  } finally { await f.close() }
})

test('旧的成功的工具结果折叠成状态与位置；失败结果保留正文', async () => {
  const f = notesFixture({ near: 1, turn: request => briefSystem(request) ? { text: '## 目标与阶段\n继续' } : { text: '业务答复' } })
  try {
    f.records.appendEntry({ kind: 'tool-result', content: { text: '成功输出'.repeat(1000) }, payload: { ok: true, call: 'call-ok', output: { text: '成功输出'.repeat(1000) } }, at: 10 })
    f.records.appendEntry({ kind: 'tool-result', content: { text: '错误：权限拒绝' }, payload: { ok: false, call: 'call-fail', output: { text: '错误：权限拒绝' } }, at: 11 })
    f.records.appendEntry({ kind: 'user', content: { text: '继续' }, at: 12 })
    expect(await f.compact('fold')).toMatchObject({ state: 'completed' })
    const material = briefMaterial(f.requests.find(briefSystem)!)
    expect(material).toContain('[工具结果 · 成功 · 4000 字符')
    expect(material).toContain('错误：权限拒绝')
  } finally { await f.close() }
})

test('主动压缩的重点进入简报请求，不进入业务请求', async () => {
  const f = notesFixture({ near: 1, turn: request => briefSystem(request) ? { text: '## 目标与阶段\n保留重点' } : { text: '业务答复' } })
  try {
    expect(await f.service.compact({ requestId: 'focus', focus: '保留重点' }, new AbortController().signal, () => {})).toMatchObject({ state: 'completed' })
    expect(JSON.stringify(f.requests.find(briefSystem)!.messages)).toContain('保留重点')
    expect(f.requests.filter(request => !briefSystem(request))).toHaveLength(0)
  } finally { await f.close() }
})
