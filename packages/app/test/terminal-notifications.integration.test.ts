import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMagicHome, type NativeResponse, type NativeWork, type RunNotice } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { runPathsOf } from '../src/run/paths.ts'
import { startManager } from '../src/run/manager.ts'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check() && Date.now() < deadline) await Bun.sleep(5)
  expect(check()).toBe(true)
}

test('通知按具体会话绑定：切换、clear、多窗口、结束后仍查看与宿主换代', async () => {
  const root = mkdtempSync(join(tmpdir(), 'terminal-notices-'))
  const magic = resolveMagicHome({}, root)
  const dataDir = magic.base
  const store = createRecordsStore({ dataDir, workspace: [root] })
  for (const session of ['a', 'b']) {
    store.setSessionTitle(session, session, 1)
    const event = { id: store.serviceFor(session).nextId(), session, turn: 1, at: 1, kind: 'turn.end' as const, data: { reason: 'settled' as const } }
    store.appendEvent(event)
    store.attention.put({ source: { session, event: event.id }, id: `${session}:done:1`, session, kind: 'done', at: 1,
      fact: '1', unread: true, delivered: false })
  }
  const paths = runPathsOf(magic, tmpdir())
  const options = { magic, paths, launch: { spawn() { throw new Error('查看完成会话不能起执行者') } } }
  const started = await startManager(options)
  if (started.role !== 'manager') throw new Error('没有启动受控管理者')
  let manager = started.manager
  let observer = linkOf<NativeResponse>(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }) as never)
  const responses: NativeResponse[] = []
  const subscribe = () => {
    observer.onMessage(message => responses.push(message))
    observer.send({ t: 'hello', role: 'observer', ...manager.identity })
  }
  subscribe()
  let request = 0
  async function inspect(session: string): Promise<NativeWork | undefined> {
    const id = String(++request)
    observer.send({ t: 'native.inspect', request: id, session })
    await until(() => responses.some(message => message.t === 'native.inspected' && message.request === id))
    const result = responses.find(message => message.t === 'native.inspected' && message.request === id)
    if (result?.t !== 'native.inspected') throw new Error('读取失败')
    return result.work
  }
  const clients: ManagerClient[] = []
  async function connect(session?: string) {
    const client = await connectManager(paths.socket, { session })
    if (!client) throw new Error('终端连接失败')
    clients.push(client)
    return client
  }
  try {
    await until(() => responses.some(message => message.t === 'native.welcome'))
    const first = await connect('a')
    const second = await connect('a')
    expect((await inspect('a'))?.terminalOpen).toBe(true)
    expect((await inspect('b'))?.terminalOpen ?? false).toBe(false)
    expect(manager.executors()).toHaveLength(0)
    expect(store.attention.list().every(item => item.unread && !item.delivered)).toBe(true)

    const targets: (string | null)[] = []
    first.onTarget(session => targets.push(session))
    first.send({ type: 'session.open', session: 'b' })
    await until(() => targets.includes('b'))
    expect((await inspect('a'))?.terminalOpen).toBe(true)
    expect((await inspect('b'))?.terminalOpen).toBe(true)
    second.close()
    await until(() => second.closed)
    // inspect 往返也允许服务处理已关闭的传输。
    await inspect('a')
    expect((await inspect('a'))?.terminalOpen ?? false).toBe(false)
    first.send({ type: 'session.new' })
    await until(() => targets.includes(null))
    expect((await inspect('b'))?.terminalOpen ?? false).toBe(false)
    expect(store.attention.list().every(item => item.unread)).toBe(true)

    const bound = await connect('a')
    bound.markRead(['a:done:1'])
    await until(() => store.attention.list().find(item => item.session === 'a')?.unread === false)
    const oldIdentity = manager.identity.serviceInstance
    manager.stop('受控宿主重开'); await manager.waitUntilExit()
    const reopened = await startManager(options)
    if (reopened.role !== 'manager') throw new Error('没有重开管理者')
    manager = reopened.manager
    expect(manager.identity.serviceInstance).not.toBe(oldIdentity)
    observer = linkOf<NativeResponse>(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }) as never)
    subscribe()
    expect((await inspect('a'))?.terminalOpen ?? false).toBe(false)
    expect((await inspect('a'))?.terminalOpen).toBe(false)
    expect(store.attention.list({ sessions: ['a'] })[0]?.unread).toBe(false)
    await connect('b')
    expect((await inspect('b'))?.terminalOpen).toBe(true)

    const records = store.collaboration
    const model = { protocol: 'chat-completions' as const, endpoint: 'https://models.example/v1', choice: 'default' as const, provider: 'test', model: 'test' }
    const origin = { sessionId: 'a', entryId: store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '原工作' }, at: 2 }) }
    const coordinator = records.registerAgent({ operationId: 'register', sessionId: 'a', name: '协调', role: '', model, at: 3 })
    records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 4 })
    for (const sessionId of ['c', 'd']) {
      records.spawn(coordinator.agentId, { operationId: `spawn:${sessionId}`, sessionId, name: sessionId, role: '', model,
        body: [{ kind: 'text', text: '独立责任' }], scope: sessionId, source: origin, authorization: [origin], at: 5 })
      store.setSessionTitle(sessionId, sessionId, 5)

    }
    await connect('c')
    const memberView = await inspect('a')
    expect(memberView?.terminalOpen).toBe(true)
    expect(memberView?.session).toBe('a')
    expect(memberView?.currentNotice).toBeUndefined()
    await connect('a')
    expect((await inspect('a'))?.terminalOpen).toBe(true)

  } finally {
    clients.forEach(client => client.close()); observer.close()
    manager.stop('测试结束'); await manager.waitUntilExit()
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('终端接回显示旧完成提醒后标读，仅影响当前会话，断开后退出状态栏候选', async () => {
  const { runTui } = await import('@magic/tui')
  const { clientTransport } = await import('../src/run/terminal.ts')
  const { PassThrough } = await import('node:stream')
  const root = mkdtempSync(join(tmpdir(), 'resume-notice-read-'))
  const magic = resolveMagicHome({}, root), paths = runPathsOf(magic, tmpdir())
  const store = createRecordsStore({ dataDir: magic.base, workspace: [root] })
  for (const session of ['a', 'b', 'broken']) {
    const service = store.serviceFor(session)
    service.appendEntry({ kind: 'assistant', at: 1, content: session === 'broken' ? { blob: 'missing-result' } : { text: `${session} 的完整结果` } })
    if (session === 'broken') {
      service.appendEntry({ kind: 'user', at: 2, content: { text: '后续交代' } })
      service.appendEntry({ kind: 'assistant', at: 3, content: { text: '摘要仍可读取，较早正文缺失' } })
    }
    const id = service.nextId()
    store.appendEvent({ id, session, turn: 1, at: 1, kind: 'turn.end', data: { reason: 'settled' } })
    store.attention.put({ id: `${session}:done`, session, kind: 'done', at: 1, fact: String(id),
      source: { session, event: id }, unread: true, delivered: false })
  }
  const started = await startManager({ magic, paths, launch: { spawn() { throw new Error('接回查看不得启动模型') } } })
  if (started.role !== 'manager') throw new Error('未启动隔离管理者')
  const client = (await connectManager(paths.socket, { session: 'a' }))!
  const notices: RunNotice[] = []
  client.onNotice(notice => notices.push(notice))
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 40 })
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  let output = ''; stdout.on('data', chunk => { output += String(chunk) })
  let app: Awaited<ReturnType<typeof runTui>> | undefined
  try {
    client.send({ type: 'history.read', session: 'a' })
    await until(() => notices.some(notice => notice.id === 'a:done'))
    expect(store.attention.list().every(notice => notice.unread)).toBe(true)
    app = await runTui({ transport: clientTransport(client), magicBase: magic.base, openingSession: 'a',
      notices: listener => client.onNotice(listener), markRead: ids => client.markRead(ids),
      stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream })
    await until(() => store.attention.list({ sessions: ['a'] })[0]?.unread === false)
    expect(output).toContain('a 的完整结果')
    expect(store.attention.list({ sessions: ['b'] })[0]?.unread).toBe(true)
    client.send({ type: 'session.open', session: 'b' })
    await until(() => store.attention.list({ sessions: ['b'] })[0]?.unread === false)
    const failedHistory: string[] = []
    client.onEvent(event => { if (event.kind === 'session.history' && event.data.error) failedHistory.push(event.data.session) })
    client.send({ type: 'session.open', session: 'broken' })
    await until(() => failedHistory.includes('broken'))
    expect(store.attention.list({ sessions: ['broken'] })[0]?.unread).toBe(true)
    expect(notices.some(notice => notice.id === 'broken:done')).toBe(false)
    expect(started.manager.executors()).toHaveLength(0)
    client.close()
    const observer = linkOf<NativeResponse>(await Bun.connect({ unix: paths.socket, socket: socketHandlers() }) as never)
    try {
      const states: NativeResponse[] = []
      observer.onMessage(message => states.push(message))
      observer.send({ t: 'hello', role: 'observer', ...started.manager.identity })
      await until(() => states.some(message => message.t === 'native.welcome' && message.projection.works.length === 1 && message.projection.works[0]?.session === 'broken' && !message.projection.works[0]?.terminalOpen))
    } finally { observer.close() }
  } finally {
    stdin.emit('end'); await app?.waitUntilExit()
    client.close(); stdin.destroy(); stdout.destroy()
    started.manager.stop('测试结束'); await started.manager.waitUntilExit()
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
