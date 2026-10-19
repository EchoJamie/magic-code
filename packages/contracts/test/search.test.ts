/**
 * U94 · 搜索回执成形（`search.ts`）——**逐条摘要，不再由源侧综合**。
 *
 * 这一根字符串是主模型读到的东西。判据三束：
 * ① **形状**——抬头 / 条数与边界 / 逐条四行；
 * ② **缺字段如实标明**——标题未知留空、日期未知写「未知」、摘要缺失写「该条未提供摘要」；
 * ③ **不编造、不删结果**——服务给几条就几条，顺序照给，多给的字段不进回执。
 */

import { describe, expect, test } from 'bun:test'
import type { SearchItem } from '../src/index.ts'
import { searchReceiptOf } from '../src/index.ts'

const RESULTS: readonly SearchItem[] = [
  { title: 'Magic Code', url: 'https://example.com/a', date: '2026-10-19', summary: '一个编码工具。' },
  { url: 'https://example.com/b' },
]

describe('搜索回执的形状', () => {
  test('抬头 / 条数与边界 / 逐条四行', () => {
    const receipt = searchReceiptOf({ query: 'magic code 是什么', results: RESULTS })

    expect(receipt).toBe(
      'Web search results for query: "magic code 是什么"\n' +
        '\n' +
        '结果：2 条 · 搜索服务摘要（不是页面全文；需要细节用 web_fetch 取那一页）\n' +
        '\n' +
        '1. 标题：Magic Code\n' +
        '   链接：https://example.com/a\n' +
        '   日期：2026-10-19\n' +
        '   摘要：一个编码工具。\n' +
        '\n' +
        '2. 标题：\n' +
        '   链接：https://example.com/b\n' +
        '   日期：未知\n' +
        '   摘要：该条未提供摘要',
    )
  })

  test('抬头里的查询只归一空白（其余照原样）', () => {
    const one = searchReceiptOf({ query: 'Tavily 免费额度', results: [] })
    expect(one.startsWith('Web search results for query: "Tavily 免费额度"')).toBe(true)

    const many = searchReceiptOf({ query: '  换行\n的   查询  ', results: [] })
    expect(many.startsWith('Web search results for query: "换行 的 查询"')).toBe(true)
  })

  test('空结果——抬头与 0 条说明（工具那一侧另给「本次未找到匹配结果」）', () => {
    const receipt = searchReceiptOf({ query: 'q', results: [] })
    expect(receipt).toBe(
      'Web search results for query: "q"\n' +
        '\n' +
        '结果：0 条 · 搜索服务摘要（不是页面全文；需要细节用 web_fetch 取那一页）',
    )
  })

  test('缺字段如实标明——标题留空、日期未知、摘要缺失', () => {
    const receipt = searchReceiptOf({
      query: 'q',
      results: [{ title: '   ', url: 'https://a' }, { url: 'https://b', summary: '   ' }],
    })

    expect(receipt).toContain('1. 标题：\n   链接：https://a\n   日期：未知\n   摘要：该条未提供摘要')
    expect(receipt).not.toContain('无标题')
    expect(receipt).not.toContain('无摘要')
  })

  test('服务多给的字段不进回执——只取 title / url / date / summary', () => {
    const fat = {
      title: 'A', url: 'https://a', date: '2026-10-19', summary: '摘要',
      score: 0.91, site_icon: 'https://icon', content: '正文',
    }
    const receipt = searchReceiptOf({ query: 'q', results: [fat] })

    expect(receipt).toContain('标题：A')
    expect(receipt).not.toContain('score')
    expect(receipt).not.toContain('site_icon')
    expect(receipt).not.toContain('正文：')
  })
})
