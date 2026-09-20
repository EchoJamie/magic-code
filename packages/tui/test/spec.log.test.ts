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
    // ⚠️ 本条 2026-09-19 **收紧过**（U20）——原来钉的是 `✓ packages`（**当时输出的末行**）。
    //    - **原锚**：这一句其实**没钉规格**，钉的是「摘要＝结果末行」那个当时的实现；
    //    - **规格为什么变**：摘要改按**形态**出（`对表.md`·B8「就近渲染已知形态」），
    //      而原型场景 2 对 `ls` 画的正是 `✓ 0.2s · **14 项**`——列表报**项数**，不是报末一项的名字；
    //    - **新锚**：同一条规格（结果另起一行 · 缩进 · dim）＋ 摘要报项数（两行输出 ⇒ `2 项`）。
    expect(frame.rowOf('  ✓ 2 项')).toBeGreaterThan(head)

    // 结果内容：缩进两行（4 列）＋ 整行 dim
    const cells = frame.cellsOf(frame.rowOf('    README.md'))
    expect(cells.slice(0, 4).every((cell) => cell.text === ' ')).toBe(true)
    expect(cells.slice(4).every((cell) => cell.fg === '#8b93a1')).toBe(true)
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
    const said = frame.textAt(frame.rowOf('! 未执行 · 规约已更新，重新审视后再操作'))

    // ① **没有耗时**（`0ms · `/`4ms · ` 那一段是旧画法）——没跑的调用没有「耗了多久」这回事
    expect(said).not.toContain('ms')
    // ② 也**没有失败那个叉**：它是「没跑」，不是「跑了没成」
    expect(said).not.toContain('✗')
    // ③ 标记用 warn（要说的是「这一笔要你再看一眼」）——`  ! ` 的 `!` 在第 3 列
    expect(cellAt(frame, '! 未执行', 2)).toMatchObject({ text: '!', fg: '#e5c07b', bold: true })
    // ④ 展开（`ctrl+o`）之后，正文那句「为什么、怎么办」还在——屏上只是**首行**那一句
    stage.press({ kind: 'ctrl+o' })
    const opened = await stage.screen()
    expect(opened.has('已送入上下文')).toBe(true)
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
    const tail = frame.cellsOf(frame.rowOf('⏺ 丁') + 1)

    expect(tail.filter((cell) => cell.text.trim() !== '').every((cell) => cell.fg === '#d8dce4')).toBe(true)
    expect(tail.some((cell) => cell.fg === '#8b93a1')).toBe(false)
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
    //    **新锚**：`['› 第一句', …]`——本句钉的规矩照旧：空串**只**出现在用户消息之前。
    expect(texts).toEqual(['› 第一句', '⏺ 答一', '', '› 第二句', '⏺ 答二'])
  })

  test('思考**默认折一行**（`ctrl+o` 才展开）——分层靠标记与明暗，不靠空行', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'thinking', text: '第一行\n第二行\n第三行' })])

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见上）——这一句问的是「思考占几行」
    const folded = await stage.screen()
    expect(folded.content.map((line) => line.text)).toEqual(['（思考）第一行'])

    stage.press({ kind: 'ctrl+o' })
    const opened = await stage.screen()
    expect(opened.content.map((line) => line.text)).toEqual(['（思考）第一行', '第二行', '第三行'])
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

    expect(texts.some((text) => text.includes('⏺'))).toBe(false) // 没有孤零零的助手行
    // 头上的空串没了＝字标块把留白收进了装帧（同上一处：原锚 / 为何变 / 新锚 见「密度」节第一处）
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

    // ⚠️ 同上一处：`record` → `content`，且字标块的前后留白一并剥（原锚 / 为何变 / 新锚
    //    见「密度」节第一处）——这一句问的是「重建之后**会话内容**还剩哪些」，
    //    字标是装帧、不在会话内容里
    expect(after.content.map((line) => line.text)).toEqual(['› 看看有什么', '⏺ 好。']) // 会话内容回来了
    expect(after.has('可用命令')).toBe(false) // 命令输出：屏上痕迹，不重建
    expect(after.has('已换模型')).toBe(false) // 命令回执：屏上痕迹，不重建
  })
})
