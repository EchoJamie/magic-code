/**
 * U50 · **停止、异常退出与通知**——管理者那一侧的全部判据。
 *
 * 与 `run-runs.test.ts` 同一套搭法（真管理者 · 真 socket · 真库 ＋ 一个说线上话的假执行者）：
 * 这一单要证的东西全在**管理者手上那几格事实**（受理没受理、谁被动了手、回执说了哪一拍、
 * 有没有误杀）。真进程那一层由 `run-owned.test.ts`（进程组）与 `run-terminal.test.ts`
 * （真窗口）守着。
 *
 * 六组：
 * 1. **整体停止**——受理 → 停止中 → 核销才算停（回执三拍说得清）；
 * 2. **局部停止**——只收这一轮，**不报已停**（不把局部成功显示为整体成功）；
 * 3. **重复停止**——安全受理，不是报错；
 * 4. **执行者不理会**——有界等待 → TERM → KILL → 等退出；
 * 5. **崩溃后收回自有进程组**——只碰证明得了归属的（同族的外人不碰、PID 重用不误杀）；
 * 6. **通知**——三类转换 · 跨窗口去重 · 不播报还在跑 · 无人连接时系统通知 ＋ 未读汇总；
 *    另加 **U79**：`needs-you` 这一档**不回执、不广播**（看着它一个字不说 ·
 *    没看着才弹系统通知 ＋ 记未读）。
 */

import { describe, expect, test } from 'bun:test'
import type { Socket } from 'bun'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent, RunNotice, RunRow, StopPhase, StopScope } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { groupAlive, startTimeOf } from '@magic/execution'
import { unreadSummaryOf } from '@magic/tui'
import { connectManager } from '../src/run/client.ts'
import type { ManagerClient } from '../src/run/client.ts'
import { startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher, ExecutorRequest, Manager, SpawnedExecutor } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import type { ExecutorToManager, ManagerToExecutor } from '../src/run/wire.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 一块沙地——形制与 `run-runs.test.ts` 那一处同（各支一片独立沙地，不共用状态）。 */
type Ground = {
  readonly root: string
  readonly magic: { readonly home: string; readonly base: string }
  readonly dataDir: string
  readonly tmp: string
  readonly ws: string
  dispose(): void
}

function ground(name: string): Ground {
  const root = tempDir(`magic-stop-${name}-`)
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
    tmp: tmpdir(),
    ws,
    dispose: () => {
      removeDir(runPathsOf({ home, base }, dataDir, tmpdir()).dir)
      removeDir(root)
    },
  }
}

/** 一个假执行者——线上那几件都会做，另加「报自有进程组」与「叫它退它退不退」。 */
type Fake = {
  readonly gen: number
  readonly request: ExecutorRequest
  readonly got: ManagerToExecutor[]
  nextId: number
  /** 管理者按过哪几记「兵」（TERM / KILL 各记一笔）。 */
  readonly signals: string[]
  /** 不理会 TERM 的那一档（用例开关）——按下 KILL 才退。 */
  stubborn: boolean
  send(message: ExecutorToManager): void
  emit(kind: string, data: unknown, session: string | null, at?: number): number
  ready(session: string | null): void
  bound(session: string): void
  /** 报一份「我手上握着哪几组自有进程」。 */
  owned(processes: readonly { pgid: number; startedAt: number | undefined; what: string }[]): void
  stopping(why: string): void
  exit(reason: string): void
  close(): void
}

type Bench = {
  readonly manager: Manager
  readonly requests: readonly ExecutorRequest[]
  readonly fakes: Fake[]
  readonly killed: readonly { readonly gen: number; readonly signal: string }[]
  attach(index: number): Promise<Fake>
  dispose(): Promise<void>
}

/** 等一个条件成立（默认 5 秒）——**轮询是用例的事**，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(20)
  }
}

/** 立一摊：真管理者 ＋ 假执行者（`launch` 那一头按用例的需要收口）。 */
async function bench(g: Ground, overrides: Record<string, unknown> = {}): Promise<Bench> {
  const requests: ExecutorRequest[] = []
  const exits = new Map<number, (reason: string) => void>()
  const fakes: Fake[] = []
  const killed: { gen: number; signal: string }[] = []

  const launcher: ExecutorLauncher = {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      requests.push(request)
      return {
        pid: 900_000 + request.gen,
        onExit(listener) {
          exits.set(request.gen, listener)
        },
        kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
          killed.push({ gen: request.gen, signal })
          const fake = fakes.find((one) => one.gen === request.gen)
          // **不听话的那一档**：TERM 白按，只有 KILL 才真退（那正是「工具拒绝正常结束」）
          if (fake?.stubborn === true && signal === 'SIGTERM') return
          exits.get(request.gen)?.(`被叫停（${signal}）`)
        },
      }
    },
  }

  const started = await startManager({
    paths: runPathsOf(g.magic, g.dataDir, g.tmp),
    dataDir: g.dataDir,
    magic: g.magic,
    launch: launcher,
    probeIntervalMs: 50,
    // 停止那一跳的时限调小：用例不该真等八秒
    stopGraceMs: 200,
    stopKillMs: 200,
    ...overrides,
  })
  if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)

  const attach = async (index: number): Promise<Fake> => {
    const request = requests[index]
    if (request === undefined) throw new Error(`第 ${index} 次发车都还没有`)

    const socket = (await Bun.connect({
      unix: started.manager.socketPath,
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
      signals: [],
      stubborn: false,
      send: (message) => void link.send(message),
      emit(kind, data, session, at = Date.now()) {
        const id = fake.nextId
        fake.nextId += 1
        link.send({
          t: 'ev',
          event: { id, session: session ?? '', turn: null, at, kind, data } as KernelEvent,
        })
        return id
      },
      ready(session) {
        link.send({
          t: 'hello',
          role: 'executor',
          token: request.token,
          session,
          workspace: [g.ws],
        })
        link.send({ t: 'ready' })
      },
      bound(session) {
        link.send({ t: 'bound', session })
      },
      owned(processes) {
        link.send({ t: 'owned', processes })
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
    manager: started.manager,
    requests,
    fakes,
    killed,
    attach,
    dispose: async () => {
      for (const fake of fakes) fake.close()
      started.manager.stop('用例收尾')
      await started.manager.waitUntilExit()
      g.dispose()
    },
  }
}

/** 让几条会话**真在库里**（列表按目录说话，停止那条路也按会话点名）。 */
function seed(g: Ground, sessions: readonly string[]): void {
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.ws] })
  for (const [at, session] of sessions.entries()) store.setSessionTitle(session, `会话 ${session}`, 1_000 + at)
  store.close()
}

async function open(g: Ground, manager: Manager): Promise<ManagerClient> {
  const client = await connectManager(manager.socketPath, { cwd: g.ws, label: '窗口' })
  if (client === undefined) throw new Error('连不上管理者')
  return client
}

const rowOf = (client: ManagerClient, session: string): RunRow | undefined =>
  client.runs().find((row) => row.session === session)

/** 一个窗口收到的「停到哪一拍」回执。 */
type StopTap = { readonly scope: StopScope; readonly phase: StopPhase; readonly note?: string }
const tapsOf = (client: ManagerClient): StopTap[] => {
  const taps: StopTap[] = []
  client.onStopped((report) => taps.push({ scope: report.scope, phase: report.phase, ...(report.note === undefined ? {} : { note: report.note }) }))
  return taps
}

/** 起一组真进程（自成一组，组长 ＝ 返回的那个 pid）——用例自己收尾。 */
function spawnGroup(script: string): { readonly pid: number; kill(): void } {
  const child = Bun.spawn(['sh', '-c', script], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    detached: true,
  })
  return {
    pid: child.pid,
    kill() {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 已经没了
      }
    },
  }
}

describe('U50 · 停止：整体那一档', () => {
  test('受理 → 停止中 → 核销才算停；回执说得出「已受理」与「停了」是两拍', async () => {
    const g = ground('whole')
    seed(g, ['s-1'])
    const b = await bench(g)
    const client = await open(g, b.manager)
    const taps = tapsOf(client)

    try {
      client.send({ type: 'session.open', session: 's-1' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-1')
      await waitFor('开张', () => rowOf(client, 's-1') !== undefined)

      fake.emit('turn.start', {}, 's-1')
      await waitFor('跑起来了', () => rowOf(client, 's-1')?.state === 'running')

      client.stop('s-1', 'run')

      // ① **受理那一拍**——它**还没停**（资源没退完，故那一行是「停止中」）
      await waitFor('受理', () => taps.some((one) => one.phase === 'accepted'))
      // 那一行是**推**下来的（合并窗 100ms，见 `pushRuns`）——等它到，不是当场读
      await waitFor('那一行成了停止中', () => rowOf(client, 's-1')?.state === 'stopping')

      // ② **取消在途 ＋ 叫它收尾**——两句都送到了那一头
      await waitFor('取消与收尾都送到了', () =>
        fake.got.some((one) => one.t === 'cmd' && one.cmd.type === 'turn.interrupt'),
      )
      await waitFor('bye 送到了', () => fake.got.some((one) => one.t === 'bye'))

      // ③ **进程真退** ⇒ 那一拍才是「停了」
      fake.exit('进程正常退出')
      await waitFor('已停', () => taps.some((one) => one.phase === 'done'))
      await waitFor('那一行也落了定', () => rowOf(client, 's-1')?.state !== 'stopping')
      expect(rowOf(client, 's-1')?.holds).toBe(false)

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  test('执行者不理会：有界等待 → TERM → KILL → 等退出', async () => {
    const g = ground('stubborn')
    seed(g, ['s-2'])
    const b = await bench(g)
    const client = await open(g, b.manager)

    try {
      client.send({ type: 'session.open', session: 's-2' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-2')
      fake.stubborn = true // 这一代不理会 TERM
      await waitFor('开张', () => rowOf(client, 's-2') !== undefined)

      client.stop('s-2', 'run')

      // TERM 到了（第一记「兵」），而它没退 —— 那一行如实停在「停止中」
      await waitFor('按了 TERM', () => b.killed.some((one) => one.signal === 'SIGTERM'))
      expect(rowOf(client, 's-2')?.state).toBe('stopping')

      // 再等一歇仍不退 ⇒ KILL（第二记）
      await waitFor('按了 KILL', () => b.killed.some((one) => one.signal === 'SIGKILL'))
      fake.exit('被杀')
      await waitFor('落定', () => rowOf(client, 's-2')?.state !== 'stopping')

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  test('重复停止：安全受理，不是报错；早就停了的也照答', async () => {
    const g = ground('twice')
    seed(g, ['s-3'])
    const b = await bench(g)
    const client = await open(g, b.manager)
    const taps = tapsOf(client)

    try {
      client.send({ type: 'session.open', session: 's-3' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-3')
      await waitFor('开张', () => rowOf(client, 's-3') !== undefined)

      client.stop('s-3', 'run')
      await waitFor('第一下受理', () => taps.length === 1)
      client.stop('s-3', 'run') // 同一个键再按一下

      await waitFor('第二下也受理了', () => taps.length >= 2)
      expect(taps[1]?.phase).toBe('accepted')
      expect(taps[1]?.note).toContain('已经在停')

      fake.exit('进程正常退出')
      await waitFor('停了', () => taps.some((one) => one.phase === 'done'))

      // 停完之后再按：**照答**（「早就停了」），不是一条错误
      const before = taps.length
      client.stop('s-3', 'run')
      await waitFor('第三下也有回声', () => taps.length > before)
      expect(taps.at(-1)?.phase).toBe('done')
      expect(taps.at(-1)?.note).toContain('早就停了')

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U50 · 停止：局部那一档', () => {
  test('只收这一轮：送中断、**不置停止中**、**不报已停**（那条运行还在）', async () => {
    const g = ground('partial')
    seed(g, ['s-4'])
    const b = await bench(g)
    const client = await open(g, b.manager)
    const taps = tapsOf(client)

    try {
      client.send({ type: 'session.open', session: 's-4' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-4')
      await waitFor('开张', () => rowOf(client, 's-4') !== undefined)

      fake.emit('turn.start', {}, 's-4')
      await waitFor('跑起来了', () => rowOf(client, 's-4')?.state === 'running')

      client.stop('s-4', 'turn')

      await waitFor('中断送到了', () =>
        fake.got.some((one) => one.t === 'cmd' && one.cmd.type === 'turn.interrupt'),
      )
      await waitFor('回执到了', () => taps.length === 1)
      expect(taps[0]?.phase).toBe('done')
      expect(taps[0]?.note).toContain('只停了这一轮')

      // **一条都不许越界**：没置停止中、没送 bye、那一代照旧活着
      expect(rowOf(client, 's-4')?.state).not.toBe('stopping')
      expect(fake.got.some((one) => one.t === 'bye')).toBe(false)
      expect(b.manager.executors().map((one) => one.gen)).toContain(fake.gen)

      // 那一轮真收束了（内核那条路），而运行还在
      fake.emit('turn.end', { reason: 'aborted' }, 's-4')
      fake.emit('agent.state', { state: 'waiting' }, 's-4')
      await waitFor('那一行落了定', () => rowOf(client, 's-4') !== undefined)
      expect(rowOf(client, 's-4')?.state).not.toBe('stopping')

      client.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U50 · 崩溃与收回自有进程组', () => {
  test('执行者被杀：照登记收回它起的那些组，**不在账上的一个不碰**', async () => {
    const g = ground('reclaim')
    seed(g, ['s-5'])
    // 两族进程：一族报进账（我们的），一族什么都不报（**外面的**）
    const ours = spawnGroup('sleep 30')
    const stranger = spawnGroup('sleep 30')
    const b = await bench(g)

    try {
      const client = await open(g, b.manager)

      client.send({ type: 'session.open', session: 's-5' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-5')
      await waitFor('开张', () => rowOf(client, 's-5') !== undefined)

      fake.owned([{ pgid: ours.pid, startedAt: startTimeOf(ours.pid), what: 'exec:sleep 30' }])
      // **等那笔账真落到管理者手上**——`owned` 那条消息是异步的，而落盘那一跳（合并写）
      // 是**它到了**的证据（读 `runs.json`）。⚠️ 不能拿 `sleep(50)` 当同步：并排跑满时
      // 那一下会把「账还没到、执行者已经没了」照进来（实测在整门上栽过一次）
      await waitFor('账到了管理者手上', () => {
        try {
          return readFileSync(runPathsOf(g.magic, g.dataDir, tmpdir()).runs, 'utf8').includes(String(ours.pid))
        } catch {
          return false
        }
      })

      // **半路没了**（没说话、没告别）
      fake.exit('进程退出（码 null）')
      await waitFor('落定为异常退出', () => rowOf(client, 's-5')?.state === 'stopped')
      expect(rowOf(client, 's-5')?.reason).toContain('异常退出')

      // ① **收回**：账上那一组没了
      await waitFor('那组被收回来了', () => !groupAlive(ours.pid), 10_000)
      // ② **不误杀**：外面那一组原样活着（它从来没进过账）
      expect(groupAlive(stranger.pid)).toBe(true)

      client.close()
    } finally {
      ours.kill()
      stranger.kill()
      await b.dispose()
    }
  }, 30_000)

  test('PID 重用：号对得上、启动时刻对不上 ⇒ 不动它，并如实说', async () => {
    const g = ground('reuse')
    seed(g, ['s-6'])
    const neighbour = spawnGroup('sleep 30')
    const b = await bench(g)

    try {
      const client = await open(g, b.manager)

      client.send({ type: 'session.open', session: 's-6' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-6')
      await waitFor('开张', () => rowOf(client, 's-6') !== undefined)

      // 一笔**故意对不上**的账：号是真的（这条进程真站着），时刻报成一小时前
      fake.owned([
        { pgid: neighbour.pid, startedAt: (startTimeOf(neighbour.pid) as number) - 3_600_000, what: 'exec:早没了的那条' },
      ])
      await waitFor('账到了管理者手上', () => {
        try {
          return readFileSync(runPathsOf(g.magic, g.dataDir, tmpdir()).runs, 'utf8').includes(String(neighbour.pid))
        } catch {
          return false
        }
      })

      fake.exit('进程退出（码 null）')
      await waitFor('落定为异常退出', () => rowOf(client, 's-6')?.state === 'stopped')

      // 收尾那一跳跑完之后：**邻居活着**，而且那一行的缘由把这件事说出来了
      await waitFor(
        '缘由里说出了没能收回来的那一组',
        () => (rowOf(client, 's-6')?.reason ?? '').includes('没能收回来'),
        10_000,
      )
      expect(groupAlive(neighbour.pid)).toBe(true)
      expect(rowOf(client, 's-6')?.reason).toContain('别人的')

      client.close()
    } finally {
      neighbour.kill()
      await b.dispose()
    }
  }, 30_000)
})

describe('U50 · 通知', () => {
  test('**「跑完了」与「需要你」都不说** · `failed` 照旧一条 · 跨窗口只报一次 · 不播报「还在跑」', async () => {
    const g = ground('notice')
    seed(g, ['s-7'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })
    const one = await open(g, b.manager)
    const two = await open(g, b.manager)

    const got: RunNotice[] = []
    one.onNotice((notice) => got.push(notice))
    two.onNotice(() => got.push({ ...({} as RunNotice), kind: 'done', id: '两个窗口看见的是同一条' }))

    try {
      one.send({ type: 'session.open', session: 's-7' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-7')
      await waitFor('开张', () => rowOf(one, 's-7') !== undefined)

      // **还在跑**：一串进展 / 输出 / 心跳，一条通知都不该有
      fake.emit('turn.start', {}, 's-7')
      fake.emit('agent.state', { state: 'resumed' }, 's-7')
      fake.emit('model.call.start', { model: 'm', inputBudget: 100 }, 's-7')
      fake.emit('tool.call', { name: 'bash', args: {} }, 's-7')
      fake.emit('tool.output.delta', { call: 1, channel: 'stdout', text: '跑着呢……' }, 's-7')
      await Bun.sleep(120)
      expect(got.length).toBe(0)

      // **需要你**（U79 起：**一个字都不说**——卡就在正看着它的那一页上）
      const request = fake.emit(
        'tool.decision.request',
        { call: 1, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-7',
      )
      // 那件事**没丢**：它落在**这条会话自己**那一行上（`RunRow.action`，卡就在屏上）
      await waitFor('那一行写着「等你定夺」', () => rowOf(one, 's-7')?.action === '等你定夺：bash')
      await Bun.sleep(120)
      expect(got.filter((one) => one.session === 's-7')).toEqual([]) // 一条回执都没有
      expect(said.length).toBe(0) // 也不弹系统通知（有人正看着它）
      fake.emit('tool.decision', { call: 1, decision: 'approve', decider: 'user', elapsedMs: 5 }, 's-7')

      // **完成**（U74 起：这一条**一个字都不说**——有窗口正看着它跑完）
      fake.emit('tool.result', { call: 1, ok: true, output: { text: 'ok' } }, 's-7')
      fake.emit('turn.end', { reason: 'settled' }, 's-7')
      // 同一条事实重放（几个窗口都收到那一形）：照样一个字不说，也不会第二次记它
      fake.emit('turn.end', { reason: 'settled' }, 's-7')
      await Bun.sleep(150)
      // ⚠️ 只看**这条会话**那几条：另一个窗口那一路（`two.onNotice`）往 `got` 里塞的是
      // 一个不认会话的记号（上面那句——「两个窗口看见的是同一条」），它不在这个提问里
      expect(got.filter((one) => one.session === 's-7').some((one) => one.kind === 'done')).toBe(false)
      expect(said.length).toBe(0) // 「正看着」那一档连系统通知都不发（更不标未读）

      // **失败**（第二条，也是今天**唯一**还落行的那一类）
      fake.emit('turn.start', {}, 's-7')
      fake.emit('turn.end', { reason: 'error' }, 's-7')
      await waitFor('失败那条到了', () => got.some((one) => one.kind === 'failed'))

      // 说出来的**只有这一条**，**没有多余的**（`done` / `needs-you` 两条都不在其中）
      await Bun.sleep(150)
      const kinds = got.filter((one) => one.session === 's-7').map((one) => one.kind)
      expect([...kinds].sort()).toEqual(['failed'])
      expect(request).toBeGreaterThan(0)
      expect(said.length).toBe(0) // 有窗口看着 ⇒ 不弹系统通知

      two.close()
      one.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  /**
   * **U74 · 「没看着」那一档**——A 页开着、B 会话跑完。
   *
   * 用户 2026-09-25 定的规则（设计 · 会话与运行管理「通知」那一格）：「跑完了」那条回执
   * **整个撤掉**——**你正看着它跑完**，印了是复述；**你没看着**，它也不该落到你正读的
   * **别的页**上。没看着那一档只走两条：**本机系统通知**（当场）＋ **下一次打开一句汇总**。
   *
   * ⚠️ **判据是「这条会话有没有窗口正看着它」，不是「有没有窗口连着」**——两者差在
   * 这一形：按「有没有窗口」，B 那件事**两头都不说**（系统通知不弹、回执又不该印），
   * 那一条就没人告诉用户了。D38（缺陷 · 通知回执的落点与次序）的「判据」那一半。
   *
   * ⚠️ 系统通知走**端口记账**（`notifySystem`），**不许真弹**（真弹是 `osascript`）。
   */
  test('A 页开着、B 会话跑完：A 页不印 · 系统通知弹 · 切进 B 汇总一句', async () => {
    const g = ground('elsewhere')
    seed(g, ['s-a', 's-b'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })

    try {
      // **A 页**——一个窗口开着，它「正看着」的是 s-a
      const aPage = await open(g, b.manager)
      const got: RunNotice[] = []
      aPage.onNotice((notice) => got.push(notice))
      aPage.send({ type: 'session.open', session: 's-a' })
      await waitFor('A 发车', () => b.requests.length === 1)
      const fakeA = await b.attach(0)
      fakeA.ready('s-a')
      await waitFor('A 开张', () => rowOf(aPage, 's-a') !== undefined)

      // **B 会话**——另一个窗口把它跑起来，随后那个窗口走了（没人再看它）
      const bPage = await open(g, b.manager)
      bPage.send({ type: 'session.open', session: 's-b' })
      await waitFor('B 发车', () => b.requests.length === 2)
      const fakeB = await b.attach(1)
      fakeB.ready('s-b')
      await waitFor('B 开张', () => rowOf(aPage, 's-b') !== undefined)
      bPage.close()
      await Bun.sleep(80)

      // 跑完那一轮——**A 页开着，可没人看着 s-b**
      fakeB.emit('turn.start', {}, 's-b')
      fakeB.emit('turn.end', { reason: 'settled' }, 's-b')

      // ① **本页不印**：A 这一页上，s-b 的回执**一条都没有**
      await waitFor('系统通知弹了一条', () => said.length === 1)
      expect(said[0]).toContain('跑完')
      await Bun.sleep(150)
      expect(got.filter((one) => one.session === 's-b').length).toBe(0)

      // ② **切进 B ⇒ 汇总一句**（下一次打开随 `welcome` 下来）
      const back = await open(g, b.manager)
      expect(back.unread.map((one) => one.session)).toEqual(['s-b'])
      expect(unreadSummaryOf(back.unread)).toBe('你不在的时候：1 项跑完 —— /resume 看是哪几条')

      aPage.close()
      back.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  test('无人连接：系统通知一条 · 未读落盘 · 下次打开汇总一次就不再念', async () => {
    const g = ground('unread')
    seed(g, ['s-8'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })

    try {
      // **先有一个窗口**把这条会话跑起来，然后它走了（此刻无人连接）
      const first = await open(g, b.manager)
      first.send({ type: 'session.open', session: 's-8' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-8')
      await waitFor('开张', () => rowOf(first, 's-8') !== undefined)
      first.close()
      await Bun.sleep(80)

      // 跑完那一轮——**没有任何窗口在场**
      fake.emit('turn.start', {}, 's-8')
      fake.emit('turn.end', { reason: 'settled' }, 's-8')

      await waitFor('系统通知弹了一条', () => said.length === 1)
      expect(said[0]).toContain('跑完')

      // **未读落盘**（合并写那一跳要等）
      const paths = runPathsOf(g.magic, g.dataDir, tmpdir())
      await waitFor('写进了盘里', () => {
        try {
          return readFileSync(paths.notices, 'utf8').includes('s-8')
        } catch {
          return false
        }
      })

      // **下一次打开汇总一次**——随 welcome 下来，且**只给一次**
      const back = await open(g, b.manager)
      expect(back.unread.length).toBe(1)
      expect(back.unread[0]?.session).toBe('s-8')
      expect(back.unread[0]?.unread).toBe(true)

      const again = await open(g, b.manager)
      expect(again.unread.length).toBe(0) // 说过了就不再念

      // 之后也不会再弹第二条系统通知（同一条事实）
      expect(said.length).toBe(1)

      back.close()
      again.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

/**
 * **U79 · 「需要你」那一档：不回执、不广播**——管理者那一侧的判据。
 *
 * 设计（会话与运行管理 · 通知）：「需要你」**卡在那条会话里**（它不动）· **你连上它时
 * 直接进那张卡**（U49 的接回快照已承担，**不在本单**）· **它不回执、不广播** ·
 * **一个窗口都没有时，才加一记本机系统通知**。
 *
 * ⚠️ **判据是「这条会话有没有窗口正看着它」**（与 `done` 同一把尺子）：
 * 「A 页开着、B 会话在等你」那一形里，按「有没有窗口连着」会**两头都不说**
 * （回执不该印、系统通知又不弹）——那一条就没人告诉用户了（D38 那半）。
 *
 * ⚠️ 系统通知走**端口记账**（`notifySystem`），**不许真弹**（真弹是 `osascript`）。
 * 真 PTY 那一趟（A 页干净 · 连上 B 直接进卡）在 `frames-u79-tui.ts`。
 */
describe('U79 · 通知：「需要你」不回执、不广播', () => {
  test('**看着它 ⇒ 一个字都不说**：回执 · 系统通知 · 未读，三样都没有', async () => {
    const g = ground('u79-watched')
    seed(g, ['s-w'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })
    const page = await open(g, b.manager)

    const got: RunNotice[] = []
    page.onNotice((notice) => got.push(notice))

    try {
      page.send({ type: 'session.open', session: 's-w' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-w')
      await waitFor('开张', () => rowOf(page, 's-w') !== undefined)

      fake.emit(
        'tool.decision.request',
        { call: 1, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-w',
      )

      // 那件事**没丢**——它落在**这条会话自己**那一行上（卡就在正看着它的那一页上）
      await waitFor('那一行写着「等你定夺」', () => rowOf(page, 's-w')?.action === '等你定夺：bash')
      await Bun.sleep(150)

      expect(got).toEqual([]) // ① 回执：一条都没有（更不广播给别的窗口）
      expect(said).toEqual([]) // ② 系统通知：不弹（有人正看着它）
      // ③ 未读：也没记——后连上来的窗口那一路**收不到这条汇总**
      const back = await open(g, b.manager)
      expect(back.unread).toEqual([])

      back.close()
      page.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  /**
   * **A 页开着、B 会话在等你**——本单要证的那一形（也是 D38 里「两头都不说」那一形）。
   */
  test('A 页开着、B 会话在等：**不落到 A 页** · 系统通知弹 · 未读落盘 · 下次打开汇总一句', async () => {
    const g = ground('u79-elsewhere')
    seed(g, ['s-a', 's-b'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })

    try {
      // **A 页**——一个窗口开着，它「正看着」的是 s-a
      const aPage = await open(g, b.manager)
      const got: RunNotice[] = []
      aPage.onNotice((notice) => got.push(notice))
      aPage.send({ type: 'session.open', session: 's-a' })
      await waitFor('A 发车', () => b.requests.length === 1)
      const fakeA = await b.attach(0)
      fakeA.ready('s-a')
      await waitFor('A 开张', () => rowOf(aPage, 's-a') !== undefined)

      // **B 会话**——另一个窗口把它跑起来，随后那个窗口走了（没人再看它）
      const bPage = await open(g, b.manager)
      bPage.send({ type: 'session.open', session: 's-b' })
      await waitFor('B 发车', () => b.requests.length === 2)
      const fakeB = await b.attach(1)
      fakeB.ready('s-b')
      await waitFor('B 开张', () => rowOf(aPage, 's-b') !== undefined)
      bPage.close()
      await Bun.sleep(80)

      fakeB.emit(
        'tool.decision.request',
        { call: 1, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-b',
      )

      // ① **不广播**：A 那一页上一条都没有（改之前它会印进 A——判据是「有没有窗口连着」）
      await waitFor('系统通知弹了一条', () => said.length === 1)
      // 逐字：桌面那一句是**用户看的话**（管理者认不得标题，故不报会话 id）
      expect(said[0]).toBe('有一件工作正等着你——打开看是哪条')
      await Bun.sleep(150)
      expect(got.filter((one) => one.session === 's-b')).toEqual([])

      // ② **未读落盘**（合并写那一跳要等）——B 那件事正等着用户回来看
      const paths = runPathsOf(g.magic, g.dataDir, tmpdir())
      await waitFor('写进了盘里', () => {
        try {
          return readFileSync(paths.notices, 'utf8').includes('s-b')
        } catch {
          return false
        }
      })

      // ③ **下次打开汇总一句**（随 `welcome` 下来，且**只给一次**）
      const back = await open(g, b.manager)
      expect(back.unread.map((one) => one.session)).toEqual(['s-b'])
      expect(unreadSummaryOf(back.unread)).toBe('你不在的时候：1 项等你 —— /resume 看是哪几条')

      const again = await open(g, b.manager)
      expect(again.unread).toEqual([]) // 说过了就不再念

      // 之后也不会再弹第二条（同一条事实只说一次）
      expect(said.length).toBe(1)
      // 而**那件事还在**：那条运行这一行照旧写着「等你定夺」（它不动、没人自动答复）
      expect(rowOf(aPage, 's-b')?.action).toBe('等你定夺：bash')

      aPage.close()
      back.close()
      again.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)

  test('**一个窗口都没有**：系统通知一把（工单验收那一形）', async () => {
    const g = ground('u79-nowindow')
    seed(g, ['s-n'])
    const said: string[] = []
    const b = await bench(g, { notifySystem: (text: string) => said.push(text) })

    try {
      // 先有一个窗口把它跑起来，然后它走了（此刻**一个窗口都没有**）
      const first = await open(g, b.manager)
      first.send({ type: 'session.open', session: 's-n' })
      await waitFor('发车', () => b.requests.length === 1)
      const fake = await b.attach(0)
      fake.ready('s-n')
      await waitFor('开张', () => rowOf(first, 's-n') !== undefined)
      first.close()
      await Bun.sleep(80)

      fake.emit(
        'tool.decision.request',
        { call: 1, name: 'bash', material: 'rm -rf build', weight: 'heavy' },
        's-n',
      )

      await waitFor('系统通知弹了一条', () => said.length === 1)
      // 逐字：桌面那一句是**用户看的话**（管理者认不得标题，故不报会话 id）
      expect(said[0]).toBe('有一件工作正等着你——打开看是哪条')

      const back = await open(g, b.manager)
      expect(back.unread.map((one) => one.kind)).toEqual(['needs-you'])
      expect(back.unread[0]?.unread).toBe(true)

      back.close()
    } finally {
      await b.dispose()
    }
  }, 30_000)
})

describe('U50 · 重启核对里的句柄身份', () => {
  test('盘上那一代：号被复用了（启动时刻对不上）⇒ 已停止，不再钉在「待确认」', async () => {
    const g = ground('identity')
    seed(g, ['s-alive', 's-reused'])
    const paths = runPathsOf(g.magic, g.dataDir, g.tmp)
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 })

    // 一个**真活着**的进程（拿真 pid 当「那个号上有人」）
    const sleeper = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 60_000)'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
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
              procStartedAt: startTimeOf(sleeper.pid),
              startedAt: 1_000,
              workspace: [g.ws],
              state: 'running',
              since: 1_100,
            },
            {
              session: 's-reused',
              gen: 6,
              pid: sleeper.pid,
              // **那一刻与此刻差着一小时**：号还是那个号，人已经不是那个人了
              procStartedAt: (startTimeOf(sleeper.pid) as number) - 3_600_000,
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

      // 对得上的那一条：**未证实结束**（占着，不许重开）
      await waitFor('待确认', () => rowOf(client, 's-alive')?.state === 'unknown')
      expect(rowOf(client, 's-alive')?.holds).toBe(true)

      // 对不上的那一条：**已停止**（U49 如实记的那条限度就收在这里）
      expect(rowOf(client, 's-reused')?.state).toBe('stopped')
      expect(rowOf(client, 's-reused')?.holds).toBe(false)

      client.close()
      await b.dispose()
    } finally {
      sleeper.kill()
      await waitFor('那个进程真没了', () => startTimeOf(sleeper.pid as number) === undefined, 5_000).catch(
        () => undefined,
      )
    }
  }, 30_000)
})
