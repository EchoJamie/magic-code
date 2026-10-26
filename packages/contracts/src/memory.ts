import type { RecordId, SessionId, Timestamp } from './ids.ts'
import type { Content, PlanStepStatus } from './entries.ts'
import type { KnowledgeReference } from './knowledge.ts'

/** 原文身份；part 省略为完整材料，-1 为真实 user 原始正文，非负为引用序号。offset 定位该段，不代表文件当前内容。 */
export type MemorySource = { readonly session: SessionId; readonly entry: RecordId; readonly part?: number; readonly offset?: number }
export type MemoryItem = {
  readonly id: string
  readonly kind: 'goal' | 'requirement' | 'fact' | 'decision' | 'question' | 'step' | 'verification'
  readonly text: string
  readonly detail?: string
  readonly scope?: string
  readonly evidence: 'fact' | 'hypothesis' | 'unresolved'
  readonly status: 'active' | 'resolved' | 'invalid'
  readonly sources: readonly MemorySource[]
  readonly revision: number
  /** 记录相关知识修订；provided: true 表示仅提供的材料依赖，未标记时表示实际采用。 */
  readonly knowledge?: readonly KnowledgeReference[]
  /** 当前工作模型标出的复用范围；user 仅用于用户明确通用要求。 */
  readonly reuse?: 'project' | 'user'
  readonly order?: number
  readonly progress?: PlanStepStatus
}
export type MemoryChange = Omit<MemoryItem, 'revision'>
export type MemorySnapshot = {
  readonly session: SessionId
  readonly revision: number
  readonly items: readonly MemoryItem[]
  readonly inspectedThrough: RecordId | null
  readonly summary: RecordId | null
  readonly coveredThrough: RecordId | null
}
export type MemoryUpdate = {
  readonly expectedRevision: number
  readonly changes: readonly MemoryChange[]
  /** 只在当前模型已实际检查该冻结范围后提交；无变化也可确认。 */
  readonly inspectedThrough?: RecordId
}
export type MemoryWriteResult = { readonly ok: true; readonly snapshot: MemorySnapshot } | { readonly ok: false; readonly reason: string; readonly snapshot: MemorySnapshot }
export type SummaryPayload = {
  readonly coveredThrough: RecordId
  readonly from: RecordId
  readonly memoryRevision: number
  readonly previousSummary: RecordId | null
  readonly sources: readonly MemorySource[]
  /** 本次摘要材料中实际出现的知识，用于纠正/遗忘后的精确失效。 */
  readonly knowledge?: readonly KnowledgeReference[]
}
/** 写入始终绑定所属会话，调用者不能传 SessionId 扩大权限。 */
export interface MemoryRecords {
  read(): MemorySnapshot
  update(input: MemoryUpdate): MemoryWriteResult
  publishSummary(input: { readonly expectedRevision: number; readonly previousSummary: RecordId | null; readonly content: Content; readonly coverage: SummaryPayload; readonly at: Timestamp; readonly compact?: { readonly requestId: string; readonly focus?: string } }): MemoryWriteResult
}
export type MaterialPage = {
  readonly knowledge?: readonly KnowledgeReference[]
  readonly source: MemorySource
  readonly speaker: string
  readonly kind: string
  readonly text: string
  readonly total: number
  readonly complete: boolean
  readonly next?: number
}
export interface MemoryAccess {
  read(): MemorySnapshot
  update(input: MemoryUpdate): MemoryWriteResult
  source(input: MemorySource & { readonly limit?: number }): Promise<MaterialPage>
}
