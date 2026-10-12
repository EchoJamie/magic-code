import { expect, test } from 'bun:test'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collaborationRuntime, requestText, spawnMember } from './run-collaboration-fixture.ts'

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test('Engine 无 TUI：只等待有限测试，完成自动进入原会话一次，常驻服务仍计数且不阻止结果通知', async () => {
  const f = await collaborationRuntime('u124-no-tui', call => {
    if (call.index === 0) return { tools: [
      { tool: 'exec', args: { cmd: 'sleep 60', background: true } },
      { tool: 'exec', args: { cmd: `while [ ! -f ${quote(join(f.workspace, 'finish'))} ]; do sleep 0.02; done; printf TEST_DONE`, background: true } },
    ] }
    if (call.index === 1) return { tool: 'background_wait', args: { ids: ['bg-2'] } }
    return { text: '测试结果已经处理，服务继续运行。' }
  }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '保留服务并等待测试' })
    await f.wait('后台等待', () => f.manager.runs().some(run => run.backgroundWaiting))
    expect(f.calls).toHaveLength(2)
    expect(f.manager.runs()[0]?.background).toBe(2)
    expect(f.store.attention.list()).toHaveLength(0)
    const session = f.session()!
    const before = f.shell.getView().background!
    expect(before.commands).toHaveLength(2)
    expect(before.commands.every(one => one.session === session && one.execution !== '')).toBe(true)
    const output = before.commands.find(one => one.id === 'bg-2')!.outputPath
    f.closeWindows()
    writeFileSync(join(f.workspace, 'finish'), '')
    await f.wait('原会话自动处理后结果通知', () => f.store.attention.list().some(one => one.kind === 'done'))
    expect(f.calls).toHaveLength(3)
    expect(requestText(f.calls[2])).toContain('后台命令跑完了')
    expect(readFileSync(output, 'utf8')).toBe('TEST_DONE')
    expect(f.manager.runs()[0]?.background).toBe(1)
    expect(f.manager.runs()[0]?.backgroundWaiting).toBeUndefined()
    const facts = f.store.serviceFor(session).inputs.list().filter(one => one.input.background !== undefined)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ state: 'included', input: { notice: true, background: { id: 'bg-2', exit: 0 } } })
    expect(facts[0]?.ref).toBe(`background:${before.commands[1]!.execution}:bg-2`)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 30000)

test('Engine 用户只停选定命令，过期或跨工作身份失败，停止事实解除等待而不冒充普通失败', async () => {
  const f = await collaborationRuntime('u124-stop', call => call.index === 0 ? { tools: [
    { tool: 'exec', args: { cmd: 'sleep 60', background: true } },
    { tool: 'exec', args: { cmd: 'sleep 60', background: true } },
  ] } : call.index === 1 ? { tool: 'background_wait', args: { ids: ['bg-2'] } } : { text: '已理解用户停止，继续其他工作。' }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '两个命令，仅等第二个' })
    await f.wait('后台等待', () => f.shell.getView().background?.waiting.length === 1)
    const command = f.shell.getView().background!.commands.find(one => one.id === 'bg-2')!
    const target = { execution: command.execution, session: command.session, id: command.id }
    f.client.send({ type: 'background.stop', target: { ...target, execution: 'stale' } })
    await f.wait('拒绝过期代次', () => f.events.some(one => one.kind === 'background.state' && one.data.result?.target.execution === 'stale' && !one.data.result.outcome.ok))
    expect(f.shell.getView().background?.commands).toHaveLength(2)
    f.client.send({ type: 'background.stop', target: { ...target, session: 'independent-work' } })
    await f.wait('拒绝其他工作', () => f.events.some(one => one.kind === 'background.state' && one.data.result?.target.session === 'independent-work' && !one.data.result.outcome.ok))
    expect(f.calls).toHaveLength(2)
    f.client.send({ type: 'background.stop', target })
    await f.wait('用户停止后自动处理', () => f.calls.length === 3 && f.manager.runs()[0]?.background === 1 && !f.manager.runs()[0]?.backgroundWaiting)
    expect(requestText(f.calls[2])).toContain('用户主动停止')
    expect(requestText(f.calls[2])).toContain('不得将此当作普通失败立即重启')
    expect(f.store.serviceFor(target.session).inputs.list().filter(one => one.input.background !== undefined)).toHaveLength(1)
    f.client.send({ type: 'background.stop', target })
    await f.wait('重复停止已结束目标', () => f.events.some(one => one.kind === 'background.state' && one.data.result?.outcome.ok && one.data.result.outcome.already))
    expect(f.calls).toHaveLength(3)
    expect(f.shell.getView().background?.commands.map(one => one.id)).toEqual(['bg-1'])
  } finally { await f.close() }
}, 30000)

test('Engine 模型停止结果已承接，不再产生第二条完成输入；读快照不调用模型', async () => {
  const f = await collaborationRuntime('u124-model-stop', call => call.index === 0
    ? { tool: 'exec', args: { cmd: 'sleep 60', background: true } }
    : call.index === 1 ? { tool: 'background_stop', args: { id: 'bg-1' } } : { text: '已停止。' }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '启动并主动停止' })
    await f.wait('本轮结束', () => f.calls.length === 3 && f.manager.runs()[0]?.state === 'idle')
    const session = f.session()!
    expect(f.store.serviceFor(session).inputs.list().filter(one => one.input.background !== undefined)).toEqual([])
    const entries = []
    for await (const entry of f.store.readEntries(session)) entries.push(entry)
    expect(entries.some(entry => entry.kind === 'tool-result' && entry.payload && 'background' in entry.payload && entry.payload.background && 'stoppedBy' in entry.payload.background && entry.payload.background.stoppedBy === 'model')).toBe(true)
    const previous = f.events.filter(one => one.kind === 'background.state').length
    for (let i = 0; i < 3; i++) f.client.send({ type: 'background.list' })
    await f.wait('只读快照', () => f.events.filter(one => one.kind === 'background.state').length >= previous + 3)
    expect(f.calls).toHaveLength(3)
  } finally { await f.close() }
}, 30000)

test('Engine 整体停止先取消接续资格，迟到终态只记录，不唤醒模型', async () => {
  const f = await collaborationRuntime('u124-scope-stop', call => call.index === 0
    ? { tool: 'exec', args: { cmd: 'sleep 60', background: true } }
    : { tool: 'background_wait', args: { ids: ['bg-1'] } }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '等待后台测试' })
    await f.wait('等待', () => f.manager.runs().some(one => one.backgroundWaiting))
    const session = f.session()!
    f.client.stop(session, 'run')
    await f.wait('资源停止', () => f.manager.executors().length === 0)
    expect(f.calls).toHaveLength(2)
    const facts = f.store.serviceFor(session).inputs.list().filter(one => one.input.background !== undefined)
    expect(facts).toHaveLength(1)
    expect(facts[0]?.input.background?.stoppedBy).toBe('scope')
    expect(facts[0]?.reason).toContain('已停止')
  } finally { await f.close() }
}, 30000)


test('成员已交付仍持有服务；无 TUI 时异常结束在原成员协调回报，closing 不抢先释放待消费责任', async () => {
  const f = await collaborationRuntime('u124-member-finish', call => {
    const delegation = f.delegation()?.delegationId
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-member', agents: [f.member()!.agentId], message: delegation, expectation: '交付结果', deadline: Date.now() + 60000 } }
      if (call.index === 2) return { tool: 'agent_message', args: { action: 'receive', delegation } }
      if (call.index === 3) return { tool: 'agent_control', args: { action: 'close' } }
      return { text: call.index === 4 ? '已收下结果，服务继续托管。' : '已处理成员的服务退出回报。' }
    }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation, response: 'accept' } }
    if (call.index === 1) return { tool: 'exec', args: { cmd: `while [ ! -f ${quote(join(f.workspace, 'finish-member'))} ]; do sleep 0.02; done; exit 7`, background: true } }
    if (call.index === 2) return { tool: 'agent_message', args: { action: 'deliver', operationId: 'delivered', delegation, conclusion: '服务已经启动', artifacts: [], verified: ['启动受理'], unresolved: [] } }
    if (call.index === 3) return { text: '服务继续由本会话托管。' }
    if (call.index === 4) return { tool: 'background_stop', args: { id: 'bg-1' } }
    if (call.index === 5) return { tool: 'agent_message', args: { action: 'send', operationId: 'service-exit', recipients: [f.collaboration()!.coordinatorId], purpose: 'inform', body: [{ kind: 'text', text: 'SERVICE_EXIT_7：原服务退出，请协调处理。' }] } }
    return { text: '已回报退出事实，不重开委派。' }
  }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '委派启动服务，交付后继续托管' })
    await f.wait('已收下交付且服务仍在', () => f.delegation()?.state === 'received' && f.requests().length === 5 && f.requests('member-model').length === 4)
    const root = f.session()!, member = f.member()!
    expect(f.collaboration()?.state).toBe('closing')
    const snapshot = f.shell.getView().background!
    expect(snapshot.commands).toHaveLength(1)
    expect(snapshot.commands[0]).toMatchObject({ session: member.sessionId, member: member.name, agent: member.agentId, id: 'bg-1' })
    f.closeWindows()
    writeFileSync(join(f.workspace, 'finish-member'), '')
    await f.wait('原成员与主 Agent 处理后才闭合', () => f.store.collaboration.collaborationForSession(root)?.state === 'closed')
    expect(f.requests('member-model')).toHaveLength(7)
    expect(requestText(f.requests('member-model')[4])).toContain('exit 7')
    expect(requestText(f.requests()[5])).toContain('SERVICE_EXIT_7')
    expect(f.delegation()?.state).toBe('received')
    expect(f.store.serviceFor(member.sessionId).inputs.list().filter(one => one.input.background !== undefined)).toHaveLength(1)
    expect(f.store.serviceFor(root).inputs.list().filter(one => one.input.background !== undefined)).toHaveLength(0)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 30000)

test('整件工作跨深层成员平铺，同名成员及三个 bg-1 仍按执行身份单项停止', async () => {
  const f = await collaborationRuntime('u124-deep', call => {
    const actor = f.members().find(one => one.model.model === call.model)
    const delegation = f.collaboration() && f.store.collaboration.listDelegations(f.collaboration()!.collaborationId).find(one => one.assigneeId === actor?.agentId)
    const service = { tool: 'exec', args: { cmd: 'sleep 60', background: true } } as const
    const wait = { tool: 'background_wait', args: { ids: ['bg-1'] } } as const
    if (call.model === 'entry-model') {
      if (call.index === 0) return service
      if (call.index === 1) return spawnMember
      return wait
    }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: delegation?.delegationId, response: 'accept' } }
    if (call.index === 1) return service
    if (call.model === 'member-model' && call.index === 2) return { tool: 'agent_spawn', args: {
      operationId: 'deep', name: '实现', responsibility: '深层检查', scope: '深层后台服务', body: [{ kind: 'text', text: '启动自身服务' }], model: { choice: 'arcane' }, modelReason: '深层检查',
    } }
    return call.index > 3 ? { text: '尊重用户停止，不重启。' } : wait
  }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '主与深层成员分别托管服务' })
    await f.wait('三个原生身份均已等待', () => f.shell.getView().background?.commands.length === 3 && f.shell.getView().background?.waiting.length === 3)
    const commands = f.shell.getView().background!.commands
    expect(commands.map(one => one.id)).toEqual(['bg-1', 'bg-1', 'bg-1'])
    expect(new Set(commands.map(one => one.outputPath)).size).toBe(3)
    expect(commands.filter(one => one.member === undefined)).toHaveLength(1)
    expect(commands.filter(one => one.member === '实现')).toHaveLength(2)
    const target = commands.find(one => one.agent === f.member()!.agentId)!
    f.client.send({ type: 'background.stop', target })
    await f.wait('仅中层后台停止', () => f.shell.getView().background?.commands.length === 2)
    expect(f.shell.getView().background?.commands.every(one => one.execution !== target.execution)).toBe(true)
    expect(f.shell.getView().background?.commands.some(one => one.session === f.session())).toBe(true)
    expect(f.manager.runs().reduce((sum, one) => sum + (one.background ?? 0), 0)).toBe(2)
    const second = await f.openWindow()
    await f.wait('重连同一列表', () => second.shell.getView().background?.commands.length === 2)
    expect(second.shell.getView().background?.commands).toEqual(f.shell.getView().background?.commands)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 30000)

test('执行实例已空闲退出后，旧详情停止仍从持久终态回已经结束，不重启执行者', async () => {
  const f = await collaborationRuntime('u124-ended-target', call => call.index === 0
    ? { tool: 'exec', args: { cmd: `while [ ! -f ${quote(join(f.workspace, 'finished'))} ]; do sleep 0.02; done`, background: true } }
    : call.index === 1 ? { tool: 'background_wait', args: { ids: ['bg-1'] } } : { text: '完成已处理。' }, { allowAll: true })
  try {
    f.client.send({ type: 'input.submit', text: '等一个有限命令' })
    await f.wait('已等待', () => f.shell.getView().background?.waiting.length === 1)
    const target = f.shell.getView().background!.commands[0]!
    writeFileSync(join(f.workspace, 'finished'), '')
    await f.wait('完成接续后执行实例释放', () => f.calls.length === 3 && f.manager.executors().length === 0)
    f.client.send({ type: 'background.stop', target })
    await f.wait('持久事实答复', () => f.events.some(event => event.kind === 'background.state' && event.data.result?.outcome.ok && event.data.result.outcome.already))
    expect(f.manager.executors()).toHaveLength(0)
    expect(f.calls).toHaveLength(3)
  } finally { await f.close() }
}, 30000)
