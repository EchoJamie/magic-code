import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { NativeResponse, NativeWork } from '@magic/contracts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { startManager, type Manager } from '../src/run/manager.ts'
import { createProcessLauncher } from '../src/run/launch.ts'
import { connectManager, type ManagerClient } from '../src/run/client.ts'
import { runPathsOf } from '../src/run/paths.ts'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

test('真实原生协作投影：入口释放仍一工作一行，成员审批归根，旧整体停止版本失效', async () => {
  const memberResponse = latch()
  const f = await collaborationRuntime('native-collaboration', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'native-wait', agents: [f.member()!.agentId],
        message: f.delegation()!.delegationId, expectation: '等待核对', deadline: Date.now() + 3600_000 } }
      return { text: '入口核对停点。' }
    }
    if (call.index === 0) {
      await memberResponse.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    return { tool: 'exec', args: { cmd: 'chmod 700 native-approval.txt' } }
  })
  writeFileSync(join(f.workspace, 'native-approval.txt'), 'approval remains pending', { mode: 0o600 })
  const native = linkOf(await Bun.connect({ unix: f.manager.socketPath, socket: socketHandlers() }) as never)
  const responses: NativeResponse[] = []
  native.onMessage(message => { if (message.t.startsWith('native.')) responses.push(message as NativeResponse) })
  const works = (): readonly NativeWork[] => {
    const view = responses.findLast(one => one.t === 'native.welcome' || one.t === 'native.projection')
    return view?.t === 'native.welcome' || view?.t === 'native.projection' ? view.projection.works : []
  }
  try {
    f.shell.key({ kind: 'paste', text: '分出核对工作，等成员结果。' }); f.shell.key({ kind: 'enter' })
    await f.wait('入口真实释放且成员请求仍在途', () => f.member() !== undefined && f.requests().length === 2 &&
      f.store.collaboration.listWaits(f.collaboration()!.collaborationId).some(wait => wait.state === 'waiting') &&
      !f.manager.executors().some(executor => executor.session === f.session()) && f.processExits.length > 0)
    const origin = f.session()!
    native.send({ t: 'hello', role: 'observer', ...f.manager.identity })
    await f.wait('整项原生投影', () => works().length > 0)
    expect(works()).toHaveLength(1)
    expect(works()[0]).toMatchObject({ session: origin, affected: true, state: 'running' })
    const oldGen = works()[0]!.gen!
    expect(oldGen).not.toBeNull()
    memberResponse.release()
    await f.wait('成员真实审批', () => f.events.some(event => event.kind === 'tool.decision.request' && event.data.name === 'exec'))
    const approval = f.events.find(event => event.kind === 'tool.decision.request' && event.data.name === 'exec')!
    native.send({ t: 'native.refresh' })
    await f.wait('成员审批在原工作待答', () => works()[0]?.notices.some(notice => notice.kind === 'needs-you' && notice.fact === String(approval.id)) === true)
    expect(works()).toHaveLength(1)
    expect(works()[0]).toMatchObject({ session: origin, state: 'waiting', affected: true })
    const notice = works()[0]!.notices.find(notice => notice.fact === String(approval.id))!
    expect(notice.session).toBe(origin)
    expect(notice.detail).toContain(f.member()!.name)
    expect(works()[0]!.gen).not.toBe(oldGen)
    native.send({ t: 'native.stop', request: 'old', serviceInstance: f.manager.identity.serviceInstance, session: origin, gen: oldGen })
    await f.wait('过期整体停止拒绝', () => responses.some(one => one.t === 'native.stopped' && one.request === 'old'))
    expect(responses.find(one => one.t === 'native.stopped' && one.request === 'old')).toMatchObject({ phase: 'unconfirmed' })
    expect(f.collaboration()!.state).toBe('open')
    native.send({ t: 'native.stop', request: 'current', serviceInstance: f.manager.identity.serviceInstance, session: origin, gen: works()[0]!.gen! })
    await f.wait('整体真实资源退出后已停', () => responses.some(one => one.t === 'native.stopped' && one.request === 'current' && one.phase === 'done'))
    expect(f.manager.executors()).toEqual([])
    expect(f.processExits).toHaveLength(2)
    expect(f.collaboration()!.state).toBe('stopped')
    expect(f.store.collaboration.listExecutions(f.collaboration()!.collaborationId).every(call => call.state === 'finished')).toBe(true)
    expect(f.requests()).toHaveLength(2)
    expect(f.errors).toEqual([])
  } finally {
    memberResponse.release()
    native.close()
    const evidence = process.env['MAGIC_COLLAB_RUN_EVIDENCE']
    if (evidence) { const dir = resolve(evidence); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'native-collaboration-projection.json'), JSON.stringify(responses, null, 2)) }
    await f.close()
  }
}, 30000)

test('真实宿主退出再开：持久等待保留停点，只读不执行；明确继续只接回入口', async () => {
  const lateMember = latch()
  const resumedText = 'REOPEN_ROOT：先核对停止事实，不重启旧成员，不重放未知效果。'
  const f = await collaborationRuntime('host-reopen', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'reopen-wait', agents: [f.member()!.agentId],
        message: f.delegation()!.delegationId, expectation: '等待独立核对', deadline: Date.now() + 3600_000 } }
      return { text: resumedText }
    }
    await lateMember.promise
    return { text: 'OLD_HTTP：停止之后才返回，不能重新推进。' }
  })
  let reopened: Manager | undefined
  let client: ManagerClient | undefined
  const exits: { pid: number | undefined; reason: string }[] = []
  try {
    f.shell.key({ kind: 'paste', text: '派出核对后等待成员结果。' }); f.shell.key({ kind: 'enter' })
    await f.wait('旧宿主持久等待已建立', () => f.collaboration() !== undefined &&
      f.store.collaboration.listWaits(f.collaboration()!.collaborationId).some(wait => wait.state === 'waiting') && f.requests().length === 2 && f.requests('member-model').length === 1)
    const origin = f.session()!
    const work = f.collaboration()!
    const member = f.member()!
    f.manager.stop('用户退出宿主')
    await f.manager.waitUntilExit()
    expect(f.manager.executors()).toEqual([])
    expect(f.processExits).toHaveLength(2)
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.store.collaboration.listExecutions(work.collaborationId).every(call => call.state === 'finished')).toBe(true)
    expect(f.store.collaboration.listWaits(work.collaborationId)[0]?.state).toBe('interrupted')

    const launch = createProcessLauncher()
    const started = await startManager({ paths: runPathsOf(f.magic, f.dataDir, tmpdir()), dataDir: f.dataDir, magic: f.magic,
      launch: { spawn(request) { const process = launch.spawn(request); process.onExit(reason => exits.push({ pid: process.pid, reason })); return process } },
      stopGraceMs: 1000, stopKillMs: 1000 })
    if (started.role !== 'manager') throw new Error('新宿主没有启动')
    reopened = started.manager
    expect(reopened.identity.serviceInstance).not.toBe(f.manager.identity.serviceInstance)
    client = await connectManager(reopened.socketPath, { session: origin, expectedIdentity: reopened.identity, cwd: f.workspace })
    if (client === undefined) throw new Error('无法只读接回')
    const events: unknown[] = []
    client.onEvent(event => events.push(event))
    client.send({ type: 'history.read', session: origin })
    client.send({ type: 'collaboration.read' })
    lateMember.release()
    await Bun.sleep(350)
    expect(reopened.executors()).toEqual([])
    expect(f.requests()).toHaveLength(2)
    expect(f.requests('member-model')).toHaveLength(1)
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.store.collaboration.getAgent(member.agentId)?.reachability).toBe('suspended')

    client.send({ type: 'collaboration.resume' })
    await f.wait('明确继续后的入口真实请求', () => f.requests().length === 3)
    expect(requestText(f.requests()[2])).toContain('interrupted')
    expect(requestText(f.requests()[2])).toContain('用户退出宿主')
    await f.wait('入口最终正文与新代实际释放', async () => {
      const entries = await Array.fromAsync(f.store.readEntries(origin))
      return entries.some(entry => entry.kind === 'assistant' && 'text' in entry.content && entry.content.text === resumedText) && exits.length === 1
    })
    expect(f.requests('member-model')).toHaveLength(1)
    expect(reopened.executors()).toEqual([])
    expect(f.store.collaboration.getAgent(member.agentId)?.reachability).toBe('suspended')
    const evidence = process.env['MAGIC_COLLAB_RUN_EVIDENCE']
    if (evidence) { const dir = resolve(evidence); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'host-reopen-result.json'), JSON.stringify({
      oldIdentity: f.manager.identity, newIdentity: reopened.identity, events, exits,
      collaboration: f.store.collaboration.getCollaboration(work.collaborationId), waits: f.store.collaboration.listWaits(work.collaborationId),
    }, null, 2)) }
  } finally {
    lateMember.release(); client?.close()
    reopened?.stop('重开验证结束'); if (reopened !== undefined) await reopened.waitUntilExit()
    await f.close()
  }
}, 30000)
