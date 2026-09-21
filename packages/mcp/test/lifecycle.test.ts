/**
 * 重连与收尾的几处**竞态**（U39 补验）——生命周期那一层自己的账。
 *
 * 三件事各有一条可观察的判据：
 * - **连续两次重连**：只走一趟——服务器那边「建了几条会话」与「删了几条」对得上
 *   （不对上＝有条会话没人收）；
 * - **重连在途时退出**：收尾之后读数**不许再被写回「可用」**，会话照旧一条不剩；
 * - **旧那一趟晚到**：不写读数、也不留下自己那条传输（stdio 侧看**子进程**收干净没有）。
 *
 * 夹具是真进程＋真 HTTP，且带**可控的握手/发现延迟**（`FAKE_MCP_HTTP_DELAY_MS` /
 * `FAKE_MCP_DELAY_MS`）——没有延迟就摆不出「在途」这个场面。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpConnection, createStdioConnection } from '../src/index.ts'

const HTTP_SERVER = join(import.meta.dir, 'support', 'fake-http-server.ts')
const STDIO_SERVER = join(import.meta.dir, 'support', 'fake-server.ts')

const stages: string[] = []
const running: Bun.Subprocess[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-mcp-life-'))
  stages.push(dir)
  return dir
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
  for (const dir of stages.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function serveHttp(delayMs: number): Promise<string> {
  const dir = tempDir()
  const child = Bun.spawn([process.execPath, HTTP_SERVER], {
    env: {
      ...process.env,
      FAKE_MCP_HTTP_PORT: '0',
      FAKE_MCP_HTTP_LOG: join(dir, 'server.jsonl'),
      FAKE_MCP_HTTP_MODE: 'ok',
      FAKE_MCP_HTTP_DELAY_MS: String(delayMs),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  running.push(child)

  const first = await child.stdout.getReader().read()
  const port = JSON.parse(new TextDecoder().decode(first.value)).port as number
  return `http://127.0.0.1:${port}/mcp`
}

function linesOf(log: string): readonly Record<string, unknown>[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 服务器自己数的会话账：开了几条、关了几条（关＝收尾那一趟真到了）。 */
function sessionTally(log: string): { readonly opened: number; readonly closed: number } {
  const rows = linesOf(log).filter((one) => one['kind'] === 'session')
  return {
    opened: rows.filter((one) => one['op'] === 'open').length,
    closed: rows.filter((one) => one['op'] === 'close').length,
  }
}

/** 这一台服务器**自己拉起的那些后代**的 pid（每个实例一个——看进程收干净没有）。 */
function childPids(log: string): readonly number[] {
  return linesOf(log)
    .filter((one) => one['kind'] === 'child')
    .map((one) => one['pid'] as number)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (!isAlive(pid)) return
    await Bun.sleep(50)
  }
}

describe('连续两次重连（U39 补验）', () => {
  test('HTTP：只走一趟——**建了几条会话就删几条**，读数可用', async () => {
    const url = await serveHttp(400)
    const connection = createHttpConnection({ server: 'x', config: { url }, connectTimeoutMs: 6_000 })
    await connection.start()

    // **同一刻两次**（用户在抽屉里连按两下回车那种情形）
    await Promise.all([connection.reconnect(), connection.reconnect()])

    expect(connection.state.status).toBe('available')

    const log = join(stages.at(-1) as string, 'server.jsonl')
    await connection.close()

    const tally = sessionTally(log)
    expect(tally.opened).toBe(tally.closed) // 一条都没落下
  })

  test('stdio：只走一趟——**起过的进程一个都不留**', async () => {
    const dir = tempDir()
    const log = join(dir, 'calls.jsonl')
    const connection = createStdioConnection({
      server: 'x',
      config: {
        command: process.execPath,
        args: [STDIO_SERVER],
        env: { FAKE_MCP_LOG: log, FAKE_MCP_MODE: 'descendants', FAKE_MCP_DELAY_MS: '300' },
      },
      connectTimeoutMs: 8_000,
    })
    await connection.start()

    await Promise.all([connection.reconnect(), connection.reconnect()])
    expect(connection.state.status).toBe('available')

    await connection.close()

    // 每个起过的假服务器都留了一个后代 pid——**全该没了**（留一个＝留了一条没人收的连接）
    const children = childPids(log)
    expect(children.length).toBeGreaterThan(0)
    for (const pid of children) {
      await waitGone(pid)
      expect(isAlive(pid)).toBe(false)
    }
  })
})

describe('重连在途时退出（U39 补验）', () => {
  test('收尾之后**不许再写回「可用」**，会话一条不剩', async () => {
    const url = await serveHttp(600)
    const connection = createHttpConnection({ server: 'x', config: { url }, connectTimeoutMs: 6_000 })
    await connection.start()

    const reconnecting = connection.reconnect() // 在途（服务器那一头慢）
    await Bun.sleep(200)
    await connection.close()
    await reconnecting

    // 越过所有延迟，看有没有迟到的写回
    await Bun.sleep(1_500)

    expect(connection.state).toEqual({ status: 'unavailable', reason: '连接已释放' })
    expect(connection.tools()).toEqual([])

    const log = join(stages.at(-1) as string, 'server.jsonl')
    const tally = sessionTally(log)
    expect(tally.opened).toBe(tally.closed)
  })

  test('起手在途时退出：同样不许写回（**旧那一趟晚到**也不许动读数）', async () => {
    const url = await serveHttp(600)
    const connection = createHttpConnection({ server: 'x', config: { url }, connectTimeoutMs: 6_000 })

    const starting = connection.start() // 在途
    await Bun.sleep(150)
    await connection.close()
    await starting
    await Bun.sleep(1_500)

    expect(connection.state).toEqual({ status: 'unavailable', reason: '连接已释放' })
    expect(connection.tools()).toEqual([])

    // ⚠️ 这一幕**会话账对不平**：收尾发生在握手落定之前，会话号还没到手（`Mcp-Session-Id`
    // 在那条被中止的响应里），故我们**发不出**那一次终止——远端**可能**留着这一条会话，
    // 收不收由它的策略定（本版不替它承诺）。这里钉的是**我们这一侧**的两件：
    // 读数不许被写回、也不许再多起一条（多起来的才是账）。
    const log = join(stages.at(-1) as string, 'server.jsonl')
    const tally = sessionTally(log)
    expect(tally.opened).toBe(1)
    expect(tally.closed).toBe(0)
  })
})
