import type { RecordId } from '@magic/contracts'

/** 单条成功工具结果参与微压缩归档的最小字符数（约 ~350-500 tokens）。 */
export const PRUNE_MIN_TOOL_CHARS = 1_200

/** 归档后占位的估算 token 开销。 */
const PRUNE_PLACEHOLDER_TOKENS = 32

/** 高信号控制/记忆类工具结果不参与微压缩归档。 */
export const EXEMPT_PRUNE_TOOLS: ReadonlySet<string> = new Set([
  'plan_read',
  'plan_update',
  'skill',
  'knowledge_read',
  'knowledge_search',
  'knowledge_update',
  'knowledge_forget',
])

export type PrunableToolItem = {
  readonly entryId: RecordId
  readonly toolName: string
  readonly ok: boolean
  readonly chars: number
  readonly tokens: number
  readonly inLatestRound: boolean
}

export function prunedToolPlaceholder(toolName: string, chars: number, entryId: RecordId): string {
  return `【较早工具结果已折叠 · ${toolName} · ${chars} 字符 · 会话记录#${entryId}（需原文可用 source_read 回查）】`
}

/**
 * 计算单调微压缩水位（一级治理，零 LLM 成本）：
 * 1. 始终保护最新工具轮次以及最近 `protectTokens` 内的工具输出；
 * 2. 只有保护窗之外尚未归档的可回收工具输出累计达到 `batchTokens` 时，才一次性推进水位；
 * 3. 水位单调不回退，两次推进之间前缀字节级稳定，保住主对话 Prompt Cache。
 */
export function computePruneAdvance(
  items: readonly PrunableToolItem[],
  currentPrunedThrough: RecordId | null,
  room: number,
): RecordId | undefined {
  if (items.length === 0 || room <= 0) return undefined
  const protectTokens = Math.min(40_000, Math.floor(room * 0.25))
  const batchTokens = Math.max(500, Math.min(30_000, Math.floor(room * 0.15)))

  let protectedSoFar = 0
  let protectBoundary = -1
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!
    if (item.inLatestRound) continue
    protectedSoFar += item.tokens
    if (protectedSoFar >= protectTokens) {
      protectBoundary = index
      break
    }
  }
  if (protectBoundary <= 0) return undefined

  const floor = currentPrunedThrough ?? 0
  let reclaimable = 0
  let highestId: RecordId | undefined
  for (let index = 0; index < protectBoundary; index++) {
    const item = items[index]!
    if (item.entryId <= floor) continue
    if (!item.ok || item.chars <= PRUNE_MIN_TOOL_CHARS || EXEMPT_PRUNE_TOOLS.has(item.toolName)) continue
    reclaimable += Math.max(0, item.tokens - PRUNE_PLACEHOLDER_TOKENS)
    highestId = item.entryId
  }
  return reclaimable >= batchTokens ? highestId : undefined
}
