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

/**
 * 等一个条件成立（默认 15 秒）——轮询是用例的事，产品那几跳都是事件驱动的。
 *
 * `ok` 可以是异步的（数进程那类要问一问系统）——与 `run-resume.test.ts` 那一份同形。
 */
async function waitFor(
  what: string,
  ok: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(50)
  }
}

/**
 * 沙地里还有没有**这一摊的进程**——按启动目录认（管理者与执行者都带着沙地里的路径）。
 *
 * ⚠️ **两类分开数**（U48 第六段）：`--internal-manager` 是**本机服务**，它「空白启动页」
 * 本来就有（设计明文：「管理者的存在不算『空白启动页有执行者』——它本来就在」）；
 * `--internal-executor` 才是**执行者**。判据要的是后者一个都没有，故分开交回。
 */
async function straysIn(sandbox: Sandbox): Promise<{ managers: string[]; executors: string[] }> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  const lines = text.split('\n').filter((line) => line.trim() !== '')

  return {
    managers: lines.filter((line) => line.includes('internal-manager')),
    executors: lines.filter((line) => line.includes('internal-executor')),
  }
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
      expect(await straysIn(sandbox)).toEqual({ managers: [], executors: [] })

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

  /**
   * **U48 第六段的判据**（与上一支合起来才是：那句话回到开屏 **AND** 空窗口仍然没有
   * 会话、没有执行者）。
   *
   * 两件一起咬：
   * - 开屏那一句**由管理者给**（它的预检读数随 `welcome` 过来）——所以配了一台连不上的
   *   服务器时，那句话必须在**第一帧**上；
   * - 而这一帧**没有一个执行者**在跑——预检是**探针**（连接 → 报状态 → 断开），
   *   不是「为它单起一个后台」。
   */
  test('配了连不上的外部工具：那句话在开屏上（管理者给的），而空窗口仍没有执行者', async () => {
    const runs = tempDir('magic-u48-preflight-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({
      baseURL: fixture.baseURL,
      config: { mcp: { servers: { broken: { command: '/nonexistent/mcp-server-for-u48' } } } },
    })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '预检', artifacts: runs, sandbox, fixture })

      const boot = await window.capture({ label: '开屏' })
      // 三件与 `Assembly.notices` 那句**同词**（判据的锚就是它）
      expect(boot.text).toContain('broken')
      expect(boot.text).toContain('连不上')
      expect(boot.text).toContain('外部工具服务器')

      // **一个执行者都没有**——预检不另起后台，也没有会话（首条消息才开张）。
      // 管理者在（它本来就在，预检就挂在它的启动上），故这里数的是**执行者**
      expect((await straysIn(sandbox)).executors).toEqual([])

      const db = readDatabase(join(sandbox.dataDir, 'records.db'))
      try {
        expect(db.sessions.length).toBe(0)
        expect(db.entries.length).toBe(0)
      } finally {
        db.close()
      }

      const closed = await window.close()
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined

      // 窗口走了、执行者一个没起 ⇒ 管理者也退（预检那一趟的连接早断了，不留人）
      await waitFor('管理者自己退场', () => !existsSync(pathsOf(sandbox).socket), 20_000)
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 90_000)

  /**
   * **卡挂着的那一轮被中断之后，执行者要收得掉**（回归：漏一个永远收不掉的执行者）。
   *
   * 由头是**实测跑出来的**：裁决卡挂在半路、这一轮被 Ctrl+C 中断时，**答复那一条事件
   * 不会来**——执行者若只按「请求／答复配对」记待答项，那一格就永远留着，而「有在途调用
   * 或待答项」是**不收**的一条判据 ⇒ 它就此钉在那儿，管理者也跟着不走。
   *
   * 口径与外壳那一侧**同一条**（`view.ts` 的 `turn.end`：「轮收束 ⇒ 悬着的裁决作废」）
   * ——故这里量的正是那条边界：**轮收束之后，那一格必须清掉**。
   *
   * ⚠️ **与「等待用户的有效工作可保留执行者」不冲突**：卡**还挂着**时这一轮没结束，
   * `turn.end` 不会来——保留照旧。这里中断的是那一轮，卡已经作废了。
   */
  test('悬着的裁决卡随轮收束作废——那一代执行者收得掉，管理者也跟着退', async () => {
    const runs = tempDir('magic-u48-cancel-runs-')
    // ⚠️ **原锚**：`exec echo hi`（判轻）；**为何变**（U76）：判轻的调用**默认通、不弹卡**
    // ——这一条要的正是一张**悬着的卡**，夹具换成**名单里**的删除（必问，且没人答它）；
    // **新锚**：卡落在**重**那一档，右位键位是 `y / n`（见下）。
    const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'rm -rf build' } }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '中断卡', artifacts: runs, sandbox, fixture })

      await window.send('跑一条命令')
      // 内置件走的是**名单里**的删除 ⇒ 重档键位（`y / n`）。⚠️ `HINT_DECIDE_HEAVY` **没出包**
      // （`@magic/tui` 只出去包的常量），故这里按**字面量**锚——与 `ui/scenarios.ts`
      // 里 `COPY.decideHint` 同一条先例：真要改那处文案，判据会红，那正是该有的反应。
      await window.key('enter', { until: { text: 'y / n' }, timeoutMs: 20_000 })

      // **卡还挂着的时候中断这一轮**——答复永远不会来（那正是这个用例要的那条边）
      await window.key('ctrl+c')
      await window.wait({ text: '/ 命令 · ctrl+c 退出' }, { timeoutMs: 15_000 })

      const closed = await window.close()
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined

      // **两手都空 ⇒ 执行者先收、管理者再退**（卡若还钉着，这两跳都不会发生）
      await waitFor('管理者自己退场', () => !existsSync(pathsOf(sandbox).socket), 20_000)
      await Bun.sleep(500)
      expect(await straysIn(sandbox)).toEqual({ managers: [], executors: [] })
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 90_000)

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

/** 那两句交代——**短**（判据按行找，长句会折成两行）。两处共用同一份，免得写岔。 */
const SAID = '记一句短话'
const REPLY = '好，记下了。'

/**
 * U53 · **D33**——`--session <id>` 起来，**记录区一个字都不铺**。
 *
 * `cli.test.ts` 那两支验的是 `--check --session`（**非终端**：装配开局装载那条会话），
 * 而 U48 之后**终端那条路不再装配**——接续成了「窗口向管理者要那条会话的那一代」这件事。
 * 那一侧一直没人看着，D33 就是从这道缝里过去的（缺陷话：「这正是它漏掉的原因」）。
 *
 * 故这一支走**真终端那条路**（真 PTY · 真 `cli.ts` · 真管理者 · 真执行者），判三件：
 *
 * 1. **记录区铺出来**——那条会话现有的历史（原话 ＋ 回话）在屏上；
 * 2. **不是重跑**——模型一次都没被再问过（「查看不触发重新执行」的物证是调用数，不是屏）；
 * 3. **同一条会话只有一个执行者**——按实际进程数证（`pgrep`），不是看屏。
 *
 * ⚠️ **两扇窗借同一块沙地**（同一个 dataDir ⇒ 同一个管理者）：各开一块就成了两个互不
 * 相干的管理者，而「接的是**那一条**会话」这件事只有在同一摊上才成立。
 */
describe('U53 · `--session` 接续（真窗口）', () => {
  /** 一条有内容的会话，起起来（照产品的方式退出），再把它的 id 交回来。 */
  async function withContent(sandbox: Sandbox, fixture: ReturnType<typeof startFixture>): Promise<string> {
    const window = await createUiSession({ label: '第一程', sandbox, fixture })
    // **收过摊没有**——`close()` 没有二次调用守卫，收两遍会把现场再翻一次
    let shut = false

    try {
      await window.send(SAID, { until: { text: SAID }, timeoutMs: 15_000 })
      await window.key('enter')
      await window.wait({ text: REPLY }, { timeoutMs: 30_000 })
      // **闲下来再收**（忙的时候 ctrl+c 是中断不是退出，助手那句就落不了账）
      await window.wait({ text: '○ 空闲' }, { timeoutMs: 30_000 })

      await window.quit()
      const closed = await window.close({ graceMs: 8_000 })
      shut = true
      expect(closed.exit.by).not.toBe('sigkill') // 自己走的，不是被拔电
    } finally {
      if (!shut) await window.close().catch(() => {})
    }

    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      expect(db.sessions.length).toBe(1)
      return db.sessions[0]?.id ?? ''
    } finally {
      db.close()
    }
  }

  test('拿那条 id 起来——记录区铺出来，模型没被再问过，执行者只有一个', async () => {
    const runs = tempDir('magic-u53-session-runs-')
    // ⚠️ **锚要短**（窄窗 / 折行都不至于把它断开）：判据按**行**找
    const fixture = startFixture({ turns: [{ kind: 'text', text: REPLY }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      const id = await withContent(sandbox, fixture)
      expect(id).not.toBe('')
      expect(fixture.requests().length).toBe(1)

      window = await createUiSession({
        label: '第二程',
        artifacts: runs,
        sandbox,
        fixture,
        argv: ['--session', id],
      })

      // ① **记录区铺出来了**——那条会话现有的历史在屏上（D33 要的正是这一条）。
      //    ⚠️ 锚**回话那一行**：`SAID` 那句话在**状态行上本来就有一份**（标题＝首句），
      //    拿它当条件时，记录区一个字不铺它照样成立——那正是 D33 当初没被看见的原因
      //    （实测：修前跑这一支，等到 `SAID` 是过得去的、等到 `REPLY` 才卡住）。
      await window.wait({ text: REPLY }, { timeoutMs: 30_000 })
      // 而那条交代**铺在记录区里**（行首那个 `›`——状态行上没有它）
      const back = await window.capture({ label: '接续之后' })
      expect(back.lines.some((line) => line.includes(`› ${SAID}`))).toBe(true)

      // ② **不是重跑**：模型一次都没被再问过（物证是调用数，不是屏）
      expect(fixture.requests().length).toBe(1)

      // ③ **同一条会话只有一个执行者**——按实际进程数证（不是看屏）
      await waitFor('只剩一条执行者', async () => (await straysIn(sandbox)).executors.length === 1)

      const closed = await window.close({ graceMs: 8_000 })
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined

      // 窗口走了 ⇒ 那一代也收（没有连接者、手上也没事）
      await waitFor('执行者收掉', async () => (await straysIn(sandbox)).executors.length === 0, 20_000)
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)
})
