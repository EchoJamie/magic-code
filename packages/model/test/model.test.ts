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
  createModelGateway,
  describeModelError,
  isAbortError,
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
): ModelStream {
  return toKernelEvents(fromParts(parts), {
    model,
    stamper: testStamper(),
    traits: resolveModelTraits(model, override),
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
        modelUsage(stamper, 12, 3),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.text).toBe('你好')
    expect(result.thinking).toBe('')
    expect(result.toolCalls).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
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

    expect(payloads(events)).toContainEqual(bare(modelUsage(testStamper(), 7, 2)))
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
        modelUsage(stamper, 30, 10),
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
        modelUsage(stamper, 9, 4),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('想想')
    expect(result.text).toBe('\n\n正文')
    // 标签不出现在任何通道的增量里
    expect(JSON.stringify(payloads(events))).not.toContain('think>')
  })

  test('内置表确有那两条（按模型名匹配，不是按供应商）', () => {
    expect(resolveModelTraits(MINIMAX_MODEL)).toEqual({ inlineThinking: { tag: 'think' } })
    // 第 18 轮补锚：M2 同样内嵌正文（第 17 轮真跑暴露，屏上曾看得见裸标签）
    expect(resolveModelTraits('MiniMax-M2')).toEqual({ inlineThinking: { tag: 'think' } })
    // 表外（同家的其余变体 / 别家）＝常规行为：不猜、不切
    expect(resolveModelTraits('MiniMax-M2.7')).toBeUndefined()
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
  /** 判据 ③——不猜、不切：正文原样走 text。 */
  test('表外模型无标注 → 正文原样走 text，标签也不动（判据 ③）', async () => {
    const { events, result } = await drain(
      normalize(
        [{ type: 'start' }, textDelta('<think>想想</think>\n\n正文'), finishPart('stop')],
        'gpt-4o',
      ),
    )

    const stamper = testStamper()
    expect(payloads(events)).toEqual(
      payloads([
        modelCallStart(stamper, 'gpt-4o'),
        modelDelta(stamper, 'text', '<think>想想</think>\n\n正文'),
        modelCallEnd(stamper),
      ]),
    )
    expect(result.thinking).toBe('')
    expect(result.text).toBe('<think>想想</think>\n\n正文')
    expect(resolveModelTraits('gpt-4o')).toBeUndefined()
  })

  test('切分**不是接缝通例**——同一段文本，常规模型原样、命中标记才切', async () => {
    const parts = [{ type: 'start' } as Part, textDelta('<think>x</think>y'), finishPart('stop')]

    const plain = await drain(normalize(parts, 'gpt-4o'))
    const inline = await drain(normalize(parts, MINIMAX_MODEL))

    expect(plain.result.text).toBe('<think>x</think>y')
    expect(plain.result.thinking).toBe('')
    expect(inline.result.text).toBe('y')
    expect(inline.result.thinking).toBe('x')
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
        modelCallStart(stamper, MINIMAX_MODEL, 'minimax'), // 条目名随事件上报（第 17 轮）
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
      { inputTokens: 12_400, outputTokens: 40, contextWindow: 200_000 },
    ])
    // 聚合结果**不动**——窗长是「这次调用之外」的东西，不是用量的一部分
    expect(withWindow.result.usage).toEqual({ inputTokens: 12_400, outputTokens: 40 })

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
    expect(usage?.data).toEqual({ inputTokens: 12_400, outputTokens: 40 })
    expect('contextWindow' in (usage?.data ?? {})).toBe(false)
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
        modelCallStart(stamper, MINIMAX_MODEL, 'minimax'), // 条目名随事件上报（第 17 轮）
        modelDelta(stamper, 'text', '你'),
        modelDelta(stamper, 'text', '好'),
        modelDelta(stamper, 'thinking', '简短想'),
        modelUsage(stamper, 11, 5),
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
    expect(payloads([modelUsage(stamper, 1, 2)])).toEqual([
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
