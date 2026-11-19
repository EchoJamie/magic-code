import { expect, test } from 'bun:test'
import { notesFixture } from './notes-support.ts'
import type { KernelEvent, ModelGateway } from '@magic/contracts'
import { createCompactController } from '@magic/host'

function held(base: ModelGateway) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const requests: Parameters<ModelGateway['stream']>[0][] = []
  const gateway: ModelGateway = { stream(request, options) {
    calls++; requests.push(request)
    const stream = base.stream(request, options)
    return { result: stream.result, events: (async function* () { await gate; yield* stream.events })() }
  } }
  return { gateway, release, requests, get calls() { return calls } }
}
async function until(check: () => boolean) {
  const end = Date.now() + 2000
  while (!check() && Date.now() < end) await Bun.sleep(2)
  expect(check()).toBe(true)
}
function fixture() {
  const gates = { main: undefined as ReturnType<typeof held> | undefined, preparation: undefined as ReturnType<typeof held> | undefined }
  const f = notesFixture({ near: 1, gateway(base) {
    const main = held(base), preparation = held(base)
    gates.main = main; gates.preparation = preparation
    return { stream(request, options) { return ((request.messages[0]?.role === 'system' && typeof request.messages[0].content === 'string' && request.messages[0].content.startsWith('你是这次交接的记录者')) ? preparation : main).gateway.stream(request, options) } }
  } })
  const published: KernelEvent[] = []
  const controller = createCompactController({ store: f.store, now: Date.now, publish: event => published.push(event) })
  const request = { type: 'compact.request' as const, session: f.session, requestId: 'request', focus: '保留已完成与未验证的区别' }
  const run = (signal: AbortSignal, started: () => void) => f.service.compact(request, signal, started)
  return { ...f, controller, request, run, main: gates.main!, preparation: gates.preparation!, published,
    async close() { gates.main!.release(); gates.preparation!.release(); await controller.close(); await f.close() } }
}

test('空闲主动压缩共用真实服务与摘要事务，不启动业务；同请求只受理一次，提交后取消仍完成', async () => {
  const f = fixture()
  try {
    expect((await f.controller.request(f.request, f.run)).state).toBe('pending')
    await until(() => f.preparation.calls === 1)
    await f.controller.request(f.request, f.run)
    expect(f.main.calls).toBe(0)
    expect(f.events.some(event => event.kind === 'agent.start' || event.kind === 'turn.start')).toBe(false)
    f.preparation.release()
    await until(() => f.published.some(event => event.kind === 'compact.state' && event.data.state === 'completed'))
    const result = await f.controller.cancel('work', 'request')
    expect(result.state).toBe('completed')
    expect(result.summary).toBe(f.records.coverage.read().summary!)
    expect(f.preparation.calls).toBe(1)
    expect(JSON.stringify(f.preparation.requests[0]?.messages)).toContain(f.request.focus)
    expect(f.service.busy()).toBe(false)
    const persisted: KernelEvent[] = []
    for await (const event of f.records.readEvents('work')) persisted.push(event)
    expect(persisted.filter(event => event.kind === 'compact.state' && event.data.state === 'completed')).toHaveLength(1)
  } finally { await f.close() }
})

test('忙时等完整模型边界再压缩，取消待执行请求不打断所属业务', async () => {
  const f = fixture()
  try {
    f.service.submit({ text: '继续原工作', ref: 'input' })
    await until(() => f.main.calls === 1)
    await f.controller.request(f.request, f.run)
    expect(f.preparation.calls).toBe(0)
    expect((await f.controller.cancel('work', 'request')).state).toBe('cancelled')
    expect(f.preparation.calls).toBe(0)
    f.main.release()
    await until(() => !f.service.busy())
    expect(f.events.some(event => event.kind === 'turn.end' && event.data.reason === 'settled')).toBe(true)
    expect(f.records.coverage.read().summary).toBeNull()
  } finally { await f.close() }
})

test('忙时压缩只在模型完整返回后开始，固定来源不会把新交代当控制重点', async () => {
  const f = fixture()
  try {
    f.service.submit({ text: '继续业务', ref: 'input' })
    await until(() => f.main.calls === 1)
    await f.controller.request(f.request, f.run)
    expect(f.preparation.calls).toBe(0)
    f.main.release()
    await until(() => f.preparation.calls === 1)
    f.preparation.release()
    await until(() => !f.service.busy())
    expect((await f.controller.query('work', 'request')).state).toBe('completed')
    const entries = []
    for await (const entry of f.records.readEntries('work')) entries.push(entry)
    expect(entries.filter(entry => entry.kind === 'user' && 'text' in entry.content && entry.content.text.includes('保留已完成'))).toHaveLength(0)
  } finally { await f.close() }
})

test('重启有受理无终态记中断且不重放；无会话和归档不创建执行责任', async () => {
  const f = fixture()
  try {
    f.records.appendEvent({ id: f.records.nextId(), session: 'work', turn: null, at: 1, kind: 'compact.state', data: { requestId: 'orphan', accepted: true, state: 'running' } })
    await f.controller.recover()
    expect((await f.controller.query('work', 'orphan')).state).toBe('interrupted')
    expect((await f.controller.request({ ...f.request, session: 'missing' }, f.run)).state).toBe('no-material')
    f.store.setSessionArchived('work', true)
    expect((await f.controller.request(f.request, f.run)).state).toBe('failed')
    expect(f.main.calls + f.preparation.calls).toBe(0)
    expect(f.store.hasSession('missing')).toBe(false)
  } finally { await f.close() }
})

test('无重点主动压缩省略可选字段，真实记录事件仍能通过JSON校验', async () => {
  const f = fixture()
  const request = { type: 'compact.request' as const, session: 'work', requestId: 'without-focus' }
  try {
    const accepted = await f.controller.request(request, (signal, started) => f.service.compact(request, signal, started))
    expect(accepted.state).toBe('pending')
    expect(Object.hasOwn(accepted, 'focus')).toBe(false)
    f.preparation.release()
    await until(() => f.published.some(event => event.kind === 'compact.state' && event.data.state === 'completed'))
    expect((await f.controller.query('work', request.requestId)).state).toBe('completed')
    expect(f.main.calls).toBe(0)
  } finally { await f.close() }
})
