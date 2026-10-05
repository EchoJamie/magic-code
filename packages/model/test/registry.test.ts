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
import {
  createLearnedTraits,
  createModelRegistry,
  matchBuiltinTraits,
  resolveModelTraits,
} from '../src/index.ts'

// ═══════════════════════════════════════════════════════════════════════
// 夹具 —— 两个条目（甲 / 乙），各在各的端点上
// ═══════════════════════════════════════════════════════════════════════

const ALPHA: ProviderConfig = { vendor: 'minimax', baseURL: 'https://alpha.example/v1' }
const BETA: ProviderConfig = { vendor: 'minimax', baseURL: 'https://beta.example/v1' }

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
  const registry = createModelRegistry({
    providers,
        stamper: makeTestStamper(),
    env: {},
    ...options,
  })
  registry.use({ alias: 'default', provider: 'alpha', model: 'alpha-1' })
  return registry
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
  test('条目只提供接入身份，不带默认模型；未提交实际选择时没有去向', () => {
    const registry = createModelRegistry({ providers: { alpha: ALPHA, beta: BETA }, stamper: makeTestStamper(), env: {} })
    expect(registry.list()).toEqual([{ id: 'alpha' }, { id: 'beta' }])
    expect(registry.has('beta')).toBe(true)
    expect(registry.has('gamma')).toBe(false)
    expect(registry.current()).toBeUndefined()
    expect(registry.selection()).toBeUndefined()
  })
  test('能力和容量属于精确组合，未选中也能查询', () => {
    const registry = createModelRegistry({ providers: { alpha: { ...ALPHA, modelOverrides: { 'alpha-1': { limits: { maxContextTokens: 200_000 } } } }, beta: BETA }, stamper: makeTestStamper() })
    expect(registry.capacityOf('alpha', 'alpha-1')?.contextWindow).toBe(200_000)
    expect(registry.capacityOf('beta', 'alpha-1')?.contextWindow).toBeUndefined()
    expect(registry.capacityOf('alpha', 'other')?.contextWindow).toBeUndefined()
  })
  test('构造只读注册表不解析 key；提交实际组合时缺 key 才拒绝', () => {
    const registry = createModelRegistry({ providers: { alpha: ALPHA }, stamper: makeTestStamper(), env: {} })
    expect(registry.current()).toBeUndefined()
    expect(registry.use({ alias: 'default', provider: 'alpha', model: 'alpha-1' }).ok).toBe(false)
    expect(registry.current()).toBeUndefined()
  })
})

describe('注册表 · 切换', () => {
  test('已提交选择：请求中的型号不能覆盖已解析组合', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    await ask(registry, 'alpha-1')
    await ask(registry, 'alpha-experimental')

    expect(seen.map((request) => request.model)).toEqual(['alpha-1', 'alpha-1'])
    expect(seen.every((request) => request.url.startsWith('https://alpha.example'))).toBe(true)
  })

  test('`use({ provider })` → 换条目，模型取**该条目的默认**（下一位客人不认上家的名字）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(await ask(registry, 'alpha-1')).toEqual({ text: '甲', model: 'alpha-1' })

    const switched = registry.use({ alias: 'default', provider: 'beta', model: 'beta-1' })
    expect(switched).toEqual({ ok: true, selection: { alias: 'default', provider: 'beta', model: 'beta-1' } })
    expect(registry.selection()).toEqual({ alias: 'default' as const, provider: 'beta', model: 'beta-1' })

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

    expect(registry.use({ alias: 'default', model: 'alpha-turbo' })).toEqual({
      ok: true,
      selection: { alias: 'default', provider: 'alpha', model: 'alpha-turbo' },
    })

    await ask(registry, 'alpha-1')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url.startsWith('https://alpha.example')).toBe(true)
    expect(seen[0]?.model).toBe('alpha-turbo')
  })

  test('`use({ provider, model })` → 两件一起换（换个端点上的指定模型）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.use({ alias: 'default', provider: 'beta', model: 'beta-large' })).toEqual({
      ok: true,
      selection: { alias: 'default', provider: 'beta', model: 'beta-large' },
    })

    await ask(registry, 'alpha-1')
    expect(seen[0]?.url.startsWith('https://beta.example')).toBe(true)
    expect(seen[0]?.model).toBe('beta-large')
  })

  test('切回缺省条目也是一次普通切换（没有「回不去」的坑）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    registry.use({ alias: 'default', provider: 'beta', model: 'beta-1' })
    registry.use({ alias: 'default', provider: 'alpha', model: 'alpha-1' })
    await ask(registry, 'alpha-1')

    expect(registry.selection()).toEqual({ alias: 'default' as const, provider: 'alpha', model: 'alpha-1' })
    expect(seen[0]?.url.startsWith('https://alpha.example')).toBe(true)
  })

  test('切换不需要新的会话——注册表不碰上下文（上下文归对话域）', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    registry.use({ alias: 'default', provider: 'beta', model: 'beta-1' })

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

    const result = registry.use({ alias: 'default', provider: 'betta' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('未知供应商「betta」——已注册：alpha / beta')
    expect(registry.selection()).toBe(before)
  })

  test('两件都不给 → 不成功（不知道要换成什么就不猜）', () => {
    const registry = registryOf({ alpha: ALPHA }, { apiKeys: { alpha: 'ka' } })

    expect(registry.use({}).ok).toBe(false)
    expect(registry.use({ alias: 'default', provider: '  ', model: '' }).ok).toBe(false)
    expect(registry.selection()).toEqual({ alias: 'default', provider: 'alpha', model: 'alpha-1' })
  })

  test('切到一半失败不留痕——失败一次之后，原先的选中照旧生效', async () => {
    const { fetch, seen } = splitEndpoint()
    const registry = registryOf({ alpha: ALPHA, beta: BETA }, { fetch, apiKeys: { alpha: 'ka', beta: 'kb' } })

    expect(registry.use({ alias: 'default', provider: 'beta', model: 'beta-1' })).toEqual({
      ok: true,
      selection: { alias: 'default', provider: 'beta', model: 'beta-1' },
    })
    // 两条切不动的路：名字不认识 · 什么都没给
    expect(registry.use({ alias: 'default', provider: 'beta-draft' }).ok).toBe(false)
    expect(registry.use({ alias: 'default', model: '  ' }).ok).toBe(false)

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
    registry.use({ alias: 'default', provider: 'beta', model: 'beta-1' })
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
          // ⚠️ 标签**在正文中间**（U65）：这一段拿来量的是「没标注就不切」那一半，
          //    而「以标签**开头**」是另一条强信号（认下并留存，见 model.test.ts
          //    的「认下的那些」那组）——两件不能混在同一份夹具里量
          choices: [{ index: 0, delta: { content: '正文里说一句 <think>想想</think> 就完' } }],
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
      { alpha: ALPHA, local: { ...BETA, modelOverrides: { 'my-local-llama': { traits: { inlineThinking: { tag: 'think' } } } } } },
      { fetch: scripted, apiKeys: { alpha: 'ka', local: 'kl' } },
    )

    registry.use({ alias: 'default', provider: 'local', model: 'my-local-llama' })
    const { result } = await drainStream(
      registry.stream({ model: 'alpha-1', messages: [{ role: 'user', content: '嗨' }] }),
    )

    expect(result.thinking).toBe('想想')
    expect(result.text).toBe('正文里说一句  就完')

    // 同一个模型名在**没有覆盖位**的条目下不切（判据 ③：皆未命中＝不猜不切）
    registry.use({ alias: 'default', provider: 'alpha', model: 'my-local-llama' })
    const plain = await drainStream(
      registry.stream({ model: 'my-local-llama', messages: [{ role: 'user', content: '嗨' }] }),
    )
    expect(plain.result.text).toBe('正文里说一句 <think>想想</think> 就完')
    expect(plain.result.thinking).toBe('')

    void fetch
  })

  /**
   * U65 的**接线**判据——「认下的那些」由**装配根造、注册表传给每一个网关**。
   *
   * 由头：这条正是漏传过一次的那种地方（注册表那一跳不传，网关就永远查不到——
   * 而每一件单独看都对）。故这里量的是**跨两轮**：第一轮认下，第二轮**同一个注册表**
   * 直接按它办，且**痕迹读得出来**（`entries()`）。
   */
  test('认下的那些随注册表进网关——第一轮认出、第二轮直接按它办', async () => {
    const body = JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'acme-reasoner-v9',
      choices: [{ index: 0, delta: { content: '<think>想</think>正文' } }],
    })
    const scripted = (async () =>
      new Response(
        `data: ${body}\n\n` +
          `data: ${JSON.stringify({
            id: 'c1',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'acme-reasoner-v9',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          })}\n\n` +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )) as unknown as typeof globalThis.fetch

    const learned = createLearnedTraits()
    const registry = registryOf(
      { alpha: { ...ALPHA } },
      { fetch: scripted, apiKeys: { alpha: 'ka' }, learnedTraits: learned },
    )

    expect(registry.use({ alias: 'default', provider: 'alpha', model: 'acme-reasoner-v9' }).ok).toBe(true)
    const first = await drainStream(
      registry.stream({ model: 'acme-reasoner-v9', messages: [{ role: 'user', content: '嗨' }] }),
    )
    expect(first.result).toMatchObject({ thinking: '想', text: '正文' })
    // **痕迹**（可查）：认下了哪一个模型名、认成了什么
    expect(learned.entries()).toEqual([
      ['acme-reasoner-v9', { inlineThinking: { tag: 'think' } }],
    ])

    // 第二轮：**同一个模型名**——走的是认下的那一份（表里并没有它）
    expect(matchBuiltinTraits('acme-reasoner-v9')).toBeUndefined()
    expect(resolveModelTraits('acme-reasoner-v9', undefined, learned)).toEqual({
      inlineThinking: { tag: 'think' },
    })
    const second = await drainStream(
      registry.stream({ model: 'acme-reasoner-v9', messages: [{ role: 'user', content: '嗨' }] }),
    )
    expect(second.result).toMatchObject({ thinking: '想', text: '正文' })
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
