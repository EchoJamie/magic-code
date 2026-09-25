/**
 * U70 · **后台运行登记**（`exec` 的后台那一形 · 发起与停）——执行域那一半的判据。
 *
 * 设计 · 工具执行与权限「`exec` 有「后台」那一形」六格里，落在本文件的是**第一格（发起）**
 * 与**第五格（停）**，外加两处边界（输出落在工作区之外 · 「输出安静了」不等于「它结束了」）。
 * 「取输出」那一格（用既有的 `read` 读那个文件）在本文件末尾——它是沙箱边界的事。
 *
 * 四条判据：
 * 1. **发起**——当场回「认得出它的 id ＋ 它的输出文件路径」，命令在**工作区之外**跑；
 * 2. **结束**——进程真退出时 `onFinish` 响**一次**；dev server 那种**永不结束**的，
 *    一直不响（⚠️ 不许据「输出安静了」判结束）；
 * 3. **停**——按 id 停，落到实处是**按进程组**停（命令起的孙进程一并收走，`pgrep` 证明）；
 *    分得清「收干净了 / 本来就结束了 / 认不出这个 id」三种；
 * 4. **沙箱认得那处只读落点**——`read` 读得到输出文件，`write` / `list` / `match` 一个都不认。
 *
 * 测试用 fs 不受守护拦（守护面收窄至各包 `src/`）——夹具照用临时目录。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BackgroundFinish, BackgroundRuns, BackgroundStart } from '@magic/contracts'
import {
  createBackgroundRuns,
  createProcessLedger,
  createSandbox,
  createWorkspaceService,
} from '../src/index.ts'

// —— 夹具 ——

const lands: string[] = []

/** 一块沙地：工作区（真临时目录）＋ 输出目录（在它**之外**，同 `MAGIC_HOME` 那种住法）。 */
type Land = {
  readonly root: string
  readonly workspace: string
  readonly outputDir: string
}

function freshLand(): Land {
  const root = mkdtempSync(join(tmpdir(), 'magic-bg-'))
  lands.push(root)
  const workspace = join(root, 'ws')
  // 工作区根须已存在（工作区构造取 realpath——宁可在构造期响亮失败）
  mkdirSync(workspace, { recursive: true })
  return { root, workspace, outputDir: join(root, 'run', 'bg') }
}

/** 造一份登记 ＋ 一本归属账（账是**用例读 pgid 的唯一来处**——id 是 `bg-N`，不含进程号）。 */
function runsOn(land: Land): { runs: BackgroundRuns; ledger: ReturnType<typeof createProcessLedger> } {
  const workspace = createWorkspaceService({ roots: [land.workspace] })
  const ledger = createProcessLedger()
  return { runs: createBackgroundRuns({ dir: land.outputDir, workspace, ledger }), ledger }
}

/** 取 `ok:true` 分支——失败分支直接判死（顺带把判别联合收窄给 tsc）。 */
function startedOf(result: BackgroundStart): Extract<BackgroundStart, { ok: true }> {
  if (!result.ok) throw new Error(`期望交出去了，实为：${result.reason}`)
  return result
}

/** 等到条件成立（或超时）——不让用例靠一个写死的 sleep 赌时间。 */
async function until(ready: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !ready()) await Bun.sleep(10)
}

/**
 * **这一组里现在有哪些进程**（`pgrep -g`，pid 升序）。
 *
 * 判据取**进程表**而不是我们自己的账本：账本说「收干净了」不作数，得看系统上还剩谁。
 */
function groupPids(pgid: number): readonly string[] {
  const done = Bun.spawnSync(['pgrep', '-g', String(pgid)], { stdout: 'pipe', stderr: 'ignore' })
  return new TextDecoder()
    .decode(done.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** 这一代账上那一条（用例只起一条，故取第一条）。 */
function pgidOf(ledger: ReturnType<typeof createProcessLedger>): number {
  const owned = ledger.list()
  const first = owned[0]
  if (first === undefined) throw new Error('账上没有这一组——夹具或记账那一跳出问题了')
  return first.pgid
}

// 收尾——测试进程退出前清掉临时目录（失败时也清）
process.on('exit', () => {
  for (const root of lands) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // 清理失败不影响判定
    }
  }
})

// ══ 判据 1 · 发起 ═════════════════════════════════════════════════════

describe('判据 1 · 发起——交出去就回', () => {
  test('当场回 id ＋ 输出文件路径，且那个文件在**工作区之外**', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const started = startedOf(await runs.start('echo hi', {}))

    expect(started.id).toBe('bg-1')
    // **工作区之外**（设计明写：落在工作区里会被当成项目文件，也会被后续的 ls / grep 撞上）
    expect(started.outputPath.startsWith(`${land.workspace}/`)).toBe(false)
    expect(started.outputPath.startsWith(`${land.outputDir}/`)).toBe(true)
  })

  test('id 一条一条往上发（同一代里不重号）', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const first = startedOf(await runs.start('true', {}))
    const second = startedOf(await runs.start('true', {}))

    expect([first.id, second.id]).toEqual(['bg-1', 'bg-2'])
  })

  test('输出落进那个文件（stdout 与 stderr 按序同在）', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const started = startedOf(
      await runs.start('echo 第一行; echo 到 stderr >&2; echo 第三行', {
        onFinish: (finish) => done.push(finish),
      }),
    )

    await until(() => done.length === 1)
    expect(readFileSync(started.outputPath, 'utf8')).toBe('第一行\n到 stderr\n第三行\n')
  })

  test('cwd 越界＝发起不成立（与沙箱同一条解析规则）', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const result = await runs.start('pwd', { cwd: '/definitely-outside' })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('不该成立')
    expect(result.reason).toContain('工作区越界')
  })

  test('记进归属账（U50）——后台进程比发起它的那一轮活得久，尤其要记', async () => {
    const land = freshLand()
    const { runs, ledger } = runsOn(land)

    const started = startedOf(await runs.start('sleep 5', {}))
    const owned = ledger.list()

    expect(owned.length).toBe(1)
    expect(owned[0]?.what.startsWith('exec(bg):')).toBe(true)

    await runs.stop(started.id)
    await until(() => ledger.list().length === 0)
  })
})

// ══ 判据 2 · 结束 ═════════════════════════════════════════════════════

describe('判据 2 · 结束——真退出才响，且只响一次', () => {
  test('自己跑完 ⇒ 响一次，带上 id / 命令 / 输出路径 / 退出码', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const started = startedOf(
      await runs.start('echo 好了', { onFinish: (finish) => done.push(finish) }),
    )
    await until(() => done.length === 1)

    expect(done[0]).toEqual({
      id: started.id,
      command: 'echo 好了',
      outputPath: started.outputPath,
      ok: true,
      exit: 0,
    })

    // **只响一次**——再等一会儿，还是那一条（不许「响过又响」）
    await Bun.sleep(120)
    expect(done.length).toBe(1)
  })

  test('非 0 退出 ⇒ ok:false（命令跑了、没成，不是没跑）', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    await runs.start('exit 3', { onFinish: (finish) => done.push(finish) })
    await until(() => done.length === 1)

    expect(done[0]?.ok).toBe(false)
    expect(done[0]?.exit).toBe(3)
  })

  /**
   * ⚠️ **「输出安静了」不等于「它结束了」**（设计点名的那一条）。
   *
   * 这条命令先吐一行、然后一直挂着——**没有输出**与**已经结束**是两件事。
   * 用例只等三百毫秒（远短于它要活的时间），验的就是「不许据安静判结束」。
   */
  test('dev server 那一形——吐了一行就挂着，`onFinish` 一声不响', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const started = startedOf(
      await runs.start('echo 起来了; sleep 30', { onFinish: (finish) => done.push(finish) }),
    )

    await Bun.sleep(300)
    expect(done.length).toBe(0)
    // 它**真在跑**——输出已经落下来了（不是「没起来」）
    expect(readFileSync(started.outputPath, 'utf8')).toContain('起来了')

    // 收尾——用例自己把它停掉，不留一条挂着的进程
    await runs.stop(started.id)
    await until(() => done.length === 1)
    expect(done[0]?.stopped).toBe(true)
  })

  test('停掉那一趟 ⇒ 那一条标着「是停的，不是自己跑完的」', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs, ledger } = runsOn(land)

    const started = startedOf(
      await runs.start('sleep 30', { onFinish: (finish) => done.push(finish) }),
    )
    // 等它真起来（进程表上看得见它），再停
    await until(() => groupPids(pgidOf(ledger)).length >= 1)

    const stopped = await runs.stop(started.id)
    expect(stopped.ok).toBe(true)

    await until(() => done.length === 1)
    expect(done[0]?.stopped).toBe(true)
    expect(done[0]?.ok).toBe(false)
  })
})

// ══ 判据 3 · 停（落实在进程组上）══════════════════════════════════════

describe('判据 3 · 停——按 id 停，落在进程组上', () => {
  /**
   * **孙进程也收走了**（设计：「命令起的孙进程一并收走，不留一窝逃逸的孤儿」）。
   *
   * 剧本：命令自己再起一个后台 `sleep`（孙进程）→ 组里应当**不止一个** → 按 id 停
   * → **`pgrep -g` 一个都不剩**。
   */
  test('按 id 停 ⇒ 它起的孙进程也没了（pgrep 证明组空了）', async () => {
    const land = freshLand()
    const { runs, ledger } = runsOn(land)

    const started = startedOf(await runs.start('sleep 30 & sleep 30', {}))
    const pgid = pgidOf(ledger)

    // 等这一组真起来——组里应当**不止一个**（`sh` 自己 ＋ 它起的那个）
    await until(() => groupPids(pgid).length >= 2)
    expect(groupPids(pgid).length).toBeGreaterThanOrEqual(2)

    const stopped = await runs.stop(started.id)
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) throw new Error('不该不成立')

    // **组空了**——`pgrep` 是这里唯一的判据（「收干净了」不许由我们自己声称）
    await until(() => groupPids(pgid).length === 0, 3_000)
    expect(groupPids(pgid)).toEqual([])
  })

  test('认不出的 id ⇒ 说的是「没有这一条」，不冒充停掉了', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const stopped = await runs.stop('bg-99')
    expect(stopped.ok).toBe(false)
    if (stopped.ok) throw new Error('不该成立')
    expect(stopped.reason).toContain('bg-99')
  })

  test('本来就结束了 ⇒ 说得清是「本来就结束了」，不冒充是自己收的', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const started = startedOf(await runs.start('true', { onFinish: (finish) => done.push(finish) }))
    await until(() => done.length === 1)

    const stopped = await runs.stop(started.id)
    expect(stopped.ok).toBe(true)
    if (!stopped.ok) throw new Error('不该不成立')
    expect(stopped.already).toBe(true)
  })
})

// ══ 判据 5 · 读面（还在跑的那些 · U89）═════════════════════════════════

/**
 * 「**还在跑**」这件事此前问不到：登记只在自己内部那本账上，而模型需要的正是它
 * （设计 · 提示词与指令 甲 ②：没有它，模型会**重复启动同一条命令**）。
 *
 * 这一面的判据是**两向**的：在跑的在列 · 跑完的 / 被停的**当场不在列**。
 * 后者尤其要紧——「删不准说成还在跑」（工单明文）：把已经结束的说成还在跑，
 * 比不报更坏（模型据此以为还能等到它的输出）。
 */
describe('判据 5 · 读面——只列此刻真没退出的', () => {
  test('一条在跑的：三件对得上（id / 命令 / 输出文件）', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const started = startedOf(await runs.start('sleep 30', {}))
    const live = runs.running()

    expect(live).toEqual([
      { id: started.id, command: 'sleep 30', outputPath: started.outputPath },
    ])

    await runs.stop(started.id)
  })

  test('⚠️ 自己跑完 ⇒ 当场不在列（不是「还在列着」）', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const started = startedOf(
      await runs.start('true', { onFinish: (finish) => done.push(finish) }),
    )
    await until(() => done.length === 1)

    expect(runs.running()).toEqual([])
    // 「结没结束」与「在不在列」是同一件事的两面——那一声回执响过，这一面就该空了
    expect(started.id).toBe('bg-1')
  })

  test('⚠️ 被停掉 ⇒ 也不在列（跑完与被停，两条路都不许说成还在跑）', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs, ledger } = runsOn(land)

    const started = startedOf(
      await runs.start('sleep 30', { onFinish: (finish) => done.push(finish) }),
    )
    await until(() => groupPids(pgidOf(ledger)).length >= 1)
    expect(runs.running().length).toBe(1)

    await runs.stop(started.id)
    await until(() => done.length === 1)

    expect(runs.running()).toEqual([])
  })

  test('一条都没有 ⇒ 空表（不是 undefined、也不是一条编出来的）', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    expect(runs.running()).toEqual([])
  })

  test('几条按**交出去的次序**排（1 在前、2 在后）；摘一条不影响别条', async () => {
    const land = freshLand()
    const done: BackgroundFinish[] = []
    const { runs } = runsOn(land)

    const first = startedOf(await runs.start('sleep 30', {}))
    const second = startedOf(await runs.start('true', { onFinish: (finish) => done.push(finish) }))

    await until(() => done.length === 1)
    // 短的那条跑完了 ⇒ 只剩第一条，且它还在原位
    expect(runs.running().map((run) => run.id)).toEqual([first.id])
    expect(runs.running()[0]?.command).toBe('sleep 30')

    await runs.stop(second.id) // 本来就结束了——说得清，不会误伤第一条
    await runs.stop(first.id)
  })

  test('⚠️ dev server 那种挂着的：**一直在列**（不据「输出安静了」摘它）', async () => {
    const land = freshLand()
    const { runs } = runsOn(land)

    const started = startedOf(await runs.start('echo 起来了; sleep 30', {}))
    await Bun.sleep(300)

    // 安静了（不再吐字）——但没结束：读面照旧列着它
    expect(runs.running().map((run) => run.id)).toEqual([started.id])

    await runs.stop(started.id)
  })
})

// ══ 判据 4 · 取输出（「用既有的 read 读那个文件」）══════════════════════

describe('判据 4 · 取输出——既有 `read` 读得到，写 / 列 / 匹配都不认', () => {
  test('`read` 读得到输出文件（它在工作区之外）', async () => {
    const land = freshLand()
    const workspace = createWorkspaceService({ roots: [land.workspace] })
    const box = createSandbox({ workspace, readOnlyDirs: [land.outputDir] })
    const runs = createBackgroundRuns({ dir: land.outputDir, workspace })

    const done: BackgroundFinish[] = []
    const started = startedOf(
      await runs.start('echo 输出在这儿', { onFinish: (finish) => done.push(finish) }),
    )
    await until(() => done.length === 1)

    const read = await box.read(started.outputPath)
    expect(read.content).toBe('输出在这儿\n')
    expect(read.truncated).toBeUndefined()
  })

  test('**只有 `read`** 认它——`write` / `list` / `match` 一个都不认', async () => {
    const land = freshLand()
    const workspace = createWorkspaceService({ roots: [land.workspace] })
    const box = createSandbox({ workspace, readOnlyDirs: [land.outputDir] })
    const runs = createBackgroundRuns({ dir: land.outputDir, workspace })

    const started = startedOf(await runs.start('true', {}))

    await expect(box.write(started.outputPath, { text: 'x' })).rejects.toThrow('工作区越界')
    await expect(box.list(land.outputDir)).rejects.toThrow('工作区越界')
    await expect(box.match('x', { mode: 'grep', path: started.outputPath })).rejects.toThrow(
      '工作区越界',
    )
  })

  test('不接那处落点（旧装配）＝ 越界照旧——一次都不多地认', async () => {
    const land = freshLand()
    const workspace = createWorkspaceService({ roots: [land.workspace] })
    const box = createSandbox({ workspace })
    const runs = createBackgroundRuns({ dir: land.outputDir, workspace })

    const started = startedOf(await runs.start('true', {}))

    await expect(box.read(started.outputPath)).rejects.toThrow('工作区越界')
  })
})
