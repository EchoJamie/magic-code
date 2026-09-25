#!/usr/bin/env bun
/**
 * U75 · **`/resume` 切过去，记录铺得出来**——真 PTY 留帧与验收判据。
 *
 * ## 这一单是什么
 *
 * 用户真跑：`/resume` 切到一条 **93 条记录**的会话（`modu install`）⇒ 屏上只剩
 * `· 已切到 modu install` 与交互区，**一条记录都没有**。受控小记录（2 条）却铺得出来。
 *
 * 真因**不在**翻页、也不在记录读回来的次序上（工单里那条「翻页把记录推到上一页」是猜测）：
 * 是**连接那一层把消息写丢了**——`wire.ts` 的 `Link.send` 把整条 JSON 交给**一次**
 * `socket.write`，而 Bun 的 socket **一次只收得下发送缓冲装得下的那么多**、返回**真收下的
 * 字节数**（超出的一截不替你留着）。那个返回值原先没人看 ⇒ **消息一超过那个缓冲就少一截**：
 * 对面收到半行、按坏行丢掉，紧接着的字节也全错位。
 *
 * 于是量出的分水岭**不是记录的条数，是那条消息的字节数**：2 条的会话那条 `session.history`
 * 几百字节（过得去）；93 条、里面还夹着几十 KB 的工具结果（过不去）。
 *
 * ## 这一趟造的是**「几十条记录 ＋ 一条大到过不去的历史」**
 *
 * 一条大记录会话（甲）：一次交代让模型 `read` 一份 **48 KiB** 的材料（工具结果那条载荷就是
 * 几十 KB），再几十轮短交代把条目数堆到**五十条以上**（跨过 `HISTORY_CHUNK`，历史分两块推）。
 * 另一条小记录会话（乙）：一句交代一句回复——**与 U44 那一形同**。
 *
 * ## 三跳，每一跳都判「铺出来了没有」
 *
 * 甲 →（`/clear`）乙 →（`/resume`）甲 →（`/resume`）乙 →（`/resume`）甲
 *
 * 每一跳四件（判据与 `frames-u44-tui.ts` 的 `checkPage` 同源，另加这一单要的那两件）：
 * - **从空白页起铺**——切走那条的字**一行都不在可见屏上**（「一条都没铺出来」那一形里，
 *   旧那条还压在屏上）；
 * - **scrollback 涨了**——旧内容是被**推走**的，不是被抹掉（只看可见屏，两者长得一样）；
 * - **记录铺出来了**——这一页上**目标那条的记录**在（整份缓冲里逐句找得到）；
 * - **回执是新那一页的头一行**——`· 已切到 <名字>` 紧接着就是目标那条的**第一条记录**，
 *   且这一页**通篇没有**切走那条的字（`通读`那一项：一屏从上读到下，认得出是哪条会话的）。
 *
 * 外加两件：**`›` / `⏺` / 工具行都在**（三种行各有其一）与**小记录那一趟逐字不变**
 * （可见屏顶行就是回执——U44 原判据）。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u75-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { createUiSession, MAGIC_IDLE_MARK, startFixture } from './ui/index.ts'
import { createSandbox } from './ui/sandbox.ts'
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

/** 等屏上的某个**条件**成立（超时**如实失败**——不重发、不拿固定 sleep 当同步）。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6

  for (;;) {
    const { lines } = await session.screen()
    const text = lines.map((line) => line.text)

    if (ok(text)) return
    if (Bun.nanoseconds() > until) throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${text.join('\n')}`)

    await Bun.sleep(40)
  }
}

/** 这一页**通读**时认定的「界」——换会话那一行回执（设计：那一页的界由它承担）。 */
const TURN_MARK = '· 已切到 '

/**
 * 一屏「这一页铺好了没有」——四件，每一跳都过一遍。
 *
 * ⚠️ **「回执在头一行」量的是它在新那一页里的位置**（不是「在可见屏顶行」）：大记录那条
 * 会话的一页有几百行，比屏高得多，回执**必然**被顶进 scrollback（那是内联渲染的实情，
 * 谁也留不住它）。故判据落成**结构上那一件**：`history` 里那一行回执**紧接着就是**目标那条
 * 的第一条记录，且**它之后通篇只有目标那条的字**。
 */
function checkPage(
  shot: Capture,
  where: string,
  options: {
    /** 这一页该是哪条会话的（回执里那个名字）。 */
    readonly label: string
    /**
     * 目标那条的**第一条记录那一行**（带行首那个记号，如 `› 甲这一条：…`）——就在回执下一行。
     *
     * ⚠️ **必须带上记号**（`› ` / `⏺ `）：不带的话，**状态行**（`○ 空闲 · <标题> · …`）与
     * **回执自己**（`· 已切到 <标题>`）都含那串字（标题就是第一条交代的开头），
     * 于是「记录铺出来了」这一条会被它们**蒙过去**——反证那一趟实测栽在这儿：
     * 屏上一条记录都没有，那两条判据照样绿。带上记号，屏上那些行就没有一行对得上。
     */
    readonly first: string
    /** 可见屏上**不许**再有这些字（切走那条的残留）。 */
    readonly gone: readonly string[]
    /** 切走那条的东西——翻过页之后**必须在整份缓冲里还找得到**。 */
    readonly kept: readonly string[]
    /** 翻页之前那一帧——`scrollback` 读数要比它**大**。 */
    readonly before: Capture
  },
): void {
  // ① 从空白页起铺：切走那条的字**一行都不在可见屏上**
  for (const needle of options.gone) {
    check(
      countOn(shot.lines, needle) === 0,
      `${where}：切走那条的「${needle}」**一行都不在可见屏上**`,
      `实际 ${countOn(shot.lines, needle)} 行`,
    )
  }

  // ② **scrollback 还在**（判「是推走、不是抹掉」的正面证据——只看可见屏，两者长得一样）
  const pushed = shot.scrollback - options.before.scrollback
  check(
    pushed > 0,
    `${where}：**scrollback 读数涨上去了**（旧内容被推进存档区，不是被抹掉）`,
    `切之前 ${options.before.scrollback} 行 → 切之后 ${shot.scrollback} 行`,
  )
  for (const needle of options.kept) {
    check(
      countOn(shot.history, needle) >= 1,
      `${where}：切走那条的「${needle}」**在整份缓冲里还找得到**`,
      `实际 ${countOn(shot.history, needle)} 行`,
    )
  }

  // ③ **记录铺出来了**——**这一条是这一单的判据**，故排在「回执落在哪」之前
  //    （反证那一趟要红就得红在这一句上：报「回执没落在头一行」是把话说了，但说的是下一层）。
  //
  // ⚠️ **认的是「带行首记号的那一行」**（`options.first` 给的是 `› 甲这一条：…`），
  //    且**从回执的下一行走起**（`slice(at + 1)`）：这一页的**状态行**（`○ 空闲 · <标题> · …`）
  //    与**回执自己**（`· 已切到 <标题>`）都含标题那一串（标题就是第一条交代的开头），
  //    不带上记号、不绕开回执那一行的话，这一条会被它们**蒙过去**——反证那一趟实测栽在这儿：
  //    屏上一条记录都没有，判据照样绿。
  const at = shot.history.findLastIndex((line) => line.includes(TURN_MARK))
  const records = at === -1 ? shot.history : shot.history.slice(at + 1)
  check(countOn(records, options.first) >= 1, `${where}：目标会话的记录**照常铺出来**（不是被吞掉）`)

  // ④ **回执是这一页的头一行**——紧接着就是目标那条的第一条记录
  check(at !== -1, `${where}：这一跳**说了话**（\`${TURN_MARK}<名字>\` 那一行在）`)
  if (at === -1) return

  check(
    shot.history[at]?.includes(options.label) === true,
    `${where}：回执说的是**目标那条的名字**（\`${options.label}\`）`,
    `实际那一行＝「${shot.history[at] ?? ''}」`,
  )
  check(
    shot.history.slice(at + 1, at + 8).some((line) => line.includes(options.first)),
    `${where}：回执**是新那一页的头一行**（紧接着就是它的第一条记录「${options.first}」）`,
    `回执往下八行＝${JSON.stringify(shot.history.slice(at + 1, at + 8).map((l) => l.trim()))}`,
  )

  // 通读那一项：这一页（含回执）通篇只有目标那条的字
  const page = shot.history.slice(at)
  for (const needle of options.gone) {
    check(
      countOn(page, needle) === 0,
      `${where}：**这一页通篇**没有切走那条的字（「${needle}」）`,
      `实际 ${countOn(page, needle)} 行`,
    )
  }

  // ⑤ 三种行都在（`›` 我的交代 · `⏺` 它的回复 · `●` 工具）
  check(countOn(records, '› ') >= 1, `${where}：**用户那一行**（\`› \`）在记录里`)
  check(countOn(records, '⏺ ') >= 1, `${where}：**助手那一行**（\`⏺ \`）在记录里`)
}

/** 本条会话那几句交代／回复——用来认「屏上这一条是谁」。 */
const 甲说 = '甲这一条：先看看有什么'
const 甲料 = '这一份材料很长，长到那条历史一次送不过去。'
const 乙说 = '乙这一条：换个方向'
const 乙答 = '乙答：列好了。'

/** 甲那一页上该有的第一句交代——判「回执下面紧接着的就是它」。 */
const 甲头 = 甲说

/** 甲这一类交代一共几轮（每轮 2 条：我说的 ＋ 它回的）——堆到**六十条以上**。 */
const 甲轮数 = 30

/** 甲那一页的**尾巴**（最后一句回复）——判「这一页铺到这儿了」。 */
const 甲尾 = `甲答第${甲轮数}句`

/**
 * `/resume` 切到**筛词指名的那一条**——开列表、打字筛、选定，等到「这一页成了」为止。
 *
 * ⚠️ **等的条件按「这一页铺成了什么样」给**，不按「回执在不在可见屏上」给：大记录那一页
 * 有几百行，回执与新页的头几条**必然**在 scrollback 里（见 `checkPage` 的注），拿它当条件
 * 会白等到超时——而那种超时会**误判成「没铺出来」**（正是这一单要分开的那两件事）。
 */
async function switchTo(
  session: UiSession,
  query: string,
  settled: (lines: readonly string[]) => boolean,
): Promise<void> {
  await session.send('/resume')
  await session.key('enter', { until: { text: '正在用' }, timeoutMs: 10_000 })
  await session.send(query)
  await Bun.sleep(400)
  await session.key('enter')

  // ⚠️ **超时在这儿不判**（U75 返修）：这一跳等的是「这一页铺成了什么样」，而**没铺出来
  //    正是这一单要证的那一件**——在这儿抛，报出去的是一句「等超时了」，比判据该说的那句
  //    「目标会话的记录没铺出来」含糊得多（反证那一趟要的正是后一句）。故等不到就等不到，
  //    照一张帧交给下面那几处 `checkPage` 判。
  try {
    await waitUntil(session, `切到「${query}」`, settled, 25_000)
  } catch (error) {
    console.log(`  ⚠ ${(error as Error).message.split('\n')[0]}`)
  }

  await Bun.sleep(600)
}

/** 大材料那份文件的名字（写在沙地工作区里，模型用 `read` 去读）。 */
const 大材料 = '大材料.txt'

/** 这一份材料的体量——**要大到那条历史一次送不过去**（真因量的是字节，不是条数）。 */
const 材料行数 = 400

/**
 * 造大材料——**几十 KB 一个文件**。
 *
 * 由头：这一单的分水岭是**消息的字节数**（见文件头注），故「大记录」那一形不能只堆条数，
 * 还得有一条**真·大的载荷**。走的是既有的 `read` 工具（模型自己读），不是往库里塞东西。
 */
function writeBigMaterial(workspace: string): void {
  const body = Array.from(
    { length: 材料行数 },
    (_, i) => `${String(i + 1).padStart(3, '0')} ｜${甲料}${'材料正文'.repeat(4)}`,
  ).join('\n')

  writeFileSync(join(workspace, 大材料), `${body}\n`, 'utf8')
}

/**
 * 这一趟的剧本——**一条 `read` ＋ 几十轮短交代 ＋ 收尾那句 `乙答`**（见文件头注）。
 *
 * 最后那一回合留给乙（`/clear` 之后那条会话的第一句，用的就是它）。
 */
function turnsOf(): readonly FixtureTurn[] {
  const 甲答 = Array.from({ length: 甲轮数 }, (_, i) => ({
    kind: 'text' as const,
    text: `甲答第${i + 1}句`,
    chunks: 1,
    chunkDelayMs: 0,
  }))

  return [
    { kind: 'tool', name: 'read', args: { path: 大材料 } },
    ...甲答,
    { kind: 'text', text: 乙答, chunks: 1, chunkDelayMs: 0 },
  ]
}

async function main(): Promise<void> {
  const fixture = startFixture({ turns: turnsOf() })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  writeBigMaterial(sandbox.workspace)

  const session = await createUiSession({
    label: 'u75-resume铺记录',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    sandbox,
    fixture,
  })

  try {
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

    // —— 甲：一条 `read` ＋ 几十轮短交代（条目数堆到五十条以上）——
    await typeLine(session, 甲说)
    await session.key('enter')

    // ⚠️ **判据换过（U87）**——**换的不是「该咬什么」，是「拿什么证」**。
    //
    //   这一支原先在这里等**一张 `read` 的裁决卡**（`y 批准`）再拨 `a`「本工作区总是允许」
    //   ——那是 U76 之前的产品行为：链的底是「默认问」，读也要过一道闸。
    //   **U76 起判轻的调用默认通、不问**（`gate.ts`：`weight === 'light'` 直接自动放行），
    //   那张卡**根本不会出现** ⇒ 那一步永远等不到（本单基线实测：20 秒超时）。
    //
    //   **它要证的那件事一个字没变：那一趟读**确实发生了**（不是被闸挡住、也没有静默跳过）
    //   ——**否则这一单要造的那条大记录根本造不出来**。今天这件事的证据换成了工具自己：
    //   **跑完了那一行（`● read …`）在屏上**——`⟳` 是「刚开跑」，`●` 是「跑完了」，
    //   被卡在裁决上时停在 `⟳`（旧那一版实测如此）。
    //
    //   ⚠️ **等的是「两者之一先出现」，超时在这儿不判**（同本文件 `switchTo` 那条的由头）：
    //   这一步等的是「那一趟读跑起来了没有」，而**没跑起来、卡在裁决上**正是旧那一版的样子
    //   ——在这儿抛，报出去的是一句「等超时了」，比判据该说的那句含糊得多。
    //   故谁先到就取那一帧，下面两条判据管的正是「**是哪一种**」。
    try {
      await waitUntil(
        session,
        '那一趟读跑完 或 裁决卡',
        (lines) => countOn(lines, '● read') >= 1 || countOn(lines, 'y 批准') >= 1,
      )
    } catch (error) {
      console.log(`  ⚠ ${(error as Error).message.split('\n')[0]}`)
    }

    const 读那一趟 = await session.capture({ label: '00-那一趟读（不弹卡）' })
    keep(读那一趟)
    check(countOn(读那一趟.lines, '● read') >= 1, '那一趟 `read` **真跑下去了**（跑完了那一行在——不是被卡在裁决上）')
    check(countOn(读那一趟.lines, 'y 批准') === 0, '**没有裁决卡**（U76：读判轻、默认通、不问）')
    await session.wait({ text: `甲答第1句` }, { timeoutMs: 30_000 })
    for (let i = 2; i <= 甲轮数; i += 1) {
      await typeLine(session, `甲说第${i}句`)
      await session.key('enter', { until: { text: `甲答第${i}句` }, timeoutMs: 20_000 })
    }
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    const 甲页 = await session.capture({ label: '01-甲那一页（大记录）' })
    keep(甲页)

    // —— ① `/clear` → 乙：另起一条（小记录那条）——
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitUntil(session, '`/clear` 之后屏上不再有甲那一句', (lines) =>
      countOn(lines, '甲答第1句') === 0,
    )
    await typeLine(session, 乙说)
    await session.key('enter', { until: { text: 乙答 }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    const 乙页 = await session.capture({ label: '02-乙那一页（小记录）' })
    keep(乙页)

    // —— ② `/resume` 切回甲：**这一跳就是这一单要的那一件** ——
    await switchTo(session, '甲这一条', (lines) => countOn(lines, 乙说) === 0 && countOn(lines, 甲尾) >= 1)
    await Bun.sleep(1500)
    const 回甲 = await session.capture({ label: '03-切回甲（大记录铺出来了）' })
    keep(回甲)

    checkPage(回甲, '03', {
      label: 甲说,
      first: `› ${甲头}`,
      gone: [乙说, 乙答],
      kept: [乙说, 乙答],
      before: 乙页,
    })
    check(
      countOn(回甲.history.slice(回甲.history.findLastIndex((l) => l.includes(TURN_MARK))), '甲答第1句') >= 1,
      '03：甲那条**几十轮记录都在**（不是只铺出最后几条）',
    )
    check(
      countOn(回甲.history, '● read') >= 1 && countOn(回甲.history, '大材料') >= 1,
      '03：**工具那一行**也在（那一次 `read` 连同它的参数）',
    )

    // —— ③ `/resume` 切回乙：小记录那一趟，逐字不变（U44 原判据）——
    await switchTo(session, '乙这一条', (lines) => countOn(lines, TURN_MARK) >= 1 && countOn(lines, 乙答) >= 1)
    await Bun.sleep(1000)
    const 回乙 = await session.capture({ label: '04-切回乙（小记录）' })
    keep(回乙)

    checkPage(回乙, '04', {
      label: 乙说,
      first: `› ${乙说}`,
      gone: [甲说, '甲答第1句'],
      kept: [甲说],
      before: 回甲,
    })
    const 顶行 = 回乙.lines.find((line) => line.trim() !== '') ?? ''
    check(
      顶行.includes(TURN_MARK),
      '04：小记录那一趟**可见屏顶行就是回执**（U44 原判据，一字不变）',
      `实际顶行＝「${顶行}」`,
    )
    check(countOn(回乙.lines, 乙说) >= 1, '04：乙那一页的记录在（与 U44 那一形同）')

    // —— ④ 再切回甲：来回两趟，每趟都看得见界 ——
    await switchTo(session, '甲这一条', (lines) => countOn(lines, 乙说) === 0 && countOn(lines, 甲尾) >= 1)
    await Bun.sleep(1500)
    const 再回甲 = await session.capture({ label: '05-再切回甲（来回第二趟）' })
    keep(再回甲)

    checkPage(再回甲, '05', {
      label: 甲说,
      first: `› ${甲头}`,
      gone: [乙说, 乙答],
      kept: [乙说, 乙答],
      before: 回乙,
    })
    check(countOn(再回甲.history.slice(再回甲.history.findLastIndex((l) => l.includes(TURN_MARK))), '● read') >= 1, '05：这一趟**工具行也在**')

    await session.quit()
    const report = await session.close({ graceMs: 3_000, keepSandbox: true })
    check(report.exit.by === 'app', '应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)

    // —— 收尾：拿库里的真账核一遍「这一趟是不是真造出了那一形」——
    //
    // ⚠️ **这一条是这一趟的立足点**：这一单的分水岭是**消息的字节数**（见文件头注）。
    //    历史里没有一条**大到过不去**的载荷时，这一趟就退化成「小记录那一趟」——
    //    判据全绿而**什么都没验到**（第一版复现正是这么栽的：47 轮短交代才 ~10 KB，
    //    一样能过去）。故把「那一条够大」写成判据，红了当场看得见。
    const store = createRecordsStore({ dataDir: sandbox.dataDir, workspace: [sandbox.workspace] })
    const catalog = await store.listSessions()
    // 默认标题**不落库**（`store.ts` 的注：由对话域现算），故按条目数认哪条是甲
    let 大条 = 0
    let 小条 = Number.POSITIVE_INFINITY
    let 总条 = 0
    let 最大载荷 = 0

    for (const row of catalog) {
      let n = 0
      for await (const entry of store.readEntries(row.id)) {
        n += 1
        // ⚠️ **量字节**（不是字符）：线上走的是 UTF-8，一个汉字三个字节——按字符量会把
        //    「已经过不去的那一条」读小一半以上（这一单的真因量的就是字节）
        for (const text of textsOf(entry)) 最大载荷 = Math.max(最大载荷, Buffer.byteLength(text))
      }
      大条 = Math.max(大条, n)
      小条 = Math.min(小条, n)
      总条 += n
      console.log(`  会话 ${row.id.slice(0, 8)} 「${row.title ?? '（默认标题，不落库）'}」：${n} 条`)
    }
    store.close()

    check(catalog.length === 2, `这一趟是**两条会话**（甲乙各一；实际 ${catalog.length} 条）`)
    check(小条 === 2, `乙那条**就两条**（与 U44 那一形同；实际 ${小条} 条）`)
    check(总条 > 0, '收尾：这一趟真落了账（拿库里的真账核的）')
    check(大条 >= 50, `甲那条**五十条以上**（几十条记录那一形；实际 ${大条} 条）`)
    check(
      最大载荷 >= 32 * 1024,
      '甲那条里**有一条大到过不去**的载荷（≥32 KiB——真因量的是字节，不是条数）',
      `实际最大载荷 ${最大载荷} 字节`,
    )

    sandbox.dispose()
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } catch (error) {
    await session.close({ graceMs: 1_000, keepSandbox: true })
    sandbox.dispose()
    throw error
  } finally {
    await fixture.stop()
  }
}

/** 一条条目里的正文（几处存放点都看一眼——判「那一条有多大」只需一个上界）。 */
function textsOf(entry: { readonly content?: unknown; readonly payload?: unknown }): readonly string[] {
  const found: string[] = []

  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const one of value) walk(one)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const one of Object.values(value)) walk(one)
    }
  }

  walk([entry.content, entry.payload])
  return found
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u75-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    await main()
  } finally {
    if (at === -1) removeDir(root)
  }
}
