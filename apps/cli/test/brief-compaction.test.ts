/** A+B 融合压缩：同前缀内联压缩、原子落库 summary、不覆盖 MEMORY.md；/memory tidy 独立整理笔记。 */
import { expect, test } from 'bun:test'
import type { ModelRequest } from '@magic/contracts'
import { notesFixture } from './notes-support.ts'

const handoffRequest = (request: ModelRequest) => {
  const last = request.messages.at(-1)
  return last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith('【系统交接整理指令')
}
const tidyRequest = (request: ModelRequest) => {
  const system = request.messages[0]
  return system?.role === 'system' && typeof system.content === 'string' && system.content.startsWith('你是当前会话工作笔记（MEMORY.md）的整理助手')
}
const handoffMaterial = (request: ModelRequest) => request.messages
  .map(message => message.role === 'tool' ? message.output : typeof message.content === 'string' ? message.content : '')
  .join('\n')

test('同前缀内联压缩：材料原子写入 summary，不覆盖既有 MEMORY.md，保留同前缀 tools', async () => {
  const f = notesFixture({ turn: request => handoffRequest(request)
    ? { text: '## 目标与当前状态\n继续核对\n## 未完成与下一步\n完成' }
    : { text: '业务答复' } })
  try {
    await f.notes.overwrite!('MEMORY.md', '长期工作记忆：保留阶段一结论')
    expect(await f.compact('one')).toMatchObject({ state: 'completed' })
    const handoffs = f.requests.filter(handoffRequest)
    expect(handoffs).toHaveLength(1)
    expect(handoffs[0]!.tools?.length).toBeGreaterThan(0)
    expect(f.requests.filter(request => !handoffRequest(request))).toHaveLength(0)

    // MEMORY.md 原封不动（压缩不再覆盖笔记）
    const noted = await f.notes.read({ path: 'MEMORY.md' })
    expect(noted.page?.text).toBe('长期工作记忆：保留阶段一结论')

    // 交接材料原子存在 summary 条目中，不再伪造 user.handoff 条目
    const coverage = f.records.coverage.read()
    expect(coverage.summary).not.toBeNull()
    const allEntries = await Array.fromAsync(f.records.readEntries(f.session))
    const summaryEntry = allEntries.find(entry => entry.id === coverage.summary)
    expect(summaryEntry?.kind).toBe('summary')
    expect(summaryEntry?.content).toEqual({ text: '## 目标与当前状态\n继续核对\n## 未完成与下一步\n完成' })
    expect(summaryEntry?.payload).toMatchObject({ format: 'compaction-v2' })
    expect(allEntries.some(entry => entry.kind === 'user' && entry.payload !== undefined && 'handoff' in entry.payload)).toBe(false)
  } finally { await f.close() }
})

test('交接材料为空时不提交覆盖，原始记录保留', async () => {
  const f = notesFixture({ turn: request => handoffRequest(request) ? { text: '   ' } : { text: '业务答复' } })
  try {
    const outcome = await f.compact('empty')
    expect(outcome.state).toBe('failed')
    expect(f.records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
  } finally { await f.close() }
})

test('压缩模型误吐 toolCalls 时自动回退一次无工具重试并成功完成', async () => {
  let handoffAttempts = 0
  const f = notesFixture({ turn: request => {
    if (!handoffRequest(request)) return { text: '业务答复' }
    handoffAttempts++
    if (handoffAttempts === 1) return { toolCalls: [{ name: 'read', args: { path: 'a.ts' } }] }
    return { text: '## 目标与当前状态\n回退后完成' }
  } })
  try {
    expect(await f.compact('fallback')).toMatchObject({ state: 'completed' })
    const handoffs = f.requests.filter(handoffRequest)
    expect(handoffs).toHaveLength(2)
    expect(handoffs[0]!.tools?.length).toBeGreaterThan(0)
    expect(handoffs[1]!.tools).toBeUndefined()
  } finally { await f.close() }
})

test('连续交接带上一次材料，不丢掉已承接的内容', async () => {
  let text = '## 目标与当前状态\n第一版交接'
  const f = notesFixture({ turn: request => handoffRequest(request) ? { text } : { text: '业务答复' } })
  try {
    expect(await f.compact('one')).toMatchObject({ state: 'completed' })
    text = '## 目标与当前状态\n第二版交接'
    f.records.appendEntry({ kind: 'user', content: { text: '后续要求' }, at: 20 })
    f.records.appendEntry({ kind: 'assistant', content: { text: '后续完成' }, at: 21 })
    expect(await f.compact('two')).toMatchObject({ state: 'completed' })
    const handoffs = f.requests.filter(handoffRequest)
    expect(handoffs).toHaveLength(2)
    expect(handoffMaterial(handoffs[1]!)).toContain('第一版交接')
    expect(handoffMaterial(handoffs[1]!)).toContain('后续要求')
  } finally { await f.close() }
})

test('主动压缩的重点进入交接请求，不进入业务请求', async () => {
  const f = notesFixture({ turn: request => handoffRequest(request) ? { text: '## 目标与当前状态\n保留重点' } : { text: '业务答复' } })
  try {
    expect(await f.service.compact({ requestId: 'focus', focus: '保留重点' }, new AbortController().signal, () => {})).toMatchObject({ state: 'completed' })
    expect(JSON.stringify(f.requests.find(handoffRequest)!.messages)).toContain('保留重点')
    expect(f.requests.filter(request => !handoffRequest(request))).toHaveLength(0)
  } finally { await f.close() }
})

test('/memory tidy 独立整理 MEMORY.md，不改动上下文覆盖点', async () => {
  const f = notesFixture({ turn: request => tidyRequest(request)
    ? { text: '# 长期工作笔记\n## 已完成\n- 第一阶段已验证\n## 进行中\n- 第二阶段' }
    : { text: '业务答复' } })
  try {
    await f.notes.overwrite!('MEMORY.md', '第一阶段大量排查日志...\n第二阶段待做')
    const coverageBefore = f.records.coverage.read()
    const result = await f.tidyMemory('tidy-1', '精简第一阶段')
    expect(result).toMatchObject({ requestId: 'tidy-1', state: 'completed', path: 'MEMORY.md', focus: '精简第一阶段' })
    expect(f.requests.filter(tidyRequest)).toHaveLength(1)
    expect(f.requests.find(tidyRequest)!.tools).toBeUndefined()
    expect((await f.notes.read({ path: 'MEMORY.md' })).page?.text).toContain('第一阶段已验证')
    expect(f.records.coverage.read()).toEqual(coverageBefore)
  } finally { await f.close() }
})
