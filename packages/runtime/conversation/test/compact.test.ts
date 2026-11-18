import { expect, test } from 'bun:test'
import type { Entry } from '@magic/contracts'
import { createCompactor, frozenSegment } from '../src/compact.ts'
import { DEFAULT_TEST_SESSION } from '@magic/faux'
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

test('没有旧段时保留覆盖；有旧段时一次调用生成简报并提交', async () => {
  const stage = makeStage({ turns: [{ text: '## 目标与阶段\n保留原文\n## 下一步\n继续' }] })
  const compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
  expect(await compact.run({ trigger: 'threshold' })).toMatchObject({ ok: false, kind: 'no-material' })
  for (let n = 0; n < 3; n++) stage.records.appendEntry({ kind: 'user', content: { text: '保留原文' }, at: n })
  expect(await compact.run({ trigger: 'threshold' })).toMatchObject({ ok: true, summarized: 2 })
  expect(stage.gateway.requests).toHaveLength(1)
  expect(stage.records.coverage.read()).toMatchObject({ coveredThrough: 2 })
  const summary = stage.records.coverage.read().summary
  expect(summary).not.toBeNull()
  const entries = await Array.fromAsync(stage.records.readEntries(DEFAULT_TEST_SESSION, { auxiliary: true, from: summary!, to: summary! }))
  expect(entries[0]?.content).toEqual({ text: '## 目标与阶段\n保留原文\n## 下一步\n继续' })
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
