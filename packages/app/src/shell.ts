/**
 * **外壳位** —— 装配视图第 5 步「接外壳」的落点（技术方案 · 领域划分 · 装配视图 5）。
 *
 * ⚠️ **真外壳（TUI）已到站**（U09 · `@magic/tui`）——`magic` **无参**即起它，那是默认路径。
 * 本文件**不是替身、也不与它争**：它是 **`--script` 的实现**——无人值守的驱动，把控制面
 * 两端（`shell.subscribe` / `shell.send`）接上，好让全链在**没有界面**的情况下跑起来
 * （验收装置 / 冒烟 / 回归都用它）。
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
 *
 * **答复的加宽位**（第 16 轮补）——`ShellAnswer` 收两形：裸 `Decision`（一次性，旧写法一字不动）
 * 或 `{ decision, remember? }`。**「总是允许」由此脚本化**：没有这个位，那条链就只
 * 在真 TTY 里按得出来、无人值守验不了（本轮的端到端真跑正是靠它）。
 *
 * **换模型的加宽位**（U17 补）——脚本的交代位收两形：裸字符串（一字不改的老写法）或
 * `{ switch: { provider?, model? } }`（**会话中途换模型**）。落点是 `onSwitch`：装配把
 * **换模型那一条产出路径**接在那儿，本文件只负责「按脚本的次序喊一声」，不认识注册表——
 * 也**因此与命令面同产 `model.switched`**（缺陷 D16：收拢的是产出，不是入口）。
 *
 * ⚠️ **为什么「会话中途换模型」出现在这里**——控制面的命令词表（契约 `Command`）里
 * **没有「换模型」这个词**（`input.submit` / `decision.answer` / `turn.interrupt` 三支），
 * 而那是个冻结的契约。本驱动是装配侧唯一「在会话中途对内核做点什么」的地方，故这一轮的
 * 入口落在这儿（真产品入口＝外壳的一条命令，待契约加词——见回报「待决」）。
 */

import type { Command, ControlTransport, Decision, KernelEvent } from '@magic/contracts'
import type { ModelSelection, ModelSwitchRequest, ModelSwitchResult } from '@magic/model'

/** 一次裁决询问（`tool.decision.request` 的四件）。 */
export type ShellDecisionRequest = {
  /** 配对键＝**请求事件** id（不是载荷里的 `call`——两个 id 空间）。 */
  readonly id: number
  readonly name: string
  /** 判断材料——命令分解 / diff / 影响面。 */
  readonly material: string
  readonly weight: 'light' | 'heavy'
}

/**
 * 一次答复——裸词，或**裸词 ＋ 加宽位**。
 *
 * 给 `Decision` ＝一次性（与阶段 1 逐字同义）；给对象形才谈得上「总是允许」。
 * 两形并存是**向后兼容**的形态：旧脚本 `decisions: ['approve']`、旧钩子 `() => 'approve'`
 * 一字不动照常工作。
 *
 * ⚠️ `remember` **只在批准时生效**（规则的条目只有「允许」这一形，没有「总是拒绝」——
 * 见契约 · `DecisionAnswer.remember`）。
 */
export type ShellAnswer = Decision | { readonly decision: Decision; readonly remember?: boolean }

/** 已答复的裁决（询问 ＋ 答复）——`remember` **原样记**：给了就在，没给就不在这个键上。 */
export type ShellDecision = ShellDecisionRequest & {
  readonly decision: Decision
  readonly remember?: boolean
}

/** 一次**会话中途**的换模型（请求 ＋ 落地后的选中）——`switches` 里的痕迹。 */
export type ShellSwitch = {
  readonly request: ModelSwitchRequest
  readonly selection: ModelSelection
}

/** 接上外壳位之后拿到的把手——驱动全链用。 */
export type ShellHandle = {
  /** 迄今收到的事件（按到达序，**含瞬时增量**）。活视图：拿在手里继续长。 */
  readonly events: readonly KernelEvent[]
  /** 迄今答复过的裁决。 */
  readonly decisions: readonly ShellDecision[]
  /** 迄今换过的模型（按发生序）。 */
  readonly switches: readonly ShellSwitch[]
  /**
   * 发一条交代并等它收束（回到「等待输入」）。
   *
   * 水位**先记后发**——反过来的话，收束快时这里会等一个永远不来的「下一次」，当场挂死。
   */
  submit(text: string, timeoutMs?: number): Promise<void>
  /** 发一条命令（不等待）——中断等非提交用途。 */
  send(command: Command): void
  /**
   * **会话中途换模型**——交给 `options.onSwitch`（装配接的注册表 `use()`），
   * 成功即留痕、失败即**抛**（无人值守里切不动就该当场停，而不是接着跑一个
   * 与脚本意图不符的会话）。没接 `onSwitch` 时同样是抛——不静默吞掉。
   */
  switchModel(request: ModelSwitchRequest): ModelSelection
  /** 等一个满足条件的**未来**事件（从调用时刻起；已过去的请扫 `events`）。 */
  until(test: (event: KernelEvent) => boolean, timeoutMs?: number): Promise<KernelEvent>
  /** 退订。 */
  dispose(): void
}

export type AttachShellOptions = {
  /**
   * **启动流转**（应用层的恢复用例）——**订阅之后、放开输入之前**那一条。
   *
   * 与真外壳（`@magic/tui` 的 `RunTuiOptions.boot`）**同一条纪律**：恢复要发事件，
   * 反了就是「事件发了没人收」；而「放开输入」以它完成为界（技术方案 · 装配视图第 5 步）。
   * `runShellScript` 在接上订阅之后、按脚本放开输入之前调它——本驱动不自己拼这条次序。
   */
  readonly boot?: (() => Promise<void>) | undefined
  /**
   * 事件观察者——**在送达订阅者的同一步**被调（瞬时增量也走这里）。
   * 与 `handle.events` 的区别：本回调可以只在场不存，长流不占内存。
   */
  readonly onEvent?: (event: KernelEvent) => void
  /**
   * 裁决答复——**无人值守替人批准**（见文件头注）。
   * 缺省 `() => 'approve'`：验收脚本要跑通全链，被闸门挡下就什么也验不到；
   * 要验「拒绝路径」请显式传 `() => 'reject'`；要验**「总是允许」**返回对象形
   * `() => ({ decision: 'approve', remember: true })`（见 `ShellAnswer`）。
   */
  readonly decide?: (request: ShellDecisionRequest) => ShellAnswer
  /**
   * **换模型的落点**——装配把**换模型那一条产出路径**接在这儿
   * （`(request) => assembly.switchModel(request)`：产 `model.switched` 并回结果——缺陷 D16）。
   * 缺省不接：脚本里没写 `switch` 就永远用不到它。
   */
  readonly onSwitch?: (request: ModelSwitchRequest) => ModelSwitchResult
  /** 等待上限（毫秒）——缺省 120 秒（真端点 + 真命令的余量）。 */
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 120_000
const APPROVE: Decision = 'approve'

/** 答复归一——裸词与对象形收成同两件（`remember` 没给就是 `undefined`，不补 `false`）。 */
function normalizeAnswer(answer: ShellAnswer): {
  readonly decision: Decision
  readonly remember: boolean | undefined
} {
  if (typeof answer === 'string') return { decision: answer, remember: undefined }
  return { decision: answer.decision, remember: answer.remember }
}

/** 换模型请求的一行话（报错里说清楚「想换成什么」）。 */
function describeSwitchRequest(request: ModelSwitchRequest): string {
  const parts: string[] = []
  if (request.provider !== undefined) parts.push(`provider=${request.provider}`)
  if (request.model !== undefined) parts.push(`model=${request.model}`)
  return parts.length === 0 ? '什么都没给' : parts.join(' · ')
}

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
  const switches: ShellSwitch[] = []
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
      const answer = normalizeAnswer(decide(request))
      decisions.push({
        ...request,
        decision: answer.decision,
        // 给了才落键——没给＝这次答复里没有这一位（与线上消息同形）
        ...(answer.remember === undefined ? {} : { remember: answer.remember }),
      })

      // **同一调用栈里答复**——权限域先登记、后扇出，故这条答复落不到空表上。
      // `remember` 只在 `true` 时才带上键：`undefined` 过不了通道的可序列化门（丢键＝有损），
      // 而 `false` 与不给同义（规则的条目只有「允许」这一形）
      shell.send(
        answer.remember === true
          ? { type: 'decision.answer', id: request.id, decision: answer.decision, remember: true }
          : { type: 'decision.answer', id: request.id, decision: answer.decision },
      )
    }
  })

  return {
    get events(): readonly KernelEvent[] {
      return events
    },
    get decisions(): readonly ShellDecision[] {
      return decisions
    },

    get switches(): readonly ShellSwitch[] {
      return switches
    },

    switchModel(request: ModelSwitchRequest): ModelSelection {
      const onSwitch = options.onSwitch
      if (onSwitch === undefined) {
        throw new Error('这次装配没接「换模型」的落点（onSwitch）——脚本里的 switch 无处可落')
      }

      const result = onSwitch(request)
      if (!result.ok) {
        throw new Error(
          `换模型不成功（${describeSwitchRequest(request)}）：${result.reason}`,
        )
      }

      switches.push({ request, selection: result.selection })
      return result.selection
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

/**
 * 脚本的一步——**交代**或**换模型**。
 *
 * 两形并存是**向后兼容**的形态：老脚本 `inputs: ["…"]` 一字不动照常工作
 * （与 `ShellAnswer` 的加宽位同法）；`{ switch: … }` 是 U17 的加宽位。
 */
export type ShellStep = string | { readonly switch: ModelSwitchRequest }

/** 一段无人值守的脚本——步骤按序走，每条交代等上一轮收束。 */
export type ShellScript = {
  /** 依次走的步骤：交代（裸字符串）或换模型（`{ switch: … }`）。 */
  readonly inputs: readonly ShellStep[]
  /**
   * 裁决答复（按询问次序取，用尽后走 `options.decide`）。
   *
   * 混着写也认：`['approve', { decision: 'approve', remember: true }]`——第 2 条即「总是允许」。
   */
  readonly decisions?: readonly ShellAnswer[]
  /** 每条交代的等待上限（毫秒）。 */
  readonly timeoutMs?: number
}

/**
 * 按脚本跑一遍——**先订阅、后放开输入**（`attachShell` 与 `submit` 的相对位置就是这条纪律）。
 * 返回把手（轨迹在内）——**不打印任何东西**：呈现是调用方的事。
 *
 * 换模型那一步**不等轮次**（它不产事件：换的是接缝下游，下一次调用才见分晓）——
 * 走完即走下一步，故「交代 → 换 → 交代」的次序由脚本自己写死。
 */
export async function runShellScript(
  shell: ControlTransport,
  script: ShellScript,
  options: AttachShellOptions = {},
): Promise<ShellHandle> {
  const queued = [...(script.decisions ?? [])]
  const fallback = options.decide ?? ((): ShellAnswer => APPROVE)

  const handle = attachShell(shell, {
    ...options,
    decide: (request) => queued.shift() ?? fallback(request),
  })

  // **先接订阅（上一步）、再跑启动流转、最后放开输入（下面的循环）**
  // ——无订阅方时命令与事件都丢（技术方案 · 控制域），恢复正好要发事件
  await options.boot?.()

  for (const step of script.inputs) {
    if (typeof step === 'string') {
      await handle.submit(step, script.timeoutMs)
      continue
    }
    handle.switchModel(step.switch)
  }

  return handle
}
