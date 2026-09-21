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
  UserPayload,
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

/**
 * 强对应的硬闸——不合即拒。
 *
 * | kind | 载荷 |
 * | --- | --- |
 * | `tool-call` | **必须有** `{ name, args }` |
 * | `tool-result` | **必须有** `{ ok, output }` |
 * | `user` | **可有**（U33 起：随这次交代送出去的技能材料；U36 起：带位置的引用）；不带＝纯文本交代 |
 * | 其余 | **必须没有** |
 *
 * **`user` 那一格是「只增不改」的落点**：加它之前落在库里的条目一条都不动
 * （没有载荷的 `user` 条目照读照认），而**没有材料的交代照样不带载荷**——
 * 旧写入路径产出的行与新路径产出的**逐字同形**（验收第一条：现有纯文本输入兼容）。
 * U36 加 `refs` 那一形时同理：**旧形（`skills`）一字未动**，旧记录照读。
 *
 * **为什么不给 `user` 也定成「必须有」**：那会把「这一次交代有没有带技能」这件事，
 * 变成每一行都要写一个空对象——空载荷与无载荷是两回事，落盘上多出一种毫无信息的形态。
 */
export function assertEntryShape(entry: NewEntry): void {
  if (entry.kind === 'tool-call') {
    if (!isToolCallPayload(entry.payload)) {
      throw new Error('tool-call 条目的载荷须为 { name, args }——它是重放真源，不可省')
    }
    return
  }

  if (entry.kind === 'tool-result') {
    if (!isToolResultPayload(entry.payload)) {
      throw new Error('tool-result 条目的载荷须为 { ok, output }——它是重放真源，不可省')
    }
    return
  }

  if (entry.kind === 'user') {
    if (entry.payload !== undefined && !isUserPayload(entry.payload)) {
      throw new Error(
        'user 条目的载荷只装这次交代带出去的材料——两形：`{ refs: [{ kind, at, marker, source, ' +
          'label, text }] }`（U36：带位置的那一份）或 `{ skills: [{ name, source, label, text }] }`' +
          '（U33 旧形：无位置）。别的东西没有位置（技术方案 · 记录 · 条目：载荷是重放真源，不是杂物抽屉）',
      )
    }
    return
  }

  if (entry.payload !== undefined) {
    throw new Error(
      `条目 kind=${entry.kind} 不带载荷——载荷只有工具条目与 user 条目有（技术方案 · 记录 · 条目：` +
        `tool-call＝名 + 参数 · tool-result＝ok / error + 输出 · user＝随它送出去的技能材料）`,
    )
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

/**
 * `user` 条目的载荷（U33 · U36）——**只认那两形**：`{ refs: [...] }` 与 `{ skills: [...] }`。
 *
 * 两条判据，缺一不可：
 * - **只许这两个键**（可以只来一个，也可以两个都在）——载荷凭空多出别的键（比如把工具条目的
 *   `{ name, args }` 错位到 `user` 头上）当场拒。这正是「kind 与载荷强对应」这道硬闸在
 *   `user` 这一格的形态：**放行两种形状，不是放行一切形状**。
 * - **每一项该有的都在**——缺了位置 / 标记 / 身份 / 正文，那份材料就复原不出来（或复原得
 *   不是地方），而它正是这条载荷存在的理由（重放依据）。故写死在这儿，与 `tool-result`
 *   那条同一姿势。标签（`label`）不查：它只影响「来源怎么念」，缺了照收。
 *
 * ## 两形的分工（为什么不是一种）
 *
 * - `refs`（**U36 起**）：带位置（`at` ＋ `marker`）、有序——正文里那一处处引用，
 *   每一处连同**它的身份与实际交付内容**；
 * - `skills`（U33 旧形）：**按绑定时序、没有位置**。旧记录照读；旧调用方
 *   （无人值守脚本的 `{ skills }`）递进来的那一份也照旧落在这儿——**不替它编一个 `at`**。
 */
export function isUserPayload(payload: unknown): payload is UserPayload {
  if (!isRecord(payload)) return false
  if (Object.keys(payload).some((key) => key !== 'skills' && key !== 'refs')) return false

  const skills = payload['skills']
  if (skills !== undefined && !isUsedSkills(skills)) return false

  const refs = payload['refs']
  if (refs !== undefined && !isInputRefs(refs)) return false

  // 空载荷（一个键都没有）不算「带了材料」——它是「没有载荷」写错了地方
  return skills !== undefined || refs !== undefined
}

/** 旧形（U33）：技能材料三件齐全（名字 / 来源 / 正文）。 */
function isUsedSkills(skills: unknown): boolean {
  if (!Array.isArray(skills)) return false

  return skills.every((item) => {
    if (!isRecord(item)) return false
    return (
      typeof item['name'] === 'string' &&
      typeof item['source'] === 'string' &&
      typeof item['text'] === 'string'
    )
  })
}

/**
 * 新形（U36）：每一处**位置（`at` 数字 ＋ `marker` 字符串）＋ 身份（`source`）＋ 正文**，
 * `kind` 三支之一。技能那支另要有 `name`（回执与模型取引用都读它）。
 */
function isInputRefs(refs: unknown): boolean {
  if (!Array.isArray(refs)) return false

  return refs.every((item) => {
    if (!isRecord(item)) return false

    const kind = item['kind']
    if (kind !== 'skill' && kind !== 'file' && kind !== 'dir') return false
    if (typeof item['at'] !== 'number' || typeof item['marker'] !== 'string') return false
    if (typeof item['source'] !== 'string' || typeof item['text'] !== 'string') return false

    return kind !== 'skill' || typeof item['name'] === 'string'
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空列——库只由本包写入，取到 null 即异常，报出来好过静默给个假值。 */
function required<T>(value: T | null, column: string): T {
  if (value === null) throw new Error(`记录行损坏：${column} 缺失（库只由本包写入，出现即异常）`)
  return value
}
