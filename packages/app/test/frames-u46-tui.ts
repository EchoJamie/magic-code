#!/usr/bin/env bun
/**
 * U46 · **退出按两次**——真 PTY 留帧与验收判据（**U68 改定落哪与时限**）。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。判据分五趟：
 *
 * | 那一趟 | 量什么 |
 * | --- | --- |
 * | **一 · 按下那一拍** | 那一行**在状态行之下**（缩进对齐、紧贴它下一格）· 输入行与状态行之间**没多出东西** · 进程还在 |
 * | **二 · 1.5 秒内再按** | **真退出**（退出码 / 收尾正常） |
 * | **三 · 超时** | 什么都不做 ⇒ 那一行**自己撤**（量的到秒数）· 屏上回到常态 · **此刻再按是新的一次**（印那一行、不退出） |
 * | **四 · 敲一个字** | 那一行**立刻撤**、那一字进草稿、没退出 |
 * | **五 · 矮窗 40×10** | 那一行**不会把输入行挤掉**、两条线照画、没有一行超宽 |
 *
 * 外加**对照**：有供应商 / 无供应商两种起手态各看一眼——那一行的位置**不随状态行内容变**。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 那一行为什么必须**不能**进记录区
 *
 * 回执（`·`）是印一次就进 scrollback 的 append-only 路——**清不掉**。这一行要能被清掉
 * （用户敲一个字就不想走了 · 1.5 秒到点自己撤），所以它走的是**状态行之下那一格**。
 * 故本文件除了「它在不在」，还要量「它**不在记录区里**」。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u46-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_ARM_MS, HINT_EXIT_ARMED, HINT_IDLE } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { createSandbox } from './ui/sandbox.ts'
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

/**
 * **状态行在屏上第几行**（U59 起它在下沿那条线之下）。
 *
 * ⚠️ **取「下线之下头一条非空行」，不是「最后一条」**（U68）：下线之下从 U68 起
 * **还有东西**（待确认的那一行）——取最后一条，量到的就成了它。
 *
 * ⚠️ 不能拿「全屏找 `○ 空闲`」代替：记录区里的回执也可能带上那几个字。
 */
function statusRowOf(shot: Capture): number {
  const footer = shot.lines.findLastIndex((line) => isRule(line))
  if (footer === -1) return -1

  for (let at = footer + 1; at < shot.lines.length; at += 1) {
    if ((shot.lines[at] ?? '').trim() !== '') return at
  }

  return -1
}

/** 一帧是不是**完整的**（两条线；输入行在线之间、状态行在下线之下——U59）。 */
function checkFrame(shot: Capture, where: string): void {
  const shown = shot.lines.filter((line) => isRule(line))
  check(shown.length === 2, `${where}：可见屏上**恰好两条**分隔线`, `实际 ${shown.length} 条`)

  const composer = shot.lines.findLastIndex((line) => line.includes('›'))
  const first = shot.lines.findIndex((line) => isRule(line))
  const last = shot.lines.findLastIndex((line) => isRule(line))

  check(composer > first && composer < last, `${where}：输入行在两条线之间`)
  check(statusRowOf(shot) > last, `${where}：状态行在**下线之下**`)
}

/**
 * **那一行落在状态行之下**（U68 的要害）——位置 ＋ 缩进 ＋ 「那一对没被打断」三件一起判。
 *
 * 三处都由头：
 * - **状态行之下**：那一行**不是关于输入的**——放上面会打断「输入行 ↔ 状态行」那一对；
 * - **紧贴它下一格**：状态行之下仍是屏底（**不另加线**，且它与状态行之间不空行）；
 * - **缩进对齐**：两个行首落在同一列（状态行左位那格是 `paddingX: 1`）。
 */
function checkBelowStatus(shot: Capture, where: string): void {
  const at = shot.lines.findIndex((line) => line.includes(HINT_EXIT_ARMED))
  const status = statusRowOf(shot)

  check(at !== -1, `${where}：那一行在屏上`, `屏：\n${shot.text}`)
  check(at > status, `${where}：它在**状态行之下**`, `那一行 ${at} · 状态行 ${status}`)
  check(at === status + 1, `${where}：它**紧贴状态行下一格**（不空行、不另加线）`, `那一行 ${at} · 状态行 ${status}`)

  const indent = (row: number): number => {
    const text = shot.lines[row] ?? ''

    return text.length - text.trimStart().length
  }

  check(
    indent(at) === indent(status) && indent(at) > 0,
    `${where}：**缩进对齐状态行**`,
    `那一行缩进 ${indent(at)} · 状态行缩进 ${indent(status)}`,
  )
  check(!inRecordArea(shot), `${where}：它**不在记录区里**（随时能清掉，不是写进 scrollback 的回执）`)
}

/** 「输入行与状态行之间没多出任何东西」——那一段里只有下沿那条线。 */
function checkPairIntact(shot: Capture, where: string): void {
  const composer = shot.lines.findLastIndex((line) => line.includes('› '))
  const status = statusRowOf(shot)
  const between = shot.lines.slice(composer + 1, status)

  check(
    between.filter((line) => isRule(line)).length === 1 && between.filter((line) => !isRule(line) && line.trim() !== '').length === 0,
    `${where}：输入行与状态行之间**没有多出任何东西**（只有下沿那条线）`,
    `中间那几行：${JSON.stringify(between)}`,
  )
}

// ══ 趟一／二 · 按下那一拍 → 1.5 秒内再按（真退出）════════════════════════

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

    // —— ① 第一下：不退出，那一行落在状态行之下 ——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const armed = await session.capture({ label: '02-按过一次' })
    keep(armed)

    checkBelowStatus(armed, '① 第一下')
    checkPairIntact(armed, '① 第一下')
    check(
      filled(armed).length === filled(before).length + 1,
      '① 第一下：屏上**多出的正好这一行**（不多不少）',
      `常态 ${filled(before).length} 行 → 按过 ${filled(armed).length} 行`,
    )
    check(
      countOn(armed.lines, '› ') === countOn(before.lines, '› '),
      '① 第一下：**交互区一行都没长**（它不在两条线之间了）',
      `输入行那一撇：常态 ${countOn(before.lines, '› ')} 处 → 按过 ${countOn(armed.lines, '› ')} 处`,
    )
    check(alive(session.pid), '① 第一下：**进程还在**（这一下不退）')
    check(countOn(armed.lines, '你好') >= 1, '① 第一下：记录区照旧（没被清、也没被这一行顶掉）')
    checkFrame(armed, '02 按过一次')

    // —— ② 第二下（**还在 1.5 秒内**）：真退出 ——
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '② 第二下：**真退出**（应用自己走的）', `exit.by=${report.exit.by}`)
    check(report.exit.code === 0, '② 第二下：退出码 0（收尾正常）', `实际 ${report.exit.code ?? '-'}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟三 · 1.5 秒什么都不做：那一行自己撤，再按是**新的一次** ══════════

async function timing(): Promise<void> {
  const session = await createUiSession({
    label: 'u46-超时',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '收到，我在。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    const before = await session.capture({ label: '03-超时前常态' })
    keep(before)

    // —— 按下：那一行上来，钟也开始走 ——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const start = Date.now()

    // —— ③ 什么都不做：它自己撤 ——
    await session.wait({ absent: HINT_EXIT_ARMED }, { timeoutMs: EXIT_ARM_MS + 5_000 })
    const elapsed = Date.now() - start
    const gone = await session.capture({ label: '04-超时之后' })
    keep(gone)

    // 如实报出量到的那个数（判据过了也要看得见它——「大概 1.5 秒」是这一趟的读数）
    console.log(`  · 实测：那一行从**上屏**到**自己撤掉**撑了 ${elapsed}ms（钟是 ${EXIT_ARM_MS}ms）`)
    check(
      elapsed >= EXIT_ARM_MS - 400 && elapsed <= EXIT_ARM_MS + 900,
      `③ 超时：那一行撑了**大约 ${EXIT_ARM_MS} 毫秒**（不是一直挂着）`,
      `实测 ${elapsed}ms（从它上屏到它消失）`,
    )
    check(countOn(gone.lines, HINT_EXIT_ARMED) === 0, '③ 超时：那一行**自己撤了**')
    check(
      filled(gone).length === filled(before).length,
      '③ 超时：屏上**回到常态**（几行就是几行，没留下空档）',
      `常态 ${filled(before).length} 行 → 超时后 ${filled(gone).length} 行`,
    )
    checkFrame(gone, '04 超时之后')

    // —— ③ 后半：此刻再按一下 ⇒ **新的一次**（印那一行，**不退出**）——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const again = await session.capture({ label: '05-超时之后又按一下' })
    keep(again)

    checkBelowStatus(again, '③ 再按一次')
    check(alive(session.pid), '③ 再按一次：还是**不退出**（上一次那一下已经不作数了）')

    // 收尾：这一次的钟内再按 —— 走
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '③ 收尾：应用自己走的', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟四 · 敲一个字：立刻撤、那一字进草稿 ══════════════════════════════

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

    // —— ④ 敲一个字（**远快于 1.5 秒**）——
    await session.send('甲', { until: { text: '› 甲' }, timeoutMs: 10_000 })
    await session.wait({ absent: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const typed = await session.capture({ label: '06-敲一个字之后' })
    keep(typed)

    check(countOn(typed.lines, HINT_EXIT_ARMED) === 0, '④ 敲一个字：那一行**立刻撤了**')
    check(countOn(typed.lines, '› 甲') >= 1, '④ 敲一个字：**那一轮输入正常**（字在草稿上）')
    check(alive(session.pid), '④ 敲一个字：**没退出**')
    checkFrame(typed, '06 敲一个字之后')

    // —— 收尾：连着按两下（**都在钟内**）——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    await session.key('ctrl+c')
    const report = await session.close({ graceMs: 3_000 })

    check(report.exit.by === 'app', '④ 收尾：应用自己走的', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 趟五 · 矮窗 40×10：不许把输入行挤掉、也不许撑高交互区 ═════════════

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
    checkBelowStatus(armed, '⑤ 矮窗')
    check(
      armed.lines.every((line) => [...line].length <= 40),
      '矮窗：没有一行超出宽度',
      `最长一行 ${Math.max(...armed.lines.map((line) => [...line].length))} 列`,
    )
    check(
      filled(armed).length === filled(before).length + 1,
      '矮窗：屏上多出的仍是**正好那一行**（它进的是「活动区之外」那笔账）',
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

// ══ 对照 · 有供应商 / 无供应商：位置不随状态行内容变 ════════════════════

async function counterpart(mark: '有供应商' | '无供应商'): Promise<void> {
  // 无供应商那一形：**配置文件根本不落**（干净机器的原样）——状态行少掉模型 / 用量那两格
  const sandbox = mark === '无供应商' ? createSandbox({ provider: 'none' }) : undefined
  const session = await createUiSession({
    label: `u46-对照-${mark}`,
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(sandbox === undefined ? { turns: [{ kind: 'text', text: '收到。' }] } : {}),
  })

  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 25_000 })

    const plain = await session.capture({ label: `09-对照-${mark}-常态` })
    keep(plain)

    await session.key('ctrl+c')
    await session.wait({ text: HINT_EXIT_ARMED }, { timeoutMs: 10_000 })
    const armed = await session.capture({ label: `10-对照-${mark}-按过一次` })
    keep(armed)

    checkBelowStatus(armed, `对照·${mark}`)
    checkPairIntact(armed, `对照·${mark}`)
    checkFrame(armed, `对照·${mark}`)

    await session.quit()
    await session.close({ graceMs: 3_000 })
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  } finally {
    sandbox?.dispose()
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
    await timing()
    await typing()
    await narrow()
    await counterpart('有供应商')
    await counterpart('无供应商')
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
