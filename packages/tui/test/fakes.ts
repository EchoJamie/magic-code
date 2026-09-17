/**
 * 外壳侧测试替身（U09 · 测试面）。
 *
 * **不是生产代码**：`ControlTransport` 的外壳侧一端由**装配**注入（U11），外壳自己不构造它。
 * 这里只是「假装配」——给外壳一个可观察的对端，让外壳的协议侧无内核、无 key 可测：
 *
 * - `createSpyTransport()`——**间谍**：记下收到的命令与订阅时序（协议断言用）；
 * - `createScriptedKernel()`——**脚本化假内核**：对命令回放固定事件序列，
 *   供手动走通（`scripts/demo.ts`）与交互测试（Ink 活体渲染）共用。
 */

import type {
  Command,
  ControlTransport,
  EventDataOf,
  EventKind,
  KernelEvent,
  RecordId,
} from '@magic/contracts'
// 测试层·非域——信封铸造桩（`stamp` 的构造面断言全仓只此一处，见该包文件头）
import { makeTestStamper } from '@magic/faux'

// —— 间谍传输 ——

/** 传输上的动作（时序断言用——「先接订阅、后放开输入」是装配纪律）。 */
export type TransportCall = 'subscribe' | 'unsubscribe' | 'send'

export type SpyTransport = {
  /** 交给外壳的一端（外壳只认这个）。 */
  readonly transport: ControlTransport
  /** 收到的命令（按序）。 */
  readonly commands: readonly Command[]
  /** 动作时序。 */
  readonly calls: readonly TransportCall[]
  /** 模拟内核广播一个事件（推给外壳的订阅者）。 */
  readonly emit: (event: KernelEvent) => void
  /** 当前订阅者数（退订后应为 0）。 */
  readonly listenerCount: () => number
}

export function createSpyTransport(): SpyTransport {
  const listeners = new Set<(event: KernelEvent) => void>()
  const commands: Command[] = []
  const calls: TransportCall[] = []

  return {
    transport: {
      send: (command) => {
        calls.push('send')
        commands.push(command)
      },
      subscribe: (listener) => {
        calls.push('subscribe')
        listeners.add(listener)

        return () => {
          calls.push('unsubscribe')
          listeners.delete(listener)
        }
      },
    },
    commands,
    calls,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event)
    },
    listenerCount: () => listeners.size,
  }
}

// —— 脚本化假内核 ——

export type ScriptedKernelOptions = {
  /** 事件之间的间隔（毫秒）——造出「流式」观感；测试里传 0（同步走完）。 */
  readonly stepMs?: number
  /** 会话标识。 */
  readonly session?: string
}

export type ScriptedKernel = {
  /** 交给外壳的一端（假装配把这一端注入外壳）。 */
  readonly shell: ControlTransport
  /** 停掉未走完的脚本（测试收尾用）。 */
  readonly stop: () => void
}

const SCRIPT_MODEL = 'faux-kernel'

/**
 * 假内核——收到 `input.submit` 就演一出「模型流式 → 工具 → 审批 → 执行 → 收尾」：
 *
 * 1. `turn.start` · 思考流 · 正文流 · 工具调用流（toolcall 通道）；
 * 2. `tool.call` → `tool.decision.request`（带材料与轻重）——**等答复**；
 * 3. 答复后 `tool.decision` → `tool.output.delta` 流 → `tool.result`；
 * 4. 收尾：正文流 · `model.usage` · `turn.end(settled)`。
 *
 * `turn.interrupt` → `turn.end(aborted)`，在跑的脚本作废（幂等：无脚本在跑时忽略）。
 *
 * 事件 id 由本替身的铸造器**当场铸**（`tool.call` 的 id 即后续四处引用的 `call`）——
 * 与真实内核「产出方铸」同形，外壳侧的按 `call` 归位才测得到。
 */
export function createScriptedKernel(options: ScriptedKernelOptions = {}): ScriptedKernel {
  const stepMs = options.stepMs ?? 0
  const session = options.session ?? 'demo-shell'
  const listeners = new Set<(event: KernelEvent) => void>()

  const stamper = makeTestStamper({ session, turn: 1 })
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 在跑的脚本被作废（中断 / 停掉）。 */
  let cancelled = false
  let running = false
  /** 待答复的调用——`null` 表示没有悬着的询问。 */
  let hangingCall: RecordId | null = null

  /** 铸一发并投给订阅者（造事件走桩的铸造器——`id` 单调、`at` 固定）。 */
  const emit = <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent => {
    const event = stamper.stamp(kind, data)

    // 作废只拦脚本的后续步骤（见 `script`）——事件本身照发：中断的「轮收束」正是脚本外的一发
    for (const listener of [...listeners]) listener(event)

    return event
  }

  /** 排一段脚本——按 `stepMs` 逐步投递（为 0 时同步走完）。 */
  const script = (steps: readonly (() => void)[]): void => {
    cancelled = false
    running = true
    let index = 0

    const step = (): void => {
      if (cancelled) {
        running = false
        return
      }

      const action = steps[index]
      index += 1

      if (action === undefined) {
        running = false
        return
      }

      action()
      if (stepMs === 0) step()
      else timer = setTimeout(step, stepMs)
    }

    step()
  }

  /** 收尾——一次交代的末尾（轮结束）。 */
  const settle = (): void => {
    emit('model.usage', { inputTokens: 1284, outputTokens: 96 })
    emit('model.call.end', {})
    emit('message.assistant', { entry: stamper.nextId })
    emit('turn.end', { reason: 'settled' })
  }

  const onInput = (text: string): void => {
    script([
      () => emit('turn.start', {}),
      () => emit('model.call.start', { model: SCRIPT_MODEL }),
      () => emit('model.delta', { channel: 'thinking', text: '先看看工作区。' }),
      () => emit('model.delta', { channel: 'text', text: `收到：「${text}」。我跑一下 ——` }),
      () => emit('model.delta', { channel: 'toolcall', name: 'exec', id: 'tc_1', text: '{"cmd":"ls"' }),
      () => emit('model.delta', { channel: 'toolcall', name: 'exec', id: 'tc_1', text: '}' }),
      () => {
        // `tool.call` 的 id 即调用链的 `call`——后续四处同指它
        const call = emit('tool.call', { name: 'exec', args: { cmd: 'ls' } }).id
        hangingCall = call
        emit('tool.decision.request', {
          call,
          name: 'exec',
          material: '在工作区根执行：ls',
          weight: 'heavy',
        })
      },
    ])
  }

  const onAnswer = (approved: boolean): void => {
    const call = hangingCall
    if (call === null) return

    hangingCall = null

    script([
      () =>
        emit('tool.decision', {
          call,
          decision: approved ? 'approve' : 'reject',
          decider: 'user',
          elapsedMs: 1200,
        }),
      ...(approved
        ? [
            () => emit('tool.output.delta', { call, channel: 'stdout' as const, text: 'README.md\n' }),
            () => emit('tool.output.delta', { call, channel: 'stdout' as const, text: 'packages\n' }),
            () => emit('tool.result', { call, ok: true, output: { text: 'README.md\npackages\n' } }),
          ]
        : [() => emit('tool.result', { call, ok: false, output: { text: '（未获批准，未执行）' } })]),
      () =>
        emit('model.delta', {
          channel: 'text',
          text: approved ? '看完了：工作区里是 README.md 与 packages。' : '好，那就不跑。',
        }),
      settle,
    ])
  }

  const onInterrupt = (): void => {
    if (!running && hangingCall === null) return

    cancelled = true
    hangingCall = null
    if (timer !== undefined) clearTimeout(timer)
    emit('turn.end', { reason: 'aborted' })
  }

  return {
    shell: {
      send: (command: Command) => {
        if (command.type === 'input.submit') onInput(command.text)
        else if (command.type === 'decision.answer') onAnswer(command.decision === 'approve')
        else onInterrupt()
      },
      subscribe: (listener) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      },
    },
    stop: () => {
      cancelled = true
      running = false
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
