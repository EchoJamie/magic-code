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
import { PLAN_INDENT } from '../src/plan.ts'
import { createStage } from './screen.ts'
import type { Frame } from './screen.ts'
import { event } from './events.ts'

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



/** 清单那一带里含某串的那一行（原样，不 trim——列的判据要看前导空格）。 */
const dockLineOf = (frame: Frame, needle: string): string =>
  frame.record.find((line) => line.text.includes(needle))?.text ?? ''

/** 喂一条 `plan.changed`（清单由此上屏）。 */
function feedPlan(stage: ReturnType<typeof createStage>, plan: PlanNote | null, entry = 1): void {
  stage.feed([event('plan.changed', { entry, plan })])
}

// ══ 一 · 形：目标顶格、步骤退一级 ═════════════════════════════════════

describe('U90 · 目标顶格 ＋ 步骤退一级', () => {
  test('目标在**第 0 列**、步骤在它下面**退一级**——一眼看得出谁是谁的名目', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('读登录逻辑', 'completed'), step('改提示', 'in_progress')))

    const frame = await stage.screen({ columns: 200, rows: 40 })

    // 目标：**顶格**（第 0 列就是它的第一个字），不带方块
    const goal = dockLineOf(frame, '修好登录失败提示')
    expect(goal.startsWith('修好登录失败提示')).toBe(true)
    // 步骤：先让出那一级，再是方块 ＋ 空格
    expect(dockLineOf(frame, '读登录逻辑')).toBe(`${' '.repeat(PLAN_INDENT)}■ 读登录逻辑`)
    expect(dockLineOf(frame, '改提示')).toBe(`${' '.repeat(PLAN_INDENT)}▪ 改提示`)
    expect(PLAN_INDENT).toBe(2)

    // **次序**：目标在步骤**之上**（这一块读起来才是「这件事 → 它的步骤」）
    const goalRow = frame.record.findIndex((line) => line.text.startsWith('修好登录失败提示'))
    const firstStep = frame.record.findIndex((line) => line.text.includes('■ 读登录逻辑'))
    expect(goalRow).toBeGreaterThan(-1)
    expect(goalRow).toBeLessThan(firstStep)
  })

  test('清单仍在分隔线**之下**（U85 的判据一字不改）：目标与步骤都在两条线之间', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('读登录逻辑', 'completed'), step('改提示', 'in_progress')))

    const frame = await stage.screen({ columns: 200, rows: 40 })
    const rules = rulesOf(frame)
    expect(rules.length).toBe(2)

    const rows = [
      frame.record.find((line) => line.text.startsWith('修好登录失败提示'))?.row,
      frame.record.find((line) => line.text.includes('■ 读登录逻辑'))?.row,
      frame.record.find((line) => line.text.includes('▪ 改提示'))?.row,
    ]

    for (const row of rows) {
      expect(row).toBeDefined()
      expect(row as number).toBeLessThan(rules[0] as number)
      expect(row as number).toBeLessThan(rules[1] as number)
    }
    // 记录区一条都不许沾（目标那几行也不进记录那一侧）
    expect(frame.dock.every((line) => !line.text.includes('修好登录失败提示'))).toBe(true)
  })

  test('⚠️ 反面：**没有目标那一行就不出现**——不是留一个空表头', async () => {
    const stage = createStage()
    feedPlan(stage, note(step('一步', 'in_progress')))

    const withOut = await stage.screen({ columns: 200, rows: 40 })
    // 那一行的判据是**列 0 上有没有一行文字**：整块清单的头一行应当就是步骤
    expect(withOut.dock[0]?.text.startsWith(' ')).toBe(true)
    expect(withOut.dock.every((line) => line.text.trim() === '' || line.text.startsWith(' '))).toBe(true)

    feedPlan(stage, withGoal('修好登录失败提示', step('一步', 'in_progress')), 2)
    const withOne = await stage.screen({ columns: 200, rows: 40 })

    // 有目标 ⇒ **正好多一行**（其余一个字不动）
    expect(nonBlank(withOne)).toBe(nonBlank(withOut) + 1)
  })

  test('反面：步骤仍是**平的一列**（退一级是排版，不引入父子树）', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('第一步'), step('第二步'), step('第三步')))

    const frame = await stage.screen({ columns: 200, rows: 40 })
    const at = frame.record
      .filter((line) => /[□▪■]/u.test(line.text))
      .map((line) => line.text.indexOf(line.text.trim().charAt(0)))

    // 三条步骤的方块**在同一列**（谁也不比谁深）
    expect(new Set(at).size).toBe(1)
    expect(at[0]).toBe(PLAN_INDENT)
  })

  test('反面：辅助笔记**不铺进清单**（它照旧只在回查与材料里）', async () => {
    const stage = createStage()
    feedPlan(stage, { goal: '修好登录失败提示', steps: [step('一步')], notes: '约束：别动引用' })

    const frame = await stage.screen({ columns: 200, rows: 40 })
    expect(frame.screen.lines.some((line) => line.includes('别动引用'))).toBe(false)
  })
})

// ══ 二 · 账与屏不分家（矮窗 · ⚠️ 本单最容易弄坏的一条）═════════════════

describe('U90 · 矮窗里账与屏不分家', () => {

  test('收起 / 清空那两条把手不受影响（与有没有目标无关）', async () => {
    const stage = createStage()
    feedPlan(stage, withGoal('修好登录失败提示', step('一步', 'in_progress')))

    expect((await stage.screen({ columns: 200, rows: 40 })).has('修好登录失败提示')).toBe(true)

    stage.press({ kind: 'ctrl+t' })
    const folded = await stage.screen({ columns: 200, rows: 40 })
    expect(folded.has('计划已收起')).toBe(true)
    expect(folded.has('修好登录失败提示')).toBe(false)

    stage.press({ kind: 'ctrl+t' })
    expect((await stage.screen({ columns: 200, rows: 40 })).has('修好登录失败提示')).toBe(true)

    feedPlan(stage, null, 2)
    const gone = await stage.screen({ columns: 200, rows: 40 })
    expect(gone.has('修好登录失败提示')).toBe(false)
    expect(gone.dock.every((line) => !/[▪■□]/u.test(line.text))).toBe(true)
  })
})
