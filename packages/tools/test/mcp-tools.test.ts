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
  description,
  parameters: { type: 'object', properties: {}, required: [] },
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
