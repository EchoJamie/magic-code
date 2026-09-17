/**
 * Context 装配 —— **由会话条目重建模型消息**（技术方案 · 领域划分：上下文由对话域装配）。
 *
 * 三步：
 * ① 系统提示词即 `role:'system'` 的**首条**消息（提示词部件在 `./prompt/`，装配在 `./service.ts`）；
 * ② 条目按序展开——`user` / `assistant`（带 `toolCalls`）/ `tool`（`callId` / `name` / `ok` / `output`）；
 * ③ 条目里的 blob 引用在装配时**解析为文本**（按策略截断）——记录只存引用，正文归装配取回。
 *
 * **工具消息的正文取条目正文、不取载荷**（第 2 轮 · 契约补锚）——工具条目的两个字段载两样
 * 东西：正文＝**面向模型的文本**（工具域 `ToolResult.output`，按上限截断）；载荷＝**记录侧
 * 形态**（`ToolResult.content`，全量，可能是 blob）。送模型的是前者——重放时逐字复原模型
 * 当时看到的那一份；后者留给审计与阶段 2 恢复的处置。
 *
 * **为什么由条目重建**（不是维护一个内存数组）——技术方案 · 记录：「上下文由条目重建」；
 * 恢复（阶段 2）走的也是这条路。代价是每轮多读一次条目，换来的是**记录即真源**：
 * 循环中途崩掉 / 被中止，下一轮装配出来的仍是记录里那个现场。
 *
 * **两处形态缺口（规约 4：本单元自决形态 · 只增不改 · 随回报备案）**：
 *
 * 1. **配对键由条目 id 派生**（`pairingKeyOf`）。契约的 `ToolCall.id` 是**供应商侧**调用 id
 *    （「只用于回填配对」），而条目侧的 `ToolCallPayload` 只有 `{ name, args }`——供应商 id
 *    **不入记录**。故重建期的配对键取「该次 `tool-call` 条目的 id」：回填配对只要求
 *    「助手消息的 `ToolCall.id`」与「工具消息的 `callId`」**同一次请求内自洽**，条目 id
 *    唯一且跨轮稳定，正合此用。供应商 id 是**线上概念**（一次调用内有效），不入记录并无损失。
 *
 * 2. **落单的 `tool-call` 不进上下文**——有调用条目而无结果条目＝进程被杀那一路留下的**在途**
 *    调用（U02 备案：在途识别＝有 `tool.call` 无 `tool.result`）。带 `toolCalls` 而无对应
 *    工具消息的助手消息**会被供应商拒**（整条上下文作废），故此处**不送**；怎么处置这条在途
 *    （重放 / 补偿 / 拒绝）是阶段 2 恢复（U15）的判据——本单元只保证装配出的上下文合法。
 */

import type {
  Content,
  Entry,
  EntryPayload,
  ModelMessage,
  RecordId,
  RecordsService,
  SessionId,
  ToolCall,
  ToolResultPayload,
  ToolCallPayload,
} from '@magic/contracts'

/**
 * blob 解析回文本的缺省上限（**字符**）——「按策略截断」（技术方案 · 领域划分 · 端口内类型）。
 * 压缩（阶段 3）会换成真正的上下文策略；此处只定「一条 blob 正文最多带多少进上下文」。
 * 缺省值与策略对象（`./policy.ts`）同源——读侧单独用时不至于各写一个数。
 */
export const DEFAULT_BLOB_TEXT_LIMIT = 2000

export type AssembleContextInput = {
  readonly records: RecordsService
  /** 会话——条目按会话读（`readEntries` 的分束键）。 */
  readonly session: SessionId
  /** 系统提示词全文——由提示词部件装配好后传入（本文件不认知提示词的段结构）。 */
  readonly systemPrompt: string
  /** blob 正文上限（字符）——缺省 `DEFAULT_BLOB_TEXT_LIMIT`。 */
  readonly blobTextLimit?: number
}

/**
 * 装配上下文——由**会话条目**重建模型消息。
 *
 * 空会话的产物＝只有系统提示词一条（首条对话必是 `user`，故不会出现空对话的畸形请求）。
 */
export async function assembleContext(
  input: AssembleContextInput,
): Promise<readonly ModelMessage[]> {
  const limit = input.blobTextLimit ?? DEFAULT_BLOB_TEXT_LIMIT
  const messages: ModelMessage[] = [{ role: 'system', content: input.systemPrompt }]

  // 条目一次取尽——`assistant` 消息的 `toolCalls` 来自**紧随其后**的调用条目（需前瞻一拍），
  // 故先缓冲再走。上下文本就整条送模型，缓冲不增峰值（阶段 3 压缩时再议取法）。
  const entries: Entry[] = []
  for await (const entry of input.records.readEntries(input.session)) entries.push(entry)

  let index = 0
  while (index < entries.length) {
    const entry = entries[index]
    if (entry === undefined) break

    if (entry.kind === 'user') {
      messages.push({ role: 'user', content: await contentText(entry.content, input, limit) })
      index += 1
      continue
    }

    if (entry.kind === 'assistant') {
      const toolCalls: ToolCall[] = []
      const toolMessages: ModelMessage[] = []

      // 助手消息带上它请求的那些调用——写入侧按「调用 → 结果」成对落账、同轮按序逐个，
      // 故此处照序配对：`tool-call` 条目 ＋ 紧随的 `tool-result` 条目 ＝ 一次调用。
      let cursor = index + 1
      for (;;) {
        const callEntry = entries[cursor]
        const resultEntry = entries[cursor + 1]
        if (callEntry?.kind !== 'tool-call') break
        // 无结果＝在途调用——不进上下文（见文件头注 2），并就此打住本轮的配对
        if (resultEntry?.kind !== 'tool-result') break

        const call = toolCallPayloadOf(callEntry.payload)
        const result = toolResultPayloadOf(resultEntry.payload)
        if (call === undefined || result === undefined) break

        const pairKey = pairingKeyOf(callEntry.id)
        toolCalls.push({ id: pairKey, name: call.name, args: call.args })
        toolMessages.push({
          role: 'tool',
          callId: pairKey,
          // 工具名**取自发起它的调用条目**，不从助手消息反查——压缩（阶段 3）来时反查会静默退化
          name: call.name,
          ok: result.ok,
          // 正文取**条目正文**（面向模型的文本，工具域按上限截断的那份）——
          // **不是**载荷里的记录形态：那是全量（可能是 blob），送模型的是这份截断文本。
          // 重放时因此逐字复原模型当时看到的那一份。
          output: await contentText(resultEntry.content, input, limit),
        })
        cursor += 2
      }

      messages.push({
        role: 'assistant',
        content: await contentText(entry.content, input, limit),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      })
      messages.push(...toolMessages)
      index = cursor
      continue
    }

    // `tool-call` / `tool-result` 已在上面按对消费；走到这里＝落单者（在途 / 无来处），不进上下文。
    // `summary`（阶段 3 压缩留位）——留缝，本单元不产也不装配。
    index += 1
  }

  return messages
}

/**
 * 配对键——由 `tool-call` 条目的 id 派生（见文件头注 1）。
 *
 * 前缀是刻意的：供应商 id 形如 `call_1`，两串 id 在日志里**一眼分得开**，
 * 免得调试时把「记录里的配对键」误当「线上的调用 id」。
 */
export function pairingKeyOf(entryId: RecordId): string {
  return `entry_${entryId}`
}

// —— 内容 → 文本（blob 解析 ＋ 截断）——

/** 条目内容 → 文本：内联者原样，blob 引用者取回按策略截断。 */
async function contentText(
  content: Content,
  input: AssembleContextInput,
  limit: number,
): Promise<string> {
  if ('text' in content) return content.text

  const text = new TextDecoder().decode(await input.records.blobs.get(content.blob))
  if (text.length <= limit) return text

  // 截断留痕：模型看得到「这里被截了」与原文规模，才不会把半截结果当完整事实下结论
  return `${text.slice(0, limit)}\n…（截断：原文 ${text.length} 字符，以上为前 ${limit} 字符）`
}

// —— 载荷收窄（契约的 `Entry.payload` 是松散联合；域间不得互 import，故自持一份）——

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isContent(value: unknown): value is Content {
  return isRecord(value) && (typeof value['text'] === 'string' || typeof value['blob'] === 'string')
}

/** 判据收在 `unknown` 入口——`EntryPayload` 是对象联合，直接收窄不会长出索引面。 */
function toolCallPayloadOf(payload: EntryPayload | undefined): ToolCallPayload | undefined {
  const source: unknown = payload
  if (!isRecord(source)) return undefined

  const { name, args } = source
  if (typeof name !== 'string' || !isRecord(args)) return undefined

  return { name, args }
}

function toolResultPayloadOf(payload: EntryPayload | undefined): ToolResultPayload | undefined {
  const source: unknown = payload
  if (!isRecord(source)) return undefined

  const { ok, output } = source
  if (typeof ok !== 'boolean' || !isContent(output)) return undefined

  return { ok, output }
}
