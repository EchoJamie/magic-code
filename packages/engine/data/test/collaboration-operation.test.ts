import { describe, expect, test } from 'bun:test'
import type { CollaborationRecords } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { body, fixture } from './collaboration-fixture.ts'

describe('协作记录 · 拒绝是需要处理的决定', () => {
  test('reject 保留 decision 收件且重试不重复', () => {
    const f = fixture()
    try {
      const child = f.spawn('child')
      const input = { operationId: 'reject', delegationId: child.delegation.delegationId,
        response: 'reject' as const, reason: '无法履行这份委派', at: 11 }
      const result = f.records.respondToDelegation(child.agent.agentId, input)
      expect(result.delegation.state).toBe('rejected')
      const receipts = f.records.inbox(f.coordinator.agentId)
      expect(receipts).toHaveLength(1)
      const message = f.records.readMessage(f.coordinator.agentId, receipts[0]!.messageId)!
      expect(message).toMatchObject({ purpose: 'decision', senderId: child.agent.agentId,
        replyTo: child.delegation.delegationId, delegationId: child.delegation.delegationId,
        body: body(input.reason) })
      expect(message.userSource).toBeUndefined()
      expect(f.records.respondToDelegation(child.agent.agentId, { ...input, at: 12 })).toEqual(result)
      expect(f.records.inbox(f.coordinator.agentId)).toEqual(receipts)
    } finally { f.close() }
  })

  test('accept 仍是普通 receipt', () => {
    const f = fixture()
    try {
      const child = f.spawn('child')
      f.accept(child.delegation.delegationId)
      const inbox = f.records.inbox(f.coordinator.agentId)
      expect(inbox).toHaveLength(1)
      expect(f.records.readMessage(f.coordinator.agentId, inbox[0]!.messageId)?.purpose).toBe('receipt')
    } finally { f.close() }
  })
})

const methods = ['send', 'delegate', 'deliver', 'publishConstraint'] as const
type Method = typeof methods[number]

describe('协作记录 · 同一 operationId 不得跨动作返回旧消息', () => {
  for (const first of methods) for (const second of methods) {
    if (first === second) continue
    test(`${first} 后 ${second} 拒绝冲突；原动作跨连接重试保持原结果`, () => {
      const f = fixture()
      try {
        const child = f.spawn('child')
        // 协调者也可接受独立委派；让四个操作对同一 actor 都具有合法输入。
        const own = f.records.delegate(f.coordinator.agentId, { operationId: 'own-assignment',
          assigneeId: f.coordinator.agentId, scope: '入口独立工作', body: body('入口独立工作'),
          source: f.origin, authorization: [f.origin], at: 10 })
        f.accept(own.delegationId)
        const invoke = (records: CollaborationRecords, method: Method, at: number) => {
          const common = { operationId: 'shared-key', body: body('只受理一次'), at }
          switch (method) {
            case 'send': return records.send(f.coordinator.agentId, { ...common,
              recipients: [child.agent.agentId], purpose: 'inform' })
            case 'delegate': return records.delegate(f.coordinator.agentId, { ...common,
              assigneeId: child.agent.agentId, scope: '新委派', source: f.origin, authorization: [f.origin] })
            case 'deliver': return records.deliver(f.coordinator.agentId, { ...common, delegationId: own.delegationId })
            case 'publishConstraint': return records.publishConstraint(f.coordinator.agentId, { ...common, source: f.origin })
          }
        }
        const snapshot = () => ({
          messages: f.records.listMessages(f.coordinator.agentId),
          delegations: f.records.listDelegations(f.collaboration.collaborationId),
          constraints: f.records.listConstraints(f.collaboration.collaborationId),
          inbox: f.records.listMembers(f.collaboration.collaborationId).map(a => f.records.inbox(a.agentId)),
          operation: f.records.operation('shared-key'),
        })
        const original = invoke(f.records, first, 20)
        const before = snapshot()
        expect(() => invoke(f.records, second, 21)).toThrow('operation identity conflict')
        expect(snapshot()).toEqual(before)
        const reopened = createRecordsStore({ dataDir: f.dir, workspace: [] })
        try {
          expect(() => invoke(reopened.collaboration, second, 22)).toThrow('operation identity conflict')
          expect(invoke(reopened.collaboration, first, 23)).toEqual(original)
        } finally { reopened.close() }
        expect(snapshot()).toEqual(before)
      } finally { f.close() }
    })
  }
})
