import type { TurnDurationMode, TurnTimingEvent, TurnEndReason } from '@magic/contracts'

/** 只投影事件事实；没有计时器，也不保存逐秒读数。 */
export type RoundTiming = {
  readonly key: string
  readonly start: number
  readonly lastAt: number
  readonly lastId: number
  readonly turn: number | null
  readonly continues: boolean
  readonly valid: boolean
  readonly waitsKnown: boolean
  readonly waiting: readonly number[]
  readonly waitingSince: number | null
  readonly waited: number
  readonly end: number | null
  readonly reason?: TurnEndReason
}

export function foldRound(previous: RoundTiming | null, event: TurnTimingEvent): RoundTiming | null {
  if (previous !== null && event.id <= previous.lastId) return previous
  if (event.kind === 'turn.start' && (previous === null || previous.end !== null || !previous.continues)) {
    return { key: `round:${event.session}:${event.id}`, start: event.at, lastAt: event.at, lastId: event.id,
      turn: event.turn, continues: false, valid: Number.isFinite(event.at), waitsKnown: true,
      waiting: [], waitingSince: null, waited: 0, end: null }
  }
  if (previous === null || previous.end !== null) return previous
  let next: RoundTiming = { ...previous, lastAt: event.at, lastId: event.id,
    valid: previous.valid && Number.isFinite(event.at) && event.at >= previous.lastAt }
  if (event.kind === 'turn.start') {
    return { ...next, turn: event.turn, continues: false,
      valid: next.valid && (previous.turn === null || event.turn === null || event.turn === previous.turn + 1) }
  }
  if (event.turn !== previous.turn) next = { ...next, valid: false }
  if (event.kind === 'tool.decision.request') {
    return { ...next, waiting: [...new Set([...next.waiting, event.data.call])],
      waitingSince: next.waitingSince ?? event.at }
  }
  if (event.kind === 'tool.decision') {
    if (!next.waiting.includes(event.data.call)) return { ...next, waitsKnown: next.waitsKnown && event.data.decider !== 'user' }
    const waiting = next.waiting.filter(call => call !== event.data.call)
    return { ...next, waiting, waitingSince: waiting.length === 0 ? null : next.waitingSince,
      waited: next.waited + (waiting.length === 0 && next.waitingSince !== null ? event.at - next.waitingSince : 0) }
  }
  if (event.data.continues) return { ...next, continues: true }
  return { ...next, end: event.at, reason: event.data.reason, continues: false }
}

export function roundDuration(round: RoundTiming, mode: TurnDurationMode, now: number | null): number | null {
  const end = round.end ?? now
  if (!round.valid || end === null || end < round.lastAt || (mode === 'active' && !round.waitsKnown)) return null
  const waiting = round.waited + (round.waitingSince === null ? 0 : end - round.waitingSince)
  const elapsed = end - round.start - (mode === 'active' ? waiting : 0)
  return elapsed < 0 ? null : elapsed
}

export function durationText(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

export function roundSummary(round: RoundTiming, mode: TurnDurationMode): string | null {
  const elapsed = roundDuration(round, mode, null)
  if (elapsed === null || round.end === null) return null
  const date = new Date(round.end)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const reason = round.reason === 'error' ? '失败 · ' : round.reason === 'aborted' ? '已停止 · ' : ''
  return `${reason}耗时 ${durationText(elapsed)}${mode === 'active' ? '（不含等待）' : ''} · 结束于 ${clock}`
}
