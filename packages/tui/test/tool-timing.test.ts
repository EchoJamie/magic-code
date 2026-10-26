/** 验证工具计时：从发起那一刻起算，落地耗时＝发起 → 落地；没跑的那一笔不报耗时。 */

import { describe, expect, test } from 'bun:test'
import { createView, reduce } from '../src/view.ts'
import type { ShellView } from '../src/view.ts'
import { TEST_AT, event } from './events.ts'
import { createStage } from './screen.ts'
import type { Stage } from './screen.ts'

const WIDE = { columns: 200, rows: 40 } as const

/** 起一个壳（带会话标题——多数用例的底子，同 `spec.u20` 的 `live`）。 */
function live(): Stage {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ archived: false, id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一屏的记录行（真归约那一侧）。 */
const rowsOf = (view: ShellView): readonly Extract<ShellView['rows'][number], { kind: 'tool' }>[] =>
  [...view.settled, ...view.rows].filter(
    (row): row is Extract<ShellView['rows'][number], { kind: 'tool' }> => row.kind === 'tool',
  )

/** 逐条归约（同 `view.test.ts` 的 `viewed`——写成箭头，省得 `Array.reduce` 把下标塞进去）。 */
const viewed = (events: readonly Parameters<typeof reduce>[1][]): ShellView =>
  events.reduce((view, one) => reduce(view, one), createView())

describe('工具计时从发起算', () => {
  test('起算点就是发起那一刻', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ startedAt: TEST_AT + 71 })
  })

  test('落地耗时＝**发起 → 落地**', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'hi' } }, { id: 271 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ state: 'ok', elapsedMs: 200 }) // 271 − 71
  })

  test('跑动中照旧报数——`1.4s`（与既有的「差距 3」同形）', async () => {
    const stage = live()
    stage.feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
    ])

    stage.at(TEST_AT + 71 + 1400)
    const frame = await stage.screen(WIDE)

    expect(frame.has('1.4s')).toBe(true)
  })
})

describe('没跑的那一笔没有「耗了多久」', () => {
  test('被拒：落地也不报耗时（`✗ 未获批准，未执行`——那个数会是「他想的时间」）', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'reject', decider: 'user', elapsedMs: 2800 }, { id: 90 }),
      event('tool.result', { call: 71, ok: false, output: { text: '（未获批准，未执行）' } }, { id: 271 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ state: 'rejected', elapsedMs: null })
  })

  test('规约扣下：同上（既有的 `notExecuted` 那一位，两处同一条账）', () => {
    const view = viewed([
      event('tool.call', { name: 'write', args: { path: 'a' } }, { id: 71 }),
      event(
        'tool.result',
        { call: 71, ok: false, notExecuted: true, output: { text: '扣住了' } },
        { id: 90 },
      ),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ state: 'unexecuted', elapsedMs: null })
  })

  test('**真跑失败**照旧报耗时（「没跑」与「跑了没成」两码事）', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'false' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: false, output: { text: 'exit 1' } }, { id: 271 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ state: 'failed', elapsedMs: 200 })
  })
})
