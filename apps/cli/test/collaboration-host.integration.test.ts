import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { KernelEvent } from '@magic/contracts'
import { startManager, type Manager } from '@magic/host'
import { createAgentLauncher } from '@magic/host'
import { connectManager } from '@magic/host'
import { runPathsOf } from '@magic/host'
import { terminalConnection } from '../src/run/terminal.ts'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'


test('真实宿主退出再开：target 接回原工作，只读不执行；明确继续及新输入只归原入口', async () => {
  const lateMember = latch()
  const resumedText = 'REOPEN_ROOT：先核对停止事实，不重启旧成员，不重放未知效果。'
  const f = await collaborationRuntime('host-reopen', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { text: '已派出，等成员核对结果后唤醒我。' }
      // resume 后的那一趟：宿主已换新，挂到 release——迟到的响应不复活已停止的旧代
      await lateMember.promise
      return { text: resumedText }
    }
    if (call.model === 'member-model') {
      // accept 直接返回：工具结果即成员对委派的响应终态（挂住 = accept 不生效，见 2026-11-24 行为）
      if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
      await lateMember.promise
      return { text: 'OLD_HTTP：停止之后才返回，不能重新推进。' }
    }
    await lateMember.promise
    return { text: 'OLD_HTTP：停止之后才返回，不能重新推进。' }
  })
  let reopened: Manager | undefined
  const reconnectSessions: (string | undefined)[] = []
  const connection = terminalConnection(f.client, async session => {
    reconnectSessions.push(session)
    if (reopened === undefined) throw new Error('新宿主尚未启动')
    const next = await connectManager(reopened.socketPath, { session, expectedIdentity: reopened.identity, cwd: f.workspace })
    if (next === undefined) throw new Error('无法只读接回')
    return next
  })
  const client = connection.client
  const targets: { session: string | null; gen: number | null }[] = []
  client.onTarget(session => targets.push({ session, gen: client.gen() }))
  const exits: { gen: number; reason: string }[] = []
  try {
    f.shell.key({ kind: 'paste', text: '派出核对后等待成员结果。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员已接受且入口让出', () => f.collaboration() !== undefined &&
      f.requests().length === 2 && f.requests('member-model').length === 2)
    const origin = f.session()!
    const work = f.collaboration()!
    const member = f.member()!
    // 实际 HTTP 与持久 wait 已建立；不靠等 target 超时掩盖首次认领缺失。
    expect(targets).toEqual([{ session: null, gen: expect.any(Number) }, { session: origin, gen: targets[0]!.gen }])
    f.manager.stop('用户退出宿主')
    await f.manager.waitUntilExit()
    await f.wait('旧客户端收到宿主关闭', () => client.closed)
    expect(f.manager.executors()).toEqual([])
    expect(f.agentExits).toHaveLength(2)
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.store.collaboration.listExecutions(work.collaborationId).every(call => call.state === 'finished')).toBe(true)

    const launch = createAgentLauncher()
    const started = await startManager({ paths: runPathsOf(f.magic, tmpdir()), magic: f.magic,
      launch: { spawn(request) { const process = launch.spawn(request); process.onExit(reason => exits.push({ gen: request.gen, reason })); return process } },
      stopGraceMs: 1000, stopKillMs: 1000 })
    if (started.role !== 'manager') throw new Error('新宿主没有启动')
    reopened = started.manager
    expect(reopened.identity.serviceInstance).not.toBe(f.manager.identity.serviceInstance)
    await connection.reopen()
    expect(reconnectSessions).toEqual([origin])
    const events: KernelEvent[] = []
    client.onEvent(event => events.push(event))
    client.send({ type: 'history.read', session: origin })
    client.send({ type: 'collaboration.read' })
    lateMember.release()
    await f.wait('只读历史与协作停点经新连接返回', () => events.some(event => event.kind === 'session.history' && event.session === origin && event.data.done)
      && events.some(event => event.kind === 'collaboration.view' && event.data.originSession === origin && event.data.collaboration?.state === 'stopped'))
    expect(reopened.executors()).toEqual([])
    expect(f.requests()).toHaveLength(2)
    expect(f.requests('member-model')).toHaveLength(2)
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.store.collaboration.getAgent(member.agentId)?.reachability).toBe('suspended')

    // **resume 只切界面**（2026-11-24 裁定）：不发请求、不复活成员、协作仍停止——
    // 继续一件已停止的工作靠直接打字（新一代接管原工作），不需要任何「继续」入口。
    client.send({ type: 'collaboration.resume' })
    expect(reopened.executors()).toEqual([])
    expect(f.requests()).toHaveLength(2)
    expect(f.requests('member-model')).toHaveLength(2)
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(f.store.collaboration.getAgent(member.agentId)?.reachability).toBe('suspended')

    const input = 'REOPEN_EXPLICIT_INPUT：继续原工作核对，不另开会话。'
    client.send({ type: 'input.submit', text: input, ref: 'reopen-input' })
    await f.wait('接回后的明确输入返回原窗口接收回执', () => events.some(event => event.kind === 'input.settled' && event.data.ref === 'reopen-input'))
    const accepted = events.find(event => event.kind === 'input.settled' && event.data.ref === 'reopen-input')!
    expect(accepted).toMatchObject({ session: origin, data: { ref: 'reopen-input', ok: true } })
    // **新一代只有一趟**（resume 不再启动运行）：明确输入触发的第 3 次请求 + 一次真实退出
    await f.wait('原入口新一代请求完成并真实退出', () => f.requests().length === 3 && exits.length === 1 && reopened!.executors().length === 0)
    expect(requestText(f.requests()[2])).toContain(input)
    expect(requestText(f.requests()[2])).toContain('派出核对后等待成员结果。')
    const entries = await Array.fromAsync(f.store.readEntries(origin))
    expect(entries.some(entry => entry.kind === 'assistant' && 'text' in entry.content && entry.content.text === resumedText)).toBe(true)
    expect(entries.filter(entry => entry.kind === 'user' && 'text' in entry.content && entry.content.text === input)).toHaveLength(1)
    expect((await f.store.listSessions()).map(session => session.id).sort()).toEqual([origin, member.sessionId].sort())
    expect(f.store.collaboration.collaborationForSession(origin)?.collaborationId).toBe(work.collaborationId)
    expect(f.requests('member-model')).toHaveLength(2)
    expect(new Set(exits.map(exit => exit.gen)).size).toBe(1)
    expect(f.errors).toEqual([])
    const evidence = process.env['MAGIC_COLLAB_RUN_EVIDENCE']
    if (evidence) { const dir = resolve(evidence); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'host-reopen-result.json'), JSON.stringify({
      oldIdentity: f.manager.identity, newIdentity: reopened.identity, targets, reconnectSessions, events, exits, entries,
      collaboration: f.store.collaboration.getCollaboration(work.collaborationId),
    }, null, 2)) }
  } finally {
    try {
      const { readdirSync, readFileSync: rf } = await import('node:fs')
      const logDir = join(f.magic.base, 'logs')
      for (const file of readdirSync(logDir).filter(one => one.startsWith('executor'))) {
        console.log('==', file)
        console.log(rf(join(logDir, file), 'utf8').split('\n').map(line => { try { const j = JSON.parse(line); return `${j.event}${j.session ? ' @' + j.session.slice(0, 8) : ''}${j.error ? ' ERR' : ''}` } catch { return line } }).filter(one => one !== 'executor.started' && one !== '').slice(-14).join('\n'))
      }
    } catch (error) { console.log('(无日志)', String(error)) }
    lateMember.release(); client.close()
    reopened?.stop('重开验证结束'); if (reopened !== undefined) await reopened.waitUntilExit()
    await f.close()
  }
}, 30000)
