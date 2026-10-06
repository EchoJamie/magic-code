import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveMagicHome, type NativeResponse, type NativeWork } from '@magic/contracts'
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
  const dataDir = join(root, 'data')
  const store = createRecordsStore({ dataDir, workspace: [root] })
  for (const session of ['a', 'b']) {
    store.setSessionTitle(session, session, 1)
    store.attention.put({ id: `${session}:done:1`, session, kind: 'done', at: 1,
      fact: '1', unread: true, delivered: false })
  }
  const paths = runPathsOf(magic, dataDir, tmpdir())
  const options = { magic, dataDir, paths, launch: { spawn() { throw new Error('查看完成会话不能起执行者') } } }
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
  async function inspect(session: string): Promise<NativeWork> {
    const id = String(++request)
    observer.send({ t: 'native.inspect', request: id, session })
    await until(() => responses.some(message => message.t === 'native.inspected' && message.request === id))
    const result = responses.find(message => message.t === 'native.inspected' && message.request === id)
    if (result?.t !== 'native.inspected' || !result.work) throw new Error('读取失败')
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
    expect((await inspect('a')).terminalNoticeIds).toEqual(['a:done:1'])
    expect((await inspect('b')).terminalNoticeIds).toEqual([])
    expect(manager.executors()).toHaveLength(0)
    expect(store.attention.list().every(item => item.unread && !item.delivered)).toBe(true)

    const targets: (string | null)[] = []
    first.onTarget(session => targets.push(session))
    first.send({ type: 'session.open', session: 'b' })
    await until(() => targets.includes('b'))
    expect((await inspect('a')).terminalNoticeIds).toEqual(['a:done:1'])
    expect((await inspect('b')).terminalNoticeIds).toEqual(['b:done:1'])
    second.close()
    await until(() => second.closed)
    // inspect 往返也允许服务处理已关闭的传输。
    await inspect('a')
    expect((await inspect('a')).terminalNoticeIds).toEqual([])
    first.send({ type: 'session.new' })
    await until(() => targets.includes(null))
    expect((await inspect('b')).terminalNoticeIds).toEqual([])
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
    expect((await inspect('a')).terminalNoticeIds).toEqual([])
    expect((await inspect('a')).notices[0]?.unread).toBe(false)
    await connect('b')
    expect((await inspect('b')).terminalNoticeIds).toEqual(['b:done:1'])

    const records = store.collaboration
    const model = { alias: 'default' as const, provider: 'test', model: 'test' }
    const origin = { sessionId: 'a', entryId: store.serviceFor('a').appendEntry({ kind: 'user', content: { text: '原工作' }, at: 2 }) }
    const coordinator = records.registerAgent({ operationId: 'register', sessionId: 'a', name: '协调', role: '', model, at: 3 })
    records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 4 })
    for (const sessionId of ['c', 'd']) {
      records.spawn(coordinator.agentId, { operationId: `spawn:${sessionId}`, sessionId, name: sessionId, role: '', model,
        body: [{ kind: 'text', text: '独立责任' }], scope: sessionId, source: origin, authorization: [origin], at: 5 })
      store.setSessionTitle(sessionId, sessionId, 5)
      store.attention.put({ id: `${sessionId}:needs-you:2`, session: sessionId, kind: 'needs-you', at: 6,
        fact: '2', unread: true, delivered: false })
    }
    await connect('c')
    const memberView = await inspect('a')
    expect(memberView.notices.map(notice => notice.id)).toContain('d:needs-you:2')
    expect(memberView.terminalNoticeIds).toContain('c:needs-you:2')
    expect(memberView.terminalNoticeIds).not.toContain('d:needs-you:2')
    expect(memberView.terminalNoticeIds).not.toContain('a:done:1')
    await connect('a')
    expect((await inspect('a')).terminalNoticeIds).toContain('d:needs-you:2')
    expect(store.attention.list().find(item => item.id === 'd:needs-you:2')?.unread).toBe(true)
  } finally {
    clients.forEach(client => client.close()); observer.close()
    manager.stop('测试结束'); await manager.waitUntilExit()
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
