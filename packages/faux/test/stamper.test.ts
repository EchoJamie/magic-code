/**
 * 铸造器桩 —— 共享测试替身（M02 回报·待决线索的收口）。
 *
 * 要钉住的两件：
 * ① **信封四件**（`id` / `session` / `turn` / `at`）由桩盖——id 本地单调、`turn` 随 `beginTurn` 走；
 * ② 桩得**够用**——各域测试不必各自再写一份（每多一个域就多一处泛型断言的日子到此为止）。
 */

import { describe, expect, test } from 'bun:test'
import type { EventKind, KernelEvent } from '@magic/contracts'
import { makeTestStamper } from '../src/index.ts'

/** 缺省时钟——固定的（测试要可复现，「当下」由注入说了算）。 */
const FIXED_AT = 1_700_000_000_000

describe('信封四件', () => {
  test('铸出完整信封——id 本地单调 · session 缺省 · turn 起步为 null', () => {
    const stamper = makeTestStamper()

    const first = stamper.stamp('turn.start', {})
    const second = stamper.stamp('turn.end', { reason: 'settled' })

    expect(first).toEqual({
      id: 1,
      session: 'test-session',
      turn: null,
      at: FIXED_AT,
      kind: 'turn.start',
      data: {},
    })
    expect(second.id).toBe(2) // 单调递增——不是常量、不是随机
    expect(second.kind).toBe('turn.end')
  })

  test('四件可注入——session / turn / at / 起始 id', () => {
    const stamper = makeTestStamper({
      session: 's-42',
      turn: 7,
      at: 9_000,
      from: 100,
    })

    const e = stamper.stamp('agent.state', { state: 'waiting' })

    expect(e.session).toBe('s-42')
    expect(e.turn).toBe(7)
    expect(e.at).toBe(9_000)
    expect(e.id).toBe(100)
  })

  test('at 可给函数——按铸造次数取时（需要「时间在走」的用例）', () => {
    let now = 1_000
    const stamper = makeTestStamper({ at: () => (now += 250) })

    stamper.stamp('turn.start', {})
    stamper.stamp('turn.end', { reason: 'settled' })

    expect(stamper.stamped.map((e) => e.at)).toEqual([1_250, 1_500])
  })
})

describe('beginTurn · 轮上下文', () => {
  test('beginTurn 切换当前轮——undefined ＝ 轮止（null）', () => {
    const stamper = makeTestStamper()

    stamper.beginTurn(7)
    expect(stamper.stamp('turn.start', {}).turn).toBe(7)

    stamper.beginTurn(undefined)
    expect(stamper.stamp('turn.end', { reason: 'settled' }).turn).toBeNull()
  })

  test('轨迹留痕——含 undefined（「谁在何时调了 beginTurn」可查）', () => {
    const stamper = makeTestStamper()

    stamper.beginTurn(1)
    stamper.beginTurn(undefined)

    expect(stamper.turns).toEqual([1, undefined])
  })
})

describe('观察面与消费姿势', () => {
  test('stamped 按铸造序留痕——含信封（断言不必另拼）', () => {
    const stamper = makeTestStamper()

    stamper.stamp('model.call.start', { model: 'faux-1' })
    stamper.stamp('model.call.end', {})

    expect(stamper.stamped.map((e) => e.kind)).toEqual(['model.call.start', 'model.call.end'])
  })

  test('返回可收窄——`kind` 判别后 `data` 跟着窄（构造面即消费面）', () => {
    const stamper = makeTestStamper()

    const e: KernelEvent = stamper.stamp('model.error', { tier: 'transient', message: '限流' })

    // 不经 `as` —— 判别联合视图的直接消费姿势
    if (e.kind !== 'model.error') throw new Error('kind 判别失败')
    const tier: string = e.data.tier
    expect(tier).toBe('transient')
  })

  test('stamp 对每个 kind 都成立——泛型对应关系的断言只此一处', () => {
    const stamper = makeTestStamper()
    const kinds: readonly EventKind[] = ['agent.start', 'model.call.end', 'error']

    // 逐个 kind 铸一遍：桩的泛型实现若与契约脱节，这里即炸
    for (const kind of kinds) {
      expect(stamper.stamp(kind as 'error', { message: 'x' }).kind).toBe(kind)
    }
  })
})
