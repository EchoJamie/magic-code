import type { Entry, EventSink, EventStamper, ModelGateway, ModelMessage, RecordsService, SessionId, ToolSpec } from '@magic/contracts'
import { COMPACTION_HANDOFF_PREFIX, assembleContext, messageTokens } from './context.ts'
import { callMemoryModel } from './memory-model.ts'

/**
 * 同前缀内联压缩（B 方案核心 + A 方案一级微压缩后置）：
 *
 * 1. 优先复用与当前主对话完全一致的前缀（`systemPrompt` + 微压缩后历史 + `tools`），
 *    只在末尾追加一条交接指令，直接命中供应商 Prompt Cache；
 * 2. 禁止执行任何工具；若模型仍误吐 `tool_calls`，回退一次 `tools: undefined` 重试；
 * 3. 若压缩请求自身撞到 `context-limit`，保留系统提示与上版交接摘要，从最早的原子轮次
 *    起头裁剪后重试（最多 3 次）。
 */
export const COMPACT_INSTRUCTION_PREFIX = '【系统交接整理指令'

export type InlinePrefix = {
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolSpec[] | undefined
}

export type BriefCapacity = { readonly inputBudget?: number; readonly maxOutputTokens?: number; readonly identity?: string }
export type BriefDeps = {
  readonly records: RecordsService
  readonly session: SessionId
  readonly gateway: ModelGateway
  readonly capacity: BriefCapacity
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
  readonly signal?: AbortSignal | undefined
  readonly focus?: string | undefined
  readonly prefix?: InlinePrefix | undefined
  readonly timeoutMs?: number | undefined
}
export class BriefFailure extends Error {
  constructor(readonly kind: 'capacity' | 'incomplete', message: string) { super(message) }
}

function compactUserInstruction(focus: string | undefined, today: string, noToolsReminder = false): string {
  const reminder = noToolsReminder ? '\n（本次未提供工具，请直接输出以下五段正文。）' : ''
  return `${COMPACT_INSTRUCTION_PREFIX} — 请勿调用任何工具】
以上会话即将进行上下文压缩交接。请不要继续执行任务或调用任何工具，也不要把前文未执行的提议当作新的用户授权。
请基于以上对话与工具记录，写一份简体中文 Markdown 交接材料，固定以下五段（没有依据的段写“无”）：

## 目标与当前状态
## 仍然有效的约束与纠正
## 已经完成（含验证到哪一步）
## 未完成与下一步
## 证据位置

要求：
- 保留用户目标、仍有效的明确约束、最新纠正及其适用范围；早期约束未撤回就仍然有效。
- 区分用户要求、助手判断、成员材料；未经用户确认的提议不写成要求或授权。
- 区分尝试、改完、验证完；不把工具返回、保存成功或测试通过当成完成。
- 日期、数字、对象按原文语义保留；同一名称不表示同一件事，证据不足保留原义。
- 只写材料中实际存在的未决事项与下一步，不发明待办；不罗列工具调用流水。
- 必要的原文位置写成“会话#记录”，便于回查。
- 只输出这五段正文，不要输出工具调用标记、函数调用或 JSON 工具参数。${reminder}
本次整理重点：${focus ?? '无'}
当前日期：${today}。`
}

/** 将前缀中间部分按「完整交互/工具往返」切分，头裁剪时绝不撕裂 tool-call/tool-result 配对。 */
function partitionMiddleGroups(messages: readonly ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = []
  let index = 0
  while (index < messages.length) {
    const current = messages[index]!
    if (current.role === 'assistant') {
      let end = index
      while (end + 1 < messages.length && messages[end + 1]!.role === 'tool') end += 1
      groups.push(messages.slice(index, end + 1))
      index = end + 1
      continue
    }
    groups.push([current])
    index += 1
  }
  return groups
}

function splitInlinePrefix(base: readonly ModelMessage[]): { head: ModelMessage[]; middle: ModelMessage[][] } {
  if (base.length === 0) return { head: [], middle: [] }
  let headCount = 1
  const second = base[1]
  if (second?.role === 'user' && typeof second.content === 'string' && second.content.startsWith(COMPACTION_HANDOFF_PREFIX)) {
    headCount = 2
  }
  return {
    head: base.slice(0, headCount),
    middle: partitionMiddleGroups(base.slice(headCount)),
  }
}

export async function prepareBrief(deps: BriefDeps, entries: readonly Entry[]): Promise<{ readonly text: string; readonly through: number; readonly summarized: number }> {
  const budget = deps.capacity.inputBudget ?? 64_000
  const reserve = Math.max(512, Math.ceil(budget * 0.15))
  const tokenLimit = Math.max(2_000, budget - reserve)

  const baseMessages = deps.prefix?.messages ?? await assembleContext({
    records: deps.records,
    session: deps.session,
    systemPrompt: '你是 Magic Code 的会话交接整理者。',
    prune: false,
  })
  const { head, middle } = splitInlinePrefix(baseMessages)

  const today = new Date(deps.now()).toISOString().slice(0, 10)
  const buildMessages = (groups: readonly ModelMessage[][], noToolsReminder: boolean): ModelMessage[] => [
    ...head,
    ...groups.flat(),
    { role: 'user', content: compactUserInstruction(deps.focus, today, noToolsReminder) },
  ]
  const totalOf = (messages: readonly ModelMessage[]) => messages.reduce((sum, message) => sum + messageTokens(message), 0)

  // 若未经过一级裁剪仍超预算，先从头按完整原子轮次主动减载（保留 system 与旧摘要）。
  while (middle.length > 0 && totalOf(buildMessages(middle, false)) > tokenLimit) {
    middle.shift()
  }

  const maxOutputTokens = deps.capacity.maxOutputTokens
  let activeTools = deps.prefix?.tools
  let retriedWithoutTools = false
  let contextRetries = 0

  for (;;) {
    const request = {
      messages: buildMessages(middle, retriedWithoutTools),
      ...(activeTools !== undefined && activeTools.length > 0 ? { tools: activeTools } : {}),
    }
    const { text, reasoning, result, failure, model } = await callMemoryModel({
      purpose: 'compact',
      gateway: deps.gateway,
      request,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      sink: deps.sink,
      stamper: deps.stamper,
      now: deps.now,
    })

    if (failure?.tier === 'context-limit' && middle.length > 0 && contextRetries < 3) {
      contextRetries += 1
      const drop = Math.max(1, Math.ceil(middle.length * 0.25))
      middle.splice(0, drop)
      continue
    }

    if (failure === undefined && !retriedWithoutTools && activeTools !== undefined && activeTools.length > 0
      && (result.finishReason === 'tool-calls' || ((result.toolCalls?.length ?? 0) > 0 && text.trim() === ''))) {
      retriedWithoutTools = true
      activeTools = undefined
      continue
    }

    if (failure !== undefined || !result.complete || (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')) {
      if (failure !== undefined) {
        throw new BriefFailure(failure.tier === 'context-limit' ? 'capacity' : 'incomplete', failure.message)
      }
      const who = model ?? '未知模型'
      const textChars = text.trim().length
      const thinkingInfo = reasoning === '' ? '' : `，思考 ${reasoning.length} 字`
      const usageInfo = result.usage?.outputTokens === undefined
        ? ''
        : `，输出 ${result.usage.outputTokens} tokens${result.usage.reasoningTokens === undefined ? '' : `（含思考 ${result.usage.reasoningTokens}）`}`
      if (result.finishReason === 'length') {
        const capInfo = maxOutputTokens === undefined ? '' : `（上限 ${maxOutputTokens}）`
        throw new BriefFailure(
          'capacity',
          `交接材料未完整生成：${who} 触及输出上限${capInfo}被截断（正文 ${textChars} 字${thinkingInfo}${usageInfo}，finish_reason=length）。思考型模型可能耗尽了输出额度——换用输出额度更大或可关闭思考的模型后重试。`,
        )
      }
      const reason = result.finishReason ?? (result.complete ? '未知' : '流中断')
      throw new BriefFailure(
        'incomplete',
        `交接材料没有完整生成：${who} 未正常结束（正文 ${textChars} 字${thinkingInfo}${usageInfo}，finish_reason=${reason}）`,
      )
    }

    const brief = text.trim()
    if (brief === '') {
      // 空正文要说清是谁、回了什么：模型名、思考与正文的字数、结束原因——
      // 只说「材料为空」让用户无从下手（2026-11-23 用户反馈）。
      const channels = reasoning === '' ? '' : `，思考通道有 ${reasoning.length} 字未计入`
      throw new BriefFailure('incomplete', `交接材料为空：${model ?? '未知模型'} 返回了空正文（正文 0 字${channels}，finish_reason=${result.finishReason}）。思考型模型可能只输出了推理过程——换用非思考模型后重试。`)
    }
    return { text: brief, through: entries.at(-1)?.id ?? 0, summarized: entries.length }
  }
}

/** 粗略 token 估算：CJK 约 1/字，ASCII 约 0.28/字符，其余 0.5；只用于把材料装进预算。 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) tokens += 1
    else if (code < 0x80) tokens += 0.28
    else tokens += 0.5
  }
  return Math.ceil(tokens)
}
