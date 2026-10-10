import { expect, test } from 'bun:test'
import { createWorkspaceService } from '@magic/execution'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelEvent, SettingsAction } from '@magic/contracts'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { connectManager } from '../src/run/client.ts'
import { clientTransport } from '../src/run/terminal.ts'
import { terminalSettings } from '../src/run/terminal-settings.ts'
import { runSettingsCall } from '../src/settings-call.ts'
import { cliGround, waitFor } from './resident-cli-fixture.ts'

test('独立配置保存与真实 Engine 动态采用、TUI 本地保存、双入口冲突；不装配 Agent', async () => {
  const g = cliGround(), magic = { base: g.base, home: g.home }, path = join(g.base, 'config.json')
  const started = await startManager({ paths: runPathsOf(magic, g.root), magic, launch: { spawn() { throw new Error('设置不应创建 Agent') } } })
  if (started.role !== 'manager') throw new Error('管理者未启动')
  const manager = started.manager
  const client = await connectManager(manager.socketPath, { cwd: g.root })
  if (!client) throw new Error('TUI 连接失败')
  const events: KernelEvent[] = [], terminal = terminalSettings(clientTransport(client), magic, createWorkspaceService({ roots: [g.root] }))
  terminal.subscribe(e => events.push(e))
  const request = (action?: SettingsAction, stamp?: string | null) => runSettingsCall({ request: crypto.randomUUID(), home: g.home, base: g.base, configPath: path, ...(action ? { action, stamp } : {}) }, {})
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
})
