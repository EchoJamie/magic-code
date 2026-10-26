import { entryKnowledgeReferences } from './knowledge-material.ts'
import type { Entry, InputRef, MaterialPage, MemorySource, RecordsService, SessionId, UserMessageContent } from '@magic/contracts'
import { collaborationBodyOf, rawTextOf, refsPayloadOf, userBodyOf, userPayloadOf } from './context.ts'

/** 同一份材料解释用于来源分页和压缩；不读取 assistant 的 reasoning 载荷。 */
export async function materialTextOf(entry: Entry, records: RecordsService, session: SessionId, knowledge?: import('@magic/contracts').KnowledgeRecords): Promise<{ text: string; speaker: string; knowledge: readonly import('@magic/contracts').KnowledgeReference[] }> {
  let content: UserMessageContent
  const references = new Map<string, import('@magic/contracts').KnowledgeReference>()
  const provided = (items: readonly import('@magic/contracts').KnowledgeReference[]) => { for (const item of items) references.set(`${item.id}\0${item.revision}`, item) }
  if (entry.kind !== 'agent-message') provided(entryKnowledgeReferences(entry))
  let speaker: string = entry.kind
  if (entry.kind === 'agent-message') {
    const actor = records.collaboration.agentForSession(session)
    if (actor === undefined || entry.payload === undefined || !('messageId' in entry.payload)) throw new Error(`协作来源 ${session}#${entry.id} 缺少身份`)
    const message = records.collaboration.readMessage(actor.agentId, entry.payload.messageId)
    if (message === undefined || message.withdrawn) throw new Error(`协作来源 ${session}#${entry.id} 不可读取`)
    speaker = `agent:${message.senderId}`
    content = await collaborationBodyOf(message, actor.agentId, records, new Set(), { knowledge, provided })
  } else if (entry.kind === 'tool-call') {
    if (entry.payload === undefined || !('name' in entry.payload)) throw new Error(`工具调用来源 ${session}#${entry.id} 缺少操作载荷`)
    content = `${entry.payload.name} ${JSON.stringify(entry.payload.args)}`
  } else {
    const original = entry.kind === 'tool-result' && entry.payload !== undefined && 'output' in entry.payload ? entry.payload.output : entry.content
    const text = await rawTextOf(original, records)
    content = entry.kind === 'user' ? await userBodyOf(text, refsPayloadOf(entry.payload), userPayloadOf(entry.payload), records) : text
    if (entry.kind === 'user' && entry.payload !== undefined && 'notice' in entry.payload && entry.payload.notice) speaker = 'system-notice'
  }
  return { speaker, knowledge: [...references.values()], text: typeof content === 'string' ? content : content.map(part => part.type === 'text' ? part.text : `〔图片材料 ${part.mime}；原图保存在来源附件〕`).join('') }
}

export function createMaterialReader(input: {
  readonly records: RecordsService
  readonly session: SessionId
  /** 调用方从明确选中知识/事项取得的具体证据；不以工作区相同授予整段历史。 */
  readonly allowedSources?: readonly MemorySource[]
  /** 仅传实际受理记录中的引用；未绑定 through 的草稿不授予读取权。 */
  readonly references?: readonly Extract<InputRef, { kind: 'session' }>[]
}) {
  return async (source: MemorySource & { readonly limit?: number }): Promise<MaterialPage & { readonly knowledge?: readonly import('@magic/contracts').KnowledgeReference[] }> => {
    const exact = input.allowedSources?.some(allowed => allowed.session === source.session && allowed.entry === source.entry
      && allowed.part === source.part && (source.offset ?? 0) >= (allowed.offset ?? 0)) === true
    const referenced = input.references?.some(ref => ref.source === source.session && ref.through !== undefined
      && Number.isSafeInteger(ref.through) && source.entry > 0 && source.entry <= ref.through) === true
    if (source.session !== input.session && !exact && !referenced) throw new Error('来源不在当前会话绑定范围或明确证据范围内')
    let found: Entry | undefined
    for await (const entry of input.records.readEntries(source.session, { from: source.entry, to: source.entry })) found = entry
    if (found === undefined) throw new Error(`来源不存在：${source.session}#${source.entry}`)
    let material = await materialTextOf(found, input.records, source.session)
    if (source.part === -1) {
      if (found.kind !== 'user' || (found.payload !== undefined && 'notice' in found.payload && found.payload.notice)) throw new Error('正文定位仅允许真实用户交代，不能使用通知或其他材料')
      material = { speaker: 'user', text: await rawTextOf(found.content, input.records), knowledge: entryKnowledgeReferences(found, source.part) }
    } else if (source.part !== undefined) {
      if (!Number.isSafeInteger(source.part) || source.part < 0) throw new Error('来源引用位置无效')
      const ref = refsPayloadOf(found.payload)[source.part]
      if (ref === undefined) throw new Error('来源附件段不存在')
      if (ref.kind === 'image') throw new Error('该段为图片，请沿原图输入读取；不能作为文本返回')
      if (ref.text === undefined) throw new Error('该附件未保存正文；路径不是历史内容快照')
      material = { speaker: found.kind === 'user' ? 'reference' : material.speaker, text: ref.text, knowledge: entryKnowledgeReferences(found, source.part) }
    }
    const offset = source.offset ?? 0
    const limit = source.limit ?? 8000
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > material.text.length || !Number.isSafeInteger(limit) || limit < 1) throw new Error('材料分页位置或长度无效')
    const text = material.text.slice(offset, offset + Math.min(limit, 32000))
    const next = offset + text.length
    const knowledge = material.knowledge
    return { source: { session: source.session, entry: source.entry, ...(source.part === undefined ? {} : { part: source.part }), offset }, speaker: material.speaker, kind: found.kind, text, total: material.text.length, complete: next === material.text.length, ...(next < material.text.length ? { next } : {}),
      ...(knowledge.length ? { knowledge } : {}) }
  }
}
