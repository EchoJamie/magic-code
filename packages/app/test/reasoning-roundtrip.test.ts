import { expect, test } from 'bun:test'
import { createConversationSession } from '@magic/conversation'
import { createModelGateway } from '@magic/model'
import { createRecordsStore } from '@magic/records'
import { makeFauxSink, makeFauxToolRuntime, makeTestStamper } from '@magic/faux'
import type { Entry } from '@magic/contracts'
import { tempDir, removeDir } from './tmp.ts'

test('分离思考经真实记录库、工具回填和会话重建后逐字段保留', async () => {
  const dir = tempDir('magic-reasoning-')
  let store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const model = 'MiniMax-M3'
  const detail = { type: 'reasoning.text', id: 'r1', index: 0, format: 'MiniMax-response-v1' }
  const expected = { ...detail, text: '先读文件' }
  const bodyText = '与 M3 的内嵌 `<think>` 完全不同。后半段回答仍在。'
  const requests: Record<string, unknown>[] = []
  const build = () => {
    const sink = makeFauxSink()
    const stamper = makeTestStamper({ session: 's1' })
    const gateway = createModelGateway({ model: 'MiniMax-M3', providerId: 'minimax', config: { vendor: 'minimax' }, apiKey: 'test', stamper,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        const first = requests.length === 1
        const deltas = first ? [
          { reasoning_content: '先读', reasoning_details: [{ ...detail, text: '先读' }] },
          { reasoning_content: '文件', reasoning_details: [{ ...detail, text: '文件' }] },
          { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        ] : [{ content: bodyText }]
        const raw = [...deltas.map(delta => ({ delta })), { delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }]
          .map(choice => `data: ${JSON.stringify({ id: 'response', model, created: 1, object: 'chat.completion.chunk', choices: [{ index: 0, ...choice }] })}\n\n`).join('') + 'data: [DONE]\n\n'
        return new Response(raw, { headers: { 'content-type': 'text/event-stream' } })
      },
    })
    const session = createConversationSession({ session: 's1',
      prompt: { cwd: dir, platform: 'test', date: '2026-10-07' },
      gateway, stamper, sink, records: store.serviceFor('s1'),
      tools: makeFauxToolRuntime({ handlers: { read: async () => ({ ok: true, output: '文件内容' }) },
        definitions: [{ name: 'read', summary: '读取测试材料', parameters: { type: 'object', properties: {} }, danger: { level: 'light' } }],
      }),
    })
    return { session, sink }
  }
  const submit = async (stage: ReturnType<typeof build>, text: string) => {
    stage.session.submit({ text })
    const until = Date.now() + 2000
    while (Date.now() < until) {
      await new Promise(resolve => setImmediate(resolve))
      if (stage.sink.byKind('agent.state').at(-1)?.data.state === 'waiting') return
    }
    throw new Error('会话未收束')
  }
  try {
    const first = build()
    await submit(first, '读取测试材料并解释标签')
    expect(first.sink.byKind('error')).toEqual([])
    expect(requests).toHaveLength(2)
    const entries: Entry[] = []
    for await (const entry of store.readEntries('s1')) entries.push(entry)
    const assistants = entries.filter(e => e.kind === 'assistant')
    expect(assistants[0]?.payload).toEqual({ reasoning: '先读文件', reasoningState: { provider: 'minimax', model, details: [expected] } })
    expect(assistants[1]?.content).toEqual({ text: bodyText })
    const liveText = first.sink.byKind('model.delta').filter(e => e.data.channel === 'text').map(e => 'text' in e.data ? e.data.text : '').join('')
    expect(liveText).toBe(bodyText)

    store.close()
    store = createRecordsStore({ dataDir: dir, workspace: [dir] })
    const restored = build()
    restored.session.rebuild({ lastTurn: 2, announced: false })
    await submit(restored, '继续')
    expect(requests).toHaveLength(3)
    for (const request of requests.slice(1)) {
      const messages = request.messages as Record<string, unknown>[]
      const assistant = messages.find(m => m.role === 'assistant' && m.tool_calls !== undefined)
      expect(assistant?.reasoning_content).toBe('先读文件')
      expect(assistant?.reasoning_details).toEqual([expected])
      expect(messages.some(m => m.role === 'tool' && m.content === '文件内容')).toBe(true)
      expect(request.reasoning_split).toBe(true)
    }
  } finally { store.close(); removeDir(dir) }
})
