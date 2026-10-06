import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { KernelEvent, NativeResponse, RunSnapshot, Wire } from '@magic/contracts'
import { resolveMagicHome } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { startManager, type ManagerOptions, type ExecutorRequest } from '../src/run/manager.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { connectManager } from '../src/run/client.ts'
import { terminalConnection } from '../src/run/terminal.ts'
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

for (const recognition of ['bound', 'event.session', 'session.state.active'] as const) {
  test(`空白首消息经 ${recognition} 认领真实 target；同代不重取快照，宿主重开仍提交原 Session`, async () => {
    const g = ground()
    const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.root] })
    const launches: ExecutorRequest[] = []
    const options: ManagerOptions = { ...g, stopGraceMs: 10, stopKillMs: 10,
      launch: { spawn(request) {
        launches.push(request)
        let end = (_reason: string) => {}
        return { pid: undefined, onExit(callback) { end = callback }, kill() { end('测试执行者核销') } }
      } },
    }
    const started = await startManager(options)
    if (started.role !== 'manager') throw new Error('启动失败')
    let manager = started.manager
    const initial = (await connectManager(g.paths.socket))!
    const reconnectSessions: (string | undefined)[] = []
    const connection = terminalConnection(initial, async (session) => {
      reconnectSessions.push(session)
      return (await connectManager(g.paths.socket, { session }))!
    })
    const targets: { session: string | null; gen: number | null }[] = []
    const resumed: RunSnapshot[] = []
    const received: KernelEvent[] = []
    connection.client.onTarget((session) => targets.push({ session, gen: connection.client.gen() }))
    connection.client.onResumed((_gen, snapshot) => resumed.push(snapshot))
    connection.client.onEvent((event) => received.push(event))
    let executor: ReturnType<typeof linkOf> | undefined
    try {
      expect(await store.listSessions()).toHaveLength(0)
      expect(manager.executors()).toHaveLength(0)
      connection.client.send({ type: 'input.submit', text: '空白页第一次明确输入' })
      await waitFor(() => launches.length === 1 && targets.length === 1)
      expect(launches[0]!.session).toBeNull()
      const gen = launches[0]!.gen
      expect(targets).toEqual([{ session: null, gen }])
      executor = linkOf(await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() }) as never)
      const requests: Wire[] = []
      executor.onMessage((message) => requests.push(message))
      // bound 路也覆盖 hello 已认领 run.session、但窗口仍只知道 null 的次序。
      executor.send({ t: 'hello', role: 'executor', token: launches[0]!.token,
        session: recognition === 'bound' ? 'actual-session' : null, workspace: [g.root] })
      executor.send({ t: 'ready' })
      await waitFor(() => requests.some((message) => message.t === 'snapshot'))
      // 查询/配置产生的临时身份尚未落账，三种认领路径都不能把它交给终端恢复。
      executor.send(recognition === 'bound'
        ? { t: 'bound', session: 'empty-session' }
        : { t: 'ev', event: recognition === 'event.session'
          ? { id: 0, session: 'empty-session', turn: null, at: 0, kind: 'agent.state', data: { state: 'waiting' } }
          : { id: 0, session: 'empty-session', turn: null, at: 0, kind: 'session.state',
            data: { active: 'empty-session', sessions: [] } } })
      store.setSessionTitle('actual-session', '首条交代创建的工作', 1)
      const recognitionMessage: Wire = recognition === 'bound'
        ? { t: 'bound', session: 'actual-session' }
        : { t: 'ev', event: recognition === 'event.session'
          ? { id: 1, session: 'actual-session', turn: null, at: 1, kind: 'agent.state', data: { state: 'waiting' } }
          : { id: 1, session: 'stale-envelope-session', turn: null, at: 1, kind: 'session.state',
            data: { active: 'actual-session', sessions: [] } } }
      executor.send(recognitionMessage)
      executor.send(recognitionMessage) // 重复认领不重复推 target。
      const buffered: KernelEvent = { id: 2, session: 'actual-session', turn: null, at: 2,
        kind: 'agent.state', data: { state: 'waiting' } }
      executor.send({ t: 'ev', event: buffered })
      const snapshotRequest = requests.find((message) => message.t === 'snapshot')!
      const snapshot: RunSnapshot = { watermark: 1, turnOpen: false, tools: [], decisions: [] }
      executor.send({ t: 'snapshot', seq: snapshotRequest.seq, snapshot })
      await waitFor(() => resumed.length === 1 && received.some((event) => event.id === 2))
      // 快照回执是处理屏障；旧实现红在实际 target 值，不靠等 target 超时。
      expect(targets).toEqual([{ session: null, gen }, { session: 'actual-session', gen }])
      expect(requests.filter((message) => message.t === 'snapshot')).toHaveLength(1)
      expect(received).toEqual([buffered]) // 原水位和缓冲没有被通知重置。
      expect(resumed).toEqual([snapshot])
      expect(launches).toHaveLength(1)

      manager.stop('受控宿主退出'); await manager.waitUntilExit()
      await waitFor(() => connection.client.closed)
      const restarted = await startManager(options)
      if (restarted.role !== 'manager') throw new Error('重启失败')
      manager = restarted.manager
      await connection.reopen()
      expect(reconnectSessions).toEqual(['actual-session'])
      await waitFor(() => received.some((event) => event.kind === 'session.state' && event.data.active === 'actual-session'))
      expect(manager.executors()).toHaveLength(0)
      expect(launches).toHaveLength(1) // 重握手、历史接回均不执行。
      connection.client.send({ type: 'input.submit', text: '明确 Enter 继续原工作' })
      await waitFor(() => launches.length === 2)
      expect(launches[1]!.session).toBe('actual-session')
      expect((await store.listSessions()).map((session) => session.id)).toEqual(['actual-session'])
    } finally {
      connection.client.close(); executor?.close(); manager.stop('测试结束'); await manager.waitUntilExit()
      store.close(); rmSync(g.root, { recursive: true, force: true })
    }
  })
}

test('窗口切走后旧执行者迟到 bound/event 只更新当前 watchers，不误指新目标', async () => {
  const g = ground()
  const store = createRecordsStore({ dataDir: g.dataDir, workspace: [g.root] })
  store.setSessionTitle('old', '原工作', 1)
  store.setSessionTitle('chosen', '主动切到的工作', 2)
  store.setSessionTitle('late-bound', '原执行者认领的持久工作', 3)
  store.setSessionTitle('late-active', '原执行者后来认领的工作', 3)
  const launches: ExecutorRequest[] = []
  const started = await startManager({ ...g, stopGraceMs: 10, stopKillMs: 10,
    launch: { spawn(request) {
      launches.push(request)
      let end = (_reason: string) => {}
      return { pid: undefined, onExit(callback) { end = callback }, kill() { end('已核销') } }
    } },
  })
  if (started.role !== 'manager') throw new Error('启动失败')
  const manager = started.manager
  const left = (await connectManager(g.paths.socket, { session: 'old' }))!
  let right: Awaited<ReturnType<typeof connectManager>>
  let executor: ReturnType<typeof linkOf> | undefined
  try {
    left.send({ type: 'input.submit', text: '开始' })
    await waitFor(() => launches.length === 1)
    executor = linkOf(await Bun.connect({ unix: g.paths.socket, socket: socketHandlers() }) as never)
    executor.send({ t: 'hello', role: 'executor', token: launches[0]!.token, session: 'old', workspace: [g.root] })
    executor.send({ t: 'ready' })
    right = (await connectManager(g.paths.socket, { session: 'old' }))!
    const leftTargets: (string | null)[] = [], rightTargets: (string | null)[] = []
    left.onTarget((session) => leftTargets.push(session))
    right.onTarget((session) => rightTargets.push(session))
    left.send({ type: 'session.open', session: 'chosen' })
    await waitFor(() => leftTargets.at(-1) === 'chosen' && rightTargets.at(-1) === 'old')
    leftTargets.length = 0; rightTargets.length = 0
    executor.send({ t: 'bound', session: 'late-bound' })
    executor.send({ t: 'ev', event: { id: 1, turn: null, session: 'late-envelope', at: 1, kind: 'session.state',
      data: { active: 'late-active', sessions: [] } } })
    await waitFor(() => manager.executors()[0]?.session === 'late-active')
    // runs 在 target 之后发送，用客户端读数作为 socket 处理屏障。
    await waitFor(() => right!.runs().some((row) => row.session === 'late-active'))
    expect(leftTargets).toEqual([])
    expect(rightTargets).toEqual(['late-bound', 'late-active'])
    left.send({ type: 'input.submit', text: '仍继续主动选中的工作' })
    await waitFor(() => launches.length === 2)
    expect(launches[1]!.session).toBe('chosen')
  } finally {
    left.close(); right?.close(); executor?.close(); manager.stop('测试结束'); await manager.waitUntilExit()
    store.close(); rmSync(g.root, { recursive: true, force: true })
  }
})

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
    await waitFor(() => messages.some((one) => one.t === 'cmd' && one.cmd.type === 'input.submit'))
    native.send({ t: 'native.refresh' })
    await waitFor(() => latest()?.gen != null)
    const old = latest()!.gen!
    client?.send({ type: 'input.submit', text: '同一执行者的下一轮' })
    await waitFor(() => messages.filter((one) => one.t === 'cmd' && one.cmd.type === 'input.submit').length === 2)
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
