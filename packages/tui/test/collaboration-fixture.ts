import type { CollaborationView, Entry } from '@magic/contracts'

export const collaborationEntries: readonly Entry[] = [
  { id: 30, kind: 'user', at: 1, content: { text: '保持公共接口兼容，检查回调校验。' } },
  { id: 32, kind: 'tool-call', at: 2, content: { text: '' }, payload: { name: 'exec', args: { command: 'bun test callback.test.ts' } } },
  { id: 33, kind: 'tool-result', at: 3, content: { text: '3 pass · 回调兼容测试通过' }, payload: { ok: true, output: { text: '3 pass · 回调兼容测试通过' } } },
  { id: 31, kind: 'assistant', at: 2, content: { text: Array.from({ length: 24 }, (_, i) => `第 ${i + 1} 项检查：保留原接口与失败响应。`).join('\n') } },
]
export const collaborationFixture: CollaborationView = {
  originSession: 'origin',
  collaboration: { collaborationId: 'work', originSessionId: 'origin', origin: { sessionId: 'origin', entryId: 1 }, coordinatorId: 'coordinator', defaultModel: { alias: 'default', provider: 'local', model: 'mini' }, state: 'open', at: 0 },
  members: [
    { agent: { agentId: 'coordinator', sessionId: 'origin', name: '协调', role: '整合结果', model: { alias: 'default', provider: 'local', model: 'mini' }, workspace: ['/project'], reachability: 'active', collaborationId: 'work', at: 0 },
      runtime: { session: 'origin', state: 'idle', since: 0, startedAt: 0, workspace: ['/project'], holds: true }, pendingDecisions: 0 },
    { agent: { agentId: 'worker', sessionId: 'member', name: '实现', role: '调整校验', model: { alias: 'default', provider: 'local', model: 'mini' }, workspace: ['/project'], reachability: 'active', collaborationId: 'work', at: 0 },
      runtime: { session: 'member', state: 'running', action: '检查回调兼容', since: 0, startedAt: 0, workspace: ['/project'], holds: true }, pendingDecisions: 0,
      delegation: { delegationId: 10, collaborationId: 'work', delegatorId: 'coordinator', assigneeId: 'worker', source: { messageId: 10 }, authorization: [], scope: '回调校验', state: 'accepted', at: 0 } },
  ],
  delegations: [
    { delegationId: 10, collaborationId: 'work', delegatorId: 'coordinator', assigneeId: 'worker', source: { messageId: 10 }, authorization: [], scope: '回调校验', state: 'accepted', at: 0 },
    { delegationId: 11, collaborationId: 'work', delegatorId: 'coordinator', assigneeId: 'worker', source: { messageId: 11 }, authorization: [], scope: '补充复核', state: 'queued', at: 0 },
  ],
  waits: [], constraints: [{ messageId: 20, states: [{ agentId: 'worker', state: 'pending' }, { agentId: 'coordinator', state: 'included' }] }],
}

export function collaborationDetail(member?: string): CollaborationView {
  if (member === undefined) return collaborationFixture
  return { ...collaborationFixture, selectedMember: member, entries: collaborationEntries,
    messages: [{ messageId: 40, collaborationId: 'work', senderId: 'worker', recipients: ['coordinator'], purpose: 'question', body: [{ kind: 'text', text: '失败响应应保留原状态码吗？' }, { kind: 'entry', ref: { sessionId: 'origin', entryId: 1 }, label: '原始要求' }], discussionRoot: 40, at: 0, withdrawn: false },
      { messageId: 41, collaborationId: 'work', senderId: 'coordinator', recipients: ['worker'], purpose: 'decision', body: [{ kind: 'text', text: '保留原状态码；未解决的兼容性疑点继续记录。' }], discussionRoot: 40, replyTo: 40, at: 1, withdrawn: false }],
  }
}
