import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import type { AgentRoleConfig, ProviderConfig, ModelSwitchRequest } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import { createAgentModels, validateSelection } from '../src/agent-models.ts'

type Seen = { route: string; body: Record<string, unknown> }
function endpoint() {
  const seen: Seen[] = []
  const held = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const route = new URL(req.url).pathname
    const body = await req.json() as Record<string, unknown>
    seen.push({ route, body })
    if (body['model'] === 'hold') { entered.resolve(); await held.promise }
    if (body['model'] === 'reject') return Response.json({ error: { message: '受控端点拒绝该模型', type: 'invalid_request_error' } }, { status: 400 })
    const delta = { content: `${route}:${String(body['model'])}` }
    return new Response(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body['model'], choices: [{ index: 0, delta }] })}\n\ndata: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: body['model'], choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
  } })
  const providers: Record<string, ProviderConfig> = {
    ds: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/ds`, apiKey: 'local-ds-test' },
    mm: { vendor: 'minimax', baseURL: `http://127.0.0.1:${server.port}/mm`, apiKey: 'local-mm-test' },
    missing: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/missing` },
  }
  const configuredModels = { default: { provider: 'ds', model: 'same' }, cantrip: { provider: 'mm', model: 'same' }, spell: { provider: 'missing', model: 'same' }, arcane: { provider: 'ds', model: 'hold' } }
  return { seen, providers, configuredModels, held, entered, close() { held.resolve(); server.stop(true) } }
}
const defaults = { choice: 'default' as const, provider: 'ds', model: 'same', reasoning: { mode: 'level' as const, level: 'high' } }
const reviewer: AgentRoleConfig = { name: '审查', instructions: '只给证据和结论', model: { reasoning: { mode: 'off' } } }
const request = { model: 'ignored-by-registry', messages: [{ role: 'user' as const, content: '受控端点测试' }] }

describe('成员模型选择预检', () => {
  test('创建失败没有候选 registry，也不改变默认与模板或发请求', () => {
    const e = endpoint()
    try {
      for (const model of [{ provider: 'missing' }, { provider: 'mm', reasoning: { mode: 'off' as const } }, { provider: 'no-such' }]) {
        const result = createAgentModels({ configuredModels: e.configuredModels, defaults, role: reviewer, config: model as ModelSwitchRequest, options: { providers: e.providers, stamper: makeTestStamper(), env: {} } })
        expect(result.ok).toBe(false)
        expect('models' in result).toBe(false)
      }
      expect(e.seen).toEqual([])
      expect(defaults.reasoning).toEqual({ mode: 'level', level: 'high' })
      expect(reviewer.model).toEqual({ reasoning: { mode: 'off' } })
    } finally { e.close() }
  })
})

describe('本地 HTTP：成员独立配置与真实出站', () => {
  test('同角色两供应商并行、切换隔离、默认与模板修改不污染已创建成员', async () => {
    const e = endpoint()
    try {
      const role = { ...structuredClone(reviewer) }
      const collaborationDefault = structuredClone(defaults)
      const a = createAgentModels({ configuredModels: e.configuredModels, role, defaults: collaborationDefault, options: { providers: e.providers, stamper: makeTestStamper({ session: 'member-a' }), env: {} } })
      const b = createAgentModels({ configuredModels: e.configuredModels, role, defaults: collaborationDefault, config: { choice: 'cantrip', reasoning: { mode: 'default' } }, options: { providers: e.providers, stamper: makeTestStamper({ session: 'member-b' }), env: {} } })
      if (!a.ok || !b.ok) throw new Error('成员应创建成功')
      expect(a.models).not.toBe(b.models)
      expect(e.seen).toEqual([])
      role.model = { choice: 'spell' }
      collaborationDefault.provider = 'missing'
      const first = await Promise.all([drainStream(a.models.stream(request)), drainStream(b.models.stream(request))])
      expect(first[0]!.result.text).toBe('/ds/chat/completions:same')
      expect(first[1]!.result.text).toBe('/mm/chat/completions:same')
      expect(first[0]!.events.every(event => event.session === 'member-a')).toBe(true)
      expect(first[1]!.events.every(event => event.session === 'member-b')).toBe(true)
      expect(first.map(one => one.result.usage?.totalTokens)).toEqual([12, 12])
      const ds = e.seen.find(one => one.route.startsWith('/ds'))!
      const mm = e.seen.find(one => one.route.startsWith('/mm'))!
      expect(ds.body['thinking']).toEqual({ type: 'disabled' })
      expect(mm.body['thinking']).toBeUndefined()
      expect(mm.body['reasoning_effort']).toBeUndefined()
      const before = a.models.current()
      const preview = validateSelection({ providers: e.providers, configuredModels: e.configuredModels, models: a.models, config: { reasoning: { mode: 'level', level: 'low' } } })
      expect(preview.ok).toBe(true)
      expect(a.models.current()).toBe(before)
      expect(e.seen.length).toBe(2)
      expect(a.models.use({ ...a.models.current()!, choice: 'default', reasoning: { mode: 'level', level: 'low' } }).ok).toBe(true)
      await Promise.all([drainStream(a.models.stream(request)), drainStream(b.models.stream(request))])
      expect(e.seen.findLast(one => one.route.startsWith('/ds'))!.body['reasoning_effort']).toBe('low')
      expect(b.models.current()).toEqual({ choice: 'cantrip' as const, provider: 'mm', model: 'same', reasoning: { mode: 'default' } })
      expect(a.models.use({ choice: 'default', provider: 'mm', model: 'alternate' }).ok).toBe(true)
      await drainStream(a.models.stream(request))
      expect(e.seen.at(-1)?.body['model']).toBe('alternate')
      expect(e.seen.at(-1)?.body['reasoning_effort']).toBeUndefined()
      expect(b.models.current()?.model).toBe('same')
      const artifact = process.env['MAGIC_MODEL_EVIDENCE']
      if (artifact) writeFileSync(artifact, JSON.stringify({ evidence: 'local-controlled-http-only', entryPoint: 'createAgentModels', requests: e.seen, sessions: first.map(one => one.events.map(event => ({ session: event.session, kind: event.kind }))) }, null, 2))
    } finally { e.close() }
  })

  test('在途请求捕获旧配置；切换只作用后续；取消一成员不影响另一成员', async () => {
    const e = endpoint()
    try {
      const a = createAgentModels({ configuredModels: e.configuredModels, defaults, config: { choice: 'arcane', reasoning: { mode: 'level', level: 'high' } }, options: { providers: e.providers, stamper: makeTestStamper({ session: 'a' }) } })
      const b = createAgentModels({ configuredModels: e.configuredModels, defaults, config: { choice: 'cantrip' }, options: { providers: e.providers, stamper: makeTestStamper({ session: 'b' }) } })
      if (!a.ok || !b.ok) throw new Error('成员应创建成功')
      const abort = new AbortController()
      const running = drainStream(a.models.stream(request, { signal: abort.signal }))
      await e.entered.promise
      expect(a.models.use({ ...a.models.current()!, choice: 'default', model: 'next', reasoning: { mode: 'off' } }).ok).toBe(true)
      abort.abort()
      const independent = await drainStream(b.models.stream(request))
      expect(independent.result.aborted).toBe(false)
      expect(independent.result.error).toBeUndefined()
      expect((await running).result.aborted).toBe(true)
      await drainStream(a.models.stream(request))
      expect(e.seen[0]?.body['model']).toBe('hold')
      expect(e.seen[0]?.body['reasoning_effort']).toBe('high')
      expect(e.seen.at(-1)?.body['model']).toBe('next')
      expect(e.seen.at(-1)?.body['thinking']).toEqual({ type: 'disabled' })
    } finally { e.close() }
  })

  test('服务端拒绝原样报告，不降档、不换供应商、不自动重发', async () => {
    const e = endpoint()
    try {
      const a = createAgentModels({ configuredModels: e.configuredModels, defaults, options: { providers: e.providers, stamper: makeTestStamper(), retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 } } })
      if (!a.ok) throw new Error(a.reason)
      expect(a.models.use({ ...a.models.current()!, choice: 'default', model: 'reject', reasoning: { mode: 'level', level: 'high' } }).ok).toBe(true)
      const result = await drainStream(a.models.stream(request))
      expect(result.result.error?.message).toContain('受控端点拒绝')
      expect(a.models.current()?.model).toBe('reject')
      expect(e.seen.length).toBe(1)
      expect(e.seen[0]?.body['reasoning_effort']).toBe('high')
    } finally { e.close() }
  })
})
