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
import { createStage, showScreen } from './screen.ts'
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
 * 助手那条正文——**整行**（U112：`⏺ ` 标记退场，正文顶格起，行首不再有占位的格子）。
 *
 * 宽字符占两格（右半是空串），故「正文从第几列起」用**格子的下标**算。
 */
function bodyCells(frame: Frame, needle: string): readonly Cell[] {
  return frame.cellsOf(frame.rowOf(needle))
}

// ══ 一 · 组件规格表：行的标记与颜色 ═══════════════════════════════════

describe('组件规格 · 行的标记与颜色', () => {
  // ⚠️ 本条 2026-09-19 **收紧过**（缺陷 D21）——规格一直是「**整行**淡青背景」，变的不是规格、
  //    是实装补齐了：修前只铺到**文字末尾**（80 列终端上到第 20 格），当时这条只能锚成立的
  //    那一半（「这一段在背景里」）。现在它锚的是规格原话——**整行**，含文字之后那些空格格。
  test('用户行——`›` 起头 · 标记青 · 正文原色 · **整行**淡青背景（铺到右缘）', async () => {
    const stage = live()
    stage.type('看看这个工作区里有什么')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen()
    const row = frame.rowOf('› 看看这个工作区里有什么')
    const cells = frame.cellsOf(row)

    expect(cells[0]).toMatchObject({ text: '›', fg: '#56b6c2' }) // 标记青（色板 · 用户）
    expect(cells[2]).toMatchObject({ text: '看', fg: '#d8dce4' }) // 正文原色（色板 · 正文）
    expect(cells.every((cell) => cell.bg === '#131d23')).toBe(true)

    // ⚠️ 量「**整行**」得用 `rawCellsOf`——`cellsOf` 按**文本**裁尾，而背景铺出去的那一截
    //    文本是空格，正好会被它裁掉（量不到「铺到哪」）。
    const full = frame.rawCellsOf(row)

    expect(full).toHaveLength(80) // 整行（默认屏宽）
    expect(full.every((cell) => cell.bg === '#131d23')).toBe(true) // 一格都不落
    expect(full.at(-1)?.bg).toBe('#131d23') // 铺到**右缘**——短句子才不像块小补丁
  })

  /**
   * ⚠️ **U112 换锚**：`⏺ ` 标记**整个退场**（设计 · 终端交互「符号 ＋ 动效：一套」）——
   * 原锚是「行首那枚绿字粗体的 `⏺`」，随标记一起去掉的还有「它不上色」那条对照。
   * **判据本身没变的那一半照钉**（正文不上任何语义色）；另一半改钉新规格的正题：
   * 正文**从第 1 格起**（行首没有标记占位，也没有那两格基线）。
   */
  test('助手行——**不带标记**（正文顶格起）· 正文**不上色**（原色）', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '我先列一下。' })])

    const frame = await stage.screen()

    expect(cellAt(frame, '我先列一下。', 0)).toMatchObject({ text: '我', fg: null }) // 第 1 格就是正文
    // 「正文原色」＝**不染色**（不上任何语义色）
    expect(bodyCells(frame, '我先列一下。').every((cell) => cell.fg === null)).toBe(true)
  })

  /**
   * ⚠️ **U112 换锚**：原来行首是那枚随状态换形的标记（`●` 落定 / `⟳` 在跑），判据是
   * 「与助手的 `⏺` 同族 · 只换色 · 不加粗不放大」。现在**行首是身份**（`▸` 静态不变），
   * 状态**紧挨着身份落在它右边**（2026-10-01 改定，不再挂行尾）；助手那枚标记已退场，
   * 故「同族 / 只换色」的比照物没了（那条对照随规格一起去掉）。**留下的照钉**：
   * `▸` 是工具色、不加粗、只占一格；名字同色、参数 dim。
   * **新增的一格**：行首缩进一级（工具与结果都比正文低一级）；身份右边那一位状态。
   */
  test('工具行——`▸` 身份（工具色 · 不加粗不放大 · 缩进一级）；名上色、参数 dim', async () => {
    const stage = live()
    stage.feed([
      event('model.delta', { channel: 'text', text: '先读一遍。' }),
      event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '14 项' } }, {}),
    ])

    const frame = await stage.screen()
    const toolMark = cellAt(frame, '▸ ✓ ls(.)', 2)

    expect(cellAt(frame, '▸ ✓ ls(.)', 0)).toMatchObject({ text: ' ' }) // 缩进一级（第一格是空格）
    expect(toolMark).toMatchObject({
      text: '▸', // 身份（不随状态换形）
      fg: '#61afef', // 工具色（色板 · 工具）
      bold: false, // 不加粗
      width: 1, // 不放大（终端里「大」只有「占两格」这一种形态）
    })
    // 身份右边**紧挨着**那一位状态：这一笔（`ok`）落定时是勾 · 绿
    expect(cellAt(frame, '▸ ✓ ls(.)', 4)).toMatchObject({ text: '✓', fg: '#98c379' })

    // 工具名上色 · 参数 dim
    expect(cellAt(frame, '▸ ✓ ls(.)', 6)).toMatchObject({ text: 'l', fg: '#61afef' })
    expect(cellAt(frame, '▸ ✓ ls(.)', 9)).toMatchObject({ text: '.', fg: '#8b93a1' })
  })

  test('工具结果——**另起一行** · 缩进 · dim', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'README.md\npackages' } }, {}),
    ])
    // ⚠️ **U110 起这一屏的「展开」在查看那一屏上**（内联那一半恒折叠：`ctrl+o` 是开那一屏）。
    //    故这条「结果另起一行 · 缩进两格 ×2 · 整行 dim」的判据改判到**那一屏**上量
    //    ——走的是产品那条路（`showScreen` = `screenFrame` ＋ 同一支 VT），色照旧量得到。
    // ⚠️ **U112 换锚**：头一行由 `● ls {}`（行首标记 ＋ 原样 JSON 的参数）变成
    //    `▸ ✓ ls`（身份 ＋ 状态位 ＋ 关键参数；`args` 给的是空对象 ⇒ 没有关键参数可挑，括号那半截不画）。
    const frame = await showScreen(stage.shell.getView())
    const head = frame.rowOf('▸ ✓ ls')

    // 结果**不在工具那一行**上（另起一行），且在它下面
    expect(frame.textAt(head)).not.toContain('README.md')
    // ⚠️ 本条 2026-09-19 **收紧过**（U20）——原来钉的是 `✓ packages`（**当时输出的末行**）。
    //    - **原锚**：这一句其实**没钉规格**，钉的是「摘要＝结果末行」那个当时的实现；
    //    - **规格为什么变**：摘要改按**形态**出（`对表.md`·B8「就近渲染已知形态」），
    //      而原型场景 2 对 `ls` 画的正是 `✓ 0.2s · **14 项**`——列表报**项数**，不是报末一项的名字；
    //    - **新锚**：同一条规格（结果另起一行 · 缩进 · dim）＋ 摘要报项数（两行输出 ⇒ `2 项`）。
    //      ⚠️ **U112**：那条读数不再以 `✓` 起头（勾已经挪到头一行行尾去了），只剩 `  2 项`。
    expect(frame.rowOf('  2 项')).toBeGreaterThan(head)

    // 结果内容：缩进**两级（4 列）**＋ 整行 dim
    //
    // ⚠️ **2026-10-01 裁定改过这一格**：U112 初稿把结果体收到与工具行同一级（2 列），
    //    于是同一屏两级不一致（正文块 2 列、`diffLines` 那一支 4 列）——
    //    那本身就是「层级没定」的症状。现在**两级都收在 4**：工具行 2 列、它的结果 4 列。
    //
    // ⚠️ 判据要**钉死列数**：`rowOf` 走的是 `includes`，写 `'  README.md'` 时
    //    4 格缩进的那一行**照样命中**（needle 是它的子串）——那条会变成一条两可都过的句子。
    const body = frame.cellsOf(frame.rowOf('README.md'))

    expect(body.slice(0, 4).every((cell) => cell.text === ' ')).toBe(true)
    expect(body[4]?.text).toBe('R')
    expect(body.slice(4).every((cell) => cell.fg === '#8b93a1')).toBe(true)

    // **与 `diff` 那一支同级**（这一条才是那次裁定的正题：同样是「工具的结果」，深浅要一致）
    const diff = live()
    diff.feed([
      event('tool.call', { name: 'edit', args: { path: 'a.ts', old: 'let a = 1', new: 'let a = 2' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '改好了' } }, {}),
    ])
    const diffFrame = await showScreen(diff.shell.getView())
    const added = diffFrame.cellsOf(diffFrame.rowOf('+let a = 2'))

    expect(added.slice(0, 4).every((cell) => cell.text === ' ')).toBe(true)
    expect(added[4]?.text).toBe('+')
  })

  test('扣下的调用——**没跑**那行不打失败的叉、也不报耗时（2026-09-20 二轮裁）', async () => {
    const stage = live()
    // 两个事件**错开几个 id**（`at` 跟着 id 走）：旧画法在这儿算得出一个 `4ms`——
    // 那条耗时只是「两个事件背靠背发出」的实现偶然，不是这次调用的账（当时画成 `✗ 4ms · 未执行`）
    stage.feed([
      event('tool.call', { name: 'write', args: { path: 'src/a.ts' } }, { id: 71 }),
      event(
        'tool.result',
        {
          call: 71,
          ok: false,
          // ⚠️ **锚点变更**（2026-09-20 三轮裁，三件写全）：**原锚**是「正文首行以 `未执行`
          // 起头」——喂一条这样的正文就够；**为何变**：那是把给人看的文案当成了跨域协议
          // （真跑失败、输出里恰有「未执行后续步骤」时认错），**新锚**是结果自己带的
          // `notExecuted`。故此处**必须喂这一位**——正文照旧是那句文案，但它不再是判据。
          notExecuted: true,
          output: {
            text:
              '未执行 · 规约已更新，重新审视后再操作\n' +
              '这个目标上刚发现新的项目规约（src/AGENTS.md），已送入上下文——请照新规约复核这次调用，' +
              '然后重新提出；这一次没有任何副作用发生。',
          },
        },
        { id: 75 },
      ),
    ])

    const frame = await stage.screen()
    const said = frame.textAt(frame.rowOf('未执行 · 规约已更新，重新审视后再操作'))

    // ① **没有耗时**（`0ms · `/`4ms · ` 那一段是旧画法）——没跑的调用没有「耗了多久」这回事
    expect(said).not.toContain('ms')
    // ② 也**没有失败那个叉**：它是「没跑」，不是「跑了没成」
    expect(said).not.toContain('✗')
    // ③ 那一笔的状态位用 warn（要说的是「这一笔要你再看一眼」）——U112 起它在**头一行**、
    //    紧挨着身份记号右边（2026-10-01 改定，不再挂行尾；原来在读数行的第 3 列：`  ! 未执行…`）
    const head = frame.cellsOf(frame.rowOf('▸ ! write(src/a.ts)'))
    expect(head[4]).toMatchObject({ text: '!', fg: '#e5c07b', bold: true })
    // ④ **展开之后**，正文那句「为什么、怎么办」还在——内联屏上只是**首行**那一句。
    //    ⚠️ **U110 起展开在查看那一屏上**：故这一条去那一屏量（同一句话、同一份行）。
    const opened = await showScreen(stage.shell.getView())
    expect(opened.has('已送入上下文')).toBe(true)
  })

  test('记录 / 回执行——**不带记号**（缩进一级）· **最弱**一档', async () => {
    const stage = live()
    stage.feed([event('model.switched', { alias: 'default', ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const frame = await stage.screen()
    const cells = frame.cellsOf(frame.rowOf('已选择 Default'))

    // ⚠️ **U112 拆的混用**：回执行**不再以 `·` 起头**（那个字形只做行内分隔符）——
    //    靠**缩进一级 ＋ 最弱色**与助手正文分开（正文顶格、无记号）
    expect(cells[0]).toMatchObject({ text: ' ' }) // 缩进一级（前两格是空格）
    expect(cells[1]).toMatchObject({ text: ' ' })
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
    expect(frame.textAt(frame.rowOf('/resume　回到之前某一条'))).toMatch(/^\/resume/)
    // 那一整块都在**记录区**（不是交互区）
    expect(frame.record.some((line) => line.text.includes('可用命令'))).toBe(true)
  })
})

// ══ 二 · 标记与悬挂缩进 ═══════════════════════════════════════════════

describe('标记与悬挂缩进（原型只画了单行，这条补上）', () => {
  // ⚠️ **U112 换锚**：助手正文的 `⏺ ` 标记退场 ⇒ 基线由 2 列变 **0 列**。
  //    判据本身（**首行与所有折行同一起点**）一字未改，变的是那个起点。
  test('助手——顶格起 ⇒ 正文与**所有折行**都从第 1 列起', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '甲'.repeat(60) })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const head = frame.rowOf('甲')
    const tail = frame.textAt(head + 1)

    // 首行：正文就在第 1 列（行首没有标记占位）
    expect(frame.textAt(head).startsWith('甲')).toBe(true)
    // 折行：也从第 1 列起，一格不差
    expect(tail.startsWith('甲')).toBe(true)
    expect(tail.startsWith(' 甲')).toBe(false)
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

  /**
   * 缺陷 D22 —— **折行的续行沿用该行的正文色**。
   *
   * 钉的规格＝组件规格表里「正文原色」那一格（**助手与用户都是**）。修前 `wrapSegments()`
   * 把**所有续行**写死成 `dim`（`#8b93a1`）⇒ 同一句话第一行原色、折下去那截变暗，
   * **读着像两段**（弱化另起一行不是它的活——层次靠缩进与标记）。
   */
  test('折行的续行**不暗**——沿用正文色（D22 · 用户）', async () => {
    const stage = live()
    stage.type('丙'.repeat(60))
    stage.press({ kind: 'enter' })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const tail = frame.cellsOf(frame.rowOf('› 丙') + 1)
    const body = tail.filter((cell) => cell.text.trim() !== '')

    expect(body.length).toBeGreaterThan(10) // 确实是折下来的那一截
    expect(body.every((cell) => cell.fg === '#d8dce4')).toBe(true) // 原色（色板 · 正文）
    expect(tail.some((cell) => cell.fg === '#8b93a1')).toBe(false) // 一处 dim 都不该有
  })

  test('折行的续行**不暗**——沿用正文色（D22 · 助手）', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'text', text: '丁'.repeat(60) })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const tail = frame.cellsOf(frame.rowOf('丁') + 1)

    expect(tail.filter((cell) => cell.text.trim() !== '').every((cell) => cell.fg === '#d8dce4')).toBe(true)
    expect(tail.some((cell) => cell.fg === '#8b93a1')).toBe(false)
  })

  // ⚠️ **U112 换锚**：行首的标记（原来在跑是 `⟳`、落定是 `●`）换成了身份 `▸`；
  //    折行的悬挂还是 `INDENT`（工具比正文低一级）⇒ 续行仍从第 3 列起。
  test('工具——缩进一级 ⇒ 参数与折行都从第 3 列起', async () => {
    const stage = live()
    stage.feed([event('tool.call', { name: 'read', args: { path: '丙'.repeat(40) } }, { id: 71 })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const head = frame.rowOf('▸ ● read(') // 身份不随状态换形（在跑还是落定都是 `▸`）；此刻在跑 ⇒ 状态位 `●`
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
    // ⚠️ **U112**：助手基线由 2 列变 0（`⏺ ` 退场）——下面那两笔账各减 2。
    const list = frame.rowOf('1. 甲')
    const wrapped = frame.textAt(list + 1)

    // 续行挂在**符号之后**：基线 0 ＋ `1. ` 的 3 列 ＝ 第 4 列起（0 基下标 3）
    expect(wrapped.startsWith('   甲')).toBe(true)
    expect(wrapped.startsWith('    甲')).toBe(false)

    // 代码块：围栏不上屏 · 缩进（基线 0 ＋ 自己 2）· 淡化
    expect(frame.has('```')).toBe(false)
    const code = frame.cellsOf(frame.rowOf('  const a = 1'))
    expect(code.slice(2).every((cell) => cell.fg === '#8b93a1')).toBe(true)
  })
})

// ══ 三 · 密度 ═════════════════════════════════════════════════════════

describe('密度（记录区不靠空行分层）', () => {
  test('**块之间留一整行 · 块内紧凑**（U67：早先只留了用户消息**之前**那一半）', async () => {
    const stage = live()
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '答一' }), event('turn.end', { reason: 'settled' })])
    stage.type('第二句')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '答二' }), event('turn.end', { reason: 'settled' })])

    const frame = await stage.screen()
    // ⚠️ 取景换 `content`（记录区**去掉最前面那块启动字标**）——
    //    **原锚** `frame.record`：那时记录区第一行就是内容。
    //    **为何变**：启动字标（TUI Banner）现在恒在记录区最前面，`record` 的头几行是它。
    //    **新锚** `frame.content`——本句问的是「**条目**之间插不插空行」，字标不是条目。
    const texts = frame.content.map((line) => line.text)

    // ⚠️ **头上那一行空串不再落进 `content`**（2026-09-20 · 字标块把前后留白收进自己那一支）——
    //    **原锚**：`['', '› 第一句', …]`——那个空串是字标之下那行留白，那时它由
    //    `needsSpacer`（首条用户消息之前留一行分段）给出来，故算在**内容**的第一行。
    //    **为何变**：字标现在**自成一块**（前留白 ＋ 画幅 ＋ 后留白，见 `components/log.ts`
    //    的 `banner` 那一支）⇒ 那行留白是**装帧**的一部分，`contentOf` 连它一起剥；
    //    紧随字标的那条也不再叠一层分段（`needsSpacerAfter`）。**屏上的行数一个没变**
    //    （改前：字标 5 行 ＋ 空行；改后：空行 ＋ 字标 5 行 ＋ 空行——块挪了 2 行，条目之间一字未动）。
    //    **新锚**：`['› 第一句', …]`——本句钉的规矩照旧：空串**只**出现在块与块之间。
    //
    // ⚠️ **U67 改（这是正题）**——**原锚**：`['› 第一句', '⏺ 答一', '', '› 第二句', '⏺ 答二']`
    //    （空串**只在用户消息之前**：用户 → 助手那一道、助手 → 用户那一道，只留了后一道）。
    //    **为何变**：设计那句「用户发言、助手发言与各组工具**之间**留一整行」的「之间」是
    //    **双向**的，而实现只判「这一条是不是用户消息」——**只做了一半**（用户 2026-09-25
    //    真跑时发现「我输入之后与模型回复之间没有空行」）。**新锚**：把「之间」补全之后
    //    每一处交界各一行——`›` 与 `⏺` 之间、`⏺` 与下一条 `›` 之间。
    // ⚠️ **U112**：助手那两条正文不再带 `⏺ `（正文顶格）——空行那几笔一字未动。
    expect(texts).toEqual(['› 第一句', '', '答一', '', '› 第二句', '', '答二'])
  })

  test('**用户之后直接是工具**（U67 · 模型一句话都没说就调工具）——照样留一行', async () => {
    // 这一形是工单点名要有的那张帧：把它写成「用户 ↔ 助手 ↔ 工具组」那种**以助手为中心**
    // 的说法就会漏掉它（中间根本没有 `⏺` 那句）。
    const stage = live()
    stage.type('改个文件')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('turn.start', {}),
      // ⚠️ **空助手行真会出现**（模型只发工具调用、不吐正文的那一轮）——它一行都不占，
      //    故「上一条」要跳过它（`rowDrawn`）：不然这一行分段会被它顶掉、或者两边各留一行
      //    连成两行空行。
      event('model.delta', { channel: 'text', text: '   ' }),
      event('tool.call', { name: 'write', args: { path: 'note.txt' } }, { id: 71 }),
    ])

    const frame = await stage.screen()
    const texts = frame.content.map((line) => line.text)

    // ⚠️ **U112 换锚**：工具那一行 `⟳ write note.txt` ＋ 底下 `  ⟳ 运行中`，变成
    //    头一行 `  ▸ ● write(note.txt)`——身份 ＋ **紧挨着的状态位**（在跑 ＝ `●`）＋ 名字。
    //    （2026-10-01 改定：状态位不再挂行尾，故中段那串靠右填充的空格也没了。）
    //    `shape` 那一压照旧（压掉首格缩进那一处空白），身份与状态位原样都在，**一条判据没放宽**。
    const shape = (text: string): string => text.replace(/\s+/gu, ' ')
    expect(texts.map(shape)).toEqual(['› 改个文件', '', ' ▸ ● write(note.txt)'])
  })

  test('思考**默认折一行**（`ctrl+o` 才展开）——分层靠标记与明暗，不靠空行', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'thinking', text: '第一行\n第二行\n第三行' })])

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见上）——这一句问的是「思考占几行」
    const folded = await stage.screen()
    expect(folded.content.map((line) => line.text)).toEqual(['（思考）第一行'])

    // ⚠️ **U110 起「展开」在查看那一屏上**（内联那一半恒折一行）——那三行去那一屏看。
    //    这一屏的排法与内联那一条**同一支**（`rowLines` 的展开态），故「几行、哪几行」
    //    在这里量得一样准；而骨架（字标那两行留白）不在这条判据里，用 `content` 那一格。
    const opened = await showScreen(stage.shell.getView())
    // 用 `screen.lines` ＋ 按锚点切片（不是 `content`——那一屏没有那两条线，切法不适用）
    const rows = opened.screen.lines.map((line) => line.trim())
    const at = rows.indexOf('（思考）第一行')

    expect(rows.slice(at, at + 3)).toEqual(['（思考）第一行', '第二行', '第三行'])
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
    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）
    const texts = frame.content.map((line) => line.text)

    // ⚠️ **U112 换锚**：原锚量的是「有没有一行以 `⏺ ` 起头」——标记整个退场之后那条断言
    //    **恒真**（量不出任何东西）。判据本身没变：**那一轮不产生助手行**——改成量
    //    「有没有一条**内容为空白**的非分段行」（真多出一行时它一定带着那些空格或空串），
    //    并顺手确认那条工具行**在**（不然「没有助手行」是空集好话）。
    expect(texts.filter((text) => text.trim() === '' && text !== '').length).toBe(0)
    expect(texts.some((text) => text.includes('▸ ● ls'))).toBe(true)
    // 头上的空串没了＝字标块把留白收进了装帧（同上一处：原锚 / 为何变 / 新锚 见「密度」节第一处）
    // ⚠️ **U67 改**：`› 跑一下` 与工具组之间那**一整行**在（用户 → 工具，中间没有助手那句）；
    //    而**那条一行都不占的空助手行没能在屏上留下痕迹**——分段没有被顶掉、也没有连成两行。
    // ⚠️ **U112**：工具那一行的形状同上一处（身份 ＋ 紧挨着的状态位）——`shape` 压掉缩进那格空白。
    const shape = (text: string): string => text.replace(/\s+/gu, ' ')
    expect(texts.map(shape)).toEqual(['› 跑一下', '', ' ▸ ● ls'])
  })
})

// ══ 四 · 记录区三类行 ═════════════════════════════════════════════════

describe('记录区的三类行（后两类不重建）', () => {
  test('会话内容随重建回来 · **命令输出与命令回执不回**', async () => {
    const stage = live()

    // 攒一屏「三类行」都在的现场：会话内容（重建得来）＋ 命令输出（`/help`）＋ 回执（`/model` 换成了）
    stage.type('/help')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.switched', { alias: 'default', ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const before = await stage.screen()
    expect(before.has('可用命令')).toBe(true) // 命令输出（第二类）
    expect(before.has('已选择')).toBe(true) // 命令回执（第三类）

    // 切走再切回：重建由 `session.history` 铺（会话内容那三类才落库）
    const entries: readonly Entry[] = [
      { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '好。' }, at: 1 },
    ]
    stage.feed([event('session.state', { active: 's2', sessions: [{ id: 's2', at: 0, title: '乙的事' }] })])
    stage.feed([event('session.history', { session: 's2', entries, done: true })])

    const after = await stage.screen()

    // ⚠️ 同上一处：`record` → `content`，且字标块的前后留白一并剥（原锚 / 为何变 / 新锚
    //    见「密度」节第一处）——这一句问的是「重建之后**会话内容**还剩哪些」，
    //    字标是装帧、不在会话内容里
    // U67：两条之间那一整行照留（重建回来的是**两块**，不是一段）
    // U112：助手那条正文不再带 `⏺ `（正文顶格）
    expect(after.content.map((line) => line.text)).toEqual(['› 看看有什么', '', '好。']) // 会话内容回来了
    expect(after.has('可用命令')).toBe(false) // 命令输出：屏上痕迹，不重建
    expect(after.has('已选择')).toBe(false) // 命令回执：屏上痕迹，不重建
  })
})

// ══ 五 · 失败那一行的裁法（U93 · D41 的另一半）════════════════════════

/**
 * `D41` 只解决了一半：措辞去重之后，**折叠态那一行仍然只铺 48 列的头**，长路径下
 * 「为什么 ＋ 该怎么办」被切在半路，要 `ctrl+o` 展开才看得到（U83 如实报的）。
 *
 * U93 把这一行改成**保头也保尾**（中段省掉、留一个 `…`）。这一节钉三件：
 * 长路径下**两头都在** · 短路径**逐字未变** · **另两支的尺子没被顺手改掉**
 * （被拒 / 被扣下那两句的要害在**头里**，见 `log.ts` 的 `firstLineOf`）。
 */
describe('失败那一行——保头也保尾（U93）', () => {
  /** 一条失败的工具结果——整句就是 `namedFailure` 那个形状（U83 定的措辞，一个字不动）。 */
  const failure = (path: string, reason = '上级目录不存在——先建目录') => [
    event('tool.call', { name: 'write', args: { path } }, { id: 71 }),
    event(
      'tool.result',
      { call: 71, ok: false, output: { text: `写入失败（${path}）：${reason}` } },
      {},
    ),
  ]

  /**
   * 结果那一行的**正文**部分——行首那两格缩进、以及那句耗时（`4ms · `，**量出来的、会变**）
   * 都不参与 48 列这笔账（48 是 `log.ts` 给那句正文的预算，见 `FAILED_LINE_COLUMNS`）。
   *
   * ⚠️ **U112 换锚**：原来还要剥掉 `  ✗ ` / `  ! ` 那个前缀标记——标记已经挪到头一行
   * 行尾去了，这一行不再带符号（只剩缩进一级）。耗时那一段**照旧要剥**：它由两个事件的
   * `at` 之差算出来，而 `at` 跟着**进程里全局递增的事件 id** 走——单跑这份文件时是 `null`，
   * 与别的文件同跑就冒出个 `4ms`。钉死它＝让这条用例随「谁跟谁一起跑」红绿。
   */
  const verdictOf = (line: string): string => line.replace(/^\s+(?:\S+\s+·\s+)?/, '')

  test('长路径——**尾部那句指引在折叠态也读得到**（中段省掉、留 `…`）', async () => {
    const stage = live()
    // 长到能把那一行撑过 48 列（真实工作区路径就是这个量级）
    stage.feed(failure('/var/folders/z9/qq6xk2pj7d7g0v_8tqp1hlz80000gn/T/u93-no-dir/u93-new.txt'))

    const frame = await stage.screen({ columns: 100, rows: 24 })
    const line = frame.textAt(frame.rowOf('写入失败'))
    const said = verdictOf(line)

    // ⚠️ **U112 换锚**：失败那个叉由行首挪到**头一行**、紧挨着身份记号右边
    //    （2026-10-01 改定：不在行尾）。判据本身没变：**这一段是失败的**，屏上要有那个叉。
    const head = frame.cellsOf(frame.rowOf('▸ × write('))
    expect(head[4]).toMatchObject({ text: '×' })
    expect(said).toContain('写入失败') // 名分（头那一半）
    expect(said).toContain('…') // 中段省掉、留了记号
    // **这一条就是本单的要害**：整句原委 ＋ 指引在折叠态读得到（改前只到「半个路径」）
    expect(said.endsWith('上级目录不存在——先建目录')).toBe(true)
    // 折叠态**只有一行**：没有换行，也不越 48 个字的预算（`FAILED_LINE_COLUMNS`）
    expect(said).not.toContain('\n')
    expect([...said].length).toBeLessThanOrEqual(48)
  })

  test('短路径——那一行**逐字未变**（反面：不为长路径改掉短的那一形）', async () => {
    const stage = live()
    stage.feed(failure('note.txt'))

    const frame = await stage.screen({ columns: 100, rows: 24 })
    const line = frame.textAt(frame.rowOf('写入失败'))

    // 短的那一形走的是「不超宽 ⇒ 原样」那条路——**与改前逐字相同**（真帧里的改前对照另证）
    expect(verdictOf(line)).toBe('写入失败（note.txt）：上级目录不存在——先建目录')
    expect(verdictOf(line)).not.toContain('…')
  })

  test('反面 · **被扣下**那一支的尺子没动（要害在头里，中截会把它挤掉）', async () => {
    const stage = live()
    // 首行是「未执行 · …」那一句（`conversation/src/rules.ts` 定的），这里撑长它看裁法
    const said = `未执行 · 规约已更新，重新审视后再操作${'（补充说明）'.repeat(8)}`
    stage.feed([
      event('tool.call', { name: 'write', args: { path: 'note.txt' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: false, output: { text: said }, notExecuted: true }, {}),
    ])

    const frame = await stage.screen({ columns: 100, rows: 24 })
    const line = frame.textAt(frame.rowOf('未执行'))

    expect(line).toContain('未执行 · 规约已更新') // 头照旧读得出
    // **仍然只留头**：中截那一形收在原文的尾巴上，这一支收在 `…` 上
    expect(line.endsWith('…')).toBe(true)
    expect(line.split('（补充说明）').length - 1).toBeLessThan(8) // 尾巴那几段没跟进来
  })
})
