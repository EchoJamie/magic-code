/**
 * 条目落账 —— 对话域的**写入侧**（读取侧＝装配，在 `./context.ts`）。
 *
 * 会话推进（条目落账）归对话域（技术方案 · 领域划分：对话域「不认知任何域的内部……
 * 会话推进（条目落账）归它」）。四类条目（技术方案 · 记录 · 条目）：
 *
 * | kind | 正文（`content`） | 载荷（`payload`） |
 * | --- | --- | --- |
 * | `user` / `assistant` | 正文（超阈值转 blob） | ——（非工具条目不带载荷） |
 * | `tool-call` | 空 | `{ name, args }`——**重放真源** |
 * | `tool-result` | **面向模型的文本**（工具域截好的那份） | `{ ok, output }`——**记录侧形态**，与 `tool.result` 事件的 `output` 同物 |
 * | `summary` | 摘要全文（超阈值同样转 blob） | ——（阶段 3 压缩的产物，见 `./compact.ts`） |
 *
 * **工具结果为什么两个字段各载一样**（第 2 轮 · 契约补锚）——契约 `ToolResult` 载**两样输出**：
 * `output` 是面向模型的文本（按上限截断），`content` 是记录侧形态（内联或 blob）。
 * 本域照此落两处：**正文**取 `output`（重放时逐字复原模型当时看到的那一份）；
 * **载荷**取 `content`（重放真源——大输出在库里是全量，不因截断丢尾巴）。
 * 此前把面向模型的文本当内联记，大输出下条目与事件会当场分叉——现已对齐。
 *
 * `tool-call` 条目的正文则留空：那次调用没有「给模型看的文本」（调用本身在助手消息里）。
 *
 * **`at` 由调用方给**——记录域不取时钟（U02 备案）；本域取时钟只经 `now` 一处，
 * 装配时可注入固定钟（测试可复现）。
 */

import type {
  Content,
  RecordId,
  RecordsService,
  Timestamp,
  ToolCall,
  ToolResult,
} from '@magic/contracts'

/** 落账的依赖束——记录面 ＋ 时钟 ＋ 阈值（由循环的构造入参给出）。 */
export type EntryLog = {
  readonly records: RecordsService
  /** 时钟——**本域取时钟的唯一出处**（别处不各取各的）。 */
  readonly now: () => Timestamp
  /** 正文字数阈值——超者转 blob（见 `./policy.ts`）。 */
  readonly blobThreshold: number
}

/**
 * 一条工具结果的**落账形态**——两样输出各归其位（见文件头注）：
 * `text` → 条目正文（面向模型）· `content` → 条目载荷（记录侧形态）。
 *
 * **为何不直接收 `ToolResult`**——违约路径（工具域抛异常，见 `./agent-loop.ts`）造不出
 * 一份 `ToolResult`：链引用 `callRef` 在违约路径上**无从取得**（`tool.call` 事件由工具域发，
 * 本域没见过）。落账只用到这两样，中间的形态差由本类型吸收——**不编造链引用**。
 */
export type ToolOutcome = {
  readonly ok: boolean
  /** 面向模型的文本——条目正文（重放时逐字复原模型看到的那份）。 */
  readonly text: string
  /** 记录侧形态——条目载荷（与该次 `tool.result` 事件的 `output` 同物）。 */
  readonly content: Content
}

/** 端口结果 → 落账形态——两样输出各取各的，改名不改义。 */
export function toolOutcomeOf(result: ToolResult): ToolOutcome {
  return { ok: result.ok, text: result.output, content: result.content }
}

/** 正文条目（`user` / `assistant`）——落账并回 id（事件按它引用这条内容）。 */
export async function appendTextEntry(
  log: EntryLog,
  kind: 'user' | 'assistant',
  text: string,
): Promise<RecordId> {
  return log.records.appendEntry({ kind, content: await contentOf(text, log), at: log.now() })
}

/**
 * 工具调用条目——`{ name, args }` 载荷。
 * 与后续的结果条目**成对**：「有调用无结果」＝在途（阶段 2 恢复的判据）。
 */
export function appendToolCallEntry(log: EntryLog, call: ToolCall): RecordId {
  return log.records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { name: call.name, args: call.args },
    at: log.now(),
  })
}

/** 工具结果条目——正文取面向模型的文本、载荷取记录侧形态（见 `ToolOutcome`）。 */
export function appendToolResultEntry(log: EntryLog, outcome: ToolOutcome): RecordId {
  return log.records.appendEntry({
    kind: 'tool-result',
    content: { text: outcome.text },
    payload: { ok: outcome.ok, output: outcome.content },
    at: log.now(),
  })
}

/**
 * 摘要条目——压缩的产物（技术方案 · 上下文压缩：「旧段交模型生成摘要 → 以 `summary`
 * 条目入库」）。
 *
 * 它与别的条目**同待遇**：正文超阈值照样转 blob（摘要也可能是长的），时间戳照样取
 * `log.now`。**只增不改**——旧段那些条目一条都不动，这条只是追加在末尾（append-only 不破）。
 */
export async function appendSummaryEntry(log: EntryLog, text: string): Promise<RecordId> {
  return log.records.appendEntry({
    kind: 'summary',
    content: await contentOf(text, log),
    at: log.now(),
  })
}

/** 正文 → 内容——超阈值转 blob（规则 ②：大负载落 blob）；**写权唯一归记录域**（经其公开面）。 */
async function contentOf(text: string, log: EntryLog): Promise<Content> {
  if (text.length <= log.blobThreshold) return { text }

  return { blob: await log.records.blobs.put(text) }
}
