/**
 * 规格即测试 · **一个字形只答一件事**（U112 · 2026-10-01 用户两条裁定）。
 *
 * ① **状态位挪到身份记号右边**——`▸ ● exec(…)` / `▸ ✓ read(…)` / `▸ × exec(…)`。
 *    由头（用户原话）：一列工具行是**沿左边缘竖着扫**的，状态挂右端**扫不动**、
 *    且那个位置**随参数长短左右飘**。
 *
 * ② **`·` 只做分隔符**——它原先兼着「回执行的身份记号」这一职，**一个字形答两件事**，
 *    违反这一套的第一条规矩。拆法：**回执不给记号**，靠**缩进一级 ＋ 弱色**与助手正文分开；
 *    **收拢的工具组同理**（`●` 在这一套里只有一个语义位：进行中）。
 *
 * 这一支量的是**屏**（真链路真终端）——与 `spec.u112.test.ts` 同一套取景。
 */

import { describe, expect, test } from 'bun:test'
import { rowLines } from '../src/components/log.ts'
import { MARKS } from '../src/marks.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'

const SCREEN = { columns: 100, rows: 40 } as const

/** 一条行 → 显示行（纯函数——收拢那个形只在重建时出现，故直接喂一条）。 */
function linesOf(row: Parameters<typeof rowLines>[0]): readonly string[] {
  return rowLines(row, { columns: SCREEN.columns, expanded: false }).map((line) =>
    line.segments.map((piece) => piece.text).join(''),
  )
}

describe('工具行 · 状态位在身份记号右边（2026-10-01 裁定）', () => {
  test('成：`▸ ✓ read(…)`——状态位**紧跟在身份记号右边**', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: 'read', args: { path: 'a.txt' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '一行' } }, { id: 72 }),
    ])

    const frame = await stage.screen(SCREEN)

    // **位置判据**：`▸` 在第 3 格、状态位在第 5 格（都是 0 起）——缩进 2 ＋ `▸ ` 2
    const row = frame.rowOf('▸ ✓ read(a.txt)')
    const cells = frame.cellsOf(row)

    expect(cells[2]?.text).toBe('▸')
    expect(cells[3]?.text).toBe(' ')
    expect(cells[4]).toMatchObject({ text: MARKS.ok, fg: '#98c379' })
  })

  test('败：`▸ × exec(…)`——同一个位置，形状换成叉', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: 'exec', args: { cmd: 'make test' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: false, output: { text: '没有这个目标' } }, { id: 72 }),
    ])

    const frame = await stage.screen(SCREEN)
    const row = frame.rowOf('▸ × exec(make test)')

    expect(frame.cellsOf(row)[4]).toMatchObject({ text: MARKS.fail, fg: '#e06c75' })
  })

  /**
   * **行尾不再有状态位**（这条把「挪走」钉死）：整行最后一个可见字符是参数那一截的
   * 右括号，不是勾/叉。改前那一版是**靠右摆**的，这一条在那一版上必红。
   */
  test('**行尾不再挂着状态位**（靠右那一版的反面）', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: 'read', args: { path: 'a.txt' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '一行' } }, { id: 72 }),
    ])

    const frame = await stage.screen(SCREEN)
    const row = frame.rowOf('▸ ✓ read(a.txt)')

    expect(frame.cellsOf(row).at(-1)?.text).toBe(')')
    // 而且**整行最右边没有一大截填充**（靠右那一版靠的就是它）——行长＝内容长
    expect(frame.textAt(row).trimEnd()).toBe('  ▸ ✓ read(a.txt)')
  })
})

describe('回执与工具组 · 不带记号（2026-10-01 裁定）', () => {
  test('回执：**无记号**，靠缩进一级 ＋ 弱色（`·` 不再做身份）', async () => {
    const stage = createStage()
    stage.feed([event('model.switched', { alias: 'default', ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const frame = await stage.screen(SCREEN)
    const row = frame.rowOf('已选择 Default')
    const cells = frame.cellsOf(row)

    // 头两格是空白（缩进一级），第 3 格**就是正文**——不是 `·`
    expect(cells[0]?.text).toBe(' ')
    expect(cells[1]?.text).toBe(' ')
    expect(cells[2]?.text).toBe('已')
    expect(cells[2]?.fg).toBe('#5a626f') // 最弱那一档
    // 而 `·` 在这一行里**一次都不出现**（它只做分隔符）
    expect(frame.textAt(row)).not.toContain(MARKS.sep)
  })

  test('收拢的工具组：**也不带记号**（`●` 只表示「进行中」，不做身份）', () => {
    const lines = linesOf({ kind: 'toolgroup', key: 'g', names: ['ls', 'read'] })

    expect(lines).toEqual(['  2 次工具调用（ls · read）'])
    // 行首那个 `●` **不许在**（它是改前那一版的样子）
    expect(lines[0]?.startsWith(MARKS.dot)).toBe(false)
    // 而 `·` 照旧在**行内**做分隔（`ls · read` 那一段）
    expect(lines[0]).toContain(MARKS.sep)
  })

  /**
   * **`·` 的两职只剩一职**（这条是那条例行的规矩的可跑版）：
   * 全仓的 `MARKS` 里，只有 `sep` 是 `·`；没有任何一行**以** `·` 起头当身份。
   */
  test('`·` 只做分隔符：没有任何一行以它起头（身份那一职已交出）', () => {
    const rows = [
      { kind: 'receipt' as const, key: 'r', text: '已切到 名字' },
      { kind: 'toolgroup' as const, key: 'g', names: ['ls', 'read'] },
    ]

    for (const row of rows) {
      for (const line of linesOf(row)) expect(line.trimStart().startsWith(MARKS.sep)).toBe(false)
    }
  })
})
