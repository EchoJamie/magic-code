/**
 * Mermaid 字符图（0.1.0）——**围栏识别 · 真实列宽 · 失败降级 · 流式时机**。
 *
 * 判据对着 `Mermaid Glyph/0.1.0.md` 的验收条件写：
 * - 含中文标签的流程图，**100 列**完整显示、边框闭合、列宽对齐；
 * - **200 列**不提前省略或折叠；
 * - 超宽 / 语法错 / 图型不支持 / 节点超限 ⇒ **退回完整源码代码块**，不报错、不出残缺图；
 * - **流式围栏未闭合**按原文显示，闭合后才成图；
 * - 已闭合那一段在**同一宽度**下反复取帧结果一致（按原文 ＋ 宽度缓存的可见后果）。
 *
 * 本文件走**真链路**（`markdown` → `rowLines`），与记录区上屏的是同一条路；
 * 色只钉「语义映射到既有色板」，不钉具体字形画法（那是库的判据）。
 */

import { describe, expect, test } from 'bun:test'
import { markdown, markdownStream } from '../src/markdown.ts'
import { rowLines } from '../src/components/log.ts'
import { PALETTE, displayWidth } from '../src/components/lines.ts'
import type { LogLine } from '../src/components/log.ts'
import type { LogRow } from '../src/view.ts'

/** 一条助手行（`key` 每条用例各用各的——行缓存按它认「还是不是同一段在长」）。 */
const assistant = (text: string, key: string): LogRow => ({ kind: 'assistant', key, text })

/** 一块 Mermaid 围栏（闭合）。 */
const fenced = (body: string): string => `\`\`\`mermaid\n${body}\n\`\`\``

/** 助手正文 → 显示行。 */
const draw = (text: string, columns: number): readonly LogLine[] =>
  rowLines(assistant(text, 'mermaid'), { columns, expanded: false })

/** 显示行的纯文字。 */
const textOf = (line: LogLine): string => line.segments.map((piece) => piece.text).join('')
const textsOf = (lines: readonly LogLine[]): readonly string[] => lines.map(textOf)

/** 有内容的色段（缩进那一格没有色）。 */
const visiblePieces = (line: LogLine): readonly { readonly text: string; readonly color?: string }[] =>
  line.segments.filter((piece) => piece.text.trim() !== '')

/** 含中文标签的那张流程图——验收表前两行用的就是这一形。 */
const FLOW = [
  'flowchart TD',
  '  A[用户输入] --> B{是否合法}',
  '  B -->|是| C[调用模型]',
  '  B -->|否| D[提示错误]',
  '  C --> E[(写入记录)]',
  '  D --> E',
].join('\n')

// ══ 围栏识别（markdown.ts）════════════════════════════════════════════

describe('围栏：保留语言标记，只认已闭合的 mermaid', () => {
  test('已闭合的 ```mermaid 块 ⇒ **整块一条** `diagram`（原文照带）', () => {
    const lines = markdown(fenced(FLOW))

    expect(lines).toHaveLength(1)
    expect(lines[0]?.diagram).toBe(FLOW)
    // 围栏与语言标记都不进显示段
    expect(textsOfText(markdown(fenced(FLOW)))).not.toContain('mermaid')
  })

  test('其它语言照旧是代码块（逐行缩进 ＋ 淡化）', () => {
    const lines = markdown('```ts\nconst a = 1\nconst b = 2\n```')

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.diagram === undefined)).toBe(true)
    expect(lines.map((line) => line.segments.map((piece) => piece.text).join(''))).toEqual([
      '  const a = 1',
      '  const b = 2',
    ])
  })

  test('大小写与 info 的额外词都认（`Mermaid` / `mermaid title="x"`）', () => {
    expect(markdown('```Mermaid\nflowchart TD\n  A --> B\n```')[0]?.diagram).toBeDefined()
    expect(markdown('```mermaid title="x"\nflowchart TD\n  A --> B\n```')[0]?.diagram).toBeDefined()
    // 只是前缀相同不算（`mermaidish` 不是 mermaid）
    expect(markdown('```mermaidish\nx\n```')[0]?.diagram).toBeUndefined()
  })

  test('**未闭合**的 mermaid 围栏：整段按原文（流式里这是常态）', () => {
    const open = '```mermaid\nflowchart TD\n  A[甲] --> B[乙]'
    const lines = markdown(open)

    expect(lines.every((line) => line.diagram === undefined)).toBe(true)
    expect(lines.map((line) => line.segments.map((piece) => piece.text).join(''))).toEqual([
      '```mermaid',
      'flowchart TD',
      '  A[甲] --> B[乙]',
    ])
  })
})

/** `markdown` 的纯文本（含空串——`diagram` 那一行没有段）。 */
function textsOfText(lines: readonly { readonly segments: readonly { readonly text: string }[] }[]): string {
  return lines.map((line) => line.segments.map((piece) => piece.text).join('')).join('\n')
}

// ══ 真实列宽（log.ts）═════════════════════════════════════════════════

describe('100 列 · 中文流程图', () => {
  const lines = draw(fenced(FLOW), 100)
  const texts = textsOf(lines)

  test('成图——框线 / 文字 / 箭头都在，围栏与 Mermaid 源码不上屏', () => {
    expect(texts.join('\n')).not.toContain('```')
    expect(texts.join('\n')).not.toContain('flowchart')

    for (const label of ['用户输入', '是否合法', '调用模型', '提示错误', '写入记录']) {
      expect(texts.some((line) => line.includes(label))).toBe(true)
    }

    expect(texts.some((line) => line.includes('┌'))).toBe(true)
    expect(texts.some((line) => line.includes('▼'))).toBe(true)
  })

  test('边框闭合、列宽对齐——同一个框的顶 / 中 / 底三行等宽', () => {
    const at = texts.findIndex((line) => line.includes('用户输入'))

    expect(at).toBeGreaterThan(0)
    const top = displayWidth(texts[at - 2] as string)
    const middle = displayWidth(texts[at] as string)
    const bottom = displayWidth(texts[at + 2] as string)

    expect(top).toBe(middle)
    expect(middle).toBe(bottom)
  })

  test('每行都不超出内容区（`columns - 2`）——超了终端会自己折，边框必断', () => {
    expect(lines.every((line) => displayWidth(textOf(line)) <= 100)).toBe(true)
  })

  test('语义色映射到既有色板：正文原色 · 框线 dim · 箭头工具蓝', () => {
    const label = lines.find((line) => textOf(line).includes('用户输入'))
    const border = lines.find((line) => textOf(line).includes('┌'))
    const arrow = lines.find((line) => textOf(line).includes('▼'))

    expect(visiblePieces(label as LogLine).some((piece) => piece.text.includes('用户输入') && piece.color === PALETTE.fg)).toBe(true)
    expect(visiblePieces(border as LogLine).every((piece) => piece.color === PALETTE.dim)).toBe(true)
    expect(visiblePieces(arrow as LogLine).some((piece) => piece.text.includes('▼') && piece.color === PALETTE.tool)).toBe(true)
  })
})

describe('200 列 · 节点不提前省略', () => {
  test('每个节点都完整画出（不折叠、不截断）', () => {
    const texts = textsOf(draw(fenced(FLOW), 200))

    for (const label of ['用户输入', '是否合法', '调用模型', '提示错误', '写入记录']) {
      expect(texts.some((line) => line.includes(label))).toBe(true)
    }

    // 边缘那几个字也在（`写入记录` 没有被 `…` 替掉）
    expect(texts.join('\n')).not.toContain('…')
    expect(texts.join('\n')).not.toContain('```')
  })

  test('同一原文在 100／200 列各出一份结果；切回来与原结果一致', () => {
    const narrow = textsOf(draw(fenced(FLOW), 100)).join('\n')
    const wide = textsOf(draw(fenced(FLOW), 200)).join('\n')
    const again = textsOf(draw(fenced(FLOW), 100)).join('\n')

    expect(narrow).toBe(again) // （原文，宽度）缓存不该把两次结果搅在一起
    expect(wide.length).toBeGreaterThanOrEqual(narrow.length)
  })
})

// ══ 失败与降级 ═════════════════════════════════════════════════════════

describe('画不出来 ⇒ 原样代码块（不报错 · 不出残缺图）', () => {
  /** 一行框线都不能有。 */
  const noDrawing = (texts: readonly string[]): boolean =>
    texts.every((line) => !/[┌┐└┘│─▼◇╭╮╰╯]/.test(line))

  test('语法错误（图头方向不合法）', () => {
    const texts = textsOf(draw(fenced('flowchart XX\n  A --> B'), 100))

    expect(noDrawing(texts)).toBe(true)
    expect(texts[0]).toBe('    flowchart XX') // INDENT ＋ 代码块缩进
    expect(texts.some((line) => line.includes('A --> B'))).toBe(true)
  })

  test('不支持的图型（时序图）', () => {
    const texts = textsOf(draw(fenced('sequenceDiagram\n  A->>B: 你好'), 100))

    expect(noDrawing(texts)).toBe(true)
    expect(texts[0]).toBe('    sequenceDiagram')
  })

  test('超宽（30 列）⇒ 完整源码，不裁半张图', () => {
    const texts = textsOf(draw(fenced(FLOW), 30))
    // 源码一行不少（这一宽下最长那行会按既有折行规矩折一次——折不是丢）
    const flat = texts.join('').replace(/\s+/g, '')

    expect(noDrawing(texts)).toBe(true)
    expect(texts[0]).toBe('    flowchart TD')
    expect(flat).toContain(FLOW.replace(/\s+/g, ''))
  })

  test('节点超限（默认 50）⇒ 源码', () => {
    const nodes = Array.from({ length: 51 }, (_, index) => `  n${index}[节点${index}] --> n${index + 1}[节点${index + 1}]`)
    const texts = textsOf(draw(fenced(['flowchart TD', ...nodes].join('\n')), 200))

    expect(noDrawing(texts)).toBe(true)
    expect(texts[0]).toBe('    flowchart TD')
    expect(texts).toHaveLength(52)
  })

  test('空围栏（没有内容）——一行都不画，也不报错', () => {
    expect(textsOf(draw('```mermaid\n```', 100))).toEqual([])
  })
})

// ══ 流式：围栏闭合后才成图 ════════════════════════════════════════════

describe('流式时机', () => {
  test('未闭合 ⇒ 原文（围栏可见）；闭合后 ⇒ 图，且不再显示围栏', () => {
    const open = `\`\`\`mermaid\n${FLOW}` // 没有闭合行
    const before = textsOf(draw(open, 100))
    expect(before[0]).toBe('  ```mermaid') // 原文逐行：INDENT ＋ 字面围栏
    expect(before.some((line) => line.includes('┌'))).toBe(false)

    const closed = `${open}\n\`\`\``
    const after = textsOf(draw(closed, 100))
    expect(after.join('\n')).not.toContain('```')
    expect(after.some((line) => line.includes('用户输入'))).toBe(true)
  })

  test('`markdownStream` 与 `markdown` 对每个前缀逐字一致（含 mermaid 块）', () => {
    const source = `前提\n\n${fenced(FLOW)}\n\n结论`

    for (let cut = 1; cut <= source.length; cut += 1) {
      const prefix = source.slice(0, cut)

      expect(textsOfText(markdownStream('mermaid-一致', prefix).lines)).toBe(textsOfText(markdown(prefix)))
    }
  })

  test('闭合后那一帧起，取帧稳定（同一正文 · 同一宽度）', () => {
    const text = `前言\n\n${fenced(FLOW)}`
    const first = textsOf(draw(text, 100)).join('\n')
    const second = textsOf(draw(text, 100)).join('\n')

    expect(first).toBe(second)
  })
})
