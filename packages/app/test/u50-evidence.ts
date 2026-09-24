#!/usr/bin/env bun
/**
 * U50 · **真进程证据**——那几行「只有真起进程、真发信号才说得清」的场景。
 *
 * `bun test` **不收它**（文件名不是 `*.test.ts`）：这几场要**杀**真的管理者与执行者、
 * 要**冻**住一个真进程，放进常规门里跑既慢又脆（而且杀别人机器的进程不该是常态）。
 * 真窗口那一层（按下停止键之后屏上长什么样）在 `frames-u50-tui.ts`；管理者那一层的
 * 判据在 `run-stop.test.ts` / `run-owned.test.ts`。这一支补的是**中间那一层**：
 * 真 `cli.ts` ＋ 真管理者 ＋ 真执行者 ＋ 真信号。
 *
 * | 场 | 造法 | 要看见什么 |
 * | --- | --- | --- |
 * | 执行者被杀 | `kill -9` 那个执行者进程 | 那一代核销、**失败**那一类通知到屏；没有进程残着 |
 * | 管理者被杀 | `kill -9` 管理者 | 执行者**自己退**（专用生命连接断了就自停，不变成无人负责的后台） |
 * | 重启核对 | 换一扇窗接同一块沙地 | 那一条读作「已停止 · 异常退出」，且**一个模型请求都不多发**（不自动重放） |
 * | 睡眠那一档 | 给执行者 `SIGSTOP` 三秒再 `SIGCONT`（**真睡眠的替身**） | 醒来接着跑，**请求数不涨**（不重发、不重放） |
 *
 * ⚠️ 睡眠那一档**用的是替身，如实说**：真睡眠要合上盖子，自动化里做不到。`SIGSTOP`
 * 冻住的是**同一个进程**（它的定时器、它的 socket、它的子进程都不动），醒来时墙上时钟
 * 已经过去三秒——与「机器睡了一觉」在**这一层**（进程还在、时间走了、没人重放）同形。
 * 它验不了的是内核挂起时 socket 缓冲与供应商连接的行为（那要真合盖）。
 *
 * 跑法：
 *
 * ```
 * bun packages/app/test/u50-evidence.ts
 * ```
 */

import { createUiSession, createSandbox, startFixture } from './ui/index.ts'
import type { Sandbox, UiSession } from './ui/index.ts'

/** 一条判据的结论——**不过就记账**（最后一起报，跑完所有场景再退非零）。 */
const failures: string[] = []

function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  ✓ ${what}${detail === '' ? '' : `（${detail}）`}`)
    return
  }

  failures.push(what)
  console.log(`  ✗ ${what}${detail === '' ? '' : `（${detail}）`}`)
}

const LONG = '这一句会慢慢长出来：先是一半，然后才是另一半，最后才收尾。停或杀都发生在这中间。'

/** 沙地里那些进程（按启动目录认）——两类分开数。 */
async function procsIn(root: string): Promise<{ managers: string[]; executors: string[] }> {
  const proc = Bun.spawn(['pgrep', '-fl', root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  const lines = text.split('\n').filter((line) => line.trim() !== '')
  return {
    managers: lines.filter((line) => line.includes('internal-manager')),
    executors: lines.filter((line) => line.includes('internal-executor')),
  }
}

/** 一行里的进程号（`pgrep -fl` 那几个字段的第一个）。 */
function pidOf(line: string): number {
  return Number(line.trim().split(/\s+/u)[0])
}

/** 等一个条件成立（默认 10 秒）。 */
async function waitFor(what: string, ok: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await ok()) return true
    await Bun.sleep(50)
  }
  console.log(`  （等不到：${what}）`)
  return false
}

/** 一扇窗的屏上有没有那句话（按行找）。 */
async function screenHas(session: UiSession, needle: string): Promise<boolean> {
  const screen = await session.screen()
  return screen.lines.some((line) => line.text.includes(needle))
}

/** 起一扇真窗口 ＋ 一块沙地 ＋ 一台夹具（三场的公共起手）。 */
async function openRoom(
  label: string,
  turns: readonly { readonly kind: 'text'; readonly text: string; readonly chunks?: number; readonly chunkDelayMs?: number }[],
): Promise<{ session: UiSession; sandbox: Sandbox; fixture: ReturnType<typeof startFixture> }> {
  const fixture = startFixture({ turns })
  const sandbox = createSandbox({ baseURL: fixture.baseURL })
  const session = await createUiSession({ label, sandbox, fixture, columns: 100, rows: 30 })
  return { session, sandbox, fixture }
}

/** 一场的收尾——**尽力而为**（现场要留着看，但进程不能留）。 */
async function closeRoom(
  session: UiSession | undefined,
  sandbox: Sandbox | undefined,
  fixture: ReturnType<typeof startFixture> | undefined,
): Promise<void> {
  if (session !== undefined) await session.close({ graceMs: 3_000 }).catch(() => undefined)
  if (fixture !== undefined) await fixture.stop().catch(() => undefined)
  if (sandbox !== undefined) sandbox.dispose()
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 执行者被杀
// ═══════════════════════════════════════════════════════════════════════

async function executorKilled(): Promise<Sandbox | undefined> {
  console.log('\n· 执行者被杀（kill -9）')
  const { session, sandbox, fixture } = await openRoom('U50证据-执行者被杀', [
    { kind: 'text', text: LONG, chunks: 60, chunkDelayMs: 400 },
  ])

  try {
    await session.send('长话')
    await session.key('enter')
    const streaming = await waitFor('开始流式', () => screenHas(session, '这一句会慢慢长出来'), 25_000)
    check(streaming, '那一轮已经在跑（有东西可杀）')
    check((await session.requests()).length >= 1, '模型那一头真收到过请求')

    const found = await waitFor('执行者进程在', async () => (await procsIn(sandbox.root)).executors.length > 0)
    const { executors } = await procsIn(sandbox.root)
    check(found, '执行者进程真的站着', executors[0] ?? '（没找到）')
    if (executors[0] === undefined) return sandbox

    // **一记 SIGKILL**——它跑不到收尾那两跳（这一场要的正是「被杀」）
    process.kill(pidOf(executors[0]), 'SIGKILL')

    const gone = await waitFor('执行者没了', async () => (await procsIn(sandbox.root)).executors.length === 0)
    check(gone, '那个进程真没了')

    // **管理者那一头如实记**：失败那一类通知（异常退出）到屏
    const noticed = await waitFor('失败那一类通知到屏', () => screenHas(session, '出错了'), 15_000)
    check(noticed, '「失败」那一类通知到了屏上（异常退出）')
    const said = await waitFor('缘由点名异常退出', () => screenHas(session, '异常退出'), 10_000)
    check(said, '缘由说得出是「异常退出」（不伪报正常收束）')

    // **不自动重放**：被杀之后模型那一头不该再多一趟请求
    const before = (await session.requests()).length
    await Bun.sleep(1_500)
    const after = (await session.requests()).length
    check(after === before, '被杀之后**没有自动重放**（模型请求数不再涨）', `${before} → ${after}`)

    return sandbox
  } finally {
    await session.close({ graceMs: 3_000 }).catch(() => undefined)
    await fixture.stop()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 二 · 管理者被杀 ⇒ 执行者自停；三 · 换一扇窗重启核对
// ═══════════════════════════════════════════════════════════════════════

async function managerKilled(): Promise<void> {
  console.log('\n· 管理者被杀（kill -9）——执行者自己退，不变成无人负责的后台')
  const { session, sandbox, fixture } = await openRoom('U50证据-管理者被杀', [
    { kind: 'text', text: LONG, chunks: 60, chunkDelayMs: 400 },
  ])
  let reused = false

  try {
    await session.send('长话')
    await session.key('enter')
    await waitFor('开始流式', () => screenHas(session, '这一句会慢慢长出来'), 25_000)

    const found = await waitFor(
      '管理者与执行者都在',
      async () => {
        const seen = await procsIn(sandbox.root)
        return seen.managers.length > 0 && seen.executors.length > 0
      },
    )
    const before = await procsIn(sandbox.root)
    check(found, '管理者与执行者都站着', `${before.managers.length} / ${before.executors.length}`)
    const requestCount = (await session.requests()).length

    // **杀掉管理者**——执行者的专用生命连接随之断开
    if (before.managers[0] !== undefined) process.kill(pidOf(before.managers[0]), 'SIGKILL')

    const stopped = await waitFor(
      '执行者自停',
      async () => (await procsIn(sandbox.root)).executors.length === 0,
      20_000,
    )
    check(stopped, '执行者**自己退了**（收到断开就自停，没有变成无人负责的后台）')

    const windowGone = await waitFor('窗口也走了', async () => {
      try {
        process.kill(session.pid, 0)
        return false
      } catch {
        return true
      }
    }, 15_000)
    check(windowGone, '那一扇窗也退场了（它的内核没了，不空转）')

    // —— 三 · 换一扇窗接同一块沙地：重启核对 ——
    console.log('\n· 重启核对（同一块沙地，另起一扇窗）')
    const again = await createUiSession({
      label: 'U50证据-重启核对',
      sandbox,
      fixture,
      columns: 100,
      rows: 30,
    })
    reused = true

    try {
      await again.send('/resume', { until: { text: '/resume' }, timeoutMs: 15_000 })
      await again.key('enter')
      const listed = await waitFor('列表里那一行', () => screenHas(again, '长话'), 20_000)
      check(listed, '重启之后那一条会话还在列表里')
      const stoppedRow = await waitFor('读作已停止', () => screenHas(again, '已停止'), 20_000)
      check(stoppedRow, '它读作「已停止」（重启核对按事实落定，不假装还在跑）')
      const crashed = await waitFor('缘由是异常退出', () => screenHas(again, '异常退出'), 15_000)
      check(crashed, '缘由说得出「异常退出」')

      // **不自动重放**：重启之后模型那一头一趟都不该多发
      await Bun.sleep(1_500)
      check(
        (await again.requests()).length === requestCount,
        '重启之后**一个模型请求都没多发**（不自动重放未知效果）',
        `${requestCount} → ${(await again.requests()).length}`,
      )
    } finally {
      await again.close({ graceMs: 3_000 }).catch(() => undefined)
    }
  } finally {
    if (!reused) {
      await closeRoom(undefined, undefined, undefined)
    }
    await fixture.stop()
    sandbox.dispose()
  }
}

// ═══════════════════════════════════════════════════════════════════════
// 四 · 睡眠那一档（SIGSTOP 替身）
// ═══════════════════════════════════════════════════════════════════════

async function frozen(): Promise<void> {
  console.log('\n· 睡眠那一档（替身：给执行者 SIGSTOP 三秒再 SIGCONT）')
  const { session, sandbox, fixture } = await openRoom('U50证据-冻住执行者', [
    { kind: 'text', text: LONG, chunks: 60, chunkDelayMs: 300 },
  ])

  try {
    await session.send('长话')
    await session.key('enter')
    await waitFor('开始流式', () => screenHas(session, '这一句会慢慢长出来'), 25_000)

    const found = await waitFor('执行者进程在', async () => (await procsIn(sandbox.root)).executors.length > 0)
    const { executors } = await procsIn(sandbox.root)
    check(found, '执行者进程站着', executors[0] ?? '（没找到）')
    if (executors[0] === undefined) return

    const pid = pidOf(executors[0])
    const before = (await session.requests()).length

    // **冻三秒**——进程还在、时间在走、谁都没重放
    process.kill(pid, 'SIGSTOP')
    await Bun.sleep(3_000)
    process.kill(pid, 'SIGCONT')

    // 醒来之后：那一轮接着跑（同一条流），而模型那一头**一趟都没多发**
    const resumed = await waitFor('接着跑', () => screenHas(session, '最后才收尾'), 40_000)
    check(resumed, '醒来之后那一轮**接着跑完了**（不是重跑一遍）')
    const after = (await session.requests()).length
    check(after === before, '冻住那三秒**没有重发、没有重放**（模型请求数不涨）', `${before} → ${after}`)

    // 那一代**还在**（冻一冻不等于死了）
    check(
      (await procsIn(sandbox.root)).executors.length === 1,
      '执行者照旧只有一个（冻过不等于被当成死了重起一代）',
    )
  } finally {
    await closeRoom(session, sandbox, fixture)
  }
}

if (import.meta.main) {
  console.log('U50 真进程证据——四场')

  const sandbox = await executorKilled()
  sandbox?.dispose()
  await managerKilled()
  await frozen()

  console.log('')
  if (failures.length > 0) {
    console.log(`有 ${failures.length} 条没过：`)
    for (const what of failures) console.log(`  ✗ ${what}`)
    process.exit(1)
  }

  console.log('四场全过。')
}
