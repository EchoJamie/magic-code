/**
 * 假 MCP 服务器（夹具）—— **一个真进程**，走官方 SDK 的服务器面 ＋ stdio 传输。
 *
 * 为什么用官方 SDK 写假服务器（而不是手搓 JSON-RPC）：验收要证的是「客户端这一侧
 * 真的在讲这门协议」——对端若也是手搓的，两侧可以一起错到一处去。用它当夹具，
 * 客户端那一半的绿才作数。
 *
 * **它是被启动的进程，不是被 import 的模块**：用例把它的路径写进配置（`command` / `args`），
 * 由客户端按 MCP 规矩拉起来——那条路与真服务器一字不差。
 *
 * 调用留痕：每收到一次 `tools/call` 就往 `FAKE_MCP_LOG` 那个文件追加一行 JSON
 * （`{tool, args, at}`）——「拒绝时零调用」这类判据要的是**服务器自己数的数**，
 * 不是客户端说了什么。
 *
 * 行为通过环境变量给（夹具可配、不写死）：
 * - `FAKE_MCP_NAME` —— serverInfo 的名字（默认 `fake-mcp`）
 * - `FAKE_MCP_LOG` —— 调用流水文件（不给＝不留痕）
 * - `FAKE_MCP_MODE` —— `ok`（默认）｜`slow`（`slow` 工具干脆不回）｜`die`（起手即退）
 */

import { appendFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const NAME = process.env['FAKE_MCP_NAME'] ?? 'fake-mcp'
const LOG = process.env['FAKE_MCP_LOG']
const MODE = process.env['FAKE_MCP_MODE'] ?? 'ok'

/** 工具表——**两件同名工具分属两个服务器**（跨服务器同名不碰撞）是验收要的形态之一。 */
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
    name: 'slow',
    description: '拖住不回（超时 / 取消的靶子）',
    inputSchema: { type: 'object', properties: {}, required: [] },
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
]

/** 一次调用留痕——服务器自己数自己（判据由此而来）。 */
function record(tool: string, args: unknown): void {
  if (LOG === undefined) return
  appendFileSync(LOG, `${JSON.stringify({ tool, args, at: Date.now() })}\n`)
}

/** 一个永不落定的 promise——`slow` 的靶子（客户端超时 / 取消打在这上面）。 */
function forever(): Promise<never> {
  return new Promise<never>(() => {})
}

function content(tool: string, args: Record<string, unknown>): unknown {
  switch (tool) {
    case 'echo':
      return { content: [{ type: 'text', text: String(args['text'] ?? '') }] }
    case 'snapshot':
      // 结构化结果 ＋ 一份文本：客户端两侧都要交得回去
      return {
        content: [{ type: 'text', text: '{"count":2,"items":["a","b"]}' }],
        structuredContent: { count: 2, items: ['a', 'b'] },
      }
    case 'shot':
      // 非文本部件：客户端必须**保留或明确标示**，不能静默丢
      return {
        content: [
          { type: 'text', text: '这是截图' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
      }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${tool}` }], isError: true }
  }
}

const server = new Server(
  { name: NAME, version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = request.params.name
  const args = (request.params.arguments ?? {}) as Record<string, unknown>
  record(tool, args)

  if (tool === 'slow' && MODE !== 'fast') return forever()
  return content(tool, args) as never
})

if (MODE === 'die') {
  process.exit(3)
}

await server.connect(new StdioServerTransport())
