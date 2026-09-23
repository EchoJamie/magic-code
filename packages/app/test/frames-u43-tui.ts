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
 * 甲落账 → `/session new` → 乙落账 → `/session` 选回甲。三屏各留一帧：
 * **① 开机屏 · ② 换回甲那一屏 · ③ 再切到乙那一屏**（常宽 100×30 一趟，窄窗 46×30 一趟）。
 *
 * 每屏上判四件：**字标只有一份**（且在最前） · **回执在**（这一屏的界） ·
 * **目标会话的记录铺出来了** · **没有残块**。
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

/** 四件「这一屏长什么样」的判据——每留一帧都过一遍（少判一屏就是空转）。 */
function checkScreen(shot: Capture, where: string, laidOut: string): void {
  const first = shot.lines.find((line) => line.trim() !== '') ?? ''
  const art = (bannerOf(shot.columns)[0]?.text ?? '').replace(/\s+$/u, '')

  check(bannerCopies(shot) === 1, `${where}：**字标只有一份**`, `实际 ${bannerCopies(shot)} 份`)
  check(first.replace(/\s+$/u, '') === art, `${where}：它就在最前面（记录区顶行）`, `顶行＝「${first}」`)
  check(countOn(shot.history, '· 已切到') >= 1, `${where}：回执在——这一屏的界由它承担`)
  check(countOn(shot.history, laidOut) >= 1, `${where}：目标会话的记录铺出来了（${laidOut}）`)
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
 * 常宽那一趟：甲落账 → `/session new` → 乙落账 → `/session` 选回甲 → 再切到乙。
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
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const jia = await session.capture({ label: '02-甲落账' })
    keep(jia)
    check(bannerCopies(jia) === 1, '甲落账之后：仍只有开机那一份字标')

    // —— `/session new`：切到一条**空会话**（此后不再种字标——本单要改的就是这一下） ——
    await typeLine(session, '/session new')
    await session.key('enter')
    // 等这一下**被吃下**（草稿清空）再取帧——不能在按键写出去的那一刻取
    await session.wait({ absent: '/session new' }, { timeoutMs: 10_000 })
    const fresh = await session.capture({ label: '03-切到空会话' })
    keep(fresh)
    check(bannerCopies(fresh) === 1, '切到空会话：**不重印字标**（仍只有开机那一份）')

    // —— 乙落账 ——
    await typeLine(session, '第二条会话的交代')
    await session.key('enter', { until: { text: '收到乙的交代。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })
    const yi = await session.capture({ label: '04-乙落账' })
    keep(yi)
    check(bannerCopies(yi) === 1, '乙落账之后：仍只有那一份')

    // —— `/session` 选回甲：**这一屏就是本单要的那一屏** ——
    //
    // ⚠️ 等「甲那两行**又铺了一遍**」而不是等它的文字出现——那段字早在 `02` 就印过了，
    //    拿「屏上有它」当条件**恒真**，会在重建落地之前就取帧（实测踩过同形的空转）。
    await typeLine(session, '/session')
    await session.key('enter') // 回车＝**开抽屉**（`/session` 这一条命令的答复随后到）
    // 抽屉刚开时选中的是**当前那条**（乙）——挪到甲那一行（按屏上印的行号算）
    await moveTo(session, '第一条会话的交代')
    await session.key('enter', { until: { text: '已切到 第一条会话的交代' }, timeoutMs: 10_000 })
    await waitUntil(
      session,
      '换回甲之后那段记录又铺一遍',
      (lines) => countOn(lines, '› 第一条会话的交代') >= 2,
      10_000,
    )
    const back = await session.capture({ label: '05-换回甲那一屏' })
    keep(back)
    checkScreen(back, '换回甲那一屏', '› 第一条会话的交代')
    check(
      countOn(back.history, '› 第一条会话的交代') >= 2,
      '换回甲那一屏：那条会话的记录**照常重铺**（不是被「不重印」连带吞掉）',
      `实际 ${countOn(back.history, '› 第一条会话的交代')} 遍`,
    )

    // —— 再切到乙：来回各一次，回执每次都在 ——
    await typeLine(session, '/session')
    await session.key('enter')
    await moveTo(session, '第二条会话的交代')
    await session.key('enter', { until: { text: '已切到 第二条会话的交代' }, timeoutMs: 10_000 })
    await waitUntil(
      session,
      '切到乙之后那段记录又铺一遍',
      (lines) => countOn(lines, '› 第二条会话的交代') >= 2,
      10_000,
    )
    const again = await session.capture({ label: '06-再切到乙那一屏' })
    keep(again)
    checkScreen(again, '再切到乙那一屏', '› 第二条会话的交代')

    check(
      countOn(again.history, '· 已切到') >= 2,
      '连切两次：**回执两次都在**（没有「字标没了、回执也没了」的空屏）',
      `实际 ${countOn(again.history, '· 已切到')} 条`,
    )

    await session.key('ctrl+c')
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
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 20_000 })
    const boot = await session.capture({ label: '07-窄窗开机屏' })
    keep(boot)

    await typeLine(session, '第一条会话的交代')
    await session.key('enter', { until: { text: '收到甲的交代。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

    await typeLine(session, '/session new')
    await session.key('enter')
    await session.wait({ absent: '/session new' }, { timeoutMs: 10_000 })

    await typeLine(session, '第二条会话的交代')
    await session.key('enter', { until: { text: '收到乙的交代。' }, timeoutMs: 20_000 })
    await session.wait({ text: HINT_IDLE }, { timeoutMs: 15_000 })

    await typeLine(session, '/session')
    await session.key('enter')
    await moveTo(session, '第一条会话的交代')
    await session.key('enter', { until: { text: '已切到 第一条会话的交代' }, timeoutMs: 10_000 })
    await waitUntil(
      session,
      '窄窗下换回甲之后那段记录又铺一遍',
      (lines) => countOn(lines, '第一条会话的交代') >= 2,
      10_000,
    )
    const back = await session.capture({ label: '08-窄窗换会话那一屏' })
    keep(back)

    check(bannerCopies(back) === 1, '窄窗换会话那一屏：字标只有一份', `实际 ${bannerCopies(back)} 份`)
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

    await session.key('ctrl+c')
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
