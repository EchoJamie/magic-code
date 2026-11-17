import { createShell } from '@magic/shell'
import { createWorkspaceService } from '@magic/resources'
import type { Command, KernelEvent } from '@magic/contracts'
import { terminalSettings } from '@magic/host'
import { waitFor } from './resident-cli-fixture.ts'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function ground() {
  const home = mkdtempSync(join(tmpdir(), 'magic-settings-offline-')), base = join(home, '.magic'), configPath = join(base, 'config.json')
  mkdirSync(base)
  return { home, base, configPath, request: crypto.randomUUID(), close: () => rmSync(home, { recursive: true, force: true }) }
}

test('断连 TUI 可读、选、清除网页服务引用；删除被引用的连接不静默级联', async () => {
  const g = ground(), workspace = createWorkspaceService({ roots: [g.home] })
  writeFileSync(g.configPath, JSON.stringify({
    providers: {
      // `region` 是既有官方区域字段——它不该成为网页服务的额外门槛。
      web: { vendor: 'deepseek', region: 'official', apiKey: 'offline-test-only' },
      badRegion: { vendor: 'deepseek', region: 'moon', apiKey: 'offline-test-only' },
      local: { vendor: 'deepseek', protocol: 'chat-completions', baseURL: 'https://example.invalid/v1', apiKey: 'offline-test-only' },
    },
    models: { cantrip: { provider: 'local', model: 'distill-model' } },
  }))
  const events: KernelEvent[] = []
  const transport = terminalSettings({ send() {}, subscribe() { return () => {} } }, { home: g.home, base: g.base }, workspace)
  transport.subscribe(event => events.push(event))
  const shell = createShell(transport, { magicBase: g.base })
  try {
    shell.releaseInput(); shell.hostGone()
    transport.send({ type: 'web.list' })
    await waitFor(() => events.some(event => event.kind === 'web.state'))
    const first = events.find(event => event.kind === 'web.state')!
    expect(first.kind === 'web.state' && first.data.provider).toBeUndefined()
    expect(first.kind === 'web.state' && first.data.cantrip?.model).toBe('distill-model')

    transport.send({ type: 'web.configure', provider: 'web' })
    await waitFor(() => events.filter(event => event.kind === 'web.state').length === 2)
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).web).toEqual({ provider: 'web' })

    // 被网页服务引用的连接不能直接删（与模型引用同一把尺子）
    transport.send({ type: 'provider.remove', provider: 'web' })
    await waitFor(() => events.some(event => event.kind === 'provider.catalog'))
    const refused = events.find(event => event.kind === 'provider.catalog')!
    expect(refused.kind === 'provider.catalog' && refused.data.saved).toBe(false)
    expect(refused.kind === 'provider.catalog' && refused.data.note).toContain('网页查询与搜索')
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).providers.web).toBeDefined()

    transport.send({ type: 'web.configure', provider: null })
    await waitFor(() => events.filter(event => event.kind === 'web.state').length === 3)
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).web).toBeUndefined()

    // 自定义地址的连接不能拿密钥自动转投官方；未知连接也如实拒。
    transport.send({ type: 'web.configure', provider: 'local' })
    await waitFor(() => events.filter(event => event.kind === 'web.state').length === 4)
    let last = events.filter(event => event.kind === 'web.state').at(-1)!
    expect(last.kind === 'web.state' && last.data.saved).toBe(false)
    expect(last.kind === 'web.state' && last.data.note).toContain('固定官方地址')

    transport.send({ type: 'web.configure', provider: 'ghost' })
    await waitFor(() => events.filter(event => event.kind === 'web.state').length === 5)
    last = events.filter(event => event.kind === 'web.state').at(-1)!
    expect(last.kind === 'web.state' && last.data.saved).toBe(false)
    expect(last.kind === 'web.state' && last.data.note).toContain('ghost')

    // 认不出的官方区域：解析不出固定地址 ⇒ 拒绝（但 region 这个字段本身不是门槛）。
    transport.send({ type: 'web.configure', provider: 'badRegion' })
    await waitFor(() => events.filter(event => event.kind === 'web.state').length === 6)
    last = events.filter(event => event.kind === 'web.state').at(-1)!
    expect(last.kind === 'web.state' && last.data.saved).toBe(false)
    expect(last.kind === 'web.state' && last.data.note).toContain('固定')
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).web).toBeUndefined()
  } finally { shell.dispose(); g.close() }
})

test('断连 TUI 按名字检索 Models.dev 候选；检索不联网，挑中的资料写进用户覆盖', async () => {
  const g = ground(), workspace = createWorkspaceService({ roots: [g.home] })
  mkdirSync(join(g.base, 'cache'), { recursive: true })
  writeFileSync(join(g.base, 'cache', 'models.dev.json'), JSON.stringify({ fetchedAt: 1_700_000_000_000, data: {
    alibaba: { api: 'https://dashscope.example/v1', models: {
      'qwen-flash': { id: 'qwen-flash', name: 'Qwen Flash', limit: { context: 128_000, output: 8_192 }, modalities: { input: ['text'], output: ['text'] }, tool_call: true, last_updated: '2026-09-01' },
      'qwen-max': { id: 'qwen-max' },
    } },
    zhipu: { models: { 'glm-4': { id: 'glm-4', name: '智谱四' } } },
  } }))
  writeFileSync(g.configPath, JSON.stringify({ providers: { relay: { baseURL: 'https://relay.test/api', protocol: 'responses', auth: 'bearer', apiKey: 'offline-test-only' } } }))
  const events: KernelEvent[] = []
  const transport = terminalSettings({ send() {}, subscribe() { return () => {} } }, { home: g.home, base: g.base }, workspace)
  transport.subscribe(event => events.push(event))
  const before = readFileSync(g.configPath, 'utf8')
  try {
    transport.send({ type: 'models.search', query: 'flash' })
    await waitFor(() => events.some(event => event.kind === 'models.search'))
    const found = events.find(event => event.kind === 'models.search')!
    expect(found.kind === 'models.search' && found.data.matches).toEqual([{
      provider: 'alibaba', model: 'qwen-flash', name: 'Qwen Flash',
      limits: { maxContextTokens: 128_000, maxOutputTokens: 8_192 },
      capabilities: { chat: true, image: false, tools: true },
      updatedAt: '2026-09-01',
    }])

    transport.send({ type: 'models.search', query: '智谱' })
    await waitFor(() => events.filter(event => event.kind === 'models.search').length === 2)
    const named = events.filter(event => event.kind === 'models.search').at(-1)!
    expect(named.kind === 'models.search' && named.data.matches.map(one => one.model)).toEqual(['glm-4'])

    transport.send({ type: 'models.search', query: 'nothing-here' })
    await waitFor(() => events.filter(event => event.kind === 'models.search').length === 3)
    const none = events.filter(event => event.kind === 'models.search').at(-1)!
    expect(none.kind === 'models.search' && none.data.matches).toEqual([])
    expect(none.kind === 'models.search' && none.data.note).toContain('没有匹配')
    expect(readFileSync(g.configPath, 'utf8')).toBe(before)

    // 挑中的那条抄进**用户覆盖**：调用时仍发我们这条连接上的原始型号（Qwen-Flash），
    // 规格/能力/思考按 Models.dev 那条走；供应商缓存一个字没动。
    transport.send({ type: 'model.override', provider: 'relay', model: 'Qwen-Flash', override: {
      limits: { maxContextTokens: 128_000, maxOutputTokens: 8_192 },
      capabilities: { chat: true, image: false, tools: true },
      reasoningSupport: { disable: true, levels: ['low', 'high'] },
    } })
    await waitFor(() => events.some(event => event.kind === 'model.catalog'))
    const saved = events.filter(event => event.kind === 'model.catalog').at(-1)!
    const row = (saved.kind === 'model.catalog' ? saved.data.entries[0] : undefined) as { modelOverrides?: Record<string, unknown>, modelInfo?: Record<string, { limits?: unknown, capabilities?: unknown, reasoning?: unknown }> } | undefined
    expect(row?.modelOverrides?.['Qwen-Flash']).toEqual({
      limits: { maxContextTokens: 128_000, maxOutputTokens: 8_192 },
      capabilities: { chat: true, image: false, tools: true },
      reasoningSupport: { disable: true, levels: ['low', 'high'] },
    })
    expect(row?.modelInfo?.['Qwen-Flash']?.limits).toBeUndefined()
    // 用户覆盖走**有效规格**那一层（不混进供应商/目录资料）：能力与思考按覆盖生效
    expect((row as { effectiveReasoning?: Record<string, { disable?: boolean, levels?: readonly string[] }> } | undefined)?.effectiveReasoning?.['Qwen-Flash'])
      .toEqual({ disable: true, levels: ['low', 'high'] })
    expect(JSON.parse(readFileSync(join(g.base, 'cache', 'models.dev.json'), 'utf8')).data.alibaba.models['qwen-flash'].id).toBe('qwen-flash')
  } finally { g.close() }
})

test('断连 TUI 可保存偏好，普通草稿保留且不创建业务库', async () => {  const g = ground(), workspace = createWorkspaceService({ roots: [g.home] })
  const forwarded: Command[] = [], events: KernelEvent[] = []
  const transport = terminalSettings({ send(command) { forwarded.push(command) }, subscribe() { return () => {} } }, { home: g.home, base: g.base }, workspace)
  transport.subscribe(event => events.push(event))
  const shell = createShell(transport, { magicBase: g.base })
  try {
    shell.releaseInput(); shell.hostGone()
    transport.send({ type: 'prefs.set', reducedMotion: true })
    await waitFor(() => events.some(event => event.kind === 'prefs.state'))
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).motion.reduced).toBe(true)
    shell.key({ kind: 'paste', text: '重连之前不发送' }); shell.key({ kind: 'enter' })
    expect(shell.getView().draft).toBe('重连之前不发送')
    expect(forwarded.filter(command => command.type === 'input.submit')).toEqual([])
    expect(existsSync(join(g.base, 'records.db'))).toBe(false)
  } finally { shell.dispose(); g.close() }
})
