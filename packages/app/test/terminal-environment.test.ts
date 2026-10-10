import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { TLSSocket, createSecureContext } from 'node:tls'
import type { Duplex } from 'node:stream'
import { createSandbox, createUiSession, startFixture, type UiSession } from './ui/index.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { readDatabase } from './support.ts'

async function until(check: () => boolean) {
  const end = Date.now() + 15000
  while (!check()) { if (Date.now() > end) throw new Error('环境回执未到'); await Bun.sleep(20) }
}

test('两个真实终端共享 Engine；网络、工具与 MCP 环境隔离，接回保留旧环境，继续采用新环境', async () => {
  const sandbox = createSandbox()
  const cert = join(sandbox.root, 'cert.pem'), key = join(sandbox.root, 'key.pem')
  const made = Bun.spawnSync(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=work.test', '-addext', 'subjectAltName=DNS:work.test'], { stdout: 'ignore', stderr: 'pipe' })
  if (made.exitCode !== 0) throw new Error(made.stderr.toString())
  const tls = createSecureContext({ cert: readFileSync(cert), key: readFileSync(key) })
  const windows: UiSession[] = []
  const sockets = new Set<Duplex>()
  const traffic: Record<string, string> = { A: '', B: '', C: '' }
  const fixtures = new Map<string, ReturnType<typeof startFixture>>()
  const httpMcp = Bun.spawn([process.execPath, join(import.meta.dir, '../../mcp/test/support/fake-http-server.ts')], {
    env: { HOME: sandbox.home, PATH: '/usr/bin:/bin', FAKE_MCP_HTTP_MODE: 'json' }, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore',
  })
  const ready = httpMcp.stdout.getReader(); const port = JSON.parse(new TextDecoder().decode((await ready.read()).value)).port; ready.releaseLock()
  const received: { path: string; key: string; auxiliary: boolean }[] = []
  const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const key = (request.headers.get('authorization') ?? '').replace('Bearer ', '')
    const body = request.method === 'POST' ? await request.text() : ''
    const json = body ? JSON.parse(body) : {}
    const auxiliary = Array.isArray(json.messages) && !json.tools
    received.push({ path, key, auxiliary })
    if (path === '/mcp') return fetch(`http://127.0.0.1:${port}/mcp`, { method: request.method, headers: request.headers, body: body || undefined })
    if (path.startsWith('/web/')) return new Response('<html><body>终端环境验证页面。</body></html>', { headers: { 'content-type': 'text/html' } })
    const fixture = fixtures.get(key)
    if (!fixture) return new Response('unexpected environment', { status: 401 })
    if (auxiliary) return new Response('data: ' + JSON.stringify({ id: 'aux', choices: [{ index: 0, delta: { content: '页面摘要' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    return fetch(fixture.baseURL + path.slice(3), { method: request.method, body: body || undefined, headers: { 'content-type': 'application/json' } })
  } })
  const proxies: ReturnType<typeof createServer>[] = []
  const envs: Record<string, Record<string, string>> = {}
  for (const label of ['A', 'B', 'C']) {
    const proxy = createServer()
    proxy.on('connect', (request, downstream, head) => {
      const upstream = connect(endpoint.port!, '127.0.0.1')
      sockets.add(upstream); sockets.add(downstream)
      upstream.on('error', () => downstream.destroy()); downstream.on('error', () => upstream.destroy())
      upstream.on('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const channel = request.url?.endsWith(':443') ? new TLSSocket(downstream, { isServer: true, secureContext: tls }) : downstream
        channel.on('error', () => upstream.destroy())
        channel.on('data', chunk => { traffic[label] += chunk.toString() })
        if (head.length) upstream.write(head)
        upstream.pipe(channel); channel.pipe(upstream)
      })
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve)); proxies.push(proxy)
    const bin = join(sandbox.root, `bin-${label}`); mkdirSync(bin)
    const probe = (kind: string) => `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(sandbox.root, `${kind}-${label}.json`))}, JSON.stringify({cwd:process.cwd(),env:process.env}));\n`
    writeFileSync(join(bin, 'env-probe'), probe('tool'), { mode: 0o755 })
    writeFileSync(join(bin, 'mcp-probe'), probe('mcp') + `await import(${JSON.stringify(join(import.meta.dir, '../../mcp/test/support/fake-server.ts'))});\n`, { mode: 0o755 })
    const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
    envs[label] = { PATH: bin + ':/usr/bin:/bin', MAGIC_LOCAL_API_KEY: label, WORK_MARK: label,
      http_proxy: url, https_proxy: url, all_proxy: '', no_proxy: '', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '' }
    fixtures.set(label, startFixture({ turns: [
      { kind: 'tool', name: 'exec', args: { cmd: `env-probe; while [ ! -f '${join(sandbox.root, `release-${label}`)}' ]; do /bin/sleep 0.05; done` } },
      { kind: 'tool', name: 'web_fetch', args: { url: `http://work.test/web/${label}`, prompt: '总结' } },
      { kind: 'text', text: `环境${label}完成` },
    ] }))
  }
  const config = JSON.parse(readFileSync(sandbox.configPath, 'utf8'))
  config.providers.local = { vendor: 'minimax', baseURL: 'http://work.test/v1' }
  config.mcp = { servers: { local: { command: 'mcp-probe' }, remote: { url: 'http://work.test/mcp' } } }
  writeFileSync(sandbox.configPath, JSON.stringify(config))
  const host = await startResidentHost({ ...sandbox, env: { ...sandbox.env, MAGIC_LOCAL_API_KEY: 'engine', WORK_MARK: 'engine', NODE_EXTRA_CA_CERTS: cert, http_proxy: 'http://127.0.0.1:1', no_proxy: '' } })
  const workspaceB = join(sandbox.root, 'ws-B'); mkdirSync(workspaceB)
  try {
    const a = await createUiSession({ sandbox, artifacts: join(sandbox.root, 'frames'), env: envs.A, argv: ['--allow-all'] }); windows.push(a)
    const b = await createUiSession({ sandbox: { ...sandbox, workspace: workspaceB }, artifacts: join(sandbox.root, 'frames'), env: envs.B, argv: ['--allow-all'] }); windows.push(b)
    for (const [window, label] of [[a, 'A'], [b, 'B']] as const) {
      await window.send(`工作${label}`, { until: { text: `工作${label}` } }); await window.key('enter')
    }
    await until(() => ['A', 'B'].every(label => existsSync(join(sandbox.root, `tool-${label}.json`))))
    for (const [label, workspace] of [['A', sandbox.workspace], ['B', workspaceB]]) {
      const tool = JSON.parse(readFileSync(join(sandbox.root, `tool-${label}.json`), 'utf8'))
      const mcp = JSON.parse(readFileSync(join(sandbox.root, `mcp-${label}.json`), 'utf8'))
      expect(tool.cwd).toBe(realpathSync(workspace!)); expect(tool.env.WORK_MARK).toBe(label)
      expect(tool.env.MAGIC_LOCAL_API_KEY).toBe(label); expect(mcp.env.PATH).toBe(envs[label!]!.PATH)
      expect(mcp.env.WORK_MARK).toBeUndefined(); expect(mcp.env.MAGIC_LOCAL_API_KEY).toBeUndefined()
      expect(mcp.cwd).toBe(realpathSync(workspace!))
    }
    const db = readDatabase(join(sandbox.dataDir, 'records.db'))
    const session = db.sessions.find(row => JSON.parse(row.workspace!)[0] === realpathSync(sandbox.workspace))!.id; db.close()
    await a.close(); windows.splice(windows.indexOf(a), 1)
    const c = await createUiSession({ sandbox: { ...sandbox, workspace: workspaceB }, artifacts: join(sandbox.root, 'frames'), env: envs.C, anchors: { ...sandbox.anchors, ready: () => ({ text: '工作A' }) }, argv: ['resume', session, '--allow-all'] }); windows.push(c)
    expect(existsSync(join(sandbox.root, 'tool-C.json'))).toBe(false)
    for (const label of ['A', 'B']) writeFileSync(join(sandbox.root, `release-${label}`), '')
    await c.wait({ text: '环境A完成' }, { timeoutMs: 15000 }); await c.wait({ text: '○ 空闲' })
    await b.wait({ text: '环境B完成' }, { timeoutMs: 15000 }); await b.wait({ text: '○ 空闲' })
    expect(received.filter(row => row.key === 'C')).toHaveLength(0)
    writeFileSync(join(sandbox.root, 'release-C'), '')
    await c.send('继续C', { until: { text: '继续C' } }); await c.key('enter')
    await c.wait({ text: '环境C完成' }, { timeoutMs: 15000 }); await c.wait({ text: '○ 空闲' })
    const continued = JSON.parse(readFileSync(join(sandbox.root, 'tool-C.json'), 'utf8'))
    expect(continued.cwd).toBe(realpathSync(sandbox.workspace)); expect(continued.env.WORK_MARK).toBe('C')
    for (const label of ['A', 'B', 'C']) {
      expect(traffic[label]).toContain(`/web/${label}`)
      expect(traffic[label]).toContain('POST /mcp')
      expect(received.some(row => row.key === label && row.auxiliary)).toBe(true)
      expect(received.some(row => row.key === label && !row.auxiliary)).toBe(true)
      for (const other of ['A', 'B', 'C'].filter(other => other !== label)) expect(traffic[label]).not.toContain(`Bearer ${other}\r\n`)
    }
    expect(host.discovery.base).toBe(sandbox.dataDir)
  } finally {
    for (const window of windows) await window.close()
    try { await host.close() } finally {
      for (const socket of sockets) socket.destroy()
      for (const proxy of proxies) await new Promise<void>(resolve => proxy.close(() => resolve()))
      httpMcp.kill(); await httpMcp.exited
      endpoint.stop(true); for (const fixture of fixtures.values()) await fixture.stop()
      await sandbox.dispose()
    }
  }
}, 60000)
