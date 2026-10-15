import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NATIVE_PROTOCOL, SOFTWARE_VERSION } from '@magic/contracts'
import { installComponents, uninstallComponent, type ComponentInspector } from '../src/component-install.ts'
import { componentDirectory, readComponents } from '../src/components.ts'

function ground() {
  const root = realpathSync(mkdtempSync('/tmp/magic-install-')), home = join(root, 'home'), payload = join(root, 'payload')
  mkdirSync(home); mkdirSync(payload)
  for (const kind of ['engine', 'cli']) writeFileSync(join(payload, `magic-${kind}`), kind === 'engine' ? '#!/bin/sh\nprintf \'{"state":"stopped"}\\n\'\n' : 'controlled-cli', { mode: 0o755 })
  const inspect: ComponentInspector = async (_path, component) => ({ component, version: SOFTWARE_VERSION, protocol: NATIVE_PROTOCOL, team: 'controlled-team' })
  return { root, home, payload, inspect, close: () => rmSync(root, { recursive: true, force: true }) }
}

test('三个组合按需补齐，复用已有 Engine 与目标，删除 App 载荷后终端仍有独立归属', async () => {
  const g = ground()
  try {
    const engineOnly = await installComponents({ ...g, profile: 'engine' }, g.inspect)
    expect(engineOnly.installed).toEqual(['engine']); expect(engineOnly.components.cli).toBeUndefined()
    expect(existsSync(join(g.home, '.local/bin/magic'))).toBe(false)
    const before = statSync(engineOnly.components.engine), selected = join(componentDirectory(g.home), 'engine.json')
    writeFileSync(selected, JSON.stringify({ parent: join(g.root, 'retained-target') }))
    const app = await installComponents({ ...g, profile: 'app' }, g.inspect)
    expect(app.reused).toEqual(['engine']); expect(app.installed).toEqual(['cli'])
    expect(statSync(app.components.engine).ino).toBe(before.ino)
    expect(JSON.parse(readFileSync(selected, 'utf8')).parent).toBe(join(g.root, 'retained-target'))
    const terminal = await installComponents({ ...g, profile: 'terminal' }, g.inspect)
    expect(terminal.reused).toEqual(['engine', 'cli']); expect(terminal.installed).toEqual([])
    expect(realpathSync(terminal.command!)).toBe(terminal.components.cli!)
    rmSync(g.payload, { recursive: true })
    expect(existsSync(app.components.engine)).toBe(true); expect(readFileSync(terminal.command!, 'utf8')).toBe('controlled-cli')
    expect(readComponents(g.home)).toEqual(terminal.components)
  } finally { g.close() }
})

test('未知文件与版本不符在变更前拒绝，客户端更新不替换 Engine', async () => {
  const g = ground()
  try {
    mkdirSync(join(g.home, '.local/bin'), { recursive: true })
    const command = join(g.home, '.local/bin/magic'); writeFileSync(command, 'foreign')
    await expect(installComponents({ ...g, profile: 'terminal' }, g.inspect)).rejects.toThrow('其他文件占用')
    expect(readFileSync(command, 'utf8')).toBe('foreign'); expect(readComponents(g.home)).toBeUndefined()
    rmSync(command)
    const installed = await installComponents({ ...g, profile: 'terminal' }, g.inspect), engineBefore = statSync(installed.components.engine)
    const older: ComponentInspector = async (path, kind) => ({ ...await g.inspect(path, kind), ...(path === installed.components.engine ? { version: '0.0.9' } : {}) })
    await expect(installComponents({ ...g, profile: 'app' }, older)).rejects.toThrow('请明确升级')
    expect(statSync(installed.components.engine).ino).toBe(engineBefore.ino)
    writeFileSync(join(g.payload, 'magic-cli'), 'updated-client')
    await installComponents({ ...g, profile: 'terminal', upgradeCLI: true }, g.inspect)
    expect(statSync(installed.components.engine).ino).toBe(engineBefore.ino)
    expect(readFileSync(installed.components.cli!, 'utf8')).toBe('updated-client')
    rmSync(command); symlinkSync(join(g.root, 'foreign-cli'), command)
    await expect(installComponents({ ...g, profile: 'app' }, g.inspect)).rejects.toThrow('其他文件占用')
  } finally { g.close() }
})

test('中断安装留下已完成的 Engine，可沿同一入口补齐 CLI，失败临时载荷已清理', async () => {
  const g = ground()
  try {
    const interrupted: ComponentInspector = async (path, kind) => {
      if (kind === 'cli' && path.endsWith('.tmp')) throw new Error('controlled-copy-failure')
      return g.inspect(path, kind)
    }
    await expect(installComponents({ ...g, profile: 'terminal' }, interrupted)).rejects.toThrow('已登记组件保留')
    const partial = readComponents(g.home)!
    expect(existsSync(partial.engine)).toBe(true); expect(partial.cli).toBeUndefined()
    expect(existsSync(join(g.home, '.local/bin/magic'))).toBe(false)
    const before = statSync(partial.engine)
    const repaired = await installComponents({ ...g, profile: 'app' }, g.inspect)
    expect(repaired.reused).toEqual(['engine']); expect(repaired.installed).toEqual(['cli'])
    expect(statSync(partial.engine).ino).toBe(before.ino)
    expect(realpathSync(repaired.command!)).toBe(repaired.components.cli!)
  } finally { g.close() }
})

test('明确升级 Engine 必须先停止，停止与并发重启未确认时保留旧载荷', async () => {
  const g = ground()
  try {
    const installed = await installComponents({ ...g, profile: 'engine' }, g.inspect), original = installed.components.engine
    writeFileSync(original, '#!/bin/sh\nprintf \'{"state":"failed","error":"controlled-stop-failed"}\\n\'\n', { mode: 0o755 })
    const before = readFileSync(original, 'utf8')
    await expect(installComponents({ ...g, profile: 'engine', upgradeEngine: true }, g.inspect)).rejects.toThrow('controlled-stop-failed')
    expect(readFileSync(original, 'utf8')).toBe(before)
    writeFileSync(original, '#!/bin/sh\nprintf \'{"state":"stopped"}\\n\'\n')
    const discovery = join(componentDirectory(g.home), 'runtime/host.json')
    writeFileSync(discovery, JSON.stringify({ state: 'starting' }))
    await expect(installComponents({ ...g, profile: 'engine', upgradeEngine: true }, g.inspect)).rejects.toThrow('重新启动')
    rmSync(discovery)
    expect((await installComponents({ ...g, profile: 'engine', upgradeEngine: true }, g.inspect)).installed).toEqual(['engine'])
  } finally { g.close() }
})


test('卸载按组件归属处理，保留 Engine、用户数据和外来命令', async () => {
  const g = ground()
  try {
    const installed = await installComponents({ ...g, profile: 'terminal' }, g.inspect)
    const engineBefore = statSync(installed.components.engine)
    const selected = join(componentDirectory(g.home), 'engine.json')
    writeFileSync(selected, JSON.stringify({ parent: g.home }))
    const data = join(g.home, '.magic'); mkdirSync(data); writeFileSync(join(data, 'config.json'), '{"retained":true}')
    rmSync(installed.command!); writeFileSync(installed.command!, 'foreign')
    await expect(uninstallComponent(g.home, 'cli', g.inspect)).rejects.toThrow('其他文件占用')
    expect(existsSync(installed.components.cli!)).toBe(true)
    expect(readFileSync(installed.command!, 'utf8')).toBe('foreign')
    rmSync(installed.command!); symlinkSync(installed.components.cli!, installed.command!)
    await uninstallComponent(g.home, 'cli', g.inspect)
    expect(existsSync(installed.command!)).toBe(false); expect(existsSync(installed.components.cli!)).toBe(false)
    expect(statSync(installed.components.engine).ino).toBe(engineBefore.ino)
    const restored = await installComponents({ ...g, profile: 'terminal' }, g.inspect)
    expect(restored.reused).toEqual(['engine']); expect(restored.installed).toEqual(['cli'])
    writeFileSync(installed.components.engine, `#!/bin/sh\nprintf '{"state":"failed","error":"not-stopped"}\\n'\n`)
    await expect(uninstallComponent(g.home, 'engine', g.inspect)).rejects.toThrow('not-stopped')
    expect(existsSync(installed.components.engine)).toBe(true)
    writeFileSync(installed.components.engine, `#!/bin/sh\nprintf '{"state":"stopped"}\\n'\n`)
    await uninstallComponent(g.home, 'engine', g.inspect)
    expect(existsSync(installed.components.engine)).toBe(false); expect(existsSync(restored.components.cli!)).toBe(true)
    expect(readFileSync(join(data, 'config.json'), 'utf8')).toBe('{"retained":true}')
    expect(JSON.parse(readFileSync(selected, 'utf8'))).toEqual({ parent: g.home })
  } finally { g.close() }
})
