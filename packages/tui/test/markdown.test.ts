/**
 * Markdown 渲染（缺陷轮 V · D14）——**助手正文**的五样 ＋ 流式容忍。
 *
 * 出处：`界面原型.html` ·「Markdown 渲染（记录区的助手正文）」。
 * 纯函数级：解析 → 显示行（样式已就位）——不起 Ink。
 */

import { describe, expect, test } from 'bun:test'
import { markdown } from '../src/markdown.ts'
import type { MdLine } from '../src/markdown.ts'

/** 一条显示行的纯文本（断言「看得见什么」）。 */
const textOf = (line: MdLine): string => line.segments.map((piece) => piece.text).join('')

/** 整段的纯文本（按行）。 */
const textsOf = (source: string): readonly string[] => markdown(source).map(textOf)

/** 某条行里有没有「加粗」的段。 */
const hasBold = (line: MdLine): boolean => line.segments.some((piece) => piece.bold === true)

const boldTextOf = (line: MdLine): string =>
  line.segments.filter((piece) => piece.bold === true).map((piece) => piece.text).join('')

// ══ 五样 ═════════════════════════════════════════════════════════════

describe('五样——各自成形', () => {
  test('粗体 `**x**`：**标记不见**、文字加粗', () => {
    const [line] = markdown('这是 **Magic Code** 的验收')

    expect(line).toBeDefined()
    expect(textOf(line as MdLine)).toBe('这是 Magic Code 的验收')
    expect(boldTextOf(line as MdLine)).toBe('Magic Code')
  })

  test('行内代码 `` `x` ``：标记不见、**换色**（且**不换背景**——省行高）', () => {
    const [line] = markdown('跑 `m02-real-endpoint.ts` 看看')
    const code = (line as MdLine).segments.find((piece) => piece.text === 'm02-real-endpoint.ts')

    expect(textOf(line as MdLine)).toBe('跑 m02-real-endpoint.ts 看看')
    expect(code?.color).toBeDefined() // 换色
    expect(code?.bold).toBeUndefined()
    // 背景不换：段上不带 backgroundColor 这一位（`MdLine` 的段没有这个键）
    expect(Object.keys(code ?? {})).not.toContain('background')
  })

  test('代码块：**去掉围栏**、缩进 ＋ 淡化', () => {
    const lines = markdown('看这段：\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n完')

    expect(textsOf('看这段：\n\n```ts\nconst a = 1\nconst b = 2\n```\n\n完')).toEqual([
      '看这段：',
      '',
      '  const a = 1',
      '  const b = 2',
      '',
      '完',
    ])
    // 代码块那两行淡化（dim）
    const code = lines[2] as MdLine
    expect(code.segments.every((piece) => piece.color !== undefined)).toBe(true)
    // 围栏本身**不出现**
    expect(textsOf('```ts\nx\n```').join('\n')).not.toContain('```')
  })

  test('列表 `- x` / `1. x`：**保留符号**、缩进对齐', () => {
    const lines = markdown('- 第一条\n- 第二条\n1. 有序')

    expect(lines.map(textOf)).toEqual(['- 第一条', '- 第二条', '1. 有序'])
    // 缩进对齐：续行挂在符号之后
    expect(lines[0]?.hang).toBe('  ')
    expect(lines[2]?.hang).toBe('   ')
  })

  test('标题 `# x`：加粗、**去掉 `#`**', () => {
    const [line] = markdown('## 这一段在说什么')

    expect(textOf(line as MdLine)).toBe('这一段在说什么')
    expect(hasBold(line as MdLine)).toBe(true)
    expect(textOf(line as MdLine)).not.toContain('#')
    // 层级（`#` 的个数）不影响首站的呈现——只去标记
    expect(textsOf('### 三级也一样')).toEqual(['三级也一样'])
  })
})

// ══ 不渲染（留白 · 首站保持原文）══════════════════════════════════════

describe('不渲染——留白到站再定', () => {
  test('表格 · 图片 · 嵌套引用：**原样**', () => {
    expect(textsOf('| a | b |')).toEqual(['| a | b |'])
    expect(textsOf('|---|') .concat(textsOf('| 1 | 2 |'))).toEqual(['|---|', '| 1 | 2 |'])
    expect(textsOf('![图](http://x/y.png)')).toEqual(['![图](http://x/y.png)'])
    expect(textsOf('> 引用')).toEqual(['> 引用'])
    expect(textsOf('>> 嵌套引用')).toEqual(['>> 嵌套引用'])
  })

  test('链接：**保留文字、URL 淡化**', () => {
    const [line] = markdown('见 [说明](https://example.com/x)')

    expect(textOf(line as MdLine)).toBe('见 说明（https://example.com/x）')
    const url = (line as MdLine).segments.find((piece) => piece.text.includes('example.com'))
    expect(url?.color).toBeDefined() // URL 淡化（弱色）
  })
})

// ══ 流式容忍 ═════════════════════════════════════════════════════════

describe('流式容忍不完整标记——**先字面、闭合后转样式**', () => {
  test('未闭合的 `**` —— 按**字面**显示（不吞、不半截加粗）', () => {
    const [line] = markdown('这是 **Magic Co')

    expect(textOf(line as MdLine)).toBe('这是 **Magic Co')
    expect(hasBold(line as MdLine)).toBe(false) // 一个段都不加粗（未闭合）
  })

  test('未闭合的反引号 —— 同样按字面', () => {
    expect(textsOf('跑 `m02-real')).toEqual(['跑 `m02-real'])
  })

  test('闭合之后**转样式**（且只转一次，不来回）', () => {
    const open = textsOf('这是 **Magic Co')
    const closed = markdown('这是 **Magic Co** 了')

    expect(open).toEqual(['这是 **Magic Co'])
    expect(closed.map(textOf)).toEqual(['这是 Magic Co 了'])
    expect(boldTextOf(closed[0] as MdLine)).toBe('Magic Co')
  })

  test('代码块未闭合（流式中）——**先按原文**，围栏一闭合才成块', () => {
    // 只有开围栏：整段按原文（` ``` ` 那行照旧可见）
    expect(textsOf('```ts\nconst a = 1')).toEqual(['```ts', 'const a = 1'])
    // 闭合之后：围栏不见、缩进淡化
    expect(textsOf('```ts\nconst a = 1\n```')).toEqual(['  const a = 1'])
  })

  test('**不闪不跳**——同一段输入渲染两次，结果一模一样（纯函数 · 无隐藏状态）', () => {
    const source = '看 **这个** `片段`\n\n```\nx\n```\n\n- 甲\n- 乙'

    expect(markdown(source)).toEqual(markdown(source))
  })

  test('半截的粗体标记不会吃掉后面的正文', () => {
    expect(textsOf('前 **中 后')).toEqual(['前 **中 后'])
  })
})
