/**
 * 进程内 state 订阅——按配置文件路径登记；写入成功后通知一次。
 *
 * 跨进程（TUI 与引擎是两条进程）的订阅不在这里：那走会话面命令/事件。
 * 本模块只解决「同一进程里，装配读的是同一份 state，不要各自缓存一份」。
 */
export type StateListener = (revision: number) => void

const listeners = new Map<string, Set<StateListener>>()

export function subscribeState(path: string, listener: StateListener): () => void {
  const set = listeners.get(path) ?? new Set<StateListener>()
  set.add(listener)
  listeners.set(path, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(path)
  }
}

/** 通知一次（写入成功后调；同一 revision 一次）。 */
export function notifyState(path: string, revision: number): void {
  for (const listener of listeners.get(path) ?? []) {
    try {
      listener(revision)
    } catch {
      // 订阅者坏了不拖垮写入；下一轮读取仍会拿到新值。
    }
  }
}
