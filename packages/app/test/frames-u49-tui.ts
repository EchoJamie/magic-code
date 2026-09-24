#!/usr/bin/env bun
/**
 * U49 · **运行列表、状态与接回**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那几件**：
 * 列表在真帧上长什么样、状态那一行读起来顺不顺、接回之后那一屏是不是「接着刚才」的样子
 * ——这一类判据在单元层（`spec.u49.test.ts`）只看得到行与文本，看不到**布局 · 文案 ·
 * 层级 · 通读**这四项（`AGENTS.md`「看图是四项」）。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真管理者 → 真执行者 → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 两扇窗，一块沙地
 *
 * 甲窗跑一句**慢慢长出来**的回话；乙窗是取景的那一扇——它要看的就是「**别人**在跑」这件事：
 * 列表上那一条排在**最前**、标着「执行中」并写着它此刻在干什么；选定之后**接回同一条**，
 * 在飞的那一段（离开期间已经吐出去的头半句）就在屏上。
 *
 * 常宽 100×30 一趟，窄窗 46×30 一趟。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u49-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { Capture, UiSession } from './ui/index.ts'
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
    `${JSON.stringify({ lines: shot.lines, cells: shot.lines.map((_l, row) => shot.cellsOf(row)) }, null, 1)}\n`,
    'utf8',
  )
}

/** 一行在不在（按行找，与 `session.wait` 同一条尺子）。 */
function has(capture: Capture, needle: string): boolean {
  return capture.lines.some((line) => line.includes(needle))
}

/** 等一个条件在**可见屏**上成立（默认 20 秒）——轮询是用例的事。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    const screen = await session.screen()
    const lines = screen.lines.map((line) => line.text)
    if (ok(lines)) return
    if (Bun.nanoseconds() > until) {
      throw new Error(`等「${what}」超时（${timeoutMs}ms）。屏：\n${lines.join('\n')}`)
    }
    await Bun.sleep(40)
  }
}

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/** 那一趟要跑的东西——宽窄各一遍（除了尺寸，判据一字不改）。 */
async function once(mark: string, columns: number, rows: number): Promise<void> {
  const runs = tempDir(`magic-u49-frames-${mark}-`)
  const fixture = startFixture({
    turns: [
      {
        kind: 'text',
        text: '这一句会慢慢长出来：先是一半，然后才是另一半。甲窗先看着它长，乙窗随后接回来。',
        // 块多、块间慢——**接回那几步要走十来秒**，那一句得像真流式那样一直长着，
        // 不然取景取到的多半是「早跑完了」（窄窗那一趟实测栽过）
        chunks: 40,
        chunkDelayMs: 700,
      },
    ],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    // —— 甲窗：把那一句**说起来** ——
    const mine = await createUiSession({
      label: `${mark}-甲窗`,
      artifacts: undefined,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(mine)
    await typeLine(mine, '说一句长话')
    await mine.key('enter')
    await mine.wait({ text: '这一句会慢慢长出来' }, { timeoutMs: 25_000 })

    // —— 乙窗：接回来 ——
    const other = await createUiSession({
      label: `${mark}-乙窗`,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(other)

    // ① 开屏那张摘要（**确有别的活跃工作**时才有这一行）
    const boot = await other.capture({ label: `${mark}-01-开屏摘要` })
    keep(boot)
    check(has(boot, '1 项执行中'), '开屏那张摘要在（确有别的活跃工作时出现）', boot.text)
    check(has(boot, '/resume'), '摘要指向列表（那句话里有去处）', boot.text)
    check(!has(boot, 'pid='), '屏上没有 PID（设计：不把 PID 常驻）', boot.text)

    // ② `/resume` 那一屏：活跃那一条在最前，且写着**它此刻在干什么**
    await typeLine(other, '/resume')
    // ⚠️ 锚**列表里那一行**，不锚状态行那句键位提示——**窄窗下它放不下**（实测载过：
    //    46 列上状态行左右两半挤一行，提示整段不出现，拿它当条件会白等到超时）
    await other.key('enter', { until: { text: '说一句长话' }, timeoutMs: 20_000 })
    const list = await other.capture({ label: `${mark}-02-列表（活跃在前）` })
    keep(list)
    check(has(list, '执行中'), '那一条标着「执行中」', list.text)
    check(has(list, '正在等'), '副文案写着**此刻在干什么**', list.text)
    check(has(list, '已持续'), '详情那一行有「已持续」', list.text)
    check(has(list, '说一句长话'), '列表里认得出是哪一条（标题＝首句交代）', list.text)

    // ③ 打字＝按名字筛（**等筛选真发生**——'长话' 三个字本来就在屏上，拿它当条件恒真）
    await other.send('长话', { until: { text: '筛选「长话」' }, timeoutMs: 10_000 })
    const filtered = await other.capture({ label: `${mark}-03-按名字筛` })
    keep(filtered)
    check(has(filtered, '筛选「长话」'), '筛词报在屏上（用户看得见自己在筛什么）', filtered.text)

    // ④ `tab` 换范围
    await other.key('tab')
    const scope = await other.capture({ label: `${mark}-04-只看本工作区` })
    keep(scope)
    check(has(scope, '只看本工作区'), '换范围了，且**与筛词各说各的**（两件都在）', scope.text)

    // ⑤ 选定它——**接回同一条**，在飞的那一段回来
    await other.key('enter')
    await waitUntil(other, '接回：在飞的那段回到屏上', (lines) =>
      lines.some((line) => line.includes('这一句会慢慢长出来')),
    )
    const back = await other.capture({ label: `${mark}-05-接回之后` })
    keep(back)
    check(has(back, '这一句会慢慢长出来'), '接回来的那一段在屏上（不是在飞时看不见）', back.text)

    // ⑥ 补齐：尾巴照常接上（同一股流，不是重跑）
    await other.wait({ text: '甲窗先看着它长' }, { timeoutMs: 45_000 })
    const whole = await other.capture({ label: `${mark}-06-补齐` })
    keep(whole)
    check(has(whole, '甲窗先看着它长'), '后来那半句照常接上（同一条流）', whole.text)

    // ⑦ 收尾：两扇窗都自己走
    await mine.quit()
    const mineClosed = await mine.close({ graceMs: 5_000 })
    check(mineClosed.exit.by !== 'sigkill', '甲窗自己走的', `by=${mineClosed.exit.by}`)
    windows.shift()

    await other.quit()
    const otherClosed = await other.close({ graceMs: 5_000 })
    check(otherClosed.exit.by !== 'sigkill', '乙窗自己走的', `by=${otherClosed.exit.by}`)
    windows.length = 0
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u49-') : (process.argv[at + 1] as string)
  mkdirSync(root, { recursive: true })
  out = root

  try {
    console.log('· 常宽 100×30')
    await once('宽', 100, 30)
    console.log('· 窄窗 46×30')
    await once('窄', 46, 30)

    console.log(`\n全部判据通过。帧落在 ${out}`)
  } finally {
    if (at === -1) removeDir(root)
  }
}
