import type { MemorySource, MaterialPage } from './memory.ts'

export type KnowledgeScope = { readonly kind: 'project'; readonly workspace: readonly string[] } | { readonly kind: 'user' }
export type KnowledgeReference = {
  readonly id: string
  readonly revision: number
  /** 仅作为材料提供的血缘；缺省表示实际采用，二者都参与纠正和遗忘。 */
  readonly provided?: true
}
export type Knowledge = {
  readonly id: string
  readonly scope: KnowledgeScope
  readonly topic: string
  readonly terms: readonly string[]
  readonly conclusion: string
  readonly conditions: string
  readonly evidence: 'fact' | 'hypothesis' | 'unresolved'
  readonly status: 'active' | 'pending' | 'invalid' | 'forgotten'
  readonly revision: number
  readonly sources: readonly MemorySource[]
  readonly dependencies: readonly KnowledgeReference[]
}
export type KnowledgeChange = Omit<Knowledge, 'revision' | 'status'> & {
  readonly expectedRevision: number
  readonly status: 'active' | 'pending' | 'invalid'
  /** 用户明确要求适用于所有工作的原始交代；不能从项目经验推定。 */
  readonly generalPreference?: MemorySource
}
export type KnowledgeQuery = {
  readonly query?: string
  readonly topic?: string
  readonly offset?: number
  readonly limit?: number
}
export type KnowledgePage = { readonly items: readonly Knowledge[]; readonly next?: number }
export type KnowledgeWriteResult =
  | { readonly ok: true; readonly items: readonly Knowledge[] }
  | { readonly ok: false; readonly reason: string }
export type KnowledgeForgetRequest = {
  readonly requestId: string
  readonly id: string
  readonly expectedRevision: number
}
export type KnowledgeForgetResult = {
  readonly status: 'completed' | 'changed' | 'processing' | 'unconfirmed'
  readonly current?: Knowledge
  readonly affected?: readonly string[]
}
export type KnowledgeCorrection = {
  readonly id: string
  readonly expectedRevision: number
  readonly changes: Partial<Omit<KnowledgeChange, 'id' | 'scope' | 'expectedRevision'>>
  /** 用户明确重新记住的本次原始交代；普通纠正不填。 */
  readonly remember?: MemorySource
}
export type KnowledgeSourcePage = MaterialPage & { readonly knowledge: readonly KnowledgeReference[] }
/** 由装配绑定已持久化的工作区；调用者不能自由扩展搜索范围。 */
export interface KnowledgeRecords {
  search(query?: KnowledgeQuery): KnowledgePage
  read(id: string): Knowledge | undefined
  /** 仅核验已有材料关系的状态/修订；不发现知识，也不返回跨范围正文。 */
  isCurrent(reference: KnowledgeReference): boolean
  write(changes: readonly KnowledgeChange[]): KnowledgeWriteResult
  forget(input: KnowledgeForgetRequest): KnowledgeForgetResult
  forgetResult(input: KnowledgeForgetRequest): KnowledgeForgetResult
  /** 仅明确重新记住的用户动作可调用，普通知识整理不拥有此入口。 */
  remember(change: KnowledgeChange, source: MemorySource): KnowledgeWriteResult
}
export interface KnowledgeAccess {
  search(query?: KnowledgeQuery): KnowledgePage
  read(id: string): Knowledge | undefined
  update(change: KnowledgeCorrection): Promise<KnowledgeWriteResult>
  source(id: string, source: MemorySource & { readonly limit?: number }): Promise<KnowledgeSourcePage>
}
