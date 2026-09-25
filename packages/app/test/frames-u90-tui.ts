#!/usr/bin/env bun
/**
 * U90 · **清单加「目标」表头 ＋ 步骤退一级** —— 真 PTY 留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u90-tui.ts --out <目录> [--only <场名>]
 * ```
 *
 * ## 这一单要看的四件事
 *
 * | 场 | 看什么 | 判据落在哪儿 |
 * | --- | --- | --- |
 * | `有目标` | 目标**顶格**一行 · 步骤**退一级**在它下面 | 目标那一行的第一个字在第 0 列；三条步骤都在第 2 列、且在目标**之下** |
 * | `没目标` | ⚠️ **反面**：那一行**不出现**（不留空表头） | 没有清单块的头一行是顶格文字；清单首行就是步骤 |
 * | `矮窗` | ⚠️ **本单最要紧的一条**：矮窗下**账与屏不差分家** | 真光标落在输入行那一行、草稿末尾那一列 |
 * | `模型真填` | ⑤ **模型真填得出来**：出站请求里 `plan_update` 的参数**带着 goal 那一格** | 取受控端点收到的**原文请求体** |
 *
 * 四场都用**真 `cli.ts`**（真装配、真 PTY、真终端解析）——屏上那几行是从 PTY 那头读回来的，
 * 不是渲染出来的中间物。清单由**真模型回合**（`plan_update`）建立：走的是产品那条路
 * （第 5 场就是这条路自己交出来的物证）。
 *
 * ## ⚠️ 为什么矮窗那一场另起一条会话（不 resize）
 *
 * 改窗那条路本仓有挂起的老账（D27：改窄之后记录重复、分隔线残留）。拿它来验本单，
 * 红的是**那一件**、不是本单——故各场各起一条会话，尺寸在**开机前**就定好（同 U85）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
} from './ui/index.ts'
import type { Capture, Fixture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 判据攒着最后一起报（同既有几支帧套件：改前改后各跑一遍做对照）。 */
const failures: string[] = []

function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}${detail === '' ? '' : `（${detail}）`}`)
    return
  }

  failures.push(what)
  console.log(`  ✗ ${what}${detail === '' ? '' : `（${detail}）`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格写进同名 `.json`。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify(
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
        cells: shot.lines.map((_line, row) => shot.cellsOf(row)),
      },
      null,
      1,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（${shot.columns}×${shot.rows} · 真光标 (${shot.cursor.x},${shot.cursor.y})）\n${shot.text}`)
}

// ══ 屏上的量法 ══════════════════════════════════════════════════════
//
// `shot.lines` 是**可见那一屏**（行号即视口行号，与 `shot.cursor.y` 同一把尺）。

/** 满宽分隔线的行号（整行都是 `─` 的那种）。 */
function rulesOf(shot: Capture): readonly number[] {
  return shot.lines
    .map((text, row) => ({ text, row }))
    .filter((one) => /^─+$/u.test(one.text.trim()))
    .map((one) => one.row)
}

/** **输入行**那一行（`› ` 开头的最后一条——记录区里也有 `›` 的用户行，故取最后一条）。 */
function composerRowOf(shot: Capture): number {
  return shot.lines.reduce((last, text, row) => (text.trimStart().startsWith('› ') ? row : last), -1)
}

/** 屏上含某串的第一行（-1 ＝ 没有）。 */
function rowOf(shot: Capture, needle: string): number {
  return shot.lines.findIndex((line) => line.includes(needle))
}

/** 屏上那一行**原样**（含前导空格——列号是这一单的判据之一）。 */
function lineOf(shot: Capture, needle: string): string {
  return shot.lines.find((line) => line.includes(needle)) ?? ''
}

/** 屏上有没有这一串（可见那一屏）。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 非空行有几条——「这一屏上多出/少了一行」用它。 */
function nonBlank(shot: Capture): number {
  return shot.lines.filter((text) => text.trim() !== '').length
}

// ══ 驱动 ════════════════════════════════════════════════════════════

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 按一个键——**写之前先隔一拍**（同 U71 / U78 / U85 那几支帧套件的那一条）。
 *
 * ⚠️ PTY 上两次写挨得太近，应用一次 read 会把它们**并成一块**读进来；隔一拍再写，
 * 两下就是两次读（U85 实测过）。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'esc' | 'shift+enter',
  until?: { readonly until: { readonly text: string }; readonly timeoutMs?: number },
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession, timeoutMs = 30_000): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs })
}

/** 一帧的底架：一块新沙地 ＋ 一台夹具 ＋ 一条**定好尺寸**的会话。 */
async function openScene(options: {
  readonly label: string
  readonly columns: number
  readonly rows: number
  readonly turns: readonly FixtureTurn[]
}): Promise<{ readonly session: UiSession; readonly sandbox: Sandbox; readonly fixture: Fixture }> {
  const fixture = startFixture({ turns: options.turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })

  const session = await createUiSession({
    label: options.label,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
    columns: options.columns,
    rows: options.rows,
  })
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 25_000 })

  return { session, sandbox, fixture }
}

/** 收摊：先照产品的方式退，再停夹具、删沙地。 */
async function closeScene(scene: {
  readonly session: UiSession
  readonly sandbox: Sandbox
  readonly fixture: Fixture
}): Promise<void> {
  try {
    await scene.session.quit()
  } finally {
    await scene.session.close({ graceMs: 3_000 })
    await scene.fixture.stop()
    scene.sandbox.dispose()
  }
}

// ══ 剧本 ════════════════════════════════════════════════════════════

/** 清单那一份（三条：一条已完成、一条进行中、一条未开始）。 */
const STEPS = [
  { text: '读登录逻辑', status: 'completed' },
  { text: '改提示', status: 'in_progress' },
  { text: '跑一遍', status: 'pending' },
] as const

/** 目标那一句话（这一单新加的那一行）。 */
const GOAL = '把登录失败提示改清楚'

/**
 * 方块那几格（`plan.ts` 的 `GLYPHS`）——**屏上认步骤那一行必须带上它**。
 *
 * ⚠️ 只按步骤的文字找会撞上记录区（`⏺ …正在改提示。` 那一行里也有「改提示」）。
 */
const GLYPHS: Record<string, string> = { completed: '■', in_progress: '▪', pending: '□' }

/** **步骤退一级的列数**（`plan.ts` 的 `PLAN_INDENT`）——屏上那一行的前导空格就是它。 */
const INDENT = 2

/** 清单里某一步那一行在屏上的行号（**按缩进 ＋ 方块 ＋ 文字**认）。 */
function stepRowOf(shot: Capture, one: { readonly text: string; readonly status: string }): number {
  return rowOf(shot, `${' '.repeat(INDENT)}${GLYPHS[one.status]} ${one.text}`)
}

/** 建立清单那一轮：模型先记计划、再回一句话（清单随之常驻）。 */
const PLAN_TURNS: readonly FixtureTurn[] = [
  {
    kind: 'tool',
    name: 'plan_update',
    args: { plan: { goal: GOAL, steps: STEPS, notes: '看住这一条' } },
    text: '先把计划记下来。',
  },
  { kind: 'text', text: '登录那一处读完了，正在改提示。' },
]

/** **没有目标**那一轮——同一份步骤，`goal` 整个不给。 */
const NO_GOAL_TURNS: readonly FixtureTurn[] = [
  {
    kind: 'tool',
    name: 'plan_update',
    args: { plan: { steps: STEPS, notes: '看住这一条' } },
    text: '先把计划记下来。',
  },
  { kind: 'text', text: '登录那一处读完了，正在改提示。' },
]

/**
 * 起一份清单：交代一句 ⇒ 模型记计划 ⇒ 清单上屏（走的是产品那条路）。
 *
 * `last` 是**这一场剧本里**模型最后那一句——等它上屏＝这一轮走到了头。
 */
async function makePlan(session: UiSession, last: string): Promise<void> {
  await typeLine(session, '查一下登录为什么失败')
  await pressKey(session, 'enter')
  await session.wait({ text: last }, { timeoutMs: 30_000 })
  await settled(session)
}

// ══ 场一 · 有目标那一屏（①）════════════════════════════════════════

/**
 * **目标顶格一行 · 步骤退一级**——一眼看得出「这是这件事、下面是它的步骤」。
 *
 * 判据全在**列号**上（`lineOf` 给的是原样那一行，含前导空格）：
 * 目标那一行的第一个字在**第 0 列**；三条步骤都在**第 `INDENT` 列**；且目标在步骤**之上**。
 */
async function sceneGoal(): Promise<void> {
  const scene = await openScene({ label: 'u90-有目标', columns: 100, rows: 30, turns: PLAN_TURNS })

  try {
    await makePlan(scene.session, '正在改提示')

    const shot = await scene.session.capture({ label: '①-有目标那一屏' })
    keep(shot)

    const rules = rulesOf(shot)
    check(rules.length === 2, '① 一屏**恰好两条**线（没为表头加线）', `实测 ${rules.length} 条`)
    if (rules.length !== 2) return

    const upper = rules[0] as number
    const lower = rules[1] as number

    // **目标顶格**：第 0 列就是它的第一个字
    const goalRow = rowOf(shot, GOAL)
    check(goalRow !== -1, '① 目标那一行在屏上', `行号 ${goalRow}`)
    check(
      lineOf(shot, GOAL).startsWith(GOAL),
      '① ⚠️ **目标顶格**（第 0 列就是它的第一个字，前面没有缩进）',
      `那一行是「${lineOf(shot, GOAL)}」`,
    )

    // **步骤退一级**：整块让出那一级，方块在第 `INDENT` 列
    const stepRows = STEPS.map((one) => stepRowOf(shot, one))
    check(
      stepRows.every((row) => row !== -1),
      '① 三条步骤都画出来了（缩进 ＋ 方块 ＋ 文字认出来的）',
      `行号 ${stepRows.join(' · ')}`,
    )
    // ⚠️ 认**步骤那一行**必须带上缩进与方块：只按文字找会撞上记录区
    //    （`⏺ …正在改提示。` 那一行里也有「改提示」——U85 在同一个坑里栽过）
    check(
      STEPS.every((one) => (shot.lines[stepRowOf(shot, one)] ?? '').startsWith(`${' '.repeat(INDENT)}${GLYPHS[one.status]} `)),
      '① ⚠️ **步骤退一级**（方块在第 2 列，文字在第 4 列）',
      `第一条是「${shot.lines[stepRowOf(shot, STEPS[0])] ?? ''}」`,
    )

    // **次序**：目标在步骤之上（读起来才是「这件事 → 它的步骤」）
    check(
      goalRow !== -1 && goalRow < Math.min(...stepRows),
      '① 目标在**步骤之上**（这一块的名目在先）',
      `目标在 ${goalRow}，第一条步骤在 ${Math.min(...stepRows)}`,
    )

    // 清单照旧落在**两条线之间**（U85 的判据——本单一个字没改它）
    check(
      goalRow > upper && Math.max(...stepRows) < lower,
      '① 反面：清单仍在**两条线之间**（U85 那道界没动）',
      `线的行号 ${upper} / ${lower}`,
    )
    check(
      rowOf(shot, '› 查一下登录为什么失败') < upper,
      '① 反面：滚动记录照旧在上沿线**之上**',
    )

    // 层级（看帧③）：第一眼那一行是「这件事是什么」——它不是方块行
    check(
      !/[□▪■]/u.test(lineOf(shot, GOAL)),
      '① 目标那一行**不带方块**（层次靠位置给，不靠记号）',
      lineOf(shot, GOAL),
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 场二 · 没目标那一屏（② · 反面）══════════════════════════════════

/**
 * **没有目标 ⇒ 那一行不出现**（不许留一个空表头）。
 *
 * 判据两路：① 屏上找不到那一串（本来就无从找）；② **清单块的头一行就是步骤**——
 * 这一路才是真判据（「不出现」不等于「少印了一串字」：印一条空行也是不出现，
 * 而空行会在那一带留下一格空白）。故比的是**清单那几行的相对位置与非空行数**。
 */
async function sceneNoGoal(): Promise<void> {
  const scene = await openScene({ label: 'u90-没目标', columns: 100, rows: 30, turns: NO_GOAL_TURNS })

  try {
    await makePlan(scene.session, '正在改提示')

    const shot = await scene.session.capture({ label: '②-没目标那一屏' })
    keep(shot)

    check(!has(shot, GOAL), '② ⚠️ **反面**：没有目标 ⇒ 屏上压根没有那一串')

    // **这一条才是真判据**：「不出现」不等于「少印了一串字」——印一条空行也是不出现。
    // 故量的是**清单块顶上紧挨着的那一行**：它必须是那条分隔线（＝清单的头一行就是步骤）。
    // 有目标时这一行是目标那句话（场一量过它的位置与列号）。
    const firstStep = Math.min(...STEPS.map((one) => stepRowOf(shot, one)))
    const above = shot.lines[firstStep - 1] ?? ''
    check(
      /^─+$/u.test(above.trim()),
      '② ⚠️ **反面**：清单的头一行就是步骤（上头紧挨着的是那条线，没多出一行空表头）',
      `步骤首行在 ${firstStep}，它上面那一行是「${above}」`,
    )

    // 三条步骤一个不少，且都退了一级（表头没了，步骤的形不受影响）
    check(
      STEPS.every((one) => stepRowOf(shot, one) !== -1),
      '② 三条步骤照旧都在（缩进与方块一个没动）',
    )
    check(rulesOf(shot).length === 2, '② 一屏仍是**恰好两条**线', `实测 ${rulesOf(shot).length} 条`)
  } finally {
    await closeScene(scene)
  }
}

// ══ 场三 · 矮窗那一屏（④ · ⚠️ 本单最容易弄坏的一条）════════════════

/**
 * **矮窗 ＋ 长清单 ＋ 有目标 ⇒ 真光标不许跑偏**。
 *
 * 60×14 这一档是**顶到边**的（同 U85）：账与屏差一行，Ink 就走整屏那一支、省掉末尾那个
 * 换行，**真光标当场高一行**。故判据落在**真光标**（VT 解析出来的）上：它必须落在
 * **输入行那一行**、**草稿末尾那一列**。
 *
 * ⚠️ **退一级正是最容易弄坏它的地方**：折行宽度少扣那一级，`wrap` 就会多折出一行，
 * 而账还是原来那个数——屏上多一行，矮窗当场顶满。
 */
async function sceneShort(): Promise<void> {
  // ⚠️ **第一条要长到折行**（60 − 2 − 2 ＝ 56 列装不下它）：退一级改的正是折行宽度，
  //    而**不折行就验不出那一级**——短步骤在这一场里永远不会碰到那个数。
  const steps = [
    { text: '把登录失败提示改清楚并且覆盖空密码、认证失败与网络失败三类分支再补一遍回归', status: 'pending' },
    ...Array.from({ length: 19 }, (_unused, at) => ({ text: `第 ${at + 2} 步`, status: 'pending' })),
  ]
  const turns: readonly FixtureTurn[] = [
    { kind: 'tool', name: 'plan_update', args: { plan: { goal: GOAL, steps, notes: '' } }, text: '先把计划记下来。' },
    { kind: 'text', text: '这就动手。' },
  ]

  const scene = await openScene({ label: 'u90-矮窗', columns: 60, rows: 14, turns })
  const DRAFT = '矮窗里这一句还在'

  try {
    await makePlan(scene.session, '这就动手')
    // 草稿**不提交**：它留在输入行上，「真光标落在草稿末尾」才量得出列号
    await typeLine(scene.session, DRAFT)

    const shot = await scene.session.capture({ label: '④-矮窗（账与屏不差分家）' })
    keep(shot)

    const rules = rulesOf(shot)
    check(rules.length === 2, '④ 矮窗里仍是**恰好两条**线', `实测 ${rules.length} 条`)

    // 清单真画出来了（目标那一行在、而且是行视口那一形）
    check(has(shot, GOAL) && has(shot, 'PgUp/PgDn'), '④ 目标那一行在矮窗里照旧画得出来（行视口 ＋ 溢出提示）')

    // **折行那一档**：长标题正常折、**续行对齐文字那一条线**（退一级 ＋ 方块那格）
    const wrapped = shot.lines.findIndex((line) => line.startsWith(`${' '.repeat(INDENT)}□ 把登录失败提示改清楚`))
    check(wrapped !== -1, '④ 长步骤（折行的那一条）画得出来', `行号 ${wrapped}`)
    const cont = shot.lines[wrapped + 1] ?? ''
    check(
      cont.startsWith(' '.repeat(INDENT + 2)) && cont[INDENT + 2] !== ' ',
      '④ 续行**对齐文字那一条线**（退一级 ＋ 方块那格之后，不是顶格、也不再多缩）',
      `续行是「${cont}」`,
    )
    check(has(shot, '第 20 步') || has(shot, '下面还有'), '④ 后面的步骤照旧在（视口里翻得到）')

    const composer = composerRowOf(shot)
    const textRow = rowOf(shot, DRAFT)
    check(composer !== -1 && textRow === composer, '④ 草稿那一行就是输入行那一行', `草稿在 ${textRow}，输入行在 ${composer}`)

    // ⚠️ **本单最要紧的一条**：真光标不跑偏
    check(
      shot.cursor.y === composer,
      '④ ⚠️ **真光标落在输入行那一行**（账与屏没分家——分家就是它高一行）',
      `真光标 y=${shot.cursor.y}，输入行在 ${composer}`,
    )
    // 草稿末尾那一列：左留白 1 ＋ `› ` 2 ＋ 正文 16 列（8 个汉字）= 19
    check(
      shot.cursor.x === 19,
      '④ 真光标落在**草稿末尾那一列**（列号也没偏）',
      `真光标 x=${shot.cursor.x}，应为 19（1 ＋ 2 ＋ 16）`,
    )
    check(shot.cursor.hidden === false, '④ 真光标**没被藏起来**')
    // 屏上那一份**就是整屏**（没有靠终端自己往下折出来的行：折了就是账少了一行）
    check(
      shot.lines.length === shot.rows && nonBlank(shot) <= shot.rows,
      '④ 矮窗里那一屏装得下（非空行没超过视口）',
      `非空行 ${nonBlank(shot)} ≤ 视口 ${shot.rows}`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 场四 · 模型真填得出来（⑤）═════════════════════════════════════

/**
 * **受控端点收到的原文**——`plan_update` 的参数里**带着 `goal` 那一格**，且说明说得清它是什么。
 *
 * 这一场要证的是**通路**（「模型读得到才会填」）：出站请求体里的工具表就是模型看到的那一份。
 * 用的是**真跑一轮**之后的物证（`fixture.requests()` 收的原文），不是断言提示词含某个关键词。
 *
 * 顺带把**它真落下去了**钉住：清单上目标那一行是这一轮跑出来的（不是手搭的视图）。
 */
async function sceneModel(): Promise<void> {
  const scene = await openScene({ label: 'u90-模型真填', columns: 100, rows: 30, turns: PLAN_TURNS })

  try {
    await makePlan(scene.session, '正在改提示')

    const shot = await scene.session.capture({ label: '⑤-模型真填（清单上那行是这一轮跑出来的）' })
    keep(shot)

    // —— 出站那一份：工具表里 `plan_update` 带着 goal 那一格 ——
    const sent = scene.fixture.requests().filter((one) => /\/chat\/completions$/u.test(one.path))
    check(sent.length > 0, '⑤ 真发出过对话请求（受控端点收到的原文在这儿）', `${sent.length} 次`)

    const body = sent[0]?.body ?? {}
    const tools = Array.isArray(body['tools']) ? (body['tools'] as readonly unknown[]) : []
    const update = tools.find(
      (one) => (one as { function?: { name?: string } }).function?.name === 'plan_update',
    ) as { function?: { parameters?: { properties?: { plan?: { properties?: Record<string, unknown>; required?: readonly string[] } } } } } | undefined

    const plan = update?.function?.parameters?.properties?.plan
    const goal = plan?.properties?.['goal'] as { type?: string; description?: string } | undefined

    check(goal !== undefined, '⑤ ⚠️ 出站工具表里 `plan_update` 的 `plan` **有 `goal` 那一格**（模型读得到）')
    check(goal?.type === 'string', '⑤ 它是字符串那一格', String(goal?.type))
    check(
      goal?.description !== undefined &&
        goal.description.includes('结果') &&
        goal.description.includes('用户会看到') &&
        goal.description.includes('不给'),
      '⑤ 说明里点明了**是什么 · 给谁看 · 可选**（说清了，模型才会填）',
      goal?.description ?? '（没有说明）',
    )
    check(
      plan?.required?.includes('goal') !== true,
      '⑤ 它**不在必填那一栏**（没有目标是一件合法的事）',
    )

    // 两道口**说的是同一件事**：工具说明说「填在哪儿」，系统提示词也得说「填在哪儿」——
    // 只改一处，模型就会照另一处把目标写进辅助笔记（U90 之前那一句正是这么写的）。
    // 取的是**真发出去的那一份**请求（不是源文件里那句），口径同本场第一格。
    const messages = Array.isArray(body['messages']) ? (body['messages'] as readonly unknown[]) : []
    const system = messages.find((one) => (one as { role?: string }).role === 'system')
    const systemText =
      typeof (system as { content?: unknown })?.content === 'string'
        ? String((system as { content: string }).content)
        : JSON.stringify((system as { content?: unknown })?.content ?? '')
    check(
      systemText.includes('goal'),
      '⑤ 系统提示词里也点到了 `goal`（两道口对得上：一处没说，模型就写在别处）',
    )

    // —— 真落下去：清单上目标那一行是这一轮跑出来的 ——
    check(
      lineOf(shot, GOAL).startsWith(GOAL),
      '⑤ 目标那一行**真上了屏**（这一轮跑完的样子）',
      `「${lineOf(shot, GOAL)}」`,
    )

    // —— 回填那一轮：**「目标：…」真回到了模型手上** ——
    //
    // 这一条量的是**端点收到的原文**（不是屏上）：成功的辅助工具不刷工具卡（设计明写），
    // 故回执在屏上压根不该出现——而它必须出现在**下一次请求的消息里**
    // （模型据此知道自己写的目标是什么）。取第 2 次请求（第一次是那一轮的计划更新，
    // 回填之后才有了它）。
    const back = sent.slice(1).map((one) => JSON.stringify(one.body['messages'] ?? []))
    check(
      back.some((text) => text.includes(`目标：${GOAL}`)),
      '⑤ 回填那一轮里「目标：…」随工具结果**回到了模型手上**（它看得到自己写的目标）',
      `第 2 次请求里${back.some((text) => text.includes(`目标：${GOAL}`)) ? '有' : '没有'}`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u90-') : (process.argv[at + 1] as string)
  const only = process.argv.includes('--only')
    ? (process.argv[process.argv.indexOf('--only') + 1] as string)
    : ''
  mkdirSync(root, { recursive: true })
  out = root

  const wanted = (name: string): boolean => only === '' || only === name

  try {
    if (wanted('有目标')) {
      console.log('\n══ 场一 · 有目标那一屏（目标顶格 ＋ 步骤退一级）══')
      await sceneGoal()
    }

    if (wanted('没目标')) {
      console.log('\n══ 场二 · 没目标那一屏（② 反面：那一行不出现）══')
      await sceneNoGoal()
    }

    if (wanted('矮窗')) {
      console.log('\n══ 场三 · 矮窗（账与屏不差分家 · ⚠️ 最要紧的一条）══')
      await sceneShort()
    }

    if (wanted('模型真填')) {
      console.log('\n══ 场四 · 模型真填得出来（⑤ 出站原文）══')
      await sceneModel()
    }
  } finally {
    if (failures.length === 0) {
      console.log(`\n全部判据通过。帧落在 ${out}`)
    } else {
      console.log(`\n${failures.length} 条判据不过：`)
      for (const what of failures) console.log(`  ✗ ${what}`)
      console.log(`帧落在 ${out}`)
      process.exitCode = 1
    }

    if (at === -1) removeDir(root)
  }
}
