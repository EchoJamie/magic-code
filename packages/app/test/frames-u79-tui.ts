#!/usr/bin/env bun
/**
 * U79 · **「需要你」那一档：不回执、不广播** —— 真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑的是**真链路到屏为止**：
 * 真 `cli.ts`（真装配 · 真闸门 · 真记录 · 真 Ink 外壳）跑在**真 PTY** 里，
 * **两扇窗共一块沙地**（同一个管理者 —— 那正是「一件事落到哪一页」成立的前提）。
 * 模型那一头是本机夹具（`ui/fixture.ts`，环回地址、一个付费请求都不发）。
 *
 * ## 这一单那一格（设计 · 会话与运行管理「通知」）
 *
 * | 那一类 | 落点 |
 * | --- | --- |
 * | **需要你** | **卡在那条会话里** …… **它不回执、不广播**。一个窗口都没有时，才加一记本机系统通知 |
 *
 * 「不回执」＝ 屏上不再有 `· 「…」等你定夺：…` 那一行（U74 撤的是「跑完了」那一条，
 * 这一条是 U79 收的另一半）；「不广播」＝ 它**不许落到别的会话那一页上**
 * （旧判据是「有没有窗口连着」，A 页开着就印进 A）。
 *
 * ## 三张帧
 *
 * | 张 | 形态 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | **A 页开着、B 会话在等你** | A 那一页上**一个字都没有**（没有那条回执、也不认得出 B 的事） |
 * | ② | **连上 B** | **直接进那张卡**（卡与它的判据都在），**不是先看到一行字** |
 * | ③ | **反面**：`failed`（U74 刚落下那一档） | ⚠️ **U86 改**：那一档**也**按「还在看」判了——**看着它就不另印**；该在屏上看见的是**错本身** |
 *
 * ⚠️ **①那一张是「不广播」的正面**：改之前，B 那件事会**印在 A 这一页上**
 * （判据是「有没有窗口连着」，见缺陷 [[缺陷/D38 通知回执的落点与次序]]）；
 * 改之后 A 那一页干净，而 B 那件事**另有去处**（未读落盘 ＋ 下次打开一句汇总；同一跳上
 * 还有一记本机系统通知，而它 **U98 起缺省就不发**——见 `system-notify.ts` 的文件头）。
 * 记账那一半归 `bun test` 的 `run-stop.test.ts`，本文件一个字不弹。
 *
 * ⚠️ **②那一张走的是既有那一手**（U49 的接回快照，`applyResume` 里挂卡那一段）——
 * 本单**只动回执与广播**，没有重造它；这一张是**它没被碰坏**的物证。
 *
 * ⚠️ **③那一张 U86 改过**：本单（U79）落地时 `failed` 照旧按「有没有窗口连着」判、
 * 照旧广播，故那一张等的是 `· 「…」出错了：这一轮出错了`。**U86 把那一档也换成同一把
 * 尺子**（D38 的最后一格）⇒ 这一张改判「**不再另印那条回执** ＋ **错本身照旧在屏上**」。
 * 它留在这儿仍是**反面**：U79 只挪了「需要你」，这一张量的是**别的档在那次改动里没被碰坏**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u79-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
  statusLineOf,
} from './ui/index.ts'
import type { Capture, FixtureTurn, UiSession } from './ui/index.ts'
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
 * 故「①/②」那两条用的都是**本帧该有的东西**（卡与判据）与**本帧不该有的东西**
 * （那条回执的完整形态）各判一次。
 */
function has(shot: Capture, needle: string): boolean {
  return shot.text.includes(needle) || shot.history.some((line) => line.includes(needle))
}

/** 敲一行字并**等它真出现在屏上**（文本与回车分两次写——挤在一次里会丢键）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 等这一轮真收束（状态行回到空闲）。 */
async function settled(session: UiSession, timeoutMs = 30_000): Promise<void> {
  await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs })
}

/** 等**状态行**上出现「等你定夺」——那一格说的是「此刻」（判法同 `frames-u70-tui.ts`）。 */
async function waitCard(session: UiSession, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const screen = await session.screen()
    if (statusLineOf(screen.lines.map((line) => line.text)).includes('等你定夺')) return
    await Bun.sleep(20)
  }

  throw new Error('等不到裁决卡——状态行一直没写到「等你定夺」')
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
  const root = at === -1 ? tempDir('magic-frames-u79-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  /**
   * 剧本**按请求次序取**（第 n 次请求用第 n 个回合）——这一趟的次序是定死的：
   *
   * | 次 | 谁发的 | 用什么回合 |
   * | --- | --- | --- |
   * | 1 | 甲窗 | ① 一句普通回话 |
   * | 2 | 乙窗 | ② `chmod` 那一段 ⇒ **弹卡**（U76 名单里那一条；U77 起 `rm` 直接拒、连卡都不出） |
   * | 3 | 甲窗 | ③ 甩一个错 ⇒ **反面那一张** |
   * | 4 起 | 收尾 | ④ 普通回话（`用完了重复最后一个`——收尾那两步才落得回空闲） |
   */
  const turns: readonly FixtureTurn[] = [
    { kind: 'text', text: '甲窗那句答复。' },
    {
      kind: 'tool',
      name: 'exec',
      args: { cmd: 'chmod 755 .; echo 起手' },
      text: '这条要你定夺。',
    },
    { kind: 'http', status: 400, message: '夹具按剧本报错' },
    { kind: 'text', text: '收尾一句。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    // —— 甲窗：**A 页**。把一句普通回话跑完，屏上定下 A 的现场 ——
    const mine = await createUiSession({
      label: 'u79-甲窗（A 页）',
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

    // —— 乙窗：**B 会话**。第二条命令里带一段名单里的动作 ⇒ 卡挂着，B 就"在等你" ——
    const other = await createUiSession({
      label: 'u79-乙窗（B 会话）',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    windows.push(other)
    await typeLine(other, '乙窗那句')
    await other.key('enter')
    await waitCard(other)

    // —— ① **A 页开着、B 在等你 ⇒ A 那一页上不出现任何回执** ——
    const aPage = await mine.capture({ label: '01-A页上不出现任何回执' })
    keep(aPage)
    check(
      !has(aPage, '等你定夺'),
      '① A 那一页上**「等你定夺」一处都没有**（那条回执不再落到别的会话的页上）',
      aPage.text,
    )
    check(
      !has(aPage, '乙窗那句'),
      '① 也**认不出 B 那件事**（连它的标题都没落过来）',
      aPage.text,
    )
    check(
      has(aPage, '甲窗那句答复。'),
      '① A 自己那一轮**照旧在屏上**（不是把这一页清空了）',
      aPage.text,
    )

    // —— ② **连上 B ⇒ 直接进那张卡**（走 U49 的接回快照那一手） ——
    const third = await createUiSession({
      label: 'u79-丙窗（连上 B）',
      artifacts: join(out, 'runs'),
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    windows.push(third)

    // 接回那一条会话（列表里选它）——**这就是「连上它」那个动作**
    await typeLine(third, '/resume')
    await third.key('enter', { until: { text: '乙窗那句' }, timeoutMs: 20_000 })
    await third.key('enter')
    await waitCard(third)

    const back = await third.capture({ label: '02-连上B直接进那张卡' })
    keep(back)
    check(
      has(back, 'chmod 755 . —— 改权限 · 属主 · 属性 / ACL（不可逆）'),
      '② 连上就**直接进那张卡**（卡上点名的正是要授权的那一段）',
      back.text,
    )
    check(has(back, '判据：系统级（改权限 / 属主 / 属性 / ACL）'), '② 判据那一行也在', back.text)
    check(
      !has(back, '· 「乙窗那句」等你定夺'),
      '② 而**不是先看到一行字**（那条回执整个不在——连回执的形都没有）',
      back.text,
    )

    // —— ③ **反面**：`failed` 那一档**也不再另印一条回执**（U86 起，同一把尺子） ——
    await typeLine(mine, '再问一句')
    await mine.key('enter')
    // ⚠️ **U86 改**：等的从「那行回执」换成「**那一件事本身**」——你正看着它，那一条
    //    回执也撤了（屏上已经有那一行：`模型错误（…）：夹具按剧本报错`）
    await mine.wait({ text: '夹具按剧本报错' }, { timeoutMs: 30_000 })

    const others = await mine.capture({ label: '03-反面-failed不再另印回执' })
    keep(others)
    check(
      !has(others, '「甲窗那句」出错了'),
      '③ `failed` 那一类**不再另印一条回执**（U86：看着它就不说）',
      others.text,
    )
    check(
      has(others, '模型错误'),
      '③ 而那一件事**照旧在屏上**（撤的是那条回执，不是它）',
      others.text,
    )

    // —— 收尾：先把卡答复掉（B 那一条照旧能接着走），再各走各的那条路 ——
    await third.send('n')
    await Bun.sleep(500)
    await typeLine(mine, '收尾')
    await mine.key('enter', { until: { text: '收尾一句。' }, timeoutMs: 30_000 })

    await leave(mine, '甲窗')
    windows.shift()
    await leave(third, '丙窗')
    windows.shift()
    await leave(other, '乙窗')
    windows.shift()

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    for (const window of windows) await window.close({ graceMs: 1_000 }).catch(() => undefined)
    await fixture.stop()
    sandbox.dispose()
    if (at === -1) removeDir(root)
  }
}
