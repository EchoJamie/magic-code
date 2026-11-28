import { describe, expect, test } from 'bun:test'
import { makeFauxRecords } from '@magic/faux'
import { assembleContext } from '../src/context.ts'
import { computePruneAdvance } from '../src/prune.ts'

const SESSION = 'prune-s1'
const SYSTEM_PROMPT = '## 身份\n你是 Magic Code。'
const AT = 1_700_000_000_000

function appendToolRound(records: ReturnType<typeof makeFauxRecords>, id: string, name: string, output: string, ok = true): number {
  records.appendEntry({ kind: 'assistant', content: { text: `调用 ${name}` }, at: AT })
  records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id, name, args: { target: id } }, at: AT })
  return records.appendEntry({ kind: 'tool-result', content: { text: output }, payload: { ok, call: id, output: { text: output } }, at: AT })
}

describe('一级批量单调微压缩（prune）', () => {
  test('可回收量未达批量阈值时不推进水位，前缀字节级稳定', async () => {
    const records = makeFauxRecords()
    // room = 20000 - 3000 = 17000; protectTokens = 4250, batchTokens = 2550
    // 放 1 条 1500 chars (~420 tokens) 在前面 + 5 条 3500 chars (~980 tokens) 在保护窗里
    appendToolRound(records, 'old_small', 'exec', 'a'.repeat(1_500))
    for (let i = 1; i <= 5; i++) {
      appendToolRound(records, `recent_${i}`, 'exec', 'b'.repeat(3_500))
    }

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 20_000 })
    expect(records.coverage.readPrunedThrough?.()).toBeNull()
    expect(JSON.stringify(messages)).toContain('a'.repeat(1_500))
  })

  test('达到批量阈值后一次性推进水位，保护最新轮/失败输出/豁免工具，占位指路 source_read', async () => {
    const records = makeFauxRecords()
    const oldExecId = appendToolRound(records, 'old_exec', 'exec', 'x'.repeat(10_000))
    const oldPlanId = appendToolRound(records, 'old_plan', 'plan_read', 'p'.repeat(5_000))
    const oldFailId = appendToolRound(records, 'old_fail', 'exec', 'e'.repeat(5_000), false)
    const oldExec2Id = appendToolRound(records, 'old_exec_2', 'exec', 'z'.repeat(4_000))
    for (let i = 1; i <= 5; i++) {
      appendToolRound(records, `tail_${i}`, 'exec', 't'.repeat(3_800))
    }

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 20_000 })
    const prunedThrough = records.coverage.readPrunedThrough?.()
    expect(prunedThrough).not.toBeNull()
    expect(prunedThrough!).toBe(oldExec2Id)
    expect(prunedThrough!).toBeGreaterThan(oldFailId)

    const toolOutputs = messages.filter(m => m.role === 'tool').map(m => m.output)
    const oldExecOut = toolOutputs.find(o => o.includes(`会话记录#${oldExecId}`))
    expect(oldExecOut).toContain('较早工具结果已折叠')
    expect(oldExecOut).toContain('source_read')
    // plan_read 与失败输出、以及最新一轮始终保留原文（即使位于水位之下）
    expect(toolOutputs.some(o => o === 'p'.repeat(5_000))).toBe(true)
    expect(toolOutputs.some(o => o === 'e'.repeat(5_000))).toBe(true)
    expect(toolOutputs.at(-1)).toBe('t'.repeat(3_800))
    expect(oldPlanId).toBeGreaterThan(oldExecId)
  })

  test('水位单调不回退：再装配同一记录产生逐字一致的微压缩输出', async () => {
    const records = makeFauxRecords()
    appendToolRound(records, 'c1', 'read', 'r'.repeat(12_000))
    for (let i = 1; i <= 5; i++) appendToolRound(records, `c_${i}`, 'exec', 'y'.repeat(3_600))

    const m1 = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 20_000 })
    const w1 = records.coverage.readPrunedThrough?.()
    const m2 = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 20_000 })
    const w2 = records.coverage.readPrunedThrough?.()
    expect(w2).toBe(w1)
    expect(m2).toEqual(m1)
    expect(computePruneAdvance([], w2 ?? null, 17_000)).toBeUndefined()
  })
})
