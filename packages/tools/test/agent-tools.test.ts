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
