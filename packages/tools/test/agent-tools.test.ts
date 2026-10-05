import { expect, test } from 'bun:test'
import { makeFauxSandbox } from '@magic/faux'
import { defineAgentTools } from '../src/agent-tools.ts'

test('等待仅在真正登记为waiting时让出；已有结果与循环拒绝回给模型继续处理', async () => {
  for (const value of [{ ok: true, wait: { state: 'waiting' } }, { ok: true, wait: { state: 'resolved' } }, { ok: false, cycle: ['a', 'b', 'a'] }]) {
    const tool = defineAgentTools({ request: async () => ({ ok: true, value }) }).find(one => one.spec.name === 'agent_wait')!
    const result = await tool.run({ operationId: 'wait', agents: ['member'], expectation: '实际结果', deadline: 1000 },
      { sandbox: makeFauxSandbox(), signal: undefined, onOutput: undefined })
    expect(result.ok).toBe(true)
    expect(result.halt).toBe(value.ok && 'wait' in value && value.wait?.state === 'waiting' ? true : undefined)
  }
})

test('consult_arcane 只收问题、材料和独立思考，不接受身份/档位/授权扩张', async () => {
  const calls: unknown[] = []
  const tool = defineAgentTools({ request: async input => { calls.push(input); return { ok: true, value: { consultationId: 1, advisorAgentId: 'a', state: 'started' } } } }).find(one => one.spec.name === 'consult_arcane')!
  const context = { sandbox: makeFauxSandbox(), signal: undefined, onOutput: undefined }
  for (const extra of [{ role: 'all' }, { alias: 'default' }, { sender: 'other' }, { workspace: ['/'] }, { permissions: 'all' }, { reasoning: { mode: 'default', role: 'all' } }, { body: [{ kind: 'entry', ref: { sessionId: 'origin', entryId: 1, permission: 'all' } }] }]) {
    expect((await tool.run({ operationId: 'one', question: '核对具体证据', ...extra }, context)).ok).toBe(false)
  }
  expect(calls).toHaveLength(0)
  const result = await tool.run({ operationId: 'one', question: '核对具体证据', reasoning: { mode: 'default' } }, context)
  expect(result.ok).toBe(true)
  expect(result.halt).toBeUndefined()
  expect(result.output).toContain('不表示顾问已完成')
  expect(calls).toEqual([{ action: 'consult', operationId: 'one', question: '核对具体证据', reasoning: { mode: 'default' } }])
})
