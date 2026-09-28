import { describe, expect, test } from 'bun:test'
import type { ModelInfo, ProviderConfig, ReasoningSetting } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import { createModelRegistry } from '../src/index.ts'

const providers: Record<string, ProviderConfig> = {
  ds: { vendor: 'deepseek', model: 'same', apiKey: 'local-ds' },
  mm: { vendor: 'minimax', model: 'same', apiKey: 'local-mm' },
  unset: { vendor: 'deepseek', apiKey: 'local-unset' },
  missing: { vendor: 'deepseek', model: 'same' },
}
const defaults = { provider: 'ds', model: 'same', reasoning: { mode: 'level' as const, level: 'high' } }
const registry = (info?: (p: string, m: string) => ModelInfo | undefined) => createModelRegistry({
  providers, stamper: makeTestStamper(), env: {}, modelInfoOf: info,
})

describe('Agent 配置分层解析', () => {
  test('明确 > 角色 > 协作；解析不改选择、不构造网关或请求', () => {
    const models = registry()
    const result = models.resolve({ defaults, role: { reasoning: { mode: 'off' } }, config: { reasoning: { mode: 'level', level: 'low' } } })
    expect(result).toEqual({ ok: true, selection: { ...defaults, reasoning: { mode: 'level', level: 'low' } } })
    expect(models.current()).toBeUndefined()
    expect(models.resolve({ defaults, config: {} })).toEqual({ ok: true, selection: defaults })
  })

  test('只换供应商取其用户默认；相同型号也不沿用另一供应商的档位', () => {
    expect(registry().resolve({ defaults, role: { provider: 'mm' } })).toEqual({ ok: true, selection: { provider: 'mm', model: 'same' } })
    expect(registry().resolve({ defaults, config: { provider: 'unset' } }).ok).toBe(false)
    expect(registry().resolve({ defaults, config: { provider: 'unset', model: 'chosen' } })).toEqual({ ok: true, selection: { provider: 'unset', model: 'chosen' } })
  })

  test('只换型号留在已选连接，跨型号不用旧档位；高层组合变更不继承低层 reasoning', () => {
    expect(registry().resolve({ defaults, role: { provider: 'mm' }, config: { model: 'mini-other' } })).toEqual({ ok: true, selection: { provider: 'mm', model: 'mini-other' } })
    expect(registry().resolve({ defaults, config: { model: 'other' } })).toEqual({ ok: true, selection: { provider: 'ds', model: 'other' } })
  })

  test('同组合可继承；显式 default 与 off 不互换；思考单字段切换保留当前型号', () => {
    const models = registry()
    expect(models.use({ provider: 'ds', model: 'other', reasoning: { mode: 'level', level: 'high' } }).ok).toBe(true)
    expect(models.use({ reasoning: { mode: 'off' } })).toEqual({ ok: true, selection: { provider: 'ds', model: 'other', reasoning: { mode: 'off' } } })
    expect(models.use({ model: 'other' }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'off' })
    expect(models.use({ reasoning: { mode: 'default' } }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'default' })
  })

  test('精确型号用户默认生效；明确 default 仍覆盖它', () => {
    const models = createModelRegistry({ providers: { ds: { ...providers.ds, modelOverrides: { specific: { reasoning: { mode: 'off' } } } } }, stamper: makeTestStamper() })
    expect(models.resolve({ defaults, config: { model: 'specific' } })).toEqual({ ok: true, selection: { provider: 'ds', model: 'specific', reasoning: { mode: 'off' } } })
    expect(models.use({ provider: 'ds', model: 'specific', reasoning: { mode: 'default' } }).ok).toBe(true)
    expect(models.current()?.reasoning).toEqual({ mode: 'default' })
  })

  test('默认连接还没选过型号，首次只指定 model 仍使用该连接', () => {
    const models = createModelRegistry({ providers, defaultProvider: 'unset', stamper: makeTestStamper() })
    expect(models.current()).toBeUndefined()
    expect(models.use({ model: 'chosen' })).toEqual({ ok: true, selection: { provider: 'unset', model: 'chosen' } })
  })
})

describe('能力校验与失败原子性', () => {
  test('按精确连接/型号能力校验，不把同名模型的能力给另一供应商', () => {
    const models = registry((p, m) => p === 'ds' && m === 'same' ? { id: m, reasoning: { levels: ['low'], disable: false } } : undefined)
    expect(models.resolve({ defaults }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { reasoning: { mode: 'off' } } }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { reasoning: { mode: 'level', level: 'low' } } }).ok).toBe(true)
    const unknown = models.resolve({ defaults, config: { provider: 'mm', reasoning: { mode: 'off' } } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('未知')
    expect(models.resolve({ defaults, config: { provider: 'mm', reasoning: { mode: 'default' } } }).ok).toBe(true)
  })

  test('能力覆盖仅命中精确组合；适配无法表达时拒绝预算或虚构档位', () => {
    const models = createModelRegistry({ providers: { ds: { ...providers.ds, modelOverrides: {
      same: { reasoningSupport: {} },
      custom: { reasoningSupport: { levels: ['ultra'], budget: { minTokens: 128, maxTokens: 256 } } },
    } } }, stamper: makeTestStamper() })
    expect(models.resolve({ defaults }).ok).toBe(false)
    expect(models.resolve({ defaults, config: { model: 'other', reasoning: { mode: 'level', level: 'high' } } }).ok).toBe(true)
    for (const reasoning of [{ mode: 'level' as const, level: 'ultra' }, { mode: 'budget' as const, budgetTokens: 64 }, { mode: 'budget' as const, budgetTokens: 200 }]) {
      expect(models.resolve({ defaults, config: { model: 'custom', reasoning } }).ok).toBe(false)
    }
  })

  test('未知供应商/适配/空字段/缺默认/缺 key/不支持档位均保留旧配置', () => {
    const models = registry()
    expect(models.use(defaults).ok).toBe(true)
    const old = models.current()
    for (const request of [{ provider: 'unknown' }, { provider: 'unset' }, { provider: 'missing' }, { model: ' ' }, { provider: '' }, { reasoning: { mode: 'level' as const, level: 'ultra' } }, { provider: 'mm', reasoning: { mode: 'off' as const } }]) {
      expect(models.use(request).ok).toBe(false)
      expect(models.current()).toBe(old)
    }
    const wrong = createModelRegistry({ providers: { wrong: { vendor: 'unknown', model: 'same' } }, stamper: makeTestStamper() })
    expect(wrong.use({ provider: 'wrong' }).ok).toBe(false)
    expect(wrong.current()).toBeUndefined()
    expect(models.use({ reasoning: null as unknown as ReasoningSetting }).ok).toBe(false)
    expect(models.current()).toBe(old)
  })

  test('显式设置快照不受调用方对象随后修改影响', () => {
    const models = registry()
    const reasoning = { mode: 'level' as const, level: 'high' }
    expect(models.use({ provider: 'ds', model: 'same', reasoning }).ok).toBe(true)
    reasoning.level = 'low'
    expect(models.current()?.reasoning).toEqual({ mode: 'level', level: 'high' })
  })

  test('配置默认路径也拒绝不支持设置，出站次数为零', async () => {
    let calls = 0
    const models = createModelRegistry({ providers: { mm: { ...providers.mm, reasoning: { mode: 'off' } } }, defaultProvider: 'mm', stamper: makeTestStamper(), fetch: async () => { calls++; throw new Error('不得调用') } })
    const result = await drainStream(models.stream({ model: 'same', messages: [{ role: 'user', content: 'hello' }] }))
    expect(result.result.error?.message).toContain('未知')
    expect(calls).toBe(0)
  })
})
