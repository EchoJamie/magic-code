import { expect, test } from 'bun:test'
import type { BackgroundRuns } from '@magic/contracts'
import { defineBackgroundTools } from '../src/background-tools.ts'
import { makeToolDeps } from './helpers.ts'

test('后台控制参数在授权、目标查询和效果之前准备完成', async () => {
  let effects = 0
  const background: BackgroundRuns = { start: async () => { throw Error('unused') }, running: () => { effects++; return [] },
    stop: async () => { effects++; return { ok: true, note: 'stopped' } }, wait: () => { effects++; return { ok: true, state: 'waiting', ids: ['bg-1'] } } }
  const deps = makeToolDeps({ background, tools: defineBackgroundTools() })
  for (const [name, args] of [
    ['background_stop', {}], ['background_stop', { id: '' }],
    ['background_wait', { ids: [] }], ['background_wait', { ids: ['bg-1', 'bg-1'] }], ['background_wait', { ids: [1] }],
  ] as const) {
    const result = await deps.runtime.invoke({ id: 'bad', name, args }, {})
    expect(result.ok).toBe(false)
  }
  expect(effects).toBe(0)
  expect(deps.sink.events.filter(one => one.kind === 'tool.decision')).toHaveLength(0)
  const waiting = await deps.runtime.invoke({ id: 'wait', name: 'background_wait', args: { ids: ['bg-1'] } }, {})
  expect(waiting).toMatchObject({ ok: true, halt: true, background: { state: 'waiting', ids: ['bg-1'] } })
  expect(effects).toBe(1)
})

test('多给的键不拦、也不参与：归属仍由内核定（用户 2026-11-20 定）', async () => {
  const stopped: string[] = []
  const background: BackgroundRuns = { start: async () => { throw Error('unused') }, running: () => [],
    stop: async (id) => { stopped.push(id); return { ok: true, note: 'stopped' } }, wait: () => ({ ok: true, state: 'waiting', ids: [] }) }
  const deps = makeToolDeps({ background, tools: defineBackgroundTools() })

  const result = await deps.runtime.invoke({ id: 'x', name: 'background_stop', args: { id: 'bg-1', session: 'other' } }, {})

  expect(result.ok).toBe(true)
  expect(stopped).toEqual(['bg-1']) // 多给的 `session` 不参与：停哪一条只由 id 与内核的归属判
})
