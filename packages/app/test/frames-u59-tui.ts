#!/usr/bin/env bun
/**
 * U59 · **分隔线挪位：输入区与状态栏之间**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 判的是哪一件事
 *
 * **U45 把下沿那条线加错了位置**（加在状态行**之下**，成了把「输入行 ＋ 状态行」框起来）。
 * 用户 2026-09-25 指出：它该在**输入区 与 状态行之间**。本文件按工单点名的几种形态
 * **逐种取真帧**（矮窗多一张），每张判同一件事：
 *
 * ```
 * ……记录区……
 * ────────────  ← 上沿：记录区／交互区
 *  › 输入行 / 卡 / 候选 / 小输入
 * ────────────  ← 下沿（U59 挪到这儿）：交互区／状态行
 *  ○ 空闲 · …
 * ```
 *
 * 七张：`01` 常态 · `02` `/clear` 之后 · `03` 选择器开着 · `04` 裁决卡开着 ·
 * `05` 窄窗 46 列 · `06` / `07` 矮窗 40×10（常态 ＋ 草稿吃满半屏）。
 *
 * ## 每张都判的四条（`checkFrame`）
 *
 * ① 可见屏上**恰好两条**满宽 `─`（**两条之外不多线**——工单硬约束：不加第三条）；
 * ② 两条都是**整宽**；③ **输入区那一块落在两条线之间**；④ **状态行落在下线之下**——
 * 且**下线之下不再有线**。
 *
 * ## 矮窗那一张（40×10）另判两条
 *
 * **输入行没被挤掉**（`06` 那张上它真在），且**动态帧短于这一屏**（`末尾非空行 ≤ 行数 − 2`）
 * ——后者是 U31 那一族老病的正面判据：账要是少算/多算一行，帧正好顶满 ⇒ Ink 省掉末尾换行
 * ⇒ **真光标高一行**（由头见 `components/app.ts` 的 `CHROME_LINES`）。
 * **U59 没动这个数**（还是「两条线 ＋ 状态行」＝ 3），这条判据就是钉住「挪位没顺手把账改坏」。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u59-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
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
      {
        columns: shot.columns,
        rows: shot.rows,
        cursor: shot.cursor,
        scrollback: shot.scrollback,
        lines: shot.lines,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`\n── ${shot.label} ──（scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/** 屏上 `needle` 出现几次。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/** 满宽分隔线的行号（顶 → 底）。 */
function rulesOf(shot: Capture): readonly number[] {
  return shot.lines.map((line, at) => ({ line, at })).filter((entry) => isRule(entry.line)).map((e) => e.at)
}

/** 状态行那一格的行号——**下线之下**第一条非空行。 */
function statusAt(shot: Capture, bottom: number): number {
  for (let at = bottom + 1; at < shot.lines.length; at += 1) {
    if ((shot.lines[at] ?? '').trim() !== '') return at
  }

  return -1
}

/** 那一行**夹在两条线之间**（`needle` 取它在屏上出现的那一行）。 */
function checkBetween(shot: Capture, where: string, needle: string): void {
  const [top, bottom] = rulesOf(shot) as [number, number]
  const at = shot.lines.findLastIndex((line) => line.includes(needle))

  check(at > top && at < bottom, `${where}：「${needle}」那一行夹在**两条线之间**`, `它在第 ${at} 行`)
}

/**
 * 一帧的**分块**是不是 U59 要的那个样子（见文件头「每张都判的四条」）。
 *
 * `block` 按形态给：**输入行** / 裁决卡的**键位行** / 选择器的**那一行**——各是那一种形态
 * 在线之间画出来的东西。裁决卡接管那会儿**输入行整块不画**（D29），故不能一律拿 `›` 去量。
 */
function checkFrame(shot: Capture, where: string, block: string): void {
  const shown = rulesOf(shot)

  check(shown.length === 2, `${where}：可见屏上**恰好两条**分隔线（两条之外不多线）`, `实际 ${shown.length} 条`)
  const [top, bottom] = shown as [number, number]
  check(top < bottom, `${where}：两条的上下次序对（上沿在上、下沿在下）`)

  check(
    shot.lines.some((line) => line.includes('─'.repeat(shot.columns))),
    `${where}：两条线都是**整宽**（${shot.columns} 列）`,
  )

  // **下线紧贴状态行之上**——这条划的就是「输入区 与 状态行」这两块（U59 的正题）：
  // 中间不夹别的东西，且它**不在**状态行之下
  const status = statusAt(shot, bottom)
  check(status === bottom + 1, `${where}：状态行就压在**下线之下**那一格`, `下线 ${bottom} · 状态行 ${status}`)
  check(
    shown.every((at) => at < status),
    `${where}：**下线之下不再有线**（状态行底下没有第三条）`,
  )

  checkBetween(shot, where, block)
}

/**
 * **动态帧短于这一屏**——账与屏同源的正面判据（U31 那一族：账少算一行 ⇒ 帧正好顶满
 * ⇒ Ink 省掉末尾换行 ⇒ 真光标高一行）。
 *
 * 判的是**最后一个非空行的行号 ≤ 行数 − 2**：动态帧至多占 `行数 − 1` 行，那一行留给
 * Ink 末尾那个换行。
 */
function checkNotFull(shot: Capture, where: string): void {
  const last = shot.lines.reduce((at, line, row) => (line.trim() === '' ? at : row), -1)

  check(
    last <= shot.rows - 2,
    `${where}：动态帧**短于这一屏**（没顶满 —— 顶满了真光标就高一行）`,
    `末尾非空行 ${last} · 行数 ${shot.rows}`,
  )
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u59-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  const sessions: UiSession[] = []

  /** 起一个真 UI 会话（都落在同一个产物根下）。 */
  const open = (label: string, columns: number, rows: number, turns: readonly FixtureTurn[] = []) =>
    createUiSession({
      label,
      columns,
      rows,
      artifacts: join(out, 'runs'),
      turns: turns.length === 0 ? [{ kind: 'text', text: '收到，我在。' }] : turns,
    })

  try {
    // —— 01 常态（100×30）：开机那一屏 ——
    {
      const session = await open('u59-常态', 100, 30)
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

      const shot = await session.capture({ label: '01-常态' })
      keep(shot)
      checkFrame(shot, '01 常态', '› ')
      checkNotFull(shot, '01 常态')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— 02 `/clear` 之后（100×30）——翻页那一跳：新页从字标起，帧该是一个样 ——
    {
      const session = await open('u59-clear之后', 100, 30)
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '先交代一句')
      await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 20_000 })
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

      await typeLine(session, '/clear')
      await session.key('enter')
      // 翻页之后这一页从字标起 ⇒ 等「两页的记录都不在可见屏上」那一拍
      await Bun.sleep(600)

      const shot = await session.capture({ label: '02-clear 之后' })
      keep(shot)
      checkFrame(shot, '02 /clear 之后', '› ')
      checkNotFull(shot, '02 /clear 之后')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— 03 选择器开着（100×30 · `/resume`）——候选整块在两条线之间 ——
    {
      const session = await open('u59-选择器开着', 100, 30)
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '甲这一条')
      await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 20_000 })
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

      await typeLine(session, '/resume')
      await session.key('enter')
      await session.wait({ text: '正在用' }, { timeoutMs: 10_000 })

      const shot = await session.capture({ label: '03-选择器开着' })
      keep(shot)
      checkFrame(shot, '03 选择器开着', 'ctrl+x 停')
      checkNotFull(shot, '03 选择器开着')
      // **输入行藏起来了**（选择器的查询是抽屉自己的）——那一块照旧在两条线之间
      check(countOn(shot.lines, '正在用') >= 1, '03：候选真在屏上（不是空抽屉）')
      await session.key('esc')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— 04 裁决卡开着（100×30）——接管态不画输入行，卡整块在两条线之间 ——
    {
      const session = await open('u59-裁决卡开着', 100, 30, [
        { kind: 'tool', name: 'write', args: { path: 'note.txt', content: '第一版' } },
        // ⚠️ **第二幕要有**：拒绝之后内核会**再问一次模型**，而夹具按序发幕——
        //    只给一幕的话它把同一个工具请求再下一遍，卡当场又开一张（等 `HINT_IDLE` 必超时）
        { kind: 'text', text: '好，那先不动它。' },
      ])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await typeLine(session, '改个文件')
      await session.key('enter')
      await session.wait({ text: 'y 批准' }, { timeoutMs: 20_000 })

      const shot = await session.capture({ label: '04-裁决卡开着' })
      keep(shot)
      checkFrame(shot, '04 裁决卡开着', 'y 批准')
      checkNotFull(shot, '04 裁决卡开着')
      check(countOn(shot.lines, 'y 批准') >= 1, '04：卡真在屏上（键位行在）')
      check(
        (shot.lines[rulesOf(shot)[1] as number + 1] ?? '').includes('等你定夺'),
        '04：状态行报「等你定夺」',
      )
      await session.send('n') // 干净退场（卡还挂着时 ctrl+c 是中断）
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— 05 窄窗 46×30 ——字标换成一行版那一档，同一条规矩 ——
    {
      const session = await open('u59-窄窗46', 46, 30)
      sessions.push(session)
      await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

      const shot = await session.capture({ label: '05-窄窗 46×30' })
      keep(shot)
      checkFrame(shot, '05 窄窗', '› ')
      checkNotFull(shot, '05 窄窗')
      check(
        shot.lines.every((line) => [...line].length <= 46),
        '05：窄窗上没有一行超出宽度',
      )
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— 06 / 07 矮窗 40×10 ——工单点名要特别核的那一格（两张：常态 ＋ 草稿吃满半屏）——
    {
      const session = await open('u59-矮窗40x10', 40, 10)
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

      // 06 常态：**输入行没被挤掉**（工单原文）——40×10 上它照样在两条线之间
      const idle = await session.capture({ label: '06-矮窗 40×10 常态' })
      keep(idle)
      checkFrame(idle, '06 矮窗常态', '› ')
      checkNotFull(idle, '06 矮窗常态')
      check(countOn(idle.lines, '› ') >= 1, '06：输入行**没被挤掉**（40×10 上它在两条线之间）')

      // 07 草稿吃满半屏（`maxDraftLines(10) = 5`）：交互区吃满预算，动态帧最容易顶满这一屏
      //
      // ⚠️ **不能拿整串当 `until`**：40 列上它折成好几个视觉行，**屏上没有一行含整串**
      //    （等它必然超时——实测栽过）。等的是折行之后那条提示：它出现＝这一串真到了。
      // ⚠️ **长度要够**：120 个 a 只折 4 个视觉行 ⇒ 半屏预算（5 行）装得下、**不折叠也没提示**；
      //    300 个 a 是 8 个视觉行 ⇒ 4 行正文 ＋ 那条「上面还有 4 行」把预算吃满
      //    （与 `spec.u31.test.ts`「矮窗单头折叠」同一份草稿、同一档窗口）
      await session.send('a'.repeat(300))
      await session.wait({ text: '上面还有' }, { timeoutMs: 10_000 })
      await Bun.sleep(300)

      const full = await session.capture({ label: '07-矮窗 40×10 草稿吃满半屏' })
      keep(full)
      // ⚠️ 这一张上 `› ` 那一段**真折出窗口了**（折行折叠的既定行为，不是「被挤掉」）——
      //    故量的是**输入区那一块**（那条「上面还有 N 行」就是它的首行）
      checkFrame(full, '07 矮窗满草稿', '上面还有')
      checkNotFull(full, '07 矮窗满草稿')
      check(countOn(full.lines, 'aaaa') >= 1, '07：草稿正文在两条线之间（半屏里放得下的那几行）')
      check(countOn(full.lines, '○ 空闲') >= 1, '07：状态行在（且紧贴下线之下，见上）')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } catch (error) {
    for (const session of sessions) await session.close({ graceMs: 1_000 }).catch(() => undefined)
    throw error
  } finally {
    if (at === -1) removeDir(root)
  }
}
