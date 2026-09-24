/**
 * U48 · 第二至第四段 —— **执行者拆出去并登记 · 独占与代次 · 收缩与异常**。
 *
 * 三段合在一支用例文件里，因为它们的判据**互相咬**：登记里那几格既是「谁在跑」的读数
 * （第二段），也是代次的来处（第三段），还是「该不该收」的一半（第四段）。分开写会
 * 出现三份各自搭台、彼此对不上的沙地。
 *
 * 证的四组：
 * 1. **一个窗口一条执行者**——七项各自独立，停一项不影响其它（U48 完成出口第 2 句）；
 * 2. **同时重连同一会话只有一个执行者**（第 3 句）——且是**并发**重连；
 * 3. **过期代次的命令一律拒绝**（自行验收·代次）——用真连接伪造一条旧号命令；
 * 4. **收缩与异常**——没人看且手上没事 ⇒ 释放；管理者被杀 ⇒ 执行者自行停止（自行验收后两条）。
 *
 * ⚠️ **执行者一律是真子进程**（`createProcessLauncher`）。「拆进程」是这一单要证的东西
 * 本身——拿进程内的替身跑出来的绿，证不了「失败隔离」。
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRecordsStore } from '@magic/records'
import { connectManager } from '../src/run/client.ts'
import type { ManagerClient } from '../src/run/client.ts'
import { createProcessLauncher } from '../src/run/launch.ts'
import { startManager } from '../src/run/manager.ts'
import type { Manager } from '../src/run/manager.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { removeDir, tempDir } from './tmp.ts'

/** 一块沙地——形制与 `run-manager.test.ts` 那一处同（两处各是一片独立沙地，不共用状态）。 */
type Ground = {
  readonly root: string
  readonly magic: { readonly home: string; readonly base: string }
  readonly dataDir: string
  readonly tmp: string
  readonly ws: string
  dispose(): void
}

function ground(name: string): Ground {
  const root = tempDir(`magic-exec-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = join(root, 'data')
  const ws = join(root, 'ws')
  for (const dir of [home, base, dataDir, ws]) mkdirSync(dir, { recursive: true })

  // 一份**读得动**的配置：执行者装配时要它。供应商指向一个必然连不上的地址——
  // 这一组用例一条模型请求都不发（走的全是会话命令），故它是死是活无关紧要。
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
    // **系统临时目录当第二落点**（见 `paths.ts` 的 `runPathsOf`）：socket 路径有
    // 104 字节的硬上限，而沙地本身已经在 `/var/folders/…` 底下七十几个字符了——
    // 拿沙地当那个「短路径」会当场撞上（第一版就是这么红的两条）。
    tmp: tmpdir(),
    ws,
    dispose: () => {
      // 运行目录可能在沙地外那一支（上面那个 fallback），一并收掉
      removeDir(runPathsOf({ home, base }, dataDir, tmpdir()).dir)
      removeDir(root)
    },
  }
}

/** 立一个管理者——收尾挂在 `finally` 里（见各条用例），免得留一个占着路径的进程。 */
async function standUp(g: Ground, overrides: Record<string, unknown> = {}): Promise<Manager> {
  const started = await startManager({
    paths: runPathsOf(g.magic, g.dataDir, g.tmp),
    dataDir: g.dataDir,
    magic: g.magic,
    launch: createProcessLauncher(),
    ...overrides,
  })
  if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)

  return started.manager
}

/** 连一个窗口上去。 */
async function open(g: Ground, manager: Manager, label: string): Promise<ManagerClient> {
  const client = await connectManager(manager.socketPath, { cwd: g.ws, label })
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

/** 这一条进程还在不在——`kill(pid, 0)` 是既有装置里那把尺子（`bench-pty.test.ts` 同此）。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('U48-S2 · 一个窗口一条执行者', () => {
  test('七个窗口各开一条新的——七代各自独立，停一项不影响其它', async () => {
    const g = ground('seven')
    const manager = await standUp(g)
    const clients: ManagerClient[] = []

    try {
      for (let i = 0; i < 7; i += 1) {
        const client = await open(g, manager, `w${i}`)
        clients.push(client)
        client.send({ type: 'session.new' })
      }

      await waitFor('七个执行者都起来', () => manager.executors().length === 7)
      // **等它们各自把会话认出来**再读——那一格是事件到达才填的，早读一步读到的是
      // 一排 `null`（它们是七个**还没开张**的执行者，各自等着自己那一条首条消息）
      await waitFor('七条会话都认出来了', () => manager.executors().every((one) => one.session !== null))

      const live = manager.executors()
      // **七代各是各的**——号不重、进程不重、会话不重
      expect(new Set(live.map((one) => one.gen)).size).toBe(7)
      expect(new Set(live.map((one) => one.pid)).size).toBe(7)
      expect(new Set(live.map((one) => one.session)).size).toBe(7)

      // ——停一项——
      const victim = live[3] as { readonly gen: number; readonly pid: number | undefined }
      expect(victim.pid).toBeDefined()
      process.kill(victim.pid as number, 'SIGKILL')

      await waitFor('被停的那一代核销掉', () => manager.executors().length === 6)
      // 其余六项**一个都不动**（号还是原来那六个）
      expect(new Set(manager.executors().map((one) => one.gen))).toEqual(
        new Set(live.filter((one) => one.gen !== victim.gen).map((one) => one.gen)),
      )
      // 而且它们还真的在跑——不是「表里还在、进程没了」
      for (const one of manager.executors()) {
        expect(one.pid === undefined ? false : alive(one.pid)).toBe(true)
      }
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
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
      first.send({ type: 'session.open', session })
      await waitFor('第一代起来', () => manager.executors().length === 1)

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
      expect(live[0]?.gen).toBe(manager.executors()[0]?.gen)

      // 三条连接都指着同一代（`target` 那一条说的就是它）
      for (const client of clients) expect(client.gen()).toBe(live[0]?.gen ?? null)
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
    }
  }, 60_000)

  test('切到另一条会话＝换一代，而原来那一代照跑', async () => {
    const g = ground('switch')
    const manager = await standUp(g)
    const clients: ManagerClient[] = []

    try {
      const client = await open(g, manager, 'a')
      clients.push(client)

      client.send({ type: 'session.open', session: 'aaaaaaaa-0000-0000-0000-000000000001' })
      await waitFor('第一代起来', () => manager.executors().length === 1)
      const first = manager.executors()[0] as { readonly gen: number; readonly pid: number | undefined }

      client.send({ type: 'session.open', session: 'aaaaaaaa-0000-0000-0000-000000000002' })
      await waitFor('第二代起来', () => manager.executors().length === 2)

      // **两代并存**：切会话不是取消工作（设计：「切会话……当前工作继续」）
      expect(manager.executors().map((one) => one.gen)).toContain(first.gen)
      expect(first.pid === undefined ? false : alive(first.pid)).toBe(true)
      // 而窗口认的是**新的那一代**
      expect(client.gen()).not.toBe(first.gen)
    } finally {
      for (const client of clients) client.close()
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
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
      link.send({ t: 'hello', role: 'client', cwd: g.ws, label: '旧窗口' })

      // ① 还没有目标时说一个号——那正是「旧窗口拿着上一代的号」的形态
      link.send({ t: 'cmd', gen: 42, cmd: { type: 'session.list' } })
      await waitFor('旧号的命令被拒', () => lines.length > 0)
      expect(lines[0]).toContain('已经不在了')
      // **没有为它起执行者**——拒绝是真拒绝，不是「收下了另说」
      expect(manager.executors().length).toBe(0)

      // ② 窗口正常接上之后再拿旧号发——同样被拒
      lines.length = 0
      link.send({ t: 'cmd', gen: null, cmd: { type: 'session.new' } })
      await waitFor('正常那条起了执行者', () => manager.executors().length === 1)
      const live = manager.executors()[0] as { readonly gen: number }

      link.send({ t: 'cmd', gen: live.gen + 7, cmd: { type: 'session.list' } })
      await waitFor('旧号又被拒', () => lines.length > 0)
      expect(lines[0]).toContain(`${live.gen + 7}`)
      // 执行者一代都没多
      expect(manager.executors().length).toBe(1)

      link.close()
    } finally {
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
    }
  }, 60_000)

  test('执行者被杀——窗口被告知「那一代没了」，而不是跟着死', async () => {
    const g = ground('killed')
    const manager = await standUp(g)

    try {
      const client = await open(g, manager, 'a')
      const lines: string[] = []
      client.onLine((text) => lines.push(text))

      client.send({ type: 'session.new' })
      await waitFor('执行者起来', () => manager.executors().length === 1)

      const pid = manager.executors()[0]?.pid as number
      process.kill(pid, 'SIGKILL')

      await waitFor('核销', () => manager.executors().length === 0)
      await waitFor('窗口收到那一句', () => lines.some((one) => one.includes('收摊')))
      // 旧号当场作废——不作废的话，它下一条命令会被当成「过期误操作」挡下来
      expect(client.gen()).toBeNull()

      // 而它接着敲是有回声的：管理者为它起新的一代
      client.send({ type: 'session.new' })
      await waitFor('起了新的一代', () => manager.executors().length === 1)
      expect(client.gen()).not.toBeNull()

      client.close()
    } finally {
      manager.stop('用例收尾')
      await manager.waitUntilExit()
      g.dispose()
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
      await waitFor('真执行者起来并接上那条会话', () =>
        manager.runs().some((row) => row.session === SESSION && row.state === 'idle'),
      )

      // **发起收摊**——`bye` 刚发出去，那一代还在（收尾两跳还没走完）
      manager.stop('用例收尾')

      // **同步读**：那一刻它就是「已受理停止、资源尚未全部退出」
      const row = manager.runs().find((one) => one.session === SESSION)
      expect(row?.state).toBe('stopping')
      expect(row?.holds).toBe(true)

      await manager.waitUntilExit()
    } finally {
      await manager.waitUntilExit().catch(() => {})
      g.dispose()
    }
  }, 60_000)
})

describe('U48-S4 · 收缩与异常', () => {
  test('没人看、手上也没事 ⇒ 执行者释放；管理者随即退出', async () => {
    const g = ground('shrink')
    const manager = await standUp(g)

    try {
      const client = await open(g, manager, 'a')
      client.send({ type: 'session.list' })
      await waitFor('执行者起来', () => manager.executors().length === 1)
      const pid = manager.executors()[0]?.pid as number

      client.close()

      // ① 执行者自己收摊（不是管理者去杀它）
      await waitFor('执行者被释放', () => manager.executors().length === 0, 8_000)
      await waitFor('那个进程真没了', () => !alive(pid), 8_000)

      // ② 两手都空 ⇒ 管理者自己退（**不成为永远占机器的 daemon**）
      await manager.waitUntilExit()

      // 退出是「收干净了」：socket 摘掉、自报那一份也清了
      const paths = runPathsOf(g.magic, g.dataDir, g.tmp)
      expect(existsSync(paths.socket)).toBe(false)
      expect(existsSync(paths.record)).toBe(false)
    } finally {
      manager.stop('用例收尾')
      g.dispose()
    }
  }, 60_000)

  test('管理者被杀——执行者经生命连接自行停止、不留残余', async () => {
    const g = ground('orphan')
    const paths = runPathsOf(g.magic, g.dataDir, g.tmp)
    const child = join(import.meta.dir, 'run-manager-child.ts')

    const managerChild = Bun.spawn(
      [
        process.execPath,
        child,
        g.magic.home,
        g.magic.base,
        g.dataDir,
        g.tmp,
        join(g.root, 'ready'),
        join(g.root, 'go'),
        join(g.root, 'result'),
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    )

    try {
      await waitFor('管理者报到', () => existsSync(join(g.root, 'ready')))
      writeFileSync(join(g.root, 'go'), '')
      await waitFor('管理者立起来', () => existsSync(join(g.root, 'result')))

      const managerPid = (JSON.parse(readFileSync(join(g.root, 'result'), 'utf8')) as { pid: number }).pid

      // 从**外面**连上去（这个用例自己就是那个窗口），要一个执行者
      const client = await connectManager(paths.socket, { cwd: g.ws })
      expect(client).toBeDefined()
      client?.send({ type: 'session.list' })

      // 执行者是管理者进程的孩子——用 `pgrep -P` 从外面看（不是问管理者要，
      // 那样问到的只是它自己说的；要证的是**真有一个子进程**）
      const executorPid = await descendantOf(managerPid)
      expect(executorPid).toBeDefined()
      expect(alive(executorPid as number)).toBe(true)

      // ——管理者被**杀**（没有收尾的机会）——
      process.kill(managerPid, 'SIGKILL')

      // 执行者自己停：不变成无人负责的后台
      await waitFor('执行者自行停止', () => !alive(executorPid as number), 15_000)
      await managerChild.exited

      // 路径上是尸首（没有收尾就没有清理）——**下一个随即能立起来**（第一段那条纪律）
      const again = await startManager({
        paths,
        dataDir: g.dataDir,
        magic: g.magic,
        launch: createProcessLauncher(),
      })
      expect(again.role).toBe('manager')
      if (again.role === 'manager') {
        again.manager.stop('用例收尾')
        await again.manager.waitUntilExit()
      }
    } finally {
      managerChild.kill('SIGKILL')
      await managerChild.exited
      g.dispose()
    }
  }, 60_000)
})

/** 某个进程的孩子——`pgrep -P`（macOS 的 `ps` 不认 `-P`，这就是用它的理由）。 */
async function descendantOf(pid: number): Promise<number | undefined> {
  const proc = Bun.spawn(['pgrep', '-P', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited

  const first = text.trim().split('\n').filter((line) => line !== '')[0]
  return first === undefined ? undefined : Number(first)
}
