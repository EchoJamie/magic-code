#!/usr/bin/env bun
/**
 * U50 · **停止、异常退出与通知**——真 PTY 留帧与验收判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那几件**：
 * 在真窗口上按那个键之后，屏上那一屏**读起来是「停了」还是「不知道停没停」**——这一条
 * 正是本单要答的问题（工单：「停止那一屏尤其要问读起来是『停了』还是『不知道停没停』」）。
 *
 * ## 三场，都在真链路上（到屏为止）
 *
 * 真 `cli.ts`（真管理者 → 真执行者 → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * | 场 | 做什么 | 要看见什么 |
 * | --- | --- | --- |
 * | 局部停止 | 列表里对选中的那一条按 `ctrl+w` | 回执写着「只停了这一轮」，而那一行**不是**已停止 |
 * | 整体停止 | 同一条按 `ctrl+x` | 回执先「正在停」再「停了」，那一行**才是**已停止 |
 * | 通知 | 一轮跑完 / 一轮出错 | 两类各一行回执（三类里「需要你」由审批卡那一屏自带） |
 *
 * ## 两扇窗，一块沙地
 *
 * 甲窗跑一句**慢慢长出来**的回话（这样「停下来」有东西可停）；乙窗是取景的那一扇
 * ——它从列表里停**别人**那一条。
 *
 * 常宽 100×30 一趟，窄窗 46×30 一趟。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u50-tui.ts --out <目录>
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

/**
 * **列表里那一条**那一行（按标题锚）——判据有的要落在**那一行**上，不能落全屏。
 *
 * 由头：开屏那张摘要（「1 项执行中 —— /resume 看它们」）**是落账进滚动区的一句**，
 * 它不会跟着运行事实变——全屏找「执行中」会一直找得到，而那与那一行此刻什么样无关。
 */
/**
 * **列表里那一条**那一行——**按行首那个序号锚**（`  1 长话　…`）。
 *
 * 为什么不用「标题 ＋ 某个状态词」：活跃那一段的行**没有状态词**（组头才是状态，
 * 行上是动作「正在等 MiniMax-M3 回话」），拿状态词当条件会找不到行。
 */
const ROW_AT = /^\s*\d+\s/u

/** 一行里找**列表那一行**（`waitUntil` 收的是 `lines`，不是 `Capture`）。 */
function line0(lines: readonly string[], title: string): string {
  return lines.find((line) => ROW_AT.test(line) && line.includes(title)) ?? ''
}

function rowIndex(capture: Capture, title: string): number {
  return capture.lines.findIndex((line) => ROW_AT.test(line) && line.includes(title))
}

function rowLine(capture: Capture, title: string): string {
  const at = rowIndex(capture, title)
  return at === -1 ? '' : (capture.lines[at] ?? '')
}

/**
 * **选中那一条的详情**（紧跟在它下面那一行）——「上一轮被中断」与停止键落在那儿。
 *
 * ⚠️ **窄窗里它会折行**（46 列实测：`… ctrl+w` ＋ 下一行 `只停这一轮`），故取**两行**：
 * 只取一行的话，判据量的就不是「那一行说不说得出来」，而是「这一屏多宽」。
 */
function detailLine(capture: Capture, title: string): string {
  const at = rowIndex(capture, title)
  return at === -1 ? '' : capture.lines.slice(at + 1, at + 3).join(' ')
}

/** 等一个条件在**可见屏**上成立（默认 25 秒）——轮询是用例的事。 */
async function waitUntil(
  session: UiSession,
  what: string,
  ok: (lines: readonly string[]) => boolean,
  timeoutMs = 25_000,
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
  const runs = tempDir(`magic-u50-frames-${mark}-`)
  const fixture = startFixture({
    turns: [
      {
        kind: 'text',
        text: '这一句会慢慢长出来：先是一半，然后才是另一半。停它的时候它正长在半路上。',
        // 块多、块间慢——「停下来」这件事要有东西可停（不然取景取到的多半是「早跑完了」）
        chunks: 40,
        chunkDelayMs: 700,
      },
      // 第二句短（给「完成」那一类通知留一场真跑）
      { kind: 'text', text: '第二句短话。' },
      // 第三场：**出错**（给「失败」那一类通知留一场真跑）
      // ⚠️ **400 不是 5xx**：5xx / 429 属**瞬时档**，模型域会退避重试——而重试会把
      //    下一场剧本吃掉（实测栽过：那一下重试拿到的正好是第四场的正常回话，
      //    「出错」当场变成「跑完了」）。400 是**终态**，重试路不走，误差可控。
      { kind: 'http', status: 400, message: '夹具按剧本报错' },
      // 第四场：短一句（把状态行从「出错」带回空闲——两扇窗要**自己走**，而
      // 「空闲连按两次 ctrl+c」那道门要它先是空闲的）
      { kind: 'text', text: '收尾一句。' },
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
    await typeLine(mine, '长话')
    await mine.key('enter')
    await mine.wait({ text: '这一句会慢慢长出来' }, { timeoutMs: 25_000 })

    // —— 乙窗：从列表里停**别人**那一条 ——
    const other = await createUiSession({
      label: `${mark}-乙窗`,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(other)

    await typeLine(other, '/resume')
    await other.key('enter', { until: { text: '长话' }, timeoutMs: 20_000 })
    const list = await other.capture({ label: `${mark}-01-列表（选中那一条）` })
    keep(list)
    check(has(list, '执行中'), '那一条标着「执行中」（有东西可停）', list.text)
    // 停止那两个键**报在选中那一条的详情那一行**（U50：状态行右位放不下，见 `STOP_KEYS_HINT`）
    check(detailLine(list, '长话').includes('ctrl+x 停'), '停止键**报在屏上**（不是要用户自己撞）', detailLine(list, '长话'))
    // ⚠️ 窄窗里这一串会**在中间折行**（`ctrl+w` ＋ 下一行 `只停这一轮`）——分成两截判，
    //    判的是「两个范围各报出来了」，不是「这一屏多宽」
    check(
      detailLine(list, '长话').includes('ctrl+w') && detailLine(list, '长话').includes('只停这一轮'),
      '两个范围各有一个键（整体 / 局部）',
      detailLine(list, '长话'),
    )

    // ① **局部停止**（`ctrl+w`）——只收这一轮
    await other.key('ctrl+w')
    await waitUntil(other, '局部停止的回执', (lines) =>
      lines.some((line) => line.includes('只停了')),
    )
    const partial = await other.capture({ label: `${mark}-02-只停这一轮` })
    keep(partial)
    check(has(partial, '只停了'), '回执说清中断的是哪个范围（局部）', partial.text)
    check(has(partial, '那条运行还在'), '**没有**把局部说成整体（那条运行还在）', partial.text)
    check(
      !rowLine(partial, '长话').includes('已停止'),
      '那一行**不显示成「已停止」**（局部成功不是整体成功）',
      rowLine(partial, '长话'),
    )
    check(
      detailLine(partial, '长话').includes('上一轮被中断'),
      '而它也没把那件事藏起来（详情里写着「上一轮被中断」）',
      detailLine(partial, '长话'),
    )

    // ② **整体停止**（`ctrl+x`）——收这条运行
    //
    // ⚠️ 判据要**认得出这一档的回执**，而且要认得出那是**回执**：
    //   - 局部那一句里也有「停了」（「只停了…」）——拿它当条件会恒真；
    //   - 那一行的详情里也有「停了」（「这一轮没跑完就停了」）——那是**事实**，不是回执。
    //   故锚死**回执那一行的原话**（`·` 开头 ＋「正在停」/「「长话」 停了」）。
    const receiptSaying = (lines: readonly string[], what: string): boolean =>
      lines.some((line) => line.trimStart().startsWith('·') && line.includes(what))

    await other.key('ctrl+x')
    await waitUntil(other, '整体停止：这一档的回执', (lines) => receiptSaying(lines, '「长话」停了'))
    const whole = await other.capture({ label: `${mark}-03-停这条运行` })
    keep(whole)
    check(has(whole, '「长话」停了'), '核销之后才报「停了」', whole.text)
    check(has(whole, '只停了'), '局部那一句也在（两档的话**分得开**）', whole.text)
    check(!has(whole, '还没收完'), '整体那一档没有提前说「停完了」', whole.text)

    // 那一行**落了定**——等的是**那一行本身**换成了「已停止」（运行事实是推来的，
    // 合并窗 100ms；拿别的字当条件会当场恒真，取到的还是旧那一屏——实测栽过两次）
    await waitUntil(
      other,
      '那一行落定为「已停止」',
      (lines) => ROW_AT.test(line0(lines, '长话')) && line0(lines, '长话').includes('已停止'),
      20_000,
    )
    const done = await other.capture({ label: `${mark}-04-停了之后` })
    keep(done)
    check(rowLine(done, '长话').includes('已停止'), '那一行落了定：读得出来它停了', rowLine(done, '长话'))
    check(!rowLine(done, '长话').includes('执行中'), '它**不再**是执行中', rowLine(done, '长话'))

    // ③ **通知**：完成与失败各一条（第三类「需要你」由审批卡那一屏自带，归 U38 的帧）
    // **等抽屉真收起来**——判据取**输入行那句占位**（「交代一件事」），它两趟都在
    // （⚠️ 不能拿状态行那句键位提示当判据：**窄窗里它本来就不出现**，那会当场恒真，
    //   后面那几个字于是打进筛词里——实测栽过一次）
    await other.key('esc', { until: { text: '交代一件事' }, timeoutMs: 10_000 })
    await typeLine(other, '短话')
    await other.key('enter')
    await waitUntil(other, '完成那一类通知', (lines) => lines.some((line) => line.includes('跑完了')))
    const notified = await other.capture({ label: `${mark}-05-跑完的那一条通知` })
    keep(notified)
    check(has(notified, '跑完了'), '「完成」那一类有一行回执', notified.text)

    await typeLine(other, '出错那句')
    await other.key('enter')
    await waitUntil(other, '失败那一类通知', (lines) => lines.some((line) => line.includes('出错了')))
    const failed = await other.capture({ label: `${mark}-06-出错的那一条通知` })
    keep(failed)
    check(has(failed, '出错了'), '「失败」那一类有一行回执', failed.text)

    // ④ 再交代一句，把状态行从「出错」带回空闲（见夹具第四场）
    await typeLine(other, '收尾')
    await other.key('enter')
    await other.wait({ text: '收尾一句。' }, { timeoutMs: 20_000 })

    // ⑤ 收尾：两扇窗都自己走
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
  const root = at === -1 ? tempDir('magic-frames-u50-') : (process.argv[at + 1] as string)
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
