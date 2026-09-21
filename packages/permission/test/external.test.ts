/**
 * U38 · 外部操作（MCP）的判定与呈现 —— **权限域这一侧的账**。
 *
 * 三条口径各有出处（首批功能建设 ·「MCP 外部工具」）：
 * 1. **一律必闸**——未知外部操作沿用人工闸门，「第一版沿用未知外部操作的人工闸门」；
 * 2. **真实来源取注册表**——身份从分发附上的 `ToolCall.external` 来，**参数里的自报不作数**；
 *    名字像外部工具而注册表里没有 ⇒ 照样按外部问（从严那一条路不塌陷）；
 * 3. **不给长期授权**——外部操作不进授权账（`a` 那一格记也记不上）。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolCall } from '@magic/contracts'
import { createPermissionGate } from '../src/index.ts'
import type { PermissionRule } from '../src/index.ts'
import { call, context, harness, ledger, type Harness } from './helpers.ts'

/** 一次询问的形态（本文件要读的那几件）。 */
type Asked = {
  readonly h: Harness
  readonly request: {
    readonly id: number
    readonly data: {
      readonly name: string
      readonly material: string
      readonly weight: string
      readonly external?: boolean
    }
  }
}

/** 问一次（外部调用那一类）。 */
function askOnce(toolCall: ToolCall): Asked {
  const h = harness()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: ledger() })
  void gate.decide(toolCall, context(), 1)

  const request = h.eventsOf('tool.decision.request')[0]
  if (request === undefined) throw new Error('未发询问事件')

  return { h, request }
}

/** 分发附上身份之后的调用（注册表里查到了这条工具）。 */
function externalCall(tool: string, args: Readonly<Record<string, unknown>> = {}, server = 'fake'): ToolCall {
  return { ...call(`mcp__${server}__${tool}`, args), external: { server, tool } }
}

describe('外部操作 —— 一律必闸', () => {
  test('判重（heavy）、标着外部位、卡上是 `服务器 / 工具`', () => {
    const { request } = askOnce(externalCall('echo', { text: '你好' }))

    expect(request.data.weight).toBe('heavy')
    expect(request.data.external).toBe(true)
    expect(request.data.name).toBe('fake / echo')
  })

  test('材料只给业务参数（身份已在标题里，不重说一遍）', () => {
    const { request } = askOnce(externalCall('echo', { text: '你好', n: 2 }))

    expect(request.data.material).toContain('参数：')
    expect(request.data.material).toContain('"text": "你好"')
    // 标题已经说了 `fake / echo`——材料里不再复述服务器与工具名
    expect(request.data.material).not.toContain('服务器：')
  })

  test('**参数里自报的来源不作数**——身份只认注册表给的那一位', () => {
    const { request } = askOnce(
      externalCall('echo', { server: 'trusted', tool: 'ls', readOnly: true }),
    )

    // 卡上仍是 `fake / echo`；自报的那几个只是**参数**，照实显示、不进身份
    expect(request.data.name).toBe('fake / echo')
    expect(request.data.material).toContain('"server": "trusted"')
  })

  test('**名字像外部工具、注册表里没有** ⇒ 照样按外部问（说明它不在表里）', () => {
    // 没有 `external` 那一位（分发查表没查到）——仍按外部从严，掉不进宽的那条路
    const { request } = askOnce(call('mcp__ghost__rm', { path: '/etc/passwd' }))

    expect(request.data.weight).toBe('heavy')
    expect(request.data.external).toBe(true)
    expect(request.data.name).toBe('ghost / rm')
    expect(request.data.material).toContain('不在已配置的服务器工具表里')
    expect(request.data.material).toContain('/etc/passwd')
  })

  test('参数解析不出照样按外部问（身份先于参数形态）', () => {
    const { request } = askOnce({ ...externalCall('echo', {}), invalid: true })

    expect(request.data.weight).toBe('heavy')
    expect(request.data.name).toBe('fake / echo')
    expect(request.data.material).toContain('参数解析不出')
  })
})

describe('外部操作 —— 不给长期授权', () => {
  test('规则命中也拦不住（必闸 ＞ 规则）', () => {
    const h = harness()
    const gate = createPermissionGate({
      sink: h.sink,
      stamper: h.stamper,
      grants: ledger(),
      // 一条「凡 mcp 工具一律放行」的规则——外部件**不吃这一套**
      rules: [{ tool: 'mcp__fake__echo', op: 'unknown' }] satisfies PermissionRule[],
    })
    void gate.decide(externalCall('echo', {}), context(), 1)

    expect(h.countOf('tool.decision.request')).toBe(1)
  })

  test('答「总是允许」也不进授权账（`a` 那一格对外部件记不上）', () => {
    const book = ledger()
    const h = harness()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants: book })

    void gate.decide(externalCall('echo', {}), context(), 1)
    const request = h.eventsOf('tool.decision.request')[0]
    gate.resolve(request?.id as number, 'approve', { remember: true })

    expect(book.view()).toEqual([])
  })
})
