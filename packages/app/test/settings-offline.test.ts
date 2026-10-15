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
