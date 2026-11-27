import type { Command } from '@magic/contracts'
import { ARCHIVED_NOTE, createWorkEnvironment } from '@magic/host'
import { createProcessLedger } from '@magic/resources'
import { newRunRecord, refresh } from '@magic/host'
import type { ExecutorSpawned } from '../launch.ts'
import { sendToExecutor as send, type Executor } from '../executor-control.ts'
import type { ClientConn } from '../connections.ts'
import type { ManagerContext, SpawnInput } from './context.ts'

/** 执行者的放置、环境归属与送达；身份登记发生在发车那一刻。 */
export function installPlacement(ctx: ManagerContext): void {
  const { options, now, store, executors, lastRuns, environments, closingEnvironments, connections, sessions, diagnosticLog, identity } = ctx
  const { workRoot, isArchived } = sessions

  function environmentFor(session: string): import('@magic/host').WorkEnvironment | undefined {
    return environments.get(workRoot(session))
  }

  function releaseEnvironments(): void {
    for (const [root, network] of environments) {
      if ([...executors].some(one => one.network === network)) continue
      const work = store.collaboration.collaborationForSession(root)
      if (work?.state === 'open' || work?.state === 'closing') continue
      if ([...lastRuns.values()].some(run => run.session !== null && workRoot(run.session) === root && (run.owned.length > 0 || run.reclaimPending))) continue
      environments.delete(root)
      const closing = network.close()
      closingEnvironments.add(closing)
      void closing.then(() => closingEnvironments.delete(closing), error => options.log?.(`工作网络连接尚未收妥：${String(error)}`))
    }
  }

  function liveOf(session: string): Executor | undefined {
    for (const one of executors) {
      if (one.run.ended === undefined && one.run.session === session) return one
    }
    return undefined
  }

  /** 起一个还没开张的执行者——**窗口的第一条命令**走它（空白启动页此时才有进程）。 */
  /**
   * 起一代**还没有会话**的执行者。
   *
   * `model` 是**这一条交代带来的**窗口选择（`UserInput.model`）——优先于连接上记的开局请求：
   * 用户刚在窗口里切过模型，第一条消息就该走它，而不是回头读启动时那份。
   */
  function spawnFresh(conn: ClientConn, model?: import('@magic/contracts').ModelSwitchRequest): Executor | undefined {
    const choice = model ?? conn.switch
    const spawned = spawn({
      session: null,
      explicit: false,
      environment: conn.environment,
      cwd: conn.cwd,
      ...(choice === undefined ? {} : { switch: choice }),
    })
    if (spawned !== undefined) connections.bind(conn, spawned)
    return spawned
  }

  /** 真起一个——登记在**发车那一刻**（不是等它连上来）：两个窗口同时要同一条会话时，
   *  第二个必须**当场**看得见第一个，否则会各起一个。 */
  function spawn(input: SpawnInput): Executor | undefined {
    if (input.session !== null && isArchived(input.session)) return undefined
    // **单活结构保证**（T1.6 · N5）：同会话已有**活**执行器 → 拒绝第二个
    // （普通会话补齐；协作成员另由 beginExecution 准入拦一层）。
    // ⚠️ 只拦活进程（exited=false 且未 ended）：「已自动收缩退场、核销未完成」的旧代
    // **让位**——新 spawn 接管会话（consumeLedgerInputs 按会话捞账本 pending，天然接管
    // 旧代遗留待办；旧代核销照常异步完成）。把「已退出未核销」也拦下 = P1 破
    // （这条已受理的输入永远无人消费——对账器只扫活执行者集合）。
    if (input.session !== null) {
      const duplicate = [...executors].find(one => one.run.session === input.session
        && one.run.ended === undefined && !one.exited)
      if (duplicate !== undefined) {
        diagnosticLog.write('warn', 'spawn.duplicate', { ...identity, session: input.session, run: String(duplicate.gen) })
        return undefined
      }
    }
    const root = input.session === null ? undefined : workRoot(input.session)
    let network: import('@magic/host').WorkEnvironment
    try { network = (root === undefined ? undefined : environments.get(root)) ?? createWorkEnvironment(input.environment ?? {}) }
    catch (error) { options.log?.(`工作网络配置不可用：${String(error)}`); return undefined }
    const gen = ctx.nextGen
    ctx.nextGen += 1
    const executionId = `${gen}-${crypto.randomUUID()}`
    const ledger = createProcessLedger(owned => {
      executor.run.owned = owned
      refresh(executor.run, now())
      ctx.saveRuns(true)
      ctx.pushRuns()
    })
    let spawned: ExecutorSpawned
    try {
      spawned = options.launch.spawn({
        gen, executionId, socket: ctx.paths.socket, network, environment: network.env,
        session: input.session, cwd: input.cwd, magic: options.magic,
        records: store, ledger,
        ...(input.switch === undefined ? {} : { switch: input.switch }),
      })
    } catch (error) {
      options.log?.(`装配 Agent 不成：${String(error)}`)
      if (![...environments.values()].includes(network)) {
        const closing = network.close()
        closingEnvironments.add(closing)
        void closing.then(() => closingEnvironments.delete(closing), error => options.log?.(String(error)))
      }
      return undefined
    }
    const link = spawned.link

    const executor: Executor = {
      ledger, network,
      gen,
      executionId,
      run: newRunRecord({
        gen,
        executionId,
        session: input.session,
        startedAt: now(),
        explicit: input.explicit,
      }),
      spawned,
      exited: false,
      link,
      diagnostic: (level, event, data) => diagnosticLog.write(level, event, { ...identity, run: String(gen), ...(data ?? {}) }),
    }

    environments.set(root ?? executionId, network)
    executors.add(executor)
    const failed = (error: unknown) => {
      executor.run.stopping = true
      executor.run.reclaimNote = `工作记录处理失败：${String(error)}`
      for (const conn of connections.watching(executor)) conn.link.send({ t: 'line', text: executor.run.reclaimNote })
      executor.spawned.cancel()
      diagnosticLog.write('error', 'executor.record.failed', { ...identity, run: String(gen) })
    }
    link.onMessage(message => { try { ctx.onExecutorMessage(executor, message) } catch (error) { options.log?.(`[failed] ${String(error)} @${message.t} ${JSON.stringify(message).slice(0, 200)}`); failed(error) } })

    spawned.onExit((reason) => {
      executor.exited = true
      ctx.control.exited(executor)
      try { ctx.retire(executor, reason) } catch (error) { failed(error) }
    })

    diagnosticLog.write('info', 'executor.started', { ...identity, run: String(gen), ...(input.session === null ? {} : { session: input.session }) })
    options.log?.(`起了执行者 第 ${gen} 代 会话=${input.session ?? '（还没开张）'}`)
    try { ctx.saveRuns(true) } catch (error) { failed(error); return undefined }
    ctx.pushRuns()
    return executor
  }

  /** 接回已有会话；查看历史不触发执行，明确输入才启动下一代。 */
  function retarget(conn: ClientConn, session: string): void {
    if (isArchived(session)) { conn.link.send({ t: 'line', text: ARCHIVED_NOTE }); return }
    if (!store.hasSession(session)) {
      conn.link.send({ t: 'line', text: '该会话已不可达，未切换当前工作。' })
      return
    }
    const live = liveOf(session)
    if (live !== undefined) {
      connections.bind(conn, live)
      void ctx.catalog(conn).then(() => ctx.readHistory(conn, session)).then(() => ctx.publishCollaboration(conn))
      return
    }

    connections.selectSession(conn, session)
    void ctx.catalog(conn).then(() => ctx.readHistory(conn, session)).then(() => ctx.publishCollaboration(conn))
  }

  function bindEnvironment(executor: Executor, session: string | null): void {
    if (session === null) return
    environments.delete(executor.executionId)
    environments.set(workRoot(session), executor.network)

  }

  /** 送一条**命令**——`send` 的那一层皮（读起来仍是「送一条命令」）。 */
  function deliver(executor: Executor, command: Command): void {
    // 旧菜单观察到的责任在下一次输入受理时失效，即使复用同一执行者也不能误停下一轮。
    if (command.type === 'input.submit' || (command.type === 'input.manage' && command.action === 'continue')) {
      executor.run.busy = true
      refresh(executor.run, now())
      ctx.stopGenerations.set(executor.run, ctx.nextStopGeneration++)
      if (executor.run.session !== null) ctx.clearTurnNotice(executor.run.session)
    }
    if (command.type === 'turn.interrupt' && executor.run.session !== null) ctx.clearTurnNotice(executor.run.session)
    send(executor, { t: 'cmd', cmd: command })
  }

  ctx.releaseEnvironments = releaseEnvironments
  ctx.environmentFor = environmentFor
  ctx.liveOf = liveOf
  ctx.spawnFresh = spawnFresh
  ctx.spawn = spawn
  ctx.retarget = retarget
  ctx.bindEnvironment = bindEnvironment
  ctx.deliver = deliver
}
