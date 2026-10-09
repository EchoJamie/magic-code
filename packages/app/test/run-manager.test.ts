/**
 * U48 · 第一段 —— **管理者立起来**。
 *
 * 要证的四件（设计 · 会话与运行管理 · 本机执行结构）：
 * 1. **同一用户、同一规范化 dataDir 只有一个**——且**是并发下的唯一**（真的七个进程，
 *    不是同一进程里顺序演七遍）；
 * 2. 启动竞争的一方**连接已有实例，不另起**；
 * 3. **本机 socket 限该用户访问**（落在「运行目录只许本人进」这一条上）；
 * 4. 收摊之后路径干净——下一个随即能立起来（**没有永远占着路径的尸首**）。
 *
 * ⚠️ **并发那一组为什么要真子进程**：这句话说的是**两个进程**之间的事。同一进程里先后
 * 调两次是顺序的（`Bun.listen` 第二次抛，那不叫竞争，那叫顺序的后手）——只有真进程才是
 * 真的一方。七个是因为工单的验收句就是「连开七个……」（`交接/工单/U48.md`）。
 */

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { KernelEvent } from '@magic/contracts'
import type { PathLike } from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { connectManager } from '../src/run/client.ts'
import { readRecord, startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher, Manager } from '../src/run/manager.ts'
import { normalizeDataDir, runPathsOf } from '../src/run/paths.ts'
import { removeDir } from './tmp.ts'

/** 这一段用不到执行者——真起执行者的是第二段那几条用例。 */
const UNUSED_LAUNCHER: ExecutorLauncher = {
  spawn() {
    throw new Error('这一段不该有人要执行者')
  },
}

/** 一块沙地：家目录 / 基础目录 / 数据目录 / 临时目录四面各一处。 */
type Ground = {
  readonly root: string
  readonly home: string
  readonly base: string
  readonly dataDir: string
  readonly tmp: string
  dispose(): void
}

function ground(name: string): Ground {
  const root = mkdtempSync(`/tmp/magic-run-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = base
  const tmp = join(root, 'tmp')
  for (const dir of [home, base, dataDir, tmp]) mkdirSync(dir, { recursive: true })

  return {
    root,
    home,
    base,
    dataDir,
    tmp,
    dispose: () => removeDir(root),
  }
}

/** 在一块沙地上立一个管理者——顺手把「收摊」挂上，免得用例忘一处就留一个占着路径的进程。 */
async function standUp(g: Ground, launch: ExecutorLauncher = UNUSED_LAUNCHER): Promise<Manager> {
  const started = await startManager({
    paths: runPathsOf({ home: g.home, base: g.base }, g.tmp),
    magic: { home: g.home, base: g.base },
    launch,
  })
  if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)

  return started.manager
}

test('U114 空态界面设置由管理者实际保存；不建执行者或会话，坏配置不被提前回显覆盖', async () => {
  const g = ground('u114-prefs')
  const config = join(g.base, 'config.json')
  writeFileSync(config, JSON.stringify({ motion: { reduced: false }, workspaces: [g.root] }))
  const manager = await standUp(g)
  const client = await connectManager(manager.socketPath, { cwd: g.root })
  if (client === undefined) throw new Error('连不上管理者')
  const events: KernelEvent[] = [], lines: string[] = []
  client.onEvent(event => events.push(event))
  client.onLine(line => lines.push(line))
  const wait = async (done: () => boolean): Promise<void> => {
    const until = Date.now() + 2000
    while (!done() && Date.now() < until) await Bun.sleep(10)
    expect(done()).toBe(true)
  }
  try {
    client.send({ type: 'prefs.set', reducedMotion: true, statusLine: { cells: ['workspace'], color: false } })
    await wait(() => events.some(event => event.kind === 'prefs.state'))
    const state = events.find(event => event.kind === 'prefs.state')!
    if (state.kind !== 'prefs.state') throw new Error('缺少设置结果')
    expect(state.data.reducedMotion).toBe(true)
    expect(state.data.statusLine).toEqual({ cells: ['workspace'], color: false })
    expect(state.data.note).toBe('已更新：状态行 · 动效')
    const saved = JSON.parse(readFileSync(config, 'utf8'))
    expect(saved.motion.reduced).toBe(true)
    expect(saved.statusLine).toEqual(state.data.statusLine)
    expect(saved.workspaces).toEqual([g.root])
    expect(statSync(config).mode & 0o777).toBe(0o600)
    const broken = '{ U114_BAD_CONFIG'
    writeFileSync(config, broken)
    client.send({ type: 'prefs.set', reducedMotion: false })
    await wait(() => lines.some(line => line.startsWith('界面设置没改成：')))
    expect(events.filter(event => event.kind === 'prefs.state')).toHaveLength(1)
    expect(readFileSync(config, 'utf8')).toBe(broken)
    expect(manager.executors()).toEqual([])
    expect(manager.runs()).toEqual([])
    const db = new Database(join(g.dataDir, 'records.db'), { readonly: true })
    try { expect(db.query('SELECT * FROM sessions').all()).toEqual([]) } finally { db.close() }
  } finally {
    client.close(); manager.stop('用例收尾'); await manager.waitUntilExit(); g.dispose()
  }
})

describe('U48-S1 · 一个数据目录只有一个管理者', () => {
  test('七个真进程同时抢——正好一个当上，其余六个认出现有的那一个', async () => {
    const g = ground('race')
    const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
    const child = join(import.meta.dir, 'run-manager-child.ts')
    const alias = join(g.root, 'alias-' + 'x'.repeat(140))
    symlinkSync(g.base, alias, 'dir')

    const children: ReturnType<typeof Bun.spawn>[] = []
    try {
      // ① 七个各自报到（**先报到、后放行**：先跑起来的那个早就占上了，
      //    晚的就只是在做「顺序的后手」，相撞的窗口落不到一起）
      for (let i = 0; i < 7; i += 1) {
        children.push(
          Bun.spawn(
            [
              process.execPath,
              child,
              g.home,
              i % 2 === 0 ? g.base : alias,
              g.tmp,
              join(g.root, `ready-${i}`),
              join(g.root, 'go'),
              join(g.root, `result-${i}`),
            ],
            // 结论落文件（见子脚本头注）——stdout / stderr 收到一处，失败时能捞出来看
            { stdout: 'pipe', stderr: 'pipe' },
          ),
        )
      }

      await settle(join(g.root, 'ready-'), 7, 20_000, '报到')

      // ② 一起放行
      writeFileSync(join(g.root, 'go'), '')

      await settle(join(g.root, 'result-'), 7, 20_000, '出结论')

      const results = children.map((_, i) => {
        const text = readFileSync(join(g.root, `result-${i}`), 'utf8')
        return JSON.parse(text) as { role: string; socket: string }
      })

      const managers = results.filter((one) => one.role === 'manager')
      const existing = results.filter((one) => one.role === 'existing')

      // 恰好一个当上——**不是「至少一个」**：两个当上就是两个管理者同时在跑
      expect(managers.length).toBe(1)
      expect(existing.length).toBe(6)
      // 六个都认的是同一条路径（同一个键算到同一处，否则它们连的是别的东西）
      expect(new Set(results.map((one) => one.socket))).toEqual(new Set([paths.socket]))
    } finally {
      // 子进程先收（当上的那个守着不退，得它先走），再删沙地：反过来会把还在用的
      // socket 路径从底下抽掉，那个进程的收尾就落在一处已经不存在的地方。
      for (const proc of children) proc.kill('SIGTERM')
      for (const proc of children) await proc.exited
      g.dispose()
    }
  }, 60_000)

  test('已经有一个管理者时，第二个不再另起——认出现有的那一个', async () => {
    const g = ground('second')
    try {
      const first = await standUp(g)
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)

      const again = await startManager({
        paths,
        magic: { home: g.home, base: g.base },
        launch: UNUSED_LAUNCHER,
      })

      expect(again.role).toBe('existing')
      if (again.role !== 'existing') return
      expect(again.record?.pid).toBe(first.record.pid)
      expect(again.record?.socket).toBe(paths.socket)

      first.stop('用例收尾')
      await first.waitUntilExit()
    } finally {
      g.dispose()
    }
  })

  test('不同基础目录各一摊——两个管理者并存', async () => {
    const g = ground('two')
    const other = join(g.root, 'data-2')
    mkdirSync(other, { recursive: true })

    try {
      const a = await standUp(g)
      const b = await startManager({
        paths: runPathsOf({ home: g.home, base: other }, g.tmp),
        magic: { home: g.home, base: other },
        launch: UNUSED_LAUNCHER,
      })

      expect(b.role).toBe('manager')
      expect(a.socketPath).not.toBe(b.role === 'manager' ? b.manager.socketPath : '')

      a.stop('用例收尾')
      if (b.role === 'manager') b.manager.stop('用例收尾')
      await a.waitUntilExit()
      if (b.role === 'manager') await b.manager.waitUntilExit()
    } finally {
      g.dispose()
    }
  })
})

describe('U48-S1 · 客户端连得上、说得清自己连的是谁', () => {
  test('连上就报得出数据目录——一次往返里说定身份', async () => {
    const g = ground('hello')
    try {
      const manager = await standUp(g)
      const client = await connectManager(manager.socketPath)

      expect(client).toBeDefined()
      expect(client?.base).toBe(g.dataDir)
      expect(client?.conn).toBe(1)
      expect(manager.clients()).toBe(1)

      client?.close()
      await Bun.sleep(50)
      expect(manager.clients()).toBe(0)

      manager.stop('用例收尾')
      await manager.waitUntilExit()
    } finally {
      g.dispose()
    }
  })

  test('没人 listen 时连不上——如实返回「没有」，不抛', async () => {
    const g = ground('nobody')
    try {
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      expect(await connectManager(paths.socket)).toBeUndefined()
    } finally {
      g.dispose()
    }
  })
})

describe('U48-S1 · 收摊与尸首', () => {
  test('收摊之后路径干净，下一个随即能立起来', async () => {
    const g = ground('clean')
    try {
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      const first = await standUp(g)
      expect(existsSync(paths.socket)).toBe(true)
      expect(readRecord(paths)?.pid).toBe(first.record.pid)

      first.stop('用例收尾')
      await first.waitUntilExit()

      // 三件都收干净：socket 摘掉、自报那一份清掉
      expect(existsSync(paths.socket)).toBe(false)
      expect(readRecord(paths)).toBeUndefined()

      // 下一个随即能立起来——**没有「等它自己烂掉」这种状态**
      const second = await standUp(g)
      expect(second.record.pid).toBe(process.pid)
      second.stop('用例收尾')
      await second.waitUntilExit()
    } finally {
      g.dispose()
    }
  })

  test('宿主退出：只断开连接，不再往窗口发那条纯退出回执', async () => {
    const g = ground('exit')
    try {
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      const manager = await standUp(g)
      const client = await connectManager(paths.socket, { cwd: g.root, label: '窗口' })
      if (client === undefined) throw new Error('连不上管理者')
      const lines: string[] = []
      client.onLine((text) => lines.push(text))
      let closed = false
      client.onClose(() => { closed = true })

      manager.stop('用例收尾')
      await manager.waitUntilExit()
      await Bun.sleep(120)

      // 那一行说的只有「退了」这一件事：底栏已经说了（还多给两个入口），留稿说明另说一件事。
      // 于是收摊只需要「连上了 → 断了」这个事实，不必再补一句没有新增信息的话。
      expect(lines.filter((text) => text.includes('Magic Code 已退出'))).toEqual([])
      expect(closed).toBe(true)
    } finally {
      g.dispose()
    }
  })

  test('路径上是尸首（进程没了、socket 文件还在）时清得掉', async () => {
    const g = ground('stale')
    try {
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      mkdirSync(paths.dir, { recursive: true })
      // 上一次被 SIGKILL 之后的样子：路径上留着个连不上的东西
      writeFileSync(paths.socket, '尸首')

      const started = await startManager({
        paths,
        magic: { home: g.home, base: g.base },
        launch: UNUSED_LAUNCHER,
      })

      expect(started.role).toBe('manager')
      if (started.role !== 'manager') return
      started.manager.stop('用例收尾')
      await started.manager.waitUntilExit()
    } finally {
      g.dispose()
    }
  })
})

describe('U48-S1 · 本机 socket 限该用户访问', () => {
  test('运行目录 0700 · socket 0600', async () => {
    const g = ground('mode')
    try {
      const manager = await standUp(g)
      const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)

      // **目录那道门是本体**：socket 文件自己的权限位在 BSD 上不生效，
      // 而「关在一个只许本人进入的目录里」是各平台都成立的同一件事（见 `paths.ts`）。
      expect(modeOf(paths.dir)).toBe(0o700)
      expect(modeOf(paths.socket)).toBe(0o600)

      manager.stop('用例收尾')
      await manager.waitUntilExit()
    } finally {
      g.dispose()
    }
  })
})

describe('U48-S1 · 规范化（同一处必须算成同一处）', () => {
  test('软链接 / 尾随斜杠 / .. 三种写法归一，且还不存在的目录也算得出来', () => {
    const g = ground('norm')
    try {
      const real = normalizeDataDir(g.dataDir)
      expect(normalizeDataDir(`${g.dataDir}/`)).toBe(real)
      expect(normalizeDataDir(join(g.dataDir, '..', 'base'))).toBe(real)
      expect(normalizeDataDir(join(g.dataDir, 'not-yet', '..'))).toBe(real)

      // 还不存在的目录：**最近的已存在祖先**取真路径 ＋ 余下的原样拼回
      expect(normalizeDataDir(join(g.dataDir, 'deep', 'deeper'))).toBe(
        join(real, 'deep', 'deeper'),
      )

      // 同一处 ⇒ 同一份路径（并发的唯一性建在这上面）
      const one = runPathsOf({ home: g.home, base: g.base }, g.tmp)
      const two = runPathsOf({ home: g.home, base: `${g.base}/` }, g.tmp)
      expect(one.socket).toBe(two.socket)
    } finally {
      g.dispose()
    }
  })
})

/**
 * 等 `count` 个以 `prefix` 开头的文件都出现——栅栏两边都用它。
 *
 * 到点**抛**而不是接着往下跑：这一组证的就是「并发下正好一个当上」，收不齐就只能
 * 得出一半的结论，那时候再断言等于把「没收齐」当成「没收齐也对」。
 */
async function settle(prefix: string, count: number, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (true) {
    const here = readdirSync(dirname(prefix)).filter((name) => name.startsWith(basename(prefix)))
    if (here.length >= count) return
    if (Date.now() > deadline) {
      throw new Error(`${timeoutMs}ms 内只有 ${here.length}/${count} 个${what}（缺 ${prefix}*）`)
    }
    await Bun.sleep(5)
  }
}

/** 权限位（低九位）——`statSync` 的 `mode` 带文件类型那几位，掩掉。 */
function modeOf(path: PathLike): number {
  return statSync(path).mode & 0o777
}


describe('基础目录的规范化身份决定运行目录', () => {
  test('长短别名与 .magic 符号链接共用运行目录；首次未建目录保持同一身份', () => {
    const root = mkdtempSync('/tmp/magic-d55-')
    try {
      const home = root
      const real = join(root, 'store')
      mkdirSync(real)
      const longAlias = join(root, 'alias-' + 'x'.repeat(150))
      const selected = join(root, '.magic')
      symlinkSync(real, longAlias, 'dir')
      symlinkSync(real, selected, 'dir')
      const expected = runPathsOf({ home, base: real }, root)
      expect(expected.dir.startsWith(normalizeDataDir(real) + '/run/')).toBe(true)
      for (const base of [longAlias, selected, real + '/', normalizeDataDir(real)]) {
        expect(runPathsOf({ home, base }, root)).toEqual(expected)
      }
      const pending = join(real, 'first', '.magic')
      const before = runPathsOf({ home, base: pending }, root)
      expect(existsSync(pending)).toBe(false)
      expect(runPathsOf({ home, base: join(longAlias, 'first', '.magic') }, root)).toEqual(before)
      mkdirSync(pending, { recursive: true })
      expect(runPathsOf({ home, base: pending }, root)).toEqual(before)
      expect(runPathsOf({ home, base: join(real, 'other', '.magic') }, root)).not.toEqual(before)
    } finally { removeDir(root) }
  })

  test('/var 与 /private/var 的首次目录共用同一运行身份', () => {
    if (process.platform !== 'darwin') return
    const root = mkdtempSync('/var/tmp/magic-d55-')
    try {
      const base = join(root, 'first', '.magic')
      const canonical = '/private' + base
      const paths = runPathsOf({ home: root, base }, '/tmp')
      expect(runPathsOf({ home: root, base: canonical }, '/tmp')).toEqual(paths)
      mkdirSync(base, { recursive: true })
      expect(runPathsOf({ home: root, base }, '/tmp')).toEqual(paths)
    } finally { removeDir(root) }
  })

  test('实体过长时所有别名都选同一临时运行目录', () => {
    const root = mkdtempSync('/tmp/magic-d55-')
    try {
      const base = join(root, 'deep-' + 'x'.repeat(140), '.magic')
      mkdirSync(base, { recursive: true })
      const alias = join(root, 'short')
      symlinkSync(base, alias, 'dir')
      const canonical = runPathsOf({ home: root, base }, root)
      expect(canonical.dir.startsWith(join(root, 'magic-run-'))).toBe(true)
      expect(runPathsOf({ home: root, base: alias }, root)).toEqual(canonical)
    } finally { removeDir(root) }
  })
})
