import { expect, test } from 'bun:test'
import { createRecordsStore } from '@magic/records'
import { createManagedCollaboration } from '../src/run/collaboration.ts'
import { captureCollaborationNative, mergeCollaborationNative } from '../src/run/collaboration-native.ts'
import { projectWorks } from '../src/run/native-projection.ts'
import { tempDir, removeDir } from './tmp.ts'

for (const completed of [false, true]) test(`U115：宿主恢复 ${completed ? '已落账尚未投递' : '中断未完成'}，补存回报不重发模型`, async () => {
  const dir = tempDir('magic-consult-recovery-')
  const store = createRecordsStore({ dataDir: dir, workspace: [dir] })
  const r = store.collaboration
  const origin = { sessionId: 'origin', entryId: store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: '原工作' }, at: 1 }) }
  const model = { alias: 'arcane' as const, provider: 'controlled', model: 'test', reasoning: { mode: 'default' as const } }
  const root = r.registerAgent({ operationId: 'root', sessionId: 'origin', name: '原工作', role: '', model, at: 1 })
  const work = r.openCollaboration(root.agentId, { operationId: 'open', origin, at: 1 })
  const spawned = r.spawn(root.agentId, { operationId: 'spawn', sessionId: 'advisor', name: '咨询 Arcane', role: '', purpose: 'consultation', model,
    body: [{ kind: 'text', text: '问题' }], source: origin, authorization: [origin], scope: '证据查证', at: 1 })
  r.respondToDelegation(spawned.agent.agentId, { operationId: 'accept', delegationId: spawned.delegation.delegationId, response: 'accept', at: 1 })
  const rec = store.serviceFor('advisor')
  const entry = rec.appendEntry({ kind: 'assistant', content: { text: completed ? '完整建议原件' : '半截内容' }, at: 2 })
  rec.appendEvent({ kind: 'message.assistant', data: { entry }, id: rec.nextId(), session: 'advisor', turn: 1, at: 2 })
  if (completed) rec.appendEvent({ kind: 'turn.end', data: { reason: 'settled' }, id: rec.nextId(), session: 'advisor', turn: 1, at: 3 })
  let starts = 0
  let wakes = 0
  const host = createManagedCollaboration({ store, magic: { home: dir, base: dir }, now: Date.now, accepting: () => true,
    start: async () => { starts++ }, wake: () => { wakes++ }, cancel: async () => undefined, input() {}, configure: async () => undefined,
    runs: () => [], decisions: () => 0, changed() {} })
  try {
    await host.recover()
    const delivery = r.getDelegation(spawned.delegation.delegationId)!
    expect(delivery.deliveryMessageId).toBeDefined()
    expect(r.getCollaboration(work.collaborationId)?.state).toBe('stopped')
    expect(starts).toBe(0); expect(wakes).toBe(0)
    const msg = r.readMessage(root.agentId, delivery.deliveryMessageId!)!
    expect(msg.body.some(part => part.kind === 'entry')).toBe(completed)
    if (!completed) expect(delivery.reason).toContain('不会自动重发')
    await host.recover()
    expect(r.inbox(root.agentId).filter(one => one.messageId === delivery.deliveryMessageId)).toHaveLength(1)
    const snapshot = captureCollaborationNative(r, ['origin', 'advisor'])
    expect(mergeCollaborationNative(await projectWorks(store, [], () => null), snapshot)).toHaveLength(1)
  } finally { host.shutdown('测试结束'); store.close(); removeDir(dir) }
})
