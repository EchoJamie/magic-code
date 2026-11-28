/**
 * 装配的预算兜底（D74）——压缩没做成时，请求也不能以超限的形式发出去。
 *
 * 次序：折叠较早的、成功的、大的工具结果 → 裁最早的完整交互 → 仍超就拒绝发送。
 * 这一层与压缩相互独立：压缩是主路径，这里是最后一道，单独成立。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import type { FauxRecords } from '@magic/faux'
import { estimateTokens } from '../src/brief.ts'
import { assembleContext, type BudgetPressure } from '../src/context.ts'
import { preparationReserve } from '../src/organize.ts'

const SESSION = 's1'
const SYSTEM_PROMPT = '## 身份\n你是 Magic Code。'
const AT = 1_700_000_000_000

function appendToolCall(records: FauxRecords, id: string): number {
  return records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { id, name: 'grep', args: { pattern: '压缩' } },
    at: AT,
  })
}

function appendToolResult(records: FauxRecords, id: string, text: string): number {
  return records.appendEntry({
    kind: 'tool-result',
    content: { text },
    payload: { ok: true, output: { text }, call: id },
    at: AT,
  })
}

const outputOf = (message: ModelMessage | undefined): string => (message?.role === 'tool' ? message.output : '')

describe('装配兜底 · 预算', () => {
  test('超预算先折叠较早的大工具结果，保留回查位置', async () => {
    const records = makeFauxRecords()
    const big = 'x'.repeat(12_000)
    for (const id of ['call_1', 'call_2']) {
      records.appendEntry({ kind: 'assistant', content: { text: `跑 ${id}` }, at: AT })
      appendToolCall(records, id)
      appendToolResult(records, id, big)
    }

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 5_000, prune: false })

    // 最早那条被折叠成占位，较晚那条仍是原文
    expect(outputOf(messages[2])).toContain('较早工具结果已折叠')
    expect(outputOf(messages[2])).toContain('会话记录#')
    expect(outputOf(messages[4])).toBe(big)
  })

  test('折叠不够就裁掉最早的完整交互，并在系统提示里说明', async () => {
    const records = makeFauxRecords()
    const texts = ['a'.repeat(4_000), 'b'.repeat(4_000)]
    for (let index = 0; index < texts.length; index++) {
      records.appendEntry({ kind: 'user', content: { text: `第${index}段` }, at: AT })
      records.appendEntry({ kind: 'assistant', content: { text: texts[index]! }, at: AT })
    }

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 2_000 })

    const first = messages[0]
    expect(first?.role === 'system' && first.content).toContain('较早的 1 段交互已从本次请求裁出')
    // 最早那段被裁走，最后一段还在
    expect(JSON.stringify(messages)).not.toContain('第0段')
    expect(JSON.stringify(messages)).toContain('第1段')
  })

  test('只剩最后一段仍超预算——拒绝发送，不把超限交给供应商', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '一'.repeat(6_000) }, at: AT })

    await expect(assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 1_000 }))
      .rejects.toThrow(/超出输入预算/)
  })

  test('裁段提示计入预算：不会因追加【上下文预算】提示而反超 room 抛出异常', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '第0段' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: 'a'.repeat(1_000) }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '第1段' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: 'b'.repeat(2_500) }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '第2段' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: 'c'.repeat(2_700) }, at: AT })

    const budget = 2_000
    const room = budget - preparationReserve(budget)
    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget })
    const first = messages[0]
    expect(first?.role === 'system' && first.content).toContain('较早的 2 段交互已从本次请求裁出')
    expect(JSON.stringify(messages)).not.toContain('第0段')
    expect(JSON.stringify(messages)).not.toContain('第1段')
    expect(JSON.stringify(messages)).toContain('第2段')
    const total = messages.reduce((sum, m) => sum + estimateTokens(m.role === 'tool' ? m.output : typeof m.content === 'string' ? m.content : ''), 0)
    expect(total).toBeLessThanOrEqual(room)
  })

  test('超预算报错文案同时写明有效预算 room 与模型窗口上限 budget', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '一'.repeat(6_000) }, at: AT })
    const budget = 2_000
    const room = budget - preparationReserve(budget)

    await expect(assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget }))
      .rejects.toThrow(new RegExp(`超出输入预算 ${room}（模型窗口输入上限 ${budget}`))
  })

  test('存在 handoff 交接消息时，大工具结果下标偏移正确仍能触发折叠', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '此前交接材料' }, payload: { handoff: true }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '跑 call_1' }, at: AT })
    appendToolCall(records, 'call_1')
    appendToolResult(records, 'call_1', 'x'.repeat(12_000))
    records.appendEntry({ kind: 'assistant', content: { text: '跑 call_2' }, at: AT })
    appendToolCall(records, 'call_2')
    appendToolResult(records, 'call_2', 'y'.repeat(12_000))

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 5_000, prune: false })
    expect(messages[1]).toEqual({ role: 'user', content: '此前交接材料' })
    expect(outputOf(messages[3])).toContain('较早工具结果已折叠')
    expect(outputOf(messages[3])).toContain('会话记录#')
    expect(outputOf(messages[5])).toBe('y'.repeat(12_000))
  })

  test('onBudgetPressure 在预算充裕时不触发，降级与溢出时准确上报', async () => {
    const okRecords = makeFauxRecords()
    okRecords.appendEntry({ kind: 'user', content: { text: '短消息' }, at: AT })
    const seenOk: BudgetPressure[] = []
    await assembleContext({ records: okRecords, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 2_000, onBudgetPressure: p => seenOk.push(p) })
    expect(seenOk).toEqual([])

    const degradeRecords = makeFauxRecords()
    degradeRecords.appendEntry({ kind: 'user', content: { text: '第0段' }, at: AT })
    degradeRecords.appendEntry({ kind: 'assistant', content: { text: 'a'.repeat(4_000) }, at: AT })
    degradeRecords.appendEntry({ kind: 'user', content: { text: '第1段' }, at: AT })
    degradeRecords.appendEntry({ kind: 'assistant', content: { text: 'b'.repeat(4_000) }, at: AT })
    const seenDegraded: BudgetPressure[] = []
    await assembleContext({ records: degradeRecords, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 2_000, onBudgetPressure: p => seenDegraded.push(p) })
    expect(seenDegraded).toHaveLength(1)
    expect(seenDegraded[0]).toMatchObject({ action: 'degraded', budget: 2_000, room: 2_000 - preparationReserve(2_000) })

    const overflowRecords = makeFauxRecords()
    overflowRecords.appendEntry({ kind: 'user', content: { text: '一'.repeat(6_000) }, at: AT })
    const seenOverflow: BudgetPressure[] = []
    await expect(assembleContext({ records: overflowRecords, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 2_000, onBudgetPressure: p => seenOverflow.push(p) })).rejects.toThrow()
    expect(seenOverflow).toHaveLength(1)
    expect(seenOverflow[0]).toMatchObject({ action: 'overflow', budget: 2_000, room: 2_000 - preparationReserve(2_000) })
  })

  test('不给预算时不改装配结果（只验循环的场景照旧）', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '看下目录' }, at: AT })
    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT })
    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '看下目录' },
    ])
  })
})
