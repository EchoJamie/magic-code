import { describe, expect, test } from 'bun:test'
import type { EventStamper, ModelMessage, ProviderConfig } from '@magic/contracts'
import { createModelGateway } from '../src/gateway.ts'
import type { ModelStream } from '../src/call.ts'

function endpoint(deltas: readonly Record<string, unknown>[], provider = 'minimax', config: ProviderConfig = { vendor: 'minimax' }) {
  const requests: Record<string, unknown>[] = []
  const gateway = createModelGateway({
    providerId: provider, config, apiKey: 'test-key', retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stamper: { stamp: (kind, data) => ({ id: 1, session: 'test', turn: 1, at: 0, kind, data }), beginTurn: () => {} } as EventStamper,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const chunks = [...deltas.map(delta => ({ delta })), { delta: {}, finish_reason: 'stop' }]
      const raw = chunks.map(choice => `data: ${JSON.stringify({
        id: 'call', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, ...choice }],
      })}\n\n`).join('') + 'data: [DONE]\n\n'
      return new Response(raw, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { gateway, requests }
}
async function drain(stream: ModelStream) {
  for await (const _event of stream.events) { /* 消费流后聚合才落定 */ }
  return stream.result
}
const model = 'MiniMax-M3'
const source = { provider: 'minimax', model }
const message = { role: 'user' as const, content: '检查通道' }
const detail = { type: 'reasoning.text', id: 'reasoning-text-1', format: 'MiniMax-response-v1', index: 0 }

describe('分离思考协议', () => {
  for (const name of ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview', 'future-model']) {
    test(`${name}：分离格式由请求保证，正文中的标签完整保留`, async () => {
      const text = '<think>示例</think>\n| 思考 | 与 M3 的内嵌 `<think>` 完全不同 |\n```xml\n</think>\n```\n回答结束'
      const { gateway, requests } = endpoint([
        { reasoning_content: '分析里也有 `<think>` 和 `</think>`。' },
        ...[...text].map(content => ({ content })),
      ], 'minimax', {
        vendor: 'minimax',
        modelOverrides: { [name]: { traits: { inlineThinking: { tag: 'think' } } } },
      })
      const result = await drain(gateway.stream({ model: name, messages: [message] }))
      expect(requests[0]?.reasoning_split).toBe(true)
      expect(requests[0]?.max_completion_tokens).toBe(4096)
      expect(requests[0]?.max_tokens).toBeUndefined()
      expect(result.text).toBe(text)
      expect(result.thinking).toBe('分析里也有 `<think>` 和 `</think>`。')
      expect(result.reasoningState).toEqual({ provider: 'minimax', model: name })
    })
  }

  test('没有思考字段的响应也不根据正文猜测思考', async () => {
    const text = '<think>这就是需要输出的字面内容</think>'
    const { gateway } = endpoint([{ content: text }])
    const result = await drain(gateway.stream({ model, messages: [message] }))
    expect(result.text).toBe(text)
    expect(result.thinking).toBe('')
    expect(result.reasoningState).toBeUndefined()
  })

  test('SDK 未承载的 details 按块合并，保留全部字段，并在同源工具往返中回传', async () => {
    const { gateway, requests } = endpoint([
      { reasoning_content: '先读', reasoning_details: [{ ...detail, text: '先读', extra: { kept: true } }] },
      { reasoning_content: '文件', reasoning_details: [{ ...detail, text: '文件' }] },
      { reasoning_details: [{ ...detail, id: 'second', index: 1, text: '第二块' }] },
      { content: '正文 `<think>` 保留' },
    ])
    const result = await drain(gateway.stream({ model, messages: [message] }))
    const details = [
      { ...detail, text: '先读文件', extra: { kept: true } },
      { ...detail, id: 'second', index: 1, text: '第二块' },
    ]
    expect(result.reasoningState).toEqual({ ...source, details })
    const history: ModelMessage[] = [message, {
      role: 'assistant', content: result.text, reasoning: result.thinking, reasoningState: result.reasoningState,
      toolCalls: [{ id: 't1', name: 'read', args: { path: 'a' } }],
    }, { role: 'tool', callId: 't1', name: 'read', ok: true, output: '文件内容' }]
    await drain(gateway.stream({ model, messages: history }))
    const sent = (requests[1]?.messages as Record<string, unknown>[]).find(x => x.role === 'assistant')
    expect(sent?.reasoning_content).toBe('先读文件')
    expect(sent?.reasoning_details).toEqual(details)
    expect(sent?.content).toBe(result.text)
    expect(sent?.tool_calls).toHaveLength(1)
  })

  test('不把旧的、异连接或异模型思考回传给 MiniMax；正文始终保留', async () => {
    const { gateway, requests } = endpoint([{ content: '好' }])
    const own = { role: 'assistant' as const, content: '正文', reasoning: '私有思考' }
    await drain(gateway.stream({ model, messages: [message,
      own,
      { ...own, reasoningState: { provider: 'other', model, details: [detail] } },
      { ...own, reasoningState: { provider: 'minimax', model: 'other', details: [detail] } },
    ] }))
    const sent = (requests[0]?.messages as Record<string, unknown>[]).filter(x => x.role === 'assistant')
    expect(sent).toHaveLength(3)
    for (const assistant of sent) {
      expect(assistant.content).toBe('正文')
      expect(assistant.reasoning_content).toBeUndefined()
      expect(assistant.reasoning_details).toBeUndefined()
    }
  })

  test('MiniMax 协议数据不流入 DeepSeek，后者缺思考的既有处理保留', async () => {
    const { gateway, requests } = endpoint([{ content: '好' }], 'ds', { vendor: 'deepseek' })
    await drain(gateway.stream({ model: 'deepseek-flash', messages: [message, {
      role: 'assistant', content: '正文', reasoning: 'MiniMax 思考', reasoningState: { ...source, details: [detail] },
    }] }))
    const sent = (requests[0]?.messages as Record<string, unknown>[]).find(x => x.role === 'assistant')
    expect(sent?.reasoning_content).toBe('（这一轮没有产出思考。）')
    expect(sent?.reasoning_details).toBeUndefined()
    expect(requests[0]?.reasoning_split).toBeUndefined()
  })

  test('无法保留的 details 结构应报告错误，不能静默丢失', async () => {
    const { gateway } = endpoint([{ reasoning_content: '思考', reasoning_details: 'broken' }])
    const result = await drain(gateway.stream({ model, messages: [message] }))
    expect(result.error?.message).toContain('reasoning_details')
  })
})
