import { expect, test } from 'bun:test'
import type { BackgroundChange, BackgroundFinish, BackgroundRunning, BackgroundRuns, BackgroundStartOptions, BackgroundView } from '@magic/contracts'
import { createBackgroundSession } from '../src/background-session.ts'

function fixture() {
  const live = new Map<string, BackgroundRunning>()
  const callbacks = new Map<string, BackgroundStartOptions['onFinish']>()
  const delivered: { fact: BackgroundChange; ref: string }[] = []
  const views: BackgroundView[] = []
  let responsibility = 0, starts = 0, stops = 0, stopped = false, accepted = true, failure: string | undefined
  const finish = (id: string, stopped = false) => {
    const run = live.get(id)!
    live.delete(id)
    const done: BackgroundFinish = { ...run, ok: !stopped, exit: stopped ? 143 : 0, ...(stopped ? { stopped: true } : {}) }
    callbacks.get(id)?.(done)
    return done
  }
  const runs: BackgroundRuns = {
    start: async (command, options) => {
      const id = `bg-${++starts}`, outputPath = `/output/${id}.log`
      live.set(id, { id, command, outputPath }); callbacks.set(id, options?.onFinish)
      return { ok: true, id, outputPath }
    },
    running: () => [...live.values()],
    stop: async id => { stops++; if (failure) return { ok: false, reason: failure }; finish(id, true); return { ok: true, note: '已停止' } },
  }
  const make = (session: string) => createBackgroundSession({ runs, session, execution: 'exec-1',
    begin: () => { responsibility++; let released = false; return () => { if (!released) responsibility--; released = true } },
    deliver: (fact, ref) => { expect(responsibility).toBeGreaterThan(0); delivered.push({ fact, ref }); return accepted },
    changed: value => views.push(value), stopped: () => stopped,
  })
  return { make, runs, finish, live, callbacks, delivered, views,
    responsibility: () => responsibility, stops: () => stops,
    stopScope: () => { stopped = true }, refuse: () => { accepted = false }, fail: () => { failure = '归属无法核实' } }
}

test('后台归属隔离，登记前后完成都不丢，受理完成输入才释放责任且终态只送一次', async () => {
  const f = fixture(), a = f.make('a'), b = f.make('b')
  await a.port.start('test'); await b.port.start('service')
  expect(a.port.running().map(one => one.id)).toEqual(['bg-1'])
  expect(a.port.wait!(['bg-2']).ok).toBe(false)
  expect((await a.port.stop('bg-2')).ok).toBe(false)
  expect(f.stops()).toBe(0)
  expect(a.port.wait!(['bg-1'])).toEqual({ ok: true, state: 'waiting', ids: ['bg-1'] })
  const done = f.finish('bg-1')
  expect(f.responsibility()).toBe(1)
  expect(a.waiting()).toBe(false)
  expect(a.port.wait!(['bg-1'])).toEqual({ ok: true, state: 'changed', results: [done] })
  f.callbacks.get('bg-1')?.(done)
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]?.ref).toBe('background:exec-1:bg-1')
  expect(b.port.running()).toHaveLength(1)
})

test('完成输入未受理时不能结清责任；用户停止和范围停止携带真实入口来源', async () => {
  const f = fixture(), a = f.make('a')
  await a.port.start('one'); await a.stop('bg-1')
  expect(f.delivered[0]?.fact.stoppedBy).toBe('user')
  await a.port.start('two'); f.stopScope(); f.refuse(); f.finish('bg-2', true)
  expect(f.delivered[1]?.fact.stoppedBy).toBe('scope')
  expect(f.responsibility()).toBe(1)
  expect(a.port.wait!(['bg-2']).ok).toBe(false)
})

test('模型停止的工具结果承接终态，不额外唤醒；未知 id 不落等待', async () => {
  const f = fixture(), a = f.make('a')
  await a.port.start('one')
  const stopped = await a.port.stop('bg-1')
  expect(stopped.ok && stopped.finish?.stoppedBy).toBe('model')
  expect(f.delivered).toHaveLength(0)
  expect(f.responsibility()).toBe(0)
  expect(a.port.wait!(['missing']).ok).toBe(false)
  expect(a.waiting()).toBe(false)
})

test('停止未确认唤醒明确等待，但不伪造退出事实或移除仍运行的命令', async () => {
  const f = fixture(), a = f.make('a')
  await a.port.start('one'); a.port.wait!(['bg-1']); f.fail()
  expect((await a.stop('bg-1')).ok).toBe(false)
  expect(a.waiting()).toBe(false)
  expect(a.port.running()).toHaveLength(1)
  expect(f.responsibility()).toBe(1)
  expect(f.delivered[0]?.fact).toMatchObject({ state: 'unconfirmed', reason: '单项停止未确认：归属无法核实', stoppedBy: 'user' })
  expect(f.delivered[0]?.fact).not.toHaveProperty('exit')
})

test('极短命令在 start 返回之前结束，归属先建立再受理终态', async () => {
  const facts: BackgroundChange[] = []
  let released = false
  const a = createBackgroundSession({ session: 'a', execution: 'e',
    runs: { start: async (_, options) => { options?.onFinish?.({ id: 'bg-1', command: 'true', outputPath: '/x', ok: true, exit: 0 }); return { ok: true, id: 'bg-1', outputPath: '/x' } }, running: () => [], stop: async () => ({ ok: true, note: 'ended' }) },
    begin: () => () => { released = true }, deliver: fact => { expect(released).toBe(false); facts.push(fact); return true }, changed: () => {}, stopped: () => false,
  })
  await a.port.start('true')
  expect(facts).toHaveLength(1); expect(released).toBe(true)
  expect(a.port.wait!(['bg-1'])).toMatchObject({ ok: true, state: 'changed' })
})

test('模型停止失败之后自然结束仍须自动受理；取消等待不停止命令', async () => {
  const f = fixture(), a = f.make('a')
  await a.port.start('one'); a.port.wait!(['bg-1']); a.cancelWait()
  expect(a.waiting()).toBe(false)
  expect(a.port.running()).toHaveLength(1)
  f.fail()
  expect((await a.port.stop('bg-1')).ok).toBe(false)
  f.finish('bg-1')
  expect(f.delivered).toHaveLength(1)
  expect(f.delivered[0]?.fact.stoppedBy).toBeUndefined()
  expect(f.responsibility()).toBe(0)
})
