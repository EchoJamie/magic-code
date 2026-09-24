/**
 * U49 · **运行列表、状态与接回**——管理者那一侧的全部判据。
 *
 * 真管理者（真 socket、真库、真路由）＋ **一个说线上话的假执行者**（`Fake`）。这么搭是因为
 * 这一单要证的东西全在**管理者手上那几格事实**：进程起没起来、正在做什么、谁在等你答复、
 * 收到停止没有。拿真子进程去撞这六行，撞出来的多是「模型跑得快不快」——
 * 而**真进程那一层由 `run-terminal.test.ts` 与 `frames-u49-tui.ts` 守着**。
 *
 * 六组：
 * 1. **那六行逐行走一遍**（同一代上把状态推着走一遍，每一步都读一遍真读数）；
 * 2. **接回＝快照 ＋ 水位**（先订阅并缓冲、按 id 去重）；
 * 3. **裁决只有一份**（晚到的那条答复有回声、且不再往下送）；
 * 4. **`/clear` 是这个窗口的**（另一个窗口那一页不跟着走）；
 * 5. **登记落盘 ＋ 重启核对**（待确认 → 已停止；期间不许为同一条会话另起一代）；
 * 6. **入口空闲不遮蔽成员**（自己这条空闲，列表里还看得见别条在跑）。
 */

import { describe, expect, test } from 'bun:test'
import type { Socket } from 'bun'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EventKind, KernelEvent, RunRow, RunSnapshot } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { connectManager } from '../src/run/client.ts'
import type { ManagerClient } from '../src/run/client.ts'
import { startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher, ExecutorRequest, Manager, SpawnedExecutor } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import type { ExecutorToManager, ManagerToExecutor } from '../src/run/wire.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 一块沙地——形制与 `run-executor.test.ts` 那一处同（两处各是一片独立沙地，不共用状态）。 */
type Ground = {
  readonly root: string
  readonly magic: { readonly home: string; readonly base: string }
  readonly dataDir: string
  readonly tmp: string
  readonly ws: string
  dispose(): void
}

function ground(name: string): Ground {
  const root = tempDir(`magic-runs-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  for (const dir of [home, base, dataDir, ws]) mkdirSync(dir, { recursive: true })

  writeFileSync(
    join(base, 'config.json'),
    JSON.stringify({
      defaultProvider: 'x',
      providers: { x: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'sk-test', model: 'm' } },
      dataDir,
    }),
  )

  return {
    root,
    magic: { home, base },
    dataDir,
    // socket 路径有 104 字节上限，沙地本身已经很深——第二落点取系统临时目录（同 U48）
    tmp: tmpdir(),
    ws,
    dispose: () => {
      removeDir(runPathsOf({ home, base }, dataDir, tmpdir()).dir)
      removeDir(root)
    },
  }
}

/**
 * 一个**说线上话的假执行者**——它替真进程说话，故这一支里每一条判据都只问管理者。
 *
 * 它只做真执行者会做的那几件：登记（`hello`）、报 `ready`、开张（`bound`）、发事件、
 * 答快照、收摊前说一声（`done` / `stopping`）。
 */
type Fake = {
  readonly gen: number
  readonly request: ExecutorRequest
  /** 管理者送到这一头的东西（按到达序）——命令与快照请求都在里头。 */
  readonly got: ManagerToExecutor[]
  /** 这一头发出去的事件 id 水位（与记录域同一条纪律：单调递增）。 */
  nextId: number
  send(message: ExecutorToManager): void
  /** 一条内核事件——返回它的 id。 */
  emit(kind: EventKind, data: unknown, session: string | null, at?: number): number
  /** 这一条工具调用开始了（`tool.call` 与那次的 id 一起交回）。 */
  toolCall(name: string, session: string): number
  ready(session: string | null): void
  stopping(why: string): void
  exit(reason: string): void
  close(): void
}

type Bench = {
  readonly manager: Manager
  /** 发过几次车（按序）——各支按第几次取那一头。 */
  readonly requests: readonly ExecutorRequest[]
  /** 把第 `index` 次发车的执行者「接上」（它连回管理者、报上姓名）。 */
  attach(index: number): Promise<Fake>
  /** 所有接上的那一头。 */
  readonly fakes: Fake[]
  dispose(): Promise<void>
}

/** 等一个条件成立（默认 5 秒）——**轮询是用例的事**，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/** 立一摊：真管理者 ＋ 假执行者。 */
async function bench(g: Ground, overrides: Record<string, unknown> = {}): Promise<Bench> {
  const requests: ExecutorRequest[] = []
  const exits = new Map<number, (reason: string) => void>()
  const fakes: Fake[] = []

  const launcher: ExecutorLauncher = {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      requests.push(request)
      return {
        // 假进程号：只作诊断（这一支里没人按 PID 找它）——取一段不会撞上真进程的号
        pid: 900_000 + request.gen,
        onExit(listener) {
          exits.set(request.gen, listener)
        },
        kill() {
          exits.get(request.gen)?.('被叫停')
        },
      }
    },
  }

  const started = await startManager({
    paths: runPathsOf(g.magic, g.dataDir, g.tmp),
    dataDir: g.dataDir,
    magic: g.magic,
    launch: launcher,
    // 生命探测调快（那一跳顺带重推运行事实、也顺带核对「待确认」那些）
    probeIntervalMs: 60,
    ...overrides,
  })
  if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)
  const manager = started.manager

  const attach = async (index: number): Promise<Fake> => {
    const request = requests[index]
    if (request === undefined) throw new Error(`第 ${index} 次发车都还没有`)

    const socket = (await Bun.connect({
      unix: manager.socketPath,
      socket: socketHandlers(),
    })) as Socket<never>
    const link = linkOf<ManagerToExecutor>(socket)
    const got: ManagerToExecutor[] = []
    link.onMessage((message) => got.push(message))

    const fake: Fake = {
      gen: request.gen,
      request,
      got,
      nextId: 1,
      send: (message) => void link.send(message),
      emit(kind, data, session, at = Date.now()) {
        const id = fake.nextId
        fake.nextId += 1
        const event = { id, session: session ?? '', turn: null, at, kind, data } as KernelEvent
        link.send({ t: 'ev', event })
        return id
      },
      toolCall(name, session) {
        return fake.emit('tool.call', { name, args: {} }, session)
      },
      ready(session) {
        link.send({ t: 'hello', role: 'executor', token: request.token, session, workspace: [g.ws] })
        link.send({ t: 'ready' })
      },
      stopping(why) {
        link.send({ t: 'stopping', why })
      },
      exit(reason) {
        exits.get(request.gen)?.(reason)
      },
      close() {
        link.close()
      },
    }

    fakes.push(fake)
    return fake
  }

  return {
    manager,
    requests,
    fakes,
    attach,
    dispose: async () => {
      for (const fake of fakes) fake.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
    },
  }
}

/**
 * 让几条会话**真在库里**——列表按目录说话（`rows()` 只对点得出名的会话说状态）。
 *
 * 真跑时那是执行者写出来的；这一支里假执行者不发条目，故由用例自己把它们落进库
 * （改一次名就是「这一行在」，判据与 `--session` 那道校验同一把尺子）。
 */
function seed(g: Ground, sessions: readonly string[]): void {
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
  for (const [at, session] of sessions.entries()) {
    store.setSessionTitle(session, `会话 ${session}`, 1_000 + at)
  }
  store.close()
}

/** 连一个窗口上去——顺带把它收到的运行事实收着（各支直接读最后一份）。 */
async function open(g: Ground, manager: Manager): Promise<ManagerClient> {
  const client = await connectManager(manager.socketPath, { cwd: g.ws, label: '窗口' })
  if (client === undefined) throw new Error('连不上管理者')
  return client
}

/** 一条读数（按会话找）——找不到返回 `undefined`（不是空行）。 */
const rowOf = (client: ManagerClient, session: string): RunRow | undefined =>
  client.runs().find((row) => row.session === session)

describe('U49 · 那六行在真管理者上逐行走一遍', () => {
  test('同一代上把状态推着走——每一步读到的都是事实说的那一行', async () => {
    const g = ground('states')
    seed(g, ['s-1'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.new' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)

      // ① **发车到 ready 之间**：还没开张，故列表里没有它——但那一代的事实是「在跑」
      fake.ready(null)
      await waitFor('接上了', () => b.manager.executors().length === 1)
      expect(client.runs().some((row) => row.state === 'running')).toBe(false) // 还没会话可挂

      fake.send({ t: 'bound', session: 's-1' })
      await waitFor('开张', () => rowOf(client, 's-1') !== undefined)

      // ② **当前空闲**——起来了、手上没事
      await waitFor('当前空闲', () => rowOf(client, 's-1')?.state === 'idle')

      // ③ **执行中**——一轮起来、模型调用在途
      fake.emit('turn.start', {}, 's-1')
      fake.emit('agent.state', { state: 'resumed' }, 's-1')
      await waitFor('执行中', () => rowOf(client, 's-1')?.state === 'running')
      const asked = fake.emit('model.call.start', { model: 'm', inputBudget: 200_000 }, 's-1')
      await waitFor('在等模型', () => rowOf(client, 's-1')?.action === '正在等 m 回话')

      // ④ **执行中 · 正在跑工具**
      const call = fake.toolCall('bash', 's-1')
      await waitFor('在跑工具', () => rowOf(client, 's-1')?.action === '正在跑 bash')

      // ⑤ **等待你**——卡挂上了
      const request = fake.emit(
        'tool.decision.request',
        { call, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-1',
      )
      await waitFor('等待你', () => rowOf(client, 's-1')?.state === 'waiting')
      expect(rowOf(client, 's-1')?.action).toBe('等你定夺：bash')

      // 答复落地 ⇒ 回到执行中
      fake.emit('tool.decision', { call, decision: 'approve', decider: 'user', elapsedMs: 12 }, 's-1')
      await waitFor('答复后回到执行中', () => rowOf(client, 's-1')?.state === 'running')

      // ⑥ **当前空闲**——一轮好好收束
      fake.emit('tool.result', { call, ok: true, output: { text: 'ok' } }, 's-1')
      fake.emit('turn.end', { reason: 'settled' }, 's-1')
      fake.emit('agent.state', { state: 'waiting' }, 's-1')
      await waitFor('收束回空闲', () => rowOf(client, 's-1')?.state === 'idle')
      expect(rowOf(client, 's-1')?.progress?.what).toBe('这一轮收束了')
      expect(asked).toBeGreaterThan(0)

      // ⑦ **停止中**——它受理了停止，资源还没退完
      fake.stopping('没人看了，手上也没有在跑的事')
      await waitFor('停止中', () => rowOf(client, 's-1')?.state === 'stopping')
      expect(rowOf(client, 's-1')?.holds).toBe(true)

      // ⑧ **当前空闲**——它自己走完了（上一轮是好好收的）
      fake.exit('进程正常退出')
      await waitFor('收摊', () => rowOf(client, 's-1')?.state === 'idle')
      expect(rowOf(client, 's-1')?.holds).toBe(false)
      expect(request).toBeGreaterThan(0)
    } finally {
      client.close()
      await b.dispose()
    }
  }, 30_000)

  test('被打断的那一代收摊 ⇒ 已停止 · 手动中断（不是「当前空闲」）', async () => {
    const g = ground('aborted')
    seed(g, ['s-2'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.new' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready(null)
      fake.send({ t: 'bound', session: 's-2' })
      await waitFor('开张', () => rowOf(client, 's-2') !== undefined)

      fake.emit('turn.start', {}, 's-2')
      fake.emit('agent.state', { state: 'resumed' }, 's-2')
      await waitFor('跑起来了', () => rowOf(client, 's-2')?.state === 'running')

      // 这一轮被**打断**（Ctrl+C 那条路），随后这一代自己收了摊
      fake.emit('turn.end', { reason: 'aborted' }, 's-2')
      fake.emit('agent.state', { state: 'waiting' }, 's-2')
      fake.stopping('没人看了')
      // 「受理了停止」与「进程真退了」是**两条**，次序要在用例里立得住：
      // 真执行者那两跳之间隔着收尾（几秒），这一支得等管理者先收下那一句
      await waitFor('受理了停止', () => rowOf(client, 's-2')?.state === 'stopping')
      fake.exit('进程正常退出')

      await waitFor('已停止', () => rowOf(client, 's-2')?.state === 'stopped')
      expect(rowOf(client, 's-2')?.reason).toBe('手动中断')
    } finally {
      client.close()
      await b.dispose()
    }
  }, 30_000)

  test('被杀的那一代 ⇒ 已停止 · 异常退出（没有收场回执，就不伪报正常收束）', async () => {
    const g = ground('crashed')
    seed(g, ['s-3'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.new' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready(null)
      fake.send({ t: 'bound', session: 's-3' })
      await waitFor('开张', () => rowOf(client, 's-3') !== undefined)
      fake.emit('turn.start', {}, 's-3')
      await waitFor('跑起来了', () => rowOf(client, 's-3')?.state === 'running')

      // 半路没了——**没说过 `stopping`、也没说过 `done`**
      fake.exit('进程退出（码 null）')

      await waitFor('已停止', () => rowOf(client, 's-3')?.state === 'stopped')
      expect(rowOf(client, 's-3')?.reason).toContain('异常退出')
    } finally {
      client.close()
      await b.dispose()
    }
  }, 30_000)

  test('入口自己空闲时，列表里照旧看得见别条在跑（不显示成整件工作已结束）', async () => {
    const g = ground('summary')
    seed(g, ['s-a', 's-b'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.new' })
      await waitFor('发车', () => b.requests.length === 1)
      const one = await b.attach(0)
      one.ready(null)
      one.send({ t: 'bound', session: 's-a' })
      one.emit('turn.start', {}, 's-a')
      one.emit('agent.state', { state: 'resumed' }, 's-a')
      await waitFor('s-a 在跑', () => rowOf(client, 's-a')?.state === 'running')

      // **另一个窗口**开一条新的（它那条空闲）
      const other = await open(g, b.manager)
      other.send({ type: 'session.new' })
      await waitFor('第二代发车', () => b.requests.length === 2)
      const two = await b.attach(1)
      two.ready(null)
      two.send({ t: 'bound', session: 's-b' })
      await waitFor('s-b 空闲', () => rowOf(other, 's-b')?.state === 'idle')

      // 这一头空闲，而那一条仍在跑——**两行都在**
      expect(rowOf(other, 's-a')?.state).toBe('running')
      expect(other.runs().filter((row) => row.state === 'running').length).toBe(1)

      other.close()
    } finally {
      client.close()
      await b.dispose()
    }
  }, 30_000)
})

describe('U49 · 接回＝快照 ＋ 水位', () => {
  test('先订阅并缓冲、快照到了才放行——水位之后的一条不多一条不少，且按 id 去重', async () => {
    const g = ground('snapshot')
    seed(g, ['s-live'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      const resumed: RunSnapshot[] = []
      const seen: number[] = []
      client.onResumed((_gen, snapshot) => resumed.push(snapshot))
      client.onEvent((event) => seen.push(event.id))

      client.send({ type: 'session.open', session: 's-live' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-live')
      await waitFor('开张', () => rowOf(client, 's-live') !== undefined)

      // 管理者在**挂上窗口的同一刻**就要了快照——它排在 `session.open` 那条命令前面
      await waitFor('管理者要快照', () => fake.got.some((one) => one.t === 'snapshot'))
      const asked = fake.got.find((one) => one.t === 'snapshot')
      if (asked === undefined || asked.t !== 'snapshot') throw new Error('管理者没要快照')
      const seq = asked.seq

      // 快照回来之前，这一段里发生的事——**一条都不许丢**（那正是缓冲区的用处）
      fake.emit('turn.start', {}, 's-live')
      fake.emit('agent.state', { state: 'resumed' }, 's-live')
      const early = fake.emit('tool.call', { name: 'bash', args: { cmd: 'pwd' } }, 's-live')
      // 重复的一条（同一 id 又发了一遍）——放行时按 id 去重
      fake.send({
        t: 'ev',
        event: {
          id: early,
          session: 's-live',
          turn: null,
          at: Date.now(),
          kind: 'tool.call',
          data: { name: 'bash', args: { cmd: 'pwd' } },
        } as KernelEvent,
      })

      // 快照：水位停在 `early` **之前**（那一条还没进快照）——于是它必须由缓冲补上
      fake.send({
        t: 'snapshot',
        seq,
        snapshot: {
          watermark: early - 1,
          turnOpen: true,
          text: '正在想……',
          tools: [],
          decisions: [],
        },
      })

      await waitFor('快照到了', () => resumed.length === 1)
      expect(resumed[0]?.text).toBe('正在想……')

      // 缓冲区里那两条（`turn.start` / `agent.state` / `tool.call`）按 id 放行，重复的只留一份
      await waitFor('缓冲放完', () => seen.includes(early))
      const flushed = seen.filter((id) => id <= early)
      expect(flushed).toEqual([...new Set(flushed)]) // 无重复
      expect(seen.filter((id) => id === early).length).toBe(1)

      // 此后是**直接**来的
      const later = fake.emit('tool.result', { call: early, ok: true, output: { text: 'ok' } }, 's-live')
      await waitFor('后续照常', () => seen.includes(later))

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U49 · 裁决只有一份', () => {
  test('两个窗口看同一代：第一个答复下行，第二个拿到「已处理」且不再往下送', async () => {
    const g = ground('decision')
    seed(g, ['s-dec'])
    const b = await bench(g)
    const one = await open(g, b.manager)
    const two = await open(g, b.manager)

    try {
      one.send({ type: 'session.open', session: 's-dec' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-dec')
      await waitFor('开张', () => rowOf(one, 's-dec') !== undefined)

      // 第二个窗口也接到同一条会话上——**同一代**
      two.send({ type: 'session.open', session: 's-dec' })
      await waitFor('两个窗口同一代', () => two.gen() !== null && two.gen() === one.gen())

      fake.emit('turn.start', {}, 's-dec')
      fake.emit('agent.state', { state: 'resumed' }, 's-dec')
      const call = fake.toolCall('bash', 's-dec')
      const request = fake.emit(
        'tool.decision.request',
        { call, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-dec',
      )
      await waitFor('两条都看得见那一行', () => rowOf(one, 's-dec')?.state === 'waiting')

      one.send({ type: 'decision.answer', id: request, decision: 'approve' })
      await waitFor('答复送到了那一头', () => fake.got.some((m) => m.t === 'cmd' && m.cmd.type === 'decision.answer'))

      // 内核回一句「答复落地」——两条窗口那一行都回到执行中（卡在两处都撤了）
      fake.emit('tool.decision', { call, decision: 'approve', decider: 'user', elapsedMs: 8 }, 's-dec')
      await waitFor('两个窗口都撤了卡', () => rowOf(one, 's-dec')?.state === 'running' && rowOf(two, 's-dec')?.state === 'running')

      // **晚到的那一条答复**——只有回声，**不往下送**
      const lines: string[] = []
      two.onLine((text) => lines.push(text))
      const before = fake.got.filter((m) => m.t === 'cmd').length
      two.send({ type: 'decision.answer', id: request, decision: 'approve' })

      await waitFor('晚到的那条有回声', () => lines.some((text) => text.includes('已经处理过了')))
      await Bun.sleep(80)
      expect(fake.got.filter((m) => m.t === 'cmd').length).toBe(before) // 一条都没多送

      one.close()
      two.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U49 · `/clear` 是这个窗口的', () => {
  test('一个窗口开一条新的——另一个窗口那一页不跟着走', async () => {
    const g = ground('clear')
    seed(g, ['s-share'])
    const b = await bench(g)
    const one = await open(g, b.manager)
    const two = await open(g, b.manager)

    try {
      one.send({ type: 'session.open', session: 's-share' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-share')
      await waitFor('开张', () => rowOf(one, 's-share') !== undefined)

      two.send({ type: 'session.open', session: 's-share' })
      await waitFor('两个窗口同一代', () => two.gen() === one.gen() && two.gen() !== null)
      const shared = one.gen() as number

      // 第二个窗口 `/clear`（`session.new`）——**为它自己另起一代**
      two.send({ type: 'session.new' })
      await waitFor('为它另起了一代', () => b.requests.length === 2)
      expect(two.gen()).not.toBe(shared)

      // 第一个窗口**一步没动**：还认着原来那一代、还在看原来那条会话
      expect(one.gen()).toBe(shared)
      expect(rowOf(one, 's-share')?.state).toBe('idle')

      // 而它那一代照旧活着（切走不是取消工作）
      expect(b.manager.executors().map((row) => row.gen)).toContain(shared)

      one.close()
      two.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U49 · 登记落盘与重启核对', () => {
  test('上一次留下的一代：进程还在 ⇒ 状态待确认且不许重开；进程没了 ⇒ 已停止', async () => {
    const g = ground('restart')
    seed(g, ['s-alive', 's-dead'])
    const paths = runPathsOf(g.magic, g.dataDir, g.tmp)
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })

    // 一条**确实活着**的进程（拿真 pid 当「上一代还没走」的替身）
    const sleeper = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    // 上一次留下的登记：一条还在跑的、一条早就没了的
    writeFileSync(
      paths.runs,
      `${JSON.stringify({
        v: 1,
        at: 1,
        runs: [
          {
            session: 's-alive',
            gen: 7,
            pid: sleeper.pid,
            startedAt: 1_000,
            workspace: [g.ws],
            state: 'running',
            since: 1_100,
          },
          {
            session: 's-dead',
            gen: 6,
            pid: 2 ** 30,
            startedAt: 900,
            workspace: [g.ws],
            state: 'running',
            since: 950,
          },
        ],
      })}\n`,
      { mode: 0o600 },
    )

    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      // **进程还在** ⇒ 未证实结束
      await waitFor('待确认', () => rowOf(client, 's-alive')?.state === 'unknown')
      expect(rowOf(client, 's-alive')?.holds).toBe(true)
      expect(rowOf(client, 's-dead')?.state).toBe('stopped')

      // **不能重复启动同会话**——这一条要如实拒绝，且说清缘由
      const lines: string[] = []
      client.onLine((text) => lines.push(text))
      const before = b.requests.length
      client.send({ type: 'session.open', session: 's-alive' })
      await waitFor('被拒且有话说', () => lines.some((text) => text.includes('没有证实结束')))
      expect(b.requests.length).toBe(before) // 一代都没多起

      // 那个进程走了 ⇒ 那一代真的结束了（生命探测那一跳核对出来的）
      sleeper.kill()
      await waitFor('落定为已停止', () => rowOf(client, 's-alive')?.state === 'stopped', 10_000)
      expect(rowOf(client, 's-alive')?.holds).toBe(false)

      // 现在可以接着开了
      client.send({ type: 'session.open', session: 's-alive' })
      await waitFor('这回起得来', () => b.requests.length === before + 1)

      client.close()
    } finally {
      sleeper.kill()
      await b.dispose()
    }
  }, 30_000)

  test('这一趟的登记会落盘——下一次启动读得到「上一次有哪几代」', async () => {
    const g = ground('persist')
    seed(g, ['s-persist'])
    const paths = runPathsOf(g.magic, g.dataDir, g.tmp)
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.open', session: 's-persist' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-persist')
      await waitFor('开张', () => rowOf(client, 's-persist') !== undefined)

      // 落盘是**合并写**（见 `saveRuns`）——等它一次
      await waitFor('写进盘里了', () => {
        try {
          const parsed = JSON.parse(readFileSync(paths.runs, 'utf8')) as {
            runs?: readonly { session?: string }[]
          }
          return parsed.runs?.some((one) => one.session === 's-persist') === true
        } catch {
          return false
        }
      })

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})
