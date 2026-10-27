import type { Entry, KnowledgeReference } from '@magic/contracts'

export const KNOWLEDGE_MATERIAL_TOOLS = new Set(['knowledge_search', 'knowledge_read', 'knowledge_source', 'knowledge_update', 'source_read'])

/** 工具输出中的结构化引用来自知识服务；普通工具/原文中的同名 JSON 不授予知识身份。 */
export function knowledgeOutputReferences(name: string, output: string): readonly KnowledgeReference[] {
  if (!KNOWLEDGE_MATERIAL_TOOLS.has(name)) return []
  let value: unknown
  try { value = JSON.parse(output) } catch { return [] }
  if (value === null || typeof value !== 'object') return []
  const items = [value]
  const references = new Map<string, KnowledgeReference>()
  for (const item of items) {
    if (item === null || typeof item !== 'object' || !('knowledge' in item) || !Array.isArray(item.knowledge)) continue
    for (const reference of item.knowledge) {
      if (reference !== null && typeof reference === 'object' && typeof reference.id === 'string'
        && Number.isSafeInteger(reference.revision) && reference.revision > 0) {
        references.set(`${reference.id}\0${reference.revision}`, reference)
      }
    }
  }
  return [...references.values()]
}

/** 原始材料中实际提供的关系；part 仅选该引用，不把相邻引用带进来。 */
export function entryKnowledgeReferences(entry: Entry, part?: number): readonly KnowledgeReference[] {
  const payload = entry.payload
  const refs = payload !== undefined && 'refs' in payload ? payload.refs ?? [] : []
  const selected = part === undefined ? refs : refs.slice(part, part + 1)
  return [...(payload !== undefined && 'knowledge' in payload ? payload.knowledge ?? [] : []), ...selected.flatMap(ref => ref.knowledge ?? [])]
}
