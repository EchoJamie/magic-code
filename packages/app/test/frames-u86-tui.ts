#!/usr/bin/env bun
/**
 * U86 常驻宿主修订：真 PTY 验证失败不串进其它会话正文，具体事项持久留存。
 * A 完成后保持界面；B 用受控模型产生待答责任，再按本次登记 PID 制造异常退出。
 * TUI 无可靠焦点证据；完成、待答、失败均留未读，hello 汇总不标读。
 * attention.json 由 RecordsStore.attention 导出，宿主日志与帧保留在 --out。
 * 测试宿主持有专用 stdin，全程只用本机模型夹具，不发系统通知。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MagicHome } from '@magic/contracts'
import {
  MAGIC_IDLE_MARK,
  createSandbox,
  createUiSession,
  startFixture,
  statusLineOf,
} from './ui/index.ts'
import type { Capture, FixtureTurn, Sandbox, UiSession } from './ui/index.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { tempDir } from './tmp.ts'
import { attentionFacts } from './resident-attention-fixture.ts'
import { startResidentHost } from './resident-host-fixture.ts'

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

/** 那一摊的路径（`runs.json`）——按产品自己那两件算，不照目录结构猜。 */
function pathsOf(sandbox: Sandbox): MagicHome & { readonly runs: string } {
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
   * | 2 | 乙窗 | ① 要求工具审批（B 会话待答——随后制造该执行者异常退出） |
   * | 3 | 甲窗 | ② 甩一个错 ⇒ **③那一张**（正看着它） |
   * | 4 起 | 收尾 | ③ 普通回话（收尾那两步才落得回空闲） |
   */
  const turns: readonly FixtureTurn[] = [
    { kind: 'text', text: '甲窗那句答复。' },
    { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' }, text: '乙窗那句答复。' },
    { kind: 'http', status: 400, message: '夹具按剧本报错' },
    { kind: 'text', text: '收尾一句。' },
  ]

  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const paths = pathsOf(sandbox)
  const windows: UiSession[] = []
  const host = await startResidentHost(sandbox, join(out, 'host'))

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

    // —— 乙窗：**B 会话**。明确输入产生待答责任（不会被空闲回收，随后要被异常打掉）——
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
    await other.wait({ text: 'y / n' }, { timeoutMs: 30_000 })

    /**
     * —— B 那一代异常退出；TUI 连接不提供可靠的焦点证据。——
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
    // 等核销后的记录与窗口投影到达；真宿主默认不发系统通知。
    await Bun.sleep(500)

    await other.wait({ absent: 'y / n' }, { timeoutMs: 20_000 })
    const detached = await other.capture({ label: '00-B异常退出撤销待答' })
    keep(detached)
    check(!detached.text.includes('y / n'), 'B 执行已结束，旧裁决卡不再接受答复', detached.text)

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
     * 仅有窗口连接不抑制通知，也不确认具体事项已读。
     */
    const attention = attentionFacts(sandbox.dataDir, sandbox.workspace)
    const stored = JSON.stringify({ attention }, null, 2)
    writeFileSync(join(out, 'attention.json'), `${stored}\n`, 'utf8')
    const failedNotice = attention.find((one) => one.kind === 'failed')
    check(attention.length === 3, '完成、待答、失败各有一项，中间工具轮未多写 done', stored)
    check(attention.every((one) => one.unread), 'TUI 无可靠焦点证据，三类事项均保持未读', stored)
    check(
      failedNotice !== undefined,
      '① B 那一件事**留了底**（`RecordsStore.attention` 里有一条 `failed`）',
      stored,
    )
    check(
      failedNotice?.unread === true,
      '① 它标着**未读**（`unread: true`——连接和汇总均不自动标读）',
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
      has(summary, '1 项出错') && has(summary, '1 项跑完') && has(summary, '1 项等你'),
      '② 汇总包括 A 已完成、B 待答与异常退出，连接不自动标读',
      summary.text,
    )
    check(attentionFacts(sandbox.dataDir, sandbox.workspace).every((item) => item.unread), '新窗 hello 和汇总仍不消费三类未读')
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
    try { await host.close() } finally {
      await fixture.stop()
      await sandbox.dispose()
    }
  }
}
