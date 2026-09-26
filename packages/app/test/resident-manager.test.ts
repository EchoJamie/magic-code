import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeResponse, Wire } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startManager, type ManagerOptions, type ExecutorRequest } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { connectManager } from '../src/run/client.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}
function ground() {
  const root = mkdtempSync(join(tmpdir(), 'resident-manager-'))
  const magic = resolveMagicHome({}, root)
  const dataDir = join(root, 'data')
  return { root, magic, dataDir, paths: runPathsOf(magic, dataDir, tmpdir()) }
}

test('原生停止绑定当前输入代次，旧菜单不误停下一轮，同一请求只执行一次', async () => {
  const g = ground()
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.root] })
  store.setSessionTitle('work', '连续工作', 1)
  const launches: ExecutorRequest[] = []
  let end: (reason: string) => void = () => {}
  const started = await startManager({ ...g, stopGraceMs: 50, stopKillMs: 50,
    launch: { spawn(request) { launches.push(request); return {
      pid: undefined,
      onExit(callback) { end = callback }, kill() { end('测试执行者退出') },
    } } },
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  const manager = started.manager
  const native = linkOf(await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() }) as never)
  const responses: NativeResponse[] = []
  native.onMessage((message) => { if (message.t.startsWith('native.')) responses.push(message as NativeResponse) })
  const latest = () => responses.flatMap((one) => one.t === 'native.welcome' || one.t === 'native.projection' ? one.projection.works : []).at(-1)
  const client = await connectManager(g.paths.socket, { session: 'work' })
  let executor: ReturnType<typeof linkOf> | undefined
  try {
    native.send({ t: 'hello', role: 'observer', ...manager.identity })
    client?.send({ type: 'input.submit', text: '第一轮' })
    await waitFor(() => launches.length === 1)
    executor = linkOf(await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() }) as never)
    const messages: Wire[] = []
    executor.onMessage((one) => messages.push(one))
    executor.send({ t: 'hello', role: 'executor', token: launches[0]!.token, session: 'work', workspace: [g.root] })
    executor.send({ t: 'bound', session: 'work' }); executor.send({ t: 'ready' })
    await waitFor(() => messages.some((one) => one.t === 'cmd'))
    native.send({ t: 'native.refresh' })
    await waitFor(() => latest()?.gen != null)
    const old = latest()!.gen!
    client?.send({ type: 'input.submit', text: '同一执行者的下一轮' })
    await waitFor(() => messages.filter((one) => one.t === 'cmd').length === 2)
    native.send({ t: 'native.stop', request: 'old-menu', session: 'work', serviceInstance: manager.identity.serviceInstance, gen: old })
    await waitFor(() => responses.some((one) => one.t === 'native.stopped' && one.request === 'old-menu'))
    expect(responses.find((one) => one.t === 'native.stopped' && one.request === 'old-menu')).toMatchObject({ phase: 'unconfirmed' })
    expect(messages.filter((one) => one.t === 'bye')).toHaveLength(0)
    native.send({ t: 'native.refresh' })
    await waitFor(() => latest()?.gen !== old)
    const stop = { t: 'native.stop' as const, request: 'current', session: 'work', serviceInstance: manager.identity.serviceInstance, gen: latest()!.gen! }
    native.send(stop); native.send(stop)
    await waitFor(() => messages.some((one) => one.t === 'bye'))
    expect(messages.filter((one) => one.t === 'bye')).toHaveLength(1)
    end('测试执行者已核销')
    await waitFor(() => responses.some((one) => one.t === 'native.stopped' && one.request === 'current' && one.phase === 'done'))
    const before = responses.length
    native.send(stop)
    await waitFor(() => responses.length > before)
    expect(responses.at(-1)).toMatchObject({ t: 'native.stopped', request: 'current', phase: 'done' })
    expect(launches).toHaveLength(1)
  } finally {
    executor?.close(); client?.close(); native.close(); manager.stop('测试结束'); await manager.waitUntilExit()
    store.close(); rmSync(g.root, { recursive: true, force: true })
  }
})

 test('纯观察：多次hello/订阅/目录/历史不标读，不起执行者；按事项读与投递独立', async () => {
  const g = ground()
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.root] })
  store.setSessionTitle('session-a', '同名工作', 1)
  store.attention.put({ id: 'one', session: 'session-a', kind: 'needs-you', at: 2, fact: 'event:1', unread: true, delivered: false })
  store.attention.put({ id: 'two', session: 'session-a', kind: 'done', at: 3, fact: 'event:2', unread: true, delivered: false })
  let spawns = 0
  const started = await startManager({ ...g, launch: { spawn() { spawns++; throw new Error('观察不执行') } } })
  if (started.role !== 'manager') throw new Error('启动失败')
  const manager = started.manager
  const socket = await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() })
  const link = linkOf<NativeResponse>(socket as never)
  const received: NativeResponse[] = []
  link.onMessage((message) => received.push(message))
  try {
    link.send({ t: 'hello', role: 'observer', ...manager.identity })
    await waitFor(() => received.some((one) => one.t === 'native.welcome'))
    for (let i = 0; i < 3; i++) {
      const client = await connectManager(g.paths.socket, { session: 'session-a' })
      expect(client?.unread.map((one) => one.id)).toEqual(['one', 'two'])
      client?.send({ type: 'session.list' })
      client?.send({ type: 'history.read', session: 'session-a' })
      client?.close()
    }
    link.send({ t: 'native.inspect', request: 'read-barrier', session: 'session-a' })
    await waitFor(() => received.some((one) => one.t === 'native.inspected'))
    expect(store.attention.list().map((one) => [one.unread, one.delivered])).toEqual([[true, false], [true, false]])
    expect(spawns).toBe(0)
    expect(manager.executors()).toHaveLength(0)
    link.send({ t: 'native.read', ids: ['one'] })
    link.send({ t: 'native.delivered', ids: ['two'] })
    link.send({ t: 'native.inspect', request: 'ack-barrier', session: 'session-a' })
    await waitFor(() => received.some((one) => one.t === 'native.inspected' && one.request === 'ack-barrier'))
    expect(store.attention.list().map((one) => [one.unread, one.delivered])).toEqual([[false, false], [true, true]])
    expect(store.attention.list()[0]?.kind).toBe('needs-you')
  } finally {
    link.close(); manager.stop('测试宿主退出'); await manager.waitUntilExit(); store.close()
    rmSync(g.root, { recursive: true, force: true })
  }
})

 test('关闭持久准入抛错：本机门保持关闭，重试必须再次完成持久门', async () => {
  const g = ground()
  let closes = 0
  let drains = 0
  const faults: string[] = []
  const started = await startManager({
    ...g, launch: { spawn() { throw new Error('不应执行') } },
    lifecycle: {
      closeAdmission() { if (++closes === 1) throw new Error('controlled-write-failure') },
      async shutdown() { drains++ }, affected: async () => [],
    }, onShutdownError: (reason) => faults.push(reason),
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  try {
    started.manager.stop('第一次')
    expect(faults[0]).toContain('controlled-write-failure')
    expect(drains).toBe(0)
    await expect(connectManager(g.paths.socket, { timeoutMs: 100 })).rejects.toThrow('正在退出')
    started.manager.stop('重试')
    await started.manager.waitUntilExit()
    expect(closes).toBe(2)
    expect(drains).toBe(1)
  } finally { rmSync(g.root, { recursive: true, force: true }) }
})

 test('扩展收尾挂起不阻挡真实执行资源 TERM/KILL，也不伪报退出完成', async () => {
  const g = ground()
  let release: () => void = () => {}
  const extension = new Promise<void>((resolve) => { release = resolve })
  let child: ReturnType<typeof Bun.spawn> | undefined
  const signals: string[] = []
  const faults: string[] = []
  const launch: ManagerOptions['launch'] = {
    spawn() {
      child = Bun.spawn(['/bin/sh', '-c', 'trap "" TERM; exec /bin/sleep 300'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
      const process = child
      return {
        pid: process.pid,
        onExit(callback) { void process.exited.then(() => callback('真实子进程已退出')) },
        kill(signal = 'SIGTERM') { signals.push(signal); process.kill(signal) },
      }
    },
  }
  const started = await startManager({ ...g, launch, stopGraceMs: 30, stopKillMs: 30,
    lifecycle: { closeAdmission() {}, shutdown: () => extension, affected: async () => [] },
    onShutdownError: (reason) => faults.push(reason),
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  let exited = false
  void started.manager.waitUntilExit().then(() => { exited = true })
  try {
    const client = await connectManager(g.paths.socket)
    client?.send({ type: 'input.submit', text: '隔离测试' })
    await waitFor(() => child !== undefined)
    started.manager.stop('测试退出')
    await waitFor(() => faults.length > 0)
    expect(await child!.exited).toBe(137)
    expect(child?.signalCode).toBe('SIGKILL')
    expect(signals).toContain('SIGTERM')
    expect(signals).toContain('SIGKILL')
    expect(exited).toBe(false)
    expect(faults[0]).toContain('协作收尾尚未确认')
    release()
    await Bun.sleep(0)
    started.manager.stop('重试确认')
    await started.manager.waitUntilExit()
    expect(exited).toBe(true)
    client?.close()
  } finally {
    release()
    if (child && child.exitCode === null) { child.kill('SIGKILL'); await child.exited }
    started.manager.stop('测试清理'); await started.manager.waitUntilExit()
    rmSync(g.root, { recursive: true, force: true })
  }
}, 10000)

 test('已完成会话回放真实用户/助手/工具记录，跨分块无漏重、不执行、不消费事项', async () => {
  const g = ground()
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.root] })
  const records = store.serviceFor('history-session')
  const expected: import('@magic/contracts').Entry[] = []
  for (let i = 0; i < 14; i++) {
    const entries: import('@magic/contracts').NewEntry[] = [
      { kind: 'user', content: { text: `第${i}次交代\n保留原文` }, at: 10 + i * 4 },
      { kind: 'assistant', content: { text: `第${i}次答复` }, at: 11 + i * 4 },
      { kind: 'tool-call', content: { text: 'exec: echo fixture' }, payload: { name: 'exec', args: { cmd: 'echo fixture' } }, at: 12 + i * 4 },
      { kind: 'tool-result', content: { text: `fixture-${i}` }, payload: { ok: true, output: { text: `fixture-${i}` } }, at: 13 + i * 4 },
    ]
    for (const entry of entries) expected.push({ ...entry, id: records.appendEntry(entry) })
  }
  store.attention.put({ id: 'history-done', session: 'history-session', kind: 'done', at: 100, fact: 'finished', unread: true, delivered: false })
  let spawns = 0
  const started = await startManager({ ...g, launch: { spawn() { spawns++; throw new Error('只读回放不得执行') } } })
  if (started.role !== 'manager') throw new Error('启动失败')
  const socket = await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() })
  const link = linkOf(socket as never)
  const chunks: { entries: readonly import('@magic/contracts').Entry[]; done: boolean }[] = []
  const active: string[] = []
  link.onMessage((message) => {
    if (message.t !== 'ev') return
    if (message.event.kind === 'session.state') active.push(message.event.data.active)
    if (message.event.kind === 'session.history') chunks.push(message.event.data)
  })
  try {
    link.send({ t: 'hello', role: 'client', protocol: started.manager.identity.protocol, version: started.manager.identity.version, source: started.manager.identity.source, cwd: '/tmp', session: 'history-session' })
    await waitFor(() => chunks.some((one) => one.done))
    expect(active).toContain('history-session')
    expect(chunks.map((one) => [one.entries.length, one.done])).toEqual([[50, false], [6, true]])
    expect(chunks.flatMap((one) => one.entries)).toEqual(expected)
    chunks.length = 0
    // 两个同一读取在途的请求只回一份，不能把旧半批拼进新整批。
    link.send({ t: 'cmd', gen: null, cmd: { type: 'history.read', session: 'history-session' } })
    link.send({ t: 'cmd', gen: null, cmd: { type: 'history.read', session: 'history-session' } })
    await waitFor(() => chunks.some((one) => one.done))
    expect(chunks.flatMap((one) => one.entries)).toEqual(expected)
    expect(chunks.filter((one) => one.done)).toHaveLength(1)
    expect(spawns).toBe(0)
    expect(started.manager.executors()).toHaveLength(0)
    expect(store.attention.list()[0]?.unread).toBe(true)
    expect(await store.listSessions()).toHaveLength(1)
  } finally {
    link.close(); started.manager.stop('测试结束'); await started.manager.waitUntilExit(); store.close()
    rmSync(g.root, { recursive: true, force: true })
  }
})
