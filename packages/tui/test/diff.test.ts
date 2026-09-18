/**
 * diff 渲染件（U20）——**改了什么，看得见**。
 *
 * 出处：`对表.md`·阶段 3 的差距 1「diff 审阅（改了文件看不见改了什么）」＋ B7
 * （首站＝**unified**，不做 side-by-side、不引语法高亮）+ B8（就近渲染已知形态）。
 *
 * 两条路各有一份判据：
 * - **认**（`diffRowsOf`）——工具输出里**本来就是** diff 文本（`git diff` 那类）时，逐行认出来；
 * - **推**（`replaceDiff`）——`edit` 的参数里只有 `old` / `new` 两段文本（**没有文件全文**），
 *   由它们推出「这一处改了什么」。
 *
 * ⚠️ **不编行号**：`@@ -12,3 +12,4 @@` 要文件全文才数得出，而 `edit` 的参数里没有。
 * 故推导出来的那段**不带 `@@` 头**——拿到的才上屏，拿不到的不编（项目的老规矩）。
 */

import { describe, expect, test } from 'bun:test'
import { diffRowsOf, looksLikeDiff, replaceDiff } from '../src/diff.ts'
import type { DiffRow } from '../src/diff.ts'

/** 分档一串——「认不认得对」看它。 */
const kinds = (rows: readonly DiffRow[]): readonly string[] => rows.map((row) => row.kind)

/** 原文一串——「上屏的是不是那一行原话」看它。 */
const texts = (rows: readonly DiffRow[]): readonly string[] => rows.map((row) => row.text)

// ══ 一 · 认：输出里本来就是 diff ═════════════════════════════════════

describe('认得出 diff（工具输出里的原文）', () => {
  const GIT_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,4 @@',
    ' const keep = 1',
    '-const v = 0',
    '+const v = 1',
    '+const w = 2',
    ' done()',
  ]

  test('`git diff` 那一段——逐行分档', () => {
    expect(kinds(diffRowsOf(GIT_DIFF))).toEqual([
      'meta', // diff --git
      'meta', // index
      'meta', // --- a/
      'meta', // +++ b/   ← `+++` 别被 `+` 抢了先
      'hunk', // @@
      'context',
      'del',
      'add',
      'add',
      'context',
    ])
  })

  test('原文**逐字上屏**（含 `+`/`-` 那个标记）——只换色，不改字', () => {
    expect(texts(diffRowsOf(GIT_DIFF))).toEqual(GIT_DIFF)
  })

  test('判据＝有没有 `@@` 块头——**列表不误伤**（`- 一条` 不是删除行）', () => {
    expect(looksLikeDiff(['@@ -1 +1 @@', '-a', '+b'])).toBe(true)
    // markdown 的列表、`---` 分隔线、目录清单——都不带 `@@`，不是 diff
    expect(looksLikeDiff(['- 一条', '- 另一条', '+ 加号起头的话'])).toBe(false)
    expect(looksLikeDiff(['---'])).toBe(false)
    expect(looksLikeDiff(['README.md', 'packages/'])).toBe(false)
  })

  test('空输出不成 diff', () => {
    expect(looksLikeDiff([])).toBe(false)
    expect(diffRowsOf([])).toEqual([])
  })
})

// ══ 二 · 推：`edit` 的 old / new ═════════════════════════════════════

describe('推得出 diff（`edit` 的参数：old → new）', () => {
  test('改一行——只出这一行的一减一加', () => {
    expect(texts(replaceDiff('const v = 0', 'const v = 1'))).toEqual(['-const v = 0', '+const v = 1'])
    expect(kinds(replaceDiff('const v = 0', 'const v = 1'))).toEqual(['del', 'add'])
  })

  test('带上下文的那一改——**公共的首尾不重复画**，只作上下文（dim）出现', () => {
    const rows = replaceDiff(
      ['function f() {', '  const v = 0', '  return v', '}'].join('\n'),
      ['function f() {', '  const v = 1', '  return v', '}'].join('\n'),
    )

    expect(texts(rows)).toEqual([
      ' function f() {',
      '-  const v = 0',
      '+  const v = 1',
      '   return v',
      ' }',
    ])
    expect(kinds(rows)).toEqual(['context', 'del', 'add', 'context', 'context'])
  })

  test('纯删（`new` 为空串）· 纯增（`old` 为空串）', () => {
    expect(texts(replaceDiff('gone\n', ''))).toEqual(['-gone'])
    expect(texts(replaceDiff('', 'born\n'))).toEqual(['+born'])
  })

  test('上下文**最多留 3 行**（unified 的老规矩）——多的不画', () => {
    const head = ['a', 'b', 'c', 'd', 'e']
    const rows = replaceDiff([...head, 'old', 'x'].join('\n'), [...head, 'new', 'x'].join('\n'))
    const context = texts(rows).filter((line) => line.startsWith(' '))

    expect(context).toEqual([' c', ' d', ' e', ' x']) // 改动前最近的 3 行 ＋ 后 1 行（只有它）
    expect(texts(rows)).not.toContain(' a')
    expect(texts(rows)).not.toContain(' b')
  })

  test('一模一样 ⇒ 没有可画的（空）', () => {
    expect(replaceDiff('same\n', 'same\n')).toEqual([])
  })

  test('多行替换——逐行分减与加', () => {
    expect(texts(replaceDiff('one\ntwo\n', 'uno\n'))).toEqual(['-one', '-two', '+uno'])
  })

  test('**不编行号**——推出来的这一段不带 `@@` 头（文件全文不在参数里）', () => {
    const rows = replaceDiff('a\n', 'b\n')

    expect(rows.some((row) => row.kind === 'hunk')).toBe(false)
    expect(texts(rows).every((line) => !line.includes('@@'))).toBe(true)
  })
})
