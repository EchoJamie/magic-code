/**
 * U41 · 模型信息缓存与时效 —— 判据：**新鲜直接用 · 过期先回旧缓存再后台刷 · 一趟在途 ·
 * 失败不清缓存且有冷却 · 迟到结果不发布**。
 *
 * 全程假端点与内存缓存（不碰网络、不碰盘）；时钟注入，故「过没过期」是算出来的不是等出来的。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelInfoCache, ModelInfoSnapshot } from '@magic/contracts'
import type { FetchLike } from '../src/index.ts'
import { createModelInfoService } from '../src/index.ts'
import type { ModelConnection } from '../src/index.ts'

/** 等后台那一趟跑完（服务里的获取是 `void` 出去的，读面不等它）。 */
const settle = (): Promise<void> => Bun.sleep(5)

function memoryCache(): ModelInfoCache & { readonly stored: Map<string, ModelInfoSnapshot> } {
  const stored = new Map<string, ModelInfoSnapshot>()
  return {
    stored,
    read: (providerId) => Promise.resolve(stored.get(providerId)),
    replace: (snapshot) => {
      stored.set(snapshot.provider, snapshot)
      return Promise.resolve()
    },
    drop: (providerId) => {
      stored.delete(providerId)
      return Promise.resolve()
    },
  }
}

/** 假列表端点——每次请求记一笔，回一串 id。 */
function listFetch(
  ids: readonly string[],
  counter: { calls: number },
): FetchLike {
  return (async () => {
    counter.calls += 1
    return new Response(
      JSON.stringify({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as FetchLike
}

/** 一条官方适配的连接（DeepSeek——列表与调用都走它）。 */
function connectionOf(over: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: 'ds',
    config: { vendor: 'deepseek' },
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-not-a-real-key',
    ...over,
  }
}

/** 一套现场：连接资料可变（`book`），时钟可控。 */
function stage(options: {
  readonly connections: ModelConnection[]
  readonly fetch: FetchLike
  readonly cache?: ModelInfoCache
  readonly now?: () => number
}): {
  readonly service: ReturnType<typeof createModelInfoService>
  setConnections(next: readonly ModelConnection[]): void
} {
  const cache = options.cache ?? memoryCache()
  let book: readonly ModelConnection[] = options.connections
  const now = options.now ?? (() => 1_000_000)

  const service = createModelInfoService({
    connections: () => book,
    cache,
    fetch: options.fetch,
    now,
  })

  return { service, setConnections: (next) => {
    book = next
  } }
}

// ═══════════════════════════════════════════════════════════════════════

describe('取一趟 · 新鲜度', () => {
  test('没有缓存 ⇒ 读数里没有快照（不拿空列表冒充「供应商没有模型」），随后取回一份', async () => {
    const counter = { calls: 0 }
    const cache = memoryCache()
    let clock = 1_000_000
    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['deepseek-flash', 'deepseek-v4-pro'], counter),
      cache,
      now: () => clock,
    })

    // 第一次读：还没有——**但这一读就顺手发起了一次后台获取**
    expect(service.read('ds')).toEqual({ refreshing: true })

    await settle()

    const after = service.read('ds')
    expect(after.snapshot?.models.map((one) => one.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(after.stale).toBe(false)
    expect(after.failure).toBeUndefined()
    expect(counter.calls).toBe(1)
    // 落盘了（可重建的那一份）
    expect(cache.stored.get('ds')?.models).toHaveLength(2)

    // **新鲜期里不再打接口**（1 小时后仍新鲜）
    clock += 60 * 60 * 1000
    expect(service.read('ds').stale).toBe(false)
    await settle()
    expect(counter.calls).toBe(1)
  })

  test('过期 ⇒ **先回旧缓存**（标陈旧）并后台刷一趟', async () => {
    const counter = { calls: 0 }
    let clock = 1_000_000
    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], counter),
      now: () => clock,
    })

    service.read('ds')
    await settle()
    expect(counter.calls).toBe(1)

    // 越过 24 小时
    clock += 25 * 60 * 60 * 1000
    const stale = service.read('ds')
    // **旧的那份还在**（用户不必等这一趟）——且明说它陈旧、正在刷
    expect(stale.snapshot?.models.map((one) => one.id)).toEqual(['a'])
    expect(stale.stale).toBe(true)
    expect(stale.refreshing).toBe(true)

    await settle()
    expect(counter.calls).toBe(2)
    expect(service.read('ds').stale).toBe(false)
  })
})

describe('一趟在途 · 失败与冷却', () => {
  test('同一连接**只跑一趟**：反复读不会发一串请求', async () => {
    const counter = { calls: 0 }
    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], counter),
    })

    for (let i = 0; i < 5; i += 1) service.read('ds')
    await settle()

    expect(counter.calls).toBe(1)
  })

  test('失败**不清缓存**：旧快照照旧可用，另记一笔缘由；冷却期内不再自动重试', async () => {
    let clock = 1_000_000
    let failing = false
    const counter = { calls: 0 }
    const ok = listFetch(['a'], counter)
    const fetch = (async (input: unknown, init?: unknown) => {
      if (failing) {
        counter.calls += 1
        throw new Error('网络断了')
      }
      return ok(input as Parameters<typeof ok>[0], init as Parameters<typeof ok>[1])
    }) as unknown as FetchLike

    const { service } = stage({ connections: [connectionOf()], fetch, now: () => clock })

    service.read('ds')
    await settle()
    expect(service.read('ds').snapshot?.models.map((one) => one.id)).toEqual(['a'])

    // 过期 ＋ 这次会失败
    failing = true
    clock += 25 * 60 * 60 * 1000
    service.read('ds')
    await settle()

    const failed = service.read('ds')
    expect(failed.snapshot?.models.map((one) => one.id)).toEqual(['a']) // **旧缓存还在**
    expect(failed.failure?.reason).toContain('网络断了')

    // 冷却期内（60 秒不到）再读：**不再发请求**
    const before = counter.calls
    clock += 30 * 1000
    service.read('ds')
    await settle()
    expect(counter.calls).toBe(before)

    // 过了冷却：允许再试（仍失败——但不硬闯更密集）
    failing = false
    clock += 31 * 1000
    service.read('ds')
    await settle()
    expect(counter.calls).toBe(before + 1)
    expect(service.read('ds').failure).toBeUndefined()
  })

  test('显式刷新**绕开**时效与冷却（那是用户明确的要求）', async () => {
    const counter = { calls: 0 }
    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], counter),
    })

    service.read('ds')
    await settle()
    expect(counter.calls).toBe(1)

    // 还新鲜，但用户就是要现在取一趟
    await service.refresh('ds')
    expect(counter.calls).toBe(2)
  })

  test('缺认证 ⇒ 记一笔「取不了」，**不发请求**', async () => {
    const counter = { calls: 0 }
    const { service } = stage({
      connections: [connectionOf({ apiKey: undefined })],
      fetch: listFetch(['a'], counter),
    })

    service.read('ds')
    await settle()

    expect(counter.calls).toBe(0)
    expect(service.read('ds').failure?.reason).toContain('没有可用的认证')
  })

  test('兼容接入（没 `vendor`）⇒ 没有自动列表能力，不请求也不报错', async () => {
    const counter = { calls: 0 }
    const { service } = stage({
      connections: [connectionOf({ config: { baseURL: 'https://x/v1', model: 'm' } })],
      fetch: listFetch(['a'], counter),
    })

    expect(service.canFetch('ds')).toBe(false)
    expect(service.read('ds')).toEqual({})
    await settle()
    expect(counter.calls).toBe(0)
  })
})

describe('范围与迟到结果', () => {
  test('取的过程中范围变了 ⇒ 那一份**不发布**（先发起、后到达的旧范围结果）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const fetch = (async () => {
      await gate
      return new Response(
        JSON.stringify({ object: 'list', data: [{ id: 'stale-one', object: 'model' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as FetchLike

    const before = connectionOf()
    // 地址换了一处 ⇒ **接入范围变了**（连接资料里那一位与配置解析出来的地址是同一个）
    const after = connectionOf({
      baseURL: 'https://other.example',
      config: { vendor: 'deepseek', baseURL: 'https://other.example' },
    })
    const cache = memoryCache()
    const { service, setConnections } = stage({ connections: [before], fetch, cache })

    service.read('ds') // 发起一趟（此刻范围＝官方地址）
    await settle()

    // 用户在这中间换了地址 —— 范围变了
    setConnections([after])

    release()
    await settle()

    // 那一份属于旧范围：**不发布**。断言落在缓存上——`read` 自己会为新范围再发起一趟
    // （那是正确行为），拿它当判据会把两件事混起来
    expect(cache.stored.has('ds')).toBe(false)
    expect(cache.stored.size).toBe(0)
  })

  test('`drop` 之后读面回到「还没有」', async () => {
    const counter = { calls: 0 }
    const cache = memoryCache()
    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], counter),
      cache,
    })

    service.read('ds')
    await settle()
    expect(service.read('ds').snapshot).toBeDefined()

    service.drop('ds')
    expect(service.read('ds').snapshot).toBeUndefined()
  })

  test('启动预热：盘上那一份读回内存（缺文件 / 损坏都只是「还没有」）', async () => {
    const cache = memoryCache()
    cache.stored.set('ds', {
      provider: 'ds',
      scope: 'deepseek@https://api.deepseek.com',
      fetchedAt: 999,
      models: [{ id: 'from-disk' }],
    })

    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], { calls: 0 }),
      cache,
      now: () => 1_000,
    })

    await service.warmup()
    // 预热后读面直接给盘上那份（**且不因为「过期」在这里就抢跑**——判据在 read 那一跳）
    expect(service.read('ds').snapshot?.models.map((one) => one.id)).toEqual(['from-disk'])
  })
})
