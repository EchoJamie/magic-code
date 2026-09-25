#!/usr/bin/env bun
/**
 * U85 · **清单与滚动记录分开** ＋ **`ctrl+a` / `ctrl+e` 行首行末** —— 真 PTY 留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/app/test/frames-u85-tui.ts --out <目录> [--only <场名>]
 * ```
 *
 * ## 这一单要看的四件事
 *
 * | 场 | 看什么 | 判据落在哪儿 |
 * | --- | --- | --- |
 * | `清单` | 有清单那一屏：它与上面的滚动记录**看得出界** | 清单那几行在**两条线之间**、记录在上沿线之上 |
 * | `矮窗` | ⚠️ **本单最要紧的一条**：矮窗（`rows` 很小）下**账与屏不差分家** | 真光标的 `(x, y)` 落在输入行那一行、那一列的草稿末尾 |
 * | `行首` | `ctrl+a` / `ctrl+e` 跳到**那一行**的两端 | 真光标的列 ＋ 屏上的草稿与引用 |
 * | `行末` | 同上（两屏一起留，改前改后好对照） | 同上 |
 *
 * 四场都用**真 `cli.ts`**（真装配、真 PTY、真终端解析）——屏上那几行是从 PTY 那头读回来的，
 * 不是渲染出来的中间物。清单由**真模型回合**（`plan_update`）建立：走的是产品那条路。
 *
 * ## 反面那两格也一并留着
 *
 * - **一屏恰好两条线**（`清单` 那一场顺手钉住）——本单**不加第三条线**，靠的是现成那条；
 * - **光标的 `y` 就是那一行**（`矮窗` 那一场）——账与屏分家的症状正是「真光标高一行」，
 *   故这里量的是**真光标**（VT 解析出来的那个），不是画出来的那一格。
 *
 * ## ⚠️ 为什么矮窗那一场另起一条会话（不 resize）
 *
 * 改窗那条路本仓有挂起的老账（D27：改窄之后记录重复、分隔线残留）。拿它来验本单，
 * 红的是**那一件**、不是本单——故四场各起一条会话，尺寸在**开机前**就定好。
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
// `shot.lines` 是**可见那一屏**（行号即视口行号，与 `shot.cursor.y` 同一把尺）——
// 故「谁在谁之上」直接按行号比，不必再换算缓冲行。

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

/** 屏上有没有这一串（可见那一屏）。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

// ══ 驱动 ════════════════════════════════════════════════════════════

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 按一个键——**写之前先隔一拍**（同 U71 / U78 那两支帧套件的那一条）。
 *
 * ⚠️ PTY 上两次写挨得太近，应用一次 read 会把它们**并成一块**读进来：`ctrl+a` 与紧接的
 * 正文挤在一个读块里时，Ink 那条解析会把整块当**一串正文字符**（`key.ctrl` 不成立）——
 * 于是那一按不生效，而正文照样进了草稿（本单实测过）。隔一拍再写，两下就是两次读。
 */
async function pressKey(
  session: UiSession,
  name: 'enter' | 'esc' | 'shift+enter' | 'ctrl+a' | 'ctrl+e' | 'up' | 'down' | 'left' | 'right',
  until?: { readonly until: { readonly text: string }; readonly timeoutMs?: number },
): Promise<void> {
  await Bun.sleep(150)
  await session.key(name, until)
}

/**
 * 等真光标**真走到某一格**——`screen()` 是**当下这一刻**的读数，轮询到为止。
 *
 * ⚠️ **不能写完就取帧**：`session.key` 只保证字节写出去了，应用那一趟重绘是**后**发生的，
 *    `capture()` 只等 VT 把**已收到**的字节解完——它不等应用再产出新字节。实测：`ctrl+a`
 *    按下去之后立刻取帧，读到的还是**上一下**的位置（本单第一趟就是这么红的）。
 *    由头同 `frames-tab-reprint.ts` 的 `waitCursorMove`（连写两下方向键会并成一块、
 *    Ink 一次只解一个）。
 */
async function waitCursor(session: UiSession, want: { readonly x: number; readonly y: number }): Promise<void> {
  for (let at = 0; at < 100; at += 1) {
    const { cursor } = await session.screen()
    if (cursor.x === want.x && cursor.y === want.y) return

    await Bun.sleep(40)
  }

  const { cursor } = await session.screen()
  throw new Error(`真光标一直没走到 (${want.x},${want.y})——此刻在 (${cursor.x},${cursor.y})`)
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession, timeoutMs = 30_000): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs })
}

/** 往工作区里放一个文件（建目录）。 */
function put(workspace: string, path: string, text: string): string {
  const full = join(workspace, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text, 'utf8')

  return full
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

/**
 * 方块那几格（`plan.ts` 的 `GLYPHS`）——**屏上认清单那一行必须带上它**。
 *
 * ⚠️ 只按步骤的文字找会撞上记录区：`⏺ 登录那一处读完了，正在改提示。` 那一行里也有
 *    「改提示」四个字（本单实测——判据当场指到了记录区那一行）。带上方块就不会误认：
 *    记录区那些行是 `› ` / `⏺ ` / `● ` 起头。
 */
const GLYPHS: Record<string, string> = { completed: '■', in_progress: '▪', pending: '□' }

/** 清单里某一步那一行在屏上的行号（**按方块 ＋ 文字**认）。 */
function stepRowOf(shot: Capture, one: { readonly text: string; readonly status: string }): number {
  return rowOf(shot, `${GLYPHS[one.status]} ${one.text}`)
}

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

/**
 * 起一份清单：交代一句 ⇒ 模型记计划 ⇒ 清单上屏（走的是产品那条路）。
 *
 * `last` 是**这一场剧本里**模型最后那一句——等它上屏＝这一轮走到了头（各场那句话不同，
 * 故由调用方给；拿别场的那句当条件是等不到的）。
 */
async function makePlan(session: UiSession, last: string): Promise<void> {
  await typeLine(session, '查一下登录为什么失败')
  await pressKey(session, 'enter')
  await session.wait({ text: last }, { timeoutMs: 30_000 })
  await settled(session)
}

// ══ 场一 · 有清单那一屏（甲）════════════════════════════════════════

/**
 * **清单与滚动记录看得出界**——一屏上：记录区（`› …` / `⏺ …`）→ **上沿线** → 清单 →
 * 输入行 → **下沿线** → 状态行。
 *
 * 判据全在**行号**上：清单那三行必须落在两条线**之间**（改前它们在线**之上**，
 * 与记录区混成一片——那正是 D43 用户说的「看不出分隔」）。
 */
async function scenePlan(): Promise<void> {
  const scene = await openScene({ label: 'u85-清单', columns: 100, rows: 30, turns: PLAN_TURNS })

  try {
    await makePlan(scene.session, '正在改提示')

    const shot = await scene.session.capture({ label: '①-有清单那一屏' })
    keep(shot)

    const rules = rulesOf(shot)
    check(rules.length === 2, '① 一屏**恰好两条**线（没为清单加第三条）', `实测 ${rules.length} 条`)
    if (rules.length !== 2) return

    const upper = rules[0] as number
    const lower = rules[1] as number

    // 三条步骤：一条都不许落在记录区那一侧
    const stepRows = STEPS.map((one) => stepRowOf(shot, one))
    check(
      stepRows.every((row) => row > upper && row < lower),
      '① ⚠️ **本单最要紧的一条**：清单三行都在**两条线之间**（上沿线之下、下沿线之上）',
      `线的行号 ${upper} / ${lower}，清单行号 ${stepRows.join(' · ')}`,
    )
    check(
      rowOf(shot, '■ 读登录逻辑') > upper,
      '① 那三行在**上沿线之下**（改前它们在上面——与滚动记录混成一片）',
      `上沿线在 ${upper}，第一行清单在 ${rowOf(shot, '■ 读登录逻辑')}`,
    )

    // 滚动记录（用户交代与模型答复）仍在上沿线**之上**
    const userRow = rowOf(shot, '› 查一下登录为什么失败')
    check(
      userRow !== -1 && userRow < upper,
      '① 滚动记录照旧在上沿线**之上**（这一单没动记录区）',
      `用户那一行在 ${userRow}`,
    )

    // 清单在输入行**之上**、两者同侧；状态行在下沿线**之下**
    const composer = composerRowOf(shot)
    check(
      stepRows.every((row) => row < composer),
      '① 清单在**输入行之上**（同在交互区那一带）',
      `清单末行 ${Math.max(...stepRows)}，输入行 ${composer}`,
    )
    check(
      composer > upper && composer < lower,
      '① 输入行仍夹在两条线之间（U45/U59 划的界一个没动）',
      `输入行 ${composer}`,
    )
    check(
      has(shot, '空闲') && shot.lines.findIndex((line) => line.includes('空闲')) > lower,
      '① 状态行仍在下沿线**之下**',
    )
  } finally {
    await closeScene(scene)
  }
}

// ══ 场二 · 矮窗那一屏（账与屏不差分家 · ⚠️ 本单最要紧的一条）════════

/**
 * **矮窗 ＋ 长清单 ⇒ 真光标不许跑偏**。
 *
 * 60×14 这一档是**顶到边**的：活动区 3 ＋ 清单 6 ＋ 两条线 ＋ 输入行 1 ＋ 状态行 1 ＝ 13
 * ＝ `rows − 1`（动态帧能占的上限）。账与屏在这儿差一行，Ink 就走整屏那一支、省掉末尾
 * 那个换行，**真光标当场高一行**——故判据落在**真光标**（VT 解析出来的）上：
 * 它必须落在**输入行那一行**、**草稿末尾那一列**。
 */
async function sceneShort(): Promise<void> {
  const steps = Array.from({ length: 20 }, (_unused, at) => ({ text: `第 ${at + 1} 步`, status: 'pending' }))
  const turns: readonly FixtureTurn[] = [
    { kind: 'tool', name: 'plan_update', args: { plan: { steps, notes: '' } }, text: '先把计划记下来。' },
    { kind: 'text', text: '这就动手。' },
  ]

  const scene = await openScene({ label: 'u85-矮窗', columns: 60, rows: 14, turns })
  const DRAFT = '矮窗里这一句还在'

  try {
    await makePlan(scene.session, '这就动手')
    // 草稿**不提交**：它留在输入行上，「真光标落在草稿末尾」才量得出列号
    await typeLine(scene.session, DRAFT)

    const shot = await scene.session.capture({ label: '②-矮窗（账与屏不差分家）' })
    keep(shot)

    const rules = rulesOf(shot)
    check(rules.length === 2, '② 矮窗里仍是**恰好两条**线', `实测 ${rules.length} 条`)

    // 清单真画出来了，而且是**行视口**那一形（放不下 ⇒ 溢出提示）
    check(has(shot, '第 1 步') && has(shot, 'PgUp/PgDn'), '② 清单在矮窗里照旧画得出来（行视口 ＋ 溢出提示）')

    const composer = composerRowOf(shot)
    const textRow = rowOf(shot, DRAFT)
    check(composer !== -1 && textRow === composer, '② 草稿那一行就是输入行那一行', `草稿在 ${textRow}，输入行在 ${composer}`)

    // ⚠️ **本单最要紧的一条**：真光标不跑偏
    check(
      shot.cursor.y === composer,
      '② ⚠️ **真光标落在输入行那一行**（账与屏没分家——分家就是它高一行）',
      `真光标 y=${shot.cursor.y}，输入行在 ${composer}`,
    )
    // 草稿末尾那一列：左留白 1 ＋ `› ` 2 ＋ 正文 16 列（8 个汉字）= 19
    check(
      shot.cursor.x === 19,
      '② 真光标落在**草稿末尾那一列**（列号也没偏）',
      `真光标 x=${shot.cursor.x}，应为 19（1 ＋ 2 ＋ 16）`,
    )
    check(shot.cursor.hidden === false, '② 真光标**没被藏起来**')
  } finally {
    await closeScene(scene)
  }
}

// ══ 场三 · 行首 / 行末（乙）═════════════════════════════════════════

/**
 * **`ctrl+a` / `ctrl+e` 跳到那一行的两端**——带引用的多行草稿。
 *
 * 草稿（两行）：
 *
 * ```
 * › 看这 @笔记.md 这一处
 *   第二行                        ← 缩进 2 列（与 `› ` 同宽）
 * ```
 *
 * `ctrl+e`（在这一行时）⇒ 真光标落到**这一行的末尾**（x ＝ 1 ＋ 2 ＋ 6 ＝ 9）；
 * `ctrl+a` ⇒ 落到**这一行的开头**（x ＝ 3）——**不是文首**（文首在上一行、引用那一段之前）。
 * 两屏都留，改前（按下去什么都不发生）改后一眼看得出。
 */
async function sceneHomeEnd(): Promise<void> {
  const scene = await openScene({
    label: 'u85-行首行末',
    columns: 100,
    rows: 30,
    turns: [{ kind: 'text', text: '知道了。' }],
  })

  try {
    // 工作区里放一个文件——`@` 那一栏才选得出引用（引用是这一场的主角之一）
    put(scene.session.facts().workspace, '笔记.md', '笔记正文')

    // —— 空草稿：两下都是**无事发生**（`lineSpan('', 0)` ＝ `[0, 0]`）——
    // 这一档屏上本来就看不出动静，故判据是**反面**：不报错、不留回执、草稿不被写脏。
    const blank = await scene.session.capture({ label: '③-前-空草稿（前）' })
    keep(blank)
    await pressKey(scene.session, 'ctrl+a')
    await waitCursor(scene.session, { x: 3, y: composerRowOf(blank) })
    await pressKey(scene.session, 'ctrl+e')
    await waitCursor(scene.session, { x: 3, y: composerRowOf(blank) })
    const stillBlank = await scene.session.capture({ label: '③-前-空草稿（按过行首行末之后）' })
    keep(stillBlank)
    check(
      stillBlank.text === blank.text,
      '③ 空草稿：`ctrl+a` / `ctrl+e` 两下按下去**屏上什么都没变**（不报错、不留回执）',
      stillBlank.lines[composerRowOf(stillBlank)] ?? '',
    )

    // —— 摆一份**两行、带引用**的草稿（全程不提交）——
    //
    // ⚠️ **那一格空格不能省**：`@` 要在**词边界**上才开候选（`shell.ts` 的 `opensPath`：
    //    行首或**空白之后**）——写成 `看@` 那张候选根本不出现，回车就成了**提交**（本单实测：
    //    草稿被发出去、清单外多了一条用户行）。
    // ⚠️ **等的那个词里别带尾随空格**：`WaitCondition` 比的是 VT 屏上那一行，而屏上的行尾
    //    空白已被裁掉（`' › 看这 '` 在屏上是 `' › 看这'`）——拿 `'看这 '` 当条件必然超时。
    await scene.session.send('看这 ', { until: { text: '看这' }, timeoutMs: 10_000 })
    await scene.session.send('@', { until: { text: '@' }, timeoutMs: 10_000 })
    await scene.session.send('笔记', { until: { text: '@笔记' }, timeoutMs: 10_000 })
    await pressKey(scene.session, 'enter', { until: { text: '@笔记.md' }, timeoutMs: 10_000 })
    await scene.session.send(' 这一处', { until: { text: '这一处' }, timeoutMs: 10_000 })
    await pressKey(scene.session, 'shift+enter')
    await scene.session.send('第二行', { until: { text: '第二行' }, timeoutMs: 10_000 })

    const posed = await scene.session.capture({ label: '③-00-草稿就位' })
    keep(posed)
    check(has(posed, '看这 @笔记.md 这一处'), '③ 草稿摆好了：引用在它被说出来的位置（`看这 @笔记.md 这一处`）', '(改前这一屏也长这样——它是底数)')

    const line = rowOf(posed, '第二行')

    // 先把插入点**挪开**（左移一个字素「行」＝ 2 列）——不挪开的话「行末」那一下无从证明
    // （草稿刚打完，插入点本来就在末尾）
    await pressKey(scene.session, 'left')
    await waitCursor(scene.session, { x: 7, y: line })

    // —— `ctrl+e` ⇒ **这一行**的末尾 ——
    await pressKey(scene.session, 'ctrl+e')
    await waitCursor(scene.session, { x: 9, y: line })
    const end = await scene.session.capture({ label: '③-01-行末（ctrl+e）' })
    keep(end)
    check(
      end.cursor.y === line && rowOf(end, '第二行') === line,
      '③ `ctrl+e` 之后真光标停在**第二行**上（没跑到别的行去）',
      `真光标 y=${end.cursor.y}，第二行在 ${rowOf(end, '第二行')}`,
    )
    check(
      end.cursor.x === 9,
      '③ `ctrl+e` ＝ **这一行的末尾**（x ＝ 1 留白 ＋ 2 缩进 ＋ 6 列「第二行」）',
      `真光标 x=${end.cursor.x}，应为 9`,
    )

    // —— `ctrl+a` ⇒ **这一行**的开头（不是文首：文首在上一行、引用那一段之前）——
    await pressKey(scene.session, 'ctrl+a')
    await waitCursor(scene.session, { x: 3, y: line })
    const head = await scene.session.capture({ label: '③-02-行首（ctrl+a）' })
    keep(head)
    check(
      head.cursor.y === line && head.cursor.x === 3,
      '③ `ctrl+a` ＝ **这一行的开头**（x ＝ 1 留白 ＋ 2 缩进），不是文首',
      `真光标 (${head.cursor.x},${head.cursor.y})，应为 (3,${line})`,
    )
    check(
      has(head, '看这 @笔记.md 这一处'),
      '③ 两下按完，**草稿与引用一个字没动**（只挪了插入点）',
      head.lines.find((one) => one.includes('看这 @')) ?? '（屏上没有那一行了）',
    )
    check(head.lines.length > 0 && rulesOf(head).length === 2, '③ 反面：这一场没有清单，一屏仍是**两条线**', `实测 ${rulesOf(head).length} 条`)
  } finally {
    await closeScene(scene)
  }
}

// ══ 入口 ════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u85-') : (process.argv[at + 1] as string)
  const only = process.argv.includes('--only')
    ? (process.argv[process.argv.indexOf('--only') + 1] as string)
    : ''
  mkdirSync(root, { recursive: true })
  out = root

  const wanted = (name: string): boolean => only === '' || only === name

  try {
    if (wanted('清单')) {
      console.log('\n══ 场一 · 有清单那一屏（甲 · 与滚动记录分得开）══')
      await scenePlan()
    }

    if (wanted('矮窗')) {
      console.log('\n══ 场二 · 矮窗（账与屏不差分家 · ⚠️ 本单最要紧的一条）══')
      await sceneShort()
    }

    if (wanted('行首行末')) {
      console.log('\n══ 场三 · 行首 / 行末（乙）══')
      await sceneHomeEnd()
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
