import type { AgentIdentity, MessagePart } from '@magic/contracts'
import { createRecordsStore } from '../src/index.ts'
import { removeDataDir, tempDataDir } from './tmp.ts'

export const model = { alias: 'default' as const, provider: 'test', model: 'test-model' }
export const body = (text: string): readonly MessagePart[] => [{ kind: 'text', text }]
export function fixture() {
  const dir = tempDataDir()
  const store = createRecordsStore({ dataDir: dir, workspace: ['/original'] })
  const records = store.collaboration
  const origin = { sessionId: 'origin', entryId: store.serviceFor('origin').appendEntry({ kind: 'user', content: { text: 'Do this work' }, at: 1 }) }
  const coordinator = records.registerAgent({ operationId: 'identity', sessionId: 'origin', name: 'coordinator', role: '', model, at: 2 })
  const collaboration = records.openCollaboration(coordinator.agentId, { operationId: 'open', origin, at: 3 })
  let sequence = 0
  function spawn(name: string, parent?: { agent: AgentIdentity; delegationId: number }) {
    return records.spawn(parent?.agent.agentId ?? coordinator.agentId, {
      operationId: `spawn-${++sequence}`, sessionId: name, name, role: 'builder', responsibility: `implement ${name}`, model,
      at: 4 + sequence, body: body(`work ${name}`), scope: name,
      source: parent ? { messageId: parent.delegationId } : origin, authorization: [origin],
      ...(parent ? { parentDelegationId: parent.delegationId } : {}),
    })
  }
  function accept(id: number) {
    const d = records.getDelegation(id)!
    return records.respondToDelegation(d.assigneeId, { operationId: `accept-${id}-${++sequence}`, delegationId: id, response: 'accept', at: 10 })
  }
  return { dir, store, records, origin, coordinator, collaboration, spawn, accept, close() { store.close(); removeDataDir(dir) } }
}
