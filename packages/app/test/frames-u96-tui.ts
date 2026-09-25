#!/usr/bin/env bun
/**
 * U96 · **有清单 ＋ 空草稿时，真光标是藏着的** —— 真 PTY 留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u96-tui.ts --out <目录> [--only <场名>]
 * ```
 *
 * ## 查出来的根子（改的地方只有一处，六行）
 *
 * `AppView` 根盒子那几个孩子里，**恒在的那几格**（两条分隔线、交互区那个盒子、状态行）
 * 原先**都没有 key**，而记录区那几条（`Static` 与本轮那几行）**有**。React 对数组里
 * 没有 key 的孩子**按下标配对**——记录区条数一变（模型那一轮落定、流式长出一行……），
 * 后面那几个的下标跟着挪 ⇒ 配不上 ⇒ **整块重挂**。`Composer` 一重挂，`anchor` 那一格
 * 归零，那一趟传出去的就是 `setCursorPosition(undefined)` ⇒ **真光标先藏一帧**。
 *
 * 探针量到的原样：改前 100×30 那一屏，「模型答完落定」那一下 `Composer` **重挂了 7 次**
 * （记录区每变一次挂一次），其中落定那一次 `spot: null`。改后同一个本子跑下来 **1 次**
 * （只有开机那一次）。
 *
 * ## 这一单要看的五件事
 *
 * | 场 | 看什么 | 判据落在哪儿 |
 * | --- | --- | --- |
 * | `有清单` | ⚠️ **本单最要紧的一条**：有清单 ＋ 空草稿 ⇒ 真光标可见、落在输入行草稿末尾 | 落定**那一刻**取的第一帧（改前正是它藏着） |
 * | `打字` | 同一屏打一个字，光标**不跳** | 两帧的 `y` 逐字相同、`x` 只挪那一格 |
 * | `无清单` | **反面**：无清单 ＋ 空草稿 ⇒ 既有行为一个字不动 | 那一屏逐字比（同时留改前那一份） |
 * | `接管` | **反面**：裁决卡 / 选择器那两屏**照旧藏** | 那两屏 `cursor.hidden === true` |
 * | `矮窗` | **反面**：矮窗下账与屏不差分家（U85 那笔老账） | 真光标落在输入行那一行、草稿末尾那一列 |
 *
 * ## ⚠️ 为什么每场各起一条会话（不 resize）
 *
 * 改窗那条路本仓有挂起的老账（D27：改窄之后记录重复、分隔线残留）。拿它来验本单，
 * 红的是**那一件**、不是本单——故各场在**开机前**就把尺寸定好。
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
import { tempDir } from './tmp.ts'

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
  console.log(
    `\n── ${shot.label} ──（${shot.columns}×${shot.rows} · 真光标 ${cursorOf(shot.cursor)}）\n${shot.text}`,
  )
}

// ══ 屏上的量法 ══════════════════════════════════════════════════════
//
// `shot.lines` 是**可见那一屏**（行号即视口行号，与 `shot.cursor.y` 同一把尺）。

/** **输入行**那一行（`› ` 开头的最后一条——记录区里也有 `›` 的用户行，故取最后一条）。 */
function composerRowOf(shot: Capture): number {
  return shot.lines.reduce((last, text, row) => (text.trimStart().startsWith('› ') ? row : last), -1)
}

/** 屏上含某串的第一行（-1 ＝ 没有）。 */
function rowOf(shot: Capture, needle: string): number {
  return shot.lines.findIndex((line) => line.includes(needle))
}

/** 屏上有没有这一串（可见那一屏）。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

/** 真光标那一格的一句话描述（判据的详情栏用它）。 */
function cursorOf(cursor: { readonly x: number; readonly y: number; readonly hidden: boolean }): string {
  return `(${cursor.x},${cursor.y})${cursor.hidden ? '隐藏' : '可见'}`
}

/** 满宽分隔线的行号（整行都是 `─` 的那种）。 */
function rulesOf(shot: Capture): readonly number[] {
  return shot.lines
    .map((text, row) => ({ text, row }))
    .filter((one) => /^─+$/u.test(one.text.trim()))
    .map((one) => one.row)
}

// ══ 驱动 ════════════════════════════════════════════════════════════

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 等真光标**真走到某一格**（`capture` 是当下这一刻的读数，轮询到为止）。 */
async function waitCursor(
  session: UiSession,
  want: { readonly x: number; readonly y: number },
): Promise<void> {
  for (let at = 0; at < 100; at += 1) {
    const { cursor } = await session.screen()
    if (cursor.x === want.x && cursor.y === want.y) return

    await Bun.sleep(40)
  }

  const { cursor } = await session.screen()
  throw new Error(`真光标一直没走到 (${want.x},${want.y})——此刻在 (${cursor.x},${cursor.y})`)
}

/**
 * 等真光标**落到输入行草稿末尾那一格**（屏稳下来之后的样子）——轮询到为止，超时抛。
 *
 * ⚠️ **判「它摆正了没有」必须轮询**：真光标的位置是**量在 effect 里**的（`Composer` 那一支），
 * 天生比布局**慢一趟写入**——那一趟用的还是上一趟量到的锚（Ink 的节流窗口约 34ms，
 * 实测归位在 100ms 内）。故「落定那一刻」与「摆正之后」是**两件事**，本套件分开判：
 * 前者判**藏没藏**（本单咬住的那一条），后者判**在不在该在的那一格**。
 */
async function waitAtDraftEnd(session: UiSession): Promise<{ readonly x: number; readonly y: number }> {
  for (let at = 0; at < 60; at += 1) {
    const screen = await session.screen()
    const composer = screen.lines.reduce(
      (last, line, row) => (line.text.trimStart().startsWith('› ') ? row : last),
      -1,
    )
    if (
      composer !== -1 &&
      screen.cursor.hidden === false &&
      screen.cursor.y === composer &&
      screen.cursor.x === 3
    ) {
      return { x: screen.cursor.x, y: screen.cursor.y }
    }

    await Bun.sleep(50)
  }

  const screen = await session.screen()
  throw new Error(`真光标一直没落到输入行草稿末尾——此刻 ${cursorOf(screen.cursor)}`)
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

/** 建立清单那一轮：模型先记计划、再回一句话（清单随之常驻）。 */
const PLAN_TURNS: readonly FixtureTurn[] = [
  {
    kind: 'tool',
    name: 'plan_update',
    args: { plan: { steps: STEPS, notes: '看住这一条' } },
    text: '先把计划记下来。',
  },
  { kind: 'text', text: '登录那一处读完了，正在改提示。' },
]

/** 没有清单的对照（模型只回一句话）。 */
const PLAIN_TURNS: readonly FixtureTurn[] = [{ kind: 'text', text: '登录那一处读完了，正在改提示。' }]

/**
 * 起一份清单：交代一句 ⇒ 模型记计划 ⇒ 清单上屏（走的是产品那条路）。
 *
 * ⚠️ **等的是「这一轮收束」**（状态行回到空闲）——本单量的是**落定那一刻**的屏，
 * 故 `settled()` 一返回就得取帧，中间不许再插等待（改前那一帧正是藏着的）。
 */
async function makeOneTurn(session: UiSession): Promise<void> {
  await typeLine(session, '查一下登录为什么失败')
  await session.key('enter')
  await session.wait({ text: '正在改提示' }, { timeoutMs: 30_000 })
  await settled(session)
}

// ══ 场一 · 有清单 ＋ 空草稿（⚠️ 本单最要紧的一条）════════════════════

/**
 * **落定那一刻不藏，屏稳下来就在输入行草稿末尾那一格**。
 *
 * 改前：落定那一刻 `cursor.hidden === true`、光标停在屏末（真光标被那一趟重挂抹掉了）。
 * 判据因此分成两条：
 *
 * - **藏没藏**——量落定**那一刻**（连取三帧、中间不睡）：改前正是它藏着；
 * - **在不在那一格**——等屏稳下来再看（`waitAtDraftEnd`）。
 *
 * ⚠️ **第二条改前也过**（约 100ms 后自己就摆回去了）——它是个**不该退化**的护栏，
 * 不是本单咬出来的那一条：本单咬住的是**藏**。见 `waitAtDraftEnd` 那段注。
 */
async function scenePlan(): Promise<{ readonly shot: Capture } | null> {
  const scene = await openScene({ label: 'u96-有清单', columns: 100, rows: 30, turns: PLAN_TURNS })

  try {
    await makeOneTurn(scene.session)

    // ⚠️ **三帧连取、中间不睡**：判据落在落定**那一刻**（改前藏的正是它）
    const shots = [
      await scene.session.capture({ label: '①-有清单空草稿（落定第一帧）' }),
      await scene.session.capture({ label: '①-有清单空草稿（再一帧）' }),
      await scene.session.capture({ label: '①-有清单空草稿（第三帧）' }),
    ]
    for (const shot of shots) keep(shot)

    const first = shots[0] as Capture

    check(has(first, '▪ 改提示'), '① 前提：清单真在屏上（不然这一场量的是空屏）')
    check(composerRowOf(first) !== -1, '① 前提：输入行那一行真在屏上')
    check(
      shots.every((shot) => shot.cursor.hidden === false),
      '① ⚠️ **本单最要紧的一条**：落定**那一刻**（三帧连取）真光标**都不是藏着的**',
      shots.map((shot) => cursorOf(shot.cursor)).join(' · '),
    )

    // 位置那一格**等它摆正**（真光标的位置量在 effect 里，天生慢一趟写入——见 `waitAtDraftEnd`）
    const at = await waitAtDraftEnd(scene.session)
    const calm = await scene.session.capture({ label: '①-有清单空草稿（屏稳下来）' })
    keep(calm)
    check(
      calm.cursor.x === 3 && calm.cursor.y === composerRowOf(calm),
      '① 真光标落在**输入行草稿末尾那一格**（屏稳下来之后）',
      `真光标 (${at.x},${at.y})，输入行在 ${composerRowOf(calm)}`,
    )

    return { shot: first }
  } finally {
    await closeScene(scene)
  }
}

// ══ 场二 · 打一个字，光标不跳 ═══════════════════════════════════════

/**
 * **同一屏打一个字 ⇒ 真光标只往右挪一格、`y` 一个字不动**。
 *
 * 由头：改前空草稿那一帧光标是藏着的，打一个字之后落定到 (4, y)——**位置也是对的那一格**，
 * 故「打一个字才看得见」被当成正常。本单要的是「**打之前它就在那儿**」；这一场钉的是
 * 「打的那一下**不跳**」（可见状态与打第一个字之间不该有位移）。
 */
async function sceneTyping(): Promise<void> {
  const scene = await openScene({ label: 'u96-打字', columns: 100, rows: 30, turns: PLAN_TURNS })

  try {
    await makeOneTurn(scene.session)

    // 先等它摆正（不然量到的是「落定那一趟写入」留下的旧位置，见 `waitAtDraftEnd`）
    await waitAtDraftEnd(scene.session)

    const blank = await scene.session.capture({ label: '②-00-空草稿' })
    keep(blank)
    const composer = composerRowOf(blank)

    await scene.session.send('x', { until: { text: 'x' }, timeoutMs: 10_000 })
    await waitCursor(scene.session, { x: 4, y: composer })

    const typed = await scene.session.capture({ label: '②-01-打一个字之后' })
    keep(typed)

    check(typed.cursor.y === blank.cursor.y, '② 打一个字之后真光标**不跳**（y 一个字不动）', `空草稿 y=${blank.cursor.y} → 打字后 y=${typed.cursor.y}`)
    check(typed.cursor.x === blank.cursor.x + 1, '② 只往右挪**那一格**（草稿末尾跟着走）', `x ${blank.cursor.x} → ${typed.cursor.x}`)
    check(typed.cursor.hidden === false, '② 打字之后照旧**可见**')
    check(
      rowOf(typed, 'x') === composer,
      '② 那一格落在输入行里（不是记录区）',
      `含 x 的行 ${rowOf(typed, 'x')}，输入行 ${composer}`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 场三 · 反面：无清单 ＋ 空草稿（既有行为一个字不动）══════════════

/**
 * **同一屏去掉清单，照旧落在那一格**——「既有行为一个字不动」。
 *
 * ⚠️ **「一个字不动」是对着改前那一份比的**（同一支套件在**退回修法**的树上跑一遍、
 * `--out 改前`，两份 `.txt` 逐字 diff——见回报「逐字比」那一节），不在本文件里判：
 * 本文件里内置一份期望文本＝把当时的屏抄一遍，屏一改就假红。
 * 这里判的是**这一屏自己该有的样子**：没有清单、真光标落在草稿末尾那一格。
 */
async function scenePlain(): Promise<void> {
  const scene = await openScene({ label: 'u96-无清单', columns: 100, rows: 30, turns: PLAIN_TURNS })

  try {
    await makeOneTurn(scene.session)

    // 落定那一刻连取三帧——**没有清单也照量**：同一个根子（重挂）与清单无关，
    // 清单只是让它**每次都撞上**（实测：无清单那一档改前是**偶发**，改后不会）
    const shots = [
      await scene.session.capture({ label: '③-无清单空草稿' }),
      await scene.session.capture({ label: '③-无清单空草稿（再一帧）' }),
      await scene.session.capture({ label: '③-无清单空草稿（第三帧）' }),
    ]
    for (const shot of shots) keep(shot)

    const shot = shots[0] as Capture
    check(
      !has(shot, '▪ 改提示') && !has(shot, '□ 跑一遍'),
      '③ 反面：这一屏上**没有清单**（对照才成立）',
    )
    check(
      shots.every((one) => one.cursor.hidden === false),
      '③ 反面：落定**那一刻**真光标也不该是藏着的（同一个根子，与清单无关）',
      shots.map((one) => cursorOf(one.cursor)).join(' · '),
    )

    const at = await waitAtDraftEnd(scene.session)
    const calm = await scene.session.capture({ label: '③-无清单空草稿（屏稳下来）' })
    keep(calm)
    check(
      at.x === 3 && at.y === composerRowOf(calm),
      '③ 反面：无清单 ＋ 空草稿 ⇒ 真光标照旧落在**输入行草稿末尾那一格**',
      `真光标 (${at.x},${at.y})，输入行在 ${composerRowOf(calm)}`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 场四 · 反面：该藏的照旧藏（接管 / 选择器）════════════════════════

/**
 * **裁决卡与选择器那两屏，真光标照旧藏着**——那两个「藏」是有意的（`D29`：那一刻打不进字），
 * 本单改的是「清单在场时不该藏」，**不是把判据撤了**。
 */
async function sceneTakeover(): Promise<void> {
  // —— 裁决卡（接管态不画输入行）——
  const card = await openScene({
    label: 'u96-裁决卡',
    columns: 100,
    rows: 30,
    turns: [
      { kind: 'tool', name: 'write', args: { path: 'note.txt', content: '第一版' } },
      // 第二幕要有：拒绝之后内核会再问一次模型（同 `frames-u59-tui.ts` 那一处注）
      { kind: 'text', text: '好，那先不动它。' },
    ],
  })

  try {
    await typeLine(card.session, '改个文件')
    await card.session.key('enter')
    await card.session.wait({ text: 'y 批准' }, { timeoutMs: 30_000 })

    const shot = await card.session.capture({ label: '④-01-裁决卡开着' })
    keep(shot)
    check(has(shot, 'y 批准'), '④ 前提：裁决卡真在屏上')
    // 接管态不画输入行（D29）——最后一条 `› ` 是**记录区**里那句交代（在上沿线之上），
    // 交互区那一带只有卡（`composerRowOf` 取的是全屏最后一条 `› `，故位置才是判据）
    const upper = rulesOf(shot)[0] ?? -1
    check(
      composerRowOf(shot) !== -1 && composerRowOf(shot) < upper,
      '④ 前提：接管态**不画输入行**（D29——最后那条 `› ` 在记录区里）',
      `最后一条 › 在 ${composerRowOf(shot)}，上沿线在 ${upper}`,
    )
    check(shot.cursor.hidden === true, '④ ⚠️ 反面：裁决卡那一屏真光标**照旧藏着**', `实测 ${cursorOf(shot.cursor)}`)

    await card.session.send('n') // 干净退场（卡还挂着时 ctrl+c 是中断）
    await card.session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 30_000 })
  } finally {
    await closeScene(card)
  }

  // —— 选择器（`/resume`：查询是抽屉自己的，不画输入行）——
  const picker = await openScene({
    label: 'u96-选择器',
    columns: 100,
    rows: 30,
    turns: PLAIN_TURNS,
  })

  try {
    // 先真走一轮——抽屉里得有东西可列（空目录不是这一场要看的）
    await makeOneTurn(picker.session)

    await typeLine(picker.session, '/resume')
    await picker.session.key('enter')
    await picker.session.wait({ text: '正在用' }, { timeoutMs: 20_000 })

    const shot = await picker.session.capture({ label: '④-02-选择器开着' })
    keep(shot)
    check(has(shot, '正在用'), '④ 前提：候选真在屏上（不是空抽屉）')
    check(shot.cursor.hidden === true, '④ ⚠️ 反面：选择器那一屏真光标**照旧藏着**', `实测 ${cursorOf(shot.cursor)}`)

    await picker.session.key('esc')
  } finally {
    await closeScene(picker)
  }
}

// ══ 场五 · 反面：矮窗下账与屏不差分家（U85 那笔老账）════════════════

/**
 * **60×14 那一档是顶到边的**：活动区 ＋ 清单 ＋ 两条线 ＋ 输入行 ＋ 状态行 ＝ `rows − 1`，
 * 账与屏差一行，Ink 就走整屏那一支 ⇒ **真光标当场高一行**。故判据落在真光标的 `(x, y)`。
 *
 * 这一场**空草稿那一帧也要量**（U96 的主场就是它）——矮窗上清单把屏占满，
 * 「清单在场」这一形在这儿是最挤的。
 */
async function sceneShort(): Promise<void> {
  const steps = Array.from({ length: 20 }, (_unused, at) => ({ text: `第 ${at + 1} 步`, status: 'pending' }))
  const turns: readonly FixtureTurn[] = [
    { kind: 'tool', name: 'plan_update', args: { plan: { steps, notes: '' } }, text: '先把计划记下来。' },
    { kind: 'text', text: '这就动手。' },
  ]

  const scene = await openScene({ label: 'u96-矮窗', columns: 60, rows: 14, turns })
  const DRAFT = '矮窗里这一句还在'

  try {
    await typeLine(scene.session, '查一下登录为什么失败')
    await scene.session.key('enter')
    await scene.session.wait({ text: '这就动手' }, { timeoutMs: 30_000 })

    // **落定那一刻**（空草稿）——单子上那一条在矮窗上的样子
    const blank = await scene.session.capture({ label: '⑤-01-矮窗空草稿（落定第一帧）' })
    keep(blank)
    check(blank.cursor.hidden === false, '⑤ 矮窗 ＋ 空草稿：落定那一刻真光标**不藏**', `实测 ${cursorOf(blank.cursor)}`)

    const at = await waitAtDraftEnd(scene.session)
    const calm = await scene.session.capture({ label: '⑤-01b-矮窗空草稿（屏稳下来）' })
    keep(calm)
    check(
      at.y === composerRowOf(calm),
      '⑤ 矮窗 ＋ 空草稿：真光标落在**输入行那一行**',
      `真光标 y=${at.y}，输入行在 ${composerRowOf(calm)}`,
    )

    // 草稿**不提交**：它留在输入行上，「真光标落在草稿末尾」才量得出列号
    await typeLine(scene.session, DRAFT)
    await waitCursor(scene.session, { x: 19, y: composerRowOf(calm) })

    const shot = await scene.session.capture({ label: '⑤-02-矮窗（账与屏不差分家）' })
    keep(shot)

    check(has(shot, '第 1 步') && has(shot, 'PgUp/PgDn'), '⑤ 清单在矮窗里照旧画得出来（行视口 ＋ 溢出提示）')
    check(shot.cursor.hidden === false, '⑤ 真光标**没被藏起来**')
    check(
      shot.cursor.y === composerRowOf(shot),
      '⑤ ⚠️ **真光标落在输入行那一行**（账与屏没分家——分家就是它高一行）',
      `真光标 y=${shot.cursor.y}，输入行在 ${composerRowOf(shot)}`,
    )
    check(
      shot.cursor.x === 19,
      '⑤ 真光标落在**草稿末尾那一列**（列号也没偏）',
      `真光标 x=${shot.cursor.x}，应为 19（1 ＋ 2 ＋ 16）`,
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ════════════════════════════════════════════════════════════

const args = process.argv.slice(2)
const outAt = args.indexOf('--out')
out = outAt === -1 ? tempDir('u96-frames') : (args[outAt + 1] as string)
const onlyAt = args.indexOf('--only')
const only = onlyAt === -1 ? null : (args[onlyAt + 1] as string)

mkdirSync(out, { recursive: true })
console.log(`产物目录：${out}`)

const scenes: readonly (readonly [string, () => Promise<unknown>])[] = [
  ['有清单', scenePlan],
  ['打字', sceneTyping],
  ['无清单', scenePlain],
  ['接管', sceneTakeover],
  ['矮窗', sceneShort],
]

for (const [name, run] of scenes) {
  if (only !== null && only !== name) continue

  console.log(`\n══ ${name} ══`)
  try {
    await run()
  } catch (error) {
    failures.push(`${name}：${String(error)}`)
    console.log(`  ✗ ${name}：抛了——${String(error)}`)
  }
}

console.log(`\n共 ${failures.length} 条不成立`)
for (const one of failures) console.log(`  ✗ ${one}`)

process.exit(failures.length === 0 ? 0 : 1)
