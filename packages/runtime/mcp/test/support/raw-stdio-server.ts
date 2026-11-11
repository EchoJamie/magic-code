/**
 * 手搓的 stdio 服务器（**只为一件事**）—— `tools/list` 回一份**不合规**的结果，
 * 且原文里塞着 `RAW_STDIO_SECRET`。
 *
 * 为什么不用官方 SDK 写这一台：这一台要的就是**客户端收到不合规内容**那一下，
 * 而 SDK 的服务器面不会替你造出不合规的应答。它不当协议对端（其余几件照规矩答），
 * 只当「对端答坏了」这个场面的夹具。
 */

const SECRET = process.env['RAW_STDIO_SECRET'] ?? 'RAW_SECRET'

function out(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

process.stdin.on('data', (chunk: Buffer) => {
  for (const line of chunk.toString().split('\n')) {
    if (line.trim() === '') continue
    const message = JSON.parse(line) as { readonly id?: number; readonly method?: string }

    if (message.method === 'initialize') {
      out({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'raw', version: '0.0.0' },
        },
      })
      continue
    }

    if (message.method === 'notifications/initialized') continue

    if (message.method === 'tools/list') {
      // **不合规**：`tools` 不是数组，且原文里带着哨兵（真事故里那一坨就是对端的响应）
      out({ jsonrpc: '2.0', id: message.id, result: { tools: `not-an-array ${SECRET}` } })
      continue
    }

    out({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: '不认识这个方法' } })
  }
})
