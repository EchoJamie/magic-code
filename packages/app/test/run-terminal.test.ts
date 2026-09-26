/** 真 PTY 客户端经专用 stdin 测试宿主接入；关闭窗口不结束 App 所属核心。 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPathsOf } from '../src/run/paths.ts'
import { readDatabase } from './support.ts'
import { createUiSession } from './ui/index.ts'
import type { Sandbox, UiSession } from './ui/index.ts'
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
      sandbox.dispose()
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
      sandbox.dispose()
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
      sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 90_000)

    test('悬着的裁决卡随轮收束作废——执行者可释放，核心只随宿主退出', async () => {
    const runs = runArtifacts('magic-u48-cancel-runs-')
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

      // **卡还挂着的时候中断这一轮**——答复永远不会来（那正是这个用例要的那条边）
      await window.key('ctrl+c')
      await window.wait({ text: '/ 命令 · ctrl+c 退出' }, { timeoutMs: 15_000 })

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
      sandbox.dispose()
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
      sandbox.dispose()
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
        sandbox.dispose()
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
      sandbox.dispose()
      if (process.env['MAGIC_CLI_EVIDENCE'] === undefined) removeDir(runs)
    }
  }, 120_000)
})
