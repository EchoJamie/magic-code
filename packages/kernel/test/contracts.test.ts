/**
 * 契约层测试（U01 第 3–4 轮）。
 *
 * 契约是**纯类型层**——运行时几无可断言之物，故这里做两件事：
 * 1. **类型层探针**：按 kind 收窄是否成立——由 `tsc` 校验（`bun test` 只剥离类型，不做检查）；
 * 2. 规则载体（常量与纯函数）的运行时断言。
 */

import { describe, expect, test } from 'bun:test'
import {
  PROMPT_SECTIONS,
  RECORD_SCHEMA_VERSION,
  TOOLSET_V1,
  TRANSIENT_EVENT_KINDS,
  apiKeyEnvVarOf,
  expandDataDir,
} from '../src/contracts/index.ts'
import type { EventEnvelope } from '../src/contracts/index.ts'

// —— 类型层探针（tsc 校验；运行时无操作）——

/** 按 kind 收窄——`data` 应精确为该 kind 的形态。 */
export function dataNarrowsByKind(): void {
  const call: EventEnvelope<'tool.call'>['data'] = { name: 'exec', args: { cmd: 'ls' } }
  const usage: EventEnvelope<'model.usage'>['data'] = { inputTokens: 1, outputTokens: 2 }
  const empty: EventEnvelope<'turn.start'>['data'] = {}

  // @ts-expect-error 收窄生效——`model.usage` 的形态不得塞进 `tool.call` 的 data
  const wrongShape: EventEnvelope<'tool.call'>['data'] = { inputTokens: 1, outputTokens: 2 }
  // @ts-expect-error 空负载不接受字段
  const notEmpty: EventEnvelope<'turn.start'>['data'] = { extra: 1 }

  void call
  void usage
  void empty
  void wrongShape
  void notEmpty
}

/** 省略泛型即全 kind 联合——旧写法不破。 */
export function envelopeDefaultsToAllKinds(): void {
  const any: EventEnvelope['data'] = { name: 'exec', args: {} }
  const kind: EventEnvelope['kind'] = 'tool.call'
  void any
  void kind
}

describe('记录契约', () => {
  test('不落库清单只含实时事件（规则 ①）', () => {
    expect(TRANSIENT_EVENT_KINDS).toEqual(['model.delta'])
  })

  test('schema 版本自始写入（v0）', () => {
    expect(RECORD_SCHEMA_VERSION).toBe(0)
  })
})

describe('配置契约', () => {
  test('环境变量名——ID 大写、非字母数字映射为下划线', () => {
    expect(apiKeyEnvVarOf('minimax')).toBe('MAGIC_MINIMAX_API_KEY')
    expect(apiKeyEnvVarOf('my-vendor')).toBe('MAGIC_MY_VENDOR_API_KEY')
    expect(apiKeyEnvVarOf('a.b')).toBe('MAGIC_A_B_API_KEY')
  })

  test('dataDir 展开——前导 ~ 换家目录，其余字面', () => {
    expect(expandDataDir('~/.magic', '/home/u')).toBe('/home/u/.magic')
    expect(expandDataDir('~', '/home/u')).toBe('/home/u')
    expect(expandDataDir('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandDataDir('rel/path', '/home/u')).toBe('rel/path')
    // 中段 `~` 不是前导——不展开
    expect(expandDataDir('/a/~/b', '/home/u')).toBe('/a/~/b')
  })
})

describe('提示词契约', () => {
  test('必含段 v0 四段，顺序即结构', () => {
    expect(PROMPT_SECTIONS).toEqual(['identity', 'conduct', 'tools', 'permission'])
  })
})

describe('工具契约', () => {
  test('工具集 v1 六工具', () => {
    expect(TOOLSET_V1.map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'ls',
    ])
  })

  test('必闸归类——`write` 取严（覆盖＝必闸）', () => {
    const gated = TOOLSET_V1.filter((tool) => tool.danger.level === 'gated').map((tool) => tool.name)
    expect(gated).toEqual(['write'])
  })
})
