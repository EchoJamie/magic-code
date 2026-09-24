/**
 * U54 · **停完之后，状态行那一格要收尾**（缺陷 D34）——外壳那一侧的判据。
 *
 * ## 现场
 *
 * ```
 * · 「说一句长话」停了            ← 回执说停了
 *  ● 工作中 · 说一句长话 · …      ← 状态行说还在跑
 * ```
 *
 * 根子是**两处各判一遍**（U49 记过的那条）：**列表读管理者推的运行事实，状态行读外壳自己
 * 攒的**——`turn.start` 抬到「工作中」、`turn.end` 收回「空闲」。而**停这个动作从管理者
 * 那一头发起，执行者退场之后没人再报 `turn.end`**，外壳那一头于是没有下文。
 *
 * 修法顺着「运行事实由管理者推」那条走：那一格交给 `runs`（`withRunFacts`）。
 *
 * ## 四组
 *
 * 1. **收起**——事实说那条会话不在跑了（`idle` / `stopped`），那一格从「工作中」收回「空闲」，
 *    右位那句键位提示跟着换（不一屏两句话打架）；
 * 2. **抬起**——事实说在跑，那一格从「空闲」抬回「工作中」（换会话那条路：翻回一条正在跑的）；
 * 3. **不碰**——`停止中` / `状态待确认` 这两档（「在不在跑」半截或证不出来）· 那三面
 *    （等你定夺 / 正在重试 / 出错，各有各的来路）· 抽屉开着的右位提示；
 * 4. **只认当前这条会话**——在列表里停**别人**那一条，本壳那一格一个字都不动。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, RunRow, RunState, SessionSummary } from '@magic/contracts'
import {
  HINT_IDLE,
  HINT_PICKER_SESSION,
  HINT_WORKING,
  createView,
  withRunFacts,
} from '../src/view.ts'
import type { ShellStatus, ShellView } from '../src/view.ts'
import { TEST_SESSION, event } from './events.ts'
import { createRunsFeed, createStage } from './screen.ts'

/** 取景的尺寸——与别的 spec 同一档（80×24）。 */
const WIDE = { columns: 80, rows: 24 } as const

const HERE = ['/w/mine']

/** 一条运行事实——`since` / `startedAt` 取「刚才」（详情那一行的「已持续」按真钟算）。 */
const run = (id: string, state: RunState, over: Partial<RunRow> = {}): RunRow => ({
  session: id,
  state,
  since: Date.now() - 1_000,
  startedAt: Date.now() - 1_000,
  workspace: HERE,
  holds: state === 'running' || state === 'waiting' || state === 'stopping' || state === 'unknown',
  ...over,
})

const session = (id: string, title: string): SessionSummary => ({ id, title, at: 1_000, workspace: HERE })

/** 一份手搭的视图——只改这一格要验的那几处。 */
const at = (status: Partial<ShellStatus>, over: Partial<ShellView> = {}): ShellView => ({
  ...createView(),
  ...over,
  status: { ...createView().status, ...status },
})

// ═══════════════════════════════════════════════════════════════════════
// 一 · 收起：事实说它不在跑了
// ═══════════════════════════════════════════════════════════════════════

describe('U54 · 运行事实说不在跑了 ⇒ 那一格收尾', () => {
  test('「已停止」⇒ 工作中收回空闲（右位那句一起换）', () => {
    const before = at({ state: 'working', amount: null, hint: HINT_WORKING }, { sessionId: 's-a' })
    const after = withRunFacts(before, [run('s-a', 'stopped')])

    expect(after.status.state).toBe('idle')
    expect(after.status.hint).toBe(HINT_IDLE) // **右位跟着收**——不然「○ 空闲 ＋ ctrl+c 中断」又打架
  })

  test('「当前空闲」⇒ 同上（那一轮是好好收的，那一格同样不该挂着工作中）', () => {
    const before = at({ state: 'working', hint: HINT_WORKING }, { sessionId: 's-a' })

    expect(withRunFacts(before, [run('s-a', 'idle')]).status.state).toBe('idle')
  })

  test('已经闲着的照旧闲着（不是「通知」那样的伪状态，重复推多少次都一个样）', () => {
    const idle = at({ state: 'idle', hint: HINT_IDLE }, { sessionId: 's-a' })
    const after = withRunFacts(idle, [run('s-a', 'idle')])

    expect(after.status.state).toBe('idle')
    expect(after.status.hint).toBe(HINT_IDLE)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 抬起：事实说在跑
// ═══════════════════════════════════════════════════════════════════════

describe('U54 · 运行事实说在跑 ⇒ 那一格抬起', () => {
  test('空闲 → 工作中（翻回一条正在跑的会话：那一格不该还停在空闲上）', () => {
    const before = at({ state: 'idle', hint: HINT_IDLE }, { sessionId: 's-a' })
    const after = withRunFacts(before, [run('s-a', 'running')])

    expect(after.status.state).toBe('working')
    expect(after.status.hint).toBe(HINT_WORKING)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 不碰：那几档不归这条管
// ═══════════════════════════════════════════════════════════════════════

describe('U54 · 这几档运行事实不碰那一格', () => {
  test('「停止中」——已受理停止而资源还没退完：不能提前收（设计：不能提前显示已停止）', () => {
    const before = at({ state: 'working', hint: HINT_WORKING }, { sessionId: 's-a' })

    expect(withRunFacts(before, [run('s-a', 'stopping')]).status.state).toBe('working')
  })

  test('「状态待确认」——失联那一档连有没有活都证不出来，不拿它冒充此刻', () => {
    const before = at({ state: 'working', hint: HINT_WORKING }, { sessionId: 's-a' })

    expect(withRunFacts(before, [run('s-a', 'unknown')]).status.state).toBe('working')
  })

  test('那三面各有各的来路——事实不抬也不压（等你定夺 / 正在重试 / 出错）', () => {
    const cases: readonly Partial<ShellStatus>[] = [
      { state: 'waiting', amount: '2/3', hint: 'y / a / n' },
      { state: 'retrying', amount: '2/3', hint: '1.6s 后重发 · 不用管' },
      { state: 'error', amount: null, hint: HINT_IDLE },
    ]

    for (const status of cases) {
      const before = at(status, { sessionId: 's-a' })
      // 事实说在跑也好、说停了也好，那三面照旧（它们说的是「在做什么 / 出了什么状况」）
      expect(withRunFacts(before, [run('s-a', 'running')]).status).toEqual(before.status)
      expect(withRunFacts(before, [run('s-a', 'stopped')]).status).toEqual(before.status)
    }
  })

  test('抽屉开着的右位归抽屉自己——收尾只换本状态那一句', () => {
    const before = at({ state: 'working', hint: HINT_PICKER_SESSION }, { sessionId: 's-a' })
    const after = withRunFacts(before, [run('s-a', 'stopped')])

    expect(after.status.state).toBe('idle') // 左半那一格照收
    expect(after.status.hint).toBe(HINT_PICKER_SESSION) // 右位那句不是它的脸，别替它改
  })

  test('没有运行事实（拿不到的不编）——会话不在表里、或压根没接这一路，那一格照旧', () => {
    const before = at({ state: 'working', hint: HINT_WORKING }, { sessionId: 's-a' })
    expect(withRunFacts(before, []).status.state).toBe('working')
    expect(withRunFacts(before, [run('s-b', 'stopped')]).status.state).toBe('working')

    // 还没有会话（开屏那一刻）——那一格没有「这条会话」可问
    const fresh = at({ state: 'idle', hint: HINT_IDLE })
    expect(withRunFacts(fresh, [run('s-a', 'running')]).status.state).toBe('idle')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 只认当前这条会话（真链路：壳 → AppView → Ink → 屏）
// ═══════════════════════════════════════════════════════════════════════

/** 当前这条会话落定（`session.state`）——那一格与那一份事实才有可对的那条会话。 */
const settled = (): KernelEvent =>
  event(
    'session.state',
    { active: TEST_SESSION, sessions: [session(TEST_SESSION, '长话')] },
    { turn: null },
  )

describe('U54 · 停的是别人那一条，本壳那一格不动', () => {
  test('停的是别的会话 ⇒ 本壳照旧「● 工作中」', async () => {
    const feed = createRunsFeed()
    const stage = createStage({ runsFeed: feed })

    stage.feed([settled()])
    stage.feed([event('turn.start', {})])
    expect((await stage.screen(WIDE)).statusLine).toContain('● 工作中')

    // 管理者那边把**别的**一条停了（推来的事实里它变成了已停止）——本壳一个字都不该动
    feed.push([run('s-other', 'stopped'), run(TEST_SESSION, 'running')])

    const frame = await stage.screen(WIDE)
    expect(frame.statusLine).toContain('● 工作中')
    expect(frame.statusLine).not.toContain('空闲')
  })

  test('停的是本壳这一条 ⇒ 那一格收尾（回执那一屏不再自相矛盾）', async () => {
    const feed = createRunsFeed()
    const stage = createStage({ runsFeed: feed })

    stage.feed([settled()])
    stage.feed([event('turn.start', {})])
    expect((await stage.screen(WIDE)).statusLine).toContain('● 工作中')

    // 管理者把**这条**停了：核销之后事实说「已停止」——执行者已经退场，再没有 `turn.end` 可等
    feed.push([run(TEST_SESSION, 'stopped')])

    const frame = await stage.screen(WIDE)
    expect(frame.statusLine).toContain('○ 空闲')
    expect(frame.statusLine).not.toContain('工作中')
    // 右位那句也换了（那一格的脸是一整套：○ 空闲 ＋ `/ 命令 · ctrl+c 退出`）
    expect(frame.statusLine).toContain(HINT_IDLE)
  })

  test('翻回一条**已经停了**的会话 ⇒ 那一格也照新那条收（不是停在上一屏的样子）', async () => {
    const feed = createRunsFeed([run('s-gone', 'stopped')])
    const stage = createStage({ runsFeed: feed })

    // 上一屏：这条会话跑着
    stage.feed([settled()])
    stage.feed([event('turn.start', {})])
    expect((await stage.screen(WIDE)).statusLine).toContain('● 工作中')

    // 翻回一条早就停了的会话（U49 那条路：选定之后 `session.state` 答复到）
    stage.feed([
      event(
        'session.state',
        { active: 's-gone', sessions: [session('s-gone', '停过那条')] },
        { turn: null },
      ),
    ])

    const frame = await stage.screen(WIDE)
    expect(frame.statusLine).toContain('○ 空闲')
    expect(frame.statusLine).not.toContain('工作中')
  })
})
