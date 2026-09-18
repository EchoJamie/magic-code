/**
 * 取景层（U24）——**把「一屏」变成可以断言的东西**。
 *
 * 这一轮（规格即测试）的用例要量的东西，散在**两条路**上，本文件各给一件：
 *
 * | 路 | 输入 | 归一化 | 拿得到什么 |
 * | --- | --- | --- | --- |
 * | **帧文本** | `renderToString` / `ink-testing-library` | `plain()` **剥掉 ANSI** | 文字与布局 |
 * | **真终端** | `record()` → `screenOf` / `screenCells` | ——（本来就是干净的） | **文字 ＋ 每格的色与重量** |
 *
 * ## 为什么帧文本要先剥 ANSI（缺陷 D17）
 *
 * Ink 的色经 `chalk`，而 chalk 的档位是**进程环境**给的（`FORCE_COLOR` / TTY / CI）。
 * 同一个仓、同一份代码，换个 shell 就红一片：
 *
 * - **快照对不上**——快照存的是无色帧，环境一开色，整帧多出色码；
 * - **`toContain` 对不上**——色码插在 `›` 与正文之间，那段子串**不再连续**（实测：`FORCE_COLOR=3` 下 21 例红）。
 *
 * **红得没有信息量，只会训练人忽略红。** 故帧文本这条路**先归一化再断言**：
 * 它量的是**布局与文字**，而色不在这条路上量——色去下面那条路量。
 *
 * ⚠️ 反过来，真终端那条路**要色就得先开色**（见 `show()`）——**别把「量到默认色」当成「代码没上色」**。
 */

import chalk from 'chalk'
import { createElement as h } from 'react'
import type { Command, KernelEvent } from '@magic/contracts'
import { AppView } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import type { Shell, ShellEffect, ShellKey } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { createSpyTransport } from './fakes.ts'
import type { SpyTransport } from './fakes.ts'
import { dividerAt } from './invariants.ts'
import { record, screenCells } from './terminal.ts'
import type { Cell, ScreenOptions } from './terminal.ts'
import type { Screen } from './terminal.ts'

// 转出去——用它的用例只需认 `screen.ts` 一个入口
export type { Cell, Screen, ScreenOptions }

// —— 一 · 帧文本：先归一化 ——

/**
 * 帧文本 → **只剩文字与布局**（剥掉 ANSI ＋ 抹平行尾）。
 *
 * 两件：
 * - **剥控制字节**——SGR（`\e[…m`：色 / 加粗 / 删除线 / 背景）· OSC 与其余 CSI
 *   （超链接 · 擦行 · 光标）。测试进程里现在只见到 SGR，但它们是同一类「帧上的控制字节」，
 *   留着迟早又是一次 D17（换个终端 / 换版 Ink 就冒出来）。
 * - **抹掉行尾空白**——⚠️ 这一条不是洁癖：Ink **自己就会裁掉无样式的行尾空格**，
 *   而带样式时（输入行末尾那格光标是**反色**的）又留着 ⇒ **有色的帧比无色的帧多一个尾空格**。
 *   那算「布局」吗？不算——它只是 Ink 裁与不裁的两副面孔。抹平了，两边才对得上
 *   （实测：只剥色码时快照仍差这一个空格，正是它）。
 */
export function plain(frame: string): string {
  return frame
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .split('\n')
    // ⚠️ 用 `\s` 而不是 `[ \t]`——裁决卡的键位行末尾那个是**全角空格**（`　`，U+3000），
    // 它不是 ASCII 空格，`[ \t]` 抹不掉（实测：快照在那四例上仍差一个全角空格）
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
}

// —— 二 · 真终端：取屏 ＋ 读格 ——

/** 一屏 ＋ 它的读法。`row` 都是**屏幕矩阵里的行号**（含滚进 scrollback 的，顶→底）。 */
export type Frame = {
  readonly screen: Screen
  /** 记录区的行（分隔线**之上**）——`界面原型.html` 里那些 `› ⏺ ● ·` 都在这。 */
  readonly record: readonly Line[]
  /** 交互区的行（分隔线**之下**）——输入行 / 裁决卡 / 选择器，以及最后那行状态行。 */
  readonly dock: readonly Line[]
  /** 状态行——屏上最后一条非空行（`AppView` 把它放在最末）。 */
  readonly statusLine: string
  /** 第 `row` 行的格子（到最后一个非空格为止）。 */
  cellsOf(row: number): readonly Cell[]
  /**
   * 第 `row` 行的格子，**含右侧空白**（整行）——量「铺到哪」用它。
   *
   * `cellsOf` 按**文本**裁尾，看不见「背景铺满整行」这类事（文字之后的空格格会被裁掉）。
   */
  rawCellsOf(row: number): readonly Cell[]
  /** 第 `row` 行的文本。 */
  textAt(row: number): string
  /** 第一条**含** `needle` 的行的行号——找不到**抛**（带整屏）。 */
  rowOf(needle: string): number
  /** 屏上有没有这一行。 */
  has(needle: string): boolean
}

export type Line = { readonly row: number; readonly text: string }

const DEFAULT_SCREEN: ScreenOptions = { columns: 80, rows: 24 }

/**
 * 把一串视图**真画一遍**，读回最后一帧之后的屏。
 *
 * ⚠️ **色档在这里拧到真彩**（`chalk.level = 3`）：测试进程默认 0 档、**一个色码都不发**，
 * 而规格表有一半的话是「什么色、加没加粗」。不拧这一下，色类断言量到的全是默认色——
 * 那不是「代码没上色」，是**没开色**。用完还原（别把档位漏给别的用例）。
 */
export async function show(
  views: readonly ShellView[],
  options: ScreenOptions = DEFAULT_SCREEN,
  /** 「此刻」（毫秒）——跑动中的工具行报 `⟳ 0.6s` 要用；不给＝没有钟（回退「运行中」）。 */
  now: number | null = null,
): Promise<Frame> {
  const bytes = await rendered(views, options, now)

  return frameOf(await screenCells(bytes, options))
}

/** 画成字节（**不读屏**）——给「量字节本身」的场合留的口子。 */
export async function rendered(
  views: readonly ShellView[],
  options: ScreenOptions,
  now: number | null = null,
): Promise<string> {
  const frames = views.map((view) =>
    h(AppView, { key: 'screen', view, columns: options.columns, rows: options.rows, now }),
  )

  const restore = chalk.level
  chalk.level = 3

  try {
    return await record(frames, { columns: options.columns, rows: options.rows })
  } finally {
    chalk.level = restore
  }
}

function frameOf(cells: Awaited<ReturnType<typeof screenCells>>): Frame {
  const { screen } = cells
  const rows = screen.lines.map((text, row) => ({ row, text }))
  const divider = dividerAt(screen)
  const lastNonBlank = rows.filter((entry) => entry.text.trim() !== '').at(-1)

  const frame: Frame = {
    screen,
    record: rows.slice(0, divider === -1 ? (lastNonBlank?.row ?? -1) + 1 : divider),
    dock: divider === -1 ? [] : rows.slice(divider + 1, (lastNonBlank?.row ?? divider) + 1),
    statusLine: lastNonBlank?.text ?? '',
    cellsOf: cells.cellsOf,
    rawCellsOf: cells.rawCellsOf,
    textAt: (row) => cells.screen.lines[row] ?? '',
    rowOf: (needle) => {
      const at = cells.screen.lines.findIndex((line) => line.includes(needle))
      // 找不到就**当场炸**（带整屏）——「没找到」被当成「没违例」是这类用例最容易空转的地方
      if (at === -1) throw new Error(`屏上没有「${needle}」这一行：\n${cells.screen.lines.join('\n')}`)

      return at
    },
    has: (needle) => cells.screen.lines.some((line) => line.includes(needle)),
  }

  return frame
}

// —— 三 · 取景台：真链路（事件 → 视图 → 一屏）——

/**
 * 起一个壳 ＋ 间谍传输，并把「此刻的一屏」取出来。
 *
 * 走的是**真链路**：事件喂进 `createShell` → 键喂进外壳 → `AppView` → Ink → 终端。
 * 规格说的是**用户看得见的那一屏**，所以取景从壳起、到屏止。
 */
/** 取景台的入参——都可省（省了＝按「拿不到」办：没有窗总量、没有钟）。 */
export type StageOptions = {
  /** 上下文窗总量（状态行 ④ 的分母）——`D10` 的出口合入前没人传，故缺省 `null`。 */
  readonly contextWindow?: number | null
  /** 本进程的工作区（U26 · `/session` 分组的取材）——不给＝不知道自己在哪儿。 */
  readonly workspaceRoots?: readonly string[]
}

export type Stage = {
  readonly shell: Shell
  readonly spy: SpyTransport
  /** 敲一串字符（逐字——与真按键同形）。 */
  type(text: string): void
  press(key: ShellKey): ShellEffect
  /** 投一串事件。 */
  feed(events: readonly KernelEvent[]): void
  /** 发出去的命令（不含订阅动作）。 */
  commands(): readonly Command[]
  /**
   * 给活壳一个「此刻」（毫秒）——跑动中的工具行据此报 `⟳ 0.6s`。
   * 不给就是**没有钟**（回退「运行中」，不编秒数）——帧因此是确定的。
   */
  at(now: number | null): void
  /** 此刻的一屏（可换尺寸——窄窗口那条规格要用）。 */
  screen(options?: ScreenOptions): Promise<Frame>
}

export function createStage(options: StageOptions = {}): Stage {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, {
    contextWindow: options.contextWindow ?? null,
    workspaceRoots: options.workspaceRoots,
  })
  let now: number | null = null

  return {
    shell,
    spy,
    type: (text) => {
      for (const char of text) shell.key({ kind: 'char', char })
    },
    press: (key) => shell.key(key),
    feed: (events) => {
      for (const item of events) spy.emit(item)
    },
    commands: () => spy.commands,
    at: (value) => {
      now = value
    },
    screen: (screenOptions = DEFAULT_SCREEN) => show([shell.getView()], screenOptions, now),
  }
}
