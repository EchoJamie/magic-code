import type { Entry, KnowledgeRecords, KnowledgeReference } from '@magic/contracts'

export const KNOWLEDGE_MATERIAL_TOOLS = new Set(['knowledge_search', 'knowledge_read', 'knowledge_source', 'knowledge_update', 'memory_read', 'memory_update', 'source_read'])

/** 工具输出中的结构化引用来自知识服务；普通工具/原文中的同名 JSON 不授予知识身份。 */
export function knowledgeOutputReferences(name: string, output: string): readonly KnowledgeReference[] {
  if (!KNOWLEDGE_MATERIAL_TOOLS.has(name)) return []
  let value: unknown
  try { value = JSON.parse(output) } catch { return [] }
  if (value === null || typeof value !== 'object') return []
  // 只解析真实内务工具的既定返回形状；失败的 memory_update 也返回当前快照。
  const snapshot = name === 'memory_update' && 'snapshot' in value ? value.snapshot : value
  const items = (name === 'memory_read' || name === 'memory_update') && snapshot !== null && typeof snapshot === 'object'
    && 'items' in snapshot && Array.isArray(snapshot.items) ? snapshot.items : [value]
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

export const STALE_KNOWLEDGE_NOTICE = '〔该材料引用的知识已纠正或遗忘，旧内容退出自动记忆使用；请沿当前有效知识重新核对。原始记录仍可明确读取。〕'
export const HISTORICAL_KNOWLEDGE_NOTICE = '〔本次明确读取的已失效历史证据；仅供核对原文，不能作为当前有效认识或自动重新记住。〕'

export function staleKnowledge(references: readonly KnowledgeReference[], knowledge?: KnowledgeRecords): boolean {
  return knowledge !== undefined && references.some(reference => !knowledge.isCurrent(reference))
}

/** 只改变送模型的材料；原始条目仍可通过明确历史读取。 */
export async function prepareKnowledgeMaterials(entries: readonly Entry[], knowledge?: KnowledgeRecords, explicit: ReadonlySet<number> = new Set()): Promise<{
  readonly entries: readonly Entry[]
  readonly knowledge: readonly KnowledgeReference[]
}> {
  const output: Entry[] = []
  const references = new Map<string, KnowledgeReference>()
  const content = { text: STALE_KNOWLEDGE_NOTICE }
  for (const original of entries) {
    // 用户交代仍有效；仅替换其中失效的引用材料，不吞掉其他引用或正文。
    const entry = original.kind === 'user' && original.payload !== undefined && 'refs' in original.payload
      ? { ...original, payload: { ...original.payload, refs: original.payload.refs?.map(ref => staleKnowledge(ref.knowledge ?? [], knowledge)
        ? explicit.has(original.id) ? { ...ref, text: `${HISTORICAL_KNOWLEDGE_NOTICE}\n${'text' in ref ? ref.text ?? '' : ''}` }
          : { ...ref, text: content.text, knowledge: [] } : ref) } } : original
    const used = entryKnowledgeReferences(entry)
    // 协作正文按部件展开并分别过滤，不能抹掉 messageId 或吞掉同件独立用户交代。
    if (entry.kind === 'agent-message') {
      output.push(entry)
      for (const reference of used) if (!staleKnowledge([reference], knowledge)) references.set(`${reference.id}\0${reference.revision}`, reference)
    } else if (entry.kind !== 'user' && staleKnowledge(used, knowledge) && !explicit.has(entry.id)) {
      output.push({ ...entry, content, payload: entry.kind === 'tool-result' && entry.payload !== undefined && 'output' in entry.payload
        ? { ...entry.payload, output: content, knowledge: [] }
        : entry.kind === 'tool-call' && entry.payload !== undefined && 'name' in entry.payload
          ? { ...entry.payload, args: { notice: STALE_KNOWLEDGE_NOTICE }, knowledge: [] } : undefined })
    } else {
      output.push(entry)
      for (const reference of used) references.set(`${reference.id}\0${reference.revision}`, reference)
    }
  }
  return { entries: output, knowledge: [...references.values()] }
}
