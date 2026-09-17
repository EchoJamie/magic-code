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
 * | `tool-result` | 空 | `{ ok, output }`——**重放真源**（大输出转 blob） |
 *
 * **工具条目的正文为什么留空**——它的「正文」就是载荷（结构对齐事件侧，契约规定）；
 * 两处各写一份只会让大输出在库里翻倍。装配读它时也只认载荷。
 *
 * **`at` 由调用方给**——记录域不取时钟（U02 备案）；本域取时钟只经 `now` 一处，
 * 装配时可注入固定钟（测试可复现）。
 */

import type { Content, RecordId, RecordsService, Timestamp, ToolCall, ToolResult } from '@magic/contracts'

/** 落账的依赖束——记录面 ＋ 时钟 ＋ 阈值（由循环的构造入参给出）。 */
export type EntryLog = {
  readonly records: RecordsService
  /** 时钟——**本域取时钟的唯一出处**（别处不各取各的）。 */
  readonly now: () => Timestamp
  /** 正文字数阈值——超者转 blob（见 `./policy.ts`）。 */
  readonly blobThreshold: number
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

/** 工具结果条目——`{ ok, output }` 载荷（大输出转 blob）。 */
export async function appendToolResultEntry(log: EntryLog, result: ToolResult): Promise<RecordId> {
  return log.records.appendEntry({
    kind: 'tool-result',
    content: { text: '' },
    payload: { ok: result.ok, output: await contentOf(result.output, log) },
    at: log.now(),
  })
}

/** 正文 → 内容——超阈值转 blob（规则 ②：大负载落 blob）；**写权唯一归记录域**（经其公开面）。 */
async function contentOf(text: string, log: EntryLog): Promise<Content> {
  if (text.length <= log.blobThreshold) return { text }

  return { blob: await log.records.blobs.put(text) }
}
