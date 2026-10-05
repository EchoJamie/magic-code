import { describe, expect, test } from 'bun:test'
import type { ModelInfo, ProviderConfig, ReasoningSetting } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import { createModelRegistry } from '../src/index.ts'

const providers: Record<string, ProviderConfig> = {
  ds: { vendor: 'deepseek', apiKey: 'local-ds' },
  mm: { vendor: 'minimax', apiKey: 'local-mm' },
  missing: { vendor: 'deepseek' },
}
const defaults = { alias: 'default' as const, provider: 'ds', model: 'same', reasoning: { mode: 'level' as const, level: 'high' } }
const registry = (info?: (p: string, m: string) => ModelInfo | undefined) => createModelRegistry({
  providers, stamper: makeTestStamper(), env: {}, modelInfoOf: info,
})

describe('已解析组合与成员快照', () => {
  test('纯预检不提交选择，也不构造网关或请求', () => {
    const models = registry()
    expect(models.resolve({ defaults, config: { reasoning: { mode: 'level', level: 'low' } } })).toEqual({ ok: true, selection: { ...defaults, reasoning: { mode: 'level', level: 'low' } } })
    expect(models.current()).toBeUndefined()
    expect(models.resolve({ defaults })).toEqual({ ok: true, selection: defaults })
  })

  test('连接没有默认型号；初次缺少实际组合失败，未选中时请求型号不能提供默认', async () => {
    const models = registry()
    expect(models.use({ provider: 'ds' }).ok).toBe(false)
    expect(models.use({ model: 'same' }).ok).toBe(false)
    const result = await drainStream(models.stream({ model: 'same', messages: [] }))
    expect(result.result.error).toBeDefined()
    expect(models.current()).toBeUndefined()
  })

  test('实际供应商或型号变更切断旧思考；相同型号在不同连接也不继承', () => {
    const models = registry()
    expect(models.resolve({ defaults, config: { alias: 'cantrip', provider: 'mm', model: 'same' } })).toEqual({ ok: true, selection: { alias: 'cantrip', provider: 'mm', model: 'same' } })
    expect(models.resolve({ defaults, config: { model: 'other' } })).toEqual({ ok: true, selection: { alias: 'default', provider: 'ds', model: 'other' } })
  })

  test('同组合继承；Default 和 off 不互换；仅思考设置保留当前型号', () => {
    const models = registry()
    expect(models.use(defaults).ok).toBe(true)
    expect(models.use({ reasoning: { mode: 'off' } })).toEqual({ ok: true, selection: { ...defaults, reasoning: { mode: 'off' } } })
    expect(models.use({ alias: 'spell', model: 'same' }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'off' })
    expect(models.current()?.alias).toBe('spell')
    expect(models.use({ reasoning: { mode: 'default' } }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'default' })
  })

  test('更换实际组合回到目标模型默认；不从规格覆盖取得思考设置', () => {
    const models = createModelRegistry({ providers, stamper: makeTestStamper() })
    expect(models.resolve({ defaults, config: { model: 'specific' } })).toEqual({ ok: true, selection: { alias: 'default', provider: 'ds', model: 'specific' } })
    expect(models.use({ alias: 'spell', provider: 'ds', model: 'specific', reasoning: { mode: 'default' } }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'default' })
  })
})

describe('能力校验与失败原子性', () => {
  test('按精确连接和型号能力校验；不借用另一连接的能力', () => {
    const models = registry((p, m) => p === 'ds' && m === 'same' ? { id: m, reasoning: { levels: ['low'], disable: false } } : undefined)
    expect(models.resolve({ defaults }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { reasoning: { mode: 'off' } } }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { reasoning: { mode: 'level', level: 'low' } } }).ok).toBe(true)
    const unknown = models.resolve({ defaults, config: { provider: 'mm', model: 'same', reasoning: { mode: 'off' } } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('未知')
    expect(models.resolve({ defaults, config: { provider: 'mm', model: 'same', reasoning: { mode: 'default' } } }).ok).toBe(true)
  })

  test('能力覆盖精确命中；适配无法表达时拒绝预算或虚构档位', () => {
    const models = createModelRegistry({ providers: { ds: { ...providers.ds, modelOverrides: {
      same: { reasoningSupport: {} }, custom: { reasoningSupport: { levels: ['ultra'], budget: { minTokens: 128, maxTokens: 256 } } },
    } } }, stamper: makeTestStamper() })
    expect(models.resolve({ defaults }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { model: 'other', reasoning: { mode: 'level', level: 'high' } } }).ok).toBe(true)
    for (const reasoning of [{ mode: 'level' as const, level: 'ultra' }, { mode: 'budget' as const, budgetTokens: 64 }, { mode: 'budget' as const, budgetTokens: 200 }]) {
      expect(models.resolve({ defaults, config: { model: 'custom', reasoning } }).ok).toBe(false)
    }
  })

  test('未知连接、适配、空字段、缺 key、不支持设置均保留旧配置', () => {
    const models = registry()
    expect(models.use(defaults).ok).toBe(true)
    const old = models.current()
    for (const request of [{ provider: 'unknown' }, { provider: 'missing' }, { model: ' ' }, { provider: '' }, { reasoning: { mode: 'level' as const, level: 'ultra' } }, { provider: 'mm', model: 'same', reasoning: { mode: 'off' as const } }]) {
      expect(models.use(request).ok).toBe(false)
      expect(models.current()).toBe(old)
    }
    const wrong = createModelRegistry({ providers: { wrong: { vendor: 'unknown' } }, stamper: makeTestStamper() })
    expect(wrong.use({ provider: 'wrong', model: 'same' }).ok).toBe(false)
    expect(models.use({ reasoning: null as unknown as ReasoningSetting }).ok).toBe(false)
    expect(models.current()).toBe(old)
  })

  test('显式设置捕获快照；调用方修改原对象不改已提交选择', () => {
    const models = registry()
    const reasoning = { mode: 'level' as const, level: 'high' }
    expect(models.use({ alias: 'default', provider: 'ds', model: 'same', reasoning }).ok).toBe(true)
    reasoning.level = 'low'
    expect(models.current()?.reasoning).toEqual({ mode: 'level', level: 'high' })
  })

  test('不支持设置在出站之前拒绝；没有选择不尝试网络请求', async () => {
    let calls = 0
    const models = createModelRegistry({ providers, stamper: makeTestStamper(), fetch: async () => { calls++; throw new Error('不得调用') } })
    expect(models.use({ alias: 'cantrip', provider: 'mm', model: 'same', reasoning: { mode: 'off' } }).ok).toBe(false)
    const result = await drainStream(models.stream({ model: 'same', messages: [] }))
    expect(result.result.error).toBeDefined()
    expect(calls).toBe(0)
  })
})
