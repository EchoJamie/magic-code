/**
 * M02 · 模型域 —— 单元测试（工作分解 · 迁移轨道 M02；沿用旧 U03 判据）。
 *
 * 分三层，**都不经网络**：
 * 1. **归一**——直接喂假的流式 chunk（`VendorStreamPart`），断言内核事件序列与聚合结果；
 * 2. **分档 / 密钥纪律 / 中间件 / 特征标记**——纯函数级断言；
 * 3. **假端点回环**——给网关注入假 fetch，回放真格式的 OpenAI 兼容 SSE，
 *    把「取件层 SSE 解析 → 归一 → 中间件」整条路走通（真端点另跑，见回报）。
 *
 * 契约消费姿势：**构造经注入的 `EventStamper` · 消费用 `KernelEvent` ＋
 * `if (e.kind === '…')` 自动收窄**。事件带信封（`id` / `session` / `turn` / `at`）——
 * 信封由铸造器盖（M01-3 锚定「产出方铸」），逐条比不得；`payloads()` 剥掉信封只比
 * `kind` ＋ `data`，信封本身另有用例专钉。
 */

import { describe, expect, test } from 'bun:test'
import { APICallError, LoadAPIKeyError } from 'ai'
import type {
  FinishReason,
  LanguageModelUsage,
  StepResultPerformance,
  TextStreamPart,
  ToolSet,
} from 'ai'
import type {
  EventDataOf,
  EventKind,
  EventStamper,
  KernelEvent,
  ModelMessage,
  ModelTraits,
  ToolSpec,
  TurnId,
} from '@magic/contracts'
import type {
  ModelCallResult,
  ModelGateway,
  ModelMiddleware,
  ModelStream,
} from '../src/index.ts'
import {
  MAX_COMPLETION_TOKENS,
  MINIMAX_MODEL,
  MissingApiKeyError,
  classifyModelError,
  createLearnedTraits,
  createModelGateway,
  createModelRegistry,
  describeModelError,
  isAbortError,
  knownInlineTags,
  matchBuiltinTraits,
  modelCallEnd,
  modelCallStart,
  modelDelta,
  modelErrorEvent,
  modelUsage,
  redactSecrets,
  resolveApiKey,
  resolveModelTraits,
} from '../src/index.ts'
import { toKernelEvents } from '../src/normalize.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 假的流式 chunk（形态＝取件层 `TextStreamPart`）
// ═══════════════════════════════════════════════════════════════════════

type Part = TextStreamPart<ToolSet>

/**
 * 信封铸造器**桩**——测试替身，模型域自身不提供缺省（技术方案 · 领域划分 · 信封的归属）。
 *
 * `id` 本地单调、`at` 固定、`session` / `turn` 可设；`beginTurn` 在此**无人调**
 * （锚定：轮起止由**对话域**调，模型域只 `stamp`），留一个记录用的桩以便将来钉。
 */
function testStamper(session = 'test-session', turn: TurnId | null = null): EventStamper & {
  readonly turns: (TurnId | undefined)[]
} {
  let next = 0
  const turns: (TurnId | undefined)[] = []
  return {
    turns,
    // 泛型 `K` 与 `data: EventDataOf[K]` 的对应关系 TS 无法在函数体内自证（构造面的固有限制，
    // M01-3 备案同此）；真实实现由装配提供四件后自然成立，此处桩用一次断言收口。
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({
        id: (next += 1),
        session,
        turn,
        at: 1_700_000_000_000,
        kind,
        data,
      }) as KernelEvent,
    beginTurn: (value) => turns.push(value),
  }
}

/**
 * 剥信封——只比 `kind` 与 `data`。
 * 信封（`id` / `at`）是流水，逐条比整条事件会把用例钉死在一种铸造节奏上，反而不该；
 * 信封本身另有用例专钉（「构造面即信封」·「信封由注入的铸造器盖」）。
 */
function bare(event: KernelEvent): { kind: string; data: unknown } {
  return { kind: event.kind, data: event.data }
}

function payloads(events: readonly KernelEvent[]): { kind: string; data: unknown }[] {
  return events.map(bare)
}

function usageOf(inputTokens: number, outputTokens: number): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: { textTokens: outputTokens, reasoningTokens: undefined },
    totalTokens: inputTokens + outputTokens,
  }
}

function emptyUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: undefined,
  }
}

const textDelta = (text: string): Part => ({ type: 'text-delta', id: 'txt-0', text })
const reasoningDelta = (text: string): Part => ({ type: 'reasoning-delta', id: 'reasoning-0', text })

const finishPart = (
  finishReason: FinishReason,
  totalUsage: LanguageModelUsage = emptyUsage(),
): Part => ({ type: 'finish', finishReason, rawFinishReason: finishReason, totalUsage })

async function* fromParts(parts: readonly Part[]): AsyncIterable<Part> {
  for (const part of parts) yield part
}

/** 消费整条流——事件与结果一并取回。 */
async function drain(stream: ModelStream): Promise<{
  events: KernelEvent[]
  result: ModelCallResult
}> {
  const events: KernelEvent[] = []
  for await (const event of stream.events) events.push(event)
  return { events, result: await stream.result }
}

/**
 * 归一的直接入口——绕开取件层，喂假 chunk。
 *
 * 第三个参数是**配置覆盖位**（`providers.<id>.traits`），不是生效标记：
 * 这里扮演装配侧，走与 `gateway.ts` 同一条裁定路（查内置表 → **键在即接管**）。
 */
function normalize(
  parts: readonly Part[],
  model = MINIMAX_MODEL,
  override?: ModelTraits,
  /** 认下内嵌思考时的回调（U65）——缺省＝不记（只切）。 */
  learn?: (tag: string) => void,
): ModelStream {
  return toKernelEvents(fromParts(parts), {
    model,
    stamper: testStamper(),
    traits: resolveModelTraits(model, override),
    ...(learn === undefined ? {} : { learnInlineThinking: learn }),
  })
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 归一：假的流式 chunk → 内核事件序列
// ═══════════════════════════════════════════════════════════════════════

describe('归一 · 正文流', () => {
  test('事件序列＝call.start → delta×n → usage → call.end', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        { type: 'start-step', request: {}, warnings: [] },
        { type: 'text-start', id: 'txt-0' },
        textDelta('你'),
        textDelta('好'),
        { type: 'text-end', id: 'txt-0' },
        finishPart('stop', usageOf(12, 3)),
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, MINIMAX_MODEL),
        modelDelta(stamper, 'text', '你'),
        modelDelta(stamper, 'text', '好'),
        modelUsage(stamper, { inputTokens: 12, outputTokens: 3, totalTokens: 15 }),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.text).toBe('你好')
    expect(result.thinking).toBe('')
    expect(result.toolCalls).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3, totalTokens: 15 })
    expect(result.finishReason).toBe('stop')
    expect(result.error).toBeUndefined()
    expect(result.aborted).toBe(false)
    expect(result.complete).toBe(true)
  })

  test('供应商未回用量时**不发** model.usage（不发比发 0 诚实）', async () => {
    const { events, result } = await drain(
      normalize([{ type: 'start' }, textDelta('嗨'), finishPart('stop')]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelDelta(stamper, 'text', '嗨'), modelCallEnd(stamper)]),
    )
    expect(result.usage).toBeUndefined()
  })

  test('start-step 的用量在 finish 缺用量时兜底', async () => {
    const { events } = await drain(
      normalize([
        { type: 'start' },
        {
          type: 'finish-step',
          response: { id: 'r1', timestamp: new Date(0), modelId: MINIMAX_MODEL },
          usage: usageOf(7, 2),
          performance: {} as StepResultPerformance,
          finishReason: 'stop',
          rawFinishReason: 'stop',
          providerMetadata: undefined,
        },
        finishPart('stop'),
      ]),
    )

    expect(payloads(events)).toContainEqual(bare(modelUsage(testStamper(), { inputTokens: 7, outputTokens: 2, totalTokens: 9 })))
  })
})

describe('归一 · 思考与工具调用', () => {
  test('思考走 thinking 通道；工具调用先出名字、再出参数片段', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        reasoningDelta('让我想想'),
        textDelta('我来执行'),
        { type: 'tool-input-start', id: 'call-1', toolName: 'exec' },
        { type: 'tool-input-delta', id: 'call-1', delta: '{"cmd"' },
        { type: 'tool-input-delta', id: 'call-1', delta: ':"ls"}' },
        { type: 'tool-input-end', id: 'call-1' },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'exec',
          input: { cmd: 'ls' },
        },
        finishPart('tool-calls', usageOf(30, 10)),
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, MINIMAX_MODEL),
        modelDelta(stamper, 'thinking', '让我想想'),
        modelDelta(stamper, 'text', '我来执行'),
        // 工具名先于参数出现——零参工具在流里也有名可示
        modelDelta(stamper, 'toolcall', '', 'exec', 'call-1'),
        modelDelta(stamper, 'toolcall', '{"cmd"', 'exec', 'call-1'),
        modelDelta(stamper, 'toolcall', ':"ls"}', 'exec', 'call-1'),
        modelUsage(stamper, { inputTokens: 30, outputTokens: 10, totalTokens: 40 }),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('让我想想')
    expect(result.text).toBe('我来执行')
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'exec', args: { cmd: 'ls' } }])
    expect(result.finishReason).toBe('tool-calls')
  })

  test('tool-call 缺席时用攒下的参数片段兜底解析', async () => {
    const { result } = await drain(
      normalize([
        { type: 'start' },
        { type: 'tool-input-start', id: 'call-9', toolName: 'read' },
        { type: 'tool-input-delta', id: 'call-9', delta: '{"path":"a.ts"}' },
        finishPart('tool-calls'),
      ]),
    )

    expect(result.toolCalls).toEqual([{ id: 'call-9', name: 'read', args: { path: 'a.ts' } }])
  })

  test('参数解析不出＝invalid，不冒充空参', async () => {
    const { result } = await drain(
      normalize([
        { type: 'start' },
        { type: 'tool-input-start', id: 'call-x', toolName: 'exec' },
        { type: 'tool-input-delta', id: 'call-x', delta: '{"cmd": ' },
        finishPart('tool-calls'),
      ]),
    )

    expect(result.toolCalls).toEqual([
      { id: 'call-x', name: 'exec', args: {}, invalid: true },
    ])
  })

  test('零参工具不出参数片段', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        { type: 'tool-input-start', id: 'call-0', toolName: 'ls' },
        finishPart('tool-calls'),
      ]),
    )

    expect(payloads(events)).toContainEqual(
      bare(modelDelta(testStamper(), 'toolcall', '', 'ls', 'call-0')),
    )
    expect(result.toolCalls).toEqual([{ id: 'call-0', name: 'ls', args: {} }])
  })

  test('不入内核的 chunk（供应商细节）被丢弃', async () => {
    const { events } = await drain(
      normalize([
        { type: 'start' },
        { type: 'raw', rawValue: { vendor_extra: 1 } },
        textDelta('正文'),
        {
          type: 'source',
          sourceType: 'url',
          id: 's1',
          url: 'https://example.com',
          title: 'x',
        },
        finishPart('stop'),
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelDelta(stamper, 'text', '正文'), modelCallEnd(stamper)]),
    )
  })
})

describe('归一 · 错误与中断', () => {
  test('error chunk 以 model.error 终结——其后没有 call.end', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        textDelta('说到一半'),
        { type: 'error', error: new Error('Rate limit exceeded, please retry later') },
      ]),
    )

    expect(events).toHaveLength(3)
    expect(events[0]?.kind).toBe('model.call.start')
    expect(payloads(events.slice(2))).toEqual([
      {
        kind: 'model.error',
        data: { tier: 'transient', message: 'Rate limit exceeded, please retry later' },
      },
    ])
    expect(result.error?.tier).toBe('transient')
    expect(result.text).toBe('说到一半')
  })

  test('中止（abort chunk）**静默**结束——中断不是模型错误', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        textDelta('半句'),
        { type: 'abort', reason: 'user' },
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelDelta(stamper, 'text', '半句')]),
    )
    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('流本身抛错（中断）同走静默路径', async () => {
    async function* throwing(): AsyncIterable<Part> {
      yield { type: 'start' }
      yield textDelta('半句')
      const abort = new Error('This operation was aborted')
      abort.name = 'AbortError'
      throw abort
    }

    const { events, result } = await drain(
      toKernelEvents(throwing(), { model: MINIMAX_MODEL, stamper: testStamper() }),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelDelta(stamper, 'text', '半句')]),
    )
    expect(result.aborted).toBe(true)
  })

  test('流本身抛错（网络）→ model.error，档位按特征判', async () => {
    async function* throwing(): AsyncIterable<Part> {
      yield { type: 'start' }
      throw new TypeError('fetch failed')
    }

    const { events, result } = await drain(
      toKernelEvents(throwing(), { model: MINIMAX_MODEL, stamper: testStamper() }),
    )

    expect(events.at(-1)?.kind).toBe('model.error')
    expect(result.error?.tier).toBe('transient')
  })

  test('消费方提前 break：结果照样落定，complete 为 false', async () => {
    const stream = normalize([
      { type: 'start' },
      textDelta('一'),
      textDelta('二'),
      textDelta('三'),
      finishPart('stop', usageOf(1, 1)),
    ])

    const seen: KernelEvent[] = []
    for await (const event of stream.events) {
      seen.push(event)
      if (seen.length === 2) break
    }
    const result = await stream.result

    const stamper = testStamper()
    expect(payloads(seen)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelDelta(stamper, 'text', '一')]),
    )
    expect(result.complete).toBe(false)
    expect(result.text).toBe('一')
  })

  test('空流也成立：起 → 止（无 delta / 无 usage）', async () => {
    const { events } = await drain(normalize([finishPart('other')]))

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, MINIMAX_MODEL), modelCallEnd(stamper)]),
    )
  })

  test('思考通道走 reasoning-delta（供应商回 reasoning_content 时）', async () => {
    const { result } = await drain(
      normalize([{ type: 'start' }, reasoningDelta('想过了'), finishPart('stop')]),
    )

    expect(result.thinking).toBe('想过了')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 一之二 · 模型特征标记（技术方案 · 模型策略）—— 三条判据
// ═══════════════════════════════════════════════════════════════════════

describe('特征标记 · 内置表', () => {
  /**
   * 真端点实测（2026-09-16）的**行为钉子**：MiniMax-M3 经 OpenAI 兼容端点
   * **不回** `reasoning_content`，而是把思考写在 `content` 里、用 `<think>…</think>` 包住。
   *
   * 内置表按**模型名**命中 → 归一据生效标记把标签内容切到 `thinking` 通道，
   * 标签本身**不出现在正文增量里**（判据 ①）。
   */
  test('MiniMax-M3 的 <think> 内容走 thinking 通道，标签不进正文（判据 ①）', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        textDelta('<think>想想</think>\n\n正文'),
        finishPart('stop', usageOf(9, 4)),
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, MINIMAX_MODEL),
        modelDelta(stamper, 'thinking', '想想'),
        modelDelta(stamper, 'text', '\n\n正文'),
        modelUsage(stamper, { inputTokens: 9, outputTokens: 4, totalTokens: 13 }),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('想想')
    expect(result.text).toBe('\n\n正文')
    // 标签不出现在任何通道的增量里
    expect(JSON.stringify(payloads(events))).not.toContain('think>')
  })

  /**
   * 判据（U65 改锚）：**型号主干（家族）**，不是完整名字、更不是供应商。
   *
   * 改由：**同一个病犯过三次**——09-16 表里只有 M3、09-18 M2 漏了、09-25
   * `M2.7-highspeed` 又漏了。三次都是**同一条模型线换了版本号**，而每一次都靠用户真跑
   * 撞出来。故从「名字一模一样」换成「**同类行为、不同版本号**」。
   */
  test('内置表按**型号主干**匹配——同线的版本号落同一条，不是一个名字一行', () => {
    // 第 16 / 18 轮真端点实测的那两条
    expect(resolveModelTraits(MINIMAX_MODEL)).toEqual({ inlineThinking: { tag: 'think' } })
    expect(resolveModelTraits('MiniMax-M2')).toEqual({ inlineThinking: { tag: 'think' } })

    // 同线的版本号（09-25 真机取证用的就是 `MiniMax-M2.7-highspeed`）——全落 M2 那一条
    expect(resolveModelTraits('MiniMax-M2.5-highspeed')).toEqual({ inlineThinking: { tag: 'think' } })
    expect(resolveModelTraits('MiniMax-M2.7-highspeed')).toEqual({ inlineThinking: { tag: 'think' } })
    // M3 那一线的将来小改款同理
    expect(matchBuiltinTraits('MiniMax-M3.1')).toEqual({ inlineThinking: { tag: 'think' } })

    // 反面一：**不是拿供应商当家族**——同家的 M1 不在表里，坦荡地不认
    expect(matchBuiltinTraits('MiniMax-M1')).toBeUndefined()
    expect(matchBuiltinTraits('MiniMax')).toBeUndefined()
    // 反面二：**主干后面要接分隔符**——`M20` 是另一个模型名，不是 M2 的小改款
    expect(matchBuiltinTraits('MiniMax-M20')).toBeUndefined()
    expect(matchBuiltinTraits('gpt-4o')).toBeUndefined()
    // 反面三：键是从外面来的字符串，别从 `Object.prototype` 上摸到东西
    expect(matchBuiltinTraits('constructor')).toBeUndefined()
  })

  test('标签跨增量边界也切得干净（半截标签留住，不吐错通道）', async () => {
    const { events, result } = await drain(
      normalize([
        { type: 'start' },
        textDelta('<thi'),
        textDelta('nk>半'),
        textDelta('句'),
        textDelta('</thi'),
        textDelta('nk>正'),
        textDelta('文'),
        finishPart('stop'),
      ]),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, MINIMAX_MODEL),
        modelDelta(stamper, 'thinking', '半'),
        modelDelta(stamper, 'thinking', '句'),
        modelDelta(stamper, 'text', '正'),
        modelDelta(stamper, 'text', '文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result).toMatchObject({ thinking: '半句', text: '正文' })
  })

  test('标签开在流末尾、收不到合——残留按当前通道吐出（不吞字）', async () => {
    const { result } = await drain(
      normalize([{ type: 'start' }, textDelta('正文<think>没写完'), finishPart('stop')]),
    )

    expect(result.text).toBe('正文')
    expect(result.thinking).toBe('没写完')
  })
})

describe('特征标记 · 覆盖位', () => {
  /** 判据 ②——表外模型在 `providers.<id>.traits` 标注，同一切分生效。 */
  test('表外模型经配置覆盖位标注 → 同一切分生效（判据 ②）', async () => {
    const { events, result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<think>想</think>正文'), finishPart('stop')],
        'my-local-llama',
        { inlineThinking: { tag: 'think' } },
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, 'my-local-llama'),
        modelDelta(stamper, 'thinking', '想'),
        modelDelta(stamper, 'text', '正文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result).toMatchObject({ thinking: '想', text: '正文' })
  })

  /** 覆盖是**整组**的：配置给了别的标记，内置表那条即失效。 */
  test('覆盖位压过内置表——给 MiniMax-M3 改标 tag 后 <think> 不再切', async () => {
    const { result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<think>不切</think><reasoning>切</reasoning>'), finishPart('stop')],
        MINIMAX_MODEL,
        { inlineThinking: { tag: 'reasoning' } },
      ),
    )

    expect(result.text).toBe('<think>不切</think>')
    expect(result.thinking).toBe('切')
  })

  /**
   * 判据＝「**键在即接管**」（技术方案 · 领域划分 · 端口内类型）：`traits` 存在就整组覆盖，
   * **`{}` ＝显式声明无特征**——不再回落内置表。理由：内置表判错时用户**关得掉**。
   */
  test('覆盖位裁定：键在即接管——`{}` 即显式无特征，不回落内置表', () => {
    expect(resolveModelTraits(MINIMAX_MODEL, {})).toEqual({})
    expect(resolveModelTraits(MINIMAX_MODEL, { inlineThinking: { tag: 'reasoning' } })).toEqual({
      inlineThinking: { tag: 'reasoning' },
    })
    // 缺省（未给键）才查内置表
    expect(resolveModelTraits(MINIMAX_MODEL, undefined)).toEqual({
      inlineThinking: { tag: 'think' },
    })
  })

  test('内置表判错时用户关得掉——配置给 `{}` 后 MiniMax-M3 不再切', async () => {
    const { events, result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<think>想想</think>\n\n正文'), finishPart('stop')],
        MINIMAX_MODEL,
        {},
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, MINIMAX_MODEL),
        modelDelta(stamper, 'text', '<think>想想</think>\n\n正文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('')
    expect(result.text).toBe('<think>想想</think>\n\n正文')
  })
})

describe('特征标记 · 皆未命中', () => {
  /**
   * 判据 ③——不猜、不切：正文原样走 `text`。**表外模型**（内置表不认、也没有覆盖位）
   * 就拿这一段量。
   *
   * ⚠️ **U65 起这条判据的边界更清了**：认下的信号是「**模型输出以已知标签开头**」，
   * 故这里量的是它的**反面**——标签**在正文中间**。正常模型摘抄一段带标签的文本是常事
   * （用户贴进来、模型引用用户的话都是这一形），那**一个字都不许动**。
   */
  test('表外模型、标签**在正文中间** → 原样走 text，标签也不动（判据 ③）', async () => {
    const { events, result } = await drain(
      normalize(
        [
          { type: 'start' },
          textDelta('前面的话'),
          textDelta('<think>想想</think>'),
          textDelta('后面的话'),
          finishPart('stop'),
        ],
        'gpt-4o',
      ),
    )

    const stamper = testStamper()
    // ⚠️ **三段原样过**——第一格是「前」，探针当场分晓（那不是任何标签头），
    //    于是后面的 `<think>` 连停都不停一下（见 `probingSplitter` 的留尾判据）
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, 'gpt-4o'),
        modelDelta(stamper, 'text', '前面的话'),
        modelDelta(stamper, 'text', '<think>想想</think>'),
        modelDelta(stamper, 'text', '后面的话'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('')
    expect(result.text).toBe('前面的话<think>想想</think>后面的话')
    expect(resolveModelTraits('gpt-4o')).toBeUndefined()
  })

  test('切分**不是接缝通例**——同一段文本，常规模型原样、命中标记才切', async () => {
    const parts = [{ type: 'start' } as Part, textDelta('引一句：<think>x</think>y'), finishPart('stop')]

    const plain = await drain(normalize(parts, 'gpt-4o'))
    const inline = await drain(normalize(parts, MINIMAX_MODEL))

    expect(plain.result.text).toBe('引一句：<think>x</think>y')
    expect(plain.result.thinking).toBe('')
    expect(inline.result.text).toBe('引一句：y')
    expect(inline.result.thinking).toBe('x')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 一之三 · 认下的那些（U65 第二层）—— 随用生长
// ═══════════════════════════════════════════════════════════════════════

/**
 * 第一层（家族主干）治的是**版本号不同**那一类；供应商真推一个**新名字**时，表仍然漏。
 * 故第二层：**认出来之后记住它**——信号是**模型输出以某个已知标签开头**。
 *
 * 判据四条，一条不松：
 * ① 认得出（这一轮就切对）；
 * ② **记下了**——下一次这个模型名**直接按它办**，不必再过探针；
 * ③ 反面：**判据取严**——标签在正文中间不算、半截标签不算；
 * ④ **可关**——认错了，覆盖位压得住（那是既有的出口）。
 */
describe('特征标记 · 认下的那些（U65）', () => {
  /** 一份「已认下」的——与装配根造的那一份同形。 */
  const seen = (model: string): ReturnType<typeof createLearnedTraits> => {
    const learned = createLearnedTraits()
    learned.remember(model, { inlineThinking: { tag: 'think' } })
    return learned
  }

  test('② 认下之后**下一次直接按它办**——不必再过探针，也不必等表', async () => {
    // 表外的模型名（不是 MiniMax 那两条主干，也不是别家已知的）＋ 内嵌思考的回复
    const model = 'acme-reasoner-v9'

    // 第一趟：没有认下的那一份 ⇒ 探针看输出，认下
    const learned = createLearnedTraits()
    const before = await drain(
      normalize([{ type: 'start' }, textDelta('<think>想</think>正文'), finishPart('stop')], model, undefined,
        (tag) => learned.remember(model, { inlineThinking: { tag } })),
    )
    expect(before.result).toMatchObject({ thinking: '想', text: '正文' })
    // **痕迹留下来了**（可查）
    expect(learned.entries()).toEqual([[model, { inlineThinking: { tag: 'think' } }]])

    // 第二趟：**同一个模型名**——先查「认下的那些」，连探针都不装
    expect(resolveModelTraits(model, undefined, learned)).toEqual({ inlineThinking: { tag: 'think' } })
    const after = await drain(
      normalize([{ type: 'start' }, textDelta('<think>想</think>正文'), finishPart('stop')], model,
        resolveModelTraits(model, undefined, learned)),
    )
    expect(after.result).toMatchObject({ thinking: '想', text: '正文' })
  })

  test('探针：**跨增量边界**也认得出（`<thi` ＋ `nk>`），不与已有切分打架', async () => {
    const learned = createLearnedTraits()
    const { events, result } = await drain(
      normalize(
        [
          { type: 'start' },
          textDelta('<thi'),
          textDelta('nk>半'),
          textDelta('句</think>正文'),
          finishPart('stop'),
        ],
        'acme-reasoner-v9',
        undefined,
        (tag) => learned.remember('acme-reasoner-v9', { inlineThinking: { tag } }),
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, 'acme-reasoner-v9'),
        modelDelta(stamper, 'thinking', '半'),
        modelDelta(stamper, 'thinking', '句'),
        modelDelta(stamper, 'text', '正文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result).toMatchObject({ thinking: '半句', text: '正文' })
    expect(learned.get('acme-reasoner-v9')).toEqual({ inlineThinking: { tag: 'think' } })
  })

  test('反面：**半截标签**就断了 ⇒ 按正文算，不认（不完整的标签不是标签）', async () => {
    const learned = createLearnedTraits()
    const { events, result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<thi'), finishPart('stop')],
        'acme-reasoner-v9',
        undefined,
        (tag) => learned.remember('acme-reasoner-v9', { inlineThinking: { tag } }),
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, 'acme-reasoner-v9'),
        modelDelta(stamper, 'text', '<thi'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result).toMatchObject({ text: '<thi', thinking: '' })
    expect(learned.entries()).toEqual([])
  })

  /**
   * 反面（**不许动常规模型那条**）——思考走**独立字段**的模型，正文里恰好有 `<think>` 字样。
   *
   * 这一条同时钉住两件：`reasoning` 那条独立通道**一个字没动**（DeepSeek 那条路），
   * 且探针**不给它添乱**——正文不因「出现过」被切走、也不会被认下。
   */
  test('反面：思考走独立字段的正常模型 ⇒ 正文原样，且**不认**', async () => {
    const learned = createLearnedTraits()
    const { events, result } = await drain(
      normalize(
        [
          { type: 'start' },
          reasoningDelta('先想'),
          textDelta('照它说的：<think>这是你贴的</think>——就这个意思。'),
          finishPart('stop'),
        ],
        'gpt-4o',
        undefined,
        (tag) => learned.remember('gpt-4o', { inlineThinking: { tag } }),
      ),
    )

    // 思考走**独立通道**（`reasoning-delta` → `thinking`），一个字没动
    expect(result.thinking).toBe('先想')
    // 正文原样——标签在**中间**，探针早在一格就判「不是」
    expect(result.text).toBe('照它说的：<think>这是你贴的</think>——就这个意思。')
    expect(learned.entries()).toEqual([])
    // 独立通道那条照旧：思考走 `thinking` 增量，正文走 `text` 增量（一个字没动）
    expect(
      events.some((event) => event.kind === 'model.delta' && event.data.channel === 'thinking'),
    ).toBe(true)
  })

  test('④ **可关**——覆盖位压过认下的那些（认错了的出口）', async () => {
    const model = 'acme-reasoner-v9'
    const learned = seen(model)

    // 没覆盖：按认下的办
    expect(resolveModelTraits(model, undefined, learned)).toEqual({ inlineThinking: { tag: 'think' } })
    // 用户说「这个模型没有内嵌思考」⇒ `{}` 就是它，认下的那些也压得住
    expect(resolveModelTraits(model, {}, learned)).toEqual({})

    // 落到切分上：给 `{}` 之后，同一段回复**一个字都不切**（也不进探针）
    const { events, result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<think>不切</think>正文'), finishPart('stop')],
        model,
        {},
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, model),
        modelDelta(stamper, 'text', '<think>不切</think>正文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result).toMatchObject({ text: '<think>不切</think>正文', thinking: '' })
  })

  test('认的是**这一个模型名**——同线的另一个名字不跟着认（那是它的输出说了算）', () => {
    const learned = seen('acme-reasoner-v9')

    expect(learned.get('acme-reasoner-v9')).toBeDefined()
    expect(learned.get('acme-reasoner-v10')).toBeUndefined()
    expect(resolveModelTraits('acme-reasoner-v10', undefined, learned)).toBeUndefined()
  })

  test('已知标签**从表里现取**（不另立名单）——表里有的才认', () => {
    expect(knownInlineTags()).toEqual(['think'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 错误分档（技术方案 · 模型策略 · 错误分档）
// ═══════════════════════════════════════════════════════════════════════

function apiError(input: {
  message?: string
  statusCode?: number
  responseBody?: string
  isRetryable?: boolean
}): APICallError {
  return new APICallError({
    message: input.message ?? 'request failed',
    url: 'https://api.minimaxi.com/v1/chat/completions',
    requestBodyValues: {},
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.responseBody === undefined ? {} : { responseBody: input.responseBody }),
    ...(input.isRetryable === undefined ? {} : { isRetryable: input.isRetryable }),
  })
}

describe('错误分档', () => {
  test('瞬时：限流 / 上游故障 / 网络', () => {
    expect(classifyModelError(apiError({ statusCode: 429 }))).toBe('transient')
    expect(classifyModelError(apiError({ statusCode: 500 }))).toBe('transient')
    expect(classifyModelError(apiError({ statusCode: 503 }))).toBe('transient')
    expect(classifyModelError(apiError({ statusCode: 408 }))).toBe('transient')
    expect(classifyModelError(new TypeError('fetch failed'))).toBe('transient')
    expect(classifyModelError(new Error('socket hang up'))).toBe('transient')
    expect(classifyModelError(new Error('请求超时 timeout'))).toBe('transient')
    // 无状态码 + SDK 判可重试＝请求未落地
    expect(classifyModelError(apiError({ isRetryable: true }))).toBe('transient')
  })

  test('上下文超限：按特征判，压过 HTTP 码', () => {
    expect(
      classifyModelError(
        apiError({
          statusCode: 400,
          responseBody: '{"error":{"message":"the maximum context length is 200000 tokens"}}',
        }),
      ),
    ).toBe('context-limit')
    expect(classifyModelError(new Error('context_length_exceeded'))).toBe('context-limit')
    expect(
      classifyModelError(new Error('Prompt is too long: please reduce the length of your messages')),
    ).toBe('context-limit')
    // 即便上游把它包成 500，也不该退避重试——该压缩重发
    expect(
      classifyModelError(apiError({ statusCode: 500, message: 'context window exceeded' })),
    ).toBe('context-limit')
  })

  test('终态：内容策略 / 鉴权 / 缺 key / 看不懂', () => {
    expect(classifyModelError(apiError({ statusCode: 401, message: 'invalid api key' }))).toBe(
      'terminal',
    )
    expect(classifyModelError(apiError({ statusCode: 403 }))).toBe('terminal')
    expect(
      classifyModelError(
        apiError({ statusCode: 400, message: 'content violates our usage policy' }),
      ),
    ).toBe('terminal')
    expect(
      classifyModelError(new LoadAPIKeyError({ message: 'API key is missing' })),
    ).toBe('terminal')
    // 兜底取终态——看不懂就停下问人，不拿退避去撞
    expect(classifyModelError({ weird: true })).toBe('terminal')
    expect(classifyModelError(undefined)).toBe('terminal')
  })

  test('错误文本去重——message 已内嵌响应体时不重复拼（真端点实测的废话问题）', () => {
    const body = '{"error":{"message":"invalid params, unknown model (2013)"}}'
    const message = describeModelError(
      apiError({ statusCode: 400, message: `invalid params — ${body}`, responseBody: body }),
    )

    expect(message).toBe(`invalid params — ${body}`)
    // 响应体只出现一次（原样拼接会带三遍）
    expect(message.split('unknown model').length - 1).toBe(1)
  })

  test('中断判定：AbortError 与 abort 措辞', () => {
    const abort = new Error('This operation was aborted')
    abort.name = 'AbortError'
    expect(isAbortError(abort)).toBe(true)
    expect(isAbortError(new Error('The user aborted a request.'))).toBe(true)
    expect(isAbortError(new Error('Rate limit exceeded'))).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 密钥纪律（共享语言 · 配置形制：key 永不入记录 / 事件）
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = {
  baseURL: 'https://api.minimaxi.com/v1',
  model: MINIMAX_MODEL,
} as const

describe('密钥纪律', () => {
  test('缺 key 在构造期就报——消息给的是环境变量名，不是 key', () => {
    expect(() => createModelGateway({ providerId: 'minimax', config: CONFIG, env: {}, stamper: testStamper() })).toThrow(
      MissingApiKeyError,
    )

    try {
      createModelGateway({ providerId: 'minimax', config: CONFIG, env: {}, stamper: testStamper() })
    } catch (error) {
      const fault = error as MissingApiKeyError
      expect(fault.envVar).toBe('MAGIC_MINIMAX_API_KEY')
      expect(fault.message).toContain('MAGIC_MINIMAX_API_KEY')
      expect(fault.message).toContain('providers.minimax.apiKey')
    }
  })

  test('key 解析次序：显式 → 配置 → 环境变量', () => {
    expect(
      resolveApiKey({
        providerId: 'minimax',
        config: { ...CONFIG, apiKey: 'from-config' },
        explicit: 'from-explicit',
        env: { MAGIC_MINIMAX_API_KEY: 'from-env' },
      }),
    ).toBe('from-explicit')

    expect(
      resolveApiKey({
        providerId: 'minimax',
        config: { ...CONFIG, apiKey: 'from-config' },
        env: { MAGIC_MINIMAX_API_KEY: 'from-env' },
      }),
    ).toBe('from-config')

    expect(
      resolveApiKey({
        providerId: 'minimax',
        config: CONFIG,
        env: { MAGIC_MINIMAX_API_KEY: 'from-env' },
      }),
    ).toBe('from-env')

    // 空白视同缺省——回退链继续往下走
    expect(
      resolveApiKey({
        providerId: 'my-vendor',
        config: { ...CONFIG, apiKey: '   ' },
        env: { MAGIC_MY_VENDOR_API_KEY: 'from-env' },
      }),
    ).toBe('from-env')
  })

  test('脱敏：具体 key 与形似令牌的串都不留', () => {
    const secret = 'sk-live-abcdefghijklmnop'
    const text = `401 from https://api.minimaxi.com (Authorization: Bearer ${secret})`

    const redacted = redactSecrets(text, secret)
    expect(redacted).not.toContain(secret)
    expect(redacted).toContain('***')

    // 没有种子也要挡——形似令牌的串一律不留
    expect(redactSecrets('token sk-other-1234567890', undefined)).not.toContain('sk-other-1234567890')
  })

  test('错误消息里混进 key 也进不了事件', async () => {
    const secret = 'sk-live-abcdefghijklmnop'
    const stream = toKernelEvents(
      fromParts([
        { type: 'start' },
        { type: 'error', error: new Error(`bad auth header: Bearer ${secret}`) },
      ]),
      { model: MINIMAX_MODEL, secret, stamper: testStamper() },
    )

    const { events, result } = await drain(stream)
    const serialized = JSON.stringify(events)

    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('***')
    expect(result.error?.message).not.toContain(secret)
    expect(describeModelError(new Error(secret), secret)).toBe('***')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 中间件位（阶段 1：留位不展开）
// ═══════════════════════════════════════════════════════════════════════

describe('中间件位', () => {
  const trace: string[] = []

  /** 探针中间件——记录进出次序，顺带证明两个挂点都通。 */
  function probe(name: string, mark: string): ModelMiddleware {
    return {
      name,
      transformRequest: (request) => {
        trace.push(`request:${name}`)
        return { ...request, messages: [...request.messages, { role: 'system', content: mark }] }
      },
      transformEvents: async function* (events) {
        trace.push(`events-in:${name}`)
        yield* events
        trace.push(`events-out:${name}`)
      },
    }
  }

  const echoFetch = (): typeof globalThis.fetch =>
    (async () =>
      new Response(
        `data: ${JSON.stringify({
          id: '1',
          object: 'chat.completion.chunk',
          created: 1,
          model: MINIMAX_MODEL,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' } }],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: '1',
            object: 'chat.completion.chunk',
            created: 1,
            model: MINIMAX_MODEL,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof globalThis.fetch

  test('数组由外到内：请求方向先列先见，事件方向先列包住后列', async () => {
    trace.length = 0
    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch: echoFetch(),
      middleware: [probe('outer', '外层'), probe('inner', '内层')],
    })

    const { events } = await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(trace).toEqual([
      'request:outer',
      'request:inner',
      'events-in:outer',
      'events-in:inner',
      'events-out:inner',
      'events-out:outer',
    ])
    expect(events.at(-1)?.kind).toBe('model.call.end')
  })

  test('无中间件时事件原样通过', async () => {
    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch: echoFetch(),
    })

    const { events } = await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        // 预算**同一份解析**给两处：请求开始这一刻就带上（与下面的 usage 同一个数）
        modelCallStart(stamper, MINIMAX_MODEL, 'minimax', 1_000_000 - MAX_COMPLETION_TOKENS),
        modelDelta(stamper, 'text', 'ok'),
        modelCallEnd(stamper),
      ]),
    )
  })

  test('改写确实落到请求上（内层看见外层的产物）', async () => {
    let body: { messages: { role: string; content: unknown }[] } | undefined
    const capturingFetch = (async (_input: unknown, init?: { body?: unknown }) => {
      body = JSON.parse(String(init?.body)) as typeof body
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }) as unknown as typeof globalThis.fetch

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch: capturingFetch,
      middleware: [
        {
          name: 'rewrite',
          transformRequest: (request) => ({
            ...request,
            messages: [{ role: 'system', content: '改写过的系统提示' }, ...request.messages],
          }),
        },
      ],
    })

    // 流会因缺 finish_reason 而报错——此处只关心请求体
    await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(body?.messages[0]).toEqual({ role: 'system', content: '改写过的系统提示' })
    expect(body?.messages[1]).toEqual({ role: 'user', content: '嗨' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 五 · 假端点回环 —— 真格式 SSE，假 fetch（不经网络）
// ═══════════════════════════════════════════════════════════════════════

/** OpenAI 兼容的流式分片（真格式——取件层怎么解析真端点，就怎么解析这里）。 */
function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: MINIMAX_MODEL,
    ...payload,
  })}\n\n`
}

function sse(...chunks: string[]): Response {
  return new Response(`${chunks.join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

type Captured = { url: string; body: Record<string, unknown>; authorization: string | null }

function capture(reply: () => Response): { fetch: typeof globalThis.fetch; seen: Captured[] } {
  const seen: Captured[] = []
  const fake = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      authorization: new Headers(init?.headers as Record<string, string>).get('authorization'),
    })
    return reply()
  }) as unknown as typeof globalThis.fetch
  return { fetch: fake, seen }
}

describe('调用设置与容量（U41 返修）', () => {
  /** 一次 SSE 回环，把出站请求体与用量事件交回来。 */
  async function callOnce(
    config: Parameters<typeof createModelGateway>[0]['config'],
    model: string,
  ): Promise<{ body: Record<string, unknown>; window: number | undefined }> {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
      ),
    )
    const gateway = createModelGateway({
      providerId: 'ds',
      stamper: testStamper(),
      config,
      apiKey: 'test-key',
      fetch,
      env: {},
    })
    const { events } = await drain(
      gateway.stream({ model, messages: [{ role: 'user', content: '嗨' }] }),
    )
    return {
      body: seen[0]?.body as Record<string, unknown>,
      window: events.find((event) => event.kind === 'model.usage')?.data.contextWindow,
    }
  }

  test('用户对该精确模型的覆盖：输出上限进请求、并进**输入预算**（同口径）', async () => {
    // 首验反例的形状：联合窗口 10000 / 输出上限 2000 ⇒ 输入预算 8000
    const { body, window } = await callOnce(
      {
        vendor: 'deepseek',
        apiKey: 'test-key',
        modelOverrides: { known: { limits: { maxContextTokens: 10_000, maxOutputTokens: 2_000 } } },
      },
      'known',
    )

    expect(body['max_tokens']).toBe(2_000)
    // 「预留输出」真的减掉了：分母是**这次能装多少输入**，不是窗总量
    expect(window).toBe(8_000)
  })

  test('没有输出上限时，联合窗口为**本次实际请求的那个数**预留', async () => {
    const { body, window } = await callOnce(
      {
        vendor: 'deepseek',
        apiKey: 'test-key',
        modelOverrides: { known: { limits: { maxContextTokens: 10_000 } } },
      },
      'known',
    )

    // 请求仍带缺省那一个
    expect(body['max_tokens']).toBe(MAX_COMPLETION_TOKENS)
    // **分母也要减它**——独立复核否掉了上一轮「常量不算规格、所以不减」那条口径：
    // 「预留依据是**本次实际请求**，不是供应商最大输出规格是否已知；当前请求参数并非未知」。
    // 故 10000 的联合窗口剩 10000 − 4096。
    expect(window).toBe(10_000 - MAX_COMPLETION_TOKENS)
  })

  test('独立输入上限**不机械减去**输出上限（两者不是一回事）', async () => {
    const { window } = await callOnce(
      {
        vendor: 'deepseek',
        apiKey: 'test-key',
        modelOverrides: { known: { limits: { maxInputTokens: 5_000, maxOutputTokens: 2_000 } } },
      },
      'known',
    )

    expect(window).toBe(5_000)
  })

  test('**本次请求只解析一次规格**——出站上限与分母出自同一份（中途再变也不影响）', async () => {
    // 独立复核的真反例：出站按新的数、分母按旧的算，两者相加**超过窗口**。
    // 这里用「每次被查都返回不同规格」的 `modelInfoOf` 把病根逼出来：
    // 若实现**重复解析**，就会拿到不同的数（第二次 2000、第三次 3000……）。
    let looked = 0
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'ds',
      stamper: testStamper(),
      config: { vendor: 'deepseek', apiKey: 'test-key' },
      apiKey: 'test-key',
      fetch,
      env: {},
      modelInfoOf: (model) => {
        looked += 1
        return { id: model, limits: { maxContextTokens: 10_000, maxOutputTokens: 1_000 * looked } }
      },
    })

    const { events } = await drain(
      gateway.stream({ model: 'known', messages: [{ role: 'user', content: '嗨' }] }),
    )

    // **只解析一次**（那一趟里出站 / start / usage / 重试共用它）
    expect(looked).toBe(1)

    const body = seen[0]?.body as Record<string, unknown>
    const start = events.find((event) => event.kind === 'model.call.start')
    const usage = events.find((event) => event.kind === 'model.usage')

    // 三处是**同一个数**（第一份：联合 10000 − 输出 1000）
    expect(body['max_tokens']).toBe(1_000)
    expect(start?.kind === 'model.call.start' ? start.data.inputBudget : undefined).toBe(9_000)
    expect(usage?.kind === 'model.usage' ? usage.data.contextWindow : undefined).toBe(9_000)
  })

  test('**注册表建的网关也消费缓存给出的规格**——漏传那一处（按 provider 绑定）', async () => {
    // 独立复核的反例：`capacityOf` 拿得到缓存里的规格（8000），而 `gatewayFor` 建网关时
    // **没把它传下去** ⇒ 实际请求仍按取件层常量 4096 发、用量事件也没有分母。
    // 这一条走**注册表**那条路（不是直接 `createModelGateway`）：漏传正是漏在这一跳上。
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }),
      ),
    )

    // 缓存里那份资料：联合窗口 10_000、本模型输出 2_000 ⇒ 有效输入预算 8_000
    const spec = { id: 'known', limits: { maxContextTokens: 10_000, maxOutputTokens: 2_000 } }
    const registry = createModelRegistry({
      providers: { ds: { vendor: 'deepseek', apiKey: 'test-key' } },
      defaultProvider: 'ds',
      stamper: testStamper(),
      env: {},
      apiKeys: { ds: 'test-key' },
      fetch,
      modelInfoOf: (provider, model) => (provider === 'ds' && model === 'known' ? spec : undefined),
    })

    // 注册表那一格：**它本来就对**（漏的是往网关那一跳）
    expect(registry.capacityOf('ds', 'known')?.inputBudget).toBe(8_000)

    const { events } = await drain(
      registry.stream({ model: 'known', messages: [{ role: 'user', content: '嗨' }] }),
    )

    const body = seen[0]?.body as Record<string, unknown>
    const start = events.find((event) => event.kind === 'model.call.start')
    const usage = events.find((event) => event.kind === 'model.usage')

    // **实际出站**按缓存那份规格走（不是取件层那个常量）
    expect(body['max_tokens']).toBe(2_000)
    // 分母也同源（联合 10000 − 本次预留 2000）
    expect(start?.kind === 'model.call.start' ? start.data.inputBudget : undefined).toBe(8_000)
    expect(usage?.kind === 'model.usage' ? usage.data.contextWindow : undefined).toBe(8_000)
  })

  test('请求体改写**按适配分**：DeepSeek 用标准 `max_tokens`，兼容接入才走旧改写', async () => {
    // 返修：此前写的是 `adapter?.transformRequestBody ?? requestBody` —— DeepSeek 没定义
    // 就回退到了 MiniMax 的改写，`max_tokens` 被顶成 `max_completion_tokens`。
    const official = await callOnce({ vendor: 'deepseek', apiKey: 'test-key' }, 'deepseek-flash')
    expect(official.body['max_tokens']).toBe(MAX_COMPLETION_TOKENS)
    expect(official.body['max_completion_tokens']).toBeUndefined()

    // **反例**：兼容接入（没有适配）仍走原来那条 MiniMax 改写——旧能力不删
    const compatible = await callOnce(
      { baseURL: 'https://api.minimaxi.com/v1', apiKey: 'test-key', model: 'MiniMax-M3' },
      'MiniMax-M3',
    )
    expect(compatible.body['max_completion_tokens']).toBe(MAX_COMPLETION_TOKENS)
    expect(compatible.body['max_tokens']).toBeUndefined()
  })
})

describe('思考的工具往返（U41）', () => {
  /**
   * **DeepSeek 的思考模式要求回传**：带 tools 时，历史轮的 `reasoning_content`
   * 不回传就 400。判据落在**出站请求体**上——不是「我们记住了」，是「真发出去了」。
   */
  test('要求回传的那家：助手消息的思考进请求体（`reasoning_content`）', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'ds',
      stamper: testStamper(),
      config: { vendor: 'deepseek', apiKey: 'test-key' },
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    await drain(
      gateway.stream({
        model: 'deepseek-flash',
        messages: [
          { role: 'user', content: '读一下那个文件' },
          {
            role: 'assistant',
            content: '我看看',
            toolCalls: [{ id: 'call-1', name: 'read', args: { path: 'a.txt' } }],
            reasoning: '先看清路径再动手',
          },
          { role: 'tool', callId: 'call-1', name: 'read', ok: true, output: '内容' },
        ],
      }),
    )

    const sent = seen[0]?.body as { messages: readonly Record<string, unknown>[] }
    const assistant = sent.messages.find((one) => one['role'] === 'assistant')
    expect(assistant?.['reasoning_content']).toBe('先看清路径再动手')
    // 正文与调用照旧（思考只是**多带**一份，不改别的）
    expect(assistant?.['tool_calls']).toHaveLength(1)
  })

  test('**反例**：不要求回传的适配（兼容接入）一个字都不带', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ),
    )

    // 兼容接入（没有 `vendor`）——原协议原样：多出来的那一位**不转发**
    const gateway = createModelGateway({
      providerId: 'mm',
      stamper: testStamper(),
      config: { baseURL: 'https://api.minimaxi.com/v1', apiKey: 'test-key', model: 'MiniMax-M3' },
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    await drain(
      gateway.stream({
        model: 'MiniMax-M3',
        messages: [
          { role: 'user', content: '嗨' },
          {
            role: 'assistant',
            content: '我看看',
            toolCalls: [{ id: 'call-1', name: 'read', args: { path: 'a.txt' } }],
            reasoning: '上家模型想的事',
          },
          { role: 'tool', callId: 'call-1', name: 'read', ok: true, output: '内容' },
        ],
      }),
    )

    const sent = seen[0]?.body as { messages: readonly Record<string, unknown>[] }
    const assistant = sent.messages.find((one) => one['role'] === 'assistant')
    expect(assistant?.['reasoning_content']).toBeUndefined()
  })
})

describe('假端点回环 · 流式事件序列', () => {
  /**
   * D10 · 第 1 样——状态行 `12.4k/200k` 的**分母**：条目配置声明了窗长，就**随用量一起到**
   * （同一次调用、同一刻）；没声明，这一位**就不在**（拿不到就不显示，不编）。
   */
  test('窗长随用量一起出来——条目声明了才有（分母跟着分子走）', async () => {
    const sseReply = (): Response =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 12_400, completion_tokens: 40, total_tokens: 12_440 } }),
      )

    const declared = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      // 条目声明了窗长（配置加键——窗长的真来处，见 `ProviderConfig.contextWindow`）
      config: { ...CONFIG, contextWindow: 200_000 },
      apiKey: 'test-key',
      fetch: capture(sseReply).fetch,
      env: {},
    })

    const withWindow = await drain(
      declared.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )
    expect(withWindow.events.filter((event) => event.kind === 'model.usage').map((event) => event.data)).toEqual([
      { inputTokens: 12_400, outputTokens: 40, totalTokens: 12_440, cacheReadTokens: 0, reasoningTokens: 0, contextWindow: 195_904 },
    ])
    // 聚合结果**不动**——窗长是「这次调用之外」的东西，不是用量的一部分
    expect(withWindow.result.usage).toEqual({ inputTokens: 12_400, outputTokens: 40, totalTokens: 12_440, cacheReadTokens: 0, reasoningTokens: 0 })

    const silent = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG, // 没声明窗长
      apiKey: 'test-key',
      fetch: capture(sseReply).fetch,
      env: {},
    })

    const withoutWindow = await drain(
      silent.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )
    const usage = withoutWindow.events.find((event) => event.kind === 'model.usage')
    // **U41 改锚**：这一位以前「只有条目声明了才有」；现在说的是**有效容量**——
    // 用户声明 → 该家适配的缺项补充 → 未知（设计：「替换当前『内置表只供界面、事件容量
    // 只认配置』的分叉」「输入上限、预留输出与所显示分母须同口径」）。
    // MiniMax-M3 有官方窗长（该家适配的补充表），故**没声明也带着它**。
    expect(usage?.data).toEqual({ inputTokens: 12_400, outputTokens: 40, totalTokens: 12_440, cacheReadTokens: 0, reasoningTokens: 0, contextWindow: 995_904 })

    // **反例**（改了这处行为的对照）：**不在补充表里**的模型照旧**没有这一位**——
    // 「不知道就是不知道」那一半没松（app 的读数用例里那条「乙」是同一个反例）。
    const unknown = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch: capture(sseReply).fetch,
      env: {},
    })
    const unknownCall = await drain(
      unknown.stream({ model: 'some-unlisted-model', messages: [{ role: 'user', content: '嗨' }] }),
    )
    const unknownUsage = unknownCall.events.find((event) => event.kind === 'model.usage')
    expect('contextWindow' in (unknownUsage?.data ?? {})).toBe(false)
  })

  test('SSE → 取件层 → 归一：序列与聚合结果都对', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] }),
        chunk({ choices: [{ index: 0, delta: { content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: { reasoning_content: '简短想' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const { events, result } = await drain(
      gateway.stream({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: '你是 Magic Code' },
          { role: 'user', content: '打个招呼' },
        ],
      }),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        // 预算**同一份解析**给两处：请求开始这一刻就带上（与下面的 usage 同一个数）
        modelCallStart(stamper, MINIMAX_MODEL, 'minimax', 1_000_000 - MAX_COMPLETION_TOKENS),
        modelDelta(stamper, 'text', '你'),
        modelDelta(stamper, 'text', '好'),
        modelDelta(stamper, 'thinking', '简短想'),
        modelUsage(
          stamper,
          { inputTokens: 11, outputTokens: 5, totalTokens: 16, cacheReadTokens: 0, reasoningTokens: 0 },
          // **有效输入预算**（U41 返修）：M3 的联合窗口 1M 为本次输出（缺省 4096）预留后
          1_000_000 - MAX_COMPLETION_TOKENS,
        ),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.text).toBe('你好')
    expect(result.thinking).toBe('简短想')
    expect(result.finishReason).toBe('stop')
    expect(result.error).toBeUndefined()

    // 请求侧：端点 / 鉴权 / MiniMax 参数改写
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.minimaxi.com/v1/chat/completions')
    expect(seen[0]?.authorization).toBe('Bearer test-key')
    expect(seen[0]?.body.model).toBe(MINIMAX_MODEL)
    expect(seen[0]?.body.stream).toBe(true)
    // 已弃用的 max_tokens 不出现在请求体里，改用 max_completion_tokens
    expect(seen[0]?.body).not.toHaveProperty('max_tokens')
    expect(seen[0]?.body.max_completion_tokens).toBe(MAX_COMPLETION_TOKENS)
    expect(seen[0]?.body.stream_options).toEqual({ include_usage: true })
    // 系统消息经 instructions 汇入提示（SDK 不接受 messages 里的 system 角色），
    // 落到线上仍是首条 system 消息——段序不变
    expect(seen[0]?.body.messages).toEqual([
      { role: 'system', content: '你是 Magic Code' },
      { role: 'user', content: '打个招呼' },
    ])
  })

  test('多条系统消息按序拼成 instructions——段序即语义', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { content: 'ok' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    await drain(
      gateway.stream({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'system', content: '身份段' },
          { role: 'system', content: '工具段' },
          { role: 'user', content: '嗨' },
        ],
      }),
    )

    expect(seen[0]?.body.messages).toEqual([
      { role: 'system', content: '身份段\n\n工具段' },
      { role: 'user', content: '嗨' },
    ])
  })

  test('工具结果回填：tool 消息 → 线上 OpenAI 兼容形制', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({ choices: [{ index: 0, delta: { content: '好' } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    await drain(
      gateway.stream({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'user', content: '列目录' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'exec', args: { cmd: 'ls' } }],
          },
          // 共享语言的工具消息：`callId` 是**供应商侧**调用 id；工具名由上文的 assistant 消息推出
          { role: 'tool', callId: 'call_1', name: 'exec', ok: true, output: 'a.ts\nb.ts' },
        ],
      }),
    )

    expect(seen[0]?.body.messages).toEqual([
      { role: 'user', content: '列目录' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'exec', arguments: '{"cmd":"ls"}' },
          },
        ],
      },
      { role: 'tool', content: 'a.ts\nb.ts', tool_call_id: 'call_1' },
    ])
  })

  test('工具失败回填：ok=false → error-text（不是 text）', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    await drain(
      gateway.stream({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'user', content: '跑一下' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_9', name: 'exec', args: { cmd: 'nope' } }],
          },
          { role: 'tool', callId: 'call_9', name: 'exec', ok: false, output: 'command not found' },
        ],
      }),
    )

    expect(seen[0]?.body.messages).toEqual([
      { role: 'user', content: '跑一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_9', type: 'function', function: { name: 'exec', arguments: '{"cmd":"nope"}' } },
        ],
      },
      { role: 'tool', content: 'command not found', tool_call_id: 'call_9' },
    ])
  })

  test('工具调用：SSE 分片 → toolcall 增量 + 聚合出的工具请求', async () => {
    const { fetch, seen } = capture(() =>
      sse(
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'exec', arguments: '{"cmd":' } },
                ],
              },
            },
          ],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] },
            },
          ],
        }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } }),
      ),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const TOOLS: readonly ToolSpec[] = [
      {
        name: 'exec',
        summary: '在工作目录里执行命令',
        parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
        danger: { level: 'by-call', note: '按命令解析' },
      },
    ]

    const { events, result } = await drain(
      gateway.stream({
        model: MINIMAX_MODEL,
        messages: [{ role: 'user', content: '列一下目录' }],
        tools: TOOLS,
      }),
    )

    const toolcallNames = new Set<string | undefined>()
    const toolcallIds = new Set<string | undefined>()
    let toolcallDeltaCount = 0
    for (const event of events) {
      // 消费侧按 kind 自动收窄（不再需要显式 `as`）
      if (event.kind !== 'model.delta') continue
      if (event.data.channel !== 'toolcall') continue
      toolcallDeltaCount += 1
      toolcallNames.add(event.data.name)
      toolcallIds.add(event.data.id)
    }
    expect(toolcallDeltaCount).toBeGreaterThan(0)
    expect([...toolcallNames]).toEqual(['exec'])
    // toolcall 增量一律带**供应商侧调用 id**（渲染侧据以按调用分组）
    expect([...toolcallIds]).toEqual(['call_1'])

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'exec', args: { cmd: 'ls' } }])
    expect(result.finishReason).toBe('tool-calls')
    expect(events.at(-1)?.kind).toBe('model.call.end')

    // 工具定义确实送出去了（模型只出请求，执行不在接缝）
    const tools = seen[0]?.body.tools as { function: { name: string } }[] | undefined
    expect(tools?.[0]?.function.name).toBe('exec')
  })

  test('鉴权失败（401）→ 终态 model.error，且 key 不在事件里', async () => {
    const { fetch } = capture(
      () =>
        new Response(
          JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'sk-secret-abcdefghijklmnop',
      fetch,
      env: {},
    })

    const { events, result } = await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(events[0]?.kind).toBe('model.call.start')
    expect(events.at(-1)?.kind).toBe('model.error')
    expect(result.error?.tier).toBe('terminal')
    expect(JSON.stringify(events)).not.toContain('sk-secret-abcdefghijklmnop')
  })

  test('限流（429）→ 瞬时档（退避重试的判据）', async () => {
    const { fetch } = capture(
      () =>
        new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const { result } = await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(result.error?.tier).toBe('transient')
    expect(result.error?.message).toContain('rate limit')
  })

  test('环境变量回退——key 从 MAGIC_MINIMAX_API_KEY 取，落到鉴权头', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: { content: '嗨' } }] })),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      fetch,
      env: { MAGIC_MINIMAX_API_KEY: 'env-key-123' },
    })

    await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(seen[0]?.authorization).toBe('Bearer env-key-123')
  })

  test('模型名取自请求——配置的默认被请求覆盖（运行时切换的落点）', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const { events } = await drain(
      gateway.stream({ model: 'MiniMax-M4', messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(seen[0]?.body.model).toBe('MiniMax-M4')
    expect(events[0]?.kind).toBe('model.call.start')
    // 特征标记随请求的模型名裁定——表外模型不切（判据 ③）
    expect(events[0]).toMatchObject({ data: { model: 'MiniMax-M4' } })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 六 · 端口形态（契约 `ModelGateway` 与 Faux 的界面）
// ═══════════════════════════════════════════════════════════════════════

describe('端口形态', () => {
  test('事件构造子产出的 kind 与 data 与契约逐 kind 配对', () => {
    const stamper = testStamper()

    expect(payloads([modelCallStart(stamper, 'MiniMax-M3')])).toEqual([
      { kind: 'model.call.start', data: { model: 'MiniMax-M3' } },
    ])
    expect(payloads([modelDelta(stamper, 'text', '嗨')])).toEqual([
      { kind: 'model.delta', data: { channel: 'text', text: '嗨' } },
    ])
    expect(payloads([modelDelta(stamper, 'toolcall', '{}', 'exec', 'c1')])).toEqual([
      { kind: 'model.delta', data: { channel: 'toolcall', text: '{}', name: 'exec', id: 'c1' } },
    ])
    expect(payloads([modelUsage(stamper, { inputTokens: 1, outputTokens: 2 })])).toEqual([
      { kind: 'model.usage', data: { inputTokens: 1, outputTokens: 2 } },
    ])
    expect(payloads([modelCallEnd(stamper)])).toEqual([{ kind: 'model.call.end', data: {} }])
    expect(payloads([modelErrorEvent(stamper, 'terminal', '停了')])).toEqual([
      { kind: 'model.error', data: { tier: 'terminal', message: '停了' } },
    ])
  })

  test('构造面即信封——信封四件由**注入的铸造器**盖（模型域不自造）', () => {
    const stamper = testStamper('sess-1', 7)
    const first = modelCallStart(stamper, MINIMAX_MODEL)
    const second = modelCallEnd(stamper)

    expect(first.session).toBe('sess-1')
    expect(first.turn).toBe(7)
    expect(first.at).toBe(1_700_000_000_000)
    expect(second.id).toBeGreaterThan(first.id)
  })

  test('信封归产出方铸——装配注入的铸造器说了算（换一个即换一套信封）', async () => {
    const { fetch } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: { content: '嗨' } }] })),
    )

    const injected = testStamper('session-of-assembly', 42)
    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: injected,
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const { events } = await drain(
      gateway.stream({ model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] }),
    )

    // 每一条事件都盖着装配给的那一套——含首条与末条
    for (const event of events) {
      expect(event).toMatchObject({ session: 'session-of-assembly', turn: 42 })
    }
    // 模型域**不调** `beginTurn`（锚定：轮起止由对话域调）
    expect(injected.turns).toEqual([])
  })

  test('Faux 可直接实现 ModelGateway（U12 的界面）', async () => {
    const stamper = testStamper()

    async function* scripted(): AsyncIterable<KernelEvent> {
      yield modelCallStart(stamper, 'faux')
      yield modelDelta(stamper, 'text', '假的')
      yield modelCallEnd(stamper)
    }

    const faux: ModelGateway = {
      stream(): ModelStream {
        return {
          events: scripted(),
          result: Promise.resolve({
            model: 'faux',
            text: '假的',
            thinking: '',
            toolCalls: [],
            usage: undefined,
            finishReason: 'stop',
            error: undefined,
            aborted: false,
            complete: true,
          } satisfies ModelCallResult),
        }
      },
    }

    const { events } = await drain(faux.stream({ model: 'faux', messages: [] }))
    expect(payloads(events)).toEqual(
      payloads([modelCallStart(stamper, 'faux'), modelDelta(stamper, 'text', '假的'), modelCallEnd(stamper)]),
    )
  })

  test('消费者按契约端口取用——只见 stream(req, opts) → { events; result }', () => {
    // 类型层面：`createModelGateway` 的返回可赋给契约端口（`@magic/contracts` 的 `ModelGateway`）
    const gateway = createModelGateway({ providerId: 'minimax', config: CONFIG, apiKey: 'k', env: {}, stamper: testStamper() })
    const stream = gateway.stream(
      { model: MINIMAX_MODEL, messages: [{ role: 'user', content: '嗨' }] },
      { signal: new AbortController().signal },
    )

    expect(typeof stream.events[Symbol.asyncIterator]).toBe('function')
    expect(stream.result).toBeInstanceOf(Promise)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 七 · 消息装配（共享语言 `ModelMessage` 的判别联合）
// ═══════════════════════════════════════════════════════════════════════

describe('消息装配', () => {
  test('四支判别联合按 role 收窄——system / user / assistant / tool', async () => {
    const { fetch } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    const gateway = createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })

    const messages: ModelMessage[] = [
      { role: 'system', content: '段一' },
      { role: 'user', content: '嗨' },
      { role: 'assistant', content: '在', toolCalls: [{ id: 'c1', name: 'ls', args: {} }] },
      { role: 'tool', callId: 'c1', name: 'ls', ok: true, output: 'a.ts' },
    ]

    const { events } = await drain(gateway.stream({ model: MINIMAX_MODEL, messages }))

    expect(events.at(-1)?.kind).toBe('model.call.end')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 八 · 图片输入（U37）——**真请求体里的那些字节**
// ═══════════════════════════════════════════════════════════════════════

/**
 * 判据落在**出站请求体**上（不是「内核侧构造了个部件」）：供应商真正收到的是
 * `image_url` 里那段数据 URL——把它解回来与送出去的字节逐字节比。
 *
 * 由头（工单的完成出口）：「文字配图和纯图片输入均能**实际送达**模型」——
 * 只验内核侧形态的话，取件层把图丢了也照样绿。
 */
describe('U37 · 图片输入：出站请求体里的图像部件', () => {
  /** 一段**认得出是图片**的字节（PNG 魔数 ＋ 后面几个字节——本层不判完整性，那在执行域）。 */
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

  function gatewayWith(fetch: typeof globalThis.fetch) {
    return createModelGateway({
      providerId: 'minimax',
      stamper: testStamper(),
      config: CONFIG,
      apiKey: 'test-key',
      fetch,
      env: {},
    })
  }

  /** 出站那一格 `content`（OpenAI 兼容里用户消息可以是字符串或部件数组）。 */
  type WireContent = string | readonly Record<string, unknown>[]

  function userContentOf(body: Record<string, unknown>, index = 0): WireContent | undefined {
    const messages = body['messages'] as readonly Record<string, unknown>[] | undefined

    return messages?.[index]?.['content'] as WireContent | undefined
  }

  test('纯图片：出站是一个 `image_url` 部件，数据 URL 里就是那些字节', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    await drain(
      gatewayWith(fetch).stream({
        model: MINIMAX_MODEL,
        messages: [
          { role: 'user', content: [{ type: 'image', mime: 'image/png', data: PNG }] },
        ],
      }),
    )

    const content = userContentOf(seen[0]?.body ?? {})
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return

    const image = content.find((part) => part['type'] === 'image_url')
    expect(image).toBeDefined()
    const url = (image?.['image_url'] as { url?: string } | undefined)?.url ?? ''
    expect(url.startsWith('data:image/png;base64,')).toBe(true)

    // **逐字节对得上**——解回来与送出去的同一串
    const decoded = new Uint8Array(Buffer.from(url.slice('data:image/png;base64,'.length), 'base64'))
    expect([...decoded]).toEqual([...PNG])
  })

  test('文字配图：文字与图片**按用户排的次序**出站', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    await drain(
      gatewayWith(fetch).stream({
        model: MINIMAX_MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '看这张图 @报错.png' },
              { type: 'text', text: '〔本次材料 · 图片 报错.png〕' },
              { type: 'image', mime: 'image/png', data: PNG },
              { type: 'text', text: '是什么问题？' },
            ],
          },
        ],
      }),
    )

    const content = userContentOf(seen[0]?.body ?? {})
    expect(Array.isArray(content)).toBe(true)
    if (!Array.isArray(content)) return

    // 次序照旧：文字 → 文字 → 图 → 文字（图片在它被说出来的那个位置）
    expect(content.map((part) => part['type'])).toEqual(['text', 'text', 'image_url', 'text'])
    expect(content[0]?.['text']).toBe('看这张图 @报错.png')
    expect(content[3]?.['text']).toBe('是什么问题？')
  })

  test('纯文字照旧是一个字符串（加图片那一支之前逐字同形）', async () => {
    const { fetch, seen } = capture(() =>
      sse(chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    )

    await drain(
      gatewayWith(fetch).stream({
        model: MINIMAX_MODEL,
        messages: [{ role: 'user', content: '就一句话' }],
      }),
    )

    expect(userContentOf(seen[0]?.body ?? {})).toBe('就一句话')
  })
})
