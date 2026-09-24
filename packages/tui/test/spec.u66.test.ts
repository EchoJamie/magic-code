/**
 * 规格即测试 · **U66 工具行的计时只算执行本身**——设计 · 终端交互（2026-09-25 定）那两条。
 *
 * > **在等你 ≠ 在执行**：卡片挂着时那一行**不说「跑了多久」**；**批准之后计时从那刻重新起算**。
 *
 * ## 这一单判的是「起算点在哪儿」，四档各一条
 *
 * | 档 | 造法 | 那个读数该是 |
 * | --- | --- | --- |
 * | **在等裁决** | `tool.decision.request` 到了、答复还没到 | **一个数都不报**（整行照旧在） |
 * | **批准之后** | 答复 `approve` 到了（卡收了、工具真起手） | 从**答复那一刻**算起（挂卡那几秒不算） |
 * | **落地** | `tool.result` 到了 | ＝**批准 → 落地**（不是发起 → 落地） |
 * | **没弹卡**（反面） | 自动放行（没有询问那一步） | **照旧从发起算**（与改动前逐字相同） |
 *
 * ⚠️ **改前那一形**（`⟳ 2.8s` 挂在卡上、落地报「发起 → 落地」）是这一单的**由头**：
 * 用户 2026-09-25 看真机「卡片挂着时工具那行还在涨」。真机那三帧见
 * `packages/app/test/frames-u66-tui.ts`（本文件判的是同一件事的**可复跑**那一份）。
 *
 * 取景沿用 U20/U24 那一套（`createStage()` 起壳 → `stage.screen()` 取屏 → `frame.has()`），
 * 底部那几条走**真归约**（`reduce`）——那个读数是视图上的一格（`elapsedMs` / `startedAt`），
 * 屏上的形由它推出来，两处一起钉才拦得住「屏对了、账错了」。
 */

import { describe, expect, test } from 'bun:test'
import { createView, reduce } from '../src/view.ts'
import type { ShellView } from '../src/view.ts'
import { TEST_AT, event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame, Stage } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const

/** 起一个壳（带会话标题——多数用例的底子，同 `spec.u20` 的 `live`）。 */
function live(): Stage {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一件**要问**的工具：发起 → 询问（卡挂着）。三个 id 都钉死——起算点就是这些信封的 `at`。 */
const ASKED = [
  event('turn.start', {}),
  event('tool.call', { name: 'exec', args: { cmd: 'sleep 9' } }, { id: 71 }),
  event(
    'tool.decision.request',
    { call: 71, name: 'exec', material: '命令 sleep 9', weight: 'light' },
    { id: 88 },
  ),
] as const

/** 屏上那一行的**钟**（`⟳ 1.4s` / `⟳ 运行中`）——工具行的第二行。 */
const clockLine = (frame: Frame): string | undefined =>
  frame.record
    .map((line) => line.text.trim())
    .find((text) => /^⟳ (?:\d|运行中)/u.test(text))

/** 那一行**头一行**（名字与参数）。 */
const headLine = (frame: Frame): string | undefined =>
  frame.record.map((line) => line.text.trim()).find((text) => /^⟳ \S/u.test(text))

/** 一屏的记录行（真归约那一侧）。 */
const rowsOf = (view: ShellView): readonly Extract<ShellView['rows'][number], { kind: 'tool' }>[] =>
  [...view.settled, ...view.rows].filter(
    (row): row is Extract<ShellView['rows'][number], { kind: 'tool' }> => row.kind === 'tool',
  )

/** 逐条归约（同 `view.test.ts` 的 `viewed`——写成箭头，省得 `Array.reduce` 把下标塞进去）。 */
const viewed = (events: readonly Parameters<typeof reduce>[1][]): ShellView =>
  events.reduce((view, one) => reduce(view, one), createView())

describe('U66 · 卡片挂着时那一行不说「跑了多久」', () => {
  test('挂着 2.8 秒——那行**还在**（名字与参数照旧），**一个数都不报**', async () => {
    const stage = live()
    stage.feed(ASKED)

    // 卡挂了 2.8 秒（改前这儿写着 `⟳ 2.8s`——那正是用户看见的「还在涨」）
    stage.at(TEST_AT + 88 + 2800)
    const frame = await stage.screen(WIDE)

    expect(frame.has('● 等你定夺')).toBe(true) // 前提：这一段真是在等你
    expect(headLine(frame)).toBe('⟳ exec {"cmd":"sleep 9"}')
    // **底下那行不画**——不报秒数，也不回退「运行中」（它没在跑，两个说法都不成立）
    expect(frame.has('⟳ 2.8s')).toBe(false)
    expect(frame.has('⟳ 运行中')).toBe(false)
    expect(clockLine(frame)).toBeUndefined()
  })

  test('挂多久都不报数——时间走过去，**整屏**一个读数都不冒出来', async () => {
    const stage = live()
    stage.feed(ASKED)

    stage.at(TEST_AT + 88 + 60_000) // 挂着整整一分钟
    const frame = await stage.screen(WIDE)
    const readings = frame.screen.lines.flatMap((line) => [...line.matchAll(/(\d+(?:\.\d+)?)(ms|s)(?![0-9a-zA-Z])/gu)])

    expect(frame.has('● 等你定夺')).toBe(true)
    expect(readings).toEqual([]) // `ms` / `s` 一个都没有（卡上的材料与状态行也都不带）
  })
})

describe('U66 · 批准之后从那刻重新起算', () => {
  /**
   * 挂满 2.8 秒之后答「批准」——**答复那一刻就是新的起算点**。
   *
   * 三个 id 在这儿排成一条时间线（信封的 `at` ＝ `TEST_AT + id`）：**发起 `71` → 挂卡
   * 2.8 秒 → 答复 `2900` → 真跑 100ms → 落地 `3000`**。两个锚差得够远，屏上才分得出
   * 「从提请算」与「从批准算」——挨得太近的话两处渲染成同一个数，判据就白写了。
   */
  const APPROVED = event(
    'tool.decision',
    { call: 71, decision: 'approve', decider: 'user', elapsedMs: 2800 },
    { id: 2900 },
  )

  test('屏上：批准之后 1.4 秒 ⇒ 报 `⟳ 1.4s`（不是「发起 → 此刻」的 `⟳ 4.2s`）', async () => {
    const stage = live()
    stage.feed(ASKED)

    stage.feed([APPROVED])
    // 批准那一刻（信封 `2900`）之后 1400ms
    stage.at(TEST_AT + 2900 + 1400)
    const frame = await stage.screen(WIDE)

    expect(frame.has('● 工作中')).toBe(true)
    expect(frame.has('⟳ 1.4s')).toBe(true)
    // 挂卡那 2.8 秒**不算**进去：改前这一格是 `⟳ 4.2s`（发起 → 此刻）
    expect(frame.has('⟳ 4.2s')).toBe(false)
  })

  test('视图上：起算点挪到**答复那一刻**（`startedAt` ＝ 裁决事件的 `at`）', () => {
    const view = viewed([...ASKED, APPROVED])

    expect(rowsOf(view)[0]).toMatchObject({
      state: 'running',
      startedAt: TEST_AT + 2900, // 改前是 `TEST_AT + 71`（发起）
    })
    // 答完了 ⇒ **停表那一位摘掉**（不是留着 `false`／`undefined` 占位——键本身不在）
    expect(rowsOf(view)[0]?.awaitingDecision).toBeUndefined()
  })

  test('落地：耗时＝**批准 → 落地**（不是发起 → 落地）', () => {
    const view = viewed([
      ...ASKED,
      APPROVED,
      event('tool.result', { call: 71, ok: true, output: { text: '跑完了' } }, { id: 3000 }),
    ])

    // 3000 − 2900 ＝ 100（改前是 3000 − 71 ＝ 2929：那近三秒里含着他想的那 2.8 秒）
    expect(rowsOf(view)[0]).toMatchObject({ state: 'ok', elapsedMs: 100 })
  })

  test('**轮收束**（卡被撤）也摘掉那一位——否则那一行此后永不报数', () => {
    const asked = viewed(ASKED)
    expect(rowsOf(asked)[0]).toMatchObject({ awaitingDecision: true })

    const ended = viewed([...ASKED, event('turn.end', { reason: 'aborted' })])

    expect(rowsOf(ended)[0]?.awaitingDecision).toBeUndefined()
  })
})

describe('U66 · 反面：没弹卡的（自动放行）照旧从发起算', () => {
  test('自动放行**不挪**起算点——`startedAt` 还是发起那一刻', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      // 自动放行：**没有** `tool.decision.request`（没问过），只有一条裁决事件
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ startedAt: TEST_AT + 71 })
    expect(rowsOf(view)[0]?.awaitingDecision).toBeUndefined()
  })

  test('落地耗时＝**发起 → 落地**（与改动前逐字相同）', () => {
    const view = viewed([
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'hi' } }, { id: 271 }),
    ])

    expect(rowsOf(view)[0]).toMatchObject({ state: 'ok', elapsedMs: 200 }) // 271 − 71
  })

  test('跑动中照旧报数——`⟳ 1.4s`（与既有的「差距 3」同形）', async () => {
    const stage = live()
    stage.feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'echo hi' } }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'auto', elapsedMs: 0 }, { id: 90 }),
    ])

    stage.at(TEST_AT + 71 + 1400)
    const frame = await stage.screen(WIDE)

    expect(frame.has('⟳ 1.4s')).toBe(true)
  })
})

describe('U66 · 没跑的那一笔没有「耗了多久」', () => {
  test('被拒：落地也不报耗时（`✗ 未获批准，未执行`——那个数会是「他想的时间」）', () => {
    const view = viewed([
      ...ASKED,
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
