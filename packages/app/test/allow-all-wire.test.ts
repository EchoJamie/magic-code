/**
 * U73 · **全放行与开局选中走的是同一条线**（窗口 `hello` → 管理者 → 发车参数）。
 *
 * ## 为什么单有一份
 *
 * 全放行要在**执行者造闸门之前**落地，故它只能随 `hello` 递进去、由管理者放进**为这个窗口
 * 新起那一代**的发车参数里（见 `wire.ts` 的 `allowAll`）。这条线有**三跳**：
 *
 * ```
 *   窗口（cli.ts 的 argv） → client.greet 的 hello → manager 的 conn → launch 的 ExecutorRequest
 * ```
 *
 * 而 U73 实测出这条线上有个**半死的先例**：`switch`（`--provider` / `--model`）在
 * **第二跳丢了**——`wire.ts` 的 `hello` 与 `manager.ts` 都认它，唯独 `client.ts` 的 `greet`
 * 按 `ConnectOptions` 的旧形状拼、没往上带。症状是**静默**：`magic --provider X` 照常起、
 * 照常跑，只是**从来没用上 X**（真 PTY 上才看得出来，单元测试全绿）。
 *
 * ⇒ 这一份把**两件**都钉在**发车参数**上：它是这条线的**出口**，也是唯一能一眼看出
 * 「它到底上没上线」的地方。**跳了任何一跳，两条用例同时红。**
 *
 * ⚠️ 判据落在 `ExecutorRequest` 上、不落在「执行者拿到了没有」——后者要真起一个进程，
 * 而这一跳要证的是**接线**（真链路上的那一头由 `frames-u73-tui.ts` 的真 PTY 帧证）。
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { connectManager } from '../src/run/client.ts'
import { startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher, ExecutorRequest, Manager, SpawnedExecutor } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { removeDir, tempDir } from './tmp.ts'

type Ground = { readonly root: string; readonly home: string; readonly base: string; readonly dataDir: string; readonly tmp: string }

/** 一块沙地：家目录 / 基础目录 / 数据目录 / 临时目录四面各一处。 */
function ground(name: string): Ground {
  const root = tempDir(`magic-u73-wire-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = join(root, 'data')
  const tmp = join(root, 'tmp')
  for (const dir of [home, base, dataDir, tmp]) mkdirSync(dir, { recursive: true })

  return { root, home, base, dataDir, tmp }
}

/** 等一个条件成立（默认 5 秒）——轮询是用例的事，产品那几跳都是事件驱动的。 */
async function waitFor(what: string, ok: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/**
 * 立一摊（真管理者 ＋ **记下发车参数的假执行者**），连一个带 `hello` 入参的窗口，
 * 再让它发一条会开张的命令——**交回管理者收到的那几条发车参数**。
 */
async function spawnedWith(connect: { allowAll?: boolean; switch?: { model: string } }): Promise<readonly ExecutorRequest[]> {
  const g = ground('spawn')
  const requests: ExecutorRequest[] = []
  const launcher: ExecutorLauncher = {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      requests.push(request)
      return {
        pid: undefined,
        onExit() {},
        kill() {},
      }
    },
  }

  let manager: Manager | undefined
  let client: Awaited<ReturnType<typeof connectManager>> | undefined

  try {
    const paths = runPathsOf({ home: g.home, base: g.base }, g.dataDir, g.tmp)
    const started = await startManager({
      paths,
      dataDir: g.dataDir,
      magic: { home: g.home, base: g.base },
      launch: launcher,
      // 假执行者不会连回来——把生命探测调快，用例收尾时它自己走干净
      probeIntervalMs: 60,
    })
    if (started.role !== 'manager') throw new Error(`没立起来：${started.role}`)
    manager = started.manager

    client = await connectManager(paths.socket, {
      cwd: g.root,
      ...(connect.allowAll === undefined ? {} : { allowAll: connect.allowAll }),
      ...(connect.switch === undefined ? {} : { switch: connect.switch }),
    })
    if (client === undefined) throw new Error('连不上管理者')

    // 一条会开张的命令——「窗口的第一条命令走它」（`manager.ts` 的 `spawnFresh`）
    client.send({ type: 'session.new' })
    await waitFor('管理者为这个窗口发了一趟车', () => requests.length >= 1)

    return requests
  } finally {
    client?.close()
    manager?.stop('用例收尾')
    await manager?.waitUntilExit()
    removeDir(g.root)
  }
}

describe('U73 · 全放行走的是「窗口 hello → 发车参数」那条线', () => {
  test('`hello.allowAll` 一路到得了**发车参数**（三跳没跳掉任何一跳）', async () => {
    const requests = await spawnedWith({ allowAll: true })

    expect(requests[0]?.allowAll).toBe(true)
  })

  test('不带它时**缺席**（不发一个假值下去——「给没给」在发车参数上分得开）', async () => {
    const requests = await spawnedWith({})

    expect(requests[0]?.allowAll).toBeUndefined()
  })

  /**
   * ⚠️ **这一条不是 U73 的功能，是它顺手补上的一处断线**（见文件头注）：`switch` 与
   * `allowAll` 挤在同一个对象里往上带，U73 把那个对象补全了——这一条钉住「补全」那一半，
   * 免得将来有人只删掉 `switch` 那一行的转交而毫无察觉（那是**静默**的那种坏）。
   */
  test('同一条线上的 `switch`（`--provider` / `--model`）也到得了', async () => {
    const requests = await spawnedWith({ switch: { model: 'MiniMax-M3' } })

    expect(requests[0]?.switch).toEqual({ model: 'MiniMax-M3' })
  })
})
