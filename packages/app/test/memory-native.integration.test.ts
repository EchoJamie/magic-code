import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { NativeResponse } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startManager, type Manager } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'

test('真实 Swift→Engine→SQLite→Swift 记忆桥分页读取，无 Agent，退出关闭 socket', async () => {
  const root = mkdtempSync('/tmp/magic-mn-'), repository = resolve(import.meta.dir, '../../..')
  const home = join(root, 'home'), base = join(root, 'data'), workspace = join(root, 'project')
  for (const dir of [home, base, workspace]) mkdirSync(dir)
  writeFileSync(join(base, 'config.json'), JSON.stringify({ workspaces: [workspace] }))
  const paths = runPathsOf({ home, base }, '/tmp'), binary = join(root, 'memory-test')
  let manager: Manager | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let store: ReturnType<typeof createRecordsStore> | undefined
  let launches = 0
  try {
    // 与 native-settings-fixture.ts 使用同一编译列表，不引入产品测试接口。
    const files = ['SettingsWire', 'SettingsFile', 'SettingsValidation', 'SettingsModels', 'NativeSettings', 'NativeWire', 'Diagnostics', 'PrivateFiles', 'ObserverConnection'].map(name => `apps/macos/MagicCode/Runtime/${name}.swift`)
    const build = Bun.spawn(['/usr/bin/xcrun', 'swiftc', '-module-cache-path', join(root, 'swift-cache'), '-parse-as-library', ...files, 'apps/macos/MagicCodeTests/MemoryHarness.swift', '-o', binary], {
      cwd: repository, env: { ...process.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' }, stdout: 'ignore', stderr: 'pipe',
    })
    child = build
    timer = setTimeout(() => build.kill(), 45000)
    const [buildCode, buildError] = await Promise.all([build.exited, new Response(build.stderr).text()])
    clearTimeout(timer); timer = undefined; child = undefined
    if (buildCode !== 0) throw new Error(`原生记忆测试编译失败：${buildError}`)

    store = createRecordsStore({ dataDir: base, workspace: [workspace] })
    const records = store.serviceFor('native-memory')
    const original = '中文来源与逐页边界。'.repeat(2000) + '原文末尾'
    const entry = records.appendEntry({ kind: 'user', content: { text: original }, at: 1 })
    const source = { session: 'native-memory', entry }
    expect(records.memory.update({ expectedRevision: 0, inspectedThrough: entry, changes: [{ id: 'requirement', kind: 'requirement', text: '保留原始要求', evidence: 'fact', status: 'active', sources: [source] }] }).ok).toBe(true)
    expect(store.knowledge.write([{ id: 'native-knowledge', expectedRevision: 0, scope: { kind: 'project', workspace: [workspace] }, topic: '原生桥', terms: [], conclusion: '真实 SQLite 样本', conditions: '隔离测试', evidence: 'fact', status: 'active', sources: [source], dependencies: [] }]).ok).toBe(true)
    const before = records.memory.read(), knowledge = store.knowledge.search(), entries = await Array.fromAsync(records.readEntries('native-memory'))
    store.close(); store = undefined

    const started = await startManager({ magic: { home, base }, paths, launch: { spawn() { launches++; throw new Error('只读原生桥不得启动 Agent') } } })
    if (started.role !== 'manager') throw new Error(`隔离 Engine 未启动：${JSON.stringify(started)}`)
    manager = started.manager
    const native = Bun.spawn([binary], { stdin: new Blob([JSON.stringify({ socket: paths.socket, identity: manager.identity, session: 'native-memory', item: 'requirement' })]), stdout: 'pipe', stderr: 'pipe', env: { HOME: home } })
    child = native
    timer = setTimeout(() => native.kill(), 25000)
    const errors = new Response(native.stderr).text()
    const reader = native.stdout.getReader(), decoder = new TextDecoder()
    let output = ''
    while (!output.includes('\n')) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error(`Swift 未返回记忆结果：${await errors}`)
      output += decoder.decode(chunk.value, { stream: true })
    }
    const decoded = JSON.parse(output.trim()) as { responses: NativeResponse[] }
    const responses = decoded.responses.map(response => {
      if (response.t !== 'native.memory.result') throw new Error('Swift 返回了错误响应类型')
      expect(response.error).toBeUndefined()
      expect(response.serviceInstance).toBe(manager!.identity.serviceInstance)
      expect(response.session).toBe('native-memory')
      return response
    })
    expect(responses[0]?.memory).toMatchObject({ session: before.session, revision: before.revision, inspectedThrough: entry, items: [{ id: 'requirement', text: '保留原始要求', sources: [source], revision: 1 }] })
    expect(responses[0]?.unprocessed).toBe(false)
    expect(responses[0]?.knowledge?.items).toMatchObject([{ id: 'native-knowledge', conclusion: '真实 SQLite 样本', sources: [source] }])
    const pages = responses.slice(1).map(response => response.material!)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.map(page => page.text).join('')).toBe(original)
    let offset = 0
    for (const [index, page] of pages.entries()) {
      expect(page.source).toEqual({ ...source, offset })
      expect(page.total).toBe(original.length)
      expect(page.kind).toBe('user')
      offset += page.text.length
      expect(page.complete).toBe(index === pages.length - 1)
      expect(page.next).toBe(index === pages.length - 1 ? undefined : offset)
    }
    expect(launches).toBe(0)
    expect(manager.executors()).toEqual([])
    expect(manager.runs()).toEqual([])
    manager.stop('原生记忆桥测试完成'); await manager.waitUntilExit(); manager = undefined
    expect(existsSync(paths.socket)).toBe(false)
    while (!(await reader.read()).done) { /* 等 Swift 确认真实连接断开并退出。 */ }
    expect(await native.exited).toBe(0)
    expect(await errors).toBe('')
    clearTimeout(timer); timer = undefined; child = undefined

    store = createRecordsStore({ dataDir: base, workspace: [workspace] })
    expect(store.serviceFor('native-memory').memory.read()).toEqual(before)
    expect(store.knowledge.search()).toEqual(knowledge)
    expect(await Array.fromAsync(store.readEntries('native-memory'))).toEqual(entries)
    expect(await store.listSessions()).toHaveLength(1)
  } finally {
    if (timer) clearTimeout(timer)
    if (child) { child.kill(); await child.exited }
    if (manager) { manager.stop('原生测试清场'); await manager.waitUntilExit() }
    store?.close()
    rmSync(root, { recursive: true, force: true })
  }
  expect(existsSync(root)).toBe(false)
}, 80000)
