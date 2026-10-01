/** 真 PTY 客户端经专用 stdin 测试宿主接入；关闭窗口不结束 App 所属核心。 */

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPathsOf } from '../src/run/paths.ts'
import { readDatabase } from './support.ts'
import { REPO_ROOT, createUiSession } from './ui/index.ts'
import type { Capture, Sandbox, UiSession } from './ui/index.ts'
import { createSandbox, startFixture } from './ui/index.ts'
import { removeDir, tempDir } from './tmp.ts'
import { startResidentHost } from './resident-host-fixture.ts'

function runArtifacts(prefix: string): string {
  const evidence = process.env['MAGIC_CLI_EVIDENCE']
  if (evidence === undefined) return tempDir(prefix)
  const path = join(evidence, `${prefix}${crypto.randomUUID()}`)
  mkdirSync(path, { recursive: true })
  return path
}

function pathsOf(sandbox: Sandbox): ReturnType<typeof runPathsOf> {
  return runPathsOf({ home: sandbox.home, base: join(sandbox.home, '.magic') }, sandbox.dataDir, tmpdir())
}

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

async function straysIn(sandbox: Sandbox): Promise<{ managers: string[]; executors: string[] }> {
  const proc = Bun.spawn(['pgrep', '-fl', sandbox.root], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  const lines = text.split('\n').filter((line) => line.trim() !== '')
    .map((line) => line.replace(/--token \S+/gu, '--token [test-token]'))

  return {
    managers: lines.filter((line) => line.includes('internal-manager')),
    executors: lines.filter((line) => line.includes('internal-executor')),
  }
}

describe('U48-S5 · 终端是客户端', () => {
  test('七个空白窗口连开再关——零 Session 零 Run、客户端退出、无残留', async () => {
    const runs = runArtifacts('magic-u48-seven-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '没人会看到这句' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
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

      expect((await straysIn(sandbox)).executors).toEqual([])

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

      // 视图全部关闭，App 所属核心仍在；只有测试宿主明确退出才收尾。
      expect(existsSync(paths.socket)).toBe(true)
      await host.close()
      await waitFor('宿主退出后核心收尾', () => !existsSync(paths.socket), 20_000)
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
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 120_000)

  test('`--session` 打错一个字母——经管理者那条路照样报错退场（不静默开一条空的）', async () => {
    const runs = runArtifacts('magic-u48-typo-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
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
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 60_000)

    test('配了连不上的外部工具：那句话在开屏上（管理者给的），而空窗口仍没有执行者', async () => {
    const runs = runArtifacts('magic-u48-preflight-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({
      baseURL: fixture.baseURL,
      config: { mcp: { servers: { broken: { command: '/nonexistent/mcp-server-for-u48' } } } },
    })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
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

      expect(existsSync(pathsOf(sandbox).socket)).toBe(true)
      await host.close()
      await waitFor('宿主退出后核心收尾', () => !existsSync(pathsOf(sandbox).socket), 20_000)
    } finally {
      await window?.close().catch(() => {})
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 90_000)

  /**
   * **卡挂着的那一轮被停掉之后，执行者要收得掉**（回归：漏一个永远收不掉的执行者）。
   *
   * 由头是**实测跑出来的**：裁决卡挂在半路、这一轮被中断时，**答复那一条事件
   * 不会来**——执行者若只按「请求／答复配对」记待答项，那一格就永远留着，而「有在途调用
   * 或待答项」是**不收**的一条判据 ⇒ 它就此钉在那儿，管理者也跟着不走。
   *
   * 口径与外壳那一侧**同一条**（`view.ts` 的 `turn.end`：「轮收束 ⇒ 悬着的裁决作废」）
   * ——故这里量的正是那条边界：**轮收束之后，那一格必须清掉**。
   *
   * ⚠️ **与「等待用户的有效工作可保留执行者」不冲突**：卡**还挂着**时这一轮没结束，
   * `turn.end` 不会来——保留照旧。这里停的是那一轮，卡已经作废了。
   *
   * ## U100 改判（原锚 / 为何变 / 新锚）
   *
   * - **原锚**：卡挂着时按 `ctrl+c` ⇒ 「替用户中断本轮」，等屏上回到空闲。
   * - **为何变**：U100 起有在途工作那一下**只把问题摆出来**（三选），不再替用户中断；
   *   用户在此刻停这一轮的入口是**三选里的「停止任务」**（默认第一项，回车即达）。
   * - **新锚**：卡挂着时 `ctrl+c` ⇒ 三选（标题「当前任务正在等待你」）⇒ 回车 ⇒
   *   **停止任务**（这条会话 · 整体那一档）⇒ 回执「停了」⇒ 客户端干净退场、零残留。
   *   判据本身（悬着的卡不许把执行者钉住、两组进程都要收干净）**一个字没松**。
   */
  test('悬着的裁决卡随轮收束作废——那一代执行者收得掉，管理者也跟着退', async () => {
    const runs = tempDir('magic-u48-cancel-runs-')
    // ⚠️ **原锚**：`exec echo hi`（判轻）；**为何变**（U76）：判轻的调用**默认通、不弹卡**
    // ——这一条要的正是一张**悬着的卡**，夹具换成**名单里**的删除（必问，且没人答它）；
    // **新锚**：卡落在**重**那一档，右位键位是 `y / n`（见下）。
    const fixture = startFixture({ turns: [{ kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '中断卡', artifacts: runs, sandbox, fixture })

      await window.send('跑一条命令')
      // 内置件走的是**名单里**的删除 ⇒ 重档键位（`y / n`）。⚠️ `HINT_DECIDE_HEAVY` **没出包**
      // （`@magic/tui` 只出去包的常量），故这里按**字面量**锚——与 `ui/scenarios.ts`
      // 里 `COPY.decideHint` 同一条先例：真要改那处文案，判据会红，那正是该有的反应。
      await window.key('enter', { until: { text: 'y / n' }, timeoutMs: 20_000 })

      // **卡还挂着的时候停这一轮**（U100 起这条路是「三选 → 停止任务」）——
      // 答复永远不会来（那正是这个用例要的那条边）
      await window.key('ctrl+c', { until: { text: '当前任务正在等待你' }, timeoutMs: 15_000 })
      await window.key('enter')
      // **核销那一拍的回执**（「停了」）——它是「资源确认退出了」的物证：
      // 悬着的那张卡随轮收束作废，而这一代执行者也就到此为止（卡若还钉着，收摊那两跳
      // 根本走不完——见本用例的由头）
      await window.wait({ text: '停了' }, { timeoutMs: 25_000 })

      const closed = await window.close()
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined

      await waitFor('无责任执行者释放', async () => (await straysIn(sandbox)).executors.length === 0, 20_000)
      expect(existsSync(pathsOf(sandbox).socket)).toBe(true)
      await host.close()
      await waitFor('宿主退出后核心收尾', () => !existsSync(pathsOf(sandbox).socket), 20_000)
      await Bun.sleep(500)
      expect(await straysIn(sandbox)).toEqual({ managers: [], executors: [] })
    } finally {
      await window?.close().catch(() => {})
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 90_000)

  test('终端断流——窗口自己退场，不留一个空转的后台', async () => {
    const runs = runArtifacts('magic-u48-drop-runs-')
    const fixture = startFixture({ turns: [] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
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
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 60_000)

  for (const leave of ['PTY EOF', 'SIGHUP', 'SIGTERM'] as const) {
    test(`${leave} 只脱离客户端——原模型请求在同代执行者完整完成`, async () => {
      const runs = runArtifacts('magic-hangup-model-')
      const answer = 'MODEL_BEFORE_DROP_A_MODEL_AFTER_DROP_B_'
      // 关窗时请求仍在流式；完整尾段和 settled 必须在客户端退出后落库。
      const fixture = startFixture({ turns: [{ kind: 'text', text: answer, chunks: 2, chunkDelayMs: 6_000 }] })
      const sandbox = createSandbox({ baseURL: fixture.baseURL })
      const host = await startResidentHost(sandbox, join(runs, 'host'))
      let window: UiSession | undefined
      const facts = () => {
        const db = readDatabase(join(sandbox.dataDir, 'records.db'))
        try { return { sessions: db.sessions, entries: db.entries, events: db.events } }
        finally { db.close() }
      }

      try {
        window = await createUiSession({ label: leave, artifacts: runs, sandbox, fixture })
        await window.send('关窗后继续这一轮')
        await window.key('enter')
        await window.wait({ text: 'MODEL_BEFORE_DROP_A_' }, { timeoutMs: 20_000 })
        await window.capture({ label: '模型在途，尚未关窗' })
        const before = { facts: facts(), processes: await straysIn(sandbox) }
        expect(before.processes.executors).toHaveLength(1)
        expect(before.facts.events.filter((event) => event.kind === 'turn.end')).toHaveLength(0)
        const pid = window.pid
        const at = Date.now()
        if (leave === 'PTY EOF') window.dropTerminal()
        else process.kill(pid, leave)
        // 保留 8 秒观察窗；不允许 driver 的 TERM/KILL 替产品收尾。
        const closed = await window.close({ graceMs: 8_000 })
        window = undefined
        const after = { facts: facts(), processes: await straysIn(sandbox) }
        writeFileSync(join(runs, 'departure.json'), JSON.stringify({ leave, pid, elapsedMs: Date.now() - at, exit: closed.exit, before, after }, null, 2))
        expect(closed.exit).toEqual({ code: 0, signal: null, by: 'app' })
        expect(after.facts.events.filter((event) => event.kind === 'turn.end')).toHaveLength(0)
        expect(after.processes.executors).toEqual(before.processes.executors)
        expect(existsSync(pathsOf(sandbox).socket)).toBe(true)
        await waitFor('关窗后原请求完整落账', () => facts().events.some((event) => event.kind === 'turn.end'), 20_000)
        const completed = facts()
        writeFileSync(join(runs, 'completed.json'), JSON.stringify({ facts: completed, requests: fixture.requests() }, null, 2))
        expect(completed.events.filter((event) => event.kind === 'turn.end').map((event) => JSON.parse(event.data).reason)).toEqual(['settled'])
        expect(completed.entries.filter((entry) => entry.kind === 'assistant').map((entry) => entry.content_text)).toEqual([answer])
        expect(fixture.requests()).toHaveLength(1)
        expect(completed.sessions).toHaveLength(1)
      } finally {
        await window?.close().catch(() => {})
        await host.close()
        await fixture.stop()
        await sandbox.dispose()
        if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
      }
    }, 60_000)
  }
})

const SAID = '记一句短话'
const REPLY = '好，记下了。'

describe('U53 · `--session` 接续（真窗口）', () => {
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

  test('拿那条 id 起来——记录区铺出来，模型没被再问过，观察不创建执行者', async () => {
    const runs = runArtifacts('magic-u53-session-runs-')
    // ⚠️ **锚要短**（窄窗 / 折行都不至于把它断开）：判据按**行**找
    const fixture = startFixture({ turns: [{ kind: 'text', text: REPLY }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    const host = await startResidentHost(sandbox, join(runs, 'host'))
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
      expect(back.lines.some((line) => line.includes(`› ${SAID}`)), back.lines.join('\n')).toBe(true)

      // ② **不是重跑**：模型一次都没被再问过（物证是调用数，不是屏）
      expect(fixture.requests().length).toBe(1)

      // ③ 完成会话的历史只读，接回不创建执行者。
      expect((await straysIn(sandbox)).executors).toHaveLength(0)

      const closed = await window.close({ graceMs: 8_000 })
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined

      // 窗口走了 ⇒ 那一代也收（没有连接者、手上也没事）
      await waitFor('执行者收掉', async () => (await straysIn(sandbox)).executors.length === 0, 20_000)
    } finally {
      await window?.close().catch(() => {})
      await host.close()
      await fixture.stop()
      await sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 120_000)
})


/**
 * U100 · **停止与后台续跑**（真窗口 · 真管理者 · 真执行者 · 真进程）。
 *
 * 这一组量的三件，都是「只有真进程说得清」的：
 *
 * | 那一趟 | 要看见什么 |
 * | --- | --- |
 * | **停掉之后接着交代** | **还是同一条会话**：库里那条没变、下一轮请求带着**上一轮的上下文** |
 * | **整体停掉** | 连那条**后台命令**一起收回（进程表上真没了） |
 * | **只剩后台命令** | `ctrl+c` 给的是**三选**（不是「再按一次退出」）——设计：「后台命令仍在执行……也属于有在途工作」 |
 */
/**
 * **把被折行的那一句接回一整行**（U100 取证用）——从含 `from` 的那一行起，把**续行**
 * （缩进两格、不带标记）一路接上；色码一并剥掉。
 *
 * ⚠️ 它是**取证的尺子**，不是产品行为：产品那边折行是 Ink 按终端宽度做的（真换行）。
 */
function joinWrapped(raw: string, from: string): string {
  const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/gu, '')
  const lines = raw.split(/\r?\n/u).map(strip)
  const at = lines.findIndex((line) => line.includes(from))
  if (at === -1) return ''

  let said = lines[at] ?? ''
  for (let next = at + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? ''
    if (!/^ {2}\S/u.test(line)) break
    said += line.trimStart()
  }

  return said
}

/**
 * **剥掉 SGR 色码**（取证用）——`\u001b[…m` 那几段；其余字节原样。
 *
 * 为什么不直接比字符串：这一条要量的正是**字节里有没有换行**（见那一处判据的注）。
 */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/gu, '')
}

describe('U100 · 停止、后台命令与接着交代（真窗口）', () => {
  /** 库里那一条会话（真会话才落账——首条消息提交之后）。 */
  function sessionIdOf(sandbox: Sandbox): string {
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      return db.sessions[0]?.id ?? ''
    } finally {
      db.close()
    }
  }

  /** 库里几条会话。 */
  function sessionCount(sandbox: Sandbox): number {
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    try {
      return db.sessions.length
    } finally {
      db.close()
    }
  }

  /**
   * **整体停掉那一条**（三选的默认项）。
   *
   * ⚠️ 等的是**回执「停了」**（核销那一拍）——不是「正在停」（受理）。两拍分得开是本单
   * 那一条「不伪报已停止」的落点。
   */
  async function stopAndStay(window: UiSession): Promise<void> {
    await window.key('ctrl+c', { until: { text: '当前任务' }, timeoutMs: 15_000 })
    await window.key('enter')
    await window.wait({ text: '停了' }, { timeoutMs: 30_000 })
  }

  test('整体停掉之后接着交代——**还是同一条会话**（记录与上下文都续着）', async () => {
    const runs = tempDir('magic-u100-continue-runs-')
    const fixture = startFixture({
      turns: [
        { kind: 'text', text: '第一句答复。' },
        { kind: 'text', text: '第二句答复。' },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '停后续聊', artifacts: runs, sandbox, fixture })

      await window.send('第一句', { until: { text: '第一句' }, timeoutMs: 10_000 })
      await window.key('enter', { until: { text: '第一句答复。' }, timeoutMs: 25_000 })
      // ⚠️ **等那一轮真收完**（屏上回空闲）再停：话刚说完那一刻这一轮还没落账，停它会把
      // 半截流式消息按设计丢掉（`agent-loop` 的中断语义）——那不是这一条要量的事
      await window.wait({ text: '○ 空闲' }, { timeoutMs: 25_000 })
      const first = sessionIdOf(sandbox)
      expect(first).not.toBe('')

      await stopAndStay(window)

      // **界面留下**：输入行照旧，接着交代
      await window.send('第二句', { until: { text: '第二句' }, timeoutMs: 10_000 })
      await window.key('enter', { until: { text: '第二句答复。' }, timeoutMs: 30_000 })
      const after = await window.capture({ label: '停完之后接着交代' })

      // ① **同一条会话**（不是悄悄开了一条新的）
      expect(sessionCount(sandbox)).toBe(1)
      expect(sessionIdOf(sandbox)).toBe(first)
      // ② 记录接着（两句都在屏上）
      expect(after.lines.some((line) => line.includes('第一句答复。'))).toBe(true)
      expect(after.lines.some((line) => line.includes('第二句答复。'))).toBe(true)
      // ③ **上下文接着**：第二轮请求带着上一轮的对话（不是从空白重来）
      const last = fixture.requests().at(-1)
      expect(last?.messages ?? 0).toBeGreaterThanOrEqual(4)

      await window.quit()
      const closed = await window.close({ graceMs: 5_000 })
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  test('整体停掉 —— 连那条**后台命令**一起收回（真进程）', async () => {
    const runs = tempDir('magic-u100-bgstop-runs-')
    // 一条**只有我们能认出来**的命令（号是唯一的，按它找进程）
    // ⚠️ **标记要落在进程自己的命令行里**，故做成 sleep 的**时长**（小数位是随机的）：
    // 写成 shell 注释（`sleep 321 # mark`）会被 sh 吃掉，而 `sh -c` 还会把自己 exec 成
    // `sleep`——那时进程表上只剩 `sleep 321`，标记一个字都不剩（实测栽过）。
    const MARK = `321.${Math.floor(Math.random() * 900_000) + 100_000}`
    const fixture = startFixture({
      turns: [
        { kind: 'tool', name: 'exec', args: { cmd: `sleep ${MARK}`, background: true } },
        { kind: 'text', text: '交出去了。' },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '停后台', artifacts: runs, sandbox, fixture })

      await window.send('起一条后台命令', { until: { text: '起一条后台命令' }, timeoutMs: 10_000 })
      await window.key('enter', { until: { text: '交出去了。' }, timeoutMs: 30_000 })

      // **那一组真站起来了**（先确认它起得来——否则「停掉了」是空判）
      await waitFor('那条后台进程站起来', async () => (await pidsOf(MARK)).length > 0, 20_000)

      await stopAndStay(window)

      // **收回去了**（有界等——收尾那条路是 TERM → 等 → KILL → 等）
      await waitFor('那条后台进程被收回', async () => (await pidsOf(MARK)).length === 0, 30_000)

      const closed = await window.close({ graceMs: 5_000 })
      expect(closed.exit.by).not.toBe('sigkill')
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      // 兜底：万一没收回（判据已经红了），别把一条 `sleep 321` 留在机器上
      for (const pid of await pidsOf(MARK)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已经没了
        }
      }
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  /**
   * **同一份交代里「模型 → 工具 → 模型」——菜单照旧停得掉**（U100 · 规划裁决）。
   *
   * 边界是**一份交代**，不是**一轮**：一轮 ＝ 一次模型调用 ＋ 它请求的工具（`agent-loop.ts`），
   * 而一份输入要跑好几轮。故「工具跑完、下一轮又起来」那一刻菜单**绝不能失效**——那正是
   * 用户按 `ctrl+c` 想停的那件事的中间。这一条走真链路（真轮次、真 `turn.end`）：
   *
   * ① 工具**正在跑**时开菜单 → ② 它跑完、这一轮收束、下一轮起来（真事件） →
   * ③ 回车 ⇒ **停止照旧发出去**（回执「正在停」为证）。
   */
  test('同一份交代「模型 → 工具 → 模型」——菜单照旧停得掉（不把内部模型轮当任务边界）', async () => {
    const runs = tempDir('magic-u100-rounds-runs-')
    const fixture = startFixture({
      turns: [
        // ① 一件**要跑一会儿**的工具（好让菜单开在「它正跑着」那一刻）
        { kind: 'tool', name: 'exec', args: { cmd: 'sleep 1.2; echo 看完了' } },
        // ② 第二轮的正文**慢慢长**（这样还能看见「第二轮真起来了」）
        { kind: 'text', text: '看完了，接着做。', chunks: 40, chunkDelayMs: 400 },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '轮间菜单', artifacts: runs, sandbox, fixture })

      await window.send('看一眼', { until: { text: '看一眼' }, timeoutMs: 10_000 })
      await window.key('enter')
      // ① 工具**正在跑**时开菜单：那一行一上屏就是「跑着」那一态（它跑 1.2 秒，这一段抓得住）。
      //    ⚠️ **U112**：工具行的记号换成 `▸`（身份在行首），「跑到哪一步」那一位挪到了
      //    **行尾**（跑着＝弱色 `●`，落定＝`✓` / `×` / `!`）——原先那个 `⟳`（运行中记号）
      //    没有了。故锚仍**钉住「跑着」这一态**（不是只钉「那一行在」）：`▸` 起头
      //    且行尾是运行位 `●`。判的那件事一字未变——菜单开在**它还在跑**的那一刻。
      await waitFor(
        '工具那一行上了屏、且正跑着（`▸` 起头、行尾是运行位 `●`）',
        async () => {
          if (window === undefined) return false
          const shot = await window.screen()

          return shot.lines.some(
            (line) => line.text.trimStart().startsWith('▸') && line.text.trimEnd().endsWith('●'),
          )
        },
        20_000,
      )
      await window.key('ctrl+c', { until: { text: '当前任务' }, timeoutMs: 15_000 })

      // ② 它跑完 → 这一轮收束 → 下一轮起来（真事件：`turn.end` 之后又 `turn.start`）
      await window.wait({ text: '看完了，接着做。' }, { timeoutMs: 40_000 })

      // ③ 回车 ⇒ **停得掉**（若拿「轮」当边界，这一下会被守护挡下——那正是本条的判据）
      await window.key('enter')
      await window.wait({ text: '正在停' }, { timeoutMs: 20_000 })
      const stopped = await window.capture({ label: '轮间停掉' })
      keepShot(stopped)
      expect(stopped.lines.some((line) => line.includes('正在停'))).toBe(true)

      await window.close({ graceMs: 5_000 })
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  /**
   * **接回入口要真敲得响**（U100 · 设计「按实际配置保留必要启动参数」）——
   * **非默认落点**那一形：把屏上印的那一行**原样取下来、真敲一遍**，接回**同一个库**。
   *
   * 为什么非要用非默认落点走一遍：默认那一形（`magic --session <id>`）在换了终端之后
   * 仍然落在 `~/.magic`，**看不出差别**；而 `MAGIC_HOME` 指向别处时，少了那个前缀就会
   * 接到另一个库（会话不在）。故这一条：
   *
   * ① 起一扇窗，`MAGIC_HOME` 指向**沙地里的另一处**（配置抄一份过去）；
   * ② 从「转到后台」那一刻的屏上**取出**那一行（`接回来：` 之后那一段就是用户要复制的）；
   * ③ 造一个 `magic` 可执行（PATH 里的 shim，转真的 `cli.ts`），**`sh -c` 原样跑它**；
   * ④ 判据：接回**同一条会话**（记录区铺着原来那一句）· 模型**没被再问一遍**。
   */
  test('转后台留的接回入口：**照那一行真敲一遍**，接回同一个库（非默认 `MAGIC_HOME`）', async () => {
    const runs = tempDir('magic-u100-resume-runs-')
    const fixture = startFixture({ turns: [{ kind: 'text', text: '第一句答复。' }] })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let first: UiSession | undefined
    let second: UiSession | undefined

    try {
      // ① **非默认落点，但同一个数据实例**（U109 按设计收窄后的口径）：
      //    `MAGIC_HOME` 指到别处（`$MAGIC_HOME/.magic` ≠ 家目录下那一个），
      //    而那一份配置里的 **`dataDir` 与 App 的一致** ⇒ 它就是**同一个数据实例**，
      //    应当照常接回。
      //
      //    原预期 → 新预期：原来是「`MAGIC_HOME` 与 `dataDir` **两处都**换成别的、
      //    仍然接得上」；现在是「**换了 `MAGIC_HOME`、但 `dataDir` 一致**才接得上」。
      //    依据：`设计/会话与运行管理`「常驻方案的生产 App 同时承载一个选定数据实例；
      //    **CLI 显式目录须与之匹配**」——守卫比的是**数据实例（`dataDir`）**，
      //    **基础目录不在其列**（它管配置/授权/技能，不是那份数据）。
      //    非法那一半（`dataDir` 不同 ⇒ 拒绝）另立一条用例，见下。
      const alt = join(sandbox.root, 'alt-home')
      mkdirSync(join(alt, '.magic'), { recursive: true })
      const config = JSON.parse(readFileSync(join(sandbox.home, '.magic', 'config.json'), 'utf8')) as Record<string, unknown>
      writeFileSync(
        join(alt, '.magic', 'config.json'),
        JSON.stringify(config, null, 2),
        'utf8',
      )

      first = await createUiSession({
        label: '接回入口', artifacts: runs, sandbox, fixture, env: { MAGIC_HOME: alt },
      })
      await first.send('第一句', { until: { text: '第一句' }, timeoutMs: 10_000 })
      await first.key('enter', { until: { text: '第一句答复。' }, timeoutMs: 25_000 })
      await first.wait({ text: '○ 空闲' }, { timeoutMs: 25_000 })
      const asked = fixture.requests().length

      // ② 转后台 ⇒ 那一行上屏
      await first.key('ctrl+c', { until: { text: '当前任务' }, timeoutMs: 15_000 })
      await first.key('down')
      await first.key('enter')
      await first.wait({ text: '接回来：' }, { timeoutMs: 10_000 })
      const shown = await first.capture({ label: '转后台留的接回入口（非默认 MAGIC_HOME）' })

      // ⚠️ **这一句超过终端宽度时 Ink 会折行**（真换行 ＋ 续行缩进两格）——照屏上那一行取，
      //    取到的是**前 100 列**（实测：前半截看着对、路径被腰斩）。故先把折行接回去
      //    （`joinWrapped`），拿到的就是**那一条逻辑行**。
      //    ⚠️ 折行本身是**产品的一条限度**：路径长过终端宽度时，整段复制会把换行带进去
      //    （短路径不受影响）——记在回报的「未验 / 限度」里。
      const copy = joinWrapped(first.rawText(), '接回来：').split('接回来：')[1] ?? ''
      // 原预期 → 新预期：原来比的是**字面**路径（测试给的 `/var/folders/…`），现在比**规范化后**
      // 的路径（`/private/var/folders/…`）。依据：协作线的 `host-discovery`（`normalizeDataDir`）
      // ——同一份代码里 socket 路径也按规范化取键（「两个写法必须落在同一把锁上」）。
      // **没变弱**：判据仍是「那一行必须带上 `MAGIC_HOME` 且指向 alt」，
      // 只是把「字面相同」换成「**指向同一个目录**」——后者更强（认的是目录，不是写法）。
      expect(copy).toContain(`MAGIC_HOME='${realpathSync(alt)}'`) // 非默认落点：**必须带上它**
      expect(copy).toContain('magic --session ')

      // ③ **它得是「屏上原样可复制」的一条**（规划裁决点名的那一条）——
      //    判据**落在字节上**，不是靠测试把这行接回来：
      //    这一句**不进记录区**（那里的行由 `log.ts` 按列数**硬折行**——真换行，复制到的东西
      //    里带着换行 ＋ 续行缩进，粘进终端就断成两条），而是由 `app.ts` **直接写字节**出去、
      //    交给**终端软折行**（软折行在终端看来仍是同一逻辑行 ⇒ 整行选中复制拿到的是完整的）。
      //    故这里要证的是：**那一串字节里没有换行**（`\n` 之前就是整条命令）。
      const stream = first.rawText()
      const at = stream.lastIndexOf("MAGIC_HOME='")
      const bytes = stream.slice(at, stream.indexOf('\n', at))
      // **两个都要**：① 那一段字节里没有换行（真折行的话这里就有）；
      // ② 剥掉色码之后**就是那整条命令**（末尾那格是 Ink 的收尾样式，`trimEnd` 掉）
      expect(bytes).not.toContain('\n')
      expect(stripAnsi(bytes).trimEnd()).toBe(copy)
      expect(shown.text).toContain('转到后台了 · 接回来：') // 而屏上（可见的那些行）照旧有它

      const gone = await first.close({ graceMs: 8_000 })
      expect(gone.exit.by).toBe('app')
      // **走了之后那一行还在屏上**（用户就是在这时候去复制它的）——它写在那一帧**之上**，
      // Ink 收摊擦的是它自己那一帧，不碰已经写出去的那一行
      const afterExit = await first.capture({ label: '退出之后那一行还在' })
      expect(afterExit.lines.some((text) => text.includes('magic --session'))).toBe(true)
      first = undefined

      // ③ 造一个 `magic`（PATH 里的 shim ⇒ 真的那个 cli.ts），**把那一行原样交给 sh**
      const bin = join(sandbox.root, 'bin')
      mkdirSync(bin, { recursive: true })
      const shim = join(bin, 'magic')
      writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} ${join(REPO_ROOT, 'packages/app/src/cli.ts')} "$@"\n`, 'utf8')
      chmodSync(shim, 0o755)

      // ⚠️ **这一扇窗的底环境里没有 `MAGIC_HOME`**（「复制到另一个终端」的原样）：
      //    它按默认落点走（家目录下那一份配置 ⇒ 另一个库）。**不带它，判据才成立**——
      //    底环境里也塞一个 `MAGIC_HOME` 的话，命令里那一段前缀就算失效也照样接得上
      //    （环境把它兜住了，实测被点出来过）。
      //
      // ⚠️ **原先这里有一道「那个默认库里必须没有这条会话」的前置**（用来排除「接上的其实是
      //    别处的同一条」）。U109 收窄守卫之后**它不再成立也不需要**：`alt` 与 App
      //    **同一个 `dataDir`** ⇒ 本来就是**同一个数据实例**，谈不上「别处」。
      //    它原来守的那件事（**不匹配的目录要拒绝**）现在由**守卫自己**承担，
      //    并另立一条用例（见本文件「数据实例不匹配 ⇒ 拒绝」）。

      second = await createUiSession({
        label: '照那一行接回来',
        artifacts: runs,
        sandbox,
        fixture,
        command: ['sh', '-c', copy],
        env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` },
        skipReady: true,
      })

      // ④ **接回同一条会话**（记录区铺着原来那一句）
      await second.wait({ text: '第一句答复。' }, { timeoutMs: 30_000 })
      const back = await second.capture({ label: '照那一行接回来的那一屏' })
      expect(back.lines.some((text) => text.includes('› 第一句'))).toBe(true)
      // **查看不触发重新执行**：模型一次都没被再问（物证是调用数，不是屏）
      expect(fixture.requests().length).toBe(asked)

      await second.quit()
      await second.close({ graceMs: 5_000 })
      second = undefined

      // ⚠️ **原先这里还有一条反面**：同一条命令**摘掉 `MAGIC_HOME=` 前缀**，在那个默认库上
      //    接不上——它守的是「④接上了是**那一段前缀**挣来的」。收窄守卫之后这条**不成立**：
      //    `alt` 与 App 同一个 `dataDir`，前缀摘掉接的也还是**同一个数据实例**。
      //    它原先的「反面」角色由**新立的那条**（`dataDir` 不同 ⇒ 守卫拒绝，且带改前红）接过，
      //    那条比它更直：不再靠「前缀在不在」间接证明，而是直接判「不匹配的目录一律拒绝」。
    } finally {
      await first?.close().catch(() => {})
      await second?.close().catch(() => {})
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  /**
   * **首条消息刚发出去就选「转到后台」**（U100 · 规划裁决点出的竞态）。
   *
   * 那一刻外壳手上**还没有会话 id**（`session.state` 那一声答复没到）。这一档**不许**
   * 当场走掉、还留一句「没有可接的入口」：要**先等在界面上**，认出来再走、写**真命令**。
   */
  test('首条输入刚发出就选「转到后台」——**等会话认出来再走**，写的是真命令', async () => {
    const runs = tempDir('magic-u100-earlybg-runs-')
    // 第一轮**慢慢长**：会话一定在它收场之前就落成（判据才确定）
    const fixture = startFixture({
      turns: [{ kind: 'text', text: '这一句会慢慢长出来：先是一半，然后才是另一半。', chunks: 40, chunkDelayMs: 500 }],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '刚发出就转后台', artifacts: runs, sandbox, fixture })

      // 发出去就按（**不等会话落成**）——但**要等那一轮真跑起来**：状态还没翻成「工作中」
      // 之前，`ctrl+c` 走的是**空闲**那条路（挂「再按一次 ctrl+c 退出」），压根不开菜单。
      // 实测过那一档（0/30/60/120ms 各按一次，四次都是空闲那条路；到 200ms 菜单才开，
      // 而那时会话 id 也已经到了）——**「菜单开着而会话还没认出来」那一格比一帧还窄**，
      // 真跑上按不出来，故它由 `spec.u100` 那两条**单元**判据钉着（同一段代码）。
      await window.send('长话', { until: { text: '长话' }, timeoutMs: 10_000 })
      await window.key('enter')
      await window.wait({ text: 'ctrl+c 停或离开' }, { timeoutMs: 15_000 })
      await window.key('ctrl+c', { until: { text: '当前任务' }, timeoutMs: 15_000 })
      await window.key('down')
      await window.key('enter')

      const closed = await window.close({ graceMs: 10_000 })
      expect(closed.exit.by).toBe('app') // 自己走的
      const raw = window.rawText()
      window = undefined

      // **写的是真命令**（带着那一条会话的 id），不是「没有可接的入口」那一句
      const id = sessionIdOf(sandbox)
      expect(id).not.toBe('')
      expect(raw).toContain(`magic --session ${id}`)
      expect(raw).not.toContain('没有可接的入口')
    } finally {
      await window?.close().catch(() => {})
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)

  test('只剩后台命令 ⇒ `ctrl+c` 给的是**三选**（不在跑模型、也不在跑工具）', async () => {
    const runs = tempDir('magic-u100-bgmenu-runs-')
    const MARK = `322.${Math.floor(Math.random() * 900_000) + 100_000}`
    const fixture = startFixture({
      turns: [
        { kind: 'tool', name: 'exec', args: { cmd: `sleep ${MARK}`, background: true } },
        { kind: 'text', text: '交出去了。' },
      ],
    })
    const sandbox = createSandbox({ baseURL: fixture.baseURL })
    let window: UiSession | undefined

    try {
      window = await createUiSession({ label: '只剩后台', artifacts: runs, sandbox, fixture })

      await window.send('起一条后台命令', { until: { text: '起一条后台命令' }, timeoutMs: 10_000 })
      await window.key('enter', { until: { text: '交出去了。' }, timeoutMs: 30_000 })
      await waitFor('那条后台进程站起来', async () => (await pidsOf(MARK)).length > 0, 20_000)

      // ⚠️ **等不了「○ 空闲」**——U100 起，只剩后台命令那一形在运行事实里**就是「执行中」**
      // （设计：「后台命令仍在执行……也属于有在途工作」）。故这一趟等的锚换成那两件**真事**：
      // 这一轮收完了（助手那句答复在屏上）＋ **没有工具在跑**。
      // ⚠️ **U112**：「没有工具在跑」原先看的是「没有 `⟳` 那行」；那个记号随 U112 消失，
      // 行尾那一位接手（跑着＝`●`、落定＝`✓`）——故改看「没有哪条 `▸` 行的行尾还挂着 `●`」。
      // 「这一轮收完了」原先看「结果行有 `✓`」，那一半照旧（`✓` 现在在头一行行尾）。
      const settled = await window.capture({ label: '只剩后台命令（这一轮已收）' })
      keepShot(settled)
      expect(settled.lines.some((line) => line.includes('交出去了。'))).toBe(true)
      expect(
        settled.lines.some((line) => line.trimStart().startsWith('▸') && line.trimEnd().endsWith('●')),
      ).toBe(false)
      expect(settled.lines.some((line) => line.includes('✓'))).toBe(true)

      await window.key('ctrl+c', { until: { text: '当前任务' }, timeoutMs: 15_000 })
      const menu = await window.capture({ label: '只剩后台命令时的三选' })
      keepShot(menu)
      expect(menu.lines.some((line) => line.includes('当前任务仍在运行'))).toBe(true)
      expect(menu.lines.some((line) => line.includes('停止任务'))).toBe(true)
      expect(menu.lines.some((line) => line.includes('再按一次 ctrl+c 退出'))).toBe(false)
      // 状态行**左位照旧报「工作中」**（运行事实说这条会话还有活在跑——它没在跑模型、
      // 也没在跑工具，可那条后台命令还站着）；右位此刻归那一屏自己（键位提示）
      const status = menu.lines.find((line) => line.includes('工作中')) ?? ''
      expect(status).toContain('● 工作中')

      // 收尾：**走「转到后台」那扇门**（不是 `quit()`——它等「○ 空闲」，而后台命令还在跑，
      // 那条会话照旧是「执行中」）。这一支只离开界面，那条命令照旧留着（下面兜底收掉）
      await window.key('down')
      await window.key('enter')
      const left = await window.close({ graceMs: 8_000 })
      expect(left.exit.by).toBe('app')
      window = undefined
    } finally {
      await window?.close().catch(() => {})
      for (const pid of await pidsOf(MARK)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 已经没了
        }
      }
      await fixture.stop()
      await sandbox.dispose()
      removeDir(runs)
    }
  }, 120_000)
})

/** 命令行里带那一段的进程号（`pgrep -f` 按整条命令行找——那一段是随机的，撞不上别人的）。 */
async function pidsOf(mark: string): Promise<readonly number[]> {
  const proc = Bun.spawn(['pgrep', '-f', mark], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  return text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

/** 留一屏（这一支的帧与 `frames-u100-tui.ts` 同一形制）。 */
function keepShot(shot: Capture): void {
  const root = process.env['U100_SHOT_DIR']
  if (root === undefined) return
  writeFileSync(join(root, `${shot.label}.txt`), `${shot.text}\n`, 'utf8')
}
