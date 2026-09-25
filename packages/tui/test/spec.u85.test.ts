/**
 * U85 · **清单与滚动记录分开**（甲）＋ **`ctrl+a` / `ctrl+e` 行首行末**（乙）——规格即测试。
 *
 * 两件事同属一屏（`components/app.ts`），各判各的。
 *
 * ## 甲 · 清单站在分隔线**之下**（缺陷 D43）
 *
 * 一屏上的次序，改前 → 改后：
 *
 * | | 活动区 | 清单 | 上沿线 | 输入行 |
 * | --- | --- | --- | --- | --- |
 * | **改前（U34）** | … | **在这儿** | 记录区／交互区 | … |
 * | **改后（U85）** | … | —— | 记录区／交互区 | **只有它在这儿** |
 *
 * 由头（用户原话）：「**看不出与上面滚动信息之间的分隔**」——清单画在上沿线**之上**，
 * 那一侧仍属「这一屏正在发生什么」，于是它读起来就是上面那些话的一部分。而它的归属
 * **本来就是交互区那一侧**（`Ctrl T` 管它、让位次序与输入区同一条）。挪到线的这一侧，
 * **现成的那条线**就把它与滚动记录划开了——**不另加第三条线**。
 *
 * 这一层量的是**用户看得见的那一屏**：它在哪一带、与那条线谁上谁下、与输入行谁上谁下，
 * 以及**搬了家之后高度的账有没有跟着走**（U31 那一族的老病：账与屏分家 ⇒ 真光标高一行）。
 * 折行 / 行视口 / 溢出提示 / 呼吸那几件**一个字没动**——它们仍归 `spec.u34-tui.test.ts`，
 * 那条用例里改的只是「从哪一段行里读清单」（`record` → `dock`），**判据本身没动**。
 *
 * ## 乙 · `ctrl+a` / `ctrl+e`（行首 / 行末）
 *
 * 用户 2026-09-26 真跑发现：按键表里没有这一对，它俩落到兜底那支变成「没人接的键」。
 * 语义按 **readline**：**插入点所在那一行**的两端，行按 `\n` 划界（**逻辑行**，
 * 不是屏上折出来的视觉行——见 `components/composer.ts` 的 `lineSpan`）。
 *
 * 三条分寸各有用例：**只挪插入点、草稿与引用一个字不动**（走 `commit` 不走 `edit`）；
 * **不与既有键冲突**（`ctrl+w` 照旧是停这一轮、`ctrl+b`/`ctrl+f` 照旧没人接）；
 * **接管期间不静默吞**（说一句，同 `←` / `→`）。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, PathCatalogRow, PlanNote, PlanStep } from '@magic/contracts'
import { toShellKeys } from '../src/components/app.ts'
import { lineSpan } from '../src/components/composer.ts'
import type { DraftRef } from '../src/components/inline.ts'
import { createStage } from './screen.ts'
import type { Frame, Stage } from './screen.ts'
import { event } from './events.ts'
import { blankRuns, duplicates, overflows } from './invariants.ts'

const ENTER = { kind: 'enter' } as const
const NEWLINE = { kind: 'newline' } as const
const LINE_START = { kind: 'lineStart' } as const
const LINE_END = { kind: 'lineEnd' } as const

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/** 屏上那两条线的行号（顶 → 底）——**恰好两条**由用例自己钉。 */
const rulesOf = (frame: Frame): readonly number[] =>
  frame.screen.lines
    .map((text, row) => ({ text, row }))
    .filter((one) => isRule(one.text))
    .map((one) => one.row)

/** 非空行有几条——「这一屏上多出/少了一行」用它（`screen.lines` 是**整份缓冲**，长度会变）。 */
const nonBlank = (frame: Frame): number => frame.screen.lines.filter((text) => text.trim() !== '').length

/**
 * **缓冲行号 → 视口行号**（`cursor.y` 用的是后者，`rowOf` / `screen.lines` 是前者）——
 * 同 `spec.u34-tui.test.ts` 那一支（`screen.lines` 含滚进 scrollback 的那些行）。
 */
const viewportOf = (frame: Frame, bufferRow: number): number =>
  bufferRow - (frame.screen.lines.length - frame.screen.rows)

/** **输入行**那一行（`› ` 开头的最后一条——记录区里也有 `›` 的用户行，故取最后一条）。 */
const composerRow = (frame: Frame): number => {
  const at = frame.screen.lines.reduce((last, text, row) => (text.trimStart().startsWith('› ') ? row : last), -1)

  return at
}

// —— 计划那一份的夹具（与 `spec.u34-tui.test.ts` 同一形）——

const step = (text: string, status: PlanStep['status'] = 'pending'): PlanStep => ({ text, status })
const note = (...steps: readonly PlanStep[]): PlanNote => ({ steps, notes: '' })

/** 喂一条 `plan.changed`（清单由此上屏）。 */
function feedPlan(stage: Stage, plan: PlanNote | null, entry = 1): void {
  stage.feed([event('plan.changed', { entry, plan })])
}

/** 一条路径候选（`@` 那一栏的答复）。 */
function feedPaths(stage: Stage, query: string, rows: readonly PathCatalogRow[]): void {
  stage.feed([event('paths.catalog', { query, rows })] as readonly KernelEvent[])
}

/** 一路选入一个文件引用：`@` → 答复 → 回车（与 `spec.u36.test.ts` 同一手）。 */
function pickFile(stage: Stage, display: string): void {
  stage.press({ kind: 'char', char: '@' })
  feedPaths(stage, '', [{ path: `/ws/${display}`, display, kind: 'file', external: false }])
  stage.press(ENTER)
}

/** 草稿上的引用（视图那一份）。 */
const refsOf = (stage: Stage): readonly DraftRef[] => stage.shell.getView().refs

// ══ 甲 · 清单站在分隔线之下 ═══════════════════════════════════════════

describe('U85 · 甲 · 清单与滚动记录分得开', () => {
  test('清单在上沿那条线**之下**——不在记录那一侧（这就是 D43 那一句「看不出分隔」）', async () => {
    const stage = createStage()

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(step('读登录逻辑', 'completed'), step('改提示', 'in_progress'), step('跑一遍')),
      }),
    ])

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const rules = rulesOf(frame)

    // 那三条步骤**一条都不在记录区**（记录区＝上沿线之上）
    expect(frame.record.filter((line) => /[▪■□]/u.test(line.text))).toEqual([])

    // 三条都在**两条线之间**那一带（＝交互区）
    const inDock = frame.dock.filter((line) => /[▪■□]/u.test(line.text))
    expect(inDock.map((line) => line.text.trim())).toEqual(['■ 读登录逻辑', '▪ 改提示', '□ 跑一遍'])

    // 且它在**上沿线之下**、**输入行之上**——两条线的次序一个没动（第一条是上沿）
    const planRow = frame.dock.find((line) => line.text.includes('▪ 改提示'))?.row ?? -1
    expect(rules.length).toBe(2)
    expect(planRow).toBeGreaterThan(rules[0] as number)
    expect(planRow).toBeLessThan(composerRow(frame))
  })

  test('反面：一屏**仍然恰好两条线**，输入区／状态行那条照旧（U45/U59 判据不改）', async () => {
    const stage = createStage()
    feedPlan(stage, note(step('一步')))

    const frame = await stage.screen({ columns: 80, rows: 24 })
    const rules = rulesOf(frame)

    expect(rules.length).toBe(2)
    // 下沿线仍在**输入行与状态行之间**：输入行在它之上、状态行在它之下
    const footer = rules[1] as number
    expect(composerRow(frame)).toBeLessThan(footer)
    expect(frame.statusRow).toBeGreaterThan(footer)
    // 两条线仍是满宽（同一条 `separatorOf`）
    for (const row of rules) expect(frame.textAt(row).trimEnd().length).toBe(80)
  })

  test('搬了家没动别处：**记录区一字未动**，多出来的正好是清单那一行', async () => {
    const stage = createStage()

    const bare = await stage.screen({ columns: 80, rows: 24 })
    feedPlan(stage, note(step('一步', 'in_progress')))
    const withPlan = await stage.screen({ columns: 80, rows: 24 })

    // 上沿线**还在原来那一行**（清单没把它往下推——它现在画在线的这一侧）
    expect(rulesOf(withPlan)[0]).toBe(rulesOf(bare)[0])
    expect(withPlan.record.map((line) => line.text)).toEqual(bare.record.map((line) => line.text))
    expect(nonBlank(withPlan)).toBe(nonBlank(bare) + 1)
  })

  test('⚠️ 账与屏没有分家：清单在场时真光标仍落在输入行上（矮窗那一档）', async () => {
    const stage = createStage()
    const short = { columns: 60, rows: 14 }

    stage.feed([
      event('plan.changed', {
        entry: 1,
        plan: note(...Array.from({ length: 30 }, (_unused, at) => step(`第 ${at + 1} 步`))),
      }),
      event('turn.start', {}),
    ])

    const frame = await stage.screen(short)

    // 清单真画出来了（行视口那一套照旧），而真光标**落在输入行那一行**——
    // 账少算/多算一行，它就会跑到输入行之外去（U31 那一族的老病）
    expect(frame.has('PgUp/PgDn 翻页')).toBe(true)
    expect(frame.screen.cursor.y).toBe(viewportOf(frame, composerRow(frame)))
    expect(blankRuns(frame.screen)).toEqual([])
    expect(duplicates(frame.screen)).toEqual([])
    expect(overflows(frame.screen)).toEqual([])
  })

  test('让位次序不变：矮窗里清单先让（余量不够给回复留 3 行时一行都不画）', async () => {
    const stage = createStage()
    feedPlan(stage, note(step('第一步', 'completed'), step('第二步', 'in_progress'), step('第三步')))

    expect((await stage.screen({ columns: 80, rows: 24 })).has('▪ 第二步')).toBe(true)
    // 8 行：交互区与状态行之后没余量 ⇒ 清单让位（**恢复高度即还原**，见 `spec.u34-tui`）
    const tiny = await stage.screen({ columns: 80, rows: 8 })
    expect(tiny.has('▪ 第二步')).toBe(false)
    expect((await stage.screen({ columns: 80, rows: 24 })).has('▪ 第二步')).toBe(true)
  })

  test('清单清空 ⇒ 那一带当场还回去（不留空行）', async () => {
    const stage = createStage()

    feedPlan(stage, note(step('一步', 'in_progress')))
    const withPlan = await stage.screen({ columns: 80, rows: 24 })
    expect(withPlan.has('▪ 一步')).toBe(true)

    feedPlan(stage, null, 2)
    const gone = await stage.screen({ columns: 80, rows: 24 })
    expect(gone.has('▪ 一步')).toBe(false)
    expect(gone.dock.every((line) => !/[▪■□]/u.test(line.text))).toBe(true)
    expect(nonBlank(gone)).toBe(nonBlank(withPlan) - 1)
  })
})

// ══ 乙 · `ctrl+a` / `ctrl+e` ══════════════════════════════════════════

describe('U85 · 乙 · 按键表', () => {
  test('`ctrl+a` / `ctrl+e` 认下来了（不再落到兜底那支当没人接的键）', () => {
    expect(toShellKeys('a', { ctrl: true })).toEqual([{ kind: 'lineStart' }])
    expect(toShellKeys('e', { ctrl: true })).toEqual([{ kind: 'lineEnd' }])
  })

  test('反面：不当正文字符、也不动别的键', () => {
    // 裸 `a` / `e` 照旧是正文
    expect(toShellKeys('a', {})).toEqual([{ kind: 'char', char: 'a' }])
    expect(toShellKeys('e', {})).toEqual([{ kind: 'char', char: 'e' }])
    // 既有那几个 ctrl 键一个没动——**`ctrl+w` 照旧是它自己**（本单不碰它）
    expect(toShellKeys('w', { ctrl: true })).toEqual([{ kind: 'ctrl+w' }])
    expect(toShellKeys('c', { ctrl: true })).toEqual([{ kind: 'ctrl+c' }])
    expect(toShellKeys('t', { ctrl: true })).toEqual([{ kind: 'ctrl+t' }])
    // `ctrl+b` / `ctrl+f` **不在本单**：它们照旧落到「没人接的键」那一支
    //（不是被悄悄当成正文，也不是被当成行首行末的近邻）
    expect(toShellKeys('b', { ctrl: true })).toEqual([{ kind: 'other', label: 'ctrl+b' }])
    expect(toShellKeys('f', { ctrl: true })).toEqual([{ kind: 'other', label: 'ctrl+f' }])
  })
})

describe('U85 · 乙 · 行首行末的落点（纯函数）', () => {
  test('空草稿：两个键都停在 0（不偏、也不报错）', () => {
    expect(lineSpan('', 0)).toEqual([0, 0])
  })

  test('单行：行首是 0、行末是草稿末尾', () => {
    expect(lineSpan('看这里', 2)).toEqual([0, 3])
    expect(lineSpan('看这里', 0)).toEqual([0, 3])
    expect(lineSpan('看这里', 3)).toEqual([0, 3])
  })

  test('多行：按 `\\n` 划界的**逻辑行**（不是屏上折出来的视觉行）', () => {
    // 'ab\ncdef\ngh'：下标 0'前' 1'前' 2\n 3-6'cdef' 7\n 8-9'gh'
    expect(lineSpan('ab\ncdef\ngh', 9)).toEqual([8, 10]) // 末行
    expect(lineSpan('ab\ncdef\ngh', 3)).toEqual([3, 7]) // 中间那一行
    expect(lineSpan('ab\ncdef\ngh', 7)).toEqual([3, 7]) // ⚠️ 压在 `\n` 上 ⇒ 算**左**那一边
    expect(lineSpan('ab\ncdef\ngh', 2)).toEqual([0, 2]) // 首行（它的行末就是那个 `\n`）
    expect(lineSpan('ab\ncdef\ngh', 0)).toEqual([0, 2])
  })

  test('插入点越界（手搭的视图给过大数）也夹得住', () => {
    expect(lineSpan('ab\ncd', 99)).toEqual([3, 5])
    expect(lineSpan('ab\ncd', -3)).toEqual([0, 2])
  })
})

describe('U85 · 乙 · 草稿那一头（真按键 → 外壳）', () => {
  test('空草稿：`ctrl+a` / `ctrl+e` 都停在 0', () => {
    const stage = createStage()

    stage.press(LINE_END)
    expect(stage.shell.getView().caret).toBe(0)
    stage.press(LINE_START)
    expect(stage.shell.getView().caret).toBe(0)
  })

  test('多行草稿：行首 ≠ 文首——跳到**插入点所在那一行**的开头 / 末尾', () => {
    const stage = createStage()
    stage.type('第一行')
    stage.press(NEWLINE)
    stage.type('第二行')

    const view = (): ReturnType<typeof stage.shell.getView> => stage.shell.getView()
    expect(view().draft).toBe('第一行\n第二行')
    expect(view().caret).toBe(7) // 末尾

    stage.press(LINE_START)
    expect(view().caret).toBe(4) // **第二行**的开头，不是文首
    expect(view().caret).not.toBe(0)

    stage.press(LINE_END)
    expect(view().caret).toBe(7) // 回到末尾

    // ⚠️ **末行没有尾随 `\n`**：所以「行末」与「文末」在这儿重合（都是 7）。
    // 退到第二行的行首、再左移一格 ⇒ 落在上一行那个 `\n` 上（第一行的末尾）
    stage.press(LINE_START)
    expect(view().caret).toBe(4)
    stage.press({ kind: 'left' })
    expect(view().caret).toBe(3)
    stage.press(LINE_START)
    expect(view().caret).toBe(0) // 这才到文首（第一行的行首）
    stage.press(LINE_END)
    expect(view().caret).toBe(3) // 第一行的行末＝换行符之前

    // **草稿一个字没动**（只挪插入点）
    expect(view().draft).toBe('第一行\n第二行')
  })

  test('带引用的草稿：引用一个字不动，落点也不在引用中间', () => {
    const stage = createStage()
    stage.type('看 ')
    pickFile(stage, 'src/login.ts')
    stage.type(' 这一处')
    stage.press(NEWLINE)
    stage.type('第二行')

    const before = refsOf(stage)
    expect(before.length).toBe(1)
    const marker = before[0]?.marker as string
    const draft = stage.shell.getView().draft
    expect(draft).toBe('看 @src/login.ts 这一处\n第二行')

    // 末尾 ⇒ 行首：落在**第二行**的开头（引用在上一行，一个字不动）
    stage.press(LINE_START)
    expect(stage.shell.getView().caret).toBe(draft.indexOf('\n') + 1)
    expect(stage.shell.getView().caret).not.toBe(0)
    expect(stage.shell.getView().draft).toBe(draft)
    expect(stage.shell.getView().refs).toEqual(before)

    // 再按一次行首 ⇒ 这一行的行首已经在脚下了，原地不动（不是又跳一层）
    const at = stage.shell.getView().caret
    stage.press(LINE_START)
    expect(stage.shell.getView().caret).toBe(at)

    // 退到第一行 ⇒ 行首是**文首**（在引用之前）：引用整个在身上，没被切
    stage.press({ kind: 'left' })
    stage.press(LINE_START)
    expect(stage.shell.getView().caret).toBe(0)
    const ref = before[0] as DraftRef
    expect(stage.shell.getView().draft.slice(ref.start, ref.end)).toBe(marker)
    expect(stage.shell.getView().refs).toEqual(before)

    // 行末：第一行的末尾＝那个换行符**之前**（引用仍是一个整处）
    stage.press(LINE_END)
    const end = stage.shell.getView().caret
    expect(stage.shell.getView().draft[end]).toBe('\n')
    expect(stage.shell.getView().draft.slice(0, end)).toBe('看 @src/login.ts 这一处')
    expect(stage.shell.getView().refs).toEqual(before)
  })

  test('零副作用：不发命令（与 `←` / `→` 同一条规矩）', () => {
    const stage = createStage()
    stage.type('一些字')
    const before = stage.commands().length

    stage.press(LINE_START)
    stage.press(LINE_END)

    expect(stage.commands().length).toBe(before)
  })

  test('接管（裁决）期间**不静默吞**——说一句，草稿一个字不动', async () => {
    const stage = createStage()

    stage.feed([
      event('tool.decision.request', { call: 71, name: 'exec', material: '命令 ls', weight: 'light' }, { id: 88 }),
    ])

    const before = stage.shell.getView()
    stage.press(LINE_START)
    const after = stage.shell.getView()

    expect(after.draft).toBe(before.draft)
    expect(after.refs).toEqual(before.refs)
    expect(after.caret).toBe(before.caret)
    expect(
      (await stage.screen({ columns: 100, rows: 30 })).screen.lines.some((one) =>
        one.includes('「行首」此刻不管用'),
      ),
    ).toBe(true)
  })

  test('选择器接管时什么都不做（那一屏的键归屏——不越过它去动后面的草稿）', () => {
    const stage = createStage()

    stage.type('看 ')
    stage.press({ kind: 'char', char: '@' })
    feedPaths(stage, '', [{ path: '/ws/a.txt', display: 'a.txt', kind: 'file', external: false }])
    const before = stage.shell.getView()

    stage.press(LINE_START)
    stage.press(LINE_END)

    expect(stage.shell.getView().caret).toBe(before.caret)
    expect(stage.shell.getView().draft).toBe(before.draft)
  })
})
