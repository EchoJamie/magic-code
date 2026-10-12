/**
 * 外部工具定义（U38 返工 B）——**列表与注册一致**那一半。
 *
 * 判据（独立验收的问题 6）：`connection.tools()` 报的那些，**一件不多、一件不少**地
 * 变成注册定义；反过来，「查得到两件、只注册了一件」这种账在结构上不该存在。
 *
 * 这一层用**桩连接**（只实现契约 `McpConnection` 那几件）——不引适配器：
 * 适配器那一侧「什么该进 `tools()`」在 `@magic/mcp` 自己的用例里咬住，
 * 本文件只管「交出来的那一份怎么变成定义」。
 */

import { describe, expect, test } from 'bun:test'
import type { McpCallOutcome, McpConnection, McpToolInfo } from '@magic/contracts'
import { defineMcpTools } from '../src/mcp-tools.ts'
import { makeToolDeps } from './helpers.ts'

/** 桩连接——`tools()` 给什么就是什么（筛子不在这儿，见文件头注）。 */
function stub(tools: readonly McpToolInfo[]): McpConnection {
  return {
    server: 'fake',
    transport: 'stdio',
    state: { status: 'available' },
    tools: () => tools,
    rejected: [],
    call: async (): Promise<McpCallOutcome> => ({ kind: 'failed', failure: 'not-sent', reason: '桩' }),
    close: async () => {},
    reconnect: async () => {},
  }
}

const tool = (name: string, description = 'probe'): McpToolInfo => ({
  name,
  validate: () => undefined,
  description,
  parameters: { type: 'object', properties: {}, required: [] },
})

describe('D58 · 外部参数准备与注册身份', () => {
  test('缺 required 字段零审批零远端调用，有效参数只审批一次', async () => {
    let calls = 0
    const echo = { ...tool('echo'), validate: (args: Readonly<Record<string, unknown>>) =>
      typeof args.text === 'string' ? undefined : '参数错误：缺少 text' }
    const connection = { ...stub([echo]), call: async (): Promise<McpCallOutcome> => {
      calls++; return { kind: 'failed', failure: 'not-sent', reason: '测试回执' }
    } }
    const deps = makeToolDeps({ tools: defineMcpTools(connection) })
    const invalid = await deps.runtime.invoke({ id: 'bad', name: 'mcp__fake__echo', args: {} }, {})
    expect(invalid.output).toContain('缺少 text')
    expect(deps.gate.requests).toHaveLength(0)
    expect(calls).toBe(0)
    await deps.runtime.invoke({ id: 'good', name: 'mcp__fake__echo', args: { text: 'hello' } }, {})
    expect(deps.gate.requests).toHaveLength(1)
    expect(calls).toBe(1)
  })

  test('审批期间重连刷新同名注册，旧调用不能投给新连接', async () => {
    let current = [tool('echo')]
    let calls = 0
    const connection = { ...stub(current), tools: () => current,
      call: async (): Promise<McpCallOutcome> => { calls++; return { kind: 'failed', failure: 'not-sent', reason: '不应发送' } },
    }
    const deps = makeToolDeps({ tools: defineMcpTools(connection), decider: () => {
      current = [tool('echo')]; return 'approve'
    } })
    const result = await deps.runtime.invoke({ id: 'old', name: 'mcp__fake__echo', args: {} }, {})
    expect(result.ok).toBe(false)
    expect(result.output).toContain('注册或连接已变化')
    expect(calls).toBe(0)
    expect(deps.gate.requests).toHaveLength(1)
  })
})

describe('列表与注册一致', () => {
  test('`tools()` 有几件就注册几件——名字与件数都对得上', () => {
    const tools = [tool('a'), tool('b'), tool('c')]
    const definitions = defineMcpTools(stub(tools))

    expect(definitions.map((definition) => definition.spec.name)).toEqual([
      'mcp__fake__a',
      'mcp__fake__b',
      'mcp__fake__c',
    ])
    expect(definitions).toHaveLength(tools.length)
  })

  test('空表 ⇒ 空定义（连上了但没有工具，不是错）', () => {
    expect(defineMcpTools(stub([]))).toEqual([])
  })

  test('每一条定义都带着**注册表给的身份**（工具的注册名与身份两处同源）', () => {
    const [definition] = defineMcpTools(stub([tool('echo')]))

    expect(definition?.external).toEqual({ server: 'fake', tool: 'echo' })
    expect(definition?.spec.danger).toEqual({ level: 'gated', reason: 'external' })
  })
})

test('D58 · 不可编译 schema 不发送给模型，旧调用仍得到具体不可用原因', async () => {
  const reason = '工具参数 schema 无法编译：不支持的引用'
  const bad = { ...tool('bad'), parameters: { $ref: 'https://invalid.example/schema' }, unavailable: reason, validate: () => reason }
  const deps = makeToolDeps({ tools: defineMcpTools(stub([tool('good'), bad])) })
  expect(deps.runtime.definitions().map(spec => spec.name)).toContain('mcp__fake__good')
  expect(deps.runtime.definitions().map(spec => spec.name)).not.toContain('mcp__fake__bad')
  const result = await deps.runtime.invoke({ id: 'old', name: 'mcp__fake__bad', args: {} }, {})
  expect(result.output).toBe(reason)
  expect(deps.gate.requests).toHaveLength(0)
})
