#!/usr/bin/env bun
/**
 * U74 · **撤掉「那一轮跑完了」回执 ＋ 思考自成一块**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。走的是**真链路到屏为止**：
 * 真 `cli.ts`（真管理者 → 真执行者 → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 三张帧（本单两件的正反面）
 *
 * | 张 | 形态 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | **不带思考的一轮** | `› …` ／ 空行 ／ `⏺ …`——**逐字**，且**没有**那行「跑完了」 |
 * | ② | **带思考的一轮** | `› …` ／ 空行 ／ `（思考）…` ／ 空行 ／ `⏺ …`——**上下各一整行** |
 * | ③ | 出错 ＋ 命令回执 | **别的回执照旧**（`· 认得的用法：…`），而**通知那两类**一个字都没有：错本身在屏上（`模型错误（…）：…`），那条回执没有了 |
 *
 * ⚠️ **①那一张就是「撤掉」的正面**——它不是「换个落点」「往后挪一挪」，是**不要了**
 * （2026-09-25 用户定，见设计 · 会话与运行管理「通知」那一格）；**②那一张的反面**是
 * ①本身：**不带思考的那一轮一字未变**（没思考就不白撑一行）。
 *
 * ⚠️ **③那一张 U86 改过**（原先等的是 `· 「在吗」出错了：这一轮出错了`）：那一档**也**
 * 按「还在看」判了——**你正看着它 ⇒ 不另印一条回执**（屏上已经有那一行）。
 * 该在屏上看见的是**错本身**（`模型错误（…）：夹具按剧本报错`），不是那条回执。
 *
 * ⚠️ **「没看着」那一档不在本文件**——它要走**系统通知**那一跳，而真弹是 `osascript`
 * （工单明写「**不许真弹**」）。那一档归 `bun test`：`run-stop.test.ts` 的「A 页开着、
 * B 会话跑完」那条，用 `notifySystem` **端口记账**。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u74-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bannerOf, HINT_IDLE } from '@magic/tui'
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

/** 屏上 `needle` 出现几次（可见那一截）。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

// ══ 取景那两件（口径与 `frames-u67-tui.ts` 同——那份注里写着为什么两处各留一份）
//    ⚠️ **包边界守护不许跨包相对引用**（`test/scaffold.test.ts`），故照它的口径在本文件
//    里另写一份**最小**的：记录区的切法 ＋ 空行不成片。══════════════════════════

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`，且铺满终端宽）。 */
function isRule(line: string, columns: number): boolean {
  return line.length >= columns - 1 && [...line].every((char) => char === '─')
}

/** **记录区的行**——第一条满宽分隔线**之上**的那一截（`invariants.ts` 的 `recordArea`）。 */
function recordArea(shot: Capture): readonly string[] {
  const at = shot.lines.findIndex((line) => isRule(line, shot.columns))

  return at === -1 ? shot.lines : shot.lines.slice(0, at)
}

/** 连续空行的上限——1 行是**分段**（块与块之间那一行，设计要的呼吸），2 行以上就是泄了。 */
const MAX_BLANK_RUN = 1

/** **不成片空行**——记录区里连续空白行不得超过 1 行（`invariants.ts` 的 `blankRuns`）。 */
function blankRuns(shot: Capture): readonly { readonly from: number; readonly count: number }[] {
  const rows = recordArea(shot)
  const runs: { from: number; count: number }[] = []
  const blankAt = (at: number): boolean => (rows[at] ?? '非空').trim() === ''

  for (let at = 0; at < rows.length; at += 1) {
    if (!blankAt(at)) continue

    let end = at
    while (blankAt(end + 1)) end += 1

    const count = end - at + 1
    if (count > MAX_BLANK_RUN) runs.push({ from: at, count })

    at = end
  }

  return runs
}

/**
 * **记录区的内容行**（含空行）——第一条满宽分隔线之上那一截，**剥掉字标块**之后的样子。
 * 剥法照 `frames-u67-tui.ts` 的 `contentOf`（逐行比对字标那几行，对上了才剥）。
 */
function contentOf(shot: Capture): readonly string[] {
  const record = recordArea(shot).map((text) => ({ text }))
  const art = bannerOf(shot.columns).map((line) => line.text.replace(/\s+$/u, ''))
  const banner = art.length === 0 ? [] : ['', ...art, '']
  let at = 0
  while (at < banner.length && record[at]?.text === banner[at]) at += 1

  return (at === banner.length ? record.slice(at) : record).map((line) =>
    line.text.replace(/\s+$/u, '').replace(/\d+ms/u, 'Nms'),
  )
}

/**
 * 记录区那几条**内容行**逐字比——两条一起判：
 *
 * ① 与 `expected` 逐字相等（「上下各一整行」就落在这个数组里）；
 * ② 记录区里**没有成片空行**（`blankRuns` ≤1——反面那条）。
 */
function checkLines(shot: Capture, where: string, expected: readonly string[]): void {
  const content = contentOf(shot)

  check(
    JSON.stringify(content) === JSON.stringify(expected),
    `${where}：记录区**逐行**＝期望的那一串`,
    `\n  实际 ${JSON.stringify(content, null, 0)}\n  期望 ${JSON.stringify(expected, null, 0)}`,
  )

  const runs = blankRuns(shot)
  check(runs.length === 0, `${where}：**没有成片空行**（blankRuns ≤1）`, JSON.stringify(runs))
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u74-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  /** 这一趟的剧本：不带思考 → 带思考 → 出错（正反面各一场，见文件头那张表）。 */
  const turns: readonly FixtureTurn[] = [
    { kind: 'text', text: '收到，我在。' },
    { kind: 'text', text: '想好了。', reasoning: '先想一下。' },
    { kind: 'http', status: 400, message: '夹具按剧本报错' },
    { kind: 'text', text: '收尾一句。' },
  ]

  const session = await createUiSession({ label: 'u74-回执与思考分块', columns: 100, rows: 30, artifacts: join(out, 'runs'), turns })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    // —— ① **不带思考的一轮**：逐字，且**没有**那行「跑完了」 ——
    await typeLine(session, '在吗')
    await session.key('enter', { until: { text: '收到，我在。' }, timeoutMs: 30_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const plain = await session.capture({ label: '01-不带思考的一轮' })
    keep(plain)
    // **这一串就是「逐字未变」**：与 U67 判准的那一形一字不差（`›` ／ 空行 ／ `⏺`）
    checkLines(plain, '01 不带思考的一轮', ['› 在吗', '', '⏺ 收到，我在。'])
    check(countOn(plain.lines, '那一轮跑完了') === 0, '① 屏上**没有**那行「跑完了」（那条回执撤掉了）')
    check(countOn(plain.lines, '· 「在吗」') === 0, '① 连它那一族的话术**一处都没有**')

    // —— ② **带思考的一轮**：`（思考）…` 上下各一整行 ——
    await typeLine(session, '想想')
    await session.key('enter', { until: { text: '想好了。' }, timeoutMs: 30_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    const thought = await session.capture({ label: '02-带思考的一轮' })
    keep(thought)
    checkLines(thought, '02 带思考的一轮', [
      '› 在吗',
      '',
      '⏺ 收到，我在。',
      '',
      '› 想想',
      '',
      '（思考）先想一下。',
      '',
      '⏺ 想好了。',
    ])

    // ⚠️ 上面那串已经钉住了「上下各一整行」；这里再**按坐标**咬一次——判据要能自己说明白
    //    （`（思考）` 那一行之上与之下**都是空行**），别只靠「期望数组是这么写的」
    const lines = thought.lines
    const atThought = lines.findIndex((line) => line.includes('（思考）'))
    check(
      atThought > 0 &&
        (lines[atThought - 1] ?? 'x').trim() === '' &&
        (lines[atThought + 1] ?? 'x').trim() === '',
      '② `（思考）` 那一行**上下各一整行空**',
      JSON.stringify(lines.slice(Math.max(0, atThought - 1), atThought + 2)),
    )

    // —— ③ **别的回执照旧**（命令那一路），而**通知那一类一条都没有** ——
    await typeLine(session, '出错那句')
    await session.key('enter')
    // ⚠️ 等的是**那一件事真的到了**（`模型错误（…）：…`——错在屏上），不是「回到空闲」：
    //    出错那一场收在 `▲ 出错` 那一格上（不是空闲），拿空闲当条件会当场白等到超时（实测栽过一次）
    //
    // ⚠️ **U86 改**：等的从「那行回执」换成「那一件事本身」——「出错了」这一档也按
    //    「还在看」判了，**你正看着它 ⇒ 不另印一条回执**（屏上已经有那一行）。
    await session.wait({ text: '夹具按剧本报错' }, { timeoutMs: 30_000 })

    // 再造一条**另一条路**的回执（命令那一路：`/clear` 的参数不对 ⇒ 认得的用法）
    await typeLine(session, '/clear 多余的参数')
    await session.key('enter')
    await session.wait({ text: '认得的用法' }, { timeoutMs: 15_000 })

    const others = await session.capture({ label: '03-别的回执照旧' })
    keep(others)
    check(
      countOn(others.lines, '「在吗」出错了') === 0,
      '③ 「出错了」那一类**不再另印一条回执**（U86：你正看着它——屏上已经有那一行）',
      others.text,
    )
    check(
      countOn(others.lines, '模型错误') > 0,
      '③ 而**那一件事照旧在屏上**（`模型错误（…）：夹具按剧本报错`）——撤的是那条回执，不是它',
      others.text,
    )
    check(
      countOn(others.lines, '· 认得的用法：/clear（不带参数）') === 1,
      '③ 命令那一路的回执**照旧**',
      others.text,
    )
    check(
      countOn(others.lines, '那一轮跑完了') === 0,
      '③ 而「跑完了」那一条**仍然一个字都没有**（三场跑完都没有）',
      others.text,
    )
    check(blankRuns(others).length === 0, '③ 这一屏也没有成片空行', JSON.stringify(blankRuns(others)))

    // 收尾：先跑一场正常回话，把状态行从 `▲ 出错` 带回空闲（`quit()` 等的就是那一刻），
    // 再走产品那条路（空闲连按两次 ctrl+c）
    await typeLine(session, '收尾')
    await session.key('enter', { until: { text: '收尾一句。' }, timeoutMs: 30_000 })
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
    await session.quit()
    const closed = await session.close({ graceMs: 5_000 })
    check(closed.exit.by !== 'sigkill', '收尾：应用自己走的', `by=${closed.exit.by}`)

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 }).catch(() => undefined)
    throw error
  } finally {
    if (at === -1) removeDir(root)
  }
}
