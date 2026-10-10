import { createShell } from '@magic/tui'
import { createWorkspaceService } from '@magic/execution'
import type { Command, KernelEvent } from '@magic/contracts'
import { terminalSettings } from '../src/run/terminal-settings.ts'
import { waitFor } from './resident-cli-fixture.ts'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configStamp } from '../src/cache-access.ts'
import { performSettingsRequest, runSettingsCall } from '../src/settings-call.ts'
import { runtimeLaunch } from '../src/run/runtime-launch.ts'

function ground() {
  const home = mkdtempSync(join(tmpdir(), 'magic-settings-offline-')), base = join(home, '.magic'), configPath = join(base, 'config.json')
  mkdirSync(base)
  return { home, base, configPath, request: crypto.randomUUID(), close: () => rmSync(home, { recursive: true, force: true }) }
}

test('单次配置进程离线保存，stdin 密钥不回显、不创建业务库或 Engine', async () => {
  const g = ground()
  try {
    const child = Bun.spawn([...runtimeLaunch(), '--internal-settings'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin', HOME: g.home } })
    child.stdin.write(JSON.stringify({ ...g, stamp: null, action: { type: 'provider.save', provider: 'deepseek', vendor: 'deepseek', apiKey: 'ONLY_STDIN_SECRET' } }))
    child.stdin.end()
    const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect({ code, errors, output: JSON.parse(output) }).toMatchObject({ code: 0, errors: '' }); expect(errors).toBe(''); expect(output).not.toContain('ONLY_STDIN_SECRET')
    const result = JSON.parse(output)
    expect(result.saved).toBe(true); expect(result.snapshot.configuration.providers.deepseek.keyConfigured).toBe(true)
    expect(readFileSync(g.configPath, 'utf8')).toContain('ONLY_STDIN_SECRET')
    expect(existsSync(join(g.base, 'records.db'))).toBe(false)
    expect(existsSync(join(g.base, 'run'))).toBe(false)
  } finally { g.close() }
})

test('配置目标与指纹分别核对，坏 JSON 不覆盖，Engine 状态不是保存前提', async () => {
  const g = ground()
  try {
    await expect(runSettingsCall({ ...g, configPath: join(g.home, 'other.json') }, {})).rejects.toThrow('配置路径')
    writeFileSync(g.configPath, '{ broken')
    const before = readFileSync(g.configPath, 'utf8')
    const bad = await runSettingsCall({ ...g, stamp: configStamp(g.configPath), action: { type: 'prefs.set', reducedMotion: true } }, {})
    expect(bad.saved).toBe(false); expect(bad.error).toBeDefined(); expect(readFileSync(g.configPath, 'utf8')).toBe(before)
    writeFileSync(g.configPath, '{}')
    const read = await runSettingsCall(g, {})
    writeFileSync(g.configPath, '{"motion":{"reduced":false}}')
    const conflict = await runSettingsCall({ ...g, stamp: read.snapshot!.stamp, action: { type: 'prefs.set', reducedMotion: true } }, {})
    expect(conflict.saved).toBe(false); expect(conflict.error).toContain('已被修改')
  } finally { g.close() }
})

test('保存后的首次读取失败自动重读，连续失败仍保留已保存，不重放写入', async () => {
  const g = ground()
  try {
    const snapshot = (await runSettingsCall(g, {})).snapshot!
    for (const failures of [1, 2]) {
      let writes = 0, reads = 0
      const result = await performSettingsRequest({ ...g, action: { type: 'prefs.set', reducedMotion: true }, stamp: null }, {
        async apply() { writes++; return '已保存' },
        async read() { if (++reads <= failures) throw new Error('本次快照不可读'); return snapshot },
      })
      expect(writes).toBe(1); expect(reads).toBe(2); expect(result.saved).toBe(true)
      expect(result.note).toBe('已保存'); expect(result.error !== undefined).toBe(failures === 2)
      expect(result.snapshot !== undefined).toBe(failures === 1)
    }
  } finally { g.close() }
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
