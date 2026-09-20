/**
 * 规格即测试 · **左下那一片**（U24）——状态行规格 ＋ 裁决卡 ＋ 输入接管 ＋ slash 两种走法。
 *
 * 与 `spec.log.test.ts` 同一套取景（真链路 → 真终端 → 读屏与读格），出处同一份
 * `界面原型.html`（一 · 状态行规格；三 · 交互逻辑的「裁决与输入接管」「slash 的两种走法」）。
 *
 * 为什么这几条也要上屏量：
 * - **状态行**——「左半四格次序恒定」「右位独立、不推动左半」「窄窗从右往左省」都是**位置**的话，
 *   位置只在屏上；
 * - **裁决卡**——「不套框」「必闸类 `a` **划掉**」是**色与重量**的话（划掉是 `strikethrough`，
 *   纯文本里与一个字没区别）；
 * - **接管**——「看得见 / 草稿不丢 / 不静默吞键」都是**用户此刻看见什么**，不是视图字段。
 */

import { describe, expect, test } from 'bun:test'
import { event } from './events.ts'
import { createStage } from './screen.ts'
import type { Cell, Frame, Stage } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const

/**
 * 一条挂着裁决的现场——`weight` 决定轻 / 重（黄线 / 红线 · `a` 给不给）。
 *
 * ⚠️ `draft` 是**接管之前**打好的草稿——顺序要紧：接管挂上之后打的字**本来就该被拒**
 * （「先答复」那条兜底），拿那时候的输入当「草稿」是测错了对象。
 */
function asked(weight: 'light' | 'heavy' = 'light', draft = ''): Stage {
  const stage = createStage()
  if (draft !== '') stage.type(draft)

  stage.feed([
    event('tool.call', { name: weight === 'heavy' ? '覆盖写' : '跑测试', args: {} }, { id: 71 }),
    event(
      'tool.decision.request',
      { call: 71, name: weight === 'heavy' ? '覆盖写' : '跑测试', material: '命令 bun test', weight },
      { id: 88 },
    ),
  ])

  return stage
}

/**
 * **输入行那句话**在不在这几行里——问的是「占位换成了哪一句」。
 *
 * ⚠️ 为什么不直接 `includes('› 等你的答复')`：空草稿时落点曾是**画出来的那一格空格**
 * （`inverse` 空格，用户 2026-09-20 定的落点），帧上因此是**两个空格**。
 * **U31 之后那一格不画了**（改摆真终端光标，见本节末那条注），帧上只剩一个空格——
 * 但这一条**不动**：归一空白再比，锚的仍是「占位是哪一句」，与光标落在哪一格无关
 * （日后挪光标不必再来改这几条）。
 *
 * ⚠️ **原锚**：`line.text.includes('› 等你的答复')`（光标原先在占位**之后**，`› ` 与占位相邻）。
 * **为何变**：光标挪到占位之前 ⇒ 中间多一格（U31 起那格不再画，归一后同样成立）。
 * **新锚**：归一空白之后再比——锚的仍是**那句话**。
 */
const saysInComposer = (frame: Frame, text: string): boolean =>
  frame.dock.some((line) => line.text.replace(/\s+/gu, ' ').includes(`› ${text}`))

/** 一行的第 `col` 格——行找不到会当场抛（带整屏）。 */
function cellAt(frame: Frame, needle: string, col: number): Cell | undefined {
  return frame.cellsOf(frame.rowOf(needle))[col]
}

/** 屏上 `needle` 出现几次（「只出现一次」那类判据用它）。 */
function count(frame: Frame, needle: string): number {
  return frame.screen.lines.filter((line) => line.includes(needle)).length
}

// ══ 五 · 状态行（栏位固定，不随状态漂）═══════════════════════════════

describe('状态行 · 栏位固定', () => {
  test('左半四格**次序恒定**——① 状态 · ② 会话 · ③ 模型 · ④ 用量', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '记录查询优化' }] }),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])

    const line = (await stage.screen(WIDE)).statusLine

    expect(line.startsWith(' ○ 空闲')).toBe(true) // ① 永远在第 ① 位（它是视觉锚）
    expect(line.indexOf('○ 空闲')).toBeLessThan(line.indexOf('记录查询优化'))
    expect(line.indexOf('记录查询优化')).toBeLessThan(line.indexOf('MiniMax-M3'))
    expect(line.indexOf('MiniMax-M3')).toBeLessThan(line.indexOf('3.1k'))
  })

  /**
   * 阶段 3 批 2 · **接 D10 的读数**——④ 那格的**分母**。
   *
   * 钉的规格＝原型状态行的 ④：`3.1k/200k`（`对表.md`·差距 5「用量显示成 `已用/总量`」）。
   * 分母的来处是条目表的答复（`model.catalog`）——**当前那条**声明的 `contextWindow`。
   */
  test('④ 用量报 `已用/总量`——分母取自条目表里**当前那条**（D10）', async () => {
    const stage = createStage()
    stage.feed([event('model.usage', { inputTokens: 3100, outputTokens: 40 })])
    stage.feed([
      event('model.catalog', {
        entries: [
          { provider: 'minimax', model: 'MiniMax-M3', contextWindow: 200_000 },
          { provider: 'local', model: 'qwen3' }, // 没声明窗总量
        ],
        current: { provider: 'minimax', model: 'MiniMax-M3' },
      }),
    ])

    expect((await stage.screen(WIDE)).statusLine).toContain('3.1k/200k')
  })

  test('**没声明就不编**——条目没给窗总量时，④ 只报已用量', async () => {
    const stage = createStage()
    stage.feed([event('model.usage', { inputTokens: 3100, outputTokens: 40 })])
    stage.feed([
      event('model.catalog', {
        entries: [{ provider: 'local', model: 'qwen3' }],
        current: { provider: 'local', model: 'qwen3' },
      }),
    ])

    const line = (await stage.screen(WIDE)).statusLine

    expect(line).toContain('3.1k')
    expect(line).not.toContain('3.1k/') // 没有分母——**不编一个 200k 出来**
  })

  test('五态固定词——**量挂在状态后面**（第几件 / 第几次）', async () => {
    const idle = createStage()
    expect((await idle.screen(WIDE)).statusLine).toContain('○ 空闲')

    const working = createStage()
    working.feed([event('turn.start', {})])
    expect((await working.screen(WIDE)).statusLine).toContain('● 工作中')

    const waiting = asked()
    expect((await waiting.screen(WIDE)).statusLine).toContain('● 等你定夺')

    const retrying = createStage()
    retrying.feed([
      event('turn.start', {}),
      event('model.retry', { attempt: 2, delayMs: 1600, tier: 'transient' }),
    ])
    expect((await retrying.screen(WIDE)).statusLine).toContain('● 正在重试 2/3') // 量挂在状态后面

    const broken = createStage()
    broken.feed([event('model.error', { tier: 'terminal', message: '没了' })])
    expect((await broken.screen(WIDE)).statusLine).toContain('▲ 出错')
  })

  test('右位**独立**——出现 / 消失**不推动左半**（省了不改剩余字段的位置）', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '记录查询优化' }] }),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])

    const wide = (await stage.screen({ columns: 80, rows: 24 })).statusLine
    const narrow = (await stage.screen({ columns: 34, rows: 24 })).statusLine

    expect(wide).toContain('/ 命令 · ctrl+c 退出') // 右位在
    expect(narrow).not.toContain('/ 命令') // 右位整段不出现

    // 左半那两格的**起手位置一格没动**（右位不是「挤在流里」，是独立一栏）
    expect(narrow.indexOf('○ 空闲')).toBe(wide.indexOf('○ 空闲'))
    expect(narrow.indexOf('记录查询优化')).toBe(wide.indexOf('记录查询优化'))
  })

  test('窄窗口**从右往左省**：用量 → 模型 → 标题截断；**① 永不省**', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '记录查询优化' }] }),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])

    const wide = (await stage.screen({ columns: 80, rows: 24 })).statusLine
    const mid = (await stage.screen({ columns: 60, rows: 24 })).statusLine
    const tight = (await stage.screen({ columns: 30, rows: 24 })).statusLine

    expect(wide).toContain('3.1k') // ④ 在
    expect(wide).toContain('MiniMax-M3') // ③ 在
    expect(mid).not.toContain('3.1k') // ④ 先让位
    expect(mid).not.toContain('MiniMax-M3') // ③ 也跟着让位
    expect(mid).toContain('记录查询优化') // ② 还在
    expect(tight).toContain('记录查询…') // 再窄：标题**截断**（不是消失）
    expect(tight).not.toContain('记录查询优化')

    // ① 是视觉锚——三档宽度下**一次都没省过**
    for (const line of [wide, mid, tight]) expect(line).toContain('○ 空闲')
  })

  test('**一次性的事不进状态行**——「已换模型」去记录区当回执', async () => {
    const stage = createStage()
    stage.feed([event('model.switched', { ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const frame = await stage.screen(WIDE)

    expect(frame.statusLine).not.toContain('已换模型') // 状态行只放「此刻」
    expect(frame.statusLine).toContain('MiniMax-M2') // ③ 跟着换成新的
    expect(frame.record.some((line) => line.text === '· 已换模型 → MiniMax-M2')).toBe(true)
  })
})

// ══ 六 · 裁决卡 ══════════════════════════════════════════════════════

describe('裁决卡 · 不套框 · 键位只出现一次 · 必闸类划掉', () => {
  test('**不套框**——只有左边一条竖线，轻黄 · 重红', async () => {
    const light = await asked('light').screen(WIDE)
    const heavy = await asked('heavy').screen(WIDE)

    // 卡那几行都以左竖线起头，且**只有这一条**（没有右竖线、没有上下横边）
    const bars = (frame: Frame) => frame.screen.lines.filter((line) => line.includes('│'))
    for (const frame of [light, heavy]) {
      const rows = bars(frame)
      expect(rows.length).toBeGreaterThanOrEqual(3) // 标题 · 材料 · 键位
      expect(rows.every((line) => line.trimStart().startsWith('│'))).toBe(true)
      expect(frame.screen.lines.some((line) => /[┌┐└┘├┤┬┴┼╭╮╰╯]/.test(line))).toBe(false)
    }

    // 竖线**着色**（这就是「不套框但仍有轻重之分」的落法）
    expect(cellAt(light, '│ 跑测试 · 可逆', 1)).toMatchObject({ text: '│', fg: '#e5c07b' })
    expect(cellAt(heavy, '│ 覆盖写 · 不可逆', 1)).toMatchObject({ text: '│', fg: '#e06c75' })
    // 标题也吃这个色（轻 / 重一眼可分）——第 0 格是左内边距、第 1 格是竖线、第 2 格是它后面的空格
    expect(cellAt(light, '│ 跑测试 · 可逆', 3)).toMatchObject({ text: '跑', fg: '#e5c07b' })
    expect(cellAt(heavy, '│ 覆盖写 · 不可逆', 3)).toMatchObject({ text: '覆', fg: '#e06c75' })
  })

  test('**键位只出现一次**（在卡上）——输入框被占只报「等你的答复」', async () => {
    const frame = await asked('light').screen(WIDE)

    expect(count(frame, '批准')).toBe(1)
    expect(count(frame, '本工作区总是允许')).toBe(1)
    expect(count(frame, '拒绝')).toBe(1)
    // 接管那行**不重列键位**
    expect(saysInComposer(frame, '等你的答复')).toBe(true)
    expect(count(frame, '等你的答复')).toBe(1)
  })

  test('必闸类 **`a` 划掉**（不是藏起来）——轻的那件不划', async () => {
    const heavy = await asked('heavy').screen(WIDE)
    const light = await asked('light').screen(WIDE)

    const heavyBar = heavy.cellsOf(heavy.rowOf('y 批准'))
    const struck = heavyBar.find((cell) => cell.text === 'a')
    // 那个 `a` **还在屏上**（划掉≠藏起来：让你看见「这里本该有它、但这件不给」）
    expect(struck).toBeDefined()
    expect(struck?.strikethrough).toBe(true)
    expect(struck?.fg).toBe('#49505e') // 连同它的说明一起退到最弱

    expect(light.cellsOf(light.rowOf('y 批准')).find((cell) => cell.text === 'a')?.strikethrough).toBe(
      false,
    )

    // 右位跟着少一个键（`y / a / n` → `y / n`）
    expect(light.statusLine).toContain('y / a / n')
    expect(heavy.statusLine).toContain('y / n')
    expect(heavy.statusLine).not.toContain('y / a / n')
  })
})

// ══ 七 · 输入接管（三条兜底 ＋ 多件逐件问）═══════════════════════════

describe('输入接管', () => {
  test('**看得见**——占位换成「等你的答复」（草稿此刻不在屏上）', async () => {
    const stage = asked('light', '打了一半')

    const frame = await stage.screen(WIDE)

    expect(saysInComposer(frame, '等你的答复')).toBe(true)
    expect(frame.has('打了一半')).toBe(false) // 收起来了，不是丢了（下一条把它要回来）
  })

  test('**草稿不丢**——答完原样归还、**不自动发送**', async () => {
    const stage = asked('light', '打了一半')

    stage.press({ kind: 'char', char: 'y' })
    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 900 })])

    const frame = await stage.screen(WIDE)

    expect(frame.dock.some((line) => line.text.includes('› 打了一半'))).toBe(true) // 归还
    expect(frame.has('等你的答复')).toBe(false) // 接管解除
    // **不自动发送**：记录区没有多出用户行，也没发过 `input.submit`
    expect(frame.record.some((line) => line.text.startsWith('› 打了一半'))).toBe(false)
    expect(stage.commands().some((command) => command.type === 'input.submit')).toBe(false)
  })

  test('**不静默吞键**——非答复键忽略，但当场说一句', async () => {
    const stage = asked()
    stage.press({ kind: 'char', char: 'x' })

    const frame = await stage.screen(WIDE)

    const said = frame.dock.find((line) => line.text.startsWith('▲'))
    expect(said?.text).toContain('先答复')
    expect(said?.text).toContain('「x」') // 说的是**哪一个键**（不静默 ≠ 只说一句套路话）
    expect(saysInComposer(frame, '等你的答复')).toBe(true) // 那一下没进草稿
  })

  test('`esc` **无动作**——屏上一格都不变', async () => {
    const stage = asked()
    const before = await stage.screen(WIDE)

    stage.press({ kind: 'escape' })
    const after = await stage.screen(WIDE)

    expect(after.screen.lines).toEqual(before.screen.lines)
    expect(after.statusLine).toContain('● 等你定夺') // 还在接管里
  })

  test('**多件逐件问**——件数报两处（卡上 · 底行），且**只有一张卡**', async () => {
    const stage = createStage()
    stage.feed([
      event('tool.call', { name: 'write', args: {} }, { id: 71 }),
      event('tool.call', { name: 'write', args: {} }, { id: 72 }),
      event('tool.call', { name: 'write', args: {} }, { id: 73 }),
      event('tool.decision.request', { call: 72, name: '整写文件', material: '目标 README.md', weight: 'light' }, { id: 88 }),
    ])

    const frame = await stage.screen(WIDE)

    expect(frame.has('│ 整写文件 · 可逆 · 2 / 3')).toBe(true) // 报数之一：卡的标题
    expect(frame.statusLine).toContain('● 等你定夺 2/3') // 报数之二：底行
    expect(count(frame, 'y 批准')).toBe(1) // 不并列、不堆积——你永远只面对一件
  })
})

// ══ 八 · slash 两种走法 ══════════════════════════════════════════════

describe('slash 的两种走法', () => {
  test('纯输出型（`/help`）——输出进记录区 · **命令本身不回显**', async () => {
    const stage = createStage()
    stage.type('/help')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)

    expect(frame.record.some((line) => line.text === '可用命令')).toBe(true) // 输出进去了
    // 记录区里**没有 `› /help` 那一行**——命令是你对**工具**下的指令，不是对 Agent 说的话
    expect(frame.record.some((line) => line.text.startsWith('› '))).toBe(false)
    expect(frame.record.some((line) => line.text.includes('/help'))).toBe(true) // 只有输出块里那一条目录
  })

  test('交互配置型（`/session`）——回车**什么都不进记录区**，只在左下开选择器', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', {
        active: 's1',
        sessions: [
          { id: 's1', at: 0, title: '记录查询优化' },
          { id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ])

    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('session.state', {
        active: 's1',
        sessions: [
          { id: 's1', at: 0, title: '记录查询优化' },
          { id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ])

    const frame = await stage.screen(WIDE)

    // ⚠️ 取景换 `content`（记录区**去掉最前面那块启动字标**）——
    //    **原锚** `frame.record`：那时记录区第一行就是内容。
    //    **为何变**：启动字标（TUI Banner）现在恒在记录区最前面，`record` 的头几行是它。
    //    **新锚** `frame.content`——本句问的是「开选择器**往记录区里进了什么**」，
    //    而字标是**开局就在那儿**的装帧，不是「进了」；有没有它这话都成立。
    expect(frame.content).toEqual([]) // 记录区**一行都不进**
    expect(frame.has('1 记录查询优化')).toBe(true) // 选择器开在左下
    expect(frame.has('正在用')).toBe(true) // 当前那条有标记
    expect(frame.statusLine).toContain('↑↓ 选 · 回车 定 · esc 收起')
  })

  /**
   * 缺陷 D23 —— **提交之后候选要收起**。
   *
   * 钉的规格＝本节两种走法共有的那半句：**回车之后画面上是什么**。候选是**打字的伴生**
   * （D12：打 `/` 即出、边打边筛），草稿一清它就**没有来处**了；留着就是
   * **空输入框下挂着候选** ＋ 右位停在「↑↓ 选 · Tab 补全」。
   */
  test('提交之后**候选收起**（D23）——打字的伴生不该跟着提交留下', async () => {
    const stage = createStage()
    // ⚠️ 用**纯输出型**（`/status`）而不是 `/session`——选择器一开就把左下整片换掉了，
    //    候选**看不看得见**在那一支里分不出来（判据会假绿）。这一支 dock 仍是输入区。
    stage.type('/status')
    // 先确认候选**真的开着**——不然「提交后没有」可能是假绿（它本来就没开过）
    expect((await stage.screen(WIDE)).has('看这一趟用了多少、模型是谁')).toBe(true)

    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)

    expect(frame.has('看这一趟用了多少、模型是谁')).toBe(false) // 候选收起
    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见上一处）
    expect(frame.content.some((line) => line.text !== '')).toBe(true) // 提交照旧生效（输出进了记录区）
    expect(frame.statusLine).not.toContain('Tab 补全') // 右位不再报补全键位
    expect(frame.statusLine).toContain('/ 命令 · ctrl+c 退出') // 回常态
  })

  test('选定了——留**一行**回执', async () => {
    const stage = createStage()
    const catalog = [
      event('session.state', {
        active: 's1',
        sessions: [
          { id: 's1', at: 0, title: '记录查询优化' },
          { id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ]
    stage.feed(catalog)
    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）——
    //    这一句问的是「选定之后**留了几行回执**」，字标不是回执
    expect(frame.content.map((line) => line.text)).toEqual(['· 已切到 修复时区处理']) // **一行**，不是一面
    expect(saysInComposer(frame, '交代一件事，回车发送')).toBe(true) // 收起了
  })

  test('`esc` 取消——**不留痕迹**（记录区与回执都没有）', async () => {
    const stage = createStage()
    const catalog = [
      event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '记录查询优化' }] }),
    ]
    stage.feed(catalog)
    stage.type('/session')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)

    stage.press({ kind: 'escape' })
    const frame = await stage.screen(WIDE)

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）
    expect(frame.content).toEqual([]) // 没有回执
    expect(frame.has('1 记录查询优化')).toBe(false) // 选择器收起
    expect(saysInComposer(frame, '交代一件事，回车发送')).toBe(true)
  })
})

// ══ 九 · 输入行的光标（用户 2026-09-20 定）═════════════════════════════

/**
 * 「**输入区域的光标位置 目前是在灰色的提示文本后面……这段提示文本允许保留
 * 但光标不应该在提示文本后面**」（用户 2026-09-20）。
 *
 * 两条一起钉，因为这是一对：**空草稿**时落点＝「开始打字的地方」（`› ` 之后、占位之前）；
 * **有草稿**时落点＝**末尾**（正在打的那一处）——后者本来就对，别被前一条顺手改掉。
 *
 * ⚠️ **U31 改量法：量真终端的光标，不再量画出来那一格**——
 * **原锚**：`cursorAt()` 读那一格 `inverse`（画出来的空格：`› ` → 光标 → 占位 /
 *   `› ` → 草稿 → 光标）落在第几列。
 * **为何变**：画出来那格与**终端自己的光标**是两笔账——两个一起摆出来就是**两个光标**
 *   （用户看得见的那一格反显 ＋ 顶在它上面的终端光标）。本单元把画的那格**删掉**，
 *   改摆真光标（`useCursor()` ＋ `measureElement()`，见 `composer.ts` 头注）⇒
 *   「光标落在哪」这句话现在得读**终端光标坐标**（`Frame.screen.cursor`）。
 * **新锚**：
 * - **空草稿**：真光标在占位那一行的第 3 列（左留白 1 ＋ `› ` 2 列）——落点不变，
 *   只是由终端自己画；那一行**不再有反色格**；
 * - **有草稿**：真光标紧跟在草稿末尾之后（`1 ＋ 2 ＋ 草稿的显示宽度`）；
 * - **接管中**（裁决挂着）：**没有插入点** ⇒ 真光标不在输入行上（藏起来），
 *   屏上也没有反色格。
 */
describe('输入行 · 光标落在哪', () => {
  test('**空草稿**：真光标在 `› ` 之后、**占位之前**——不在灰字后面', async () => {
    const stage = createStage()
    const frame = await stage.screen(WIDE)
    const row = frame.rowOf('交代一件事，回车发送')

    // 左留白 1 ＋ `› ` 2 列 ⇒ 第 3 列；行号＝占位那一行（输入行自己那一行）
    expect(frame.screen.cursor).toEqual({ x: 3, y: row })
    // 画出来那格已经删了——否则与真光标撞成一格两个光标（U31）
    expect(frame.rawCellsOf(row).some((cell) => cell.inverse)).toBe(false)
    // 占位那句灰字仍在它后面（落点没挪到别处）
    expect(frame.textAt(row).endsWith('交代一件事，回车发送')).toBe(true)
  })

  test('**有草稿**：真光标仍在**末尾**（正在打的那一处）——这一路不动', async () => {
    const stage = createStage()
    stage.type('打了一半')
    const frame = await stage.screen(WIDE)
    const row = frame.rowOf('打了一半')

    // 1（左留白）＋ 2（`› `）＋ 4 个汉字各占 2 列 ＝ 11
    expect(frame.screen.cursor).toEqual({ x: 11, y: row })
    expect(frame.rawCellsOf(row).some((cell) => cell.inverse)).toBe(false)
  })

  test('**接管中**（占位换成「等你的答复」）真光标不在输入行上', async () => {
    const frame = await asked('light', '草稿').screen(WIDE)
    const row = frame.rowOf('等你的答复')

    expect(frame.screen.cursor.y).not.toBe(row)
    expect(frame.rawCellsOf(row).some((cell) => cell.inverse)).toBe(false)
  })
})
