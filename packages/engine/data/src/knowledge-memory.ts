import type { Database } from 'bun:sqlite'
import type { AgentMessage, KnowledgeReference, MemorySource } from '@magic/contracts'

/** 同一修订同时被提供和采用时，保留采用所需的事实保护。 */
export function mergeKnowledgeReferences(references: readonly KnowledgeReference[]): KnowledgeReference[] {
  const merged = new Map<string, KnowledgeReference>()
  for (const reference of references) {
    const key = `${reference.id}\0${reference.revision}`
    if (!merged.has(key) || reference.provided !== true) merged.set(key, reference)
  }
  return [...merged.values()]
}

/** part 的定位语义与统一材料读面一致；-1 不能伪装通知或助手为用户正文。 */
export function userBodySource(db: Database, source: MemorySource): boolean {
  return (source.part === undefined || source.part === -1)
    && db.query("SELECT 1 FROM entries WHERE session=? AND id=? AND kind='user' AND COALESCE(json_extract(payload,'$.notice'),0)=0").get(source.session, source.entry) !== null
}

export function sourcePartExists(db: Database, source: MemorySource): boolean {
  if (source.part === undefined) return true
  if (!Number.isSafeInteger(source.part) || source.part < -1) return false
  if (source.part === -1) return userBodySource(db, source)
  const row = db.query<{ payload: string | null }, [string, number]>('SELECT payload FROM entries WHERE session=? AND id=?').get(source.session, source.entry)
  return row?.payload != null && JSON.parse(row.payload).refs?.[source.part] !== undefined
}

/** 从实际提供/派生材料继承修订，不依赖模型再次填写已有来源关系。 */
export function sourceKnowledgeReferences(db: Database, sources: readonly MemorySource[]): KnowledgeReference[] {
  const references = new Map<string, KnowledgeReference>()
  const visited = new Set<string>()
  const visit = (source: MemorySource): void => {
    const key = JSON.stringify([source.session, source.entry, source.part])
    if (visited.has(key)) return
    visited.add(key)
    const row = db.query<{ kind: string; payload: string | null }, [string, number]>('SELECT kind,payload FROM entries WHERE session=? AND id=?').get(source.session, source.entry)
    const payload = row?.payload == null ? undefined : JSON.parse(row.payload)
    if (row?.kind === 'agent-message') {
      const message = db.query<{ data: string }, [number]>("SELECT data FROM ledger_entries WHERE kind='message' AND id=?").get(payload.messageId)
      if (message !== null) {
        const material = JSON.parse(message.data) as AgentMessage
        for (const part of material.body) {
          if (part.kind === 'entry') visit({ session: part.ref.sessionId, entry: part.ref.entryId })
          else for (const reference of part.knowledge ?? []) references.set(`${reference.id}\0${reference.revision}`, { ...reference, provided: true })
        }
        if (material.generatedFrom !== undefined && material.body.some(part => part.kind === 'entry' && part.label !== undefined)) visit({ session: material.generatedFrom.sessionId, entry: material.generatedFrom.entryId })
      }
      return
    }
    const refs = source.part === undefined ? payload?.refs ?? [] : [payload?.refs?.[source.part]]
    const selected = [...(payload?.knowledge ?? []), ...refs.flatMap((ref: { knowledge?: readonly KnowledgeReference[] } | undefined) => ref?.knowledge ?? [])]
    for (const reference of selected) references.set(`${reference.id}\0${reference.revision}`, { id: reference.id, revision: reference.revision, provided: true })
  }
  for (const source of sources) visit(source)
  return [...references.values()]
}
