/**
 * U72 · 网页正文 → markdown（`html.ts`）。
 *
 * 判据的口径：**够模型按问题找答案**——结构读得出来（哪是标题、哪是列表、哪是链接、
 * 哪是代码），字一个不少；**不追像素级还原**（那是浏览器的事，不是这一趟的终点）。
 * 故这里断的是「这一段字与这一段结构在不在」，不是逐字节对齐某个库的输出。
 */

import { describe, expect, test } from 'bun:test'
import { decodeEntities, htmlToMarkdown } from '../src/html.ts'

describe('U72 · HTML → markdown', () => {
  test('标题成 `#`，段落成段（块之间隔空行）', () => {
    const got = htmlToMarkdown('<h1>定价</h1><p>第一段</p><p>第二段</p>').markdown
    expect(got).toBe('# 定价\n\n第一段\n\n第二段')
  })

  test('`<title>` 单独交出来（回执抬头要用），不进正文', () => {
    const got = htmlToMarkdown('<html><head><title>定价 · 官网</title></head><body><p>正文</p></body></html>')
    expect(got.title).toBe('定价 · 官网')
    expect(got.markdown).toBe('正文')
  })

  test('列表：无序成 `-`，有序按序号', () => {
    expect(htmlToMarkdown('<ul><li>甲</li><li>乙</li></ul>').markdown).toBe('- 甲\n- 乙')
    expect(htmlToMarkdown('<ol><li>甲</li><li>乙</li></ol>').markdown).toBe('1. 甲\n2. 乙')
  })

  test('链接与强调成形，图片带说明', () => {
    const got = htmlToMarkdown('<p>见 <a href="https://example.com/x">文档</a> 与 <strong>重点</strong></p>').markdown
    expect(got).toBe('见 [文档](https://example.com/x) 与 **重点**')
    expect(htmlToMarkdown('<img src="/a.png" alt="示意图">').markdown).toBe('![示意图](/a.png)')
  })

  test('代码块成围栏，里面的空白**一个字都不折叠**', () => {
    const got = htmlToMarkdown('<pre><code>def f():\n    return 1</code></pre>').markdown
    expect(got).toContain('```')
    expect(got).toContain('    return 1')
  })

  test('表格按行铺成 `|` 格（不还原对齐，只保住「哪一格是哪一格」）', () => {
    const got = htmlToMarkdown('<table><tr><th>档位</th><th>价</th></tr><tr><td>标准</td><td>12</td></tr></table>').markdown
    expect(got).toContain('| 档位 | 价 |')
    expect(got).toContain('| 标准 | 12 |')
  })

  test('脚本 / 样式 / 注释 / `head` 一律不进正文', () => {
    const got = htmlToMarkdown(
      '<html><head><style>p{color:red}</style></head><body><script>alert(1)</script><p>只有这句</p><!-- 注 --></body></html>',
    ).markdown

    expect(got).toBe('只有这句')
    expect(got).not.toContain('alert')
    expect(got).not.toContain('color')
  })

  test('实体解码（具名 ＋ 数字两种）', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#65; &#x42; &nbsp;d')).toBe('a & b <c> A B  d')
    // 认不得的原样留着——**编一个字符出来比留着更坏**
    expect(decodeEntities('&nosuchentity;')).toBe('&nosuchentity;')
  })

  test('空白折叠：多余的换行与行尾空格都收干净', () => {
    expect(htmlToMarkdown('<p>  一  二  </p><div></div><div></div><p>三</p>').markdown).toBe('一 二\n\n三')
  })

  test('引用带 `> `（丢了标记，模型读不出那是引用）', () => {
    expect(htmlToMarkdown('<blockquote><p>引的这句</p></blockquote>').markdown).toBe('> 引的这句')
  })

  test('纯文本页面：转一遍不伤它（没有标签就当正文原样）', () => {
    expect(htmlToMarkdown('就一行字，没有标签').markdown).toBe('就一行字，没有标签')
  })
})
