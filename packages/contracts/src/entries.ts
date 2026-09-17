/**
 * 共享语言 · 条目与 blob 引用（已冻结 v0）。
 *
 * 出处：技术方案 · 记录（「记录 schema v0」· 条目）。
 * **内容流**——对话、工具调用与结果的持久形态（append-only）；恢复＝由条目重建现场。
 */

import type { BlobRef, RecordId, SessionId, Timestamp } from './ids.ts'

/** 内容承载——正文内联，或大负载转 blob 引用。 */
export type Content = { readonly text: string } | { readonly blob: BlobRef }

/** 条目 kind。 */
export type EntryKind =
  | 'user' // 用户输入
  | 'assistant' // 助手产出
  | 'tool-call' // 名 + 参数
  | 'tool-result' // ok / error + 输出
  | 'summary' // 压缩摘要（阶段 3 留位）

/**
 * `tool-call` 载荷——**结构对齐事件侧**（`EventDataOf['tool.call']`），为重放真源。
 * 不带 `call` 引用——条目自身即那次调用。
 */
export type ToolCallPayload = {
  readonly name: string
  /** 工具各自的参数模式。 */
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * `tool-result` 载荷——**结构对齐事件侧**（`EventDataOf['tool.result']`），为重放真源。
 * 不带 `call` 引用（同上）。
 */
export type ToolResultPayload = {
  readonly ok: boolean
  /** 内联或 blob 引用。 */
  readonly output: Content
}

/** 工具条目的载荷（技术方案 · 记录：条目字段「载荷」——工具条目有，其余 kind 无）。 */
export type EntryPayload = ToolCallPayload | ToolResultPayload

/** 会话条目——对话、工具调用与结果的持久形态（append-only）。 */
export type Entry = {
  readonly id: RecordId
  readonly kind: EntryKind
  readonly content: Content
  /**
   * 载荷——`tool-call` / `tool-result` 有（结构对齐事件侧、为重放真源）；其余 kind 无。
   *
   * TODO(规划侧)：kind 与载荷支的**强对应**未在类型上表达（此处为可选联合）；
   * 若需编译期强制，可改为按 kind 的映射——属只增不改，等单元实需时再定。
   */
  readonly payload?: EntryPayload
  readonly at: Timestamp
  /** 来源引用（协作立条前的占位——委派关系可表达为引用链）。 */
  readonly source?: SessionId
}

/** 新增条目——未分配 `id` 的条目（`RecordsService.appendEntry` 的入参）。 */
export type NewEntry = Omit<Entry, 'id'>

/**
 * 条目范围（读取用）。
 *
 * TODO(规划侧)：形态未定；占位为可选起止（含端点与否亦未定）。
 */
export type EntryRange = {
  readonly from?: RecordId
  readonly to?: RecordId
}

/**
 * 会话摘要（列表用）。
 *
 * TODO(规划侧)：形态未定；占位为 id + 标题 + 时间
 * （技术方案 · 会话与多会话：标题＝首条消息摘要、可改）。
 */
export type SessionSummary = {
  readonly id: SessionId
  readonly title?: string
  readonly at: Timestamp
}
