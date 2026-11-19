/**
 * 规格即测试 · **左下那一片**（U24）——状态行规格 ＋ 裁决卡 ＋ 输入接管 ＋ slash 两种走法。
 *
 * 与 `log-presentation.test.ts` 同一套取景（真链路 → 真终端 → 读屏与读格），出处同一份
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
import type { Frame } from './screen.ts'
import { collaborationFixture } from './collaboration-fixture.ts'

const WIDE = { columns: 200, rows: 40 } as const

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

// ══ 五 · 状态行（栏位固定，不随状态漂）═══════════════════════════════

describe('状态行 · 栏位固定', () => {
  test('左半各格**次序恒定**——① 状态 · ② 会话 · 上下文占用', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', { active: 's1', sessions: [{ archived: false, id: 's1', at: 0, title: '记录查询优化' }] }),
      event('model.call.start', { choice: 'default', model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])

    const line = (await stage.screen(WIDE)).statusLine

    // ⚠️ **U112 改的那一格**：默认那一条（`STATUS_LINE_DEFAULT`）＝「会话名 · 上下文占用」，
    //    **模型那一格不再默认摆出来**（设计：默认那条不放配置回显，用户自己勾才算）。故
    //    ② 之后是上下文占用——「次序恒定」这条规格不变，只是那一列里少了一格。
    expect(line.startsWith(' ○ 空闲')).toBe(true) // ① 永远在第 ① 位（它是视觉锚）
    expect(line.indexOf('○ 空闲')).toBeLessThan(line.indexOf('记录查询优化'))
    expect(line.indexOf('记录查询优化')).toBeLessThan(line.indexOf('3.1k'))
  })

  /**
   * 阶段 3 批 2 · **接 D10 的读数**——④ 那格的**分母**。
   *
   * 钉的规格＝原型状态行的 ④：`3.1k/200k`（`对表.md`·差距 5「用量显示成 `已用/总量`」）。
   * 分母的来处是条目表的答复（`model.catalog`）——**当前那条**声明的 `contextWindow`。
   */
  test('④ 用量报 `已用/总量`——分母取自答复里**当前选择**的有效输入预算（D10）', async () => {
    // **原锚**（U30/D10）：分母取 `entries` 里**当前那条**的 `contextWindow`。
    // **为何变**（U41 返修）：那一格是**该连接默认模型**的数，而当前选中可以是同一条连接下
    //   的**另一个模型**——照它取就是拿错型号（复核点名）；答复另带**按 `current` 算**的
    //   `currentInputBudget`（与出站 / 用量 / 压缩同源，模型域一次解析）。
    // **新锚**：`currentInputBudget`。下面那行的 `contextWindow` 故意留着——
    //   它**不该**被用上（用例里那个 999k 从不露面）。
    const stage = createStage()
    stage.feed([event('model.usage', { inputTokens: 3100, outputTokens: 40 })])
    stage.feed([
      event('model.catalog', {
        entries: [
          { provider: 'minimax', cache: { snapshot: { provider: 'minimax', scope: 'fixture', fetchedAt: 1, models: [{ id: 'MiniMax-M3' }] } },  },
          { provider: 'local', cache: { snapshot: { provider: 'local', scope: 'fixture', fetchedAt: 1, models: [{ id: 'qwen3' }] } }, },
        ],
        current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'default' as const, provider: 'minimax', model: 'deepseek-reasoner' },
        currentInputBudget: 200_000,
      }),
    ])

    const frame = await stage.screen(WIDE)
    expect(frame.statusLine).toContain('3.1k/200k')
    expect(frame.statusLine).not.toContain('999k') // 默认行那一格与当前选择无关
  })

  test('**没声明就不编**——条目没给窗总量时，④ 只报已用量', async () => {
    const stage = createStage()
    stage.feed([event('model.usage', { inputTokens: 3100, outputTokens: 40 })])
    stage.feed([
      event('model.catalog', {
        entries: [{ provider: 'local', cache: { snapshot: { provider: 'local', scope: 'fixture', fetchedAt: 1, models: [{ id: 'qwen3' }] } }, }],
        current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'default' as const, provider: 'local', model: 'qwen3' },
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

    const waiting = createStage()
    waiting.feed([
      event('collaboration.view', {
        ...collaborationFixture,
        members: collaborationFixture.members.map((member, index) =>
          index === 0 ? { ...member, pendingDecisions: 1 } : member,
        ),
      }),
    ])
    expect((await waiting.screen(WIDE)).statusLine).toContain('◊ 等你定夺') // U112：等你与工作中**分形状**

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

  test('**一次性的事不进状态行**——「已换模型」去记录区当回执', async () => {
    const stage = createStage()
    stage.feed([event('model.switched', { choice: 'default', ok: true, model: 'MiniMax-M2', provider: 'minimax' })])

    const frame = await stage.screen(WIDE)

    expect(frame.statusLine).not.toContain('已选择') // 状态行只放「此刻」
    // ⚠️ **U112 删掉的那一条**：旧锚＝`statusLine` 含新模型名（模型那格跟着换）。
    //    模型那一格不再在默认那一列里（`STATUS_LINE_DEFAULT`＝会话名 · 上下文占用），
    //    「换模型」这件事在屏上只剩记录区那一行回执——下面那条就是它的落点。
    // ⚠️ **U112 换形**：回执行不再以 `· ` 起头（那个字形只做行内分隔），改靠**缩进一级 ＋ 最弱色**
    expect(frame.record.some((line) => line.text === '  已选择 Default')).toBe(true)
  })
})

// ══ 八 · slash 两种走法 ══════════════════════════════════════════════

describe('slash 的两种走法', () => {
  test('纯输出型（`/help`）——输出进记录区 · **命令本身不回显**', async () => {
    const stage = createStage()
    stage.type('/help ')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)

    expect(frame.record.some((line) => line.text === '使用帮助')).toBe(true) // 输出进去了
    // 记录区里**没有 `› /help` 那一行**——命令是你对**工具**下的指令，不是对 Agent 说的话
    expect(frame.record.filter(line => line.text.startsWith('› ')).map(line => line.text)).toEqual(['› /help'])
    expect(frame.record.some((line) => line.text.includes('/help'))).toBe(true) // 只有输出块里那一条目录
  })

  test('交互配置型（`/resume`）——回车**什么都不进记录区**，只在左下开选择器', async () => {
    const stage = createStage()
    stage.feed([
      event('session.state', {
        active: 's1',
        sessions: [
          { archived: false, id: 's1', at: 0, title: '记录查询优化' },
          { archived: false, id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ])

    stage.type('/resume ')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('session.state', {
        active: 's1',
        sessions: [
          { archived: false, id: 's1', at: 0, title: '记录查询优化' },
          { archived: false, id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ])

    const frame = await stage.screen(WIDE)

    // ⚠️ 取景换 `content`（记录区**去掉最前面那块启动字标**）——
    //    **原锚** `frame.record`：那时记录区第一行就是内容。
    //    **为何变**：启动字标（TUI Banner）现在恒在记录区最前面，`record` 的头几行是它。
    //    **新锚** `frame.content`——本句问的是「开选择器**往记录区里进了什么**」，
    //    而字标是**开局就在那儿**的装帧，不是「进了」；有没有它这话都成立。
    expect(frame.content.map(line => line.text)).toEqual(['› /resume']) // 记录区**一行都不进**
    expect(frame.dock.some(line => line.text.includes('›  记录查询优化'))).toBe(true) // 选择器开在左下
    expect(frame.has('正在用')).toBe(true) // 当前那条有标记
    // **键位提示对得上键位**（U49 加了两个键）：「名称搜索」与「当前工作区 / 全部」的筛选
    // 落在这一屏上（设计明文），抽屉一开就接管输入——不报出来用户只能自己撞，撞不出回声
    // ⚠️ U61（选择器的「层」与一套栈）在这一句里加了 `← 退`——与 `esc 收起` 成对报出
    //    （设计：`←` 弹一层、`esc` 全收，两个动作两个键）。
    expect(frame.dock.map(line => line.text).join('\n')).toContain('↑↓ 选择 · 打字筛选 · Ctrl+G 操作 · Esc 返回')
    expect(frame.statusLine).not.toContain('Esc 返回')
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
    // ⚠️ 用**纯输出型**（`/status`）而不是 `/resume`——选择器一开就把左下整片换掉了，
    //    候选**看不看得见**在那一支里分不出来（判据会假绿）。这一支 dock 仍是输入区。
    stage.type('/status')
    // 先确认候选**真的开着**——不然「提交后没有」可能是假绿（它本来就没开过）
    expect((await stage.screen(WIDE)).has('查看会话、模型、用量与调用状态')).toBe(true)

    stage.type(' ')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)

    expect(frame.has('查看会话、模型、用量与调用状态')).toBe(false) // 候选收起
    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见上一处）
    expect(frame.content.some((line) => line.text !== '')).toBe(true) // 提交照旧生效（输出进了记录区）
    expect(frame.statusLine).not.toContain('Tab 补全') // 右位不再报补全键位
    expect(frame.statusLine).toContain('/ 命令 · ctrl+c 退出') // 回常态
  })

  /**
   * 选定之后**留一行回执**——⚠️ 这一行**等答复到了才留**（U44）。
   *
   * 由头：换会话要翻页（清可见屏），那一下发生在「页号一变」那一瞬——**选定那一刻**写下的
   * 字会被一并推进 scrollback，新那一页的界上就没有它了。故本用例连着判两跳：
   * 选定之后**记录区仍是空的**（一个字都没说），答复到了才是那**一行**。
   */
  test('选定了——**答复到了才**留**一行**回执', async () => {
    const stage = createStage()
    const catalog = [
      event('session.state', {
        active: 's1',
        sessions: [
          { archived: false, id: 's1', at: 0, title: '记录查询优化' },
          { archived: false, id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ]
    stage.feed(catalog)
    stage.type('/resume ')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)
    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    // 还没答复：这一跳只发了命令、收起了抽屉——记录区**一个字都没有**
    const before = await stage.screen(WIDE)
    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）
    expect(before.content.map(line => line.text)).toEqual(['› /resume'])
    expect(saysInComposer(before, '交代一件事，回车发送')).toBe(true) // 收起了

    // 答复（活跃位真换了）⇒ 那**一行**回执落进记录区
    stage.feed([
      event('session.state', {
        active: 's2',
        sessions: [
          { archived: false, id: 's1', at: 0, title: '记录查询优化' },
          { archived: false, id: 's2', at: 0, title: '修复时区处理' },
        ],
      }),
    ])

    const frame = await stage.screen(WIDE)

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）——
    //    这一句问的是「选定之后**留了几行回执**」，字标不是回执
    expect(frame.content.map((line) => line.text)).toEqual(['  已切到 修复时区处理']) // **一行**，不是一面（U112 起无记号）
  })

  test('`esc` 取消——**不留痕迹**（记录区与回执都没有）', async () => {
    const stage = createStage()
    const catalog = [
      event('session.state', { active: 's1', sessions: [{ archived: false, id: 's1', at: 0, title: '记录查询优化' }] }),
    ]
    stage.feed(catalog)
    stage.type('/resume ')
    stage.press({ kind: 'enter' })
    stage.feed(catalog)

    stage.press({ kind: 'escape' })
    const frame = await stage.screen(WIDE)

    // ⚠️ 同上一处：`record` → `content`（原锚 / 为何变 / 新锚 见本节第一处）
    expect(frame.content.map(line => line.text)).toEqual(['› /resume']) // 没有回执
    expect(frame.dock.some(line => line.text.includes('›  记录查询优化'))).toBe(false) // 选择器收起
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
 * - **有草稿**：真光标紧跟在草稿末尾之后（`1 ＋ 2 ＋ 草稿的显示宽度`）。
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


  /**
   * U133 —— **候选开着时回车先补全**，不提交。
   *
   * 打 `/` 之后 ↑↓ 选完直接敲回车，曾经会把一条只有斜杠的交代发给模型：
   * 回车走普通提交，而 `/`、`/h` 都不满足「完整命令名 ＋ 空格」。
   */
  test('候选开着时回车先补全（U133）——只有斜杠的交代不会发出去', async () => {
    const stage = createStage()
    stage.type('/c')

    const opened = await stage.screen(WIDE)
    expect(opened.statusLine).toContain('Tab 补全') // 候选真的开着

    stage.press({ kind: 'down' })
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)
    const input = frame.dock.map((line) => line.text).join('\n')

    expect(input).toMatch(/\/(connect|clear|compact)/) // 补成了「命令名 ＋ 空格」
    expect(frame.statusLine).not.toContain('Tab 补全') // 候选收起
    expect(stage.commands().some((command) => command.type === 'input.submit')).toBe(false)
  })


  /**
   * U133 的两条边界：**严格前缀才补全**；**模糊匹配出来的候选回车照发**。
   *
   * `/help` 是 `/help` 的前缀 ⇒ 补全；`/hlp` 只是子序列命中 ⇒ 那是正文，回车照发。
   */
  test('候选开着时只对前缀补全——命令名打完就直接执行（U133 · U134）', async () => {
    // 前缀：还没打全 ⇒ 补全，不提交
    const prefix = createStage()
    prefix.type('/h')
    expect((await prefix.screen(WIDE)).statusLine).toContain('Tab 补全')
    prefix.press({ kind: 'enter' })
    expect(prefix.shell.getView().draft).toBe('/help ')
    expect(prefix.commands().some((command) => command.type === 'input.submit')).toBe(false)

    // 打全了 ⇒ 回车直接执行（清稿），不再补全
    const full = createStage()
    full.type('/help')
    full.press({ kind: 'enter' })
    expect(full.shell.getView().draft).toBe('')

    // 模糊命中（子序列）⇒ 那是正文，回车照发
    const fuzzy = createStage()
    fuzzy.type('/hlp')
    expect((await fuzzy.screen(WIDE)).statusLine).toContain('Tab 补全')
    fuzzy.press({ kind: 'enter' })
    expect(fuzzy.commands()).toContainEqual(expect.objectContaining({ type: 'input.submit', text: '/hlp' }))
  })

})
