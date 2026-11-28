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
  GLM_VENDOR,
  MINIMAX_VENDOR,
  collectPages,
  listModelsOfProtocol,
  resolveModelSource,
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
  test('DeepSeek：保留接口给出的容量、名称和输入模态', async () => {
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

    expect(models).toEqual([{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', capabilities: { image: true }, reasoning: { levels: ['low', 'high', 'max'], defaultLevel: 'high' }, limits: { maxOutputTokens: 393_216, maxContextTokens: 1_048_576 } }])
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
    expect(vendorIds()).toEqual(['minimax', 'deepseek', 'glm'])

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
  test('列已注册的几家：名字 ＋ 官方区域（**从适配现取**，不是另一张表）', () => {
    const vendors = vendorCatalog()

    expect(vendors.map((one) => one.vendor)).toEqual(['minimax', 'deepseek', 'glm'])
    expect(vendors.map((one) => one.label)).toEqual(['MiniMax', 'DeepSeek', 'GLM'])

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
// 四 · 协议支持提示（**只是提示，不是硬闸门**）
// ═══════════════════════════════════════════════════════════════════════

describe('协议支持提示', () => {
  test('DeepSeek 的官方提示：Responses 只含 `deepseek-flash`，Messages / Chat 含两个型号', () => {
    const responses = DEEPSEEK_VENDOR.protocols.find(one => one.id === 'responses')
    expect(responses?.models).toEqual(['deepseek-flash'])
    for (const id of ['messages', 'chat-completions']) {
      expect(DEEPSEEK_VENDOR.protocols.find(one => one.id === id)?.models)
        .toEqual(expect.arrayContaining(['deepseek-flash', 'deepseek-v4-pro']))
    }
    // 读面（界面据此显示「协议（按型号）」）与适配同源，不用另维护一份表。
    const catalog = vendorCatalog().find(one => one.vendor === 'deepseek')
    expect(catalog?.protocols.find(one => one.id === 'responses')?.models).toEqual(['deepseek-flash'])
  })

  test('型号不在提示里不拒绝：显式协议照用，缺省按固定优先级兜底', () => {
    // 显式写了协议就用它（官方提示缺这一位也不拦）。
    expect(resolveModelSource({ vendor: 'deepseek', protocol: 'messages' }, '尚未公布的型号'))
      .toEqual({ protocol: 'messages', endpoint: 'https://api.deepseek.com/anthropic/v1' })
    // 没写协议 ⇒ 按 Responses → Messages → Chat Completions 的固定次序兜底。
    expect(resolveModelSource({ vendor: 'deepseek' }, '尚未公布的型号'))
      .toEqual({ protocol: 'responses', endpoint: 'https://api.deepseek.com' })
    // 端点仍照旧解析：没有地址就报错（不猜、不回落）。
    expect(() => resolveModelSource({ vendor: 'deepseek', region: 'mars' }, '尚未公布的型号')).toThrow('服务地址')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 五 · 思考设置 → 原生参数（**没依据不发假参数**）
// ═══════════════════════════════════════════════════════════════════════

describe('思考设置映射', () => {
  test('DeepSeek：默认什么都不发（官方默认就是开启 ＋ high）', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'default' }, 'deepseek-flash')).toBeUndefined()
  })

  test('DeepSeek：明确关闭 ⇒ `thinking.type = disabled`', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'off' }, 'deepseek-flash')).toEqual({
      params: { thinking: { type: 'disabled' } },
    })
  })

  test('DeepSeek：官方三档 low / high / max ⇒ `reasoning_effort`', () => {
    expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level: 'high' }, 'deepseek-flash')).toEqual({
      params: { thinking: { type: 'enabled' }, reasoningEffort: 'high' },
    })
    for (const level of ['low', 'high', 'max']) {
      expect(DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level }, 'deepseek-flash')).toEqual({
        params: { thinking: { type: 'enabled' }, reasoningEffort: level },
      })
    }
  })

  test('DeepSeek：不认识的档位 / 预算 ⇒ **报缺口**（不发假参数）', () => {
    const level = DEEPSEEK_VENDOR.reasoningOf({ mode: 'level', level: 'ultra' }, 'deepseek-flash')
    expect(level !== undefined && 'gap' in level && level.gap).toMatch(/low \/ high \/ max/)

    const budget = DEEPSEEK_VENDOR.reasoningOf({ mode: 'budget', budgetTokens: 4096 }, 'deepseek-flash')
    expect(budget !== undefined && 'gap' in budget && budget.gap).toMatch(/没有思考预算/)
  })

  test('MiniMax：参数映射不维护型号名单，能力由选择层独立校验', () => {
    expect(MINIMAX_VENDOR.reasoningOf({ mode: 'default' }, 'unknown')).toBeUndefined()

    expect(MINIMAX_VENDOR.reasoningOf({ mode: 'off' }, 'unknown')).toEqual({ params: { thinking: { type: 'disabled' } } })
    const budget = MINIMAX_VENDOR.reasoningOf({ mode: 'budget', budgetTokens: 1024 }, 'unknown')
    expect(budget !== undefined && 'gap' in budget && budget.gap).toMatch(/不支持该思考设置/)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 五之二 · GLM（智谱）：区域 × 协议的端点改写 ＋ 按型号代次的思考映射
// ═══════════════════════════════════════════════════════════════════════

describe('GLM：端点解析', () => {
  // 四个官方区域：站（国内 / 国际 Z.ai）× 端点（通用 / Coding 套餐）——第一项是缺省
  test('缺省＝中国大陆通用端点；区域列全两条接入线', () => {
    expect(GLM_VENDOR.baseURLOf({})).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(GLM_VENDOR.baseURLOf({ region: 'cn-coding' })).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(GLM_VENDOR.baseURLOf({ region: 'global' })).toBe('https://api.z.ai/api/paas/v4')
    expect(GLM_VENDOR.baseURLOf({ region: 'global-coding' })).toBe('https://api.z.ai/api/coding/paas/v4')
    expect(GLM_VENDOR.baseURLOf({ region: 'mars' })).toBeUndefined()
  })

  test('Messages / Responses 改写到同站的协议线；显式地址不改写', () => {
    // Anthropic 兼容端点通用与套餐共用同一地址
    expect(GLM_VENDOR.baseURLOf({}, 'messages')).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(GLM_VENDOR.baseURLOf({ region: 'cn-coding' }, 'messages')).toBe('https://open.bigmodel.cn/api/anthropic')
    expect(GLM_VENDOR.baseURLOf({ region: 'global' }, 'messages')).toBe('https://api.z.ai/api/anthropic')
    // Responses（Coding 套餐 Codex 端点）
    expect(GLM_VENDOR.baseURLOf({ region: 'cn-coding' }, 'responses')).toBe('https://open.bigmodel.cn/api/v1')
    expect(GLM_VENDOR.baseURLOf({ region: 'global-coding' }, 'responses')).toBe('https://api.z.ai/api/v1')
    // Chat Completions 原样
    expect(GLM_VENDOR.baseURLOf({ region: 'global-coding' }, 'chat-completions')).toBe('https://api.z.ai/api/coding/paas/v4')
    // 显式写了地址 ⇒ 原样用（完整路径由用户负责）
    expect(GLM_VENDOR.baseURLOf({ baseURL: 'https://my-proxy.example/glm' }, 'messages')).toBe('https://my-proxy.example/glm')
  })

  test('resolveModelSource：显式协议照用，缺省按固定优先级兜底', () => {
    expect(resolveModelSource({ vendor: 'glm' }, 'glm-5.4'))
      .toEqual({ protocol: 'responses', endpoint: 'https://open.bigmodel.cn/api/v1' })
    // 5.3 没有 Responses 提示 ⇒ 兜底到 Messages？——5.3 在 Messages 提示里，取 Messages
    expect(resolveModelSource({ vendor: 'glm' }, 'glm-5.3'))
      .toEqual({ protocol: 'messages', endpoint: 'https://open.bigmodel.cn/api/anthropic' })
    // 型号不在任何提示里 ⇒ 固定优先级（Responses → Messages → Chat Completions）
    expect(resolveModelSource({ vendor: 'glm' }, '尚未公布的型号'))
      .toEqual({ protocol: 'responses', endpoint: 'https://open.bigmodel.cn/api/v1' })
  })

  test('列表：`GET {base}/models`（Bearer），归一 `data[]`；认证随协议走 `x-api-key` 的部分由调用方定', async () => {
    const { fetch, seen } = capturing(listBody('glm-5.3', 'glm-5.2'))

    const models = await GLM_VENDOR.listModels(ctxOf(fetch, 'https://open.bigmodel.cn/api/paas/v4'))

    expect(models.map((one) => one.id)).toEqual(['glm-5.3', 'glm-5.2'])
    expect(seen[0]?.url).toBe('https://open.bigmodel.cn/api/paas/v4/models')
    expect(seen[0]?.authorization).toBe('Bearer sk-not-a-real-key')
  })
})

describe('GLM：官方协议支持提示', () => {
  test('Responses 只含 glm-5.4；Messages / Chat Completions 覆盖已核实型号', () => {
    expect(GLM_VENDOR.protocols.find(one => one.id === 'responses')?.models).toEqual(['glm-5.4'])
    expect(GLM_VENDOR.protocols.find(one => one.id === 'messages')?.models)
      .toEqual(expect.arrayContaining(['glm-5.4', 'glm-5.3', 'glm-5.2', 'glm-4.7']))
    expect(GLM_VENDOR.protocols.find(one => one.id === 'chat-completions')?.models)
      .toEqual(expect.arrayContaining(['glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-4.7']))
  })
})

describe('GLM：思考设置映射（按型号代次，没依据不发假参数）', () => {
  test('默认什么都不发（GLM 默认思考开启、模型自动判断）', () => {
    expect(GLM_VENDOR.reasoningOf({ mode: 'default' }, 'glm-5.3')).toBeUndefined()
  })

  test('明确关闭 ⇒ `thinking.type = disabled`；GLM-5.3 系强制思考 ⇒ 报缺口', () => {
    expect(GLM_VENDOR.reasoningOf({ mode: 'off' }, 'glm-5.2')).toEqual({ params: { thinking: { type: 'disabled' } } })
    expect(GLM_VENDOR.reasoningOf({ mode: 'off' }, 'glm-4.7')).toEqual({ params: { thinking: { type: 'disabled' } } })

    const gap = GLM_VENDOR.reasoningOf({ mode: 'off' }, 'glm-5.3')
    expect(gap !== undefined && 'gap' in gap && gap.gap).toMatch(/不支持关闭思考/)
    const flash = GLM_VENDOR.reasoningOf({ mode: 'off' }, 'glm-5.3-flash')
    expect(flash !== undefined && 'gap' in flash && flash.gap).toMatch(/不支持关闭思考/)
  })

  test('档位 ⇒ `reasoning_effort`：5.3 系只认 low / high / max，5.2 及以上五档', () => {
    expect(GLM_VENDOR.reasoningOf({ mode: 'level', level: 'max' }, 'glm-5.3'))
      .toEqual({ params: { thinking: { type: 'enabled' }, reasoningEffort: 'max' } })
    for (const level of ['low', 'high', 'max']) {
      expect(GLM_VENDOR.reasoningOf({ mode: 'level', level }, 'glm-5.3')).toEqual({
        params: { thinking: { type: 'enabled' }, reasoningEffort: level },
      })
    }
    // 5.3 系的 medium / xhigh：通用 API 明文报错 ⇒ 缺口（套餐端点虽宽松映射，适配不按区域换规则）
    const medium = GLM_VENDOR.reasoningOf({ mode: 'level', level: 'medium' }, 'glm-5.3')
    expect(medium !== undefined && 'gap' in medium && medium.gap).toMatch(/low \/ high \/ max/)

    // 5.2 及以上：五档全放行（服务端自行映射 low/medium→high、xhigh→max）
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(GLM_VENDOR.reasoningOf({ mode: 'level', level }, 'glm-5.2'))
        .toEqual({ params: { thinking: { type: 'enabled' }, reasoningEffort: level } })
    }
    expect(GLM_VENDOR.reasoningOf({ mode: 'level', level: 'xhigh' }, 'glm-5.4'))
      .toEqual({ params: { thinking: { type: 'enabled' }, reasoningEffort: 'xhigh' } })
  })

  test('5.2 之前的型号没有档位；认不出的型号不猜 ⇒ 都报缺口', () => {
    for (const model of ['glm-4.7', 'glm-5.1', 'glm-5', 'glm-5-turbo']) {
      const gap = GLM_VENDOR.reasoningOf({ mode: 'level', level: 'high' }, model)
      expect(gap !== undefined && 'gap' in gap && gap.gap).toMatch(/reasoning_effort 仅 GLM-5\.2 及以上/)
    }
    const unknown = GLM_VENDOR.reasoningOf({ mode: 'level', level: 'high' }, 'glm-air')
    expect(unknown !== undefined && 'gap' in unknown && unknown.gap).toMatch(/不支持思考档位/)
  })

  test('各协议的参数形态：Messages 走 effort，Responses 走 reasoningEffort，Chat 平铺', () => {
    expect(GLM_VENDOR.reasoningOf({ mode: 'level', level: 'high' }, 'glm-5.3', 'messages'))
      .toEqual({ params: { thinking: { type: 'enabled' }, effort: 'high' } })
    expect(GLM_VENDOR.reasoningOf({ mode: 'level', level: 'high' }, 'glm-5.3', 'responses'))
      .toEqual({ params: { reasoningEffort: 'high' } })
    // Responses 没有思考开关字段：off 走 effort `none`（与 DeepSeek 同一处理）
    expect(GLM_VENDOR.reasoningOf({ mode: 'off' }, 'glm-5.2', 'responses'))
      .toEqual({ params: { reasoningEffort: 'none' } })
  })

  test('预算 ⇒ 报缺口（官方没有思考 token 预算参数）', () => {
    const gap = GLM_VENDOR.reasoningOf({ mode: 'budget', budgetTokens: 4096 }, 'glm-5.4')
    expect(gap !== undefined && 'gap' in gap && gap.gap).toMatch(/没有思考预算/)
  })
})



/** 一次请求的现场：地址 ＋ 全部请求头（认证位置、协议版本头都在这上面看）。 */
type ProtocolSeen = { readonly url: string; readonly headers: Headers }

/** 按顺序回放几页响应（页数用完就重复最后一页）。 */
function capturingPages(bodies: readonly unknown[]): { readonly fetch: FetchLike; readonly seen: ProtocolSeen[] } {
  const seen: ProtocolSeen[] = []
  let at = 0
  const fetch = (async (input: unknown, init?: { headers?: unknown }) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers as Record<string, string> | undefined) })
    const body = bodies[Math.min(at, bodies.length - 1)]
    at += 1
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as FetchLike
  return { fetch, seen }
}

describe('协议自带列表', () => {
  test('Chat Completions / Responses：`GET {base}/models`，Bearer 认证，归一 `data[]`', async () => {
    const { fetch, seen } = capturingPages([listBody('Qwen-Flash', 'GLM')])

    const models = await listModelsOfProtocol({
      providerId: 'relay',
      baseURL: 'https://relay.example/api',
      apiKey: 'sk-not-a-real-key',
      fetch,
      protocol: 'responses',
      auth: 'bearer',
    })

    expect(models.map((one) => one.id)).toEqual(['Qwen-Flash', 'GLM'])
    expect(seen[0]?.url).toBe('https://relay.example/api/models')
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-not-a-real-key')
    // 版本头只归 Messages 协议，别的协议不带
    expect(seen[0]?.headers.get('anthropic-version')).toBeNull()
  })

  test('认证位置按连接的 `auth`：`api-key` ⇒ `x-api-key`，不带 `authorization`', async () => {
    const { fetch, seen } = capturingPages([listBody('Qwen-Flash')])

    await listModelsOfProtocol({
      providerId: 'relay',
      baseURL: 'https://relay.example/api',
      apiKey: 'sk-not-a-real-key',
      fetch,
      protocol: 'chat-completions',
      auth: 'api-key',
    })

    expect(seen[0]?.headers.get('x-api-key')).toBe('sk-not-a-real-key')
    expect(seen[0]?.headers.get('authorization')).toBeNull()
  })

  test('Messages：带 `anthropic-version`，按 `has_more` / `last_id` 翻页，取 `display_name` 作可读名', async () => {
    const { fetch, seen } = capturingPages([
      { data: [{ id: 'claude-one', display_name: '一号' }], has_more: true, last_id: 'claude-one' },
      { data: [{ id: 'claude-two', display_name: '二号' }], has_more: false, last_id: 'claude-two' },
    ])

    const models = await listModelsOfProtocol({
      providerId: 'relay',
      baseURL: 'https://relay.example/v1',
      apiKey: 'sk-not-a-real-key',
      fetch,
      protocol: 'messages',
      auth: 'api-key',
    })

    expect(seen.map((one) => one.url)).toEqual([
      'https://relay.example/v1/models?limit=1000',
      'https://relay.example/v1/models?limit=1000&after_id=claude-one',
    ])
    expect(seen[0]?.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(seen[0]?.headers.get('x-api-key')).toBe('sk-not-a-real-key')
    expect(models).toEqual([
      { id: 'claude-one', name: '一号' },
      { id: 'claude-two', name: '二号' },
    ])
  })

  test('对面对不上协议：HTTP 状态当场抛，不带响应正文', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'sk-not-a-real-key' }), { status: 502 })) as unknown as FetchLike

    await expect(listModelsOfProtocol({
      providerId: 'relay',
      baseURL: 'https://relay.example/api',
      apiKey: 'sk-not-a-real-key',
      fetch,
      protocol: 'responses',
      auth: 'bearer',
    })).rejects.toThrow('取模型列表失败（HTTP 502）')
  })

  test('响应不是 `data[]`：报「没有 data 数组」，不拿空列表冒充没有型号', async () => {
    const { fetch } = capturingPages([{ object: 'list', items: [] }])

    await expect(listModelsOfProtocol({
      providerId: 'relay',
      baseURL: 'https://relay.example/api',
      apiKey: 'sk-not-a-real-key',
      fetch,
      protocol: 'responses',
      auth: 'bearer',
    })).rejects.toThrow('模型列表里没有 data 数组')
  })
})
