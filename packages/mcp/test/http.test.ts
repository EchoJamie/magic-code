/**
 * Streamable HTTP 适配器用例 —— **连接这一层自己的账**（U39）。
 *
 * 覆盖发现 / 调用 / 非文本部件 / 失败三例 / 断流与重放 / 起手失败的四种缘由 / 收尾与
 * 终止会话 / 两条与 SDK 有关的核对（隐含重连关掉了 · 协议版本协商）。
 * 审批与回填不在这儿（那是工具域与权限域的账，在 app 的全链用例里验）。
 *
 * 夹具一律**真进程 ＋ 真 HTTP**（`test/support/fake-http-server.ts` 走官方 SDK 的服务器面）
 * ——「对端不在」「响应流断了」「重连补了几次」这几条只有真网络验得出来。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpConnection, McpHttpConfig } from '@magic/contracts'
import { createHttpConnection } from '../src/http.ts'

const SERVER = join(import.meta.dir, 'support', 'fake-http-server.ts')

/** 一块沙地：临时目录（服务器的留痕落在里面）＋ 用完了删干净。 */
const stages: string[] = []
/** 起过的服务器进程——每个用例收尾时一并收掉（不留孤儿）。 */
const running: Bun.Subprocess[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-mcp-http-'))
  stages.push(dir)
  return dir
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
  for (const dir of stages.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一台假 HTTP 服务器（真进程）——端口由系统分，从它那一行自报里读。 */
async function serve(
  mode = 'ok',
  body?: string,
  /** 每一趟请求先拖这么久——给竞态用例摆场面（见夹具那一格）。 */
  options: { readonly delayMs?: number } = {},
): Promise<{ url: string; log: string }> {
  const dir = tempDir()
  const log = join(dir, 'server.jsonl')
  const child = Bun.spawn([process.execPath, SERVER], {
    env: {
      ...process.env,
      FAKE_MCP_HTTP_PORT: '0',
      FAKE_MCP_HTTP_LOG: log,
      FAKE_MCP_HTTP_MODE: mode,
      ...(body === undefined ? {} : { FAKE_MCP_HTTP_BODY: body }),
      ...(options.delayMs === undefined ? {} : { FAKE_MCP_HTTP_DELAY_MS: String(options.delayMs) }),
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  running.push(child)

  const first = await child.stdout.getReader().read()
  const port = JSON.parse(new TextDecoder().decode(first.value)).port as number

  return { url: `http://127.0.0.1:${port}/mcp`, log }
}

/** 拉一条连接（起手那一趟跑完再交出来）——夹具的缺省形。 */
async function connect(
  config: Partial<McpHttpConfig> & { readonly url: string },
  options: {
    readonly server?: string
    readonly callTimeoutMs?: number
    readonly connectTimeoutMs?: number
  } = {},
): Promise<McpConnection> {
  const connection = createHttpConnection({
    server: options.server ?? 'fake',
    config,
    ...(options.callTimeoutMs === undefined ? {} : { callTimeoutMs: options.callTimeoutMs }),
    ...(options.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.connectTimeoutMs }),
  })

  await connection.start()
  return connection
}

/** 服务器留痕的一行行（`kind: 'call'` 是调用，`kind: 'http'` 是请求）。 */
function linesOf(log: string): readonly Record<string, unknown>[] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** 服务器自己数到的调用流水。 */
function callsOf(log: string, tool?: string): readonly Record<string, unknown>[] {
  return linesOf(log).filter(
    (one) => one['kind'] === 'call' && (tool === undefined || one['tool'] === tool),
  )
}

/** 服务器自己数到的 HTTP 请求（按方法）。 */
function requestsOf(log: string, method: string): readonly Record<string, unknown>[] {
  return linesOf(log).filter((one) => one['kind'] === 'http' && one['method'] === method)
}

describe('发现与调用', () => {
  test('连上之后给出服务器的工具表；两种接入同一个端口形态', async () => {
    const { url } = await serve()
    const connection = await connect({ url })

    expect(connection.transport).toBe('http')
    expect(connection.state.status).toBe('available')

    const tools = connection.tools()
    expect(tools.map((tool) => tool.name)).toContain('echo')
    expect(tools.find((tool) => tool.name === 'echo')?.parameters).toMatchObject({ type: 'object' })

    await connection.close()
  })

  test('文本 · 结构化 · 非文本 · 服务器报错——四种结果的形态与 stdio 同一份', async () => {
    const { url, log } = await serve()
    const connection = await connect({ url })

    expect(await connection.call('echo', { text: '外部你好' })).toEqual({
      kind: 'result',
      ok: true,
      parts: [{ kind: 'text', text: '外部你好' }],
    })

    const snapshot = await connection.call('snapshot', {})
    expect(snapshot.kind === 'result' ? snapshot.parts.at(-1) : undefined).toEqual({
      kind: 'structured',
      text: '{"count":2,"items":["a","b"]}',
    })

    expect(await connection.call('shot', {})).toEqual({
      kind: 'result',
      ok: true,
      parts: [
        { kind: 'text', text: '这是截图' },
        { kind: 'other', type: 'image', mimeType: 'image/png', bytes: 5 },
      ],
    })

    // 服务器说这次错了——**调用是成了的**（结果如此）
    expect(await connection.call('fail', {})).toMatchObject({ kind: 'result', ok: false })

    // 服务器自己数的数：四件各来过一次
    expect(callsOf(log).map((one) => one['tool'])).toEqual(['echo', 'snapshot', 'shot', 'fail'])

    await connection.close()
  })

  test('JSON 响应那一支也走得通（服务端不回流，直接给 JSON）', async () => {
    const { url } = await serve('json')
    const connection = await connect({ url })

    expect(connection.state.status).toBe('available')
    expect(await connection.call('echo', { text: '不走流的' })).toMatchObject({ kind: 'result', ok: true })

    await connection.close()
  })
})

describe('失败的三例（各有确定结果）', () => {
  test('超时——到点即落定，连接**仍报可用**（服务器活着，是这一笔没答）', async () => {
    const { url } = await serve()
    const connection = await connect({ url }, { callTimeoutMs: 400 })
    const outcome = await connection.call('slow', {})

    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('timeout')
    expect(connection.state.status).toBe('available')

    await connection.close()
  })

  test('取消——已发出取消请求，落定；连接不受影响', async () => {
    const { url } = await serve()
    const connection = await connect({ url }, { callTimeoutMs: 20_000 })
    const controller = new AbortController()
    const pending = connection.call('slow', {}, { signal: controller.signal })
    setTimeout(() => controller.abort(), 50)

    const outcome = await pending
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('canceled')
    expect(connection.state.status).toBe('available')

    await connection.close()
  })

  test('远端收了调用之后断流——效果未知、读数当场作废、**一次都没有重放**', async () => {
    const { url, log } = await serve()
    const connection = await connect({ url }, { callTimeoutMs: 5_000 })

    const outcome = await connection.call('boom', {})

    // 调用**发出去了**（服务器数得到），效果未知——不是「没发出去」
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('unreachable')
    expect(callsOf(log, 'boom')).toHaveLength(1)

    // 读数跟着连接走：这条路断了
    await waitState(connection, 'unavailable')
    expect(connection.state.status).toBe('unavailable')
    // **断了**（不是我们放的）：工具表留着——模型下一轮照旧调得到，拿到的是一句说得清的话
    expect(connection.tools().map((tool) => tool.name)).toContain('echo')

    // 之后的调用是**没发出去**；且服务器那边一次都没有多出来（不自动重试 / 重放）
    const after = await connection.call('echo', { text: 'x' })
    expect(after.kind === 'failed' ? after.failure : undefined).toBe('not-sent')
    expect(callsOf(log)).toHaveLength(1)

    await connection.close()
  })

  test('对端整个没了：调用报「效果未知」，读数落成不可用（不外泄 SDK 的通用话）', async () => {
    const { url } = await serve()
    const connection = await connect({ url }, { callTimeoutMs: 5_000 })
    running.at(-1)?.kill() // 服务器没了——不是它自己崩，是整台端掉
    await Bun.sleep(200)

    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('unreachable')

    await waitState(connection, 'unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toBe('连不上了') // 不是 `MCP error -32000: Connection closed` 那一串

    await connection.close()
  })
})

describe('起手失败（四种缘由各说各的话）', () => {
  test('对端不在——报「连不上谁」，不是 fetch 那一串英文', async () => {
    const connection = await connect({ url: 'http://127.0.0.1:9/mcp' }, { connectTimeoutMs: 3_000 })

    expect(connection.state.status).toBe('unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toContain('连不上 127.0.0.1:9')
    expect(connection.tools()).toEqual([])

    const outcome = await connection.call('echo', { text: 'x' })
    expect(outcome.kind === 'failed' ? outcome.failure : undefined).toBe('not-sent')

    await connection.close()
  })

  test('要认证的服务——**明确报本版不支持登录**（不是含糊的「连不上」）', async () => {
    const { url } = await serve('auth')
    const connection = await connect({ url })

    expect(connection.state.status).toBe('unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toContain('服务器要认证（HTTP 401）')
    expect(reason).toContain('本版不支持登录授权')

    await connection.close()
  })

  test('地址上没有端点——404 说「地址写错了，还是路径不对」', async () => {
    const { url } = await serve('notfound')
    const connection = await connect({ url })

    expect(connection.state.status).toBe('unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toContain('HTTP 404')

    await connection.close()
  })

  test('协议版本对不上——译一句人话，且不当成可用', async () => {
    const { url } = await serve('badversion')
    const connection = await connect({ url })

    expect(connection.state.status).toBe('unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).toContain('协议版本「1999-01-01」')
    expect(reason).toContain('本版不支持')

    await connection.close()
  })
})

describe('协议与重试的核对（两处都要与 SDK 对过）', () => {
  test('握手按 SDK 支持的那一版协商：对端报回来的版本落在支持范围里', async () => {
    const { url } = await serve()
    const transport = new StreamableHTTPClientTransport(new URL(url))
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })

    await client.connect(transport)
    // SDK 报回来的版本它自己认过（不支持会当场抛）——这一条钉的是「真握了手」
    expect(transport.protocolVersion).toBe('2025-11-25')

    await client.close()
  })

  test('**SDK 的隐含重连**：默认会自己去补那条断掉的 GET 流（对照），我们这条不补', async () => {
    // ① 对照：官方传输的默认姿势——GET 流开了就断，它会按退避补一次
    const raw = await serve('flakyget')
    const transport = new StreamableHTTPClientTransport(new URL(raw.url))
    const client = new Client({ name: 'probe', version: '0' }, { capabilities: {} })
    await client.connect(transport)
    await Bun.sleep(1_600) // 默认的首次退避是 1000ms
    const rawGets = requestsOf(raw.log, 'GET').length
    await client.close()

    expect(rawGets).toBeGreaterThan(1) // 补了（这就是那条隐含重试）

    // ② 本单这条：一样的一幕，只发一次 GET（续流也是「没人按过又去问了一趟」）
    const ours = await serve('flakyget')
    const connection = await connect({ url: ours.url })
    await Bun.sleep(1_600)

    expect(requestsOf(ours.log, 'GET')).toHaveLength(1)
    expect(connection.state.status).toBe('available') // 调用那条路照旧

    await connection.close()
  })
})

describe('收尾', () => {
  test('关闭终止会话（DELETE 到达服务器）、本端不再发请求、可再关一次', async () => {
    const { url, log } = await serve()
    const connection = await connect({ url })
    await connection.call('echo', { text: 'x' })

    const before = linesOf(log).length
    await connection.close()

    expect(requestsOf(log, 'DELETE')).toHaveLength(1)
    expect(connection.state).toEqual({ status: 'unavailable', reason: '连接已释放' })
    expect(connection.tools()).toEqual([])

    await Bun.sleep(120)
    const quiet = linesOf(log).length
    await connection.close() // 幂等
    await Bun.sleep(120)

    // 收尾之后本端安安静静（没有遗留的流在发请求）
    expect(linesOf(log).length).toBe(quiet)
    expect(quiet).toBeGreaterThanOrEqual(before) // 收尾本身只多了一趟 DELETE
  })

  test('对端不支持终止会话（405）——不算没收干净', async () => {
    const { url } = await serve('nodelete')
    const connection = await connect({ url })
    await connection.close()

    expect(connection.state).toEqual({ status: 'unavailable', reason: '连接已释放' })
  })

  test('收尾之后**外部服务器照旧服务**（不关用户的服务）', async () => {
    const { url } = await serve('ok')
    const first = await connect({ url })
    await first.close()

    // 同一台服务器，另起一条连接照样连得上
    const second = await connect({ url })
    expect(second.state.status).toBe('available')
    expect(await second.call('echo', { text: '还在' })).toMatchObject({ kind: 'result', ok: true })
    await second.close()
  })
})

describe('密钥不外泄 · **失败路径也守**（U39 补验）', () => {
  test('对端把哨兵回显在 500 的正文里——**不许跟着失败缘由出去**', async () => {
    const sentinel = 'U39_DIAGNOSTIC_FAKE_SECRET'
    // 合成值：对端在**失败响应体**里回显它（真事故里这就是上游把凭据抄回正文的样子）
    const { url } = await serve('call500', `diagnostic upstream: ${sentinel}`)
    const connection = await connect({ url })
    expect(connection.state.status).toBe('available') // 握手与发现照常

    const outcome = await connection.call('echo', { text: 'x' })

    expect(outcome.kind).toBe('failed')
    const reason = outcome.kind === 'failed' ? outcome.reason : ''
    expect(reason).not.toContain(sentinel)
    expect(reason).not.toContain('diagnostic upstream')
    // 说人话：这一趟是「对端回了 500」，不是把对端的正文抄一遍
    expect(reason).toContain('HTTP 500')

    // 读数那一侧同样一个字符都不许带
    expect(JSON.stringify(connection.state)).not.toContain(sentinel)

    await connection.close()
  })

  test('**起手**那一趟失败也收敛（500 正文里有哨兵）', async () => {
    const sentinel = 'U39_DIAGNOSTIC_FAKE_SECRET'
    const { url } = await serve('upstream500', `diagnostic upstream: ${sentinel}`)
    const connection = await connect({ url })

    expect(connection.state.status).toBe('unavailable')
    const reason = connection.state.status === 'unavailable' ? connection.state.reason : ''
    expect(reason).not.toContain(sentinel)
    expect(reason).toContain('HTTP 500')

    await connection.close()
  })

  test('**带凭据的地址**不进缘由（地址里塞了 token 那一幕）', async () => {
    const sentinel = 'U39_DIAGNOSTIC_FAKE_SECRET'
    const connection = await connect(
      // 地址里带 userinfo（凭据的一种写法）——缘由只许报主机
      { url: `http://u:${sentinel}@127.0.0.1:9/mcp` },
      { connectTimeoutMs: 3_000 },
    )

    const said = JSON.stringify(connection.state)
    expect(said).not.toContain(sentinel)
    expect(said).toContain('127.0.0.1:9')

    await connection.close()
  })
})

describe('密钥不外泄', () => {
  test('配置里的请求头值进不了读数（`/mcp` 那一屏报的是名字）', async () => {
    const sentinel = 'Bearer sk-mcp-http-sentinel-DO-NOT-LEAK'
    const { url } = await serve()
    const connection = await connect({ url, headers: { Authorization: sentinel } })

    expect(connection.state.status).toBe('available')
    expect(JSON.stringify(connection.state)).not.toContain(sentinel)
    expect(JSON.stringify(connection.tools())).not.toContain(sentinel)
    expect(JSON.stringify(connection.rejected)).not.toContain(sentinel)

    await connection.close()
  })
})

/** 等状态落定（有界——探针别无限等）。 */
async function waitState(connection: McpConnection, status: 'available' | 'unavailable'): Promise<void> {
  for (let i = 0; i < 100 && connection.state.status !== status; i += 1) await Bun.sleep(20)
}
