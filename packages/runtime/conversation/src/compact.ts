import type { Entry, EventSink, EventStamper, ModelGateway, RecordId, RecordsService, SessionId, ToolRuntime, WorkingNotes } from '@magic/contracts'
import { BriefFailure, prepareBrief, type BriefCapacity } from './brief.ts'
import { PreparationFailure, preparationReserve, substantiveEntries } from './organize.ts'
import { readPlanOf } from './plan.ts'

export type CompactTrigger = 'threshold' | 'context-limit'
export type CompactFailureKind = 'configuration' | 'no-material' | 'local-capacity' | 'remote-capacity' | 'transient' | 'canceled' | 'changed'
export type CompactOutcome = ({ readonly notesSaved: boolean } & (
  | { readonly ok: true; readonly summary: RecordId; readonly summarized: number; readonly kept: number }
  | { readonly ok: false; readonly reason: string; readonly kind: CompactFailureKind; readonly canContinue: boolean }
))
export type Compactor = {
  readonly nearEntries: number
  observe(usage: { readonly inputTokens?: number | undefined; readonly contextWindow?: number | undefined }): void
  needed(): boolean
  run(input: { readonly trigger: CompactTrigger; readonly signal?: AbortSignal | undefined; readonly compact?: { readonly requestId: string; readonly focus?: string } }): Promise<CompactOutcome>
}
export type CompactorDeps = {
  readonly records: RecordsService; readonly session: SessionId
  readonly gateway: ModelGateway
  /** 旧接续装配的依赖；简报路径不再使用，保留字段以免装配面同时改两处。 */
  readonly notes?: WorkingNotes
  readonly noteTools?: (notes: WorkingNotes) => ToolRuntime
  readonly capacity?: () => BriefCapacity
  readonly inputVersion?: () => number
  readonly sink: EventSink; readonly stamper: EventStamper; readonly now: () => number
  readonly nearEntries: number; readonly compactAtFraction: number; readonly compactAtTokens: number
}

/** 只在完整交互边界移出旧段；准备期间的新材料保留在上界之后。 */
export function frozenSegment(all: readonly Entry[], nearEntries: number): readonly Entry[] {
  const meaningful = substantiveEntries(all)
  const keepFrom = meaningful[Math.max(0, meaningful.length - Math.max(1, nearEntries))]?.id
  let cut = keepFrom === undefined ? 0 : all.findIndex(entry => entry.id === keepFrom)
  const interaction = all.filter(entry => entry.kind !== 'agent-message')
  const next = interaction.find(entry => entry.id >= (all[cut]?.id ?? Infinity))
  if (next?.kind === 'tool-call' || next?.kind === 'tool-result') {
    while (cut > 0 && all[cut]?.kind !== 'assistant') cut--
  }
  for (let index = 0; index < interaction.length; index++) {
    const entry = interaction[index]!
    if (entry.id >= (all[cut]?.id ?? Infinity)) break
    if (entry.kind === 'tool-call' && interaction[index + 1]?.kind !== 'tool-result') {
      cut = all.indexOf(entry)
      while (cut > 0 && all[cut]?.kind !== 'assistant') cut--
      break
    }
  }
  return all.slice(0, cut)
}

export function createCompactor(deps: CompactorDeps): Compactor {
  let usage: number | undefined, contextWindow: number | undefined
  let failedBasis: string | undefined
  return {
    nearEntries: deps.nearEntries,
    observe(reading) { if (reading.inputTokens !== undefined) { usage = reading.inputTokens; contextWindow = reading.contextWindow } },
    needed() {
      if (usage === undefined) return false
      const threshold = contextWindow === undefined ? deps.compactAtTokens : Math.floor(contextWindow * deps.compactAtFraction)
      const budget = deps.capacity?.().inputBudget
      return usage >= (budget === undefined ? threshold : Math.min(threshold, Math.max(0, budget - preparationReserve(budget))))
    },
    async run({ trigger, signal, compact }) {
      let basisKey: string | undefined
      try {
        signal?.throwIfAborted()
        const before = deps.records.coverage.read()
        const version = deps.inputVersion?.()
        const inputs = () => JSON.stringify(deps.records.inputs.list().filter(row => row.input.notice !== true).map(row => [row.ref, row.revision, row.input]))
        const inputBasis = inputs()
        const plan = readPlanOf(deps.records, deps.session)
        const capacity = deps.capacity?.() ?? { inputBudget: contextWindow }
        const all = substantiveEntries(await Array.fromAsync(deps.records.readEntries(deps.session, { from: (before.coveredThrough ?? 0) + 1 })))
        const old = frozenSegment(all, deps.nearEntries)
        const last = old.at(-1)?.id
        if (last === undefined) return { ok: false, kind: 'no-material', reason: '近段之外没有可整理的完整交互', canContinue: true, notesSaved: false }
        basisKey = JSON.stringify([before, last, version, inputBasis, plan.entry, capacity])
        if (compact === undefined && basisKey === failedBasis) return { ok: false, kind: 'transient', reason: '相同接续条件已失败，等待材料或条件变化后再整理', canContinue: trigger === 'threshold', notesSaved: false }
        const checkBasis = () => {
          if (deps.records.coverage.read().summary !== before.summary || deps.inputVersion?.() !== version || inputs() !== inputBasis
            || JSON.stringify(deps.capacity?.() ?? capacity) !== JSON.stringify(capacity) || readPlanOf(deps.records, deps.session).entry !== plan.entry) throw new PreparationFailure('changed', '新交代、模型能力或覆盖依据已改变，先处理新内容后重新准备')
          let cursor: number | undefined
          for (;;) {
            const recent = deps.records.readEntriesBack(deps.session, cursor, 256)
            for (const entry of recent) {
              if (entry.id > (all.at(-1)?.id ?? 0) && entry.kind === 'user' && !(entry.payload && 'notice' in entry.payload && entry.payload.notice)) throw new PreparationFailure('changed', '准备期间收到新交代，先处理后沿原请求重新准备')
            }
            if (recent.length < 256 || recent[0]!.id <= (all.at(-1)?.id ?? 0)) break
            cursor = recent[0]!.id
          }
        }
        const brief = await prepareBrief({ records: deps.records, session: deps.session, gateway: deps.gateway, capacity,
          sink: deps.sink, stamper: deps.stamper, now: deps.now, ...(signal === undefined ? {} : { signal }), ...(compact?.focus === undefined ? {} : { focus: compact.focus }) }, old)
        // 最后一次异步 I/O 之后，同步复核全部可变依据并提交。
        checkBasis()
        signal?.throwIfAborted()
        const summary = deps.records.coverage.publish({ previousSummary: before.summary, from: old[0]!.id, through: brief.through, at: deps.now(), notesSaved: true, text: brief.text, ...(compact ? { compact } : {}) })
        failedBasis = undefined; usage = undefined
        deps.sink.emit(deps.stamper.stamp('context.compacted', { summary }))
        if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${summary}`, accepted: true, state: 'completed', summary, notesSaved: true }))
        return { ok: true, summary, summarized: brief.summarized, kept: all.length - brief.summarized, notesSaved: true }
      } catch (error) {
        const kind: CompactFailureKind = signal?.aborted ? 'canceled'
          : error instanceof BriefFailure ? error.kind === 'capacity' ? 'local-capacity' : 'transient'
          : error instanceof PreparationFailure ? error.kind === 'capacity' ? 'local-capacity' : error.kind === 'changed' ? 'changed' : 'transient'
          : 'transient'
        const reason = error instanceof Error ? error.message : String(error)
        if (kind !== 'changed' && kind !== 'canceled') {
          failedBasis = basisKey
          deps.sink.emit(deps.stamper.stamp('error', { message: `上下文整理未完成：${reason}。原始历史已保留，没有切换模型。` }))
          if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${deps.now()}`, accepted: true, state: 'failed', reason, notesSaved: false }))
        }
        return { ok: false, kind, reason, canContinue: trigger === 'threshold' && kind !== 'canceled', notesSaved: false }
      }
    },
  }
}
