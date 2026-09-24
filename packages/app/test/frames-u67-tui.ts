#!/usr/bin/env bun
/**
 * U67 · **块之间留一整行（补上漏掉的另一半）**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。
 *
 * ## 判的是哪一件事
 *
 * 设计那句是「用户发言、助手发言与各组工具**之间**留一整行」，而实现
 * （`needsSpacerAfter`）只判「**这一条是不是用户消息**」⇒ **只在用户消息之前**留、
 * 用户消息之后（`⏺` 之前）不留。用户 2026-09-25 真跑时发现：**「我输入之后与模型回复
 * 之间没有空行」**——**实现只做了一半**。
 *
 * 这一轮按**块**补齐（设计 2026-09-25 写准）：一块＝**一条用户发言** / **一条助手发言** /
 * **一个工具组**（这一批发起的调用 · 结果 · 所属附件 · 回执合起来算一块）；
 * **相邻两块之间留一整行、块内紧凑**。
 *
 * ⚠️ **判据不按「谁在中间」分**（用户 2026-09-25 补正）——用户输入之后紧跟的**可能直接
 * 就是工具**（模型一句话都没说就调工具）。故第 ③ 张**专门**取这一形：屏上是
 * `› 看看工作区` **紧接** `● ls …`，**中间没有 `⏺` 那句**。
 *
 * ## 六张帧（工单点名的六个形态）＋ 矮窗一张
 *
 * | 张 | 形态 | 该在屏上看见什么 |
 * | --- | --- | --- |
 * | ① | 一问一答 | `› …` ／ 空行 ／ `⏺ …` |
 * | ② | 助手带工具组 | `›` 空行 `⏺` 空行 **`● ls …` ＋ `✓ …`（组内紧贴）** 空行 `⏺` |
 * | ③ | **用户之后直接是工具**（没有 `⏺` 那句） | `› …` ／ 空行 ／ `● ls …`——**中间没有 `⏺`** |
 * | ④ | 工具组夹在两条发言之间 | `⏺` 空行 **组** 空行 `⏺` |
 * | ⑤ | 连续两组工具 | 两组各自成块（组与组之间那句发言把两块分开），组内各自紧贴 |
 * | ⑥ | 只有回执（无工具） | 回执**贴在前一块尾巴上**（前面不留空行——它是那一块的收尾） |
 * | ⑦ | 矮窗 40×10 | 多出来的空行进**高度账**：输入行没被挤掉 · 帧短于这一屏 · 一行不折 |
 *
 * ## 每条判据怎么咬
 *
 * - **记录区逐行比**（第 ①–⑥ 张）：把第一条满宽分隔线之上那一截（`recordArea`）**连同
 *   空行**取出来，剥掉字标块之后与**写死的期望数组**逐字比——「之间一行、组内紧凑」
 *   这句话在屏上成立不成立，就是这一串比对；**不是**「有没有那一行字」那种软判据。
 *   （**耗时那一格归一化**成 `Nms`：`✓ 1ms` / `✓ 0ms` 是墙钟，不在这条判据里。）
 * - **反面**（`blankRuns`，口径同 `packages/tui/test/invariants.ts`）：记录区里**不许有
 *   ≥2 行连着的空行**——「空行不成片」的机器判据，**逐张**都过一遍（字标之后、
 *   消息交界处都在里面）。
 * - **高度账**：`checkNotFull`（帧短于这一屏——顶满了真光标就高一行）＋ 矮窗那张
 *   「输入行还在」。⚠️ 多插的那些空行要是没进账，这两条会当场现形。
 * - **不许放宽**：期望数组是**逐字**写死的；对不上就抛。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u67-tui.ts --out <目录>
 * ```
 *
 * ⚠️ **这一趟把读与搜索的工具设成放行**（`permissions.rules`）——这几张判的是**记录区的
 * 分段**，不该被裁决卡岔开（默认「一律问」的话 `ls` 会先弹卡，工具那一行停在 `⟳ 运行中`，
 * 取不到「跑完了」那一形）。姿态与设计「放行区：读与搜索（一律轻，不弹卡）」一致。
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

// ══ 取景那两件（照 `packages/tui/test/invariants.ts` 的口径）══════════
//
// ⚠️ **为什么在这儿重写一份**：那三条不变量的权威在 `@magic/tui` 的测试层
// （`packages/tui/test/invariants.ts`），而**包边界守护不许跨包相对引用**
// （`test/scaffold.test.ts`：「各包源码的引用不越出包边界」——`packages/app/test/*`
// 相对引到 `packages/tui/test/*` 当场红）。本包的帧脚本又不该把判据让出去，
// 故照它的口径在本地写一份**最小**的（本单只用得到两条：记录区的切法 ＋ 空行不成片）。
// 「≤1」那一个数两处一致；改一处另一处要跟着看。

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

/**
 * **不成片空行**——记录区里连续空白行不得超过 1 行（`invariants.ts` 的 `blankRuns`）。
 *
 * 返回违例（空数组＝没有）。判据**含记录区末尾那一片空**（内容与分隔线之间）——
 * 那儿也是一行都多不得的地方。
 */
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
 * **记录区的内容行**（含空行）——第一条满宽分隔线之上的那一截，**剥掉字标块**之后的样子。
 *
 * 剥法照 `packages/tui/test/screen.ts` 的 `contentOf`：字标块＝前留白 ＋ 画幅 ＋ 后留白
 * （画幅随列数变：100 列是 5 行块字版、40 列是一行版）；**逐行比对**那几行的样子，
 * 对上了才剥——不硬掐前 N 行（内容一多字标会滚出去，硬掐会误伤正文）。
 *
 * ⚠️ **耗时那一格归一化**成 `Nms`：`✓ 1ms` / `✓ 0ms` 是**墙钟**（这次真跑了多久），
 * 不是这条判据要看的东西——不归一化就成了「机器快慢决定判据红不红」。
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
 * ① 与 `expected` 逐字相等（「之间一行、组内紧凑」就落在这个数组里）；
 * ② 记录区里**没有成片空行**（`blankRuns` ≤1——反面那条）。
 */
function checkLines(shot: Capture, where: string, expected: readonly string[]): void {
  const content = contentOf(shot)

  check(
    JSON.stringify(content) === JSON.stringify(expected),
    `${where}：记录区**逐行**＝期望的那一串（之间一行 · 组内紧凑）`,
    `\n  实际 ${JSON.stringify(content, null, 0)}\n  期望 ${JSON.stringify(expected, null, 0)}`,
  )

  const runs = blankRuns(shot)
  check(runs.length === 0, `${where}：**没有成片空行**（blankRuns ≤1）`, JSON.stringify(runs))
}

/** 屏上 `needle` 出现几次。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/**
 * **动态帧短于这一屏**——账与屏同源的正面判据（U31 那一族：账少算一行 ⇒ 帧正好顶满
 * ⇒ Ink 省掉末尾换行 ⇒ **真光标高一行**）。
 *
 * 判的是**最后一个非空行的行号 ≤ 行数 − 2**。⚠️ U67 往记录区里多插了几行空行，
 * 故这一条**逐张**都过——「多出来的空行要进高度账」正是要在这儿兑现。
 */
function checkNotFull(shot: Capture, where: string): void {
  const last = shot.lines.reduce((at, line, row) => (line.trim() === '' ? at : row), -1)

  check(
    last <= shot.rows - 2,
    `${where}：动态帧**短于这一屏**（没顶满 —— 顶满了真光标就高一行）`,
    `末尾非空行 ${last} · 行数 ${shot.rows}`,
  )
}

/** 一屏的分块：可见屏上**恰好两条**分隔线（线是划界用的——U67 明写不许再加）。 */
function checkChrome(shot: Capture, where: string): void {
  const shown = shot.lines
    .map((line, at) => ({ line, at }))
    .filter((one) => isRule(one.line, shot.columns))
    .map((one) => one.at)

  check(shown.length === 2, `${where}：屏上**恰好两条**分隔线（不许加第三条）`, `实际 ${shown.length} 条`)
}

/** 起一个会话来跑那一趟——`turns` 见 `ui/fixture.ts`。 */
function sessionOf(
  label: string,
  columns: number,
  rows: number,
  turns: readonly FixtureTurn[],
): Promise<UiSession> {
  return createUiSession({
    label,
    columns,
    rows,
    artifacts: join(out, 'runs'),
    config: { permissions: { rules: [{ tool: 'ls' }, { tool: 'glob' }, { tool: 'read' }] } },
    turns: turns.length === 0 ? [{ kind: 'text', text: '收到，我在。' }] : turns,
  })
}

/** 一句用户交代跑完——等答复那一句上屏，再等回到空闲。 */
async function settle(session: UiSession, said: string, until: string): Promise<void> {
  await typeLine(session, said)
  await session.key('enter', { until: { text: until }, timeoutMs: 40_000 })
  await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u67-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  const sessions: UiSession[] = []

  try {
    // —— ① 一问一答（100×30）——那一句「我输入之后与模型回复之间没有空行」的正题 ——
    {
      const session = await sessionOf('u67-一问一答', 100, 30, [{ kind: 'text', text: '收到，我在。' }])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '在吗', '收到，我在。')

      const shot = await session.capture({ label: '01-一问一答' })
      keep(shot)
      checkChrome(shot, '01 一问一答')
      // **这一张就是那句抱怨的屏**：`› 在吗` 与 `⏺ 收到，我在。` **之间**有且只有一行
      checkLines(shot, '01 一问一答', ['· 「在吗」那一轮跑完了', '', '› 在吗', '', '⏺ 收到，我在。'])
      checkNotFull(shot, '01 一问一答')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ② 助手带工具组（100×30）——助手说了话，紧接着一个工具组 ——
    {
      const session = await sessionOf('u67-助手带工具组', 100, 30, [
        { kind: 'tool', name: 'ls', args: { path: '.' }, text: '我先看看。' },
        { kind: 'text', text: '看完了。' },
      ])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '看看工作区', '看完了。')

      const shot = await session.capture({ label: '02-助手带工具组' })
      keep(shot)
      checkChrome(shot, '02 助手带工具组')
      checkLines(shot, '02 助手带工具组', [
        '· 「看看工作区」那一轮跑完了',
        '',
        '› 看看工作区',
        '',
        '⏺ 我先看看。',
        '',
        '● ls {"path":"."}',
        '  ✓ Nms · [空目录]',
        '· 「看看工作区」那一轮跑完了',
        '',
        '⏺ 看完了。',
      ])
      checkNotFull(shot, '02 助手带工具组')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ③ **用户之后直接是工具**（100×30）——工单点名的那一形：中间没有 `⏺` ——
    {
      const session = await sessionOf('u67-用户之后直接是工具', 100, 30, [
        { kind: 'tool', name: 'ls', args: { path: '.' } }, // ⚠️ **一个字都不说**
        { kind: 'text', text: '看完了。' },
      ])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '看看工作区', '看完了。')

      const shot = await session.capture({ label: '03-用户之后直接是工具' })
      keep(shot)
      checkChrome(shot, '03 用户之后直接是工具')
      checkLines(shot, '03 用户之后直接是工具', [
        '· 「看看工作区」那一轮跑完了',
        '',
        '› 看看工作区',
        '',
        '● ls {"path":"."}',
        '  ✓ Nms · [空目录]',
        '· 「看看工作区」那一轮跑完了',
        '',
        '⏺ 看完了。',
      ])
      checkNotFull(shot, '03 用户之后直接是工具')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ④ 工具组夹在两条发言之间（100×30）——再补一条用户交代，看交界两头 ——
    {
      const session = await sessionOf('u67-工具组夹在两条发言之间', 100, 30, [
        { kind: 'tool', name: 'ls', args: { path: '.' }, text: '先看一眼。' },
        { kind: 'text', text: '这一处看过了。' },
        { kind: 'text', text: '好。' },
      ])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '看看工作区', '这一处看过了。')
      await settle(session, '那就好', '好。')

      const shot = await session.capture({ label: '04-工具组夹在两条发言之间' })
      keep(shot)
      checkChrome(shot, '04 工具组夹在两条发言之间')
      checkLines(shot, '04 工具组夹在两条发言之间', [
        '· 「看看工作区」那一轮跑完了',
        '',
        '› 看看工作区',
        '',
        '⏺ 先看一眼。',
        '',
        '● ls {"path":"."}',
        '  ✓ Nms · [空目录]',
        '· 「看看工作区」那一轮跑完了',
        '',
        '⏺ 这一处看过了。',
        '· 「看看工作区」那一轮跑完了',
        '',
        '› 那就好',
        '',
        '⏺ 好。',
      ])
      checkNotFull(shot, '04 工具组夹在两条发言之间')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ⑤ 连续两组工具（100×30）——两组各自成块、组内各自紧贴 ——
    {
      const session = await sessionOf('u67-连续两组工具', 100, 30, [
        { kind: 'tool', name: 'ls', args: { path: '.' }, text: '先列一下。' },
        { kind: 'tool', name: 'glob', args: { pattern: '*' }, text: '再看一份。' },
        { kind: 'text', text: '跑完了。' },
      ])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '看看工作区', '跑完了。')

      const shot = await session.capture({ label: '05-连续两组工具' })
      keep(shot)
      checkChrome(shot, '05 连续两组工具')
      checkLines(shot, '05 连续两组工具', [
        '· 「看看工作区」那一轮跑完了',
        '',
        '› 看看工作区',
        '',
        '⏺ 先列一下。',
        '',
        '● ls {"path":"."}',
        '  ✓ Nms · [空目录]',
        '· 「看看工作区」那一轮跑完了',
        '',
        '⏺ 再看一份。',
        '',
        '● glob {"pattern":"*"}',
        '  ✓ Nms · [无命中]',
        '· 「看看工作区」那一轮跑完了',
        '',
        '⏺ 跑完了。',
      ])
      check(
        countOn(contentOf(shot), '● ') === 2,
        '05：屏上**两组**工具（各一个 `●` 起头的组头——不是并成一段）',
      )
      checkNotFull(shot, '05 连续两组工具')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ⑥ 只有回执（无工具）（100×30）——回执**贴在前一块尾巴上**，前面不留空行 ——
    {
      const session = await sessionOf('u67-只有回执', 100, 30, [{ kind: 'text', text: '收到，我在。' }])
      sessions.push(session)
      await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
      await settle(session, '在吗', '收到，我在。')

      // 多写一个参数 ⇒ `/clear` 只回一句**回执**（不进任何工具、不翻页）
      await typeLine(session, '/clear 多余的参数')
      await session.key('enter')
      await session.wait({ text: '认得的用法' }, { timeoutMs: 10_000 })

      const shot = await session.capture({ label: '06-只有回执' })
      keep(shot)
      checkChrome(shot, '06 只有回执')
      checkLines(shot, '06 只有回执', [
        '· 「在吗」那一轮跑完了',
        '',
        '› 在吗',
        '',
        '⏺ 收到，我在。',
        // **紧贴在助手那一块之后**——回执贴的是前一块的尾巴（`blockOf` 不长块），
        // 它前面**不留**空行；它**后面**才是与下一块之间的那一行（见第 ②–⑤ 张）
        '· 认得的用法：/clear（不带参数）',
      ])
      check(
        countOn(contentOf(shot), '● ') === 0 && countOn(contentOf(shot), '⟳ ') === 0,
        '06：这一屏上**一个工具都没有**（只有回执）',
      )
      checkNotFull(shot, '06 只有回执')
      await session.quit()
      await session.close({ graceMs: 3_000 })
    }

    // —— ⑦ 矮窗 40×10——**多出来的空行要进高度账**（U45/U59 那两次的教训） ——
    {
      const session = await sessionOf('u67-矮窗40x10', 40, 10, [
        { kind: 'tool', name: 'ls', args: { path: '.' }, text: '先列一下。' },
        { kind: 'text', text: '完了。' },
      ])
      sessions.push(session)
      await session.wait({ text: '○ 空闲' }, { timeoutMs: 20_000 })

      // 起手那一屏：字标（一行版）＋ 分隔线 ＋ 输入行 ＋ 分隔线 ＋ 状态行
      const boot = await session.capture({ label: '07-矮窗起手' })
      keep(boot)
      checkChrome(boot, '07 矮窗起手')
      check(countOn(boot.lines, '› ') >= 1, '07：起手那一屏**输入行在**（40×10 上没被挤掉）')
      checkNotFull(boot, '07 矮窗起手')

      // 一轮里走完「用户 → 空助手行 → 工具 → 发言」：本单元新增的边界最多的那一形
      await settle(session, '看看工作区', '完了。')

      const shot = await session.capture({ label: '07-矮窗 40×10' })
      keep(shot)
      checkChrome(shot, '07 矮窗 40×10')
      check(countOn(shot.lines, '› ') >= 1, '07：输入行**没被挤掉**（多出来的空行进了账，没吃掉交互区）')
      checkNotFull(shot, '07 矮窗 40×10')
      check(
        shot.lines.every((line) => [...line].length <= 40),
        '07：窄窗上**没有一行超出宽度**（超了终端自己折行＝溢出）',
      )
      // 矮窗上记录区只剩尾巴——判据落在那一截上：回执之后**一行**，再接那句发言
      const tail = contentOf(shot)
      check(
        tail.includes('') && tail.at(-1) === '⏺ 完了。',
        '07：矮窗上那一道交界仍在（回执之后一行、再接 `⏺ 完了。`）',
        JSON.stringify(tail),
      )
      check(blankRuns(shot).length === 0, '07：矮窗上记录区也没有成片空行')
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
