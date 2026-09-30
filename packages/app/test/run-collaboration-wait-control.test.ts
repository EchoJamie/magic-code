import { expect, test } from 'bun:test'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

test('真实等待期控制：inform 不解除 wait，入口仍可执行点名 stop 并写下一正文', async () => {
  const memberReply = latch()
  const controlReply = latch()
  const deadline = Date.now() + 3600_000
  const inform = 'WAIT_CONTROL_INFORM：检查条件已变化，请入口撤回当前委派。'
  const stopReason = '根据成员新告知撤回当前检查'
  const finalText = 'WAIT_CONTROL_FINAL：已处理指定委派的撤回，继续核对后续安排。'
  const f = await collaborationRuntime('wait-inform-control', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-member', agents: [f.member()!.agentId],
        message: f.delegation()!.delegationId, expectation: '等待成员检查结果', deadline } }
      if (call.index === 2) {
        // 让测试读取第三次真实 HTTP 到达时的持久 wait，随后才输出控制工具。
        await controlReply.promise
        return { tool: 'agent_control', args: { action: 'stop', delegation: f.delegation()!.delegationId, reason: stopReason } }
      }
      return { text: finalText }
    }
    if (call.index === 0) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    if (call.index === 1) return { tool: 'agent_message', args: { action: 'send', operationId: 'inform-entry',
      recipients: [f.collaboration()!.coordinatorId], purpose: 'inform', body: [{ kind: 'text', text: inform }] } }
    return { text: '已告知入口当前变化。' }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出回调检查，等待结果；若成员告知条件变化可撤回该委派。' })
    f.shell.key({ kind: 'enter' })
    await f.wait('入口持久等待且已 idle', () => {
      const work = f.collaboration()
      const waiting = work === undefined ? undefined : f.store.collaboration.listWaits(work.collaborationId).find(one => one.state === 'waiting')
      const run = f.manager.runs().find(one => one.session === f.session())
      return waiting !== undefined && run?.state === 'idle' && (run.lastTurnAt ?? 0) >= waiting.at
    })
    const work = f.collaboration()!
    const member = f.member()!
    const delegation = f.delegation()!
    const waiting = f.store.collaboration.listWaits(work.collaborationId)[0]!
    expect(waiting.state).toBe('waiting')
    expect(waiting.forMessageId).toBe(delegation.delegationId)
    // 没有新信息时保持让出；此观察窗口不触发模型或推进 deadline。
    await Bun.sleep(350)
    expect(f.requests()).toHaveLength(2)

    memberReply.release()
    await f.wait('inform 唤起入口第三次 HTTP', () => f.requests().length >= 3)
    expect(f.requests()).toHaveLength(3)
    expect(requestText(f.requests()[2])).toContain(inform)
    expect(f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)?.state).toBe('waiting')
    expect(f.delegation()?.state).toBe('accepted')
    expect(Date.now()).toBeLessThan(deadline)
    const message = f.store.collaboration.listMessages(work.coordinatorId).find(one => one.purpose === 'inform')
    expect(message?.senderId).toBe(member.agentId)
    expect(message?.body).toEqual([{ kind: 'text', text: inform }])

    controlReply.release()
    await f.wait('点名 stop 的工具结果进入下一 HTTP', () => f.requests().length >= 4)
    const control = f.events.find(one => one.kind === 'tool.call' && one.session === work.originSessionId && one.data.name === 'agent_control')
    if (control?.kind !== 'tool.call') throw new Error('等待期间的 agent_control 被吞掉')
    expect(control.data.args).toEqual({ action: 'stop', delegation: delegation.delegationId, reason: stopReason })
    const result = f.events.find(one => one.kind === 'tool.result' && one.session === work.originSessionId && one.data.call === control.id)
    if (result?.kind !== 'tool.result') throw new Error('点名 stop 没有返回工具结果')
    expect(result.data.ok).toBe(true)
    expect(result.data.notExecuted).toBeUndefined()
    if (!('text' in result.data.output)) throw new Error('控制结果未以正文返回')
    const stopped = JSON.parse(result.data.output.text)
    expect(stopped.agents).toEqual([member.agentId])
    expect(stopped.delegations).toEqual([delegation.delegationId])
    const messages = f.requests()[3]!.body['messages'] as readonly { role: string; content: unknown }[]
    expect(messages.filter(one => one.role === 'tool').at(-1)?.content).toBe(result.data.output.text)
    expect(f.delegation()?.state).toBe('cancelled')
    expect(f.collaboration()?.state).toBe('open')
    await f.wait('入口写完撤回后的正文并 idle', () => {
      const run = f.manager.runs().find(one => one.session === work.originSessionId)
      return run?.state === 'idle' && (run.lastTurnAt ?? 0) >= f.requests()[3]!.at
    })
    const entries = await Array.fromAsync(f.store.readEntries(work.originSessionId))
    expect(entries.filter(one => one.kind === 'assistant').at(-1)?.content).toEqual({ text: finalText })
    await Bun.sleep(350)
    expect(f.requests()).toHaveLength(4)
    expect(f.events.filter(one => one.kind === 'tool.call' && one.session === work.originSessionId && one.data.name === 'agent_control')).toHaveLength(1)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    // 本例只证控制未被 waiting 拦截；不把旧 manager 的 socket 核销当作资源退出确证。
  } finally { memberReply.release(); controlReply.release(); await f.close() }
}, 30000)
