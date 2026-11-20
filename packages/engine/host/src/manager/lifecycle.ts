import type {
  AgentIdentity,
  KernelEvent,
  StopPhase,
  StopScope,
} from '@magic/contracts'
import { pendingViews } from '@magic/contracts'
import {
  ARCHIVED_NOTE,
  actionOf,
  captureCollaborationNative,
  endKindOf,
  isProgress,
  progressOf,
  refresh,
  tailOf,
} from '@magic/host'
import type { CollaborationNativeGroup, RunRecord } from '@magic/host'
import { sendToExecutor as send, type Executor } from '../executor-control.ts'
import { clearRecord } from '../run-store.ts'
import { createRunStops } from '../stopping.ts'
import type { ManagerContext } from './context.ts'

/** 执行者交接、停止等待与最终收摊。 */
export function installLifecycle(ctx: ManagerContext): void {
  const { options, paths, now, store, executors, lastRuns, connections, sessions, control, collaboration, compactions, environments, closingEnvironments, diagnosticLog, identity, stopReports, stopGenerations, stopContent, collaborationStopVersions, sudoRequests, collaborationInputs } = ctx
  const { clients } = connections
  const { workRoot, isArchived } = sessions

  const stopGeneration = (run: RunRecord): number => {
    let gen = stopGenerations.get(run)
    if (gen === undefined) { gen = ctx.nextStopGeneration++; stopGenerations.set(run, gen) }
    return gen
  }

  function workStopGeneration(session: string,
    group = captureCollaborationNative(store.collaboration, [session]).groups[0] as CollaborationNativeGroup | undefined,
  ): number | null {
    if (group === undefined) {
      const run = ctx.liveOf(session)?.run ?? lastRuns.get(session)
      return run === undefined ? null : stopGeneration(run)
    }
    const work = group.collaboration
    // 只是停止目标的版本，不另存工作状态；任何成员换代或新输入使旧菜单失效。
    const signature = JSON.stringify([
      work.state,
      group.members.map(member => {
        const run = ctx.liveOf(member.sessionId)?.run ?? lastRuns.get(member.sessionId)
        return [member.agentId, member.reachability, run === undefined ? null : stopGeneration(run)]
      }),
      group.delegations.map(item => [item.delegationId, item.state]),
      group.waits.map(item => [item.waitId, item.state]),
    ])
    const previous = collaborationStopVersions.get(work.collaborationId)
    if (previous?.signature === signature) return previous.gen
    const gen = ctx.nextStopGeneration++
    collaborationStopVersions.set(work.collaborationId, { signature, gen })
    return gen
  }

  /** 回一句「停到哪一拍」——按会话 ＋ 范围，话由外壳按它自己的目录拼（见 `wire.ts`）。 */
  function reportStop(
    connId: number,
    session: string,
    scope: StopScope,
    phase: StopPhase,
    note?: string,
  ): void {
    stopReports.get(connId)?.(phase, note)
    clients.get(connId)?.link.send({
      t: 'stopped',
      session,
      scope,
      phase,
      ...(note === undefined ? {} : { note }),
    })
  }

  async function startMember(agent: AgentIdentity): Promise<void> {
    if (ctx.stopped) throw new Error('管理者正在退出')
    if (isArchived(agent.sessionId)) throw new Error(ARCHIVED_NOTE)
    let existing = ctx.liveOf(agent.sessionId)
    if (existing?.run.stopping) { await cancelMembers([agent.sessionId]); existing = ctx.liveOf(agent.sessionId) }
    const previous = lastRuns.get(agent.sessionId)
    if (existing === undefined && previous !== undefined && (previous.ended === undefined || previous.reclaimPending || previous.reclaimNote !== undefined)) throw new Error('该成员上一代资源仍待核实')
    if (ctx.stopped) throw new Error('管理者正在退出')
    if (isArchived(agent.sessionId)) throw new Error(ARCHIVED_NOTE)
    const executor = existing ?? ctx.spawn({
      session: agent.sessionId, explicit: true,
      cwd: agent.workspace[0] ?? ''
    })
    if (executor === undefined) throw new Error('无法启动成员执行者')
    for (const conn of clients.values()) if (conn.selectedSession === agent.sessionId && conn.target !== executor) connections.bind(conn, executor)
    if (executor.run.ready) return
    return control.waitUntilReady(executor)
  }

  async function cancelMembers(sessions: readonly string[]): Promise<void> {
    await Promise.all(sessions.map(session => new Promise<void>((resolve, reject) => {
      const id = ctx.nextStopRequest--
      const timer = setTimeout(() => {
        stopReports.delete(id)
        reject(new Error('成员资源退出尚未核实'))
      }, 30_000)
      stopReports.set(id, (phase, note) => {
        if (phase === 'accepted') return
        clearTimeout(timer)
        stopReports.delete(id)
        if (phase === 'done') resolve()
        else reject(new Error(note ?? '成员资源退出尚未核实'))
      })
      // 与客户端和原生停止复用同一 RunRecord 等待及核销出口。
      stopExecution({ id }, session, 'run')
    })))
  }

  /** 等待者绑定具体执行者代次，旧代异步核销不能兑现同会话的后继代。 */
  const settledRuns = ctx.settledRuns

  installRunStops()

  function installRunStops(): void {
    ctx.runStops = createRunStops({
      now, liveOf: session => ctx.liveOf(session), lastRuns, stopGraceMs: ctx.stopGraceMs, stopKillMs: ctx.stopKillMs,
      deliver: (executor, command) => ctx.deliver(executor, command),
      reportStop,
      changed: (immediate = false) => { ctx.saveRuns(immediate); ctx.pushRuns() },
      log: options.log,
      onSettled(run, note) {
        if (note === undefined && run.ended !== undefined && !run.reclaimPending && run.reclaimNote === undefined &&
          run.session !== null && run.executionId !== undefined && !ctx.storeClosed && !settledRuns.has(run)) {
          void collaboration.executorExited(run.session, run.executionId, run.ended.why,
            run.ended.kind === 'crashed' && lastRuns.get(run.session) === run && ctx.liveOf(run.session) === undefined).catch(error => options.log?.(`中断回报尚未核实：${String(error)}`))
          settledRuns.add(run)
        }
      },
    })
  }

  const { stopExecution, settleStop, reclaimStale, reclaimRun, escalateStop } = ctx.runStops

  function markStopping(executor: Executor, why: string): void {
    if (executor.run.ended !== undefined) return
    executor.run.stopping = true
    refresh(executor.run, now())
    options.log?.(`第 ${executor.gen} 代受理了停止：${why}`)
    ctx.saveRuns()
    ctx.pushRuns()
  }

  function onExecutorMessage(executor: Executor, message: import('@magic/host').ExecutorToManager): void {

    switch (message.t) {
      case 'compact.started': control.compactStarted(executor, message.requestId); return
      case 'compact.result': control.compactResult(executor, message.requestId, message.state); return
      case 'collaboration.request': {
        const session = executor.run.session
        if (session === null) { send(executor, { t: 'collaboration.reply', requestId: message.requestId, reply: { ok: false, reason: '执行身份尚未绑定' } }); return }
        void collaboration.request(session, message.request).then(reply => {
          send(executor, { t: 'collaboration.reply', requestId: message.requestId, reply })
        })
        return
      }
      case 'collaboration.configured':
        control.configured(executor, message)
        return
      case 'collaboration.changed':
        collaboration.changed()
        return
      case 'assembled':
        if (message.session !== null && store.hasSession(message.session)) executor.run.session = message.session
        executor.run.workspace = message.workspace
        executor.run.everConnected = true
        executor.run.connected = true
        refresh(executor.run, now())
        ctx.saveRuns(true)
        ctx.pushRuns()
        return
      case 'ready': {
        control.ready(executor)
        executor.run.ready = true
        // 起来那一刻「正在起执行者」这件事就完了（那一格由 `actionOf` 之外的一处写，
        // 故在这儿清）——`busy` 不动：它说的是**内核**手上有活没有，与本跳无关
        executor.run.action = undefined
        refresh(executor.run, now())
        const queued = executor.queued
        executor.queued = []
        for (const one of queued) {
          if (executor.run.ended !== undefined) break
          executor.link.send(one)
        }
        ctx.saveRuns()
        ctx.pushRuns()
        return
      }
      case 'bound':
        if (!store.hasSession(message.session)) return
        executor.run.session = message.session
        connections.syncTarget(executor)
        ctx.bindEnvironment(executor, message.session)
        refresh(executor.run, now())
        ctx.saveRuns(true)
        ctx.pushRuns()
        return
      case 'settings.synced': {
        diagnosticLog.write(message.error ? 'warn' : 'debug', 'settings.ack', { ...identity, request: message.request, run: String(executor.gen) })
        control.synced(executor, message)
        return
      }
      case 'ev':
        onEvent(executor, message.event)
        return
      case 'done':
        if (!executor.run.ready) {
          for (const conn of connections.watching(executor)) conn.link.send({ t: 'line', text: message.why })
        }
        // **自己受理了收摊**——记成「停止中」，核销等进程真退（见 `retire`）
        markStopping(executor, message.why)
        return
      case 'stopping':
        markStopping(executor, message.why)
        return
      case 'snapshot':
        connections.onSnapshot(executor, message.seq, message.snapshot)
        return
      case 'sudo.request': {
        // 同一 requestId 只认一次；没有窗口看着这一代就当场取消（命令不启动）。
        if (sudoRequests.has(message.requestId)) return
        sudoRequests.set(message.requestId, { executor, command: message.command })
        const watchers = connections.watching(executor)
        if (watchers.length === 0) {
          ctx.cancelSudo(message.requestId, executor)
          return
        }
        for (const conn of watchers) {
          conn.link.send({ t: 'sudo.request', requestId: message.requestId, command: message.command })
        }
        return
      }
      case 'sudo.cancel':
        ctx.cancelSudo(message.requestId, executor)
        return
      default:
        return
    }
  }

  /** 一条内核事件——**广播给盯着这一代的窗口**，顺带把登记里那几格更新到与内核一致。 */
  function onEvent(executor: Executor, event: KernelEvent): void {
    diagnosticLog.write(event.kind === 'error' ? 'error' : 'trace', `kernel.${event.kind}`, { ...identity, run: String(executor.gen), ...(event.session ? { session: event.session } : {}) })
    if (event.kind === 'background.state') {
      executor.run.backgroundView = event.data
      refresh(executor.run, now())
      ctx.pushRuns()
      for (const conn of clients.values()) if (conn.selectedSession !== null && workRoot(conn.selectedSession) === workRoot(event.session)) ctx.publishBackground(conn, event.data.result)
      return
    }
    if (event.kind === 'mcp.catalog') control.observe(executor, event.data.servers)
    if (event.kind === 'input.settled' && event.data.ref !== undefined) {
      const owner = collaborationInputs.get(event.data.ref)
      if (owner !== undefined) {
        if (event.data.stage !== 'accepted') collaborationInputs.delete(event.data.ref)
        const { ref: _transportRef, ...settled } = event.data
        owner.conn.link.send({
          t: 'ev', gen: owner.conn.target?.gen ?? null, event: {
            ...event, data: { ...settled, ...(owner.ref === undefined ? {} : { ref: owner.ref }) },
          }
        })
        owner.conn.link.send({ t: 'ev', gen: null, event: { session: owner.target, id: 0, at: now(), turn: null, kind: 'input.pending', data: { inputs: pendingViews(store.serviceFor(owner.target).inputs.list()) } } })
        return
      }
    }
    const run = executor.run
    const previousSession = run.session
    const at = now()

    // 会话从事件里认（这就是 `bound` 那条路的日常形态：首条消息一按下回车，
    // 事件就带上了真会话号）——**不另立一份「它现在在哪条会话」的真源**。
    if (event.kind === 'session.state') {
      const active = event.data.active
      run.session = active !== '' && store.hasSession(active) ? active : null
      // 查询/配置动作可能产生临时信封；它不是可恢复的持久会话。
      event = { ...event, session: run.session ?? '', data: { ...event.data, active: run.session ?? '' } }
    } else if (run.session === null && event.session !== '' && store.hasSession(event.session)) {
      run.session = event.session
    }
    connections.syncTarget(executor)
    ctx.bindEnvironment(executor, run.session)

    if (run.session !== previousSession) ctx.saveRuns(true)

    switch (event.kind) {
      case 'agent.state':
        run.busy = event.data.state !== 'waiting'
        if (!run.busy && stopContent.get(run)?.stop !== undefined) queueMicrotask(() => { void ctx.notifyStop(run, stopContent.get(run)!.stop!).catch(error => options.log?.(String(error))) })
        break
      case 'turn.start':
        stopContent.set(run, {})
        if (run.session !== null) ctx.clearTurnNotice(run.session)
        stopGenerations.set(run, ctx.nextStopGeneration++)
        run.turnActive = true
        break
      case 'message.assistant':
        stopContent.set(run, { ...stopContent.get(run), entry: event.data.entry })
        break
      case 'error':
        stopContent.set(run, { ...stopContent.get(run), event: event.id, error: event.data.message })
        break
      case 'model.error':
        if (event.data.tier !== 'transient') stopContent.set(run, { ...stopContent.get(run), event: event.id, error: event.data.message })
        break
      case 'turn.end':
        stopContent.set(run, { ...stopContent.get(run), stop: event })
        run.turnActive = false
        run.lastTurn = event.data.reason
        run.lastTurnAt = event.at
        if (run.session !== null) {
          const current = store.attention.list({ sessions: [workRoot(run.session)] })[0]
          // 同一停点重放保留已读与送达事实；新一轮仍由 turn.start 清除旧原因。
          if (current?.source?.session !== event.session || current.fact !== String(event.id)) ctx.clearTurnNotice(run.session)
          if (!event.data.continues && (event.data.reason === 'settled' || event.data.reason === 'error')) queueMicrotask(() => { void ctx.notifyStop(run, event).catch(error => options.log?.(`当前原因读取失败：${String(error)}`)) })
        }
        break
      case 'tool.output.delta':
        run.output = { at, sample: tailOf(run.output?.sample, event.data.text) }
        break
      default:
        break
    }

    const action = actionOf(event)
    if (action !== undefined) run.action = action ?? undefined

    if (isProgress(event)) {
      const what = progressOf(event)
      if (what !== undefined) run.progress = { at, what }
    }

    refresh(run, at)

    connections.publish(executor, event)

    const shared = event.session === undefined ? undefined : store.collaboration.collaborationForSession(event.session)
    if (shared !== undefined && event.kind === 'turn.end' && event.data.reason === 'settled' && !event.data.continues) {
      void collaboration.settled(event.session!, event.turn).catch(error => options.log?.(`咨询回报尚未核实：${String(error)}`))
    }
    if (shared !== undefined && ((event.kind === 'turn.end' && event.data.reason === 'error') || event.kind === 'error')) {
      void collaboration.failed(event.session!, event.kind === 'error' ? event.data.message : '成员本轮执行失败，需要核对停点').catch(error => options.log?.(`失败回报尚未核实：${String(error)}`))
    }
    if (shared !== undefined && ['agent.state', 'turn.start', 'turn.end', 'tool.decision', 'message.assistant', 'message.user', 'model.usage'].includes(event.kind)) {
      collaboration.changed()
      if (event.kind === 'agent.state' && event.data.state === 'waiting') {
        void collaboration.idle(shared.originSessionId).then(closed => {
          if (closed) void ctx.notifyStop(run, event)
        }).catch(error => options.log?.(`协作收尾尚未核实：${String(error)}`))
      }
    }

    ctx.saveRuns()
    ctx.pushRuns()
  }

  function retire(executor: Executor, reason: string): void {
    if (executor.run.ended !== undefined) return
    for (const [requestId, request] of sudoRequests) {
      if (request.executor === executor) ctx.cancelSudo(requestId, executor)
    }
    for (const [key, owner] of collaborationInputs) if (owner.target === executor.run.session) {
      collaborationInputs.delete(key)
      owner.conn.link.send({
        t: 'ev', gen: owner.conn.target?.gen ?? null, event: {
          kind: 'input.settled', data: { ok: false, ...(owner.ref === undefined ? {} : { ref: owner.ref }), reason: '输入目标已退出，未确认接收；原稿保留' },
          session: owner.session, id: store.serviceFor(owner.session).nextId(), at: now(), turn: null,
        }
      })
    }
    control.retire(executor, reason)

    const at = now()
    const kind = executor.run.stopping
      ? // **收摊那一刻这一轮还开着**也算被打断（U50）：收尾那两跳可能抢在
      // `turn.end` 前面，光看 `lastTurn` 会把一次真停读成「当前空闲」
      endKindOf(executor.run.lastTurn, executor.run.turnActive)
      : executor.run.lastTurn === 'aborted'
        ? ('aborted' as const)
        : ('crashed' as const)

    executor.run.ended = { at, why: reason, kind }
    executor.run.reclaimPending = executor.run.owned.length > 0
    executor.run.connected = false
    executor.run.busy = false
    executor.run.turnActive = false
    executor.run.action = undefined
    refresh(executor.run, at)

    executors.delete(executor)
    executor.queued = []

    // **留一条「最近一次运行」**——列表上「当前/最近状态」那一格要它
    lastRuns.set(executor.run.session ?? executor.executionId, executor.run)

    connections.detach(executor, reason)
    executor.link.close()

    options.log?.(`核销第 ${executor.gen} 代执行者（${reason}）`)
    ctx.saveRuns()

    ctx.pushRuns(true)

    if (executor.run.ended?.kind === 'crashed' && executor.run.session !== null) {
      ctx.notify(
        executor.run.session,
        'failed',
        `${executor.gen}@${executor.run.ended.at}`,
        `异常退出：${reason}`,
      )
    }

    afterEnd(executor.run)
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
        collaboration.shutdown(why)
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
    const extension = Promise.all([compactions.close(), Promise.resolve().then(() => options.lifecycle?.shutdown())])
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
    store.close()
    options.log?.(`管理者收摊（${why}）`)
    diagnosticLog.write('info', 'manager.stopped', identity)
    await diagnosticLog.close()
    await options.beforeExit?.()
    ctx.settle()
  }

  ctx.workStopGeneration = workStopGeneration
  ctx.reportStop = reportStop
  ctx.startMember = startMember
  ctx.cancelMembers = cancelMembers
  ctx.markStopping = markStopping
  ctx.onExecutorMessage = onExecutorMessage
  ctx.onEvent = onEvent
  ctx.retire = retire
  ctx.afterEnd = afterEnd
  ctx.stop = stop
  ctx.beginStop = beginStop
  ctx.shutdown = shutdown
}
