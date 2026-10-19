/**
 * U94 · `web_search` —— 逐条摘要、零辅助模型、失败分档。
 *
 * 判据：
 * ① 规格——名字 · 参数只有 query · 外发必闸；
 * ② 成的那一趟——need_content=false（服务那一侧保证），回执是逐条摘要；
 * ③ query 1–128 字符，超长报错不截断；
 * ④ 空结果 / 服务失败 / 未配置 三件事分开说；
 * ⑤ 没有辅助模型入口——工具构造入参里根本没有 Cantrip。
 */

import { describe, expect, test } from 'bun:test'
import type { WebSearchItem, WebSearchOutcome, WebSource } from '@magic/contracts'
import { WEB_SEARCH_SPEC, defineWebSearchTool } from '../src/index.ts'
import type { WebServiceRef } from '../src/index.ts'
import { defineToolsetV1 } from '../src/toolset.ts'
import { makeToolDeps } from './helpers.ts'

type Searching = WebSource & {
  readonly asked: string[]
}

function fakeWeb(outcome: (query: string) => WebSearchOutcome): Searching {
  const asked: string[] = []

  return {
    asked,
    fetchPage: () => Promise.resolve({ ok: false, reason: 'not used' }),
    search: (input) => {
      asked.push(input.query)
      return Promise.resolve(outcome(input.query))
    },
  }
}

const service = (web: WebSource): (() => WebServiceRef) =>
  () => ({ ok: true, web, provider: 'test', scope: 'test' })

function toolWith(web: WebSource) {
  const definition = defineWebSearchTool({ web: service(web) })
  return makeToolDeps({ tools: [definition] })
}

async function call(deps: ReturnType<typeof makeToolDeps>, args: Record<string, unknown>) {
  const result = await deps.runtime.invoke({ id: 'c1', name: 'web_search', args }, {})
  return { ok: result.ok, output: result.output }
}

const ITEMS: readonly WebSearchItem[] = [
  { title: 'A', url: 'https://a', date: '2026-10-19', summary: '摘要 A' },
  { title: '', url: 'https://b' },
]

describe('web_search ① 规格', () => {
  test('名字与既有的 grep 分得开，参数只有 query', () => {
    expect(WEB_SEARCH_SPEC.name).toBe('web_search')
    expect(WEB_SEARCH_SPEC.name).not.toBe('grep')
    expect(Object.keys(WEB_SEARCH_SPEC.parameters['properties'] as Record<string, unknown>)).toEqual(['query'])
    expect(WEB_SEARCH_SPEC.parameters['required']).toEqual(['query'])
    expect(WEB_SEARCH_SPEC.parameters['additionalProperties']).toBe(false)
  })

  test('危险归类声明外发必闸', () => {
    expect(WEB_SEARCH_SPEC.danger).toEqual({ level: 'gated', reason: 'outbound' })
  })

  test('有执行体——工具可以真跑起来', () => {
    expect('run' in WEB_SEARCH_SPEC).toBe(false) // 规格面不带执行体
    expect(typeof defineWebSearchTool({ web: service(fakeWeb(() => ({ ok: true, results: [] }))) }).run).toBe('function')
  })

  test('默认七件里仍没有它——它由装配按配置追加', () => {
    expect(defineToolsetV1().map((one) => one.spec.name)).not.toContain('web_search')
  })
})

describe('web_search ② 成的那一趟', () => {
  test('回执是逐条标题 / 链接 / 日期 / 摘要，并标明是服务摘要', async () => {
    const web = fakeWeb(() => ({ ok: true, results: ITEMS }))
    const got = await call(toolWith(web), { query: 'magic code' })

    expect(got.ok).toBe(true)
    expect(got.output).toContain('Web search results for query: "magic code"')
    expect(got.output).toContain('结果：2 条 · 搜索服务摘要')
    expect(got.output).toContain('1. 标题：A')
    expect(got.output).toContain('   链接：https://a')
    expect(got.output).toContain('   日期：2026-10-19')
    expect(got.output).toContain('   摘要：摘要 A')
    // 缺字段如实标明
    expect(got.output).toContain('2. 标题：\n   链接：https://b\n   日期：未知\n   摘要：该条未提供摘要')
  })

  test('交给服务的是模型写的 query（去首尾空白），一次调用只搜一次', async () => {
    const web = fakeWeb(() => ({ ok: true, results: ITEMS }))
    const deps = toolWith(web)

    await call(deps, { query: '  简明问题  ' })

    expect(web.asked).toEqual(['简明问题'])
  })

  test('没有辅助模型入口——构造入参只有 web', () => {
    const deps = defineWebSearchTool({ web: service(fakeWeb(() => ({ ok: true, results: [] }))) })
    expect(Object.keys(deps).sort()).toEqual(['prepare', 'run', 'spec', 'unavailable', 'via'])
  })
})

describe('web_search ③ query 校验', () => {
  test('空 / 全空白 / 超长都报参数错，且零出网', async () => {
    const web = fakeWeb(() => ({ ok: true, results: [] }))
    const deps = toolWith(web)

    expect((await call(deps, { query: '' })).output).toContain('参数错误')
    expect((await call(deps, { query: '   ' })).output).toContain('不得全是空白')
    const long = (await call(deps, { query: '字'.repeat(129) })).output
    expect(long).toContain('128')
    expect(long).toContain('不会替你截断')
    expect(web.asked).toHaveLength(0)
  })

  test('恰好 128 个字符可以发', async () => {
    const web = fakeWeb(() => ({ ok: true, results: [] }))
    const got = await call(toolWith(web), { query: '字'.repeat(128) })

    expect(got.ok).toBe(true)
    expect(web.asked).toHaveLength(1)
  })
})

describe('web_search ④ 空结果 / 失败 / 未配置', () => {
  test('空结果是一份结果，不是失败', async () => {
    const got = await call(toolWith(fakeWeb(() => ({ ok: true, results: [] }))), { query: 'q' })

    expect(got.ok).toBe(true)
    expect(got.output).toBe('本次未找到匹配结果。')
  })

  test('服务失败照实报，不伪装成「未找到」', async () => {
    const got = await call(toolWith(fakeWeb(() => ({ ok: false, reason: '网页服务限流（HTTP 429）' }))), { query: 'q' })

    expect(got.ok).toBe(false)
    expect(got.output).toContain('429')
    expect(got.output).not.toContain('未找到')
  })

  test('网页服务未配置：工具不可用，在途调用零出网并说清原因', async () => {
    const web = fakeWeb(() => ({ ok: true, results: [] }))
    const definition = defineWebSearchTool({ web: () => ({ ok: false, reason: '网页服务尚未配置——去 /web 选择连接' }) })
    const deps = makeToolDeps({ tools: [definition] })

    expect(deps.runtime.definitions().map((one) => one.name)).not.toContain('web_search')
    const got = await call(deps, { query: 'q' })
    expect(got.ok).toBe(false)
    expect(got.output).toContain('尚未配置')
    expect(web.asked).toHaveLength(0)
  })
})
