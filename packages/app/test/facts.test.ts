import { expect, test } from 'bun:test'
import { blocksNewRun, newRunRecord, reconcile, refresh, storedRunOf } from '../src/run/facts.ts'

function idle() {
  const run = newRunRecord({ gen: 1, session: 'origin', startedAt: 1_000, explicit: true })
  run.ready = true
  run.connected = true
  run.everConnected = true
  refresh(run, 2_000)
  return run
}

test('没有结束事实的旧 Agent 随 Engine 中断，idle/stopped 均不能冒充正常结束', () => {
  for (const state of ['idle', 'stopped'] as const) {
    const recovered = reconcile({ ...storedRunOf(idle())!, state }, 3_000)
    expect(recovered.ended).toMatchObject({ at: 3_000, kind: 'crashed' })
    expect(recovered.state).toBe('stopped')
    expect(blocksNewRun(recovered.state)).toBe(false)
  }
})

test('真实正常结束保留结束事实与时间', () => {
  const run = idle()
  run.ended = { at: 2_000, why: '正常释放实例', kind: 'normal' }
  const stored = storedRunOf(run)!
  const recovered = reconcile(stored, 3_000)
  expect(recovered.ended).toEqual(run.ended)
  expect(recovered.state).toBe('idle')
  expect(recovered.since).toBe(stored.since)
})

test('实例结束时资源待回收：保留真实结束事实和全部归属，不能提前核销', () => {
  const run = idle()
  run.ended = { at: 2_000, why: '实例结束，资源待收回', kind: 'normal' }
  run.owned = [{ pgid: 123, startedAt: 1_000, kind: 'exec', what: '待核对的子进程' }]
  run.reclaimPending = true
  refresh(run, 2_000)
  const recovered = reconcile(storedRunOf(run)!, 3_000)
  expect(recovered.ended).toEqual(run.ended)
  expect(recovered.owned).toEqual(run.owned)
  expect(recovered.state).toBe('stopping')
  expect(blocksNewRun(recovered.state)).toBe(true)
})
