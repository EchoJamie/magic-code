/** 验证窗口 hello 的全放行选项经过管理者传入执行者。 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { connectManager } from '../src/run/client.ts'
import { startManager } from '../src/run/manager.ts'
import type { ExecutorLauncher, ExecutorRequest, Manager, SpawnedExecutor } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { removeDir } from './tmp.ts'

type Ground = { readonly root: string; readonly home: string; readonly base: string; readonly dataDir: string; readonly tmp: string }

/** 一块沙地：家目录 / 基础目录 / 数据目录 / 临时目录四面各一处。 */
function ground(name: string): Ground {
  const root = mkdtempSync(`/tmp/magic-u73-wire-${name}-`)
  const home = join(root, 'home')
  const base = join(root, 'base')
  const dataDir = base
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
async function spawnedWith(connect: { allowAll?: boolean; switch?: { choice: 'default' } }): Promise<readonly ExecutorRequest[]> {
  const g = ground('spawn')
  const requests: ExecutorRequest[] = []
  let exit: ((reason: string) => void) | undefined
  const launcher: ExecutorLauncher = {
    spawn(request: ExecutorRequest): SpawnedExecutor {
      requests.push(request)
      return {
        onExit(listener) { exit = listener },
        cancel() { exit?.('测试执行者收到终止') },
      }
    },
  }

  let manager: Manager | undefined
  let client: Awaited<ReturnType<typeof connectManager>> | undefined

  try {
    const paths = runPathsOf({ home: g.home, base: g.base }, g.tmp)
    const started = await startManager({
      paths,
      magic: { home: g.home, base: g.base },
      launch: launcher,
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

    expect(requests).toHaveLength(0)
    // hello 只保存启动参数；明确输入才创建执行者。launcher 为替身，不会请求模型。
    client.send({ type: 'input.submit', text: '验证启动参数，不运行真实模型' })
    await waitFor('管理者为这个窗口发了一趟车', () => requests.length === 1)
    expect(requests).toHaveLength(1)

    return requests
  } finally {
    client?.close()
    // 假执行者也交回真实的结束回调，不能让宿主等待一个没有生命连接的假进程。
    exit?.('测试执行者结束')
    manager?.stop('用例收尾')
    await manager?.waitUntilExit()
    removeDir(g.root)
  }
}

describe('全放行走的是「窗口 hello → 发车参数」那条线', () => {
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
    const requests = await spawnedWith({ switch: { choice: 'default' } })

    expect(requests[0]?.switch).toEqual({ choice: 'default' })
  })
})
