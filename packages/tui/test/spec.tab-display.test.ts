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
import stringWidth from 'string-width'
import wrapAnsi from 'wrap-ansi'
import type { LogRow } from '../src/view.ts'
import { rowLines } from '../src/components/log.ts'
import { PALETTE, expandTabs, tabWidth, wrap } from '../src/components/lines.ts'
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

describe('首行带 Tab（独立复核退回①：首行与续行必须取自同一份显示文本）', () => {
  /** 一条用户消息 → 显示行的纯文本。 */
  const rowsOf = (text: string, columns = 100): readonly string[] => {
    const row: LogRow = { kind: 'user', key: 'u1', text, echoed: true }
    return rowLines(row, { columns, expanded: false, spaced: false }).map((line) =>
      line.segments.map((piece) => piece.text).join(''),
    )
  }

  /**
   * **制表位从哪一列起算**——这一行**含 `› ` 那两格**：`› left` 走到第 6 列，Tab 于是到第 8 列
   * （2 格空白）。
   *
   * 由头（对照实测，不是口味）：`› ` 是**同一行里画在正文之前**的那两格，终端的制表位
   * 按**物理列**算、`wrap-ansi` 折草稿那一支也算进它 ⇒ 两边一致才是「提交前后同一个样子」。
   * 独立复核那一趟的稳定帧里，屏上画的正是 `› left  right`（两格）；本仓 `wrap-ansi`
   * 折 `› left\tright` 也只得这一份（下面「单行」那一条直接对过）。
   */
  const FIRST_LINE_TAB = `› left${' '.repeat(tabWidth(6))}right` // `› left` 6 列 → 第 8 列

  test('单行：首行**不留裸 Tab**，也不把换行吞进来', () => {
    const rows = rowsOf('left\tright')

    expect(rows).toEqual([FIRST_LINE_TAB])
    expect(rows.some((line) => line.includes('\t') || line.includes('\n'))).toBe(false)
  })

  test('单行：首行与**草稿折出来的那一行**逐字相同（提交前后不跳格）', () => {
    // 草稿那一支是 Ink 的 `wrap-ansi`（`composer.ts` 的 `wrapVisual`）——记录区首行要是
    // 与它差一格，按下回车的那一刻文字就会横跳。这一条把「同一份显示文本」钉在字面上。
    const draft = wrapAnsi(`› ${'left\tright'}`, 98, { trim: false, hard: true })

    expect(rowsOf('left\tright')).toEqual([draft])
  })

  test('首行的**分段与样式**原样保留（`› ` 淡青粗体、正文原色——展开不吞色）', () => {
    const row: LogRow = { kind: 'user', key: 'u1', text: 'left\tright', echoed: true }
    const first = rowLines(row, { columns: 100, expanded: false, spaced: false })[0]

    expect(first?.segments.map((piece) => [piece.text, piece.color, piece.bold ?? false])).toEqual([
      ['› ', PALETTE.user, true],
      [`left${' '.repeat(2)}right`, PALETTE.fg, false],
    ])
  })

  test('多行：首行只画第一行，第二行是它自己那一行', () => {
    const rows = rowsOf('left\tright\nnext')

    // ⚠️ 修前（924e116）：首行是 `› left\tright\n`——裸 Tab 与换行都被吞了进来，
    //    屏上那一行于是自己折一次 ⇒ 重印
    expect(rows).toEqual([FIRST_LINE_TAB, '  next'])
    expect(rows.some((line) => line.includes('\t') || line.includes('\n'))).toBe(false)
  })

  test('折行：每一行都不含 Tab/换行，且拼起来**不丢不重**', () => {
    const rows = rowsOf('left\tright\n' + 'x'.repeat(120))

    expect(rows).toEqual([FIRST_LINE_TAB, `  ${'x'.repeat(98)}`, `  ${'x'.repeat(22)}`])
    expect(rows.some((line) => line.includes('\t') || line.includes('\n'))).toBe(false)
    // 首行那一份 ＋ 续行（去掉悬挂缩进那两格）拼回来 ＝ 展开后的第一行
    const head = rows[0] ?? ''
    const tail = rows.slice(1).map((line) => line.replace(/^ {2}/, '')).join('')
    expect(head.slice(2) + tail).toBe(`${FIRST_LINE_TAB.slice(2)}${'x'.repeat(120)}`)
  })

  test('折行**正好切在 Tab 展开出来的空白里**：线不丢不重，首行也不多一截', () => {
    // `› ` ＋ 95 个 `x` ＝ 97 列 → Tab 到第 104 列（7 格）——折线落在第 98 列，
    // 正是那 7 格空白的头一格上（切在**一段显示文字里**，不是切在段与段之间）
    const rows = rowsOf(`${'x'.repeat(95)}\tY`)

    expect(rows).toEqual([`› ${'x'.repeat(95)} `, `  ${' '.repeat(6)}Y`])
    expect(rows.some((line) => line.includes('\t') || line.includes('\n'))).toBe(false)
    const head2 = (rows[0] ?? '').slice(2)
    const tail2 = (rows[1] ?? '').replace(/^ {2}/, '')
    expect(head2 + tail2).toBe(`${'x'.repeat(95)}${' '.repeat(7)}Y`)
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

  /**
   * **组合字素（独立复核退回②）**：`👩‍💻` 是**一个字素、三个码点**，Ink 那一支（`string-width`）
   * 整段量成 **2 列**——逐码点量（2 ＋ 0 ＋ 2）会算成 4 列，制表位跟着错、插入点偏出去
   * （独立复核实测 7，行尾应为 9）。
   *
   * 行尾这一条同时对一次**屏上那一行**：插入点在行尾 ⇒ 列号必须等于 `wrap-ansi` 折出来
   * 那一行自己的宽度（同一把尺，不另算一个数）。
   */
  const EMOJI_TAB = '👩‍💻\tX'

  test('组合 emoji ＋ Tab：行尾插入点按整段字素量', () => {
    const layout = composerLayout(EMOJI_TAB, EMOJI_TAB.length, 100)
    const shown = wrapAnsi(`› ${EMOJI_TAB}`, 98, { trim: false, hard: true })

    // `› ` 2 ＋ emoji 2 ⇒ 第 4 列打 Tab ⇒ 到第 8 列（4 格空白）⇒ `X` ⇒ 9
    expect(layout.caretCol).toBe(9)
    expect(layout.caretRow).toBe(0)
    expect(layout.caretCol).toBe(stringWidth(shown))
  })

  test('组合 emoji ＋ Tab：中间插入点（emoji 之后）也按整段字素量', () => {
    const layout = composerLayout(EMOJI_TAB, 3, 100) // 插入点在 emoji 之后（3 个码点）

    expect(layout.caretCol).toBe(2 + 2)
  })

  test('区域指示符（两个字素码点拼一面旗）＋ Tab：同一条口径（对照）', () => {
    const draft = '🇨🇳\tX'
    const layout = composerLayout(draft, draft.length, 100)

    expect(layout.caretCol).toBe(9)
    expect(layout.caretCol).toBe(stringWidth(wrapAnsi(`› ${draft}`, 98, { trim: false, hard: true })))
  })
})
