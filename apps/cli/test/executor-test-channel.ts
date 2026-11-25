/** **测试专用**的进程内执行者通道——生产代码不许 import 本文件（import-guard 的测试层锚保证）。
 *
 * 这里住着两件从生产面清退的轻量设施：
 * - `localLinks`：内存里两个对口子，send 入队、宏任务拍派发（与跨进程 socket 同投递语义）。
 * - `createAgentLauncher`：不起子进程、直接在 manager 进程内跑完整装配的 launcher——
 *   测试要真装配但不要真进程时的替身。
 *
 * 真实引擎的执行者一律独立子进程（`createProcessLauncher`）；生产代码里不存在同进程形态。
 */
import type { ExecutorSpawn, ExecutorSpawned, ExecutorLauncher, ExecutorToManager, ManagerToExecutor, Wire, Link } from '@magic/host'
import { runExecutor } from '@magic/host'

/** Engine 内部通道，不建立 socket、生命握手或心跳。 */
export function localLinks<A extends Wire, B extends Wire>(): [Link<A>, Link<B>] {
  let closed = false
  const listeners: ((message: Wire) => void)[][] = [[], []]
  const closers: (() => void)[] = []
  // **投递与发送解耦**——send 只入队，宏任务拍整批派发。跨进程 socket 的投递本来
  // 就是这个语义（写帧即返回，对端自己消费）；同步直呼会让发送方调用栈被接收方
  // 嵌套驱动——同批受理曾在受理栈未返回时同步重入执行者的首次消费，惰性流死锁。
  // 异步性收在这一处结构里，各调用点不再自行防重入；handler 内再 send 的帧留给
  // 下一拍（与 socket 语义一致），派发前的 close 丢弃未投递帧。
  const pending: { side: number; message: Wire }[] = []
  let flushScheduled = false
  const flush = (): void => {
    flushScheduled = false
    for (const { side, message } of pending.splice(0)) {
      // 已入队的帧照常送达——close 只挡**新**发送，与 socket 的缓冲语义一致
      //（装配失败的 assembled/done 就靠这一跳在 close 前落进队列）。
      for (const listener of [...listeners[side]!]) listener(message)
    }
  }
  const endpoint = (side: number): Link => ({
    get closed() { return closed },
    send(message) {
      if (closed) return false
      pending.push({ side: 1 - side, message })
      if (!flushScheduled) { flushScheduled = true; setImmediate(flush) }
      return true
    },
    onMessage(listener) { listeners[side]!.push(listener) },
    onClose(listener) { if (closed) listener(); else closers.push(listener) },
    close() {
      if (closed) return
      closed = true
      flush()
      for (const listener of closers.splice(0)) listener()
      listeners[0] = []; listeners[1] = []
    },
  })
  return [endpoint(0) as Link<A>, endpoint(1) as Link<B>]
}

/** Agent 是 Engine 内的异步实例；取消与完成只作用于本次运行。**仅测试使用**。 */
export function createAgentLauncher(): ExecutorLauncher {
  return {
    spawn(request: ExecutorSpawn): ExecutorSpawned {
      const controller = new AbortController()
      const [link, agentLink] = localLinks<ExecutorToManager, ManagerToExecutor>()
      const done = Promise.resolve().then(() => runExecutor({
        ...request,
        link: agentLink,
        signal: controller.signal,
      }))
        .then(outcome => outcome.kind === 'ok' ? '执行实例已释放' : outcome.reason,
          error => `执行实例失败：${error instanceof Error ? error.message : String(error)}`)
      return {
        link,
        onExit(listener) { void done.then(listener) },
        cancel() { controller.abort() },
      }
    },
  }
}
