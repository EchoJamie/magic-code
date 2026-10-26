import type { Database } from 'bun:sqlite'
import type { AgentMessage, Knowledge, KnowledgeReference, MemoryItem, MemorySource, SummaryPayload } from '@magic/contracts'

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
      const message = db.query<{ data: string }, [number]>('SELECT data FROM collaboration_messages WHERE id=?').get(payload.messageId)
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

/** 独立用户交代须实际出现在来源正文中；协作授权/类别不替代内容证据。 */
export function independentUserBody(db: Database, source: MemorySource, invalid: (references: readonly KnowledgeReference[] | undefined) => boolean = references => Boolean(references?.length), visited = new Set<string>()): boolean {
  const key = JSON.stringify([source.session, source.entry, source.part])
  if (visited.has(key)) return false
  visited.add(key)
  const row = db.query<{ kind: string; payload: string | null; content_text: string | null; content_blob: string | null }, [string, number]>(
    'SELECT kind,payload,content_text,content_blob FROM entries WHERE session=? AND id=?',
  ).get(source.session, source.entry)
  if (row === null) return false
  const payload = row.payload === null ? undefined : JSON.parse(row.payload)
  if (userBodySource(db, source)) return Boolean(row.content_text?.trim() || row.content_blob) && !invalid(payload?.knowledge)
  if (source.part !== undefined || row.kind !== 'agent-message') return false
  const message = db.query<{ data: string }, [number]>('SELECT data FROM collaboration_messages WHERE id=?').get(payload.messageId)
  return message !== null && (JSON.parse(message.data) as AgentMessage).body.some(part => part.kind === 'entry'
    && independentUserBody(db, { session: part.ref.sessionId, entry: part.ref.entryId }, invalid, visited))
}

/** 知识引用只授权该知识；不改变来源会话的可读范围。 */
export function knowledgeReferenceProblem(db: Database, session: string, references: readonly KnowledgeReference[] | undefined, allowPending = false, inherited: readonly KnowledgeReference[] = []): string | undefined {
  if (references === undefined) return undefined
  if (!Array.isArray(references)) return '知识引用须为数组'
  const workspace = db.query<{ workspace: string | null }, [string]>('SELECT workspace FROM sessions WHERE id=?').get(session)?.workspace
  for (const reference of references) {
    if (reference === null || typeof reference !== 'object' || typeof reference.id !== 'string' || !reference.id.trim() || !Number.isSafeInteger(reference.revision)
      || reference.revision < 1 || (reference.provided !== undefined && reference.provided !== true)) return '知识引用身份、修订或用途无效'
    const knowledge = db.query<{ scope: string; revision: number; status: string; basis: string }, [string]>('SELECT scope,revision,status,basis FROM knowledge WHERE id=?').get(reference.id)
    if (knowledge === null || (knowledge.status !== 'active' && !((allowPending || reference.provided === true) && knowledge.status === 'pending')) || knowledge.revision !== reference.revision
      || (knowledge.scope !== 'user' && knowledge.scope !== workspace && !(reference.provided === true && inherited.some(source => source.id === reference.id && source.revision === reference.revision)))) return `知识 ${reference.id} 已失效、修订变化或不在当前范围内`
    if (!allowPending && reference.provided !== true && knowledge.basis !== 'fact') return `知识 ${reference.id} 不是已确认事实，不能用于提升事项事实等级`
  }
  return undefined
}

/** 遗忘/纠正与正文写入同事务；重建时直接使用剩余有效事项，不再读取旧摘要。 */
export function invalidateKnowledgeMemory(db: Database, changed: readonly Knowledge[]): readonly string[] {
  const sessions: string[] = []
  const affected = new Map(changed.map(item => [item.id, item.revision]))
  const invalid = (references: readonly KnowledgeReference[] | undefined): boolean => references?.some(reference => {
    const revision = affected.get(reference.id)
    return revision !== undefined && reference.revision <= revision
  }) ?? false
  const rows = db.query<{ session: string; revision: number; items: string; summary: number | null; payload: string | null }, []>(
    'SELECT m.session,m.revision,m.items,m.summary,e.payload FROM working_memory m LEFT JOIN entries e ON e.id=m.summary',
  ).all()
  for (const row of rows) {
    const items = JSON.parse(row.items) as MemoryItem[]
    let touched = false
    const remaining = items.map(item => {
      if (!invalid(item.knowledge) || item.status === 'invalid') return item
      touched = true
      // 明确目标和要求仍由用户交代成立；撤回它们必须经过普通纠正输入。
      if ((item.kind === 'goal' || item.kind === 'requirement') && item.sources.some(source => independentUserBody(db, source, invalid))) {
        return { ...item, knowledge: item.knowledge?.filter(reference => !invalid([reference])), revision: item.revision + 1 }
      }
      return { ...item, status: 'invalid' as const, revision: item.revision + 1 }
    })
    const summaryInvalid = row.payload !== null && invalid((JSON.parse(row.payload) as SummaryPayload).knowledge)
    if (!touched && !summaryInvalid) continue
    // covered_through 保留历史已承接边界；对话域从 remaining 重建，不自动重新提炼被移出的旧内容。
    db.query('UPDATE working_memory SET revision=?,items=?,summary=? WHERE session=?')
      .run(row.revision + 1, JSON.stringify(remaining), summaryInvalid ? null : row.summary, row.session)
    sessions.push(row.session)
  }
  return sessions
}
