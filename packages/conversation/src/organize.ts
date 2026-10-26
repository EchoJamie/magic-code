import { knowledgeOutputReferences, staleKnowledge, STALE_KNOWLEDGE_NOTICE } from './knowledge-material.ts'
import { callMemoryModel } from './memory-model.ts'
import type { Entry, ModelGateway, RecordsService, SessionId, ToolSpec, MemoryUpdate, RecordId, ModelMessage, MemorySource, EventSink, EventStamper } from '@magic/contracts'
import { materialTextOf } from './material.ts'
import { announceMemoryPlan, createMemoryAccess, createMemorySourceReader, memoryBlock } from './memory.ts'
import { appendTextEntry, appendToolCallEntry, appendToolResultEntry, type EntryLog } from './entries.ts'

export const MEMORY_TOOLS = new Set(['memory_read', 'memory_update', 'source_read'])

/** 内务工具的结果不再作为待整理业务材料；公开正文仍保留。 */
export function substantiveEntries(entries: readonly Entry[]): readonly Entry[] {
  const skip = new Set<RecordId>()
  const interaction = entries.filter(entry => entry.kind !== 'agent-message')
  for (let index = 0; index < interaction.length; index += 1) {
    const entry = interaction[index]!
    if (entry.kind !== 'tool-call' || entry.payload === undefined || !('name' in entry.payload) || !MEMORY_TOOLS.has(entry.payload.name)) continue
    skip.add(entry.id)
    if (interaction[index + 1]?.kind === 'tool-result') skip.add(interaction[index + 1]!.id)
    const anchor = interaction[index - 1]
    if (anchor?.kind === 'assistant' && 'text' in anchor.content && anchor.content.text.trim() === '') skip.add(anchor.id)
  }
  return entries.filter(entry => entry.kind !== 'summary' && !skip.has(entry.id))
}

/** 仅在历史即将移出且尚未承接时调用当前模型；允许补读后提交，失败保留整个范围。 */
export async function organizeWorkingMemory(input: {
  readonly knowledge?: import('@magic/contracts').KnowledgeRecords
  readonly records: RecordsService
  readonly session: SessionId
  readonly gateway: ModelGateway
  readonly tools: readonly ToolSpec[]
  readonly entries: readonly Entry[]
  readonly through: RecordId
  readonly signal?: AbortSignal
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
  readonly blobThreshold: number
}): Promise<void> {
  input.signal?.throwIfAborted()
  const access = createMemoryAccess(input)
  const before = input.records.memory.read()
  const source = createMemorySourceReader(input, before, input.through)
  if ((before.inspectedThrough ?? 0) >= input.through) return
  const fresh = substantiveEntries(input.entries).filter(entry => entry.id > (before.inspectedThrough ?? 0))
  if (fresh.length === 0) {
    const result = input.records.memory.update({ expectedRevision: before.revision, changes: [], inspectedThrough: input.through })
    if (!result.ok) throw new Error(result.reason)
    announceMemoryPlan(input, result.snapshot, input.through)
    return
  }
  const specs = input.tools.filter(tool => MEMORY_TOOLS.has(tool.name))
  if (!specs.some(tool => tool.name === 'memory_update')) throw new Error('当前模型未装配工作记忆维护工具；未移走原材料')
  const provided = new Map<string, import('@magic/contracts').KnowledgeReference>()
  const include = (references: readonly import('@magic/contracts').KnowledgeReference[]) => {
    for (const reference of references) provided.set(`${reference.id}\0${reference.revision}`, reference)
  }
  for (const item of before.items) if (item.status !== 'invalid') include(item.knowledge ?? [])
  const rendered = await Promise.all(fresh.map(async entry => {
    const body = await materialTextOf(entry, input.records, input.session, input.knowledge)
    include(body.knowledge)
    return `【来源 ${input.session}#${entry.id} · ${body.speaker} · ${entry.kind}】\n${body.text}`
  }))
  input.signal?.throwIfAborted()
  const messages: ModelMessage[] = [
    { role: 'system', content: '这是当前工作的受限记忆整理。只维护自身工作记忆，不执行业务、不给用户答复。下面提供待整理公开材料。保留有效要求、最新纠正、全部未决点、事实/假设/已验证范围与准确来源，不把协作回报升级为用户授权。可以 memory_read 或 source_read 补查，只能读取冻结上界内的材料。最后用 memory_update 一次提交必要增量和 inspectedThrough；无需改变时 changes=[]。不要改无关事项；整理位置只证明检查过，不证明语义完整。' },
    { role: 'user', content: `${memoryBlock(before)}\n\n冻结上界：${input.through}；预期修订：${before.revision}\n\n${rendered.join('\n\n')}` },
  ]
  const log: EntryLog = { records: input.records, now: input.now, blobThreshold: input.blobThreshold }
  for (;;) {
    input.signal?.throwIfAborted()
    if (input.records.memory.read().revision !== before.revision) throw new Error('整理期间工作记忆修订已变化；请按最新认识重新处理')
    const { text, reasoning, result, failure } = await callMemoryModel({
      purpose: 'organize', gateway: input.gateway, request: { messages, tools: specs },
      ...(input.signal === undefined ? {} : { signal: input.signal }), sink: input.sink, stamper: input.stamper, now: input.now,
    })
    input.signal?.throwIfAborted()
    if (failure !== undefined || !result.complete) throw new Error(failure?.message ?? '工作记忆整理未完整结束')
    const calls = result.toolCalls ?? []
    if (calls.length === 0) throw new Error('整理未确认冻结范围；原材料保留')
    if (calls.some(call => !MEMORY_TOOLS.has(call.name))) throw new Error('受限整理不允许业务工具')
    const updates = calls.filter(call => call.name === 'memory_update')
    if (updates.length > 1 || (updates.length === 1 && calls.at(-1)?.name !== 'memory_update')) throw new Error('整理应在读完材料后最后提交一次 memory_update')
    if (updates.length === 1) {
      const update = updates[0]!.args as MemoryUpdate
      if (update.expectedRevision !== before.revision || update.inspectedThrough !== input.through || !Array.isArray(update.changes)) throw new Error('整理提交未对应冻结的修订与来源范围')
    }
    messages.push({ role: 'assistant', content: text, toolCalls: calls,
      ...(reasoning ? { reasoning } : {}), ...(result.reasoningState === undefined ? {} : { reasoningState: result.reasoningState }) })
    const supplied = [...provided.values()]
    await appendTextEntry(log, 'assistant', '', undefined, supplied)
    for (const call of calls) {
      appendToolCallEntry(log, call, supplied)
      let output: string; let ok = false
      try {
        input.signal?.throwIfAborted()
        if (call.name === 'memory_read') {
          const current = access.read()
          if (current.revision !== before.revision) throw new Error('整理期间工作记忆修订已变化')
          output = JSON.stringify(current)
          ok = true
        } else if (call.name === 'source_read') {
          const requested = call.args as MemorySource & { readonly limit?: number }
          output = JSON.stringify(await source(requested))
          ok = true
        } else {
          const committed = access.update(call.args as MemoryUpdate)
          ok = committed.ok
          output = JSON.stringify(committed)
        }
      } catch (error) { output = error instanceof Error ? error.message : String(error) }
      const references = knowledgeOutputReferences(call.name, output)
      const resultId = appendToolResultEntry(log, { ok, text: output, content: { text: output } }, references)
      messages.push({ role: 'tool', callId: call.id, name: call.name, ok,
        output: staleKnowledge(references, input.knowledge) ? STALE_KNOWLEDGE_NOTICE : output })
      if (!staleKnowledge(references, input.knowledge)) include(references)
      if (!ok) throw new Error(output)
      if (call.name === 'memory_update') {
        announceMemoryPlan(input, input.records.memory.read(), resultId)
        return
      }
    }
  }
}
