/**
 * U30 · **留帧装置**（外壳那半）——「换过模型之后 ④ 的分母」那几屏，存成可核对的帧。
 *
 * `bun test` 不收它（文件名不是 `*.test.ts`）。用途只有一个：**外观那一关看帧**——
 * 判据（数字对不对、装配给的是什么）归 `window.test.ts` / `spec.window.test.ts`，
 * 这里把**用户看得见的那一屏**落成文本与字节，好让人**从上到下一行行读**
 * （`AGENTS.md`·工作模式：「看图」是四项）。
 *
 * ## 走的是真链路（到外壳为止）
 *
 * 真外壳（`createShell`）→ 真终端回放（U23 立的取景层：录真字节 → `@xterm/headless` 读屏）。
 * **事件按真内核的形状喂**（`model.call.start` / `model.usage` / `model.switched`——与真跑
 * 落库的那几条同形）；表按装配给的那张给（`Assembly.windowTable` 的形状与数，
 * 由 `packages/app/test/window.test.ts` 在**真装配**那一头钉住，`run.ts` 那一跳也是那里验的）。
 *
 * ⚠️ **为什么不在 app 侧留这份帧**：本仓有一条结构守护（`test/scaffold.test.ts`：
 * 「各包源码的引用不越出包边界」）——app 的测试文件**不得**相对引用 `@magic/tui` 的取景层
 * （实测被拦）。故：**数**在 app 侧钉（真装配那条链），**屏**在这儿出（真外壳这条链）。
 *
 * `--unwired` 出的是**没给这张表**时的样子（对照用：③ 换了、④ 还停在旧分母——本单元
 * 收掉的那条缺陷的形状）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/tui/test/frames-window.ts --out <目录>
 * bun packages/tui/test/frames-window.ts --out <目录> --unwired
 * ```
 *
 * 帧存两形：`*.txt`（屏上的字——读屏读出来的）与 `*.ansi`（外壳写出的原始字节，带色）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createShell } from '../src/shell.ts'
import type { Shell } from '../src/shell.ts'
import type { WindowTable } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { rendered, show } from './screen.ts'

const SCREEN = { columns: 100, rows: 30 } as const

/**
 * 装配给的那张表（形状与数照 `Assembly.windowTable`）——内置容量表（官方出处见
 * `@magic/model` 的 `capacity.ts`）＋ 两条**用户声明**（各挂在配置它的那个条目上；
 * 声明**不按模型名全局生效**——见 `capacity.ts` 的 `WindowTable`）。
 */
const TABLE: WindowTable = {
  builtin: {
    'MiniMax-M3': 1_000_000,
    'MiniMax-M2': 204_800,
    'mini-declared': 262_144,
  },
  declared: {
    // 两条声明**各挂各的条目**——`mm2` 那个 `MiniMax-M2` 是它自己的 32768
    mm2: { model: 'MiniMax-M2', window: 32_768 },
    mm3: { model: 'mini-declared', window: 131_072 },
  },
}

/** 一句已用量（原型状态行 ④ 的样例数）。 */
const used = () => event('model.usage', { inputTokens: 3_100, outputTokens: 6 })

/** 落一帧：屏上的字（读屏）＋ 外壳写出的原始字节（带色），外加印一份给人看。 */
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
  const unwired = process.argv.includes('--unwired')
  if (at === -1 || out === '') throw new Error('用法：bun frames-window.ts --out <目录> [--unwired]')

  mkdirSync(out, { recursive: true })

  const spy = createSpyTransport()
  const shell = createShell(
    spy.transport,
    // 「没接线」那一形：只递开机那一格（`run.ts` 那一跳没落下时的样子）
    unwired
      ? { contextWindow: 1_000_000 }
      : { contextWindow: 1_000_000, windowTable: TABLE },
  )
  const feed = (...events: Parameters<typeof spy.emit>[0][]): void => {
    for (const item of events) spy.emit(item)
  }
  const suffix = unwired ? '-unwired' : ''

  try {
    await save(out, `01-boot${suffix}`, shell)

    // 跑过一句：③ 有模型名、④ 有分子与分母
    feed(event('model.call.start', { model: 'MiniMax-M3', provider: 'mm' }), used())
    await save(out, `02-known-M3${suffix}`, shell)

    // 换到**另一已知**（内置表的另一个数）
    feed(event('model.switched', { ok: true, provider: 'mm2', model: 'MiniMax-M2' }))
    await save(out, `03-switched-known-M2${suffix}`, shell)

    // 换到**用户声明过**的那一档（声明挂在它自己条目上）
    feed(event('model.switched', { ok: true, provider: 'mm3', model: 'mini-declared' }))
    await save(out, `04-switched-declared${suffix}`, shell)

    // **同名模型的另一条目**（`mm2` 声明的是 32768；轮到 `mm` 挂的同一个模型时按内置表
    // 报 204800——声明不串味，这是规划侧点名的那一形）
    feed(event('model.switched', { ok: true, provider: 'mm', model: 'MiniMax-M2' }))
    await save(out, `05-same-model-other-entry${suffix}`, shell)

    // 换到**未知**（自建 llama：分母没有——不沿用上一个）
    feed(event('model.switched', { ok: true, provider: 'local', model: 'my-local-llama' }))
    await save(out, `06-switched-unknown${suffix}`, shell)

    await Bun.write(Bun.stdout, `帧落在：${out}\n`)
  } finally {
    shell.dispose()
  }
}

if (import.meta.main) await main()
