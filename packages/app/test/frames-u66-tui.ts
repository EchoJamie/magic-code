#!/usr/bin/env bun
/**
 * U66 · **工具行的计时只算执行本身**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 裁决卡挂着（在等用户）的那几秒，工具那行**报不报「跑了多久」**；批准之后那个读数
 * **从哪儿起算**。
 *
 * ## 判据怎么咬
 *
 * 三条各对工单的一句话：
 *
 * | 趟 | 造法 | 要看见什么 |
 * | --- | --- | --- |
 * | ① **内置工具**（`write` 必闸） | 卡挂着**停三秒**再取帧 | **那一行一个字都不报**（也不许把整行拿掉）；批准之后结论行照旧、读数从 0 起 |
 * | ② **外部工具**（MCP `slow`，永不返回） | 卡挂着停三秒 → 批准 → 隔 250ms / 再隔 1.5s 各取一帧 | 挂在卡上时不报数；**批准之后从 0 起**，且**接着往下走**（不是冻在 0），**也没把那三秒算进去** |
 * | ③ **反面**（没弹卡的工具） | 两笔都是**判轻的** `exec`（`echo` · `sleep`） | **一个卡都没有**（U76 起默认通，**不必先授权**），而那一行**照旧报耗时**（从发起到此刻——与改动前同形） |
 *
 * ⚠️ **读数靠屏上的字**（`⟳ 1.4s` / `✓ 3ms`），不是读内部状态：这一单要验的正是
 * **屏上那句话**。判「不报数」时扫的是**整屏每一行**——漏掉一处就等于放行。
 *
 * ⚠️ 这一支**跑完再一起报**（同 `u50-evidence.ts` 的姿势，不是 `frames-u60` 那种当场抛）：
 * 它要能**在改动前后各跑一遍**做对照——当场抛就只拿得到头一条判据之前的那几帧，
 * 「改前」那一趟的原始帧补不齐（而这一单的由头正是「改前那一屏长什么样」）。失败记账、末尾退非零。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u66-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, createUiSession, statusLineOf } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——入口解析 `--out` 之后填。 */
let out = ''

/** 判据攒着最后一起报（见文件头注「跑完再一起报」）。 */
const failures: string[] = []

function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}${detail === '' ? '' : `（${detail}）`}`)
    return
  }

  failures.push(what)
  console.log(`  ✗ ${what}${detail === '' ? '' : `（${detail}）`}`)
}

/** 留一屏——文本写进 `<out>/<序号-名字>.txt`，字格写进同名 `.json`。 */
function keep(shot: Capture): void {
  writeFileSync(join(out, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${shot.label}.json`),
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 一行里所有**读数**（毫秒）——`⟳ 1.4s` / `✓ 3ms` 里的那个数。 */
function readLine(line: string): readonly number[] {
  const found: number[] = []

  // 颜色已经是驱动那一侧的事（`Capture.lines` 是纯文本）
  for (const matched of line.matchAll(/(\d+(?:\.\d+)?)(ms|s)(?![0-9a-zA-Z])/gu)) {
    const value = Number(matched[1])
    found.push(matched[2] === 's' ? Math.round(value * 1000) : value)
  }

  return found
}

/**
 * 屏上所有读数——**整屏每一行**。
 *
 * ⚠️ 判据「卡片挂着时那一行不说跑了多久」的形态是「**整屏一个都没有**」，故它必须扫全屏：
 * 只盯工具那几行的话，读数换个地方冒出来就漏过去了。
 */
function readings(lines: readonly string[]): readonly number[] {
  return lines.flatMap((line) => readLine(line))
}

/** 屏上**跑动中工具那一行**（`⟳ ` 起头——头一行是名字与参数）。 */
function runningRow(lines: readonly string[]): string | undefined {
  return lines.map((line) => line.trim()).find((line) => line.startsWith('⟳ '))
}

/**
 * 屏上**那行钟**（`  ⟳ 1.4s` / `  ⟳ 运行中`）——工具行是**两行**：头一行名字与参数，
 * 第二行才是读数（见 `components/log.ts` 的 `toolLines`）。
 *
 * ⚠️ 别看头一行：`⟳ write 产物.txt` 上**没有**读数，判据会当场读成 undefined
 * （第一版就是这么错的——「没读数」与「读错了行」在断言里长得一模一样）。
 */
function clockRow(lines: readonly string[]): string | undefined {
  return lines.map((line) => line.trim()).find((line) => /^⟳\s*(?:\d|运行中)/u.test(line))
}

/** 屏上**结论行**（`✓ ` 起头）——`contains` 给出时取含它的那条（一轮里可能有好几条）。 */
function verdictRow(lines: readonly string[], contains = ''): string | undefined {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.startsWith('✓ ') && line.includes(contains))
    .at(-1)
}

/** 一行上头的那个读数（没有＝`undefined`）——跑动中那行与结论行各用一次。 */
function readingOf(line: string | undefined): number | undefined {
  return line === undefined ? undefined : readLine(line)[0]
}

/** 等一个条件在**可见屏**上成立（默认 20 秒）。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 20_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return lines
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

/** 起手那道闸：等它空闲（同既有几支帧套件）。 */
async function booted(session: UiSession): Promise<void> {
  await session.wait({ text: '空闲' }, { timeoutMs: 25_000 })
}

// ═══════════════════════════════════════════════════════════════════════
// ① 内置工具：卡片挂着时那一行不报数 ＋ 批准之后结论照旧
// ═══════════════════════════════════════════════════════════════════════

/**
 * `write` 是必闸（整文件覆盖要问）⇒ 一定弹卡，答复键是「`y` 批准 / `n` 拒绝」。
 *
 * ⚠️ **`write` 这一格 U76 一个字节没动**（名单那次收缩**只到 `exec` 那一层**：越界 ·
 * 判不出这两类在非 `exec` 工具上照旧判重），故这一趟照旧弹卡。
 * 卡上另有一格 `a`（本工作区总是允许）——它在**必闸类上是划掉的**（`decision.ts`），
 * U76 起 `a` 只在**取网**那件上按域名给（U72）；本趟答的是 `y`。
 *
 * 两帧：**卡片挂着那一刻**与**挂满三秒之后**。后者是这一单的现场——改之前它写着
 * `⟳ 3.4s`（那是「他还没答」的那一段），改之后它一个字都不报。
 */
async function builtinCard(mark: string): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u66-内置卡片-${mark}`,
      columns: 100,
      rows: 30,
      turns: [{ kind: 'tool', name: 'write', args: { path: '产物.txt', content: 'U66 写下的' } }],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    await typeLine(session, '写个文件')
    await session.key('enter', { until: { text: '等你定夺' }, timeoutMs: 15_000 })
    keep(await session.capture({ label: `${mark}-01-卡片刚挂上` }))

    // **挂着那几秒**——正是用户看到「还在涨」的那一段
    await Bun.sleep(3_000)
    const hung = await session.capture({ label: `${mark}-02-卡片挂着三秒` })
    keep(hung)

    const hungReadings = readings(hung.lines)
    check(
      hung.text.includes('等你定夺'),
      `【${mark}】取帧那一刻卡确实还挂着（前提：这一段真是在等你）`,
      statusLineOf(hung.lines),
    )
    check(
      runningRow(hung.lines) !== undefined,
      `【${mark}】① 工具那行**还在**（不是把整行拿掉了）`,
      runningRow(hung.lines) ?? '（屏上没有 `⟳` 那一行）',
    )
    check(
      hungReadings.length === 0,
      `【${mark}】① 卡片挂着时那一行**不报「跑了多久」**——整屏一个读数都没有`,
      hungReadings.length === 0 ? '整屏没有 `ms` / `s` 读数' : `实读 ${hungReadings.join(' / ')}ms`,
    )

    // —— 批准 → 真跑 → 结论照旧 ——
    await session.send('y', { until: { text: '已写入' }, timeoutMs: 15_000 })
    const ran = await session.capture({ label: `${mark}-03-批准之后跑完` })
    keep(ran)

    const verdict = verdictRow(ran.lines, '已写入')
    check(
      verdict !== undefined,
      `【${mark}】③ 批完真跑完，那一行的**结论照旧**（完成标记 ＋ 那句「已写入 …」）`,
      verdict ?? '（屏上没有结论行）',
    )

    // ② 结论行上那个耗时＝**真跑的那一段**（写下一个小文件），不是卡片挂着的那三秒
    const doneReading = readingOf(verdict)
    check(
      doneReading !== undefined && doneReading < 2_000,
      `【${mark}】② 批准之后读数**从 0 起**（不是卡片挂着的那三秒）`,
      doneReading === undefined ? '（结论行上没有读数）' : `实读 ${doneReading}ms（卡挂了三秒）`,
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ② 外部工具：挂着不报数 · 批准之后从 0 起（且接着走）
// ═══════════════════════════════════════════════════════════════════════

/**
 * MCP 的 `slow` **永不返回**——故批准之后那行会一直跑下去，正好用来读「它从哪儿起算」：
 * 改之前是 `⟳ 3.7s`（含挂卡的 3 秒），改之后是 `⟳ 0.2s` 并接着走。
 *
 * 收尾按既有的取消那一套（`ctrl+c`）——顺带确认这一单没把「中断」那一路弄坏。
 */
async function externalCard(mark: string): Promise<void> {
  const fake = join(REPO_ROOT, 'packages', 'mcp', 'test', 'support', 'fake-server.ts')
  const logDir = mkdtempSync(join(tmpdir(), 'magic-u66-mcp-'))
  const log = join(logDir, 'fake.jsonl')
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u66-外部卡片-${mark}`,
      columns: 100,
      rows: 30,
      turns: [{ kind: 'tool', name: 'mcp__fake__slow', args: {} }],
      // **显式配置**才连（只有配置里写了才拉起那条服务器进程）
      config: {
        mcp: {
          servers: {
            fake: {
              command: process.execPath,
              args: [fake],
              env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: 'fake' },
            },
          },
        },
      },
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    await typeLine(session, '来件拖住的')
    await session.key('enter', { until: { text: 'y 批准这一次' }, timeoutMs: 20_000 })
    await Bun.sleep(3_000)
    const hung = await session.capture({ label: `${mark}-04-外部件挂着三秒` })
    keep(hung)

    const hungReadings = readings(hung.lines)
    check(
      hungReadings.length === 0,
      `【${mark}】① 外部件挂着时那一行也**不报数**`,
      hungReadings.length === 0 ? '整屏没有 `ms` / `s` 读数' : `实读 ${hungReadings.join(' / ')}ms`,
    )

    // —— 批准 ——
    await session.send('y')
    await Bun.sleep(250)
    const justAfter = await session.capture({ label: `${mark}-05-批准之后两百五十毫秒` })
    keep(justAfter)

    await Bun.sleep(1_500)
    const later = await session.capture({ label: `${mark}-06-批准之后一秒五` })
    keep(later)

    const first = readingOf(clockRow(justAfter.lines))
    const second = readingOf(clockRow(later.lines))

    check(
      !justAfter.text.includes('y 批准这一次'),
      `【${mark}】批准之后卡收了（那一下真答了）`,
      runningRow(justAfter.lines) ?? '（屏上没有跑动中的那一行）',
    )
    check(
      first !== undefined && first < 1_000,
      `【${mark}】② 批准之后**从 0 起**（不是挂着的那三秒）`,
      first === undefined ? '（跑动中那行没有读数）' : `实读 ${first}ms（卡挂了三秒）`,
    )
    check(
      first !== undefined && second !== undefined && second > first && second < 3_000,
      `【${mark}】② 并且它**接着往下走**（不是冻在 0）——且那三秒没被算进来`,
      `批准后 250ms 时 ${String(first)}ms → 又过 1.5s 时 ${String(second)}ms`,
    )

    // 收尾：中断这一笔（`slow` 永不返回），顺手判中断那一路照旧
    await session.send('\u0003')  // ctrl+c（工作中＝中断）
    const canceled = await waitUntil(
      session,
      '中断的「已取消」',
      (lines) => lines.some((line) => line.includes('已取消')),
      15_000,
    )
    keep(await session.capture({ label: `${mark}-10-中断收尾` }))
    check(
      canceled.some((line) => line.includes('已取消')),
      `【${mark}】中断那一路照旧（那一笔说「已取消」）`,
      canceled.find((line) => line.includes('已取消')) ?? '',
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
    removeDir(logDir)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ③ 反面：没弹卡的工具，计时照旧（从发起到此刻）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 反面那一趟——**一个卡都没有**的工具，那一行的计时**与改动前同形**。
 *
 * 造法：两笔都是**判轻的** `exec`（`echo 先来一笔` · `sleep 2.5`——两个程序词都在只读
 * 那张表里、也不落路径）⇒ U76 起**默认通：一个卡都没有**。
 *
 * ⚠️ **【原锚 / 为何变 / 新锚】**
 * - **原锚**：先用「`a` 本工作区总是允许」答掉第一笔轻的 `exec`，第二笔同类**就不再问**。
 * - **为何变**：链的底从「默认问」翻成「**默认通**」——第一笔**根本不弹卡**，那条授权
 *   **无从来**；而「同类授不授权」这件事**已经没有对象**：判轻的本来就没人问，
 *   名单里那两条**不可授权**（卡上那一格是划掉的），`a` 如今只在**取网**那件上按域名给。
 *   **别把这一趟写成「那条授权放行了第二笔」——那是假话。**
 * - **新锚**：**两笔都没有卡**（第一笔留一帧 `07` 为证），而第二笔那一行的计时
 *   **照旧从发起算**（本趟真正要判的那一件，与改动前同形）。
 *
 * ⚠️ **这一趟判的是「没被我改坏」**：读数必须**仍在**，且是**从发起到此刻**那个数
 * （两秒半的量级）。若「批准才起算」误加到了自动放行那一路上，屏上会是 `0ms` 量级
 * ——那正是这一条当场抓的东西。
 */
async function noCard(mark: string): Promise<void> {
  let session: UiSession | undefined

  try {
    session = await createUiSession({
      label: `u66-没弹卡-${mark}`,
      columns: 100,
      rows: 30,
      turns: [
        { kind: 'tool', name: 'exec', args: { cmd: 'echo 先来一笔' } },
        { kind: 'tool', name: 'exec', args: { cmd: 'sleep 2.5' } },
        { kind: 'text', text: '两笔都完了' },
      ],
      artifacts: join(out, 'runs'),
    })
    await booted(session)

    // —— 第一笔：**不弹卡**（判轻的默认通）——留一帧为证，再去等第二笔 ——
    await typeLine(session, '先跑一笔')
    // 锚在**工具那一行**上（`● exec {"cmd":"echo 先来一笔"}`——参数原样印在行里）：
    // 它上屏＝这一笔真发出去了（不是被谁扣住了）
    await session.key('enter', { until: { text: '{"cmd":"echo 先来一笔"}' }, timeoutMs: 20_000 })
    const first = await session.capture({ label: `${mark}-07-第一笔不弹卡` })
    keep(first)
    check(
      first.text.includes('{"cmd":"echo 先来一笔"}'),
      `【${mark}】前提：第一笔**真发出去了**（工具行在屏上）`,
      first.text,
    )
    check(
      !first.text.includes('· 不可逆'),
      `【${mark}】前提：第一笔**一个卡都没有**（U76 起判轻的默认通——不必先授权）`,
      first.text,
    )
    // ⚠️ 键位提示**两串都要判**：轻卡写 `y / a / n`、重卡写 `y / n`（`HINT_DECIDE_LIGHT /
    // HEAVY`）——只判 `y / n` 会把轻卡放过去
    const firstStatus = statusLineOf(first.lines)
    check(
      !firstStatus.includes('等你定夺') &&
        !firstStatus.includes('y / n') &&
        !firstStatus.includes('y / a / n'),
      `【${mark}】前提：状态行也不是裁决态（根本没问）`,
      firstStatus,
    )

    // —— 第二笔：同类 ⇒ 同样不问；等它**跑起来** ——
    const running = await waitUntil(
      session,
      '第二笔（sleep 2.5）跑起来',
      (lines) => runningRow(lines)?.includes('sleep') === true,
      20_000,
    )
    await Bun.sleep(1_500)
    const mid = await session.capture({ label: `${mark}-08-没弹卡的那一笔（跑动中）` })
    keep(mid)

    check(
      !running.some((line) => line.includes('y 批准') || line.includes('· 不可逆')),
      `【${mark}】反面：第二笔**一个卡都没有**（判轻的默认通，走的是自动放行）`,
      running.filter((line) => line.includes('批准') || line.includes('不可逆')).join(' / ') || '（一条都没有——对的）',
    )
    check(
      !mid.text.includes('y 批准') && !mid.text.includes('· 不可逆'),
      `【${mark}】反面：它跑着的时候屏上也没有卡`,
      mid.lines
        .map((line) => line.trim())
        .filter((line) => line.startsWith('● ') || line.startsWith('⟳ '))
        .join(' ⏎ '),
    )

    // 读数**仍在**，且是**从发起到此刻**那个数——这一条就是「与改动前同形」
    const live = readingOf(clockRow(mid.lines))
    check(
      live !== undefined && live > 800,
      `【${mark}】反面：没弹卡的工具**照旧报耗时**（从发起到此刻，两秒半的量级）`,
      live === undefined ? '（跑动中那行没有读数 ✗）' : `实读 ${live}ms`,
    )

    // —— 跑完：结论行上的耗时同样是**从发起**那一段 ——
    const lines = await waitUntil(
      session,
      '第二笔跑完（结论行上的「完成」）',
      (all) => verdictRow(all, '完成') !== undefined,
      25_000,
    )
    const finished = await session.capture({ label: `${mark}-09-没弹卡的那一笔（跑完）` })
    keep(finished)
    const final = readingOf(verdictRow(lines, '完成'))
    check(
      final !== undefined && final >= 2_000,
      `【${mark}】反面：跑完之后结论行报的是**两秒半**（发起到落地——没被改短）`,
      final === undefined ? '（结论行上没有读数）' : `实读 ${final}ms`,
    )
  } finally {
    if (session !== undefined) await session.close().catch(() => {})
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u66-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· ① 内置工具（write 必闸）· 卡片挂着 → 批准')
    await builtinCard('常宽')
    console.log('· ② 外部工具（MCP slow）· 挂着 → 批准 → 再走一秒五')
    await externalCard('常宽')
    console.log('· ③ 反面：没弹卡的工具')
    await noCard('常宽')

    if (failures.length === 0) {
      console.log(`\n全部判据通过。帧落在 ${out}`)
    } else {
      console.log(`\n${failures.length} 条判据不过：`)
      for (const what of failures) console.log(`  ✗ ${what}`)
      console.log(`帧落在 ${out}`)
      process.exitCode = 1
    }
  } finally {
    if (at === -1) removeDir(root)
  }
}
