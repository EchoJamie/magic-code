/**
 * Tab 的显示表示（2026-09-22 · [[交接/工单/Tab多行重印]]）——**原文不动，屏上按终端的规矩画**。
 *
 * 根因（真 PTY 实测 + 三处量法对照）：同一个 `\t` 在三处量出了**三个宽度**——
 * 本仓记录区那支 `charWidth` 算 **1 列** · Ink 那支 `string-width` 算 **0 列** ·
 * 终端（与 `wrap-ansi`）把它**展成到下一张 8 列制表位的空格**。记录区那些按宽度**补齐到
 * 屏宽**的行于是比终端以为的短一截：终端多出来的那几列**自己折了一行** ⇒ 应用的行数账目
 * 少一行 ⇒ 上一帧擦不干净 ⇒ 含 Tab 的多行正文提交后**重印**（8 次）。
 *
 * 修法：显示层把 Tab 展开成与终端一致的那段空白（`lines.ts` 的 `expandTabs`）——**原文
 * （草稿 / 模型请求 / 记录）里的 `\t` 一字不动**。
 */

import { describe, expect, test } from 'bun:test'
import type { LogRow } from '../src/view.ts'
import { rowLines } from '../src/components/log.ts'
import { expandTabs, tabWidth, wrap } from '../src/components/lines.ts'
import { composerLayout } from '../src/components/composer.ts'

/** 一行（含色段）的纯文本。 */
function textOf(line: { readonly segments: readonly { readonly text: string }[] }): string {
  return line.segments.map((piece) => piece.text).join('')
}

describe('Tab 的展开（与终端 / `wrap-ansi` 同一条）', () => {
  test('到下一张 8 列的制表位——行首一个 Tab 铺满 8 列', () => {
    expect(tabWidth(0)).toBe(8)
    expect(tabWidth(3)).toBe(5)
    expect(tabWidth(8)).toBe(8)
    expect(expandTabs('\tprint(1)')).toBe(`${' '.repeat(8)}print(1)`)
  })

  test('行内 Tab 按**它落的那一列**算', () => {
    expect(expandTabs('left\tright')).toBe(`left${' '.repeat(4)}right`)
    expect(expandTabs('  \tprint(1)')).toBe(`${' '.repeat(8)}print(1)`)
  })

  test('**没有 Tab 的文字一个字不改**（对照：普通正文不受影响）', () => {
    const plain = 'if ready:\n  print(1)\nleft right'
    expect(expandTabs(plain)).toBe(plain)
  })
})

describe('折行：展开之后再折（账与屏同一本）', () => {
  test('折出来的行里**没有 Tab**，且宽度就是我们算的那个', () => {
    const lines = wrap('if ready:\n\tprint(1)\nleft\tright', 98)

    expect(lines.some((line) => line.includes('\t'))).toBe(false)
    expect(lines).toEqual(['if ready:', `${' '.repeat(8)}print(1)`, `left${' '.repeat(4)}right`])
  })

  test('展开出来的空格**参与折行**（不是白涨宽度）——行宽不会越过上限', () => {
    const lines = wrap(`${'x'.repeat(99)}\t`, 100)

    expect(lines.length).toBe(2) // 99 列之后那 5 列空白：前 1 列留在本行、余下 4 列折下去
    expect(lines.every((line) => line.length <= 100)).toBe(true)
  })
})

describe('记录区那一行：屏上不留 Tab（修前会重印的那一条）', () => {
  /** 一条用户消息（粘贴进来的一段多行代码）。 */
  const userRow: LogRow = {
    kind: 'user',
    key: 'u1',
    text: 'if ready:\n\tprint(1)\nleft\tright',
    echoed: true,
  }

  test('画出来的每一行都不含 Tab，且不超宽（超了终端会自己折 ⇒ 行数账目分家）', () => {
    const lines = rowLines(userRow, { columns: 100, expanded: false, spaced: false })
    const texts = lines.map(textOf)

    expect(texts.some((line) => line.includes('\t'))).toBe(false)
    // ⚠️ 这一条是**修前失败**的那一条：展开前 `  \tprint(1)` 按 11 列算、终端按 16 列画，
    //    再补齐到 100 列就是 105 列 ⇒ 终端折一行 ⇒ 行数对不上 ⇒ 重印
    expect(texts.every((line) => line.length <= 100)).toBe(true)
    // 首行带 `› `；**续行带两格悬挂缩进**（既有形态）——Tab 那 8 格排在它之后
    expect(texts).toEqual([
      '› if ready:',
      `${' '.repeat(2)}${' '.repeat(8)}print(1)`,
      `${' '.repeat(2)}left${' '.repeat(4)}right`,
    ])
  })

  test('**原文不动**：行是把 Tab 展开画出来的，文本本身仍是一个 `\t`', () => {
    expect(userRow.text).toContain('\t')
    expect(userRow.text).toBe('if ready:\n\tprint(1)\nleft\tright')
  })
})

describe('输入行：插入点落在终端画它的那一格（Tab 也要展开着量）', () => {
  test('行内 Tab：插入点在末尾时，列号按展开后的宽度算', () => {
    const draft = 'left\tright'
    const layout = composerLayout(draft, draft.length, 100)

    // `left` 4 列 → Tab 到第 8 列（4 个空格）→ `right` 5 列 ⇒ 13 列
    expect(layout.caretCol).toBe(13)
  })

  test('行首 Tab：插入点在末尾时同样按展开后的宽度算', () => {
    const draft = '\tprint(1)'
    const layout = composerLayout(draft, draft.length, 100)

    expect(layout.caretCol).toBe(8 + 8) // 8 列空白 ＋ `print(1)`
  })
})
