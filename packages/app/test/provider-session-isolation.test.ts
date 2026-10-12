import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Command, KernelEvent } from '@magic/contracts'
import { attachShell } from '../src/shell.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { makeStage } from './support.ts'
import { removeDir } from './tmp.ts'

type Wire = { path: string; model: string; body: Record<string, unknown> }

function fixture(background = false) {
  const requests: Wire[] = []
  let releasePath = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, unknown>
    const wire = { path: new URL(request.url).pathname, model: String(body.model), body }
    const index = requests.length
    requests.push(wire)
    const tool = !background ? undefined : index === 0
      ? { name: 'exec', args: { cmd: `while [ ! -f '${releasePath}' ]; do sleep 0.02; done; printf A_BACKGROUND_DONE`, background: true } }
      : index === 1 ? { name: 'background_wait', args: { ids: ['bg-1'] } } : undefined
    const delta = tool ? { tool_calls: [{ index: 0, id: `call-${index}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
      : { content: `reply:${wire.path}:${wire.model}` }
    const chunk = (delta: unknown, finish?: string) => `data: ${JSON.stringify({ id: `response-${index}`, object: 'chat.completion.chunk', created: 1, model: wire.model,
      choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`
    return new Response(chunk(delta) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
  } })
  const endpoint = `http://127.0.0.1:${server.port}`
  const selections = {
    a: { choice: 'default' as const, provider: 'service-a', model: 'A/Exact:2026', protocol: 'chat-completions' as const, endpoint: `${endpoint}/service-a/v1` },
    b: { choice: 'spell' as const, provider: 'service-b', model: 'B/Exact:2026', protocol: 'chat-completions' as const, endpoint: `${endpoint}/service-b/v2` },
  }
  const stage = makeStage({ config: {
    providers: Object.fromEntries(Object.values(selections).map(selection => [selection.provider, { protocol: selection.protocol, baseURL: selection.endpoint, auth: 'none' }])),
    models: { default: { provider: selections.a.provider, model: selections.a.model }, spell: { provider: selections.b.provider, model: selections.b.model } },
  } })
  releasePath = join(stage.workspace, 'release-a-background')
  const assembly = stage.assemble({ modelGateway: undefined, modelFetch: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.origin !== endpoint) throw new Error(`测试禁止外网请求：${url.origin}`)
    return fetch(input, init)
  } })
  const handle = attachShell(assembly.shell, { timeoutMs: 5000 })
  const runtimeDir = runPathsOf(assembly.magic, tmpdir()).dir
  const sessionCommand = async (command: Command) => {
    const state = handle.until(event => event.kind === 'session.state')
    handle.send(command)
    const event = await state
    if (event.kind !== 'session.state') throw Error('expected session.state')
    expect(event.data.note).toBeUndefined()
    return event.data.active
  }
  const waitFor = (predicate: (event: KernelEvent) => boolean) => handle.events.find(predicate) ?? handle.until(predicate)
  return { assembly, handle, requests, selections, sessionCommand, waitFor,
    release: () => writeFileSync(releasePath, 'ready'),
    async dispose() {
      try { await assembly.shutdown() }
      finally {
        handle.dispose(); assembly.close(); server.stop(true)
        removeDir(runtimeDir)
        stage.dispose()
      }
    },
  }
}

test('缓存会话 A/B：明确切换 B 再返回 A，读面、模型请求及事件恢复 A 的绑定', async () => {
  const f = fixture()
  try {
    await f.handle.submit('A_FIRST')
    const a = f.assembly.session!
    const b = await f.sessionCommand({ type: 'session.new' })
    expect(b).not.toBe(a)
    expect(f.assembly.switchModel({ choice: 'spell' })).toEqual({ ok: true, selection: f.selections.b })
    await f.handle.submit('B_FIRST')
    expect(await f.sessionCommand({ type: 'session.open', session: a })).toBe(a)
    const current = f.assembly.models?.current()
    const from = f.handle.events.length
    await f.handle.submit('A_RETURN')
    const events = f.handle.events.slice(from).filter(event => event.kind.startsWith('model.'))
    expect({ current, requests: f.requests.map(({ path, model }) => ({ path, model })), sessions: [...new Set(events.map(event => event.session))] }).toEqual({
      current: f.selections.a,
      requests: [
        { path: '/service-a/v1/chat/completions', model: f.selections.a.model },
        { path: '/service-b/v2/chat/completions', model: f.selections.b.model },
        { path: '/service-a/v1/chat/completions', model: f.selections.a.model },
      ], sessions: [a],
    })
  } finally { await f.dispose() }
}, 15000)

test('A 后台完成续轮：B 保持选中，A 请求模型、端点和模型事件仍归 A', async () => {
  const f = fixture(true)
  try {
    await f.handle.submit('A_START_BACKGROUND')
    const a = f.assembly.session!
    await f.waitFor(event => event.kind === 'background.state' && event.session === a && event.data.waiting.includes(a))
    expect(f.requests).toHaveLength(2)
    const b = await f.sessionCommand({ type: 'session.new' })
    expect(f.assembly.switchModel({ choice: 'spell' })).toEqual({ ok: true, selection: f.selections.b })
    await f.handle.submit('B_FIRST')
    const from = f.handle.events.length
    const resumed = f.handle.until(event => event.kind === 'turn.end' && event.session === a)
    f.release()
    await resumed
    const events = f.handle.events.slice(from)
    const modelEvents = events.filter(event => event.kind.startsWith('model.'))
    expect(events.some(event => event.kind === 'exec.background.done' && event.session === a)).toBe(true)
    const resumedState = { active: f.assembly.session, current: f.assembly.models?.current(),
      request: f.requests.at(-1) && { path: f.requests.at(-1)!.path, model: f.requests.at(-1)!.model },
      modelSessions: [...new Set(modelEvents.map(event => event.session))],
    }
    expect(JSON.stringify(f.requests.at(-1)?.body)).toContain('〔后台命令跑完了〕')
    const beforeB = f.handle.events.length
    await f.handle.submit('B_AFTER_A_FINISHED')
    expect(f.requests.at(-1)).toMatchObject({ path: '/service-b/v2/chat/completions', model: f.selections.b.model })
    expect([...new Set(f.handle.events.slice(beforeB).filter(event => event.kind.startsWith('model.')).map(event => event.session))]).toEqual([b])
    expect(resumedState).toEqual({ active: b, current: f.selections.b,
      request: { path: '/service-a/v1/chat/completions', model: f.selections.a.model }, modelSessions: [a],
    })
  } finally { await f.dispose() }
}, 15000)
