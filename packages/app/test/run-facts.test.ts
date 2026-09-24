/**
 * U49 · **那六行状态表逐行对事实**。
 *
 * 设计（会话与运行管理 · 用户如何发现和接回）那张表把每一行的**事实依据**写死了，本支用例
 * 就逐行拿那个依据去问判定（`runStateOf`）——**一行一档，谁也不许用一份「完成率」替代**。
 *
 * 另外三件在这一层一并咬住：
 * 1. **停止中不提前显示已停止**（`ended` 没到就一直是停止中）；
 * 2. **失联不把历史 running 当现况**（控制连接失效 ⇒ 状态待确认，而不是「没在跑」）；
 * 3. **「已停止」与「当前空闲」的分水岭是上一轮怎么收的**，不是「进程在不在」。
 *
 * 纯判定，不起进程——真进程那一层在 `run-runs.test.ts` 与 `run-terminal.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import {
  actionOf,
  blocksNewRun,
  endKindOf,
  isProgress,
  newRunRecord,
  progressOf,
  reconcile,
  refresh,
  runRowOf,
  runStateOf,
  stopReasonOf,
  tailOf,
} from '../src/run/facts.ts'
import type { RunRecord } from '../src/run/facts.ts'

/** 一条记录——各支只动它关心的那几格（其余照「刚发车」的样子）。 */
function record(over: Partial<RunRecord> = {}): RunRecord {
  const base = newRunRecord({
    gen: 1,
    session: 's-1',
    startedAt: 1_000,
    explicit: true,
    pid: 4_242,
  })
  // 多数用例要的是「已经起来的、安安静静的那一代」——发车时那两格（在跑 / 正在支起来）
  // 由各支自己按需要覆盖
  base.ready = true
  base.action = undefined
  base.state = runStateOf(base)
  base.since = 1_000
  return Object.assign(base, over)
}

describe('U49 · 六行状态逐行对事实', () => {
  test('执行中 · 正在跑测试——有在途的模型/工具调用', () => {
    const busy = record({ busy: true, turnActive: true, action: '正在跑 bash' })
    expect(runStateOf(busy)).toBe('running')

    // 只在途「这一轮开着」而 `agent.state` 还没回位——同样算在跑
    expect(runStateOf(record({ turnActive: true }))).toBe('running')
  })

  test('等待你 · 存在仍有效的提问或审批', () => {
    const asking = record({ busy: true, turnActive: true, action: '等你定夺：rm -rf build' })
    asking.decisions.set(7, 6)
    expect(runStateOf(asking)).toBe('waiting')
  })

  test('停止中 · 已受理停止，资源尚未全部退出', () => {
    const stopping = record({ stopping: true })
    expect(runStateOf(stopping)).toBe('stopping')

    // **不能提前显示已停止**——`ended` 一到才跳过去
    stopping.ended = { at: 2_000, why: '自己收摊：没人看了', kind: 'normal' }
    expect(runStateOf(stopping)).toBe('idle')
  })

  test('已停止 · 手动中断 / 异常退出', () => {
    // 上一轮被打断，那一代随后自己收了摊
    const aborted = record({ lastTurn: 'aborted', stopping: true })
    aborted.ended = { at: 2_000, why: '自己收摊：没人看了', kind: 'aborted' }
    expect(runStateOf(aborted)).toBe('stopped')
    expect(stopReasonOf(aborted)).toBe('手动中断')

    // 被杀——**没有收场回执**，故按异常记（不伪报「正常收束」）
    const killed = record()
    killed.ended = { at: 2_000, why: '进程退出（码 null）', kind: 'crashed' }
    expect(runStateOf(killed)).toBe('stopped')
    expect(stopReasonOf(killed)).toBe('异常退出：进程退出（码 null）')

    // **还活着、但上一轮是出错收的** ⇒ **当前空闲**（U50 收紧的那一档）
    //
    // ⚠️ 这一条**改了判据**（U49 时断的是 `stopped`）：那一行的事实依据是「执行者与自有资源
    // **已核销**」，而这一条里那一代还活着——上一轮怎么收的是**另一件事**，由 `lastTurn`
    // 带出去（行上那一格），不拿它冒充整个运行停掉了（设计：「不把局部成功显示为整体成功」）。
    expect(runStateOf(record({ lastTurn: 'error' }))).toBe('idle')
    expect(runRowOf(record({ lastTurn: 'error' })).lastTurn).toBe('error')
  })

  test('运行还在的时候，上一轮被打断**不叫「已停止」**（U50 改判）', () => {
    // 用户按了一下「只停这一轮」：那一轮断了，而这条运行还在、还能接着用
    const interrupted = record({ lastTurn: 'aborted' })
    expect(runStateOf(interrupted)).toBe('idle')
    expect(stopReasonOf(interrupted)).toBeUndefined()
    // 而「上一轮被中断」这件事不能就这么消失——它由行上那一格带出去（详情里说得出停点）
    expect(runRowOf(interrupted).lastTurn).toBe('aborted')
    expect(runRowOf(interrupted).reason).toBeUndefined()

    // 它**后来真收摊了**（核销）⇒ 那一行才跳到「已停止 · 手动中断」
    const gone = record({ lastTurn: 'aborted' })
    gone.ended = { at: 3_000, why: '自己收摊：没人看了', kind: 'aborted' }
    expect(runStateOf(gone)).toBe('stopped')
    expect(stopReasonOf(gone)).toBe('手动中断')
  })

  test('当前空闲 · 没有在途调用与待答项，上一轮正常结束', () => {
    expect(runStateOf(record({ lastTurn: 'settled' }))).toBe('idle')

    const done = record({ lastTurn: 'settled', stopping: true })
    done.ended = { at: 2_000, why: '自己收摊：没人看了', kind: 'normal' }
    expect(runStateOf(done)).toBe('idle')
    expect(stopReasonOf(done)).toBeUndefined()
  })

  test('状态待确认 · 控制连接失效，尚未证实执行结束', () => {
    const lost = record({ everConnected: true, connected: false })
    expect(runStateOf(lost)).toBe('unknown')

    // **失联不把历史 running 当现况**：它此刻报的是「待确认」，不是「空闲」也不是「执行中」
    const wasBusy = record({ everConnected: true, connected: false, busy: true, turnActive: true })
    expect(runStateOf(wasBusy)).toBe('unknown')

    // 而**从来就没接上过**不算失联（刚发车那一瞬还没认领）
    expect(runStateOf(record({ everConnected: false, connected: false }))).toBe('idle')
  })

  test('发车到 `ready` 之间算执行中——它不是「空闲」', () => {
    const starting = newRunRecord({ gen: 2, session: 's-2', startedAt: 10, explicit: false, pid: 5 })
    expect(runStateOf(starting)).toBe('running')
    expect(starting.action).toBe('正在起执行者')

    starting.ready = true
    starting.action = undefined
    expect(runStateOf(starting)).toBe('idle')
  })
})

describe('U49 · `since` 只在行真的换了那一刻动', () => {
  test('同一行里连着更新几次，起点不动；换了行才换起点', () => {
    const one = record()
    one.busy = true
    expect(refresh(one, 2_000)).toBe('running')
    expect(one.since).toBe(2_000)

    one.action = '正在跑 bash'
    expect(refresh(one, 3_000)).toBe('running')
    expect(one.since).toBe(2_000) // 同一行——起点不动

    one.busy = false
    expect(refresh(one, 4_000)).toBe('idle')
    expect(one.since).toBe(4_000) // 换行了——起点跟着换
  })
})

describe('U49 · 谁占着那条会话', () => {
  test('四个「占着」——running / waiting / stopping / unknown', () => {
    expect(blocksNewRun('running')).toBe(true)
    expect(blocksNewRun('waiting')).toBe(true)
    expect(blocksNewRun('stopping')).toBe(true)
    expect(blocksNewRun('unknown')).toBe(true)
    expect(blocksNewRun('idle')).toBe(false)
    expect(blocksNewRun('stopped')).toBe(false)
  })

  test('行上那一格 `holds` 与判定同源', () => {
    const unknown = record({ everConnected: true, connected: false })
    unknown.state = 'unknown'
    expect(runRowOf(unknown).holds).toBe(true)

    const idle = record()
    idle.state = 'idle'
    expect(runRowOf(idle).holds).toBe(false)
  })
})

describe('U49 · 重启核对', () => {
  test('进程还在 ⇒ 状态待确认（占着这条会话）', () => {
    const back = reconcile(
      {
        session: 's-1',
        gen: 3,
        pid: process.pid, // 一个**确实活着**的进程（本进程）
        startedAt: 1_000,
        workspace: ['/w'],
        state: 'running',
        since: 1_500,
      },
      9_000,
    )

    expect(back.state).toBe('unknown')
    expect(back.ended).toBeUndefined()
    expect(blocksNewRun(back.state)).toBe(true)
  })

  test('进程没了 ⇒ 已停止 · 异常退出（不伪报正常收束）', () => {
    const gone = reconcile(
      {
        session: 's-1',
        gen: 3,
        pid: 2 ** 30, // 这个号不会有活进程（超出 pid 上限）
        startedAt: 1_000,
        workspace: ['/w'],
        state: 'running',
        since: 1_500,
      },
      9_000,
    )

    expect(gone.state).toBe('stopped')
    expect(stopReasonOf(gone)).toContain('异常退出')
  })

  test('盘上已经写着「结束了」的——不回翻成待确认', () => {
    const done = reconcile(
      {
        session: 's-1',
        gen: 3,
        pid: process.pid,
        startedAt: 1_000,
        workspace: ['/w'],
        state: 'idle',
        since: 1_500,
        lastTurn: 'settled',
        why: '自己收摊：没人看了',
        kind: 'normal',
      },
      9_000,
    )

    expect(done.state).toBe('idle')
    expect(done.since).toBe(1_500) // 起点仍是当年那一跳，不是「重启那一刻」
  })
})

describe('U49 · 进展、动作与输出', () => {
  const event = (kind: KernelEvent['kind'], data: unknown, id: number): KernelEvent =>
    ({ id, session: 's-1', turn: null, at: id * 100, kind, data }) as KernelEvent

  test('心跳不算进展——流式增量也不算', () => {
    expect(isProgress(event('model.delta', { channel: 'text', text: '…' }, 1))).toBe(false)
    expect(isProgress(event('tool.output.delta', { call: 1, channel: 'stdout', text: '…' }, 2))).toBe(false)
    expect(isProgress(event('tool.call', { name: 'bash', args: {} }, 3))).toBe(true)
    expect(progressOf(event('tool.call', { name: 'bash', args: {} }, 3))).toBe('开始跑 bash')
  })

  test('进行时那一格与里程碑那一格各说各的', () => {
    expect(actionOf(event('tool.call', { name: 'bash', args: {} }, 3))).toBe('正在跑 bash')
    expect(actionOf(event('tool.result', { call: 3, ok: true, output: { text: '' } }, 4))).toBeNull()
    // 一条不说「此刻在干什么」的事件两头都不写
    expect(actionOf(event('message.user', { entry: 1 }, 5))).toBeUndefined()
  })

  test('输出样本取末尾、有界', () => {
    expect(tailOf('abc', 'def', 4)).toBe('cdef')
    expect(tailOf(undefined, 'xy')).toBe('xy')
  })

  test('一轮怎么收的 → 那一代怎么算', () => {
    expect(endKindOf('aborted')).toBe('aborted')
    expect(endKindOf('settled')).toBe('normal')
    expect(endKindOf(undefined)).toBe('normal')

    // **U50 补的那一位**：收摊那一刻这一轮还开着 ⇒ 被打断（`turn.end` 可能还没落）。
    // 不补它的话，「用户按停 → 执行者退出」那一档会读成 `normal` ⇒ 「当前空闲」
    // ——看起来像什么都没发生过（实测栽在 `stop-not-rollback` 那一场上）
    expect(endKindOf(undefined, true)).toBe('aborted')
    expect(endKindOf('settled', true)).toBe('aborted')
    expect(endKindOf('settled', false)).toBe('normal')
  })

  test('「手动中断」不靠 `lastTurn` 那一格才有（U50）', () => {
    // 收摊时那一轮还开着、而 `turn.end` 没落——缘由仍要说得出是「手动中断」，
    // 不能退成 `ended.why` 那种「连接断了」的什么也没说的话
    // （核销那一跳会把 `turnActive` 抹掉——判 kind 是**在它还在的时候**做的，见 `retire`）
    const cut = record({ stopping: true })
    cut.ended = { at: 2_000, why: '连接断了', kind: 'aborted' }
    expect(runStateOf(cut)).toBe('stopped')
    expect(stopReasonOf(cut)).toBe('手动中断')
  })
})
