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
  /**
   * **这条会话属于哪个工作区**（U26）——**建立时锚定的那组根**（绝对路径 · 声明序，
   * `[0]` ＝默认根；多根见词典 Workspace：「≥ 1 条路径的联合作用域」）。
   *
   * **为何记整组而不是单取默认根**：这一列是给**恢复**用的（「回到原位，不由当下的
   * 启动目录临时决定」）——只记默认根的话，多根工作区恢复时重建不回去。
   *
   * **缺席＝列加上之前落账的会话**（无法知道，**不编**——同 `title` 的缺席之辨）。
   * 词典 · Workspace / Session（2026-09-19 改）：一个会话属于一个工作区，归属
   * **随记录持久**。
   *
   * ⚠️ 形态与配置的 `WorkspaceRoots`（`config.ts`）同形——**不为它 import 那个名字**：
   * `entries → config → ports → entries` 会绕成一个环，而共享语言里这一处只是「一组根」。
   * 两处同形是**一件事的两个入口**（配置声明什么 / 会话记下什么），不是两个概念。
   */
  readonly workspace?: readonly string[]
}
