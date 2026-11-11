import type {
  KnowledgeAccess, KnowledgeRecords, MaterialPage, MemorySource,
} from '@magic/contracts'

const sameSource = (a: MemorySource, b: MemorySource): boolean => a.session === b.session && a.entry === b.entry && a.part === b.part

/** 模型和只读页面均经已选知识取得具体证据，不授予来源会话的历史查询权。 */
export function createKnowledgeAccess(input: {
  readonly records: KnowledgeRecords
  readonly writable: boolean
  /** 无 evidence 时按当前会话已绑定权限读取；evidence 仅由下方选中知识校验后给出。 */
  readonly material: (source: MemorySource & { readonly limit?: number }, evidence?: readonly MemorySource[]) => Promise<MaterialPage>
}): KnowledgeAccess {
  const observed = new Map<string, number>()
  return {
    search: query => input.records.search(query),
    read(id) {
      const item = input.records.read(id)
      if (item !== undefined) observed.set(id, item.revision)
      return item
    },
    async update(change) {
      if (!input.writable) return { ok: false, reason: '咨询成员不能修改共同知识' }
      const current = input.records.read(change.id)
      if (current === undefined || observed.get(change.id) !== current.revision || change.expectedRevision !== current.revision) {
        return { ok: false, reason: '纠正前须先精读该知识的最新内容与修订' }
      }
      try {
        if (change.remember !== undefined && (await input.material({ ...change.remember, limit: 1 })).speaker !== 'user') {
          return { ok: false, reason: '重新记住需要明确用户交代，不能使用通知或模型输出' }
        }
        for (const source of change.changes.sources ?? []) {
          if (!current.sources.some(prior => sameSource(source, prior) && (source.offset ?? 0) >= (prior.offset ?? 0))) await input.material({ ...source, limit: 1 })
        }
      } catch (error) {
        return { ok: false, reason: `新增来源未获当前会话授权：${error instanceof Error ? error.message : String(error)}` }
      }
      const updated = { ...current, status: current.status === 'forgotten' ? 'invalid' as const : current.status,
        ...change.changes,
        ...(change.changes.dependencies === undefined ? {} : { dependencies: change.changes.dependencies.map(({ id, revision }) => ({ id, revision })) }),
        id: current.id, scope: current.scope, expectedRevision: change.expectedRevision }
      return change.remember === undefined ? input.records.write([updated]) : input.records.remember(updated, change.remember)
    },
    async source(id, source) {
      const item = input.records.read(id)
      if (item === undefined || !item.sources.some(allowed => sameSource(allowed, source) && (source.offset ?? 0) >= (allowed.offset ?? 0))) {
        throw new Error('此来源不属于所选知识的具体证据')
      }
      const page = await input.material(source, item.sources)
      if (input.records.read(id)?.revision !== item.revision) throw new Error('读取证据期间知识已改变，请重新读取')
      return { ...page, knowledge: [{ id, revision: item.revision }] }
    },
  }
}
