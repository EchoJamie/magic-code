import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collaborationRuntime, latch, requestText } from './run-collaboration-fixture.ts'

// 反向实验只临时突变生产接线；本文件在正常实现下也必须通过。
test('U115反向判据：顾问终态前，同批独立动作已经落地', async () => {
  const pending = latch()
  const f = await collaborationRuntime('u115-reverse-immediate', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? { tools: [
      { tool: 'consult_arcane', args: { operationId: 'reverse', question: '暂停的顾问查证' } },
      { tool: 'write', args: { path: 'independent.txt', content: '在顾问完成前落地' } },
    ] } : { text: '独立动作完成，意见另等。' }
    await pending.promise; return { text: '完整顾问意见' }
  }, { allowAll: true })
  const marker = join(f.root, 'terminal-wait-marker')
  process.env['U115_REVERSE_MARKER'] = marker
  try {
    f.shell.key({ kind: 'paste', text: '咨询与独立步骤' }); f.shell.key({ kind: 'enter' })
    await f.wait('独立落地或明确串行等待谁先到', () => existsSync(join(f.workspace, 'independent.txt')) || (existsSync(marker) && f.requests('descendant-model').length === 1))
    const facts = { advisorPending: f.delegation()?.deliveryMessageId === undefined, independentLanded: existsSync(join(f.workspace, 'independent.txt')), terminalWaitObserved: existsSync(marker) }
    console.log('U115_IMMEDIATE_FACTS', JSON.stringify(facts))
    expect(facts.advisorPending).toBe(true)
    expect(facts.independentLanded).toBe(true)
  } finally { pending.release(); delete process.env['U115_REVERSE_MARKER']; await f.close() }
}, 15000)

test('U115反向判据：实际副作用探针不变，合法read成功', async () => {
  const f = await collaborationRuntime('u115-reverse-readonly', call => {
    if (call.model === 'entry-model') return call.index === 0 ? { tool: 'consult_arcane', args: { operationId: 'probe', question: '只读查证' } } : { text: '原工作持有责任。' }
    if (call.index === 0) return { tool: 'write', args: { path: 'probe.txt', content: '实际越权写入-643' } }
    if (call.index === 1) return { tool: 'read', args: { path: 'probe.txt' } }
    expect(requestText(call)).toContain('probe.txt')
    return { text: '已通过合法read取得实际探针文件。' }
  }, { allowAll: true })
  writeFileSync(join(f.workspace, 'probe.txt'), '原值')
  try {
    f.shell.key({ kind: 'paste', text: '只读咨询' }); f.shell.key({ kind: 'enter' })
    await f.wait('实际分发收束或异常先到', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
    expect(f.errors).toEqual([])
    const messages = f.requests('descendant-model')[2]!.body['messages'] as { role: string; content: unknown }[]
    const legalRead = JSON.stringify(messages.filter(one => one.role === 'tool').at(-1)?.content).match(/原值|实际越权写入-643/) !== null
    const actual = readFileSync(join(f.workspace, 'probe.txt'), 'utf8')
    console.log('U115_READONLY_FACTS', JSON.stringify({ legalRead, actual, modelCalls: f.requests('descendant-model').length }))
    expect(legalRead).toBe(true)
    expect(actual).toBe('原值')
  } finally { await f.close() }
}, 15000)
