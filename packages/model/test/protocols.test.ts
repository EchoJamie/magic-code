import { describe, expect, test } from 'bun:test'
import type { ModelMessage, ModelProtocol, ProviderConfig } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import { createModelGateway, createModelRegistry, resolveModelSource, vendorCatalog } from '../src/index.ts'

const protocols = ['responses', 'messages', 'chat-completions'] as const
const tool = { danger: { level: 'light' as const }, name: 'read', summary: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const sse = (events: object[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const reasoningItem = { id: 'r1', type: 'reasoning', content: [{ type: 'reasoning_text', text: '先读文件' }], summary: [], private_field: 'keep' }
const thinkingBlock = { type: 'thinking', thinking: '先读文件', signature: 'sig-A-B' }
function chunks(protocol: ModelProtocol, first: boolean): object[] {
  if (protocol === 'responses') return [
    { type: 'response.created', response: { id: 'resp1', created_at: 1, model: 'exact' } },
    ...(first ? [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r1' } },
      { type: 'response.reasoning_text.delta', item_id: 'r1', output_index: 0, delta: '先读文件' },
      { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 't1', name: 'read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 1, delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', output_index: 1, delta: '"a"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 't1', name: 'read', arguments: '{"path":"a"}', status: 'completed' } },
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: '完成' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1' } },
    ]),
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 5, output_tokens_details: { reasoning_tokens: 2 } } } },
  ]
  if (protocol === 'messages') return [
    { type: 'message_start', message: { id: 'msg1', type: 'message', role: 'assistant', model: 'exact', content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    ...(first ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先读文件' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-B' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'read', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a"}' } },
      { type: 'content_block_stop', index: 1 },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '完成' } },
      { type: 'content_block_stop', index: 0 },
    ]),
    { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const deltas = first ? [
    { reasoning_content: '先读文件' },
    { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] },
  ] : [{ content: '完成' }]
  return [...deltas.map(delta => ({ choices: [{ index: 0, delta }] })), { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }]
}

function harness(protocol: ModelProtocol, config: Partial<ProviderConfig> = {}, events?: (turn: number) => object[]) {
  const requests: { url: string; headers: Headers; body: any }[] = []
  const gateway = createModelGateway({ providerId: 'local', model: 'exact', config: { baseURL: 'http://127.0.0.1:4321/root/v9/', protocol, auth: 'none', ...config },
    env: { MAGIC_LOCAL_API_KEY: 'DO-NOT-READ' }, stamper: makeTestStamper(), retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    fetch: async (url, init) => { requests.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) }); return sse(events?.(requests.length) ?? chunks(protocol, requests.length === 1)) },
  })
  return { gateway, requests }
}

describe('三种 SDK 的受控多轮工具闭环', () => {
  for (const protocol of protocols) test(protocol, async () => {
    const { gateway, requests } = harness(protocol)
    const user: ModelMessage = { role: 'user', content: '读取 a' }
    const first = (await drainStream(gateway.stream({ messages: [user], tools: [tool] }))).result
    expect(first.error).toBeUndefined()
    expect(first.toolCalls).toEqual([{ id: 't1', name: 'read', args: { path: 'a' } }])
    expect(first.thinking).toBe('先读文件')
    expect(first.reasoningState).toMatchObject({ provider: 'local', model: 'exact', protocol, endpoint: 'http://127.0.0.1:4321/root/v9' })
    expect(first.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, totalTokens: 17 })
    expect(first.usage?.cacheReadTokens).toBeUndefined()
    const messages: ModelMessage[] = [user, { role: 'assistant', content: first.text, reasoning: first.thinking, reasoningState: first.reasoningState, toolCalls: first.toolCalls }, { role: 'tool', callId: 't1', name: 'read', output: '文件结果', ok: true }]
    const final = (await drainStream(gateway.stream({ messages, tools: [tool] }))).result
    expect(final.error).toBeUndefined()
    expect(final.text).toBe('完成')
    const sent = requests[1]!
    expect(sent.url).toBe(`http://127.0.0.1:4321/root/v9/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`)
    expect(sent.headers.has('authorization')).toBe(false)
    expect(sent.headers.has('x-api-key')).toBe(false)
    expect(sent.body.model).toBe('exact')
    if (protocol === 'responses') {
      expect(sent.body.store).toBe(false)
      expect(sent.body.previous_response_id).toBeUndefined()
      expect(sent.body.input).toContainEqual(reasoningItem)
      expect(sent.body.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 't1', output: '文件结果' }))
    } else if (protocol === 'messages') {
      expect(sent.body.messages.find((m: any) => m.role === 'assistant').content).toContainEqual(thinkingBlock)
      expect(JSON.stringify(sent.body.messages)).toContain('tool_use_id')
    } else {
      expect(sent.body.messages.find((m: any) => m.role === 'assistant').reasoning_content).toBe('先读文件')
      expect(sent.body.messages.find((m: any) => m.role === 'tool').tool_call_id).toBe('t1')
    }
  })
  for (const protocol of protocols) test(`${protocol}: missing end is not an executable tool`, async () => {
    const { gateway } = harness(protocol, {}, () => chunks(protocol, true).slice(0, -1))
    const result = (await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'read' }], tools: [tool] }))).result
    expect(result.error).toBeDefined()
    expect((result.toolCalls ?? []).every(call => call.invalid)).toBe(true)
  })
})

test('精确官方支持范围、默认顺序及协议级地址', () => {
  expect(resolveModelSource({ vendor: 'minimax' }, 'MiniMax-M3')).toEqual({ protocol: 'responses', endpoint: 'https://api.minimax.cn/v1' })
  expect(resolveModelSource({ vendor: 'deepseek' }, 'deepseek-v4-pro')).toEqual({ protocol: 'messages', endpoint: 'https://api.deepseek.com/anthropic/v1' })
  expect(() => resolveModelSource({ vendor: 'deepseek', protocol: 'responses' }, 'deepseek-v4-pro')).toThrow('deepseek-v4-pro')
  for (const model of ['deepseek-chat', 'deepseek-v4-flash', 'claude-opus-4']) expect(() => resolveModelSource({ vendor: 'deepseek' }, model)).toThrow(model)
  expect(vendorCatalog()[0]?.protocols.map(p => p.id)).toEqual([...protocols])
})

test('注册表保持已存协议，原配置变化不改已绑定请求', async () => {
  const config: ProviderConfig = { protocol: 'chat-completions', auth: 'none', baseURL: 'http://local/v2' }
  const providers = { local: config }
  const requests: string[] = []
  const registry = createModelRegistry({ providers, stamper: makeTestStamper(), fetch: async url => { requests.push(String(url)); return sse(chunks('chat-completions', false)) } })
  expect(registry.use({ choice: 'default', provider: 'local', model: 'exact' }).ok).toBe(true)
  const previous = registry.current()!
  providers.local = { ...config, protocol: 'responses' }
  expect(registry.use(previous).ok).toBe(true)
  await drainStream(registry.stream({ messages: [{ role: 'user', content: 'hi' }] }))
  expect(requests).toEqual(['http://local/v2/chat/completions'])
  providers.local = { ...providers.local, baseURL: 'http://other/v2' }
  expect(registry.use(previous).ok).toBe(false)
  expect(registry.current()).toEqual(previous)
})

for (const protocol of protocols) {
  for (const auth of ['none', 'bearer', 'api-key'] as const) test(`${protocol}: ${auth} authentication is explicit`, async () => {
    const { gateway, requests } = harness(protocol, { auth, apiKey: 'configured-key' }, () => chunks(protocol, false))
    await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers.get('authorization')).toBe(auth === 'bearer' ? 'Bearer configured-key' : null)
    expect(requests[0]!.headers.get('x-api-key')).toBe(auth === 'api-key' ? 'configured-key' : null)
  })
  for (const status of [401, 429, 500]) test(`${protocol}: HTTP ${status} never changes protocol`, async () => {
    const urls: string[] = []
    const gateway = createModelGateway({ providerId: 'local', model: 'exact', config: { protocol, auth: 'none', baseURL: 'http://local/prefix' },
      stamper: makeTestStamper(), retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 }, sleep: async () => {},
      fetch: async url => { urls.push(String(url)); return new Response(JSON.stringify({ error: { message: `controlled ${status}` } }), { status, headers: { 'content-type': 'application/json' } }) },
    })
    const result = (await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }))).result
    expect(result.error).toBeDefined()
    expect(urls).toHaveLength(status === 401 ? 1 : 2)
    expect(new Set(urls).size).toBe(1)
    expect(urls[0]).toEndWith(protocol === 'chat-completions' ? '/chat/completions' : `/${protocol}`)
  })
  test(`${protocol}: cancellation ends pending request`, async () => {
    const abort = new AbortController()
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const gateway = createModelGateway({ providerId: 'local', model: 'exact', config: { protocol, auth: 'none', baseURL: 'http://local/prefix' }, stamper: makeTestStamper(),
      fetch: async (_url, init) => { entered(); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }) }) },
    })
    const pending = drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { signal: abort.signal }))
    await ready
    abort.abort()
    const { result } = await pending
    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.toolCalls ?? []).toEqual([])
  })
  test(`${protocol}: private state never crosses endpoint or protocol`, async () => {
    const { gateway, requests } = harness(protocol, {}, () => chunks(protocol, false))
    const foreign: ModelMessage = { role: 'assistant', content: 'readable', reasoning: 'PRIVATE-REASONING', reasoningState: {
      provider: 'local', model: 'exact', protocol, endpoint: 'http://different/prefix',
      items: [reasoningItem], details: [{ text: 'PRIVATE-DETAIL' }],
    }, toolCalls: [{ id: 't1', name: 'read', args: { path: 'a' } }] }
    const messages: ModelMessage[] = [{ role: 'user', content: 'hi' }, foreign, { role: 'tool', callId: 't1', name: 'read', ok: true, output: 'result' }]
    await drainStream(gateway.stream({ messages, tools: [tool] }))
    expect(JSON.stringify(requests[0]!.body)).not.toContain('PRIVATE')
    expect(JSON.stringify(requests[0]!.body)).toContain('readable')
    const missing = { ...foreign, reasoningState: { provider: 'local', model: 'exact' } } as ModelMessage
    await drainStream(gateway.stream({ messages: [messages[0]!, missing, messages[2]!], tools: [tool] }))
    expect(JSON.stringify(requests[1]!.body)).not.toContain('PRIVATE')
  })
}

test('无认证不读取配置 key 或 MAGIC 环境密钥，SDK 默认环境密钥不出站', async () => {
  const originalOpenAI = process.env.OPENAI_API_KEY, originalAnthropic = process.env.ANTHROPIC_API_KEY
  process.env.OPENAI_API_KEY = 'FORBIDDEN-OPENAI'
  process.env.ANTHROPIC_API_KEY = 'FORBIDDEN-ANTHROPIC'
  try {
    for (const protocol of protocols) {
      const config: ProviderConfig = { protocol, auth: 'none', baseURL: 'http://local/prefix', get apiKey(): string { throw new Error('read configured key') } }
      const env = { get MAGIC_LOCAL_API_KEY(): string { throw new Error('read environment key') } }
      let headers: Headers | undefined
      const gateway = createModelGateway({ providerId: 'local', model: 'exact', config, env, stamper: makeTestStamper(), fetch: async (_url, init) => { headers = new Headers(init?.headers); return sse(chunks(protocol, false)) } })
      const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }))
      expect(result.error).toBeUndefined()
      expect(headers?.has('authorization')).toBe(false)
      expect(headers?.has('x-api-key')).toBe(false)
    }
  } finally {
    if (originalOpenAI === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenAI
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = originalAnthropic
  }
})

for (const vendor of ['minimax', 'deepseek']) for (const protocol of protocols) test(`${vendor}/${protocol}: exact official params and tool history`, async () => {
  const model = vendor === 'minimax' ? 'MiniMax-M3' : 'deepseek-flash'
  const source = resolveModelSource({ vendor, protocol }, model)
  const bodies: any[] = []
  const gateway = createModelGateway({ providerId: vendor, model, config: { vendor, protocol }, apiKey: 'controlled', stamper: makeTestStamper(),
    fetch: async (url, init) => { expect(String(url)).toBe(source.endpoint + (protocol === 'chat-completions' ? '/chat/completions' : `/${protocol}`)); bodies.push(JSON.parse(String(init?.body))); return sse(chunks(protocol, bodies.length === 1)) },
  })
  const user: ModelMessage = { role: 'user', content: 'read' }
  const first = (await drainStream(gateway.stream({ messages: [user], tools: [tool] }, { reasoning: { mode: 'off' } }))).result
  expect(first.error).toBeUndefined()
  expect(first.toolCalls?.[0]?.id).toBe('t1')
  if (protocol === 'responses') expect(bodies[0].reasoning).toEqual({ effort: 'none' })
  else expect(bodies[0].thinking).toEqual({ type: 'disabled' })
  const result = (await drainStream(gateway.stream({ messages: [user, { role: 'assistant', content: first.text, reasoning: first.thinking, reasoningState: first.reasoningState, toolCalls: first.toolCalls }, { role: 'tool', callId: 't1', name: 'read', ok: true, output: 'result' }], tools: [tool] }))).result
  expect(result.text).toBe('完成')
  expect(bodies[1].model).toBe(model)
  expect(bodies[1].thinking).toBeUndefined()
  expect(bodies[1].reasoning?.effort).toBeUndefined()
})

for (const protocol of protocols) test(`MiniMax M3.1/${protocol}: all documented effort levels reach the wire`, async () => {
  const bodies: any[] = []
  const gateway = createModelGateway({ providerId: 'mm', model: 'MiniMax-M3.1-Flash-Preview', config: { vendor: 'minimax', protocol }, apiKey: 'controlled', stamper: makeTestStamper(),
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(chunks(protocol, false)) },
  })
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { mode: 'level', level } }))
    expect(result.error).toBeUndefined()
    const body = bodies.at(-1)!
    expect(protocol === 'responses' ? body.reasoning.effort : protocol === 'messages' ? body.output_config.effort : body.reasoning_effort).toBe(level)
  }
  const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { mode: 'off' } }))
  expect(result.error).toBeDefined()
  expect(bodies).toHaveLength(5)
})

test('active 的容量、图片能力和出站输出额度共同冻结，未选候选继续现读', async () => {
  let known = { id: 'exact', limits: { maxContextTokens: 1000, maxOutputTokens: 100 }, capabilities: { image: false } }
  const bodies: any[] = []
  const registry = createModelRegistry({ providers: { local: { baseURL: 'http://local/v1', protocol: 'chat-completions', auth: 'none' } }, stamper: makeTestStamper(),
    modelInfoOf: (_provider, model) => ({ ...known, id: model }), fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(chunks('chat-completions', false)) },
  })
  expect(registry.use({ choice: 'default', provider: 'local', model: 'exact' }).ok).toBe(true)
  known.limits.maxOutputTokens = 800
  known = { id: 'exact', limits: { maxContextTokens: 9000, maxOutputTokens: 800 }, capabilities: { image: true } }
  expect(registry.capacityOf('local', 'exact')?.inputBudget).toBe(900)
  expect(registry.capabilityOf('local', 'exact')?.image).toBe(false)
  expect(registry.capacityOf('local', 'other')?.inputBudget).toBe(8200)
  await drainStream(registry.stream({ messages: [{ role: 'user', content: 'hi' }] }))
  expect(bodies[0].max_tokens).toBe(100)
})

for (const protocol of protocols) test(`${protocol}: unknown usage fields remain absent`, async () => {
  const { gateway } = harness(protocol, {}, () => chunks(protocol, false).map(event => {
    const e = structuredClone(event) as any
    if (protocol === 'responses' && e.response) delete e.response.usage
    if (protocol === 'chat-completions') delete e.usage
    // Messages requires input/output totals, but does not require cached or thinking token counts.
    return e
  }))
  const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }))
  expect(result.error).toBeUndefined()
  if (protocol !== 'messages') expect(result.usage).toBeUndefined()
  expect(result.usage?.reasoningTokens).toBeUndefined()
  expect(result.usage?.cacheReadTokens).toBeUndefined()
})

test('只携带私有状态且没有思考文字时仍完整往返', async () => {
  const encrypted = { type: 'reasoning', id: 'r1', encrypted_content: 'opaque-encrypted-state', summary: [] }
  const { gateway, requests } = harness('responses', {}, turn => chunks('responses', turn === 1)
    .filter((e: any) => e.type !== 'response.reasoning_text.delta')
    .map((e: any) => e.type === 'response.output_item.done' && e.item.type === 'reasoning' ? { ...e, item: encrypted } : e))
  const user: ModelMessage = { role: 'user', content: 'hi' }
  const { result } = await drainStream(gateway.stream({ messages: [user], tools: [tool] }))
  expect(result.thinking).toBe('')
  expect(result.reasoningState?.items).toEqual([encrypted])
  await drainStream(gateway.stream({ messages: [user, { role: 'assistant', content: '', reasoningState: result.reasoningState, toolCalls: result.toolCalls }, { role: 'tool', callId: 't1', name: 'read', output: 'ok', ok: true }], tools: [tool] }))
  expect(requests[1]!.body.input).toContainEqual(encrypted)
})

test('Messages 预算包含在同一个输出额度内，不让 SDK 再增加额度', async () => {
  const { gateway, requests } = harness('messages', { modelOverrides: { exact: { reasoningSupport: { budget: { minTokens: 1024, maxTokens: 2048 } }, limits: { maxOutputTokens: 3000, maxContextTokens: 10000 } } } }, () => chunks('messages', false))
  const { result, events } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { mode: 'budget', budgetTokens: 1024 } }))
  expect(result.error).toBeUndefined()
  expect(requests[0]!.body.max_tokens).toBe(3000)
  expect(requests[0]!.body.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
  expect(events.find(e => e.kind === 'model.call.start')?.data).toMatchObject({ inputBudget: 7000 })
})

for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) test(`自定义 Messages 显式档位 ${level} 使用 adaptive 与 output_config.effort`, async () => {
  const { gateway, requests } = harness('messages', { modelOverrides: { exact: { reasoningSupport: { levels: [level] } } } }, () => chunks('messages', false))
  const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { mode: 'level', level } }))
  expect(result.error).toBeUndefined()
  expect(requests[0]!.body.thinking).toEqual({ type: 'adaptive' })
  expect(requests[0]!.body.output_config).toEqual({ effort: level })
})

test('自定义 Responses 型号恰与 SDK 官方名相同，仍采用已声明可表达的显式档位', async () => {
  const bodies: any[] = []
  const gateway = createModelGateway({ providerId: 'local', model: 'gpt-5-pro', config: { protocol: 'responses', auth: 'none', baseURL: 'http://local/v1', modelOverrides: { 'gpt-5-pro': { reasoningSupport: { levels: ['low'] } } } }, stamper: makeTestStamper(),
    fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return sse(chunks('responses', false)) },
  })
  const { result } = await drainStream(gateway.stream({ messages: [{ role: 'user', content: 'hi' }] }, { reasoning: { mode: 'level', level: 'low' } }))
  expect(result.error).toBeUndefined()
  expect(bodies[0].model).toBe('gpt-5-pro')
  expect(bodies[0].reasoning).toEqual({ effort: 'low' })
})
