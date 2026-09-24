#!/usr/bin/env bun
/**
 * U43 · **切换会话不重印字标**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 「一屏一个」是**屏**上的话——字标印进 scrollback 之后不在视图里，单元用例量不动它
 * （`packages/tui/test/spec.u43.test.ts` 量的是帧序里累计印了几份，两边各钉一半）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 场景（工单里那条）
 *
 * 甲落账 → `/clear` → 乙落账 → `/resume` 选回甲。三屏各留一帧：
 * **① 开机屏 · ② 换回甲那一屏 · ③ 再切到乙那一屏**（常宽 100×30 一趟，窄窗 46×30 一趟）。
 *
 * 每屏上判四件：**字标份数对得上**（且在最前） · **回执在**（这一屏的界） ·
 * **目标会话的记录铺出来了** · **没有残块**。
 *
 * ## ⚠️ U44 / U45 之后本脚本改了什么（读它之前先读这段）
 *
 * 三处**行为变了**，判据跟着变（不是放宽，是跟着新行为走）：
 *
 * 1. **`/clear` 不再留字**——U44 起「换会话＝翻页」，`/clear` 的回执**就是清屏本身**；
 *    U43 补条那句 `· 已开一条新会话` 随之作废（工单明文）。故那一跳改判
 *    「屏真被清了」＋「切走那条的记录**还在缓冲里**」。
 * 2. **翻页把可见屏推进 scrollback**——于是「字标在最前」改为量**整份缓冲**的顶行
 *    （翻过页之后可见那一截的顶行是记录，那是翻页**该做**的事）。
 *    「记录又铺了一遍」那几处等待也换成了「**新页铺好了**」（回执 ＋ 目标记录同时在可见屏上）
 *    ——翻页之后旧内容不在可见区，这一条才真的在等重建。
 * 3. **字标按「开一条新的」印**（U45 · 设计 · 终端呈现）——本文件原句是『一屏只有一份字标』
 *    （U43 的裁定：只在开机印一次）。改判之后 **`/clear` 各印一块、`/resume` 一块都不印**：
 *    故份数**不再是一个常数**——开机之后那一屏 `1`，`/clear` 之后各屏 `2`（开机那块 ＋ 那一跳那块），
 *    `/resume` 那几跳**维持 `2` 不动**（这正是本文件最该咬住的一格）。
 *    份数照钉**精确值**（`checkScreen` 的 `want` 由各屏自己给，不许退成「至少出现过」）。
 *
 * 翻页本身（清成什么样 / scrollback 读数 / 半截屏）的正面证据在 `frames-u44-tui.ts`。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u43-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE, bannerOf } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import { MAGIC_IDLE_MARK } from './ui/anchors.ts'
import type { Capture, UiSession } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 这一趟的产物根——`keep()` 要用（入口解析 `--out` 之后填）。 */
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
  console.log(`\n── ${shot.label} ──\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 屏上 `needle` 出现几次。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/**
 * **记录区**那几行（分隔线之上）——含滚进 scrollback 的。
 *
 * `Capture.lines` 是可见那一屏（底下还压着输入行与状态行），而「这一跳多印了什么」问的是
 * 记录区：拿它比对才能说清「多出来的**正好是**那一样」。
 */
function recordOf(shot: Capture): readonly string[] {
  const divider = shot.history.findIndex((line) => /^─{8,}$/u.test(line.trim()))

  return divider === -1 ? [...shot.history] : shot.history.slice(0, divider)
}

/**
 * 「字标画幅首行」在**整份缓冲**（含滚进 scrollback 的）里出现几次——
 * **每多一份＝终端上多一块字标**（本单要防的就是它）。
 *
 * ⚠️ 量**整份缓冲**而不是可见那一截：多印的那一份可以已经滚出可见区，
 * 只看可见屏时它「不在」——那正好是本单要躲开的空转（旧的那份擦不掉，
 * 它会一直留在屏上/缓冲里）。
 */
function bannerCopies(shot: Capture): number {
  const art = (bannerOf(shot.columns)[0]?.text ?? '').replace(/\s+$/u, '')

  return shot.history.filter((line) => line.replace(/\s+$/u, '') === art).length
}

/**
 * 等屏上的某个**条件**成立（`wait` 的闭集装不下「数一数」这类判据，故自己轮询 `screen()`）。
 *
 * ⚠️ 超时**如实失败**（带上此刻的整屏）——不重发、不重试、不拿固定 sleep 当同步。
 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 10_000,
): Promise<readonly string[]> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6

  for (;;) {
    const { lines } = await session.screen()
    const text = lines.map((line) => line.text)

    if (ok(text)) return text
    if (Bun.nanoseconds() > until) throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${text.join('\n')}`)

    await Bun.sleep(40)
  }
}

/**
 * 等**整份缓冲**里那块字标攒够 `copies` 块（U45）——每次「开一条新的」各印一块。
 *
 * 由头：`/clear` 那一跳的回执是**清屏 ＋ 字标**，而字标是**新那一页**画出来的（Ink 的重绘
 * 排在微任务里）——「旧内容不在可见屏上了」那一下**早于**新页铺出来（实测：紧接着取帧会少一块）。
 * 等它数够了再取帧，量的才是「这一跳真印出来了」。
 */
async function waitBanner(session: UiSession, copies: number): Promise<void> {
  const art = (bannerOf(session.columns)[0]?.text ?? '').replace(/\s+$/u, '')

  for (let at = 0; at < 250; at += 1) {
    const { history } = await session.screen()
    if (history.filter((line) => line.replace(/\s+$/u, '') === art).length >= copies) return

    await Bun.sleep(40)
  }

  throw new Error(`等了 10 秒，整份缓冲里仍不足 ${copies} 块字标`)
}

/**
 * 四件「这一屏长什么样」的判据——每留一帧都过一遍（少判一屏就是空转）。
 *
 * ⚠️ **「字标在最前」改为量整份缓冲**（U44）：翻页把可见屏推进 scrollback，于是翻过页之后
 * **可见那一截**的顶行是记录 / 帧，不再是字标——而「字标仍在一份的前面」这个事实没变
 * （它在缓冲的最顶上，往上翻就看到）。拿可见那一截判，量到的会是「翻页把它推走了」，
 * 那正是翻页**该做**的事，不是缺陷。
 */
function checkScreen(shot: Capture, where: string, laidOut: string, want: number): void {
  const first = shot.history.find((line) => line.trim() !== '') ?? ''
  const art = (bannerOf(shot.columns)[0]?.text ?? '').replace(/\s+$/u, '')

  // ⚠️ **份数按屏上真有的那块数**（U45 起：`/clear` 各印一块）——`want` 由调用方给，
  //    不由这一处猜：这一条问的是「**这一跳多印了没有**」，而各屏的正确答案不同。
  check(bannerCopies(shot) === want, `${where}：字标份数对得上（${want} 份）`, `实际 ${bannerCopies(shot)} 份`)
  check(first.replace(/\s+$/u, '') === art, `${where}：它就在最前面（整份缓冲的顶行）`, `顶行＝「${first}」`)
  check(countOn(shot.history, '· 已切到') >= 1, `${where}：回执在——这一屏的界由它承担`)
  check(countOn(shot.history, laidOut) >= 1, `${where}：目标会话的记录铺出来了（${laidOut}）`)
}

/**
 * 等**新那一页真铺好了**：回执（新页的头一行）与目标会话的记录**同时在可见屏上**。
 *
 * ⚠️ **不能只等记录行**（U43 的老坑，U44 起更甚）：那段字在**切走的那一条**上本来就有
 * （同名记录两边都有），「屏上有它」可能当场为真 ⇒ 等待空转、取到的是还没翻页的那一帧。
 * 回执**只在新页上出现**（U44 起它是页头那一行），两个一起要求才说得上是「铺好了」。
 *
 * ⚠️ **必须看可见屏**（`session.screen()` 给的正是它）：翻页之后旧内容进了 scrollback，
 * 它还在 `history` 里——拿整份缓冲数就是恒真。**这里要的恰恰是「它已经离开可见区」。**
 */
async function waitLaidOut(session: UiSession, label: string, row: string, timeoutMs = 10_000): Promise<void> {
  await waitUntil(
    session,
    `新页铺好（回执 ＋「${row}」同时在屏上）`,
    (lines) => countOn(lines, `· 已切到 ${label}`) >= 1 && countOn(lines, row) >= 1,
    timeoutMs,
  )
}

/**
 * 抽屉里把光标挪到 `label` 那一条上——**按屏上印的行号算**（`01 ` 那一列）。
 *
 * 为什么不直接按方向键猜：目录的序由内核给（这里是**最近在前**），本脚本不假定它；
 * 而光标起点是**当前那条**（`openPicker` 的 `selected`），屏上那一行印着「正在用」——
 * 两个行号一减就是要按几下。
 */
async function moveTo(session: UiSession, label: string): Promise<void> {
  const lines = await waitUntil(session, `抽屉铺开且有「${label}」与「正在用」两行`, (all) => {
    const divider = all.findIndex((line) => /^─{8,}$/u.test(line.trim()))
    const dock = divider === -1 ? [] : all.slice(divider + 1)

    return dock.some((line) => line.includes('正在用')) && dock.some((line) => line.includes(label))
  })

  // ⚠️ **只在分隔线之下找**：记录区里也有「› 第一条会话的交代」那几行（回显与重建的行），
  //    整屏找会先撞上它们（实测栽过：读到的是记录区那一行，不是抽屉那一行）
  const divider = lines.findIndex((line) => /^─{8,}$/u.test(line.trim()))
  const dock = lines.slice(divider + 1)

  /** 抽屉里某一行开头那个序号（`01 `）——认不出就当场抛。 */
  const numberOf = (what: string, at: number): number => {
    const matched = /^\s*(\d+) /u.exec(dock[at] ?? '')
    if (matched === null) throw new Error(`抽屉里${what}那一行读不出序号：「${dock[at]}」`)

    return Number(matched[1])
  }

  const target = numberOf(label, dock.findIndex((line) => line.includes(label)))
  const current = numberOf('「正在用」', dock.findIndex((line) => line.includes('正在用')))

  for (let step = 0; step < Math.abs(target - current); step += 1) {
    await session.key(target > current ? 'down' : 'up')
  }
}

/**
 * 常宽那一趟：甲落账 → `/clear` → 乙落账 → `/resume` 选回甲 → 再切到乙。
 *
 * 六屏都留：`01` 开机 · `02` 甲落账 · `03` 切到空会话 · `04` 乙落账 ·
 * `05` **换回甲那一屏**（工单要的那一屏）· `06` 再切到乙那一屏（来回各一次）。
 */
async function switching(): Promise<void> {
  const session = await createUiSession({
    label: 'u43-切会话-常宽',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'text', text: '收到甲的交代。' },
      { kind: 'text', text: '收到乙的交代。' },
    ],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    const boot = await session.capture({ label: '01-开机屏' })
    keep(boot)
    check(bannerCopies(boot) === 1, '开机屏：字标一份（印一次）')

    // —— 甲落账 ——
    await typeLine(session, '第一条会话的交代')
    await session.key('enter', { until: { text: '收到甲的交代。' }, timeoutMs: 20_000 })
    // ⚠️ 等**状态那一格**，不等右位那句键位提示：这一趟是 46 列的窄窗，而首条交代落账后
    //    状态行左位换成**真标题**，右位那句按既有口径让位（U50 起；由头见 `driver.ts` 的
    //    `MAGIC_IDLE_MARK`）。拿它当条件＝量窗口宽度，不是「它闲下来了没有」。
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })
    const jia = await session.capture({ label: '02-甲落账' })
    keep(jia)
    check(bannerCopies(jia) === 1, '甲落账之后：仍只有开机那一份字标')

    // —— `/clear`：清屏 ＋ 开一条新的（**回执就是清屏本身**，一个字都不印） ——
    //
    // ⚠️ **U44 起了新裁定**：旧那一跳（`/session new`）留的 `· 已开一条新会话` 作废了——
    // 翻页把可见屏清掉，屏上那一下已经说明了一切。故这一帧要等的是**屏真被清了**：
    // 切之前那一屏上的记录（`› 第一条会话的交代`）**不在可见区了**。
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitUntil(
      session,
      '`/clear` 之后屏上不再有切走那条的记录',
      (lines) => countOn(lines, '› 第一条会话的交代') === 0,
      10_000,
    )
    await waitBanner(session, 2) // 开机那块 ＋ 这一跳那块（U45）
    const fresh = await session.capture({ label: '03-clear 之后' })
    keep(fresh)
    // ⚠️ **本条 2026-09-24 按新行为改写**（U45 · 设计 · 终端呈现「字标是开一条新的的记号」）：
    //    原句是『`/clear`：**不重印字标**』（U43：只在开机印一次），锚 `=== 1`。
    //    改判之后 `/clear` 正是「开一条新的」⇒ **印**：缓冲里**两块**（开机那块 ＋ 这一块）。
    //    判据没删——问的还是「这一跳印了几块」，只是答案从「一块都不多」变成「**正好多一块**」。
    check(bannerCopies(fresh) === 2, '`/clear`：**印**（开机那块 ＋ 这一块，共两块）', `实际 ${bannerCopies(fresh)} 份`)
    check(
      countOn(fresh.history, '› 第一条会话的交代') >= 1,
      '切走那条的记录**没被抹掉**（还在缓冲里——往上翻看得到）',
      `整份缓冲实际 ${countOn(fresh.history, '› 第一条会话的交代')} 行`,
    )
    check(
      recordOf(fresh).join('\n') !== recordOf(jia).join('\n'),
      '那一屏**不是**切之前那一屏（记录区不再跨会话累积）',
    )

    // —— 乙落账 ——
    await typeLine(session, '第二条会话的交代')
    await session.key('enter', { until: { text: '收到乙的交代。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const yi = await session.capture({ label: '04-乙落账' })
    keep(yi)
    check(bannerCopies(yi) === 2, '乙落账之后：仍是那两块（落账不再添）')

    // —— `/resume` 选回甲：**这一屏就是本单要的那一屏** ——
    //
    // ⚠️ 等的是「**新页铺好了**」（回执 ＋ 目标的记录同时在可见屏上），不是「那段字出现过」——
    //    那段字在 `02` 就印过了，拿「屏上有它」当条件就是空转（实测踩过同形的坑）。
    //    翻页之后旧内容进了 scrollback，可见屏上看不见它，故这一条等待**才**真的在等重建。
    await typeLine(session, '/resume')
    await session.key('enter') // 回车＝**开抽屉**（`/resume` 这一条命令的答复随后到）
    // 抽屉刚开时选中的是**当前那条**（乙）——挪到甲那一行（按屏上印的行号算）
    await moveTo(session, '第一条会话的交代')
    await session.key('enter')
    await waitLaidOut(session, '第一条会话的交代', '› 第一条会话的交代')
    const back = await session.capture({ label: '05-换回甲那一屏' })
    keep(back)
    checkScreen(back, '换回甲那一屏', '› 第一条会话的交代', 2)
    check(
      countOn(back.history, '› 第一条会话的交代') >= 2,
      '换回甲那一屏：那条会话的记录**照常重铺**（不是被「不重印」连带吞掉）',
      `实际 ${countOn(back.history, '› 第一条会话的交代')} 遍`,
    )

    // —— 再切到乙：来回各一次，回执每次都在 ——
    await typeLine(session, '/resume')
    await session.key('enter')
    await moveTo(session, '第二条会话的交代')
    await session.key('enter')
    await waitLaidOut(session, '第二条会话的交代', '› 第二条会话的交代')
    const again = await session.capture({ label: '06-再切到乙那一屏' })
    keep(again)
    checkScreen(again, '再切到乙那一屏', '› 第二条会话的交代', 2)

    check(
      countOn(again.history, '· 已切到') >= 2,
      '连切两次：**回执两次都在**（没有「字标没了、回执也没了」的空屏）',
      `实际 ${countOn(again.history, '· 已切到')} 条`,
    )

    // 空闲**按两次**才走（U46）
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

/** 窄窗那一趟（46 列＝**一行版**字标）——同一个帧序，量「只一份」与「没有残块」。 */
async function narrow(): Promise<void> {
  const session = await createUiSession({
    label: 'u43-切会话-窄窗',
    columns: 46,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'text', text: '收到甲的交代。' },
      { kind: 'text', text: '收到乙的交代。' },
    ],
  })

  try {
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })
    const boot = await session.capture({ label: '07-窄窗开机屏' })
    keep(boot)

    await typeLine(session, '第一条会话的交代')
    await session.key('enter', { until: { text: '收到甲的交代。' }, timeoutMs: 20_000 })
    // ⚠️ 等**状态那一格**，不等右位那句键位提示：这一趟是 46 列的窄窗，而首条交代落账后
    //    状态行左位换成**真标题**，右位那句按既有口径让位（U50 起；由头见 `driver.ts` 的
    //    `MAGIC_IDLE_MARK`）。拿它当条件＝量窗口宽度，不是「它闲下来了没有」。
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    // `/clear`——窄窗下这一跳不留字（回执就是清屏），等的是**屏真被清了**
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitUntil(
      session,
      '窄窗下 `/clear` 之后屏上不再有切走那条的记录',
      (lines) => countOn(lines, '第一条会话的交代') === 0,
      10_000,
    )
    await waitBanner(session, 2) // 开机那块 ＋ 这一跳那块（U45）
    const fresh = await session.capture({ label: '07a-窄窗 clear 之后' })
    keep(fresh)
    // 同常宽那一条：U45 起 `/clear` **印**（窄窗这一档是一行版 `Magic Code`，一块也是一行）
    check(bannerCopies(fresh) === 2, '窄窗下 `/clear`：**印**（开机那块 ＋ 这一块，共两块）', `实际 ${bannerCopies(fresh)} 份`)
    check(
      countOn(fresh.history, '第一条会话的交代') >= 1,
      '窄窗下切走那条的记录也**没被抹掉**（还在缓冲里）',
    )
    check(
      fresh.history.every((line) => line.includes('█') === false),
      '窄窗下 `/clear` 也**没有块字残块**',
    )

    await typeLine(session, '第二条会话的交代')
    await session.key('enter', { until: { text: '收到乙的交代。' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    await typeLine(session, '/resume')
    await session.key('enter')
    await moveTo(session, '第一条会话的交代')
    await session.key('enter')
    await waitLaidOut(session, '第一条会话的交代', '第一条会话的交代')
    const back = await session.capture({ label: '08-窄窗换会话那一屏' })
    keep(back)

    check(bannerCopies(back) === 2, '窄窗换会话那一屏：仍是那两块（`/resume` 不印）', `实际 ${bannerCopies(back)} 份`)
    check(
      back.history.every((line) => line.includes('█') === false),
      '窄窗下不印块字版——换会话那一屏（含 scrollback）也**没有残块**',
    )
    check(countOn(back.history, '· 已切到') >= 1, '窄窗下回执照常在')
    check(
      countOn(back.history, '第一条会话的交代') >= 2,
      '窄窗下目标会话的记录照常铺出来',
      `实际 ${countOn(back.history, '第一条会话的交代')} 遍`,
    )
    check(
      back.lines.every((line) => [...line].length <= 46),
      '窄窗上没有一行超出宽度',
      `最长一行 ${Math.max(...back.lines.map((line) => [...line].length))} 列`,
    )

    // 空闲**按两次**才走（U46）
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '窄窗那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u43-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    await switching()
    await narrow()
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
