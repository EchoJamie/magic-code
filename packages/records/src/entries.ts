/**
 * 条目——行 ↔ 形态（判据 1 · 落取回环）。
 *
 * 出处：技术方案 · 记录（记录 schema v0 · 条目）· `@magic/contracts` · `entries`。
 *
 * 本文件补的一处**契约形态缺口**（M01 回报占位 9；U02 自决 · 只增不改）：
 * 契约的 `Entry.payload?: EntryPayload` 是可选的松散联合，`kind` 与载荷支的**强对应**
 * 在类型上表达不出来。落码处补两件，皆**只增**：
 * - **写入侧硬闸**——`appendEntry` 处校验对应关系（错配即拒，不落半条坏行）；
 * - **读取侧收窄**——`isToolCallEntry` / `isToolResultEntry` 类型守卫，
 *   消费者 `if (isToolCallEntry(entry))` 即可拿到窄化的 `payload`（不必 `as`）。
 *
 * 若规划侧后续在契约层落「按 kind 的映射」，两处可撤回包内——语义不变。
 */

import type {
  Content,
  Entry,
  EntryKind,
  EntryPayload,
  NewEntry,
  RecordId,
  SessionId,
  ToolCallPayload,
  ToolResultPayload,
} from '@magic/contracts'
import type { NamedParams } from './schema.ts'

/** `entries` 表的行形态（列名即落盘形态）。 */
export type EntryRow = {
  readonly id: number
  readonly session: string
  readonly kind: string
  readonly content_kind: string
  readonly content_text: string | null
  readonly content_blob: string | null
  readonly payload: string | null
  readonly at: number
  readonly source: string | null
}

/** `tool-call` 条目——`kind` 与载荷皆已收窄。 */
export type ToolCallEntry = Entry & { readonly kind: 'tool-call'; readonly payload: ToolCallPayload }
/** `tool-result` 条目——`kind` 与载荷皆已收窄。 */
export type ToolResultEntry = Entry & {
  readonly kind: 'tool-result'
  readonly payload: ToolResultPayload
}

// —— 写入侧 ——

/** 强对应的硬闸——不合即拒（`tool-call` / `tool-result` 必须带对应载荷，其余必须不带）。 */
export function assertEntryShape(entry: NewEntry): void {
  const toolEntry = entry.kind === 'tool-call' || entry.kind === 'tool-result'

  if (!toolEntry && entry.payload !== undefined) {
    throw new Error(
      `条目 kind=${entry.kind} 不带载荷——载荷只有工具条目有（技术方案 · 记录 · 条目：` +
        `tool-call＝名 + 参数 · tool-result＝ok / error + 输出）`,
    )
  }
  if (entry.kind === 'tool-call' && !isToolCallPayload(entry.payload)) {
    throw new Error('tool-call 条目的载荷须为 { name, args }——它是重放真源，不可省')
  }
  if (entry.kind === 'tool-result' && !isToolResultPayload(entry.payload)) {
    throw new Error('tool-result 条目的载荷须为 { ok, output }——它是重放真源，不可省')
  }
}

/** 条目 → 绑定参数（内容两列由判别列 `content_kind` 择一，载荷走 JSON 一列）。 */
export function entryParamsOf(id: RecordId, session: SessionId, entry: NewEntry): NamedParams {
  return {
    $id: id,
    $session: session,
    $kind: entry.kind,
    $contentKind: 'blob' in entry.content ? 'blob' : 'text',
    $contentText: 'text' in entry.content ? entry.content.text : null,
    $contentBlob: 'blob' in entry.content ? entry.content.blob : null,
    $payload: entry.payload === undefined ? null : JSON.stringify(entry.payload),
    $at: entry.at,
    $source: entry.source ?? null,
  }
}

// —— 读取侧 ——

export function entryOfRow(row: EntryRow): Entry {
  return {
    id: row.id,
    kind: row.kind as EntryKind,
    content:
      row.content_kind === 'blob'
        ? { blob: required(row.content_blob, 'content_blob') }
        : { text: required(row.content_text, 'content_text') },
    ...(row.payload === null ? {} : { payload: JSON.parse(row.payload) as EntryPayload }),
    at: row.at,
    ...(row.source === null ? {} : { source: row.source }),
  }
}

// —— 类型守卫（只增不改：补契约的强对应缺口）——

export function isToolCallEntry(entry: Entry): entry is ToolCallEntry {
  return entry.kind === 'tool-call' && isToolCallPayload(entry.payload)
}

export function isToolResultEntry(entry: Entry): entry is ToolResultEntry {
  return entry.kind === 'tool-result' && isToolResultPayload(entry.payload)
}

// —— 形态判据（无 `as`：靠 `unknown` 收窄，故外部数据进来也站得住）——

export function isToolCallPayload(payload: unknown): payload is ToolCallPayload {
  return isRecord(payload) && typeof payload['name'] === 'string' && isRecord(payload['args'])
}

export function isToolResultPayload(payload: unknown): payload is ToolResultPayload {
  return isRecord(payload) && typeof payload['ok'] === 'boolean' && isContent(payload['output'])
}

export function isContent(value: unknown): value is Content {
  return isRecord(value) && (typeof value['text'] === 'string' || typeof value['blob'] === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空列——库只由本包写入，取到 null 即异常，报出来好过静默给个假值。 */
function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`记录行损坏：${column} 缺失（库只由本包写入，出现即异常）`)
  return value
}
