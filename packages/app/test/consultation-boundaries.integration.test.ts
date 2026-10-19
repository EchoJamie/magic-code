import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collaborationRuntime, latch, requestText } from './run-collaboration-fixture.ts'

test('顾问终态前，同批独立动作已经落地', async () => {
  const pending = latch()
  const f = await collaborationRuntime('consultation-independent-action', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? { tools: [
      { tool: 'consult_arcane', args: { operationId: 'reverse', question: '暂停的顾问查证' } },
      { tool: 'write', args: { path: 'independent.txt', content: '在顾问完成前落地' } },
    ] } : { text: '独立动作完成，意见另等。' }
    await pending.promise; return { text: '完整顾问意见' }
  }, { allowAll: true })
  try {
    f.shell.key({ kind: 'paste', text: '咨询与独立步骤' }); f.shell.key({ kind: 'enter' })
    await f.wait('独立动作完成后入口继续请求，顾问仍在等待', () => f.requests('entry-model').length === 2)
    expect(f.delegation()?.deliveryMessageId).toBeUndefined()
    expect(readFileSync(join(f.workspace, 'independent.txt'), 'utf8')).toBe('在顾问完成前落地')
  } finally { pending.release(); await f.close() }
}, 15000)

test('只读顾问不能写文件，后续合法读取仍能取得原文', async () => {
  const f = await collaborationRuntime('consultation-readonly', call => {
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
    expect(legalRead).toBe(true)
    expect(actual).toBe('原值')
  } finally { await f.close() }
}, 15000)
