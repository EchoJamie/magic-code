#!/usr/bin/env bun
/**
 * U111 · **命令面「看 / 做」裁定**——`/attachments` 撤掉之后，真终端上还剩什么。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 判的是哪一件事
 *
 * 工单（U111）只实施一条：**撤掉 `/attachments`**（判据：「看」才配名字，「看」不该有名字）。
 * 这会动到**用户看得见的三处**——故按「外壳改动，验收必须含看帧判外观」留帧：
 * - **`/` 那一栏（全表）**——少了一条，别的照旧；
 * - **`/s` 那一栏**——匹配度那一列少了 `/attachments`（它当年是「末位子串」那一档）；
 * - **`/help` 那一屏**——正文由 `COMMANDS` 一处出（`HELP_TITLE` / `HELP_LINES`），
 *   表上没了它，这一屏也就没了它。
 *
 * ⚠️ **光看代码不算**：这三处都是「那一刻屏上是什么」，只有真终端说得清。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析，不是拿视图对象算的）。
 * 一个模型请求都不发（这三下都不需要模型），真 `~/.magic` 零触碰。
 *
 * ## 三屏
 *
 * `01-help`（`/help` 那一屏）· `02-候选-全表`（一个 `/`）· `03-候选-s`（`/s`）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u111-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './tmp.ts'
import { createUiSession } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'

/** 一条判据的结论——**不过就当场抛**（留帧装置不是「看看而已」，判据得咬人）。 */
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}`)
    return
  }

  throw new Error(`判据「${what}」没过${detail === '' ? '' : `：${detail}`}`)
}

/** 留一屏——文本写进 `<out>/<名字>.txt`，字格与光标写进同名 `.json`。 */
function keep(out: string, shot: Capture, label: string): void {
  writeFileSync(join(out, `${label}.txt`), `${shot.text}\n`, 'utf8')
  writeFileSync(
    join(out, `${label}.json`),
    `${JSON.stringify({ columns: shot.columns, rows: shot.rows, lines: shot.lines }, null, 2)}\n`,
    'utf8',
  )
  console.log(`\n── ${label} ──\n${shot.text}`)
}

/** 屏上有没有这一行。 */
function has(shot: Capture, needle: string): boolean {
  return shot.lines.some((line) => line.includes(needle))
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const out = at === -1 ? tempDir('magic-frames-u111-') : (process.argv[at + 1] as string)
  mkdirSync(out, { recursive: true })

  const session: UiSession = await createUiSession({
    label: 'u111-命令面',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
  })

  let report: Awaited<ReturnType<UiSession['close']>> | undefined
  try {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

    // —— ① `/help`：命令表那一屏（正文由 `COMMANDS` 一处出）——
    await session.send('/help ', { until: { text: '/help' }, timeoutMs: 10_000 })
    await Bun.sleep(150)
    await session.key('enter', { until: { text: '可用命令' }, timeoutMs: 10_000 })
    const help = await session.capture({ label: '01-help' })
    keep(out, help, '01-help')

    check(has(help, '可用命令'), '`/help` 那一屏真开着（标题那一行在）')
    check(!has(help, '/attachments'), '**表上没有了它**（撤掉的那一条）')
    check(!has(help, '送过的图片'), '连它的那句说明也一个字不剩')
    check(has(help, '/mcp'), '别的命令照旧在（拿 `/mcp` 当对照）')
    check(has(help, '/help'), '`/help` 自己还在（它不是被撤的那一条）')

    // —— ② 一个 `/`：全表那一栏 ——
    // ⚠️ 锚要挑**只有候选栏开着才有**的那一格：`/clear` 在 `/help` 那一屏的记录区里也有，
    //    拿它当锚等于没等（实测：帧拍下来的时候那一栏还没开）。
    await session.send('/', { until: { text: '↑↓ 选' }, timeoutMs: 10_000 })
    const all = await session.capture({ label: '02-候选-全表' })
    keep(out, all, '02-候选-全表')

    check(has(all, '/clear') && has(all, '/model'), '`/` 那一栏照旧列全表')
    check(!has(all, '/attachments'), '**全表里没有它**')

    // —— ③ `/s`：匹配度那一列（它是「末位子串」那一档）——
    // ⚠️ 同一条：等草稿那一格**真成了 `/s`**（`/skills` 在上一帧的全表里也有）。
    await session.send('s', { until: { text: '› /s' }, timeoutMs: 10_000 })
    const slashed = await session.capture({ label: '03-候选-s' })
    keep(out, slashed, '03-候选-s')

    check(!has(slashed, '/attachments'), '**`/s` 那一列里没有它**（子序列那一档也扫不到）')
    check(has(slashed, '/grants') && has(slashed, '/resume'), '同档那两条照旧在（它们是「做」）')
  } finally {
    await session.wait({ text: '○ 空闲' }, { timeoutMs: 10_000 }).catch(() => undefined)
    await session.quit()
    report = await session.close({ graceMs: 3_000 })
  }

  const how = `${report.exit.by}（code ${report.exit.code ?? '-'} / signal ${report.exit.signal ?? '-'}）`
  if (report.exit.by !== 'app') throw new Error(`应用不是自己走的（${how}）——收摊那条路没走完`)
  console.log(`  · 收摊：${how} · 帧 ${report.frames} 张 · 现场 ${report.runDir}`)
  console.log(`\n全部判据通过。帧落在 ${out}`)
}
