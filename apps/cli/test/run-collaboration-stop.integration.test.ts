import { expect, test } from 'bun:test'
import type { OwnedProcess } from '@magic/contracts'
import { latch, spawnMember, type ModelReply } from './run-collaboration-fixture.ts'
import { alive, stopRuntime, type StopRuntime } from './run-collaboration-stop-fixture.ts'

const delivery = { conclusion: 'LATE_DELIVERY_ORIGINAL_CONCLUSION', artifacts: ['local-result.txt'], verified: ['受控本地验证'], unresolved: ['待入口复核'] }
const spawnDescendant: ModelReply = { tool: 'agent_spawn', args: { operationId: 'spawn-descendant', name: '后代 B', responsibility: '独立核对细节', scope: '回调细节', body: [{ kind: 'text', text: '核对细节后回报 A' }], model: { choice: 'arcane' }, modelReason: '复杂细节需要独立核对' } }
const memberOf = (f: StopRuntime) => f.members().find(one => one.model.model === 'member-model')!
const delegationOf = (f: StopRuntime) => f.delegations().find(one => one.assigneeId === memberOf(f)?.agentId)!
/** 每案经真实工具先 accept，再起一组可证明归属的后台进程，第三个响应才抵达屏障。 */
async function scenario(name: string, reply: (f: StopRuntime) => ModelReply | Promise<ModelReply>, gate = false) {
  const f = await stopRuntime(name, async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { text: '已派出，成员交付会自动唤醒我；交付前保持等待。' }
      return { text: 'UNEXPECTED_ENTRY_REAWAKEN' }
    }
    if (call.model === 'member-model') {
      if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'stop-accept', delegation: delegationOf(f).delegationId, response: 'accept' } }
      if (call.index === 1) return { tool: 'exec', args: { description: '测试命令', command: 'sleep 30', background: true } }
      if (call.index === 2) return reply(f)
    }
    return { text: 'UNEXPECTED_WORK_AFTER_BARRIER' }
  }, gate)
  return f
}

async function ready(f: StopRuntime): Promise<readonly OwnedProcess[]> {
  f.shell.key({ kind: 'paste', text: '委派独立核对，允许成员继续派生，并等待交付。' }); f.shell.key({ kind: 'enter' })
  await f.wait('成员接受、后台进程已登记、第三个 HTTP 暂停，入口已持久等待', () => {
    const work = f.collaboration()
    return work !== undefined && delegationOf(f)?.state === 'accepted' &&
      f.calls.filter(one => one.model === 'member-model').length === 3 &&
      f.launches.some(one => one.session === memberOf(f)?.sessionId && one.owned.length > 0) &&
            f.manager.runs().find(one => one.session === work.originSessionId)?.state === 'idle'
  })
  const member = memberOf(f)
  const owned = f.launches.find(one => one.session === member.sessionId)!.owned.map(one => ({ ...one }))
  expect(owned.length).toBeGreaterThan(0)
  for (const process of owned) {
    expect(process.startedAt).toBeDefined()
    expect(process.what).toContain('sleep 30')
    expect(alive(process.pgid)).toBe(true)
  }
  expect(f.launches).toHaveLength(2)
  expect(new Set(f.launches.map(one => one.gen)).size).toBe(2)
  f.mark('barrier-ready', { members: f.members(), delegations: f.delegations(), owned })
  await f.openStop()
  return owned
}

async function stopped(f: StopRuntime) {
  // 停止的持久事实是「委派全部作废」——协作与成员状态不被改写（停止只掐运行）。
  await f.wait('整体停止已持久生效（委派作废）', () => f.delegations().length > 0 && f.delegations().every(one => one.state === 'cancelled'))
  const work = f.collaboration()!
  expect(work.state).toBe('open')
  const order = f.mark('stop-persisted', { collaboration: work, delegations: f.delegations() })
  for (const agent of f.members()) {
    const delegation = f.delegations().find(one => one.assigneeId === agent.agentId)
    // 停止后成员准入关闭（委派作废）；协调者无委派——继续＝新一代正常准入，不再有状态墙。
    if (delegation === undefined) continue
    expect(f.store.collaboration.checkAdmission(agent.agentId, delegation.delegationId, 'work').allowed).toBe(false)
  }
  expect(f.delegations().every(one => one.state === 'cancelled')).toBe(true)
  return { order, calls: f.calls.length, workExecutions: f.store.collaboration.listExecutions(work.collaborationId).filter(one => one.mode === 'work').map(one => one.operationId) }
}

async function reclaimed(f: StopRuntime, owned: readonly OwnedProcess[], atStop: Awaited<ReturnType<typeof stopped>>) {
  const work = f.collaboration()!
  // 协作墓碑是 stopped；正常退出的历史 Run 可以是 idle。核销依据是实际资源与 ended，非显示文案。
  // 盘上核销记录**按会话留最新一代**（`lastRuns` 以会话为键，后代核销顶掉前代——整体停止后
  // 入口会因「新一代接管」再起一代并退出，gen 1 的记录被 gen 3 顶掉）：故判据是「涉及到的
  // 每个会话，其**最新一代**已核销」；member（gen 2）是其会话唯一一代，逐代精确断言保留。
  const latestBySession = (session: string | null): number => Math.max(...f.launches.filter(one => one.session === session).map(one => one.gen))
  const sessionReclaimed = (session: string | null): boolean => {
    if (session === null) return true
    const persisted = f.storedRuns().find(run => run.session === session && run.gen === latestBySession(session))
    return persisted !== undefined && persisted.kind !== undefined && persisted.why !== undefined
  }
  const sessionOf = new Map(f.launches.map(one => [one.gen, one.session]))
  await f.wait('全部真实 executor onExit 与自有组回收', () => f.launches.every(one => one.exited !== undefined) &&
    f.manager.executors().length === 0 && f.manager.runs().every(one => !one.holds) &&
    [...sessionOf.values()].every(sessionReclaimed) &&
    f.store.collaboration.listExecutions(work.collaborationId).every(one => one.state === 'finished') &&
    owned.every(one => !alive(one.pgid) && !alive(-one.pgid)))
  for (const launched of f.launches) {
    expect(launched.exited).toBeDefined()
    expect(f.members().some(one => one.sessionId === launched.session)).toBe(true)
    expect(f.manager.runs().find(one => one.session === launched.session)?.holds).toBe(false)
  }
  // 盘上核销记录按会话断言（最新一代）：root 的 gen 1 记录被 gen 3 顶掉是产品语义，不是漏核销。
  for (const session of new Set(f.launches.map(one => one.session))) {
    const persisted = f.storedRuns().find(one => one.session === session && one.gen === latestBySession(session))!
    expect(persisted.kind).toBeDefined()
    expect(persisted.why).toBeDefined()
  }
  expect(work.state).toBe('open')
  expect(f.delegations().every(one => one.state === 'cancelled' && one.receivedAt === undefined)).toBe(true)
  expect(f.store.collaboration.listExecutions(work.collaborationId).every(one => one.state === 'finished')).toBe(true)
  expect(f.store.collaboration.listExecutions(work.collaborationId).filter(one => one.mode === 'work').map(one => one.operationId)).toEqual(atStop.workExecutions)
  const before = { calls: f.calls.length, launches: f.launches.length }
  // 停止后经同一根窗口 socket 读协作摘要；只读不带成员完整历史，也不重新建立执行者。
  const queries = [undefined, ...f.members().map(one => one.agentId)]
  for (const member of queries) {
    const start = f.events.length
    f.client.send({ type: 'collaboration.read', ...(member === undefined ? {} : { member }) })
    await f.wait('停止后的协作视图', () => f.events.slice(start).some(one => one.kind === 'collaboration.view' && one.data.collaboration?.state === 'open'))
    const event = f.events.slice(start).find(one => one.kind === 'collaboration.view')
    if (event?.kind !== 'collaboration.view') throw new Error('没有协作视图')
    // 当前会话自身（这里是入口）不会被当成要查看的成员；协作视图也不携带 entries。
    expect(event.data.entries).toBeUndefined()
    expect(event.data.selectedMember).toBeUndefined()
  }
  // 成员正文改走会话历史分片：切进子会话并读历史，不重建执行者。
  const memberSession = f.members().find(one => one.agentId !== f.collaboration()?.coordinatorId)!.sessionId
  const historyStart = f.events.length
  f.client.send({ type: 'session.open', session: memberSession })
  f.client.send({ type: 'history.read', session: memberSession })
  await f.wait('停止后的子会话历史', () => f.events.slice(historyStart).some(one => one.kind === 'session.history' && one.data.session === memberSession && one.data.done))
  /**
   * 原锚：只取 `done` 那一块的 entries（末包带最后一批条目）。
   * 为何变：末包拆成「最后一批条目（done:false）」＋「空条目的 done 帧」，
   * 否则 inputs/timing/plan 会把末帧撑过单帧预算（2026-11-21）。
   * 新锚：把该会话所有分块的 entries 拼起来，条目总数不变。
   */
  const blocks = f.events.slice(historyStart).flatMap(one =>
    one.kind === 'session.history' && one.data.session === memberSession ? [one.data] : [])
  expect(blocks.flatMap(block => block.entries).length).toBeGreaterThan(0)
  await Bun.sleep(200) // 仅检查迟到帧/多余调用；停止证明来自 onExit、原账本与进程组探针。


  expect(f.calls).toHaveLength(atStop.calls)
  expect({ calls: f.calls.length, launches: f.launches.length }).toEqual(before)
  expect(f.manager.executors()).toEqual([])
  // 停止走 Ctrl+C → client.stop 通道（scope 'run'，engine 对入口会话升级为整件）；shell 不再有协作停止命令。
  expect(f.stops).toEqual([{ session: work.originSessionId, scope: 'run' }])
  expect(f.errors).toEqual([])
  f.mark('stop-verified-before-cleanup', { ownedGone: owned.map(one => ({ ...one, leaderAlive: alive(one.pgid), groupAlive: alive(-one.pgid) })), snapshot: await f.snapshot() })
}

test('整体停止与成员后代派生竞争：按持久准入结果回收全部真实执行者及自有资源', async () => {
  const response = latch()
  const f = await scenario('stop-spawn-race', async () => {
    await response.promise
    return spawnDescendant
  })
  try {
    const owned = await ready(f)
    response.release(); f.pick('stop')
    const stop = await stopped(f)
    const descendant = f.members().find(one => one.model.model === 'descendant-model')
    if (descendant !== undefined) {
      const parent = delegationOf(f)
      expect(f.delegations().find(one => one.assigneeId === descendant.agentId)?.parentDelegationId).toBe(parent.delegationId)
      expect(f.delegations().find(one => one.assigneeId === descendant.agentId)?.state).toBe('cancelled')
    }
    f.mark('spawn-race-outcome', { outcome: descendant ? 'descendant-admitted-before-stop' : 'stop-before-descendant-admission', descendant })
    await reclaimed(f, owned, stop)
    expect(f.members().filter(one => one.model.model === 'descendant-model')).toHaveLength(descendant ? 1 : 0)
    expect(f.launches.filter(one => one.session === descendant?.sessionId).every(one => one.exited !== undefined)).toBe(true)
  } finally { response.release(); await f.close() }
}, 30000)

test('后代已登记、真实启动并持有后台进程后整体 stop：入口及 A/B 全部核销', async () => {
  const spawn = latch(), descendantResponse = latch()
  const descendantOf = () => f.members().find(one => one.model.model === 'descendant-model')
  const childDelegation = () => f.delegations().find(one => one.assigneeId === descendantOf()?.agentId)
  const f = await stopRuntime('stop-after-descendant-started', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { text: '已派出，成员交付会自动唤醒我；交付前保持等待。' }
    }
    if (call.model === 'member-model') {
      if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'stop-accept', delegation: delegationOf(f).delegationId, response: 'accept' } }
      if (call.index === 1) return { tool: 'exec', args: { description: '测试命令', command: 'sleep 30', background: true } }
      if (call.index === 2) { await spawn.promise; return spawnDescendant }
      if (call.index === 3) return { text: 'A 已派生 B，等待核对。' }
    }
    if (call.model === 'descendant-model') {
      if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'descendant-accept', delegation: childDelegation()!.delegationId, response: 'accept' } }
      if (call.index === 1) return { tool: 'exec', args: { description: '测试命令', command: 'sleep 30', background: true } }
      if (call.index === 2) { await descendantResponse.promise; return { text: 'B 的旧响应。' } }
    }
    return { text: 'UNEXPECTED_WORK_AFTER_BARRIER' }
  })
  try {
    const ownedA = await ready(f)
    spawn.release()
    await f.wait('B 已接受派生委派、真实请求在途且自有进程组已登记', () => childDelegation()?.state === 'accepted' &&
      f.calls.filter(one => one.model === 'descendant-model').length === 3 &&
      f.calls.filter(one => one.model === 'member-model').length === 4 &&
      f.launches.some(one => one.session === descendantOf()?.sessionId && one.owned.length > 0))
    const descendant = descendantOf()!
    const launched = f.launches.find(one => one.session === descendant.sessionId)!
    expect(childDelegation()?.parentDelegationId).toBe(delegationOf(f).delegationId)
    expect(descendant.createdBy).toBe(memberOf(f).agentId)
    expect(f.collaboration()?.state).toBe('open')
    expect(f.launches).toHaveLength(3)
    expect(new Set(f.launches.map(one => one.gen)).size).toBe(3)
    expect(launched.exited).toBeUndefined()
    const owned = [...ownedA, ...launched.owned.map(one => ({ ...one }))]
    for (const one of owned) {
      expect(one.startedAt).toBeDefined()
      expect(alive(one.pgid)).toBe(true)
      expect(alive(-one.pgid)).toBe(true)
    }
    const beforeStop = f.mark('descendant-started-before-stop', { descendant, delegation: childDelegation(), launch: { ...launched }, owned })
    expect(f.stops).toEqual([])
    f.pick('stop')
    const stop = await stopped(f)
    expect(beforeStop).toBeLessThan(stop.order)
    descendantResponse.release()
    await reclaimed(f, owned, stop)
    expect(f.members()).toHaveLength(3)
    expect(f.delegations()).toHaveLength(2)
    expect(launched.exited!.order).toBeGreaterThan(beforeStop)
  } finally { spawn.release(); descendantResponse.release(); await f.close() }
}, 30000)

test('整体 stop 已持久生效后返回旧 HTTP deliver 响应：不继续执行、不复活、不重放', async () => {
  const response = latch()
  const f = await scenario('stop-old-http', async f => {
    await response.promise
    return { tool: 'agent_message', args: { action: 'deliver', operationId: 'old-http-delivery', delegation: delegationOf(f).delegationId, ...delivery } }
  })
  try {
    const owned = await ready(f)
    expect(f.packets.some(one => one.message.t === 'collaboration.request' && one.message.request.action === 'deliver')).toBe(false)
    f.pick('stop')
    const stop = await stopped(f)
    response.release()
    await f.wait('本地 HTTP 旧响应已释放', () => f.journal.some(one => one.kind === 'http-response-released' && JSON.stringify(one.data).includes('old-http-delivery')))
    await reclaimed(f, owned, stop)
    expect(delegationOf(f).deliveryMessageId).toBeUndefined()
    const requests = f.packets.filter(one => one.direction === 'executor-to-manager' && one.message.t === 'collaboration.request' && one.message.request.action === 'deliver')
    expect(requests).toEqual([])
    f.mark('old-http-outcome', '旧响应已释放但未成为交付 RPC；本案不作为已发 RPC 迟到保存的证明')
  } finally { response.release(); await f.close() }
}, 30000)

test('executor 已发出的交付 RPC 在 stop 后经原通道处理：保存原归属且不得恢复或自动收悉', async () => {
  const response = latch()
  const f = await scenario('stop-inflight-rpc', async f => {
    await response.promise
    return { tool: 'agent_message', args: { action: 'deliver', operationId: 'inflight-delivery', delegation: delegationOf(f).delegationId, ...delivery } }
  }, true)
  try {
    const owned = await ready(f)
    response.release()
    await f.wait('生产 executor 的真实 deliver RPC 已在原认证连接发出', () => f.gate() !== undefined)
    const gate = f.gate()!
    const packet = gate.packet
    if (packet.message.t !== 'collaboration.request' || packet.message.request.action !== 'deliver') throw new Error('不是交付 RPC')
    const requestId = packet.message.requestId
    expect(packet.forwarded).toBeUndefined()
    const { generatedFrom, ...request } = packet.message.request
    expect(request).toEqual({ action: 'deliver', operationId: 'inflight-delivery', delegation: delegationOf(f).delegationId, ...delivery })
    const owner = f.launches.find(one => one.gen === packet.gen)!
    expect(owner.session).toBe(memberOf(f).sessionId)
    expect(owner.exited).toBeUndefined()
    expect(generatedFrom).toBeDefined()
    const source = (await Array.fromAsync(f.store.readEntries(generatedFrom!.sessionId, { from: generatedFrom!.entryId })))[0]
    expect(source).toMatchObject({ kind: 'tool-call', payload: { name: 'agent_message' } })
    expect(generatedFrom).toEqual({ sessionId: memberOf(f).sessionId, entryId: source!.id })
    expect(source?.payload && 'args' in source.payload ? source.payload.args : undefined).toEqual(request)
    f.pick('stop')
    const stop = await stopped(f)
    expect(packet.order).toBeLessThan(stop.order)
    expect(delegationOf(f).deliveryMessageId).toBeUndefined()
    gate.releaseRequest()
    expect(packet.forwarded).toBeGreaterThan(stop.order)
    await f.wait('同一宿主处理原通道迟到 RPC 并返回对应 reply', () => f.packets.some(one => one.gen === packet.gen && one.message.t === 'collaboration.reply' && one.message.requestId === requestId))
    const reply = f.packets.find(one => one.gen === packet.gen && one.message.t === 'collaboration.reply' && one.message.requestId === requestId)!
    if (reply.message.t !== 'collaboration.reply') throw new Error('没有对应交付回复')
    expect(reply.message.reply.ok).toBe(true)
    const delegated = delegationOf(f)
    expect(delegated.state).toBe('cancelled')
    expect(delegated.receivedAt).toBeUndefined()
    expect(delegated.deliveryMessageId).toBeDefined()
    const message = f.store.collaboration.readMessage(f.collaboration()!.coordinatorId, delegated.deliveryMessageId!)!
    expect(message.senderId).toBe(memberOf(f).agentId)
    expect(message.delegationId).toBe(delegated.delegationId)
    expect(message.purpose).toBe('delivery')
    expect(message.body).toEqual([{ kind: 'text', text: JSON.stringify(delivery) }])
    f.mark('late-rpc-saved', { packet: packet.order, forwarded: packet.forwarded, reply: reply.order, message, delegation: delegated })
    // stop 控制先发，reply 后发；恢复这一方向的原 FIFO，未重排或伪造任何帧。
    gate.releaseControl()
    await reclaimed(f, owned, stop)
    expect(f.packets.filter(one => one.gen === packet.gen && one.message.t === 'collaboration.request' && one.message.request.action === 'deliver')).toHaveLength(1)
    expect(f.store.collaboration.listMessages(f.collaboration()!.coordinatorId).filter(one => one.purpose === 'delivery')).toHaveLength(1)
  } finally { response.release(); f.gate()?.releaseRequest(); f.gate()?.releaseControl(); await f.close() }
}, 30000)
