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
import type { LogLine } from '../src/components/log.ts'
import { createShell } from '../src/shell.ts'
import type { ShellKey } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain } from './screen.ts'

const COLUMNS = 100
const ROWS = 30

/**
 * 取景——一屏渲染成字符串（同一条链，只有最后一跳是纯函数）。
 *
 * ## ⚠️ 2026-09-20：这 16 张快照**全都变了**——两处改动，逐条记在这儿（不是默默重录）
 *
 * **① 启动字标（TUI Banner）进了记录区最前面**（`spec.banner.test.ts` 是它的判据）
 * - **原锚**：一屏的第一行就是内容（`› …` / `⏺ …` / 空态那句），记录区顶上没有别的东西。
 * - **为何变**：字标启动印一次、恒在 `settled[0]`（设计：记录区的最前面 · 内联随内容滚动）。
 *   于是每张快照**头上多出字标那几行**——本文件取景在 100 列 ⇒ **块字版 5 行**
 *   （场景 14 取 46 列 ⇒ **一行版** `Magic Code`）；另外**首条用户消息之前多了一行分段**
 *   （`needsSpacer` 的老由头是「顶上没有东西要分隔」，现在顶上有字标了）。
 * - **新锚**：每张的头 5 行是 `  ` ＋ 53 列块字画幅（`src/banner.ts` 的 `BANNER_WIDE`），
 *   其后与原先逐字相同，只在首条用户消息之前多一个空行。
 *
 * **② 空态里那段用法提示去掉了**（用户 2026-09-20：「会有一些用法的提示文字 这个似乎不太需要
 * 直接去掉吧」）
 * - **原锚**：原型 · 场景 1 的原文——一句说明 ＋ 空行 ＋ `比如：` ＋ 三条示例。
 * - **为何变**：用户要去掉**用法提示**那一段。留下的那句讲的是**产品行为**（会话何时建立），
 *   不是「你该怎么操作」，故照他给的分寸留着（见 `EmptyState` 的注）。
 * - **新锚**：空态只剩那一句（`交代一件事就开始。…`）。**只有场景 1 那张动**。
 *
 * ⚠️ **②与 `界面原型.html` 差这一处**——那几行一直标着「原型 · 场景 1 的原文」，
 * 删它们**等于改规格**；此处照用户的话改代码，差异备案在回报里。
 *
 * **③ 输入行的光标挪到占位**之前**（用户 2026-09-20：「输入区域的光标位置 目前是在灰色的
 * 提示文本后面……这段提示文本允许保留 但光标不应该在提示文本后面」）
 * - **原锚**：`› ` → 占位（灰字）→ 光标 ⇒ 帧上 `› 交代一件事，回车发送`。
 * - **为何变**：光标压在灰字之后读起来像「要从这句说明后面接着打」；占位留着，
 *   落点挪到**开始打字的位置**（见 `composer.ts` 里 `cursor` 那条注）。
 * - **新锚**：`› ` → 光标 → 占位 ⇒ 帧上 `› ` 与占位之间**多一个空格**（光标那一格）。
 *   **有草稿那一路不动**（光标仍在末尾——那是正在打的地方）。
 *
 * ⚠️ **挪的只是「画出来那个」**（`inverse` 空格）：**真终端的光标不在这一处、也不随它走**——
 * 本仓没用 Ink 的 `useCursor()`，真光标停在整帧之下（实测见 `composer.ts` 那条注）。
 *
 * **④ 字标落进界面的位置与间距（首屏布局收口 · 2026-09-20）**——规格出处：`界面原型.html`
 * 场景 1 新落的 `.banner{padding-left:2ch;margin:0 0 17px}` 与那段注。用户当场的批评：
 * 「真就直接硬放一个 banner 呗 一点布局设计都没有的那种」（顶格贴左上角 ＋ 紧挨着引导语）。
 * - **原锚**：一屏从字标**第 1 行**开始（顶上不空行）；画幅之后紧跟内容
 *   （空态那一屏＝引导语直接贴着字标末行）；**首条用户消息之前那一行分段**由 `needsSpacer` 给；
 *   一行版（场景 14 · 46 列）**贴在最左边**。
 * - **为何变**：字标**自成一块**——**前后各一行留白**（`components/log.ts` 的
 *   `BANNER_GAP_TOP` / `BANNER_GAP_BOTTOM`），它与引导语是两种东西（品牌 vs 空态提示）；
 *   一行版**同样缩 2 列**（`BANNER_INDENT`：同一块东西，退让时别换性格）。
 * - **新锚**：每张快照**头上多一行空白**（前留白）；场景 1 那张在画幅与引导语之间**多一行空白**
 *   （后留白）；场景 14 那张从 `Magic Code` 变成 `  Magic Code`。
 *   ⚠️ **其余逐字未动**：后留白把「首条用户消息之前那一行」**顶掉**了（`needsSpacerAfter`），
 *   故有内容的那几张**只多头上那一行**——不是又多一行、也没少一行。
 *
 * **⑤ 空态引导语再去掉开头半句（用户 2026-09-20 看真机帧时指出：重复叙述）**
 * - **原锚**：`交代一件事就开始。会话在你按下第一次回车时才建立。`
 * - **为何变**：同一屏上、**隔着一行**，输入框占位正是「交代一件事，回车发送」——
 *   引导语以同一个词起头＝**把占位又说了一遍**。用户：「交代一件事 看了图没发现这句话是重复叙述？」
 *   那半句是废话（占位已经说了），留下的是**用户不知道的信息**（会话建立于何时）。
 * - **新锚**：`会话在你按下第一次回车时才建立。`。**只有场景 1 那张动**（其余屏不显示空态）。
 *
 * ⚠️ **这条的教训**（规划侧自陈·照记）：上一轮**只看了布局没读话** ⇒ 漏了。
 * 「从上到下一行行通读」是这一屏的验收动作，光量缩进与留白量不出重复叙述。
 *
 * ⚠️ **先归一化**（`plain`——剥掉 ANSI）：这一层量的是**文字与布局**，而色是**环境**给的
 * （Ink 经 `chalk`，档位看 `FORCE_COLOR` / TTY）。不剥就是**缺陷 D17**：同一个仓、同一份代码，
 * 换个 shell（设了 `FORCE_COLOR` 的工具链 / CI / IDE 集成终端）**21 例当场全红**——
 * 快照对不上色码、`toContain` 的子串被色码从中间断开。**红得没有信息量，只会训练人忽略红。**
 */
function screen(shell: ReturnType<typeof createShell>, columns = COLUMNS, rows = ROWS): string {
  return plain(renderToString(h(AppView, { view: shell.getView(), columns, rows }), { columns }))
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

/**
 * `ls .` 的一条真实结果——**一行一项**（14 项）。
 *
 * 为什么不用一句 `'14 项'` 当夹具（原先是那样）：那是把**摘要**当成了**结果**。
 * 摘要现在按形态自己算（一行一项 ⇒ `14 项`），夹具得给**真的结果**，
 * 否则算出来的是「1 项」——那才是把假的当真的。
 */
const LS_OUTPUT = [
  'README.md  (1204 字节)',
  'bun.lock  (19744 字节)',
  'package.json  (456 字节)',
  'packages/',
  'docs/',
  'src/',
  'test/',
  'scripts/',
  'tsconfig.json  (571 字节)',
  'bunfig.toml  (237 字节)',
  'LICENSE  (1063 字节)',
  'CHANGELOG.md  (2201 字节)',
  '.gitignore  (192 字节)',
  '.githooks/',
].join('\n')

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
    // `ls .` 的真实结果形态（一行一项）——14 项（原型 · 场景 2 画的 `✓ 0.2s · 14 项` 就是这个数）
    // 落地事件给**显式 id**：`at` 也随之固定（`TEST_AT + id`），耗时才是确定的 200ms——
    // 让 id 自动递增的话，钟随**别的用例跑没跑过**变，快照就成了掷骰子。
    event('tool.result', { call: 71, ok: true, output: { text: LS_OUTPUT } }, { id: 271 }),
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
    // ⚠️ 空态那句 2026-09-20 又短了一截（去掉开头的「交代一件事就开始」，见下面第 ⑤ 段）——
    //    这里钉的是「**会话什么时候建立**那句话在不在」，故只钉留下的那半句
    expect(frame).toContain('会话在你按下第一次回车时才建立')
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
  // ⚠️ 2026-09-19（U20）**标题收窄过**：原先叫「标记换 `⟳` ＋ 运行中（**不编秒数**）」。
  //    - **原锚**：那时这句其实是在给一个**局限**立碑——「真秒表要一个 ticker，归后续」，
  //      而 `⟳ 0.6s` 正是原型场景 3 画的那一形（`● read src/utils/date.ts` / `⟳ 0.6s`）；
  //    - **规格为什么变**：U20 把钟补上了（`TuiApp` 按需滴答 → `AppView` 的 `now`）；
  //    - **新锚**：钟给得出就报**真耗时**（`差距 3` 那两条用例钉它），**给不出才回退**「运行中」
  //      ——这一条（`renderToString` 那条路，没有钟）钉的是后半句。**不编**这条规矩没变，
  //      变的是「真量得出来的时候，量出来的可以上屏」。
  test('工具在跑——标记换 `⟳`；**没有钟**就回退「运行中」（不编秒数）；输入行说实话；右位报中断', () => {
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
      event('tool.result', { call: 71, ok: true, output: { text: '写好了' } }, { id: 271 }),
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
    // **U26 起多一行分组头**：目录按工作区分组（本夹具的会话**没有归属**——列加上之前
    // 落账的那种——故头如实说「未记录」）。分组那一族的判据在 `session-workspace.test.ts`。
    expect(frame).toContain('（工作区未记录）')
    expect(frame).toMatchSnapshot()
  })
})

describe('场景 10 · `/model`（同一处、同一开合）', () => {
  test('列表报条目与模型名（**全量**）；开选择器本身**不进记录区**', () => {
    const app = live()
    app.feed([
      state(SESSION, [{ id: SESSION, title: '修复时区处理…' }]),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
    ])
    app.type('/model')
    app.key(ENTER)
    // ⚠️ 本条 2026-09-19 改过（阶段 3 批 2 · 接 D10 的读数）——开选择器的那条答复换了：
    //    原先是「空参 `model.switch` 的失败缘由」（列表就着那句缘由拼）、现在是 D10 的
    //    **读侧答复 `model.catalog`**（注册表全量）。规格变的是**入口那条链**，
    //    「列表报条目与模型名」这句本身没变。
    app.feed([
      event('model.catalog', {
        entries: [
          { provider: 'minimax', model: 'MiniMax-M3' },
          { provider: 'minimax-m2', model: 'MiniMax-M2' },
        ],
        current: { provider: 'minimax', model: 'MiniMax-M3' },
      }),
    ])

    const settled = [...app.shell.getView().settled, ...app.shell.getView().rows]

    // **开的这一刻什么都不进记录区**（原型 · slash 两种走法：交互配置型「回车什么都不进」；
    // 「留一行回执」是**选定之后**的事）——旧形状在这里留过一行「换模型未成：…」的假回执
    expect(settled.some((row) => row.kind === 'receipt')).toBe(false)
    expect(settled.some((row) => row.kind === 'output')).toBe(false)

    const frame = app.screen()
    expect(frame).toContain('minimax')
    // **全量**：注册表里另一条也在（这趟会话从没调用过它）
    expect(frame).toContain('minimax-m2')
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
      { id: 4, kind: 'tool-result', content: { text: LS_OUTPUT }, payload: { ok: true, output: { text: LS_OUTPUT } }, at: 3 },
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
  /**
   * ⚠️ **本条 2026-09-19 改过**（缺陷轮 VI）——原来的期待值钉的是**当时的输出**
   * （「只展开最近一组」＋「单次的组也收」），那条判据**没有规格依据**：
   * 原型场景 12 只画了「更早的一组收成摘要」，从没定过「收几组 / 多大的组才收」。
   *
   * - **规格为什么变**——D18：① 单次调用收进摘要占同样一行、却把参数丢了（收拢是为了省行，
   *   1 次收是**净损失**）；②「只展开最近一组」在长会话恢复时＝**几乎全灰**。
   * - **新规格**——`collapseToolGroups` 的两条判据：**≥2 次才收** ＋ **末尾 `RECENT_GROUPS` 组不收**。
   *   数据因此要**够长**（七组）才看得见收拢——这正是判据本身要求的。
   */
  test('**收拢**：更早的组并成一行摘要，**末尾五组**逐条展开（原型 · 场景 12 ＋ 缺陷 D18）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '时区修正' }])])

    const tool = (id: number, name: string): readonly Entry[] => [
      { id, kind: 'tool-call', content: { text: '' }, payload: { name, args: {} }, at: id },
      { id: id + 1, kind: 'tool-result', content: { text: '成' }, payload: { ok: true, output: { text: '成' } }, at: id },
    ]
    const say = (id: number, text: string): Entry => ({ id, kind: 'assistant', content: { text }, at: id })

    app.feed([
      event('session.history', {
        session: SESSION,
        entries: [
          { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
          ...tool(10, 'ls'),
          ...tool(20, 'read'),
          ...tool(30, 'grep'),
          say(40, '看完了。'),
          ...tool(50, 'write'),
          ...tool(60, 'edit'),
          say(70, '改完了。'),
          ...tool(80, 'ls'),
          say(90, '再看。'),
          ...tool(100, 'ls'),
          say(110, '继续。'),
          ...tool(120, 'ls'),
          say(130, '继续。'),
          ...tool(140, 'ls'),
          say(150, '继续。'),
          ...tool(160, 'cat'),
          say(170, '完了。'),
        ],
        done: true,
      }),
    ])

    const frame = app.screen()

    // 更早的两组（都在末尾五组**之外**，且都 ≥2 次）并成一行摘要
    expect(frame).toContain('3 次工具调用（ls · read · grep）')
    expect(frame).toContain('2 次工具调用（write · edit）')
    // **单次调用不收**（D18①）——`● 1 次工具调用（ls）` 那种行不该出现
    expect(frame).not.toContain('1 次工具调用')
    // 末尾五组逐条展开（含最后那组单发的 `cat`）
    expect(frame).toContain('● ls {}')
    expect(frame).toContain('● cat {}')
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
    // ⚠️ **原锚** `toBe(40)`——那 40 条就是重建出来的会话内容。
    //    **为何变**：启动字标（TUI Banner）现在恒在 `settled[0]`（启动印一次）。
    //    **新锚** `toBe(41)`＝那 40 条 ＋ 字标那一行（**本句钉的「40 条内容全在」没变**）。
    expect(view.settled.length).toBe(41)
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
      event('tool.result', { call: 71, ok: true, output: { text: 'a.txt\nb.txt' } }, { id: 271 }),
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

  /**
   * 只列**真存在**的命令（原型 · 场景 11 的自律）。
   *
   * ⚠️ **原锚是 `/grants`「内核还没有，故不列」**——`U22` 到站后它有了（授权名录
   * 走 `grants.list`），于是这一条**翻面**：候选里**应当**有它。
   * 「表里列的都得真认得」那半条改由 `shell.test.ts` 的遍历用例钉（更强，且不用手改）。
   */
  test('真存在的命令照列——`/g` 出 `/grants`（U22 到站后它真有了）', () => {
    const app = live()

    app.type('/g')

    expect(app.screen()).toContain('/grants')
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
      event('tool.result', { call: 71, ok: true, output: { text: 'a.txt' } }, { id: 271 }),
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

// ══ D14 · 助手正文渲染 Markdown（缺陷轮 V）══════════════════════════════

describe('D14 · 记录区渲染 Markdown', () => {
  /** 助手正文喂进真链路 → 取**屏上会是什么**（显示行）。 */
  const bodyOf = (text: string, columns = 96): readonly LogLine[] => {
    const app = live()
    app.feed([event('model.delta', { channel: 'text', text })])

    return logLines(app.shell.getView().rows, { columns, expanded: false })
  }

  const textsOf = (lines: readonly LogLine[]): readonly string[] =>
    lines.map((line) => line.segments.map((piece) => piece.text).join(''))

  test('**粗体** 与 `行内代码`——标记不上屏；代码换色、**不换背景**', () => {
    const lines = bodyOf('这是 **Magic Code** 的 `验收脚本`')
    const texts = textsOf(lines)

    expect(texts).toEqual(['⏺ 这是 Magic Code 的 验收脚本'])
    expect(texts.join('')).not.toContain('**')
    expect(texts.join('')).not.toContain('`')

    const bold = lines[0]?.segments.find((piece) => piece.text === 'Magic Code')
    const code = lines[0]?.segments.find((piece) => piece.text === '验收脚本')

    expect(bold?.bold).toBe(true) // 加粗
    expect(code?.color).toBeDefined() // 换色
    expect(lines[0]?.background).toBeUndefined() // 不换背景（省行高）
  })

  test('代码块 / 列表 / 标题——**围栏与 `#` 不上屏**，符号留着', () => {
    const texts = textsOf(bodyOf('## 这一段在说什么\n\n```ts\nconst a = 1\n```\n\n- 第一条\n1. 有序'))

    // 钉的规格＝**D14 五样**（围栏与 `#` 不见、列表符号原样留着）
    // ＋ **D20 统一悬挂**（正文与所有折行都从第 3 列起 ⇒ 非首行前面那两格基线；
    //    markdown 自己的缩进——代码块 2 列、列表符号——**叠在基线上**）。
    expect(texts).toEqual(['⏺ 这一段在说什么', '  ', '    const a = 1', '  ', '  - 第一条', '  1. 有序'])
    expect(texts.join('\n')).not.toContain('```')
    expect(texts.join('\n')).not.toContain('#')
  })

  test('`⏺ ` **只挂首行**；续行按各行的悬挂缩进挂（列表挂到符号之后）', () => {
    const texts = textsOf(bodyOf(`1. ${'甲'.repeat(20)}`, 30))

    expect(texts.filter((line) => line.includes('⏺'))).toHaveLength(1) // 只有首行有标记
    expect(texts).toHaveLength(2)
    expect(texts[0]?.startsWith('⏺ 1. 甲')).toBe(true)
    // D20：助手基线 2 列 ＋ 列表「按标记宽度」（`1. ` ＝ 3 列）⇒ 续行从第 6 列起。
    expect(texts[1]?.startsWith('     ')).toBe(true)
    expect(texts[1]?.startsWith('      ')).toBe(false)
  })

  test('**流式中间帧**——未闭合的 `**` / 反引号 / 围栏**先按字面**（不闪不跳）', () => {
    // 「未闭合的先按字面」是 D14 定死的那条细节（**现在还钉它**）；
    // 非首行的两格基线归 D20。
    expect(textsOf(bodyOf('这是 **Magic Co'))).toEqual(['⏺ 这是 **Magic Co'])
    expect(textsOf(bodyOf('跑 `m02-real'))).toEqual(['⏺ 跑 `m02-real'])
    expect(textsOf(bodyOf('```ts\nconst a = 1'))).toEqual(['⏺ ```ts', '  const a = 1'])
  })

  test('**整屏取景**——帧上见不到 `**` 与反引号（D14 的现象本身）', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '验收' }])])
    app.feed([
      event('model.delta', {
        channel: 'text',
        text: '**重点**：跑 `bun test`\n\n```sh\nbun test\n```',
      }),
    ])

    const frame = app.screen()

    expect(frame).toContain('重点：跑 bun test')
    expect(frame).not.toContain('**')
    expect(frame).not.toContain('`')
    expect(frame).not.toContain('#')
  })
})

// ══ D18 · D19 · D20（缺陷轮 VI）═══════════════════════════════════════
//
// 这三条的**正向判据**——每条指着一句规格，不是「现在跑出来什么」：
// - **D18**：`collapseToolGroups` 的两条判据（**≥2 次才收** · **末尾 `RECENT_GROUPS` 组不收**）
// - **D19**：正文**内部**的段落空行是内容，**一条不删**（「首尾裁、中间留」）
// - **D20**：**统一悬挂**——首行标记占 N 列 ⇒ **正文与所有折行都从第 N+1 列起**

describe('D18 / D19 / D20（缺陷轮 VI）', () => {
  const bodyOf = (text: string, columns = 96): readonly LogLine[] => {
    const app = live()
    app.feed([event('model.delta', { channel: 'text', text })])

    return logLines(app.shell.getView().rows, { columns, expanded: false })
  }

  const textsOf = (lines: readonly LogLine[]): readonly string[] =>
    lines.map((line) => line.segments.map((piece) => piece.text).join(''))

  test('D18① · **单次调用的组不收**——摘要占同样一行，还把参数丢了', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲' }])])

    const call = (id: number, name: string, args: Readonly<Record<string, unknown>>): readonly Entry[] => [
      { id, kind: 'tool-call', content: { text: '' }, payload: { name, args }, at: id },
      { id: id + 1, kind: 'tool-result', content: { text: '成' }, payload: { ok: true, output: { text: '成' } }, at: id },
    ]

    app.feed([
      event('session.history', {
        session: SESSION,
        entries: [
          { id: 1, kind: 'user', content: { text: '看看' }, at: 0 },
          ...call(10, 'ls', { path: '.' }),
          { id: 30, kind: 'user', content: { text: '再来' }, at: 30 },
          ...call(40, 'grep', { q: 'x' }),
        ],
        done: true,
      }),
    ])

    const frame = app.screen()
    expect(frame).not.toContain('次工具调用') // 两组都是单次 ⇒ **一组都不收**
    expect(frame).toContain('● grep') // 参数留在屏上
  })

  test('D20 · 助手正文**每一个非首行**都从第 3 列起', () => {
    expect(textsOf(bodyOf('第一行\n第二行\n第三行'))).toEqual(['⏺ 第一行', '  第二行', '  第三行'])
  })

  test('D20 · 用户消息的折行同样悬挂（`› ` 也占 2 列）', () => {
    const lines = logLines([{ kind: 'user', key: 'u', text: '第一行\n第二行', echoed: false }], {
      columns: 96,
      expanded: false,
    })

    expect(textsOf(lines)).toEqual(['› 第一行', '  第二行'])
  })

  test('D20 · 代码块挂在基线上（基线 2 ＋ 它自己的缩进 2）', () => {
    expect(textsOf(bodyOf('看：\n\n```\nx\n```'))).toEqual(['⏺ 看：', '  ', '    x'])
  })

  test('D19 · 正文**内部**的段落空行一条不删（「首尾裁、中间留」）', () => {
    expect(textsOf(bodyOf('甲\n\n乙\n\n丙'))).toEqual(['⏺ 甲', '  ', '  乙', '  ', '  丙'])
  })

  test('D19 · 段落空行**在屏上真的占一行**（走真 Ink，不是纯函数）', () => {
    const app = live()
    app.feed([event('model.delta', { channel: 'text', text: '甲\n\n乙' })])

    const lines = app.screen().split('\n')

    // ⚠️ **原锚**：`lines[0]` / `lines[1]` / `lines[2]`——那时记录区第一行就是正文。
    //    **为何变**：启动字标占了记录区最前面那几行（见 `screen()` 的注）。
    //    **新锚**：**从正文那一行起**往下数——不数死偏移，字标占几行（随宽度变）都不影响这条。
    const at = lines.indexOf('⏺ 甲')
    expect(at).toBeGreaterThanOrEqual(0)
    expect(lines[at + 1]?.trim()).toBe('') // 空行**在**
    expect(lines[at + 2]).toBe('  乙')
  })

  test('**分段行**（用户消息之前那一行）真的占一行——空段那条路的哨兵（原型 · 密度）', () => {
    // ⚠️ 这条钉的是 **Ink 那一跳**：`line.segments` 为空的行只有「分段」这一种，
    // 而 **Ink 7 会把内容为空串的 `<Text>` 整行丢掉**（D19 的根因，`LogRowView` 里修的）。
    // 倒回 `['']` ⇒ 这条当场红（段落空行那条测不出来——D20 的基线让它带上了色段）。
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲' }])])
    app.type('甲')
    app.key(ENTER)
    app.feed([event('model.delta', { channel: 'text', text: '嗯' })])
    app.type('乙')
    app.key(ENTER)

    const lines = app.screen().split('\n')

    // ⚠️ **原锚** `toHaveLength(1)`——「两条用户消息 ⇒ 第二条之前那一行分段」。
    //    **为何变（一）**：字标现在恒在记录区最前面（`settled[0]`）⇒ **首条用户消息之上也有东西了**，
    //    它之前那行分段照同一条规矩也够格（`needsSpacer`：只有用户消息之前留一行分段）⇒ 2 条。
    //    **为何变（二）**：2026-09-20「首屏布局收口」——字标**自成一块**，自己带**前后各一行留白**
    //    （`components/log.ts` 的 `BANNER_GAP_TOP` / `BANNER_GAP_BOTTOM`）⇒ 顶上多一行；
    //    而紧随其后的首条用户消息**不再叠**它自己那条分段（`needsSpacerAfter`）⇒ 后留白
    //    与原来那条分段是同一行，不多不少。
    //    **新锚**：3 条＝**前留白 ＋ 首条用户消息那条分段（＝后留白）＋ 第二条用户消息之前那条**。
    //    这条钉的东西没变——**分段真的占一行**（不是只算出来）——变的是**有几条**。
    //    ⚠️ 字标画幅那 5 行不在此列（那不是空行）。
    expect(lines.filter((line) => line.trim() === '')).toHaveLength(3)
  })

  test('D19 · 首尾的空行仍然不渲染（那是模型的格式噪声）', () => {
    expect(textsOf(bodyOf('\n\n甲乙\n\n'))).toEqual(['⏺ 甲乙'])
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
  /**
   * ⚠️ **原锚**：`/g` 一条候选都不出（那会儿 `/grants` 内核还没有）。
   * **为何变**：`U22` 到站——`/grants` 进了命令表，`/g` 前缀命中它（打分 3）。
   * **新锚**：`/g` → `/grants`；全表由四条变五条。`/s` 一栏照旧考**匹配度**（前缀在前），
   * 只是 `/grants` 作为**子序列**（`/`…`s`）也进了这一列——排在那两条前缀命中的后面。
   */
  test('`/g` —— 出 `/grants`（它现在真存在）', async () => {
    const { matchCommands } = await import('../src/view.ts')

    expect(matchCommands('/g').map((row) => row.name)).toEqual(['/grants'])
    expect(matchCommands('/s').map((row) => row.name)).toEqual(['/session', '/status', '/grants'])
    expect(matchCommands('/').map((row) => row.name)).toHaveLength(5) // 全列（真存在的五条）
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
