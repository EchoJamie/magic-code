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
  ModelUsage,
  ToolCall,
} from '@magic/contracts'
import type { ModelCallResult, ModelStream } from './call.ts'
import { classifyModelError, describeModelError, isAbortError, redactSecrets } from './errors.ts'
import {
  modelCallEnd,
  modelCallStart,
  modelDelta,
  modelErrorEvent,
  modelRetry,
  modelUsage,
} from './events.ts'
import type { InlineDelta, TextSplitter } from './inline-thinking.ts'
import { inlineThinkingSplitter, passthroughSplitter, probingSplitter } from './inline-thinking.ts'
import { knownInlineTags } from './traits.ts'

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
   * 无 `inlineThinking` ＝ 常规行为：正文原样走 `text`，**不猜、不切**。
   *
   * 缺省（`undefined`）＝**不知道这个模型是哪一类**——那时才装探针：
   * 模型输出**以某个已知标签开头**才认、认下并留存（见 `learnInlineThinking`）。
   */
  readonly traits?: ModelTraits | undefined
  /**
   * **认下内嵌思考**时的回调（U65 第二层）——探针认出来的那一刻调一次，带标签名。
   *
   * 由**网关**接：记进 `LearnedTraits`（这个模型名下一次直接按它办）。不接也行——
   * 这一次照样切对，只是下一轮还得再认一遍。归一本身**不持有**那份记忆（本文件仍是纯的）。
   */
  readonly learnInlineThinking?: ((tag: string) => void) | undefined
  /**
   * **上下文窗口总量**（token）——`model.usage` 上那个分母（缺陷 D10 · 第 1 样）。
   * 由网关从条目配置传入（`ProviderConfig.contextWindow`）。**缺省 ＝ 不给分母**——
   * 归一不会为它编一个数（没声明就没有这一位）。
   */
  readonly contextWindow?: number | undefined
  /**
   * **这次调用的有效输入预算**（U41 返修）——写进 `model.call.start`，让外壳在请求
   * **开始**那一刻就有分母（不必等整轮收束的 `model.usage`）。与 `contextWindow`
   * 是**同一个数**（同一次解析），只是两个时点各报一次。
   */
  readonly inputBudget?: number | undefined
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
  /**
   * **不成形时那段原文**（U84）——`undefined` ＝没给参数（或参数收成了，用不着它）。
   * 已截断、已脱敏（见 `rawOf`）。
   */
  raw: string | undefined
}

type NormalizeState = {
  readonly model: string
  readonly provider: string | undefined
  /** 这次调用的有效输入预算（见 `NormalizeOptions.inputBudget`）。 */
  readonly inputBudget: number | undefined
  readonly secret: string | undefined
  /** 上下文窗口总量（条目配置声明了才有）——随 `model.usage` 出去的那个分母。 */
  readonly contextWindow: number | undefined
  readonly stamper: EventStamper
  /** 正文切分位——生效标记决定实现（见 `inline-thinking.ts`）。 */
  readonly splitter: TextSplitter
  text: string
  thinking: string
  readonly pending: Map<string, PendingToolCall>
  /** 实际用量——**各字段分别可缺**（未上报＝不知道，不补零）。 */
  usage: ModelUsage | undefined
  /** 供应商未给 / 未走完＝`undefined`（「是否走完」由 `complete` 表述）。 */
  finishReason: ModelFinishReason | undefined
  error: { tier: ReturnType<typeof classifyModelError>; message: string } | undefined
  aborted: boolean
  complete: boolean
  /** 已收束（finish）/ 已出错 / 已中断——流到此为止，其后 chunk 不再吐事件。 */
  closed: boolean
}

/**
 * 正文切分位——**标记驱动**（技术方案 · 模型策略：不当通例处理）。三处出口，判据只有一条：
 * 这个模型**知不知道**是哪一类。
 *
 * - 知道，且标了 `inlineThinking` ⇒ 按它切；
 * - 知道，且**明说无特征**（`{}`）⇒ 原样走 `text`（**不探**——那是用户的出口，见 `traits.ts`）；
 * - **不知道** ⇒ 探针：模型输出以已知标签开头才认（探针本身不含「无条件切分」，见
 *   `probingSplitter` 的判据）。
 */
function createSplitter(options: NormalizeOptions): TextSplitter {
  const tag = options.traits?.inlineThinking?.tag
  if (tag !== undefined && tag.length > 0) return inlineThinkingSplitter(tag)
  if (options.traits !== undefined) return passthroughSplitter()

  return probingSplitter({
    tags: knownInlineTags(),
    learn: options.learnInlineThinking,
  })
}

function createState(options: NormalizeOptions): NormalizeState {
  return {
    model: options.model,
    provider: options.provider,
    inputBudget: options.inputBudget,
    secret: options.secret,
    contextWindow: options.contextWindow,
    stamper: options.stamper,
    splitter: createSplitter(options),
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
 * 用量归一（U41 改形）——**各字段分别允许未知**。
 *
 * 撤销了原先「缺一个就补零」的简化：**服务端明确返回 0 才是 0**，没回来就是**不知道**
 * （设计 · 模型与上下文「用量归一」）。全部字段都缺才返回 `undefined`——那一次不发
 * `model.usage`。
 *
 * 口径（设计逐条）：
 * - `inputTokens` ——**完整**输入消耗（**含**已计入输入的缓存部分）；
 * - `outputTokens` ——**完整**输出消耗（**含**该供应商计入输出的思考部分）；
 * - `cacheRead` / `cacheWrite` / `reasoning` ——**仅作细分**，**不得与上面两个相加**；
 * - `totalTokens` —— 保留**供应商自己给的定义**，我们不去替它加一个。
 *
 * 数据源优先取 SDK 已归一的字段（`inputTokens` / `outputTokens` / `totalTokens` 与两组
 * details），不回到供应商原始 JSON 里另加一遍——那正是 DeepSeek 缓存命中被重复计数的来路。
 */
function toUsage(usage: LanguageModelUsage | undefined): ModelUsage | undefined {
  if (usage === undefined) return undefined

  const cacheRead = usage.inputTokenDetails?.cacheReadTokens
  const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens
  const reasoning = usage.outputTokenDetails?.reasoningTokens

  const mapped: ModelUsage = {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens }),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }

  return Object.keys(mapped).length === 0 ? undefined : mapped
}

/**
 * **不成形参数的原文上限**（字符）——U84，缺陷 D42「参数解析不出把原文丢了」。
 *
 * 取的是一段能**认清成因**的量：够看见这串东西的头部与断点（是 JSON 断在半路？
 * 是个字符串？是个数组？），又不会让一条坏调用把记录撑成必须翻页的东西。
 * 对照同域已有的两道：判档用的文本上限 4000（`errors.ts`），报给用户那句 500。
 * **它不是给模型看的**（模型那边本来就有 `args: {}` 加一句「参数解析不出」），
 * 故不必迁就「一屏读完」，但也没有理由比正常调用占的地方更大。
 */
const RAW_ARGS_LIMIT = 2000

/** 非字符串的值（数字 / 数组 / `null`…）——照 JSON 写出来；写不出来（循环引用）就退回字符串形。 */
function safeJsonOf(value: unknown): string {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}

/** 截一段——超限即截，并在末尾写明「原文还有多长」（读的人据此知道后面还有东西）。 */
function clip(text: string): string {
  if (text.length <= RAW_ARGS_LIMIT) return text
  return `${text.slice(0, RAW_ARGS_LIMIT)}…（原文共 ${text.length} 字，已截断）`
}

/**
 * **不成形时那段原文**（U84）——两处来源，**取更贴近原文的那一个**：
 *
 * ① 流里攒下的那串文本（`text`）——**供应商原样给的**，一字未动，首选；
 * ② 它没有时（SDK 直接把解析好的值交过来，没走增量），才把那个值照 JSON 写出来
 *    （`value`）——那是还原，不是原文，但总比丢掉强。
 *
 * 两处都没有（空文本 ＋ `undefined`）⇒ `undefined` ＝**压根没给参数**。
 *
 * 出来之前过两道：**脱敏**（密钥纪律「key 只向下流」——模型的参数里可能原样带着
 * 用户粘过的 key；与错误消息那一道同一把尺子）＋**截断**。
 */
function rawOf(state: NormalizeState, text: string, value: unknown): string | undefined {
  const source = text.length > 0 ? text : value === undefined ? '' : safeJsonOf(value)
  if (source.length === 0) return undefined
  return redactSecrets(clip(source), state.secret)
}

/**
 * 解析不出即取空对象——同时置 `invalid`，让调用方知道参数不可信。
 *
 * ⚠️ **「没给」与「给了但不成形」在这里就分开**（U84，缺陷 D42）：
 * - `input === undefined` ⇒ `invalid: false`——**没给参数**，不是坏参数
 *   （零参工具走的就是这一支，照旧放行）；
 * - 其余非对象（字符串 / 数字 / 数组 / `null`）⇒ `invalid: true`——**给了，但不成形**。
 *
 * 原文**不在这里取**：那要问流里攒下的那串文本（见 `rawOf`），而本函数是纯的、
 * 手上只有解析后的值。
 */
function toArgs(input: unknown): {
  args: Readonly<Record<string, unknown>>
  invalid: boolean
} {
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
        raw: undefined,
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
      // 原文优先取**流里攒下的那串**（同一 id 的增量片段），没有才退回解析后的值
      const kept = invalid ? rawOf(state, existing?.argsRaw ?? '', part.input) : undefined
      if (existing === undefined) {
        state.pending.set(part.toolCallId, {
          id: part.toolCallId,
          name: part.toolName,
          argsRaw: '',
          args,
          invalid,
          raw: kept,
        })
      } else {
        existing.name = part.toolName
        existing.args = args
        existing.invalid = invalid
        existing.raw = kept
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
        events.push(modelUsage(state.stamper, state.usage, state.contextWindow))
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
      return [
        ...flushText(state),
        modelErrorEvent(state.stamper, tier, message, {
          provider: state.provider,
          model: state.model,
        }),
      ]
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

/**
 * 在途工具调用收口——`tool-call` 未到者，用攒下的参数片段兜底。
 *
 * 三岔与 `toArgs` 同一副判据（U84，「没给」与「给了但不成形」要分得开）：
 * ① **收成了** ⇒ 原样；
 * ② **没给**（片段一片都没攒下）⇒ 空参数、**不是坏参数**、也没有原文；
 * ③ **给了但不成形**（片段攒下了，JSON 却解不出 / 解出来不是对象）⇒ `invalid`
 *    且**把那段原文一并带走**——这正是它跟②在记录里分得开的那一格。
 */
function settleToolCalls(state: NormalizeState): ToolCall[] {
  const calls: ToolCall[] = []
  for (const call of state.pending.values()) {
    if (call.args !== undefined) {
      calls.push(
        call.invalid
          ? { ...rawFieldOf(call.raw), id: call.id, name: call.name, args: call.args, invalid: true }
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
          ? {
              ...rawFieldOf(rawOf(state, call.argsRaw, parsed)),
              id: call.id,
              name: call.name,
              args,
              invalid: true,
            }
          : { id: call.id, name: call.name, args },
      )
    } catch {
      // 断在半路——**这一串就是原文**（收口这一步是它唯一的去处）
      calls.push({
        ...rawFieldOf(rawOf(state, call.argsRaw, undefined)),
        id: call.id,
        name: call.name,
        args: {},
        invalid: true,
      })
    }
  }
  return calls
}

/**
 * 「有原文才带这一位」——`ToolCall.rawArgs` 是可缺位（**只增不改**：不给就与加它之前
 * 逐字同形）。判 `undefined`（不在场），不判真假：空串也是一段原文（模型真给了个空串）。
 */
function rawFieldOf(raw: string | undefined): { rawArgs?: string } {
  return raw === undefined ? {} : { rawArgs: raw }
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
      yield modelCallStart(state.stamper, state.model, state.provider, state.inputBudget)

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
        yield modelErrorEvent(state.stamper, tier, message, {
          provider: state.provider,
          model: state.model,
        })
      }
    } finally {
      settle(snapshot(state))
    }
  }

  return { events: pump(), result }
}
