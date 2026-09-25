/**
 * U88 · 搜索的回执成形（`search.ts`）——**形状是从四次真调用里实测定下来的那一份**。
 *
 * 为什么这些判据值一组用例：这一根字符串是**主模型读到的东西**，而它的形状**照实测逐字**
 * （设计 · 网页与搜索「搜索的回执长什么样（2026-09-26 实测）」那一节）。源还没定、接线还没做，
 * 这一单的份量就在**把它钉住**——钉不住，它会在接线之前先烂掉。
 *
 * 三处分寸各有一束用例咬住：**形状逐字** · **空标题留空**（不补一句「无标题」）·
 * **套话不进回执**（且**只掐开头那一截**——中段里出现同样一句，那是搜到的内容在引它）。
 */

import { describe, expect, test } from 'bun:test'
import type { SearchLink } from '../src/index.ts'
import { searchReceiptOf } from '../src/index.ts'

/** 一次搜索的产物（照实测那一节的形：标题有 · 标题缺 · 正文是 markdown）。 */
const LINKS: readonly SearchLink[] = [
  { title: 'Magic Code', url: 'https://example.com/a' },
  { url: 'https://example.com/b' },
]

const BODY = '# 答案\n\n它是这个意思。'

describe('U88 · 搜索回执的形状', () => {
  test('逐字照实测那一节——抬头 / 空行 / 链接段 / 空行 / 正文', () => {
    const receipt = searchReceiptOf({ query: 'magic code 是什么', links: LINKS, body: BODY })

    expect(receipt).toBe(
      'Web search results for query: "magic code 是什么"\n' +
        '\n' +
        'Links: [{"title":"Magic Code","url":"https://example.com/a"},{"title":"","url":"https://example.com/b"}]\n' +
        '\n' +
        '# 答案\n' +
        '\n' +
        '它是这个意思。',
    )
  })

  test('抬头那一行里装的是**原查询**（引号里的字照给，只归一空白）', () => {
    const one = searchReceiptOf({ query: 'Tavily 免费额度', links: [], body: 'x' })
    expect(one.startsWith('Web search results for query: "Tavily 免费额度"')).toBe(true)

    // 多行 / 连着空白的查询：并成一个空格——抬头是一行的形，不归一它当场被拆成两行
    const many = searchReceiptOf({ query: '  换行\n的   查询  ', links: [], body: 'x' })
    expect(many.startsWith('Web search results for query: "换行 的 查询"')).toBe(true)
  })

  test('链接段＝**JSON 数组字面量**（紧凑 · 一行 · 键序 title 在前）', () => {
    const receipt = searchReceiptOf({ query: 'q', links: LINKS, body: 'x' })
    const line = receipt.split('\n')[2] ?? ''

    expect(line.startsWith('Links: ')).toBe(true)
    expect(JSON.parse(line.slice('Links: '.length))).toEqual([
      { title: 'Magic Code', url: 'https://example.com/a' },
      { title: '', url: 'https://example.com/b' },
    ])
  })

  test('一条链接也没有 ⇒ `Links: []`（不编、也不跳过那一段）', () => {
    const receipt = searchReceiptOf({ query: 'q', links: [], body: '正文' })
    expect(receipt.split('\n')[2]).toBe('Links: []')
  })

  test('链接段**只有 title 与 url 两把键**——源多给的字段不进回执', () => {
    const fat = { title: 'A', url: 'https://a', score: 0.91, published: '2026-09-26' }
    const receipt = searchReceiptOf({ query: 'q', links: [fat], body: 'x' })

    expect(receipt).toContain('Links: [{"title":"A","url":"https://a"}]')
    expect(receipt).not.toContain('score')
    expect(receipt).not.toContain('published')
  })
})

describe('U88 · 拿不到标题就留空', () => {
  test('缺席与全是空白同一条口径——都写成 `"title":""`', () => {
    const receipt = searchReceiptOf({
      query: 'q',
      links: [{ url: 'https://a' }, { title: '   ', url: 'https://b' }],
      body: 'x',
    })

    expect(receipt).toContain('{"title":"","url":"https://a"}')
    expect(receipt).toContain('{"title":"","url":"https://b"}')
  })

  test('**不补一句「无标题」**——整根回执里没有这三个字', () => {
    const receipt = searchReceiptOf({ query: 'q', links: [{ url: 'https://a' }], body: 'x' })
    expect(receipt).not.toContain('无标题')
  })
})

describe('U88 · 掐掉小模型的开场白（且只掐开头那一截）', () => {
  /** 实测那四次全有的两句（设计「三条白拿的细节」第三条，逐字）。 */
  const NOISES = [
    "I'll search for information about X.",
    "I'll perform a web search for that query.",
  ]

  test('开头那一句套话**不进回执**（两句各一遍）', () => {
    for (const noise of NOISES) {
      const receipt = searchReceiptOf({
        query: 'q',
        links: [],
        body: `${noise}\n\n# 答案\n\n它是这个意思。`,
      })

      expect(receipt).not.toContain(noise)
      expect(receipt.endsWith('# 答案\n\n它是这个意思。')).toBe(true)
    }
  })

  test('连着两句都掐，且不留下多余的空行', () => {
    const receipt = searchReceiptOf({
      query: 'q',
      links: [],
      body: `${NOISES[0]}\n\n${NOISES[1]}\n\n正文`,
    })

    expect(receipt.endsWith('\n\n正文')).toBe(true)
    expect(receipt).not.toContain("I'll")
  })

  test('⚠️ **只掐开头**——中段里出现同样一句，那是搜到的内容在引它，一个字不动', () => {
    const quoted = "上面那一句是别的页面在引它：I'll search for information about X."
    const receipt = searchReceiptOf({ query: 'q', links: [], body: `# 答案\n\n${quoted}` })

    expect(receipt).toContain(quoted)
  })

  test('正文整个都是套话 ⇒ 那一段**整个不出现**（不添空行、不补一句「无正文」）', () => {
    const receipt = searchReceiptOf({ query: 'q', links: LINKS, body: `${NOISES[0]}\n\n` })

    expect(receipt).toBe(
      'Web search results for query: "q"\n' +
        '\n' +
        'Links: [{"title":"Magic Code","url":"https://example.com/a"},{"title":"","url":"https://example.com/b"}]',
    )
    expect(receipt).not.toContain('无正文')
  })
})
