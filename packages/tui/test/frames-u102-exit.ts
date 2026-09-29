#!/usr/bin/env bun
/**
 * U102 · **App 退出后，TUI 末屏那三行** —— 真外壳留帧。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。跑法：
 *
 * ```
 * bun packages/tui/test/frames-u102-exit.ts --out <目录>
 * ```
 *
 * ## 这一单要看的一件事
 *
 * 末屏依次是：**纯退出回执 → 留稿说明 → 底栏状态**。判的就是**第一条**：
 * 它除了「Magic Code 已退出」没有任何别处没有的信息（同一事实底栏已经说了，
 * 且底栏还多给「ctrl+r 重新打开 · ctrl+c 离开」两个入口）。
 *
 * 走的是真链路，到外壳为止：管理者那一句从 `ShellOptions.lines` 进来（U50 接上的那条口），
 * 宿主没了走 `hostGone()`，其余照旧。帧存两形：`*.txt`（屏上的字）与 `*.ansi`（原始字节）。
 *
 * 两个模式（那一句发不发**由管理者那侧决定**，这里只如实地两屏都留帧）：
 * `--with-exit-line` = 改前（管理者会补一句）· 不带 = 改后（收摊只断连接）。
 * 「改前在、改后不在、其它行逐字未变」由两次运行 diff 出来；判据本体在
 * `packages/app/test/run-manager.test.ts`（收摊那一节）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createShell } from '../src/shell.ts'
import type { Shell } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'
import { rendered, show } from './screen.ts'

const SCREEN = { columns: 100, rows: 30 } as const

/** 落一帧：屏上的字（读屏）＋ 原始字节（带色），并印一份给人看。 */
async function save(out: string, name: string, shell: Shell): Promise<void> {
  const view = shell.getView()
  const screen = await show([view], SCREEN, null)
  const bytes = await rendered([view], SCREEN, null)
  writeFileSync(join(out, `${name}.txt`), `${screen.screen.lines.join('\n')}\n`, 'utf8')
  writeFileSync(join(out, `${name}.ansi`), bytes, 'utf8')
  await Bun.write(Bun.stdout, `── ${name} ──\n${screen.screen.lines.join('\n')}\n\n`)
}

async function main(): Promise<void> {
  const at = process.argv.indexOf('--out')
  const out = process.argv[at + 1] ?? ''
  if (at === -1 || out === '') throw new Error('用法：bun frames-u102-exit.ts --out <目录> [--with-exit-line]')
  const withExitLine = process.argv.includes('--with-exit-line')
  mkdirSync(out, { recursive: true })

  const spy = createSpyTransport()
  let say: (text: string) => void = () => {}
  const shell = createShell(spy.transport, { lines: (listener) => { say = listener } })
  for (const char of '继续之前先检查') shell.key({ kind: 'char', char })

  try {
    await save(out, '01-before-exit', shell)
    // ① 管理者那句「给人看的话」——改前它会补这一句（`--with-exit-line`），改后不补。
    if (withExitLine) say('Magic Code 已退出')
    await save(out, '02-manager-line', shell)
    // ② 宿主没了：留稿说明 + 底栏状态。
    shell.hostGone()
    await save(out, '03-final', shell)
    await Bun.write(Bun.stdout, `帧落在：${out}（${withExitLine ? '改前：管理者会补那一句' : '改后：收摊只断连接'}）\n`)
  } finally {
    shell.dispose()
  }
}

if (import.meta.main) await main()
