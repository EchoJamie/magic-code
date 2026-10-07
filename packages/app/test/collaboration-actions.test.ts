import { expect, test } from 'bun:test'
import { createCollaborationActions } from '@magic/actions'
import type { CollaborationRequest } from '@magic/contracts'
import { createRecordsStore } from '@magic/records'
import { removeDir, tempDir } from './tmp.ts'

test('首次派生模型预检失败不展开协作；修正后重试只登记和启动同一成员', async () => {
  const dir = tempDir('magic-collaboration-actions-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const records = store.collaboration
  const sessionId = 'origin'
  const entryId = store.serviceFor(sessionId).appendEntry({ kind: 'user', content: { text: '检查同一份工作' }, at: 1 })
  const model = { choice: 'default' as const, provider: 'test', model: 'entry' }
  const actor = records.registerAgent({ operationId: 'identity', sessionId, name: '入口', role: '', model, at: 2 })
  let available = false
  const starts: string[] = []
  const actions = createCollaborationActions({ records, now: Date.now,
    origin: async () => ({ sessionId, entryId }),
    resolveModel: async () => { if (!available) throw new Error('所选模型不可用'); return model },
    start: async member => { starts.push(member.agentId) }, wake: () => undefined,
    cancel: async () => undefined, changed: () => undefined,
  })
  const request: CollaborationRequest = { action: 'spawn', operationId: 'one-member', name: '检查者',
    responsibility: '独立检查', scope: '已交代的工作', body: [{ kind: 'text', text: '检查并回报' }] }
  try {
    expect(await actions.request(actor.agentId, request)).toEqual({ ok: false, reason: '所选模型不可用' })
    expect(records.collaborationForSession(sessionId)).toBeUndefined()
    expect(starts).toEqual([])

    available = true
    const first = await actions.request(actor.agentId, request)
    expect(first.ok).toBe(true)
    expect(await actions.request(actor.agentId, request)).toEqual(first)
    const collaboration = records.collaborationForSession(sessionId)!
    expect(records.listMembers(collaboration.collaborationId)).toHaveLength(2)
    expect(records.listDelegations(collaboration.collaborationId)).toHaveLength(1)
    expect(starts).toHaveLength(1)
  } finally { store.close(); removeDir(dir) }
})
