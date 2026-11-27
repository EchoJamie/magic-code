/** T1.6 · N5：第二读者只读语义（连接层）——写位唯一、只读明示、写者离开释放。 */
import { expect, test } from 'bun:test'
import type { ExecutorToManager, Link, Wire } from '@magic/host'
import type { ClientToManager } from '@magic/contracts'
import { newRunRecord, refresh } from '@magic/host'
import { createClientConnections, type ClientConn } from '../src/connections.ts'
import type { Executor } from '../src/executor-control.ts'

function fakeLink(): { readonly sent: Wire[]; readonly link: Link<ClientToManager> } {
  const sent: Wire[] = []
  return { sent, link: { send: message => { sent.push(message); return true }, onMessage() {}, onClose() {}, close() {}, get closed() { return false } } }
}

function fakeExecutor(gen: number, session: string): Executor {
  const run = newRunRecord({ gen, session, startedAt: 1, explicit: false })
  refresh(run, 1)
  return {
    ledger: { list: () => [] } as never,
    network: {} as never,
    gen, executionId: `${gen}-x`, run,
    spawned: { onExit: () => () => {} } as never,
    exited: false,
    link: { send: () => true, onMessage() {}, onClose() {}, close() {}, get closed() { return false } } as Link<ExecutorToManager>,
    diagnostic: () => {},
  }
}

function clientOf(connections: ReturnType<typeof createClientConnections>, source: string): ClientConn & { readonly sent: Wire[] } {
  const { link, sent } = fakeLink()
  const conn = connections.create({ link, cwd: '/w', switch: undefined, selectedSession: null, source })
  connections.accept(conn)
  return Object.assign(conn, { sent })
}

test('第二读者只读：明示占用方、标记只读；写者离开后写位释放', () => {
  const connections = createClientConnections(() => {})
  const executor = fakeExecutor(1, 's-1')
  const writer = clientOf(connections, 'tui-a')
  connections.bind(writer, executor)
  expect(executor.writerConn).toBe(writer.id)
  expect(writer.readonlyObserver).toBeUndefined()

  const reader = clientOf(connections, 'tui-b')
  connections.bind(reader, executor)
  // 第二读者：标记只读 + line 明示占用方（不静默变成旁观者，更不能双写）。
  expect(reader.readonlyObserver).toBe(true)
  expect(reader.sent.some(one => one.t === 'line' && JSON.stringify(one).includes('已在别处运行'))).toBe(true)
  expect(executor.writerConn).toBe(writer.id)

  // 写者断开：写位释放，只读者重新绑定时接管为写者。
  connections.dropClient(writer.id)
  expect(executor.writerConn).toBeUndefined()
  const returning = clientOf(connections, 'tui-c')
  connections.bind(returning, executor)
  expect(executor.writerConn).toBe(returning.id)
  expect(returning.readonlyObserver).toBeUndefined()
})

test('只读观察者断开：不解除同目标其它观察者的保护（P0 回归——写位仍在写者手里）', () => {
  const connections = createClientConnections(() => {})
  const executor = fakeExecutor(2, 's-2')
  const writer = clientOf(connections, 'tui-a')
  connections.bind(writer, executor)
  const readerA = clientOf(connections, 'tui-b')
  connections.bind(readerA, executor)
  const readerB = clientOf(connections, 'tui-c')
  connections.bind(readerB, executor)
  expect(executor.writerConn).toBe(writer.id)
  expect(readerA.readonlyObserver).toBe(true)
  expect(readerB.readonlyObserver).toBe(true)

  // **其中一个观察者走了**：写位没动，另一个观察者的保护原样留着——
  // 此前 releaseTarget 无条件清同目标全部连接的标记，剩下的「只读浏览」窗口
  // 能发出写命令，与仍在场的写者构成双写。
  connections.dropClient(readerA.id)
  expect(executor.writerConn).toBe(writer.id)
  expect(readerB.readonlyObserver).toBe(true)
})
