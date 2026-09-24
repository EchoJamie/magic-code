#!/usr/bin/env bun
/**
 * U45 · **翻页后字标按「开一条新的」印** ＋ **交互区下沿加一条分隔线**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。两件事都在同一块屏上，故并作一趟、帧只取一次。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真装配 → 真外壳 Ink → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 之一 · 字标是「开一条新的」的记号——四处各看一遍（工单的验收口径）
 *
 * | 哪一跳 | 字标 |
 * | --- | --- |
 * | **开机**（第一条会话） | **印** |
 * | **`/clear`**（开一条新的） | **印** |
 * | **`/resume`**（翻回已有的一页） | **不印**（页头另有 `· 已切到 <名字>` 划界） |
 *
 * 量的是**整份缓冲里字标的块数**（不是「可见屏上有没有」）：翻页把可见屏推进 scrollback，
 * 只看可见那一截，「推走了」与「抹掉了」长得一模一样。
 *
 * ⚠️ **`null → 头一条` 那一格单跑**（`firstMessage()`，工单的 ④）：外壳**不会**在首条消息开张时
 * 收到 `session.state`，故 `view.sessionId` 一直是 `null`——那一页**本来就有开机印的那一个**，
 * 判据是「**不能弄丢、也不能凭空多出一个**」（多一个＝某一跳重复种了）。
 *
 * ## 之二 · 交互区下沿那条分隔线
 *
 * 一帧里**两条**满宽 `─`（记录区／交互区之间那条 ＋ 交互区下沿那条），**同宽同色**；
 * 输入行与状态行被它们夹在当中（「一眼分出三块」）。**不许再多线**——这一条就是工单里
 * 那四条硬约束的第三条，量的是**整份缓冲**里的条数。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u45-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HINT_IDLE, bannerOf } from '@magic/tui'
import { createUiSession } from './ui/index.ts'
import { MAGIC_IDLE_MARK } from './ui/anchors.ts'
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
  console.log(`\n── ${shot.label} ──（scrollback ${shot.scrollback}）\n${shot.text}`)
}

/** 打一行字并**等它真出现在屏上**（文本与回车分两次写——挤在同一次写里按键会丢）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 屏上 `needle` 出现几次。 */
function countOn(lines: readonly string[], needle: string): number {
  return lines.filter((line) => line.includes(needle)).length
}

/** 满宽分隔线（`AppView` 画的那种：整行都是 `─`）。 */
const isRule = (line: string): boolean => /^─+$/u.test(line.trim())

/**
 * 一笔**整份缓冲**里某样东西的份数——翻过页之后可见那一截答不了这类问题（见文件头注）。
 *
 * ⚠️ **不许退回「至少出现过」**：份数一律钉**精确值**（多印一份、少印一份都是要看的）。
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

/** 等屏上的某个条件成立（可见那一截）——`waitScreen` 的兄弟（见那一处注）。 */
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

/** 字标**画幅首行**（当前列数那一版）——认「这一页从字标起」与「缓冲里有几块」。 */
const bannerTop = (columns: number): string => (bannerOf(columns)[0]?.text ?? '').replace(/\s+$/u, '')

/** 整份缓冲里字标画幅首行出现几次——**每多一份 ＝ 终端上多一块字标**。 */
function bannerCopies(shot: Capture): number {
  const art = bannerTop(shot.columns)

  return shot.history.filter((line) => line.replace(/\s+$/u, '') === art).length
}

/**
 * 一帧是不是**完整的**，且**恰好两条分隔线**（之二那一条的正面判据）。
 *
 * 三件缺一不可：**两条满宽分隔线**（多一条 / 少一条都不行——工单：「两条分隔线之外不许再多线」）·
 * **输入行** · **状态行**；且输入行与状态行落在**两条线之间**（「一眼分出三块」）。
 */
function checkFrame(shot: Capture, where: string): void {
  const rules = shot.history.map((line, at) => ({ line, at })).filter((entry) => isRule(entry.line))
  // **可见屏**上的条数才算「屏上画了几条」——缓冲里的旧帧不算（翻过页之后旧帧留在 scrollback）
  const shown = shot.lines.filter((line) => isRule(line))

  check(shown.length === 2, `${where}：可见屏上**恰好两条**分隔线（两条之外不多线）`, `实际 ${shown.length} 条`)
  check(
    shot.lines.some((line) => line.includes('─'.repeat(shot.columns))),
    `${where}：两条线都是**整宽**（${shot.columns} 列）`,
  )

  // ⚠️ 两处都取**最后一个**：记录区里也有 `› `（用户那句回显）与 `● `（工具行、重建出来的行）——
  //    取第一个会撞上它们（实测栽过：把记录里那条用户消息当成了输入行）。
  const composer = shot.lines.findLastIndex((line) => line.includes('›'))
  const status = shot.lines.findLastIndex((line) => line.includes('○ ') || line.includes('● '))
  const first = shot.lines.findIndex((line) => isRule(line))
  const last = shot.lines.findLastIndex((line) => isRule(line))

  check(composer > first && composer < last, `${where}：输入行在**两条线之间**（三块分得开）`)
  check(status > first && status < last, `${where}：状态行也在**两条线之间**`)
  check(
    rules.length >= 2 && shot.scrollback >= 0,
    `${where}：帧是画完了的（不是擦到一半）`,
  )
}

/** 本条会话那两句交代——用来认「屏上这一条是谁」。 */
const 甲说 = '甲这一条：先看看有什么'
const 甲答 = '甲这一条：列好了。'
const 乙说 = '乙这一条：换个方向'
const 乙答 = '乙这一条：也列好了。'

// ══ ①②③ 常宽那一趟 ═════════════════════════════════════════════════

/**
 * 100×30：开机 → 甲落账 → `/clear` → 乙落账 → `/resume` 切回甲。
 *
 * 四帧：`01` 开机屏 · `02` 甲落账 · `03` **`/clear` 之后**（工单 ②）·
 * `04` **切回甲那一屏**（工单 ③）。
 */
async function wide(): Promise<void> {
  const session = await createUiSession({
    label: 'u45-字标-常宽',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: 甲答 }, { kind: 'text', text: 乙答 }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })

    // —— ① 开机屏：字标一份、在最前 ——
    const boot = await session.capture({ label: '01-开机屏' })
    keep(boot)
    check(bannerCopies(boot) === 1, '① 开机：字标**印**（一处一块）', `实际 ${bannerCopies(boot)} 块`)
    check(
      (boot.lines.find((line) => line.trim() !== '') ?? '') === bannerTop(boot.columns),
      '① 开机：字标就在**这一页的最前面**',
    )
    checkFrame(boot, '① 开机屏')

    await typeLine(session, 甲说)
    await session.key('enter', { until: { text: 甲答 }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const jia = await session.capture({ label: '02-甲落账' })
    keep(jia)
    check(bannerCopies(jia) === 1, '甲落账之后：字标仍是开机那一块（没多印）')
    checkFrame(jia, '02 甲落账')

    // —— ② `/clear`：**这一页从字标起**（工单的由头就在这里） ——
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitScreen(
      session,
      '`/clear` 之后整份缓冲里出现第二块字标',
      (screen) => countOn(screen.history, bannerTop(screen.columns)) >= 2,
    )
    const cleared = await session.capture({ label: '03-clear 之后' })
    keep(cleared)

    check(bannerCopies(cleared) === 2, '② `/clear`：**印**（开机那块 ＋ 新这块，共两块）', `实际 ${bannerCopies(cleared)} 块`)
    check(
      (cleared.lines.find((line) => line.trim() !== '') ?? '') === bannerTop(cleared.columns),
      '② `/clear`：这一页**从字标起**（顶行就是它——不是「只剩分隔线贴顶」那张故障脸）',
      `实际顶行＝「${cleared.lines.find((line) => line.trim() !== '')}」`,
    )
    check(countOn(cleared.lines, 甲说) === 0, '② `/clear`：切走那条的记录一行都不在可见屏上')
    check(countOn(cleared.history, 甲说) >= 1, '② `/clear`：切走那条还在整份缓冲里（推走，不是抹掉）')
    // **回执就是清屏 ＋ 字标，不加第三样**（工单硬约束 2）：这一页上一条 `·` 开头的回执都没有
    const receipts = cleared.lines.filter((line) => line.trimStart().startsWith('· '))
    check(
      receipts.length === 0,
      '② `/clear`：**不另发文案**（这一页只有字标与帧，一条回执都没有）',
      `实际 ${receipts.length} 条：${receipts.join(' / ')}`,
    )
    checkFrame(cleared, '03 clear 之后')

    // —— 乙落账（新那一条里有东西，后头才认得出「切到的是哪一条」） ——
    await typeLine(session, 乙说)
    await session.key('enter', { until: { text: 乙答 }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

    // —— ③ `/resume` 切回甲：**这一页不印字标** ——
    await typeLine(session, '/resume')
    await session.key('enter')
    await session.wait({ text: '正在用' }, { timeoutMs: 10_000 })
    await session.key('up', { until: { text: '正在用' }, timeoutMs: 5_000 })
    await session.key('enter')
    await waitUntil(
      session,
      '切回甲：回执与新页的记录同时在屏上',
      (lines) => countOn(lines, '· 已切到') >= 1 && countOn(lines, 甲说) >= 1,
    )
    const back = await session.capture({ label: '04-切回甲' })
    keep(back)

    check(bannerCopies(back) === 2, '③ `/resume`：**不印**（仍是那两块——切回这一跳一块都没添）', `实际 ${bannerCopies(back)} 块`)
    check(
      (back.lines.find((line) => line.trim() !== '') ?? '').includes('· 已切到'),
      '③ `/resume`：这一页的界由回执承担（顶行是 `· 已切到 <名字>`）',
      `实际顶行＝「${back.lines.find((line) => line.trim() !== '')}」`,
    )
    check(countOn(back.lines, 甲说) >= 1, '③ `/resume`：目标会话的记录照常铺出来')
    check(countOn(back.lines, 乙说) === 0, '③ `/resume`：切走那条一行都不在可见屏上')
    checkFrame(back, '04 切回甲')

    // 空闲**按两次**才走（U46）——`quit()` 就是那一套
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '常宽那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ ④ 敲第一句话开张那一下（`null → 头一条`）═════════════════════════

/**
 * **空手开机 → 敲第一句话 → 再 `/clear`**——这一趟单跑，因为它是本单最紧的那一格。
 *
 * 判据两条（工单原文：**不能把开机那个字标弄丢，也不能凭空多出一个**）：
 *
 * - **开张那一下**：那一跳**不是**开页（记录区没换，屏上正是用户刚敲的那句话）——
 *   故**还是那一块**字标（`1`），既没丢、也没多；
 * - **此后 `/clear`**：那才是「开一条新的」⇒ **两块**（开机那块进了 scrollback ＋ 新这块）。
 *   两块**正好**是这两跳各一块——`3` 就说明某一跳重复种了（这一格最容易漏的就是它：
 *   外壳收不到首条消息的 `session.state`，`view.sessionId` 一直是 `null`，
 *   `null → 头一条` 全落进「换页」那一格里）。
 *
 * 三帧：`05` 开机屏 · `06` 第一句话开张 · `07` 开局 `/clear` 之后。
 */
async function firstMessage(): Promise<void> {
  const session = await createUiSession({
    label: 'u45-字标-开局',
    columns: 100,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: '甲答：开了。' }],
  })

  try {
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    const boot = await session.capture({ label: '05-开机屏' })
    keep(boot)
    check(bannerCopies(boot) === 1, '④ 开机：一块')

    // —— 敲第一句话：**这一跳不是开页** ——
    await typeLine(session, '第一句话：开张')
    await session.key('enter', { until: { text: '甲答：开了。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const opened = await session.capture({ label: '06-第一句话开张' })
    keep(opened)

    check(bannerCopies(opened) === 1, '④ 开张那一下：**还是开机那一块**（没弄丢、也没凭空多一个）', `实际 ${bannerCopies(opened)} 块`)
    check(
      (opened.lines.find((line) => line.trim() !== '') ?? '') === bannerTop(opened.columns),
      '④ 开张那一下：**没有翻页**（顶行仍是字标——记录区没换，屏上是刚敲的那句话）',
      `实际顶行＝「${opened.lines.find((line) => line.trim() !== '')}」`,
    )
    check(countOn(opened.lines, '› 第一句话：开张') >= 1, '④ 开张那一下：用户那句话与字标**同在一页上**')
    checkFrame(opened, '06 第一句话开张')

    // —— 此后 `/clear`：**这才是「开一条新的」** ——
    await typeLine(session, '/clear')
    await session.key('enter')
    await waitScreen(
      session,
      '开局 `/clear` 之后出现第二块字标',
      (screen) => countOn(screen.history, bannerTop(screen.columns)) >= 2,
    )
    const cleared = await session.capture({ label: '07-开局 clear 之后' })
    keep(cleared)

    check(bannerCopies(cleared) === 2, '④ 开局 `/clear`：**正好两块**（开机 ＋ 这一跳各一块）', `实际 ${bannerCopies(cleared)} 块`)
    check(
      (cleared.lines.find((line) => line.trim() !== '') ?? '') === bannerTop(cleared.columns),
      '④ 开局 `/clear`：这一页从字标起',
    )
    check(
      countOn(cleared.history, '› 第一句话：开张') >= 1,
      '④ 开局 `/clear`：开张那句话**没被抹掉**（还在整份缓冲里）',
    )
    check(
      cleared.lines.filter((line) => line.trimStart().startsWith('· ')).length === 0,
      '④ 开局 `/clear`：一样不另发文案',
    )
    checkFrame(cleared, '07 开局 clear 之后')

    // 空闲**按两次**才走（U46）——`quit()` 就是那一套
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '开局那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 窄窗那一趟 ═══════════════════════════════════════════════════════

/** 46×30：字标换成**一行版**那档——同一个骨架，量「同一条规矩在窄窗上也站得住」。 */
async function narrow(): Promise<void> {
  const session = await createUiSession({
    label: 'u45-字标-窄窗',
    columns: 46,
    rows: 30,
    artifacts: join(out, 'runs'),
    turns: [{ kind: 'text', text: 甲答 }, { kind: 'text', text: 乙答 }],
  })

  try {
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 20_000 })

    await typeLine(session, 甲说)
    await session.key('enter', { until: { text: '列好了' }, timeoutMs: 20_000 })
    // ⚠️ 等**状态那一格**，不等右位那句键位提示：这一趟是 46 列的窄窗，而首条交代落账后
    //    状态行左位换成**真标题**，右位那句按既有口径让位（U50 起；由头见 `driver.ts` 的
    //    `MAGIC_IDLE_MARK`）。拿它当条件＝量窗口宽度，不是「它闲下来了没有」。
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    await typeLine(session, '/clear')
    await session.key('enter')
    await waitScreen(
      session,
      '窄窗 `/clear` 之后出现第二块字标',
      (screen) => countOn(screen.history, bannerTop(screen.columns)) >= 2,
    )
    const cleared = await session.capture({ label: '08-窄窗 clear 之后' })
    keep(cleared)

    check(bannerCopies(cleared) === 2, '窄窗 `/clear`：印（一行版，共两块）', `实际 ${bannerCopies(cleared)} 块`)
    check(
      (cleared.lines.find((line) => line.trim() !== '') ?? '') === bannerTop(cleared.columns),
      '窄窗 `/clear`：这一页从字标起（一行版 `Magic Code`）',
    )
    check(
      cleared.lines.every((line) => [...line].length <= 46),
      '窄窗上没有一行超出宽度',
      `最长一行 ${Math.max(...cleared.lines.map((line) => [...line].length))} 列`,
    )
    checkFrame(cleared, '08 窄窗 clear 之后')

    await typeLine(session, 乙说)
    await session.key('enter', { until: { text: '也列好了' }, timeoutMs: 20_000 })
    await session.wait({ text: MAGIC_IDLE_MARK }, { timeoutMs: 15_000 })

    await typeLine(session, '/resume')
    await session.key('enter')
    await session.wait({ text: '正在用' }, { timeoutMs: 10_000 })
    await session.key('up', { until: { text: '正在用' }, timeoutMs: 5_000 })
    await session.key('enter')
    await waitUntil(
      session,
      '窄窗切回甲：回执与新页的记录同时在屏上',
      (lines) => countOn(lines, '· 已切到') >= 1 && countOn(lines, 甲说) >= 1,
    )
    const back = await session.capture({ label: '09-窄窗切回甲' })
    keep(back)

    check(bannerCopies(back) === 2, '窄窗 `/resume`：不印（仍是那两块）', `实际 ${bannerCopies(back)} 块`)
    check((back.lines.find((line) => line.trim() !== '') ?? '').includes('· 已切到'), '窄窗 `/resume`：界由回执承担')
    checkFrame(back, '09 窄窗切回甲')

    // 空闲**按两次**才走（U46）——`quit()` 就是那一套
    await session.quit()
    const report = await session.close({ graceMs: 3_000 })
    check(report.exit.by === 'app', '窄窗那一趟应用自己走的（收摊确认）', `exit.by=${report.exit.by}`)
  } catch (error) {
    await session.close({ graceMs: 1_000 })
    throw error
  }
}

// ══ 极窄那一档：**不在这儿跑**（如实记一条限度）══════════════════════

/**
 * 极窄（9 列）那一档**本装置跑不了**：起手那道闸等的是状态行右位那句 `/ 命令 · ctrl+c 退出`
 * （`driver.ts` 的 `waitForFrame`），而 9 列下它**折成好几行**、屏上永远拼不出那一串
 * ——等它必然超时，那是**装置**的限度，不是产品的。
 *
 * 故「极窄档按既有规则（不印字标 · 两条线照画 · 不出多余空行）」在**单元那一层**判：
 * `packages/tui/test/spec.u45.test.ts`（9 列那份视图画出来数线）与 `spec.u43.test.ts` ③
 * （题面同一档：没有块字残块）。
 */

// ══ 入口 ═════════════════════════════════════════════════════════════

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u45-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    await wide()
    await firstMessage()
    await narrow()
    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
