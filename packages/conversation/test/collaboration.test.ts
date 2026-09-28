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

test('批次中补充：在途调用如实完成，下一件旧工具暂停并重新请求模型', async () => {
  let fresh = false
  const stage = makeStage({ turns: [
    { toolCalls: [{ name: 'exec', args: { cmd: 'first' } }, { name: 'exec', args: { cmd: 'stale' } }] },
    { text: '已按新约束重新判断' },
  ], handlers: { exec: () => { fresh = true; return { ok: true, output: 'first finished' } } } })
  const port = boundary({ consume: async () => { const value = fresh; fresh = false; return value } })
  expect(await agentLoop(makeLoopRuntime(stage, { collaboration: port }), { text: '工作' }, new AbortController().signal)).toBe('settled')
  expect(stage.tools.calls.map(call => call.args.cmd)).toEqual(['first'])
  expect(stage.gateway.requests).toHaveLength(2)
  expect(stage.sink.byKind('tool.result').map(event => event.data.notExecuted === true)).toEqual([false, true])
  expect(JSON.stringify(stage.gateway.requests[1])).toContain('重新判断')
})

test('停止准入挡住下一工具和下一模型请求，不声称撤销已执行动作', async () => {
  let stopped = false
  const stage = makeStage({ turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'first' } }, { name: 'exec', args: { cmd: 'second' } }] }],
    handlers: { exec: () => { stopped = true; return { ok: true, output: '已发生' } } } })
  await agentLoop(makeLoopRuntime(stage, { collaboration: boundary({ admit: () => stopped ? '已停止' : undefined }) }), { text: '工作' }, new AbortController().signal)
  expect(stage.tools.calls).toHaveLength(1)
  expect(stage.gateway.requests).toHaveLength(1)
  expect(stage.sink.byKind('tool.result')[1]?.data.notExecuted).toBe(true)
})

test('持久等待让出推进，不执行同批次后续动作或忙轮询', async () => {
  const stage = makeStage({ turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'register wait' } }, { name: 'exec', args: { cmd: 'later' } }] }],
    handlers: { exec: () => ({ ok: true, output: '已登记等待', halt: true }) } })
  await agentLoop(makeLoopRuntime(stage, { collaboration: boundary() }), { text: '工作' }, new AbortController().signal)
  expect(stage.tools.calls).toHaveLength(1)
  expect(stage.gateway.requests).toHaveLength(1)
})

test('收件唤起不伪造用户消息，重复无新信息的唤起不请求模型', async () => {
  let pending = true
  const stage = makeStage({ turns: [{ text: '核验成员结果' }] })
  const service = createConversationSession({ session: 's', model: 'faux', prompt: stage.promptVars,
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
  const base = buildSystemPrompt({ cwd: '/w', platform: 'test', date: '2026-09-26' })
  const plain = await collaborationPrompt(base)
  expect(plain).toBe(base)
  expect(plain).toContain(COLLABORATION_HINT)
  expect(plain).not.toContain('收到结果要核验')
  expect(await collaborationPrompt('base', boundary())).toContain('收到结果要核验')
})

test('共同补充发布失败如实保留已落账原文，归还原ref且不请求模型', async () => {
  const stage = makeStage({ turns: [{ text: '不应请求模型' }] })
  const service = createConversationSession({ session: 's', model: 'faux', prompt: stage.promptVars,
    gateway: stage.gateway, tools: stage.toolDomain, records: stage.records, sink: stage.sink, stamper: stage.stamper,
    collaboration: boundary({ userInput: () => { throw new Error('宿主已关闭准入') } }),
  })
  await service.supplement({ text: '新的共同要求', ref: 'draft-original' }, true)
  await waitUntilIdle(stage.sink)
  expect(stage.records.entries.filter(entry => entry.kind === 'user').map(entry => entry.content)).toEqual([{ text: '新的共同要求' }])
  expect(stage.sink.byKind('message.user')).toHaveLength(1)
  expect(stage.sink.byKind('input.settled').map(event => event.data)).toEqual([{
    ref: 'draft-original', ok: false,
    reason: '输入已保存，但共同补充未能发布（宿主已关闭准入）；未继续执行，原稿保留',
  }])
  expect(stage.gateway.requests).toHaveLength(0)
})
