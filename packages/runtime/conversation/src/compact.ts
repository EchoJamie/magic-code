import type { Entry, EventSink, EventStamper, ModelGateway, RecordId, RecordsService, SessionId } from '@magic/contracts'
import { BriefFailure, estimateTokens, prepareBrief, type BriefCapacity, type InlinePrefix } from './brief.ts'
import { isRealUserEntry } from './context.ts'
import { materialTextOf } from './material.ts'
import { PreparationFailure, preparationReserve, substantiveEntries } from './organize.ts'

type CompactTrigger = 'threshold' | 'context-limit'
type CompactFailureKind = 'configuration' | 'no-material' | 'local-capacity' | 'remote-capacity' | 'transient' | 'canceled' | 'changed'
type CompactOutcome =
  | { readonly ok: true; readonly summary: RecordId; readonly summarized: number; readonly kept: number }
  | { readonly ok: false; readonly reason: string; readonly kind: CompactFailureKind; readonly canContinue: boolean }
export type Compactor = {
  observe(usage: { readonly inputTokens?: number | undefined; readonly contextWindow?: number | undefined }): void
  needed(): boolean
  run(input: { readonly trigger: CompactTrigger; readonly signal?: AbortSignal | undefined; readonly compact?: { readonly requestId: string; readonly focus?: string } }): Promise<CompactOutcome>
}
export type CompactorDeps = {
  readonly records: RecordsService
  readonly session: SessionId
  readonly gateway: ModelGateway
  readonly capacity?: () => BriefCapacity
  readonly preparePrefix?: (signal?: AbortSignal) => Promise<InlinePrefix>
  readonly sink: EventSink
  readonly stamper: EventStamper
  readonly now: () => number
  readonly timeoutMs?: number | undefined
  readonly keepTailTokens?: number | undefined
  readonly compactAtFraction: number
  readonly compactAtTokens: number
}

type AtomicRound = {
  readonly startIdx: number
  readonly endIdx: number
  readonly tokens: number
  readonly isSingleRealUser: boolean
}

async function partitionRounds(all: readonly Entry[], records: RecordsService, session: SessionId): Promise<AtomicRound[]> {
  const rounds: AtomicRound[] = []
  let idx = 0
  while (idx < all.length) {
    const entry = all[idx]!
    if (entry.kind === 'assistant') {
      let end = idx
      while (end + 1 < all.length && (all[end + 1]!.kind === 'tool-call' || all[end + 1]!.kind === 'tool-result')) end++
      let tokens = 0
      for (let k = idx; k <= end; k++) {
        const material = await materialTextOf(all[k]!, records, session)
        tokens += estimateTokens(material.text)
      }
      rounds.push({ startIdx: idx, endIdx: end, tokens, isSingleRealUser: false })
      idx = end + 1
      continue
    }
    const material = await materialTextOf(entry, records, session)
    rounds.push({ startIdx: idx, endIdx: idx, tokens: estimateTokens(material.text), isSingleRealUser: isRealUserEntry(entry) })
    idx += 1
  }
  return rounds
}

async function priorRetainedUsers(records: RecordsService, session: SessionId, summaryId: RecordId | null): Promise<readonly RecordId[]> {
  if (summaryId === null) return []
  for await (const entry of records.readEntries(session, { from: summaryId, to: summaryId })) {
    if (entry.kind === 'summary' && entry.payload !== undefined && 'retainedUsers' in entry.payload && Array.isArray(entry.payload.retainedUsers)) {
      return entry.payload.retainedUsers
    }
  }
  return []
}

async function legacyHandoffToText(records: RecordsService, session: SessionId, coveredThrough: RecordId | null): Promise<readonly RecordId[]> {
  if (coveredThrough === null) return []
  const entries = await Array.fromAsync(records.readEntries(session, { to: coveredThrough }))
  const lastReal = entries.findLast(isRealUserEntry)
  return lastReal === undefined ? [] : [lastReal.id]
}

/**
 * **A+B 融合压缩**：
 * - 第一级（装配期）：批量单调折叠陈旧工具输出（零 LLM 成本，见 `prune.ts`）；
 * - 第二级（本模块）：同前缀内联调用模型生成五段交接材料，按**完整轮次边界**覆盖旧段
 *   （保留一小段近期工作现场 + 锚定活跃真实用户原话），单一事务原子落入 `summary` 条目。
 * - 不触碰 `MEMORY.md`（长期笔记由显式 `/memory tidy` 管理）。
 */
export function createCompactor(deps: CompactorDeps): Compactor {
  let usage: number | undefined, contextWindow: number | undefined
  let failedBasis: string | undefined
  let noCoverableBasis: string | undefined
  let consecutiveFailures = 0
  let backoffUntilEntries = 0
  let lastCapacityIdentity: string | undefined

  return {
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
        const capacity = deps.capacity?.() ?? { inputBudget: contextWindow }
        if (capacity.identity !== lastCapacityIdentity) {
          lastCapacityIdentity = capacity.identity
          consecutiveFailures = 0
          backoffUntilEntries = 0
          failedBasis = undefined
        }
        if (compact !== undefined) {
          consecutiveFailures = 0
          backoffUntilEntries = 0
        }

        const all = substantiveEntries(await Array.fromAsync(deps.records.readEntries(deps.session, { from: (before.coveredThrough ?? 0) + 1 })))
        const first = all[0]?.id
        if (first === undefined) {
          // 没有材料同样是「交接没做成」，自动路径也要说出来（D74）。
          deps.sink.emit(deps.stamper.stamp('error', { message: '交接未完成：没有可交接的材料（这一轮还没开始工作）。原始历史已保留。' }))
          if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${deps.now()}`, accepted: true, state: 'no-material', reason: '没有可交接的材料' }))
          return { ok: false, kind: 'no-material', reason: '没有可交接的材料（这一轮还没开始工作）', canContinue: true }
        }

        const rounds = await partitionRounds(all, deps.records, deps.session)
        if (rounds.length < 2) {
          const uncoverableKey = JSON.stringify([before, all[0]?.id ?? null])
          if (compact === undefined && uncoverableKey === noCoverableBasis) {
            return { ok: false, kind: 'no-material', reason: '没有可覆盖的旧段，等待新的交互轮次后再交接', canContinue: trigger === 'threshold' }
          }
          if (compact === undefined) noCoverableBasis = uncoverableKey
          throw new BriefFailure('incomplete', '没有可覆盖的旧段，交接不成立')
        }
        noCoverableBasis = undefined

        basisKey = JSON.stringify([before, all.at(-1)!.id, capacity])
        if (compact === undefined && basisKey === failedBasis) {
          return { ok: false, kind: 'transient', reason: '相同接续条件已失败，等待材料或条件变化后再交接', canContinue: trigger === 'threshold' }
        }
        if (compact === undefined && trigger === 'threshold' && consecutiveFailures > 0 && all.length < backoffUntilEntries) {
          return { ok: false, kind: 'transient', reason: '自动压缩冷却中，等待新增进展或切换模型后再试', canContinue: true }
        }

        // 计算安全切点：在「完整轮次边界」切开，保留一小段近段工作现场，并确保活跃真实用户原话在场。
        const totalTokens = rounds.reduce((sum, round) => sum + round.tokens, 0)
        const budget = capacity.inputBudget ?? 64_000
        const room = Math.max(2_000, budget - preparationReserve(budget))
        let cutRoundIndex = rounds.length
        if (deps.keepTailTokens !== undefined) {
          if (deps.keepTailTokens <= 0) {
            cutRoundIndex = rounds.at(-1)!.isSingleRealUser ? rounds.length - 1 : rounds.length
          } else {
            let kept = 0
            for (let r = rounds.length - 1; r >= 1; r--) {
              const round = rounds[r]!
              if (kept + round.tokens > deps.keepTailTokens && !(r === rounds.length - 1 && round.isSingleRealUser)) break
              kept += round.tokens
              cutRoundIndex = r
            }
          }
        } else {
          const targetTail = Math.min(20_000, Math.floor(room * 0.15))
          const effectiveTail = Math.min(targetTail, Math.floor(totalTokens * 0.45))
          let kept = 0
          for (let r = rounds.length - 1; r >= 1; r--) {
            const round = rounds[r]!
            if (r === rounds.length - 1 && round.isSingleRealUser && round.tokens <= room * 0.5) {
              kept += round.tokens
              cutRoundIndex = r
              continue
            }
            if (kept + round.tokens > effectiveTail) break
            kept += round.tokens
            cutRoundIndex = r
          }
        }
        cutRoundIndex = Math.max(1, cutRoundIndex)
        const coveredSliceEnd = rounds[cutRoundIndex - 1]!.endIdx
        const through = all[coveredSliceEnd]!.id
        const keptCount = all.length - (coveredSliceEnd + 1)

        // 若裁剪线之后没有真实用户原话（例如单用户百轮工具循环，或最新实话在切线之前），锚定最新真实用户原话。
        const hasTailRealUser = all.slice(coveredSliceEnd + 1).some(isRealUserEntry)
        let retainedUsers: readonly RecordId[] = []
        if (!hasTailRealUser) {
          const latestReal = all.slice(0, coveredSliceEnd + 1).findLast(isRealUserEntry)
          if (latestReal !== undefined) {
            retainedUsers = [latestReal.id]
          } else {
            const inherited = await priorRetainedUsers(deps.records, deps.session, before.summary)
            retainedUsers = inherited.length > 0 ? inherited : await legacyHandoffToText(deps.records, deps.session, before.coveredThrough)
          }
        }

        const prefix = await deps.preparePrefix?.(signal)
        const handoff = await prepareBrief({
          records: deps.records,
          session: deps.session,
          gateway: deps.gateway,
          capacity,
          sink: deps.sink,
          stamper: deps.stamper,
          now: deps.now,
          ...(prefix === undefined ? {} : { prefix }),
          ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
          ...(signal === undefined ? {} : { signal }),
          ...(compact?.focus === undefined ? {} : { focus: compact.focus }),
        }, all.slice(0, coveredSliceEnd + 1))

        signal?.throwIfAborted()
        if (deps.records.coverage.read().summary !== before.summary) {
          throw new PreparationFailure('changed', '压缩期间已完成另一次覆盖提交，保留原状态')
        }

        // 原子事务：新摘要正文、覆盖范围与保留真实用户原话一并写入单一 summary 条目，不再伪装 user 或覆写 MEMORY.md。
        const summary = deps.records.coverage.publish({
          previousSummary: before.summary,
          from: first,
          through,
          at: deps.now(),
          format: 'compaction-v2',
          text: handoff.text,
          ...(retainedUsers.length > 0 ? { retainedUsers } : {}),
          ...(compact ? { compact } : {}),
        })

        failedBasis = undefined
        noCoverableBasis = undefined
        consecutiveFailures = 0
        backoffUntilEntries = 0
        usage = undefined
        deps.sink.emit(deps.stamper.stamp('context.compacted', { summary }))
        if (compact === undefined) {
          deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${summary}`, accepted: true, state: 'completed', summary }))
        }
        return { ok: true, summary, summarized: coveredSliceEnd + 1, kept: keptCount }
      } catch (error) {
        const kind: CompactFailureKind = signal?.aborted ? 'canceled'
          : error instanceof BriefFailure ? error.kind === 'capacity' ? 'local-capacity' : 'transient'
          : error instanceof PreparationFailure ? error.kind === 'capacity' ? 'local-capacity' : error.kind === 'changed' ? 'changed' : 'transient'
          : 'transient'
        const reason = error instanceof Error ? error.message : String(error)
        if (kind !== 'changed' && kind !== 'canceled') {
          failedBasis = basisKey
          if (compact === undefined) {
            consecutiveFailures += 1
            const step = consecutiveFailures === 1 ? 6 : consecutiveFailures === 2 ? 18 : 40
            const currentCount = substantiveEntries(await Array.fromAsync(deps.records.readEntries(deps.session, { from: (deps.records.coverage.read().coveredThrough ?? 0) + 1 }))).length
            backoffUntilEntries = currentCount + step
          }
          deps.sink.emit(deps.stamper.stamp('error', { message: `交接未完成：${reason}。原始历史已保留，可再试一次。` }))
          if (compact === undefined) {
            deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${deps.now()}`, accepted: true, state: 'failed', reason }))
          }
        }
        return { ok: false, kind, reason, canContinue: trigger === 'threshold' && kind !== 'canceled' }
      }
    },
  }
}
