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
  /** 启动时建立的进程内协议端点。 */
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
export function sendToExecutor(executor: Executor, message: ManagerToExecutor): void {
  if (executor.run.ended !== undefined) return
  if (!executor.run.ready) return
  if (!executor.link.send(message)) {
    executor.diagnostic('warn', message.t === 'collaboration.wake' ? 'wake.write-fail' : 'send.write-fail',
      { gen: executor.gen, session: executor.run.session, kind: message.t })
  }
}

/** 执行者协议的待确认请求；回执必须来自原对象，不能跨代完成。 */
export function createExecutorControl(onStartupTimeout: (executor: Executor) => void) {
  const compactions = new Map<string, { executor: Executor; started: () => void; resolve: (state: import('@magic/contracts').CompactState) => void; reject: (error: Error) => void }>()
  const configurationWaiters = new Map<string, { executor: Executor; resolve: () => void; reject: (error: Error) => void }>()
  const readyWaiters = new Map<number, { resolve: () => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const executorSettings = new WeakMap<Executor, readonly McpCatalogRow[]>()
  const settingsReplies = new Map<string, { executor: Executor; resolve: (note: string) => void; reject: (error: Error) => void }>()
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
        const abort = () => sendToExecutor(executor, { t: 'compact.cancel', requestId: request.requestId })
        compactions.set(request.requestId, { executor, started, resolve: state => { signal.removeEventListener('abort', abort); resolve(state) }, reject: error => { signal.removeEventListener('abort', abort); reject(error) } })
        signal.addEventListener('abort', abort, { once: true })
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
    },
    retire(executor: Executor, reason: string): void {
      for (const [id, pending] of configurationWaiters) if (pending.executor === executor) {
        configurationWaiters.delete(id)
        pending.reject(new Error('成员配置结果未确认，原持久配置保留'))
      }

      const ready = readyWaiters.get(executor.gen)
      if (ready !== undefined) {
        clearTimeout(ready.timer)
        readyWaiters.delete(executor.gen)
        ready.reject(new Error(reason))
      }
    },
  }
}
