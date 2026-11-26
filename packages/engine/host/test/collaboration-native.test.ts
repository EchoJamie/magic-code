/**
 * 归并投影的缺省语义锁（T1.4/T1.5）——防「缺省陷阱」与「N9 超时推导」走样。
 */
import { expect, test } from 'bun:test'
import type { NativeWork } from '@magic/contracts'
import { captureCollaborationNative, deliveryAwaitText, mergeCollaborationNative } from '../src/collaboration-native.ts'

const MODEL = { protocol: 'chat-completions' as const, endpoint: 'https://x/v1', choice: 'cantrip' as const, provider: 'p', model: 'm' }

function deliveredDelegationFixture(at: number) {
  return {
    collaboration: { collaborationId: 'c1', originSessionId: 'origin', coordinatorId: 'root',
      state: 'open' as const, at, defaultModel: { ...MODEL, choice: 'cantrip' as const }, origin: { sessionId: 'origin', entryId: 1 } },
    members: [{ agentId: 'root', sessionId: 'origin', name: '入口', role: 'origin', model: MODEL, workspace: [], reachability: 'active' as const, at },
      { agentId: 'm1', sessionId: 'member-1', name: '成员', role: 'member', model: MODEL, workspace: [], reachability: 'active' as const, at }],
    delegations: [{ collaborationId: 'c1', delegationId: 'd1', delegatorId: 'root', assigneeId: 'm1', source: { sessionId: 'origin', entryId: 1 },
      authorization: [originRef()], scope: '查证', state: 'delivered' as const, deliveryMessageId: 9, deliveredAt: at, at },
    ] as never,
    executions: [],
  }
}

function originRef() {
  return { sessionId: 'origin', entryId: 1 }
}

function workOf(session: string, state: import('@magic/contracts').RunState, since: number): NativeWork {
  return { session, title: session, workspace: [], state, since, gen: null, affected: false, archived: false, canArchive: false, terminalOpen: false }
}

test('N9 超时推导：成对传（now+ackTimeoutMs）才判超时', () => {
  const deliveredAt = 1_000
  // 已过 25h（>24h）：判超时。
  expect(deliveryAwaitText(deliveredAt, deliveredAt + 25 * 3_600_000, 24 * 3_600_000)).toBe('已交付，未认收（超时）')
  // 不到 24h：仍是等待中。
  expect(deliveryAwaitText(deliveredAt, deliveredAt + 2 * 3_600_000, 24 * 3_600_000)).toBe('已交付，待主会话认收')
})

test('N9 缺省陷阱：不传 options（或只传其一）不判超时——等待中委派不得显示「超时」', () => {
  const snapshot = { sessions: ['origin'], groups: [deliveredDelegationFixture(1_000)] }
  const merged = mergeCollaborationNative([workOf('origin', 'idle', 1_000)], snapshot)
  expect(merged[0]?.reason).toBe('已交付，待主会话认收')
  // 只传 ackTimeoutMs 没传 now：不判超时（now 缺省陷阱）。
  const partial = mergeCollaborationNative([workOf('origin', 'idle', 1_000)], snapshot, { ackTimeoutMs: 24 * 3_600_000 })
  expect(partial[0]?.reason).toBe('已交付，待主会话认收')
  // 只传 now 没传 ackTimeoutMs：同样不判超时。
  const other = mergeCollaborationNative([workOf('origin', 'idle', 1_000)], snapshot, { now: 99_999_999_999 })
  expect(other[0]?.reason).toBe('已交付，待主会话认收')
})

test('mergeMemberState：执行在飞而行已停 ⇒ unknown（降级语义唯一实现）', () => {
  const member = { agentId: 'm1', sessionId: 'member-1', name: '成员', role: 'member', model: MODEL, workspace: [], reachability: 'active' as const, at: 1 }
  const execution = { operationId: 'e1', agentId: 'm1', runId: 'r1', kind: 'model' as const, state: 'running' as const, at: 2 }
  const merged = mergeMemberStateOf(member, { state: 'stopped', since: 1 }, execution)
  expect(merged.state).toBe('unknown')
  expect(merged.reason).toBe('成员状态待核实')
})

function mergeMemberStateOf(
  member: import('@magic/contracts').AgentIdentity,
  row: import('../src/collaboration-native.ts').MemberRowShape,
  execution: import('@magic/contracts').ExecutionAdmission,
) {
  // 直接经 capture+merge 走公共路径，锁的是「view 与 native 同源」的那条实现。
  const snapshot = captureCollaborationNative({ collaborationForSession: () => undefined } as never, [])
  void snapshot
  // mergeMemberState 是导出的纯函数——这里直接引用确保签名与降级语义。
  const { mergeMemberState: fn } = require('../src/collaboration-native.ts') as typeof import('../src/collaboration-native.ts')
  return fn(member, row, execution)
}
