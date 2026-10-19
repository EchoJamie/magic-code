import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { acquireFileLock, configStamp, editConfigFile } from '@magic/config'
import { expect, test } from 'bun:test'
import { createWorkspaceService } from '@magic/execution'
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, SettingsAction, SettingsSnapshot, ModelCatalogRow } from '@magic/contracts'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { connectManager } from '../src/run/client.ts'
import { clientTransport } from '../src/run/terminal.ts'
import { terminalSettings } from '../src/run/terminal-settings.ts'
import { nativeModelsDevCatalog, holdNativeSettingsLock, runNativeSettings } from './native-settings-fixture.ts'
import { createSettings } from '../src/settings.ts'
import { statusLinePreview } from '@magic/tui'
import { cliGround, waitFor } from './resident-cli-fixture.ts'
import { commitGrants, loadGrants } from '../src/grants-file.ts'

test('Swift 原生配置保存与真实 Engine 动态采用、TUI 本地保存、双入口冲突；不装配 Agent', async () => {
  const g = cliGround(), magic = { base: g.base, home: g.home }, path = join(g.base, 'config.json')
  const started = await startManager({ paths: runPathsOf(magic, g.root), magic, launch: { spawn() { throw new Error('设置不应创建 Agent') } } })
  if (started.role !== 'manager') throw new Error('管理者未启动')
  const manager = started.manager
  const client = await connectManager(manager.socketPath, { cwd: g.root })
  if (!client) throw new Error('TUI 连接失败')
  const events: KernelEvent[] = [], terminal = terminalSettings(clientTransport(client), magic, createWorkspaceService({ roots: [g.root] }))
  terminal.subscribe(e => events.push(e))
  const request = (action?: SettingsAction, stamp?: string | null) => runNativeSettings({ request: crypto.randomUUID(), home: g.home, base: g.base, configPath: path, ...(action ? { action, stamp } : {}) }, {})
  try {
    const before = (await request()).snapshot!
    const saved = await request({ type: 'prefs.set', statusLine: { cells: ['workspace', 'session'], color: false }, reducedMotion: true }, before.stamp)
    expect(saved.saved).toBe(true)
    await waitFor(() => events.some(e => e.kind === 'prefs.state' && e.data.reducedMotion))
    const content = readFileSync(path, 'utf8')
    const conflict = await request({ type: 'prefs.set', reducedMotion: false }, before.stamp)
    expect(conflict.saved).toBe(false); expect(conflict.error).toContain('修改'); expect(readFileSync(path, 'utf8')).toBe(content)
    events.length = 0
    terminal.send({ type: 'prefs.set', reducedMotion: false })
    await waitFor(() => events.some(e => e.kind === 'prefs.state' && !e.data.reducedMotion))
    expect((await request()).snapshot!.configuration.motion).toEqual({})
    events.length = 0
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), statusLine: { cells: ['model', 'context'] } }))
    await waitFor(() => events.some(e => e.kind === 'prefs.state' && e.data.statusLine?.cells[0] === 'model'))
    expect((await request()).snapshot!.configuration.statusLine).toEqual({ cells: ['model', 'context'] })
    expect(manager.executors()).toEqual([])
  } finally { client.close(); manager.stop('settings 测试收尾'); await manager.waitUntilExit(); g.close() }
}, 60000)

test('TS 与 Swift 按同一文件格式交叉编辑，字段校验、凭据隐藏及未知字段保留一致', async () => {
  const g = ground(), env = { MAGIC_LOCAL_API_KEY: 'ENV_SECRET_SENTINEL' }
  const settings = createSettings({ magic: g, environment: env, fetch: async () => { throw new Error('本地编辑不得联网') } })
  const actions: SettingsAction[] = [
    { type: 'provider.save', provider: 'local', baseURL: 'http://localhost:9010/custom/v1', auth: 'none', protocol: 'responses' },
    { type: 'model.override', provider: 'local', model: '原始型号/Case-Sensitive', override: { limits: { maxContextTokens: 40000, maxInputTokens: 32000, maxOutputTokens: 8000 }, reasoningSupport: { disable: true, default: 'on', levels: ['minimal', 'low', 'private'], budget: { minTokens: 1024 } } } },
    { type: 'model.configure', provider: 'local', model: '原始型号/Case-Sensitive', choice: 'default', initialize: true },
    { type: 'role.save', id: 'review', role: { name: '审查', instructions: '只检查指定内容', tools: [], model: { choice: 'spell', reasoning: { mode: 'off' } } } },
    { type: 'mcp.save', name: 'local', server: { command: 'echo', args: ['中文'] }, secrets: { PRIVATE_TOKEN: 'MCP_SECRET_SENTINEL' } },
    { type: 'sources.set', source: 'rules.sources', paths: ['~/规则', '/tmp/来源'] },
    { type: 'workspace.set', roots: [g.home] },
    { type: 'permissions.set', rules: [{ tool: 'exec', op: ['read', 'create'], path: '**', host: 'example.com' }] },
    { type: 'prefs.set', statusLine: { cells: ['workspace', 'model'], color: false }, reducedMotion: true },
    { type: 'diagnostics.set', debugMode: true, logLevel: 'trace' },
    { type: 'provider.save', provider: 'local', name: '重命名', apiKey: 'KEY_SECRET_SENTINEL' },
    { type: 'model.override', provider: 'local', model: '原始型号/Case-Sensitive', override: null },
    { type: 'role.remove', id: 'review' }, { type: 'mcp.remove', name: 'local' },
    { type: 'workspace.set', roots: null }, { type: 'prefs.set', reducedMotion: false },
  ]
  writeFileSync(g.configPath, JSON.stringify({ future: { nested: ['保留', { enabled: true }] } }), { mode: 0o600 })
  try {
    for (const action of actions) {
      const before = readFileSync(g.configPath, 'utf8')
      await settings.apply(action, configStamp(g.configPath))
      const expected = JSON.parse(readFileSync(g.configPath, 'utf8'))
      writeFileSync(g.configPath, before)
      const result = await runNativeSettings({ ...g, action, stamp: configStamp(g.configPath) }, env)
      expect(result.error).toBeUndefined(); expect(result.saved).toBe(true)
      expect(JSON.parse(readFileSync(g.configPath, 'utf8'))).toEqual(expected)
      expect(result.snapshot?.stamp).toBe(configStamp(g.configPath))
      expect(result.snapshot?.configuration).toEqual((await settings.read()).configuration)
      expect(result.snapshot?.catalog).toEqual((await settings.read()).catalog)
      expect(JSON.stringify(result)).not.toMatch(/(?:KEY|ENV|MCP)_SECRET_SENTINEL/)
      expect(statSync(g.configPath).mode & 0o777).toBe(0o600)
    }
    for (const action of [
      { type: 'provider.save', provider: 'local', baseURL: 'https://user:password@example.com', apiKey: 'KEY_SECRET_SENTINEL' },
      { type: 'model.override', provider: 'local', model: 'm', override: { limits: { maxInputTokens: 100, maxContextTokens: 50 } } },
      { type: 'permissions.set', rules: [{ tool: 'exec', op: [] }] },
      { type: 'role.save', id: 'bad', role: { name: '错误', instructions: '保留草稿', model: { reasoning: { mode: 'off' } } } },
    ] as SettingsAction[]) {
      const before = readFileSync(g.configPath, 'utf8'), stamp = configStamp(g.configPath)
      await expect(settings.apply(action, stamp)).rejects.toThrow()
      const result = await runNativeSettings({ ...g, action, stamp }, env)
      expect(result.saved).toBe(false); expect(result.error).toBeDefined(); expect(readFileSync(g.configPath, 'utf8')).toBe(before)
      expect(JSON.stringify(result)).not.toContain('KEY_SECRET_SENTINEL')
    }
  } finally { g.close() }
}, 60000)

test('两端对规范化目录别名使用同一把锁；任一端持锁时另一端不能覆盖', async () => {
  const g = ground(), alias = join(g.home, 'alias')
  writeFileSync(g.configPath, '{}'); symlinkSync(g.base, alias, 'dir')
  try {
    const request = { ...g, configPath: join(alias, 'config.json') }, stamp = configStamp(g.configPath)
    expect((await runNativeSettings(request)).snapshot?.stamp).toBe(stamp)
    const held = await acquireFileLock(g.configPath)
    try {
      const blocked = await runNativeSettings({ ...request, stamp, action: { type: 'prefs.set', reducedMotion: true } })
      expect(blocked.saved).toBe(false); expect(blocked.error).toContain('正在写入')
    } finally { held.release() }
    const release = await holdNativeSettingsLock(request)
    try {
      const blocked = await editConfigFile({ path: g.configPath, expectedStamp: stamp, update: raw => ({ ok: true, raw: { ...raw, debugMode: true } }) })
      expect(blocked.ok).toBe(false); expect(readFileSync(g.configPath, 'utf8')).toBe('{}')
    } finally { await release() }
    const saved = await runNativeSettings({ ...request, stamp, action: { type: 'prefs.set', reducedMotion: true } })
    expect(saved.saved).toBe(true)
    const stale = await editConfigFile({ path: g.configPath, expectedStamp: stamp, update: raw => ({ ok: true, raw: { ...raw, debugMode: true } }) })
    expect(stale.ok).toBe(false)
    expect(JSON.parse(readFileSync(g.configPath, 'utf8'))).toEqual({ motion: { reduced: true } })
  } finally { g.close() }
}, 60000)

test('原生状态行预览与 TUI 的列宽、排序、截断和颜色样本一致', async () => {
  const g = ground()
  try {
    for (const columns of [20, 34, 65, 90]) for (const cells of [[], ['session', 'context'], ['workspace', 'model', 'reasoning', 'context', 'session']] as const) {
      for (const color of [false, true]) {
        const preview = { columns, statusLine: { cells, color }, reducedMotion: columns % 2 === 0 }
        const result = await runNativeSettings({ ...g, preview })
        expect(result.error).toBeUndefined()
        expect(result.snapshot?.preview).toEqual(statusLinePreview(preview.statusLine, columns, preview.reducedMotion))
      }
    }
  } finally { g.close() }
}, 60000)
function ground() {
  const home = mkdtempSync(join(tmpdir(), 'magic-settings-offline-')), base = join(home, '.magic'), configPath = join(base, 'config.json')
  mkdirSync(base)
  return { home, base, configPath, request: crypto.randomUUID(), close: () => rmSync(home, { recursive: true, force: true }) }
}

test('配置目标与指纹分别核对，坏 JSON 不覆盖，Engine 状态不是保存前提', async () => {
  const g = ground()
  try {
    await expect(runNativeSettings({ ...g, configPath: join(g.home, 'other.json') }, {})).rejects.toThrow('配置路径')
    writeFileSync(g.configPath, '{ broken')
    const before = readFileSync(g.configPath, 'utf8')
    const bad = await runNativeSettings({ ...g, stamp: configStamp(g.configPath), action: { type: 'prefs.set', reducedMotion: true } }, {})
    expect(bad.saved).toBe(false); expect(bad.error).toBeDefined(); expect(readFileSync(g.configPath, 'utf8')).toBe(before)
    writeFileSync(g.configPath, '{}')
    const read = await runNativeSettings(g, {})
    writeFileSync(g.configPath, '{"motion":{"reduced":false}}')
    const conflict = await runNativeSettings({ ...g, stamp: read.snapshot!.stamp, action: { type: 'prefs.set', reducedMotion: true } }, {})
    expect(conflict.saved).toBe(false); expect(conflict.error).toContain('已被修改')
  } finally { g.close() }
}, 60000)


test('原生模型列表与 TS 缓存互通，非认证编辑沿用；换凭据和迟到刷新不能串用旧范围', async () => {
  const g = ground(), requests: string[] = []
  let hold: Promise<void> | undefined, release: (() => void) | undefined
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push(request.headers.get('authorization') ?? '')
    if (hold) await hold
    return Response.json({ data: [{ id: 'deepseek-chat', name: '受控列表', context_window: 64000, max_output_tokens: 4096, capabilities: { tools: true }, reasoning: { disable: true, default: 'off' } }] })
  } })
  const settings = createSettings({ magic: g, environment: {}, fetch })
  const row = (snapshot: Pick<SettingsSnapshot, 'catalog'>) => snapshot.catalog[0] as ModelCatalogRow
  const native = (action?: SettingsAction) => runNativeSettings({ ...g, ...(action ? { action, stamp: configStamp(g.configPath) } : {}) })
  try {
    writeFileSync(g.configPath, JSON.stringify({ providers: { official: { vendor: 'deepseek', baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'FIRST_SECRET' } } }))
    const refreshed = await native({ type: 'model.refresh', provider: 'official' })
    expect(refreshed.error).toBeUndefined()
    const nativeRow = row(refreshed.snapshot!)
    expect(nativeRow.cache?.snapshot?.models[0]?.limits?.maxContextTokens).toBe(64000)
    expect(row(await settings.read()).cache).toEqual(nativeRow.cache)
    await settings.apply({ type: 'provider.save', provider: 'official', name: '已重命名' }, configStamp(g.configPath))
    expect(row((await native()).snapshot!).cache?.snapshot?.models).toEqual(nativeRow.cache!.snapshot!.models)
    expect((await native({ type: 'prefs.set', reducedMotion: true })).saved).toBe(true)
    expect(row(await settings.read()).cache?.snapshot?.models).toEqual(nativeRow.cache!.snapshot!.models)
    hold = new Promise<void>(resolve => { release = resolve })
    const late = native({ type: 'model.refresh', provider: 'official' })
    await waitFor(() => requests.length === 2)
    expect((await native({ type: 'provider.save', provider: 'official', apiKey: 'SECOND_SECRET' })).saved).toBe(true)
    release!(); await late; hold = undefined
    expect(row((await native()).snapshot!).cache).toBeUndefined()
    expect(row(await settings.read()).cache).toBeUndefined()
    await settings.apply({ type: 'model.refresh', provider: 'official' }, configStamp(g.configPath))
    expect(row((await native()).snapshot!).cache?.snapshot?.models).toEqual(row(await settings.read()).cache?.snapshot?.models)
    expect(requests).toEqual(['Bearer FIRST_SECRET', 'Bearer FIRST_SECRET', 'Bearer SECOND_SECRET'])
    expect(JSON.stringify(await native())).not.toMatch(/FIRST_SECRET|SECOND_SECRET/)
  } finally { release?.(); await server.stop(true); g.close() }
}, 60000)

test('原生撤销与 TS 授权记账交叉写入，旧指纹拒绝覆盖，新授权和其他工作区保留', async () => {
  const g = ground(), path = join(g.base, 'grants.json'), other = join(g.home, 'other')
  const grant = { tool: 'exec', path: '**', op: 'read' as const, grantedAt: 1 }
  try {
    await commitGrants(path, [{ kind: 'grant', workspace: g.home, grant }, { kind: 'grant', workspace: other, grant }])
    const before = (await runNativeSettings(g)).snapshot!
    await commitGrants(path, [{ kind: 'grant', workspace: g.home, grant: { ...grant, path: '*.txt' } }])
    const conflict = await runNativeSettings({ ...g, stamp: before.stamp, action: { type: 'grants.revoke', workspace: g.home, index: 0, grantStamp: before.grantStamp } })
    expect(conflict.saved).toBe(false); expect(loadGrants(path).file.workspaces[g.home]).toHaveLength(2)
    const current = (await runNativeSettings(g)).snapshot!
    const revoked = await runNativeSettings({ ...g, stamp: current.stamp, action: { type: 'grants.revoke', workspace: g.home, index: 0, grantStamp: current.grantStamp } })
    expect(revoked.saved).toBe(true)
    expect(loadGrants(path).file.workspaces[g.home]).toEqual([{ ...grant, path: '*.txt' }])
    expect(loadGrants(path).file.workspaces[other]).toEqual([grant])
    expect(statSync(path).mode & 0o777).toBe(0o600)
    writeFileSync(path, '{ broken')
    const failed = await runNativeSettings({ ...g, stamp: configStamp(g.configPath), action: { type: 'grants.revoke', workspace: g.home, grantStamp: configStamp(path) } })
    expect(failed.saved).toBe(false); expect(readFileSync(path, 'utf8')).toBe('{ broken')
  } finally { g.close() }
}, 60000)

test('App 原生模型刷新保留显式代理与 NO_PROXY，不因客户端拆分改变出站路径', async () => {
  const g = ground(), tunnels: string[] = []
  const model = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ data: [{ id: 'deepseek-chat' }] }) })
  const proxy = createServer()
  proxy.on('connect', (request, client, head) => {
    tunnels.push(request.url!)
    const upstream = connect(model.port!, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client); client.pipe(upstream)
    })
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address() as { port: number }
  const refresh = (baseURL: string, environment: Record<string, string>) => {
    writeFileSync(g.configPath, JSON.stringify({ providers: { official: { vendor: 'deepseek', baseURL, apiKey: 'LOCAL_ONLY' } } }))
    return runNativeSettings({ ...g, stamp: configStamp(g.configPath), action: { type: 'model.refresh', provider: 'official' } }, environment)
  }
  try {
    const proxied = await refresh('http://native-models.invalid/v1', { http_proxy: `http://127.0.0.1:${address.port}`, NO_PROXY: '127.0.0.1' })
    expect(proxied.error, JSON.stringify(tunnels)).toBeUndefined(); expect(tunnels).toEqual(['native-models.invalid:80'])
    const direct = await refresh(`http://127.0.0.1:${model.port}/v1`, { HTTP_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1' })
    expect(direct.error).toBeUndefined(); expect(tunnels).toHaveLength(1)
    const blocked = await refresh('http://native-models.invalid/v1', { ALL_PROXY: 'http://127.0.0.1:1' })
    expect(blocked.error).toContain('模型列表刷新失败')
  } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await model.stop(true); g.close() }
}, 60000)

test('官方 messages 配置的列表仍用目录端点，原生缓存范围与 TS 一致', async () => {
  const g = ground(), urls: string[] = []
  const settings = createSettings({ magic: g, environment: {}, fetch: async input => {
    if (String(input) === 'https://models.dev/api.json') return Response.json(nativeModelsDevCatalog)
    urls.push(String(input)); return Response.json({ data: [{ id: 'MiniMax-M2.7' }] })
  } })
  try {
    writeFileSync(g.configPath, JSON.stringify({ providers: { official: { vendor: 'minimax', protocol: 'messages', apiKey: 'SYNTHETIC' } } }))
    await settings.apply({ type: 'model.refresh', provider: 'official' }, configStamp(g.configPath))
    expect(urls).toEqual(['https://api.minimax.cn/v1/models'])
    const native = (await runNativeSettings(g)).snapshot!
    expect((native.catalog[0] as ModelCatalogRow).cache).toEqual(((await settings.read()).catalog[0] as ModelCatalogRow).cache)
    expect((native.catalog[0] as ModelCatalogRow).cache?.snapshot).toBeDefined()
  } finally { g.close() }
}, 60000)

test('App 与 TS 动态解析同一 Models.dev 缓存；精确渠道与型号匹配，手动刷新绕过 TTL', async () => {
  const g = ground(), id = 'MiniMax-M3.1-Flash'
  const settings = createSettings({ magic: g, environment: {}, fetch: async () => { throw new Error('新鲜资料应直接读文件') } })
  try {
    writeFileSync(g.configPath, JSON.stringify({ providers: {
      official: { vendor: 'minimax', modelOverrides: { [`${id}-Preview`]: {} } },
      private: { baseURL: 'https://private.invalid/v1', modelOverrides: { [id]: {} } },
    }, models: { default: { provider: 'official', model: id } } }))
    const native = await runNativeSettings(g)
    expect(native.error).toBeUndefined()
    const row = native.snapshot!.catalog[0] as ModelCatalogRow
    expect(row.modelInfo?.[id]?.limits).toEqual({ maxContextTokens: 1_000_000, maxOutputTokens: 512_000 })
    expect(row.effectiveReasoning?.[id]).toEqual({ levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(row.modelInfo?.[`${id}-Preview`]).toBeUndefined()
    expect((native.snapshot!.catalog[1] as ModelCatalogRow).modelInfo?.[id]).toBeUndefined()
    const ts = (await settings.read()).catalog[0] as ModelCatalogRow
    expect(row.modelInfo).toEqual(ts.modelInfo)
    expect(row.effectiveReasoning).toEqual(ts.effectiveReasoning)
    const file = join(g.base, 'cache/models.dev.json'), cached = JSON.parse(readFileSync(file, 'utf8'))
    cached.data['minimax-cn'].models[id].limit.output = 500_000
    writeFileSync(file, JSON.stringify(cached))
    const reread = await runNativeSettings(g)
    expect((reread.snapshot!.catalog[0] as ModelCatalogRow).modelInfo?.[id]?.limits?.maxOutputTokens).toBe(500_000)
    expect(((await settings.read()).catalog[0] as ModelCatalogRow).modelInfo?.[id]?.limits?.maxOutputTokens).toBe(500_000)
    // 自定义连接不依赖模型列表接口，也可以手动刷新公共资料。
    const refreshed = await runNativeSettings({ ...g, stamp: reread.snapshot!.stamp, action: { type: 'model.refresh', provider: 'private' } })
    expect(refreshed.error).toBeUndefined()
    expect((refreshed.snapshot!.catalog[0] as ModelCatalogRow).modelInfo?.[id]?.limits?.maxOutputTokens).toBe(512_000)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  } finally { g.close() }
}, 60000)
