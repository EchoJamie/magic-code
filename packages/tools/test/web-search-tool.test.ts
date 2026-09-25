/**
 * U88 · `web_search` —— **定义留下、不注册**。
 *
 * 两束判据，对着工单的两句话：
 *
 * | 束 | 咬住的 |
 * | --- | --- |
 * | ① **规格** | 名字（与既有的 `grep` 分得开）· 一句话说明 · 参数（只有 `query` 一把键）· 外发归类；**并且没有执行体**——它是**结构上**跑不起来的 |
 * | ② ⚠️ **反面**（本单最要紧的一条） | **这一件不在给模型的工具集里**——默认集里没有它，真造一张注册表也没有它 |
 *
 * 回执成形那一半的用例在**契约**（`@magic/contracts` 的 `test/search.test.ts`）——
 * 成形不在本域，见 `web-search-tool.ts` 头注那一条「服务将来落哪一域还没定，域之间
 * 又不互相 import」。
 */

import { describe, expect, test } from 'bun:test'
import { defineToolsetV1 } from '../src/toolset.ts'
import { WEB_SEARCH_SPEC } from '../src/web-search-tool.ts'
import { makeToolDeps } from './helpers.ts'

describe('U88 · web_search 的规格（定义留下）', () => {
  test('名字与既有的 grep 分得开——一个搜工作区里的文件内容，一个搜网上', () => {
    expect(WEB_SEARCH_SPEC.name).toBe('web_search')
    // 与「取网页」同一族（一个找、一个取）；而 `grep` 是沙箱那一条底上的另一件事
    expect(WEB_SEARCH_SPEC.name.startsWith('web_')).toBe(true)
    expect(WEB_SEARCH_SPEC.name).not.toBe('grep')
  })

  test('一句话说明——括号里说清它内部干了什么（它是与「取网页」最容易混的那一件）', () => {
    expect(WEB_SEARCH_SPEC.summary).toBe('联网搜索（一次查询 → 读若干页 → 回答案与出处）')
  })

  test('参数只有 query 一把键（参照面里的域过滤**设计里没有**，故不先占位）', () => {
    const parameters = WEB_SEARCH_SPEC.parameters

    expect(parameters['type']).toBe('object')
    expect(Object.keys(parameters['properties'] as Record<string, unknown>)).toEqual(['query'])
    expect(parameters['required']).toEqual(['query'])
    expect(parameters['additionalProperties']).toBe(false)

    const query = (parameters['properties'] as Record<string, { readonly type?: string }>)['query']
    expect(query?.type).toBe('string')
  })

  test('参数模式可序列化（送模型＝JSON 往返不变）', () => {
    expect(WEB_SEARCH_SPEC.parameters).toEqual(JSON.parse(JSON.stringify(WEB_SEARCH_SPEC.parameters)))
  })

  test('危险归类声明的是**方向**：外发 ⇒ 必闸（与 web_fetch 同一条口径）', () => {
    expect(WEB_SEARCH_SPEC.danger).toEqual({ level: 'gated', reason: 'outbound' })
  })

  test('⚠️ **没有执行体**——这一件结构上跑不起来（一个搜索源都没接）', () => {
    // `run` 这一格压根不在：没有谁拿着它去执行，也就没有「跑得起来」这回事。
    // 将来接线那一步要补的是它 ＋ 装配那一行 ＋ 权限域的分析格，三件一起。
    expect('run' in WEB_SEARCH_SPEC).toBe(false)
  })
})

describe('U88 · 反面：不在给模型的工具集里', () => {
  test('默认集（工具集 v1 七件）里没有它——一件不多', () => {
    const names = defineToolsetV1().map((definition) => definition.spec.name)

    expect(names).toHaveLength(7)
    expect(names).not.toContain(WEB_SEARCH_SPEC.name)
    expect(names.filter((name) => name.includes('search'))).toEqual([])
  })

  test('真造一张注册表——`definitions()`（随每次调用送模型的那一份）里也没有它', () => {
    const names = makeToolDeps().runtime.definitions().map((spec) => spec.name)

    expect(names).not.toContain(WEB_SEARCH_SPEC.name)
    // 「含 search 的一个都没有」——改名绕过去也咬得住（`grep` 是搜工作区的，名字里没这两个字）
    expect(names.filter((name) => name.includes('search'))).toEqual([])
  })
})
