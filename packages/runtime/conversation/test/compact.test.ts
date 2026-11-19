import { expect, test } from 'bun:test'
import { createCompactor } from '../src/compact.ts'
import { assembleContext } from '../src/context.ts'
import { DEFAULT_TEST_SESSION } from '@magic/faux'
import { makeCompactor, makeStage } from './support/harness.ts'

/** 取消息正文——只取字符串形态。 */
const textOf = (message: unknown): string => {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

test('用量到 85% 触发压缩；预算读数更小时按预算算', () => {
  const compact = makeCompactor(makeStage(), { policy: { compactAtFraction: .85, compactAtTokens: 100 } })
  compact.observe({ inputTokens: 849, contextWindow: 1000 })
  expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 850, contextWindow: 1000 })
  expect(compact.needed()).toBe(true)

  const stage = makeStage()
  const budgeted = createCompactor({ records: stage.records, session: 'test', gateway: stage.gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => 1, compactAtFraction: .85, compactAtTokens: 120000,
    capacity: () => ({ inputBudget: 2000 }) })
  // 2000 − 512（准备预留）= 1488；1487 不压，1488 压
  budgeted.observe({ inputTokens: 1487, contextWindow: 128000 })
  expect(budgeted.needed()).toBe(false)
  budgeted.observe({ inputTokens: 1488, contextWindow: 128000 })
  expect(budgeted.needed()).toBe(true)
})

/** 一段像真的会话：几轮问答，最后再补一条最新交代。 */
function seed(stage: ReturnType<typeof makeStage>, turns: number): void {
  for (let n = 0; n < turns; n++) {
    stage.records.appendEntry({ kind: 'user', content: { text: `第${n}条` }, at: n })
    stage.records.appendEntry({ kind: 'assistant', content: { text: `答复${n}` }, at: n })
  }
  stage.records.appendEntry({ kind: 'user', content: { text: '最新一句' }, at: 100 })
}

test('压缩＝交接材料成为新的第一句，最新一句原文仍留在上下文里', async () => {
  const stage = makeStage({ turns: [{ text: '## 目标与当前状态\n把压缩改成交接\n## 未完成与下一步\n继续' }] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  seed(stage, 5)

  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome.ok).toBe(true)

  const coverage = stage.records.coverage.read()
  const rest = await Array.fromAsync(stage.records.readEntries(DEFAULT_TEST_SESSION, { from: (coverage.coveredThrough ?? 0) + 1 }))
  const users = rest.filter(entry => entry.kind === 'user')
  // 交接材料带标记，用户最新说的那句原样留着（记录顺序按追加；装配时交接材料排最前）
  expect(users.filter(entry => entry.payload !== undefined && 'handoff' in entry.payload && entry.payload.handoff === true)).toHaveLength(1)
  expect(users.map(entry => (entry.content as { text?: string }).text)).toContain('最新一句')

  const messages = await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统提示' })
  expect(messages[1]).toMatchObject({ role: 'user' })
  expect(textOf(messages[1])).toContain('把压缩改成交接')
  expect(messages.some(message => textOf(message).includes('最新一句'))).toBe(true)
  // 旧材料不再进上下文
  expect(messages.some(message => textOf(message).includes('第3条'))).toBe(false)
})

test('没有可交接的材料时明说，并且自动路径也要发状态', async () => {
  const stage = makeStage({ turns: [] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome).toMatchObject({ ok: false, kind: 'no-material' })
  expect(stage.sink.events.filter(event => event.kind === 'compact.state').at(-1)?.data).toMatchObject({ state: 'no-material' })
})

test('交接材料生成失败时保留原上下文并报出原因', async () => {
  const stage = makeStage({ turns: [] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  stage.records.appendEntry({ kind: 'user', content: { text: '原始交代' }, at: 0 })
  stage.records.appendEntry({ kind: 'assistant', content: { text: '做了一些事' }, at: 1 })
  stage.records.appendEntry({ kind: 'user', content: { text: '最新一句' }, at: 2 })
  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome.ok).toBe(false)
  expect(stage.records.coverage.read().coveredThrough).toBeNull()
  expect(stage.sink.events.some(event => event.kind === 'compact.state' && event.data.state === 'failed')).toBe(true)
})

test('手动压缩与自动走同一条交接路径', async () => {
  const stage = makeStage({ turns: [{ text: '## 目标与当前状态\n手动交接\n## 未完成与下一步\n继续' }] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  seed(stage, 3)
  const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'req-1', focus: '保留 slash 部分' } })
  expect(outcome.ok).toBe(true)
  const coverage = stage.records.coverage.read()
  expect(coverage.coveredThrough).not.toBeNull()
  const rest = await Array.fromAsync(stage.records.readEntries(DEFAULT_TEST_SESSION, { from: (coverage.coveredThrough ?? 0) + 1 }))
  const users = rest.filter(entry => entry.kind === 'user')
  expect(users.filter(entry => entry.payload !== undefined && 'handoff' in entry.payload && entry.payload.handoff === true)).toHaveLength(1)
  expect(users.map(entry => (entry.content as { text?: string }).text)).toContain('最新一句')
})
