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

/**
 * 一条官方适配的连接（DeepSeek——列表与调用都走它）。
 *
 * 带一个**可信接入身份**（真身份由装配按认证来源算）：没有它模型域不碰共享盘，
 * 盘上那几条用例就无从谈起。要试「没有身份」那一支就 `access: undefined` 盖掉。
 */
function connectionOf(over: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: 'ds',
    config: { vendor: 'deepseek' },
    baseURL: 'https://api.deepseek.com',
    apiKey: 'sk-not-a-real-key',
    access: { id: 'cfg:test', persistent: true },
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

  test('**无可信身份**（`access` 缺省）⇒ 不读也不写共享盘，内存里照常', async () => {
    const counter = { calls: 0 }
    const cache = memoryCache()
    cache.stored.set('ds', {
      provider: 'ds',
      scope: 'deepseek@https://api.deepseek.com',
      fetchedAt: 1_000,
      models: [{ id: 'ON-DISK' }],
    })

    const { service } = stage({
      connections: [connectionOf({ access: undefined })],
      fetch: listFetch(['fresh'], counter),
      cache,
      now: () => 1_000,
    })

    // 预热**不读盘**：没有可信身份，盘上那份是谁的说不清
    await service.warmup()
    expect(service.read('ds').snapshot).toBeUndefined()

    // 取到了**也不写盘**（内存里那份照常发布）
    await service.refresh('ds')
    expect(service.read('ds').snapshot?.models.map((one) => one.id)).toEqual(['fresh'])
    // 盘上那份原样没动——不是「按老样子读写」
    expect(cache.stored.get('ds')?.models).toEqual([{ id: 'ON-DISK' }])
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

describe('认证轮换 · `drop` 作废在途', () => {
  /** 挂住的一趟——`release` 之前不落定（模拟「先发起、后到达」）。 */
  function gated(): { readonly gate: Promise<Response>; release(r: Response): void } {
    let release!: (r: Response) => void
    const gate = new Promise<Response>((resolve) => {
      release = resolve
    })
    return { gate, release }
  }

  const listed = (id: string): Response =>
    Response.json({ object: 'list', data: [{ id, object: 'model' }] })

  test('换认证后 `drop`：旧认证那趟的迟到列表不得重新成为当前缓存', async () => {
    const { gate, release } = gated()
    const cache = memoryCache()
    const { service, setConnections } = stage({
      connections: [connectionOf({ apiKey: 'fake-old' })],
      fetch: (async () => gate) as unknown as FetchLike,
      cache,
    })

    const stale = service.refresh('ds') // 旧认证发起一趟（挂住）
    await settle()

    // 用户换了认证 —— 装配在 `scopeChanged` 那里调 `drop`（认证变更也是范围变更）
    setConnections([connectionOf({ apiKey: 'fake-new' })])
    service.drop('ds')
    await cache.drop('ds')

    release(listed('OLD-ACCOUNT-ONLY'))
    await stale
    await settle()

    expect(service.read('ds').snapshot).toBeUndefined()
    expect(cache.stored.has('ds')).toBe(false)
  })

  test('作废只盖当时在途的那一趟：`drop` 之后新发起的一趟照常发布', async () => {
    const { gate, release } = gated()
    let calls = 0
    const fetch = (async () => {
      calls += 1
      // 第一趟（旧认证）挂住；第二趟（换过认证）立即回
      return calls === 1 ? gate : listed('new-one')
    }) as unknown as FetchLike

    const cache = memoryCache()
    const { service, setConnections } = stage({
      connections: [connectionOf({ apiKey: 'fake-old' })],
      fetch,
      cache,
    })

    const stale = service.refresh('ds')
    await settle()

    setConnections([connectionOf({ apiKey: 'fake-new' })])
    service.drop('ds')

    // ① 作废的那一趟**让出在途位**：这一趟不必等它先落定
    await service.refresh('ds')
    // ② 旧那趟这才迟到 —— 不得盖掉刚发布的那份
    release(listed('OLD-ACCOUNT-ONLY'))
    await stale
    await settle()

    expect(service.read('ds').snapshot?.models.map((one) => one.id)).toEqual(['new-one'])
  })

  /**
   * **原锚**：`stored.has('ds') === false`（收尾时把盘上那份也抹掉）。
   * **为何变**：复核反例二判这条为错——写盘那一跳里可能已经有**换过认证的那一趟**
   * 写下的新结果，抹掉它就是把别人的东西删了（`PENDING[NEW_AFTER_OLD_CLEANUP]` 曾被删成
   * `null`）。**新锚**：「落定后不发布」，而盘上那半归缓存端口按**作废记录**判——
   * 目标仍是「别在下次预热时复活」，改由读面与写入共用的作废判据达成（端口层用例见
   * `app/test/model-cache.test.ts` 的「作废期间才落定的那份，读面也不得收回来」）。
   */
  test('`drop` 落在写盘那一跳里 ⇒ 不发布（内存不留；盘上那份归作废记录判）', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const base = memoryCache()
    const stuck: ModelInfoCache = {
      ...base,
      // 发布内存之后、写完盘之前卡住 —— `drop` 就落在这个窗口里
      replace: async (snapshot) => {
        await gate
        return base.replace(snapshot)
      },
    }

    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], { calls: 0 }),
      cache: stuck,
    })

    const pending = service.refresh('ds')
    await settle()

    service.drop('ds') // 认证就在这一刻换了
    release()
    await pending

    // 那一趟不再发布：内存里不留它（盘上那份也**不抹**——见上面的原锚/新锚）
    expect(service.read('ds').snapshot).toBeUndefined()
  })
})

describe('warmup · 核范围', () => {
  test('盘上那份属于另一个端点 ⇒ 不接纳（另起一趟取当前范围的）', async () => {
    const cache = memoryCache()
    cache.stored.set('ds', {
      provider: 'ds',
      scope: 'deepseek@https://old.example', // 与当前连接的官方地址不是一个范围
      fetchedAt: 999,
      models: [{ id: 'OLD-ENDPOINT-ONLY' }],
    })

    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], { calls: 0 }),
      cache,
      now: () => 1_000,
    })

    await service.warmup()
    expect(service.read('ds').snapshot).toBeUndefined()

    // 拒收不等于把这条连接弄哑：当前范围照常取
    await settle()
    expect(service.read('ds').snapshot?.models.map((one) => one.id)).toEqual(['a'])
  })

  test('范围一致、只是陈旧 ⇒ 照样接纳（拒的是范围不符，不是「旧」）', async () => {
    const cache = memoryCache()
    cache.stored.set('ds', {
      provider: 'ds',
      scope: 'deepseek@https://api.deepseek.com', // 与当前连接同一个范围
      fetchedAt: 999,
      models: [{ id: 'from-disk' }],
    })

    const { service } = stage({
      connections: [connectionOf()],
      fetch: listFetch(['a'], { calls: 0 }),
      cache,
      now: () => 1_000_000_000, // 盘上那份早就过了有效期
    })

    await service.warmup()
    const read = service.read('ds')
    expect(read.snapshot?.models.map((one) => one.id)).toEqual(['from-disk'])
    expect(read.stale).toBe(true) // 陈旧如实标（这一读也会顺手发起一趟后台刷新）
  })
})

describe('失败缘由 · 脱敏', () => {
  test('凭据不得原样出现在失败缘由里', async () => {
    const key = 'synthetic-private-marker'
    const { service } = stage({
      connections: [connectionOf({ apiKey: key })],
      fetch: (async () => {
        throw new Error(`bad Authorization: Bearer ${key}`)
      }) as unknown as FetchLike,
    })

    service.read('ds')
    await settle()

    const read = service.read('ds')
    expect(read.failure?.reason).not.toContain(key)
    expect(read.failure?.reason.length).toBeGreaterThan(0) // 不是抹成空
    // 差错文案会进事件与记录 —— 整条读数都不许带它
    expect(JSON.stringify(read)).not.toContain(key)
  })

  test('不含凭据的缘由原样保留（脱敏不吞掉可读信息）', async () => {
    const { service } = stage({
      connections: [connectionOf({ apiKey: 'sk-fake-only-not-real' })],
      fetch: (async () => {
        throw new Error('网络断了')
      }) as unknown as FetchLike,
    })

    service.read('ds')
    await settle()

    expect(service.read('ds').failure?.reason).toContain('网络断了')
  })
})
