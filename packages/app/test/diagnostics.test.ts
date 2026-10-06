import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { diagnosticsOf, decodeNativeMessage } from '@magic/contracts'
import { loadConfig } from '../src/config.ts'
import { parseArgs } from '../src/cli.ts'
import { saveDiagnostics } from '../src/diagnostics.ts'
import { DiagnosticLog } from '../src/diagnostic-log.ts'
import { configStamp } from '../src/cache-access.ts'
import { cliGround } from './resident-cli-fixture.ts'
const settingsAction = (action: unknown) => decodeNativeMessage({ t: 'native.settings.apply', request: 'test', serviceInstance: 'service', dataDir: '/instance', stamp: null, action }) !== undefined
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function setup() { const g = cliGround(); cleanups.push(g.close); return { ...g, magic: { base: g.base, home: g.home }, path: join(g.base, 'config.json') } }

test('诊断默认值只读；显式两项原子保存，独立关闭模式保留 trace 和其它配置', () => {
  const g = setup(), original = readFileSync(g.path, 'utf8')
  expect(diagnosticsOf(loadConfig({ magic: g.magic }).config)).toEqual({ debugMode: false, logLevel: 'info' })
  expect(readFileSync(g.path, 'utf8')).toBe(original)
  writeFileSync(g.path, JSON.stringify({ dataDir: g.dataDir, untouched: 'keep', providers: { ds: { vendor: 'deepseek', apiKey: 'PRIVATE_SENTINEL' } } }))
  saveDiagnostics(g.magic, { debugMode: true, logLevel: 'trace' }, configStamp(g.path))
  saveDiagnostics(g.magic, { debugMode: false }, configStamp(g.path))
  expect(diagnosticsOf(loadConfig({ magic: g.magic }).config)).toEqual({ debugMode: false, logLevel: 'trace' })
  expect(JSON.parse(readFileSync(g.path, 'utf8'))).toMatchObject({ untouched: 'keep', dataDir: g.dataDir, providers: { ds: { apiKey: 'PRIVATE_SENTINEL' } } })
  expect(statSync(g.path).mode & 0o777).toBe(0o600)
  expect(readdirSync(g.dataDir)).toEqual([])
})
test('坏参数、冲突和外部修改均不半保存；help 不执行设置，check 拒绝设置', () => {
  const g = setup(), original = readFileSync(g.path, 'utf8')
  for (const args of [['--debug', '--no-debug'], ['--debug', '--log-level'], ['--debug', '--log-level', 'verbose'], ['--check', '--debug'], ['--log-level', 'debug', '--log-level', 'trace']]) expect(() => parseArgs(args)).toThrow()
  expect(parseArgs(['--debug', '--log-level', 'trace']).diagnostics).toEqual({ debugMode: true, logLevel: 'trace' })
  expect(parseArgs(['--debug', '--help']).diagnostics).toBeUndefined()
  expect(() => saveDiagnostics(g.magic, { debugMode: true }, 'stale')).toThrow('配置已被修改')
  expect(() => saveDiagnostics(g.magic, { debugMode: true, logLevel: 'bad' as never }, configStamp(g.path))).toThrow('logLevel')
  expect(readFileSync(g.path, 'utf8')).toBe(original)
})
test('诊断协议拒绝坏值与空动作，真实值可往返', () => {
  expect(settingsAction({ type: 'diagnostics.set' })).toBe(false)
  expect(settingsAction({ type: 'diagnostics.set', logLevel: 'verbose' })).toBe(false)
  expect(settingsAction({ type: 'diagnostics.set', debugMode: false, logLevel: 'trace' })).toBe(true)
  const message = { t: 'host.diagnostics', request: 'one', value: { debugMode: true, logLevel: 'debug' }, dataDir: '/instance' } as const
  expect(decodeNativeMessage(message)).toEqual(message)
  expect(decodeNativeMessage({ ...message, value: { debugMode: 'true', logLevel: 'debug' } })).toBeUndefined()
})
test('文件日志动态阈值、结构化内容和权限；不接受正文或额外字段', async () => {
  const g = setup(), log = new DiagnosticLog('manager', g.dataDir, 'warn')
  log.write('debug', 'not.recorded'); log.write('error', 'host.failed')
  log.setLevel('trace'); log.write('trace', 'native.received', { request: 'req-one', userText: 'PRIVATE_SENTINEL' } as never)
  log.write('error', 'Authorization: Bearer PRIVATE_SENTINEL')
  await log.close()
  const names = readdirSync(log.directory)
  expect(names).toHaveLength(1); expect(names[0]).not.toContain('.active')
  const file = join(log.directory, names[0]!), text = readFileSync(file, 'utf8'), records = text.trim().split('\n').map(s => JSON.parse(s))
  expect(records.map(r => r.event)).toEqual(['host.failed', 'native.received'])
  expect(records[1]).toMatchObject({ request: 'req-one', level: 'trace', component: 'manager', pid: process.pid })
  expect(text).not.toContain('PRIVATE_SENTINEL'); expect(statSync(file).mode & 0o777).toBe(0o600); expect(statSync(log.directory).mode & 0o777).toBe(0o700)
})
test('轮转仅删除已关闭文件、限制磁盘占用；写入故障保持业务可运行', async () => {
  const g = setup(), log = new DiagnosticLog('executor', g.dataDir, 'trace', { file: 500, total: 2000, queue: 100 })
  for (let i = 0; i < 20; i++) { log.write('debug', 'event.test', { count: i }); await log.flush() }
  const active = join(log.directory, readdirSync(log.directory).find(n => n.endsWith('.active.jsonl'))!)
  expect(existsSync(active)).toBe(true)
  await log.close()
  expect(readdirSync(log.directory).reduce((sum, name) => sum + statSync(join(log.directory, name)).size, 0)).toBeLessThanOrEqual(2000)
  const bad = join(g.root, 'not-directory'); writeFileSync(bad, '')
  const broken = new DiagnosticLog('manager', bad, 'info'); broken.write('info', 'startup'); await broken.flush()
  expect(broken.problem).toContain('日志写入失败'); await broken.close()
})

test('运行实例从同一 socket 修改，App 确认失败仍如实保存；重读恢复，不启动工作', async () => {
  const { startManager } = await import('../src/run/manager.ts')
  const { runPathsOf } = await import('../src/run/paths.ts')
  const { applyHostDiagnostics } = await import('../src/run/diagnostics-client.ts')
  const g = setup(); let fail = false; const received: unknown[] = []
  const started = await startManager({ magic: g.magic, dataDir: g.dataDir, paths: runPathsOf(g.magic, g.dataDir, g.root),
    launch: { spawn() { throw new Error('诊断设置不应启动执行者') } },
    diagnosticsChanged: async value => { received.push(value); if (fail) throw new Error('unconfirmed') },
  })
  if (started.role !== 'manager') throw new Error('未就绪')
  const manager = started.manager, discovery = { ...g.discovery, ...manager.identity, socket: manager.socketPath }
  try {
    expect(await applyHostDiagnostics(discovery, { debugMode: true, logLevel: 'trace' })).toContain('保存并生效')
    expect(received.at(-1)).toEqual({ debugMode: true, logLevel: 'trace' })
    fail = true
    expect(await applyHostDiagnostics(discovery, { debugMode: false })).toContain('已保存，部分运行进程尚未确认生效：App')
    expect(diagnosticsOf(loadConfig({ magic: g.magic }).config)).toEqual({ debugMode: false, logLevel: 'trace' })
    fail = false
    expect(await applyHostDiagnostics(discovery, { logLevel: 'error' })).toContain('保存并生效')
    expect(received.at(-1)).toEqual({ debugMode: false, logLevel: 'error' })
    expect(manager.executors()).toEqual([])
  } finally { manager.stop('诊断测试结束'); await manager.waitUntilExit() }
})

test('日志拥塞优先保留错误并记录丢弃数量，缓冲有界', async () => {
  const g = setup(), log = new DiagnosticLog('manager', g.dataDir, 'trace', { file: 10000, total: 20000, queue: 3 })
  for (let i = 0; i < 100; i++) log.write('trace', 'event.trace', { count: i })
  log.write('error', 'host.failed'); await log.close()
  const text = readdirSync(log.directory).map(name => readFileSync(join(log.directory, name), 'utf8')).join('')
  const rows = text.trim().split('\n').map(line => JSON.parse(line))
  expect(rows).toHaveLength(4)
  expect(rows.some(row => row.event === 'host.failed')).toBe(true)
  expect(rows.find(row => row.event === 'log.dropped').count).toBe(98)
})
