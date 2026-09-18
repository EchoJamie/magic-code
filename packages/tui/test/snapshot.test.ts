/**
 * 十四屏快照（缺陷轮 II）——**照着 `界面原型.html` 落**的判据。
 *
 * 取景走**真链路**：事件喂进 `createShell` → 键喂进外壳 → 快照钉住**整条链**
 * （事件 / 键 → 视图 → 一屏），而不是手搓的视图对象。
 *
 * 与原型逐屏对照（场景号即 `describe` 里的编号）：
 * 1 启动空态 · 2 空闲有历史 · 3 工作中流式 · 4 待裁决（轻）· 5 待裁决（重）·
 * 6 接管按了非答复键 · 7 多件裁决 · 8 答完之后 · 9 `/session` · 10 `/model` ·
 * 11 `/help` · 12 重建（收拢）· 13 退避重试 · 14 窄窗口降级。
 *
 * 快照文件：`test/__snapshots__/snapshot.test.ts.snap`（入库——改动即进 diff 可评审）。
 */

import { describe, expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { createElement as h } from 'react'
import type { Entry, KernelEvent } from '@magic/contracts'
import { AppView } from '../src/components/app.ts'
import { logLines } from '../src/components/log.ts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

const COLUMNS = 100
const ROWS = 30

/** 取景——一屏渲染成字符串（同一条链，只有最后一跳是纯函数）。 */
function screen(shell: ReturnType<typeof createShell>, columns = COLUMNS, rows = ROWS): string {
  return renderToString(h(AppView, { view: shell.getView(), columns, rows }), { columns })
}

/** 起壳 ＋ 取景把手。 */
function live() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)

  return {
    shell,
    spy,
    feed: (events: readonly KernelEvent[]) => {
      for (const item of events) spy.emit(item)
    },
    key: (key: ShellKey) => shell.key(key),
    type: (text: string) => {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    screen: (columns = COLUMNS, rows = ROWS) => screen(shell, columns, rows),
  }
}

const ENTER: ShellKey = { kind: 'enter' }
const SESSION = 'sess-1'

const state = (active: string, rows: readonly { id: string; title?: string }[]) =>
  event('session.state', {
    active,
    sessions: rows.map((row) => ({ id: row.id, at: 0, ...(row.title === undefined ? {} : { title: row.title }) })),
  })

/** 一屏「有历史」的常态（场景 2 的底子）。 */
function historyShown(app: ReturnType<typeof live>): void {
  app.feed([
    state(SESSION, [{ id: SESSION, title: '记录查询优化' }]),
    event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
    event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
  ])
  app.type('看看这个工作区里有什么')
  app.key(ENTER)
  app.feed([
    event('turn.start', {}),
    event('model.delta', { channel: 'text', text: '我先列一下。' }),
    event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 }),
    event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 200 }),
    event('tool.result', { call: 71, ok: true, output: { text: '14 项' } }),
    event('model.delta', { channel: 'text', text: '是个 Bun 工作区，packages 下六个包。' }),
    event('turn.end', { reason: 'settled' }),
  ])
}

// ══ 场景 1–3 ═════════════════════════════════════════════════════════

describe('场景 1 · 启动（空态）', () => {
  test('**新会话，不接续**——空手打开没有会话，状态行报「新会话」', () => {
    const app = live()
    app.feed([event('turn.end', { reason: 'settled' })])

    const frame = app.screen()
    expect(frame).toContain('交代一件事就开始')
    expect(frame).toContain('你按下第一次回车')
    expect(frame).toContain('新会话')
    expect(frame).toContain('○ 空闲')
    expect(frame).toContain('/ 命令 · ctrl+c 退出')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 2 · 空闲（有历史）', () => {
  test('三类行各就其位 ＋ 状态行四格', () => {
    const app = live()
    historyShown(app)

    const frame = app.screen()
    expect(frame).toContain('› 看看这个工作区里有什么')
    expect(frame).toContain('⏺ 我先列一下。')
    // 工具标记＝`●`（与助手同族 · 只换颜色 · 视觉重量比助手轻——原型 · 组件规格）
    expect(frame).toContain('●')
    expect(frame).toContain('ls')
    expect(frame).toContain('3.1k')
    expect(frame).toContain('记录查询优化')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 3 · 工作中（流式）', () => {
  test('工具在跑——标记换 `⟳` ＋ **运行中**（不编秒数）；输入行说实话；右位报中断', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '时区修正' }]),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('turn.start', {}),
    ])
    app.type('把 src/utils/date.ts 的时区处理改成本地时区')
    app.key(ENTER)
    app.feed([
      event('model.delta', { channel: 'text', text: '先读一遍，看清它现在怎么算的——' }),
      event('tool.call', { name: 'read', args: { path: 'src/utils/date.ts' } }, { id: 71 }),
    ])

    const frame = app.screen()
    expect(frame).toContain('⟳')
    expect(frame).toContain('● 工作中')
    expect(frame).toContain('ctrl+c 中断')
    expect(frame).toMatchSnapshot()
  })
})

// ══ 场景 4–8（裁决与接管）════════════════════════════════════════════

describe('场景 4 · 待裁决（轻）', () => {
  test('黄线 ＋ 材料内联 ＋ 三键（含 `a`）；输入行只报「等你的答复」', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '记录查询优化' }]),
      event('turn.start', {}),
    ])
    app.type('跑一下测试看看现在什么情况')
    app.key(ENTER)
    app.feed([
      event('model.delta', { channel: 'text', text: '要跑 bun test——这条命令没配过规则，请一下。' }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: '命令 bun test · 只读（不写工作区）', weight: 'light' },
        { id: 88 },
      ),
    ])

    const frame = app.screen()
    expect(frame).toContain('│ exec')
    expect(frame).toContain('可逆')
    expect(frame).toContain('本工作区总是允许')
    expect(frame).toContain('等你的答复')
    expect(frame).toContain('● 等你定夺')
    expect(frame).toContain('y / a / n')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 5 · 待裁决（重）', () => {
  test('红线 ＋ **`a` 划掉**（不是藏起来）；右位只剩 `y / n`', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '时区修正' }]),
      event('turn.start', {}),
    ])
    app.type('把 user_version 抬到 1，旧库的迁移也补上')
    app.key(ENTER)
    app.feed([
      event(
        'tool.decision.request',
        {
          call: 72,
          name: 'write',
          material: '目标 src/records/db.ts · 影响面 覆盖已有文件（132 行将变）\n- const v = 0\n+ const v = 1',
          weight: 'heavy',
        },
        { id: 89 },
      ),
    ])

    const frame = app.screen()
    expect(frame).toContain('不可逆')
    expect(frame).toContain('本工作区总是允许') // **还在**（划掉而非藏起来）
    expect(frame).toContain('y / n')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 6 · 接管 · 按了非答复键', () => {
  test('忽略但**当场说一句**（`▲ …`）；其余照旧', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '记录查询优化' }]),
      event('turn.start', {}),
      event('tool.decision.request', { call: 71, name: 'write', material: '覆盖 src/records/db.ts', weight: 'heavy' }, { id: 88 }),
    ])
    app.key({ kind: 'char', char: 'x' })

    const frame = app.screen()
    expect(frame).toContain('▲')
    expect(frame).toContain('先答复')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 7 · 多件裁决', () => {
  test('件数报**两处**：卡的标题 `2 / 3` 与状态行 `2/3`', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '时区修正' }]),
      event('turn.start', {}),
      event('tool.call', { name: 'write', args: { path: 'a' } }, { id: 71 }),
      event('tool.call', { name: 'write', args: { path: 'b' } }, { id: 72 }),
      event('tool.call', { name: 'write', args: { path: 'c' } }, { id: 73 }),
      event(
        'tool.decision.request',
        { call: 72, name: 'write', material: '目标 README.md · 影响面 覆盖（新增 12 行）', weight: 'light' },
        { id: 88 },
      ),
    ])

    const frame = app.screen()
    expect(frame).toContain('2 / 3')
    expect(frame).toContain('● 等你定夺 2/3')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 8 · 答完之后', () => {
  test('回执一行 · 下一件接上 · 草稿归还（不自动发送）', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '时区修正' }]),
      event('turn.start', {}),
      event('tool.call', { name: 'write', args: { path: 'src/records/db.ts' } }, { id: 71 }),
      event('tool.decision.request', { call: 71, name: 'write', material: '目标 src/records/db.ts', weight: 'heavy' }, { id: 88 }),
    ])
    app.type('打了一半的话')
    app.key({ kind: 'char', char: 'y' })
    app.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 1200 })])
    app.feed([
      event('tool.result', { call: 71, ok: true, output: { text: '写好了' } }),
      // 第二件：工具先落，再问（件数就是从这里数的）
      event('tool.call', { name: 'write', args: { path: 'README.md' } }, { id: 72 }),
      event('tool.decision.request', { call: 72, name: 'write', material: '目标 README.md', weight: 'light' }, { id: 89 }),
    ])

    const frame = app.screen()
    expect(frame).toContain('2 / 2')
    expect(frame).toMatchSnapshot()
  })
})

// ══ 场景 9–11（slash 两种走法）═══════════════════════════════════════

describe('场景 9 · `/session`（交互配置型）', () => {
  test('回车**不进记录区**，只在左下开选择器；列表带当前位与说明', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '记录查询优化' }])])
    app.type('/session')
    app.key(ENTER)
    app.feed([
      state(SESSION, [
        { id: SESSION, title: '记录查询优化' },
        { id: 's2', title: '修复时区处理…' },
        { id: 's3', title: '给 CI 加缓存' },
      ]),
    ])

    const frame = app.screen()
    expect(frame).toContain('记录查询优化')
    expect(frame).toContain('正在用')
    expect(frame).toContain('↑↓ 选')
    expect(frame).not.toContain('› /session') // 命令本身不进记录区
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 10 · `/model`（同一处、同一开合）', () => {
  test('列表报条目与模型名；回执留一行', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '修复时区处理…' }]),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
    ])
    app.type('/model')
    app.key(ENTER)
    app.feed([event('model.switched', { ok: false, reason: '不知道要换成什么——已注册：minimax' })])

    const frame = app.screen()
    expect(frame).toContain('minimax')
    expect(frame).toContain('已注册：minimax')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 11 · `/help`（纯输出型）', () => {
  test('输出进记录区（dim 块）；**命令本身不回显**', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '时区修正' }])])
    app.feed([event('model.switched', { ok: true, provider: 'minimax-m2', model: 'MiniMax-M2' })])
    app.type('/help')
    app.key(ENTER)

    const frame = app.screen()
    expect(frame).toContain('可用命令')
    expect(frame).toContain('/session')
    // **命令本身不回显**——记录区里没有 `› /help` 那一行（候选里的那条不算：
    // 它在左下交互区、不在记录区）
    const view = app.shell.getView()
    expect([...view.settled, ...view.rows].some((row) => row.kind === 'user')).toBe(false)
    expect(frame).toMatchSnapshot()
  })
})

// ══ 场景 12–14 ═══════════════════════════════════════════════════════

describe('场景 12 · 切换 / 恢复后——重建，且是收拢的', () => {
  test('条目重建出记录区；工具两条并一行；屏上痕迹不回', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '时区修正' }])])
    app.type('/help') // 先留一块屏上痕迹（输出）——重建**不该**把它带回来
    app.key(ENTER)

    const entries: readonly Entry[] = [
      { id: 1, kind: 'user', content: { text: '看看这个工作区里有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '我先列一下。' }, at: 1 },
      { id: 3, kind: 'tool-call', content: { text: '' }, payload: { name: 'ls', args: { path: '.' } }, at: 2 },
      { id: 4, kind: 'tool-result', content: { text: '14 项' }, payload: { ok: true, output: { text: '14 项' } }, at: 3 },
      { id: 5, kind: 'assistant', content: { text: '是个 Bun 工作区，packages 下六个包。' }, at: 4 },
    ]
    app.feed([event('session.history', { session: SESSION, entries, done: true })])

    const frame = app.screen()
    expect(frame).toContain('看看这个工作区里有什么')
    expect(frame).toContain('●') // 工具标记（第 21 轮起＝`●`）
    expect(frame).toContain('14 项')
    expect(frame).not.toContain('可用命令') // 屏上痕迹不回
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 13 · 退避重试', () => {
  test('状态词换 `● 正在重试 2/3`，右位报「几秒后重发」；输入行说实话', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '时区修正' }]),
      event('turn.start', {}),
      event('model.retry', { attempt: 2, delayMs: 1600, tier: 'transient' }),
    ])

    const frame = app.screen()
    expect(frame).toContain('● 正在重试 2/3')
    expect(frame).toContain('1.6s')
    expect(frame).toContain('不用管')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 14 · 窄窗口降级', () => {
  test('从右往左省（用量 → 模型 → 标题截断）；**省了不改剩余字段的位置**', () => {
    const app = live()
    historyShown(app)

    const frame = app.screen(46, 14)
    expect(frame).toContain('○ 空闲') // ① 状态**永不省**（视觉锚）
    expect(frame).toMatchSnapshot()
  })
})

// ══ 补：收拢 · 视口 · 行标记（原型规格的细节判据）════════════════════

describe('规格细节（渲染层）', () => {
  test('**收拢**：更早的组并成一行摘要，最近一组逐条展开（原型 · 场景 12）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '时区修正' }])])

    const tool = (id: number, name: string): readonly Entry[] => [
      { id, kind: 'tool-call', content: { text: '' }, payload: { name, args: {} }, at: id },
      { id: id + 1, kind: 'tool-result', content: { text: '成' }, payload: { ok: true, output: { text: '成' } }, at: id },
    ]

    app.feed([
      event('session.history', {
        session: SESSION,
        entries: [
          { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
          ...tool(10, 'ls'),
          ...tool(20, 'read'),
          ...tool(30, 'grep'),
          { id: 40, kind: 'user', content: { text: '再看看' }, at: 40 },
          ...tool(50, 'write'),
        ],
        done: true,
      }),
    ])

    const frame = app.screen()
    expect(frame).toContain('3 次工具调用')
    expect(frame).toContain('（ls · read · grep）')
    expect(frame).toContain('write') // 最近一组仍逐条
    expect(frame).toMatchSnapshot()
  })

  test('视口——记录区只渲染**视口内**的行（铺满窗口＝滚动归我们）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '长会话' }])])
    app.feed([
      event('session.history', {
        session: SESSION,
        entries: Array.from({ length: 40 }, (_unused, index) => ({
          id: index + 1,
          kind: 'user' as const,
          content: { text: `第 ${index + 1} 句` },
          at: index,
        })),
        done: true,
      }),
    ])

    // 内联模式下「视口」换了机制：**已定局的行走 `Static`**（终端自己滚），
    // 活动区只放本轮那些——故这里验的是**分侧**，不再是「裁掉开头」
    const view = app.shell.getView()
    expect(view.settled.length).toBe(40)
    expect(view.rows).toHaveLength(0)
  })

  test('行标记与着色——用户行整行背景、工具跑起来换 `⟳`', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }])])
    app.type('跑一下')
    app.key(ENTER)
    app.feed([event('turn.start', {}), event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 })])

    const lines = logLines(app.shell.getView().rows, { columns: 100, expanded: false })
    const user = lines.find((line) => line.segments.some((piece) => piece.text.includes('跑一下')))
    expect(user?.background).toBe('#131d23') // 整行淡青背景
    expect(lines.some((line) => line.segments.some((piece) => piece.text.startsWith('⟳')))).toBe(true)
  })

  test('`ctrl+o` 展开——思考从一行变全文，工具结果行跟着出来', () => {
    const app = live()
    app.feed([
      event('model.delta', { channel: 'thinking', text: '第一行\n第二行\n第三行' }),
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'a.txt\nb.txt' } }),
    ])

    const collapsed = logLines(app.shell.getView().rows, { columns: 100, expanded: false })
    const expanded = logLines(app.shell.getView().rows, { columns: 100, expanded: true })

    expect(collapsed.some((line) => line.segments.some((piece) => piece.text.includes('第二行')))).toBe(false)
    expect(expanded.some((line) => line.segments.some((piece) => piece.text.includes('第二行')))).toBe(true)
    expect(expanded.some((line) => line.segments.some((piece) => piece.text.includes('b.txt')))).toBe(true)
  })
})


// ══ 场景 11 · slash 自动补全（D12）═══════════════════════════════════

describe('场景 11 · slash 自动补全', () => {
  test('打 `/s` —— 候选列在输入行**上方**，`/session` 与 `/status` 在前（按匹配度）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '记录查询优化' }])])

    app.type('/s')

    const frame = app.screen()
    expect(frame).toContain('/session')
    expect(frame).toContain('/status')
    expect(frame).toContain('↑↓ 选 · Tab 补全 · esc 收起')
    // 候选在输入行**上方**——输入行是**最后**那条 `› …`（候选行也以 `› ` 起头并且含 `/s`）
    expect(frame.indexOf('/session')).toBeLessThan(frame.lastIndexOf('› /s'))
    expect(frame).toMatchSnapshot()
  })

  test('只列**真存在**的命令——`/grants` 内核还没有，不列', () => {
    const app = live()

    app.type('/g')

    const frame = app.screen()
    expect(frame).not.toContain('/grants')
  })

  test('`Tab` 补全 —— 选中那条落进草稿（留一个空格等参数）；`esc` 收起候选', () => {
    const app = live()

    app.type('/sess')
    app.key({ kind: 'tab' })
    expect(app.shell.getView().draft).toBe('/session ')

    app.key({ kind: 'ctrl+c' }) // 收摊前把草稿清了（下面另起一段输入）
    app.shell.key({ kind: 'escape' })
    app.type('/se')
    expect(app.shell.getView().completion).not.toBeNull()
    app.key({ kind: 'escape' })
    expect(app.shell.getView().completion).toBeNull()
    expect(app.shell.getView().draft).toBe('/se') // 草稿留着
  })
})

// ══ 密度 ＋ D11 护栏 ═════════════════════════════════════════════════

describe('密度（原型 · 密度节）', () => {
  test('条目之间**不插空行**；只有用户消息之前留一行分段', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }])])
    app.type('跑一下')
    app.key(ENTER)
    app.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '好。' }),
      event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'a.txt' } }),
    ])

    const lines = logLines(app.shell.getView().rows, { columns: 100, expanded: false })
    const spacers = lines.filter((line) => line.spacer === true).length

    expect(spacers).toBe(0) // 首条用户消息之前不必分段（顶上没有东西）
    // 分段行只出现在**用户消息之前**：拿一个带两条用户消息的行列来验
    const withTwo = [
      { kind: 'user' as const, key: 'u1', text: '甲', echoed: false },
      { kind: 'assistant' as const, key: 'a1', text: '嗯' },
      { kind: 'user' as const, key: 'u2', text: '乙', echoed: false },
    ]
    const spaced = logLines(withTwo, { columns: 100, expanded: false })
    const at = spaced.findIndex((line) => line.spacer === true)

    expect(spaced.filter((line) => line.spacer === true)).toHaveLength(1) // 只有乙之前那一条
    expect(at).toBeGreaterThan(0) // 不在开头（甲之前不必分）
    expect(spaced[at]?.segments.length).toBe(0) // 就是那一条空行
  })

  test('**空内容不渲染**（D6 的外壳侧重保险）——只发工具调用的那一轮不产生行', () => {
    const app = live()
    app.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '   ' }), // 只有空白
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
    ])

    const lines = logLines(app.shell.getView().rows, { columns: 100, expanded: false })
    expect(lines.some((line) => line.segments.some((piece) => piece.text.includes('⏺')))).toBe(false)
  })
})

describe('D11 护栏（内联渲染的重复）', () => {
  test('**一行一个 `<Text>`、行内不写换行**——行数就是行数（多写换行＝重绘擦不干净）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }])])
    app.type('看看有什么')
    app.key(ENTER)
    app.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '列一下。' }),
    ])

    const rows = app.shell.getView().rows
    const lines = logLines(rows, { columns: 100, expanded: false })

    // 渲染出来的行数 = 纯函数算出来的行数（不再多一倍）
    const frame = app.screen(100, 30)
    const body = frame.split('\n').filter((line) => line.trim() !== '')
    expect(body.filter((line) => line.includes('列一下。')).length).toBe(1)
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe('slash 候选（D12 · 纯函数级）', () => {
  test('`/g` —— 一条候选都不出（`/grants` 内核还没有）', async () => {
    const { matchCommands } = await import('../src/view.ts')

    expect(matchCommands('/g')).toEqual([])
    expect(matchCommands('/s').map((row) => row.name)).toEqual(['/session', '/status'])
    expect(matchCommands('/').map((row) => row.name)).toHaveLength(4) // 全列（真存在的四条）
    expect(matchCommands('看下目录')).toEqual([]) // 不是 slash——不出候选
  })
})

// ══ D13 · 活动区/定局区的「同一段画两遍」（第 22 轮）══════════════════

describe('D13 · 首行不吞换行（正文以 `\\n\\n` 开头那一形）', () => {
  test('正文以两个换行开头——**渲染成一行**（不是首行自己展开 ＋ 续行再画一遍）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }])])
    app.type('只回四个字')
    app.key(ENTER)
    app.feed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '\n\n甲乙丙丁' }),
    ])

    const lines = logLines(app.shell.getView().rows, { columns: 96, expanded: false })
    const reply = lines.filter((line) => line.segments.some((piece) => piece.text.includes('甲乙丙丁')))

    // 只有一条显示行带正文；且它同时带标记（首行＝`⏺ ` ＋ 正文）
    expect(reply).toHaveLength(1)
    expect(reply[0]?.segments.map((piece) => piece.text).join('')).toBe('⏺ 甲乙丙丁')
    // 首尾的空行**不渲染**（密度）
    expect(lines.some((line) => line.segments.every((piece) => piece.text.trim() === ''))).toBe(false)
  })

  test('正文中间的换行照旧折行（首尾才去空）', () => {
    const app = live()
    app.feed([event('model.delta', { channel: 'text', text: '第一段\n\n第二段' })])

    const lines = logLines(app.shell.getView().rows, { columns: 96, expanded: false })
    const texts = lines.map((line) => line.segments.map((piece) => piece.text).join(''))

    expect(texts[0]).toBe('⏺ 第一段')
    expect(texts.some((line) => line.includes('第二段'))).toBe(true)
  })
})
