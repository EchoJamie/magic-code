import { expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import type { ModelProtocol, ProviderAuth } from '@magic/contracts'
import { attachShell, type Assembly, type ShellHandle } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase } from './support.ts'

const protocols = ['responses', 'messages', 'chat-completions'] as const
const model = 'local/U126:exact'
const key = 'u126-local-test-key'
const command = { cmd: 'echo U126' }
const prompt = '请执行 echo U126，然后告诉我结果。'
const thought = '只执行指定的本地回显命令。'
const answer = '命令已完成，输出 U126。'
const reasoningItem = { type: 'reasoning', id: 'reason-u126', content: [{ type: 'reasoning_text', text: thought }], summary: [], private_field: 'responses-private' }
const thinkingBlock = { type: 'thinking', thinking: thought, signature: 'messages-signature-A-B' }
const details = [{ type: 'reasoning.text', id: 'chat-reason', text: thought, format: 'local-chat-private' }]
const authOf = (protocol: ModelProtocol): ProviderAuth => protocol === 'responses' ? 'none' : protocol === 'messages' ? 'api-key' : 'bearer'
const pathOf = (protocol: ModelProtocol) => `/custom/v9/${protocol === 'chat-completions' ? 'chat/completions' : protocol}`
const callId = (protocol: ModelProtocol) => `exec-${protocol}`

// 沿用模型域协议用例的 SSE 形制；这里由真对话循环执行工具并构造下一次请求。
function frames(protocol: ModelProtocol, first: boolean): object[] {
  const id = callId(protocol), args = JSON.stringify(command)
  if (protocol === 'responses') return [
    { type: 'response.created', response: { id: 'resp-u126', created_at: 1, model } },
    ...(first ? [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: reasoningItem.id } },
      { type: 'response.reasoning_text.delta', item_id: reasoningItem.id, output_index: 0, delta: thought },
      { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc-u126', call_id: id, name: 'exec', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-u126', output_index: 1, delta: args.slice(0, 8) },
      { type: 'response.function_call_arguments.delta', item_id: 'fc-u126', output_index: 1, delta: args.slice(8) },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc-u126', call_id: id, name: 'exec', arguments: args, status: 'completed' } },
    ] : [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-u126' } },
      { type: 'response.output_text.delta', item_id: 'msg-u126', output_index: 0, content_index: 0, delta: answer },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-u126' } },
    ]),
    { type: 'response.completed', response: { usage: { input_tokens: 12, output_tokens: 5 } } },
  ]
  if (protocol === 'messages') return [
    { type: 'message_start', message: { id: 'msg-u126', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
    ...(first ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thought } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'messages-signature-A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: '-B' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id, name: 'exec', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(0, 8) } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args.slice(8) } },
      { type: 'content_block_stop', index: 1 },
    ] : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } },
      { type: 'content_block_stop', index: 0 },
    ]),
    { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  const deltas = first ? [
    { reasoning_content: thought, reasoning_details: details },
    { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'exec', arguments: args.slice(0, 8) } }] },
    { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] },
  ] : [{ content: answer }]
  return [...deltas.map(delta => ({ choices: [{ index: 0, delta }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } }]
}

type Wire = Record<string, any>
type WireRequest = { protocol: ModelProtocol; url: string; headers: Headers; body: Wire }
function fixture() {
  const requests: WireRequest[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const protocol = protocols.find(p => new URL(request.url).pathname === pathOf(p))
    if (protocol === undefined || request.method !== 'POST') return new Response('unexpected request', { status: 404 })
    const first = !requests.some(r => r.protocol === protocol)
    requests.push({ protocol, url: request.url, headers: request.headers, body: await request.json() as Wire })
    const data = frames(protocol, first).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
    return new Response(data, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const origin = `http://127.0.0.1:${server.port}`
  return { requests, origin, baseURL: `${origin}/custom/v9`, stop: () => server.stop(true) }
}

function contentText(content: any): string {
  return typeof content === 'string' ? content : (content ?? []).filter((p: Wire) => ['text', 'input_text', 'output_text'].includes(p.type)).map((p: Wire) => p.text).join('')
}

// 只归一公开对话与工具配对，以比较跨协议历史；私有状态另按原始请求体逐字段断言。
function historyOf(request: WireRequest): Wire[] {
  const history: Wire[] = []
  for (const message of request.body.input ?? request.body.messages) {
    if (message.role === 'system' || message.role === 'developer' || message.type === 'reasoning') continue
    const text = contentText(message.content)
    if (text && message.role !== 'tool') history.push({ role: message.role, text })
    if (message.type === 'function_call') history.push({ call: message.call_id, name: message.name, args: JSON.parse(message.arguments) })
    if (message.type === 'function_call_output') history.push({ result: message.call_id, text: contentText(message.output) })
    if (message.role === 'tool') history.push({ result: message.tool_call_id, text })
    for (const call of message.tool_calls ?? []) history.push({ call: call.id, name: call.function.name, args: JSON.parse(call.function.arguments) })
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_use') history.push({ call: block.id, name: block.name, args: block.input })
      if (block.type === 'tool_result') history.push({ result: block.tool_use_id, text: contentText(block.content) })
    }
  }
  return history
}

function assertRequest(request: WireRequest, origin: string) {
  expect(request.url).toBe(origin + pathOf(request.protocol))
  expect(request.body.model).toBe(model)
  expect(request.headers.get('authorization')).toBe(authOf(request.protocol) === 'bearer' ? `Bearer ${key}` : null)
  expect(request.headers.get('x-api-key')).toBe(authOf(request.protocol) === 'api-key' ? key : null)
  expect(request.body.tools.some((tool: Wire) => (tool.function?.name ?? tool.name) === 'exec')).toBe(true)
  expect(JSON.stringify(request.body)).not.toContain('ENV_SENTINEL')
  if (request.protocol === 'responses') {
    expect(request.body.store).toBe(false)
    expect(request.body.truncation).toBe('disabled')
    expect(request.body.previous_response_id).toBeUndefined()
    expect(request.body.conversation).toBeUndefined()
    expect(request.body.context_management).toBeUndefined()
  }
}

function assertPrivate(request: WireRequest) {
  if (request.protocol === 'responses') expect(request.body.input.filter((item: Wire) => item.type === 'reasoning')).toEqual([reasoningItem])
  else if (request.protocol === 'messages') expect(request.body.messages.flatMap((m: Wire) => Array.isArray(m.content) ? m.content : []).filter((b: Wire) => b.type === 'thinking')).toEqual([thinkingBlock])
  else {
    const assistant = request.body.messages.find((m: Wire) => m.role === 'assistant' && m.tool_calls?.length)
    expect(assistant.reasoning_content).toBe(thought)
    expect(assistant.reasoning_details).toEqual(details)
  }
}

function storedCalls(database: string): string[] {
  const db = readDatabase(database)
  try {
    return db.entries.filter(e => e.kind === 'tool-call').map(e => {
      expect(JSON.parse(e.payload!)).toEqual({ name: 'exec', args: command })
      return `entry_${e.id}`
    })
  } finally { db.close() }
}

for (const protocol of protocols) test(`真装配 ${protocol}：exec 执行、回填、正文${protocol === 'responses' ? '及同会话协议往返切换' : ''}`, async () => {
  const endpoint = fixture()
  const stage = makeStage({ config: {
    providers: { local: { baseURL: endpoint.baseURL, protocol, auth: authOf(protocol), apiKey: key } },
    models: Object.fromEntries(['default', 'cantrip', 'spell', 'arcane'].map(choice => [choice, { provider: 'local', model }])),
  } })
  let assembly: Assembly | undefined, shell: ShellHandle | undefined
  try {
    assembly = stage.assemble({ modelGateway: undefined,
      environment: { PATH: '/usr/bin:/bin', SHELL: '/bin/sh', OPENAI_API_KEY: 'ENV_SENTINEL', ANTHROPIC_API_KEY: 'ENV_SENTINEL', MAGIC_LOCAL_API_KEY: 'ENV_SENTINEL' },
      modelFetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.origin !== endpoint.origin) throw new Error(`禁止非夹具模型请求：${url.origin}`)
        return globalThis.fetch(input, init)
      },
    })
    shell = attachShell(assembly.shell, { timeoutMs: 5000 })
    await shell.submit(prompt)
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    expect(eventsOfKind(shell.events, 'turn.end').map(e => e.data.reason)).toEqual(['settled', 'settled'])
    expect(eventsOfKind(shell.events, 'tool.result').map(e => ({ ok: e.data.ok, output: e.data.output }))).toEqual([{ ok: true, output: { text: 'U126\n' } }])
    expect(endpoint.requests).toHaveLength(2)
    const [first, second] = endpoint.requests as [WireRequest, WireRequest]
    expect(historyOf(first)).toEqual([{ role: 'user', text: prompt }])
    // 应用按记录条目生成稳定配对键；供应商本次返回的 ID 不作为历史 ID。
    const pair = storedCalls(assembly.paths.database)[0]!
    const completed = [{ role: 'user', text: prompt }, { call: pair, name: 'exec', args: command }, { result: pair, text: 'U126\n' }]
    expect(historyOf(second)).toEqual(completed)
    const firstHistory = first.body.input ?? first.body.messages
    expect((second.body.input ?? second.body.messages).slice(0, firstHistory.length)).toEqual(firstHistory)
    assertPrivate(second)

    const db = readDatabase(assembly.paths.database)
    let session: string
    try {
      expect(db.sessions).toHaveLength(1)
      session = db.sessions[0]!.id
      const assistants = db.entries.filter(e => e.kind === 'assistant')
      expect(assistants.at(-1)?.content_text).toBe(answer)
      const payload = JSON.parse(assistants[0]!.payload!)
      expect(payload.reasoning).toBe(thought)
      expect(payload.reasoningState).toMatchObject({ provider: 'local', model, protocol, endpoint: endpoint.baseURL })
      if (protocol === 'responses') expect(payload.reasoningState.items).toEqual([reasoningItem])
      if (protocol === 'messages') expect(payload.reasoningState.items).toEqual([thinkingBlock])
      if (protocol === 'chat-completions') expect(payload.reasoningState.details).toEqual(details)
    } finally { db.close() }

    if (protocol === 'responses') {
      const switchTo = (next: ModelProtocol) => {
        const config = JSON.parse(readFileSync(stage.configPath, 'utf8'))
        config.providers.local.protocol = next
        config.providers.local.auth = authOf(next)
        writeFileSync(stage.configPath, JSON.stringify(config))
        shell!.send({ type: 'model.switch', choice: 'default' })
        expect(eventsOfKind(shell!.events, 'model.switched').at(-1)?.data).toMatchObject({ ok: true, protocol: next, endpoint: endpoint.baseURL })
      }
      switchTo('messages')
      const nextPrompt = '在同一会话再执行一次。'
      await shell.submit(nextPrompt)
      expect(endpoint.requests).toHaveLength(4)
      const switched = endpoint.requests[2]!, refilled = endpoint.requests[3]!
      const oldHistory = [...completed, { role: 'assistant', text: answer }, { role: 'user', text: nextPrompt }]
      expect(historyOf(switched)).toEqual(oldHistory)
      expect(JSON.stringify(switched.body)).not.toContain(thought)
      expect(JSON.stringify(switched.body)).not.toContain('responses-private')
      const nextPair = storedCalls(assembly.paths.database)[1]!
      expect(nextPair).not.toBe(pair)
      expect(historyOf(refilled)).toEqual([...oldHistory, { call: nextPair, name: 'exec', args: command }, { result: nextPair, text: 'U126\n' }])
      assertPrivate(refilled)
      expect(JSON.stringify(refilled.body)).not.toContain('responses-private')

      switchTo('responses')
      await shell.submit('保留之前记录，确认即可。')
      expect(endpoint.requests).toHaveLength(5)
      const returned = endpoint.requests[4]!
      expect(historyOf(returned)).toEqual([...historyOf(refilled), { role: 'assistant', text: answer }, { role: 'user', text: '保留之前记录，确认即可。' }])
      assertPrivate(returned)
      expect(JSON.stringify(returned.body)).not.toContain('messages-signature')
      expect(eventsOfKind(shell.events, 'tool.result').map(e => e.data.output)).toEqual([{ text: 'U126\n' }, { text: 'U126\n' }])
      expect(eventsOfKind(shell.events, 'turn.end').map(e => e.data.reason)).toEqual(['settled', 'settled', 'settled', 'settled', 'settled'])
      const after = readDatabase(assembly.paths.database)
      try {
        expect(after.sessions.map(s => s.id)).toEqual([session])
        const sources = after.entries.filter(e => e.kind === 'assistant').map(e => JSON.parse(e.payload ?? 'null')?.reasoningState).filter(Boolean)
        expect(sources.map(s => s.protocol)).toEqual(['responses', 'messages'])
        expect(sources[0].items).toEqual([reasoningItem])
        expect(sources[1].items).toEqual([thinkingBlock])
      } finally { after.close() }
    }
    expect(eventsOfKind(shell.events, 'error')).toEqual([])
    for (const request of endpoint.requests) assertRequest(request, endpoint.origin)
  } finally {
    shell?.dispose()
    assembly?.close()
    await endpoint.stop()
    stage.dispose()
  }
}, 15000)
