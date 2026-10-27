import { expect, test } from 'bun:test'
import type { Entry } from '@magic/contracts'
import { createCompactor, frozenSegment } from '../src/compact.ts'
import { makeCompactor, makeStage } from './support/harness.ts'

test('压缩触发依据实际用量，未报告用量不触发', () => {
  const compact = makeCompactor(makeStage(), { policy: { compactAtFraction: .5, compactAtTokens: 100 } })
  expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 99 }); expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 100 }); expect(compact.needed()).toBe(true)
  compact.observe({ inputTokens: 499, contextWindow: 1000 }); expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 500, contextWindow: 1000 }); expect(compact.needed()).toBe(true)
})

test('冻结只经过完整assistant/tool-call/tool-result边界，穿插成员消息不拆协议配对', () => {
  const kinds = ['user', 'assistant', 'tool-call', 'agent-message', 'tool-result', 'user'] as const
  const entries = kinds.map((kind, index): Entry => ({ id: index + 1, kind, at: 1, content: { text: '' } }))
  expect(frozenSegment(entries, 2).map(entry => entry.id)).toEqual([1])
  expect(frozenSegment(entries, 1).map(entry => entry.id)).toEqual([1, 2, 3, 4, 5])
  const incomplete = entries.filter(entry => entry.kind !== 'tool-result')
  expect(frozenSegment(incomplete, 1).map(entry => entry.id)).toEqual([1])
})

test('没有可覆盖完整旧段或没有接续装配时保留覆盖与原记录', async () => {
  const stage = makeStage(), compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
  expect(await compact.run({ trigger: 'threshold' })).toMatchObject({ ok: false, kind: 'no-material' })
  for (let n = 0; n < 3; n++) stage.records.appendEntry({ kind: 'user', content: { text: '保留原文' }, at: n })
  expect(await compact.run({ trigger: 'threshold' })).toMatchObject({ ok: false, kind: 'configuration' })
  expect(stage.records.coverage.read()).toEqual({ summary: null, coveredThrough: null })
  expect(stage.gateway.requests).toEqual([])
})

test('当前模型有效输入预算比上下文窗口小，自动触发仍保留接续往返余量', () => {
  const stage = makeStage()
  const compact = createCompactor({ records: stage.records, session: 'test', gateway: stage.gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => 1, nearEntries: 1,
    compactAtFraction: .8, compactAtTokens: 120000, capacity: () => ({ inputBudget: 2000 }) })
  compact.observe({ inputTokens: 1000, contextWindow: 128000 })
  expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 1600, contextWindow: 128000 })
  expect(compact.needed()).toBe(true)
})
