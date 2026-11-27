import { expect, test } from 'bun:test'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { collaborationRuntime, latch, requestText, spawnMember } from './run-collaboration-fixture.ts'

for (const response of ['clarify', 'reject', 'accept'] as const) {
  test(`真实 manager/socket/executor：入口让出后 ${response} 的唤起语义`, async () => {
    const memberReply = latch()
    const f = await collaborationRuntime(`yield-${response}`, async call => {
      if (call.model === 'entry-model') {
        if (call.index === 0) return spawnMember
        return { text: `入口已让出，等待成员 ${response}` }
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
      await f.wait('入口正文结束即让出', () => {
        const run = f.manager.runs().find(one => one.session === f.session())
        return f.requests().length === 2 && run?.state === 'idle'
      })
      const processes = f.manager.executors()
      expect(processes).toHaveLength(2)
      expect(new Set(processes.map(one => one.gen)).size).toBe(2)
      expect(processes.every(one => one.gen !== undefined)).toBe(true)
      memberReply.release()
      await f.wait('成员响应落库', () => f.delegation()?.state === (response === 'accept' ? 'accepted' : response === 'clarify' ? 'clarification' : 'rejected'))
      if (response === 'accept') {
        await f.wait('成员当轮结束', () => f.manager.runs().find(one => one.session === f.member()?.sessionId)?.state === 'idle')
        await Bun.sleep(350)
        expect(f.requests()).toHaveLength(2)
      } else {
        await f.wait('入口由成员决定消息重新请求模型', () => f.requests().length >= 3)
        expect(requestText(f.requests()[2])).toContain(`MEMBER_${response}_REASON`)
        await f.wait('入口处理结束', () => f.manager.runs().find(one => one.session === f.session())?.state === 'idle')
        await Bun.sleep(350)
        expect(f.requests()).toHaveLength(3)
      }
      expect(f.errors).toEqual([])
      expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    } finally { memberReply.release(); await f.close() }
  }, 30000)

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
          ...(response === 'accept' ? {} : { reason }) } }
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
      expect((await Array.fromAsync(f.store.readEntries(work.originSessionId))).filter(one => one.kind === 'assistant').at(-1)?.content).toEqual({ text: initialText })
      expect(f.delegation()?.state).toBe('queued')
      expect(f.manager.executors()).toHaveLength(2)

      memberReply.release()
      await f.wait('成员响应已落库', () => f.delegation()?.state === (response === 'reject' ? 'rejected' : response === 'clarify' ? 'clarification' : 'accepted'))
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
      expect(f.requests()).toHaveLength(response === 'accept' ? 2 : 3)
      expect(f.requests('member-model')).toHaveLength(2)
      expect(f.errors).toEqual([])
      expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    } finally { memberReply.release(); await f.close() }
  }, 30000)
}

test('显式正常收尾：收下成员交付后仍能写最终正文，资源退出才 closed 且记录可读', async () => {
  const memberReply = latch()
  const finalReply = latch()
  const conclusion = 'DELIVERY_CONCLUSION：回调兼容已核验。'
  const finalText = 'FINAL_AFTER_CLOSE：已核验并收下成员结果，回调接口保持兼容。'
  const memberFinal = 'MEMBER_FINAL：产物、验证与未解决项已随交付保存。'
  const f = await collaborationRuntime('explicit-close', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { text: '已派出，等成员交付后唤醒我。' }
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
    await f.wait('入口正文结束即让出', () => f.collaboration() !== undefined &&
      f.manager.runs().find(one => one.session === f.session())?.state === 'idle' && f.requests().length === 2)
    const member = f.member()!
    const origin = f.session()!
    const pids = f.manager.executors().map(one => one.gen)
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
    expect(f.manager.executors().map(one => one.gen)).toEqual(pids)
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
    expect(originEntries.filter(one => one.kind === 'tool-call').map(one => one.payload)).toContainEqual({ id: expect.any(String), name: 'agent_control', args: { action: 'close' } })
    expect(memberEntries.filter(one => one.kind === 'tool-result').map(one => one.payload)).toMatchObject([{ ok: true }, { ok: true }])

    // 关闭后仍可进入这条子会话查看完整正文；只读不重建执行者。
    await f.openMember()
    const memberView = f.shell.getView()
    expect(memberView.sessionId).toBe(member.sessionId)
    expect(memberView.collaboration?.collaboration?.state).toBe('closed')
    const transcript = [...memberView.settled, ...memberView.rows]
    expect(transcript.some(one => one.kind === 'assistant' && one.text.includes(memberFinal))).toBe(true)
    expect(transcript.some(one => one.key.startsWith('am:'))).toBe(true)
    expect(JSON.stringify(memberView.messages)).toContain(conclusion)
    expect(f.manager.executors()).toEqual([])
    expect(f.requests()).toHaveLength(5)
    expect(f.requests('member-model')).toHaveLength(3)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
    // 按收到 closed 当时的退出事实裁决，不能用随后到达的 onExit 掩盖提前闭合。
    expect(f.closedViews.every(view => view.liveGenerations.length === 0 && pids.every(pid => view.exitedGenerations.includes(pid)))).toBe(true)
  } finally { memberReply.release(); finalReply.release(); await f.close() }
}, 30000)

test('两个根 TUI：成员材料拒收只回原窗口；第二读者写入被只读闸门拒，草稿与引用不串', async () => {
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
      await f.openMember(window.shell)
      window.shell.key({ kind: 'paste', text: `成员${window.label}核对 ` }); window.shell.key({ kind: 'char', char: '@' })
      await f.wait('真实文件候选', () => { const dock = window.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'paths' && dock.picker.rows.some(row => row.value === path) }, 30000)
      f.pick(path, window.shell)
      held.push({ draft: window.shell.getView().draft, refs: window.shell.getView().refs, file: `${window.label}-ref.txt` })
      unlinkSync(path)
    }
    const before = f.calls.length
    const first = windows[0]!, secondWindow = windows[1]!
    // 甲先占写者位提交：文件已删 → 材料拒收回执只回原窗口。
    first.shell.key({ kind: 'enter' })
    const command = first.commands.findLast(one => one.type === 'collaboration.input')
    if (command?.type !== 'collaboration.input') throw new Error('没有发送成员输入')
    expect(command.input.ref).toBeString()
    const submittedRef = command.input.ref!
    await f.wait('原窗口的 draft-1 失败回执', () => first.events.some(one => one.kind === 'input.settled' && !one.data.ok && one.data.ref === submittedRef))
    const settled = first.events.filter(one => one.kind === 'input.settled').filter(one => one.data.ref === submittedRef && !one.data.ok)
    expect(settled).toHaveLength(1)
    const result = settled[0]!.data
    expect(result.ref).toBe(submittedRef)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(held[0]!.file)
    expect(first.shell.getView().draft).toBe(held[0]!.draft)
    expect(first.shell.getView().refs).toEqual(held[0]!.refs)
    first.shell.key({ kind: 'tab' })
    await f.wait('回到协作列表', () => { const dock = first.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    f.pick('whole', first.shell)
    await f.wait('回到入口会话', () => first.shell.getView().sessionId === f.collaboration()?.originSessionId)
    expect(first.shell.getView().draft).toBe('整体甲尚未提交的草稿')
    expect(first.shell.getView().inputMember).toBeUndefined()
    // 乙是第二读者（单写者边界）：写入被只读闸门拒——没有回执事件、成员账本无新行，
    // 甲的拒收回执也不串进乙；乙的草稿不含甲的正文。
    expect(secondWindow.events.filter(one => one.kind === 'input.settled' && !one.data.ok)).toHaveLength(0)
    expect(secondWindow.events.filter(one => one.kind === 'input.settled' && one.data.ok).length).toBeLessThanOrEqual(1)
    expect(secondWindow.shell.getView().draft).not.toContain('整体甲')
    expect(f.calls).toHaveLength(before)
    // 接收后再做一趟真实查询，确保没有迟到的另一窗口回执广播过来。
    f.client.send({ type: 'collaboration.read' })
    await Bun.sleep(100)
    expect(first.events.filter(one => one.kind === 'input.settled' && !one.data.ok)).toHaveLength(1)
  } finally { await f.close() }
}, 30000)

for (const response of ['clarify', 'reject'] as const) {
  test(`无 TUI 且入口进程已退出：成员 ${response} 经同一宿主唤回新代入口`, async () => {
    const memberReply = latch()
    const rootReply = latch()
    const reason = `NO_TUI_${response}_REASON：需要入口核对当前委派。`
    const finalText = `新代入口已处理 ${response}，等待用户后续安排。`
    const f = await collaborationRuntime(`no-tui-${response}`, async call => {
      if (call.model === 'entry-model') {
        if (call.index === 0) return spawnMember
        if (call.index === 1) return { text: '已派出，等成员明确回应后唤醒我。' }
        await rootReply.promise
        return { text: finalText }
      }
      if (call.index === 0) {
        await memberReply.promise
        return { tool: 'agent_message', args: { action: 'respond', operationId: `response-${response}`, delegation: f.delegation()!.delegationId, response, reason } }
      }
      return { text: `成员已 ${response}` }
    // 本例只运行受控协作工具，显式采用生产全放行开关；关闭窗口后没有隐藏审批客户端。
    })
    try {
      f.shell.key({ kind: 'paste', text: '分出检查并等待成员，关闭窗口后仍需承接明确回应。' }); f.shell.key({ kind: 'enter' })
      await f.wait('入口正文结束即让出', () => {
        const run = f.manager.runs().find(one => one.session === f.session())
        return f.requests().length === 2 && run?.state === 'idle'
      })
      const work = f.collaboration()!
      const identity = f.manager.identity
      const original = f.manager.executors().find(one => one.session === work.originSessionId)!
      expect(original.gen).toBeDefined()
      f.closeWindows()
      await f.wait('全部窗口关闭且入口真实 onExit 后已无 executor', () => f.manager.clients() === 0 &&
        f.agentExits.some(one => one.gen === original.gen) && !f.manager.executors().some(one => one.session === work.originSessionId))
      await Bun.sleep(350)
      expect(f.requests()).toHaveLength(2)
      expect(f.manager.clients()).toBe(0)

      memberReply.release()
      await f.wait('无窗口的同一宿主启动新代入口 HTTP', () => f.requests().length >= 3)
      const resumed = f.manager.executors().find(one => one.session === work.originSessionId)!
      expect(resumed.gen).not.toBe(original.gen)
      expect(resumed.gen).toBeDefined()
      expect(resumed.gen).not.toBe(original.gen)
      expect(f.manager.identity).toEqual(identity)
      expect(f.manager.clients()).toBe(0)
      expect(requestText(f.requests()[2])).toContain(reason)
      rootReply.release()
      await f.wait('新代入口最终正文持久化', async () => (await Array.fromAsync(f.store.readEntries(work.originSessionId)))
        .some(one => one.kind === 'assistant' && 'text' in one.content && one.content.text === finalText))
      await f.wait('新代入口结束后也实际释放', () => f.agentExits.some(one => one.gen === resumed.gen) &&
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
  const inform = 'HANGUP_INFORM：当前检查仍在进行，先告知入口进展。'
  const reason = 'HANGUP_CLARIFY：需要入口补充回调边界。'
  const finalText = '关窗后的新代入口已处理成员澄清。'
  const f = await collaborationRuntime('no-tui-hangup', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return spawnMember
      if (call.index === 1) return { text: '已派出，等成员回应后继续。' }
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
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，等待成员回应；关闭窗口只离开界面。' }); f.shell.key({ kind: 'enter' })
    await f.wait('入口正文结束即让出', () => {
      const run = f.manager.runs().find(one => one.session === f.session())
      return f.requests().length === 2 && run?.state === 'idle'
    })
    const work = f.collaboration()!
    const identity = f.manager.identity
    informReply.release()
    await f.wait('inform 消息唤起真实 HTTP', () => f.requests().length === 3 && f.requests('member-model').length === 2
      && f.shell.getView().status.state === 'working')
    expect(requestText(f.requests()[2])).toContain(inform)
    const original = f.manager.executors().find(one => one.session === work.originSessionId)!
    expect(original.gen).toBeDefined()
    const before = f.commands.length
    // U100 起 `Shell.hangUp` 已删（终端离开不再问外壳——那一问没有了对象）。
    // 「离开只脱离、不中断工作」这条判据改由**真实关窗**来验；不冒充 PTY SIGHUP 或 App 包关窗。
    f.closeWindows()
    closingReply.release()
    await f.wait('窗口关闭且原入口真实退出后无 executor', () => f.manager.clients() === 0 && f.agentExits.some(one => one.gen === original.gen)
      && !f.manager.executors().some(one => one.session === work.originSessionId))
    expect({ commands: f.commands.slice(before), collaboration: f.collaboration()?.state })
      .toEqual({ commands: [], collaboration: 'open' })
    expect(f.requests()).toHaveLength(3)

    memberReply.release()
    await f.wait('成员回应使无窗口入口发起新代 HTTP', () => f.requests().length >= 4)
    const resumed = f.manager.executors().find(one => one.session === work.originSessionId)!
    expect(resumed.gen).not.toBe(original.gen)
    expect(resumed.gen).toBeDefined()
    expect(resumed.gen).not.toBe(original.gen)
    expect(f.manager.identity).toEqual(identity)
    expect(f.manager.clients()).toBe(0)
    expect(requestText(f.requests()[3])).toContain(reason)
    resumedReply.release()
    await f.wait('新代入口正文落库且真实释放', async () => f.agentExits.some(one => one.gen === resumed.gen)
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

test('U130：成员运行中切进子会话，正文实时追加；返回入口不断连、草稿各自保留', async () => {
  const memberReply = latch()
  const f = await collaborationRuntime('subsession-switch', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口本轮结束。' }
    if (call.index === 0) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    return { text: '成员正在检查回调。' }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，成员先跑起来。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员执行中', () => f.member() !== undefined
      && f.manager.runs().find(one => one.session === f.member()!.sessionId)?.state === 'running')
    f.shell.key({ kind: 'paste', text: '入口草稿' })
    const origin = f.session()!
    const memberSession = f.member()!.sessionId

    // 运行中 Tab → 协作列表 → Enter：进的是完整子会话，不是阅读器。
    await f.openMember()
    expect(f.shell.getView().sessionId).toBe(memberSession)
    expect(f.shell.getView().draft).toBe('')
    expect(f.shell.getView().inputMember).toBeUndefined()

    memberReply.release()
    await f.wait('子会话正文实时追加', () => [...f.shell.getView().settled, ...f.shell.getView().rows]
      .some(row => row.kind === 'assistant' && row.text.includes('成员正在检查回调')))

    // 子会话里再开列表：当前子会话不在；主会话预选，Enter 返回。
    f.shell.key({ kind: 'tab' })
    await f.wait('子会话的协作列表', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    const dock = f.shell.getView().dock
    if (dock.kind !== 'picker') throw new Error('没有协作列表')
    const coordinator = f.store.collaboration.collaborationForSession(memberSession)!.coordinatorId
    expect(dock.picker.rows.some(row => row.value === f.member()!.agentId)).toBe(false)
    expect(dock.picker.rows[dock.picker.selected]?.value).toBe(coordinator)
    f.pick(coordinator)
    await f.wait('返回入口会话', () => f.shell.getView().sessionId === origin)
    expect(f.shell.getView().draft).toBe('入口草稿')
    expect(f.manager.clients()).toBe(1)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { memberReply.release(); await f.close() }
}, 30000)

test('D68：入口与子会话往返不重连、不复用当前会话当成员、不重放请求', async () => {
  const memberReply = latch()
  const f = await collaborationRuntime('d68-round-trip', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口本轮结束。' }
    if (call.index === 0) {
      await memberReply.promise
      return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    }
    return { text: '成员结果。' }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，切换期间成员保持运行。' }); f.shell.key({ kind: 'enter' })
    await f.wait('入口会话已开张', () => f.session() !== null)
    const origin = f.session()!
    // 等入口这一轮自己收束（它的第二次调用），成员停在受控屏障上；此后切屏不该再发请求。
    await f.wait('入口空闲、成员在跑', () => f.member() !== undefined
      && f.requests().length === 2 && f.requests('member-model').length === 1
      && f.manager.runs().find(one => one.session === origin)?.state === 'idle')
    const member = f.member()!
    const calls = f.calls.length
    const clients = f.manager.clients()

    await f.openMember()
    expect(f.shell.getView().sessionId).toBe(member.sessionId)
    // 管理侧保护：把当前子会话自身当成员读，不重读、不重发它的完整历史。
    const viewsBefore = f.events.filter(one => one.kind === 'collaboration.view').length
    f.client.send({ type: 'collaboration.read', member: member.agentId })
    await f.wait('自读回执', () => f.events.filter(one => one.kind === 'collaboration.view').length > viewsBefore)
    const views = f.events.flatMap(one => one.kind === 'collaboration.view' ? [one.data] : [])
    expect(views.filter(view => view.entries !== undefined)).toEqual([])
    expect(views.every(view => view.selectedMember === undefined)).toBe(true)

    // 返回入口：同一条连接、成员仍在跑、切换本身不触发模型调用。
    f.shell.key({ kind: 'tab' })
    await f.wait('子会话列表', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    f.pick(f.collaboration()!.coordinatorId)
    await f.wait('返回入口', () => f.shell.getView().sessionId === origin)
    expect(f.manager.clients()).toBe(clients)
    expect(f.calls.length).toBe(calls)
    expect(f.manager.runs().some(one => one.session === member.sessionId)).toBe(true)

    // 再往返一次：记录行键不重复（不因打开子会话重发或叠行）。
    await f.openMember()
    f.shell.key({ kind: 'tab' })
    await f.wait('再次打开子会话列表', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    f.pick(f.collaboration()!.coordinatorId)
    await f.wait('再次返回入口', () => f.shell.getView().sessionId === origin)
    const rows = [...f.shell.getView().settled, ...f.shell.getView().rows]
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { memberReply.release(); await f.close() }
}, 30000)

test('U130：子会话里的模型入口只改该成员的身份与执行者', async () => {
  const f = await collaborationRuntime('subsession-model', call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口本轮结束。' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    return { text: '成员已完成。' }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，随后在子会话里换模型。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员接受并空闲', () => f.delegation()?.state === 'accepted'
      && f.manager.runs().every(one => one.state === 'idle'))
    const member = f.member()!
    const coordinator = f.members().find(one => one.agentId === f.collaboration()!.coordinatorId)!
    expect(member.model.model).toBe('member-model')
    await f.openMember()

    f.shell.key({ kind: 'paste', text: '/model ' }); f.shell.key({ kind: 'enter' })
    await f.wait('模型档位切换器', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'model-choice' })
    f.pick('arcane')
    await f.wait('成员身份已换档', () => f.store.collaboration.getAgent(member.agentId)?.model.model === 'descendant-model')
    expect(f.store.collaboration.getAgent(coordinator.agentId)?.model.model).toBe('entry-model')
    expect(f.commands.filter(one => one.type === 'collaboration.configure')).toEqual([
      expect.objectContaining({ type: 'collaboration.configure', member: member.agentId, model: { choice: 'arcane' } }),
    ])
    expect(f.commands.some(one => one.type === 'model.switch')).toBe(false)

    // 下一次成员请求实际用新档；入口仍是自己的模型。
    f.shell.key({ kind: 'paste', text: '换档后再做一步。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员用新档请求', () => f.requests('descendant-model').length >= 1)
    // 换档后不再用旧成员档；入口仍走自己的档。
    expect(f.requests('member-model')).toHaveLength(2)
    expect(f.calls.length).toBeGreaterThanOrEqual(3)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { await f.close() }
}, 30000)

test('U130：子会话的标准停止只停这份委派及其派生闭包，整件工作仍开放', async () => {
  const memberReply = latch()
  const f = await collaborationRuntime('subsession-stop', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口本轮结束。' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    if (call.index === 1) { await memberReply.promise; return { text: '成员这一步不该跑完。' } }
    return { text: '成员后续。' }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，随后只停这份委派。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员已接受并在跑', () => f.delegation()?.state === 'accepted'
      && f.requests('member-model').length >= 2)
    const member = f.member()!
    const work = f.collaboration()!
    await f.openMember()

    f.shell.key({ kind: 'ctrl+c' })
    await f.wait('停止这份委派菜单', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'task' })
    const dock = f.shell.getView().dock
    if (dock.kind !== 'picker') throw new Error('停止菜单没有打开')
    expect(dock.picker.rows[0]?.label).toBe('停止这份委派')
    expect(dock.picker.rows[0]?.meta).toContain('派生闭包')
    f.pick('stop')

    await f.wait('只取消这份委派', () => f.delegation()?.state === 'cancelled')
    await f.wait('停止回执写明范围', () => [...f.shell.getView().settled, ...f.shell.getView().rows]
      .some(row => row.kind === 'receipt' && row.text.includes('委派「回调兼容」及派生闭包')))
    expect(f.store.collaboration.getCollaboration(work.collaborationId)?.state).toBe('open')
    expect(f.manager.executors().some(one => one.session === member.sessionId)).toBe(false)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { memberReply.release(); await f.close() }
}, 30000)

test('D68：成员长历史不进协作视图，切会话不重发全量', async () => {
  // 1.2MB 正文：旧路径会把整段显示历史塞进 collaboration.view 并在每次变化时重发。
  const huge = 'LARGE_BODY_'.repeat(120_000)
  const f = await collaborationRuntime('d68-large-history', call => {
    if (call.model === 'entry-model') return call.index === 0 ? spawnMember : { text: '入口本轮结束。' }
    if (call.index === 0) return { tool: 'agent_message', args: { action: 'respond', operationId: 'accept', delegation: f.delegation()!.delegationId, response: 'accept' } }
    return { text: huge }
  })
  try {
    f.shell.key({ kind: 'paste', text: '分出检查，成员产生长正文。' }); f.shell.key({ kind: 'enter' })
    await f.wait('成员长正文落库且双方空闲', () => f.member() !== undefined
      && f.requests('member-model').length >= 2
      && (f.store.collaboration.agentForSession(f.member()!.sessionId) !== undefined)
      && f.manager.runs().every(one => one.state === 'idle'))
    const origin = f.collaboration()!.originSessionId
    const start = f.events.length
    await f.openMember()
    f.shell.key({ kind: 'tab' })
    await f.wait('子会话列表', () => { const dock = f.shell.getView().dock; return dock.kind === 'picker' && dock.picker.source === 'collaboration' })
    f.pick(f.collaboration()!.coordinatorId)
    await f.wait('返回入口', () => f.shell.getView().sessionId === origin)

    const views = f.events.slice(start).flatMap(one => one.kind === 'collaboration.view' ? [one.data] : [])
    expect(views.length).toBeGreaterThan(0)
    for (const view of views) {
      expect(view.entries).toBeUndefined()
      expect(JSON.stringify(view)).not.toContain('LARGE_BODY_')
      expect(JSON.stringify(view).length).toBeLessThan(200_000)
    }
    expect(f.manager.clients()).toBe(1)
    expect(f.errors).toEqual([])
    expect(f.events.filter(one => one.kind === 'error')).toEqual([])
  } finally { await f.close() }
}, 30000)
