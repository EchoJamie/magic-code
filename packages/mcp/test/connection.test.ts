/**
 * 适配器用例 —— **连接这一层自己的账**（U38）。
 *
 * 覆盖发现 / 调用 / 非文本部件 / 服务器报错 / 超时 / 取消 / 断连 / 关闭释放 / 起手失败。
 * 审批与回填不在这儿（那是工具域与权限域的账，在 app 的全链用例里验）。
 *
 * 夹具一律**真进程**（`test/support/fake-server.ts` 走官方 SDK 的服务器面）——
 * 起手有界、断连、关闭释放这三条**只有真进程验得出来**（假实现里它们不存在）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpConnection, McpServerConfig } from '@magic/contracts'
import { createStdioConnection } from '../src/stdio.ts'

const SERVER = join(import.meta.dir, 'support', 'fake-server.ts')

/** 一块沙地：临时目录（调用流水落在里面）＋ 用完了删干净。 */
const stages: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-mcp-'))
  stages.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of stages.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 拉一条连接（起手那一趟跑完再交出来）——夹具的缺省形。 */
async function connect(
  overrides: Partial<McpServerConfig> = {},
  options: {
    readonly server?: string
    readonly dir?: string
    readonly callTimeoutMs?: number
    readonly connectTimeoutMs?: number
    /** 夹具的哪一幕（见 `support/fake-server.ts` 头注）。 */
    readonly mode?: string
  } = {},
): Promise<{ readonly connection: McpConnection; readonly log: string }> {
  const dir = options.dir ?? tempDir()
  const log = join(dir, 'calls.jsonl')

  const connection = createStdioConnection({
    server: options.server ?? 'fake',
    config: {
      command: process.execPath, // 就是 bun 自己——夹具不必依赖 PATH 上有什么
      args: [SERVER],
      env: {
        FAKE_MCP_LOG: log,
        FAKE_MCP_NAME: options.server ?? 'fake',
        ...(options.mode === undefined ? {} : { FAKE_MCP_MODE: options.mode }),
      },
      ...overrides,
    },
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
  })

  await connection.start()
  return { connection, log }
}

/** 调用流水（服务器自己数的数）——一行一次调用。 */
function callsOf(log: string): readonly { tool: string; pid: number }[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { tool: string; pid: number })
}

/** 服务器记下的**它自己拉起的那个后代**（`descendants` 那一幕的 pid）。 */
function descendantPidOf(log: string): number | undefined {
  if (!existsSync(log)) return undefined
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line) as { kind?: string; pid?: number }
    if (entry.kind === 'child') return entry.pid
  }
  return undefined
}

describe('发现', () => {
  test('连上之后给出服务器的工具表（名字 / 说明 / 参数）', async () => {
    const { connection } = await connect()

    expect(connection.state.status).toBe('available')

    const tools = connection.tools()
    expect(tools.map((tool) => tool.name)).toContain('echo')

    const echo = tools.find((tool) => tool.name === 'echo')
    expect(echo?.description).toBe('把 text 原样回给你')
    expect(echo?.parameters).toMatchObject({ type: 'object' })

    await connection.close()
  })

  test('服务器自报的只读 / 幂等不进发现结果（自报不算数）', async () => {
    const { connection } = await connect()
    const annotated = connection.tools().find((tool) => tool.name === 'annotated')

    // 发现的结果只有三件——annotations 那一套压根不过这一层（审批口径由工具域定死）
    expect(annotated).toBeDefined()
    expect(Object.keys(annotated ?? {})).toEqual(['name', 'description', 'parameters'])

    await connection.close()
  })
})

describe('调用', () => {
  test('文本结果原样回来', async () => {
    const { connection, log } = await connect()
    const outcome = await connection.call('echo', { text: '你好' })

    expect(outcome).toEqual({ kind: 'result', ok: true, parts: [{ kind: 'text', text: '你好' }] })
    expect(callsOf(log).map((call) => call.tool)).toEqual(['echo'])

    await connection.close()
  })

  test('结构化结果作为一段 JSON 文本交出', async () => {
    const { connection } = await connect()
    const outcome = await connection.call('snapshot', {})

    expect(outcome.kind).toBe('result')
    if (outcome.kind !== 'result') return
    expect(outcome.parts.map((part) => part.kind)).toEqual(['text', 'structured'])
    expect(outcome.parts.at(-1)).toEqual({
      kind: 'structured',
      text: '{"count":2,"items":["a","b"]}',
    })

    await connection.close()
  })

  test('非文本部件报出类型与字节数（不静默丢）', async () => {
    const { connection } = await connect()
    const outcome = await connection.call('shot', {})

    expect(outcome.kind).toBe('result')
    if (outcome.kind !== 'result') return
    expect(outcome.parts).toEqual([
      { kind: 'text', text: '这是截图' },
      { kind: 'other', type: 'image', mimeType: 'image/png', bytes: 5 }, // 'hello' 五个字节
    ])

    await connection.close()
  })

  test('服务器说这次错了——是「结果如此」，不是「没做成」', async () => {
    const { connection } = await connect()
    expect(await connection.call('fail', {})).toEqual({
      kind: 'result',
      ok: false,
      parts: [{ kind: 'text', text: '这件事做不成' }],
    })

    await connection.close()
  })
})

describe('失败的三例（各有确定结果）', () => {
  test('超时——到点即落定，不挂死', async () => {
    const { connection } = await connect({}, { callTimeoutMs: 300 })
    const outcome = await connection.call('slow', {})

    expect(outcome.kind).toBe('failed')
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('timeout')

    await connection.close()
  })

  test('取消——已发出取消请求，落定', async () => {
    const { connection } = await connect()
    const controller = new AbortController()
    const pending = connection.call('slow', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    const outcome = await pending
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('canceled')

    await connection.close()
  })

  test('断连——服务器在途没了，落成「未收到结果」那一路', async () => {
    const { connection } = await connect()
    const outcome = await connection.call('boom', {})

    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('unreachable')

    await connection.close()
  })
})

describe('起手与释放', () => {
  test('起不来＝不可用 ＋ 缘由（不抛、不拖垮别的）', async () => {
    const connection = createStdioConnection({
      server: 'missing',
      config: { command: join(tempDir(), '没有这个可执行文件') },
      connectTimeoutMs: 3_000,
    })

    await connection.start() // 不抛

    expect(connection.state.status).toBe('unavailable')
    // 缘由**说人话**（这一句会上屏）：哪条命令、怎么不对——不是 `posix_spawn` 那一串
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toContain('找不到可执行文件')
    expect(reason).not.toContain('posix_spawn')
    expect(connection.tools()).toEqual([])

    // 没连上时的调用也是确定结果。
    // **原锚** `'unreachable'`；**为何变**：返工 A 把「本次没发出去」与「发出去之后断了
    // （效果未知）」分成两种结果（独立验收问题 4）；**新锚** `'not-sent'`。
    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('not-sent')

    await connection.close()
  })

  test('关闭释放自有子进程——进程没了，且可以再关一次', async () => {
    const dir = tempDir()
    const { connection, log } = await connect({}, { dir })
    await connection.call('echo', { text: 'x' })

    const pid = callsOf(log)[0]?.pid
    expect(typeof pid).toBe('number')
    expect(isAlive(pid as number)).toBe(true)

    await connection.close()
    await waitGone(pid as number)

    expect(isAlive(pid as number)).toBe(false)
    await connection.close() // 幂等：再关一次不炸（收尾路径可能走两遍）

    // 释放之后的调用仍是确定结果——且**读数当场归位**（原锚：仍是 `available` ＋ 旧工具表；
    // 为何变：返工 A 的问题 4「断连或主动关闭后，连接读数仍报可用」；新锚：不可用 ＋ 空表）
    expect(connection.state.status).toBe('unavailable')
    expect(connection.tools()).toEqual([])

    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('not-sent')
  })
})

describe('发现要翻完分页（返工 A · 独立验收问题 3）', () => {
  test('两页工具表都进发现结果——不只看第一页', async () => {
    const { connection } = await connect({}, { mode: 'paged' })
    const names = connection.tools().map((tool) => tool.name)

    // 第一页 `echo` ＋ 第二页 `snapshot`（游标那一页）——两件都要在
    expect(names).toEqual(['echo', 'snapshot'])
    expect(connection.state.status).toBe('available')

    await connection.close()
  })

  test('坏游标（每页都指回同一个）——停，且不当成可用', async () => {
    const startedAt = Date.now()
    const { connection } = await connect({}, { mode: 'stuck' })

    // 停得下来（不是无限翻页）：整体预算之内落定
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(connection.state.status).toBe('unavailable')
    expect(connection.state.status === 'unavailable' ? connection.state.reason : '').toContain('游标')
    // 发现不完整 ⇒ 一件工具都不放行（半份表比没有更坏：模型以为「服务器就这些」）
    expect(connection.tools()).toEqual([])

    await connection.close()
  })
})

describe('自有子树要收干净（返工 A · 独立验收问题 2）', () => {
  test('关闭时服务器再拉的那一层也收掉；**无关进程不受影响**', async () => {
    const dir = tempDir()
    const log = join(dir, 'calls.jsonl')
    const { connection } = await connect({}, { dir, mode: 'descendants' })

    const child = descendantPidOf(log)
    expect(typeof child).toBe('number')
    expect(isAlive(child as number)).toBe(true)

    // **与本进程无关**的一个进程（没有归属关系）——收尾不许碰它
    const unrelated = Bun.spawn(['/bin/sleep', '60'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })

    try {
      await connection.close()
      await waitGone(child as number)

      expect(isAlive(child as number)).toBe(false)
      expect(isAlive(unrelated.pid)).toBe(true)
    } finally {
      unrelated.kill()
    }
  })
})

describe('读数跟着连接走（返工 A · 独立验收问题 4）', () => {
  test('服务器在途退出：结果照实（效果未知），读数当场不可用', async () => {
    const { connection } = await connect()

    expect(await connection.call('boom', {})).toMatchObject({ kind: 'failed', failure: 'unreachable' })
    await waitState(connection, 'unavailable')

    expect(connection.state.status).toBe('unavailable')
    // **断了**（不是我们放的）：工具表留着——模型下一轮照旧调得到，拿到的是一句
    // 说清楚了的话（下面的 `not-sent`），而不是「未注册的工具」那种像写错名字的答复
    expect(connection.tools().map((tool) => tool.name)).toContain('echo')

    // 之后的调用是**没发出去**（不是「效果未知」）——两者分开报
    const after = await connection.call('echo', { text: 'x' })
    expect(after.kind === 'failed' ? after.failure : undefined).toBe('not-sent')

    await connection.close()
  })

  test('主动关闭后：不可用 ＋ 空表（读数不留假账）', async () => {
    const { connection } = await connect()
    expect(connection.state.status).toBe('available')

    await connection.close()

    expect(connection.state.status).toBe('unavailable')
    expect(connection.tools()).toEqual([])
  })
})

describe('服务器先崩再 close（返工 A 补正 · 独立复验退回的那一条）', () => {
  test('崩之前数到的后代照收——不靠「close 那一刻还数得到」', async () => {
    const dir = tempDir()
    const log = join(dir, 'calls.jsonl')
    const { connection } = await connect({}, { dir, mode: 'descendants' })

    const child = descendantPidOf(log)
    expect(typeof child).toBe('number')
    expect(isAlive(child as number)).toBe(true)

    // 服务器**自己崩**：调用进去了、活没干完，进程没了。
    // ⚠️ 此刻 SDK 那一侧的 `pid` 已经收走——「等到 close 再数」是数不到的（复验就是栽在这）
    expect(await connection.call('boom', {})).toMatchObject({ kind: 'failed', failure: 'unreachable' })
    await waitState(connection, 'unavailable')

    // **close 还没叫**，那一层就该被收掉（它是孤儿了）
    await waitGone(child as number)
    expect(isAlive(child as number)).toBe(false)

    // 之后 close 照常（幂等、不炸），且**工具表清空**——「断了留着」只属于还活着的那条连接
    await connection.close()
    expect(connection.state.status).toBe('unavailable')
    expect(connection.tools()).toEqual([])
  })
})

test('**调用中途**才起的后代、父随即崩——照样收得到（组归属，不靠崩前数过什么）', async () => {
    const dir = tempDir()
    const log = join(dir, 'calls.jsonl')
    const { connection } = await connect({}, { dir })

    // 这一件工具是「起一层后代 ＋ 当场自尽」：观察时点**来不及**看见那个后代
    // （它出生在调用中途），只有「组里有什么就收什么」这条路认得出它
    expect(await connection.call('spawnboom', {})).toMatchObject({
      kind: 'failed',
      failure: 'unreachable',
    })

    const child = descendantPidOf(log)
    expect(typeof child).toBe('number')

    await waitGone(child as number)
    expect(isAlive(child as number)).toBe(false)

    await connection.close()
    expect(connection.state.status).toBe('unavailable')
  })

describe('复入 close（返工 A 补正 · 复验退回的最后一处）', () => {
  test('第二次 close 共享同一次收尾——不绕过等待、也不提前宣称已释放', async () => {
    const dir = tempDir()
    const log = join(dir, 'calls.jsonl')
    // 带后代那一幕：收尾真要花时间（关 stdin 之后等它退，到点才按组收）——
    // 「第二次立即返回」那种漏洞只有在这种「收尾确实要等」的场景里才露得出来
    const { connection } = await connect({}, { dir, mode: 'descendants' })

    const server = callsOf(log)[0]?.pid as number
    const child = descendantPidOf(log) as number
    expect(isAlive(server)).toBe(true)
    expect(isAlive(child)).toBe(true)

    const first = connection.close()
    const second = connection.close() // **复入**：同一趟收尾，不是另起一趟

    // ① 同一个 promise：谁调都一起等（「另起一趟」或「看见 transport 已置空就返回」都过不了这一条）
    expect(second).toBe(first)

    // ② **此刻**还没收完——读数不许已经写「连接已释放」（服务器还活着呢）
    expect(connection.state).not.toEqual({ status: 'unavailable', reason: '连接已释放' })

    await second

    // ③ 两次都落定之后：服务器与它那一层都真没了，读数才说已释放
    expect(isAlive(server)).toBe(false)
    await waitGone(child)
    expect(isAlive(child)).toBe(false)
    expect(connection.state).toEqual({ status: 'unavailable', reason: '连接已释放' })
    expect(connection.tools()).toEqual([])
  })
})

/** 等状态落定（有界——探针别无限等）。 */
async function waitState(connection: McpConnection, status: 'available' | 'unavailable'): Promise<void> {
  for (let i = 0; i < 100 && connection.state.status !== status; i += 1) await Bun.sleep(20)
}

/** 进程还在不在（`kill 0` 只探活，不发信号）。 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 等它没（关 stdin → 服务器自己退；上限 5s）。 */
async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (!isAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
