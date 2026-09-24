#!/usr/bin/env bun
/**
 * U44 · **换会话＝翻页**（清可见屏 · 留 scrollback）——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 翻页是**终端上的动作**（一串字节），单元用例那一层（`show(views…)` 逐帧过 `AppView`）
 * 根本没有它——**清成了什么样、旧内容还在不在、有没有露出半截屏**，只能从真 PTY 写出的
 * 字节里读回来。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 三屏（工单里那三件）
 *
 * ① `/clear`（有内容的一屏 → 清成什么样）· ② `/resume` 切到另一条 · ③ `/resume` 切回来。
 *
 * 每屏判四件：
 * - **从空白页起铺**——这一页的第一行就在**可见屏的顶行**（旧内容不在它上面压着）；
 * - **没有上一条的残留**——切走那条的字**一行都不在可见屏上**；
 * - **scrollback 还在**——`scrollback` 读数**涨上去**了（旧内容被推进存档区），且它在
 *   整份缓冲里**一行不少**（这是判「没清 scrollback」的**正面证据**：只看可见屏，
 *   「被推走」与「被抹掉」长得一模一样）；
 * - **没有半截屏**——分隔线 ＋ 输入行 ＋ 状态行都在（一帧是完整的），
 *   且翻页那串字节**包在同步更新块里**（终端不可能显示「擦完了还没画」那一瞬间）。
 *
 * ## 另外两件（工单上单列的）
 *
 * - **三个入口各跑一遍**：`/clear` 不印文案 · `/resume` 空参数开得出列表且选定即切 ·
 *   `/rename` 无文本给提示；
 * - **内核忙时那一跳有话说**——`session.state` 的 `note` 接上了（原先那一格没有出口，
 *   「按了没反应」原样留着）。
 *
 * 常宽 100×30 一趟，窄窗 46×30 一趟。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u44-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE, bannerOf } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import { IDLE_MARK } from './ui/driver.ts'
import type { Capture, UiSession } from './ui/index.ts'
import type { VtScreen } from './ui/vt.ts'
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
  console.log(
    `\n── ${shot.label} ──（scrollback ${shot.scrollback} · 可见 ${shot.lines.filter((l) => l.trim() !== '').length} 行非空）\n${shot.text}`,
  )
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
 * **这一屏的页首该是什么**（U45）——`/clear` 开的那一页**从字标起**（设计 · 终端呈现：
 * 字标是「开一条新的」的记号），`/resume` 翻回的那一页从回执起。
 *
 * ⚠️ **本脚本此处换过锚**（U45；不是放宽）：原锚一律是 `'─'`——那时 `/clear` 那一页是
 * **全空**的，逐行往下第一个非空格就是分隔线。裁定之后它头上多了那一块字标，
 * 「从空白页起铺」这半条判据仍在，只是**顶行由字标充当**（原锚问的也正是「顶上没有旧内容」）。
 */
const bannerTop = (columns: number): string => (bannerOf(columns)[0]?.text ?? '').replace(/\s+$/u, '')

/**
 * **整份缓冲里字标画幅首行出现几次**（U45）——「开一条新的」印一次，
 * 故开机 ＋ 每一次 `/clear` 各留一块；`/resume` 一块都不添。
 */
function bannerCopies(shot: Capture): number {
  const art = bannerTop(shot.columns)

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
 * 等**整屏**上的某个条件成立——`waitUntil` 那一副的兄弟：它把**可见那一截**交给判据，
 * 而「整份缓冲里第几块字标」「scrollback 读数」这类条件在 `lines` 里装不下（得看 `history`）。
 *
 * ⚠️ 超时**如实失败**（带上此刻的可见屏），不重发、不重试。
 */
async function waitScreen(
  session: UiSession,
  what: string,
  ok: (screen: VtScreen) => boolean,
  timeoutMs = 10_000,
): Promise<VtScreen> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6

  for (;;) {
    const screen = await session.screen()

    if (ok(screen)) return screen
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${screen.lines.map((line) => line.text).join('\n')}`)
    }

    await Bun.sleep(40)
  }
}

/**
 * 翻页那串字节：**若干换行 ＋ 光标归位**。
 *
 * ⚠️ 只认这一段：`CSI H`（光标归位）在本仓的外壳里**只有翻页会写**（Ink 自己那两条
 * 写点用的是 `CSI G` / `CSI <n>G`），故它在字节流里就是翻页的指纹。
 */
const FLIP_MARK = '\u001b[H'
const SYNC_ON = '\u001b[?2026h'
const SYNC_OFF = '\u001b[?2026l'

/**
 * 翻页那几处**都包在同步更新块里**吗（工单：「不许有半截屏」）。
 *
 * 由头：认得同步更新的终端在 `?2026l` 那一下**整帧一次落地**——起手擦掉旧帧、中间那一段
 * （**擦完了还没画**：屏是空的，记录与输入行都不在）谁也看不见。翻页若不在这对标记里，
 * 那一瞬间就可能被看见（也正是 `vt.ts` 的 `splitFrames` 不许我们取到的那种帧）。
 *
 * 判据：每一处 `CSI H` 都要满足「它前面最近的是 `?2026h`、后面最近的是 `?2026l`，
 * 且这两头之间没有别的 `?2026h`」（＝它落在**某一块之内**，不是块与块之间）。
 */
function flipsAreSynchronized(bytes: string): { readonly total: number; readonly loose: number } {
  let total = 0
  let loose = 0

  for (let at = bytes.indexOf(FLIP_MARK); at !== -1; at = bytes.indexOf(FLIP_MARK, at + 1)) {
    total += 1
    const open = bytes.lastIndexOf(SYNC_ON, at)
    const close = bytes.indexOf(SYNC_OFF, at)
    if (open === -1 || close === -1 || bytes.indexOf(SYNC_ON, open + 1) < at) loose += 1
  }

  return { total, loose }
}

/**
 * 一帧是不是**完整的**（工单：「清屏与重铺之间不能露出『擦完了还没画』的中间态」）。
 *
 * 三件缺一不可：**一整条分隔线**（按当时的列数，折行的半截份不算）· **输入行** ·
 * **状态行**。清完还没画的那一瞬间，这三样一个都不在——所以这一条量的正是那个瞬间有没有被看见。
 */
function frameIsWhole(shot: Capture, where: string): void {
  const divider = '─'.repeat(shot.columns)
  const hasDivider = shot.lines.some((line) => line.includes(divider))
  const hasComposer = countOn(shot.lines, '›') >= 1
  const hasStatus = countOn(shot.lines, '○ ') >= 1 || countOn(shot.lines, '● ') >= 1

  check(hasDivider, `${where}：一整条分隔线在（帧是画完了的，不是擦到一半）`)
  check(hasComposer, `${where}：输入行在（没有「擦完了还没画」那一瞬间）`)
  check(hasStatus, `${where}：状态行在`)
}

/** 一屏「这一页铺好了没有」的四件——每一跳都过一遍。 */
function checkPage(
  shot: Capture,
  where: string,
  options: {
    /** 这一页顶行该是什么（从空白页起铺的判据）。 */
    readonly top: string
    /** 可见屏上**不许**再有这些字（上一条的残留）。 */
    readonly gone: readonly string[]
    /** 切走那条的东西——翻过页之后**必须在整份缓冲里还找得到**。 */
    readonly kept: readonly string[]
    /** 翻页之前那一帧——`scrollback` 读数要比它**大**（旧内容被推上去了）。 */
    readonly before: Capture
  },
): void {
  // ① 从空白页起铺：这一页的第一行就在**可见屏的顶行**
  const first = shot.lines.find((line) => line.trim() !== '') ?? ''
  check(
    first.includes(options.top),
    `${where}：这一页**从空白页起铺**（顶行＝「${options.top}」）`,
    `实际顶行＝「${first}」`,
  )

  // ② 没有上一条的残留：切走那条的字一行都不在可见屏上
  for (const needle of options.gone) {
    check(
      countOn(shot.lines, needle) === 0,
      `${where}：切走那条的「${needle}」**一行都不在可见屏上**`,
      `实际 ${countOn(shot.lines, needle)} 行`,
    )
  }

  // ③ **scrollback 还在**（判「没清 scrollback」的正面证据）。
  //
  // 为什么非看这个读数不可：**只看可见屏，「被推走」与「被抹掉」长得一模一样**——
  // 两种做法下那几个字都不在屏上。读数涨上去，才说明它们是被**推进存档区**了。
  const pushed = shot.scrollback - options.before.scrollback
  check(
    pushed > 0,
    `${where}：**scrollback 读数涨上去了**（旧内容被推进存档区，不是被抹掉）`,
    `切之前 ${options.before.scrollback} 行 → 切之后 ${shot.scrollback} 行`,
  )
  // 涨了几行**不写死**：翻页那一刻屏上是什么，取决于切之前最后那一帧——而中间还夹着
  // 开抽屉 / 关抽屉（帧高变过）。故只要求「**至少**把切走那条露在外面的那几行推走了」。
  const shown = options.gone.reduce((sum, needle) => sum + countOn(options.before.lines, needle), 0)
  check(
    pushed >= shown,
    `${where}：涨的格数够把切走那条**露在外面的那几行**推走（不是只挪了一两行）`,
    `涨了 ${pushed} 行，切走那条切之前露着 ${shown} 行`,
  )

  // 且那些字**真还在**（在整份缓冲里找得到——`history` 含滚进 scrollback 的）
  for (const needle of options.kept) {
    check(
      countOn(shot.history, needle) >= 1,
      `${where}：切走那条的「${needle}」**在整份缓冲里还找得到**`,
      `实际 ${countOn(shot.history, needle)} 行`,
    )
  }

  // ④ 没有半截屏：这一帧是完整的
  frameIsWhole(shot, where)
}

/** 本条会话那两句交代——用来认「屏上这一条是谁」。 */
const 甲说 = '甲这一条：先看看有什么'
const 甲答 = '甲这一条：列好了。'
const 乙说 = '乙这一条：换个方向'
const 乙答 = '乙这一条：也列好了。'

// ══ 常宽那一趟 ═══════════════════════════════════════════════════════

/**
 * 100×30：有内容的一屏 → `/clear` → 乙落账 → `/resume` 选回甲 → 再 `/rename` 无文本 →
 * 忙着按 `/clear`。
 *
 * 每一跳留一帧：`01` 有内容 · `02` clear 之后 · `03` 乙落账 · `04` resume 抽屉 ·
 * `05` 切回甲 · `06` rename 无文本 · `07` 忙时 clear。
 */
async function wide(): Promise<void> {
  const session = await createUiSession({
    label: 'u44-翻页-常宽',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [
      { kind: 'text', text: 甲答 },
      { kind: 'text', text: 乙答 },
      // 第三次起换成**慢慢吐**的：忙那一跳要在它跑着的时候按下去
      { kind: 'text', text: '这一条很长，长到够慢慢吐一会儿，好让忙的那一跳赶得上。', chunks: 10, chunkDelayMs: 900 },
    ],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    // —— 甲落账：屏上先有内容，`/clear` 才有东西可清 ——
    await typeLine(session, 甲说)
    await session.key('enter', { until: { text: 甲答 }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const full = await session.capture({ label: '01-有内容的一屏' })
    keep(full)
    check(countOn(full.lines, 甲说) >= 1, '01：这一条的两句真在可见屏上（不然「清」这一手没得判）')

    // —— ① `/clear`：有内容的一屏 → 清成什么样 ——
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitUntil(session, '`/clear` 之后屏上不再有切走那条', (lines) => countOn(lines, 甲说) === 0)
    const cleared = await session.capture({ label: '02-clear 之后' })
    keep(cleared)

    checkPage(cleared, '02', {
      // 新开的那条是空的 ⇒ 空白页上只剩帧；**顶行是字标**（U45：`/clear` 是「开一条新的」，
      // 那一页从字标起——原锚 `'─'` 是「那一页全空」时代的，见 `bannerTop` 的注）
      top: bannerTop(cleared.columns),
      gone: [甲说, 甲答],
      kept: [甲说, 甲答],
      before: full,
    })
    // 整份缓冲里**两块**字标：开机印的那块（在 scrollback 里）＋ `/clear` 这一页新印的
    check(bannerCopies(cleared) === 2, '`/clear` 那一页**印字标**（缓冲里开机那块 ＋ 这一块，共两块）', `实际 ${bannerCopies(cleared)} 块`)
    check(
      !cleared.lines.some((line) => line.includes('/clear')),
      '`/clear` **不印文案**（回执就是清屏本身；命令词本身也不留）',
    )
    check(
      countOn(cleared.history, '已开一条新会话') === 0,
      'U43 补条那句 `· 已开一条新会话` 随之作废（一个字都没有）',
    )

    // —— 乙落账（新那一条里有东西，后头才认得出「切到的是哪一条」） ——
    await typeLine(session, 乙说)
    await session.key('enter', { until: { text: 乙答 }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const yi = await session.capture({ label: '03-乙落账' })
    keep(yi)
    check(countOn(yi.lines, 乙说) >= 1, '03：乙这一条真在屏上')

    // —— ② `/resume` 空参数：开得出列表，选定即切到甲 ——
    await typeLine(session, '/resume')
    await session.key('enter')
    // ⚠️ 等的是**抽屉真铺开了**（`正在用` 那一行只可能来自它），不是那句右位提示——
    //    窄窗下状态行放不下它（左右两半挤在一行），拿它当条件会白等到超时。
    await session.wait({ text: '正在用' }, { timeoutMs: 10_000 })
    const drawer = await session.capture({ label: '04-resume 抽屉' })
    keep(drawer)
    check(countOn(drawer.lines, 甲说) >= 1, '04：`/resume` 空参数**开得出列表**，里头有甲那条')
    check(countOn(drawer.lines, '正在用') >= 1, '04：列表带「正在用」（当前那条标出来了）')

    await session.key('up', { until: { text: '正在用' }, timeoutMs: 5_000 })
    await session.key('enter')
    await waitUntil(
      session,
      '切回甲：回执与新页的记录同时在屏上',
      (lines) => countOn(lines, '已切到') >= 1 && countOn(lines, 甲说) >= 1,
    )
    const back = await session.capture({ label: '05-切回甲那一屏' })
    keep(back)

    checkPage(back, '05', {
      // 换会话那一页的界由回执承担 ⇒ 它就在顶行（字标不在换会话时重印）
      top: '· 已切到',
      gone: [乙说, 乙答],
      kept: [乙说, 乙答],
      before: yi,
    })
    check(countOn(back.lines, 甲说) >= 1, '05：目标会话的记录**照常铺出来**（不是被清屏连带吞掉）')

    // —— `/rename` 无文本：提示补上，不静默 ——
    await typeLine(session, '/rename')
    await session.key('enter', { until: { text: '要改成什么' }, timeoutMs: 10_000 })
    const rename = await session.capture({ label: '06-rename 无文本' })
    keep(rename)
    check(countOn(rename.lines, '要改成什么') >= 1, '`/rename` 无文本**给了提示**（不静默）')
    check(
      rename.lines.some((line) => line.includes('/rename <文本>')),
      '提示里点的是**这条命令自己的写法**（用户照着敲得出下一步）',
    )
    check(
      !rename.lines.some((line) => line.includes('/session')),
      '屏上不再有 `/session` 那个实体入口（整条撤掉了）',
    )

    // —— 忙时按 `/clear`：内核挡回，那一跳得有话说 ——
    await typeLine(session, '这一条会跑一会儿')
    await session.key('enter')
    // 状态行报「ctrl+c 中断」＝这一轮真跑起来了（`HINT_WORKING`；忙的判据取它）
    await session.wait({ text: 'ctrl+c 中断' }, { timeoutMs: 15_000 })

    await typeLine(session, '/clear')
    await session.key('enter', { until: { text: '正在跑一轮' }, timeoutMs: 10_000 })
    const busy = await session.capture({ label: '07-忙时 clear' })
    keep(busy)
    check(
      countOn(busy.lines, '正在跑一轮') >= 1,
      '忙时那一跳**有话说**（`note` 接上了，不再「按了没反应」）',
    )
    // 挡回那一跳**没有**再冒一句「已切到」（说的是真发生过的：这一跳什么都没切）
    check(
      countOn(busy.lines, '· 已切到') === countOn(rename.lines, '· 已切到'),
      '挡回那一跳**没有**再冒「已切到」（说的都是真发生过的）',
      `拒之前 ${countOn(rename.lines, '· 已切到')} 条 → 拒之后 ${countOn(busy.lines, '· 已切到')} 条`,
    )
    check(
      countOn(busy.lines, 甲说) >= 1,
      '挡回那一跳**也没清屏**（什么都没发生，屏就不该动）',
    )

    // —— 收尾：先把这一轮断了（工作中那一下是**中断**），等闲下来再走「按两次」那条路 ——
    await session.key('ctrl+c')
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)

    // 翻页一共发生了三次（clear · 切回甲 · 忙那一下没翻）= 两次；都在同步块里
    const sync = flipsAreSynchronized(session.rawText())
    check(sync.total >= 2, '字节流里认得出翻页那一手（`CSI H` 至少两处）', `实际 ${sync.total} 处`)
    check(sync.loose === 0, '每一处翻页都**包在同步更新块里**（终端不可能露出「擦完了还没画」）', `裸的 ${sync.loose} 处`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 开局就 `/clear` 那一趟（`null → 头一条` 那一格）════════════════════

/**
 * **空手开机 → `/clear`**——这一趟单跑，因为它是翻页里最容易漏的那一格。
 *
 * 由头（真 PTY 上现形过）：外壳**不会**在首条消息开张时收到 `session.state`，
 * 故 `view.sessionId` 一直是 `null`——`/clear` 那一跳在「会话身份真换了没换」这条判据下
 * **不算换会话**，屏不翻、「按了没反应」。而它**确实是**「清屏 ＋ 另起一条」。
 * 归约那侧为此多了一条「换页那一跳把 `null → 头一条` 也算上」（见 `reduceSessionState`），
 * 这一趟就是钉它：**空手开机按下 `/clear`，屏照样清**。
 *
 * 两帧：`12` 开机屏（字标在屏上）· `13` `/clear` 之后（**新那一页也是从字标起**）。
 *
 * ## ⚠️ U45 之后这一趟怎么判（换过三处锚，逐条说清）
 *
 * 这一格上「清」与「印」两件事**看得见的都是同一块字标**——开机那块被推进 scrollback，
 * 新那一页又印一块。故 U45 之前那句「屏上不再有 `█`」**不再是判据**（它是旧规则才成立的
 * 现象），换成**正面**两条：**整份缓冲里两块**（开机那块没丢 ＋ 新那块真印出来了）
 * 与**scrollback 读数涨上去了**（判「是推走、不是抹掉」的那把尺子，与别处同一个读法）。
 */
async function bootClear(): Promise<void> {
  const session = await createUiSession({
    label: 'u44-翻页-开局就清',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    const boot = await session.capture({ label: '12-开机屏' })
    keep(boot)
    check(boot.lines.some((line) => line.includes('█')), '12：开机屏上字标真在（不然「清掉了没有」无从判）')
    check(bannerCopies(boot) === 1, '12：开机那一块字标只印一份', `实际 ${bannerCopies(boot)} 块`)

    await typeLine(session, '/clear')
    await session.key('enter')
    // **等的是「新那一页也印出来了」**（整份缓冲里第二块字标）——不是「屏上没字标了」：
    // 这一格上屏上**一直**有字标（开机那块被推走、新那块又印），等不到「没有」。
    await waitScreen(
      session,
      '开机 /clear 之后整份缓冲里出现第二块字标',
      (screen) => countOn(screen.history, '█') >= 10,
      10_000,
    )

    const cleared = await session.capture({ label: '13-开局 clear 之后' })
    keep(cleared)

    checkPage(cleared, '13', {
      // 这一页也从字标起（U45）；「从空白页起铺」＝顶行是它、旧内容一行不压在上面
      top: bannerTop(cleared.columns),
      // ⚠️ 这一格**没有「切走那条的残留」可判**（空手开机、一个字都没落过账）——
      //    原来那句 `gone: ['█']` 是旧规则的现象，见本函数头注
      gone: [],
      kept: ['█'],
      before: boot,
    })
    check(
      bannerCopies(cleared) === 2,
      '两块字标：开机那块（进了 scrollback）＋ `/clear` 这一页新印的那块（U45）',
      `实际 ${bannerCopies(cleared)} 块`,
    )
    check(
      countOn(cleared.history, '█') >= 10,
      '开机那块字标**没被抹掉**（整份缓冲里它那五行还在——只是推到可见区上面去了）',
      `实际 ${countOn(cleared.history, '█')} 行`,
    )

    // 空闲**按两次**才走（U46）
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '开局那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 窄窗那一趟 ═══════════════════════════════════════════════════════

/** 46×30：同一个骨架，量「一样清得干净、一样留得住旧内容」。 */
async function narrow(): Promise<void> {
  const session = await createUiSession({
    label: 'u44-翻页-窄窗',
    columns: 46,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: 甲答 }, { kind: 'text', text: 乙答 }],
  })

  try {
    await session.wait({ text: IDLE_MARK }, { timeoutMs: 20_000 })

    await typeLine(session, 甲说)
    await session.key('enter', { until: { text: '列好了' }, timeoutMs: 20_000 })
    // ⚠️ 等**状态那一格**，不等右位那句键位提示：这一趟是 46 列的窄窗，而首条交代落账后
    //    状态行左位换成**真标题**，右位那句按既有口径让位（U50 起；由头见 `driver.ts` 的
    //    `IDLE_MARK`）。拿它当条件＝量窗口宽度，不是「它闲下来了没有」。
    await session.wait({ text: IDLE_MARK }, { timeoutMs: 15_000 })
    const full = await session.capture({ label: '08-窄窗有内容的一屏' })
    keep(full)

    await typeLine(session, '/clear')
    await session.key('enter')
    await waitUntil(session, '窄窗下 clear 之后屏上不再有切走那条', (lines) => countOn(lines, 甲说) === 0)
    const cleared = await session.capture({ label: '09-窄窗 clear 之后' })
    keep(cleared)

    checkPage(cleared, '09', {
      // 窄窗下同一副面孔：这一页也从字标起（46 列 ⇒ **一行版** `Magic Code`，见 `bannerTop`）
      top: bannerTop(cleared.columns),
      gone: [甲说],
      kept: [甲说],
      before: full,
    })
    check(bannerCopies(cleared) === 2, '窄窗下 `/clear` 那一页也印字标（共两块）', `实际 ${bannerCopies(cleared)} 块`)

    await typeLine(session, 乙说)
    await session.key('enter', { until: { text: '也列好了' }, timeoutMs: 20_000 })
    await session.wait({ text: IDLE_MARK }, { timeoutMs: 15_000 })
    const yi = await session.capture({ label: '10-窄窗乙落账' })
    keep(yi)

    await typeLine(session, '/resume')
    await session.key('enter')
    await session.wait({ text: '正在用' }, { timeoutMs: 10_000 })
    await session.key('up', { until: { text: '正在用' }, timeoutMs: 5_000 })
    await session.key('enter')
    await waitUntil(
      session,
      '窄窗下切回甲：回执与新页的记录同时在屏上',
      (lines) => countOn(lines, '已切到') >= 1 && countOn(lines, 甲说) >= 1,
    )
    const back = await session.capture({ label: '11-窄窗切回甲' })
    keep(back)

    checkPage(back, '11', {
      top: '· 已切到',
      gone: [乙说],
      kept: [乙说],
      before: yi,
    })
    check(
      back.lines.every((line) => [...line].length <= 46),
      '窄窗上没有一行超出宽度',
      `最长一行 ${Math.max(...back.lines.map((line) => [...line].length))} 列`,
    )

    // 空闲**按两次**才走（U46）
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '窄窗那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)

    const sync = flipsAreSynchronized(session.rawText())
    check(sync.total >= 2 && sync.loose === 0, '窄窗下翻页也在同步块里', `共 ${sync.total} 处 · 裸的 ${sync.loose} 处`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u44-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    await wide()
    await bootClear()
    await narrow()
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
