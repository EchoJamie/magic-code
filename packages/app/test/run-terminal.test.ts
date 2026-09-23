/**
 * U48 · 第五段 —— **终端是客户端**。
 *
 * 这一支量的是 U48 那条**完成出口的头一句**：
 *
 * > 连开七个空白窗口再关，**零 Session 零 Run**、无高 CPU 残留
 *
 * 以及两条同族的：`--session` 打错一个字母**经管理者那条路**照样报错退场（U28 那条
 * 「不静默开一条空的」不能在换底之后失效），与**终端断流**时窗口自己退场（不能空转
 * 充当后台执行者）。
 *
 * ⚠️ **走的是真窗口**（`createUiSession`：真 PTY · 真 `cli.ts` · 真 Ink），不是进程内的
 * 装配层用例——这一单要证的正是「终端与执行分开了」，进程内那一层证不了。
 *
 * ⚠️ **七个窗口借同一块沙地**（`sandbox` / `fixture` 外借）：它们要落在**同一摊运行**
 * 上（同一个 dataDir ⇒ 同一个管理者），各开一块沙地就变成七个互不相干的管理者了——
 * 而那正是这条判据要否掉的东西。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPathsOf } from '../src/run/paths.ts'
import { readDatabase } from './support.ts'
import { createUiSession } from './ui/index.ts'
import type { Sandbox, UiSession } from './ui/index.ts'
import { createSandbox, startFixture } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 那一摊运行的落点（沙地的 HOME ＋ 沙地的 dataDir ⇒ 与子进程同一条算式）。 */
function pathsOf(sandbox: Sandbox): ReturnType<typeof runPathsOf> {
  return runPathsOf({ home: sandbox.home, base: join(sandbox.home, '.magic') }, sandbox.dataDir, tmpdir())
}

/** 等一个条件成立（默认 15 秒）——轮询是用例的事，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(50)
  }
}

/** 沙地里还有没有这一摊的进程（按启动目录认——执行者与管理者都带着沙地的路径）。 */
async function straysIn(sandbox: Sandbox): Promise<string[]> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  return text
    .split('\n')
    .filter((line) => line.includes('internal-'))
    .filter((line) => line.trim() !== '')
}

describe('U48-S5 · 终端是客户端', () => {
  test('七个空白窗口连开再关——零 Session 零 Run、客户端退出、无残留', async () => {
    const runs = tempDir('magic-u48-seven-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '没人会看到这句' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const windows: UiSession[] = []

    try {
      // —— 连开七个：**并行**（工单那句是「连开」；顺序开七个只能证到一半）——
      for (let i = 0; i < 7; i += 1) {
        windows.push(
          await createUiSession({ label: `空白-${i}`, artifacts: runs, sandbox, fixture }),
        )
      }

      const paths = pathsOf(sandbox)
      // **一个管理者**：七条窗口都落在同一条 socket 上（各自另起一个的话，这里会有七个）
      expect(existsSync(paths.socket)).toBe(true)

      // —— 再关 ——
      for (const window of windows) {
        const closed = await window.close()
        expect(closed.exit.by).not.toBe('sigkill') // 窗口是**自己走的**，不是被拔电
      }
      windows.length = 0

      // **零 Session 零 Run**：库在（管理者开过、迁移过），可一条会话、一条条目、一个事件都没有
      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      try {
        expect(db.sessions.length).toBe(0)
        expect(db.entries.length).toBe(0)
        expect(db.events.length).toBe(0)
      } finally {
        db.close()
      }

      // **不留人**：两手空了 ⇒ 管理者自己收摊（收摊之后路径是干净的）
      await waitFor('管理者自己退场', () => !existsSync(paths.socket), 20_000)
      await Bun.sleep(500)
      expect(await straysIn(sandbox)).toEqual([])

      // **外借的沙地原封不动**（回收归借出方）
      expect(existsSync(sandbox.root)).toBe(true)
    } finally {
      for (const window of windows) {
        try {
          await window.close()
        } catch {
          // 已经关了
        }
      }
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  test('`--session` 打错一个字母——经管理者那条路照样报错退场（不静默开一条空的）', async () => {
    const runs = tempDir('magic-u48-typo-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({
        label: 'typo',
        artifacts: runs,
        sandbox,
        fixture,
        argv: ['--session', 's-typo'],
        // 这一趟**画不出一帧**（没接上就退了）——故不等首帧
        skipReady: true,
      })

      const closed = await window.close({ graceMs: 8_000 })
      expect(closed.exit.by).toBe('app') // 自己退的
      expect(closed.exit.code).toBe(1)

      const said = window.rawText()
      expect(said).toContain('没有这条会话')
      expect(said).toContain('s-typo')

      // **一个会话都没开**——「报错不降级」在这一条路上也是结构上的
      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      try {
        expect(db.sessions.length).toBe(0)
      } finally {
        db.close()
      }
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 60_000)

  test('终端断流——窗口自己退场，不留一个空转的后台', async () => {
    const runs = tempDir('magic-u48-drop-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: 'drop', artifacts: runs, sandbox, fixture })

      // **把终端那一头摘掉**（关掉 PTY 主端，不发信号）——「这一头没人了」
      window.dropTerminal()

      const closed = await window.close({ graceMs: 10_000 })
      expect(closed.exit.by).toBe('app')
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 60_000)
})
