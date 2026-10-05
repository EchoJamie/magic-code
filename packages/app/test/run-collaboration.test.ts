import { expect, test } from 'bun:test'
import { statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

for (const response of ['clarify', 'reject', 'accept'] as const) {
  test(`真实 manager/socket/executor：入口让出后 ${response} 的唤起语义`, async () => {
    const memberReply = latch()
    const deadline = Date.now() + 3600_000
    const f = await collaborationRuntime(`wait-${response}`, async call => {
      if (call.model === 'entry-model') {
        if (call.index === 0) return spawnMember
        if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-member', agents: [f.member()!.agentId], message: f.delegation()!.delegationId,
          expectation: '成员明确回应', deadline } }
        return { text: `入口已处理 ${response}` }
      }
      if (call.index === 0) {
        await memberReply.promise
        return { tool: 'agent_message', args: { action: 'respond', operationId: `response-${response}`, delegation: f.delegation()!.delegationId, response,
          reason: `MEMBER_${response}_REASON` } }
      }
      return { text: `成员已 ${response}` }
    })
    try {
      f.shell.key({ kind: 'paste', text: '展开回调兼容检查，等待成员明确回应。' }); f.shell.key({ kind: 'enter' })
      await f.wait('入口持久等待且已让出', () => {
        const work = f.collaboration()
        const waiting = work === undefined ? undefined : f.store.collaboration.listWaits(work.collaborationId).find(one => one.state === 'waiting')
        const run = f.manager.runs().find(one => one.session === f.session())
        return waiting !== undefined && run?.state === 'idle' && (run.lastTurnAt ?? 0) >= waiting.at
      })
      expect(f.requests()).toHaveLength(2)
      const processes = f.manager.executors()
      expect(processes).toHaveLength(2)
      expect(new Set(processes.map(one => one.pid)).size).toBe(2)
      expect(processes.every(one => one.pid !== undefined && one.pid !== process.pid)).toBe(true)
      memberReply.release()
      await f.wait('成员响应落库', () => f.delegation()?.state === (response === 'accept' ? 'accepted' : response === 'clarify' ? 'clarification' : 'rejected'))
      if (response === 'accept') {
        await f.wait('成员当轮结束', () => f.manager.runs().find(one => one.session === f.member()?.sessionId)?.state === 'idle')
        // 给所有已在 socket 上的回执充分到达；无信息的接受不能偷偷起入口模型。
        await Bun.sleep(350)
        expect(f.requests()).toHaveLength(2)
        expect(f.store.collaboration.listWaits(f.collaboration()!.collaborationId)[0]?.state).toBe('waiting')
      } else {
        await f.wait('入口由成员事件重新请求模型', () => f.requests().length >= 3)
        expect(requestText(f.requests()[2])).toContain(`MEMBER_${response}_REASON`)
        const waiting = f.store.collaboration.listWaits(f.collaboration()!.collaborationId)[0]!
        expect(waiting.state).not.toBe('waiting')
        expect(waiting.state).not.toBe('expired')
        expect(waiting.handledAt).toBeDefined()
        expect(Date.now()).toBeLessThan(deadline)
        await f.wait('入口处理结束', () => f.manager.runs().find(one => one.session === f.session())?.state === 'idle')
        await Bun.sleep(350)
        expect(f.requests()).toHaveLength(3)
      }
      expect(f.errors).toEqual([])
      expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    } finally { memberReply.release(); await f.close() }
  }, 30000)
}

for (const response of ['reject', 'accept'] as const) {
  test(`真实 manager/socket/executor：入口未登记 wait 且正文结束后 ${response} 的唤起语义`, async () => {
    const memberReply = latch()
    const initialText = '入口已说明当前进展，本轮正常结束，未登记等待。'
    const reason = 'NO_WAIT_REJECT_REASON：无法承担该范围，需要入口重新分配。'
    const f = await collaborationRuntime(`no-wait-${response}`, async call => {
      if (call.model === 'entry-model') {
        if (call.index === 0) return spawnMember
        return { text: call.index === 1 ? initialText : `入口已处理成员 ${response}` }
      }
      if (call.index === 0) {
        await memberReply.promise
        return { tool: 'agent_message', args: { action: 'respond', operationId: `response-${response}`, delegation: f.delegation()!.delegationId, response,
          ...(response === 'reject' ? { reason } : {}) } }
      }
      return { text: `成员已 ${response}` }
    })
    try {
      f.shell.key({ kind: 'paste', text: '分出回调检查，先说明进展。' }); f.shell.key({ kind: 'enter' })
      await f.wait('入口正文已正常结束并 idle，成员响应仍挂起', () => {
        const run = f.manager.runs().find(one => one.session === f.session())
        return f.requests().length === 2 && f.requests('member-model').length === 1 && run?.state === 'idle' &&
          f.events.some(one => one.kind === 'turn.end' && one.session === f.session() && one.data.reason === 'settled')
      })
      const work = f.collaboration()!
      const member = f.member()!
      expect(f.store.collaboration.listWaits(work.collaborationId)).toEqual([])
      expect((await Array.fromAsync(f.store.readEntries(work.originSessionId))).filter(one => one.kind === 'assistant').at(-1)?.content).toEqual({ text: initialText })
      expect(f.delegation()?.state).toBe('queued')
      expect(f.manager.executors()).toHaveLength(2)

      memberReply.release()
      await f.wait('成员响应已落库', () => f.delegation()?.state === (response === 'reject' ? 'rejected' : 'accepted'))
      await f.wait('成员响应当轮结束', () => f.manager.runs().find(one => one.session === member.sessionId)?.state === 'idle')
      if (response === 'reject') {
        await f.wait('无 wait 的入口因拒绝重新请求模型', () => f.requests().length >= 3)
        expect(requestText(f.requests()[2])).toContain(reason)
        await f.wait('入口处理拒绝后再次 idle', () => {
          const run = f.manager.runs().find(one => one.session === work.originSessionId)
          return run?.state === 'idle' && (run.lastTurnAt ?? 0) >= f.requests()[2]!.at
        })
      }
      // 留出已在途调度的观察窗口；不参与唤醒，也不把普通 accept 当成信息性回应。
      await Bun.sleep(350)
      expect(f.requests()).toHaveLength(response === 'reject' ? 3 : 2)
      expect(f.requests('member-model')).toHaveLength(2)
      expect(f.store.collaboration.listWaits(work.collaborationId)).toEqual([])
      expect(f.errors).toEqual([])
      expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    } finally { memberReply.release(); await f.close() }
  }, 30000)
}

test('成员工具审批在根 TUI 只有同一份，根窗口答复回成员并实际执行', async () => {
  const f = await collaborationRuntime('member-decision', call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '等待成员审查。' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    if (call.index === 1) return { tool: 'exec', args: { cmd: 'chmod 700 approved.sh' } }
    return { text: '成员审批操作已完成。' }
  })
  const path = join(f.workspace, 'approved.sh')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查并确认成员操作。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员 exec 待答到根窗口',()=>f.events.some(one=>one.kind==='tool.decision.request'&&one.data.name==='exec'))
    f.shell.key({kind:'ctrl+g'})
    await f.wait('成员 exec 审批到根窗口', () => {
      const dock = f.shell.getView().dock
      return dock.kind === 'decision' && dock.pending.name === 'exec'
    })
    const dock = f.shell.getView().dock
    if (dock.kind !== 'decision') throw new Error('审批没有展示')
    expect(dock.pending.member).toBe('实现')
    expect(f.shell.getView().sessionId).toBe(f.collaboration()!.originSessionId)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    f.client.send({ type: 'collaboration.read', member: f.member()!.agentId })
    await f.wait('主动查询后仍是同一张卡', () => f.events.filter(one => one.kind === 'tool.decision.request' && one.id === dock.pending.id).length >= 2)
    const requests = f.events.filter(one => one.kind === 'tool.decision.request' && one.data.name === 'exec')
    expect(new Set(requests.map(one => one.id)).size).toBe(1)
    expect(requests.every(one => one.session === f.member()!.sessionId)).toBe(true)
    f.shell.key({ kind: 'char', char: 'y' }); f.shell.key({ kind: 'char', char: 'y' })
    await f.wait('成员实际改完权限', () => (statSync(path).mode & 0o777) === 0o700)
    await f.wait('成员操作后的 HTTP 请求', () => f.requests('member-model').length >= 3)
    expect(f.commands.filter(one => one.type === 'decision.answer' && one.id === dock.pending.id)).toHaveLength(1)
    expect(f.events.filter(one => one.kind === 'tool.decision' && one.data.call === dock.pending.call && one.session === f.member()!.sessionId)).toHaveLength(1)
    expect(f.shell.getView().dock.kind).not.toBe('decision')
    expect(f.shell.getView().sessionId).toBe(f.collaboration()!.originSessionId)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { await f.close() }
}, 30000)

test('真实入口 detached 后根窗口保留成员审批、目标及草稿，答复仍回原成员', async () => {
  const rootReply = latch()
  const memberReply = latch()
  const f = await collaborationRuntime('window-detached-decision', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      await rootReply.promise
      return { text: '入口本轮结束，成员继续。' }
    }
    if (call.index === 0) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    if (call.index === 1) return { tool: 'exec', args: { cmd: 'chmod 700 approved.sh' } }
    return { text: '成员已收到原窗口答复并执行。' }
  })
  const path = join(f.workspace, 'approved.sh')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  const detached: string[] = []
  f.client.onDetached(why => detached.push(why))
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，入口本轮结束后保留成员操作。' }); f.shell.key({ kind: 'enter' })
    await f.wait('双方实际 HTTP 已进入受控屏障', () => f.requests().length === 2 && f.requests('member-model').length === 1)
    const origin = f.session()!
    const root = f.manager.executors().find(one => one.session === origin)!
    const member = f.member()!
    f.shell.key({ kind: 'paste', text: '整体保留原稿' })
    await f.openMember(); f.pick('input')
    f.shell.key({ kind: 'paste', text: '成员保留原稿 ' }); f.shell.key({ kind: 'char', char: '@' })
    await f.wait('真实文件引用候选', () => {
      const dock = f.shell.getView().dock
      return dock.kind === 'picker' && dock.picker.source === 'paths' && dock.picker.rows.some(one => one.value === path)
    })
    f.pick(path)
    const draft = f.shell.getView().draft
    const refs = f.shell.getView().refs
    memberReply.release()
    await f.wait('成员 chmod 待答提示',()=>f.events.some(one=>one.kind==='tool.decision.request'&&one.data.name==='exec'))
    f.shell.key({kind:'ctrl+g'})
    await f.wait('成员 chmod 待审批', () => { const dock = f.shell.getView().dock; return dock.kind === 'decision' && dock.pending.name === 'exec' })
    const dock = f.shell.getView().dock
    if (dock.kind !== 'decision') throw new Error('成员审批没有展示')
    rootReply.release()
    await f.wait('入口真实退出且窗口收到 detached', () => detached.length > 0 && f.processExits.some(one => one.pid === root.pid)
      && !f.manager.executors().some(one => one.session === origin))
    expect(f.manager.clients()).toBe(1)
    expect(f.shell.getView().sessionId).toBe(origin)
    expect(f.shell.getView().inputMember).toBe(member.agentId)
    // 审批接管输入时，原稿与引用保存在既有 stashed；答复后必须原样归还。
    expect(f.shell.getView().stashed).toMatchObject({ draft, refs })
    expect(f.shell.getView().dock).toMatchObject({ kind: 'decision', pending: { id: dock.pending.id, member: '实现' } })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    f.client.send({ type: 'collaboration.read', member: member.agentId })
    await f.wait('只读重发仍为原审批', () => f.events.filter(one => one.kind === 'tool.decision.request' && one.id === dock.pending.id).length >= 2)
    expect(f.manager.executors().some(one => one.session === origin)).toBe(false)
    f.shell.key({ kind: 'char', char: 'y' }); f.shell.key({ kind: 'char', char: 'y' })
    await f.wait('无入口 executor 时答复仍交成员执行', () => (statSync(path).mode & 0o777) === 0o700 && f.requests('member-model').length === 3)
    expect(f.commands.filter(one => one.type === 'decision.answer' && one.id === dock.pending.id)).toHaveLength(1)
    expect(f.events.filter(one => one.kind === 'tool.decision' && one.session === member.sessionId && one.data.call === dock.pending.call)).toHaveLength(1)
    expect(f.shell.getView().dock.kind).not.toBe('decision')
    expect(f.shell.getView().inputMember).toBe(member.agentId)
    expect(f.shell.getView().draft).toBe(draft)
    expect(f.shell.getView().refs).toEqual(refs)
    f.shell.key({ kind: 'tab' })
    await f.wait('返回整体目标选择', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    f.pick('whole')
    expect(f.shell.getView().draft).toBe('整体保留原稿')
    expect(f.shell.getView().inputMember).toBeUndefined()
    expect(f.requests()).toHaveLength(2)
    expect(f.manager.executors().some(one => one.session === origin)).toBe(false)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { rootReply.release(); memberReply.release(); await f.close() }
}, 30000)

test('审批等待期间发布共同约束：批准旧 chmod 后仍须重审，不能执行旧工具', async () => {
  const constraintText = 'APPROVAL_WINDOW_CONSTRAINT：保持 approved.sh 权限不变，先重新核对新要求。'
  const f = await collaborationRuntime('approval-shared-constraint', call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '共同要求已记录。' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    if (call.index === 1) return { tool: 'exec', args: { cmd: 'chmod 700 approved.sh' } }
    return { text: '已根据新要求重审，保持权限不变。' }
  })
  const path = join(f.workspace, 'approved.sh')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o600 })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查并确认成员操作。' }); f.shell.key({ kind: 'enter' })
    await f.wait('旧 chmod 待答',()=>f.events.some(one=>one.kind==='tool.decision.request'&&one.data.name==='exec'))
    f.shell.key({kind:'ctrl+g'})
    await f.wait('旧 chmod 已弹审批卡', () => {
      const dock = f.shell.getView().dock
      return dock.kind === 'decision' && dock.pending.name === 'exec'
    })
    const dock = f.shell.getView().dock
    if (dock.kind !== 'decision') throw new Error('旧工具没有进入审批等待')
    const member = f.member()!
    expect(f.requests('member-model')).toHaveLength(2)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    // 走根入口的真实控制命令；不直接写 records，也不在批准后才补约束。
    f.client.send({ type: 'collaboration.input', shared: true, input: { text: constraintText, ref: 'approval-window-constraint' } })
    await f.wait('共同约束已持久发布且成员尚未消费', () => {
      const constraint = f.store.collaboration.listConstraints(f.collaboration()!.collaborationId).at(-1)
      return constraint !== undefined && f.store.collaboration.inbox(member.agentId).some(one => one.messageId === constraint.messageId && one.state === 'pending')
    })
    const constraint = f.store.collaboration.listConstraints(f.collaboration()!.collaborationId).at(-1)!
    expect(f.store.collaboration.readMessage(member.agentId, constraint.messageId)?.userSource?.sessionId).toBe(f.session()!)
    expect(f.requests('member-model')).toHaveLength(2)
    const pending = f.shell.getView().dock
    expect(pending.kind === 'decision' && pending.pending.id).toBe(dock.pending.id)

    f.shell.key({ kind: 'char', char: 'y' })
    await f.wait('批准旧工具后的下一成员 HTTP 请求', () => f.requests('member-model').length >= 3)
    const nextRequest = requestText(f.requests('member-model')[2])
    expect(nextRequest).toContain(constraintText)
    expect(nextRequest).toContain('先重新判断，再执行工具')
    await f.wait('成员完成重审', () => f.manager.runs().find(one => one.session === member.sessionId)?.state === 'idle')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(f.requests('member-model')).toHaveLength(3)
    const result = (await Array.fromAsync(f.store.readEntries(member.sessionId))).findLast(one => one.kind === 'tool-result')
    expect(result?.payload).toMatchObject({ ok: false })
    expect(f.events.some(one => one.kind === 'tool.decision' && one.session === member.sessionId && one.data.call === dock.pending.call && one.data.decision === 'approve')).toBe(true)
    expect(f.store.collaboration.constraintStatus(constraint.messageId).find(one => one.agentId === member.agentId)?.state).toBe('included')
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 30000)

test('显式正常收尾：收下成员交付后仍能写最终正文，资源退出才 closed 且记录可读', async () => {
  const memberReply = latch()
  const finalReply = latch()
  const conclusion = 'DELIVERY_CONCLUSION：回调兼容已核验。'
  const finalText = 'FINAL_AFTER_CLOSE：已核验并收下成员结果，回调接口保持兼容。'
  const memberFinal = 'MEMBER_FINAL：产物、验证与未解决项已随交付保存。'
  const f = await collaborationRuntime('explicit-close', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-delivery', agents: [f.member()!.agentId], message: f.delegation()!.delegationId,
        expectation: '收到完整交付后核验收下', deadline: Date.now() + 3600_000 } }
      if (call.index === 2) return { tool: 'agent_message', args: { action: 'receive', delegation: f.delegation()!.delegationId } }
      if (call.index === 3) return { tool: 'agent_control', args: { action: 'close' } }
      if (call.index === 4) { await finalReply.promise; return { text: finalText } }
      throw new Error(`入口收尾后不应继续请求模型：${call.index}`)
    }
    if (call.index === 0) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    if (call.index === 1) return { tool: 'agent_message', args: { action: 'deliver', operationId: 'deliver', delegation: f.delegation()!.delegationId,
      conclusion, artifacts: ['callback-review.txt'], verified: ['DELIVERY_VERIFIED：核对回调参数与返回值'], unresolved: [] } }
    if (call.index === 2) return { text: memberFinal }
    throw new Error(`成员交付后不应继续请求模型：${call.index}`)
  })
  try {
    f.shell.key({ kind: 'paste', text: '展开检查，核验成员交付后显式收尾并给最终说明。' }); f.shell.key({ kind: 'enter' })
    await f.wait('入口已让出等待交付', () => f.collaboration() !== undefined &&
      f.store.collaboration.listWaits(f.collaboration()!.collaborationId).some(one => one.state === 'waiting') &&
      f.manager.runs().find(one => one.session === f.session())?.state === 'idle')
    const member = f.member()!
    const origin = f.session()!
    const pids = f.manager.executors().map(one => one.pid)
    expect(pids).toHaveLength(2)
    memberReply.release()
    await f.wait('close 后入口实际请求最终正文', () => f.requests().length === 5)
    await f.wait('成员完成交付正文', () => f.manager.runs().find(one => one.session === member.sessionId)?.state === 'idle')
    expect(requestText(f.requests()[2])).toContain(conclusion)
    expect(requestText(f.requests()[2])).toContain('DELIVERY_VERIFIED')
    expect(requestText(f.requests()[3])).toContain('received')
    expect(requestText(f.requests()[4])).toContain('已停止新派生')
    expect(f.delegation()?.state).toBe('received')
    expect(f.delegation()?.receivedAt).toBeDefined()
    expect(f.collaboration()?.state).toBe('closing')
    expect(f.manager.executors().map(one => one.pid)).toEqual(pids)
    expect(f.closedViews).toEqual([])

    finalReply.release()
    await f.wait('真实宿主完成收尾并推送 closed', () => f.closedViews.length > 0)
    expect(f.collaboration()?.state).toBe('closed')
    expect(f.manager.executors()).toEqual([])
    expect(f.members().every(one => one.reachability === 'historical')).toBe(true)
    expect(f.store.collaboration.listExecutions(f.collaboration()!.collaborationId).every(one => one.state === 'finished')).toBe(true)
    const originEntries = await Array.fromAsync(f.store.readEntries(origin))
    const memberEntries = await Array.fromAsync(f.store.readEntries(member.sessionId))
    expect(originEntries.filter(one => one.kind === 'assistant').at(-1)?.content).toEqual({ text: finalText })
    expect(memberEntries.filter(one => one.kind === 'assistant').at(-1)?.content).toEqual({ text: memberFinal })
    expect(originEntries.filter(one => one.kind === 'tool-call').map(one => one.payload)).toContainEqual({ name: 'agent_control', args: { action: 'close' } })
    expect(memberEntries.filter(one => one.kind === 'tool-result').map(one => one.payload)).toMatchObject([{ ok: true }, { ok: true }])

    // 关闭后仍经原 socket 查询完整成员记录；只读不重建执行者。
    f.client.send({ type: 'collaboration.read', member: member.agentId })
    await f.wait('关闭后成员完整记录仍可查询', () => f.events.some(one => one.kind === 'collaboration.view' && one.data.selectedMember === member.agentId && one.data.collaboration?.state === 'closed'))
    const read = f.events.findLast(one => one.kind === 'collaboration.view' && one.data.selectedMember === member.agentId)
    if (read?.kind !== 'collaboration.view') throw new Error('未返回关闭后的记录')
    expect(read.data.entries).toEqual(memberEntries)
    expect(read.data.messages?.map(one => one.purpose)).toEqual(expect.arrayContaining(['delegation', 'receipt', 'delivery']))
    expect(JSON.stringify(read.data.messages)).toContain(conclusion)
    expect(f.manager.executors()).toEqual([])
    expect(f.requests()).toHaveLength(5)
    expect(f.requests('member-model')).toHaveLength(3)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    // 按收到 closed 当时的退出事实裁决，不能用随后到达的 onExit 掩盖提前闭合。
    expect(f.closedViews.every(view => view.livePids.length === 0 && pids.every(pid => view.exitedPids.includes(pid)))).toBe(true)
  } finally { memberReply.release(); finalReply.release(); await f.close() }
}, 30000)

test('两个根 TUI 使用独立提交身份：成员材料拒收只回原窗口，草稿与引用不串', async () => {
  const f = await collaborationRuntime('member-input-ref', call => call.model === 'entry-model' && call.index === 0 ? spawnMember : { text: '本轮已停在可补充处。' })
  try {
    // 开场经真实 socket 发，不占用任一 TUI 的本地提交序号。
    f.client.send({ type: 'input.submit', text: '展开一份检查。' })
    await f.wait('根会话已开张', () => f.events.some(one => one.kind === 'message.user'))
    f.client.send({ type: 'session.list' })
    await f.wait('成员已建立且两端空闲', () => f.member() !== undefined && f.manager.runs().every(one => one.state === 'idle'))
    const second = await f.openWindow()
    const windows = [
      { shell: f.shell, events: f.events, commands: f.commands, label: '甲' },
      { ...second, label: '乙' },
    ]
    const held: { draft: string; refs: ReturnType<typeof f.shell.getView>['refs']; file: string }[] = []
    for (const window of windows) {
      const path = join(f.workspace, `${window.label}-ref.txt`)
      writeFileSync(path, '提交前可读的材料')
      window.shell.key({ kind: 'paste', text: `整体${window.label}尚未提交的草稿` })
      await f.openMember(window.shell); f.pick('input', window.shell)
      window.shell.key({ kind: 'paste', text: `成员${window.label}核对 ` }); window.shell.key({ kind: 'char', char: '@' })
      await f.wait('真实文件候选', () => { const dock = window.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'paths' && dock.picker.rows.some(one => one.value === path) })
      f.pick(path, window.shell)
      held.push({ draft: window.shell.getView().draft, refs: window.shell.getView().refs, file: `${window.label}-ref.txt` })
      unlinkSync(path)
    }
    const before = f.calls.length
    // 不在两次发送之间 await：制造两个 socket 上同名 ref 都在途的窗口。
    for (const window of windows) window.shell.key({ kind: 'enter' })
    for (const [index, window] of windows.entries()) {
      const command = window.commands.findLast(one => one.type === 'collaboration.input')
      if (command?.type !== 'collaboration.input') throw new Error('没有发送成员输入')
      expect(command.input.ref).toBeString()
      const submittedRef=command.input.ref!
      await f.wait('原窗口的 draft-1 失败回执', () => window.events.some(one => one.kind === 'input.settled' && !one.data.ok && one.data.ref === submittedRef))
      const settled = window.events.filter(one => one.kind === 'input.settled').filter(one=>one.data.ref===submittedRef&&!one.data.ok)
      expect(settled).toHaveLength(1)
      const result = settled[0]!.data
      expect(result.ref).toBe(submittedRef)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(held[index]!.file)
      expect(window.shell.getView().draft).toBe(held[index]!.draft)
      expect(window.shell.getView().refs).toEqual(held[index]!.refs)
      window.shell.key({ kind: 'tab' })
      await f.wait('回到协作列表', () => { const dock = window.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
      f.pick('whole', window.shell)
      expect(window.shell.getView().draft).toBe(`整体${window.label}尚未提交的草稿`)
      expect(window.shell.getView().inputMember).toBeUndefined()
    }
    expect(f.calls).toHaveLength(before)
    // 接收后再做一趟真实查询，确保没有迟到的另一窗口回执广播过来。
    f.client.send({ type: 'collaboration.read' })
    await Bun.sleep(100)
    for (const window of windows) expect(window.events.filter(one => one.kind === 'input.settled'&&!one.data.ok)).toHaveLength(1)
    const refs=windows.map(window=>window.commands.findLast(one=>one.type==='collaboration.input')).map(one=>one?.type==='collaboration.input'?one.input.ref:undefined)
    expect(new Set(refs).size).toBe(2)
  } finally { await f.close() }
}, 30000)

for (const response of ['clarify', 'reject'] as const) {
  test(`无 TUI 且入口进程已退出：成员 ${response} 经同一宿主唤回新代入口`, async () => {
    const memberReply = latch()
    const rootReply = latch()
    const deadline = Date.now() + 3600_000
    const reason = `NO_TUI_${response}_REASON：需要入口核对当前委派。`
    const finalText = `新代入口已处理 ${response}，等待用户后续安排。`
    const f = await collaborationRuntime(`no-tui-${response}`, async call => {
      if (call.model === 'entry-model') {
        if (call.index === 0) return spawnMember
        if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-member', agents: [f.member()!.agentId],
          message: f.delegation()!.delegationId, expectation: '等待成员明确回应', deadline } }
        await rootReply.promise
        return { text: finalText }
      }
      if (call.index === 0) {
        await memberReply.promise
        return { tool: 'agent_message', args: { action: 'respond', operationId: `response-${response}`, delegation: f.delegation()!.delegationId, response, reason } }
      }
      return { text: `成员已 ${response}` }
    // 本例只运行受控协作工具，显式采用生产全放行开关；关闭窗口后没有隐藏审批客户端。
    }, { allowAll: true })
    try {
      f.shell.key({ kind: 'paste', text: '分出检查并等待成员，关闭窗口后仍需承接明确回应。' }); f.shell.key({ kind: 'enter' })
      await f.wait('入口持久等待且已让出', () => {
        const work = f.collaboration()
        const waiting = work === undefined ? undefined : f.store.collaboration.listWaits(work.collaborationId).find(one => one.state === 'waiting')
        const run = f.manager.runs().find(one => one.session === f.session())
        return waiting !== undefined && run?.state === 'idle' && (run.lastTurnAt ?? 0) >= waiting.at
      })
      const work = f.collaboration()!
      const identity = f.manager.identity
      const waiting = f.store.collaboration.listWaits(work.collaborationId)[0]!
      const original = f.manager.executors().find(one => one.session === work.originSessionId)!
      expect(original.pid).toBeDefined()
      expect(original.pid).not.toBe(process.pid)
      f.closeWindows()
      await f.wait('全部窗口关闭且入口真实 onExit 后已无 executor', () => f.manager.clients() === 0 &&
        f.processExits.some(one => one.pid === original.pid) && !f.manager.executors().some(one => one.session === work.originSessionId))
      expect(f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)?.state).toBe('waiting')
      await Bun.sleep(350)
      expect(f.requests()).toHaveLength(2)
      expect(f.manager.clients()).toBe(0)

      memberReply.release()
      await f.wait('无窗口的同一宿主启动新代入口 HTTP', () => f.requests().length >= 3)
      const resumed = f.manager.executors().find(one => one.session === work.originSessionId)!
      expect(resumed.gen).not.toBe(original.gen)
      expect(resumed.pid).toBeDefined()
      expect(resumed.pid).not.toBe(original.pid)
      expect(f.manager.identity).toEqual(identity)
      expect(f.manager.clients()).toBe(0)
      expect(requestText(f.requests()[2])).toContain(reason)
      const handled = f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)!
      expect(handled.state).not.toBe('waiting')
      expect(handled.state).not.toBe('expired')
      expect(handled.handledAt).toBeDefined()
      expect(Date.now()).toBeLessThan(deadline)
      rootReply.release()
      await f.wait('新代入口最终正文持久化', async () => (await Array.fromAsync(f.store.readEntries(work.originSessionId)))
        .some(one => one.kind === 'assistant' && 'text' in one.content && one.content.text === finalText))
      await f.wait('新代入口结束后也实际释放', () => f.processExits.some(one => one.pid === resumed.pid) &&
        !f.manager.executors().some(one => one.session === work.originSessionId))
      expect(f.requests()).toHaveLength(3)
      expect(f.manager.clients()).toBe(0)
      expect(f.errors).toEqual([])
      expect((await Array.fromAsync(f.store.serviceFor(work.originSessionId).readEvents(work.originSessionId))).filter(one => one.kind === 'error')).toEqual([])
    } finally { memberReply.release(); rootReply.release(); await f.close() }
  }, 30000)
}

test('生产 shell.hangUp 关窗不停止协作：持久 wait 保留，成员回应唤回无窗口入口', async () => {
  const informReply = latch()
  const closingReply = latch()
  const memberReply = latch()
  const resumedReply = latch()
  const deadline = Date.now() + 3600_000
  const inform = 'HANGUP_INFORM：当前检查仍在进行，先告知入口进展。'
  const reason = 'HANGUP_CLARIFY：需要入口补充回调边界。'
  const finalText = '关窗后的新代入口已处理成员澄清。'
  const f = await collaborationRuntime('no-tui-hangup', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { tool: 'agent_wait', args: { operationId: 'wait-member', agents: [f.member()!.agentId],
        message: f.delegation()!.delegationId, expectation: '等待成员明确回应', deadline } }
      if (call.index === 2) { await closingReply.promise; return { text: '已阅进展，原委派继续等待。' } }
      await resumedReply.promise
      return { text: finalText }
    }
    if (call.index === 0) {
      await informReply.promise
      return { tool: 'agent_message', args: { action: 'send', operationId: 'inform-entry', recipients: [f.collaboration()!.coordinatorId],
        purpose: 'inform', body: [{ kind: 'text', text: inform }] } }
    }
    if (call.index === 1) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'clarify-after-window-close', delegation: f.delegation()!.delegationId,
        response: 'clarify', reason } }
    }
    return { text: '成员已向无窗口入口提出澄清。' }
  }, { allowAll: true })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，等待成员回应；关闭窗口只离开界面。' }); f.shell.key({ kind: 'enter' })
    await f.wait('入口持久等待且已让出', () => {
      const work = f.collaboration()
      const waiting = work === undefined ? undefined : f.store.collaboration.listWaits(work.collaborationId).find(one => one.state === 'waiting')
      const run = f.manager.runs().find(one => one.session === f.session())
      return waiting !== undefined && run?.state === 'idle' && (run.lastTurnAt ?? 0) >= waiting.at
    })
    const work = f.collaboration()!
    const identity = f.manager.identity
    const waiting = f.store.collaboration.listWaits(work.collaborationId)[0]!
    informReply.release()
    await f.wait('inform 唤起真实 HTTP，原 wait 尚未解除', () => f.requests().length === 3 && f.requests('member-model').length === 2
      && f.shell.getView().status.state === 'working')
    expect(requestText(f.requests()[2])).toContain(inform)
    expect(f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)?.state).toBe('waiting')
    const original = f.manager.executors().find(one => one.session === work.originSessionId)!
    expect(original.pid).toBeDefined()
    const before = f.commands.length
    // U100 起 `Shell.hangUp` 已删（终端离开不再问外壳——那一问没有了对象）。
    // 「离开只脱离、不中断工作」这条判据改由**真实关窗**来验；不冒充 PTY SIGHUP 或 App 包关窗。
    f.closeWindows()
    closingReply.release()
    await f.wait('窗口关闭且原入口真实退出后无 executor', () => f.manager.clients() === 0 && f.processExits.some(one => one.pid === original.pid)
      && !f.manager.executors().some(one => one.session === work.originSessionId))
    expect({ commands: f.commands.slice(before), collaboration: f.collaboration()?.state,
      wait: f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)?.state })
      .toEqual({ commands: [], collaboration: 'open', wait: 'waiting' })
    expect(f.requests()).toHaveLength(3)

    memberReply.release()
    await f.wait('成员回应使无窗口入口发起新代 HTTP', () => f.requests().length >= 4)
    const resumed = f.manager.executors().find(one => one.session === work.originSessionId)!
    expect(resumed.gen).not.toBe(original.gen)
    expect(resumed.pid).toBeDefined()
    expect(resumed.pid).not.toBe(original.pid)
    expect(f.manager.identity).toEqual(identity)
    expect(f.manager.clients()).toBe(0)
    expect(requestText(f.requests()[3])).toContain(reason)
    const handled = f.store.collaboration.listWaits(work.collaborationId).find(one => one.waitId === waiting.waitId)!
    expect(handled.state).not.toBe('waiting')
    expect(handled.state).not.toBe('expired')
    expect(handled.handledAt).toBeDefined()
    expect(Date.now()).toBeLessThan(deadline)
    resumedReply.release()
    await f.wait('新代入口正文落库且真实释放', async () => f.processExits.some(one => one.pid === resumed.pid)
      && !f.manager.executors().some(one => one.session === work.originSessionId)
      && (await Array.fromAsync(f.store.readEntries(work.originSessionId))).some(one => one.kind === 'assistant' && 'text' in one.content && one.content.text === finalText))
    expect(f.requests()).toHaveLength(4)
    expect(f.manager.clients()).toBe(0)
    expect(f.errors).toEqual([])
  } finally { informReply.release(); closingReply.release(); memberReply.release(); resumedReply.release(); await f.close() }
}, 30000)

test('共同补充的原文、文件引用与图片字节进入入口和成员下一次实际 HTTP 请求', async () => {
  const f = await collaborationRuntime('shared-input-refs', call => {
    if (call.model === 'entry-model' && call.index === 0) return spawnMember
    if (call.model === 'member-model' && call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    return { text: '已核对当前要求。' }
  })
  const path = join(f.workspace, 'shared.txt')
  writeFileSync(path, 'SHARED_CURRENT_MATERIAL')
  try {
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jF9kAAAAASUVORK5CYII=', 'base64')
    const image = await f.store.blobs.put(imageBytes)
    f.shell.key({ kind: 'paste', text: '展开并分别核对回调。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员接受后双方空闲', () => f.delegation()?.state === 'accepted' && f.manager.runs().every(one => one.state === 'idle'))
    const originCount = f.requests().length
    const memberCount = f.requests('member-model').length
    const text = '先读 @shared.txt，对照 Image#1，再保持公共接口兼容。'
    const ref = 'shared-original-ref'
    f.client.send({ type: 'collaboration.input', shared: true, input: { text, ref, refs: [
      { kind: 'file', at: text.indexOf('@'), marker: '@shared.txt', source: path },
      { kind: 'image', at: text.indexOf('Image#1'), marker: 'Image#1', source: join(f.workspace, 'saved.png'), label: '用户选定图片', name: 'saved.png', mime: 'image/png', blob: image },
    ] } })
    await f.wait('共同补充原 ref 已接收', () => f.events.some(one => one.kind === 'input.settled' && one.data.ok && one.data.ref === ref))
    await f.wait('双方都发出含补充的新 HTTP 请求', () => f.requests().length > originCount && f.requests('member-model').length > memberCount)
    for (const request of [f.requests()[originCount], f.requests('member-model')[memberCount]]) {
      // 文件按 U63 保留原位引用供模型自读；图片必须把已保存字节实际送到 HTTP。
      expect(requestText(request)).toContain(`data:image/png;base64,${imageBytes.toString('base64')}`)
      expect(requestText(request)).toContain('保持公共接口兼容')
      expect(requestText(request)).toContain('@shared.txt')
    }
    const user = (await Array.fromAsync(f.store.readEntries(f.session()!))).findLast(one => one.kind === 'user')!
    expect(user.content).toEqual({ text })
    expect(user.payload).toMatchObject({ refs: [
      { kind: 'file', at: text.indexOf('@'), marker: '@shared.txt', source: path },
      { kind: 'image', at: text.indexOf('Image#1'), marker: 'Image#1', blob: image },
    ] })
    const constraint = f.store.collaboration.listConstraints(f.collaboration()!.collaborationId).at(-1)!
    expect(f.store.collaboration.readMessage(f.member()!.agentId, constraint.messageId)?.userSource).toEqual({ sessionId: f.session()!, entryId: user.id })
    expect(f.store.collaboration.constraintStatus(constraint.messageId)).toHaveLength(2)
    await f.wait('共同约束已带入两端请求', () => f.store.collaboration.constraintStatus(constraint.messageId).every(one => one.state === 'included'))
    await f.wait('双方处理补充后空闲', () => f.manager.runs().every(one => one.state === 'idle'))
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { await f.close() }
}, 30000)
