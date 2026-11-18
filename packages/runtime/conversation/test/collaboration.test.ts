import { expect, test } from 'bun:test'
import { buildSystemPrompt } from '../src/prompt/index.ts'
import { agentLoop } from '../src/agent-loop.ts'
import { collaborationPrompt, COLLABORATION_HINT } from '../src/collaboration.ts'
import type { CollaborationBoundary } from '../src/collaboration.ts'
import { createConversationSession } from '../src/service.ts'
import { makeLoopRuntime, makeStage, waitUntilIdle } from './support/harness.ts'

function boundary(overrides: Partial<CollaborationBoundary> = {}): CollaborationBoundary {
  return { consume: async () => false, context: async () => '当前职责：验证。', admit: () => undefined,
    requested: () => undefined, ...overrides }
}

test('批次中补充：已发起的调用如实完成，新交代在下一轮开始前重新判断', async () => {
  let fresh = false
  const stage = makeStage({ turns: [
    { toolCalls: [{ name: 'exec', args: { command: 'first' } }, { name: 'exec', args: { command: 'stale' } }] },
    { text: '已按新约束重新判断' },
  ], handlers: { exec: () => { fresh = true; return { ok: true, output: 'first finished' } } } })
  const port = boundary({ consume: async () => { const value = fresh; fresh = false; return value } })
  expect(await agentLoop(makeLoopRuntime(stage, { collaboration: port }), { text: '工作' }, new AbortController().signal)).toBe('settled')
  // **并发发起**：两件都已起跑——在途到达的新交代撤不回已发起的动作，如实完成
  expect(stage.tools.calls.map(call => call.args.command)).toEqual(['first', 'stale'])
  expect(stage.sink.byKind('tool.result').map(event => event.data.notExecuted === true)).toEqual([false, false])
  expect(stage.gateway.requests).toHaveLength(2)
  expect(JSON.stringify(stage.gateway.requests[1])).toContain('重新判断')
})

test('停止准入：已发起的调用完成，下一模型请求不再发起', async () => {
  let stopped = false
  const stage = makeStage({ turns: [{ toolCalls: [{ name: 'exec', args: { command: 'first' } }, { name: 'exec', args: { command: 'second' } }] }],
    handlers: { exec: () => { stopped = true; return { ok: true, output: '已发生' } } } })
  await agentLoop(makeLoopRuntime(stage, { collaboration: boundary({ admit: () => stopped ? '已停止' : undefined }) }), { text: '工作' }, new AbortController().signal)
  // 同批并发发起 ⇒ 两件都跑；但收束时准入已挡，**不再开下一轮**
  expect(stage.tools.calls).toHaveLength(2)
  expect(stage.gateway.requests).toHaveLength(1)
})

test('持久等待让出推进：同批已发起，不再开下一轮', async () => {
  const stage = makeStage({ turns: [{ toolCalls: [{ name: 'exec', args: { command: 'register wait' } }, { name: 'exec', args: { command: 'later' } }] }],
    handlers: { exec: () => ({ ok: true, output: '已登记等待', halt: true }) } })
  await agentLoop(makeLoopRuntime(stage, { collaboration: boundary() }), { text: '工作' }, new AbortController().signal)
  // 并发发起后 `halt` 只能决定「还开不开下一轮」，不能撤回同批已起跑的那件
  expect(stage.tools.calls).toHaveLength(2)
  expect(stage.gateway.requests).toHaveLength(1)
})

test('收件唤起不伪造用户消息，重复无新信息的唤起不请求模型', async () => {
  let pending = true
  const stage = makeStage({ turns: [{ text: '核验成员结果' }] })
  const service = createConversationSession({ session: 's',  prompt: stage.promptVars,
    gateway: stage.gateway, tools: stage.toolDomain, records: stage.records, sink: stage.sink, stamper: stage.stamper,
    collaboration: boundary({ consume: async () => { const result = pending; pending = false; return result } }),
  })
  service.wake()
  await waitUntilIdle(stage.sink)
  service.wake()
  await waitUntilIdle(stage.sink)
  expect(stage.gateway.requests).toHaveLength(1)
  expect(stage.records.entries.filter(entry => entry.kind === 'user')).toHaveLength(0)
  expect(stage.sink.byKind('message.user')).toHaveLength(0)
})

test('单会话只给一句提示，真正展开才注完整协作指导', async () => {
  const base = buildSystemPrompt({ cwd: '/w', shell: '/bin/sh', platform: 'test', date: '2026-09-26' })
  const plain = await collaborationPrompt(base)
  expect(plain).toBe(base)
  expect(plain).toContain(COLLABORATION_HINT)
  expect(plain).not.toContain('收到结果要核验')
  expect(await collaborationPrompt('base', boundary())).toContain('收到结果要核验')
})

test('共同补充发布失败如实保留已落账原文，归还原ref且不请求模型', async () => {
  const stage = makeStage({ turns: [{ text: '不应请求模型' }] })
  const service = createConversationSession({ session: 's',  prompt: stage.promptVars,
    gateway: stage.gateway, tools: stage.toolDomain, records: stage.records, sink: stage.sink, stamper: stage.stamper,
    collaboration: boundary({ userInput: () => { throw new Error('宿主已关闭准入') } }),
  })
  await service.supplement({ text: '新的共同要求', ref: 'draft-original' }, true)
  await waitUntilIdle(stage.sink)
  expect(stage.records.entries.filter(entry => entry.kind === 'user').map(entry => entry.content)).toEqual([{ text: '新的共同要求' }])
  expect(stage.sink.byKind('message.user')).toHaveLength(1)
  expect(stage.sink.byKind('input.settled').map(event => event.data)).toEqual([{ref:'draft-original',ok:true,stage:'accepted'}, {
    ref: 'draft-original', ok: false,
    reason: '输入已保存，但共同补充未能发布（宿主已关闭准入）；未继续执行，原稿保留',
  }])
  expect(stage.gateway.requests).toHaveLength(0)
})
