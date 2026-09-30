import { describe, expect, test } from 'bun:test'
import { createRecordsStore } from '../src/index.ts'
import { fixture } from './collaboration-fixture.ts'

function waitingFixture() {
  const f = fixture()
  const child = f.spawn('child')
  const outcome = f.records.registerWait(f.coordinator.agentId, {
    operationId: 'waiting', forAgents: [child.agent.agentId], forMessageId: child.delegation.delegationId,
    expectation: '成员回报', deadline: 20, at: 10,
  })
  if (!outcome.ok) throw new Error('unexpected wait cycle')
  return { ...f, child, wait: outcome.wait }
}

describe('协作等待 · 领取与实际请求带入分开', () => {
  for (const state of ['expired', 'resolved', 'interrupted'] as const) {
    test(`${state} 领取不冒称带入；确认跨连接持久且重试保留首次时间`, () => {
      const f = waitingFixture()
      try {
        if (state === 'expired') f.records.expireWaits(20)
        else f.records.respondToDelegation(f.child.agent.agentId, {
          operationId: 'response', delegationId: f.child.delegation.delegationId,
          response: state === 'resolved' ? 'clarify' : 'reject', reason: '需要入口处理', at: 20,
        })
        const claimed = f.records.consumeWaitOutcomes(f.coordinator.agentId, 21)
        expect(claimed).toHaveLength(1)
        expect(claimed[0]).toMatchObject({ waitId: f.wait.waitId, state, handledAt: 21 })
        expect(claimed[0]?.includedAt).toBeUndefined()
        const inbox = f.records.inbox(f.coordinator.agentId)
        const reopened = createRecordsStore({ dataDir: f.dir, workspace: [] })
        try {
          // 模拟领取后本地请求失败；重开不重复领取，仍可查出尚未实际带入的终态。
          expect(reopened.collaboration.consumeWaitOutcomes(f.coordinator.agentId, 22)).toEqual([])
          expect(reopened.collaboration.listWaits(f.collaboration.collaborationId)).toEqual(claimed)
          reopened.collaboration.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId, f.wait.waitId], 23)
          reopened.collaboration.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId], 24)
        } finally { reopened.close() }
        expect(f.records.listWaits(f.collaboration.collaborationId)).toEqual([{ ...claimed[0]!, includedAt: 23 }])
        expect(f.records.consumeWaitOutcomes(f.coordinator.agentId, 25)).toEqual([])
        expect(f.records.inbox(f.coordinator.agentId)).toEqual(inbox)
      } finally { f.close() }
    })
  }

  test('仍在等待、终态未领取、他人领取或不存在的等待均不能确认', () => {
    const f = waitingFixture()
    try {
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId], 11)).toThrow('terminal and consumed')
      f.records.expireWaits(20)
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId], 21)).toThrow('terminal and consumed')
      const claimed = f.records.consumeWaitOutcomes(f.coordinator.agentId, 22)
      expect(() => f.records.markWaitOutcomesIncluded(f.child.agent.agentId, [f.wait.waitId], 23)).toThrow('not owned')
      expect(() => f.records.markWaitOutcomesIncluded('unknown-agent', [f.wait.waitId], 23)).toThrow('not owned')
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [Number.MAX_SAFE_INTEGER], 23)).toThrow('wait not found')
      expect(f.records.listWaits(f.collaboration.collaborationId)).toEqual(claimed)
      f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId], 24)
      // 已确认也不能通过他人身份当作幂等成功。
      expect(() => f.records.markWaitOutcomesIncluded(f.child.agent.agentId, [f.wait.waitId], 25)).toThrow('not owned')
    } finally { f.close() }
  })

  test('混合批次非法项使前项回滚；空数组无事，合法批次不重复领取', () => {
    const f = waitingFixture()
    try {
      f.records.expireWaits(20)
      f.records.consumeWaitOutcomes(f.coordinator.agentId, 21)
      const other = f.records.registerWait(f.coordinator.agentId, { operationId: 'other',
        forAgents: [f.child.agent.agentId], expectation: '另一份回报', deadline: 50, at: 22 })
      if (!other.ok) throw new Error('unexpected wait cycle')
      const ids = [f.wait.waitId, other.wait.waitId]
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, ids, 23)).toThrow('terminal and consumed')
      expect(f.records.listWaits(f.collaboration.collaborationId).every(w => w.includedAt === undefined)).toBe(true)
      f.records.expireWaits(50)
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, ids, 51)).toThrow('terminal and consumed')
      expect(f.records.listWaits(f.collaboration.collaborationId).every(w => w.includedAt === undefined)).toBe(true)
      f.records.consumeWaitOutcomes(f.coordinator.agentId, 52)
      expect(() => f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [...ids, Number.MAX_SAFE_INTEGER], 53)).toThrow('wait not found')
      const before = f.records.listWaits(f.collaboration.collaborationId)
      expect(before.every(w => w.includedAt === undefined)).toBe(true)
      expect(() => f.records.markWaitOutcomesIncluded('unknown-agent', [], 54)).not.toThrow()
      expect(f.records.listWaits(f.collaboration.collaborationId)).toEqual(before)
      f.records.markWaitOutcomesIncluded(f.coordinator.agentId, ids, 55)
      expect(f.records.listWaits(f.collaboration.collaborationId)).toEqual(before.map(w => ({ ...w, includedAt: 55 })))
      expect(f.records.consumeWaitOutcomes(f.coordinator.agentId, 56)).toEqual([])
    } finally { f.close() }
  })

  test('停止后确认已经领取的回报只补事实，不恢复准入', () => {
    const f = waitingFixture()
    try {
      f.records.expireWaits(20)
      f.records.consumeWaitOutcomes(f.coordinator.agentId, 21)
      f.records.stop({ kind: 'host' }, 'stop', 22)
      f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [f.wait.waitId], 23)
      expect(f.records.listWaits(f.collaboration.collaborationId)[0]).toMatchObject({ state: 'expired', handledAt: 21, includedAt: 23 })
      expect(f.records.checkAdmission(f.coordinator.agentId, undefined, 'coordination').allowed).toBe(false)
      expect(f.records.getCollaboration(f.collaboration.collaborationId)?.state).toBe('stopped')
    } finally { f.close() }
  })
})
