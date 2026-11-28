import type { Entry, EventDataOf, EventSink, EventStamper, ModelGateway, RecordsService, SessionId, WorkingNotes } from '@magic/contracts'
import type { BriefCapacity } from './brief.ts'
import { estimateTokens } from './brief.ts'
import { isRealUserEntry, rawTextOf } from './context.ts'
import { callMemoryModel } from './memory-model.ts'
import { substantiveEntries } from './organize.ts'

export type MemoryTidyDeps = {
  readonly records: RecordsService
  readonly session: SessionId
  readonly gateway: ModelGateway
  readonly notes?: WorkingNotes | undefined
  readonly capacity?: (() => BriefCapacity) | undefined
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
  readonly timeoutMs?: number | undefined
}

const TIDY_INSTRUCTION = `你是当前会话工作笔记（MEMORY.md）的整理助手。
本会话可能连续处理多个事项或阶段；用户现在明确发起整理，请你把「已经阶段性完成」的事项精简为耐久结论，同时保留「仍在进行/未决」的细节与有效约束。

输出要求（简体中文 Markdown，直接输出整理后的 MEMORY.md 全文）：
1. 保留仍在进行的事项、当前约束/纠正、未决问题与后续步骤所需的上下文细节；
2. 把已完成或已收尾阶段的试错过程、冗长日志与临时排查细节精简掉，只留关键结论、改动边界、验证状态与证据位置（“会话#记录”）；
3. 原笔记中仍有价值且未被后续纠正推翻的内容予以保留；不编造记录里没有的事实；
4. 只输出整理后的 Markdown 正文，不要输出函数调用或代码块包裹。
本次整理重点：`

const MAX_RECENT_ENTRIES = 160
const MAX_ENTRY_CHARS = 2_000
const MAX_RECENT_TOKENS = 24_000

async function formatRecentEntry(entry: Entry, records: RecordsService): Promise<string | undefined> {
  if (entry.kind === 'user') {
    if (!isRealUserEntry(entry)) return undefined
    const text = (await rawTextOf(entry.content, records)).trim()
    if (text === '') return undefined
    const body = text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}\n（截断，见会话#${entry.id}）`
    return `[用户 · 会话#${entry.id}]\n${body}`
  }
  if (entry.kind === 'assistant') {
    const text = (await rawTextOf(entry.content, records)).trim()
    if (text === '') return undefined
    const body = text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}\n（截断，见会话#${entry.id}）`
    return `[助手 · 会话#${entry.id}]\n${body}`
  }
  if (entry.kind === 'tool-result') {
    const ok = entry.payload !== undefined && 'ok' in entry.payload ? entry.payload.ok : true
    if (ok) return undefined
    const original = entry.payload !== undefined && 'output' in entry.payload ? entry.payload.output : entry.content
    const text = (await rawTextOf(original, records)).trim()
    if (text === '') return undefined
    const body = text.length <= MAX_ENTRY_CHARS ? text : `${text.slice(0, MAX_ENTRY_CHARS)}\n（截断，见会话#${entry.id}）`
    return `[失败工具结果 · 会话#${entry.id}]\n${body}`
  }
  return undefined
}

/** 显式整理精简工作笔记 MEMORY.md；独立于上下文压缩，不改变 coverage。 */
export async function tidyWorkingMemory(
  deps: MemoryTidyDeps,
  input: { readonly requestId: string; readonly focus?: string | undefined; readonly signal?: AbortSignal | undefined },
): Promise<EventDataOf['memory.tidy.state']> {
  const focus = input.focus?.trim() || undefined
  const base = { requestId: input.requestId, ...(focus === undefined ? {} : { focus }) }
  if (deps.notes?.overwrite === undefined) {
    return { ...base, state: 'failed', reason: '当前会话未挂载工作笔记目录' }
  }

  try {
    input.signal?.throwIfAborted()
    const snapshot = await deps.notes.snapshot()
    const existing = (snapshot['MEMORY.md'] ?? '').trim()

    const recent = substantiveEntries(await deps.records.readEntriesBack(deps.session, undefined, MAX_RECENT_ENTRIES))
    const blocks: string[] = []
    let usedTokens = 0
    for (let index = recent.length - 1; index >= 0; index--) {
      const formatted = await formatRecentEntry(recent[index]!, deps.records)
      if (formatted === undefined) continue
      const tokens = estimateTokens(formatted)
      if (usedTokens + tokens > MAX_RECENT_TOKENS && blocks.length > 0) break
      blocks.unshift(formatted)
      usedTokens += tokens
    }

    if (existing === '' && blocks.length === 0) {
      return { ...base, state: 'no-material', reason: '当前会话尚无工作笔记或记录可整理' }
    }

    const today = new Date(deps.now()).toISOString().slice(0, 10)
    const sections = [
      `【现有 MEMORY.md】\n${existing === '' ? '（当前为空）' : existing}`,
      ...(blocks.length === 0 ? [] : [`【近期会话记录（供核对已完成与未决事项）】\n${blocks.join('\n\n')}`]),
    ]
    const capacity = deps.capacity?.()
    const { text, reasoning, result, failure, model } = await callMemoryModel({
      purpose: 'memory-tidy',
      gateway: deps.gateway,
      request: {
        messages: [
          { role: 'system', content: `${TIDY_INSTRUCTION}${focus ?? '无'}\n当前日期：${today}。` },
          { role: 'user', content: sections.join('\n\n') },
        ],
      },
      ...(capacity?.maxOutputTokens === undefined ? {} : { maxOutputTokens: capacity.maxOutputTokens }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      sink: deps.sink,
      stamper: deps.stamper,
      now: deps.now,
    })

    if (input.signal?.aborted) {
      return { ...base, state: 'failed', reason: '本次整理已取消' }
    }
    if (failure !== undefined || !result.complete || (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')) {
      if (failure !== undefined) return { ...base, state: 'failed', reason: failure.message }
      const who = model ?? '未知模型'
      const reason = result.finishReason ?? (result.complete ? '未知' : '流中断')
      if (result.finishReason === 'length') {
        return { ...base, state: 'failed', reason: `${who} 整理笔记时触及输出上限被截断（finish_reason=length），原笔记已保留` }
      }
      return { ...base, state: 'failed', reason: `${who} 未完整生成整理结果（finish_reason=${reason}），原笔记已保留` }
    }

    const tidied = text.trim()
    if (tidied === '') {
      const channels = reasoning === '' ? '' : `，思考通道有 ${reasoning.length} 字未计入`
      return { ...base, state: 'failed', reason: `${model ?? '未知模型'} 返回了空正文（正文 0 字${channels}，finish_reason=${result.finishReason}），原笔记已保留` }
    }

    await deps.notes.overwrite('MEMORY.md', tidied)
    return { ...base, state: 'completed', path: 'MEMORY.md' }
  } catch (error) {
    const reason = input.signal?.aborted ? '本次整理已取消' : error instanceof Error ? error.message : String(error)
    return { ...base, state: 'failed', reason }
  }
}
