import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import type { KernelEvent, RunNotice, NativeResponse } from '@magic/contracts'
import { connectManager } from '../src/run/client.ts'
import type { ManagerClient } from '../src/run/client.ts'
import { createAgentLauncher } from '../src/run/launch.ts'
import { startManager } from '../src/run/manager.ts'
import type { Manager } from '../src/run/manager.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { removeDir, tempDir } from './tmp.ts'
import { startFixture, type Fixture, type FixtureTurn } from './ui/fixture.ts'
import { attentionFacts } from './resident-attention-fixture.ts'

/** 一块沙地——形制与 `run-manager.test.ts` 那一处同（两处各是一片独立沙地，不共用状态）。 */
type Ground = {
  readonly root: string
  readonly magic: { readonly home: string; readonly base: string }
  readonly dataDir: string
  readonly tmp: string
  readonly ws: string
  readonly fixture: Fixture
  readonly environment: Record<string, string>
  dispose(): Promise<void>
}

function ground(name: string, mode: 'held' | 'settled' | 'background' | 'background-finish' = 'held', turns?: readonly FixtureTurn[]): Ground {
  const root = tempDir(`magic-exec-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = base
  const ws = join(root, 'ws')
  for (const dir of [home, base, dataDir, ws]) mkdirSync(dir, { recursive: true })

  // 真执行者只连接本机受控模型；待答命令绝不批准，不产生工具副作用。
  const complete = { kind: 'text' as const, text: '核心隔离回合完成', chunks: 1, chunkDelayMs: 0 }
  const fixture = startFixture({ turns: turns ?? (mode.startsWith('background')
    ? [{ kind: 'tool', name: 'exec', args: { cmd: mode === 'background-finish' ? 'sleep 1.5' : 'sleep 300', background: true } }, complete]
    : [mode === 'settled' ? complete : { kind: 'tool', name: 'exec', args: { cmd: 'chmod 755 .' } }]),
  })
  const environment: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), HOME: home, MAGIC_HOME: base }
  for (const key of Object.keys(environment)) if (/^MAGIC_.*_API_KEY$/.test(key)) environment[key] = ''
  writeFileSync(
    join(base, 'config.json'),
    JSON.stringify({
      models: {default: {provider: "x", model: 'm'}, cantrip: {provider: "x", model: 'm'}, spell: {provider: "x", model: 'm'}, arcane: {provider: "x", model: 'm'}},
      providers: { x: { vendor: 'minimax', baseURL: fixture.baseURL, apiKey: 'sk-test' } },
      dataDir,
    }),
  )

  return {
    root,
    fixture,
    environment,
    magic: { home, base },
    dataDir,
    // **系统临时目录当第二落点**（见 `paths.ts` 的 `runPathsOf`）：socket 路径有
    // 104 字节的硬上限，而沙地本身已经在 `/var/folders/…` 底下七十几个字符了——
    // 拿沙地当那个「短路径」会当场撞上（第一版就是这么红的两条）。
    tmp: tmpdir(),
    ws,
    dispose: async () => {
      await fixture.stop()
      // 运行目录可能在沙地外那一支（上面那个 fallback），一并收掉
      removeDir(runPathsOf({ home, base }, tmpdir()).dir)
      removeDir(root)
    },
  }
}

/** 立一个管理者——收尾挂在 `finally` 里（见各条用例），免得留一个占着路径的进程。 */
async function standUp(g: Ground, overrides: Record<string, unknown> = {}): Promise<Manager> {
  const started = await startManager({
    paths: runPathsOf(g.magic, g.tmp),
    magic: g.magic,
    launch: createAgentLauncher(),
    ...overrides,
  })
  if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)

  return started.manager
}

/** 连一个窗口上去。 */
async function open(g: Ground, manager: Manager, label: string): Promise<ManagerClient> {
  const client = await connectManager(manager.socketPath, { cwd: g.ws, label, environment: g.environment })
  if (client === undefined) throw new Error('连不上管理者')
  return client
}

/** 等一个条件成立（默认给 10 秒）——轮询是**用例**的事，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(20)
  }
}

/** 拒收当场报红；接收成功后继续原判据，两条分支共用原来的等待时限。 */
async function submitAndWait(client: ManagerClient, text: string, what: string, ok: () => boolean): Promise<void> {
  const ref = crypto.randomUUID()
  let settled: Extract<KernelEvent, { kind: 'input.settled' }> | undefined
  client.onEvent(event => {
    if (event.kind === 'input.settled' && event.data.ref === ref) settled = event
  })
  client.send({ type: 'input.submit', text, ref })
  await waitFor(what, () => settled !== undefined && (!settled.data.ok || ok()))
  expect(settled?.data.ok, JSON.stringify(settled)).toBe(true)
}

/** 这一条进程还在不在——`kill(pid, 0)` 是既有装置里那把尺子（`bench-pty.test.ts` 同此）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('会话身份与启动失败回归', () => {
  test('清空只解除目标；首次输入落账，空闲重启接续同一会话，清空后输入另建会话', async () => {
    const complete = { kind: 'text' as const, text: '完成', chunks: 1, chunkDelayMs: 0 }
    const g = ground('identity', 'settled', [complete, complete, complete])
    const manager = await standUp(g)
    const client = await open(g, manager, 'identity')
    const records = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
    const states: string[] = []
    const targets: (string | null)[] = []
    let completed = 0
    client.onTarget(session => targets.push(session))
    client.onEvent(event => {
      if (event.kind === 'session.state') states.push(event.data.active)
      if (event.kind === 'turn.end' && event.data.reason === 'settled') completed++
    })
    try {
      client.send({ type: 'session.new' })
      await waitFor('新对话回执', () => states.at(-1) === '')
      expect(manager.executors()).toHaveLength(0)
      expect(await records.listSessions()).toHaveLength(0)
      expect(g.fixture.requests()).toHaveLength(0)
      await submitAndWait(client, '第一条', '首轮完成并退出', () => completed === 1 && manager.executors().length === 0)
      const first = targets.at(-1)
      expect(first).toBeString()
      expect((await records.listSessions()).map(session => session.id)).toEqual([first!])
      await submitAndWait(client, '继续原会话', '第二轮完成并退出', () => completed === 2 && manager.executors().length === 0)
      expect(targets.at(-1)).toBe(first)
      expect(await records.listSessions()).toHaveLength(1)
      states.length = 0
      client.send({ type: 'session.new' })
      await waitFor('清空回执', () => states.at(-1) === '')
      expect(targets.at(-1)).toBeNull()
      expect(manager.executors()).toHaveLength(0)
      expect(await records.listSessions()).toHaveLength(1)
      await submitAndWait(client, '新对话首条', '新对话完成并退出', () => completed === 3 && manager.executors().length === 0)
      expect(targets.at(-1)).not.toBe(first)
      expect(await records.listSessions()).toHaveLength(2)
      expect(g.fixture.requests().filter(request => request.path.endsWith('/chat/completions'))).toHaveLength(3)
    } finally {
      client.close(); manager.stop('测试结束'); await manager.waitUntilExit()
      records.close(); await g.dispose()
    }
  }, 30_000)

  test('装配失败向所属窗口返回具体原因，不创建不可恢复的会话', async () => {
    const g = ground('assembly-failure', 'settled')
    const manager = await standUp(g)
    const client = await open(g, manager, 'failure')
    const records = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
    const lines: string[] = []
    let detached = false
    client.onLine(line => lines.push(line))
    client.onDetached(() => { detached = true })
    try {
      writeFileSync(join(g.magic.base, 'config.json'), '{ invalid config')
      client.send({ type: 'input.submit', text: '不能丢掉的输入', ref: 'first' })
      await waitFor('失败原因与退出回执', () => detached && lines.some(line => line.includes('装配没成：')))
      expect(lines.find(line => line.includes('装配没成：'))).not.toBe('装配没成：')
      expect(manager.executors()).toHaveLength(0)
      expect(await records.listSessions()).toHaveLength(0)
      expect(g.fixture.requests()).toHaveLength(0)
    } finally {
      client.close(); manager.stop('测试结束'); await manager.waitUntilExit()
      records.close(); await g.dispose()
    }
  }, 15_000)
})

describe('U48-S2 · 一个窗口一条执行者', () => {
  test('七个窗口各开一条新的——七代各自独立，停一项不影响其它', async () => {
    const g = ground('seven')
    const manager = await standUp(g)
    const clients: ManagerClient[] = []

    try {
      for (let i = 0; i < 7; i += 1) {
        const client = await open(g, manager, `w${i}`)
        clients.push(client)
        client.send({ type: 'input.submit', text: `受控待答 ${i}` })
      }

      await waitFor('七个执行者都起来', () => manager.executors().length === 7)
      // **等它们各自把会话认出来**再读——那一格是事件到达才填的，早读一步读到的是
      // 一排 `null`（它们是七个**还没开张**的执行者，各自等着自己那一条首条消息）
      await waitFor('七条都真在等待审批', () => manager.runs().filter((one) => one.state === 'waiting').length === 7)

      const live = manager.executors()
      // **七代各是各的**——号不重、进程不重、会话不重
      expect(new Set(live.map((one) => one.gen)).size).toBe(7)
      expect(new Set(live.map((one) => one.session)).size).toBe(7)

      // ——停一项——
      const victim = live[3]!
      clients[3]!.stop(victim.session!, 'run')

      await waitFor('被停的那一代核销掉', () => manager.executors().length === 6)
      // 其余六项**一个都不动**（号还是原来那六个）
      expect(new Set(manager.executors().map((one) => one.gen))).toEqual(
        new Set(live.filter((one) => one.gen !== victim.gen).map((one) => one.gen)),
      )
      // 而且它们还真的在跑——不是「表里还在、进程没了」
      for (const one of manager.executors()) {
        expect(manager.runs().find(row => row.session === one.session)?.state).toBe('waiting')
      }
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)

  test('同时重连同一会话——只有一个执行者', async () => {
    const g = ground('reconnect')
    const manager = await standUp(g)
    const clients: ManagerClient[] = []

    try {
      const session = '11111111-2222-3333-4444-555555555555'

      const first = await open(g, manager, 'a')
      clients.push(first)
      const records = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
      records.setSessionTitle(session, '并发接回', Date.now())
      records.close()
      first.send({ type: 'session.open', session })
      await submitAndWait(first, '受控待答', '第一代待答', () => manager.runs().some((row) => row.session === session && row.state === 'waiting'))
      const original = manager.executors()[0]!

      // ——同时——（两个窗口在同一刻发同一条 open，不是「一个接一个看它接得上」）
      const second = await open(g, manager, 'b')
      const third = await open(g, manager, 'c')
      clients.push(second, third)
      second.send({ type: 'session.open', session })
      third.send({ type: 'session.open', session })

      await Bun.sleep(800)

      // **只有一代，且就是原来那一代**——没有为「重连」另起第二个
      const live = manager.executors()
      expect(live.length).toBe(1)
      expect(live[0]?.session).toBe(session)
      expect(live[0]?.gen).toBe(original.gen)
      expect(g.fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))).toHaveLength(1)

      // 三条连接都指着同一代（`target` 那一条说的就是它）
      for (const client of clients) expect(client.gen()).toBe(live[0]?.gen ?? null)
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)

  test('切到另一条会话＝换一代，而原来那一代照跑', async () => {
    const g = ground('switch', 'background')
    const manager = await standUp(g)
    const clients: ManagerClient[] = []

    try {
      const client = await open(g, manager, 'a')
      clients.push(client)
      let completed = 0
      client.onEvent((event) => { if (event.kind === 'turn.end' && event.data.reason === 'settled') completed += 1 })

      const sessions = ['aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000002'] as const
      const records = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
      for (const session of sessions) records.setSessionTitle(session, session, Date.now())
      records.close()
      client.send({ type: 'session.open', session: sessions[0] })
      // 工具调用和工具回填后的文本各有一条 turn.end；两轮都结束才是本次输入收束。
      await submitAndWait(client, '运行隔离后台命令', '输入已收束而后台责任仍在', () => completed === 2 && manager.runs().some((row) => row.session === sessions[0] && row.lastTurn === 'settled' && row.state === 'running' && row.background === 1))
      const first = manager.executors()[0]!
      // 原预期 → 新预期：原来是 action 那句文案里含「后台命令」（切字符串），现在是 row.background 那一格。
      // 依据 U100；没变弱（从「字里有这三个字」换到「这一位是几」）。
      expect(manager.runs().find((row) => row.session === sessions[0])?.background).toBe(1)

      client.send({ type: 'session.open', session: sessions[1] })
      await waitFor('只读切换到第二条', () => client.gen() === null)
      expect(manager.executors()).toHaveLength(1)
      client.send({ type: 'input.submit', text: '第二条明确开始' })
      await waitFor('第二代起来', () => manager.executors().length === 2 && client.gen() !== null)

      // **两代并存**：切会话不是取消工作（设计：「切会话……当前工作继续」）
      expect(manager.executors().map((one) => one.gen)).toContain(first.gen)
      // 而窗口认的是**新的那一代**
      expect(client.gen()).not.toBe(first.gen)
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)
})

describe('U48-S3 · 独占与代次', () => {
  test('过期连接携带旧代次的命令一律拒绝——且是有回声的拒绝', async () => {
    const g = ground('stale')
    const manager = await standUp(g)

    try {
      // 一条**手搓的连接**：就是「别处一个旧窗口」的形态——它自己说一个号，
      // 而那个号不是管理者此刻给它的那一个。
      const socket = await Bun.connect({
        unix: manager.socketPath,
        socket: socketHandlers(),
      })
      const link = linkOf(socket as never)
      const lines: string[] = []
      link.onMessage((message) => {
        if ((message as { t: string }).t === 'line') {
          lines.push((message as { text: string }).text)
        }
      })
      link.send({ t: 'hello', role: 'client', protocol: manager.identity.protocol, version: manager.identity.version, source: manager.identity.source, cwd: g.ws, label: '旧窗口' })

      // ① 还没有目标时说一个号——那正是「旧窗口拿着上一代的号」的形态
      link.send({ t: 'cmd', gen: 42, cmd: { type: 'input.submit', text: '旧代次不得执行' } })
      await waitFor('旧号的命令被拒', () => lines.length > 0)
      expect(lines[0]).toContain('已经不在了')
      // **没有为它起执行者**——拒绝是真拒绝，不是「收下了另说」
      expect(manager.executors().length).toBe(0)

      // ② 窗口正常接上之后再拿旧号发——同样被拒
      lines.length = 0
      link.send({ t: 'cmd', gen: null, cmd: { type: 'input.submit', text: '受控待答' } })
      await waitFor('正常那条起了执行者', () => manager.executors().length === 1)
      const live = manager.executors()[0] as { readonly gen: number }
      await waitFor('正常输入进入待答', () => manager.runs().some((row) => row.state === 'waiting'))

      link.send({ t: 'cmd', gen: live.gen + 7, cmd: { type: 'input.submit', text: '旧代次不得执行' } })
      await waitFor('旧号又被拒', () => lines.length > 0)
      expect(lines[0]).toContain(`${live.gen + 7}`)
      // 执行者一代都没多
      expect(manager.executors().length).toBe(1)

      link.close()
    } finally {
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)


})

/** 这一支要用的那条会话 id——形制与上面 `session.open` 那几条同。 */
const SESSION = 'aaaaaaaa-0000-0000-0000-000000000009'

describe('U49 · 停止中那一行（真进程 · 真窗口那一瞬）', () => {
  test('管理者收摊那一刻：那一行是「停止中」——已受理，资源尚未全退', async () => {
    const g = ground('stopping')
    // 真会话（列表按目录说话：库里点得出的会话才有那一行）
    const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
    store.setSessionTitle(SESSION, '收摊那条', Date.now())
    store.close()

    const manager = await standUp(g)

    try {
      const client = await open(g, manager, 'a')
      client.send({ type: 'session.open', session: SESSION })
      await submitAndWait(client, '受控待答', '真执行者起来并接上那条会话', () =>
        manager.runs().some((row) => row.session === SESSION && row.state === 'waiting'),
      )

      // **发起收摊**——`bye` 刚发出去，那一代还在（收尾两跳还没走完）
      manager.stop('用例收尾')

      // **同步读**：那一刻它就是「已受理停止、资源尚未全部退出」
      const row = manager.runs().find((one) => one.session === SESSION)
      expect(row?.state).toBe('stopping')
      expect(row?.holds).toBe(true)

      await manager.waitUntilExit()
    } finally {
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)
})

describe('U48-S4 · 收缩与异常', () => {
  test('真实模型与工具：中间轮无 done，最终事项只交给绑定终端，执行者释放不重复系统通知', async () => {
    const marker = 'resident-continues-tool-output'
    const g = ground('attention', 'settled', [
      { kind: 'tool', name: 'exec', args: { cmd: `echo ${marker}` } },
      // 保留真实流式阶段，第一轮结束时可直接检查持久事项，不能只在最终数总数。
      { kind: 'text', text: '工具结果已收到，这才是本次交代的最终结果。', chunks: 10, chunkDelayMs: 100 },
    ])
    const manager = await standUp(g)
    const client = await open(g, manager, '完成事项观察')
    const terminalNotices: RunNotice[] = []
    client.onNotice(notice => terminalNotices.push(notice))
    const events: KernelEvent[] = []
    const observations: { event: Extract<KernelEvent, { kind: 'turn.end' }>; attention: ReturnType<typeof attentionFacts> }[] = []
    let gen: number | undefined
    client.onEvent((event) => {
      events.push(event)
      if (event.kind === 'turn.end') observations.push({ event, attention: attentionFacts(g.dataDir, g.ws) })
    })
    try {
      client.send({ type: 'input.submit', text: '执行受控 echo 后给出最终结果' })
      await waitFor('工具轮结束事件已收到', () => observations.length > 0)
      gen = manager.executors()[0]?.gen
      expect(observations[0]?.event.data).toEqual({ reason: 'settled', continues: true })
      expect(observations[0]?.attention).toEqual([])
      expect(terminalNotices).toEqual([])
      const tools = events.filter((event) => event.kind === 'tool.result')
      expect(tools).toHaveLength(1)
      expect(tools[0]?.data.ok).toBe(true)
      expect(JSON.stringify(tools[0]?.data.output)).toContain(marker)
      expect(gen).toBeDefined()

      await waitFor('最终事项送达绑定终端并释放执行者', () => observations.length === 2 && terminalNotices.length === 1 && manager.executors().length === 0 && client.gen() === null)
      expect(observations.map((one) => one.event.data)).toEqual([
        { reason: 'settled', continues: true }, { reason: 'settled' },
      ])
      const final = observations[1]!.event
      const attention = attentionFacts(g.dataDir, g.ws)
      expect(attention).toHaveLength(1)
      expect(attention[0]).toMatchObject({ session: final.session, fact: String(final.id), kind: 'done', unread: true, delivered: false })
      expect(terminalNotices).toEqual([...attention])
      expect(client.closed).toBe(false)
      expect(client.gen()).toBeNull()
      const requests = g.fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]?.body.messages)).toContain(marker)
      expect(manager.executors().some(one => one.gen === gen)).toBe(false)
    } finally {
      client.close()
      manager.stop('测试宿主退出')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)

  test('窗口仍连着但无工作责任 ⇒ 执行者释放；同 Session 下一次输入才起新代，管理者等宿主退出', async () => {
    const g = ground('shrink', 'settled')
    const manager = await standUp(g)

    try {
      const client = await open(g, manager, 'a')
      client.send({ type: 'input.submit', text: '受控完成后释放' })
      await waitFor('执行者起来', () => manager.executors().length === 1)
      const gen = manager.executors()[0]!.gen

      await waitFor('回合完成', () => manager.runs().some((row) => row.state === 'idle'))
      const session = manager.runs().find((row) => row.state === 'idle')!.session

      // ① 窗口仍连接：执行者自己收摊（不是管理者去杀它）
      await waitFor('执行者被释放', () => manager.executors().length === 0, 8_000)

      expect(client.closed).toBe(false)
      expect(client.gen()).toBeNull()
      client.send({ type: 'input.submit', text: '沿原会话继续' })
      await waitFor('原会话下一代开始', () => manager.executors().some((one) => one.session === session && one.gen !== gen))
      await waitFor('第二轮也释放', () => manager.executors().length === 0, 8_000)
      expect(manager.runs().map((row) => row.session)).toEqual([session])
      expect(g.fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))).toHaveLength(2)
      client.close()

      // 空闲仍能接入，直到宿主显式退出。
      const observer = await open(g, manager, '空闲观察')
      expect(observer.closed).toBe(false)
      expect(manager.executors()).toHaveLength(0)
      observer.close()
      manager.stop('宿主退出')
      await manager.waitUntilExit()

      // 退出是「收干净了」：socket 摘掉、自报那一份也清了
      const paths = runPathsOf(g.magic, g.tmp)
      expect(existsSync(paths.socket)).toBe(false)
      expect(existsSync(paths.record)).toBe(false)
    } finally {
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)

  test('真实后台命令：模型轮收束后仍 running，命令退出才 idle 并释放执行者', async () => {
    const g = ground('background-finish', 'background-finish')
    const manager = await standUp(g)
    const client = await open(g, manager, '后台命令观察')
    let completed = 0
    client.onEvent((event) => { if (event.kind === 'turn.end' && event.data.reason === 'settled') completed += 1 })
    try {
      client.send({ type: 'input.submit', text: '启动受控后台命令' })
      await waitFor('两次模型轮均已收束而命令仍在', () => completed === 2 && manager.runs().some((row) => row.lastTurn === 'settled' && row.state === 'running' && row.background === 1))
      const session = manager.runs()[0]!.session
      expect(manager.runs()[0]?.background).toBe(1)
      expect(g.fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))).toHaveLength(2)
      expect(manager.executors()[0]?.gen).toBeDefined()
      await waitFor('后台责任归零', () => manager.runs().find((row) => row.session === session)?.state === 'idle')
      await waitFor('无责任执行者真实退出', () => manager.executors().length === 0)
      expect(client.closed).toBe(false)
      expect(manager.runs().find((row) => row.session === session)?.holds).toBe(false)
      // 后台结束的 notice 按既有业务进入同一会话，额外一轮是结束回执，不是历史重跑。
      const chats = g.fixture.requests().filter((one) => one.path.endsWith('/chat/completions'))
      expect(chats).toHaveLength(3)
      expect(chats[2]?.lastUser).toContain('sleep 1.5')
    } finally {
      client.close()
      manager.stop('测试宿主退出')
      await manager.waitUntilExit()
      await g.dispose()
    }
  }, 60_000)

  test('Engine 被杀后重启核对旧 Agent 并回收持久登记的真实工具', async () => {
    const g = ground('orphan', 'background')
    const paths = runPathsOf(g.magic, g.tmp)
    const child = join(import.meta.dir, 'run-manager-child.ts')
    let restarted: Manager | undefined

    const managerChild = Bun.spawn(
      [
        process.execPath,
        child,
        g.magic.home,
        g.magic.base,
        g.tmp,
        join(g.root, 'ready'),
        join(g.root, 'go'),
        join(g.root, 'result'),
      ],
      { stdout: 'pipe', stderr: 'pipe', env: g.environment },
    )

    try {
      await waitFor('管理者报到', () => existsSync(join(g.root, 'ready')))
      writeFileSync(join(g.root, 'go'), '')
      await waitFor('管理者立起来', () => existsSync(join(g.root, 'result')))

      const managerPid = (JSON.parse(readFileSync(join(g.root, 'result'), 'utf8')) as { pid: number }).pid

      expect(managerPid).toBe(managerChild.pid)

      // 从**外面**连上去（这个用例自己就是那个窗口），要一个执行者
      const client = await connectManager(paths.socket, { cwd: g.ws, environment: g.environment })
      expect(client).toBeDefined()
      client?.send({ type: 'input.submit', text: '受控待答' })

      await waitFor('真实后台工具已登记', () => client?.runs().some(row => row.background === 1) === true)
      const stored = JSON.parse(readFileSync(paths.runs, 'utf8')) as { runs: { owned?: { pgid: number }[] }[] }
      const toolPid = stored.runs.flatMap(run => run.owned ?? [])[0]!.pgid
      expect(alive(toolPid)).toBe(true)
      process.kill(managerPid, 'SIGKILL')
      await managerChild.exited
      client?.close()

      // 路径上是尸首（没有收尾就没有清理）——**下一个随即能立起来**（第一段那条纪律）
      const again = await startManager({
        paths,
        magic: g.magic,
        launch: createAgentLauncher(),
      })
      expect(again.role).toBe('manager')
      if (again.role === 'manager') {
        restarted = again.manager
        await waitFor('旧工具已收回', () => !alive(toolPid), 15000)
        expect(again.manager.executors()).toHaveLength(0)
        expect(again.manager.runs()[0]?.state).toBe('stopped')
        again.manager.stop('用例收尾')
        await again.manager.waitUntilExit()
      }
    } finally {
      restarted?.stop('测试结束'); await restarted?.waitUntilExit()
      managerChild.kill('SIGKILL')
      await managerChild.exited
      await g.dispose()
    }
  }, 60_000)
})

test('在途执行者动态调整诊断等级，代次与审批保持；错误等级不继续记 trace', async () => {
  const { applyHostDiagnostics } = await import('../src/run/diagnostics-client.ts')
  const { readdirSync } = await import('node:fs')
  const { configStamp } = await import('../src/cache-access.ts')
  const g = ground('live-diagnostics'), manager = await standUp(g), client = await open(g, manager, 'diagnostics')
  const discovery = { ...manager.identity, app: '/test.app', base: g.magic.base, socket: manager.socketPath }
  const observer = linkOf<NativeResponse>(await Bun.connect({ unix: manager.socketPath, socket: socketHandlers() }) as never)
  let adopted: string | null = null
  observer.onMessage(message => { if (message.t === 'native.welcome' || message.t === 'native.projection') adopted = message.projection.configuration?.stamp ?? null })
  observer.send({ t: 'hello', role: 'observer', ...manager.identity })
  try {
    client.send({ type: 'input.submit', text: 'PRIVATE_DIAGNOSTICS_INPUT' })
    await waitFor('真实执行者待答', () => manager.runs().some(row => row.state === 'waiting'))
    const before = manager.executors()
    expect(await applyHostDiagnostics(discovery, { debugMode: true, logLevel: 'trace' })).toContain('已保存')
    expect(manager.executors()).toEqual(before); expect(manager.runs().some(row => row.state === 'waiting')).toBe(true)
    const readLogs = () => readdirSync(join(g.dataDir, 'logs')).filter(n => n.startsWith(`executor-${process.pid}-`)).map(n => readFileSync(join(g.dataDir, 'logs', n), 'utf8')).join('')
    await waitFor('trace 消息已落盘', () => readLogs().includes('control.settings.sync'))
    let catalogs = 0
    client.onEvent(event => { if (event.kind === 'model.catalog') catalogs++ })
    expect(await applyHostDiagnostics(discovery, { debugMode: false, logLevel: 'error' })).toContain('已保存')
    const saved = configStamp(join(g.magic.base, 'config.json'))
    await waitFor('降低日志等级已实际采用', () => adopted === saved)
    const filtered = readLogs()
    expect(manager.executors()).toEqual(before)
    expect(manager.runs().some(row => row.state === 'waiting')).toBe(true)
    client.send({ type: 'model.list' })
    await waitFor('已处理后续命令', () => catalogs > 0)
    expect(readLogs()).toBe(filtered)
    expect(filtered).not.toContain('PRIVATE_DIAGNOSTICS_INPUT'); expect(filtered).not.toContain('sk-test')
  } finally { observer.close(); client.close(); manager.stop('诊断实操收尾'); await manager.waitUntilExit(); await g.dispose() }
}, 20_000)

test('配置文件争锁与大输出期间仍能查询并独立停止另一工作', async () => {
  const g = ground('control-pressure', 'settled', [
    { kind: 'tool', name: 'exec', args: { cmd: 'yes u122-output', background: true } },
    { kind: 'text', text: '后台输出继续' },
    { kind: 'tool', name: 'exec', args: { cmd: 'sleep 30' } },
  ])
  const { acquireFileLock } = await import('../src/grants-file.ts')
  const manager = await standUp(g)
  const a = (await connectManager(manager.socketPath, { cwd: g.ws, environment: g.environment, allowAll: true }))!
  const b = (await connectManager(manager.socketPath, { cwd: g.ws, environment: g.environment, allowAll: true }))!
  let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined
  try {
    let firstCompleted = false
    a.onEvent(event => { if (event.kind === 'turn.end' && !event.data.continues) firstCompleted = true })
    a.send({ type: 'input.submit', text: '持续后台输出' })
    await waitFor('后台命令运行且首轮已完成', () => firstCompleted && manager.runs().some(run => run.background === 1))
    const first = manager.runs().find(run => run.background === 1)!.session
    b.send({ type: 'input.submit', text: '第二项独立工作' })
    await waitFor('第二项命令运行', () => manager.runs().some(run => run.session !== first && run.state === 'running'))
    const second = manager.runs().find(run => run.session !== first)!.session
    lock = await acquireFileLock(join(g.dataDir, 'config.json'))
    let saved = false, stopped = false, queried = false
    a.onEvent(event => { if (event.kind === 'prefs.state') saved = true; if (event.kind === 'session.state') queried = true })
    b.onStopped(report => { if (report.phase === 'done') stopped = true })
    a.send({ type: 'prefs.set', reducedMotion: true })
    a.send({ type: 'session.list' })
    b.stop(second, 'run')
    await waitFor('锁等待中完成查询与单项停止', () => stopped && queried, 900)
    expect(saved).toBe(false)
    expect(manager.runs().find(run => run.session === first)?.background).toBe(1)
    expect(a.closed).toBe(false)
    lock.release(); lock = undefined
    await waitFor('释放锁后保存成功', () => saved)
  } finally {
    lock?.release(); a.close(); b.close(); manager.stop('压力测试收尾')
    await manager.waitUntilExit(); await g.dispose()
  }
}, 15000)
