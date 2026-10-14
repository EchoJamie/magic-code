import type { Command, StopPhase, StopScope } from '@magic/contracts'
import { sendToExecutor as send, type Executor } from './executor-control.ts'
import { refresh, stopReasonOf, type RunRecord } from './facts.ts'
import { reclaim, reclaimNoteOf } from './reclaim.ts'

/** 独占停止等待与回收任务；直接更新管理者持有的 RunRecord，不复制运行事实。
 * 等待与回收均绑定原对象，不以会话 id 兑现后继代的停止。
 */
export function createRunStops(input: {
  now: () => number
  liveOf: (session: string) => Executor | undefined
  lastRuns: ReadonlyMap<string, RunRecord>
  stopGraceMs: number
  stopKillMs: number
  deliver: (executor: Executor, command: Command) => void
  reportStop: (connId: number, session: string, scope: StopScope, phase: StopPhase, note?: string) => void
  changed: (immediate?: boolean) => void
  onSettled: (run: RunRecord, note: string | undefined) => void
  log: ((line: string) => void) | undefined
}) {
  const { now, liveOf, lastRuns, stopGraceMs, stopKillMs, deliver, reportStop, changed, onSettled, log } = input
  const reclaiming = new Map<RunRecord, Promise<string | undefined>>()
  const stopWaiters = new Map<RunRecord, { readonly conns: Set<number>; readonly scope: StopScope }>()

  function settleStop(run: RunRecord, note = run.reclaimNote): void {
    onSettled(run, note)
    const waiting = stopWaiters.get(run)
    if (waiting === undefined || run.session === null) return
    stopWaiters.delete(run)
    for (const id of waiting.conns) reportStop(id, run.session, waiting.scope, note === undefined ? 'done' : 'unconfirmed', note)
  }

  /** 记下「这个窗口在等这一代执行者的停止结果」。 */
  function awaitStop(conn: { readonly id: number }, run: RunRecord, scope: StopScope): void {
    const waiting = stopWaiters.get(run) ?? { conns: new Set<number>(), scope }
    waiting.conns.add(conn.id)
    stopWaiters.set(run, waiting)
  }

  function stopExecution(conn: { readonly id: number }, session: string, scope: StopScope): void {
    const live = liveOf(session)
    const stale = lastRuns.get(session)

    if (scope === 'turn') {
      if (live === undefined) {
        reportStop(
          conn.id,
          session,
          scope,
          'unconfirmed',
          '它这会儿没有活着的一代在跑——没有可以中断的那一轮',
        )
        return
      }

      deliver(live, { type: 'turn.interrupt' })
      // **局部到此为止**：不置 `stopping`、不送 `bye`、不报已停——「那条运行还在」是这一档
      // 的全部语义（设计：「**不能把局部成功显示为整体成功**」）
      reportStop(conn.id, session, scope, 'done', '只停了这一轮，那条运行还在（可以接着用）')
      return
    }

    // —— 整体：这条运行的全部资源 ＋ 它自己 ——

    if (live !== undefined) {
      // **受理**（重复停止照收）——「停止中」那一行的事实依据就在这一格
      const again = live.run.stopping
      live.run.stopping = true
      refresh(live.run, now())
      changed()

      awaitStop(conn, live.run, scope)
      reportStop(conn.id, session, scope, 'accepted', again ? '它已经在停了——这一下照旧受理' : undefined)

      // ① 先取消在途的模型 / 工具（设计：「对具体 Run **取消模型/工具**并收尾」）
      deliver(live, { type: 'turn.interrupt' })
      // ② 再叫它收尾（`bye`＝执行者那条「把资源退干净再走」的路）
      send(live, { t: 'bye', why: '收到停止' })
      // ③ 同时回收该代资源，并有界等待异步实例关闭确认。
      void escalateStop(live)
      return
    }

    // **没有活着的一代**——那要看盘上那份记录：
    if (stale?.ended !== undefined && (stale.reclaimPending || stale.reclaimNote !== undefined)) {
      awaitStop(conn, stale, scope)
      reportStop(conn.id, session, scope, 'accepted', '正在核对剩余资源')
      void reclaimRun(stale).then((note) => settleStop(stale, note))
      return
    }
    if (stale === undefined || stale.ended !== undefined) {
      // 早就没了（或它压根没跑过）：**重复停止安全受理**，如实说一句就是
      reportStop(
        conn.id,
        session,
        scope,
        'done',
        stale === undefined ? '它这会儿没有在跑的运行' : `它早就停了（${stopReasonOf(stale) ?? '已停止'}）`,
      )
      return
    }

    // **没证实结束的那一份**（失联 / 正在收尾）：照登记收回——**先核对身份，再动手**
    awaitStop(conn, stale, scope)
    reportStop(conn.id, session, scope, 'accepted', '它这会儿联系不上——照登记收回它')
    void reclaimStale(stale)
  }

  async function reclaimStale(record: RunRecord): Promise<void> {
    record.ended = { at: now(), why: '停止：照登记收回（它当时已经联系不上）', kind: 'crashed' }
    record.stopping = false
    record.reclaimPending = record.owned.length > 0
    refresh(record, now())

    const note = record.owned.length > 0 ? await reclaimRun(record) : undefined
    changed()
    settleStop(record, note)
  }

  const stoppingTasks = new WeakMap<Executor, Promise<void>>()

  /** Agent 在共享 Engine 内：只回收目标代登记资源，等待该实例关闭确认。 */
  function escalateStop(executor: Executor): Promise<void> {
    const existing = stoppingTasks.get(executor)
    if (existing !== undefined) return existing
    const closingStarts = executor.ledger.close?.()
    executor.spawned.cancel()
    const pending = (async () => {
      let note: string | undefined
      try {
        await reclaimRun(executor.run)
        await closingStarts
        note = await reclaimRun(executor.run)
      } catch (error) { note = String(error) }
      const deadline = Date.now() + stopGraceMs + 2 * stopKillMs
      while (!executor.exited && executor.run.ended === undefined && Date.now() < deadline) await Bun.sleep(25)
      if (!executor.exited && executor.run.ended === undefined) {
        note ??= '执行实例关闭尚未确认，未终止共享 Engine'
        executor.run.reclaimPending = true
        executor.run.reclaimNote = note
        refresh(executor.run, now())
        changed(true)
        settleStop(executor.run, note)
      }
    })().finally(() => stoppingTasks.delete(executor))
    stoppingTasks.set(executor, pending)
    return pending
  }

  function reclaimRun(record: RunRecord): Promise<string | undefined> {
    const existing = reclaiming.get(record)
    if (existing !== undefined) return existing
    const pending = performReclaim(record).finally(() => reclaiming.delete(record))
    reclaiming.set(record, pending)
    return pending
  }

  async function performReclaim(record: RunRecord): Promise<string | undefined> {
    const report = await reclaim(record.owned)
    const note = reclaimNoteOf(report)
    if (record.ended === undefined) return note
    record.owned = report.remaining
    record.reclaimPending = false
    record.reclaimNote = note
    refresh(record, now())
    if (note !== undefined) log?.(`收回第 ${record.gen} 代的自有进程组：${note}`)
    changed(true)
    return note
  }

  return {
    stopExecution, settleStop, reclaimStale, reclaimRun, escalateStop,
    drainReclaims: () => Promise.all([...reclaiming.values()]),
  }
}
