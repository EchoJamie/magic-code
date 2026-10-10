import type { OwnedProcess } from '@magic/contracts'
import { reapOwned } from '@magic/execution'

/** 收尾的时限——与执行者自己那一跳（`groups.ts` 的缺省）同一量级，收尾不能被挂住。 */
export type ReclaimTimes = {
  readonly settleMs?: number
  readonly termMs?: number
  readonly killMs?: number
}

/** 一次收回的结果——**没收回来的那些**（空数组＝全收干净了）。 */
export type ReclaimReport = {
  readonly tried: number
  readonly remaining: readonly OwnedProcess[]
  /** 一句人话的缘由（诊断与回执都读它）——全收干净时为空。 */
  readonly notes: readonly string[]
}

/**
 * 照登记收——**幂等**（组没了就是 `gone`，再收一遍无事）。
 *
 * 交回的是**没收回来的那些**：调用方把它写进那一行的缘由（「不伪报取消成功」的落点）。
 */
export async function reclaim(
  owned: readonly OwnedProcess[],
  times: ReclaimTimes = {},
): Promise<ReclaimReport> {
  const notes: string[] = []
  const remaining: OwnedProcess[] = []

  for (const one of owned) {
    const outcome = await reapOwned(one, times)
    switch (outcome.kind) {
      case 'reaped':
      case 'gone':
        break
      // 下三种都要说出来——「没收回来的」是事实的一部分，不能吞
      case 'left':
      case 'stranger':
      case 'unprovable':
        remaining.push(one)
        notes.push(outcome.note)
        break
    }
  }

  return { tried: owned.length, notes, remaining }
}

/** 把没收回来的那几件合成**一句**给人看的话（空＝全收干净了）。 */
export function reclaimNoteOf(report: ReclaimReport): string | undefined {
  if (report.notes.length === 0) return undefined
  return `还有 ${report.notes.length} 组进程没能收回来：${report.notes.join('；')}`
}
