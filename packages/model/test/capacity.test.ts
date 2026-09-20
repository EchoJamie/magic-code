/**
 * U30 · 容量（上下文窗总量）—— **内置表 ＋ 覆盖判定**（域内那半）。
 *
 * 判据锚的是「**我要什么**」，逐条：
 *
 * 1. **已知模型不要求用户自己补客观容量**——窗长是模型的客观属性、我们有官方出处
 *    （`capacity.ts` 记着 URL）：查得到就得给得出，不必等配置里写一行；
 * 2. **用户已明确配置的保持覆盖能力**——声明了就用声明的数（本地端点 / 私有部署的
 *    真实窗长只有用户知道）；
 * 3. **未知 / 别名不能证实 ⇒ 不知道**——`undefined`（分母 `null`），**不模糊匹配一整个
 *    家族、不拿别名顶上、不编数**；
 * 4. **同一张表经条目出口出去**（`list()` 与 `contextWindows()`）——外壳与 `model.catalog`
 *    两处取材同源，不会分叉。
 *
 * 数值的**出处**（2026-09-20 核 · 单位 token）：MiniMax 开放平台模型表
 * https://platform.minimax.io/docs/guides/text-generation 。
 */

import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { MODEL_CONTEXT_BUILTIN, createModelRegistry, resolveContextWindow } from '../src/index.ts'

// ═══════════════════════════════════════════════════════════════════════
// 一 · 裁定：声明 → 内置表 → 未知
// ═══════════════════════════════════════════════════════════════════════

describe('容量裁定 · 声明 → 内置表 → 未知', () => {
  test('内置命中：官方表里那些模型，查得出**逐行那个数**', () => {
    // 旗舰（1M）与 M2（204.8k）——两个不同量级，免得上线时把表写串了还看不出来
    expect(resolveContextWindow('MiniMax-M3')).toBe(1_000_000)
    expect(resolveContextWindow('MiniMax-M2')).toBe(204_800)
  })

  test('同家变体**逐行精确 id**，不是家族匹配——每个 id 单独在表里，数取官方那一行', () => {
    for (const id of [
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M2.5',
      'MiniMax-M2.5-highspeed',
      'MiniMax-M2.1',
      'MiniMax-M2.1-highspeed',
    ]) {
      expect(resolveContextWindow(id)).toBe(204_800)
    }
  })

  test('声明覆盖内置：给了数就用给的数（本地端点 / 私有部署的窗长只有用户知道）', () => {
    expect(resolveContextWindow('MiniMax-M3', 32_768)).toBe(32_768)
    // 声明对表外模型同样成立——覆盖位不是「内置的补丁」，是独立的来处
    expect(resolveContextWindow('my-local-llama', 8_192)).toBe(8_192)
  })

  test('未知 / 别名 / 表外：`undefined`——不猜、不模糊匹配、不编', () => {
    // 表里没有的模型
    expect(resolveContextWindow('MiniMax-M9')).toBeUndefined()
    // **不许前缀匹配**：名字里带着 MiniMax-M3 的另一个模型 ≠ MiniMax-M3
    expect(resolveContextWindow('MiniMax-M3-preview')).toBeUndefined()
    expect(resolveContextWindow('MiniMax-M3.1')).toBeUndefined()
    // 大小写不同＝另一个键（与真跑送出去的模型名逐字对齐，不做大小写折叠）
    expect(resolveContextWindow('minimax-m3')).toBeUndefined()
    // 别名 / 简写不能证实 ⇒ 不知道
    expect(resolveContextWindow('M3')).toBeUndefined()
    // 官方表把 M2-her 写成「64 K」——**单位不肯定**，故整行不收（宁可未知，不编）
    expect(resolveContextWindow('M2-her')).toBeUndefined()
    // 连空串也照这条走（载荷缺字段时别拿一个"看起来像 0"的东西顶上）
    expect(resolveContextWindow('')).toBeUndefined()
  })

  test('内置表**只有**那几个键——加行是有意的（表本身即规格，别在别处偷偷拼）', () => {
    expect(Object.keys(MODEL_CONTEXT_BUILTIN).sort()).toEqual(
      [
        'MiniMax-M2',
        'MiniMax-M2.1',
        'MiniMax-M2.1-highspeed',
        'MiniMax-M2.5',
        'MiniMax-M2.5-highspeed',
        'MiniMax-M2.7',
        'MiniMax-M2.7-highspeed',
        'MiniMax-M3',
      ].sort(),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 出口：同一条判定，两处取材（条目表 · 窗长表）
// ═══════════════════════════════════════════════════════════════════════

const CONFIG = (model: string): ProviderConfig => ({ baseURL: 'https://alpha.example/v1', model })

/** 造一张注册表：缺省条目＝**第一格**，各行按 id 给一把假 key（构造期要解析缺省那条的 key）。 */
function registryOf(providers: Record<string, ProviderConfig>) {
  return createModelRegistry({
    providers,
    defaultProvider: Object.keys(providers)[0] ?? '',
    stamper: makeTestStamper(),
    env: {},
    apiKeys: Object.fromEntries(Object.keys(providers).map((id) => [id, 'test-key'])),
  })
}

describe('条目出口 · `list()` 与 `contextWindows()`', () => {
  test('条目没声明、模型在内置表里 ⇒ 条目**带出内置那个数**（不必让用户自己补）', () => {
    const registry = registryOf({ alpha: CONFIG('MiniMax-M2') })

    expect(registry.list()).toEqual([{ id: 'alpha', model: 'MiniMax-M2', contextWindow: 204_800 }])
  })

  test('条目声明了 ⇒ 声明优先（覆盖内置），哪怕模型就在表里', () => {
    const registry = registryOf({
      alpha: { ...CONFIG('MiniMax-M2'), contextWindow: 32_768 },
    })

    expect(registry.list()).toEqual([{ id: 'alpha', model: 'MiniMax-M2', contextWindow: 32_768 }])
  })

  test('表外模型又没声明 ⇒ **不给这一位**（不是 0、也不是占位符——外壳据「在不在」判）', () => {
    const registry = registryOf({ alpha: CONFIG('my-local-llama') })

    const first = registry.list()[0]
    expect(first).toEqual({ id: 'alpha', model: 'my-local-llama' })
    expect('contextWindow' in (first ?? {})).toBe(false)
  })

  test('窗长表：内置打底 ＋ 各条目声明盖上——**只有已知的键在**（外壳据此查）', () => {
    const registry = registryOf({
      known: CONFIG('MiniMax-M2'),
      declared: { ...CONFIG('my-local-llama'), contextWindow: 8_192 },
      unknown: CONFIG('MiniMax-No-Such-Model'),
    })

    const table = registry.contextWindows()

    // 内置那几行都在
    expect(table['MiniMax-M3']).toBe(1_000_000)
    expect(table['MiniMax-M2']).toBe(204_800)
    // 声明的那个模型进了表（它的窗长只有用户知道，正是覆盖位的用处）
    expect(table['my-local-llama']).toBe(8_192)
    // 不知道的**连键都不在**（≠ 0）——外壳 `?? null` 即「不知道」
    expect('MiniMax-No-Such-Model' in table).toBe(false)
  })

  test('窗长表与条目表**同源**——同一模型两处报的数一致（不会分叉）', () => {
    const registry = registryOf({
      alpha: CONFIG('MiniMax-M3'),
      beta: { ...CONFIG('MiniMax-M2'), contextWindow: 100_000 },
    })

    const table = registry.contextWindows()
    for (const entry of registry.list()) {
      expect(entry.contextWindow).toBe(table[entry.model])
    }
  })
})
