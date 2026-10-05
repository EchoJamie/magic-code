import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONSULTATION_TOOL_NAMES } from '@magic/contracts'
import { collaborationRuntime, latch, requestText, type ModelReply } from './run-collaboration-fixture.ts'

const consult: ModelReply = { tool: 'consult_arcane', args: { operationId: 'consult-1', question: '查 workspace 中的关键证据，判断启动失败原因；只给建议。', body: [{ kind: 'text', text: '相关约束：保持只读。' }] } }
const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }

test('U115：同批立即受理与独立写入、定向种子、自行取证、幂等、依赖等待、事件回报与用量', async () => {
  const advisor = latch()
  const final = latch()
  const f = await collaborationRuntime('u115-complete', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return { tools: [consult as Extract<ModelReply, { tool: string }>, { tool: 'write', args: { path: 'independent.txt', content: '独立动作已经执行' } }], usage }
      if (call.index === 1) return { ...consult, usage }
      if (call.index === 2) return { tool: 'agent_wait', args: { operationId: 'wait-advisor', agents: [f.member()!.agentId], message: f.delegation()!.delegationId, expectation: '取得顾问实际证据', deadline: Date.now() + 60000 }, usage }
      expect(requestText(call)).toContain('关键证据-实际读取-8391')
      expect(requestText(call)).toContain('来自顾问')
      await final.promise
      return { text: '核对当前证据后继续负责原工作。', usage }
    }
    if (call.index === 0) { await advisor.promise; return { tool: 'read', args: { path: 'evidence.txt' }, usage } }
    expect(requestText(call)).toContain('关键证据-实际读取-8391')
    return { text: '证据来自 evidence.txt:1：关键证据-实际读取-8391。建议核对初始化次序；本次仅查证，修复尚未验证。', usage }
  }, { allowAll: true })
  writeFileSync(join(f.workspace, 'evidence.txt'), '关键证据-实际读取-8391')
  try {
    f.shell.key({ kind: 'paste', text: '查启动失败原因。无关历史唯一串-NOT-FOR-ADVISOR-915' }); f.shell.key({ kind: 'enter' })
    await f.wait('同批独立动作与持久等待', () => existsSync(join(f.workspace, 'independent.txt')) && f.store.collaboration.listWaits(f.collaboration()!.collaborationId).some(one => one.state === 'waiting'))
    expect(f.requests('descendant-model')).toHaveLength(1)
    expect(f.delegation()?.state).toBe('accepted')
    const first = f.requests('descendant-model')[0]!
    expect(requestText(first)).not.toContain('NOT-FOR-ADVISOR-915')
    expect(requestText(first)).not.toContain('关键证据-实际读取-8391')
    expect(requestText(first)).toContain('相关约束：保持只读')
    expect(requestText(first)).not.toContain('维护计划笔记')
    expect((first.body.tools as { function: { name: string } }[]).map(one => one.function.name).sort()).toEqual([...CONSULTATION_TOOL_NAMES].sort())
    expect(f.members()).toHaveLength(2)
    advisor.release()
    await f.wait('结果带入主模型与顾问进程退出', () => f.requests().length >= 4 && f.member()!.reachability === 'historical' && !f.manager.executors().some(one => one.session === f.member()!.sessionId))
    expect(f.delegation()?.state).toBe('delivered')
    const view = f.shell.getView().collaboration!
    expect(view.members.find(one => one.agent.purpose === 'consultation')?.usage).toMatchObject({ calls: 2, reportedCalls: 2, totalTokens: 36 })
    expect(f.store.collaboration.inbox(f.collaboration()!.coordinatorId).filter(one => one.messageId === f.delegation()!.deliveryMessageId)).toHaveLength(1)
    const stops = await f.store.listSessions()
    expect(stops).toHaveLength(2)
    expect(f.errors).toEqual([])
  } finally { advisor.release(); final.release(); await f.close() }
}, 20000)

for (const name of ['write', 'edit', 'exec', 'plan_update', 'agent_spawn', 'consult_arcane', 'mcp__fake__read']) {
  test(`U115：顾问伪造 ${name} 实际分发拒绝，合法 read 继续`, async () => {
    const f = await collaborationRuntime(`u115-deny-${name}`, call => {
      if (call.model === 'entry-model') return call.index === 0 ? consult : { text: '原执行者保留责任。' }
      if (call.index === 0) return { tool: name, args: { path: 'probe.txt', content: '不应写入', old: '原值', new: '不应修改', cmd: 'touch probe-exec.txt', plan: null,
        operationId: 'recursive', question: '再咨询', name: '伪造成员', responsibility: '修改', scope: '任意', body: [{ kind: 'text', text: '伪造' }] } }
      if (call.index === 1) {
        expect(requestText(call)).toMatch(/不允许|没有开放|未执行|拒绝|不存在|找不到|未知/)
        return { tool: 'read', args: { path: 'probe.txt' } }
      }
      expect(requestText(call)).toContain('原值')
      return { text: 'probe.txt:1 仍为原值；未执行禁止动作。' }
    }, { allowAll: true })
    writeFileSync(join(f.workspace, 'probe.txt'), '原值')
    try {
      f.shell.key({ kind: 'paste', text: '请只读顾问查证' }); f.shell.key({ kind: 'enter' })
      await f.wait('顾问完成或异常先到', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
      expect(f.errors).toEqual([])
      expect(readFileSync(join(f.workspace, 'probe.txt'), 'utf8')).toBe('原值')
      expect(existsSync(join(f.workspace, 'probe-exec.txt'))).toBe(false)
      expect(f.members()).toHaveLength(2)
    } finally { await f.close() }
  }, 15000)
}

for (const reply of [{ text: '' }, { text: '半截建议', finish: 'length' }]) {
  test(`U115：${reply.finish ?? '空正文'} 作为失败主动回报，半截内容不成为建议`, async () => {
    const f = await collaborationRuntime(`u115-failure-${reply.finish ?? 'empty'}`, call => call.model === 'entry-model'
      ? call.index === 0 ? consult : { text: '原执行者等待真实意见。' } : reply, { allowAll: true })
    try {
      f.shell.key({ kind: 'paste', text: '先咨询再执行' }); f.shell.key({ kind: 'enter' })
      await f.wait('失败投递', () => f.delegation()?.deliveryMessageId !== undefined)
      const msg = f.store.collaboration.readMessage(f.collaboration()!.coordinatorId, f.delegation()!.deliveryMessageId!)!
      expect(JSON.stringify(msg.body)).toContain('未完成')
      expect(JSON.stringify(msg.body)).not.toContain('半截建议')
      expect(msg.body.every(one => one.kind === 'text')).toBe(true)
    } finally { await f.close() }
  }, 15000)
}

test('U115：plan/history 绑定发起 Session，主计划不自动入种子，跨独立工作记录不可读', async () => {
  let evidenceEntry = 0
  let foreignEntry = 0
  const f = await collaborationRuntime('u115-record-source', call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return { tool: 'plan_update', args: { plan: { goal: 'MAIN-PLAN-ONLY-592', steps: [], notes: '主计划仅按需查询' } } }
      if (call.index === 1) return consult
      return { text: '原工作保持计划与责任。' }
    }
    if (call.index === 0) { expect(requestText(call)).not.toContain('MAIN-PLAN-ONLY-592'); return { tool: 'plan_read', args: {} } }
    if (call.index === 1) { expect(requestText(call)).toContain('MAIN-PLAN-ONLY-592'); return { tool: 'history_read', args: { entry: evidenceEntry } } }
    if (call.index === 2) { expect(requestText(call)).toContain('ORIGIN-HISTORY-EVIDENCE-771'); return { tool: 'history_read', args: { entry: foreignEntry } } }
    expect(requestText(call)).not.toContain('FOREIGN-SECRET-991')
    return { text: '只读查证了原工作计划与历史；独立工作记录不可读。' }
  }, { allowAll: true })
  foreignEntry = f.store.serviceFor('foreign-work').appendEntry({ kind: 'user', content: { text: 'FOREIGN-SECRET-991' }, at: Date.now() })
  try {
    f.shell.key({ kind: 'paste', text: 'ORIGIN-HISTORY-EVIDENCE-771：查启动失败，先写计划，再咨询' }); f.shell.key({ kind: 'enter' })
    await f.wait('原交代落账', async () => { const id = f.session(); if (id === null) return false; for await (const entry of f.store.readEntries(id)) if (entry.kind === 'user') { evidenceEntry = entry.id; return true } return false })
    await f.wait('顾问查询完成或异常先到', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 15000)

for (const whole of [false, true]) {
  test(`U115：${whole ? '整体停止' : '局部撤回'}取消顾问，迟到响应不续跑原工作`, async () => {
    const pending = latch()
    let replyReleased = false
    const f = await collaborationRuntime(`u115-stop-${whole}`, async call => {
      if (call.model === 'entry-model') return call.index === 0 ? consult : { text: '原工作完成独立步骤。' }
      await pending.promise
      replyReleased = true
      return { text: '停止后迟到的建议不触发实施。' }
    }, { allowAll: true })
    try {
      f.shell.key({ kind: 'paste', text: '启动咨询并保持原工作' }); f.shell.key({ kind: 'enter' })
      await f.wait('顾问在途', () => f.requests('descendant-model').length === 1 && f.requests().length >= 2)
      const before = f.requests().length
      f.client.send({ type: 'collaboration.stop', ...(whole ? {} : { delegation: f.delegation()!.delegationId }) })
      await f.wait('顾问实际退出', () => f.delegation()?.state === 'cancelled' && !f.manager.executors().some(one => one.session === f.member()!.sessionId))
      pending.release()
      // 测试装置仅让已在途的 HTTP 响应释放；不用 sleep/轮询驱动产品。
      await f.wait('在途HTTP已释放且执行资源核销', () => replyReleased && f.store.collaboration.listExecutions(f.collaboration()!.collaborationId).filter(one => one.agentId === f.member()!.agentId).every(one => one.state === 'finished'))
      const second = await f.openWindow() // 再走一次真实重连投影，不能由未到达响应制造假过。
      expect(second.shell.getView().collaboration?.members.find(one => one.agent.purpose === 'consultation')?.delegation?.state).toBe('cancelled')
      expect(f.requests()).toHaveLength(before)
      expect(f.collaboration()?.state).toBe(whole ? 'stopped' : 'open')
      expect(f.store.collaboration.listExecutions(f.collaboration()!.collaborationId).filter(one => one.agentId === f.member()!.agentId).every(one => one.state === 'finished')).toBe(true)
    } finally { pending.release(); await f.close() }
  }, 15000)
}

test('U115：窗口断线仍完成咨询，原工作被结果唤起；重复终态不重复消费', async () => {
  const pending = latch()
  const f = await collaborationRuntime('u115-disconnect', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? consult : { text: '原工作看到顾问结果继续核对。' }
    await pending.promise
    return { text: '后台顾问的完整建议。' }
  }, { allowAll: true })
  try {
    f.shell.key({ kind: 'paste', text: '启动后台只读查证' }); f.shell.key({ kind: 'enter' })
    await f.wait('原轮结束和顾问在途', () => f.requests().length >= 2 && f.requests('descendant-model').length === 1)
    f.closeWindows()
    pending.release()
    await f.wait('没有窗口仍回报并唤起原工作', () => f.delegation()?.deliveryMessageId !== undefined && f.requests().length >= 3)
    const records = f.store.collaboration
    const messageId = f.delegation()!.deliveryMessageId!
    const origin = f.collaboration()!.coordinatorId
    expect(records.inbox(origin).filter(one => one.messageId === messageId)).toHaveLength(1)
    records.markIncluded(origin, [messageId], Date.now())
    expect(records.inbox(origin).filter(one => one.messageId === messageId && one.includedAt !== undefined)).toHaveLength(1)
    expect(f.errors).toEqual([])
  } finally { pending.release(); await f.close() }
}, 15000)

test('U115：咨询在途映射稳定，下次新咨询读取新映射，主 reasoning 不继承', async () => {
  const pending = latch()
  const consult2: ModelReply = { tool: 'consult_arcane', args: { operationId: 'consult-2', question: '第二个新问题' } }
  const f = await collaborationRuntime('u115-model-isolation', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return consult
      if (call.index === 1) return { text: '继续独立工作。' }
      if (call.index === 2) return consult2
      return { text: '主模型仍负责执行。' }
    }
    if (call.model === 'descendant-model') {
      if (call.index === 0) { await pending.promise; return { tool: 'read', args: { path: 'evidence.txt' } } }
      return { text: '第一份咨询完成。' }
    }
    expect(call.model).toBe('changed-model')
    if (!requestText(call).includes('新映射不能改变已有咨询')) return { tool: 'read', args: { path: 'evidence.txt' } }
    expect(requestText(call)).toContain('新映射不能改变已有咨询')
    return { text: '新映射下的独立咨询完成。' }
  }, { allowAll: true })
  writeFileSync(join(f.workspace, 'evidence.txt'), '新映射不能改变已有咨询')
  const configPath = join(f.magic.base, 'config.json')
  try {
    f.shell.key({ kind: 'paste', text: '先咨询' }); f.shell.key({ kind: 'enter' })
    await f.wait('咨询第一轮在途', () => f.requests('descendant-model').length === 1 && f.requests().length >= 2)
    const main = f.store.collaboration.getAgent(f.collaboration()!.coordinatorId)!
    f.store.collaboration.updateAgent(main.agentId, { model: { ...main.model, reasoning: { mode: 'off' } } })
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    config.modelAliases.arcane = { provider: 'second', model: 'changed-model' }
    config.providers.second = { ...config.providers.controlled, vendor: 'minimax' }
    writeFileSync(configPath, JSON.stringify(config))
    pending.release()
    await f.wait('旧咨询多轮完成与主模型自动核收', () => f.delegation()?.deliveryMessageId !== undefined && f.requests().length >= 4)
    expect(f.requests('descendant-model')).toHaveLength(2)
    f.client.send({ type: 'input.submit', text: '启动下一份咨询' })
    await f.wait('新映射经真实工具往返完成', () => f.store.collaboration.listDelegations(f.collaboration()!.collaborationId).some(d => f.store.collaboration.getAgent(d.assigneeId)?.model.model === 'changed-model' && d.deliveryMessageId !== undefined) || f.errors.length > 0)
    const advisors = f.members().filter(one => one.purpose === 'consultation')
    expect(advisors.map(one => one.model)).toEqual([
      { alias: 'arcane', provider: 'controlled', model: 'descendant-model', reasoning: { mode: 'default' } },
      { alias: 'arcane', provider: 'second', model: 'changed-model', reasoning: { mode: 'default' } },
    ])
    expect(f.requests('changed-model')[0]?.body.thinking).not.toEqual({ type: 'disabled' })
    expect(f.store.collaboration.getAgent(main.agentId)!.model.alias).toBe('default')
    expect(f.errors).toEqual([])
  } finally { pending.release(); await f.close() }
}, 20000)

test('U115：缺 Arcane 配置或思考不支持在模型调用前拒绝，不换档', async () => {
  const f = await collaborationRuntime('u115-config-reject', call => call.index === 0 ? consult : call.index === 1
    ? { tool: 'consult_arcane', args: { operationId: 'unsupported', question: '不支持的思考设置', reasoning: { mode: 'level', level: 'impossible' } } }
    : { text: '报告配置问题，不绕过咨询条件。' }, { allowAll: true })
  const path = join(f.magic.base, 'config.json')
  try {
    const config = JSON.parse(readFileSync(path, 'utf8'))
    delete config.modelAliases.arcane
    writeFileSync(path, JSON.stringify(config))
    f.shell.key({ kind: 'paste', text: '咨询前必须有配置' }); f.shell.key({ kind: 'enter' })
    await f.wait('配置错误返回原模型', () => f.requests().length >= 2)
    config.modelAliases.arcane = { provider: 'controlled', model: 'descendant-model' }
    writeFileSync(path, JSON.stringify(config))
    await f.wait('原轮结束', () => f.requests().length >= 3)
    expect(f.requests('descendant-model')).toHaveLength(0)
    expect(f.members()).toHaveLength(0)
    expect(requestText(f.requests()[1])).toContain('Arcane 尚未配置')
    expect(f.errors).toEqual([])
  } finally { await f.close() }
}, 15000)

test('U115：运行中纠正到安全边界，历史保留旧证据，原工作采纳前实际重读当前文件', async () => {
  const readDone = latch()
  const resume = latch()
  let mainRechecked = false
  const f = await collaborationRuntime('u115-correction', async call => {
    if (call.model === 'entry-model') {
      if (call.index === 0) return consult
      if (call.index === 1) return { text: '继续独立步骤。' }
      if (!requestText(call).includes('顾问最终建议')) return { text: '已记下新的用户要求。' }
      if (!mainRechecked) { mainRechecked = true; return { tool: 'read', args: { path: 'evidence.txt' } } }
      return { text: '顾问所读旧值已保留；我重读当前值 CURRENT-EVIDENCE-202 后再决定执行。' }
    }
    if (call.index === 0) return { tool: 'read', args: { path: 'evidence.txt' } }
    if (call.index === 1) { expect(requestText(call)).toContain('OLD-EVIDENCE-101'); readDone.release(); await resume.promise; return { tool: 'read', args: { path: 'evidence.txt' } } }
    expect(requestText(call)).toContain('用户纠正-不得立即修改-778')
    if (!requestText(call).includes('CURRENT-EVIDENCE-202')) return { tool: 'read', args: { path: 'evidence.txt' } }
    return { text: '顾问查证：首次 OLD-EVIDENCE-101，纠正后重读 CURRENT-EVIDENCE-202。建议保持只读，原工作核现场。' }
  }, { allowAll: true })
  writeFileSync(join(f.workspace, 'evidence.txt'), 'OLD-EVIDENCE-101')
  try {
    f.shell.key({ kind: 'paste', text: '查证' }); f.shell.key({ kind: 'enter' })
    await readDone.promise
    writeFileSync(join(f.workspace, 'evidence.txt'), 'CURRENT-EVIDENCE-202')
    f.client.send({ type: 'collaboration.input', input: { text: '用户纠正-不得立即修改-778' }, shared: true })
    await f.wait('纠正实际进入顾问收件', () => f.store.collaboration.listConstraints(f.collaboration()!.collaborationId).length > 0)
    resume.release()
    await f.wait('主工作重读当前证据或发现异常', () => f.events.some(one => one.session === f.session() && one.kind === 'tool.result' && JSON.stringify(one.data.output).includes('CURRENT-EVIDENCE-202')) || f.errors.length > 0)
    expect(f.errors).toEqual([])
    const receipts = f.shell.getView().settled.filter(one => one.kind === 'receipt' && one.text.includes('来自顾问'))
    expect(receipts).toHaveLength(1)
    const old = f.requests('descendant-model')[1]!
    expect(requestText(old)).toContain('OLD-EVIDENCE-101')
  } finally { resume.release(); await f.close() }
}, 20000)

test('U115：顾问 executor 异常退出主动报未完成，不重发咨询，原工作仍能接住', async () => {
  const pending = latch()
  const f = await collaborationRuntime('u115-crash', async call => {
    if (call.model === 'entry-model') return call.index === 0 ? consult : { text: '收到未完成原因，保留原工作责任。' }
    await pending.promise; return { text: '不该采纳的迟到内容' }
  }, { allowAll: true })
  try {
    f.shell.key({ kind: 'paste', text: '先查证' }); f.shell.key({ kind: 'enter' })
    await f.wait('顾问实际调用', () => f.requests('descendant-model').length === 1)
    const executor = f.manager.executors().find(one => one.session === f.member()!.sessionId)!
    process.kill(executor.pid!, 'SIGKILL')
    await f.wait('中断回报与进程核销', () => f.delegation()?.deliveryMessageId !== undefined && f.processExits.some(one => one.pid === executor.pid))
    expect(f.delegation()?.reason).toContain('咨询未完成')
    expect(f.requests('descendant-model')).toHaveLength(1)
    expect(f.manager.executors().some(one => one.pid === executor.pid)).toBe(false)
  } finally { pending.release(); await f.close() }
}, 15000)

test('U115：主模型与Arcane同实际型号仍创建独立上下文，咨询不继承主思考', async () => {
  let mainCalls = 0
  let advisorCalls = 0
  const f = await collaborationRuntime('u115-same-model', call => {
    const tools = call.body['tools'] as { function: { name: string } }[]
    if (tools.some(one => one.function.name === 'consult_arcane')) {
      if (mainCalls++ === 0) {
        const r = f.store.collaboration
        const actor = r.agentForSession(f.session()!)!
        r.updateAgent(actor.agentId, { model: { ...actor.model, reasoning: { mode: 'off' } } })
        return consult
      }
      return { text: '主模型保持执行责任。' }
    }
    advisorCalls++
    expect(requestText(call)).not.toContain('SAME-MODEL-UNRELATED-HISTORY-887')
    return { text: '同型号、独立上下文的顾问建议。' }
  }, { allowAll: true })
  const path = join(f.magic.base, 'config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.modelAliases.arcane = config.modelAliases.default
  writeFileSync(path, JSON.stringify(config))
  try {
    f.shell.key({ kind: 'paste', text: 'SAME-MODEL-UNRELATED-HISTORY-887' }); f.shell.key({ kind: 'enter' })
    await f.wait('同型号顾问完成', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
    expect(f.errors).toEqual([]); expect(advisorCalls).toBe(1)
    expect(f.member()!.model).toMatchObject({ model: 'entry-model', reasoning: { mode: 'default' } })
    expect(f.members()).toHaveLength(2)
  } finally { await f.close() }
}, 15000)

test('U115：原始条目图片进入咨询能力检查，明确不支持时零顾问请求并主动失败', async () => {
  let imageEntry = 0
  const f = await collaborationRuntime('u115-image-reject', call => {
    if (call.model !== 'entry-model') throw new Error('不支持图片不应发出降为文字的请求')
    if (call.index === 0) {
      const service = f.store.serviceFor(f.session()!)
      imageEntry = service.appendEntry({ kind: 'user', at: Date.now(), content: { text: '原图 Image#1' }, payload: { refs: [{ kind: 'image', at: 3,
        marker: 'Image#1', source: '/isolated-original.png', label: '原始证据图片', name: 'original.png', mime: 'image/png', blob }] } })
      return { tool: 'consult_arcane', args: { operationId: 'image', question: '核对原图证据', body: [{ kind: 'entry', ref: { sessionId: f.session()!, entryId: imageEntry } }] } }
    }
    return { text: '咨询无法读取原图，不能按文字降级后的意见执行。' }
  }, { allowAll: true })
  const blob = await f.store.blobs.put(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
  const path = join(f.magic.base, 'config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.providers.controlled.modelOverrides = { 'descendant-model': { capabilities: { image: false } } }
  writeFileSync(path, JSON.stringify(config))
  try {
    f.shell.key({ kind: 'paste', text: '按需提交原始引用' }); f.shell.key({ kind: 'enter' })
    await f.wait('图片能力失败回报', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
    expect(f.errors).toEqual([])
    expect(f.requests('descendant-model')).toHaveLength(0)
    expect(f.delegation()?.reason).toMatch(/图片|图像/)
  } finally { await f.close() }
}, 15000)

for (const fault of [{ httpStatus: 429 }, { httpStatus: 503 }, { malformed: true as const }]) test(`U115：上游失败 ${fault.httpStatus ?? '异常SSE'} 不成为成功建议，不换档`, async () => {
  const f = await collaborationRuntime(`u115-upstream-${fault.httpStatus ?? 'sse'}`, call => call.model === 'entry-model'
    ? call.index === 0 ? consult : { text: '咨询未完成，继续核对原因。' }
    : { text: '', ...fault }, { allowAll: true })
  try {
    f.shell.key({ kind: 'paste', text: '核对证据' }); f.shell.key({ kind: 'enter' })
    await f.wait('上游失败落账', () => f.delegation()?.deliveryMessageId !== undefined || f.errors.length > 0)
    expect(f.errors).toEqual([])
    expect(f.delegation()?.reason).toContain('咨询未完成')
    expect(f.calls.every(one => ['entry-model', 'descendant-model'].includes(one.model))).toBe(true)
    const msg = f.store.collaboration.readMessage(f.collaboration()!.coordinatorId, f.delegation()!.deliveryMessageId!)!
    expect(msg.body.every(one => one.kind === 'text')).toBe(true)
  } finally { await f.close() }
}, 15000)
