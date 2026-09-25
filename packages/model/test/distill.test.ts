/**
 * U72 · 提炼面（`PageDistiller`）——**「那次调用不带任何工具」这一条的用例**。
 *
 * ## 判据咬在哪一层
 *
 * 不咬「实现里没写 `tools`」那句自觉，咬**真发出去的那几个字节**：
 * 走真网关（`createModelGateway`）→ 真取件层（`ai-sdk.ts`）→ 假端点，
 * 断言**出站请求体里连 `tools` 这个键都没有**。发不出工具调用这件事因此
 * 是**结构上**的：供应商那一侧压根没收到过工具有哪些。
 *
 * 三支：
 * - ① 请求体无 `tools`（且 `tool_choice` 也没有）——护栏的正面；
 * - ② 端点**硬塞**一次工具调用回来（模拟「它试着发」）⇒ 那一笔**没有下文**：
 *    只有一次请求（没有下一轮）、结果照旧只取正文——工具生不出工具，深度恒为 1；
 * - ③ 用哪条模型由构造者定死（此处钉一个与会话无关的名字），走的是这条连接。
 */

import { describe, expect, test } from 'bun:test'
import type { EventDataOf, EventKind, EventStamper, KernelEvent, TurnId } from '@magic/contracts'
import { createModelGateway, createPageDistiller } from '../src/index.ts'

// ══ 夹具 —— 假端点（真格式 SSE，不经网络）══════════════════════════════

type Captured = { readonly url: string; readonly body: Record<string, unknown> }

/** 一次回环抓下来的请求体——**判据看的就是它**（出站物证的单元版）。 */
function capture(reply: () => Response): { fetch: typeof globalThis.fetch; seen: Captured[] } {
  const seen: Captured[] = []
  const fake = (async (input: unknown, init?: { body?: unknown }) => {
    seen.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return reply()
  }) as unknown as typeof globalThis.fetch

  return { fetch: fake, seen }
}

function chunk(model: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-distill',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    ...payload,
  })}\n\n`
}

function sse(...chunks: string[]): Response {
  return new Response(`${chunks.join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function testStamper(): EventStamper {
  let next = 0
  return {
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({ id: (next += 1), session: 's1', turn: null as TurnId | null, at: 1_700_000_000_000, kind, data }) as KernelEvent,
    beginTurn: () => {},
  }
}

/** 造一条连接上的网关——**写死的模型名与被测的那一件无关**（用例钉的是构造入参那一个）。 */
function distillerOn(model: string, fetch: typeof globalThis.fetch) {
  const gateway = createModelGateway({
    providerId: 'ds',
    stamper: testStamper(),
    config: { vendor: 'deepseek', apiKey: 'test-key' },
    fetch: fetch as never,
    env: {},
  })

  return createPageDistiller({ gateway, model })
}

const PAGE = '# 定价\n\n标准版每月 12 元。'

// ═══════════════════════════════════════════════════════════════════════

describe('U72 · 提炼面', () => {
  test('① 出站请求体里没有 `tools` 这一格——「发不出工具调用」是结构上的', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk('提炼型号', { choices: [{ index: 0, delta: { role: 'assistant', content: '每月 12 元。' } }] }),
        chunk('提炼型号', { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk('提炼型号', { choices: [], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } }),
      ),
    )

    const outcome = await distillerOn('提炼型号', fetch).distill({
      url: 'https://example.com/pricing',
      page: PAGE,
      prompt: '标准版多少钱？',
    })

    expect(outcome).toEqual({ ok: true, answer: '每月 12 元。', model: '提炼型号' })

    const body = seen[0]?.body as Record<string, unknown>
    // ⚠️ **判的是「这个键不在」**，不是「它是个空数组」——`ai-sdk.ts` 那一处对
    // `undefined` 与 `[]` 都**不发给供应商**，故两种写法下这几个断言都成立；
    // 写成 `toEqual([])` 反而会把实现钉死在「必须发一个空数组」上（那是另一件事）。
    expect('tools' in body).toBe(false)
    expect('tool_choice' in body).toBe(false)

    // 用哪条模型由构造者定死（不是会话当前那个）
    expect(body['model']).toBe('提炼型号')

    // 页面与问题真的进了请求——「按问题提炼」那一半的来处
    const messages = body['messages'] as { role: string; content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('只依据下面这一页的正文')
    expect(messages.at(-1)?.content).toContain('标准版多少钱？')
    expect(messages.at(-1)?.content).toContain('标准版每月 12 元。')
  })

  test('② 端点硬塞一次工具调用：那一笔没有下文——只有一次请求，也长不出第二轮', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        // 「它试着发一个 tool_call」——真发回来会怎样
        chunk('提炼型号', {
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_x', type: 'function', function: { name: 'exec', arguments: '{"cmd":"curl https://example.com"}' } },
                ],
              },
            },
          ],
        }),
        chunk('提炼型号', { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      ),
    )

    const outcome = await distillerOn('提炼型号', fetch).distill({
      url: 'https://example.com/pricing',
      page: PAGE,
      prompt: '标准版多少钱？',
    })

    // 那一笔工具调用**没有下文**：本域压根没有能执行它的东西，而循环也不在这里
    expect(seen).toHaveLength(1)
    expect('tools' in (seen[0]?.body as Record<string, unknown>)).toBe(false)

    // 只有工具调用、一个字的正文都没有 ⇒ **空答案＝坏答案**（不落一条空回复给读的人）
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('没有给出答案正文')
  })

  test('③ 端点报错 ⇒ 一次**普通失败**（照实带缘由，不吞）', async () => {
    const { fetch } = capture(
      () =>
        new Response(JSON.stringify({ error: { message: '余额不足' } }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const outcome = await distillerOn('提炼型号', fetch).distill({
      url: 'https://example.com/pricing',
      page: PAGE,
      prompt: '标准版多少钱？',
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.kind).toBe('failed')
      expect(outcome.reason).toContain('余额不足')
    }
  })
})
