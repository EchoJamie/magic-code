#!/usr/bin/env bun
/**
 * 错误分档探针 —— **U17 的验收跑具**（技术方案 · 模型策略 · 错误分档）。
 *
 * 三档各跑一趟，**取件层与注册表都是真的**（真 AI SDK · 真归一 · 真退避）——
 * 只有「供应商那头」按需替换：
 *
 * ① **瞬时档 · 限流**——本地起一个真 socket 的服务端，第一拉回 429（带 `Retry-After`）、
 *    第二拉回真格式 SSE。判据：**真重试了**（服务端真收到两次请求）· 退避时长照做 ·
 *    内核只看得见一次干净调用（`model.call.start` … `model.call.end`，没有多余的 start/error）。
 * ② **瞬时档 · 网络**——把端点指到一个**没人听的端口**（接管即拒）。判据：连撞
 *    `maxAttempts` 次、每次之间真等（退避节奏），随后**停下报告**（`model.error{transient}`）。
 * ③ **终态档 · 真端点**——真 `~/.magic/config.json` 的 key 与端点，故意报一个**不存在的
 *    模型名**（供应商回 400）。判据：**只打一次**（不重试）、`model.error{terminal}`、
 *    随后收场——「停下报告用户」那一档的真端点实录。
 *
 * **上下文超限档**不在本轮（它要压缩，归阶段 3 · U19）——故本探针**不跑**它；
 * 该档「认得出、且不重试」由 `packages/model/test/retry.test.ts` 的假端点用例钉着。
 *
 * 跑法：`bun packages/app/scripts/model-probe.ts [--fast]`
 * （`--fast` ＝把退避压到 50ms 起步，只验次序不验时长）。
 */

import type { ModelErrorTier, ModelRequest, ProviderConfig } from '@magic/contracts'
import { createModelRegistry } from '@magic/model'
import type { RetryPolicy } from '@magic/model'
import { createStamper, loadConfig } from '../src/index.ts'

/** 请求形态——模型名**取自请求**（技术方案 · 配置与密钥）；各档按需改这一个字段。 */
function request(model: string): ModelRequest {
  return { model, messages: [{ role: 'user', content: '说一个字' }] }
}

const FAST = process.argv.includes('--fast')
const POLICY: RetryPolicy | undefined = FAST
  ? { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 500 }
  : undefined

// —— 小工具 ——

/** 探针用铸造器——不落库，故 id 本地数（装配的真路取自记录域 `nextId()`）。 */
function stamper(): ReturnType<typeof createStamper> {
  let next = 0
  return createStamper({
    records: { nextId: () => (next += 1) },
    session: 'model-probe',
    now: Date.now,
  })
}

function nowMs(): number {
  return Date.now()
}

/** 一趟探针的读数。 */
type Reading = {
  readonly requests: number
  readonly gapsMs: readonly number[]
  readonly kinds: readonly string[]
  readonly tier: ModelErrorTier | undefined
  readonly message: string | undefined
  readonly attempts: number | undefined
  readonly text: string
}

/** 跑一次模型调用——**调用方视角**：只有 `stream()`，分档与重试全在接缝之后。 */
async function call(
  config: ProviderConfig,
  options: {
    /** 请求里的模型名——缺省 `'probe'`（前两档的端点不看它）。 */
    readonly model?: string | undefined
    readonly fetch?: typeof globalThis.fetch
    readonly retry?: RetryPolicy
    /** 显式 key——缺省给个本地假 key（前两档的端点根本不看它）；真端点那档传配置里的。 */
    readonly apiKey?: string | undefined
    /** 环境变量来源——真端点那档要用（配置里没写 key 时回退环境变量）。 */
    readonly env?: Readonly<Record<string, string | undefined>> | undefined
  },
): Promise<Reading> {
  const registry = createModelRegistry({
    providers: { probe: config },
    defaultProvider: 'probe',
    stamper: stamper(),
    apiKeys: { probe: options.apiKey ?? 'probe-key' },
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  })

  const kinds: string[] = []
  let tier: ModelErrorTier | undefined
  let message: string | undefined

  const stream = registry.stream(request(options.model ?? 'probe'))
  for await (const event of stream.events) {
    kinds.push(event.kind)
    // 消费面：按 `kind` 自动收窄（契约的判别联合视图）
    if (event.kind === 'model.error') {
      tier = event.data.tier
      message = event.data.message
    }
  }

  const result = await stream.result
  return {
    requests: 0, // 由调用方按各自的账本填
    gapsMs: [],
    kinds,
    tier,
    message,
    attempts: result.attempts,
    text: result.text,
  }
}

function render(label: string, reading: Reading): void {
  const gaps = reading.gapsMs.map((ms) => `${ms}ms`).join(' · ') || '—'
  console.log(`\n${label}`)
  console.log(`  请求次数　${reading.requests}　　退避间隔　${gaps}`)
  console.log(`  事件序列　${reading.kinds.join(' → ')}`)
  console.log(
    `  分档　　　${reading.tier ?? '（无错）'}` +
      (reading.message === undefined ? '' : `　「${reading.message.slice(0, 80)}」`),
  )
  console.log(
    `  聚合结果　attempts=${reading.attempts ?? 1}　正文「${reading.text.slice(0, 40)}」`,
  )
}

// ═══════════════════════════════════════════════════════════════════════
// ① 瞬时档 · 限流（本地真 socket 回放 429 → 成功）
// ═══════════════════════════════════════════════════════════════════════

/** 真格式 SSE —— 取件层怎么解析真端点，就怎么解析这里。 */
function sse(text: string): Response {
  const frame = (payload: Record<string, unknown>): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-probe',
      object: 'chat.completion.chunk',
      created: Math.floor(nowMs() / 1000),
      model: 'probe',
      ...payload,
    })}\n\n`

  return new Response(
    frame({ choices: [{ index: 0, delta: { role: 'assistant', content: text } }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) +
      'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function probeRateLimit(): Promise<Reading> {
  const arrivals: number[] = []

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(): Response {
      arrivals.push(nowMs())
      if (arrivals.length === 1) {
        // 第一次：限流。`Retry-After: 1` —— 探针据此印证「照供应商说的等」
        return new Response(JSON.stringify({ error: { message: 'rate limit reached' } }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        })
      }
      return sse('到了')
    },
  })

  try {
    const reading = await call(
      { baseURL: `http://127.0.0.1:${server.port}/v1`, model: 'probe' },
      { retry: POLICY },
    )

    const gapsMs = arrivals.slice(1).map((at, index) => at - (arrivals[index] ?? at))
    return { ...reading, requests: arrivals.length, gapsMs }
  } finally {
    server.stop(true)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ② 瞬时档 · 网络（没人听的端口——连不上，撞满为止）
// ═══════════════════════════════════════════════════════════════════════

/** 拿一个**刚被释放**的端口——没人听，连上去即拒。 */
function deadEndpoint(): string {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = server.port
  server.stop(true)
  return `http://127.0.0.1:${port}/v1`
}

async function probeNetwork(): Promise<Reading> {
  const arrivals: number[] = []
  const countingFetch = (async (input: unknown, init?: unknown) => {
    arrivals.push(nowMs())
    return await globalThis.fetch(input as never, init as never)
  }) as unknown as typeof globalThis.fetch

  const reading = await call(
    { baseURL: deadEndpoint(), model: 'probe' },
    { fetch: countingFetch, retry: POLICY },
  )

  const gapsMs = arrivals.slice(1).map((at, index) => at - (arrivals[index] ?? at))
  return { ...reading, requests: arrivals.length, gapsMs }
}

// ═══════════════════════════════════════════════════════════════════════
// ③ 终态档 · 真端点（真 key · 真端点 · 一个不存在的模型名）
// ═══════════════════════════════════════════════════════════════════════

async function probeTerminal(): Promise<Reading> {
  const loaded = loadConfig()
  const { baseURL } = loaded.provider
  const model = 'MiniMax-No-Such-Model'

  console.log(`  （真端点 ${baseURL} · 模型 ${model} · key 取自${loaded.provider.apiKey ? '配置文件' : '环境变量'}）`)

  // key 只在装配层解析、只交给取件层——探针这几行也不打印它
  const reading = await call(
    { baseURL, model },
    { model, apiKey: loaded.provider.apiKey, retry: POLICY },
  )
  return { ...reading, requests: 1 }
}

// ═══════════════════════════════════════════════════════════════════════
// 跑
// ═══════════════════════════════════════════════════════════════════════

console.log('模型分档探针 —— 真取件层 ＋ 真归一 ＋ 真退避（供应商那头按需替换）')
if (FAST) console.log('（--fast：退避压到 50ms 起步——只验次序，不验时长）')

render('① 瞬时档 · 限流（本地 socket 回放 429 → 重试成功）', await probeRateLimit())
render('② 瞬时档 · 网络（没人听的端口——撞满即停下报告）', await probeNetwork())
console.log('\n  （③ 要打真端点，故放在最后）')
render('③ 终态档 · 真端点（不存在的模型名 → 400）', await probeTerminal())
