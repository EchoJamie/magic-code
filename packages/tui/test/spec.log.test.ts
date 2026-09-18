/**
 * 规格即测试 · **记录区**（U24）——`界面原型.html` 的组件规格表与密度/悬挂两条，
 * 逐条落成用例。
 *
 * ## 为什么这一层是「屏」，不是「视图对象」
 *
 * 仓里八百多条测的是**视图对象怎么变**；而规格表写的多半是**用户看得见的那一屏**：
 * 「助手标记绿」「工具只换色、不加粗不放大」「正文与所有折行都从第 N+1 列起」——
 * 这些话在视图对象里**一个字都读不出来**（视图那侧只有 `segments[0].color` 与 `hang` 两个字段，
 * 它们对了不等于屏上对了）。故这一轮的用例走**真链路、真终端**：
 *
 * ```
 * 事件 ──createShell──▶ 视图 ──AppView──▶ Ink ──字节──▶ @xterm/headless ──▶ 屏幕矩阵 ＋ 每格的色与重量
 * ```
 *
 * 取景在 `screen.ts`；判据仍是 `bun:test` 的 `expect`（**不另造断言 DSL**）。
 *
 * ## ⚠️ 色是**显式拧开**的
 *
 * `show()` 把 `chalk` 拧到真彩档才画——测试进程默认 0 档、**一个色码都不发**，
 * 那时候量到的「全默认色」不是「代码没上色」，是**没开色**。理由见 `screen.ts`。
 *
 * 对应规格：`界面原型.html` · 一 · 组件规格（表的五行）· 三 · 交互逻辑（标记与悬挂缩进 · 密度 ·
 * 记录区的三类行）。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry } from '@magic/contracts'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Cell, Frame } from './screen.ts'

/** 起一个壳，并投一条会话状态（② 有标题、目录非空——多数用例的底子）。 */
function live() {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一行的第 `col` 格——行找不到会当场抛（带整屏），故这里只可能「列号出界」。 */
function cellAt(frame: Frame, needle: string, col: number): Cell | undefined {
  return frame.cellsOf(frame.rowOf(needle))[col]
}

/**
 * 助手那条正文——`⏺ ` 之后的格子。
 *
 * 宽字符占两格（右半是空串），故「正文从第几列起」用**格子的下标**算，
 * 与规格里「标记占 N 列 ⇒ 正文从第 N+1 列起」是同一把尺子。
 */
function bodyCells(frame: Frame, needle: string): readonly Cell[] {
  return frame.cellsOf(frame.rowOf(needle)).slice(2)
}

// ══ 一 · 组件规格表：行的标记与颜色 ═══════════════════════════════════

describe('组件规格 · 行的标记与颜色', () => {
  // ⚠️ 规格原文是「**整行**淡青背景」；实测铺的是**这段文字**那么宽（80 列终端上到第 20 格为止），
  //    不到终端右缘——见回报「与规格不符」。这条用例锚的是成立的**那一半**：这一段的每一格都在背景里。
  test('用户行——`›` 起头 · 标记青 · 正文原色 · **整段淡青背景**', async () => {
    const stage = live()
    stage.type('看看这个工作区里有什么')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen()
    const row = frame.rowOf('› 看看这个工作区里有什么')
    const cells = frame.cellsOf(row)

    expect(cells[0]).toMatchObject({ text: '›', fg: '#56b6c2' }) // 标记青（色板 · 用户）
    expect(cells[2]).toMatchObject({ text: '看', fg: '#d8dce4' }) // 正文原色（色板 · 正文）
    // **整段**带背景——这一条在纯文本里一个字都看不到
    expect(cells.every((cell) => cell.bg === '#131d23')).toBe(true)
    expect(cells.length).toBeGreaterThan(2)
  })

  test('助手行——`⏺` 起头 · 标记绿（加粗）· 正文**不上色**（原色）', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '我先列一下。' })])

    const frame = await stage.screen()

    expect(cellAt(frame, '⏺ 我先列一下。', 0)).toMatchObject({
      text: '⏺',
      fg: '#98c379', // 标记绿（色板 · 成了）
      bold: true,
    })
    // 「正文原色」＝**不染色**（不上任何语义色）——它与标记绿分明是两回事
    expect(bodyCells(frame, '⏺ 我先列一下。').every((cell) => cell.fg === null)).toBe(true)
  })

  test('工具行——`●` 与助手**同族 · 只换色 · 不加粗不放大**；名上色、参数 dim', async () => {
    const stage = live()
    stage.feed([
      event('model.delta', { channel: 'text', text: '先读一遍。' }),
      event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '14 项' } }, {}),
    ])

    const frame = await stage.screen()
    const toolMark = cellAt(frame, '● ls {"path":"."}', 0)
    const assistantMark = cellAt(frame, '⏺ 先读一遍。', 0)

    expect(toolMark).toMatchObject({
      text: '●', // 实心点——与助手的 `⏺` 同族
      fg: '#61afef', // 工具色（色板 · 工具）——**只换色**
      bold: false, // 不加粗
      width: 1, // 不放大（终端里「大」只有「占两格」这一种形态）
    })
    // 对照组：助手那个标记是**加粗**的——「只换色」这句话得有个比照物才立得住
    expect(assistantMark?.bold).toBe(true)

    // 工具名上色 · 参数 dim
    expect(cellAt(frame, '● ls {"path":"."}', 2)).toMatchObject({ text: 'l', fg: '#61afef' })
    expect(cellAt(frame, '● ls {"path":"."}', 5)).toMatchObject({ text: '{', fg: '#8b93a1' })
  })

  test('工具结果——**另起一行** · 缩进 · dim', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'README.md\npackages' } }, {}),
    ])
    stage.press({ kind: 'ctrl+o' }) // 结果块展开才有内容行

    const frame = await stage.screen()
    const head = frame.rowOf('● ls {}')

    // 结果**不在工具那一行**上（另起一行），且在它下面
    expect(frame.textAt(head)).not.toContain('README.md')
    expect(frame.rowOf('  ✓ packages')).toBeGreaterThan(head)

    // 结果内容：缩进两行（4 列）＋ 整行 dim
    const cells = frame.cellsOf(frame.rowOf('    README.md'))
    expect(cells.slice(0, 4).every((cell) => cell.text === ' ')).toBe(true)
    expect(cells.slice(4).every((cell) => cell.fg === '#8b93a1')).toBe(true)
  })

  test('记录 / 回执行——`·` 起头 · **最弱**一档', async () => {
    const stage = live()
    stage.feed([event('model.switched', { ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const frame = await stage.screen()
    const cells = frame.cellsOf(frame.rowOf('· 已换模型 → MiniMax-M2'))

    expect(cells[0]).toMatchObject({ text: '·', fg: '#49505e' }) // 那个点：比「最弱」还弱一档
    expect(cells[2]).toMatchObject({ text: '已', fg: '#5a626f' }) // 正文：最弱色（色板 · 最弱）
  })

  test('命令输出——**无标记** · 整块 dim', async () => {
    const stage = live()
    stage.type('/help')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen()
    const row = frame.rowOf('可用命令')
    const cells = frame.cellsOf(row)

    // 无标记：第一格就是正文本身，不是什么 `›` / `⏺` / `●` / `·`
    expect(cells[0]).toMatchObject({ text: '可', fg: '#8b93a1' })
    expect(cells.every((cell) => cell.fg === '#8b93a1')).toBe(true) // 整块同色（dim）
    expect(frame.textAt(frame.rowOf('/session　会话：列表 · 切换 · 新建 · 改名'))).toMatch(/^\/session/)
    // 那一整块都在**记录区**（不是交互区）
    expect(frame.record.some((line) => line.text.includes('可用命令'))).toBe(true)
  })
})

// ══ 二 · 标记与悬挂缩进 ═══════════════════════════════════════════════

describe('标记与悬挂缩进（原型只画了单行，这条补上）', () => {
  test('助手——标记占 2 列 ⇒ 正文与**所有折行**都从第 3 列起', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '甲'.repeat(60) })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const head = frame.rowOf('⏺ 甲')
    const tail = frame.textAt(head + 1)

    // 首行：标记与正文**同一行**（不取「标记独占一行」——那让每条多占一行，与密度相抵）
    expect(frame.textAt(head).startsWith('⏺ 甲')).toBe(true)
    // 折行：从第 3 列起（两个空格），一格不差
    expect(tail.startsWith('  甲')).toBe(true)
    expect(tail.startsWith('   甲')).toBe(false)
  })

  test('用户——`› ` 同样占 2 列 ⇒ 折行也从第 3 列起', async () => {
    const stage = live()
    stage.type('乙'.repeat(60))
    stage.press({ kind: 'enter' })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const head = frame.rowOf('› 乙')
    const tail = frame.textAt(head + 1)

    expect(tail.startsWith('  乙')).toBe(true)
    expect(tail.startsWith('   乙')).toBe(false)
    // 折行仍在**那条消息的背景**里（整段淡青背景不因折行而断）
    expect(frame.cellsOf(head + 1).every((cell) => cell.bg === '#131d23')).toBe(true)
  })

  test('工具——`● ` 同样 2 列 ⇒ 参数与折行都从第 3 列起', async () => {
    const stage = live()
    stage.feed([event('tool.call', { name: 'read', args: { path: '丙'.repeat(40) } }, { id: 71 })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const head = frame.rowOf('⟳ read') // 还没落地 ⇒ 标记是转圈那个（跑完换 `●`）
    const tail = frame.textAt(head + 1)

    expect(tail.startsWith('  丙')).toBe(true)
    expect(tail.startsWith('   丙')).toBe(false)
  })

  test('列表**按标记宽度**（`1. ` ⇒ 基线 2 ＋ 3 ＝ 5 列）· 代码块缩进淡化', async () => {
    const stage = live()
    stage.feed([
      event('model.delta', { channel: 'text', text: `1. ${'甲'.repeat(20)}\n\n\`\`\`ts\nconst a = 1\n\`\`\`` }),
    ])

    const frame = await stage.screen({ columns: 30, rows: 24 })
    const list = frame.rowOf('⏺ 1. 甲') // 基线 2 ＋ 列表自己那 2 列（`1.` 之前）
    const wrapped = frame.textAt(list + 1)

    // 续行挂在**符号之后**：基线 2 ＋ `1. ` 的 3 列 ＝ 第 6 列起（0 基下标 5）
    expect(wrapped.startsWith('     甲')).toBe(true)
    expect(wrapped.startsWith('      甲')).toBe(false)

    // 代码块：围栏不上屏 · 缩进（基线 2 ＋ 自己 2）· 淡化
    expect(frame.has('```')).toBe(false)
    const code = frame.cellsOf(frame.rowOf('    const a = 1'))
    expect(code.slice(4).every((cell) => cell.fg === '#8b93a1')).toBe(true)
  })
})

// ══ 三 · 密度 ═════════════════════════════════════════════════════════

describe('密度（记录区不靠空行分层）', () => {
  test('条目之间**不插空行**；只有**用户消息之前**留一行分段', async () => {
    const stage = live()
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '答一' }), event('turn.end', { reason: 'settled' })])
    stage.type('第二句')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '答二' }), event('turn.end', { reason: 'settled' })])

    const frame = await stage.screen()
    const texts = frame.record.map((line) => line.text)

    expect(texts).toEqual(['› 第一句', '⏺ 答一', '', '› 第二句', '⏺ 答二'])
  })

  test('思考**默认折一行**（`ctrl+o` 才展开）——分层靠标记与明暗，不靠空行', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'thinking', text: '第一行\n第二行\n第三行' })])

    const folded = await stage.screen()
    expect(folded.record.map((line) => line.text)).toEqual(['（思考）第一行'])

    stage.press({ kind: 'ctrl+o' })
    const opened = await stage.screen()
    expect(opened.record.map((line) => line.text)).toEqual(['（思考）第一行', '第二行', '第三行'])
  })

  test('**空内容不渲染**——只发工具调用、不吐正文的那一轮不出一行', async () => {
    const stage = live()
    stage.type('跑一下')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '   ' }), // 只有空白
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
    ])

    const frame = await stage.screen()
    const texts = frame.record.map((line) => line.text)

    expect(texts.some((text) => text.includes('⏺'))).toBe(false) // 没有孤零零的助手行
    expect(texts).toEqual(['› 跑一下', '⟳ ls {}', '  ⟳ 运行中'])
  })
})

// ══ 四 · 记录区三类行 ═════════════════════════════════════════════════

describe('记录区的三类行（后两类不重建）', () => {
  test('会话内容随重建回来 · **命令输出与命令回执不回**', async () => {
    const stage = live()

    // 攒一屏「三类行」都在的现场：会话内容（重建得来）＋ 命令输出（`/help`）＋ 回执（`/model` 换成了）
    stage.type('/help')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.switched', { ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const before = await stage.screen()
    expect(before.has('可用命令')).toBe(true) // 命令输出（第二类）
    expect(before.has('已换模型')).toBe(true) // 命令回执（第三类）

    // 切走再切回：重建由 `session.history` 铺（会话内容那三类才落库）
    const entries: readonly Entry[] = [
      { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '好。' }, at: 1 },
    ]
    stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙的事' }] })])
    stage.feed([event('session.history', { session: 's2', entries, done: true })])

    const after = await stage.screen()

    expect(after.record.map((line) => line.text)).toEqual(['› 看看有什么', '⏺ 好。']) // 会话内容回来了
    expect(after.has('可用命令')).toBe(false) // 命令输出：屏上痕迹，不重建
    expect(after.has('已换模型')).toBe(false) // 命令回执：屏上痕迹，不重建
  })
})
