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
import { assembleContext } from '../src/context.ts'

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

    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT, budget: 5_000 })

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
