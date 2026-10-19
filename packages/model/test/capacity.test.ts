import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { createModelRegistry } from '../src/index.ts'

const CONFIG = (_model: string): ProviderConfig => ({ vendor: 'minimax', baseURL: 'https://alpha.example/v1' })

/** 造一张注册表：缺省条目＝**第一格**，各行按 id 给一把假 key（构造期要解析缺省那条的 key）。 */
function registryOf(providers: Record<string, ProviderConfig>) {
  return createModelRegistry({
    providers,
    modelInfoOf: (_provider, model) => model === 'MiniMax-M2' ? { id: model, limits: { maxContextTokens: 204_800 } } : undefined,
    stamper: makeTestStamper(),
    env: {},
    apiKeys: Object.fromEntries(Object.keys(providers).map((id) => [id, 'test-key'])),
  })
}

describe('条目出口 · `list()` 与**有效规格出口**（`capacityOf`）', () => {
  test('条目没声明、模型在已获取资料里 ⇒ 条目**带出来源资料那个数**（不必让用户自己补）', () => {
    const registry = registryOf({ alpha: CONFIG('MiniMax-M2') })

    expect(registry.list()).toEqual([{ id: 'alpha' }])
    expect(registry.capacityOf('alpha', 'MiniMax-M2')?.contextWindow).toBe(204_800)
  })

  test('条目声明了 ⇒ 声明优先（覆盖来源资料），哪怕模型就在表里', () => {
    const registry = registryOf({
      alpha: { ...CONFIG('MiniMax-M2'), modelOverrides: { 'MiniMax-M2': { limits: { maxContextTokens: 32_768 } } } },
    })

    expect(registry.list()).toEqual([{ id: 'alpha' }])
    expect(registry.capacityOf('alpha', 'MiniMax-M2')?.contextWindow).toBe(32_768)
  })

  test('表外模型又没声明 ⇒ **不给这一位**（不是 0、也不是占位符——外壳据「在不在」判）', () => {
    const registry = registryOf({ alpha: CONFIG('my-local-llama') })

    const first = registry.list()[0]
    expect(first).toEqual({ id: 'alpha' })
    expect('contextWindow' in (first ?? {})).toBe(false)
  })

  test('新出口：合用窗口**为本次输出预留**（缺省输出 4096 也算已发出去的数）', () => {
    const registry = registryOf({ alpha: CONFIG('my-local-llama') })

    const spec = registry.capacityOf('alpha', 'my-local-llama')
    // 没有输出覆盖 ⇒ 真会送的是缺省那一个 —— 复核：「当前请求参数并非未知」
    expect(spec?.maxOutputTokens).toBe(4_096)
    expect(spec?.inputBudget).toBeUndefined() // 这份配置里没有窗长依据

    const declared = registryOf({ alpha: { ...CONFIG('MiniMax-M2'), modelOverrides: { 'MiniMax-M2': { limits: { maxContextTokens: 10_000 } } } } })
    expect(declared.capacityOf('alpha', 'MiniMax-M2')?.inputBudget).toBe(10_000 - 4_096)
  })

  test('新出口：**两道约束取共同允许的范围**——独立输入上限不被合用窗口放大', () => {
    const registry = registryOf({
      alpha: {
        ...CONFIG('my-local-llama'),
        modelOverrides: {
          'my-local-llama': {
            limits: { maxContextTokens: 10_000, maxInputTokens: 3_000, maxOutputTokens: 2_000 },
          },
        },
      },
    })

    const spec = registry.capacityOf('alpha', 'my-local-llama')
    // 合用窗口预留后是 8000，但独立输入上限说 3000 —— **取较小的那一个**
    expect(spec?.maxOutputTokens).toBe(2_000)
    expect(spec?.inputBudget).toBe(3_000)
  })

  test('新出口：同名模型两条目**各查各的**（旧表那条口径的延续）', () => {
    const registry = registryOf({
      'alpha-gw': { ...CONFIG('MiniMax-M2'), modelOverrides: { 'MiniMax-M2': { limits: { maxContextTokens: 32_768 } } } },
      'beta-direct': CONFIG('MiniMax-M2'),
    })

    expect(registry.capacityOf('alpha-gw', 'MiniMax-M2')?.contextWindow).toBe(32_768)
    expect(registry.capacityOf('beta-direct', 'MiniMax-M2')?.contextWindow).toBe(204_800)
  })

  test('新出口：未知连接 / 未知模型 ⇒ `undefined`（不知道就是不知道）', () => {
    const registry = registryOf({ alpha: CONFIG('MiniMax-M2') })
    expect(registry.capacityOf('nope', 'MiniMax-M2')).toBeUndefined()
  })

  /**
   * **原型上有名字的条目名**（验收边界）：`providers` 的查表也只认自有键——
   * 否则 `has('toString')` 报 `true`，`use({ provider: 'toString' })` 会把
   * `Object.prototype.toString` 当配置去解 key（实测 `TypeError: …trim is not a function`）。
   * 切不动就不动：**如实报「未知供应商」**，选中原样保留。
   */
  test('`toString` / `constructor` 这类条目名 ⇒ 未知供应商（不是原型上那个东西）', () => {
    const registry = registryOf({ alpha: CONFIG('MiniMax-M2') })

    for (const id of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(registry.has(id)).toBe(false)

      const switched = registry.use({ choice: 'default', provider: id, model: 'MiniMax-M2' })
      expect(switched.ok).toBe(false)
      expect(switched.ok === false ? switched.reason : '').toContain('未知供应商')
      // 切不动就不动——选中没被这一下带偏
      expect(registry.current()).toBeUndefined()
    }
  })
})
