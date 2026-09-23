#!/usr/bin/env bun
/**
 * U46 · **退出按两次**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。工单的验收口径逐条落在下面四趟里：
 *
 * | 那一趟 | 量什么（工单原文） |
 * | --- | --- |
 * | **一 · 按一次再按一次** | ① 空闲按一次 Ctrl+C（**屏上多出一行**、进程还在）② 再按一次（**真退出**，退出码 / 收尾正常） |
 * | **二 · 中间敲一个字** | ③ 那一行没了、没退出、那一轮输入正常——且那一下**不作数**（要重新按两下） |
 * | **三 · 工作中** | 按 Ctrl+C **不受影响**（仍是中断本轮，不冒那一行） |
 * | **四 · 矮窗 40×10** | 那一行**不会把输入行挤掉、也不会撑高 dock**（工单点名要看的那一条） |
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 那条线为什么必须**不能**进记录区
 *
 * 回执（`·`）是印一次就进 scrollback 的 append-only 路——**清不掉**。这一行要能被清掉
 * （用户敲一个字就不想走了），所以它走的是**输入区上方那一格**（临时提示那一族）。
 * 故本文件除了「它在不在」，还要量「它**不在记录区里**」：屏上那几行属于**动态帧**，
 * 退出 / 下一次重绘就没了，而记录区那几行是写过就不再动的。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u46-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_EXIT_ARMED, HINT_IDLE } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
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
        files: shot.files,
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

/** 屏上 `needle` 出现几次（可见那一截）。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/** 可见屏上的**非空**行——量「那一行让屏上多了几行」用它（空行是帧的余量，不算内容）。 */
const filled = (shot: Capture): readonly string[] => shot.lines.filter((line) => line.trim() !== '')

/** 这一行**在不在记录区里**（上面那条分隔线之上）——那一行不该在这儿。 */
function inRecordArea(shot: Capture): boolean {
  const first = shot.lines.findIndex((line) => isRule(line))

  return (first === -1 ? shot.lines : shot.lines.slice(0, first)).some((line) =>
    line.includes(HINT_EXIT_ARMED),
  )
}

/** 进程还活着吗——「按一下没退出」那条判据看它（不是看屏）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一帧是不是**完整的**（两条线 ＋ 输入行 ＋ 状态行，且后两者夹在两条线之间）。 */
function checkFrame(shot: Capture, where: string): void {
  const shown = shot.lines.filter((line) => isRule(line))
  check(shown.length === 2, `${where}：可见屏上**恰好两条**分隔线`, `实际 ${shown.length} 条`)

  const composer = shot.lines.findLastIndex((line) => line.includes('›'))
  const status = shot.lines.findLastIndex((line) => line.includes('○ ') || line.includes('● '))
  const first = shot.lines.findIndex((line) => isRule(line))
  const last = shot.lines.findLastIndex((line) => isRule(line))

  check(composer > first && composer < last, `${where}：输入行在两条线之间`)
  check(status > first && status < last, `${where}：状态行在两条线之间`)
}

/** 那一行**紧贴输入行上方**（中间不夹别的东西）。 */
function checkAbove(session: UiSession, shot: Capture, where: string): void {
  const at = shot.lines.findIndex((line) => line.includes(HINT_EXIT_ARMED))
  // ⚠️ **取最后一个**：记录区里也有 `› `（用户那句回显）——取第一个会撞上它
  //    （实测栽过：把记录里那条用户消息当成了输入行）
  const composer = shot.lines.findLastIndex((line) => line.includes('› '))

  check(at !== -1, `${where}：那一行在屏上`, `屏：\n${shot.text}`)
  check(at + 1 === composer, `${where}：它就在**输入行上方那一格**`, `那一行 ${at} · 输入行 ${composer}`)
  check(!inRecordArea(shot), `${where}：它**不在记录区里**（随时能清掉，不是写进 scrollback 的回执）`)
  void session
}

// ══ 趟一 · 按一次（屏上多一行、进程还在）→ 再按一次（真退出）══════════

async function confirming(): Promise<void> {
  const session = await createUiSession({
    label: 'u46-按两次',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到，我在。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    // 先落一条记录——屏上不是空屏，那一行的位置才说明得了问题
    await typeLine(session, '你好')
    await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

    const before = await session.capture({ label: '01-空闲常态' })
    keep(before)
    check(countOn(before.lines, HINT_EXIT_ARMED) === 0, '① 常态：屏上**没有**那一行')
    checkFrame(before, '01 空闲常态')

    // —— ① 第一下：不退出，屏上多出一行 ——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const armed = await session.capture({ label: '02-按过一次' })
    keep(armed)

    checkAbove(session, armed, '① 第一下')
    check(
      filled(armed).length === filled(before).length + 1,
      '① 第一下：屏上**多出的正好这一行**（不多不少）',
      `常态 ${filled(before).length} 行 → 按过 ${filled(armed).length} 行`,
    )
    check(alive(session.pid), '① 第一下：**进程还在**（这一下不退）')
    check(countOn(armed.lines, '你好') >= 1, '① 第一下：记录区照旧（没被清、也没被这一行顶掉）')
    checkFrame(armed, '02 按过一次')

    // —— ② 第二下：真退出 ——
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '② 第二下：**真退出**（应用自己走的）', `exit.by=${report.exit.by}`)
    check(report.exit.code === 0, '② 第二下：退出码 0（收尾正常）', `实际 ${report.exit.code ?? '-'}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟二 · 中间敲一个字（那一行没了、那一下不作数）═══════════════════

async function typing(): Promise<void> {
  const session = await createUiSession({
    label: 'u46-敲一个字',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到，我在。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })

    // —— ③ 敲一个字 ——
    await session.send('甲', { until: { text: '› 甲' }, timeoutMs: 10_000 })
    await session.wait({ absent: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const typed = await session.capture({ label: '03-敲一个字之后' })
    keep(typed)

    check(countOn(typed.lines, HINT_EXIT_ARMED) === 0, '③ 敲一个字：那一行**没了**')
    check(countOn(typed.lines, '› 甲') >= 1, '③ 敲一个字：**那一轮输入正常**（字在草稿上）')
    check(alive(session.pid), '③ 敲一个字：**没退出**')
    checkFrame(typed, '03 敲一个字之后')

    // —— 那一下**不作数**：再按一次是重新起算（挂上那一行），不是退出 ——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const again = await session.capture({ label: '04-重新起算' })
    keep(again)

    checkAbove(session, again, '③ 再按一次')
    check(alive(session.pid), '③ 再按一次：还是**不退出**（上一次那一下已经不作数了）')

    // 收尾：再按一次（这才是「第二次」）
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '③ 收尾：应用自己走的', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟三 · 工作中按 Ctrl+C：不受影响（仍是中断本轮）══════════════════

async function working(): Promise<void> {
  const session = await createUiSession({
    label: 'u46-工作中',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    // 慢慢吐（够久，抓得到「这一轮正在跑」那一帧）；按了之后它会中断收束
    turns: [{ kind: 'text', text: '这一轮会慢慢跑一会儿，好让中断有东西可断。', chunks: 40, chunkDelayMs: 150 }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    await typeLine(session, '这一条会跑一会儿')
    await session.key('enter')
    // 状态行报「ctrl+c 中断」＝这一轮真跑起来了
    await session.wait({ text: 'ctrl+c 中断' }, { timeoutMs: 15_000 })
    await session.wait({ text: '› 这一条会跑一会儿' }, { timeoutMs: 5_000 })

    // —— 工作中那一下 ——
    await session.key('ctrl+c')
    const shot = await session.capture({ label: '05-工作中按 ctrl+c' })
    keep(shot)

    check(countOn(shot.lines, HINT_EXIT_ARMED) === 0, '工作中：**不冒那一行**（这一下不是退出的第一下）')
    check(alive(session.pid), '工作中：**没退出**（本单不许改坏这一条）')
    // 中断的痕迹：这一轮当场收束，状态行回到空闲（回执说清中断的是哪个范围）
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 15_000 })
    await session.wait(
      { text: '已中断' },
      { timeoutMs: 10_000 },
    ).catch(() => undefined) // 中断回执那句话不是本单的判据（措辞归各自的单），有就更好
    const after = await session.capture({ label: '06-中断之后' })
    keep(after)

    check(
      countOn(after.lines, HINT_EXIT_ARMED) === 0,
      '工作中：中断之后屏上也不留那一行（它压根没挂上）',
    )

    await session.quit()
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '工作中那一趟：收尾应用自己走的', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟四 · 矮窗 40×10：不许把输入行挤掉、也不许撑高 dock ═════════════

async function narrow(): Promise<void> {
  const session = await createUiSession({
    label: 'u46-矮窗',
    columns: 40,
    rows: 10,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    const before = await session.capture({ label: '07-矮窗常态' })
    keep(before)

    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const armed = await session.capture({ label: '08-矮窗按过一次' })
    keep(armed)

    // ⚠️ 工单点名要看的：**输入行还在**（没被那一行挤出去）、**两条线照画**、**没有一行超宽**
    check(countOn(armed.lines, '› ') >= 1, '矮窗：**输入行还在**（没被那一行挤掉）')
    checkFrame(armed, '08 矮窗按过一次')
    checkAbove(session, armed, '④ 矮窗')
    check(
      armed.lines.every((line) => [...line].length <= 40),
      '矮窗：没有一行超出宽度',
      `最长一行 ${Math.max(...armed.lines.map((line) => [...line].length))} 列`,
    )
    check(
      filled(armed).length === filled(before).length + 1,
      '矮窗：屏上多出的仍是**正好那一行**（交互区没被撑破）',
      `常态 ${filled(before).length} 行 → 按过 ${filled(armed).length} 行`,
    )

    await session.quit()
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '矮窗那一趟：应用自己走的', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u46-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    await confirming()
    await typing()
    await working()
    await narrow()
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
