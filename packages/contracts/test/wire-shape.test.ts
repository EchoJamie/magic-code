/**
 * 帧协议契约测试（边界方案 §四）——锁帧形状，防「正文回流」。
 */
import { expect, test } from 'bun:test'
import type { ExecutorToManager, ManagerToExecutor } from '../src/scheduling/run-wire.ts'

test('collaboration.input 帧已退化为信号：不再携带正文（正文只存账本）', () => {
  const signal: ManagerToExecutor = { t: 'collaboration.input', shared: true }
  expect('input' in signal).toBe(false)
})

test('heartbeat 帧存在；watermark/settled 可缺省（缺省＝没有这一件，不拿 0 冒充）', () => {
  const bare: ExecutorToManager = { t: 'heartbeat' }
  const full: ExecutorToManager = { t: 'heartbeat', watermark: 42, settled: 7 }
  expect('watermark' in bare).toBe(false)
  expect('settled' in bare).toBe(false)
  expect('watermark' in full).toBe(true)
  expect('settled' in full).toBe(true)
})

test('输入动作表：retry/consume 已入契约；continue 保留为旧名', () => {
  // 类型层动作集合由 InputManage 联合承载——这里锁运行时可序列化的形状。
  const retry: import('../src/conversation/input.ts').InputManage = { type: 'input.manage', action: 'retry', ref: 'r', revision: 1 }
  const consume: import('../src/conversation/input.ts').InputManage = { type: 'input.manage', action: 'consume', ref: 'r', revision: 1 }
  expect(retry.action).toBe('retry')
  expect(consume.action).toBe('consume')
})

test('协作账本写操作：dequeue 已入契约（pending→executing 唯一触发路径，只由执行者请求）', () => {
  const request: import('../src/conversation/collaboration-control.ts').CollaborationRequest = {
    action: 'dequeue', operationId: 'op-1', refs: ['r-1', 'r-2'], at: 1,
  }
  expect(request.action).toBe('dequeue')
  expect(request.refs).toEqual(['r-1', 'r-2'])
})

test('input.rejected 帧：执行者拒收显式回执带 (session,ref,reason)', () => {
  const rejected: ExecutorToManager = { t: 'input.rejected', session: 's-1', ref: 'r-1', reason: '会话已归档' }
  expect(rejected.t).toBe('input.rejected')
  expect(rejected.ref).toBe('r-1')
})
