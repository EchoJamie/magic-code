import { expect, test } from 'bun:test'
import { collaborationRuntime, requestText, spawnMember } from './run-collaboration-fixture.ts'

test('读取旧协作与clear并发：迟到快照不能把新工作接回旧协作', async () => {
  const f = await collaborationRuntime('clear-query-race', call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '本轮交代已处理' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept',
      delegation: f.delegation()!.delegationId, response: 'accept' } }
    return { text: '成员独立推进' }
  })
  try {
    f.client.send({ type: 'input.submit', text: 'OLD_WORK_ORIGIN：展开这份工作', ref: 'old-input' })
    await f.wait('原工作双方空闲且协作已出现', () => f.collaboration() !== undefined && f.requests().length === 2
      && f.manager.runs().filter(run => [f.session(), f.member()?.sessionId].includes(run.session)).every(run => run.state === 'idle'))
    const oldSession = f.session()!
    const work = f.collaboration()!
    const member = f.member()!
    const targets: (string | null)[] = []
    const staleViews: string[] = []
    f.client.onTarget(session => targets.push(session))
    // 订阅会立即回放当前 target；之后的 target(null) 表示已清空当前目标。
    targets.length = 0
    const switched = () => targets.some(session => session !== oldSession)
    f.client.onEvent(event => {
      if (switched() && event.kind === 'collaboration.view' && event.data.originSession === oldSession) staleViews.push(event.data.originSession)
    })
    // 两条命令连续发出：第一条只读尚在装配结果，第二条已经切换目标。
    f.client.send({ type: 'collaboration.read', member: member.agentId })
    f.client.send({ type: 'session.new' })
    await f.wait('已清空当前工作', () => targets.at(-1) === null && f.shell.getView().sessionId === null)
    expect(switched()).toBe(true)
    expect(staleViews).toEqual([])
    expect(f.shell.getView().collaboration).toBeUndefined()

    f.client.send({ type: 'input.submit', text: 'NEW_WORK_ONLY：独立的新交代', ref: 'new-input' })
    await f.wait('新交代进入独立请求并确认新会话', () => f.requests().length === 3 && f.session() !== null && f.session() !== oldSession)
    expect(requestText(f.requests()[2])).toContain('NEW_WORK_ONLY')
    expect(requestText(f.requests()[2])).not.toContain('OLD_WORK_ORIGIN')
    expect(f.store.collaboration.collaborationForSession(f.session()!)).toBeUndefined()
    expect(f.store.collaboration.listConstraints(work.collaborationId)).toEqual([])
    expect(f.store.collaboration.listMembers(work.collaborationId)).toHaveLength(2)
  } finally { await f.close() }
}, 30000)
