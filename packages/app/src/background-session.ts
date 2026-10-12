import type { BackgroundChange, BackgroundFinish, BackgroundRuns, BackgroundStartOptions, BackgroundStop, BackgroundView } from '@magic/contracts'

/** 应用层只绑定归属、等待和完成输入；进程运行与回收仍由执行层唯一持有。 */
export function createBackgroundSession(input: {
  runs: BackgroundRuns; session: string; execution: string
  begin(): () => void
  deliver(finish: BackgroundChange, ref: string): boolean
  changed(view: BackgroundView): void
  stopped(): boolean
}) {
  const owned = new Set<string>()
  const completed = new Map<string, BackgroundFinish>()
  const stopping = new Map<string, Promise<BackgroundStop>>()
  const stopSources = new Map<string, 'model' | 'user'>()
  let waiting: readonly string[] = []
  const running = () => input.runs.running().filter(run => owned.has(run.id))
  const view = (): BackgroundView => ({ commands: running().map(run => ({ ...run, session: input.session, execution: input.execution })), waiting: waiting.length ? [input.session] : [] })
  const changed = () => input.changed(view())
  const cancelWait = () => { if (waiting.length) { waiting = []; changed() } }
  const finish = (done: BackgroundFinish, release: () => void) => {
    if (completed.has(done.id)) return
    const source = input.stopped() ? 'scope' : stopSources.get(done.id)
    if (source) done = { ...done, stoppedBy: source }
    completed.set(done.id, done)
    if (waiting.includes(done.id)) cancelWait()
    const ref = `background:${input.execution}:${done.id}`
    if (source === 'model') {
      // 当前停止调用以结构化工具结果承接，不再投一份空闲唤醒。
      release()
    } else if (input.deliver(done, ref)) {
      // 输入已持久受理之后才能释放协作资源责任。
      release()
    }
    input.changed({ ...view(), result: { target: { execution: input.execution, session: input.session, id: done.id }, outcome: { ok: true, note: done.stopped ? `${done.id} 已停止` : `${done.id} 已结束`, finish: done } } })
  }
  const stop = async (id: string, source: 'model' | 'user'): Promise<BackgroundStop> => {
    if (!owned.has(id)) return { ok: false, reason: `没有本会话持有的后台命令 ${id}` }
    const previous = completed.get(id)
    if (previous) return { ok: true, already: true, note: `${id} 已经结束`, finish: previous }
    const pending = stopping.get(id)
    if (pending) { if (source === 'user') stopSources.set(id, source); return pending }
    stopSources.set(id, source)
    const flight = performStop(id, source).finally(() => { stopping.delete(id); if (completed.has(id)) stopSources.delete(id); changed() })
    stopping.set(id, flight)
    return flight
  }
  const performStop = async (id: string, source: 'model' | 'user'): Promise<BackgroundStop> => {
      const pending = input.runs.stop(id)
      changed()
      const result = await pending
      if (!result.ok) stopSources.delete(id)
      if (!result.ok && waiting.includes(id)) {
        // 失败是一次实际变化；后续由模型据事实判断，不靠轮询。
        cancelWait()
        input.deliver({ id, command: running().find(run => run.id === id)?.command ?? id,
          outputPath: running().find(run => run.id === id)?.outputPath ?? '', state: 'unconfirmed', stoppedBy: source,
          reason: `单项停止未确认：${result.reason}` }, `background-stop:${input.execution}:${id}:${crypto.randomUUID()}`)
      }
      return result.ok && completed.has(id) ? { ...result, finish: completed.get(id)! } : result
  }
  const port: BackgroundRuns = {
    async start(command: string, opts?: BackgroundStartOptions) {
      const release = input.begin()
      let ready = false
      let early: BackgroundFinish | undefined
      try {
        const result = await input.runs.start(command, { ...opts, onFinish(done) {
          if (!ready) early = done
          else finish(done, release)
        } })
        if (result.ok) owned.add(result.id)
        else release()
        ready = true
        if (early) finish(early, release)
        changed()
        return result
      } catch (error) { release(); throw error }
    },
    running,
    stop: id => stop(id, 'model'),
    wait(ids) {
      if (input.stopped()) return { ok: false, reason: '执行范围已停止，不能登记等待' }
      const missing = ids.find(id => !owned.has(id))
      if (missing !== undefined) return { ok: false, reason: `没有本会话持有的后台命令 ${missing}` }
      const results = ids.flatMap(id => completed.has(id) ? [completed.get(id)!] : [])
      if (results.length) return { ok: true, state: 'changed', results }
      waiting = [...ids]
      changed()
      return { ok: true, state: 'waiting', ids: waiting }
    },
  }
  return { port, view, cancelWait, waiting: () => waiting.length > 0, stop: (id: string) => stop(id, 'user') }
}
