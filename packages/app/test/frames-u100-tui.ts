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
 * | 四 · 停止任务 | 流式时 ⇒ 停止任务 | 先「正在停」后「停了」（**与停止并退出同一档**）· **界面还在** · **接着交代是同一条会话** |
 * | 五 · 停止并退出 | 流式时 ⇒ 停止并退出 | 先「正在停」后「停了」· 客户端自己退（`by=app`）· 零残留 |
 * | 六 · 关终端 | 流式中途把 PTY 主端摘掉 | **只离开**：执行者照跑、产出继续、可接回 |
 * | 七 · 待答 | 卡挂着时 ⇒ 三选（标题「正在等待你」）⇒ `esc` | **审批照原样回来**（没被答掉） |
 * | 八 · 另一条会话 | 两扇窗一块沙地；甲窗在跑，乙窗停自己那条 | **甲窗那一条不受影响**（请求数照涨） |
 * | 九 · 待答时离开 | 卡挂着 ⇒ 转后台 ⇒ 接回 | **还是原来那一张卡**（没自动批准、没丢）、答它才真跑 |
 * | 十 · 只剩后台命令 | 那一轮早收了、只有后台命令在跑 | **照样给三选**；「停止任务」把它**连进程一起收回**（`pgrep` 为证） |
 * | 十一 · 同一份交代跨轮 | 工具正在跑时开菜单 ⇒ 它跑完、下一轮起来 | 菜单**照旧在**、回车**停得掉**（不拿「轮」当任务边界） |
 * | 十二 · 失联 | 杀掉管理者 | **留在界面**、如实说「连接已断开」、状态那一格「状态待确认」、ctrl+c 两下仍走得掉 |
 * | 十三 · 别的列表之后开三选 | 先在 `/resume` 里挪到第 3 条，再按 `ctrl+c` | **新开的三选恒第一项**（按字格看高亮）· `↓` 挪得动 · `esc` 回去**原列表照原样** |
 * | 十四 · 过期的卡（已核销） | 审批被三选罩住 ⇒ 另一窗口停掉同一运行 ⇒ `esc` | **卡不复活**、不代答、草稿归还、`ctrl+c` 回到**离开**那条路 |
 * | 十五 · 过期的卡（失联） | 同上 ⇒ 杀掉管理者 ⇒ `esc` | **仍是失联**（那格不许被改成「等你定夺」或「空闲」）· 双按 ctrl+c 仍走得掉 |
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

/**
 * **输入行那一行**（左下的输入框）——**取屏上最后一个 `› …`**：
 * 记录区里的用户发言也长这样（`› 跑一条命令`），它在上面；输入行恒在交互区、在最后。
 */
function inputLineOf(shot: Capture): string {
  for (const line of [...shot.lines].reverse()) {
    if (line.trimStart().startsWith('› ')) return line
  }

  return ''
}

/** 一行在不在（按行找，与 `session.wait` 同一条尺子）。 */
function has(capture: Capture, needle: string): boolean {
  return capture.lines.some((line) => line.includes(needle))
}

/**
 * **那一行是不是「工具在跑」才有的那行读数**——U112 起**在跑**的唯一凭据。
 *
 * 工具行是两行（`components/log.ts`）：头一行 `▸ 名字(关键参数)` ＋ 行尾状态位
 * （在跑弱色 `●`、定住 `✓`），**在跑时**底下才有第二行、且**光一个时长**（`0ms` / `1.2s`）。
 * 故「在跑」不再能拿行首那个记号认（`⟳` 撤了，`▸` 跑着与跑完都在），认的是**这一行**。
 */
function isClockOnly(line: string): boolean {
  return /^\d+(?:\.\d+)?(?:ms|s)$/u.test(line.trim())
}

/**
 * **一行是不是「选中那一行」**——按**字格**判，不按文字：那一屏三项的文字一直都在，
 * 等文本等不到任何东西（U100 合前复核点出的：「原方向键帧仍是第一项亮色加粗」）。
 *
 * ⚠️ **不能只看「第一个加粗的行」**（复核又点出一次）：`components/picker.ts` 里
 * **选中项与「正在用」那一项都加粗**（`bold: index === selected || row.current`），
 * 两处只有**颜色**分得开——**选中是 `PALETTE.fg`（#d8dce4）**，「正在用」没被选中是
 * `PALETTE.user`（#56b6c2，青）。故判据是**选中色 ＋ 加粗**两件一起。
 *
 * ⚠️ **`cellsOf` 要当场取**（它是活视图）——本函数就在取到帧的同一跳里读。
 */
function focusedRow(shot: Capture): string {
  for (const [at, line] of shot.lines.entries()) {
    const cells = shot.cellsOf(at)
    if (cells.some((cell) => cell.bold && cell.fg === '#d8dce4')) return line
  }

  return ''
}

/**
 * **等高亮真的挪到某一行为止**（有界）——取帧要等这一刻，不能紧跟着按键就取。
 *
 * ⚠️ **判据收一个函数**（也可以给一句文本）：有的等待根本没有稳定的文字可等——
 * 「焦点从第一项挪到第二项」时三项的文字**一个字都没变**，只有字格变了
 * （U100 合前复核点出的：原来那一步「只等文本」，于是永远等到的是同一帧）。
 */
async function waitFocusTo(
  session: UiSession,
  ok: (focused: string) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<Capture> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const shot = await session.capture({ label: 'focus' })
    if (ok(focusedRow(shot))) return shot
    if (Bun.nanoseconds() > until) {
      throw new Error(`等不到${what}（此刻高亮的是「${focusedRow(shot)}」）`)
    }
    await Bun.sleep(40)
  }
}

/** 等高亮挪到含 `needle` 的那一行。 */
async function waitFocus(session: UiSession, needle: string, timeoutMs = 10_000): Promise<Capture> {
  return waitFocusTo(session, (focused) => focused.includes(needle), `高亮挪到「${needle}」`, timeoutMs)
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

    // **先让那一轮真跑起来**（状态行那句「ctrl+c 停或离开」就是物证），再按
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

    // —— 二 · 方向键：**焦点真挪过去**（按字格判，不按文字——三项的文字一直都在）——
    check(focusedRow(menu).includes('停止任务'), '开屏默认落在**第一项**（它是高亮那一行）', focusedRow(menu))
    await window.key('down')
    const moved = await waitFocus(window, '转到后台') // **等高亮挪过去再取帧**
    keep(moved, `${mark}-03-按下方向键`)
    check(focusedRow(moved).includes('转到后台'), '按 ↓ 之后**第二项才是高亮那一行**', focusedRow(moved))
    check(!focusedRow(moved).includes('停止任务'), '第一项**不再是**高亮那一行（焦点走了）', focusedRow(moved))
    await window.key('up')
    const backToTop = await waitFocus(window, '停止任务')
    keep(backToTop, `${mark}-03b-再按上键回到第一项`)
    check(focusedRow(backToTop).includes('停止任务'), '再按 ↑ 回到**第一项**（上下键都对得上）', focusedRow(backToTop))

    // —— 三 · 菜单里**再按一次 ctrl+c** ⇒ 只返回，不执行任何一项 ——
    await window.key('ctrl+c')
    await window.wait({ absent: '当前任务' }, { timeoutMs: 10_000 })
    const closed = await window.capture({ label: `${mark}-04-再按一次-ctrl+c-返回` })
    keep(closed)
    check(!has(closed, '停止任务'), '菜单收了（再按 ctrl+c 只返回）', '')
    check(!has(closed, '正在停') && !has(closed, '停了'), '**没有**执行任何一项（没有停止的回执）', '')
    check(has(closed, SLOW_HEAD), '那一轮照旧在（正文还在，工作没被打断）', '')

    // —— 四 · 再开一次，`esc` 返回 ——
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('esc')
    await window.wait({ absent: '停止任务' }, { timeoutMs: 10_000 })
    const escaped = await window.capture({ label: `${mark}-05-esc-返回` })
    keep(escaped)
    check(has(escaped, SLOW_HEAD), '`esc` 之后那一轮照旧在（取消不停止）', '')
    check(!has(escaped, '正在停') && !has(escaped, '停了'), '取消也没有停止的回执', '')

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
    await sandbox.dispose()
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
    // **离开之前留一条可复制的接回入口**（设计明文）——它是那一屏临走前落的最后一行记录，
    // 退出后内容留在终端里，用户想接回来时那串命令就在眼前。
    // ⚠️ **先等它上屏再取帧**（`key()` 写完就返回，不等应用处理——抢在前面取到的是菜单那一帧）
    await first.wait({ text: 'magic --session' }, { timeoutMs: 10_000 })
    const leaving = await first.capture({ label: '06b-转后台时留的接回入口' })
    keep(leaving)
    check(has(leaving, '转到后台了'), '离开前说清这一下做了什么', '')
    check(
      /magic --session [0-9a-f-]{8,}/u.test(leaving.text),
      '**留了一条可复制的接回入口**（`magic --session <id>`）',
      leaving.lines.find((line) => line.includes('magic --session')) ?? '',
    )

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
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 四 · **停止任务**：停**整体那一档**（这条会话在途的模型 / 工具 / 后台命令）、**界面留下**、
 * 接着交代是**同一条会话**。
 *
 * ⚠️ **U100 复议后改判**（原锚：「只停了…这一轮」——那时两项停止取了不同档）：规划裁决
 * 「两项停止**工作范围相同**，都必须收回这条会话的在途模型、工具和后台命令」，故现在两项
 * 走的是**同一档**（整体），回执与「停止并退出」逐字同形（先「正在停」后「停了」）——
 * 差别只在停完之后走不走。判据随之改判，**「界面留下、接着交代是同一条记录」一个字没松**。
 */
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

    const requestsAtStop = fixture.requests().length
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('enter') // 默认第一项＝停止任务
    // **先受理、再核销**：两拍各自看得见（`正在停` → `停了`）——这是「资源确已停止」那句的落点
    await window.wait({ text: '正在停' }, { timeoutMs: 15_000 })
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    const stopped = await window.capture({ label: '09-停止任务之后（界面留下）' })
    keep(stopped)
    check(has(stopped, '正在停'), '受理那一拍说「正在停」（不是「已停」）', '')
    check(has(stopped, '停了'), '核销之后才说「停了」', '')
    check(has(stopped, '› ') || has(stopped, '交代一件事'), '**界面留下了**（输入行还在）', '')
    await Bun.sleep(1_000)
    check(
      fixture.requests().length === requestsAtStop,
      '**停之后没有再问模型**（请求数不涨）',
      `${requestsAtStop} → ${fixture.requests().length} 趟`,
    )

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
    await sandbox.dispose()
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
    await sandbox.dispose()
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
    await sandbox.dispose()
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
    await sandbox.dispose()
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
    await sandbox.dispose()
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
    await waitUntil(other, '乙窗停止的回执', (lines) => lines.some((line) => line.includes('停了')))
    const stopped = await other.capture({ label: '16-乙窗停自己那条' })
    keep(stopped)
    check(has(stopped, '正在停'), '乙窗停的是自己那一条（「正在停…」那一拍）', '')

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
    check(!has(kept, '停了'), '甲窗上没有任何「停」的回执（不是它的事）', '')

    for (const window of windows) await window.quit()
    windows.length = 0
    await mine.close({ graceMs: 5_000 })
    await other.close({ graceMs: 5_000 })
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 十 · **只剩后台命令**——那一轮早收了，可后台那条命令还站着：`ctrl+c` 给的仍是**三选**。
 *
 * 设计：「后台命令仍在执行……也属于有在途工作」；判据落在**真进程**上（pgrep 找得到它），
 * 而不是屏上的一句话。
 */
async function backgroundOnly(): Promise<void> {
  const runs = tempDir('magic-u100-bgonly-runs-')
  // ⚠️ 标记做进 **sleep 的时长**（小数位随机）：写成 shell 注释会被 sh 吃掉，而 `sh -c`
  //    还会把自己 exec 成 `sleep` —— 那时进程表上只剩 `sleep 321`，标记一个字都不剩（实测栽过）
  const MARK = `325.${Math.floor(Math.random() * 900_000) + 100_000}`
  const fixture = startFixture({
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: `sleep ${MARK}`, background: true } },
      { kind: 'text', text: '交出去了。' },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({ label: '只剩后台', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })

    await typeLine(window, '起一条后台命令')
    await window.key('enter', { until: { text: '交出去了。' }, timeoutMs: 30_000 })
    const up = await pidsOf(MARK)
    check(up.length > 0, '那条后台命令**真站着**（按命令行找得到它）', `pids ${up.join(',')}`)

    // 这一轮收完了（助手那句在屏上、没有工具在跑），而运行事实照旧说「执行中」
    const settled = await window.capture({ label: '20-只剩后台命令（这一轮已收）' })
    keep(settled)
    // ⚠️ **U112 换过「在跑」认什么**（这一条要证的那件事一个字没变：**这会儿没有工具在跑**）：
    //    `⟳` 撤了，工具那一行的身份 `▸` **跑着与跑完都在**（状态在行尾：跑着 `●`、定住 `✓`），
    //    故今天认**两件**——① 那一行**在**、且行尾已**定住**（`✓`）② **在跑才有的那行读数不在**。
    //    （只判「不在」是不够的：屏上什么都没有时它照样绿——故先钉住那一行在。）
    check(
      settled.lines.some((line) => line.trimStart().startsWith('▸ exec(sleep') && line.trimEnd().endsWith('✓')),
      '工具那一行**在**、而且**已定住**（U112：定住写作行尾那颗 `✓`）',
      settled.lines.find((line) => line.includes('▸ ')) ?? '（屏上没有 `▸` 那一行）',
    )
    check(
      !settled.lines.some(isClockOnly),
      '没有工具在跑（**在跑才有的那行读数不在**）',
      settled.lines.find(isClockOnly) ?? '（屏上没有那一行——对的）',
    )

    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await window.capture({ label: '21-只剩后台命令时的三选' })
    keep(menu)
    check(has(menu, '当前任务仍在运行'), '**照样给三选**（不是「再按一次 ctrl+c 退出」）', '')
    check(has(menu, '停止任务') && has(menu, '转到后台') && has(menu, '停止并退出'), '三项都在', '')
    check(!has(menu, '再按一次 ctrl+c 退出'), '**没有**退回空闲那条路', '')

    // **停止任务 ⇒ 连那条后台命令一起收回**（真进程）
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    const gone = await waitPidsGone(MARK)
    const stopped = await window.capture({ label: '22-停掉之后（后台命令收回了）' })
    keep(stopped)
    check(gone, '**那条后台命令被收回了**（不在进程表上）', `pids ${(await pidsOf(MARK)).join(',')}`)

    // 界面留下、接着交代照旧（这一步在 `run-terminal` 那一组里另有真窗口用例）
    await window.quit()
    const report = await window.close({ graceMs: 5_000 })
    check(report.exit.by !== 'sigkill', '窗口自己走的', `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    for (const pid of await pidsOf(MARK)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // 已经没了
      }
    }
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 十一 · **同一份交代里「模型 → 工具 → 模型」**——菜单在**轮与轮之间**照旧停得掉。
 *
 * 一轮 ＝ 一次模型调用 ＋ 它请求的工具；一份输入跑好几轮。故「工具跑完、下一轮又起来」
 * 那一下**不许**把菜单作废——用户要停的就是这件事（规划裁决那一条的判据）。
 */
async function acrossRounds(): Promise<void> {
  const runs = tempDir('magic-u100-rounds-runs-')
  const fixture = startFixture({
    turns: [
      { kind: 'tool', name: 'exec', args: { cmd: 'sleep 1.2; echo 看完了' } },
      { kind: 'text', text: '看完了，接着做。', chunks: 40, chunkDelayMs: 400 },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({ label: '轮间菜单', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })

    await typeLine(window, '看一眼')
    await window.key('enter')
    // 工具正在跑——⚠️ **U112 起认的是「在跑才有的那行读数」**（`⟳` 那个记号撤了；那一行的
    // 身份 `▸` 跑着与跑完都在，认不出这件事），见 `isClockOnly` 的注。
    await waitUntil(window, '工具正在跑（底下那行读数）', (lines) => lines.some(isClockOnly), 20_000)
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await window.capture({ label: '23-工具正在跑时开的三选' })
    keep(menu)
    check(has(menu, '当前任务仍在运行'), '工具还在跑时菜单开得起来', '')

    // 它跑完 → 这一轮收束 → **下一轮起来**（真事件），菜单照旧在
    await window.wait({ text: '看完了，接着做。' }, { timeoutMs: 40_000 })
    const mid = await window.capture({ label: '24-下一轮起来了，菜单照旧在' })
    keep(mid)
    check(has(mid, '停止任务'), '**下一轮的途中菜单还在**（没被「轮」的收束作废）', '')
    // ⚠️ **页脚也得还是菜单的**（U100 真帧上撞过）：那一轮起止会把状态行右位写成
    // 「工作中／空闲」那一句，而此刻那一格归这一屏
    check(has(mid, '↑↓ 选 · 回车 定 · esc 返回'), '页脚照旧列**菜单的键位**（不被轮起止改写）', '')

    // 回车 ⇒ 停得掉（这一下若被守护挡下，判据当场红）
    const before = fixture.requests().length
    await window.key('enter')
    await window.wait({ text: '正在停' }, { timeoutMs: 20_000 })
    const stopped = await window.capture({ label: '25-轮间停得掉' })
    keep(stopped)
    check(has(stopped, '正在停'), '**停得掉**（没停下一轮，也没被挡下）', '')

    // **停完就不再往前跑了**（以 **HTTP 请求计数**为证，不看屏上有没有字）：
    // 屏上那句「看完了，接着做。」是**停之前**就流完的（它连同这一轮一起落的账），
    // 而「停之后有没有再问模型」只有夹具那一头的计数说得出来。
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    await Bun.sleep(1_500)
    const after = fixture.requests().length
    check(after === before, '**停之后没有再问模型**（请求数不涨）', `${before} → ${after} 趟`)

    await window.close({ graceMs: 5_000 })
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 十二 · **失联**——把管理者**杀**掉，这一屏要**留着**并如实说（不自动退场）。
 *
 * 规划裁决：「控制连接丢失……**留在界面如实说明；不得自动退场**」。故这里量三件：
 * 那一行实话在、状态那一格改成「状态待确认」、`ctrl+c` 两下仍走得掉（离开那扇门留着）。
 */
async function disconnected(): Promise<void> {
  const runs = tempDir('magic-u100-lost-runs-')
  const fixture = startFixture({ turns: [{ kind: 'text', text: SLOW, chunks: 40, chunkDelayMs: 500 }] })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({ label: '失联', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })

    await ask(window, '长话', SLOW_HEAD)

    // **杀掉管理者**（按它自己的启动目录认它——不是模式匹配杀别的什么）
    // ⚠️ 模式**不带前导 `--`**：`pgrep -f --internal-manager` 会被它当成自己的长选项报错
    //     （实测：一个都数不到，还看成「没有管理者」）
    const managers = await pidsOf('internal-manager', sandbox.root)
    check(managers.length === 1, '这一摊只有一个管理者（按沙地路径认）', `pids ${managers.join(',')}`)
    process.kill(managers[0] as number, 'SIGKILL')

    await window.wait({ text: '连接已断开' }, { timeoutMs: 20_000 })
    await Bun.sleep(1_500) // 给它几拍：**不该**自己退
    const lost = await window.capture({ label: '26-失联之后（留在界面）' })
    keep(lost)
    check(has(lost, '连接已断开，暂时无法确认任务状态'), '**如实说**连接断了（一句话，不写协议细节）', '')
    check(has(lost, '状态待确认'), '状态那一格改成「状态待确认」（不把历史 working 当现况）', '')
    check(has(lost, '› '), '这一屏**留着**（输入行还在——没自动退场）', '')
    check(
      !has(lost, '交代一件事，回车发送'),
      '输入行不再承诺「回车发送」（发不出去的事不许写在占位里）',
      '',
    )

    // 离开那扇门还在：`ctrl+c` 两下
    await window.key('ctrl+c')
    await window.key('ctrl+c')
    const report = await window.close({ graceMs: 8_000 })
    check(report.exit.by === 'app', '要走的时候走得掉（ctrl+c 两下）', `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/** 带那一段的进程号（`pgrep -f`）——`also` 给定时要求命令行里同时含它（认「哪一摊的」）。 */
async function pidsOf(mark: string, also?: string): Promise<readonly number[]> {
  const proc = Bun.spawn(['pgrep', '-f', mark], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  const pids = text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)

  if (also === undefined) return pids
  const kept: number[] = []
  for (const pid of pids) {
    const one = Bun.spawn(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
    const line = await new Response(one.stdout as ReadableStream<Uint8Array>).text()
    await one.exited
    if (line.includes(also)) kept.push(pid)
  }

  return kept
}

/** 等那一组进程没了（有界）。 */
async function waitPidsGone(mark: string, timeoutMs = 30_000): Promise<boolean> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    if ((await pidsOf(mark)).length === 0) return true
    if (Bun.nanoseconds() > until) return false
    await Bun.sleep(100)
  }
}

/**
 * 十三 · **别的列表 → 三选**（U100 合前复核 · 返修一）——两张列表的选中项是两回事。
 *
 * 真反例：先在 `/resume` 里挪到第 3 条，再按 `ctrl+c`；旧写法把那**另一张列表**的索引带了
 * 进来 ⇒ 回车落在「停止并退出」上。判据：**新开的三选恒第一项**（按字格看高亮）、
 * `↑↓` 照旧挪得动、`esc` 回去**原列表照原样**（还是第 3 条、没被筛过）。
 */
async function menuAfterList(): Promise<void> {
  const runs = tempDir('magic-u100-list-runs-')
  const fixture = startFixture({
    turns: [
      { kind: 'text', text: '答复丙' },
      { kind: 'text', text: '答复乙' },
      // 甲的事**慢慢长**（这一趟要在它跑着的时候走完「开列表 → 挪两项 → 开三选 → 返回」，
      // 故这一轮得**比那几步加起来还长**：实测 16 秒那版会在中途收工，Ctrl+C 于是走了空闲那条路）
      { kind: 'text', text: SLOW, chunks: 120, chunkDelayMs: 500 },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []
  let window: UiSession | undefined

  try {
    // **真准备三条会话**：列表里得有**具体的一项**可挪、可比——一条会话的列表里
    // 「焦点在第一条」是必然的，拿它当判据什么也证明不了。
    // ⚠️ 用**三扇窗**（同一块沙地）而不是 `/clear`：`/clear` 在 PTY 上会先弹补全候选，
    // 紧跟着的回车可能被候选吃掉（实测栽过：命令带着多余的字提交，回一句「认得的用法」）。
    const third = await createUiSession({ label: '丙的事', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    windows.push(third)
    await typeLine(third, '丙的事')
    await third.key('enter', { until: { text: '答复丙' }, timeoutMs: 25_000 })

    const second = await createUiSession({ label: '乙的事', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    windows.push(second)
    await typeLine(second, '乙的事')
    await second.key('enter', { until: { text: '答复乙' }, timeoutMs: 25_000 })

    window = await createUiSession({ label: '列表之后开三选', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    windows.push(window)
    await typeLine(window, '甲的事')
    await window.key('enter', { until: { text: SLOW_HEAD }, timeoutMs: 25_000 }) // 这一条**在跑**

    // 开 `/resume` 那张列表（先让目录回来），挪到**第三条**（具体的一项，不是首项）
    await typeLine(window, '/resume')
    await window.key('enter', { until: { text: '↑↓ 选 · 回车 定 · 打字筛' }, timeoutMs: 20_000 })
    const list = await window.capture({ label: '27-列表（当前那一项）' })
    keep(list)
    const firstFocused = focusedRow(list)
    check(firstFocused !== '', '列表那一屏**有高亮那一行**（探针要先看见它）', firstFocused)
    const titles = list.lines.filter((line) => /^\s*\d+\s/u.test(line)).length
    check(titles >= 3, '列表里**至少三项**（够挪、够比）', `${titles} 项`)

    /** 列表里**第一行**（首项）那一行的文字——「非首项」按它判。 */
    const firstRow = list.lines.find((line) => /^\s*\d+\s/u.test(line)) ?? ''

    // ⚠️ **一下一下来**（连着按两下方向键会丢一下——U40 驱动那条老经验）：按一下、等它落地
    await window.key('down')
    const moved = await waitFocusTo(window, (focused) => focused !== '' && focused !== firstFocused, '焦点挪到另一项')
    keep(moved, '27b-列表里挪到另一项')
    const target = focusedRow(moved)
    check(target !== '', '前置成立：**有具体那一项被选中**（不是空）', target)
    check(target !== firstRow, '前置成立：选中的**不是首项**（列表里第 2 项之后）', `首项 ${firstRow} / 选中 ${target}`)

    // **Ctrl+C ⇒ 三选**：高亮必须是**第一项**
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const menu = await waitFocus(window, '停止任务')
    keep(menu, '28-列表之后开的三选（默认第一项）')
    check(focusedRow(menu).includes('停止任务'), '**新开的三选恒选第一项**（高亮在「停止任务」）', focusedRow(menu))
    check(!focusedRow(menu).includes('停止并退出'), '没有继承那张列表的选中项', focusedRow(menu))
    check(focusedRow(menu) !== target, '而它**不是**刚才列表里那一项（两张列表各是各的）', `列表 ${target} / 三选 ${focusedRow(menu)}`)

    // `↓` 照旧挪得动（焦点证据按字格判：三项文字一个字没变）
    await window.key('down')
    const stepped = await waitFocus(window, '转到后台')
    keep(stepped, '29-三选里按-↓')
    check(focusedRow(stepped).includes('转到后台'), '按 ↓ 之后高亮到第二项', focusedRow(stepped))

    // `esc` ⇒ **原列表照原样回来**（比的是**同一项**）
    await window.key('esc')
    const back = await waitFocusTo(window, (focused) => focused === target, '列表回到刚才那一项')
    keep(back, '30-esc-之后回到原列表那一项')
    check(!has(back, '停止并退出'), '三选收了（回到原列表那一屏）', '')
    check(focusedRow(back) === target, '**原列表的选中照旧**：还是刚才那一项', `刚才 ${target} / 现在 ${focusedRow(back)}`)

    // 收尾：`esc` 收起列表 ⇒ **回输入屏**（等**那一屏自己的**东西不见了：
    // 列表底下那句键位提示带「打字筛」；⚠️ **不等状态行那句**——它是按状态给的，
    // 这一趟走到这儿时那一轮是「还在跑」还是「早跑完」都不一定）
    await window.key('esc', { until: { text: '›' }, timeoutMs: 10_000 }) // **输入行回来了**
    await window.wait({ absent: '打字筛' }, { timeoutMs: 10_000 }) // 列表页脚走了 ⇒ 那一屏收了

    // **走到能开三选的那一档**：那一轮还在跑 ⇒ 直接按；早跑完了 ⇒ 先交代一句让它重新在跑
    // （空闲时 `ctrl+c` 走的是「按两次退出」那条路——那不是这一趟要验的事）
    const busy = async (): Promise<boolean> => {
      const shot = await window?.capture({ label: 'cleanup-state' })
      return shot?.lines.some((line) => line.includes('工作中')) === true
    }

    if (!(await busy())) {
      await typeLine(window, '再来一件')
      await window.key('enter', { until: { text: SLOW_HEAD }, timeoutMs: 25_000 })
    }

    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
    await window.quit()
    const report = await window.close({ graceMs: 5_000 })
    check(report.exit.by !== 'sigkill', '窗口自己走的', `by=${report.exit.by}`)
    window = undefined
  } finally {
    for (const one of windows) await one.close().catch(() => {})
    await window?.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 十四 · **审批被三选遮住 → 另一窗口停掉这条运行**（U100 合前复核 · 返修二其一）。
 *
 * 判据：被罩住的那张卡是**过期快照**——不能从屏栈复活、不向内核代答、也不替用户取消；
 * 草稿照旧；`ctrl+c` 回到**离开**那条路。
 */
async function staleCardAfterStop(): Promise<void> {
  const runs = tempDir('magic-u100-stale-runs-')
  const fixture = startFixture({
    turns: [
      // ⚠️ **受控返回**：**同一个 tool 回合先慢慢流一段正文再给工具**——那几百毫秒就是
      //    「模型返回前」那一段，草稿才有地方录（卡一挂上就占着输入区了 ✗）。
      // ⚠️ **不能拆成「先 text 回合、再 tool 回合」**：text 回合以 `finish_reason=stop` 收尾，
      //    生产**不会再问第二轮**（那是这一轮正常结束）——等审批必然超时（复核指出的坑）。
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' }, text: '我先看一眼再动手。', chunks: 40, chunkDelayMs: 400 },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let mine: UiSession | undefined
  let other: UiSession | undefined

  try {
    mine = await createUiSession({ label: '被罩住的卡', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    await typeLine(mine, '跑一条命令')
    await mine.key('enter', { until: { text: '我先看一眼' }, timeoutMs: 25_000 })
    // **模型返回之前**录一段**独立、未提交**的草稿（不能拿已经交代出去的文字算草稿）
    await mine.send('打了一半的草稿', { until: { text: '› 打了一半的草稿' }, timeoutMs: 10_000 })
    // 这一轮说完 ⇒ 卡片到（草稿被 `takeOver` 收进 `stashed`）
    await mine.wait({ text: 'y / n' }, { timeoutMs: 30_000 })
    await mine.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })
    const covered = await mine.capture({ label: '31-卡被三选罩住' })
    keep(covered)
    check(has(covered, '当前任务正在等待你'), '待答时标题是「正在等待你」那一版', '')
    check(!has(covered, 'y / n'), '卡被这一屏压住（一屏不摆两套键）', '')

    // —— 另一扇窗**停掉同一条运行**（整体那一档）——
    other = await createUiSession({ label: '另一扇窗', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    await typeLine(other, '/resume')
    await other.key('enter', { until: { text: '跑一条命令' }, timeoutMs: 20_000 })
    await other.key('ctrl+x')
    await waitUntil(other, '那一行落定为「已停止」', (lines) =>
      lines.some((line) => /^\s*\d+\s/u.test(line) && line.includes('已停止')),
      30_000,
    )
    const stopped = await other.capture({ label: '32-另一扇窗把它停了' })
    keep(stopped)
    check(has(stopped, '已停止'), '另一扇窗那一行读作「已停止」', '')

    // —— 回到被罩住那一扇窗 ——
    // ⚠️ **只在菜单还开着时才按 `esc`**：那一轮被停掉之后 `turn.end` 一到，菜单会**自己收起**
    //    （那张卡作废时连同它上面那一屏一并收），此时再按 `esc` 是**正常语义「清草稿」**
    //    ——那就把要验的那一段草稿自己擦掉了 ✗
    await Bun.sleep(800)
    const mid = await mine.capture({ label: '33-另一扇窗停完之后（菜单可能已自己收起）' })
    if (mid.lines.some((line) => line.includes('停止任务'))) await mine.key('esc')
    await Bun.sleep(500)
    const back = await mine.capture({ label: '33b-过期的卡没有复活' })
    keep(mid, '33-停完之后那一屏')
    keep(back)
    check(!has(back, 'y 批准') && !has(back, 'y / n'), '**过期的卡没有复活**（那一代早没了）', '')
    check(has(back, '› '), '回到输入行（界面照旧在）', '')
    check(
      inputLineOf(back).includes('打了一半的草稿'),
      '**草稿原样归还**（卡接管时收起的那一段，回来时还在输入行上）',
      inputLineOf(back),
    )
    // **那一行不再冒充「运行中」**（U100 合前复核 · 呈现补：核销之后那一件的结果不会再来）
    //
    // ⚠️ **U112 换过这一条认什么**（这一条要证的那件事一个字没变）：`⟳` 撤了、`⟳ 运行中`
    //    那句自述也整个撤了；核销之后那一件在屏上长这样——头一行 `▸ 工具(参数)` ＋ 行尾
    //    那颗 `●`，**底下什么都没有**（`log.ts`：lost ⇒ 只有头一行，不摆那行读数）。
    //    故今天认两件：① 那一行**在**（判「它报不报数」得先有那一行）② **底下没有读数那一行**。
    const lostRowAt = back.lines.findIndex((line) => line.trimStart().startsWith('▸ '))
    check(
      lostRowAt !== -1,
      '失联那一条工具行**还在屏上**（判「它还报不报数」得先有那一行）',
      back.lines.filter((line) => line.includes('▸ ')).join(' ⏎ ') || '（屏上没有 `▸` 那一行）',
    )
    check(
      !isClockOnly(back.lines[lostRowAt + 1] ?? '') && !back.lines.some(isClockOnly),
      '那一代核销之后**底下没有读数那一行**（不再把没落定的说成在跑、也不给它计时）',
      back.lines.find(isClockOnly) ?? '（屏上没有读数那一行——对的）',
    )
    check(
      !back.lines.some((line) => line.includes('✓')),
      '而它也没有被说成「跑成功了」（不冒充结果）',
      back.lines.find((line) => line.includes('✓')) ?? '',
    )
    check(!has(back, '交代一件事，回车发送'), '而输入行没有占位语（草稿占着它）', '')

    // `ctrl+c` 走**离开**那条路（不是又进三选）
    await mine.key('ctrl+c', { until: { text: '再按一次 ctrl+c 退出' }, timeoutMs: 10_000 })
    const leaving = await mine.capture({ label: '34-之后走的是离开那条路' })
    keep(leaving)
    check(has(leaving, '再按一次 ctrl+c 退出'), '`ctrl+c` 回到**离开**那条路（不是又进三选）', '')

    await mine.key('ctrl+c')
    const closed = await mine.close({ graceMs: 8_000 })
    check(closed.exit.by === 'app', '窗口自己走的', `by=${closed.exit.by}`)
    mine = undefined

    await other.quit()
    await other.close({ graceMs: 5_000 })
    other = undefined
  } finally {
    await mine?.close().catch(() => {})
    await other?.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

/**
 * 十五 · **审批被三选遮住 → 控制连接断了**（返修二其二）——`esc` 回去**仍是失联**：
 * 那一格不许被改回「等你定夺」（失联不是还能答），也不许被改成「空闲」（失联不是已停止）。
 */
async function staleCardAfterLost(): Promise<void> {
  const runs = tempDir('magic-u100-stalelost-runs-')
  const fixture = startFixture({
    turns: [
      // 同趟十四：**受控返回**——草稿要在卡片到来**之前**录进去（同一个 tool 回合先流正文）
      { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' }, text: '我先看一眼再动手。', chunks: 40, chunkDelayMs: 400 },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  let window: UiSession | undefined

  try {
    window = await createUiSession({ label: '遮住之后失联', artifacts: runs, sandbox, fixture, columns: 100, rows: 30 })
    await typeLine(window, '跑一条命令')
    await window.key('enter', { until: { text: '我先看一眼' }, timeoutMs: 25_000 })
    // **模型返回之前**录一段**独立、未提交**的草稿
    await window.send('半截草稿', { until: { text: '› 半截草稿' }, timeoutMs: 10_000 })
    await window.wait({ text: 'y / n' }, { timeoutMs: 30_000 })
    await window.key('ctrl+c', { until: MENU_UP, timeoutMs: 15_000 })

    // **杀掉管理者**（与趟十二同一条路：按沙地路径认它）
    const managers = await pidsOf('internal-manager', sandbox.root)
    check(managers.length === 1, '这一摊只有一个管理者', `pids ${managers.join(',')}`)
    process.kill(managers[0] as number, 'SIGKILL')
    await window.wait({ text: '连接已断开' }, { timeoutMs: 20_000 })

    // `esc` 回来 ⇒ **仍是失联**（失联时**没有事件**，菜单不会自己收——故这一下一定会按到菜单上）
    await window.key('esc')
    await Bun.sleep(500)
    const back = await window.capture({ label: '35-失联之后返回（仍是失联）' })
    keep(back)
    check(has(back, '状态待确认'), '状态那格**仍是「状态待确认」**（没被改回等你定夺、也没改成空闲）', '')
    check(
      !has(back, '等你定夺'),
      '**没有**把那张过期的卡摆回来（失联不是「还能答」）',
      back.lines.find((line) => line.includes('状态')) ?? '',
    )
    check(!has(back, 'y 批准') && !has(back, 'y / n'), '**没有审批键位**（卡没回来）', '')
    check(has(back, '› '), '界面还在（没自动退场）', '')

    // ① **先看草稿**：收起的那一段原样回来（⚠️ 草稿非空时**看不到**占位语——两者互斥）
    const withDraft = inputLineOf(back)
    check(
      withDraft.includes('半截草稿'),
      '**草稿原样归还**（失联不吞草稿）',
      withDraft,
    )

    // **失联那一档：那一行不再报秒数**（两次取帧比一比——秒数若在涨就是还在计时）
    // ⚠️ **U112 起这一块是「头一行 ＋ 它底下那一行」**（`⟳` 撤了，不能只按那个记号取行）：
    //    取**整块**（`▸ …` 那一行 ＋ 在跑才有的读数那一行）比字面——秒数若在涨，块就变；
    //    且**块非空才算数**（两边都空时「字面相同」是白给的，什么也没量到）。
    const rowBlock = (lines: readonly string[]): readonly string[] =>
      lines.filter((line) => line.trimStart().startsWith('▸ ') || isClockOnly(line))
    const tick1 = rowBlock(back.lines)
    await Bun.sleep(1_200)
    const later = await window.capture({ label: '35b-失联一秒多之后' })
    const tick2 = rowBlock(later.lines)
    check(
      tick1.length > 0 && tick1.join('|') === tick2.join('|'),
      '失联之后那一行**不再计时**（一秒多之后字面一字不变）',
      `前 ${tick1.join('|')} / 后 ${tick2.join('|')}`,
    )

    // ② **再把草稿清空**，另取一帧看那行占位（别要求同一行同时显示两者）
    for (let at = 0; at < 5; at += 1) await window.key('backspace')
    await Bun.sleep(300)
    const emptied = await window.capture({ label: '36-清空草稿之后（失联那句占位）' })
    keep(emptied)
    const emptyLine = inputLineOf(emptied)
    check(
      emptyLine.includes('连接已断开——此刻发不出这一句'),
      '草稿清空之后，输入行**直接**就是失联那句占位（发不出去的事不许写在占位里）',
      emptyLine,
    )
    check(!emptyLine.includes('回车发送'), '**不再**承诺「回车发送」', emptyLine)
    check(has(emptied, '状态待确认'), '状态那格照旧「状态待确认」', '')

    // 双按 `ctrl+c` 仍走得掉
    await window.key('ctrl+c')
    await window.key('ctrl+c')
    const report = await window.close({ graceMs: 8_000 })
    check(report.exit.by === 'app', '要走的时候走得掉', `by=${report.exit.by}`)
    window = undefined
  } finally {
    await window?.close().catch(() => {})
    await fixture.stop()
    await sandbox.dispose()
    removeDir(runs)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u100-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  /**
   * **只跑指定的几趟**（`--only 13,14,15`）——调试装置时用。
   *
   * 由头（复核建议）：一到十二趟在同一生产补丁上已完整通过多次，**调装置不必每次从第一趟起**
   * （一趟一趟加起来几分钟）；但**归档那一份必须是完整十五趟**（`--only` 不写就是全跑）。
   */
  const onlyAt = process.argv.indexOf('--only')
  const only =
    onlyAt === -1
      ? null
      : new Set(
          (process.argv[onlyAt + 1] ?? '')
            .split(',')
            .map((one) => Number(one.trim()))
            .filter((one) => Number.isInteger(one)),
        )
  const want = (trip: number): boolean => only === null || only.has(trip)

  try {
    if (want(1)) {
      console.log('· 1 · ' + "await once('宽', 100, 30)")
      await once('宽', 100, 30)
    }
    if (want(2)) {
      console.log('· 2 · ' + "await once('矮', 40, 10)")
      await once('矮', 40, 10)
    }
    if (want(3)) {
      console.log('· 3 · ' + 'await background()')
      await background()
    }
    if (want(4)) {
      console.log('· 4 · ' + 'await stopAndStay()')
      await stopAndStay()
    }
    if (want(5)) {
      console.log('· 5 · ' + 'await stopAndExit()')
      await stopAndExit()
    }
    if (want(6)) {
      console.log('· 6 · ' + 'await dropTerminal()')
      await dropTerminal()
    }
    if (want(7)) {
      console.log('· 7 · ' + 'await waiting()')
      await waiting()
    }
    if (want(8)) {
      console.log('· 8 · ' + 'await otherSession()')
      await otherSession()
    }
    if (want(9)) {
      console.log('· 9 · ' + 'await waitingAcrossBackground()')
      await waitingAcrossBackground()
    }
    if (want(10)) {
      console.log('· 10 · ' + 'await backgroundOnly()')
      await backgroundOnly()
    }
    if (want(11)) {
      console.log('· 11 · ' + 'await acrossRounds()')
      await acrossRounds()
    }
    if (want(12)) {
      console.log('· 12 · ' + 'await disconnected()')
      await disconnected()
    }
    if (want(13)) {
      console.log('· 13 · ' + 'await menuAfterList()')
      await menuAfterList()
    }
    if (want(14)) {
      console.log('· 14 · ' + 'await staleCardAfterStop()')
      await staleCardAfterStop()
    }
    if (want(15)) {
      console.log('· 15 · ' + 'await staleCardAfterLost()')
      await staleCardAfterLost()
    }

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
