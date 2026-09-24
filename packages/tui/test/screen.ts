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
import type { Command, KernelEvent, RunRow, RunSnapshot } from '@magic/contracts'
import { bannerOf } from '../src/banner.ts'
import { AppView } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import type { Shell, ShellEffect, ShellKey } from '../src/shell.ts'
import type { ShellView } from '../src/view.ts'
import { createSpyTransport } from './fakes.ts'
import type { SpyTransport } from './fakes.ts'
import { dividerAt, footerAt } from './invariants.ts'
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
  /** 记录区的行（**上面那条**分隔线之上）——`界面原型.html` 里那些 `› ⏺ ● ·` 都在这。 */
  readonly record: readonly Line[]
  /**
   * 记录区的**内容行**——`record` 去掉最前面那一块**启动字标**（TUI Banner，
   * **含它前后那两行留白**——整块都是装帧，见 `contentOf`）。
   *
   * 由头：字标恒在记录区最前面（启动印一次，见 `src/banner.ts`），而**绝大多数判据问的是
   * 「记录区里有哪些内容」**——「条目之间不插空行」「命令输出与回执不回」「切了会话还剩什么」
   * ……那些话里字标都**不算一个条目**：它是**装帧**，不是「这一趟发生过什么」。
   * 这一层替它们把装帧去掉，省得每条判据都去数一遍字标占几行——而那几行**随宽度变**
   * （块字版 5 行 · 一行版 1 行 · 极窄 0 行）。
   *
   * ⚠️ **字标自己的**判据用它哥 `record` / `cellsOf`：在不在、在第几行、什么色——
   * 那些**要**看见它（见 `spec.banner.test.ts`）。别拿这一条去量字标，那儿量不到。
   *
   * ⚠️ 剥法是**逐行比对那几行的样子**，不是「掐掉前 N 行」：内容一多字标会滚出屏幕，
   * 那时它在 `record` 里根本不存在，硬掐就会把**正文的头几行**当成字标切掉。
   */
  readonly content: readonly Line[]
  /**
   * 交互区的行（**两条**分隔线**之间**）——输入行 / 裁决卡 / 选择器。
   *
   * ⚠️ **下沿那条线不算在里面**（U45）：它是 `AppView` 的收尾（交互区下沿的界），
   * 不是「交互区里的一行」。故切法是「上沿 ＋1 → 下沿」，没有下沿那条线时到最后一个非空行。
   * ⚠️ **状态行也不算在里面**（U59）：下沿那条线挪到「输入区与状态行之间」之后，
   * 它划开的正是这两块——状态行在线**之下**，是独立的一格（见 `statusLine`）。
   */
  readonly dock: readonly Line[]
  /** 状态行——**下沿那条线之下头一条非空行**（U59 起 `AppView` 把它摆在屏末；改前它在上沿与下沿之间）。 */
  readonly statusLine: string
  /**
   * 状态行在屏幕矩阵里的行号——**状态行之下还有什么**（U68：待确认的那一行就挂在那儿）
   * 这类判据要拿它当锚；`statusLine` 只是一段文本，量不出「谁在谁之下」。
   *
   * 没有分隔线（只录了半屏）时给 `-1`，与 `statusLine` 空串同一个意思。
   */
  readonly statusRow: number
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

  return frameOf(await screenCells(bytes, options), options.columns)
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

/**
 * 记录区 → 去掉最前面那一块**启动字标**（见 `Frame.content` 的注）。
 *
 * 逐行比对那几行的样子（**含宽度**——块字版与一行版长得完全不同），不是掐前 N 行。
 *
 * ⚠️ 剥的是**整块**：`'' ＋ 画幅 ＋ ''`——**前留白与后留白也算装帧**。
 * 那两行留白由字标那一支自己发（`components/log.ts` 的 `BANNER_GAP_TOP` / `_BOTTOM`），
 * 与「记录区里的一个条目」不是一回事；留着它们会让「记录区里有哪些内容」这类判据
 * 在**每一条**前面都多看见一个空串（2026-09-20 收口时一并剥掉）。
 */
function contentOf(record: readonly Line[], columns: number): readonly Line[] {
  const art = bannerOf(columns).map((line) => line.text.replace(/\s+$/u, ''))
  // 极窄那一档字标一行都不印 ⇒ 一行留白也没有（块整个不存在）
  const banner = art.length === 0 ? [] : ['', ...art, '']
  let at = 0
  while (at < banner.length && record[at]?.text === banner[at]) at += 1

  // 全对上了才剥——对上一半（正文自己开头就长得像字标那种）宁可不剥，也不误伤正文
  return at === banner.length ? record.slice(at) : record
}

function frameOf(cells: Awaited<ReturnType<typeof screenCells>>, columns: number): Frame {
  const { screen } = cells
  const rows = screen.lines.map((text, row) => ({ row, text }))
  const divider = dividerAt(screen)
  // **下沿那条线**（U45 加 · **U59 挪**）——它现在划的是**输入区与状态行之间**，故它之下
  // 只剩状态行那一行（`AppView` 末尾的次序：交互区 → 下线 → 状态行），它**不算交互区的一行**。
  //
  // ⚠️ **U45 那一版是「取下线上一行」当底**（那时状态行在下线之上）——照搬过来会把
  // **输入行**当成状态行（`statusLine` 于是量到 `› …` 那一行，一屏的红）。改法两处：
  // 交互区切到 `footer` 为止，状态行取 `footer` **之下**那一条。
  const footer = footerAt(screen)
  const lastNonBlank = rows.filter((entry) => entry.text.trim() !== '').at(-1)
  // 交互区的下界：有下线取下线，没有（半屏 / 只画出一条线那一档）退回最后一个非空行之后
  const end = footer === -1 ? (lastNonBlank?.row ?? -1) + 1 : footer
  const record = rows.slice(0, divider === -1 ? (lastNonBlank?.row ?? -1) + 1 : divider)

  // ⚠️ **状态行取「下线之下头一条非空行」，不是「之下最后一条」**（U68）：状态行之下从
  //    U68 起**还有东西**（待确认的那一行，它挂着时是屏末那一条）——照旧取最后一条，
  //    量到的就成了那一行，而**这一格的判据全是关于状态行的**（`○ 空闲` / 提示那句）。
  //    没有分隔线那一档（半屏）照旧退回整屏最后一条非空行。
  const statusRow =
    footer === -1 ? (lastNonBlank?.row ?? -1) : rows.findIndex((entry) => entry.row > footer && entry.text.trim() !== '')

  const frame: Frame = {
    screen,
    record,
    content: contentOf(record, columns),
    dock: divider === -1 ? [] : rows.slice(divider + 1, end),
    statusLine: statusRow === -1 ? '' : (rows[statusRow]?.text ?? ''),
    statusRow,
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
/**
 * **一份可推的运行事实**（U54）——`RunFeed` 那一形，外加一个「推」的把手给用例。
 *
 * 为什么用例要自己拿这个东西：真管理者**推**事实，而 `RunFeed.subscribe` 的监听在
 * `createShell` 构造那一刻就接上了（订阅之后不可换）——想演「事实变了」，就得从**订阅之前**
 * 手里就有它，故它由用例造好递进 `StageOptions.runsFeed`。
 */
export type RunsFeed = {
  current(): readonly RunRow[]
  subscribe(listener: (rows: readonly RunRow[]) => void): void
  /** 推一份新的事实（＝管理者那一下推送）。 */
  push(rows: readonly RunRow[]): void
}

/** 造一份可推的运行事实（初值 ＋ 此后由 `push` 推）。 */
export function createRunsFeed(initial: readonly RunRow[] = []): RunsFeed {
  let rows = initial
  const listeners = new Set<(rows: readonly RunRow[]) => void>()

  return {
    current: () => rows,
    subscribe: (listener) => {
      listeners.add(listener)
    },
    push: (next) => {
      rows = next
      for (const listener of [...listeners]) listener(rows)
    },
  }
}

/** 取景台的入参——都可省（省了＝按「拿不到」办：没有窗总量、没有钟）。 */
export type StageOptions = {
  /** 上下文窗总量（状态行 ④ 的分母）——`D10` 的出口合入前没人传，故缺省 `null`。 */
  readonly contextWindow?: number | null
  /** 本进程的工作区（U26 · `/resume` 那一屏分组的取材）——不给＝不知道自己在哪儿。 */
  readonly workspaceRoots?: readonly string[]
  /** 受理输入了没有（U25 那道闸）——`false` ＝ 启动中（回车不受理、命令一律丢弃）。 */
  readonly inputReady?: boolean
  /**
   * **运行事实**（U49）——`/resume` 那一屏每一行的状态据它。
   *
   * 缺省不给 ⇒ 那一屏照旧只有目录、一行状态都不标（「拿不到的不编」，同 `workspaceRoots`）。
   */
  readonly runs?: readonly RunRow[]
  /**
   * **运行事实的来路**（U54）——要**推**那一趟（事实变了 ⇒ 外壳跟着收尾）就走它。
   *
   * 与 `runs` 的分工：那一格给的是**构造那一刻的读数**（`current()` 一次，此后再不动），
   * 只够验「列表按事实铺行」；而 D34 那条路要的恰恰是**此后的变化**——管理者停掉一条之后
   * 推来新的一份。故这一格收一个**真 feed**：用例拿 `stage.pushRuns(...)` 推。
   */
  readonly runsFeed?: RunsFeed
  /** **开局就接的那条会话**（只作开屏摘要的排除项）。 */
  readonly openingSession?: string
  /** **接回快照**（U49）——接上它之后喂一份进去，等于管理者刚把「此刻」推来了。 */
  readonly resumed?: (listener: (gen: number, snapshot: RunSnapshot) => void) => void
}

export type Stage = {
  readonly shell: Shell
  readonly spy: SpyTransport
  /** 敲一串字符（逐字——与真按键同形）。 */
  type(text: string): void
  press(key: ShellKey): ShellEffect
  /** 投一串事件。 */
  feed(events: readonly KernelEvent[]): void
  /**
   * **推一份新的运行事实**（U54）——只有给了 `StageOptions.runsFeed` 的那些台推得动
   * （别的台没有那条来路，推了就当没接运行事实）。
   */
  pushRuns(rows: readonly RunRow[]): void
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
    ...(options.inputReady === undefined ? {} : { inputReady: options.inputReady }),
    ...(options.runsFeed !== undefined
      ? { runs: options.runsFeed }
      : options.runs === undefined
        ? {}
        : { runs: { current: () => options.runs as readonly RunRow[], subscribe: () => {} } }),
    ...(options.openingSession === undefined ? {} : { openingSession: options.openingSession }),
    ...(options.resumed === undefined ? {} : { resumed: { subscribe: options.resumed } }),
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
    pushRuns: (next) => options.runsFeed?.push(next),
    commands: () => spy.commands,
    at: (value) => {
      now = value
    },
    screen: (screenOptions = DEFAULT_SCREEN) => show([shell.getView()], screenOptions, now),
  }
}
