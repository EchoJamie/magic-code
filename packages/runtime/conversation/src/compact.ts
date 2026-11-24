import type { EventSink, EventStamper, ModelGateway, RecordId, RecordsService, SessionId, ToolRuntime, WorkingNotes } from '@magic/contracts'
import { BriefFailure, prepareBrief, type BriefCapacity } from './brief.ts'
import { PreparationFailure, preparationReserve, substantiveEntries } from './organize.ts'
import { readPlanOf } from './plan.ts'

type CompactTrigger = 'threshold' | 'context-limit'
type CompactFailureKind = 'configuration' | 'no-material' | 'local-capacity' | 'remote-capacity' | 'transient' | 'canceled' | 'changed'
type CompactOutcome = ({ readonly notesSaved: boolean } & (
  | { readonly ok: true; readonly summary: RecordId; readonly summarized: number; readonly kept: number }
  | { readonly ok: false; readonly reason: string; readonly kind: CompactFailureKind; readonly canContinue: boolean }
))
export type Compactor = {
  /** 近段 token 预算；交接形态不再留近段，保留字段只为装配面少改一处。 */
  readonly nearTokens?: number | undefined
  observe(usage: { readonly inputTokens?: number | undefined; readonly contextWindow?: number | undefined }): void
  needed(): boolean
  run(input: { readonly trigger: CompactTrigger; readonly signal?: AbortSignal | undefined; readonly compact?: { readonly requestId: string; readonly focus?: string } }): Promise<CompactOutcome>
}
export type CompactorDeps = {
  readonly records: RecordsService; readonly session: SessionId
  readonly gateway: ModelGateway
  readonly notes?: WorkingNotes
  readonly noteTools?: (notes: WorkingNotes) => ToolRuntime
  readonly capacity?: () => BriefCapacity
  readonly inputVersion?: () => number
  readonly sink: EventSink; readonly stamper: EventStamper; readonly now: () => number
  readonly nearTokens?: number | undefined; readonly compactAtFraction: number; readonly compactAtTokens: number
}

/**
 * **压缩 ＝ 交接**（用户 2026-11-19 定，D74）：
 *
 * 1. 让模型把「过往行为 ＋ 当前目标」写成一份交接材料（一次调用，材料从最近的往前装）；
 * 2. 这份材料写进工作笔记；
 * 3. 它作为**新上下文的第一句用户输入**落成一条 `user` 条目，覆盖点停在它之前；
 * 4. 之后照常继续，旧记录一条不动。
 *
 * 没有摘要、没有近段切分、没有切段边界：模型看到的就是「用户说：这是之前的进度，接着干」。
 */
export function createCompactor(deps: CompactorDeps): Compactor {
  let usage: number | undefined, contextWindow: number | undefined
  let failedBasis: string | undefined
  return {
    nearTokens: deps.nearTokens,
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
        const first = all[0]?.id
        if (first === undefined) {
          // 没有材料同样是「交接没做成」，自动路径也要说出来（D74）。
          deps.sink.emit(deps.stamper.stamp('error', { message: '交接未完成：没有可交接的材料（这一轮还没开始工作）。原始历史已保留。' }))
          if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${deps.now()}`, accepted: true, state: 'no-material', reason: '没有可交接的材料', notesSaved: false }))
          return { ok: false, kind: 'no-material', reason: '没有可交接的材料（这一轮还没开始工作）', canContinue: true, notesSaved: false }
        }
        basisKey = JSON.stringify([before, all.at(-1)!.id, version, inputBasis, plan.entry, capacity])
        if (compact === undefined && basisKey === failedBasis) return { ok: false, kind: 'transient', reason: '相同接续条件已失败，等待材料或条件变化后再交接', canContinue: trigger === 'threshold', notesSaved: false }
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
        const handoff = await prepareBrief({ records: deps.records, session: deps.session, gateway: deps.gateway, capacity,
          sink: deps.sink, stamper: deps.stamper, now: deps.now, ...(signal === undefined ? {} : { signal }), ...(compact?.focus === undefined ? {} : { focus: compact.focus }) }, all)
        checkBasis()
        signal?.throwIfAborted()
        // 笔记与新上下文的第一句同源：写不进笔记就不提交交接（材料不能只活在一个地方）。
        const notesSaved = await saveNotes(deps, handoff.text)
        if (!notesSaved) throw new BriefFailure('incomplete', '工作笔记没有写入成功，交接未提交')
        const entry = deps.records.appendEntry({ kind: 'user', content: { text: handoff.text }, payload: { handoff: true }, at: deps.now() })
        // 覆盖到「最后一条用户输入之前」：用户最新说的那句话必须原样留在新上下文里，
        // 不能被压进交接材料（那是有损的）。记录 id 可能跳号，用真实条目的 id 当上界。
        const lastUserIndex = all.findLastIndex(item => item.kind === 'user')
        const through = lastUserIndex > 0 ? all[lastUserIndex - 1]!.id : undefined
        if (through === undefined || through < first || through >= entry) throw new BriefFailure('incomplete', '没有可覆盖的旧段，交接不成立')
        const summary = deps.records.coverage.publish({ previousSummary: before.summary, from: first, through, at: deps.now(), notesSaved, ...(compact ? { compact } : {}) })
        failedBasis = undefined; usage = undefined
        deps.sink.emit(deps.stamper.stamp('context.compacted', { summary }))
        if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${summary}`, accepted: true, state: 'completed', summary, notesSaved }))
        return { ok: true, summary, summarized: all.length, kept: 0, notesSaved }
      } catch (error) {
        const kind: CompactFailureKind = signal?.aborted ? 'canceled'
          : error instanceof BriefFailure ? error.kind === 'capacity' ? 'local-capacity' : 'transient'
          : error instanceof PreparationFailure ? error.kind === 'capacity' ? 'local-capacity' : error.kind === 'changed' ? 'changed' : 'transient'
          : 'transient'
        const reason = error instanceof Error ? error.message : String(error)
        if (kind !== 'changed' && kind !== 'canceled') {
          failedBasis = basisKey
          deps.sink.emit(deps.stamper.stamp('error', { message: `交接未完成：${reason}。原始历史已保留，可再试一次。` }))
          if (compact === undefined) deps.sink.emit(deps.stamper.stamp('compact.state', { requestId: `auto:${deps.now()}`, accepted: true, state: 'failed', reason, notesSaved: false }))
        }
        return { ok: false, kind, reason, canContinue: trigger === 'threshold' && kind !== 'canceled', notesSaved: false }
      }
    },
  }
}

/** 把交接材料写进本次会话的工作笔记（覆盖 MEMORY.md，笔记的其余文件不动）。 */
async function saveNotes(deps: CompactorDeps, text: string): Promise<boolean> {
  const notes = deps.notes
  if (notes?.overwrite === undefined) return true
  try {
    await notes.overwrite('MEMORY.md', text)
    return true
  } catch {
    return false
  }
}
