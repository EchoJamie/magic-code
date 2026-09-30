import { describe, expect, test } from 'bun:test'
import { alive, blocksNewRun, newRunRecord, reconcile, refresh, runRowOf, storedRunOf } from '../src/run/facts.ts'

/** 存活但空闲的执行者，持久形必须来自生产转换，不能拿 idle 代替 ended。 */
function liveIdle() {
  const run = newRunRecord({ gen: 1, session: 'origin',
    startedAt: 1_000, explicit: true, pid: process.pid, procStartedAt: 500 })
  run.ready = true
  run.connected = true
  run.everConnected = true
  run.busy = false
  refresh(run, 2_000)
  return run
}

describe('持久 idle 与实际退出分别核对', () => {
  test('活原 PID 的 idle 重启后仍待核实：不生成 ended，阻止后继', () => {
    const run = liveIdle()
    const stored = storedRunOf(run)!
    expect(stored.state).toBe('idle')
    expect(stored.why).toBeUndefined()
    expect(stored.kind).toBeUndefined()
    const checked: number[] = []
    const recovered = reconcile(stored, 3_000, pid => { checked.push(pid); return 500 })
    expect(checked).toEqual([process.pid])
    expect(recovered.ended).toBeUndefined()
    expect(recovered.state).toBe('unknown')
    expect(blocksNewRun(recovered.state)).toBe(true)
    expect(runRowOf(recovered).holds).toBe(true)
  })

  test('活 PID 身份读不到时保守占用会话，不凭 idle 核销', () => {
    const stored = storedRunOf(liveIdle())!
    let checked = 0
    const recovered = reconcile(stored, 3_000, () => { checked++; return undefined })
    expect(checked).toBe(1)
    expect(recovered.ended).toBeUndefined()
    expect(recovered.state).toBe('unknown')
    expect(blocksNewRun(recovered.state)).toBe(true)
  })

  test('真结束 idle 用既有 why/kind 保留结束事实，不把已结束代次重新认作活 PID', () => {
    const run = liveIdle()
    run.ended = { at: 2_000, why: '正常释放执行者', kind: 'normal' }
    const stored = storedRunOf(run)!
    let checked = 0
    const recovered = reconcile(stored, 3_000, () => { checked++; return 60_000 })
    expect(checked).toBe(0)
    expect(recovered.ended).toEqual(run.ended)
    expect(recovered.state).toBe('idle')
    expect(recovered.since).toBe(stored.since)
    expect(blocksNewRun(recovered.state)).toBe(false)
  })

  test('PID 已复用：核对启动时刻后才确认旧代消失，不将无关活进程认作旧 executor', () => {
    const stored = storedRunOf(liveIdle())!
    const checked: number[] = []
    const recovered = reconcile(stored, 3_000, pid => { checked.push(pid); return 60_000 })
    expect(checked).toEqual([process.pid])
    expect(alive(process.pid)).toBe(true)
    expect(recovered.ended).toMatchObject({ at: 3_000, kind: 'crashed' })
    expect(recovered.state).toBe('stopped')
    expect(blocksNewRun(recovered.state)).toBe(false)
  })

  test('仅状态写着 stopped 也不能替代退出事实，仍要核对活原 PID', () => {
    const stored = { ...storedRunOf(liveIdle())!, state: 'stopped' as const }
    const recovered = reconcile(stored, 3_000, () => 500)
    expect(recovered.ended).toBeUndefined()
    expect(recovered.state).toBe('unknown')
    expect(blocksNewRun(recovered.state)).toBe(true)
  })

  test('执行者已退出但 owned 待收回：沿已有结束事实恢复，不因停止中丢失已知退出', () => {
    const run = liveIdle()
    run.ended = { at: 2_000, why: '执行者已退出，自有组待收回', kind: 'normal' }
    run.owned = [{ pgid: 123, startedAt: 1_000, kind: 'exec', what: '仍待核对的子进程' }]
    run.reclaimPending = true
    refresh(run, 2_000)
    const stored = storedRunOf(run)!
    expect(stored.state).toBe('stopping')
    let checked = 0
    const recovered = reconcile(stored, 3_000, () => { checked++; return 500 })
    expect(checked).toBe(0)
    expect(recovered.ended).toEqual(run.ended)
    expect(recovered.owned).toEqual(run.owned)
    expect(recovered.state).toBe('stopping')
    expect(blocksNewRun(recovered.state)).toBe(true)
  })
})
