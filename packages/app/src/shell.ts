/**
 * **外壳位** —— 装配视图第 5 步「接外壳」的落点（技术方案 · 领域划分 · 装配视图 5）。
 *
 * ⚠️ **真外壳（TUI）归 U09**（`@magic/tui`），本文件不是它、也不与它争。这里只有
 * **无人值守的驱动**：把控制面两端（`shell.subscribe` / `shell.send`）接上，好让全链
 * 在**没有界面**的情况下跑起来——工单点名的验收装置就是它（「脚本化的假外壳」）。
 *
 * **它不做呈现**——事件到此为止是**数据**（`events` 轨迹 / `onEvent` 回调），
 * 一行字都不渲染。要说「外壳」，它只是外壳的**协议那一半**；给人看的那一半在 U09。
 *
 * 纪律（技术方案 · 控制域：无订阅方时命令丢弃——不排队、不补发）——
 * **订阅在 `attachShell` 里当场接上，发命令是其后的事**。这条次序就是「先接订阅、
 * 后放开输入」：反了＝用户输入无声丢失。
 *
 * **裁决口径**（无人值守替人批准）——阶段 1 一律人工门；本驱动替人按下按钮，是**验收
 * 装置的方便**，不是产品行为（产品里裁决只来自用户；自动放行归阶段 2 的规则化）。
 * 故缺省 `decide` 写得显眼，脚本可逐条改写；用尽的答复走同一个缺省。
 */

import type { Command, ControlTransport, Decision, KernelEvent } from '@magic/contracts'

/** 一次裁决询问（`tool.decision.request` 的四件）。 */
export type ShellDecisionRequest = {
  /** 配对键＝**请求事件** id（不是载荷里的 `call`——两个 id 空间）。 */
  readonly id: number
  readonly name: string
  /** 判断材料——命令分解 / diff / 影响面。 */
  readonly material: string
  readonly weight: 'light' | 'heavy'
}

/** 已答复的裁决（询问 ＋ 答复）。 */
export type ShellDecision = ShellDecisionRequest & { readonly decision: Decision }

/** 接上外壳位之后拿到的把手——驱动全链用。 */
export type ShellHandle = {
  /** 迄今收到的事件（按到达序，**含瞬时增量**）。活视图：拿在手里继续长。 */
  readonly events: readonly KernelEvent[]
  /** 迄今答复过的裁决。 */
  readonly decisions: readonly ShellDecision[]
  /**
   * 发一条交代并等它收束（回到「等待输入」）。
   *
   * 水位**先记后发**——反过来的话，收束快时这里会等一个永远不来的「下一次」，当场挂死。
   */
  submit(text: string, timeoutMs?: number): Promise<void>
  /** 发一条命令（不等待）——中断等非提交用途。 */
  send(command: Command): void
  /** 等一个满足条件的**未来**事件（从调用时刻起；已过去的请扫 `events`）。 */
  until(test: (event: KernelEvent) => boolean, timeoutMs?: number): Promise<KernelEvent>
  /** 退订。 */
  dispose(): void
}

export type AttachShellOptions = {
  /**
   * 事件观察者——**在送达订阅者的同一步**被调（瞬时增量也走这里）。
   * 与 `handle.events` 的区别：本回调可以只在场不存，长流不占内存。
   */
  readonly onEvent?: (event: KernelEvent) => void
  /**
   * 裁决答复——**无人值守替人批准**（见文件头注）。
   * 缺省 `() => 'approve'`：验收脚本要跑通全链，被闸门挡下就什么也验不到；
   * 要验「拒绝路径」请显式传 `() => 'reject'`。
   */
  readonly decide?: (request: ShellDecisionRequest) => Decision
  /** 等待上限（毫秒）——缺省 120 秒（真端点 + 真命令的余量）。 */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const APPROVE: Decision = 'approve'

/** 一个「`timeoutMs` 后无论如何都拒绝」的 promise——挂死比慢更坏（无订阅方＝丢命令，不报错）。 */
function deadline(timeoutMs: number, what: string): { promise: Promise<never>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined

  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`外壳等待超时（${timeoutMs}ms）：${what}`)),
      timeoutMs,
    )
  })

  return {
    promise,
    cancel: (): void => {
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}

/**
 * 接上外壳位——订阅当场接上，返回驱动把手。
 *
 * 顺序（技术方案 · 控制域）：**这里订阅** → 之后调用方才发命令。全链的「放开输入」
 * 因此是一个**显式动作**（`submit` / `send`），不是「装配完就自动开闸」。
 */
export function attachShell(shell: ControlTransport, options: AttachShellOptions = {}): ShellHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const decide = options.decide ?? ((): Decision => APPROVE)

  const events: KernelEvent[] = []
  const decisions: ShellDecision[] = []
  /** `agent.state{waiting}` 的水位——`submit` 记下它、等它的下一次。 */
  let waiting = 0
  const idleWaiters: { readonly target: number; readonly settle: () => void }[] = []
  const untilWaiters: { readonly test: (event: KernelEvent) => boolean; readonly settle: (event: KernelEvent) => void }[] = []

  const off = shell.subscribe((event) => {
    events.push(event)
    options.onEvent?.(event)

    for (let i = untilWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = untilWaiters[i]
      if (waiter === undefined || !waiter.test(event)) continue
      untilWaiters.splice(i, 1)
      waiter.settle(event)
    }

    if (event.kind === 'agent.state' && event.data.state === 'waiting') {
      waiting += 1
      for (let i = idleWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = idleWaiters[i]
        if (waiter === undefined || waiting < waiter.target) continue
        idleWaiters.splice(i, 1)
        waiter.settle()
      }
      return
    }

    if (event.kind === 'tool.decision.request') {
      const request: ShellDecisionRequest = {
        // 配对键＝**请求事件** id（不是载荷里的 `call`——两个 id 空间，见契约 `ids.ts`）
        id: event.id,
        name: event.data.name,
        material: event.data.material,
        weight: event.data.weight,
      }
      const decision = decide(request)
      decisions.push({ ...request, decision })
      // **同一调用栈里答复**——权限域先登记、后扇出，故这条答复落不到空表上
      shell.send({ type: 'decision.answer', id: request.id, decision })
    }
  })

  return {
    get events(): readonly KernelEvent[] {
      return events
    },
    get decisions(): readonly ShellDecision[] {
      return decisions
    },

    submit(text: string, overrideTimeoutMs?: number): Promise<void> {
      const target = waiting + 1
      const armed = deadline(
        overrideTimeoutMs ?? timeoutMs,
        `等「回到等待输入」（交代：${text}）`,
      )

      const settled = new Promise<void>((settle) => {
        idleWaiters.push({ target, settle })
      })

      shell.send({ type: 'input.submit', text })

      return Promise.race([settled, armed.promise]).finally(armed.cancel)
    },

    send(command: Command): void {
      shell.send(command)
    },

    until(test: (event: KernelEvent) => boolean, overrideTimeoutMs?: number): Promise<KernelEvent> {
      const armed = deadline(overrideTimeoutMs ?? timeoutMs, '等一个事件')
      const waiter = { test, settle: (_event: KernelEvent): void => {} }

      const matched = new Promise<KernelEvent>((settle) => {
        waiter.settle = settle
        untilWaiters.push(waiter)
      })

      // 超时即把它摘掉——留着一个没人听的等待者，后续事件白 settle 一场（不报错，只是脏）
      return Promise.race([matched, armed.promise]).finally(() => {
        armed.cancel()
        const index = untilWaiters.indexOf(waiter)
        if (index >= 0) untilWaiters.splice(index, 1)
      })
    },

    dispose(): void {
      off()
    },
  }
}

/** 一段无人值守的脚本——交代按序发，每条等上一轮收束。 */
export type ShellScript = {
  /** 依次发出的交代。 */
  readonly inputs: readonly string[]
  /** 裁决答复（按询问次序取，用尽后走 `options.decide`）。 */
  readonly decisions?: readonly Decision[]
  /** 每条交代的等待上限（毫秒）。 */
  readonly timeoutMs?: number
}

/**
 * 按脚本跑一遍——**先订阅、后放开输入**（`attachShell` 与 `submit` 的相对位置就是这条纪律）。
 * 返回把手（轨迹在内）——**不打印任何东西**：呈现是调用方的事。
 */
export async function runShellScript(
  shell: ControlTransport,
  script: ShellScript,
  options: AttachShellOptions = {},
): Promise<ShellHandle> {
  const queued = [...(script.decisions ?? [])]
  const fallback = options.decide ?? ((): Decision => APPROVE)

  const handle = attachShell(shell, {
    ...options,
    decide: (request) => queued.shift() ?? fallback(request),
  })

  for (const text of script.inputs) {
    await handle.submit(text, script.timeoutMs)
  }

  return handle
}
