#!/usr/bin/env bun
/**
 * U86 · **「出错了」那一档也按「还在看」判** —— 真 PTY 留帧与验收判据（D38 的最后一格）。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑的是**真链路到屏为止**：
 * 真 `cli.ts`（真装配 · 真闸门 · 真记录 · 真 Ink 外壳）跑在**真 PTY** 里，
 * **三扇窗共一块沙地**（同一个管理者 —— 那正是「一件事落到哪一页」成立的前提）。
 * 模型那一头是本机夹具（`ui/fixture.ts`，环回地址、一个付费请求都不发）。
 *
 * ## 这一单那一格（设计 · 会话与运行管理「通知」）
 *
 * | 那一类 | 落点 |
 * | --- | --- |
 * | **出错了** | **你正看着** ⇒ 不印（**屏上已经有那一行**）· **没看着** ⇒ 系统通知 ＋ 下次打开汇总 |
 *
 * ⚠️ **判据是「这条会话有没有窗口正看着它」，不是「有没有窗口连着」**——两者差在
 * 「A 页开着、B 会话出错」这一形：按「有没有窗口」，B 那件事**两头都不说**
 * （系统通知不弹、回执又不该印），那一条就没人告诉用户了。这正是缺陷
 * [[缺陷/D38 通知回执的落点与次序]] 记的最后一格。
 *
 * ## 三张帧
 *
 * | 张 | 形态 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | **A 页开着、B 会话出错**（**没人看着 B**） | A 那一页**一个字都没有**（不认得出 B 那件事） |
 * | ② | **新开一扇窗** | **屏上就是那一句汇总**：「你不在的时候：1 项出错」——**B 那件事有人告诉用户** |
 * | ③ | **你正看着它而它出错** | **那条回执没有了**，而**错本身照旧在屏上**（`模型错误（…）：…`） |
 *
 * ## ⚠️「B 出错而没人看着它」在真 PTY 里是**怎么造出来的**（要你知道）
 *
 * 直觉那一手（**把 B 那扇窗关掉，让它在后台出错**）**今天走不通**：最后一个看客一走，
 * 执行者就按收缩那条路收摊，那一轮记的是 `aborted / 连接断了`——**`aborted` 不说话**
 * （用户自己按的中断才不报，见 `manager.ts` 的 `notify` 注）。实测：把 B 那扇窗
 * `close()` 掉之后，屏上那一行读作「那一代执行者收摊了（连接断了）」，而**一条
 * `failed` 都没有**。（真产品今天不承诺「关掉窗口工作仍在」——那是**设计第三步**还没交付的
 * 那一格，见 [[设计/会话与运行管理]] 的落地次序。）
 *
 * ⇒ 本文件走的是**另一条真路**：**那一代异常退出**（`executor.ts` 的 `crashed` 那一档）——
 * 用一个 SIGKILL 打掉 B 那一代的执行者进程（**按 `runs.json` 里那一个 pid，只杀这一个**）。
 * 那正是 U50 里「异常退出也是一类转换 · 报的是 `failed`」那一格，而它与「这一轮出错了」
 * 在**这一条判据上完全同形**：`watchersOf(session)` 会跳过**已经收摊的那一代**
 * （「已经结束的那一代不算看客」——`manager.ts` 那条注），故**B 那件事落进「没人看着」那一档**，
 * 而 A 页开着（`clients.size = 2`）——**旧判据（有没有窗口连着）会把它广播给两扇窗**。
 *
 * ⚠️ **「B 那件事仍然有人告诉用户」的物证有三件**（工单明写「别只说通知弹了」）：
 * 1. **下次打开一句汇总** —— 见帧 ②：**新开的那扇窗屏上**就是那一句；
 * 2. **未读落盘** —— 那一份 `notices.json`（`kind: "failed"` / `unread: true`）原样归档进
 *    本趟的 `--out` 目录；
 * 3. **系统通知那一跳的入口** —— 它就在同一跳里（落盘之后紧接的那一声，见 `manager.ts`
 *    的 `notify`）。⚠️ **U98 起缺省不接**（真发的实现已删，见 `system-notify.ts` 的文件头）：
 *    这一格今天一个字都不发，故**物证就是上面那两条**。端口还在——**逐字**那一半归
 *    `bun test`：`run-stop.test.ts` 的「A 页开着、B 会话出错」那条用 `notifySystem`
 *    **端口记账**咬 `有一件工作出错了——打开看是哪条`。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u86-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagicHome, RunNotice } from '@magic/contracts'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
  statusLineOf,
} from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { runPathsOf } from '../src/run/paths.ts'
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
    `${JSON.stringify(
      { columns: shot.columns, rows: shot.rows, cursor: shot.cursor, lines: shot.lines },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（scrollback ${shot.scrollback}）\n${shot.text}`)
}

/**
 * 屏上（可见那一屏 ＋ 滚进去的）有没有这句话。
 *
 * ⚠️ **反面判据不许拿它当唯一尺子**（U70 踩过的那一形）：回执写完就留在屏上，
 * 一场里只要出现过一次，后面每一帧都命中它 ⇒ 拿它认「这一帧有没有印」会假绿。
 * 故①②③三条都同时判**本帧该有的东西**与**本帧不该有的东西**。
 */
function has(shot: Capture, needle: string): boolean {
  return shot.text.includes(needle) || shot.history.some((line) => line.includes(needle))
}

/** 那一摊的路径（`notices.json` / `runs.json`）——按产品自己那两件算，不照目录结构猜。 */
function pathsOf(sandbox: Sandbox): MagicHome & { readonly notices: string; readonly runs: string } {
  const magic: MagicHome = { home: sandbox.home, base: join(sandbox.home, '.magic') }
  return Object.assign(magic, runPathsOf(magic, sandbox.dataDir, tmpdir()))
}

/** 等一个条件成立（20 秒上界）——**轮询是用例的事**，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(20)
  }
}

/** 敲一行字并**等它真出现在屏上**（文本与回车分两次写——挤在一次里会丢键）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession, timeoutMs = 30_000): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs })
}

/** 收尾：空闲了再连按两次 ctrl+c（产品那条路，`quit()` 等的就是空闲那一刻）。 */
async function leave(session: UiSession, who: string): Promise<void> {
  await settled(session, 30_000)
  await session.quit()
  const closed = await session.close({ graceMs: 5_000 })
  check(closed.exit.by !== 'sigkill', `${who} 自己走的`, `by=${closed.exit.by}`)
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u86-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  /**
   * 剧本**按请求次序取**（第 n 次请求用第 n 个回合）——这一趟的次序是定死的：
   *
   * | 次 | 谁发的 | 用什么回合 |
   * | --- | --- | --- |
   * | 1 | 甲窗 | ① 一句普通回话（**A 页**的现场） |
   * | 2 | 乙窗 | ① 一句普通回话（**B 会话**立起来——随后的「异常退出」落在它身上） |
   * | 3 | 甲窗 | ② 甩一个错 ⇒ **③那一张**（正看着它） |
   * | 4 起 | 收尾 | ③ 普通回话（收尾那两步才落得回空闲） |
   */
  const turns: readonly FixtureTurn[] = [
    { kind: 'text', text: '甲窗那句答复。' },
    { kind: 'text', text: '乙窗那句答复。' },
    { kind: 'http', status: 400, message: '夹具按剧本报错' },
    { kind: 'text', text: '收尾一句。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const paths = pathsOf(sandbox)
  const windows: UiSession[] = []

  try {
    // —— 甲窗：**A 页**。把一句普通回话跑完，屏上定下 A 的现场 ——
    const mine = await createUiSession({
      label: 'u86-甲窗（A 页）',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    windows.push(mine)
    await typeLine(mine, '甲窗那句')
    await mine.key('enter', { until: { text: '甲窗那句答复。' }, timeoutMs: 30_000 })
    await settled(mine)

    // —— 乙窗：**B 会话**。跑完一轮就停在那儿（它的那一代随后要被异常打掉）——
    const other = await createUiSession({
      label: 'u86-乙窗（B 会话）',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    windows.push(other)
    await typeLine(other, '乙窗那句')
    await other.key('enter', { until: { text: '乙窗那句答复。' }, timeoutMs: 30_000 })
    await settled(other)

    /**
     * —— **B 那一代异常退出**（见文件头注：这是「没人看着的 B」在真 PTY 里唯一的来路）——
     *
     * ⚠️ **只杀那一个 pid**（`runs.json` 里最晚起的那一代就是 B 的），**不按名字杀**
     * （这机器上还有别人的 `bun`）。
     */
    const registry = JSON.parse(readFileSync(paths.runs, 'utf8')) as {
      runs: { gen: number; pid: number; startedAt: number }[]
    }
    const latest = [...registry.runs].sort((one, two) => two.startedAt - one.startedAt)[0]
    if (latest === undefined) throw new Error('盘上一条运行都没有——B 那一代没立起来')
    console.log(`\n（打掉 B 那一代：gen=${latest.gen} pid=${latest.pid}）`)
    process.kill(latest.pid, 'SIGKILL')

    /**
     * 等**那一代真被核销**（登记里 `state` 变成 `stopped`）——这是个**前条件**，
     * 不是判据：新旧两种行为下它都成立。
     *
     * ⚠️ **不许拿「那一件落了盘」当等待条件**（AGENTS.md 那条「**超时红 ≠ 判据咬得住**」）：
     * 旧行为下它**永远不落盘**（那一档走的是广播，不记未读）⇒ 反向验证会红在一句超时上，
     * 看起来像验过了，其实红的是「它没来」而不是「旧行为把那一行印到了 A 页上」。
     * 故等的是前条件，判据落到下面那几行 `check` 上。
     */
    await waitFor('那一代被核销', () => {
      try {
        const now = JSON.parse(readFileSync(paths.runs, 'utf8')) as {
          runs: { gen: number; state: string }[]
        }
        return now.runs.find((one) => one.gen === latest.gen)?.state === 'stopped'
      } catch {
        return false
      }
    })
    // 核销之后那一跳（落盘 ＋ 弹系统通知）就在同一条路上，给它一拍
    await Bun.sleep(500)

    // ① **A 页开着、B 出错 ⇒ A 那一页上不出现任何回执**
    //
    // ⚠️ **这一条排在最前**：它就是 D38 那一格本身——旧判据下这一页会印出一条
    //    `· 「另一条会话」出错了：…`（反向验证时红的正是这一行，**不是**一句超时）。
    const aPage = await mine.capture({ label: '01-A页上不出现任何回执' })
    keep(aPage)
    check(
      !has(aPage, '出错了'),
      '① A 那一页上**「出错了」一处都没有**（那条回执不再落到别的会话的页上）',
      aPage.text,
    )
    check(
      !has(aPage, '连接断了'),
      '① B 那一代的**收摊缘由也没串过来**（停止那一类回执只落在它自己那一扇窗上）',
      aPage.text,
    )
    check(!has(aPage, '乙窗那句'), '① 也**认不出 B 那件事**（连它的标题都没落过来）', aPage.text)
    check(
      has(aPage, '甲窗那句答复。'),
      '① A 自己那一轮**照旧在屏上**（不是把这一页清空了）',
      aPage.text,
    )

    /**
     * ① **B 那件事留了底**——`notify` 那一跳的物证：`kind: "failed"` ＋ **`unread: true`**。
     *
     * ⚠️ **`unread` 这一格就是本单的另一半**：旧判据（有没有窗口连着）下它是 `false`
     * （「A 页开着」被当成有人看）⇒ 系统通知不弹、汇总里也不提——**那一条就没人告诉用户**。
     */
    const stored = readFileSync(paths.notices, 'utf8')
    writeFileSync(join(out, 'notices.json'), stored, 'utf8')
    const failedNotice = (JSON.parse(stored) as { notices: RunNotice[] }).notices.find(
      (one) => one.kind === 'failed',
    )
    check(
      failedNotice !== undefined,
      '① B 那一件事**留了底**（`notices.json` 里有一条 `failed`）',
      stored,
    )
    check(
      failedNotice?.unread === true,
      '① 它标着**未读**（`unread: true`——「没人看着」那一档才走系统通知 ＋ 下次打开汇总）',
      stored,
    )

    // —— **B 那件事仍然有人告诉用户**：新开一扇窗，看那句汇总真的上屏 ——
    const fresh = await createUiSession({
      label: 'u86-丙窗（事后新开）',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    windows.push(fresh)
    await fresh.wait({ text: '你不在的时候' }, { timeoutMs: 20_000 })

    const summary = await fresh.capture({ label: '02-下次打开一句汇总' })
    keep(summary)
    check(
      has(summary, '你不在的时候：1 项出错 —— /resume 看是哪几条'),
      '② 新开那一扇窗上**就是那句汇总**（`unreadSummaryOf`：1 项出错，不逐条念）',
      summary.text,
    )
    check(
      !has(summary, '乙窗那句'),
      '② 而它也**不认得出是哪一条**（汇总不逐条念——具体是哪一条归 `/resume`）',
      summary.text,
    )

    // —— ③ **你正看着它而它出错**：那一条回执没有了，错本身照旧在屏上 ——
    await typeLine(mine, '再问一句')
    await mine.key('enter')
    await mine.wait({ text: '夹具按剧本报错' }, { timeoutMs: 30_000 })

    const watched = await mine.capture({ label: '03-正看着它出错' })
    keep(watched)
    check(
      !has(watched, '「甲窗那句」出错了'),
      '③ **不另印那条回执**（`· 「甲窗那句」出错了：这一轮出错了` 一处都没有）',
      watched.text,
    )
    check(
      !has(watched, '这一轮出错了'),
      '③ 那条回执的**尾巴**也不在（不是换了个说法印）',
      watched.text,
    )
    check(
      has(watched, '模型错误'),
      '③ 而**错本身照旧在屏上**（`模型错误（…）：夹具按剧本报错`）——那才是「屏上已经有那一行」',
      watched.text,
    )
    check(
      statusLineOf(watched.lines).includes('出错'),
      '③ 状态行也照旧说得出这一场收在哪儿（`▲ 出错`）',
      statusLineOf(watched.lines),
    )

    // —— ④ **反面**：U74（跑完了）与 U79（需要你）两档在这次改动里**一个字没动** ——
    check(
      !has(watched, '那一轮跑完了'),
      '④ `done` 那一档照旧**一个字都不印**（U74 的口径未动）',
      watched.text,
    )
    check(
      !has(watched, '· 「甲窗那句」等你定夺'),
      '④ `needs-you` 那一档照旧**不产出**（U79 的口径未动）',
      watched.text,
    )

    // —— 收尾：把状态行从「出错」带回空闲，再各走各的那条路 ——
    await typeLine(mine, '收尾')
    await mine.key('enter', { until: { text: '收尾一句。' }, timeoutMs: 30_000 })

    await leave(mine, '甲窗')
    windows.splice(windows.indexOf(mine), 1)
    await leave(fresh, '丙窗')
    windows.splice(windows.indexOf(fresh), 1)
    // 乙窗那一代的执行者已经被打掉了，可**这扇窗自己**还在跑（它照旧能空闲退出）
    await leave(other, '乙窗')
    windows.splice(windows.indexOf(other), 1)

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    for (const window of [...windows]) await window.close({ graceMs: 1_000 }).catch(() => undefined)
    await fixture.stop()
    sandbox.dispose()
    if (at === -1) removeDir(root)
  }
}
