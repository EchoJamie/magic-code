import type { AgentModelConfig, Diagnostics, McpCatalogRow, ProcessLedger } from '@magic/contracts'
import type { WorkEnvironment, RunRecord } from '@magic/host'
import type { ExecutorSpawned } from './launch.ts'
import type { ExecutorToManager, Link, ManagerToExecutor } from '@magic/host'

export type Executor = {
  readonly ledger: ProcessLedger
  readonly network: WorkEnvironment
  /** 管理者分配的执行代次，后继代不会复用。 */
  readonly gen: number
  /** 发车时给的令牌——认「这条连上来的是我叫起来的那一个」。 */
  readonly executionId: string
  /** 运行事实的唯一来源。 */
  readonly run: RunRecord
  readonly spawned: ExecutorSpawned
  exited: boolean
  /** 当前**写连接**（T1.6 · N5）：第一个绑定它的窗口；写者断开释放，后来者接管写位。 */
  writerConn?: number
  readonly link: Link<ExecutorToManager>
  /** 诊断留痕（T1.5：manager DiagnosticLog 的定向计数通道；发送失败/超时类在此分计）。 */
  readonly diagnostic: (level: 'debug' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void
  /**
   * **最后已知活跃时刻**（T1.2 心跳租约）——收到 `heartbeat` 或 `ev` 帧即刷新；
   * 对账器据它判「executing 超 15s（3 心跳）无进展」→ failed。缺省＝还没有过心跳（不判死）。
   */
  lastSeenAt?: number
  /** 上次补发消费信号的时刻（对账器补发 wake 的去抖）。 */
  lastWakeAt?: number
}

/**
 * 发送。**ready 前一律不发**（T1.2 送达链重构）：待办已落账（受理前移），帧只是
 * 加速信号——ready 后由 ready 处理与对账器补发消费信号，执行者从账本捞待办。
 * 连接层未绑定（子进程未连回）同样不发；有回执的请求（settings/compact）由各自
 * 超时兜底给「未确认」与出路（N22）。
 * 发送失败（通道拒收）按帧类分计（T1.5）：wake 用 `wake.write-fail`，其余 `send.write-fail`。
 */
/**
 * 发送。**ready 前一律不发**（T1.2 送达链重构）：待办已落账（受理前移），帧只是
 * 加速信号——ready 后由 ready 处理与对账器补发消费信号，执行者从账本捞待办。
 * 连接层未绑定（子进程未连回）同样不发；有回执的请求（settings/compact）由各自
 * 超时兜底给「未确认」与出路（N22）。
 *
 * ⚠️ **snapshot 是例外**（T4 回归根因）：bind 的快照握手等的就是这一帧的回执——
 * ready 门把它丢了，连接的 `awaiting` 永卡，执行者的事件流全部停在缓冲里，窗口
 * 收到的只剩旁路（pushRuns/notice/detached）——「提交中」卡死、回复永不渲染。
 * ready 前的快照＝空水位（fresh 执行器还没消费任何东西），与 bind 的时序语义一致；
 * 重绑到运行中的执行器时它已 ready，不走这条例外。
 * 发送失败（通道拒收）按帧类分计（T1.5）：wake 用 `wake.write-fail`，其余 `send.write-fail`。
 */
export function sendToExecutor(executor: Executor, message: ManagerToExecutor): void {
  if (executor.run.ended !== undefined) return
  if (!executor.run.ready && message.t !== 'snapshot') return
  if (!executor.link.send(message)) {
    executor.diagnostic('warn', message.t === 'collaboration.wake' ? 'wake.write-fail' : 'send.write-fail',
      { gen: executor.gen, session: executor.run.session, kind: message.t })
  }
}

/** 执行者协议的待确认请求；回执必须来自原对象，不能跨代完成。 */
export function createExecutorControl(onStartupTimeout: (executor: Executor) => void) {
  const compactions = new Map<string, { executor: Executor; started: () => void; resolve: (state: import('@magic/contracts').CompactState) => void; reject: (error: Error) => void }>()
  /** ready 闸门前送达会被丢弃的压缩请求——按代排队，ready 时刻补发。 */
  const pendingCompacts = new Map<number, { request: { requestId: string; focus?: string }; signal: AbortSignal; started: () => void }[]>()
  /** ready 闸门前送达会被丢弃的换模请求——按代排队，ready 时刻补发（P1 修复：此前既不排队
   * 也无超时，配置悬到 retire 才落定；常规路径 startMember 先等 ready，缺口只在竞态窗口）。 */
  const pendingConfigures = new Map<number, { requestId: string; model: AgentModelConfig }[]>()
  const configurationWaiters = new Map<string, { executor: Executor; resolve: () => void; reject: (error: Error) => void }>()
  const readyWaiters = new Map<number, { resolve: () => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const executorSettings = new WeakMap<Executor, readonly McpCatalogRow[]>()
  const settingsReplies = new Map<string, { executor: Executor; resolve: (note: string) => void; reject: (error: Error) => void }>()

  /** 执行者退出/收代：ready 前排队的请求**就地落定**，队列条目清掉——不再悬挂、不再累积。 */
  function dropQueuedPreReady(executor: Executor, note: string): void {
    const queuedCompacts = pendingCompacts.get(executor.gen)
    if (queuedCompacts !== undefined) {
      pendingCompacts.delete(executor.gen)
      for (const item of queuedCompacts) {
        const pending = compactions.get(item.request.requestId)
        if (pending?.executor === executor) { compactions.delete(item.request.requestId); pending.reject(new Error(`${note}，本次压缩中断`)) }
      }
    }
    pendingConfigures.delete(executor.gen)
  }
  function settingsToExecutor(executor: Executor, server?: string, inspect = false, diagnostics?: Diagnostics): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = crypto.randomUUID()
      const timeout = setTimeout(() => {
        settingsReplies.delete(request)
        reject(new Error('执行者未确认设置受理，请重新读取当前事实'))
      }, diagnostics ? 5_000 : 30_000)
      settingsReplies.set(request, {
        executor,
        resolve: note => { clearTimeout(timeout); resolve(note) },
        reject: error => { clearTimeout(timeout); reject(error) },
      })
      const message: ManagerToExecutor = diagnostics
        ? { t: 'diagnostics.sync', request, value: diagnostics }
        : inspect
          ? { t: 'settings.inspect', request }
          : server === undefined
            ? { t: 'settings.sync', request }
            : { t: 'settings.reconnect', request, server }
      sendToExecutor(executor, message)
    })
  }

  function waitUntilReady(executor: Executor): Promise<void> {
    return new Promise((resolve, reject) => {
      const previous = readyWaiters.get(executor.gen)
      if (previous !== undefined) {
        const done = previous.resolve
        const failed = previous.reject
        previous.resolve = () => { done(); resolve() }
        previous.reject = reason => { failed(reason); reject(reason) }
        return
      }
      const timer = setTimeout(() => {
        readyWaiters.delete(executor.gen)
        onStartupTimeout(executor)
        reject(new Error('成员启动未就绪，正在回收'))
      }, 30_000)
      readyWaiters.set(executor.gen, { resolve, reject, timer })
    })
  }

  return {
    compact(executor: Executor, request: { requestId: string; focus?: string }, signal: AbortSignal, started: () => void): Promise<import('@magic/contracts').CompactState> {
      signal.throwIfAborted()
      return new Promise((resolve, reject) => {
        const abort = () => {
          // **还没送出就撤销**（ready 前排队的那一档）：帧没有在途的收口——就地落定，
          // 不再等一个不会来的 compact.result。
          const queue = pendingCompacts.get(executor.gen)
          const at = queue?.findIndex(item => item.request.requestId === request.requestId) ?? -1
          if (queue !== undefined && at >= 0) {
            queue.splice(at, 1)
            if (queue.length === 0) pendingCompacts.delete(executor.gen)
            const pending = compactions.get(request.requestId)
            if (pending?.executor === executor) pending.resolve({ requestId: request.requestId, state: 'cancelled', reason: '执行者就绪前撤销' })
            return
          }
          sendToExecutor(executor, { t: 'compact.cancel', requestId: request.requestId })
        }
        compactions.set(request.requestId, { executor, started, resolve: state => { signal.removeEventListener('abort', abort); resolve(state) }, reject: error => { signal.removeEventListener('abort', abort); reject(error) } })
        signal.addEventListener('abort', abort, { once: true })
        if (!executor.run.ready) {
          // ready 闸门会丢这一帧——排队，ready 时刻补发（撤销走同一 abort）。
          const queue = pendingCompacts.get(executor.gen) ?? []
          queue.push({ request, signal, started })
          pendingCompacts.set(executor.gen, queue)
          return
        }
        sendToExecutor(executor, { t: 'compact', request })
      })
    },
    compactStarted(executor: Executor, requestId: string): void { const operation = compactions.get(requestId); if (operation?.executor === executor) operation.started() },
    compactResult(executor: Executor, requestId: string, state: import('@magic/contracts').CompactState): void {
      const operation = compactions.get(requestId)
      if (operation?.executor !== executor) return
      compactions.delete(requestId); operation.resolve(state)
    },
    waitUntilReady,
    settings: settingsToExecutor,
    servers: (executor: Executor) => executorSettings.get(executor),
    observe: (executor: Executor, servers: readonly McpCatalogRow[]) => executorSettings.set(executor, servers),
    configure(executor: Executor, model: AgentModelConfig): Promise<void> {
      return new Promise((resolve, reject) => {
        const requestId = crypto.randomUUID()
        configurationWaiters.set(requestId, { executor, resolve, reject })
        if (!executor.run.ready) {
          // ready 闸门会丢这一帧——排队，ready 时刻补发；退出/收代在 dropQueuedPreReady 落定。
          const queue = pendingConfigures.get(executor.gen) ?? []
          queue.push({ requestId, model })
          pendingConfigures.set(executor.gen, queue)
          return
        }
        sendToExecutor(executor, { t: 'collaboration.configure', requestId, model })
      })
    },
    configured(executor: Executor, message: Extract<ExecutorToManager, { t: 'collaboration.configured' }>): void {
      const pending = configurationWaiters.get(message.requestId)
      if (pending?.executor !== executor) return
      configurationWaiters.delete(message.requestId)
      if (message.result.ok) pending.resolve()
      else pending.reject(new Error(message.result.reason))
    },
    ready(executor: Executor): void {
      const waiting = readyWaiters.get(executor.gen)
      if (waiting !== undefined) {
        clearTimeout(waiting.timer)
        readyWaiters.delete(executor.gen)
        waiting.resolve()
      }
      // ready 闸门（sendToExecutor 丢弃非 snapshot 帧）的补发口：排队中的压缩与换模此刻放行。
      const queued = pendingCompacts.get(executor.gen)
      if (queued !== undefined) {
        pendingCompacts.delete(executor.gen)
        for (const item of queued) {
          if (item.signal.aborted) continue
          sendToExecutor(executor, { t: 'compact', request: item.request })
        }
      }
      const queuedConfigures = pendingConfigures.get(executor.gen)
      if (queuedConfigures !== undefined) {
        pendingConfigures.delete(executor.gen)
        for (const item of queuedConfigures) sendToExecutor(executor, { t: 'collaboration.configure', requestId: item.requestId, model: item.model })
      }
    },
    synced(executor: Executor, message: Extract<ExecutorToManager, { t: 'settings.synced' }>): void {
      executorSettings.set(executor, message.mcp)
      const pending = settingsReplies.get(message.request)
      if (pending?.executor !== executor) return
      settingsReplies.delete(message.request)
      if (message.error !== undefined) pending.reject(new Error(message.error))
      else pending.resolve(message.note ?? '已受理设置')
    },
    exited(executor: Executor): void {
      for (const [id, operation] of compactions) if (operation.executor === executor) { compactions.delete(id); operation.reject(new Error('执行实例已结束，本次压缩中断')) }
      for (const [request, pending] of settingsReplies) if (pending.executor === executor) {
        settingsReplies.delete(request)
        pending.reject(new Error('执行者已退出，设置受理未确认；请重新读取'))
      }
      dropQueuedPreReady(executor, '执行实例已结束')
    },
    retire(executor: Executor, reason: string): void {
      for (const [id, pending] of configurationWaiters) if (pending.executor === executor) {
        configurationWaiters.delete(id)
        pending.reject(new Error('成员配置结果未确认，原持久配置保留'))
      }
      dropQueuedPreReady(executor, reason)

      const ready = readyWaiters.get(executor.gen)
      if (ready !== undefined) {
        clearTimeout(ready.timer)
        readyWaiters.delete(executor.gen)
        ready.reject(new Error(reason))
      }
    },
  }
}
