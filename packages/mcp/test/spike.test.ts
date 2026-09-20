import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const SERVER = join(import.meta.dir, 'support', 'fake-server.ts')

test('spike：官方 SDK 的 stdio 客户端在 bun 下跑得通', async () => {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [SERVER],
    env: { FAKE_MCP_NAME: 'spike-mcp' } as Record<string, string>,
    stderr: 'ignore',
  })
  const client = new Client({ name: 'magic', version: '0.0.0' })

  await client.connect(transport)
  const tools = await client.listTools()
  console.log('serverVersion', client.getServerVersion())
  console.log('tools', tools.tools.map((t) => t.name))

  const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } })
  console.log('echo', JSON.stringify(result))

  const snap = await client.callTool({ name: 'snapshot', arguments: {} })
  console.log('snapshot', JSON.stringify(snap))

  await client.close()
  expect(tools.tools.length).toBe(4)
})
