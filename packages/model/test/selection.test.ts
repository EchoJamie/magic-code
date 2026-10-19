import { describe, expect, test } from 'bun:test'
import type { AgentModelConfig, ModelInfo, ProviderConfig, ReasoningSetting } from '@magic/contracts'
import { drainStream, makeTestStamper } from '@magic/faux'
import { createModelRegistry, selectModel } from '../src/index.ts'

const providers: Record<string, ProviderConfig> = {
  ds: { vendor: 'deepseek', protocol: 'chat-completions', apiKey: 'local-ds' },
  mm: { vendor: 'minimax', protocol: 'chat-completions', apiKey: 'local-mm' },
  missing: { vendor: 'deepseek', protocol: 'chat-completions' },
}
const defaults: AgentModelConfig = { protocol: 'chat-completions', endpoint: 'https://api.deepseek.com', choice: 'default', provider: 'ds', model: 'deepseek-flash', reasoning: { mode: 'level', level: 'high' } }
const known = (_p: string, m: string): ModelInfo | undefined => ['deepseek-flash', 'MiniMax-M3'].includes(m) ? { id: m, reasoning: { disable: true, levels: ['low', 'high', 'max'] } } : undefined
const registry = (modelInfoOf: (p: string, m: string) => ModelInfo | undefined = known) => createModelRegistry({
  providers, stamper: makeTestStamper(), env: {}, modelInfoOf,
})

describe('完整选择的校验与原子提交', () => {
  test('预检不提交或构造网关，运行层不再叠加部分 provider/model', async () => {
    const models = registry()
    expect(selectModel({ providers, modelInfoOf: known }, defaults)).toEqual({ ok: true, selection: defaults })
    expect(models.current()).toBeUndefined()
    for (const partial of [{ provider: 'ds' }, { model: 'deepseek-flash' }, { reasoning: { mode: 'off' } }, {}]) {
      expect(models.use(partial as unknown as AgentModelConfig).ok).toBe(false)
    }
    expect((await drainStream(models.stream({ messages: [] }))).result.error).toBeDefined()
    expect(models.current()).toBeUndefined()
  })

  test('完整提交不会继承上一组合的思考设置；Default 与 off 保持不同含义', () => {
    const models = registry()
    expect(models.use(defaults).ok).toBe(true)
    expect(models.use({ choice: 'spell', provider: 'mm', model: 'MiniMax-M3', protocol: 'chat-completions', endpoint: 'https://api.minimax.cn/v1' })).toEqual({
      ok: true, selection: { choice: 'spell', provider: 'mm', model: 'MiniMax-M3', protocol: 'chat-completions', endpoint: 'https://api.minimax.cn/v1' },
    })
    expect(models.current()?.reasoning).toBeUndefined()
    for (const reasoning of [{ mode: 'off' } as const, { mode: 'default' } as const]) {
      expect(models.use({ ...defaults, reasoning }).ok).toBe(true)
      expect(models.current()?.reasoning).toEqual(reasoning)
    }
  })

  test('能力只认精确连接和型号，API 当前值优先于供应商补充', () => {
    const modelInfoOf = (p: string, m: string): ModelInfo | undefined =>
      p === 'ds' && m === 'deepseek-flash' ? { id: m, reasoning: { levels: ['low'], disable: false } } : undefined
    const options = { providers, modelInfoOf }
    expect(selectModel(options, defaults).ok).toBe(false)
    expect(selectModel(options, { ...defaults, reasoning: { mode: 'off' } }).ok).toBe(false)
    expect(selectModel(options, { ...defaults, reasoning: { mode: 'level', level: 'low' } }).ok).toBe(true)
    const unknown = selectModel(options, { ...defaults, provider: 'mm', model: 'MiniMax-M2.5', endpoint: 'https://api.minimax.cn/v1', reasoning: { mode: 'off' } })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toContain('思考能力未知')
    expect(selectModel(options, { ...defaults, provider: 'mm', model: 'MiniMax-M2.5', endpoint: 'https://api.minimax.cn/v1', reasoning: { mode: 'default' } }).ok).toBe(true)
  })

  test('用户能力覆盖精确生效；适配不能表达的设置仍拒绝', () => {
    const configured = { ds: { ...providers.ds, modelOverrides: {
      'deepseek-flash': { reasoningSupport: {} }, 'deepseek-v4-pro': { reasoningSupport: { levels: ['ultra'], budget: { minTokens: 128, maxTokens: 256 } } },
    } } }
    expect(selectModel({ providers: configured }, defaults).ok).toBe(false)
    expect(selectModel({ providers: configured }, { ...defaults, model: 'deepseek-v4-pro', reasoning: { mode: 'default' } }).ok).toBe(true)
    for (const reasoning of [{ mode: 'level', level: 'ultra' }, { mode: 'budget', budgetTokens: 64 }, { mode: 'budget', budgetTokens: 200 }] as const) {
      expect(selectModel({ providers: configured }, { ...defaults, model: 'deepseek-v4-pro', reasoning }).ok).toBe(false)
    }
  })

  test('未知连接、适配、缺 key、空字段和不支持设置均保留旧配置', () => {
    const models = registry()
    expect(models.use(defaults).ok).toBe(true)
    const old = models.current()
    for (const change of [{ provider: 'unknown' }, { provider: 'missing' }, { model: ' ' }, { provider: '' },
      { reasoning: { mode: 'level' as const, level: 'ultra' } }, { provider: 'mm', model: 'MiniMax-M2.5', protocol: 'chat-completions' as const, endpoint: 'https://api.minimax.cn/v1', reasoning: { mode: 'off' as const } },
      { reasoning: null as unknown as ReasoningSetting }]) {
      expect(models.use({ ...defaults, ...change }).ok).toBe(false)
      expect(models.current()).toBe(old)
    }
    const wrong = createModelRegistry({ providers: { wrong: { vendor: 'unknown' } }, stamper: makeTestStamper() })
    expect(wrong.use({ ...defaults, provider: 'wrong' }).ok).toBe(false)
  })

  test('调用方修改原对象不改已提交选择', () => {
    const models = registry()
    const reasoning = { mode: 'level' as const, level: 'high' }
    expect(models.use({ ...defaults, reasoning }).ok).toBe(true)
    reasoning.level = 'low'
    expect(models.current()?.reasoning).toEqual({ mode: 'level', level: 'high' })
  })

  test('不支持设置和未绑定选择均不尝试网络请求', async () => {
    let calls = 0
    const models = createModelRegistry({ providers, stamper: makeTestStamper(), fetch: async () => { calls++; throw new Error('不得调用') } })
    expect(models.use({ choice: 'cantrip', provider: 'mm', model: 'MiniMax-M2.5', reasoning: { mode: 'off' } }).ok).toBe(false)
    expect((await drainStream(models.stream({ messages: [] }))).result.error).toBeDefined()
    expect(calls).toBe(0)
  })
})

test('有效思考支持与实际映射同源，协议不能表达的用户声明不开放', async () => {
  const { effectiveReasoningSupportOf } = await import('../src/index.ts')
  const info = { exact: { reasoningSupport: { disable: true, levels: ['low', 'xhigh', 'made-up'], budget: { minTokens: 1024 } } } }
  const config: ProviderConfig = { baseURL: 'http://local/v1', modelOverrides: info }
  expect(effectiveReasoningSupportOf({ ...config, protocol: 'responses' }, 'exact')).toEqual({ disable: true, levels: ['low', 'xhigh'] })
  expect(effectiveReasoningSupportOf({ ...config, protocol: 'messages' }, 'exact')).toEqual({ disable: true, levels: ['low', 'xhigh'], budget: { minTokens: 1024 } })
  expect(effectiveReasoningSupportOf({ vendor: 'minimax', protocol: 'responses' }, 'MiniMax-M3', { id: 'MiniMax-M3', reasoning: { disable: true } })).toEqual({ disable: true })
  expect(effectiveReasoningSupportOf({ vendor: 'minimax', protocol: 'chat-completions' }, 'MiniMax-M3')).toBeUndefined()
  expect(effectiveReasoningSupportOf({ vendor: 'deepseek', protocol: 'responses' }, 'deepseek-v4-pro')).toBeUndefined()
  expect(effectiveReasoningSupportOf(config, 'undeclared')).toBeUndefined()
})
