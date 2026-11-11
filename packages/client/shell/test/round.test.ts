import type { TurnTimingEvent } from '@magic/contracts'
import { describe, expect, test } from 'bun:test'
import { roundLineText } from '../src/components/app.ts'
import { rowLines } from '../src/components/log.ts'
import { foldRound, roundDuration, roundSummary } from '../src/round.ts'
import { createView, rebuild, reduce } from '../src/view.ts'
import { event, TEST_AT, TEST_SESSION } from './events.ts'
import { createStage } from './screen.ts'

const timing: TurnTimingEvent[] = [
  event('turn.start', {}, { id: 1 }),
  event('turn.end', { reason: 'settled', continues: true }, { id: 10_001 }),
  event('turn.start', {}, { id: 10_002, turn: 2 }),
  event('turn.end', { reason: 'settled' }, { id: 123_001, turn: 2 }),
]

describe('整轮时间投影', () => {
  test('多模型轮不归零；实时与历史统计相同', () => {
    let live = createView()
    for (const e of timing) live = reduce(live, e)
    expect(live.settled.filter(row => row.kind === 'round')).toHaveLength(1)
    const round = live.round!
    expect(roundDuration(round, 'elapsed', null)).toBe(123_000)
    expect(roundDuration(round, 'active', null)).toBe(123_000)
    expect(roundSummary(round, 'elapsed')).toMatch(/^耗时 2m 03s · 结束于 \d{2}:\d{2}$/)
    expect(roundSummary(round, 'active')).toMatch(/^耗时 2m 03s（不含等待） · 结束于 \d{2}:\d{2}$/)
    const restored = rebuild(createView(), [], { timing })
    expect(restored.round).toEqual(round)
    expect(restored.settled).toEqual(live.settled)
  })
  test('普通 waiting、失联各说实况；接回从原起点计时', () => {
    const view = rebuild({ ...createView(), sessionId: TEST_SESSION }, [], { timing: timing.slice(0, 3) })
    expect(roundLineText(view, TEST_AT + 30_001)).toBe('● thinking... 30s')
    expect(roundLineText({ ...view, turnDuration: 'active' }, TEST_AT + 30_001)).toBe('● thinking... 30s（不含等待）')
    expect(roundLineText({ ...view, status: { ...view.status, state: 'waiting' } }, TEST_AT + 50_001)).toBe('● thinking... 50s')
    expect(roundLineText({ ...view, status: { ...view.status, state: 'lost' } }, TEST_AT + 50_001)).toBe('■ 本轮状态待确认')
  })
  test('边界缺失、时间倒退不补猜', () => {
    expect(foldRound(null, timing.at(-1)!)).toBeNull()
    const start = foldRound(null, timing[0]!)!
    const backward = foldRound(start, { ...timing.at(-1)!, at: TEST_AT - 100 })!
    expect(roundSummary(backward, 'elapsed')).toBeNull()
  })
  test('失败及停止有终态且结束后不继续累计', () => {
    const start = foldRound(null, timing[0]!)!
    const end = foldRound(start, event('turn.end', { reason: 'aborted' }, { id: 30_001 }))!
    expect(roundDuration(end, 'active', TEST_AT + 999_999)).toBe(30_000)
    expect(roundSummary(end, 'elapsed')).toStartWith('已停止 · 耗时 30s')
    expect(roundSummary({ ...end, reason: 'error' }, 'elapsed')).toStartWith('失败 · 耗时 30s')
  })
  test('正文与思考在第 2 列，思考静态且全文保留', () => {
    const assistant = rowLines({ kind: 'assistant', key: 'a', text: '1234567890' }, { columns: 8, expanded: true }).map(line => line.segments.map(s => s.text).join(''))
    expect(assistant).toEqual(['  123456', '  7890'])
    const thought = { kind: 'thinking' as const, key: 't', text: '第一行\n第二行', startedAt: 1, lastAt: 9999, flowing: true }
    expect(rowLines(thought, { columns: 100, expanded: true, now: 10000 })).toEqual(rowLines(thought, { columns: 100, expanded: true, now: 20000 }))
    expect(rowLines(thought, { columns: 100, expanded: true }).map(line => line.segments.map(s => s.text).join(''))).toEqual(['│ 第一行', '│ 第二行'])
  })
  test('200×40、100×40 与矮窗：一条 loading，两条分隔线，临时层在 dock，计划不进入 scrollback', async () => {
    const stage = createStage()
    stage.feed([timing[0]!])
    stage.at(TEST_AT + 10_001)
    for (const size of [{ columns: 200, rows: 40 }, { columns: 100, rows: 40 }, { columns: 80, rows: 10 }]) {
      stage.type('/')
      const frame = await stage.screen(size)
      expect(frame.screen.lines.filter(line => line.includes('thinking...'))).toHaveLength(1)
      expect(frame.screen.lines.filter(line => /^─+$/.test(line))).toHaveLength(2)
      expect(frame.screen.lines.filter(line => line.trim() !== '').length).toBeGreaterThan(4)
      stage.press({ kind: 'ctrl+c' })
    }
    stage.shell.dispose()
  })
})
