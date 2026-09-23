/**
 * U34 · **步骤清单在屏上的落点**（界面线）。
 *
 * 出处：`设计/任务推进`（·用户如何查看 · 终端投影与布局）＋ `交接/工单/U34` 的完成出口 5：
 * 真终端默认显示清单及进度；改路线保留已完成项；**呈现与主动收起/展开零模型请求、零工具
 * 副作用**，且保住正文、引用、光标及历史操作。
 *
 * 这一层量的是**用户看得见的那一屏**与**键按下去之后的状态**——判据分四组：
 * 1. **投影**：记录（条目 / `plan.changed`）怎么落成屏上那一份，谁新谁旧；
 * 2. **清单那一块**：方块与状态、折行、放不下时的行视口、矮窗口与恢复；
 * 3. **键**：`Ctrl T` 与翻页**只改本地视图**——不发命令、不动草稿/引用/插入点/输入历史；
 * 4. **不该出现的**：辅助工具的成功调用不刷工具卡（失败照旧可见）。
 *
 * 纯排版那一层（预算、视口、呼吸的数学）归 `plan.test.ts`；这里量它在屏上的样子。
 */

import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import type { Entry, EntryPayload, PlanNote, PlanStep } from '@magic/contracts'
import { TuiApp, breathingOf, liveLayoutOf } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { PALETTE } from '../src/components/lines.ts'
import { planStyleOf } from '../src/plan.ts'
import { hasPlan, planFromEntries, withPlan } from '../src/view.ts'
import { createStage } from './screen.ts'
import { blankRuns, duplicates, overflows } from './invariants.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain, rendered } from './screen.ts'

// —— 计划那一份的夹具 ——

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status })
const note = (...steps: readonly PlanStep[]): PlanNote => ({ steps, notes: '' })

/** 一条条目（重建那一趟要读的形态）。 */
function entry(id: number, kind: Entry['kind'], payload?: EntryPayload): Entry {
  return {
    id,
    kind,
    content: { text: '' },
    ...(payload === undefined ? {} : { payload }),
    at: 1_700_000_000_000 + id,
  }
}

/** 一条**带计划**的工具结果条目（内核那一路：结果与计划字段一次落进同一条）。 */
function planEntry(id: number, plan: PlanNote | null): Entry {
  return entry(id, 'tool-result', { ok: true, output: { text: '已更新' }, plan })
}

/** 记录区那一串是哪些行（不含字标——那是装帧）。工具行报名字（它没有 `text` 那一格）。 */
function rowsOf(stage: ReturnType<typeof createStage>): readonly string[] {
  const view = stage.shell.getView()
  return [...view.settled, ...view.rows]
    .filter((row) => row.kind !== 'banner')
    .map((row) => {
      if (row.kind === 'tool') return `[tool] ${row.name}`
      return 'text' in row ? row.text : `[${row.kind}]`
    })
}

/** 屏上的**视口行号**（`cursor.y` 用的是它；`rowOf` 给的是缓冲行号）。 */
function viewportOf(frame: Awaited<ReturnType<ReturnType<typeof createStage>['screen']>>, bufferRow: number): number {
  return bufferRow - (frame.screen.lines.length - frame.screen.rows)
}

/**
 * **帧尾那个换行还在不在**——「动态帧顶满终端了吗」的**字节**判据（U31 三轮立的那一条）。
 *
 * 顶满时 Ink 走整屏那一支、不写末尾那个换行（`ink.js` 的 `renderInteractiveFrame`），
 * 而摆光标的后缀仍按「正文之下还有一行」回退 ⇒ **真光标高一行**。剥控制序列这一步
 * **不能省**（`FORCE_COLOR=3` 那道门下色码开着，不剥就会把 `\e[39m` 当成帧尾）。
 */
function trailingBreak(bytes: string): boolean {
  const esc = String.fromCharCode(27)

  return bytes
    .slice(-120)
    .replace(new RegExp(`${esc}\\][^${esc}]*(?:\\u0007|${esc}\\\\)`, 'g'), '')
    .replace(new RegExp(`${esc}\\[[0-9;?]*[A-Za-z]`, 'g'), '')
    .endsWith('\n')
}

// ══ 一 · 投影：记录 → 屏上那一份 ════════════════════════════════════

describe('U34 · 计划投影', () => {
  test('`plan.changed` 一到，清单就在屏上（默认展开，不必先按什么键）', async () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', {
        entry: 10,
        plan: note(step('读登录逻辑', 'completed'), step('改提示', 'in_progress'), step('跑一遍')),
      }),
    ])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('■ 改提示')).toBe(true)
    expect(frame.has('■ 读登录逻辑')).toBe(true)
    expect(frame.has('□ 跑一遍')).toBe(true)
    // 没溢出就不该有那一行提示（放得下时不用报「还有几行」）
    expect(frame.has('PgUp/PgDn')).toBe(false)
  })

  test('清空 ⇒ 清单当场消失，不留「已完成」的常驻行', async () => {
    const stage = createStage()

    stage.feed([event('plan.changed', { entry: 10, plan: note(step('做完的那步', 'completed')) })])
    expect(hasPlan(stage.shell.getView())).toBe(true)

    stage.feed([event('plan.changed', { entry: 11, plan: null })])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(hasPlan(stage.shell.getView())).toBe(false)
    expect(frame.has('做完的那步')).toBe(false)
    expect(frame.has('计划')).toBe(false) // 连「已收起」那行都不该冒出来
  })

  test('旧的条目晚到 ⇒ 不覆盖（历史晚到不能覆盖更新或清空）', () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', { entry: 20, plan: note(step('新的')) }),
      event('plan.changed', { entry: 12, plan: note(step('旧的')) }),
    ])

    expect(rowsOf(stage)).toEqual([]) // 计划不进记录区（清单是另画的一块）
    expect(stage.shell.getView().plan.entry).toBe(20)
    expect(stage.shell.getView().plan.plan?.steps[0]?.text).toBe('新的')
  })

  test('换会话 ⇒ **先移除旧清单**（不能短暂串到新会话）', () => {
    const stage = createStage()

    // 先落到甲这条会话上（开局那一下：`null` → 真 id 不算「换」），再攒一份计划
    stage.feed([event('session.state', { active: 'session-a', sessions: [] })])
    stage.feed([event('plan.changed', { entry: 30, plan: note(step('上一条会话的')) })])
    expect(hasPlan(stage.shell.getView())).toBe(true)

    stage.feed([event('session.state', { active: 'session-b', sessions: [] })])

    expect(hasPlan(stage.shell.getView())).toBe(false)
    expect(stage.shell.getView().plan.entry).toBe(null)
  })

  test('重建（切会话 / 重开）从条目里取——最后一条带 `plan` 字段的工具结果说了算', () => {
    const entries = [
      entry(1, 'user'),
      entry(2, 'tool-call', { name: 'plan_update', args: {} }),
      planEntry(3, note(step('第一步', 'completed'))),
      entry(4, 'assistant'),
      planEntry(5, note(step('第一步', 'completed'), step('第二步', 'in_progress'))),
    ]

    expect(planFromEntries(entries)).toEqual({
      entry: 5,
      plan: note(step('第一步', 'completed'), step('第二步', 'in_progress')),
    })
  })

  test('清空之后**不继续往前找**（清空那一条就是当前计划）', () => {
    const entries = [planEntry(7, note(step('早就清掉的那份'))), planEntry(9, null)]

    expect(planFromEntries(entries)).toEqual({ entry: 9, plan: null })
  })

  test('没有 `plan` 字段的结果**不冒充**计划；失败的不算更新', () => {
    const plainResult = entry(4, 'tool-result', { ok: true, output: { text: 'ls 的输出' } })
    const failed = entry(6, 'tool-result', { ok: false, output: { text: '写不进去' }, plan: note(step('没落账的')) })

    expect(planFromEntries([plainResult])).toEqual({ entry: null, plan: null })
    expect(planFromEntries([planEntry(5, note(step('落账的'))), plainResult, failed])).toEqual({
      entry: 5,
      plan: note(step('落账的')),
    })
  })

  test('重建晚到（比实时事件旧）⇒ 不覆盖手上那一份', () => {
    const stage = createStage()

    stage.feed([event('plan.changed', { entry: 40, plan: note(step('实时来的')) })])
    // 重建那一趟读的是更早的一条（分块读库，慢一步）
    stage.feed([
      event('session.history', { session: 'session-test', entries: [planEntry(33, note(step('历史里的')))], done: true }),
    ])

    expect(stage.shell.getView().plan.entry).toBe(40)
    expect(stage.shell.getView().plan.plan?.steps[0]?.text).toBe('实时来的')
  })

  test('重建能补上清单（重开之后清单照旧在，除非它被清空过）', () => {
    const stage = createStage()

    stage.feed([
      event('session.history', {
        session: 'session-test',
        entries: [planEntry(8, note(step('还在这儿的第一步', 'completed'), step('没做完的第二步')))],
        done: true,
      }),
    ])

    expect(hasPlan(stage.shell.getView())).toBe(true)
    expect(stage.shell.getView().plan.entry).toBe(8)
  })

  test('`withPlan` 只认更新的一笔（同 id 也不覆盖——它是同一份）', () => {
    const stage = createStage()
    const view = stage.shell.getView()

    const once = withPlan(view, 5, note(step('一')))
    expect(withPlan(once, 5, note(step('二')))).toBe(once) // 原样返回（同一个对象）
  })
})

// ══ 二 · 清单那一块：方块、折行、行视口 ══════════════════════════════

describe('U34 · 清单那一块', () => {
  test('放得下 ⇒ 全部步骤都在，没有提示行；改路线时**已完成的留着**', async () => {
    const stage = createStage()

    stage.feed([event('plan.changed', { entry: 1, plan: note(step('第一步', 'completed')) })])
    // 改路线：已完成那一步留着，未完成的两步改掉 / 增补
    stage.feed([
      event('plan.changed', {
        entry: 2,
        plan: note(step('第一步', 'completed'), step('换个法子验证', 'in_progress'), step('补一条新加的')),
      }),
    ])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('■ 第一步')).toBe(true)
    expect(frame.has('■ 换个法子验证')).toBe(true)
    expect(frame.has('□ 补一条新加的')).toBe(true)
  })

  test('长标题**正常换行**（不裁短、不省略）——续行对齐文字', async () => {
    const stage = createStage()
    const long = '把登录失败的三条分支都改到位：空密码、认证失败、网络失败'

    stage.feed([event('plan.changed', { entry: 1, plan: note(step(long, 'in_progress')) })])

    const frame = await stage.screen({ columns: 40, rows: 24 })
    const lines = frame.record.map((line) => line.text)
    // 首行带方块，续行是两格缩进——拼起来仍是**原文一字不少**
    const at = lines.findIndex((line) => line.startsWith('■ '))
    expect(at).toBeGreaterThan(-1)
    const joined = [lines[at]?.slice(2), ...lines.slice(at + 1).map((line) => line.slice(2))]
      .join('')
      .slice(0, long.length)

    expect(joined).toBe(long)
  })

  test('放不下 ⇒ 起行视口：提示行报出上下还有几行，且**每一步都翻得到**', async () => {
    const stage = createStage()
    const many = Array.from({ length: 30 }, (_unused, at) => step(`第 ${at + 1} 步`))

    stage.feed([event('plan.changed', { entry: 1, plan: note(...many) })])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('PgUp/PgDn 翻页')).toBe(true)
    expect(frame.has('下面还有')).toBe(true)
    // 第一屏从顶上开始（看不见最后一步）
    expect(frame.has('第 1 步')).toBe(true)
    expect(frame.has('第 30 步')).toBe(false)

    // 一路翻到底：最后一步翻得到，且「下面」归零
    for (let page = 0; page < 20; page += 1) {
      const window = liveLayoutOf(stage.shell.getView(), 80, 24).plan.window
      if (window === null) break
      const next = window.top + window.visible
      stage.press({ kind: 'planTop', top: next })
      if (next >= window.total - window.visible) break
    }

    const bottom = await stage.screen({ columns: 80, rows: 24 })
    expect(bottom.has('第 30 步')).toBe(true)
    expect(bottom.has('上面还有')).toBe(true)
    expect(bottom.has('下面还有')).toBe(false)
  })

  test('矮窗口：清单让位给回复与输入区（一行都不画）——**恢复高度即还原**', async () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(step('第一步', 'completed'), step('第二步', 'in_progress'), step('第三步')),
      }),
    ])

    // 24 行：画得出来
    expect((await stage.screen({ columns: 80, rows: 24 })).has('■ 第二步')).toBe(true)

    // 8 行：交互区与状态行之后没余量了 ⇒ 暂不绘清单（也不落历史、不清屏）
    const short = await stage.screen({ columns: 80, rows: 8 })
    expect(short.has('■ 第二步')).toBe(false)
    expect(short.has('□ 第三步')).toBe(false)

    // 恢复高度 ⇒ 还原（视图那一份没丢，画不画只是当下的账）
    expect((await stage.screen({ columns: 80, rows: 24 })).has('■ 第二步')).toBe(true)
  })

  test('清单不把动态帧撑破（帧尾那个换行还在 · 真光标落在输入行）', async () => {
    const stage = createStage()
    const short = { columns: 60, rows: 20 }

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(...Array.from({ length: 40 }, (_u, at) => step(`第 ${at + 1} 步`))),
      }),
      event('turn.start', {}),
    ])

    // ① **字节**：帧尾那个换行还在不在——「动态帧顶满终端了吗」的直接判据（U31 三轮那条：
    //    顶满时 Ink 走整屏那一支、省掉末尾那个换行，真光标就高一行）
    expect(trailingBreak(await rendered([stage.shell.getView()], short, null))).toBe(true)

    // ② **真光标**：落在输入行上（清单多占的那几行把它顶下去就不对了）
    const frame = await stage.screen(short)
    expect(frame.has('PgUp/PgDn 翻页')).toBe(true)
    expect(frame.screen.cursor.y).toBe(viewportOf(frame, frame.rowOf('› ')))
  })

  test('屏上没有重影、没有成片空行、没有溢出', async () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(step('读一遍', 'completed'), step('改一处', 'in_progress'), step('跑测试')),
      }),
      event('turn.start', {}),
    ])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(duplicates(frame.screen)).toEqual([])
    expect(blankRuns(frame.screen)).toEqual([])
    expect(overflows(frame.screen)).toEqual([])
  })
})

// ══ 三 · 键：收起/展开与翻页 ══════════════════════════════════════════

describe('U34 · `Ctrl T` 与翻页', () => {
  test('`Ctrl T` 收起 ⇒ 只剩一行把手；再按 ⇒ 展开回原样', async () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', { entry: 1, plan: note(step('第一步', 'completed'), step('第二步', 'in_progress')) }),
    ])

    stage.press({ kind: 'ctrl+t' })
    const folded = await stage.screen({ columns: 80, rows: 24 })

    expect(folded.has('计划已收起 · ctrl+t 展开')).toBe(true)
    expect(folded.has('■ 第二步')).toBe(false)

    stage.press({ kind: 'ctrl+t' })
    const back = await stage.screen({ columns: 80, rows: 24 })

    expect(back.has('■ 第二步')).toBe(true)
    expect(back.has('计划已收起')).toBe(false)
  })

  test('没有清单时 `Ctrl T` 不切（别埋伏一个「下次建立计划就收着」）', () => {
    const stage = createStage()

    stage.press({ kind: 'ctrl+t' })
    expect(stage.shell.getView().planCollapsed).toBe(false)
  })

  test('呈现与收起/展开**零模型请求、零工具副作用**', () => {
    const stage = createStage()

    stage.feed([event('plan.changed', { entry: 1, plan: note(step('一步')) })])
    const before = stage.commands().length

    stage.press({ kind: 'ctrl+t' })
    stage.press({ kind: 'ctrl+t' })
    stage.press({ kind: 'planTop', top: 3 })

    expect(stage.commands().length).toBe(before)
  })

  test('`Ctrl T` 不动草稿、引用、插入点，也不动输入历史', () => {
    const stage = createStage()

    // 打一句、提交（进历史）——再打第二句并把插入点挪到中间
    stage.type('第一句')
    stage.press({ kind: 'enter' })
    stage.type('第二句')
    stage.press({ kind: 'left' })

    stage.feed([event('plan.changed', { entry: 1, plan: note(step('一步')) })])
    const before = stage.shell.getView()

    stage.press({ kind: 'ctrl+t' })

    const after = stage.shell.getView()
    expect(after.draft).toBe(before.draft)
    expect(after.caret).toBe(before.caret)
    expect(after.refs).toBe(before.refs)
    expect(after.planCollapsed).toBe(true)

    // 历史照旧：`↑` 取回的仍是刚提交的那一句
    stage.press({ kind: 'ctrl+t' })
    stage.press({ kind: 'up' })
    expect(stage.shell.getView().draft).toBe('第一句')
  })

  test('翻页键在**接管**（裁决）期间不生效', () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(...Array.from({ length: 30 }, (_u, at) => step(`第 ${at + 1} 步`))),
      }),
    ])

    // 没有接管时翻得动（给一个明确的目标位置）
    stage.press({ kind: 'planTop', top: 5 })
    expect(stage.shell.getView().planTop).toBe(5)

    // 裁决接管输入之后，翻页让位
    stage.feed([
      event('tool.decision.request', { call: 9, name: 'exec', material: 'rm -rf /tmp/x', weight: 'light' }, { id: 90 }),
    ])
    expect(stage.shell.getView().dock.kind).toBe('decision')

    stage.press({ kind: 'planTop', top: 9 })
    expect(stage.shell.getView().planTop).toBe(5)
  })

  test('方向键照旧归选择器与输入历史（翻页不抢它们）', () => {
    const stage = createStage()

    stage.feed([event('plan.changed', { entry: 1, plan: note(step('一步')) })])
    stage.type('一句')
    stage.press({ kind: 'enter' })
    stage.type('草稿')

    stage.press({ kind: 'up' })
    expect(stage.shell.getView().draft).toBe('一句')
  })
})

// ══ 四 · 真按键路径（Ink → 外壳）════════════════════════════════════

const POLL_MS = 5
const TIMEOUT_MS = 2000

/** 起一个**活壳**（真 `TuiApp`）——按键按字节写进 Ink 的 stdin，走完整的那一跳。 */
function liveApp() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  const ui = render(h(TuiApp, { shell }))

  const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + TIMEOUT_MS
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }

    throw new Error(`等不到：${label}\n${plain(ui.lastFrame() ?? '')}`)
  }

  return {
    spy,
    shell,
    /** 等 Ink 接管 stdin（否则第一次写会掉）。 */
    ready: async (): Promise<void> => {
      await waitFor(
        () => (ui.stdin as unknown as { listenerCount: (name: string) => number }).listenerCount('readable') > 0,
        'Ink 接管 stdin',
      )
    },
    write: (data: string): void => {
      ui.stdin.write(data)
    },
    waitFor,
    unmount: (): void => ui.unmount(),
  }
}

describe('U34 · 真按键路径', () => {
  test('`\\u0014`（Ctrl T）到得了外壳：收起、再按展开', async () => {
    const app = liveApp()
    try {
      await app.ready()
      app.spy.emit(
        event('plan.changed', { entry: 1, plan: note(step('第一步', 'completed'), step('第二步', 'in_progress')) }),
      )
      await app.waitFor(() => app.shell.getView().plan.plan !== null, '计划落进视图')

      app.write('\u0014')
      await app.waitFor(() => app.shell.getView().planCollapsed, 'Ctrl T 收起')

      app.write('\u0014')
      await app.waitFor(() => !app.shell.getView().planCollapsed, 'Ctrl T 展开')
    } finally {
      app.unmount()
    }
  })

  test('`\\u001b[6~`（PgDn）翻一页——一页几行由屏算，外壳只存目标', async () => {
    const app = liveApp()
    try {
      await app.ready()
      app.spy.emit(
        event('plan.changed', {
          entry: 1,
          plan: note(...Array.from({ length: 40 }, (_u, at) => step(`第 ${at + 1} 步`))),
        }),
      )
      await app.waitFor(() => app.shell.getView().plan.plan !== null, '计划落进视图')

      app.write('\u001b[6~')
      await app.waitFor(() => app.shell.getView().planTop > 0, 'PgDn 翻页')

      app.write('\u001b[5~')
      await app.waitFor(() => app.shell.getView().planTop === 0, 'PgUp 翻回顶')
    } finally {
      app.unmount()
    }
  })
})

// ══ 五 · 三态的样子（色 · 强调 · 弱化）════════════════════════════════

describe('U34 · 三态的样子', () => {
  const plan = note(step('做完的那步', 'completed'), step('正在做的那步', 'in_progress'), step('还没轮到'))

  test('纯层：三态各自的色与强调（进：主题色＋粗；完：压暗；未开始：都不）', () => {
    expect(planStyleOf('pending')).toEqual({ glyph: null, bold: false, dim: false })
    expect(planStyleOf('completed')).toEqual({ glyph: null, bold: false, dim: true })
    expect(planStyleOf('in_progress')).toEqual({ glyph: PALETTE.warn, bold: true, dim: false })
  })

  test('进行中＝主题色实心＋文字加粗；已完成＝原色压暗；未开始＝原色不强调', async () => {
    const stage = createStage()
    stage.feed([event('plan.changed', { entry: 1, plan })])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const done = frame.cellsOf(frame.rowOf('做完的那步'))
    const doing = frame.cellsOf(frame.rowOf('正在做的那步'))
    const todo = frame.cellsOf(frame.rowOf('还没轮到'))

    // **已完成**：整行压暗（色仍是默认前景——弱化是强度，不是颜色）
    expect(done.every((cell) => cell.dim)).toBe(true)
    expect(done.every((cell) => cell.fg === null)).toBe(true)
    expect(done.every((cell) => cell.strikethrough === false)).toBe(true) // 不划掉

    // **进行中**：方块是主题色，文字加粗、不压暗
    const glyph = doing.find((cell) => cell.text === '■')
    expect(glyph?.fg).toBe(PALETTE.warn)
    expect(doing.some((cell) => cell.bold)).toBe(true)
    expect(doing.every((cell) => cell.dim)).toBe(false)

    // **未开始**：空心、默认色、不强调
    expect(todo.some((cell) => cell.text === '□')).toBe(true)
    expect(todo.every((cell) => cell.fg === null)).toBe(true)
    expect(todo.every((cell) => cell.bold === false)).toBe(true)
    expect(todo.every((cell) => cell.dim === false)).toBe(true)
  })

  test('呼吸只动方块那一格——文字一直加粗（不跟着一亮一暗）', async () => {
    const stage = createStage()
    stage.feed([event('plan.changed', { entry: 1, plan })])

    stage.at(0) // 一轮的两端（最暗）
    const dimmest = await stage.screen({ columns: 80, rows: 24 })
    stage.at(1000) // 中点（最亮＝原色）
    const brightest = await stage.screen({ columns: 80, rows: 24 })

    const fgAt = (frame: Awaited<ReturnType<typeof stage.screen>>): string | null | undefined =>
      frame.cellsOf(frame.rowOf('正在做的那步')).find((cell) => cell.text === '■')?.fg

    expect(fgAt(dimmest)).not.toBe(fgAt(brightest))
    expect(fgAt(brightest)).toBe(PALETTE.warn)
    const text = brightest
      .cellsOf(brightest.rowOf('正在做的那步'))
      .filter((cell) => cell.text.trim() !== '' && cell.text !== '■')
    expect(text.length).toBeGreaterThan(0)
    expect(text.every((cell) => cell.bold)).toBe(true)
  })

  test('无色那一档：形状与强调还在（色不承担唯一辨识）', async () => {
    const stage = createStage()
    stage.feed([event('plan.changed', { entry: 1, plan })])

    // 剥掉色码之后仍是三行、方块与文字都在（`plain` 就是无色那一档的读法）
    const frame = await stage.screen({ columns: 80, rows: 24 })
    expect(plain(frame.screen.lines.join('\n'))).toContain('□ 还没轮到')
    expect(plain(frame.screen.lines.join('\n'))).toContain('■ 正在做的那步')
  })
})

// ══ 六 · 呼吸开关 ════════════════════════════════════════════════════

describe('U34 · 呼吸开关', () => {
  test('只在「清单可见 · 工作中 · 有进行中项」时动', () => {
    const stage = createStage()
    const plan = note(step('做完的', 'completed'), step('在做的', 'in_progress'))
    stage.feed([event('plan.changed', { entry: 1, plan })])
    const view = stage.shell.getView()
    const block = liveLayoutOf(view, 80, 24).plan

    // 空闲（还没开始这一轮）⇒ 不动
    expect(breathingOf(view, block)).toBe(false)

    // 工作中 ⇒ 动
    stage.feed([event('turn.start', {})])
    expect(breathingOf(stage.shell.getView(), block)).toBe(true)

    // 收起了 ⇒ 停
    stage.press({ kind: 'ctrl+t' })
    const folded = liveLayoutOf(stage.shell.getView(), 80, 24).plan
    expect(breathingOf(stage.shell.getView(), folded)).toBe(false)
  })

  test('没有进行中项就不动（全已完成 / 全未开始）', () => {
    const stage = createStage()
    stage.feed([
      event('plan.changed', { entry: 1, plan: note(step('做完了', 'completed'), step('还没动')) }),
      event('turn.start', {}),
    ])
    const view = stage.shell.getView()

    expect(breathingOf(view, liveLayoutOf(view, 80, 24).plan)).toBe(false)
  })
})

// ══ 七 · 辅助工具不刷工具卡 ══════════════════════════════════════════

describe('U34 · 三个辅助工具的工具卡', () => {
  /** 一次工具调用（事件 id 就是那笔调用的 `call`——契约：`tool.call` 不带 `call` 字段）。 */
  const call = (id: number, name: string) => event('tool.call', { name, args: {} }, { id })
  const result = (id: number, ok: boolean, text: string) =>
    event('tool.result', { call: id, ok, output: { text } })

  test('成功的 `plan_update` / `plan_read` / `history_read` 都不上屏', async () => {
    const stage = createStage()

    for (const [at, name] of ['plan_update', 'plan_read', 'history_read'].entries()) {
      stage.feed([call(at + 1, name), result(at + 1, true, '好')])
    }

    // 行还在本轮里（多件裁决报数要用）——判据是**屏上有没有**（「不另刷一串工具卡」）
    expect(rowsOf(stage).length).toBeGreaterThan(0)
    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('plan_update')).toBe(false)
    expect(frame.has('plan_read')).toBe(false)
    expect(frame.has('history_read')).toBe(false)
  })

  test('失败的那一次**照旧可见**（默认不画 ≠ 不认）', async () => {
    const stage = createStage()

    stage.feed([call(1, 'plan_update'), result(1, false, '落账失败')])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('plan_update')).toBe(true)
    expect(frame.has('落账失败')).toBe(true)
  })

  test('别的工具一行不少（只静那三个）', async () => {
    const stage = createStage()

    stage.feed([call(1, 'exec'), result(1, true, 'hello')])

    const frame = await stage.screen({ columns: 80, rows: 24 })

    expect(frame.has('exec')).toBe(true)
  })
})
