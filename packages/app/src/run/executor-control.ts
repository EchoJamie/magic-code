import type { AgentModelConfig, Diagnostics, McpCatalogRow, ProcessLedger } from '@magic/contracts'
import type { WorkEnvironment } from '../work-environment.ts'
import type { RunRecord } from './facts.ts'
import type { SpawnedExecutor } from './launch.ts'
import type { ExecutorToManager, Link, ManagerToExecutor } from './wire.ts'

export type Executor = {
  readonly ledger: ProcessLedger
  readonly network: WorkEnvironment
  /** 管理者分配的执行代次，后继代不会复用。 */
  readonly gen: number
  /** 发车时给的令牌——认「这条连上来的是我叫起来的那一个」。 */
  readonly executionId: string
  /** 运行事实的唯一来源。 */
  readonly run: RunRecord
  readonly spawned: SpawnedExecutor
  exited: boolean
  /** 启动时建立的进程内协议端点；就绪前的命令仍须排队。 */
  readonly link: Link<ExecutorToManager>
  /** 还没送出去的东西（**先攒后送**：没人接的话发出去就是「敲了没反应」）。 */
  queued: ManagerToExecutor[]

}

export function sendToExecutor(executor: Executor, message: ManagerToExecutor): void {
  if (executor.run.ended !== undefined) return

  if (!executor.run.ready) {
    executor.queued.push(message)
    return
  }
  executor.link.send(message)
}

/** 执行者协议的待确认请求；回执必须来自原对象，不能跨代完成。 */
export function createExecutorControl(onStartupTimeout: (executor: Executor) => void) {
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
