import { expect, test } from 'bun:test'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeResponse, NativeRequest, KernelEvent } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startManager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { connectManager } from '../src/run/client.ts'
import { cliGround, waitFor } from './resident-cli-fixture.ts'

test('真实原生socket保存、两观察入口冲突与TUI双向事实；不产生工作或执行者', async () => {
  const g = cliGround(), magic = { base: g.base, home: g.home }, path = join(g.base, 'config.json')
  const started = await startManager({ paths: runPathsOf(magic, g.dataDir, g.root), magic, dataDir: g.dataDir, launch: { spawn() { throw new Error('设置不应启动执行者') } } })
  if (started.role !== 'manager') throw new Error('管理者未启动')
  const manager = started.manager, store = createRecordsStore({ dataDir: g.dataDir, workspace: [] })
  const one = linkOf<NativeResponse>(await Bun.connect({ unix: manager.socketPath, socket: socketHandlers() }) as never)
  const two = linkOf<NativeResponse>(await Bun.connect({ unix: manager.socketPath, socket: socketHandlers() }) as never)
  const received: NativeResponse[] = [], other: NativeResponse[] = []
  one.onMessage(v => received.push(v)); two.onMessage(v => other.push(v))
  const client = await connectManager(manager.socketPath, { cwd: g.root })
  if (!client) throw new Error('TUI连接失败')
  const events: KernelEvent[] = []; client.onEvent(e => events.push(e))
  const identity = manager.identity
  const hello: NativeRequest = { t: 'hello', role: 'observer', protocol: identity.protocol, version: identity.version, source: identity.source, dataDir: identity.dataDir }
  const target = { serviceInstance: identity.serviceInstance, dataDir: identity.dataDir }
  function result(id: string, all = received) { return all.find((v): v is Extract<NativeResponse, { t: 'native.settings.result' }> => v.t === 'native.settings.result' && v.request === id) }
  try {
    one.send(hello); two.send(hello); await waitFor(() => received.some(v => v.t === 'native.welcome') && other.some(v => v.t === 'native.welcome'))
    one.send({ t: 'native.settings.read', request: 'before', ...target }); await waitFor(() => result('before') !== undefined)
    two.send({ t: 'native.settings.read', request: 'other-before', ...target }); await waitFor(() => result('other-before', other) !== undefined)
    const before = result('before')!.snapshot!
    const save: NativeRequest = { t: 'native.settings.apply', request: 'save', ...target, stamp: before.stamp, action: { type: 'prefs.set', statusLine: { cells: ['workspace', 'session'], color: false }, reducedMotion: true } }
    one.send(save); await waitFor(() => result('save') !== undefined)
    expect(result('save')!.error).toBeUndefined(); expect(events.some(e => e.kind === 'prefs.state' && e.data.reducedMotion)).toBe(true)
    const content = readFileSync(path, 'utf8'); one.send(save)
    await waitFor(() => received.filter(v => v.t === 'native.settings.result' && v.request === 'save').length === 2)
    expect(readFileSync(path, 'utf8')).toBe(content)
    two.send({ t: 'native.settings.apply', request: 'conflict', ...target, stamp: before.stamp, action: { type: 'prefs.set', reducedMotion: false } }); await waitFor(() => result('conflict', other) !== undefined)
    expect(result('conflict', other)!.error).toContain('修改'); expect(readFileSync(path, 'utf8')).toBe(content)
    one.send({ t: 'native.settings.apply', request: 'identity-spoof', ...target, serviceInstance: 'WRONG', stamp: result('save')!.snapshot!.stamp, action: { type: 'prefs.set', reducedMotion: false } }); await waitFor(() => result('identity-spoof') !== undefined)
    expect(result('identity-spoof')!.error).toContain('身份'); expect(readFileSync(path, 'utf8')).toBe(content)
    client.send({ type: 'prefs.set', reducedMotion: false }); await waitFor(() => events.some(e => e.kind === 'prefs.state' && !e.data.reducedMotion))
    one.send({ t: 'native.settings.read', request: 'after-tui', ...target }); await waitFor(() => result('after-tui') !== undefined)
    expect(result('after-tui')!.snapshot!.configuration.motion).toEqual({})
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), statusLine: { cells: ['model', 'context'] } }))
    one.send({ t: 'native.settings.read', request: 'after-file', ...target }); await waitFor(() => result('after-file') !== undefined)
    expect(result('after-file')!.snapshot!.configuration.statusLine).toEqual({ cells: ['model', 'context'] })
    expect(manager.executors()).toEqual([]); expect(await store.listSessions()).toEqual([])
    const evidence = process.env['MAGIC_SETTINGS_NATIVE_EVIDENCE']
    if (evidence) writeFileSync(evidence, JSON.stringify({ entry: 'real native socket → manager → shared config; real TUI reverse update', identity: target, saved: result('save'), tuiReadBack: result('after-tui'), fileReadBack: result('after-file'), conflict: result('conflict', other), wrongIdentity: result('identity-spoof'), duplicateWriteChangedFile: false, sessions: 0, executors: 0 }, null, 2))
  } finally { one.close(); two.close(); client.close(); manager.stop('settings测试收尾'); await manager.waitUntilExit(); store.close(); g.close() }
})
