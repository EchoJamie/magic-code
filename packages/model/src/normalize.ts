/**
 * 归一 —— 取件层（AI SDK）的 chunk → 内核事件（技术方案 · 模型策略 · 接缝自留）。
 *
 * 本文件是**接缝的内核**，且刻意做成**纯函数**：喂进一串流式 chunk，产出内核事件序列 +
 * 聚合结果，不碰网络、不碰配置、不碰 key。故循环 / 渲染所依赖的归一规则，
 * 用**假的流式响应**即可测（工作分解 · U03 测试策略）。
 *
 * ⚠️ `VendorStreamPart` 是取件层形态，**只在接缝内部流通**；越过这一层的是 `KernelEvent`。
 *
 * 流的**不变式**（渲染与控制面可依赖）：
 * ① 首条恒为 `model.call.start`；
 * ② 中段零至多条 `model.delta`；
 * ③ 收束为 `model.usage`? → `model.call.end`；
 * ④ 出错则以 `model.error` **终结**（其后不再有事件，也没有 `model.call.end`）；
 * ⑤ 被中断则流**静默结束**（无 `model.error`、无 `model.call.end`）——中断不是模型错误。
 */

import type { FinishReason, LanguageModelUsage, TextStreamPart, ToolSet } from 'ai'
import type {
  EventStamper,
  KernelEvent,
  ModelFinishReason,
  ModelTraits,
  ToolCall,
} from '@magic/contracts'
import type { ModelCallResult, ModelStream } from './call.ts'
import { classifyModelError, describeModelError, isAbortError } from './errors.ts'
import {
  modelCallEnd,
  modelCallStart,
  modelDelta,
  modelErrorEvent,
  modelRetry,
  modelUsage,
} from './events.ts'
import type { InlineDelta, TextSplitter } from './inline-thinking.ts'
import { inlineThinkingSplitter, passthroughSplitter } from './inline-thinking.ts'

/** 取件层的流形态——**接缝内部**。AI SDK 的 `TextStreamPart` 不越过接缝。 */
/**
 * 退避重试的信号块——**取件层不产它**，是退避层（`retry.ts`）插进流里的一格。
 *
 * 为什么要骑马过流而不是另开一条路：模型域的事件出口**就是这条流**
 * （`ModelStream.events`，由对话域消费后转 `EventSink`）——从别处直发会让
 * `model.retry` 与它前后的 `model.delta` **丢掉先后的准头**，而「等之前 / 等之后」
 * 恰恰是这条事件唯一的用处。
 */
export type RetryStreamPart = {
  readonly type: 'retry'
  /** 下一次尝试的序号（**从 2 起**——第 1 次是首发，谈不上「重试」）。 */
  readonly attempt: number
  /** 即将等的时长（毫秒）。 */
  readonly delayMs: number
  /** 策略的上限（总尝试次数，含首次）——状态行 `2/3` 的分母（缺陷 D10 · 第 2 样）。 */
  readonly maxAttempts: number
}

/**
 * 接缝内部的流块。名字沿用「取件层」——主体仍是 SDK 的 `TextStreamPart`；
 * 额外那一格 `retry` 是本层自己的信号（见 `RetryStreamPart`）。
 */
export type VendorStreamPart = TextStreamPart<ToolSet> | RetryStreamPart

export type NormalizeOptions = {
  /** 模型名——写进 `model.call.start`。 */
  readonly model: string
  /**
   * 条目名（`providers` 的键）——写进 `model.call.start`，供外壳状态行显示当前供应商
   * （技术方案 · 领域划分：「运行时切换」锚定）。缺省＝未给（Faux 与直接喂 chunk 的用例）。
   */
  readonly provider?: string | undefined
  /** 用于错误消息脱敏（key 永不入记录 / 事件）。 */
  readonly secret?: string | undefined
  /**
   * **生效的**模型特征标记——由 `resolveModelTraits` 裁定后传入（见 `traits.ts`）。
   * 缺省 / 无 `inlineThinking` ＝ 常规行为：正文原样走 `text`，**不猜、不切**。
   */
  readonly traits?: ModelTraits | undefined
  /**
   * **上下文窗口总量**（token）——`model.usage` 上那个分母（缺陷 D10 · 第 1 样）。
   * 由网关从条目配置传入（`ProviderConfig.contextWindow`）。**缺省 ＝ 不给分母**——
   * 归一不会为它编一个数（没声明就没有这一位）。
   */
  readonly contextWindow?: number | undefined
  /**
   * 信封铸造器（技术方案 · 领域划分 · 信封的归属 v0 锚定）——**产出方铸**。
   * `id` / `session` / `turn` / `at` 四件全由它盖；归一不自造计数、不取时钟。
   */
  readonly stamper: EventStamper
}

/** 流中在途的工具调用——名字先到、参数片段陆续到、`tool-call` 落定。 */
type PendingToolCall = {
  readonly id: string
  name: string
  argsRaw: string
  args: Readonly<Record<string, unknown>> | undefined
  invalid: boolean
}

type NormalizeState = {
  readonly model: string
  readonly provider: string | undefined
  readonly secret: string | undefined
  /** 上下文窗口总量（条目配置声明了才有）——随 `model.usage` 出去的那个分母。 */
  readonly contextWindow: number | undefined
  readonly stamper: EventStamper
  /** 正文切分位——生效标记决定实现（见 `inline-thinking.ts`）。 */
  readonly splitter: TextSplitter
  text: string
  thinking: string
  readonly pending: Map<string, PendingToolCall>
  usage: { inputTokens: number; outputTokens: number } | undefined
  /** 供应商未给 / 未走完＝`undefined`（「是否走完」由 `complete` 表述）。 */
  finishReason: ModelFinishReason | undefined
  error: { tier: ReturnType<typeof classifyModelError>; message: string } | undefined
  aborted: boolean
  complete: boolean
  /** 已收束（finish）/ 已出错 / 已中断——流到此为止，其后 chunk 不再吐事件。 */
  closed: boolean
}

/**
 * 正文切分位——**标记驱动**（技术方案 · 模型策略：不当通例处理）。
 * 命中 `inlineThinking` 才切；否则原样走 `text`。
 */
function createSplitter(traits: ModelTraits | undefined): TextSplitter {
  const tag = traits?.inlineThinking?.tag
  return tag === undefined || tag.length === 0 ? passthroughSplitter() : inlineThinkingSplitter(tag)
}

function createState(options: NormalizeOptions): NormalizeState {
  return {
    model: options.model,
    provider: options.provider,
    secret: options.secret,
    contextWindow: options.contextWindow,
    stamper: options.stamper,
    splitter: createSplitter(options.traits),
    text: '',
    thinking: '',
    pending: new Map(),
    usage: undefined,
    finishReason: undefined,
    error: undefined,
    aborted: false,
    complete: false,
    closed: false,
  }
}

// —— 收束原因的归一 ——

/** 取件层的 `FinishReason` → 内核词表；缺省 / 未知一律**缺省**（契约 `finishReason` 可缺）。 */
function toFinishReason(reason: FinishReason | string | undefined): ModelFinishReason | undefined {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'content-filter':
    case 'tool-calls':
    case 'error':
    case 'other':
      return reason
    default:
      return undefined
  }
}

/**
 * 用量归一——`undefined` 视作 0，但**两者皆缺**时返回 `undefined`（不发 `model.usage`）。
 * 契约要求 `number`，故不把「未上报」伪装成 0。
 */
function toUsage(usage: LanguageModelUsage | undefined): { inputTokens: number; outputTokens: number } | undefined {
  if (usage === undefined) return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  if (input === undefined && output === undefined) return undefined
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 }
}

/** 解析不出即取空对象——同时置 `invalid`，让调用方知道参数不可信。 */
function toArgs(input: unknown): { args: Readonly<Record<string, unknown>>; invalid: boolean } {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return { args: input as Readonly<Record<string, unknown>>, invalid: false }
  }
  return { args: {}, invalid: input !== undefined }
}

// —— 正文增量（过切分位）——

/** 切出的增量落进状态并转事件——两处出口（`text` / `thinking`）同源，故聚合与事件不会打架。 */
function emitText(state: NormalizeState, deltas: readonly InlineDelta[]): KernelEvent[] {
  const events: KernelEvent[] = []
  for (const delta of deltas) {
    if (delta.channel === 'thinking') state.thinking += delta.text
    else state.text += delta.text
    events.push(modelDelta(state.stamper, delta.channel, delta.text))
  }
  return events
}

/** 收尾——把切分器手里留的残片吐出（不完整的标签按正文算，见 `inline-thinking.ts`）。 */
function flushText(state: NormalizeState): KernelEvent[] {
  return emitText(state, state.splitter.flush())
}

// —— 逐 chunk 消费 ——

function consume(part: VendorStreamPart, state: NormalizeState): KernelEvent[] {
  switch (part.type) {
    // —— 退避重试中（本层自己的信号块，非取件来源）——
    case 'retry': {
      return [modelRetry(state.stamper, part.attempt, part.delayMs, part.maxAttempts)]
    }

    // —— 正文（过切分位：内嵌思考可能被切到 thinking 通道）——
    case 'text-delta': {
      return emitText(state, state.splitter.push(part.text))
    }

    // —— 思考 ——
    case 'reasoning-delta': {
      state.thinking += part.text
      return [modelDelta(state.stamper, 'thinking', part.text)]
    }

    // —— 工具调用：名字先到，参数片段随后（增量一律带上供应商侧调用 id——渲染侧据以分组）——
    case 'tool-input-start': {
      state.pending.set(part.id, {
        id: part.id,
        name: part.toolName,
        argsRaw: '',
        args: undefined,
        invalid: false,
      })
      // 空文本增量——零参工具不会有参数片段，工具名只在流里出现这一次
      return [modelDelta(state.stamper, 'toolcall', '', part.toolName, part.id)]
    }
    case 'tool-input-delta': {
      const call = state.pending.get(part.id)
      if (call !== undefined) call.argsRaw += part.delta
      // 名字取自在途记录（缺 `tool-input-start` 时可能没有），id 一律直给
      return [modelDelta(state.stamper, 'toolcall', part.delta, call?.name, part.id)]
    }
    case 'tool-call': {
      const existing = state.pending.get(part.toolCallId)
      const { args, invalid } = toArgs(part.input)
      if (existing === undefined) {
        state.pending.set(part.toolCallId, {
          id: part.toolCallId,
          name: part.toolName,
          argsRaw: '',
          args,
          invalid,
        })
      } else {
        existing.name = part.toolName
        existing.args = args
        existing.invalid = invalid
      }
      return []
    }

    // —— 收束 ——
    case 'finish-step': {
      // 单步调用下与 finish 同源；作为 finish 缺用量时的兜底
      state.usage = toUsage(part.usage) ?? state.usage
      return []
    }
    case 'finish': {
      state.usage = toUsage(part.totalUsage) ?? state.usage
      state.finishReason = toFinishReason(part.finishReason)
      // 收束前先吐残片——否则标签尾部的半截留在切分器里，正文截掉一截
      const events: KernelEvent[] = flushText(state)
      if (state.usage !== undefined) {
        events.push(
          modelUsage(
            state.stamper,
            state.usage.inputTokens,
            state.usage.outputTokens,
            state.contextWindow,
          ),
        )
      }
      events.push(modelCallEnd(state.stamper))
      state.closed = true
      return events
    }

    // —— 失败 / 中断 ——
    case 'error': {
      state.closed = true
      if (isAbortError(part.error)) {
        state.aborted = true
        return flushText(state)
      }
      const tier = classifyModelError(part.error)
      const message = describeModelError(part.error, state.secret)
      state.error = { tier, message }
      return [...flushText(state), modelErrorEvent(state.stamper, tier, message)]
    }
    case 'abort': {
      state.aborted = true
      state.closed = true
      return flushText(state)
    }

    // —— 不入内核的 chunk（供应商细节 / 非文本模态 / 由 SDK 自己跑的工具）——
    case 'start':
    case 'start-step':
    case 'text-start':
    case 'text-end':
    case 'reasoning-start':
    case 'reasoning-end':
    case 'tool-input-end':
    case 'tool-result':
    case 'tool-error':
    case 'tool-output-denied':
    case 'tool-approval-request':
    case 'tool-approval-response':
    case 'source':
    case 'file':
    case 'reasoning-file':
    case 'custom':
    case 'raw':
      return []

    default:
      return []
  }
}

// —— 落定 ——

/** 在途工具调用收口——`tool-call` 未到者，用攒下的参数片段兜底。 */
function settleToolCalls(state: NormalizeState): ToolCall[] {
  const calls: ToolCall[] = []
  for (const call of state.pending.values()) {
    if (call.args !== undefined) {
      calls.push(
        call.invalid
          ? { id: call.id, name: call.name, args: call.args, invalid: true }
          : { id: call.id, name: call.name, args: call.args },
      )
      continue
    }
    if (call.argsRaw.length === 0) {
      calls.push({ id: call.id, name: call.name, args: {} })
      continue
    }
    try {
      const parsed: unknown = JSON.parse(call.argsRaw)
      const { args, invalid } = toArgs(parsed)
      calls.push(
        invalid
          ? { id: call.id, name: call.name, args, invalid: true }
          : { id: call.id, name: call.name, args },
      )
    } catch {
      calls.push({ id: call.id, name: call.name, args: {}, invalid: true })
    }
  }
  return calls
}

function snapshot(state: NormalizeState): ModelCallResult {
  return {
    model: state.model,
    text: state.text,
    thinking: state.thinking,
    toolCalls: settleToolCalls(state),
    usage: state.usage,
    finishReason: state.finishReason,
    error: state.error,
    aborted: state.aborted,
    complete: state.complete,
  }
}

// —— 归一入口 ——

/**
 * 把取件层的 chunk 流归一为内核事件序列 + 聚合结果。
 *
 * `result` 随 `events` 被消费完而落定；拉一半 `break` 也会落定（`complete: false`），
 * 且会顺带关掉上游流（`for await` 的 `IteratorClose`）。
 */
export function toKernelEvents(
  parts: AsyncIterable<VendorStreamPart>,
  options: NormalizeOptions,
): ModelStream {
  const state = createState(options)

  let settle!: (result: ModelCallResult) => void
  const result = new Promise<ModelCallResult>((resolve) => {
    settle = resolve
  })

  async function* pump(): AsyncGenerator<KernelEvent> {
    try {
      yield modelCallStart(state.stamper, state.model, state.provider)

      for await (const part of parts) {
        for (const event of consume(part, state)) yield event
        if (state.closed) break
      }

      // 走到这里＝流已定论（收束 / 出错 / 中断皆算）。消费方提前 break 则到不了此行，
      // `complete` 留 false——这正是它与「被掐断」的区别。
      state.complete = true
    } catch (error) {
      state.complete = true
      if (isAbortError(error)) {
        state.aborted = true
      } else {
        const tier = classifyModelError(error)
        const message = describeModelError(error, state.secret)
        state.error = { tier, message }
        yield modelErrorEvent(state.stamper, tier, message)
      }
    } finally {
      settle(snapshot(state))
    }
  }

  return { events: pump(), result }
}
