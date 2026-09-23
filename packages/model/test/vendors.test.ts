/**
 * U41 · 供应商适配 —— 判据：**按两家实际接口**取列表 / 归一字段 / 补缺项 / 映射思考，
 * 且**没有依据的请求一个都不发**。
 *
 * 全程**假端点**（注入 fetch 回 JSON，不经网络、不取真 key）：真端点连通与账号授权
 * 另列证据（见回报「未验证项」）。
 */

import { describe, expect, test } from 'bun:test'
import type { FetchLike } from '../src/index.ts'
import type { ModelInfo } from '@magic/contracts'
import {
  DEEPSEEK_VENDOR,
  MINIMAX_VENDOR,
  collectPages,
  vendorIds,
  vendorOf,
} from '../src/vendors.ts'

// —— 夹具 ——

/** 一次请求的现场（路径 ＋ 认证头）——够断言「发到哪儿、带了什么凭据」而不回显凭据本身。 */
type Seen = { readonly url: string; readonly authorization: string | undefined }

function capturing(
  body: unknown,
  status = 200,
): { readonly fetch: FetchLike; readonly seen: Seen[] } {
  const seen: Seen[] = []
  const fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    const headers = new Headers(init?.headers as Record<string, string> | undefined)
    seen.push({ url: String(input), authorization: headers.get('authorization') ?? undefined })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as FetchLike
  return { fetch, seen }
}

const ctxOf = (fetch: FetchLike, baseURL = 'https://api.deepseek.com') => ({
  providerId: 'ds',
  baseURL,
  apiKey: 'sk-not-a-real-key',
  fetch,
})

/** OpenAI 兼容的列表响应（两家共用那一层：`object: 'list'` ＋ `data`）。 */
const listBody = (...ids: readonly string[]): unknown => ({
  object: 'list',
  data: ids.map((id) => ({ id, object: 'model', owned_by: 'x' })),
})

// ═══════════════════════════════════════════════════════════════════════
// 一 · 列表：归一 + 认证位置 + 失败不泄露
// ═══════════════════════════════════════════════════════════════════════

describe('列表获取', () => {
  test('DeepSeek：`GET {base}/models`，`Bearer` 认证，归一出一串 `id`', async () => {
    const { fetch, seen } = capturing(listBody('deepseek-flash', 'deepseek-v4-pro'))

    const models = await DEEPSEEK_VENDOR.listModels(ctxOf(fetch))

    expect(models.map((one) => one.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    // **只认 `id`**：`owned_by` 那类既不调用也不呈现，收了只会让人以为「一直有」
    expect(models[0]).toEqual({ id: 'deepseek-flash' })
    expect(seen[0]?.url).toBe('https://api.deepseek.com/models')
    expect(seen[0]?.authorization).toBe('Bearer sk-not-a-real-key')
  })

  test('MiniMax：官方地址在 `/v1` 下', async () => {
    const { fetch, seen } = capturing(listBody('MiniMax-M3'))

    await MINIMAX_VENDOR.listModels(ctxOf(fetch, 'https://api.minimax.cn/v1'))

    expect(seen[0]?.url).toBe('https://api.minimax.cn/v1/models')
  })

  test('非 2xx ⇒ 抛，且**不带响应正文**（对面可能把凭据抄回来）', async () => {
    const { fetch } = capturing({ error: { message: 'Bearer sk-not-a-real-key 无效' } }, 401)

    await expect(DEEPSEEK_VENDOR.listModels(ctxOf(fetch))).rejects.toThrow(/HTTP 401/)
    try {
      await DEEPSEEK_VENDOR.listModels(ctxOf(fetch))
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      expect(text).not.toContain('sk-not-a-real-key')
    }
  })

  test('响应不成形（没有 data 数组）⇒ 抛，不当成空列表', async () => {
    const { fetch } = capturing({ object: 'list' })
    await expect(DEEPSEEK_VENDOR.listModels(ctxOf(fetch))).rejects.toThrow(/没有 data 数组/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 分页：**全部成功才返回**
// ═══════════════════════════════════════════════════════════════════════

describe('分页一致性', () => {
  test('一页页取到没有下一页为止', async () => {
    const pages: readonly { models: readonly ModelInfo[]; next?: string }[] = [
      { models: [{ id: 'a' }], next: 'p2' },
      { models: [{ id: 'b' }], next: 'p3' },
      { models: [{ id: 'c' }] },
    ]
    let index = 0
    const cursors: (string | undefined)[] = []

    const all = await collectPages((cursor) => {
      cursors.push(cursor)
      return Promise.resolve(pages[index++] ?? { models: [] })
    })

    expect(all.map((one) => one.id)).toEqual(['a', 'b', 'c'])
    // 首次不带游标，其后按上一页给的走
    expect(cursors).toEqual([undefined, 'p2', 'p3'])
  })

  test('游标重复 ⇒ 抛（对面在绕圈，不提交半份快照）', async () => {
    await expect(
      collectPages(() => Promise.resolve({ models: [{ id: 'a' }], next: 'same' })),
    ).rejects.toThrow(/游标重复/)
  })

  test('中途失败 ⇒ 抛（调用方保留上一份成功的结果）', async () => {
    let calls = 0
    await expect(
      collectPages(() => {
        calls += 1
        if (calls === 1) return Promise.resolve({ models: [{ id: 'a' }], next: 'p2' })
        return Promise.reject(new Error('网络断了'))
      }),
    ).rejects.toThrow('网络断了')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 没有依据的请求一个都不发
// ═══════════════════════════════════════════════════════════════════════

describe('按官方接口的已知差异', () => {
  test('DeepSeek **没有**详情接口 ⇒ 适配压根不给 `retrieveModel`', () => {
    expect(DEEPSEEK_VENDOR.retrieveModel).toBeUndefined()
  })

  test('MiniMax 有详情 ⇒ `GET /models/{id}`（id 经编码）', async () => {
    const { fetch, seen } = capturing({ id: 'MiniMax-M3', object: 'model' })

    const one = await MINIMAX_VENDOR.retrieveModel?.(
      ctxOf(fetch, 'https://api.minimax.cn/v1'),
      'MiniMax-M3/x',
    )

    expect(one?.id).toBe('MiniMax-M3')
    expect(seen[0]?.url).toBe('https://api.minimax.cn/v1/models/MiniMax-M3%2Fx')
  })

  test('认不出的供应商 / 区域**不猜地址**', () => {
    expect(vendorOf('nope')).toBeUndefined()
    expect(vendorIds()).toEqual(['minimax', 'deepseek'])

    // 区域认不出 ⇒ 不给地址（调用方报错，不回落一个「大概率是它」的域名）
    expect(MINIMAX_VENDOR.baseURLOf({ region: 'mars' })).toBeUndefined()
    // 明确写了地址就用它（高级地址只在明确需要时编辑）
    expect(MINIMAX_VENDOR.baseURLOf({ baseURL: 'https://my/v1', region: 'mars' })).toBe('https://my/v1')
    // 没写区域 ⇒ 官方缺省
    expect(DEEPSEEK_VENDOR.baseURLOf({})).toBe('https://api.deepseek.com')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 缺项补充：**不添型号 · 不覆盖 API 给的**
// ═══════════════════════════════════════════════════════════════════════

describe('缺项补充', () => {
  test('MiniMax：按**精确 id** 补官方窗长与实测特征', () => {
    const filled = MINIMAX_VENDOR.supplement({ id: 'MiniMax-M3' })

    expect(filled.limits?.maxContextTokens).toBe(1_000_000)
    expect(filled.traits).toEqual({ inlineThinking: { tag: 'think' } })
    // 两种都只补「API 没给」的那几格，不该凭空多出输入/输出上限
    expect(filled.limits?.maxInputTokens).toBeUndefined()
    expect(filled.limits?.maxOutputTokens).toBeUndefined()
  })

  test('**不添型号**：表里没有的就原样返回（一个字段都不加）', () => {
    const info: ModelInfo = { id: 'some-unlisted-model' }
    expect(MINIMAX_VENDOR.supplement(info)).toEqual({ id: 'some-unlisted-model' })
  })

  test('**API 给了的不覆盖**：补充排在供应商当前信息之后', () => {
    const filled = MINIMAX_VENDOR.supplement({
      id: 'MiniMax-M3',
      limits: { maxContextTokens: 1234 },
    })
    expect(filled.limits?.maxContextTokens).toBe(1234)
  })

  test('DeepSeek：官方没给容量 / 能力 ⇒ 一个字都不补（缺项如实未知）', () => {
    expect(DEEPSEEK_VENDOR.supplement({ id: 'deepseek-flash' })).toEqual({ id: 'deepseek-flash' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 五 · 思考设置 → 原生参数（**没依据不发假参数**）
// ═══════════════════════════════════════════════════════════════════════

describe('思考设置映射', () => {
  test('DeepSeek：默认什么都不发（官方默认就是开启 ＋ high）', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'default' })).toBeUndefined()
  })

  test('DeepSeek：明确关闭 ⇒ `thinking.type = disabled`', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'off' })).toEqual({
      params: { thinking: { type: 'disabled' } },
    })
  })

  test('DeepSeek：官方三档 low / high / max ⇒ `reasoning_effort`', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level: 'high' })).toEqual({
      params: { reasoningEffort: 'high' },
    })
    for (const level of ['low', 'high', 'max']) {
      expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level })).toEqual({
        params: { reasoningEffort: level },
      })
    }
  })

  test('DeepSeek：不认识的档位 / 预算 ⇒ **报缺口**（不发假参数）', () => {
    const level = DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level: 'ultra' })
    expect(level !== undefined && 'gap' in level && level.gap).toMatch(/low \/ high \/ max/)

    const budget = DEEPSEEK_VENDOR.reasoningOf({ mode: 'budget', budgetTokens: 4096 })
    expect(budget !== undefined && 'gap' in budget && budget.gap).toMatch(/没有思考预算/)
  })

  test('MiniMax：官方没有可配置的思考参数 ⇒ 除默认外一律报缺口', () => {
    expect(MINIMAX_VENDOR.reasoningOf({ mode: 'default' })).toBeUndefined()

    const off = MINIMAX_VENDOR.reasoningOf({ mode: 'off' })
    expect(off !== undefined && 'gap' in off && off.gap).toMatch(/没有可配置的思考参数/)
  })
})
