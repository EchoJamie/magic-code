import { describe, expect, test } from 'bun:test'
import type { CollaborationRecords, InboxItem } from '@magic/contracts'
import { fixture, body, model } from './collaboration-fixture.ts'

type Call = { method: keyof CollaborationRecords; args: unknown[] }
type Outcome = { ok: true; value: any } | { ok: false; error: string }

test('同成员发送与交付并发争用同一 operationId：仅一个动作受理，另一个明确冲突', async () => {
  const f = fixture()
  try {
    const child = f.spawn('operation-race'); f.accept(child.delegation.delegationId)
    const before = f.records.listMessages(f.coordinator.agentId).length
    const send = { operationId: 'cross-action-race', recipients: [f.coordinator.agentId],
      purpose: 'inform' as const, body: body('仍在工作'), at: 20 }
    const deliver = { operationId: 'cross-action-race', delegationId: child.delegation.delegationId,
      body: body('完成交付'), at: 20 }
    const results = await race(f.records, [
      { method: 'send', args: [child.agent.agentId, send] },
      { method: 'deliver', args: [child.agent.agentId, deliver] },
    ])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toEqual([{ ok: false, error: 'operation identity conflict' }])
    const sent = results[0]!
    const delivered = results[1]!
    if (sent.ok) {
      expect(f.records.send(child.agent.agentId, send)).toEqual(sent.value)
      expect(() => f.records.deliver(child.agent.agentId, deliver)).toThrow('operation identity conflict')
      expect(f.records.getDelegation(child.delegation.delegationId)?.state).toBe('accepted')
    } else if (delivered.ok) {
      expect(f.records.deliver(child.agent.agentId, deliver)).toEqual(delivered.value)
      expect(() => f.records.send(child.agent.agentId, send)).toThrow('operation identity conflict')
      expect(f.records.getDelegation(child.delegation.delegationId)?.state).toBe('delivered')
    }
    expect(f.records.listMessages(f.coordinator.agentId)).toHaveLength(before + 1)
  } finally { f.close() }
}, 30000)

async function race(records: CollaborationRecords, calls: Call[]): Promise<Outcome[]> {
  return Promise.all(calls.map(async call => {
    await new Promise<void>(resolve => setImmediate(resolve))
    try {
      const method = records[call.method] as (...args: unknown[]) => unknown
      return { ok: true as const, value: method(...call.args) }
    } catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : String(error) } }
  }))
}

describe('协作记录 · 共享连接上的并发请求', () => {
  test('两个接受并发只能有一个已接受委派；其余仍排队', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a')
      const second = f.records.delegate(f.coordinator.agentId, { operationId: 'second', assigneeId: a.agent.agentId, body: body('second'), scope: 'second', source: f.origin, authorization: [f.origin], at: 8 })
      const result = await race(f.records, [a.delegation, second].map((d, i) => ({ method: 'respondToDelegation', args: [a.agent.agentId, { operationId: `accept-${i}`, delegationId: d.delegationId, response: 'accept', at: 10 }] })))
      expect(result.every(r => r.ok)).toBe(true)
      expect(result.filter(r => r.ok && r.value.accepted)).toHaveLength(1)
      expect(f.records.listDelegations(f.collaboration.collaborationId).map(d => d.state).sort()).toEqual(['accepted', 'queued'])
    } finally { f.close() }
  }, 30000)

  test('并发派生与发送重传返回原受理事实，不生多成员、多消息或多收件', async () => {
    const f = fixture()
    try {
      const input = { operationId: 'same-spawn', sessionId: 'new-session', name: 'worker', role: '', model, body: body('work'), scope: 'work', source: f.origin, authorization: [f.origin], at: 10 }
      const result = await race(f.records, Array.from({ length: 4 }, () => ({ method: 'spawn', args: [f.coordinator.agentId, input] })))
      expect(result.every(r => r.ok)).toBe(true)
      const ids = result.map(r => r.ok ? r.value.agent.agentId as string : '')
      expect(new Set(ids).size).toBe(1)
      expect(f.records.listMembers(f.collaboration.collaborationId)).toHaveLength(2)
      const send = { operationId: 'same-send', recipients: [ids[0]], purpose: 'question', body: body('one body'), at: 11 }
      const sent = await race(f.records, Array.from({ length: 4 }, () => ({ method: 'send', args: [f.coordinator.agentId, send] })))
      expect(sent.every(r => r.ok)).toBe(true)
      expect(new Set(sent.map(r => r.ok ? r.value.messageId : 0)).size).toBe(1)
      expect(f.records.inbox(ids[0]!)).toHaveLength(2)
    } finally { f.close() }
  }, 30000)

  test('整体停止与派生/执行共事务，停止后无漏网成员或执行', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      const result = await race(f.records, [
        { method: 'spawn', args: [f.coordinator.agentId, { operationId: 'spawn-race', sessionId: 'racing', name: '', role: '', model, body: body('x'), scope: 'x', source: f.origin, authorization: [f.origin], at: 20 }] },
        { method: 'beginExecution', args: [a.agent.agentId, { operationId: 'exec-race', delegationId: a.delegation.delegationId, runId: 'a', kind: 'tool', at: 20 }] },
        { method: 'stop', args: [{ kind: 'collaboration', collaborationId: f.collaboration.collaborationId }, 'stop', 20] },
      ])
      expect(result[2]?.ok).toBe(true)
      expect(f.records.getCollaboration(f.collaboration.collaborationId)?.state).toBe('stopped')
      expect(f.records.listMembers(f.collaboration.collaborationId).every(a => a.reachability === 'suspended')).toBe(true)
      expect(f.records.listDelegations(f.collaboration.collaborationId).every(d => d.state === 'cancelled')).toBe(true)
      expect(f.records.listExecutions(f.collaboration.collaborationId).every(e => e.state === 'cancel-requested')).toBe(true)
      expect(() => f.records.beginExecution(a.agent.agentId, { operationId: 'after-stop', delegationId: a.delegation.delegationId, runId: 'a', kind: 'tool', at: 21 })).toThrow('closed')
    } finally { f.close() }
  }, 30000)

  test('同项消费与撤回只有一方成功；两个消费者不重复追加条目', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.records.consumeInbox(a.agent.agentId, 10)
      const sent = f.records.send(f.coordinator.agentId, { operationId: 'withdraw-race', recipients: [a.agent.agentId], purpose: 'inform', body: body('pending'), at: 11 })
      const result = await race(f.records, [
        { method: 'consumeInbox', args: [a.agent.agentId, 12] },
        { method: 'withdrawMessage', args: [f.coordinator.agentId, sent.messageId] },
      ])
      expect(result.every(r => r.ok)).toBe(true)
      const consumed = result[0]!.ok ? result[0]!.value.length : -1
      const withdrawn = result[1]!.ok && result[1]!.value
      expect(consumed + Number(withdrawn)).toBe(1)
      const next = f.records.send(f.coordinator.agentId, { operationId: 'consume-race', recipients: [a.agent.agentId], purpose: 'inform', body: body('consume once'), at: 13 })
      const both = await race(f.records, [0, 1].map(() => ({ method: 'consumeInbox', args: [a.agent.agentId, 14] })))
      expect(both.every(r => r.ok)).toBe(true)
      expect(both.flatMap(r => r.ok ? r.value as InboxItem[] : []).filter(i => i.messageId === next.messageId)).toHaveLength(1)
      const entries = await Array.fromAsync(f.store.readEntries('a'))
      expect(entries.filter(e => e.payload && 'messageId' in e.payload && e.payload.messageId === next.messageId)).toHaveLength(1)
    } finally { f.close() }
  }, 30000)

  test('编辑与消费按同一收件事实裁决；开始消费后正文不变', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.records.consumeInbox(a.agent.agentId, 10)
      const sent = f.records.send(f.coordinator.agentId, { operationId: 'edit-race', recipients: [a.agent.agentId], purpose: 'inform', body: body('original'), at: 11 })
      const result = await race(f.records, [
        { method: 'consumeInbox', args: [a.agent.agentId, 12] },
        { method: 'editMessage', args: [f.coordinator.agentId, sent.messageId, body('edited')] },
      ])
      expect(result.every(r => r.ok)).toBe(true)
      const edited = result[1]!.ok && result[1]!.value
      expect(f.records.readMessage(a.agent.agentId, sent.messageId)?.body).toEqual(body(edited ? 'edited' : 'original'))
      expect(f.records.editMessage(f.coordinator.agentId, sent.messageId, body('after-consume'))).toBe(false)
    } finally { f.close() }
  }, 30000)

  test('并发截止只产生一次超时事实，并发唤起只允许一个运行实例', async () => {
    const f = fixture()
    try {
      const a = f.spawn('a'); f.accept(a.delegation.delegationId)
      f.records.registerWait(a.agent.agentId, { operationId: 'wait', forAgents: [f.coordinator.agentId], delegationId: a.delegation.delegationId, expectation: 'result', deadline: 50, at: 15 })
      const result = await race(f.records, [0, 1].map(() => ({ method: 'expireWaits', args: [50] })))
      expect(result.flatMap(r => r.ok ? r.value : [])).toHaveLength(1)
      const started = await race(f.records, [0, 1].map(i => ({ method: 'beginExecution', args: [a.agent.agentId, { operationId: `wake-${i}`, delegationId: a.delegation.delegationId, runId: `run-${i}`, kind: 'wake', at: 51 }] })))
      expect(started.filter(r => r.ok)).toHaveLength(1)
      expect(started.some(r => !r.ok && r.error.includes('executor'))).toBe(true)
    } finally { f.close() }
  }, 30000)
})

test('等待终态多调用原子领取，断通知后可补领且仅回报一次', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); f.accept(a.delegation.delegationId)
    f.records.registerWait(a.agent.agentId, { operationId: 'wait-outcome', forAgents: [f.coordinator.agentId], delegationId: a.delegation.delegationId, expectation: 'answer', deadline: 20, at: 15 })
    f.records.expireWaits(20)
    const results = await race(f.records, [0, 1].map(() => ({ method: 'consumeWaitOutcomes', args: [a.agent.agentId, 21] })))
    expect(results.every(r => r.ok)).toBe(true)
    expect(results.flatMap(r => r.ok ? r.value : [])).toHaveLength(1)
    expect(f.records.consumeWaitOutcomes(a.agent.agentId, 22)).toEqual([])
  } finally { f.close() }
}, 30000)

test('已领取等待终态的请求带入确认多调用幂等，保留首次时间且不重复领取', async () => {
  const f = fixture()
  try {
    const child = f.spawn('wait-inclusion')
    const registered = f.records.registerWait(f.coordinator.agentId, { operationId: 'wait-inclusion',
      forAgents: [child.agent.agentId], expectation: '结果', deadline: 20, at: 15 })
    if (!registered.ok) throw new Error('unexpected wait cycle')
    f.records.expireWaits(20)
    const claimed = f.records.consumeWaitOutcomes(f.coordinator.agentId, 21)[0]!
    const results = await race(f.records, [22, 23].map(at => ({ method: 'markWaitOutcomesIncluded',
      args: [f.coordinator.agentId, [registered.wait.waitId], at] })))
    expect(results.every(result => result.ok)).toBe(true)
    const confirmed = f.records.listWaits(f.collaboration.collaborationId)[0]!
    expect(confirmed.includedAt === 22 || confirmed.includedAt === 23).toBe(true)
    expect(confirmed).toEqual({ ...claimed, includedAt: confirmed.includedAt })
    f.records.markWaitOutcomesIncluded(f.coordinator.agentId, [registered.wait.waitId], 24)
    expect(f.records.listWaits(f.collaboration.collaborationId)[0]).toEqual(confirmed)
    expect(f.records.consumeWaitOutcomes(f.coordinator.agentId, 25)).toEqual([])
  } finally { f.close() }
}, 30000)

test('相反等待并发登记仍由同一事务拒绝形成循环的那一条', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); const b = f.spawn('b'); f.accept(a.delegation.delegationId); f.accept(b.delegation.delegationId)
    const result = await race(f.records, [[a, b], [b, a]].map(([from, to], index) => ({ method: 'registerWait', args: [from!.agent.agentId, { operationId: `cycle-${index}`, forAgents: [to!.agent.agentId], delegationId: from!.delegation.delegationId, expectation: 'result', deadline: 50, at: 15 }] })))
    expect(result.every(r => r.ok)).toBe(true)
    expect(result.filter(r => r.ok && r.value.ok)).toHaveLength(1)
    expect(result.filter(r => r.ok && !r.value.ok && r.value.cycle.length === 3)).toHaveLength(1)
    expect(f.records.listWaits(f.collaboration.collaborationId)).toHaveLength(1)
  } finally { f.close() }
}, 30000)

test('接受与撤回并发后责任只能是已取消，不能从迟到接受重开', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a')
    const result = await race(f.records, [
      { method: 'respondToDelegation', args: [a.agent.agentId, { operationId: 'race-accept', delegationId: a.delegation.delegationId, response: 'accept', at: 15 }] },
      { method: 'stop', args: [{ kind: 'delegation', delegationId: a.delegation.delegationId }, 'cancel', 15] },
    ])
    expect(result[1]?.ok).toBe(true)
    expect(f.records.getDelegation(a.delegation.delegationId)?.state).toBe('cancelled')
    expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(false)
    expect(() => f.records.respondToDelegation(a.agent.agentId, { operationId: 'late-accept', delegationId: a.delegation.delegationId, response: 'accept', at: 16 })).toThrow('not awaiting')
  } finally { f.close() }
}, 30000)

test('已接受 A 的执行准入与排队 B 的停止并发，A 始终获准且不出现在取消目标', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a'); f.accept(a.delegation.delegationId)
    const queued = f.records.delegate(f.coordinator.agentId, { operationId: 'race-queued-b', assigneeId: a.agent.agentId, body: body('B'), scope: 'B', source: f.origin, authorization: [f.origin], at: 11 })
    const result = await race(f.records, [
      { method: 'beginExecution', args: [a.agent.agentId, { operationId: 'race-active-a', delegationId: a.delegation.delegationId, runId: 'active-a', kind: 'tool', at: 12 }] },
      { method: 'stop', args: [{ kind: 'delegation', delegationId: queued.delegationId }, 'stop queued B', 12] },
    ])
    expect(result.every(r => r.ok)).toBe(true)
    expect(result[1]?.ok && result[1].value.agents).toEqual([])
    expect(result[1]?.ok && result[1].value.executions).toEqual([])
    expect(f.records.getDelegation(a.delegation.delegationId)?.state).toBe('accepted')
    expect(f.records.listExecutions(f.collaboration.collaborationId)[0]?.state).toBe('running')
    expect(f.records.checkAdmission(a.agent.agentId, a.delegation.delegationId).allowed).toBe(true)
  } finally { f.close() }
}, 30000)

test('接受 A 与停止 queued B/无绑定判断并发：A 先接受则不停 A，停止先成立则阻止接受', async () => {
  const f = fixture()
  try {
    const a = f.spawn('a')
    const queued = f.records.delegate(f.coordinator.agentId, { operationId: 'competing-b', assigneeId: a.agent.agentId, body: body('B'), scope: 'B', source: f.origin, authorization: [f.origin], at: 11 })
    f.records.beginExecution(a.agent.agentId, { operationId: 'deciding', runId: 'deciding', kind: 'model', mode: 'coordination', at: 12 })
    const result = await race(f.records, [
      { method: 'respondToDelegation', args: [a.agent.agentId, { operationId: 'competing-accept-a', delegationId: a.delegation.delegationId, response: 'accept', at: 13 }] },
      { method: 'stop', args: [{ kind: 'delegation', delegationId: queued.delegationId }, 'stop queued B', 13] },
    ])
    expect(result[1]?.ok).toBe(true)
    expect(f.records.getDelegation(queued.delegationId)?.state).toBe('cancelled')
    if (f.records.getDelegation(a.delegation.delegationId)?.state === 'accepted') {
      expect(result[1]?.ok && result[1].value.agents).toEqual([])
      expect(f.records.listExecutions(f.collaboration.collaborationId)[0]?.state).toBe('running')
    } else {
      expect(result[0]?.ok).toBe(false)
      expect(result[1]?.ok && result[1].value.agents).toEqual([a.agent.agentId])
      expect(f.records.listExecutions(f.collaboration.collaborationId)[0]?.state).toBe('cancel-requested')
    }
  } finally { f.close() }
}, 30000)
