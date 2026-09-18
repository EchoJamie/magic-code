/**
 * 规格即测试 · **U20 显示打磨**——用户列的五个差距，逐条落成屏上用例。
 *
 * 出处：`对表.md`·阶段 3「差距清单（用户 2026-09-19）」＋ B7/B8/B9（首站的限度）＋
 * `技术方案.md`·接入「TUI 显示工程」（工具输出渲染是主战场）＋ `界面原型.html`（键盘表 · 场景 2/3）。
 *
 * | # | 差距（用户原话） | 用例在哪 |
 * | --- | --- | --- |
 * | 1 | diff 审阅——改了文件，你看不到改了什么 | `差距 1` |
 * | 2 | 工具输出渲染——只有原始文本 | `差距 2` |
 * | 3 | 进度感——长任务看不出做到哪一步 | `差距 3` |
 * | 4 | 输入框骨架级——无历史 / 多行 / 补全 | `差距 4` |
 * | 5 | 上下文窗口进度（`12.4k/200k`） | `差距 5` |
 *
 * 取景与判据沿用 U24 那一套（真链路 → 真终端 → 读屏与读格）：`createStage()` 起壳，
 * `stage.screen()` 取屏，`frame.cellsOf()` 读每一格的色。**不造 DSL**，判据仍是 `expect`。
 */

import { describe, expect, test } from 'bun:test'
import { TEST_AT, event } from './events.ts'
import { createStage } from './screen.ts'
import type { Frame, Stage } from './screen.ts'

const WIDE = { columns: 80, rows: 24 } as const

/** 起一个壳，并投一条会话状态（② 有标题——多数用例的底子）。 */
function live(): Stage {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一行的第 `col` 格——行找不到会当场抛（带整屏）。 */
function cellAt(frame: Frame, needle: string, col: number): ReturnType<Frame['cellsOf']>[number] | undefined {
  return frame.cellsOf(frame.rowOf(needle))[col]
}

/** 一行的**正文**（跳过 4 列缩进）——diff 块用它量色。 */
function bodyOf(frame: Frame, needle: string) {
  return frame.cellsOf(frame.rowOf(needle)).slice(4)
}

/**
 * 结果行的**摘要**那半句（`✓ 328ms · 3 项` → `3 项`）。
 *
 * 为什么要把耗时那截摘掉：它是**真量出来的**、随事件的 `at` 走（本地钟的差），
 * 拿它进断言就把「摘要成形」这条判据绑死在夹具的时刻上了。耗时本身另有用例
 * （`差距 3` 那两条）。
 */
function resultSummary(frame: Frame): string {
  const line = frame.record.find((row) => row.text.includes('✓ ') || row.text.includes('✗ '))
  const text = line?.text.trim() ?? ''

  return text.replace(/^[✓✗] (?:\d+(?:\.\d+)?(?:ms|s) · )?/, '')
}

/** 一次 `edit` 的现场：模型说了要改什么，工具把它做成了（或没做成）。 */
function edited(stage: Stage, options: { readonly ok?: boolean } = {}): void {
  stage.feed([
    event('model.delta', { channel: 'text', text: '改一处。' }),
    event(
      'tool.call',
      {
        name: 'edit',
        args: {
          path: 'src/utils/date.ts',
          old: ['function f() {', '  const v = 0', '  return v', '}'].join('\n'),
          new: ['function f() {', '  const v = 1', '  return v', '}'].join('\n'),
        },
      },
      { id: 71 },
    ),
    event(
      'tool.result',
      {
        call: 71,
        ok: options.ok ?? true,
        output: { text: options.ok === false ? '编辑失败：找不到那段原文' : '已替换 1 处（src/utils/date.ts）' },
      },
      { id: 72 }, // 落地在发起之后（`at` 递增——钟是往前走的）
    ),
  ])
}

// ══ 差距 1 · diff 审阅 ═══════════════════════════════════════════════

describe('差距 1 · diff 审阅——改了文件，看得见改了什么', () => {
  test('`edit` 改成了——**就地**给出这一处 diff：`-` 红 · `+` 绿 · 上下文 dim', async () => {
    const stage = live()
    edited(stage)

    const frame = await stage.screen(WIDE)

    // 工具行报的是**哪个文件**（不是一坨 JSON——参数里塞着整段正文）
    expect(frame.has('● edit src/utils/date.ts')).toBe(true)

    // 三档都在屏上：删（红）· 增（绿）· 上下文（dim）
    expect(bodyOf(frame, '-  const v = 0').every((cell) => cell.fg === '#e06c75')).toBe(true)
    expect(bodyOf(frame, '+  const v = 1').every((cell) => cell.fg === '#98c379')).toBe(true)
    expect(bodyOf(frame, '   return v').every((cell) => cell.fg === '#8b93a1')).toBe(true)

    // 公共的首尾**不重复画**（首行是上下文、不是删除行）——一减一加各只一次
    expect(frame.record.filter((line) => line.text.includes('const v = 0')).length).toBe(1)
    expect(frame.record.filter((line) => line.text.includes('const v = 1')).length).toBe(1)
  })

  test('**没做成就不给 diff**——那是「打算」，不是发生过的事；报的是缘由', async () => {
    const stage = live()
    edited(stage, { ok: false })

    const frame = await stage.screen(WIDE)

    expect(frame.has('-  const v = 0')).toBe(false)
    expect(frame.has('+  const v = 1')).toBe(false)
    expect(resultSummary(frame)).toBe('编辑失败：找不到那段原文')
  })

  test('改动很长——**折住**并**如实报**还有几行；`ctrl+o` 给全量', async () => {
    const stage = live()
    const old = Array.from({ length: 20 }, (_, at) => `old ${at}`).join('\n')
    const new_ = Array.from({ length: 20 }, (_, at) => `new ${at}`).join('\n')

    stage.feed([
      event('tool.call', { name: 'edit', args: { path: 'a.ts', old, new: new_ } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '已替换 1 处（a.ts）' } }, { id: 72 }),
    ])

    const folded = await stage.screen(WIDE)
    expect(folded.has('… 还有 24 行（ctrl+o 展开）')).toBe(true) // 40 行里画了 16
    expect(folded.has('old 19')).toBe(false)

    stage.press({ kind: 'ctrl+o' })
    const opened = await stage.screen(WIDE)
    expect(opened.has('old 19')).toBe(true)
    expect(opened.has('… 还有')).toBe(false)
  })
})

// ══ 差距 2 · 工具输出渲染 ═══════════════════════════════════════════

describe('差距 2 · 工具输出渲染——就近渲染已知形态', () => {
  test('失败——结果行**报首行缘由**（不必展开就知道为什么没成）', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'exec', args: { cmd: 'bun test' } }, { id: 71 }),
      event(
        'tool.result',
        { call: 71, ok: false, output: { text: 'exec 未能执行（信号收掉）：子进程被杀\n第二行别的东西' } },
        { id: 72 },
      ),
    ])

    const frame = await stage.screen(WIDE)

    expect(resultSummary(frame)).toContain('exec 未能执行（信号收掉）：子进程被杀')
    expect(frame.has('第二行别的东西')).toBe(false) // 缘由只要那一句，不铺全文
  })

  test('输出本来就是 diff（`exec` 跑 `git diff`）——摘要报增删行数 · 展开逐行着色', async () => {
    const stage = live()
    const diff = ['@@ -1,2 +1,2 @@', ' keep', '-old', '+new'].join('\n')

    stage.feed([
      event('tool.call', { name: 'exec', args: { cmd: 'git diff' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: diff } }, { id: 72 }),
    ])

    const folded = await stage.screen(WIDE)
    expect(resultSummary(folded)).toBe('+1 −1') // 认出来了：一增一删

    stage.press({ kind: 'ctrl+o' })
    const opened = await stage.screen(WIDE)
    expect(bodyOf(opened, '-old').every((cell) => cell.fg === '#e06c75')).toBe(true)
    expect(bodyOf(opened, '+new').every((cell) => cell.fg === '#98c379')).toBe(true)
  })

  test('列表类——报**项数**（`ls` 的输出一行一项）；**表格保持原文**', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'src/\ntest/\nREADME.md' } }, { id: 72 }),
    ])
    expect(resultSummary(await stage.screen(WIDE))).toBe('3 项')

    const table = createStage()
    table.feed([
      event('tool.call', { name: 'exec', args: { cmd: 'cat t.md' } }, { id: 72 }),
      event('tool.result', { call: 72, ok: true, output: { text: '| a | b |\n| --- | --- |\n| 1 | 2 |' } }, { id: 73 }),
    ])
    table.press({ kind: 'ctrl+o' })

    const frame = await table.screen(WIDE)
    // 首站**不渲染表格**（B8 的已知限度）——原样铺，且不上任何语义色
    expect(frame.has('| a | b |')).toBe(true)
    expect(bodyOf(frame, '| a | b |').every((cell) => cell.fg === null || cell.fg === '#8b93a1')).toBe(true)
  })

  test('空目录 / 无命中——内核的**注**比计数要紧（说的是「结果为空」）', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: '[空目录]' } }, { id: 72 }),
    ])

    expect(resultSummary(await stage.screen(WIDE))).toBe('[空目录]')
  })
})

// ══ 差距 3 · 进度感 ═════════════════════════════════════════════════

describe('差距 3 · 进度感——工具跑动 / 等待模型 / 退避重试，屏上分得出', () => {
  test('工具跑动——报**真耗时**（`⟳ 1.4s`）：钟给的，不是编的', async () => {
    const stage = live()
    stage.feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'sleep 9' } }, { id: 71 }),
    ])

    stage.at(TEST_AT + 71 + 1400) // 发起（`tool.call` 的 at）之后 1400ms
    const frame = await stage.screen(WIDE)

    expect(frame.has('⟳ exec {"cmd":"sleep 9"}')).toBe(true) // 还在跑：标记是转圈那个
    expect(frame.has('⟳ 1.4s')).toBe(true)
  })

  test('**没有钟就不报秒数**——回退「运行中」（拿不到的不编）', async () => {
    const stage = live()
    stage.feed([event('tool.call', { name: 'exec', args: { cmd: 'sleep 9' } }, { id: 71 })])

    const frame = await stage.screen(WIDE)

    expect(frame.has('⟳ 运行中')).toBe(true)
    expect(frame.has('⟳ 0')).toBe(false)
  })

  /**
   * 真跑留帧时当场看出来的：**答完裁决之后，状态行还停在「等你定夺」**——
   * 而那一刻球已经回到内核那边（工具在跑）。输入行说「交代一件事」（常态），
   * 底行却说「等你定夺」，两处**互相打架**；状态行的规矩是「只放此刻」。
   */
  test('答完裁决——状态行**回到「工作中」**（不赖在「等你定夺」上）', async () => {
    const stage = live()
    stage.feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'sleep 3' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: '命令 sleep 3', weight: 'light' },
        { id: 88 },
      ),
    ])
    expect((await stage.screen(WIDE)).statusLine).toContain('● 等你定夺')

    stage.feed([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 300 })])

    const frame = await stage.screen(WIDE)
    expect(frame.statusLine).toContain('● 工作中')
    expect(frame.statusLine).not.toContain('等你定夺')
    expect(frame.has('（工作中——想插话可以打，发不出去就排队）')).toBe(true) // 输入行与它同口径
  })

  test('**等模型**与**工具在跑**——输入行两句话分开（不必看状态行才分得出）', async () => {
    const waiting = live()
    waiting.feed([event('turn.start', {})])
    expect((await waiting.screen(WIDE)).has('（等模型回来——想插话可以打，发不出去就排队）')).toBe(true)

    const running = live()
    running.feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'bun test' } }, { id: 71 }),
    ])
    const frame = await running.screen(WIDE)

    expect(frame.has('（工作中——想插话可以打，发不出去就排队）')).toBe(true)
    expect(frame.has('等模型回来')).toBe(false)
  })
})

// ══ 差距 4 · 输入框骨架级 ═══════════════════════════════════════════

describe('差距 4 · 输入框——`shift+回车` 换行 · 多行草稿 · `↑` 历史', () => {
  test('`shift+回车` 换行——草稿两行，**续行缩进 2 列**（与 `› ` 同宽）', async () => {
    const stage = live()
    stage.type('第一行')
    stage.press({ kind: 'newline' })
    stage.type('第二行')

    const frame = await stage.screen(WIDE)

    expect(frame.dock.some((line) => line.text.includes('› 第一行'))).toBe(true)
    expect(frame.dock.some((line) => line.text.startsWith('   第二行'))).toBe(true) // 内边距 1 ＋ 缩进 2
    expect(frame.dock.some((line) => line.text.includes('› 第二行'))).toBe(false)
  })

  test('**回车**把多行草稿原样发出去（记录区里两行都在）', async () => {
    const stage = live()
    stage.type('第一行')
    stage.press({ kind: 'newline' })
    stage.type('第二行')
    stage.press({ kind: 'enter' })

    const frame = await stage.screen(WIDE)
    const texts = frame.record.map((line) => line.text)

    expect(texts).toContain('› 第一行')
    expect(texts).toContain('  第二行') // 用户行的折/续行同样从第 3 列起（悬挂缩进）
    expect(stage.commands().some((command) => command.type === 'input.submit')).toBe(true)
  })

  test('多行草稿**上限半屏**——超了收起头部，并**如实报**上面还有几行', async () => {
    const stage = live()
    for (let at = 0; at < 7; at += 1) {
      if (at > 0) stage.press({ kind: 'newline' })
      stage.type(`第 ${at + 1} 行`)
    }

    // 屏 10 行 ⇒ 半屏 5 行：前 2 行收起
    const frame = await stage.screen({ columns: 80, rows: 10 })

    expect(frame.has('… 上面还有 2 行')).toBe(true)
    expect(frame.has('第 1 行')).toBe(false)
    expect(frame.has('第 7 行')).toBe(true) // 光标在末尾，正在打的那行必须看得见
  })

  test('`↑` 历史——翻出一条**改过之后**再按 `↑`，从末尾重新翻（不卡在历史中间）', async () => {
    const stage = live()
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.feed([event('turn.end', { reason: 'settled' })])

    stage.press({ kind: 'up' })
    expect((await stage.screen(WIDE)).dock.some((line) => line.text.includes('› 第一句'))).toBe(true)

    stage.type('啊') // 改了它——这条就不再是历史里的那一条了
    stage.press({ kind: 'up' })

    const frame = await stage.screen(WIDE)
    expect(frame.dock.some((line) => line.text.includes('› 第一句'))).toBe(true)
    expect(frame.dock.some((line) => line.text.includes('第一句啊'))).toBe(false)
  })
})

// ══ 差距 5 · 上下文窗进度 ═══════════════════════════════════════════

describe('差距 5 · 上下文窗口进度——`12.4k/200k`', () => {
  test('窗总量**拿得到**——④ 报 `12.4k/200k`（原型 · 状态行规格的样例）', async () => {
    const stage = createStage({ contextWindow: 200_000 })
    stage.feed([event('model.usage', { inputTokens: 12_400, outputTokens: 40 })])

    const line = (await stage.screen(WIDE)).statusLine

    expect(line).toContain('12.4k/200k')
  })

  test('窗总量**拿不到**（`D10` 的出口还没合入）——只报已用量，**不编一个总数**', async () => {
    const stage = createStage()
    stage.feed([event('model.usage', { inputTokens: 12_400, outputTokens: 40 })])

    const line = (await stage.screen(WIDE)).statusLine

    expect(line).toContain('12.4k')
    expect(line).not.toContain('12.4k/') // 没有分母就不写那个斜杠
    expect(line).not.toContain('200k') // 更不能凭空出现一个总数
  })
})

// ══ 顺带：工具行的参数成形（差距 2 的同一件事）═══════════════════════

describe('顺带 · 笨重参数的成形', () => {
  test('`edit` / `write` 报**路径**；其余工具的参数原样（不追全量）', async () => {
    const stage = live()
    stage.feed([
      event('tool.call', { name: 'write', args: { path: 'README.md', content: 'x'.repeat(200) } }, { id: 71 }),
      event('tool.call', { name: 'ls', args: { path: 'src' } }, { id: 72 }),
    ])

    const frame = await stage.screen(WIDE)

    expect(frame.has('write README.md')).toBe(true)
    expect(frame.has('x'.repeat(200))).toBe(false) // 整段正文不再铺上屏
    expect(frame.has('ls {"path":"src"}')).toBe(true) // 短参数原样
  })

  test('流式那几帧参数还不全——照旧看得见（回退到原文片段）', async () => {
    const stage = live()
    stage.feed([event('model.delta', { channel: 'toolcall', text: '{"path":"a', name: 'edit', id: 'c1' })])

    const frame = await stage.screen(WIDE)

    expect(frame.has('{"path":"a')).toBe(true)
    // `⟳ edit ` 之后才是参数（标记 1 格 ＋ 空格 ＋ 名字 4 格 ＋ 空格 ⇒ 下标 7 起）
    expect(cellAt(frame, '{"path":"a', 7)).toMatchObject({ fg: '#8b93a1' }) // 参数仍是 dim
  })
})
