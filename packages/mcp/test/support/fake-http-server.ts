/**
 * 假 MCP 服务器（Streamable HTTP 夹具）—— **一个真进程**，走官方 SDK 的服务器面。
 *
 * 与 stdio 那个夹具（`fake-server.ts`）同一条纪律：对端也走官方实现——两侧都手搓的话
 * 可以一起错到一处去；它当夹具，客户端那一半的绿才作数。
 *
 * **它是被启动的进程，不是被 import 的模块**：用例按 `url` 连它——那条路与真服务器一字不差。
 * 起手后往 stdout 打一行 `{"port":N}`（端口 `FAKE_MCP_HTTP_PORT` 给 0 时由系统分一个）。
 *
 * 留痕两本：
 * - **调用流水**（`FAKE_MCP_HTTP_LOG`）——每次 `tools/call` 一行 JSON（`{tool, args, at, pid}`）；
 *   「拒绝时零调用」「断流没有被重试」这类判据要的是**服务器自己数的数**。
 * - **请求流水**（同一个文件里 `kind: 'http'`）——每一趟 HTTP 的方法与路径。判 GET 那几条
 *   有没有被自动重连（SDK 的隐含重试）、DELETE 有没有来过，靠的是这一本。
 *
 * 行为由环境变量给（夹具可配、不写死）：
 * - `FAKE_MCP_HTTP_MODE` —— 这几幕：
 *   - `ok`（默认）——规规矩矩的 MCP 服务器（SSE 响应）
 *   - `json` —— 同 `ok`，但响应走 JSON（不走 SSE 流）
 *   - `auth` —— 一律 401（「需要登录的服务」那一幕）
 *   - `notfound` —— 一律 404（地址写错那一幕）
 *   - `badversion` —— 认一个**本版不支持的协议版本**（`1999-01-01`）
 *   - `nodelete` —— DELETE 回 405（对端不支持显式终止会话，规范允许）
 *   - `flakyget` —— 那条 GET 流开了就断（验 SDK 会不会自己去续）
 *   - `upstream500` —— 一律 HTTP 500，正文是 `FAKE_MCP_HTTP_BODY`（缺省一句诊断话）
 *   - `call500` —— 只有 `tools/call` 那一趟 500（握手与发现照常），正文同上。
 *     两幕都用来验**失败路径的哨兵**：对端把凭据回显在正文里时，客户端那一路不许带出去
 * - `FAKE_MCP_HTTP_JSON=1` 与 `mode=json` 同义（两处写法都认，便于探针直用）
 */

import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const NAME = process.env['FAKE_MCP_HTTP_NAME'] ?? 'fake-http'
const LOG = process.env['FAKE_MCP_HTTP_LOG']
const MODE = process.env['FAKE_MCP_HTTP_MODE'] ?? 'ok'
const PORT = Number(process.env['FAKE_MCP_HTTP_PORT'] ?? '0')
const JSON_RESPONSE = MODE === 'json' || process.env['FAKE_MCP_HTTP_JSON'] === '1'
/**
 * 每一趟请求之前先拖这么久（毫秒）——**给竞态用例一个可控的窗口**
 * （握手/发现慢下来，才有「重连在途时再点一次」「重连在途时退出」这些场面可摆）。
 * 不给＝不拖（既有用例一字不受影响）。
 */
const DELAY_MS = Number(process.env['FAKE_MCP_HTTP_DELAY_MS'] ?? '0')

/** 工具表——与 stdio 那个夹具同形（文本 · 结构化 · 非文本 · 自报只读 · 报错 · 拖住 · 自尽）。 */
const TOOLS = [
  {
    name: 'echo',
    description: '把 text 原样回给你',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要回显的文本' } },
      required: ['text'],
    },
  },
  {
    name: 'snapshot',
    description: '回一份结构化结果',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'shot',
    description: '回一张图（非文本部件）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'annotated',
    description: '自报只读且幂等（审批仍要问）',
    inputSchema: { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false },
  },
  {
    name: 'fail',
    description: '服务器说这次错了（isError）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'slow',
    description: '拖住不回（超时 / 取消的靶子）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'boom',
    description: '调用中途让服务器自己死掉（断流的靶子）',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
]

/** 一次留痕——服务器自己数自己（判据由此而来）。 */
function record(entry: Record<string, unknown>): void {
  if (LOG === undefined) return
  appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`)
}

/** 一件工具的结果——四种形态各一条（与 stdio 夹具同一份）。 */
function content(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
    case 'snapshot':
      return {
        content: [{ type: 'text', text: '{"count":2,"items":["a","b"]}' }],
        structuredContent: { count: 2, items: ['a', 'b'] },
      }
    case 'shot':
      return {
        content: [
          { type: 'text', text: '这是截图' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      }
    case 'annotated':
      return { content: [{ type: 'text', text: '只读动作做完了' }] }
    case 'fail':
      return { content: [{ type: 'text', text: '这件事做不成' }], isError: true }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${tool}` }], isError: true }
  }
}

/** 一个永不落定的 promise——`slow` 的靶子。 */
function forever(): Promise<never> {
  return new Promise<never>(() => {})
}

/**
 * 一幕幕的响应。
 *
 * `auth` / `badversion` 两幕**不装 MCP 服务器**：它们要的就是「进不去」那一下——
 * 装一台真的再把它挡住，测的就不是客户端那一侧了。
 */
async function handRolled(request: Request): Promise<Response | undefined> {
  if (MODE === 'auth') return new Response('unauthorized', { status: 401 })

  // 地址写错那一幕：这个路径上没有端点
  if (MODE === 'notfound') return new Response('not found', { status: 404 })

  // 上游 500 —— **正文可注入**（探的是「失败路径会不会把对端正文原样带出去」）
  if (MODE === 'upstream500') return upstream500()

  // 只有 `tools/call` 那一趟 500：**握手与发现照常**，故能走到「调用失败」那一步
  if (MODE === 'call500' && request.method === 'POST') {
    const body = await request.clone().text()
    if (body.includes('"method":"tools/call"')) return upstream500()
  }

  // 对端不支持显式终止会话（规范允许回 405）——收尾那一趟不该因此报「没收干净」
  if (MODE === 'nodelete' && request.method === 'DELETE') {
    return new Response('no delete here', { status: 405 })
  }

  // 服务端推消息的那条 GET 流**开了就断**——用来验「SDK 会不会自动补一次」
  if (MODE === 'flakyget' && request.method === 'GET') {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          // 一个带 id 的 priming 事件 ＋ 当场收摊（规范里 GET 流可续，故 SDK 默认会来补）
          controller.enqueue(new TextEncoder().encode('id: 1\nevent: message\ndata: \n\n'))
          controller.close()
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }

  if (MODE === 'badversion') {
    // 认一个**本版不支持的协议版本**——客户端要的是「明确结果」，不是硬连下去。
    // id 照抄回来的（协议按 id 配对；对不上就不是「答了」而是「没答」）
    const asked = (await request.json().catch(() => ({}))) as { readonly id?: unknown }

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: asked.id ?? 0,
        result: {
          protocolVersion: '1999-01-01',
          capabilities: { tools: {} },
          serverInfo: { name: NAME, version: '0.0.1' },
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }

  return undefined
}

/** 一句可注入的 500 正文（缺省就是一句诊断话）。 */
function upstream500(): Response {
  return new Response(process.env['FAKE_MCP_HTTP_BODY'] ?? 'diagnostic upstream: 500', {
    status: 500,
    headers: { 'content-type': 'text/plain' },
  })
}

/** **有状态**：一台会话一套传输（规范里的 `Mcp-Session-Id` 就是干这个的）。 */
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>()

async function mcpFetch(request: Request): Promise<Response> {
  if (DELAY_MS > 0) await Bun.sleep(DELAY_MS)

  const hand = await handRolled(request)
  if (hand !== undefined) return hand

  // ⚠️ `Headers.get` 在 Bun 这儿**缺席回 `null`**（不是 `undefined`）——照标准那句话写会
  // 把「没有这个头」当成「有这个头」，每一趟都落进下面那一支去（实测踩过）
  const session = request.headers.get('mcp-session-id') ?? undefined

  if (session !== undefined) {
    const found = sessions.get(session)
    if (found === undefined) return new Response('no such session', { status: 404 })
    return found.handleRequest(request)
  }

  return startSession()

  async function startSession(): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: JSON_RESPONSE,
      onsessioninitialized: (id) => {
        sessions.set(id, transport)
        record({ kind: 'session', op: 'open', id })
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
        record({ kind: 'session', op: 'close', id })
      },
    })

    const server = new Server({ name: NAME, version: '0.0.1' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name
      const args = (request.params.arguments ?? {}) as Record<string, unknown>
      record({ kind: 'call', tool, args })

      if (tool === 'slow') return forever()
      // 断流的靶子：调用进来了、活还没干完，**进程自己没了**——POST 的响应流当场断掉
      if (tool === 'boom') process.exit(9)

      return content(tool, args) as never
    })

    await server.connect(transport)
    return transport.handleRequest(request)
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(request) {
    record({
      kind: 'http',
      method: request.method,
      path: new URL(request.url).pathname,
      // 会话号: `null` ＝ 这一趟没带（新建会话那一趟就是它）——数「建几条 / 删几条」靠这一格
      session: request.headers.get('mcp-session-id') ?? null,
    })
    return mcpFetch(request)
  },
})

// 起了就打一行（用例/探针据此拿端口）——`FAKE_MCP_HTTP_PORT` 给 0 时端口由系统分
console.log(JSON.stringify({ port: server.port }))
