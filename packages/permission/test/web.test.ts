/**
 * U72 · 取网页的判定与呈现 —— **外发必闸，而「总是允许」落在域名上**。
 *
 * 工单那两句合起来看才是本文件的判据：
 * - 「取网是外发 ⇒ **必闸**」——判重，卡要给足判断材料；
 * - 「「总是允许」**按域名给，不按工具给**」——记下来的那一条只覆盖**这一个域名**。
 *
 * 故这里咬三件：
 * 1. **卡上说清发给哪个域名**（`host` 那一位 ＋ 材料里那一行）——批的是什么，屏上看得见；
 * 2. **一条授权只放一个域名**：同一域名的第二次不再问，换一个域名照旧问；
 * 3. **按域名那条口子开得很窄**：不写域名的规则**够不着**它，写给别的工具的
 *    域名规则**也够不着**（否则一条 `{tool:'exec', host:'x.com'}` 能把必闸掏空）。
 *
 * ⚠️ 地址**取不得**的那些（本机 / 无点 / 非 http）也在这儿：它们**不发请求**，
 * 故卡上明说「不会发出去」，且**没有域名可记**（`a` 那一格不给）。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolCall } from '@magic/contracts'
import { createPermissionGate } from '../src/index.ts'
import type { PermissionRule } from '../src/index.ts'
import { call, context, harness, ledger } from './helpers.ts'

/** 一次取网页的调用。 */
function fetchCall(url: string, prompt = '这一页说了什么'): ToolCall {
  return call('web_fetch', { url, prompt })
}

/**
 * 问一次——把**询问事件**与现场交回来（不答）。
 *
 * `request` 可能缺席（规则命中 ⇒ 没问）——那是**正当结果之一**，故这里不抛
 * （用例自己按 `h.countOf('tool.decision.request')` 判）。
 */
function askOnce(toolCall: ToolCall, rules: readonly PermissionRule[] = []) {
  const h = harness()
  const grants = ledger()
  const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, rules, grants })
  const answered = gate.decide(toolCall, context(), 1).catch(() => 'reject' as const)

  return { h, gate, grants, request: h.eventsOf('tool.decision.request')[0], answered }
}

/** 问一次，**且要求真问了**（多数用例要的是这一种）。 */
function askedOnce(toolCall: ToolCall, rules: readonly PermissionRule[] = []) {
  const asked = askOnce(toolCall, rules)
  if (asked.request === undefined) throw new Error('未发询问事件')
  return asked as typeof asked & { readonly request: NonNullable<typeof asked.request> }
}

describe('U72 · 取网页：外发必闸', () => {
  test('判重（outbound），卡上给出**发给哪个域名**', () => {
    const { request } = askedOnce(fetchCall('https://example.com/pricing'))

    expect(request.data.weight).toBe('heavy')
    expect(request.data.host).toBe('example.com')
    expect(request.data.material).toContain('example.com')
    // 发出去的只有那个地址——问什么、看什么都不会发到这个站点
    expect(request.data.material).toContain('外发')
  })

  test('`http` 升过之后才对：卡上的地址与真发出去的是同一个', () => {
    const { request } = askedOnce(fetchCall('http://example.com/plain'))

    expect(request.data.material).toContain('https://example.com/plain')
    expect(request.data.host).toBe('example.com')
  })

  test('取不得的地址：不发请求、没有域名可记（材料照实说）', () => {
    for (const bad of ['http://localhost:8080/x', 'https://intranet/wiki', 'ftp://example.com/x']) {
      const { request } = askedOnce(fetchCall(bad))

      expect(request.data.weight).toBe('heavy')
      expect(request.data.host).toBeUndefined()
      expect(request.data.material).toContain('不会发出任何请求')
    }
  })

  test('一条**没写域名**的规则够不着它（否则一条宽规则就把这一次必闸放行了）', () => {
    const rules: readonly PermissionRule[] = [{ tool: 'web_fetch', op: 'outbound' }]
    const { h, request } = askedOnce(fetchCall('https://example.com/x'), rules)

    expect(h.countOf('tool.decision.request')).toBe(1) // 照问
    // **连命中都不算**（不是「命中了又被必闸否决」）——没写域名的规则在这一维上无从比对
    expect(request.data.material).not.toContain('规则')
  })

  test('写给**别的工具**的域名规则也够不着它（`exec` 那一侧没有域名这一维）', () => {
    const rules: readonly PermissionRule[] = [{ tool: 'exec', op: 'outbound', host: 'example.com' }]
    const { h } = askedOnce(fetchCall('https://example.com/x'), rules)

    expect(h.countOf('tool.decision.request')).toBe(1)
  })

  test('正面：写了域名、且对得上 ⇒ 不问了（那正是用户手写的那一条窄规则）', () => {
    const yes: readonly PermissionRule[] = [{ tool: 'web_fetch', op: 'outbound', host: 'example.com' }]
    expect(askOnce(fetchCall('https://example.com/x'), yes).h.countOf('tool.decision.request')).toBe(0)

    const no: readonly PermissionRule[] = [{ tool: 'web_fetch', op: 'outbound', host: 'other.example' }]
    expect(askedOnce(fetchCall('https://example.com/x'), no).h.countOf('tool.decision.request')).toBe(1)
  })
})

describe('U72 · 「总是允许」按域名给', () => {
  /**
   * 问一次并数一数**新挂出来的卡**——同一个账本、同一道闸（`resolve` 认的是**本闸**发的
   * 那个 id，另造一道闸去答是答不上的：陌生 id 按迟到/伪造忽略）。
   */
  function asker(): {
    readonly h: ReturnType<typeof harness>
    readonly grants: ReturnType<typeof ledger>
    readonly gate: ReturnType<typeof createPermissionGate>
    asked(url: string): number
    answer(remember: boolean): void
  } {
    const h = harness()
    const grants = ledger()
    const gate = createPermissionGate({ sink: h.sink, stamper: h.stamper, grants })

    return {
      h,
      grants,
      gate,
      asked(url) {
        const before = h.countOf('tool.decision.request')
        void gate.decide(fetchCall(url), context(), 1).catch(() => {})
        return h.countOf('tool.decision.request') - before
      },
      answer(remember) {
        const request = h.eventsOf('tool.decision.request').at(-1)
        if (request === undefined) throw new Error('还没问过')
        gate.resolve(request.id, 'approve', { remember })
      },
    }
  }

  test('拨 `a` 之后：**同域名不再问**，**别的域名照问**', () => {
    const { grants, asked, answer } = asker()

    // 第一趟：问了——这就是「必闸」在行为上的样子（默认没有一处自动放行）
    expect(asked('https://example.com/a')).toBe(1)

    answer(true)
    // ⚠️ 授权里**必须带域名**：少了它这一条会覆盖任意域名（那正是工单要挡的那件事）
    expect(grants.rules().map(({ tool, op, host }) => ({ tool, op, host }))).toEqual([
      { tool: 'web_fetch', op: ['outbound'], host: 'example.com' },
    ])

    expect(asked('https://example.com/b')).toBe(0) // 同域名：不再问
    expect(asked('https://other.example/x')).toBe(1) // 别的域名：照问
  })

  test('子域也算别的域名（授权是精确那一个，不是那一家）', () => {
    const { asked, answer } = asker()

    expect(asked('https://example.com/a')).toBe(1)
    answer(true)

    expect(asked('https://www.example.com/a')).toBe(1)
  })

  test('取不得的地址：卡上**没有域名**，那一下「总是允许」也开不了任何门', () => {
    const { asked, answer } = asker()

    expect(asked('https://intranet/wiki')).toBe(1)
    answer(true)

    // 无论答的是「批准」还是「总是允许」，下一趟照旧问——没有域名可记
    expect(asked('https://intranet/wiki')).toBe(1)
  })
})
