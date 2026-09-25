/**
 * U90 · **清单加「目标」表头 ＋ 步骤退一级**——规格即测试。
 *
 * 用户 2026-09-26 要的形状（他给了一张参照图）：**顶格一行是「这件事是什么」，
 * 下面才是步骤**——像 Claude 那样「有缩进、不顶格」。两件：
 *
 * | | 形 | 由头 |
 * | --- | --- | --- |
 * | **目标** | **顶格**、无记号、不动色 | 它是这一块的名目——层次由**位置**给，不另加记号 |
 * | **步骤** | 整块**退一级**（`PLAN_INDENT`） | 一眼看得出「下面这些是它的步骤」 |
 *
 * ⚠️ **退一级只改折行宽度，不改行数**：行视口 / 翻页 / 溢出提示一个字没动，
 * 目标那几行与步骤那几行**同属一份行账**（`planBlockOf` 一处给）。故这一层最要紧的
 * 反面判据与 U85 同一条：**矮窗下账与屏不差分家**（退一级正是最容易弄坏它的地方——
 * 折行宽度少算一级，终端就会自己折出多余的行，矮终端上动态帧当场顶满 ⇒ 真光标高一行）。
 *
 * 三条分寸各有用例：**没有目标 ⇒ 那一行不出现**（不留空表头）· **不把 notes 铺进清单**
 * （它照旧只在回查与材料里）· **步骤仍是平的一列**（退一级是排版，不引入父子树）。
 */

import { describe, expect, test } from 'bun:test'
import type { PlanNote, PlanStep } from '@magic/contracts'
import { liveLayoutOf } from '../src/components/app.ts'
import { PLAN_INDENT } from '../src/plan.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'
import { event } from './events.ts'
import { blankRuns, duplicates, overflows } from './invariants.ts'

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status })
const note = (...steps: readonly PlanStep[]): PlanNote => ({ steps, notes: '' })
const withGoal = (goal: string, ...steps: readonly PlanStep[]): PlanNote => ({
  goal,
  steps,
  notes: '',
})

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/** 屏上那两条线的行号（顶 → 底）。 */
const rulesOf = (frame: Frame): readonly number[] =>
  frame.screen.lines
    .map((text, row) => ({ text, row }))
    .filter((one) => isRule(one.text))
    .map((one) => one.row)

/** 非空行有几条——「这一屏上多出/少了一行」用它。 */
const nonBlank = (frame: Frame): number => frame.screen.lines.filter((text) => text.trim() !== '').length

/** 缓冲行号 → 视口行号（`cursor.y` 用的是后者）——同 `spec.u34-tui.test.ts` 那一支。 */
const viewportOf = (frame: Frame, bufferRow: number): number =>
  bufferRow - (frame.screen.lines.length - frame.screen.rows)

/** **输入行**那一行（`› ` 开头的最后一条）。 */
const composerRow = (frame: Frame): number =>
  frame.screen.lines.reduce((last, text, row) => (text.trimStart().startsWith('› ') ? row : last), -1)

/** 清单那一带里含某串的那一行（原样，不 trim——列的判据要看前导空格）。 */
const dockLineOf = (frame: Frame, needle: string): string =>
  frame.dock.find((line) => line.text.includes(needle))?.text ?? ''

/** 喂一条 `plan.changed`（清单由此上屏）。 */
function feedPlan(stage: ReturnType<typeof createStage>, plan: PlanNote | null, entry = 1): void {
  stage.feed([event('plan.changed', { entry, plan })])
}

// ══ 一 · 形：目标顶格、步骤退一级 ═════════════════════════════════════

describe('U90 · 目标顶格 ＋ 步骤退一级', () => {
  test('目标在**第 0 列**、步骤在它下面**退一级**——一眼看得出谁是谁的名目', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('读登录逻辑', 'completed'), step('改提示', 'in_progress')))

    const frame = await stage.screen({ columns: 80, rows: 24 })

    // 目标：**顶格**（第 0 列就是它的第一个字），不带方块
    const goal = dockLineOf(frame, '修好登录失败提示')
    expect(goal.startsWith('修好登录失败提示')).toBe(true)
    // 步骤：先让出那一级，再是方块 ＋ 空格
    expect(dockLineOf(frame, '读登录逻辑')).toBe(`${' '.repeat(PLAN_INDENT)}■ 读登录逻辑`)
    expect(dockLineOf(frame, '改提示')).toBe(`${' '.repeat(PLAN_INDENT)}▪ 改提示`)
    expect(PLAN_INDENT).toBe(2)

    // **次序**：目标在步骤**之上**（这一块读起来才是「这件事 → 它的步骤」）
    const goalRow = frame.dock.findIndex((line) => line.text.startsWith('修好登录失败提示'))
    const firstStep = frame.dock.findIndex((line) => line.text.includes('■ 读登录逻辑'))
    expect(goalRow).toBeGreaterThan(-1)
    expect(goalRow).toBeLessThan(firstStep)
  })

  test('清单仍在分隔线**之下**（U85 的判据一字不改）：目标与步骤都在两条线之间', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('读登录逻辑', 'completed'), step('改提示', 'in_progress')))

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const rules = rulesOf(frame)
    expect(rules.length).toBe(2)

    const rows = [
      frame.dock.find((line) => line.text.startsWith('修好登录失败提示'))?.row,
      frame.dock.find((line) => line.text.includes('■ 读登录逻辑'))?.row,
      frame.dock.find((line) => line.text.includes('▪ 改提示'))?.row,
    ]

    for (const row of rows) {
      expect(row).toBeDefined()
      expect(row as number).toBeGreaterThan(rules[0] as number)
      expect(row as number).toBeLessThan(rules[1] as number)
    }
    // 记录区一条都不许沾（目标那几行也不进记录那一侧）
    expect(frame.record.every((line) => !line.text.includes('修好登录失败提示'))).toBe(true)
  })

  test('⚠️ 反面：**没有目标那一行就不出现**——不是留一个空表头', async () => {
    const stage = createStage()
    feedPlan(stage, note(step('一步', 'in_progress')))

    const withOut = await stage.screen({ columns: 80, rows: 24 })
    // 那一行的判据是**列 0 上有没有一行文字**：整块清单的头一行应当就是步骤
    expect(withOut.dock[0]?.text.startsWith(' ')).toBe(true)
    expect(withOut.dock.every((line) => line.text.trim() === '' || line.text.startsWith(' '))).toBe(true)

    feedPlan(stage, withGoal('修好登录失败提示', step('一步', 'in_progress')), 2)
    const withOne = await stage.screen({ columns: 80, rows: 24 })

    // 有目标 ⇒ **正好多一行**（其余一个字不动）
    expect(nonBlank(withOne)).toBe(nonBlank(withOut) + 1)
  })

  test('反面：步骤仍是**平的一列**（退一级是排版，不引入父子树）', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('第一步'), step('第二步'), step('第三步')))

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const at = frame.dock
      .filter((line) => /[□▪■]/u.test(line.text))
      .map((line) => line.text.indexOf(line.text.trim().charAt(0)))

    // 三条步骤的方块**在同一列**（谁也不比谁深）
    expect(new Set(at).size).toBe(1)
    expect(at[0]).toBe(PLAN_INDENT)
  })

  test('反面：辅助笔记**不铺进清单**（它照旧只在回查与材料里）', async () => {
    const stage = createStage()
    feedPlan(stage, { goal: '修好登录失败提示', steps: [step('一步')], notes: '约束：别动引用' })

    const frame = await stage.screen({ columns: 80, rows: 24 })
    expect(frame.screen.lines.some((line) => line.includes('别动引用'))).toBe(false)
  })

  test('长目标正常折行（不裁短、不省略），续行仍**顶格**', async () => {
    const stage = createStage()
    const long = '修好登录失败提示并覆盖空密码与网络失败两类分支'
    feedPlan(stage, withGoal(long, step('一步')))

    const frame = await stage.screen({ columns: 20, rows: 24 })
    const dock = frame.dock.map((line) => line.text)

    // 目标占了不止一行：找不到整串，但**原文拼起来一字不少**且每一行都顶格
    const at = dock.findIndex((line) => long.startsWith(line))
    expect(at).toBeGreaterThan(-1)
    expect(dock[at]).toBe(long.slice(0, dock[at]?.length))

    // 目标折出来的那几行**都在第 0 列**（续行也顶格——它是表头，不悬挂缩进）
    const firstStep = dock.findIndex((line) => line.startsWith(' '))
    const goalRows = dock.slice(at, firstStep)
    expect(goalRows.length).toBeGreaterThan(1)
    expect(goalRows.every((line) => line !== '' && !line.startsWith(' '))).toBe(true)
    expect(goalRows.join('').slice(0, long.length)).toBe(long)
  })

  test('长步骤的续行**对齐文字那一条线**（退一级之后仍是那一条）', async () => {
    const stage = createStage()
    const long = '把登录失败的三条分支都改到位：空密码、认证失败、网络失败'
    feedPlan(stage, withGoal('修好提示', step(long, 'in_progress')))

    const frame = await stage.screen({ columns: 40, rows: 24 })
    const dock = frame.dock.map((line) => line.text)
    const at = dock.findIndex((line) => line.startsWith(`${' '.repeat(PLAN_INDENT)}▪ `))
    expect(at).toBeGreaterThan(-1)

    const cut = PLAN_INDENT + 2
    expect([dock[at]?.slice(cut), ...dock.slice(at + 1).map((line) => line.slice(cut))]
      .join('')
      .slice(0, long.length)).toBe(long)
  })
})

// ══ 二 · 账与屏不分家（矮窗 · ⚠️ 本单最容易弄坏的一条）═════════════════

describe('U90 · 矮窗里账与屏不分家', () => {
  test('⚠️ 目标在场、矮窗：真光标仍**落在输入行上**（多算/少算一行它就跑了）', async () => {
    const stage = createStage()
    const short = { columns: 60, rows: 14 }

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: withGoal(
          '修好登录失败提示',
          ...Array.from({ length: 30 }, (_unused, at) => step(`第 ${at + 1} 步`)),
        ),
      }),
      event('turn.start', {}),
    ])

    const frame = await stage.screen(short)

    // 清单真画出来了（目标那一行在、视口与溢出提示照旧）
    expect(frame.has('修好登录失败提示')).toBe(true)
    expect(frame.has('PgUp/PgDn 翻页')).toBe(true)
    expect(frame.screen.cursor.y).toBe(viewportOf(frame, composerRow(frame)))
    // 没有重影、没有成片空行、没有溢出——账与屏分家的几种样子
    expect(blankRuns(frame.screen)).toEqual([])
    expect(duplicates(frame.screen)).toEqual([])
    expect(overflows(frame.screen)).toEqual([])
  })

  test('⚠️ 折行宽度**算上了退的那一级**：屏上几行 ＝ `planBlockOf` 的账几行', async () => {
    const stage = createStage()
    // 58 列的文字：按**退了级**的宽度（60 − 2 − 2 ＝ 56）折成**两行**；
    // 忘了扣那一级（按 58 折）就是**一行**——这一档量的正是那件事。
    const exact = '一'.repeat(29)

    stage.feed([
      event('plan.changed', { entry: 1, plan: withGoal('修好登录失败提示', step(exact)) }),
      event('turn.start', {}),
    ])

    const frame = await stage.screen({ columns: 60, rows: 24 })
    const block = liveLayoutOf(stage.shell.getView(), 60, 24).plan
    // 清单那几行 ＝ 交互区里除了输入行之外的非空行（这一屏上没有别的）
    const planRows = frame.dock.filter(
      (line) => line.text.trim() !== '' && !line.text.trimStart().startsWith('› '),
    )

    expect(planRows.length).toBe(block.height) // **账与屏同一个数**
    expect(planRows.length).toBe(3) // 目标 1 行 ＋ 步骤 2 行
    // 续行**对齐文字那一条线**（退一级 ＋ 方块那格）
    expect(planRows[2]?.text.startsWith(`${' '.repeat(PLAN_INDENT)}  `)).toBe(true)
    expect(overflows(frame.screen)).toEqual([])
  })

  test('目标折行也算进账：矮窗里目标占两行时，真光标照旧不跑偏', async () => {
    const stage = createStage()
    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: withGoal(
          '修好登录失败提示并覆盖空密码与网络失败两类分支再补一遍回归',
          step('第一步'),
          step('第二步'),
        ),
      }),
      event('turn.start', {}),
    ])

    const frame = await stage.screen({ columns: 40, rows: 14 })
    expect(frame.screen.cursor.y).toBe(viewportOf(frame, composerRow(frame)))
    expect(blankRuns(frame.screen)).toEqual([])
    expect(overflows(frame.screen)).toEqual([])
  })

  test('收起 / 清空那两条把手不受影响（与有没有目标无关）', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('一步', 'in_progress')))

    expect((await stage.screen({ columns: 80, rows: 24 })).has('修好登录失败提示')).toBe(true)

    stage.press({ kind: 'ctrl+t' })
    const folded = await stage.screen({ columns: 80, rows: 24 })
    expect(folded.has('计划已收起')).toBe(true)
    expect(folded.has('修好登录失败提示')).toBe(false)

    stage.press({ kind: 'ctrl+t' })
    expect((await stage.screen({ columns: 80, rows: 24 })).has('修好登录失败提示')).toBe(true)

    feedPlan(stage, null, 2)
    const gone = await stage.screen({ columns: 80, rows: 24 })
    expect(gone.has('修好登录失败提示')).toBe(false)
    expect(gone.dock.every((line) => !/[▪■□]/u.test(line.text))).toBe(true)
  })
})
