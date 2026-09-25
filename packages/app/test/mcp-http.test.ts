/**
 * U39 · MCP Streamable HTTP 与连接查询 —— **全链判据**（装配 × 工具域 × 权限域 × 控制面）。
 *
 * 一句话：**真应用装配 ＋ 本地假 HTTP 服务器**跑完发现 → 审批 → 调用 → 回填，
 * 再验两种接入并存、单连接失败不串台、`/mcp` 的读数与重连、密钥不外泄、关闭释放。
 *
 * 三条纪律落在这一份里：
 * - **模型是替身（Faux）、服务器是真进程 ＋ 真 HTTP**（起手有界、断流、释放这三条假实现里
 *   不存在）；
 * - **判据取服务器自己数的数**（假服务器的留痕文件），不取客户端说了什么；
 * - **沙地全在临时目录**（`makeStage` 的规矩：数据 / 配置 / 授权 / 子进程都不碰真的）。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent } from '@magic/contracts'
import type { Assembly } from '../src/index.ts'
import { eventsOfKind, lastModel, makeStage } from './support.ts'

/** 假服务器（都用真进程）：stdio 那一台与 U39 的 HTTP 那一台。 */
const STDIO_SERVER = join(import.meta.dir, '..', '..', 'mcp', 'test', 'support', 'fake-server.ts')
const HTTP_SERVER = join(import.meta.dir, '..', '..', 'mcp', 'test', 'support', 'fake-http-server.ts')

const scraps: string[] = []
const running: Bun.Subprocess[] = []

function scrapDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'magic-mcp-http-app-'))
  scraps.push(dir)
  return dir
}

afterEach(() => {
  for (const child of running.splice(0)) child.kill()
  for (const dir of scraps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 起一台假 HTTP 服务器（真进程）——端口由系统分，从它那一行自报里读。 */
async function serveHttp(mode = 'ok'): Promise<{ url: string; log: string; child: Bun.Subprocess }> {
  const dir = scrapDir()
  const log = join(dir, 'http.jsonl')
  const child = Bun.spawn([process.execPath, HTTP_SERVER], {
    env: { ...process.env, FAKE_MCP_HTTP_PORT: '0', FAKE_MCP_HTTP_LOG: log, FAKE_MCP_HTTP_MODE: mode },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  running.push(child)

  const first = await child.stdout.getReader().read()
  const port = JSON.parse(new TextDecoder().decode(first.value)).port as number

  return { url: `http://127.0.0.1:${port}/mcp`, log, child }
}

/** 一个 stdio 条目（命令用**当前这个运行时**——夹具不依赖 PATH 上有什么）。 */
function stdioEntry(dir: string, name: string, extra: Record<string, string> = {}): unknown {
  return {
    command: process.execPath,
    args: [STDIO_SERVER],
    env: { FAKE_MCP_LOG: join(dir, `${name}.jsonl`), FAKE_MCP_NAME: name, ...extra },
  }
}

/** 服务器那边的调用流水——**判据取它**（服务器自己数的数）。 */
function callsOf(path: string, tool?: string): readonly Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((one) => one['kind'] === undefined || one['kind'] === 'call')
    .filter((one) => tool === undefined || one['tool'] === tool)
}

/** 等条件成立（轮询——这一条链是异步的，测试别假设时序）。 */
async function until(test: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await Bun.sleep(10)
  }
}

/** 裸接控制面：留事件轨迹，**按需答复**。 */
function bareShell(assembly: Assembly) {
  const events: KernelEvent[] = []
  const off = assembly.shell.subscribe((event) => events.push(event))

  return {
    events,
    requests: () => eventsOfKind(events, 'tool.decision.request'),
    result: () => eventsOfKind(events, 'tool.result').at(-1),
    answer(id: number, decision: 'approve' | 'reject'): void {
      assembly.shell.send({ type: 'decision.answer', id, decision })
    },
    dispose: off,
  }
}

/** 问一次「配了哪些、各是什么状态」，拿答复。**先架等、后发命令**（控制面是同步的）。 */
async function askMcp(assembly: Assembly): Promise<Extract<KernelEvent, { kind: 'mcp.catalog' }>> {
  const events: KernelEvent[] = []
  const off = assembly.shell.subscribe((event) => events.push(event))
  assembly.shell.send({ type: 'mcp.list' })

  await until(() => eventsOfKind(events, 'mcp.catalog').length >= 1, '那一屏回来了')
  off()

  const found = eventsOfKind(events, 'mcp.catalog')[0]
  if (found === undefined) throw new Error('等来的不是外部服务器一屏')
  return found
}

describe('HTTP 全链（发现 → 审批 → 调用 → 回填）', () => {
  test('真装配下走完同一条链；工具身份 · 审批卡 · 回填与 stdio 一字不差', async () => {
    const http = await serveHttp()
    const stage = makeStage({
      config: { mcp: { servers: { remote: { url: http.url } } } },
    })

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__remote__echo', args: { text: '外部你好' } }] },
          { text: '收到了' },
        ],
      })
      await assembly.ready()

      // ① 读数：这一台连上了、工具表是服务器报的那几件、接入方式是 http
      expect(assembly.mcpServers()).toEqual([
        {
          server: 'remote',
          transport: 'http',
          state: { status: 'available' },
          tools: ['echo', 'snapshot', 'shot', 'annotated', 'fail', 'slow', 'boom'],
          rejected: [],
        },
      ])

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '用外部工具回显一句' })
      await until(() => shell.requests().length >= 1, '审批询问')

      // ② 首轮模型请求里就有它（唯一名带服务器身份）
      expect(lastModel(stage).requests[0]?.tools?.map((tool) => tool.name)).toContain(
        'mcp__remote__echo',
      )

      // ③ 审批卡：`服务器 / 工具` ＋ 「外部操作」＋ 实际业务参数
      const request = shell.requests()[0]
      expect(request?.data.name).toBe('remote / echo')
      expect(request?.data.external).toBe(true)
      expect(request?.data.material).toContain('外部你好')

      // ④ 批准 → **服务器真收到了一次**（服务器自己数的）
      shell.answer(request?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 1, '工具跑完')

      expect(callsOf(http.log).map((one) => one['tool'])).toEqual(['echo'])
      expect(shell.result()?.data.ok).toBe(true)

      // ⑤ 回填：模型第二次请求里带着这次结果
      await until(() => lastModel(stage).requests.length >= 2, '第二次模型请求')
      const back = lastModel(stage).requests[1]
      const toolMessage = back?.messages.find((message) => message.role === 'tool')
      expect(toolMessage?.output).toContain('外部你好')

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('两种接入并存', () => {
  test('stdio 与 HTTP 各走各的；跨服务器同名工具按来源正确路由', async () => {
    const dir = scrapDir()
    const http = await serveHttp()
    const stage = makeStage({
      config: {
        mcp: {
          servers: {
            local: stdioEntry(dir, 'local'),
            remote: { url: http.url },
          },
        },
      },
    })

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__remote__echo', args: { text: '走 http' } }] },
          { toolCalls: [{ name: 'mcp__local__echo', args: { text: '走 stdio' } }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      const views = assembly.mcpServers()
      expect(views.map((view) => [view.server, view.transport])).toEqual([
        ['local', 'stdio'],
        ['remote', 'http'],
      ])
      expect(views.every((view) => view.state.status === 'available')).toBe(true)

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '两台各调一次' })

      await until(() => shell.requests().length >= 1, '第一次询问')
      expect(shell.requests()[0]?.data.name).toBe('remote / echo')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.requests().length >= 2, '第二次询问')

      expect(shell.requests()[1]?.data.name).toBe('local / echo')
      shell.answer(shell.requests()[1]?.id as number, 'approve')
      await until(() => eventsOfKind(shell.events, 'tool.result').length >= 2, '两笔都跑完')

      // **各数各的**：HTTP 那台只数到它那一次，stdio 那台同理
      expect(callsOf(http.log).map((one) => one['tool'])).toEqual(['echo'])
      expect(callsOf(join(dir, 'local.jsonl')).map((one) => one['tool'])).toEqual(['echo'])

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('查询（`/mcp` 那一屏 · `mcp.list` → `mcp.catalog`）', () => {
  test('一台都没配：空表 ＋ 一句「去哪儿配」；记录区之外不落任何东西', async () => {
    const stage = makeStage()

    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      await assembly.ready()

      const catalog = await askMcp(assembly)
      expect(catalog.data.servers).toEqual([])
      expect(catalog.data.note).toBeUndefined()

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('两台并存：身份 · 接入方式 · 状态 · 工具数；**地址与请求头一个字都不带**', async () => {
    const dir = scrapDir()
    const http = await serveHttp()
    const sentinel = 'Bearer sk-mcp-http-app-sentinel'
    const stage = makeStage({
      config: {
        mcp: {
          servers: {
            local: stdioEntry(dir, 'local'),
            remote: { url: http.url, headers: { Authorization: sentinel } },
            // 拉不起来的那一台（可执行文件不存在）——**它不该拖垮别的**
            broken: { command: join(dir, '没有这个可执行文件') },
          },
        },
      },
    })

    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      await assembly.ready()

      const catalog = await askMcp(assembly)
      const byName = new Map(catalog.data.servers.map((one) => [one.server, one]))

      expect(byName.get('local')?.transport).toBe('stdio')
      expect(byName.get('remote')?.transport).toBe('http')
      expect(byName.get('remote')?.state).toEqual({ status: 'available' })
      expect(byName.get('remote')?.tools).toHaveLength(7)
      expect(byName.get('local')?.tools).toHaveLength(8) // stdio 那台多一件 `spawnboom`

      // 坏的那一台：不可用 ＋ 缘由（其余两台照常）
      expect(byName.get('broken')?.state.status).toBe('unavailable')
      const state = byName.get('broken')?.state
      expect(state?.status === 'unavailable' ? state.reason : '').toContain('找不到可执行文件')

      // **地址与请求头不上这一屏**（名字就是身份；凭据一个字符都不许进来）
      const said = JSON.stringify(catalog.data)
      expect(said).not.toContain(http.url)
      expect(said).not.toContain(sentinel)

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('对端没了：那一台落成不可用并说缘由，其他连接与内置工具照常', async () => {
    const dir = scrapDir()
    const http = await serveHttp()
    const stage = makeStage({
      config: {
        mcp: {
          servers: { local: stdioEntry(dir, 'local'), remote: { url: http.url } },
        },
      },
    })

    try {
      const assembly = stage.assemble({
        turns: [
          { toolCalls: [{ name: 'mcp__remote__echo', args: { text: '先把对端弄没' } }] },
          // ⚠️ **原锚**：`exec echo 内置照常`（判轻）；**为何变**（U76）：判轻的默认通、
          // **不弹卡**——下面「第二次询问 → 批准 → 内置照常跑」那三步就没有对象；
          // **新锚**：名单里的删除打头（必问），`内置照常` 那串输出原样留着。
          { toolCalls: [{ name: 'exec', args: { cmd: 'chmod 755 . && echo 内置照常' } }] },
          { text: '好' },
        ],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      // 对端整个没了（不是它自己崩，是端掉）——那一次调用随后生效
      http.child.kill()
      await Bun.sleep(200)

      assembly.shell.send({ type: 'input.submit', text: '调那台没了的' })
      await until(() => shell.requests().length >= 1, '第一次询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '第一笔落定')

      // 记录：效果未知（发出去过）
      const text = outputTextOf(shell.result())
      expect(text).toContain('未收到结果，远端可能已执行')

      // 查询：那一台不可用 ＋ 缘由；另一台照旧可用（**不串台**）
      const catalog = await askMcp(assembly)
      const byName = new Map(catalog.data.servers.map((one) => [one.server, one]))
      expect(byName.get('remote')?.state.status).toBe('unavailable')
      expect(byName.get('local')?.state.status).toBe('available')

      // 内置工具照常跑（第二条交代）
      await until(() => shell.requests().length >= 2, '第二次询问')
      shell.answer(shell.requests()[1]?.id as number, 'approve')
      await until(() => shell.result()?.data.ok === true, '内置跑完')
      expect(shell.result()?.data.ok).toBe(true)

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('显式重连（`/mcp reconnect <服务器>`）', () => {
  test('重连重走一趟起手与发现；**不重放任何一次业务调用**', async () => {
    const http = await serveHttp()
    const stage = makeStage({ config: { mcp: { servers: { remote: { url: http.url } } } } })

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__remote__echo', args: { text: '先调一次' } }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调一次' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '跑完')
      expect(callsOf(http.log)).toHaveLength(1)

      // 重连：命令面发一条，答复仍是那一屏（`mcp.catalog`）
      const events: KernelEvent[] = []
      const off = assembly.shell.subscribe((event) => events.push(event))
      assembly.shell.send({ type: 'mcp.reconnect', server: 'remote' })
      await until(() => eventsOfKind(events, 'mcp.catalog').length >= 1, '重连的答复')
      off()

      const catalog = eventsOfKind(events, 'mcp.catalog')[0]
      expect(catalog?.data.note).toContain('已重连')
      expect(catalog?.data.servers[0]?.state).toEqual({ status: 'available' })
      expect(catalog?.data.servers[0]?.tools).toHaveLength(7)

      // **业务调用一次都没被重放**（服务器数的还是那一次）
      expect(callsOf(http.log)).toHaveLength(1)

      shell.dispose()
      await assembly.shutdown()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('重连到一台**仍不可用**的：回执说「没成」，不说「已重连」（U39 补验）', async () => {
    const http = await serveHttp('auth') // 要认证的对端：怎么重连都连不上
    const stage = makeStage({ config: { mcp: { servers: { locked: { url: http.url } } } } })

    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      await assembly.ready()

      const events: KernelEvent[] = []
      const off = assembly.shell.subscribe((event) => events.push(event))
      assembly.shell.send({ type: 'mcp.reconnect', server: 'locked' })
      await until(() => eventsOfKind(events, 'mcp.catalog').length >= 1, '重连的答复')
      off()

      const catalog = eventsOfKind(events, 'mcp.catalog')[0]
      // **原锚**：`note` 说的是「找到了这一台」（`已重连「locked」`）——那与同一屏上的
      // `不可用` 自相矛盾（回报帧 03 就是这么露的）；**为何变**：回执要按**最终状态**给；
      // **新锚**：连不上就说「没成」，且那一句缘由仍在读数里。
      expect(catalog?.data.note).toContain('重连没成')
      expect(catalog?.data.note).not.toContain('已重连')
      // 也不复述状态：那一台可不可用在同一屏的读数里（窄窗下省两行）
      expect(catalog?.data.note).not.toContain('不可用')
      expect(catalog?.data.servers[0]?.state.status).toBe('unavailable')

      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('认不出的服务器名：名录照给，缘由写在那一句上（不是错误）', async () => {
    const http = await serveHttp()
    const stage = makeStage({ config: { mcp: { servers: { remote: { url: http.url } } } } })

    try {
      const assembly = stage.assemble({ turns: [{ text: '好' }] })
      await assembly.ready()

      const events: KernelEvent[] = []
      const off = assembly.shell.subscribe((event) => events.push(event))
      assembly.shell.send({ type: 'mcp.reconnect', server: '没这一台' })
      await until(() => eventsOfKind(events, 'mcp.catalog').length >= 1, '答复')
      off()

      const catalog = eventsOfKind(events, 'mcp.catalog')[0]
      expect(catalog?.data.note).toContain('没有配这一台')
      expect(catalog?.data.servers.map((one) => one.server)).toEqual(['remote'])

      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('关闭与隔离', () => {
  test('关闭释放本端：终止会话、外部服务器照旧服务；密钥不进事件与模型请求', async () => {
    const sentinel = 'Bearer sk-mcp-http-app-close-sentinel'
    const http = await serveHttp()
    const stage = makeStage({
      config: { mcp: { servers: { remote: { url: http.url, headers: { Authorization: sentinel } } } } },
    })

    try {
      const assembly = stage.assemble({
        turns: [{ toolCalls: [{ name: 'mcp__remote__echo', args: { text: '跟着凭据跑一趟' } }] }, { text: '好' }],
      })
      await assembly.ready()

      const shell = bareShell(assembly)
      assembly.shell.send({ type: 'input.submit', text: '调一下' })
      await until(() => shell.requests().length >= 1, '审批询问')
      shell.answer(shell.requests()[0]?.id as number, 'approve')
      await until(() => shell.result() !== undefined, '跑完')

      // 密钥不进模型请求 / 事件 / 开屏那几句 / 查询读数（**一处都不许漏**）
      expect(JSON.stringify(lastModel(stage).requests)).not.toContain(sentinel)
      expect(JSON.stringify(shell.events)).not.toContain(sentinel)
      expect(JSON.stringify(assembly.notices)).not.toContain(sentinel)
      expect(JSON.stringify(assembly.mcpServers())).not.toContain(sentinel)

      await assembly.shutdown()

      // 本端收尾那一趟终止了会话（DELETE 到达）；**外部服务器照旧服务**
      const requests = readFileSync(http.log, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((one) => one['kind'] === 'http')
      expect(requests.some((one) => one['method'] === 'DELETE')).toBe(true)

      const again = await fetch(`${http.url}`, { method: 'POST', body: '{}' })
      expect(again.status).toBeGreaterThan(0) // 服务器还在（不是我们杀掉的）

      shell.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

/** 结果的文本（`tool.result` 的 `output` 是记录侧形态——内联才拿得到文本）。 */
function outputTextOf(event: { readonly data: { readonly output: unknown } } | undefined): string {
  const output = event?.data.output as { readonly text?: string } | undefined
  return output?.text ?? ''
}
