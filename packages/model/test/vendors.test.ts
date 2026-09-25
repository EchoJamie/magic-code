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
  vendorCatalog,
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
    // **收「调用真用得到」的那几格**：`owned_by` 那类既不调用也不呈现，收了只会让人
    // 以为「一直有」；这份响应里**没有规格可收** ⇒ 一个 `limits` 都不给（不凭空造）
    expect(models[0]).toEqual({ id: 'deepseek-flash' })
    expect(seen[0]?.url).toBe('https://api.deepseek.com/models')
    expect(seen[0]?.authorization).toBe('Bearer sk-not-a-real-key')
  })

  /**
   * **U91 的真响应形状**——2026-09-26 对 `https://api.deepseek.com/models` 实测抄回，
   * 逐字（键序照抄；两台模型的数一样，故留一台＋一台对照）。
   *
   * 判据：`max_output_tokens` 收进 `limits.maxOutputTokens`——**它就是出站请求体里
   * 那个输出上限的来路**（网关 → 取件层 → `max_tokens`）。此前这一格被整个丢掉，
   * 输出上限只能落回取件层常量 4096。
   */
  test('DeepSeek：接口给的 `max_output_tokens` 收进规格（其余各格仍不收）', async () => {
    const { fetch } = capturing({
      object: 'list',
      data: [
        {
          id: 'deepseek-flash',
          object: 'model',
          owned_by: 'deepseek',
          name: 'DeepSeek-V4.1-Flash',
          context_window: 1_048_576,
          max_output_tokens: 393_216,
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
          api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history' } },
        },
      ],
    })

    const models = await DEEPSEEK_VENDOR.listModels(ctxOf(fetch))

    // **只有那一格**：名字 / 模态 / effort / 联合窗口都不收（不调用也不呈现）
    expect(models).toEqual([{ id: 'deepseek-flash', limits: { maxOutputTokens: 393_216 } }])
    // 联合窗口**明确不收**——它进的是分母与压缩阈值，不在 U91 射程（别顺手收进来）
    expect(models[0]?.limits?.maxContextTokens).toBeUndefined()
  })

  /**
   * 「读不懂就不给这一位」——同 `capacity.ts` 那条口径（零 / 非法规格不当作无限大）。
   * 少了这条，一个字符串或 0 就会一路发进请求体的输出上限。
   */
  test('DeepSeek：`max_output_tokens` 读不懂（字符串 / 0 / 负 / 小数）⇒ 当作没给', async () => {
    const { fetch } = capturing({
      object: 'list',
      data: [
        { id: 'a', max_output_tokens: '393216' },
        { id: 'b', max_output_tokens: 0 },
        { id: 'c', max_output_tokens: -1 },
        { id: 'd', max_output_tokens: 1.5 },
        { id: 'e', max_output_tokens: null },
      ],
    })

    const models = await DEEPSEEK_VENDOR.listModels(ctxOf(fetch))

    expect(models).toEqual([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }])
  })

  /**
   * ⚠️ **反面：MiniMax 一个数都取不到**（2026-09-26 实测，列表与详情都是这四个字段）。
   *
   * 这一条钉住「没有就**如实没有**」：它那条路照旧落回取件层常量（`ai-sdk.ts` 里
   * 标了「权宜」的那一个）——**不许替它编一个输出上限**。
   */
  test('MiniMax：四个字段的响应 ⇒ 一格规格都不给（它那条路没有这一位可取）', async () => {
    const { fetch } = capturing({
      object: 'list',
      data: [{ id: 'MiniMax-M3', object: 'model', created: 1_780_272_000, owned_by: 'minimax' }],
    })

    const models = await MINIMAX_VENDOR.listModels(ctxOf(fetch, 'https://api.minimax.cn/v1'))

    expect(models).toEqual([{ id: 'MiniMax-M3' }])
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
// 三之二 · 内置供应商与官方区域的读面（U41 返修 · 界面「接入」用）
// ═══════════════════════════════════════════════════════════════════════

describe('供应商读面', () => {
  test('列已注册的两家：名字 ＋ 官方区域（**从适配现取**，不是另一张表）', () => {
    const vendors = vendorCatalog()

    expect(vendors.map((one) => one.vendor)).toEqual(['minimax', 'deepseek'])
    expect(vendors.map((one) => one.label)).toEqual(['MiniMax', 'DeepSeek'])

    // 每一家至少一个区域，且**第一项就是缺省**——与 `baseURLOf` 同源（同一份 `regions`）
    for (const one of vendors) {
      expect(one.regions.length).toBeGreaterThan(0)
      const fallback = one.regions[0]
      expect(fallback).toBeDefined()
      expect(vendorOf(one.vendor)?.baseURLOf({})).toBe(fallback?.baseURL)
    }

    // 列出来的地址**就是适配真会用的那个**（两处同源，不会各说一套）
    const minimax = vendors.find((one) => one.vendor === 'minimax')
    expect(minimax?.regions.some((region) => region.baseURL === 'https://api.minimax.cn/v1')).toBe(true)
    const deepseek = vendors.find((one) => one.vendor === 'deepseek')
    expect(deepseek?.regions[0]?.baseURL).toBe('https://api.deepseek.com')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 缺项补充：**不添型号 · 不覆盖 API 给的**
// ═══════════════════════════════════════════════════════════════════════

describe('缺项补充', () => {
  test('MiniMax：按**精确 id** 补官方窗长，按**实测**补特征标记', () => {
    const filled = MINIMAX_VENDOR.supplement({ id: 'MiniMax-M3' })

    expect(filled.limits?.maxContextTokens).toBe(1_000_000)
    expect(filled.traits).toEqual({ inlineThinking: { tag: 'think' } })
    // 两种都只补「API 没给」的那几格，不该凭空多出输入/输出上限
    expect(filled.limits?.maxInputTokens).toBeUndefined()
    expect(filled.limits?.maxOutputTokens).toBeUndefined()
  })

  /**
   * U65：官方适配这条路上，**特征标记按家族查**（`MiniMax-M2.7-highspeed` 落 M2 那条），
   * 而**窗长仍按精确 id 查**——两样的查法**故意不一样**：
   *
   * - 内嵌思考有「同一线不同版本号行为相同」的实测依据（`traits.ts` 那条注）；
   * - 窗长是**逐型号的规格**，没有依据说小改款的窗口跟着走——不按型号名猜
   *   （设计：「不按型号家族 / 前缀猜」）。
   *
   * 09-25 真机取证用的就是这个模型名：它当时既没被认成内嵌思考（而它确实是）。
   */
  test('MiniMax：**同线的小改款**落同一条特征——窗长仍逐行精确（两样故意不一样）', () => {
    // 09-25 真机取证用的就是它：窗长表里**逐行有它**（官方表给的就是这个精确 id），
    // 特征表里当时**没有它**——于是思考没被拆，整段 `<think>` 当正文落库也印屏
    const real = MINIMAX_VENDOR.supplement({ id: 'MiniMax-M2.7-highspeed' })
    expect(real.traits).toEqual({ inlineThinking: { tag: 'think' } })
    expect(real.limits?.maxContextTokens).toBe(204_800)

    // 将来的小版本：**特征**按家族落 M3 那条；**窗长**表里没有就不给这一位
    //（不按型号名猜一个数——设计：「不按型号家族 / 前缀猜」）
    const future = MINIMAX_VENDOR.supplement({ id: 'MiniMax-M3.1' })
    expect(future.traits).toEqual({ inlineThinking: { tag: 'think' } })
    expect(future.limits).toBeUndefined()
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

  test('DeepSeek：补**思考能力**（官方文档有依据），容量一个字都不补', () => {
    // **原锚**：「官方没给容量 / 能力 ⇒ 一个字都不补」。
    // **为何变**：独立首验的反例要求「真实列表形成的 DeepSeek 读面须提供已支持的思考选择」
    // ——列表本身只回 `id`，而官方 `guides/thinking_mode` 确实给了开关与三档；
    // 设计也说「必要缺项按官方资料补充」。**容量仍不补**（官方写「1M / 384K」，单位不肯定）。
    // **新锚**：思考能力补（`levels` 三档 ＋ 可关闭），`limits` 一格不加。
    const filled = DEEPSEEK_VENDOR.supplement({ id: 'deepseek-flash' })

    expect(filled.reasoning?.levels).toEqual(['low', 'high', 'max'])
    expect(filled.reasoning?.disable).toBe(true)
    // 没有预算参数（官方没给）——**不给这一位**，别编一个 0 或区间
    expect(filled.reasoning?.budget).toBeUndefined()
    // 容量缺项如实未知
    expect(filled.limits).toBeUndefined()
  })

  test('DeepSeek：**API 给了的不覆盖**（补充排在供应商当前信息之后）', () => {
    const given: ModelInfo = {
      id: 'deepseek-flash',
      reasoning: { levels: ['high'] },
    }
    expect(DEEPSEEK_VENDOR.supplement(given)).toEqual(given)
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
