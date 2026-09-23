/**
 * U17 · 供应商注册表 —— 多供应商 ＋ **运行时切换**（技术方案 · 模型策略 · 切换）。
 *
 * 判据三层：
 * 1. **加一条目即多一个**——`providers` 加键即多一格（`list()` 读得出），各有各的
 *    端点 / key / 默认模型；
 * 2. **换模型＝换接缝下游**——`use()` 之后下一次 `stream()` 打到**另一个端点**上，
 *    且模型名按锚定走（切换前取自请求、切换后取选中）；**域外看不见任何切换动作**
 *    （调用方只反复 `stream()`，对话域 / 记录域一个字都不必改）；
 * 3. **切不动就不动**——未知条目 / 空请求 / 缺 key：`ok: false` ＋ 缘由，选中原样保留。
 *
 * 密钥纪律照旧：**key 只在造网关时解析**（此处按条目各解析一次），既不进事件也不进结果
 * ——「key 不进事件」那条由「两个条目用两把不同的 key」正面证。
 *
 * 都不经网络：假 fetch 按 URL 分流（真取件层怎么打真端点，就怎么打这里）。
 */

import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import type { ModelRegistry } from '../src/index.ts'
import { MissingApiKeyError, createModelRegistry } from '../src/index.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 两个条目（甲 / 乙），各在各的端点上
// ═══════════════════════════════════════════════════════════════════════

const ALPHA: ProviderConfig = { baseURL: 'https://alpha.example/v1', model: 'alpha-1' }
const BETA: ProviderConfig = { baseURL: 'https://beta.example/v1', model: 'beta-1' }

type Seen = { url: string; model: string; authorization: string | null }

/** 假端点——按 URL 认家（两家各有各的回复），同时记下每次请求。 */
function splitEndpoint(): { readonly fetch: typeof globalThis.fetch; readonly seen: Seen[] } {
  const seen: Seen[] = []

  const fake = (async (input: unknown, init?: { body?: unknown; headers?: unknown }) => {
    const url = String(input)
    const body = JSON.parse(String(init?.body)) as { model?: string }
    seen.push({
      url,
      model: String(body.model),
      authorization: new Headers(init?.headers as Record<string, string>).get('authorization'),
    })

    // 谁家的端点回谁家的名——「打对了家」因此可从正文里也看出来
    const who = url.includes('alpha.example') ? '甲' : '乙'
    return new Response(
      `data: ${JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: { role: 'assistant', content: who } }],
      })}\n\n` +
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n` +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }) as unknown as typeof globalThis.fetch

  return { fetch: fake, seen }
}

function registryOf(
  providers: Record<string, ProviderConfig>,
  options: Partial<Parameters<typeof createModelRegistry>[0]> = {},
): ModelRegistry {
  return createModelRegistry({
    providers,
    defaultProvider: 'alpha',
    stamper: makeTestStamper(),
    env: {},
    ...options,
  })
}

/** 发一次请求并取回结果（调用方视角：它只会 `stream()`）。 */
async function ask(
  registry: ModelRegistry,
  model: string,
): Promise<{ readonly text: string; readonly model: string }> {
  const { result } = await drainStream(
    registry.stream({ model, messages: [{ role: 'user', content: '嗨' }] }),
  )
  return { text: result.text, model: result.model }
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 注册：加一条目即多一个
// ═══════════════════════════════════════════════════════════════════════

describe('注册表 · 注册', () => {
  test('`providers` 有几条就有几格——id 与各自默认模型都读得出', () => {
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.list()).toEqual([
      { id: 'alpha', model: 'alpha-1' },
      { id: 'beta', model: 'beta-1' },
    ])
    expect(registry.defaultProviderId()).toBe('alpha')
    expect(registry.has('beta')).toBe(true)
    expect(registry.has('gamma')).toBe(false)
    // 未切换过——`selection()` 为空（＝走缺省条目、模型名取自请求）
    expect(registry.selection()).toBeUndefined()
  })

  test('形制不变：加条目只是加个键（同一家挂第二个模型也算）', () => {
    const registry = registryOf(
      { alpha: ALPHA, 'alpha-turbo': { ...ALPHA, model: 'alpha-turbo' } },
      { apiKeys: { alpha: 'ka', 'alpha-turbo': 'ka' } },
    )

    expect(registry.list().map((entry) => entry.id)).toEqual(['alpha', 'alpha-turbo'])
    expect(registry.has('alpha-turbo')).toBe(true)
  })

  /**
   * D10 · 第 1 样（窗长）与第 3 样（条目表）的**域内**那半——外壳看到的表就是从这儿出的。
   */
  test('窗长随条目带出来——**声明了才有**（不声明就不给这一位，不编）', () => {
    const registry = registryOf(
      {
        alpha: { ...ALPHA, contextWindow: 200_000 },
        // 乙没声明——两形对照
        beta: BETA,
      },
      { apiKeys: { alpha: 'ka', beta: 'kb' } },
    )

    const [first, second] = registry.list()
    expect(first).toEqual({ id: 'alpha', model: 'alpha-1', contextWindow: 200_000 })
    // 没声明＝**连键都没有**（不是 `undefined` 占位——外壳据「在不在」判「给不给分母」）
    expect(second).toEqual({ id: 'beta', model: 'beta-1' })
    expect('contextWindow' in (second ?? {})).toBe(false)
  })

  test('`current()`：未切换＝缺省条目 ＋ 它的默认模型；切换后跟着走', () => {
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { apiKeys: { alpha: 'ka', beta: 'kb' } })

    // 未切换——`selection()` 为空，但「此刻会走哪一条」是确定的（缺省那条）
    expect(registry.selection()).toBeUndefined()
    expect(registry.current()).toEqual({ provider: 'alpha', model: 'alpha-1' })

    registry.use({ provider: 'beta' })
    expect(registry.current()).toEqual({ provider: 'beta', model: 'beta-1' })

    // 只换模型：条目不动，模型名换掉——`current` 未必是表里的某一行（见契约 `ModelSelectionRef`）
    registry.use({ model: 'beta-x' })
    expect(registry.current()).toEqual({ provider: 'beta', model: 'beta-x' })
    expect(registry.list()).toContainEqual({ id: 'beta', model: 'beta-1' })
  })

  test('缺省条目不在表里——当场报（配置加载器已拦一道，这里再拦一道）', () => {
    expect(() =>
      createModelRegistry({
        providers: { beta: BETA },
        defaultProvider: 'alpha',
        stamper: makeTestStamper(),
        env: {},
      }),
    ).toThrow(/缺省供应商「alpha」/)
  })

  test('缺省条目缺 key → **启动期**即报（与单供应商时代逐字同义）', () => {
    expect(() =>
      createModelRegistry({
        providers: { alpha: ALPHA },
        defaultProvider: 'alpha',
        stamper: makeTestStamper(),
        env: {},
      }),
    ).toThrow(MissingApiKeyError)
  })

  test('**非**缺省条目缺 key 不拦启动——备用条目没配好，不该把人挡在门外', () => {
    const registry = registryOf({ alpha: ALPHA, 'beta-draft': BETA }, { apiKeys: { alpha: 'ka' } })

    expect(registry.list()).toHaveLength(2)
    // 真切过去时才说话，且说清楚去哪儿配（不是一路沉默到第一次调用）
    const result = registry.use({ provider: 'beta-draft' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain('MAGIC_BETA_DRAFT_API_KEY')
      expect(result.reason).toContain('providers.beta-draft.apiKey')
    }
    // 切不动就不动——选中照旧为空
    expect(registry.selection()).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 切换：换模型＝换接缝下游
// ═══════════════════════════════════════════════════════════════════════

describe('注册表 · 切换', () => {
  test('未切换：走缺省条目，**模型名取自请求**（请求可覆盖配置默认）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    await ask(registry, 'alpha-1')
    await ask(registry, 'alpha-experimental')

    expect(seen.map((request) => request.model)).toEqual(['alpha-1', 'alpha-experimental'])
    expect(seen.every((request) => request.url.startsWith('https://alpha.example'))).toBe(true)
  })

  test('`use({ provider })` → 换条目，模型取**该条目的默认**（下一位客人不认上家的名字）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(await ask(registry, 'alpha-1')).toEqual({ text: '甲', model: 'alpha-1' })

    const switched = registry.use({ provider: 'beta' })
    expect(switched).toEqual({ ok: true, selection: { provider: 'beta', model: 'beta-1' } })
    expect(registry.selection()).toEqual({ provider: 'beta', model: 'beta-1' })

    // 调用方**一字未改**——还是同一个 registry、同一个 stream 调用
    expect(await ask(registry, 'alpha-1')).toEqual({ text: '乙', model: 'beta-1' })
    expect(seen.map((request) => request.url)).toEqual([
      'https://alpha.example/v1/chat/completions',
      'https://beta.example/v1/chat/completions',
    ])
    expect(seen.at(-1)?.model).toBe('beta-1')
  })

  test('`use({ model })` → 留在这家，换模型（同一端点跑另一个模型）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.use({ model: 'alpha-turbo' })).toEqual({
      ok: true,
      selection: { provider: 'alpha', model: 'alpha-turbo' },
    })

    await ask(registry, 'alpha-1')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url.startsWith('https://alpha.example')).toBe(true)
    expect(seen[0]?.model).toBe('alpha-turbo')
  })

  test('`use({ provider, model })` → 两件一起换（换个端点上的指定模型）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.use({ provider: 'beta', model: 'beta-large' })).toEqual({
      ok: true,
      selection: { provider: 'beta', model: 'beta-large' },
    })

    await ask(registry, 'alpha-1')
    expect(seen[0]?.url.startsWith('https://beta.example')).toBe(true)
    expect(seen[0]?.model).toBe('beta-large')
  })

  test('切回缺省条目也是一次普通切换（没有「回不去」的坑）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    registry.use({ provider: 'beta' })
    registry.use({ provider: 'alpha' })
    await ask(registry, 'alpha-1')

    expect(registry.selection()).toEqual({ provider: 'alpha', model: 'alpha-1' })
    expect(seen[0]?.url.startsWith('https://alpha.example')).toBe(true)
  })

  test('切换不需要新的会话——注册表不碰上下文（上下文归对话域）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    registry.use({ provider: 'beta' })

    // 同一次调用里的消息照旧原样送出去——注册表只换下游，不碰消息
    const { result } = await drainStream(
      registry.stream({
        model: 'alpha-1',
        messages: [
          { role: 'system', content: '你是 Magic Code' },
          { role: 'user', content: '第一轮' },
          { role: 'assistant', content: '记下了' },
          { role: 'user', content: '第二轮' },
        ],
      }),
    )

    expect(result.text).toBe('乙')
    expect(seen[0]?.model).toBe('beta-1')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 切不动就不动（解析从严 · 缘由交回）
// ═══════════════════════════════════════════════════════════════════════

describe('注册表 · 切不动就不动', () => {
  test('未知条目 → 不成功，缘由点名已注册的条目（打错字时当场看得见有哪些）', () => {
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { apiKeys: { alpha: 'ka', beta: 'kb' } })
    const before = registry.selection()

    const result = registry.use({ provider: 'betta' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('未知供应商「betta」——已注册：alpha / beta')
    expect(registry.selection()).toBe(before)
  })

  test('两件都不给 → 不成功（不知道要换成什么就不猜）', () => {
    const registry = registryOf({ alpha: ALPHA }, { apiKeys: { alpha: 'ka' } })

    expect(registry.use({}).ok).toBe(false)
    expect(registry.use({ provider: '  ', model: '' }).ok).toBe(false)
    expect(registry.selection()).toBeUndefined()
  })

  test('切到一半失败不留痕——失败一次之后，原先的选中照旧生效', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.use({ provider: 'beta' })).toEqual({
      ok: true,
      selection: { provider: 'beta', model: 'beta-1' },
    })
    // 两条切不动的路：名字不认识 · 什么都没给
    expect(registry.use({ provider: 'beta-draft' }).ok).toBe(false)
    expect(registry.use({ model: '  ' }).ok).toBe(false)

    await ask(registry, 'alpha-1')
    expect(seen[0]?.url.startsWith('https://beta.example')).toBe(true)
    expect(seen[0]?.model).toBe('beta-1')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 每条目各归其位（key · traits）
// ═══════════════════════════════════════════════════════════════════════

describe('注册表 · 每条目各归其位', () => {
  test('key 按条目各解析一次——两条目两把钥匙，且都不进事件 / 结果', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf(
      { alpha: ALPHA, beta: BETA },
      { fetch, apiKeys: { alpha: 'sk-alpha-key', beta: 'sk-beta-key' } },
    )

    const first = await drainStream(
      registry.stream({ model: 'alpha-1', messages: [{ role: 'user', content: '嗨' }] }),
    )
    registry.use({ provider: 'beta' })
    const second = await drainStream(
      registry.stream({ model: 'alpha-1', messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(seen.map((request) => request.authorization)).toEqual([
      'Bearer sk-alpha-key',
      'Bearer sk-beta-key',
    ])
    // key 永不入事件与结果
    for (const stream of [first, second]) {
      expect(JSON.stringify(stream.events)).not.toContain('sk-')
      expect(JSON.stringify(stream.result)).not.toContain('sk-')
    }
  })

  test('`traits` 覆盖位随条目适用——**表外模型**在自己条目里标注即生效', async () => {
    const { fetch } = splitEndpoint()
    const scripted = (async (input: unknown, init?: { body?: unknown }) => {
      const model = (JSON.parse(String(init?.body)) as { model?: string }).model
      void input
      return new Response(
        `data: ${JSON.stringify({
          id: 'c1',
          object: 'chat.completion.chunk',
          created: 1,
          model,
          choices: [{ index: 0, delta: { content: '<think>想想</think>正文' } }],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as unknown as typeof globalThis.fetch

    // 乙家是个表外模型（内置表不认），靠**条目自己的覆盖位**声明「思考内嵌在正文里」
    const registry = registryOf(
      { alpha: ALPHA, local: { ...BETA, model: 'my-local-llama', traits: { inlineThinking: { tag: 'think' } } } },
      { fetch: scripted, apiKeys: { alpha: 'ka', local: 'kl' } },
    )

    registry.use({ provider: 'local' })
    const { result } = await drainStream(
      registry.stream({ model: 'alpha-1', messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(result.thinking).toBe('想想')
    expect(result.text).toBe('正文')

    // 同一个模型名在**没有覆盖位**的条目下不切（判据 ③：皆未命中＝不猜不切）
    registry.use({ provider: 'alpha', model: 'my-local-llama' })
    const plain = await drainStream(
      registry.stream({ model: 'my-local-llama', messages: [{ role: 'user', content: '嗨' }] }),
    )
    expect(plain.result.text).toBe('<think>想想</think>正文')
    expect(plain.result.thinking).toBe('')

    void fetch
  })
})

// ═══════════════════════════════════════════════════════════════════════
// U37 · 能力读数 —— **带图那一条交代在发出去之前**要问的那一格
// ═══════════════════════════════════════════════════════════════════════

/**
 * 判据三件：
 * 1. **用户明确覆盖**（`modelOverrides[<精确 id>].capabilities.image`）——今天「明确不支持」
 *    唯一的正当来路（列表接口只给 `id`，型号名又不许猜）；
 * 2. **缓存里那份资料**（`modelInfoOf` 给的 `capabilities`）——API 真给了就算数；
 * 3. **两处都没有 ⇒ `undefined`**——不知道就是不知道（**不冒充「不支持」**，
 *    否则会凭空禁掉一批其实能看图的模型）。
 */
describe('U37 · 能力读数', () => {
  test('用户覆盖：把某个模型明确标成「不吃图」', () => {
    const registry = registryOf(
      { alpha: { ...ALPHA, modelOverrides: { 'alpha-1': { capabilities: { image: false } } } } },
      { apiKeys: { alpha: 'ka' } },
    )

    expect(registry.capabilityOf('alpha', 'alpha-1')).toEqual({ image: false })
  })

  test('缓存里那份资料也算数（API 给了就用它）', () => {
    const registry = registryOf(
      { alpha: ALPHA },
      {
        apiKeys: { alpha: 'ka' },
        modelInfoOf: (provider, model) =>
          provider === 'alpha' && model === 'alpha-1' ? { id: model, capabilities: { image: true } } : undefined,
      },
    )

    expect(registry.capabilityOf('alpha', 'alpha-1')).toEqual({ image: true })
  })

  test('两处都没有 ⇒ `undefined`（不知道，不冒充「不支持」）', () => {
    const registry = registryOf({ alpha: ALPHA }, { apiKeys: { alpha: 'ka' } })

    expect(registry.capabilityOf('alpha', 'alpha-1')).toBeUndefined()
    expect(registry.capabilityOf('没有这条连接', 'x')).toBeUndefined()
  })

  test('用户覆盖盖过缓存里那份（优先级：用户覆盖 → API 资料 → 未知）', () => {
    const registry = registryOf(
      { alpha: { ...ALPHA, modelOverrides: { 'alpha-1': { capabilities: { image: false } } } } },
      { apiKeys: { alpha: 'ka' }, modelInfoOf: (_, model) => ({ id: model, capabilities: { image: true } }) },
    )

    expect(registry.capabilityOf('alpha', 'alpha-1')?.image).toBe(false)
  })

  test('同条目换到别的模型：覆盖**不跟过去**（它是「这一条 ＋ 那个模型」两件的事）', () => {
    const registry = registryOf(
      { alpha: { ...ALPHA, modelOverrides: { 'alpha-1': { capabilities: { image: false } } } } },
      { apiKeys: { alpha: 'ka' } },
    )

    expect(registry.capabilityOf('alpha', 'alpha-2')).toBeUndefined()
  })
})
