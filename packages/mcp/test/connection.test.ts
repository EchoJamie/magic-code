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
  options: { readonly server?: string; readonly dir?: string; readonly callTimeoutMs?: number; readonly connectTimeoutMs?: number } = {},
): Promise<{ readonly connection: McpConnection; readonly log: string }> {
  const dir = options.dir ?? tempDir()
  const log = join(dir, 'calls.jsonl')

  const connection = createStdioConnection({
    server: options.server ?? 'fake',
    config: {
      command: process.execPath, // 就是 bun 自己——夹具不必依赖 PATH 上有什么
      args: [SERVER],
      env: { FAKE_MCP_LOG: log, FAKE_MCP_NAME: options.server ?? 'fake' },
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
    expect(connection.state.status === 'unavailable' ? connection.state.reason : '').not.toBe('')
    expect(connection.tools()).toEqual([])

    // 没连上时的调用也是确定结果（「没发出去」——不复述「远端可能已执行」）
    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('unreachable')

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

    // 释放之后的调用仍是确定结果
    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('unreachable')
  })
})

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
