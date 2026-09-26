#!/usr/bin/env bun
/**
 * U100 · **Ctrl+C 任务去向与后台续跑**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端真进程才说得清**的那几件：
 * 那三选摆出来长什么样、按下之后**进程这一头**到底发生了什么（界面退了没有、原运行还在不在
 * 产出、接回来的是不是同一条）。
 *
 * ## 八趟，都在真链路上（到屏、到进程）
 *
 * 真 `cli.ts`（真管理者 → 真执行者 → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * | 趟 | 做什么 | 要看见什么 |
 * | --- | --- | --- |
 * | 一 · 常规宽度 | 流式时 `ctrl+c` ⇒ 三项 · 方向键 · `esc` 返回 · 再一次 `ctrl+c` 返回 | **打开不改变执行**（那一轮还在长）· 三行文案与默认项对得上 |
 * | 二 · 矮窗 | 40×10 里开同一屏 | 输入区不被挤破、没有一行超宽、字标之外的行数不为负 |
 * | 三 · 转到后台 | 流式时 ⇒ 转后台 | **客户端真退出**（`by=app`）· 原运行**继续产出** · 接回是同一条会话、**模型没被再问一遍** |
 * | 四 · 停止任务 | 流式时 ⇒ 停止任务 | 回执「只停了…这一轮」· **界面还在** · **接着交代是同一条会话** |
 * | 五 · 停止并退出 | 流式时 ⇒ 停止并退出 | 先「正在停」后「停了」· 客户端自己退（`by=app`）· 零残留 |
 * | 六 · 关终端 | 流式中途把 PTY 主端摘掉 | **只离开**：执行者照跑、产出继续、可接回 |
 * | 七 · 待答 | 卡挂着时 ⇒ 三选（标题「正在等待你」）⇒ `esc` | **审批照原样回来**（没被答掉） |
 * | 八 · 另一条会话 | 两扇窗一块沙地；甲窗在跑，乙窗停自己那条 | **甲窗那一条不受影响**（请求数照涨） |
 * | 九 · 待答时离开 | 卡挂着 ⇒ 转后台 ⇒ 接回 | **还是原来那一张卡**（没自动批准、没丢）、答它才真跑 |
 *
 * ## 两扇窗借同一块沙地
 *
 * 同一个 dataDir ⇒ 同一个管理者。各开一块沙地就变成两摊互不相干的运行，而「另一条会话不受
 * 影响」那条只有在同一摊上才成立（同 `run-terminal.test.ts` 的注）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u100-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { Capture, Sandbox, UiSession } from './ui/index.ts'
import { readDatabase } from './support.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<序号>-<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(shot: Capture, label = shot.label): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 一行在不在（按行找，与 `session.wait` 同一条尺子）。 */
function has(capture: Capture, needle: string): boolean {
  return capture.lines.some((line) => line.includes(needle))
}

/** 等一个条件在**可见屏**上成立（默认 25 秒）——轮询是用例的事。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 25_000,
): Promise<void> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 三选那一屏**上屏了**吗——三段标题都含这一截，不必分开等。 */
const MENU_UP = { text: '当前任务' }

/** 交代一句、等回话**开头**那几字上屏（流式还在长——不当成「跑完了」）。 */
async function ask(session: UiSession, text: string, until: string): Promise<void> {
  await typeLine(session, text)
  await session.key('enter', { until: { text: until }, timeoutMs: 25_000 })
}

/** 那一摊运行的会话 id（库里那一条）——接回 `--session <id>` 用它。 */
function sessionIdOf(sandbox: Sandbox): string {
  const db = readDatabase(join(sandbox.dataDir, 'records.db'))
  try {
    return db.sessions[0]?.id ?? ''
  } finally {
    db.close()
  }
}

/** 慢慢长出来的那句——「停下来 / 走去后台」都要有东西可停、可续。 */
const SLOW = '这一句会慢慢长出来：先是一半，然后才是另一半，最后收在句号上。'
const SLOW_HEAD = '这一句会慢慢长出来'

/**
 * 一趟要跑的东西——**尺寸参数化**（除了尺寸，判据一字不改）。
 *
 * 这一趟只量「那一屏本身」：三项都在、默认落在第一项、方向键动、`esc` 回来之后**那一轮还
 * 在长**（打开与取消都不改变执行）。
 */
async function once(mark: string, columns: number, rows: number): Promise<void> {
  const runs = tempDir(`magic-u100-frames-${mark}-`)
  const fixture = startFixture({
    turns: [{ kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({
      label: `${mark}-甲窗`,
      artifacts: runs,
      sandbox,
      fixture,
      columns,
      rows,
    })

    // **先让那一轮真跑起来**（状态行那句「ctrl+c 中断」就是物证），再按
    await typeLine(window, '长话')
    await window.key('enter', { until: { text: SLOW_HEAD }, timeoutMs: 25_000 })

    // —— 一 · 打开：三选上屏，而**那一轮照旧在长** ——
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await window.capture({ label: `${mark}-01-三选` })
    keep(menu)

    check(has(menu, '当前任务仍在运行'), '标题说的是此刻的事实（在跑那一版）', '')
    // **三个动作名一个字不动**（设计那张表的顺序：停止任务 → 转到后台 → 停止并退出）
    check(has(menu, '停止任务') && has(menu, '转到后台') && has(menu, '停止并退出'), '三项都在', '')
    // **三项各占一行**（`oneLine`：超宽在渲染层截断加 `…`，不折行）——账与屏才对得上
    const itemLines = menu.lines.filter((line) => /^\s*\d\s/u.test(line))
    check(itemLines.length === 3, '三项**各占一行**（没有折行）', `实际 ${itemLines.length} 行`)

    if (columns >= 60) {
      // **宽窗：简述写全**（一句话说清每一项会怎么处置这件事）
      check(has(menu, '停止当前任务，留在 Magic'), '第一项的说明是**留在界面**', '')
      check(has(menu, '退出界面，任务继续运行'), '第二项的说明是**界面退出、任务继续**', '')
      check(has(menu, '停止当前任务并退出 Magic'), '第三项的说明是**停掉并退出**', '')
      // 键位提示挂在状态行右位（既有那一格）——**放不下就整段不出现**，故只在宽窗判
      check(has(menu, '↑↓ 选 · 回车 定 · esc 返回'), '页脚只列有用键位（↑↓ / 回车 / esc 返回）', '')
    } else {
      // **窄窗**：简述按设计那条「**先保名称、再截断简述**」收尾（`…`）——
      // 判的是「名称全在、简述是它自己的前缀」，不是「这一屏多宽」
      const said = itemLines.join('\n')
      check(
        said.includes('停止当前任务') && said.includes('退出界面') && said.includes('停止当前任务并退出'),
        '窄窗：三项的说明**开头那几个字还在**（截的是尾巴）',
        said,
      )
      check(
        menu.lines.every((line) => [...line].length <= columns),
        '窄窗：没有一行超出宽度',
        `最长 ${Math.max(...menu.lines.map((line) => [...line].length))} 列`,
      )
    }
    check(!has(menu, 'y 批准'), '菜单里没有卡的键位（它不是审批屏）', '')
    // **打开不改变执行**：这一屏出来之后，模型那一头照旧在吐字
    const before = fixture.requests().length
    await window.wait({ text: SLOW_HEAD }, { timeoutMs: 5_000 })
    const mid = await window.capture({ label: `${mark}-02-菜单开着时那一轮照旧在长` })
    keep(mid)
    check(
      (mid.text.match(/这一句会慢慢长出来/g) ?? []).length >= 1,
      '打开菜单**没有停止**那一轮（正文还在长）',
      '',
    )
    check(fixture.requests().length === before, '也没有重发请求', `请求 ${fixture.requests().length} 趟`)

    // —— 二 · 方向键：焦点动、三项还在 ——
    await window.key('down')
    const moved = await window.capture({ label: `${mark}-03-按下方向键` })
    keep(moved)
    check(has(moved, '转到后台'), '按 ↓ 之后三项照旧（焦点挪到第二项）', '')

    // —— 三 · 菜单里**再按一次 ctrl+c** ⇒ 只返回，不执行任何一项 ——
    await window.key('ctrl+c')
    await window.wait({ absent: '当前任务' }, { timeoutMs: 10_000 })
    const closed = await window.capture({ label: `${mark}-04-再按一次-ctrl+c-返回` })
    keep(closed)
    check(!has(closed, '停止任务'), '菜单收了（再按 ctrl+c 只返回）', '')
    check(has(closed, '只停了') === false, '**没有**执行任何一项（没有停止的回执）', '')
    check(has(closed, SLOW_HEAD), '那一轮照旧在（正文还在，工作没被打断）', '')

    // —— 四 · 再开一次，`esc` 返回 ——
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('esc')
    await window.wait({ absent: '停止任务' }, { timeoutMs: 10_000 })
    const escaped = await window.capture({ label: `${mark}-05-esc-返回` })
    keep(escaped)
    check(has(escaped, SLOW_HEAD), '`esc` 之后那一轮照旧在（取消不停止）', '')
    check(!has(escaped, '只停了'), '取消也没有停止的回执', '')

    // 收尾：**等它自己跑完**，再空闲按两次退出（不借这一趟的菜单）
    //
    // ⚠️ 等的锚用**状态行左位**（「○ 空闲」）而不是正文那一句：矮窗里正文会折行，
    // 一句话可能**正卡在折点上**（按行 `includes` 就永远等不到）；状态行左位那几格
    // 在窄窗里照旧在（实测 40 列上「○ 空闲 · 长话」）。
    await window.wait({ text: '○ 空闲' }, { timeoutMs: 90_000 })
    await window.quit()
    const report = await window.close({ graceMs: 5_000 })
    check(report.exit.by !== 'sigkill', `【${mark}】窗口自己走的`, `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * **三 · 转到后台**——设计那一条的正身：**界面退出，同一运行继续**。
 *
 * 判据要**在真实产出上**落：客户端退出之后，那条会话还在写（接回来读得到**它退出之后**才
 * 出现的那半句），而模型**没有被再问一遍**（`requests()` 计数不涨——「不重开、不重发用户
 * 输入」的物证是调用数，不是屏）。
 */
async function background(): Promise<void> {
  const runs = tempDir('magic-u100-bg-runs-')
  const fixture = startFixture({
    turns: [
      { kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 },
      // 第二句留给「接回来之后再交代」——它证明的是**同一条会话**还能往下走
      { kind: 'text', text: '第二句：接上了。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let first: UiSession | undefined
  let second: UiSession | undefined

  try {
    first = await createUiSession({
      label: '转后台-甲窗',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await ask(first, '长话', SLOW_HEAD)
    await first.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await first.capture({ label: '06-转后台之前' })
    keep(menu)
    check(has(menu, '转到后台'), '第二项在（这一趟要选的就是它）', '')

    // —— 选「转到后台」（默认在第一项，先按一下 ↓）——
    await first.key('down')
    await first.key('enter')
    const closed = await first.close({ graceMs: 8_000 })
    check(closed.exit.by === 'app', '客户端**自己退出了**（不是被杀的）', `by=${closed.exit.by}`)
    const atExit = fixture.requests().length
    first = undefined

    // —— 它退出之后，那一轮**继续在产出** ——
    // ⚠️ **先睡一觉再接回**：那一句是慢慢长的（块间 500ms），立刻接回来的话，「退出之后
    // 才出现的那半句」还没写出来——判据就退化成「它本来就在跑」（看不出「继续」）。
    await Bun.sleep(2_000)

    // 接回来：**同一条会话**（`--session <id>`），记录区照旧铺它，而且它还活着
    const id = sessionIdOf(sandbox)
    check(id !== '', '那条会话落账了（接回要按 id 来）', '')

    second = await createUiSession({
      label: '转后台-乙窗（接回）',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      argv: ['--session', id],
    })

    await second.wait({ text: SLOW_HEAD }, { timeoutMs: 30_000 })
    // **它退出之后才出现的那半句**——等的就是它（那一轮在无人看着的时候照旧跑完了）
    await second.wait({ text: '收在句号上。' }, { timeoutMs: 60_000 })
    const resumed = await second.capture({ label: '07-接回来的那一屏（它退出之后跑完的）' })
    keep(resumed)
    check(has(resumed, '收在句号上。'), '**原运行没被打断**：退出之后才出现的那半句在这里', '')
    check(
      fixture.requests().length === atExit,
      '接回**不重放**：模型没被再问一遍',
      `${atExit} → ${fixture.requests().length} 趟`,
    )
    check(has(resumed, '› 长话'), '记录区铺着原来那一句（同一条会话）', '')

    // —— 同一现场继续交代 ——
    await ask(second, '再来一句', '第二句：接上了。')
    const more = await second.capture({ label: '08-接回来之后继续交代' })
    keep(more)
    check(has(more, '第二句：接上了。'), '接回来之后照旧能交代（同一条会话往下走）', '')
    check(
      sessionIdOf(sandbox) === id,
      '**还是那一条会话**（没有悄悄开一条新的）',
      `接回前 ${id} · 之后 ${sessionIdOf(sandbox)}`,
    )

    await second.quit()
    const farewell = await second.close({ graceMs: 5_000 })
    check(farewell.exit.by !== 'sigkill', '接回的那一扇也自己走的', `by=${farewell.exit.by}`)
    second = undefined
  } finally {
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/** 四 · **停止任务**：停这一轮、**界面留下**、接着交代是同一条会话。 */
async function stopAndStay(): Promise<void> {
  const runs = tempDir('magic-u100-stop-runs-')
  const fixture = startFixture({
    turns: [
      { kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 },
      { kind: 'text', text: '第二句：接着来。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({
      label: '停止任务',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await ask(window, '长话', SLOW_HEAD)
    const id = sessionIdOf(sandbox)

    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('enter') // 默认第一项＝停止任务
    await waitUntil(window, '停止的回执', (lines) => lines.some((line) => line.includes('只停了')))
    const stopped = await window.capture({ label: '09-停止任务之后（界面留下）' })
    keep(stopped)
    check(has(stopped, '只停了'), '回执说清停的是**这一轮**（局部那一档）', '')
    check(has(stopped, '那条运行还在'), '并且说得出**没停什么**（那条运行还在）', '')
    check(has(stopped, '› ') || has(stopped, '交代一件事'), '**界面留下了**（输入行还在）', '')

    // 接着交代——**同一条会话**往下走（这是「留在界面」的判据，不是「能打字」）
    await ask(window, '接着来', '第二句：接着来。')
    const continued = await window.capture({ label: '10-停完之后继续交代' })
    keep(continued)
    check(has(continued, '第二句：接着来。'), '停完之后能继续交代', '')
    check(
      sessionIdOf(sandbox) === id,
      '而且是**同一条会话**（不是悄悄开了一条新的）',
      `${id} → ${sessionIdOf(sandbox)}`,
    )

    await window.quit()
    const report = await window.close({ graceMs: 5_000 })
    check(report.exit.by !== 'sigkill', '窗口自己走的', `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 五 · **停止并退出**：先停（核销）再退——`/exit` 那条路一个字不改。
 *
 * 「先核销」的物证＝回执走到 **「停了」**（U50 的三拍：受理 → 核销 → 报已停），而不是
 * 受理那一句就退出。
 */
async function stopAndExit(): Promise<void> {
  const runs = tempDir('magic-u100-stopexit-runs-')
  const fixture = startFixture({
    turns: [{ kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({
      label: '停止并退出',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await ask(window, '长话', SLOW_HEAD)
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('down')
    await window.key('down')
    await window.key('enter') // 第三项＝停止并退出

    // ⚠️ **先看到「正在停」**——那是受理；再看到「停了」——那才是核销（资源确认退出）
    await window.wait({ text: '正在停' }, { timeoutMs: 10_000 })
    const accepted = await window.capture({ label: '11-停止并退出（受理那一拍）' })
    keep(accepted)
    check(has(accepted, '正在停'), '受理那一拍说「正在停」（不是「已停」）', '')

    await window.wait({ text: '停了' }, { timeoutMs: 15_000 })
    const done = await window.capture({ label: '12-核销之后' })
    keep(done)
    check(has(done, '停了'), '核销之后才说「停了」', '')

    const report = await window.close({ graceMs: 8_000 })
    check(report.exit.by === 'app', '客户端自己退的（资源核销之后）', `by=${report.exit.by}`)
    check(report.exit.code === 0, '退出码 0', `实际 ${report.exit.code ?? '-'}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 六 · **直接关终端**——与「转到后台」同一条语义（只离开，不取消）。
 *
 * 这一趟是**本单拆掉的那个耦合**的正身：旧写法里，断流时若这一轮在跑，外壳会**替用户发一次
 * 中断**（`hangUp` 的旧语义）。故这里量的不是「客户端退没退」（D26 已经量过），
 * 而是**退出之后那条运行还在不在**：接回来读得到它退出之后才出现的那半句。
 */
async function dropTerminal(): Promise<void> {
  const runs = tempDir('magic-u100-drop-runs-')
  const fixture = startFixture({
    turns: [{ kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let first: UiSession | undefined
  let second: UiSession | undefined

  try {
    first = await createUiSession({
      label: '关终端-甲窗',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await ask(first, '长话', SLOW_HEAD)
    const atDrop = fixture.requests().length

    // **把终端那一头摘掉**（关掉 PTY 主端，不发信号）——「这一头没人了」
    first.dropTerminal()
    const closed = await first.close({ graceMs: 10_000 })
    check(closed.exit.by === 'app', '客户端自己退的（断流那条老路照旧）', `by=${closed.exit.by}`)
    first = undefined

    // 退出之后那一轮照旧跑完
    await Bun.sleep(1_000)
    const id = sessionIdOf(sandbox)
    second = await createUiSession({
      label: '关终端-乙窗（接回）',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
      argv: ['--session', id],
    })

    await second.wait({ text: '收在句号上。' }, { timeoutMs: 60_000 })
    const back = await second.capture({ label: '13-关终端之后接回来' })
    keep(back)
    check(has(back, '收在句号上。'), '**关终端只离开**：那一轮在无人看着的时候照旧跑完了', '')
    check(
      fixture.requests().length === atDrop,
      '接回不重放（模型没被再问一遍）',
      `${atDrop} → ${fixture.requests().length} 趟`,
    )

    await second.quit()
    await second.close({ graceMs: 5_000 })
    second = undefined
  } finally {
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/** 七 · **待答**：卡挂着时开三选，标题换一版；`esc` 之后**审批照原样回来**。 */
async function waiting(): Promise<void> {
  const runs = tempDir('magic-u100-ask-runs-')
  // 名单里的删除 ⇒ 必问（重档键位 `y / n`，见 `ui/scenarios.ts` 的 `COPY.decideHint`）。
  // ⚠️ **第二回合要有一句正文**：夹具是「用完了重复最后一个」——只给工具那一回合的话，
  // 拒绝之后模型**再要一次**，这一轮永远收不了场（收尾那两下 `ctrl+c` 就白等一场）
  const fixture = startFixture({
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } },
      { kind: 'text', text: '那就不改了。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({
      label: '待答',
      artifacts: runs,
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })

    await typeLine(window, '跑一条命令')
    await window.key('enter', { until: { text: 'y / n' }, timeoutMs: 25_000 })

    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await window.capture({ label: '14-待答时的三选' })
    keep(menu)
    check(has(menu, '当前任务正在等待你'), '待答时标题换成**等待你**那一版', '')
    check(has(menu, '停止任务'), '三项照旧', '')
    check(!has(menu, 'y / n'), '卡被这一屏压住（一屏上不摆两套键）', '')

    // `esc` ⇒ 卡照原样回来（**审批不丢、也没被答掉**）
    await window.key('esc')
    await window.wait({ text: 'y / n' }, { timeoutMs: 10_000 })
    const back = await window.capture({ label: '15-esc-之后卡回来了' })
    keep(back)
    check(has(back, 'y / n'), '`esc` 之后**卡照原样回来**', '')
    check(has(back, '跑一条命令'), '卡上的材料还在（说的是原来那一笔）', '')
    check(!has(back, '决定'), '没有替用户答过（没有任何裁决回执）', '')
    // 那一件工具**一件都没跑**（没人批准过它）
    check(fixture.requests().length === 1, '模型也没被再问过', `${fixture.requests().length} 趟`)

    // 干净退场：先拒绝那一笔（不执行任何东西），再走空闲那条路
    await window.send('n', { until: { text: '那就不改了。' }, timeoutMs: 20_000 })
    await window.quit()
    const report = await window.close({ graceMs: 5_000 })
    check(report.exit.by !== 'sigkill', '窗口自己走的', `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 九 · **待答时离开、再接回**——卡还在，而且**还是原来那一张**。
 *
 * 设计：「待答时离开再接回仍是原审批」「后台遇到审批就等待；不自动批准、不因无界面而放宽权限」。
 * U100 起「离开」多了一条正门（三选里的「转到后台」），故这一条要在**真进程**上量：
 *
 * - 客户端退出（`by=app`）· 那一件工具**一件都没跑**（没人批准过）；
 * - 接回来那张卡**照旧挂着**（材料还在，键位照旧），**没有自动批准**、也没有被丢掉；
 * - 这时候答它才真跑（`y` ⇒ 结果出来）——「离开不改变权限」那一半。
 */
async function waitingAcrossBackground(): Promise<void> {
  const runs = tempDir('magic-u100-askbg-runs-')
  // ⚠️ 第二回合要有一句正文（同趟七那条注：只给工具那一回合的话，批准之后模型再要一次，
  //    这一轮永远收不了场）
  const fixture = startFixture({
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } },
      { kind: 'text', text: '改完了。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let first: UiSession | undefined
  let second: UiSession | undefined

  try {
    first = await createUiSession({
      label: '待答-甲窗', artifacts: runs, sandbox, fixture, columns: 100, rows: 30,
    })

    await typeLine(first, '跑一条命令')
    await first.key('enter', { until: { text: 'y / n' }, timeoutMs: 25_000 })

    // **卡挂着的时候离开**（三选里的「转到后台」）
    await first.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await first.key('down')
    await first.key('enter')
    const closed = await first.close({ graceMs: 8_000 })
    check(closed.exit.by === 'app', '卡挂着的时候也走得掉（客户端自己退的）', `by=${closed.exit.by}`)
    first = undefined
    check(fixture.requests().length === 1, '那一件工具**一件都没跑**（没人批准过它）', `${fixture.requests().length} 趟`)

    // 接回来：**还是原来那一张**
    //
    // ⚠️ `skipReady`：这一扇窗**没有那道空闲闸可等**——它开局就直接进那张卡
    // （设计：「**需要你**……**你连上它时直接进那张卡**」），照常规等 `HINT_IDLE` 只会
    // 白等到超时。等的对象在这一趟里换成卡本身（下面那一句）。
    const id = sessionIdOf(sandbox)
    second = await createUiSession({
      label: '待答-乙窗（接回）', artifacts: runs, sandbox, fixture, columns: 100, rows: 30,
      argv: ['--session', id],
      skipReady: true,
    })

    await second.wait({ text: 'y / n' }, { timeoutMs: 30_000 })
    const back = await second.capture({ label: '18-离开之后再接回：卡还在' })
    keep(back)
    check(has(back, 'y / n'), '接回来**那张卡照旧挂着**（原审批还在）', '')
    check(has(back, 'chmod 755 .'), '卡上的材料还是原来那一笔', '')
    check(fixture.requests().length === 1, '**没有**自动批准（也不会替用户重试）', `${fixture.requests().length} 趟`)

    // 这时候答它 —— 它才真跑
    await second.send('y', { until: { text: '改完了。' }, timeoutMs: 30_000 })
    const answered = await second.capture({ label: '19-接回之后答它，它才真跑' })
    keep(answered)
    check(has(answered, '改完了。'), '答完之后照旧往下走（**离开没有改变权限**）', '')

    await second.quit()
    await second.close({ graceMs: 5_000 })
    second = undefined
  } finally {
    await first?.close().catch(() => {})
    await second?.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

/** 八 · **另一条会话不受影响**：乙窗停自己那条，甲窗照旧在跑。 */
async function otherSession(): Promise<void> {
  const runs = tempDir('magic-u100-other-runs-')
  const fixture = startFixture({
    turns: [{ kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    const mine = await createUiSession({
      label: '别条会话-甲窗', artifacts: runs, sandbox, fixture, columns: 100, rows: 30,
    })
    windows.push(mine)
    await ask(mine, '长话', SLOW_HEAD)

    const other = await createUiSession({
      label: '别条会话-乙窗', artifacts: runs, sandbox, fixture, columns: 100, rows: 30,
    })
    windows.push(other)
    await ask(other, '另一句', SLOW_HEAD)
    const mineRequests = fixture.requests().length

    // 乙窗停**自己**那一条（它自己的在途工作）
    await other.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await other.key('enter')
    await waitUntil(other, '乙窗停止的回执', (lines) => lines.some((line) => line.includes('只停了')))
    const stopped = await other.capture({ label: '16-乙窗停自己那条' })
    keep(stopped)
    check(has(stopped, '只停了'), '乙窗停的是自己那一条', '')

    // 甲窗照旧：它那一轮的正文还在长，接续的产出照旧到
    await mine.wait({ text: '收在句号上。' }, { timeoutMs: 60_000 })
    const kept = await mine.capture({ label: '17-甲窗照旧跑完' })
    keep(kept)
    check(has(kept, '收在句号上。'), '**甲窗那一条不受影响**（照旧跑完）', '')
    check(
      fixture.requests().length >= mineRequests,
      '甲窗那一头的调用照旧',
      `${mineRequests} → ${fixture.requests().length} 趟`,
    )
    check(!has(kept, '只停了'), '甲窗上没有任何「停」的回执（不是它的事）', '')

    for (const window of windows) await window.quit()
    windows.length = 0
    await mine.close({ graceMs: 5_000 })
    await other.close({ graceMs: 5_000 })
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u100-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· 一 · 常规宽度 100×30')
    await once('宽', 100, 30)
    console.log('· 二 · 矮窗 40×10')
    await once('矮', 40, 10)
    console.log('· 三 · 转到后台（真进程）')
    await background()
    console.log('· 四 · 停止任务（留在界面）')
    await stopAndStay()
    console.log('· 五 · 停止并退出（先核销）')
    await stopAndExit()
    console.log('· 六 · 直接关终端')
    await dropTerminal()
    console.log('· 七 · 待答')
    await waiting()
    console.log('· 八 · 另一条会话不受影响')
    await otherSession()
    console.log('· 九 · 待答时离开、再接回')
    await waitingAcrossBackground()

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
