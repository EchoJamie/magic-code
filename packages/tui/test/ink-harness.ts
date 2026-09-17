/**
 * 活体渲染夹具（U09 · 测试面）——把 Ink 跑在假终端上。
 *
 * 为什么自持而不用现成的：外壳的交互（打字 / 答复 / Ctrl+C）要**真按键**才测得到，
 * 而 `renderToString` 是同步一次成像（`useInput` 退化成空操作）。夹具给 Ink 一对假
 * stdin / stdout：`debug: true` 下 Ink 每帧整块写出，于是「最近一帧」＝最后一块。
 *
 * 与 `ink-testing-library` 同法（都对 Ink 用 `debug` ＋ 假流），但**自持**：
 * 少一个外部依赖，且断言面按本单元需要收（等帧 / 按键 / 退出）。
 */

import { EventEmitter } from 'node:events'
import { render } from 'ink'
import type { Instance } from 'ink'
import type { ReactNode } from 'react'

/** 假 stdout——Ink 只用 `write` / `columns` / `isTTY` / `destroyed` / `writableEnded`。 */
class FakeStdout extends EventEmitter {
  readonly columns: number
  readonly rows = 24
  readonly isTTY = false
  readonly destroyed = false
  readonly writableEnded = false
  /** 每帧一整块（`debug: true`）。 */
  readonly frames: string[] = []

  constructor(columns: number) {
    super()
    this.columns = columns
  }

  write = (chunk: string): boolean => {
    this.frames.push(chunk)
    return true
  }
}

/** 假 stdin——按 `readable` 事件供数据（Ink 逐块 `read()` 到 null）。 */
class FakeStdin extends EventEmitter {
  readonly isTTY = true
  private queue: string[] = []

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => this.queue.shift() ?? null

  /** 敲一串键（模拟终端数据到达）。 */
  type(data: string): void {
    this.queue.push(data)
    this.emit('readable')
  }
}

export type Harness = {
  /**
   * 敲键（`\r` 回车 · `\x03` Ctrl+C · `y` / `n` 答复）。
   *
   * **是异步的**：Ink 在 effect 里才接管 stdin（挂 `readable` 监听），首帧写出时那一步
   * 未必已跑完——早按的键会**静默丢掉**（实测踩过）。故敲键前先等监听挂上。
   */
  type(data: string): Promise<void>
  /** 最近一帧（还没渲染过则为空串）。 */
  frame(): string
  /** 等一帧满足条件（超时抛——时间给了，还是没等到就是真没渲染出来）。 */
  waitForFrame(predicate: (frame: string) => boolean, label?: string): Promise<string>
  /** 等进程退出（Ink 的 `exit()`）。 */
  waitForExit(): Promise<void>
  /** 收摊。 */
  unmount(): void
}

const POLL_MS = 5
const TIMEOUT_MS = 2000

export function renderTui(node: ReactNode, options: { readonly columns?: number } = {}): Harness {
  const stdout = new FakeStdout(options.columns ?? 80)
  const stdin = new FakeStdin()

  const instance: Instance = render(node, {
    // 类型上要 NodeJS.WriteStream/ReadStream——假流只实现 Ink 真正用到的那几个成员
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    // Ctrl+C 由外壳自己解（空闲退出 / 工作中中断）——Ink 不许抢
    exitOnCtrlC: false,
    patchConsole: false,
  })

  const frame = (): string => stdout.frames[stdout.frames.length - 1] ?? ''

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** 等 Ink 真正接管 stdin——child effect（`useInput`）先于 App 的 effect（挂 `readable`），
   *  故 `readable` 在监听上，两个都就位了。 */
  const ready = async (): Promise<void> => {
    const deadline = Date.now() + TIMEOUT_MS

    while (Date.now() < deadline) {
      if (stdin.listenerCount('readable') > 0) return
      await sleep(POLL_MS)
    }

    throw new Error('Ink 未接管 stdin——`readable` 监听没挂上')
  }

  return {
    type: async (data) => {
      await ready()
      stdin.type(data)
    },
    frame,

    waitForFrame: async (predicate, label) => {
      const deadline = Date.now() + TIMEOUT_MS

      while (Date.now() < deadline) {
        const current = frame()
        if (predicate(current)) return current
        await sleep(POLL_MS)
      }

      throw new Error(`等不到满足条件的帧${label === undefined ? '' : `（${label}）`}：\n${frame()}`)
    },

    waitForExit: async () => {
      await instance.waitUntilExit()
    },

    unmount: () => instance.unmount(),
  }
}
