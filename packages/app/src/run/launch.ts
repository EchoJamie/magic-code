import type { ExecutorLauncher, ExecutorRequest, SpawnedExecutor } from './manager.ts'
import { runExecutor } from './executor.ts'

/** Agent 是 Engine 内的异步实例；取消与完成只作用于本次运行。 */
export function createAgentLauncher(): ExecutorLauncher {
  return {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      const controller = new AbortController()
      const done = Promise.resolve().then(() => runExecutor({ ...request, signal: controller.signal }))
        .then(outcome => outcome.kind === 'ok' ? '执行实例已释放' : outcome.reason,
          error => `执行实例失败：${error instanceof Error ? error.message : String(error)}`)
      return {
        onExit(listener) { void done.then(listener) },
        cancel() { controller.abort() },
      }
    },
  }
}
