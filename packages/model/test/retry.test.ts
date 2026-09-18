/**
 * U17 · 退避重试 —— 错误分档的**瞬时档处置**（技术方案 · 模型策略 · 错误分档）。
 *
 * 三层，都不经真网络：
 * 1. **接缝内部**——直接喂假的取件层流（`VendorStreamPart`），钉住「未定局才重试」的
 *    三个位置：块不重复吐、延迟按退避走、给不出可重试的理由就原样上报；
 * 2. **判据**——策略归一 / `Retry-After` / 中断不重试（纯函数级）；
 * 3. **假端点回环**——给网关注入假 fetch：429 回放 → 重试 → 成功；终态 / 超限 /
 *    中途断流 → **只打一次**。判据是「打了几次」＋「内核看见什么」。
 *
 * 判据的两面（缺一不可）：
 * - **该重试的重试了**——请求数 > 1，且内核只看见最终那一次（没有多余的 `call.start`）；
 * - **不该重试的没重试**——请求数 === 1（终态 / 超限 / 已定局），错误照原样上报。
 */

import { describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'
import type { TextStreamPart, ToolSet } from 'ai'
import { drainStream, makeTestStamper } from '@magic/faux'
import type { KernelEvent } from '@magic/contracts'
import type { ModelGatewayOptions, RetryPolicy, Sleeper } from '../src/index.ts'
import { DEFAULT_RETRY_POLICY, createModelGateway } from '../src/index.ts'
import type { VendorStreamer } from '../src/ai-sdk.ts'
import type { VendorStreamPart } from '../src/normalize.ts'
import { retryAfterMsOf, withTransientRetry } from '../src/retry.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════════════

type Part = TextStreamPart<ToolSet>

const CONFIG = { baseURL: 'https://api.minimaxi.com/v1', model: 'MiniMax-M3' } as const

/** 每次尝试的延迟记账——注入 `sleep` 用（测试不真等）。 */
function recorder(): { readonly delays: number[]; readonly sleep: Sleeper } {
  const delays: number[] = []
  return {
    delays,
    sleep: (delayMs: number) => {
      delays.push(delayMs)
      return Promise.resolve()
    },
  }
}

/** 一次 429（限流）——分档判据是状态码，故响应体不必讲究。 */
function tooManyRequests(retryAfterSeconds?: number): Response {
  return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
    status: 429,
    headers: {
      'content-type': 'application/json',
      ...(retryAfterSeconds === undefined ? {} : { 'retry-after': String(retryAfterSeconds) }),
    },
  })
}

function chunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: CONFIG.model,
    ...payload,
  })}\n\n`
}

function sse(...chunks: string[]): Response {
  return new Response(`${chunks.join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** 一路顺风的回复——正文 `ok` 然后收束。 */
function okResponse(text = 'ok'): Response {
  return sse(
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  )
}

/**
 * 半途断流——先吐两段正文，**再**让底层流炸掉（「已定局」那一档的现场）。
 *
 * `pull` 驱动（不是 `setTimeout`）：前两拉给正文、第三拉报错——不靠时序赌运气。
 * 两拉是**量出来的**：取件层要拉够才把首个增量交出来（一拉时它还在攒）。
 */
function breaksMidway(): Response {
  const encoder = new TextEncoder()
  let pulls = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1
      if (pulls <= 2) {
        controller.enqueue(
          encoder.encode(chunk({ choices: [{ index: 0, delta: { content: '半截' } }] })),
        )
        return
      }
      controller.error(new Error('connection reset by peer'))
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** 假端点——按**第几次请求**回放（`replies[n]`；越界即一路顺风）。同时记下请求数。 */
function endpoint(replies: readonly Response[]): {
  readonly fetch: typeof globalThis.fetch
  readonly requests: { url: string; body: Record<string, unknown>; authorization: string | null }[]
} {
  const requests: { url: string; body: Record<string, unknown>; authorization: string | null }[] = []

  const fake = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const reply = replies[requests.length] ?? okResponse()
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      authorization: new Headers(init?.headers as Record<string, string>).get('authorization'),
    })
    return reply
  }) as unknown as typeof globalThis.fetch

  return { fetch: fake, requests }
}

function gatewayWith(
  endpointFetch: typeof globalThis.fetch,
  extra: Partial<ModelGatewayOptions> = {},
): ReturnType<typeof createModelGateway> {
  return createModelGateway({
    providerId: 'minimax',
    config: CONFIG,
    apiKey: 'test-key',
    env: {},
    stamper: makeTestStamper(),
    fetch: endpointFetch,
    ...extra,
  })
}

function kindsOf(events: readonly KernelEvent[]): string[] {
  return events.map((event) => event.kind)
}

/** 一个假的取件层流——直接构造 `VendorStreamPart` 序列（接缝内部用例用）。 */
function scripted(parts: readonly Part[]): VendorStreamer {
  return function stream(): AsyncIterable<VendorStreamPart> {
    return (async function* () {
      for (const part of parts) yield part
    })()
  }
}

async function pullAll(stream: AsyncIterable<VendorStreamPart>): Promise<VendorStreamPart[]> {
  const seen: VendorStreamPart[] = []
  for await (const part of stream) seen.push(part)
  return seen
}

const startPart: Part = { type: 'start' }
const textPart = (text: string): Part => ({ type: 'text-delta', id: 't0', text })

// ═══════════════════════════════════════════════════════════════════════
// 一 · 接缝内部：未定局才重试（块不重复 / 不丢）
// ═══════════════════════════════════════════════════════════════════════

describe('退避重试 · 接缝内部', () => {
  test('未定局就失败 → 整次尝试丢弃重来（攒着的块不重复吐）', async () => {
    const attempts: number[] = []
    let call = 0

    const streamer: VendorStreamer = () => {
      call += 1
      return call === 1
        ? (async function* (): AsyncGenerator<VendorStreamPart> {
            yield startPart
            throw new Error('fetch failed')
          })()
        : (async function* (): AsyncGenerator<VendorStreamPart> {
            yield startPart
            yield textPart('好的')
          })()
    }

    const parts = await pullAll(
      withTransientRetry(streamer, {
        sleep: () => Promise.resolve(),
        onAttempt: (attempt) => attempts.push(attempt),
      })({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(call).toBe(2)
    expect(attempts).toEqual([1, 2])
    // 第一次尝试的 `start` 被丢弃——吐出来的只有第二次那一遍，不重复
    expect(parts.map((part) => part.type)).toEqual(['start', 'text-delta'])
    expect(parts[1]).toMatchObject({ type: 'text-delta', text: '好的' })
  })

  test('已定局后失败 → 照原样上报，不重来（半截正文不拼接）', async () => {
    let call = 0
    const streamer: VendorStreamer = () => {
      call += 1
      return (async function* (): AsyncGenerator<VendorStreamPart> {
        yield startPart
        yield textPart('半截')
        throw new Error('fetch failed')
      })()
    }

    const chunks: VendorStreamPart[] = []
    let failure: unknown

    try {
      for await (const part of withTransientRetry(streamer, {
        sleep: () => Promise.resolve(),
      })({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] })) {
        chunks.push(part)
      }
    } catch (error) {
      failure = error
    }

    expect(call).toBe(1)
    expect(chunks.map((part) => part.type)).toEqual(['start', 'text-delta'])
    expect((failure as Error).message).toBe('fetch failed')
  })

  test('不重试的那一档也把攒着的块吐完（`error` 块原样交出去）', async () => {
    const errorPart = { type: 'error', error: new Error('content policy violation') } as Part
    const streamer: VendorStreamer = () =>
      (async function* (): AsyncGenerator<VendorStreamPart> {
        yield startPart
        yield errorPart
      })()

    const parts = await pullAll(
      withTransientRetry(streamer, { sleep: () => Promise.resolve() })({
        model: CONFIG.model,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    )

    expect(parts.map((part) => part.type)).toEqual(['start', 'error'])
  })

  test('退避节奏：指数 ＋ 上限（打满即停，最后一次的错照抛）', async () => {
    const policy: RetryPolicy = { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 }
    const slept = recorder()

    let call = 0
    const streamer: VendorStreamer = () => {
      call += 1
      return (async function* (): AsyncGenerator<VendorStreamPart> {
        throw new Error('rate limit exceeded')
      })()
    }

    let failure: unknown
    try {
      await pullAll(
        withTransientRetry(streamer, { policy, sleep: slept.sleep })({
          model: CONFIG.model,
          messages: [{ role: 'user', content: '嗨' }],
        }),
      )
    } catch (error) {
      failure = error
    }

    expect(call).toBe(4)
    // 100 → 200 → 250（第三次触到上限）
    expect(slept.delays).toEqual([100, 200, 250])
    expect((failure as Error).message).toBe('rate limit exceeded')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 判据（纯函数级）
// ═══════════════════════════════════════════════════════════════════════

describe('退避重试 · 判据', () => {
  test('缺省策略：3 次、800ms 起步、8s 封顶（单用户 CLI 的尺度）', () => {
    expect(DEFAULT_RETRY_POLICY).toEqual({ maxAttempts: 3, baseDelayMs: 800, maxDelayMs: 8_000 })
  })

  test('`Retry-After` 只认整数秒——HTTP-date 与乱写一律当没给', () => {
    const withHeader = (headers: Record<string, string> | undefined): APICallError =>
      new APICallError({
        message: 'rate limit reached',
        url: 'https://api.minimaxi.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
        ...(headers === undefined ? {} : { responseHeaders: headers }),
      })

    expect(retryAfterMsOf(withHeader({ 'retry-after': '2' }))).toBe(2_000)
    expect(retryAfterMsOf(withHeader({ 'retry-after': '0' }))).toBeUndefined()
    // HTTP-date 那一形不认识——当没给（退回指数退避，不猜日期）
    expect(
      retryAfterMsOf(withHeader({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })),
    ).toBeUndefined()
    expect(retryAfterMsOf(withHeader({}))).toBeUndefined()
    expect(retryAfterMsOf(withHeader(undefined))).toBeUndefined()
    // 不是 `APICallError` 就没有响应头可读——判据只在真错误对象上生效
    expect(retryAfterMsOf(Object.assign(new Error('rate limit'), { statusCode: 429 }))).toBeUndefined()
    expect(retryAfterMsOf(undefined)).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 假端点回环：该重试的重试、不该重试的一次都不多打
// ═══════════════════════════════════════════════════════════════════════

describe('退避重试 · 假端点回环', () => {
  test('限流（429）→ 退避重试 → 成了：内核只看见一次干净调用（判据：瞬时档）', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([tooManyRequests(), okResponse('重试之后成了')])

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({
        model: CONFIG.model,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    )

    expect(requests).toHaveLength(2)
    expect(slept.delays).toEqual([DEFAULT_RETRY_POLICY.baseDelayMs])
    // 事件序列＝一次干净调用：没有 model.error、没有第二个 call.start
    expect(kindsOf(events)).toEqual(['model.call.start', 'model.delta', 'model.call.end'])
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('重试之后成了')
    expect(result.attempts).toBe(2)
  })

  test('一路顺风时 attempts 为 1（计数如实，不虚报重试）', async () => {
    const { fetch, requests } = endpoint([okResponse('一次就好')])
    const { result } = await drainStream(
      gatewayWith(fetch).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(1)
    expect(result.attempts).toBe(1)
  })

  test('429 反复 → 打满次数即停下报告（不无限撞）', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([tooManyRequests(), tooManyRequests(), tooManyRequests()])

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(DEFAULT_RETRY_POLICY.maxAttempts)
    expect(slept.delays).toEqual([800, 1_600])
    expect(kindsOf(events).at(-1)).toBe('model.error')
    expect(result.error?.tier).toBe('transient')
    expect(result.attempts).toBe(3)
    // 不变式 ④：出错即终结——其后没有 call.end
    expect(kindsOf(events)).not.toContain('model.call.end')
  })

  test('终态（内容策略）→ **不重试**，停下报告用户', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([
      new Response(
        JSON.stringify({ error: { message: 'content violates our usage policy' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
      okResponse('不该走到这里'),
    ])

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(1)
    expect(slept.delays).toEqual([])
    expect(kindsOf(events).at(-1)).toBe('model.error')
    expect(result.error?.tier).toBe('terminal')
    expect(result.error?.message).toContain('usage policy')
    expect(result.attempts).toBe(1)
  })

  test('上下文超限 → **不重试**（留位：压缩重发归阶段 3 · U19）', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([
      new Response(
        JSON.stringify({ error: { message: 'the maximum context length is 200000 tokens' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
      okResponse('不该走到这里'),
    ])

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(1)
    expect(slept.delays).toEqual([])
    expect(result.error?.tier).toBe('context-limit')
    expect(kindsOf(events).at(-1)).toBe('model.error')
  })

  test('流到一半断了 → 不重试（半截正文已经在手，重来＝拼接两次回答）', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([breaksMidway(), okResponse('不该走到这里')])

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(1)
    expect(slept.delays).toEqual([])
    // 半截正文照旧入内核（流式就是这样——已出的收不回），错误另发一条
    expect(result.text).toBe('半截半截')
    expect(result.error !== undefined).toBe(true)
    expect(kindsOf(events).at(-1)).toBe('model.error')
  })

  test('网络故障（请求根本没落地）→ 退避重试', async () => {
    const slept = recorder()
    let call = 0
    const flaky = (async () => {
      call += 1
      if (call === 1) throw new TypeError('fetch failed')
      return okResponse('第二次通了')
    }) as unknown as typeof globalThis.fetch

    const { result } = await drainStream(
      gatewayWith(flaky, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(call).toBe(2)
    expect(slept.delays).toEqual([DEFAULT_RETRY_POLICY.baseDelayMs])
    expect(result.error).toBeUndefined()
    expect(result.text).toBe('第二次通了')
    expect(result.attempts).toBe(2)
  })

  test('`maxAttempts: 1` ＝ 关掉重试（要关就说 1，不加开关）', async () => {
    const { fetch, requests } = endpoint([tooManyRequests(), okResponse('不该走到这里')])

    const { result } = await drainStream(
      gatewayWith(fetch, { retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 } }).stream({
        model: CONFIG.model,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    )

    expect(requests).toHaveLength(1)
    expect(result.error?.tier).toBe('transient')
    expect(result.attempts).toBe(1)
  })

  test('退避期间的等待可被中断——中断不是错误，静默收场（不再打第二次）', async () => {
    const controller = new AbortController()
    const { fetch, requests } = endpoint([tooManyRequests(), okResponse('不该走到这里')])

    // 真 sleep 的中断行为：信号一响即以 AbortError 收场（此处不真等，直接照做）
    const abortingSleep: Sleeper = (_delayMs, signal) => {
      controller.abort()
      expect(signal?.aborted).toBe(true)
      const error = new Error('重试等待被中断')
      error.name = 'AbortError'
      return Promise.reject(error)
    }

    const { events, result } = await drainStream(
      gatewayWith(fetch, { sleep: abortingSleep }).stream(
        { model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] },
        { signal: controller.signal },
      ),
    )

    expect(requests).toHaveLength(1)
    expect(kindsOf(events)).toEqual(['model.call.start'])
    expect(result.aborted).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('`Retry-After` 落到等待时长上（限流窗口照供应商说的等）', async () => {
    const slept = recorder()
    const { fetch, requests } = endpoint([tooManyRequests(2), okResponse('等够了')])

    const { result } = await drainStream(
      gatewayWith(fetch, { sleep: slept.sleep }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(requests).toHaveLength(2)
    expect(slept.delays).toEqual([2_000])
    expect(result.attempts).toBe(2)
  })

  test('`Retry-After` 长过上限 → 取上限（宁可早点停下报告，不把人晾在屏幕前）', async () => {
    const slept = recorder()
    const { fetch } = endpoint([tooManyRequests(600), okResponse('等够了')])

    const { result } = await drainStream(
      gatewayWith(fetch, {
        sleep: slept.sleep,
        retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1_500 },
      }).stream({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(slept.delays).toEqual([1_500])
    expect(result.attempts).toBe(2)
  })

  test('不通就抛——策略不合法在**构造期**报（不等到半夜重试时才现形）', () => {
    expect(() =>
      createModelGateway({
        providerId: 'minimax',
        config: CONFIG,
        apiKey: 'k',
        env: {},
        stamper: makeTestStamper(),
        retry: { maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 100 },
      }),
    ).toThrow(/maxAttempts/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 脚本化的接缝流（`VendorStreamPart` 直喂——重试在归一之下）
// ═══════════════════════════════════════════════════════════════════════

describe('退避重试 · 与归一的接缝', () => {
  test('重试发生在归一之下——事件流里看不出重试（只有结果上的计数）', async () => {
    // 取件层流两段脚本：第一段（`start` ＋ 掉线）走不通，第二段吐出正文
    let call = 0
    const scriptedGate: VendorStreamer = () => {
      call += 1
      return call === 1
        ? (async function* (): AsyncGenerator<VendorStreamPart> {
            yield startPart
            throw new Error('socket hang up')
          })()
        : (async function* (): AsyncGenerator<VendorStreamPart> {
            yield startPart
            yield textPart('重来之后')
            yield {
              type: 'finish',
              finishReason: 'stop',
              rawFinishReason: 'stop',
              totalUsage: {
                inputTokens: 3,
                inputTokenDetails: {},
                outputTokens: 2,
                outputTokenDetails: {},
                totalTokens: 5,
              },
            } as Part
          })()
    }

    const parts = await pullAll(
      withTransientRetry(scriptedGate, { sleep: () => Promise.resolve() })({
        model: CONFIG.model,
        messages: [{ role: 'user', content: '嗨' }],
      }),
    )

    expect(call).toBe(2)
    expect(parts.map((part) => part.type)).toEqual(['start', 'text-delta', 'finish'])
  })

  test('脚本化的流走通了也照样是原样通过（无重试时不改一个块）', async () => {
    const parts = await pullAll(
      withTransientRetry(scripted([startPart, textPart('一'), textPart('二')]), {
        sleep: () => Promise.resolve(),
      })({ model: CONFIG.model, messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(parts.map((part) => part.type)).toEqual(['start', 'text-delta', 'text-delta'])
  })
})
