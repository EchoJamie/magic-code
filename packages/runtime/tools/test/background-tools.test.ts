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
    ['background_stop', {}], ['background_stop', { id: '' }], ['background_stop', { id: 'bg-1', session: 'other' }],
    ['background_wait', { ids: [] }], ['background_wait', { ids: ['bg-1', 'bg-1'] }], ['background_wait', { ids: [1] }], ['background_wait', { ids: ['bg-1'], owner: 'other' }],
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
