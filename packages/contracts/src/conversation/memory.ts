import type { RecordId, SessionId } from '../shared/ids.ts'
import type { KnowledgeReference } from './knowledge.ts'

/** 原文身份；part 省略为完整材料，-1 为真实 user 原始正文，非负为引用序号。offset 定位该段，不代表文件当前内容。 */
export type MemorySource = { readonly session: SessionId; readonly entry: RecordId; readonly part?: number; readonly offset?: number }
export type SummaryPayload = {
  readonly coveredThrough: RecordId
  readonly from: RecordId
  readonly format?: 'compaction-v2'
  readonly retainedUsers?: readonly RecordId[]
  /** 新接续覆盖的提交标记；旧摘要不代表笔记已保存。 */
  readonly notesSaved?: boolean
  /** 本条摘要正文是接续简报；旧摘要不参与重注。 */
  readonly brief?: boolean
  readonly memoryRevision?: number
  readonly previousSummary: RecordId | null
  readonly sources: readonly MemorySource[]
  /** 历史摘要材料中实际出现的知识来源。 */
  readonly knowledge?: readonly KnowledgeReference[]
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
