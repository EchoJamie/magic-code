#!/usr/bin/env bun
/**
 * U53 · **`--session` 接续时记录区一个字都不铺**（D33）——真 PTY 留帧与判据。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）。它补的是**只有真终端才说得清的那一件**：
 * 拿一条真会话的 id 起第二个窗口，**记录区到底铺不铺**。这正是 D33 漏掉的那一侧——
 * `cli.test.ts` 只验了 `--check --session`（非终端，走装配那一条），终端那一侧没人看着。
 *
 * ## 走的是真链路（到屏为止）
 *
 * 真 `cli.ts`（真管理者 → 真执行者 → 真模型适配链）→ 按键**经真 PTY** 送进它的 stdin →
 * 屏上的字**从它写出的字节里读**（VT 模型解析）。模型那一头是 loopback 夹具（合成假 key）。
 *
 * ## 两程，一块沙地
 *
 * 第一程：起一个窗口、交代一句、等回话落屏、**照产品的方式退出**（`quit`）。
 * 第二程：**另一个窗口拿那条会话的 id 起来**（`--session <id>`）。判四件：
 *
 * 1. **记录区铺出来了**——那条交代与那回话都在屏上（D33 要的正是这一条）；
 * 2. **状态行认得出那条会话**（标题＝首句）——今天已经对，钉住它别被改坏；
 * 3. **不是重跑**——模型一次都没被再问过（物证是**调用数**，不是屏）；
 * 4. **同一条会话只有一个执行者**——按**实际进程数**证（`pgrep`），不是看屏。
 *
 * ⚠️ **锚回话那一行，别锚那句原话**：原话在状态行上本来就有一份（标题＝首句），
 * 拿它当条件时记录区一个字不铺它照样成立——D33 当初没被一眼看出来，正是栽在这一处。
 *
 * ## 跑法
 *
 * ```
 * bun packages/app/test/frames-u53-tui.ts --out <目录>
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDatabase } from './support.ts'
import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { Capture, Sandbox, UiSession } from './ui/index.ts'
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

/** 敲一行字（先等它落到输入行上，再交给调用方按回车）。 */
async function typeLine(session: UiSession, text: string): Promise<void> {
  await session.send(text, { until: { text }, timeoutMs: 10_000 })
}

/**
 * 沙地里现在有几个**执行者**——`pgrep` 按启动目录认（它们都带着沙地里的路径）。
 *
 * 判据要的是**实际进程数**，不是屏上的样子：「同一条会话只有一个执行者」这件事
 * 屏上说不清（两个窗口看同一条会话本来就各有各的屏）。
 */
async function executorsIn(sandbox: Sandbox): Promise<number> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  return text.split('\n').filter((line) => line.includes('internal-executor')).length
}

/** 等一个条件成立（默认 15 秒）——轮询是这一层的事，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(50)
  }
}

/** 那条会话的 id——**从库里读**（会话是首写即建的，这是它唯一的落点）。 */
function onlySessionOf(sandbox: Sandbox): string {
  const db = readDatabase(join(sandbox.dataDir, 'records.db'))
  try {
    const sessions = db.sessions
    if (sessions.length !== 1) throw new Error(`库里不止一条会话（${sessions.length} 条）`)
    return (sessions[0] as { id: string }).id
  } finally {
    db.close()
  }
}

/** 那一趟要跑的东西——宽窄各一遍（除了尺寸，判据一字不改）。 */
async function once(mark: string, columns: number, rows: number): Promise<void> {
  const runs = tempDir(`magic-u53-frames-${mark}-`)
  // ⚠️ **锚要短**（窄窗 46 列下自动折行）：判据按**行**找，长句会断在两行上
  const said = '记一句短话'
  const reply = '好，记下了。'
  const fixture = startFixture({
    turns: [{ kind: 'text', text: reply }],
  })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const windows: UiSession[] = []

  try {
    // —— 第一程：起一条有内容的会话，再**照产品的方式退出** ——
    const one = await createUiSession({
      label: `${mark}-第一程`,
      artifacts: runs,
      sandbox,
      fixture,
      columns,
      rows,
    })
    windows.push(one)

    await typeLine(one, said)
    await one.key('enter')
    await one.wait({ text: reply }, { timeoutMs: 30_000 })
    await one.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })
    const opened = await one.capture({ label: `${mark}-01-第一程（记下来了）` })
    keep(opened)

    await one.quit()
    const closed = await one.close({ graceMs: 8_000 })
    check(closed.exit.by !== 'sigkill', '第一程自己走的', `by=${closed.exit.by}`)
    windows.length = 0

    const id = onlySessionOf(sandbox)
    console.log(`  · 会话 id：${id}`)
    check(fixture.requests().length === 1, '第一程只问过模型一次', `${fixture.requests().length} 次`)

    // —— 第二程：拿那条 id 起来 ——
    const two = await createUiSession({
      label: `${mark}-第二程（--session）`,
      artifacts: runs,
      sandbox,
      fixture,
      columns,
      rows,
      argv: ['--session', id],
    })
    windows.push(two)

    // ① **记录区铺出来了**——那条会话的历史就在屏上（D33 要的正是这一条）。
    //    ⚠️ 锚**回话那一行**，不锚那句原话：原话**在状态行上本来就有一份**（标题＝首句），
    //    拿它当条件时，记录区一个字不铺它照样成立——那正是 D33 没能被一眼看出来的原因。
    await two.wait({ text: reply }, { timeoutMs: 30_000 })
    const back = await two.capture({ label: `${mark}-02-接续（记录区）` })
    keep(back)
    check(has(back, `› ${said}`), '记录区把那条交代铺出来了', back.text)
    check(has(back, reply), '回话那一行也在（整条流水都铺了）', back.text)
    check(has(back, `○ 空闲 · ${said}`), '状态行认得出那条会话（标题＝首句）', back.text)
    // **铺的是那条会话现有的历史，不是重跑**——模型一次都没被再问过（物证是调用数，不是屏）
    check(fixture.requests().length === 1, '接续没有重跑（模型只被问过一次）', `${fixture.requests().length} 次`)
    // ② **同一条会话只有一个执行者**——按实际进程数证（不是看屏）
    await waitFor('那条会话的执行者只有一个', async () => (await executorsIn(sandbox)) === 1, 20_000)
    console.log('  ✓ 同一条会话只有一个执行者（pgrep 实数）')

    await two.quit()
    const twoClosed = await two.close({ graceMs: 8_000 })
    check(twoClosed.exit.by !== 'sigkill', '第二程自己走的', `by=${twoClosed.exit.by}`)
    windows.length = 0

    // 窗口走了 ⇒ 那一代也收（没有连接者、手上也没事）——「不留空转的后台」那一条
    await waitFor('执行者收掉', async () => (await executorsIn(sandbox)) === 0, 20_000)
    console.log('  ✓ 窗口走了执行者也收——不留一个空转的后台（pgrep 实数）')
  } finally {
    for (const window of windows) await window.close().catch(() => {})
    await fixture.stop()
    sandbox.dispose()
    removeDir(runs)
  }
}

if (import.meta.main) {
  const at = process.argv.indexOf('--out')
  const root = at === -1 ? tempDir('magic-frames-u53-') : (process.argv[at + 1] as string)
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
