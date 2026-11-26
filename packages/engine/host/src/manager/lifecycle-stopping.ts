/**
 * **停止编排**（T1.7 SRP 拆分）——runStops 装配、停止标记、engine 整体停止/收尾的
 * 分治件。从 `lifecycle.ts` 搬移，行为不变；执行者生命周期与帧分发留在 `lifecycle.ts`。
 * 依赖同走 `ManagerContext`（与 `installLifecycle` 同形）。
 */
import type { ManagerContext } from './context.ts'
import type { Executor, RunRecord } from '@magic/host'
import { refresh } from '@magic/host'
import { clearRecord } from '../run-store.ts'
import { createRunStops } from '../stopping.ts'

type RunStops = ReturnType<typeof import('../stopping.ts').createRunStops>

export function installStopping(ctx: ManagerContext): {
  readonly markStopping: (executor: Executor, why: string) => void
  readonly afterEnd: (run: RunRecord) => void
  readonly stop: (why: string) => void
  readonly beginStop: (why: string) => Promise<void>
  readonly shutdown: (why: string) => Promise<void>
  /** runStops 解构面——lifecycle 的 retire/onEvent 等仍要用。 */
  readonly runStops: RunStops
} {
  const { now, options, executors, lastRuns, environments, closingEnvironments, connections, paths, diagnosticLog, identity } = ctx

  ctx.runStops = createRunStops({
    now, liveOf: session => ctx.liveOf(session), lastRuns, stopGraceMs: ctx.stopGraceMs, stopKillMs: ctx.stopKillMs,
    deliver: (executor, command) => ctx.deliver(executor, command),
    reportStop: ctx.reportStop,
    changed: (immediate = false) => { ctx.saveRuns(immediate); ctx.pushRuns() },
    log: options.log,
    onSettled(run, note) {
      if (note === undefined && run.ended !== undefined && !run.reclaimPending && run.reclaimNote === undefined &&
        run.session !== null && run.executionId !== undefined && !ctx.storeClosed && !ctx.settledRuns.has(run)) {
        void ctx.collaboration.executorExited(run.session, run.executionId, run.ended.why)
        ctx.settledRuns.add(run)
      }
    },
  })
  const { settleStop, reclaimStale, reclaimRun, escalateStop } = ctx.runStops

  function markStopping(executor: Executor, why: string): void {
    if (executor.run.ended !== undefined) return
    executor.run.stopping = true
    refresh(executor.run, now())
    options.log?.(`第 ${executor.gen} 代受理了停止：${why}`)
    ctx.saveRuns()
    ctx.pushRuns()
  }

  function afterEnd(run: RunRecord): void {
    ctx.releaseEnvironments()
    void reclaimRun(run).then((note) => { ctx.releaseEnvironments(); settleStop(run, note) })
  }

  function stop(why: string): void {
    void beginStop(why).catch(error => {
      const reason = `未能确认全部工作已停止：${String(error)}`
      options.log?.(reason)
      diagnosticLog.write('error', 'manager.shutdown.failed', identity)
      options.onShutdownError?.(reason)
    })
  }

  function beginStop(why: string): Promise<void> {
    if (ctx.storeClosed) return Promise.resolve()
    if (ctx.shutdownInFlight !== undefined) return ctx.shutdownInFlight
    ctx.stopped = true
    clearInterval(ctx.probe)
    if (ctx.pushTimer !== undefined) clearTimeout(ctx.pushTimer)
    ctx.native.changed()
    try {
      if (!ctx.admissionClosed) {
        ctx.collaboration.shutdown(why)
        options.lifecycle?.closeAdmission()
        ctx.admissionClosed = true
      }
    } catch (error) { return Promise.reject(error) }
    ctx.shutdownInFlight = shutdown(why).finally(() => { ctx.shutdownInFlight = undefined })
    return ctx.shutdownInFlight
  }

  async function shutdown(why: string): Promise<void> {
    const owned = [...executors]
    for (const executor of owned) {
      executor.run.stopping = true
      refresh(executor.run, now())
      executor.link.send({ t: 'bye', why })
    }
    ctx.saveRuns(true)
    // 扩展收尾与所属工具回收并行，扩展不能阻止目标 Agent 取消。
    const extension = Promise.all([ctx.compactions.close(), Promise.resolve().then(() => options.lifecycle?.shutdown())])
    let extensionTimer: ReturnType<typeof setTimeout> | undefined
    const extensionResult = Promise.race([
      extension.then(() => undefined, (error: unknown) => String(error)),
      new Promise<string>((resolve) => {
        extensionTimer = setTimeout(() => resolve('协作收尾尚未确认'), ctx.stopGraceMs + 2 * ctx.stopKillMs)
      }),
    ]).finally(() => { if (extensionTimer !== undefined) clearTimeout(extensionTimer) })
    await Promise.all(owned.map(executor => escalateStop(executor)))
    if (owned.some((one) => !one.exited && one.run.ended === undefined)) throw new Error('仍有执行资源未核销')
    await ctx.runStops.drainReclaims()
    for (const run of lastRuns.values()) {
      if (run.ended === undefined) {
        await reclaimStale(run)
      }
      if (run.owned.length > 0) await reclaimRun(run)
      if (run.reclaimNote !== undefined) throw new Error(run.reclaimNote)
      settleStop(run)
    }
    const extensionError = await extensionResult
    if (extensionError !== undefined) throw new Error(extensionError)
    await Promise.all([...environments.values()].map(network => network.close()))
    await Promise.all([...closingEnvironments])
    environments.clear()
    if (ctx.saveTimer !== undefined) clearTimeout(ctx.saveTimer)
    ctx.saveRuns(true)
    // 关闭连接后由客户端呈现断线状态，保留其草稿与重连入口。
    connections.close()
    await ctx.closeConfigWatch()
    ctx.native.close()
    ctx.server.stop(true)
    clearRecord(paths)
    ctx.storeClosed = true
    ctx.store.close()
    options.log?.(`管理者收摊（${why}）`)
    diagnosticLog.write('info', 'manager.stopped', identity)
    await diagnosticLog.close()
    await options.beforeExit?.()
    ctx.settle()
  }

  ctx.markStopping = markStopping
  ctx.afterEnd = afterEnd
  ctx.stop = stop
  ctx.beginStop = beginStop
  ctx.shutdown = shutdown

  return { markStopping, afterEnd, stop, beginStop, shutdown, runStops: ctx.runStops }
}
