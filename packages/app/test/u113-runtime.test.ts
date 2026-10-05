import { expect, test } from 'bun:test'
import { collaborationRuntime, latch, spawnMember } from './run-collaboration-fixture.ts'

test('U113：真实成员在途切换保住旧请求，下一请求采用新档位；入口不受影响', async () => {
  const held = latch()
  const f = await collaborationRuntime('u113-inflight-member', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口独立完成' }
    if (call.model === 'member-model') { await held.promise; return { text: '旧成员请求正常结束' } }
    return { text: '新档位处理剩余输入' }
  })
  try {
    f.client.send({ type: 'input.submit', text: '明确执行检查，委派给 Spell 成员。' })
    await f.wait('成员请求已在途', () => f.requests('member-model').length === 1 && f.member() !== undefined)
    const member = f.member()!
    const old = JSON.stringify(f.requests('member-model')[0]!.body)
    f.client.send({ type: 'collaboration.configure', member: member.agentId, model: { alias: 'arcane' } })
    await f.wait('成员选择已保存', () => f.store.collaboration.getAgent(member.agentId)?.model.alias === 'arcane')
    expect(JSON.stringify(f.requests('member-model')[0]!.body)).toBe(old)
    expect(f.requests('descendant-model')).toHaveLength(0)
    held.release()
    await f.wait('旧请求正常结束', () => f.manager.runs().find(one => one.session === member.sessionId)?.state === 'idle')
    f.client.send({ type: 'collaboration.input', member: member.agentId, input: { text: '继续尚未完成范围，不重复已完成动作。' } })
    await f.wait('下一请求采用 Arcane', () => f.requests('descendant-model').length === 1)
    await f.wait('新请求结束', () => f.manager.runs().find(one => one.session === member.sessionId)?.state === 'idle')
    expect(f.requests('member-model')).toHaveLength(1)
    expect(f.store.collaboration.getAgent(f.collaboration()!.coordinatorId)?.model.alias).toBe('default')
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { held.release(); await f.close() }
}, 30000)
