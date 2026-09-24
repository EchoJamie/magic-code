#!/usr/bin/env bun
/**
 * U54 · **停完之后，状态行那一格收尾**（缺陷 D34）——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 停完之后那一屏**通读**一遍是不是自洽的——回执说「停了」，而左下那一格还写着「● 工作中」
 * 是这一单的现场（D34 那张图），而它只在**真按键 ＋ 真执行者 ＋ 真管理者**那条路上出现
 * （单元层看得见行与文本，看不见「这一屏读起来矛盾不矛盾」）。
 *
 * ## 三趟，都是**停当前这一条**（D34 的触发面）
 *
 * | 趟 | 键 | 要看见什么 |
 * | --- | --- | --- |
 * | ① | `/resume` 里 `ctrl+w`（局部） | 回执「只停了…那一轮」；那一格**收起空闲**，不再挂着工作中 |
 * | ② | `/resume` 里 `ctrl+x`（整体） | 回执「正在停」→「停了」；那一格**收起空闲**，**且执行者真退了** |
 * | ③ | `/exit`（它走整体那一档） | 敲完 `/exit`、等到「停了」那一拍（界面马上要退）——那一格也不写工作中 |
 *
 * ⚠️ **为什么不停「别人」那一条**：那一条 U50 的帧套件（`frames-u50-tui.ts`）已经真跑过
 * ——那一趟里乙窗停的是甲窗，**乙窗自己那一格本来就该一动不动**。反向那一半（停别的会话
 * 不影响本壳）落在那一套上，本套只管**停自己**这一半。
 *
 * ## 「资源真退出」用读数，不是看屏
 *
 * ②那一趟在按下 `ctrl+x` 之前先读一次管理者的运行登记（`runs.json`），记下那一代的进程号；
 * 停完再读一次——**登记读作已停止，而那个号真的没了**。屏上说「停了」不算证据。
 *
 * 常宽 100×30 一趟，窄窗 46×30 一趟（判据一字不改——除了 `ctrl+w` 那一行在窄窗折行，
 * 判据按「接起来读」）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u54-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, createSandbox, startFixture, statusLineOf } from './ui/index.ts'
import type { Capture, SessionFacts, UiSession } from './ui/index.ts'
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
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 折行的判据要**接起来读**（窄窗上长句会被劈成两截——U50 那套踩过）。 */
const flat = (lines: readonly string[]): string => lines.map((line) => line.trim()).join('')

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

/** 等**状态行那一格**满足条件——那一格的判据都走它（取法见 `statusLineOf`）。 */
async function waitStatus(
  session: UiSession,
  what: string,
  ok: (line: string) => boolean,
  timeoutMs = 25_000,
): Promise<void> {
  await waitUntil(session, `状态行 ${what}`, (lines) => ok(statusLineOf(lines)), timeoutMs)
}

/**
 * **列表里那一条**那一行（按行首那个序号锚）——`/resume` 开着时它才在屏上。
 *
 * 为什么取帧之前要等**它**也落了定：回执是**当场**回的，而运行事实是**推**来的——
 * 「那一格」可能已经由内核事件收了尾，而列表那一行还停在旧读数上（两者同源，但差那一拍）。
 * 取一张**前后一致**的帧来通读，才是这一单要交的那张图。
 */
const ROW_AT = /^\s*\d+\s/u
const rowOf = (lines: readonly string[], title: string): string =>
  lines.find((line) => ROW_AT.test(line) && line.includes(title)) ?? ''

/** 等**那一行**说出某个词（＝那一份推来的事实到了）。 */
async function waitRow(session: UiSession, title: string, needle: string): Promise<void> {
  await waitUntil(session, `列表里「${title}」那一行读作「${needle}」`, (lines) =>
    rowOf(lines, title).includes(needle),
  )
}

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

// —— 运行登记（`runs.json`）那一份读数 ——

/** 登记里的一条（只取本单要读的那两格——形制见 `@magic/app` 的 `StoredRun`）。 */
type StoredRow = { readonly session: string; readonly pid?: number; readonly state: string }

/**
 * 读一次管理者的运行登记（`<家>/.magic/run/<指纹>/runs.json`）。
 *
 * ⚠️ **不自己拼那条路径**是不行的：本层只有家目录，而目录名是**数据目录的指纹**
 * （`paths.ts` 一处算出来）。故按「`run/` 下那一层」取——一个沙地里只有一个数据目录。
 */
function registryOf(facts: SessionFacts): readonly StoredRow[] {
  const root = join(facts.home, '.magic', 'run')
  const dirs = readdirSync(root)
  const rows: StoredRow[] = []

  for (const dir of dirs) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, dir, 'runs.json'), 'utf8')) as {
        readonly runs?: readonly StoredRow[]
      }
      rows.push(...(parsed.runs ?? []))
    } catch {
      // 还没写过 / 正写着（合并窗 300ms）：这一趟读不到就当没有——判据自己会再等
    }
  }

  return rows
}

/** 那个号上还站着进程吗（`EPERM` 也算在）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/** 那一趟要跑的东西——宽窄各一遍（除了尺寸，判据一字不改）。 */
async function once(mark: string, columns: number, rows: number): Promise<void> {
  const runs = tempDir(`magic-u54-frames-${mark}-`)
  // **慢着长**：停下来这件事要有东西可停（块多、块间慢——早跑完的话取到的就是「空闲」那一屏）
  const long = (say: string): { kind: 'text'; text: string; chunks: number; chunkDelayMs: number } => ({
    kind: 'text',
    text: say,
    chunks: 40,
    chunkDelayMs: 500,
  })
  const fixture = startFixture({
    turns: [
      long('这一句会慢慢长出来：先是一半，然后才是另一半。停它的时候它正长在半路上。'),
      long('第二句也慢慢长：这一趟要停的是**整体**那一档，而它不是头一次交代。'),
      long('第三句慢慢长：这一趟走 `/exit`，停完那一拍界面就要收摊了。'),
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    // —— 甲窗：本壳自己的会话，一条**慢慢长**的回话 ——
    const mine = await createUiSession({
      label: `${mark}-甲窗`,
      artifacts: undefined,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(mine)
    await typeLine(mine, '长话')
    await mine.key('enter')
    await mine.wait({ text: '这一句会慢慢长出来' }, { timeoutMs: 25_000 })

    // ⓪ **没停之前那一格照旧**（反向：改的是收尾，不是那一格本身）
    await waitStatus(mine, '在跑那一档', (line) => line.includes('● 工作中'))
    const running = await mine.capture({ label: `${mark}-00-没停之前` })
    keep(running)
    check(
      statusLineOf(running.lines).includes('● 工作中'),
      '没停之前那一格照旧写着「工作中」',
      statusLineOf(running.lines),
    )

    // ① **局部停止**（`ctrl+w`）——只收这一轮，那条运行还在
    await typeLine(mine, '/resume')
    await mine.key('enter', { until: { text: 'ctrl+x 停' }, timeoutMs: 20_000 })
    await mine.key('ctrl+w')
    await waitUntil(mine, '局部停止的回执', (lines) => lines.some((line) => line.includes('只停了')))

    // ⚠️ **等那一格收完再取帧**：回执是当场回的，而运行事实是**推**来的（合并窗 100ms
    //    ＋ 内核那边的中止要跑完）——不等它，取到的还是「跑着」那一屏（U50 那套踩过两次）
    //
    // ⚠️ **列表那一行也要等**（`waitRow`）：那张图要**通读**——列表说「执行中」而那一格说
    //    「○ 空闲」摆在同一屏上，与 D34 是同一类毛病（同一件事的两句不一样）。两者同源
    //    （都读推来的事实），差的那一拍是「内核事件已收尾、推的那份还没到」。
    await waitStatus(mine, '收起空闲', (line) => line.includes('○ 空闲'))
    await waitRow(mine, '长话', '当前空闲')
    const partial = await mine.capture({ label: `${mark}-01-只停这一轮` })
    keep(partial)
    check(
      !statusLineOf(partial.lines).includes('工作中'),
      '**那一格不再写着「工作中」**（这一单要修的那一句）',
      statusLineOf(partial.lines),
    )
    check(statusLineOf(partial.lines).includes('○ 空闲'), '它收成了「○ 空闲」', statusLineOf(partial.lines))
    check(
      flat(partial.lines).includes('那条运行还在'),
      '回执**没把局部说成整体**（那条运行还在）',
      flat(partial.lines).slice(0, 400),
    )

    // ② **整体停止**（`ctrl+x`）——先再交代一句（那条运行还在，接着用得上）
    //
    // ⚠️ **`esc` 要等它生效**（`直到输入行那句占位回来`）——不等的话，esc 那一个字节与
    //    紧接着打进去的正文会挤进**同一个读块**，Ink 把它当**转义序列**整段吞掉：
    //    抽屉不关，那几个字落进筛词（本套实测栽过一次，屏上写着「筛选「再说一句」」）
    await mine.key('esc', { until: { text: '交代一件事' }, timeoutMs: 10_000 })
    await typeLine(mine, '再说一句')
    await mine.key('enter')
    await mine.wait({ text: '第二句也慢慢长' }, { timeoutMs: 25_000 })
    await waitStatus(mine, '又跑起来了', (line) => line.includes('● 工作中'))

    // **按下停止之前**先读一次登记：那一代的号（停完拿它作证「资源真退了」）
    const before = registryOf(mine.facts())
    const standing = before.filter((one) => one.pid !== undefined && alive(one.pid))
    check(standing.length === 1, '停之前登记里**只有一代在站着**（一条会话一个执行者）', JSON.stringify(before))
    const pid = standing[0]?.pid as number

    await typeLine(mine, '/resume')
    await mine.key('enter', { until: { text: 'ctrl+x 停' }, timeoutMs: 20_000 })
    await mine.key('ctrl+x')
    await waitUntil(mine, '整体停止：这一档的回执', (lines) =>
      lines.some((line) => line.trimStart().startsWith('·') && line.includes('停了')),
    )

    // ⚠️ **等那一格落定**（推来的事实）——拿别的字当条件会当场恒真（U50 那套记过）
    await waitStatus(mine, '收起空闲（整体那档）', (line) => line.includes('○ 空闲'))
    await waitRow(mine, '长话', '已停止')
    const done = await mine.capture({ label: `${mark}-02-停这条运行` })
    keep(done)
    check(
      !statusLineOf(done.lines).includes('工作中'),
      '整体停完，那一格**也不写工作中**（回执说「停了」，那一格说「○ 空闲」——两句话不打架）',
      statusLineOf(done.lines),
    )
    check(statusLineOf(done.lines).includes('○ 空闲'), '它收成了「○ 空闲」', statusLineOf(done.lines))
    check(flat(done.lines).includes('停了'), '那一档的回执在（核销之后才报）', flat(done.lines).slice(0, 400))

    // **资源真退出**（读数，不是看屏）：登记读作已停止，而那个号真的没了。
    //
    // ⚠️ **两件都要等**（写盘是合并的，`RUNS_SAVE_MS` 300ms）：只等「号没了」的话，
    //    读到的还是停之前那一份（`state: running`）——本套实测栽过一次。
    await waitUntil(
      mine,
      '登记里那一代收成了「已停止」且那个号没了',
      () => {
        const rows = registryOf(mine.facts())
        return rows.length > 0 && rows.every((one) => one.state === 'stopped' && !alive(one.pid ?? 0))
      },
      20_000,
    )
    const after = registryOf(mine.facts())
    check(!alive(pid), `那个执行者真退了（号 ${pid} 上已经没人）`, JSON.stringify(after))
    check(
      after.every((one) => one.state === 'stopped'),
      '登记里那条会话读作「已停止」（不是靠屏上那句话）',
      JSON.stringify(after),
    )

    // ③ **`/exit`** —— 它走的就是整体那一档；取的是「停了」之后、界面收摊之前那一拍
    const other = await createUiSession({
      label: `${mark}-乙窗`,
      artifacts: undefined,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(other)
    await typeLine(other, '第三句')
    await other.key('enter')
    await other.wait({ text: '第三句慢慢长' }, { timeoutMs: 25_000 })
    await waitStatus(other, '在跑那一档（/exit 之前）', (line) => line.includes('● 工作中'))

    await other.send('/exit', { until: { text: ' › /exit' }, timeoutMs: 15_000 })
    await other.key('enter')
    await other.wait({ text: '停了' }, { timeoutMs: 30_000 })
    // ⚠️ **标签里不能有 `/`**（它是文件名的一半，会被当成路径分隔符——本套实测栽过一次）
    const leaving = await other.capture({ label: `${mark}-03-敲完-exit-那一拍` })
    keep(leaving)
    check(
      !statusLineOf(leaving.lines).includes('工作中'),
      '`/exit` 停完那一拍，那一格也不写工作中（那一屏马上要收，但**看得见**这一格）',
      statusLineOf(leaving.lines),
    )

    const closed = await other.close({ graceMs: 5_000 })
    check(closed.exit.by === 'app', '`/exit` 让应用自己退了场', `by=${closed.exit.by}`)
    windows.pop()

    // 收尾：甲窗自己走（**它这会儿真闲着**——状态行那一格收完了，ctrl+c 才走的是退出那条路）
    await mine.quit()
    const mineClosed = await mine.close({ graceMs: 5_000 })
    check(mineClosed.exit.by !== 'sigkill', '甲窗自己走的', `by=${mineClosed.exit.by}`)
    windows.shift()
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u54-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· 常宽 100×30')
    await once('宽', 100, 30)
    console.log('· 窄窗 46×30')
    await once('窄', 46, 30)

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
