import { createShell } from '@magic/tui'
import { createWorkspaceService } from '@magic/execution'
import type { Command, KernelEvent } from '@magic/contracts'
import { terminalSettings } from '../src/run/terminal-settings.ts'
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

test('断连 TUI 可查询并撤销授权、保存偏好，普通草稿保留且不创建业务库', async () => {
  const g = ground(), workspace = createWorkspaceService({ roots: [g.home] })
  const forwarded: Command[] = [], events: KernelEvent[] = []
  const transport = terminalSettings({ send(command) { forwarded.push(command) }, subscribe() { return () => {} } }, { home: g.home, base: g.base }, workspace)
  transport.subscribe(event => events.push(event))
  const shell = createShell(transport, { magicBase: g.base })
  const grantsPath = join(g.base, 'grants.json')
  writeFileSync(grantsPath, JSON.stringify({ version: 1, workspaces: { [workspace.defaultRoot()]: [{ tool: 'web_fetch', host: 'example.com', grantedAt: 1 }] } }))
  try {
    shell.releaseInput(); shell.hostGone()
    shell.key({ kind: 'paste', text: '/grants ' }); shell.key({ kind: 'enter' })
    await waitFor(() => shell.getView().dock.kind === 'picker')
    const catalog = events.find(event => event.kind === 'grants.catalog')!
    expect(catalog.kind === 'grants.catalog' && catalog.data.grants).toHaveLength(1)
    expect(catalog.data).not.toHaveProperty('decisions'); expect(catalog.data).not.toHaveProperty('history')
    transport.send({ type: 'grants.revoke', index: 0 })
    await waitFor(() => events.filter(event => event.kind === 'grants.catalog').length === 2)
    expect(JSON.parse(readFileSync(grantsPath, 'utf8')).workspaces[workspace.defaultRoot()]).toBeUndefined()
    transport.send({ type: 'prefs.set', reducedMotion: true })
    await waitFor(() => events.some(event => event.kind === 'prefs.state'))
    expect(JSON.parse(readFileSync(g.configPath, 'utf8')).motion.reduced).toBe(true)
    shell.key({ kind: 'escape' }); shell.key({ kind: 'paste', text: '重连之前不发送' }); shell.key({ kind: 'enter' })
    expect(shell.getView().draft).toBe('重连之前不发送')
    expect(forwarded.filter(command => command.type === 'input.submit')).toEqual([])
    expect(existsSync(join(g.base, 'records.db'))).toBe(false)
  } finally { shell.dispose(); g.close() }
})
