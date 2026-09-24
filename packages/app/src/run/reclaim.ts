/**
 * **收回已登记的自有进程组**（U50）——执行者没了之后，它起的那些进程由管理者照账收。
 *
 * 设计（会话与运行管理 · 离开、停止与异常退出）：
 *
 * > 执行者崩溃或被杀 ｜ 管理者**收回独占权与已登记自有进程组**，记录异常；
 * > **外部效果不明不伪报取消成功**。
 *
 * ## 为什么这件事必须有
 *
 * 执行者被 `SIGKILL` 时它跑不到收尾那两跳（关外部服务器在 `assembly.shutdown()` 里），
 * 于是它起的 MCP 服务器、正在跑的长命令就成了**没人认领的后台**——设计头一句
 * 「任何存活进程都须有负责人」要免掉的正是它。执行者与工具都在**各自的进程组**里
 * （`detached`），故它们不会被谁顺手带走：得有人照着账来收。
 *
 * ## 判据与限度（一条都不许放宽）
 *
 * 收的这一跳是**别人替你收**：中间隔着未知的时间，号可能已经被系统回收再分配。故每一组
 * 都先核对身份（`@magic/execution` 的 `reapOwned`）——**证明不了归属的一个都不碰**，
 * 且**收没收到如实说**：
 *
 * - 收不干净的（KILL 之后还站着）⇒ 写进那一行的缘由（「已停止（还有 1 组进程没能收回来）」）；
 * - 号已经是别人的 / 组长没了无从证实 ⇒ **不动**，同样如实带一句。
 *
 * ⚠️ **这不是「全机扫描清理」**（工单明写的那条不许）：账上只有**我们起过的**那些组
 * （`@magic/contracts` 的 `ProcessLedger`），一个探针都不扫全机、也不按命令名认人。
 */

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
        notes.push(outcome.note)
        break
    }
  }

  return { tried: owned.length, notes }
}

/** 把没收回来的那几件合成**一句**给人看的话（空＝全收干净了）。 */
export function reclaimNoteOf(report: ReclaimReport): string | undefined {
  if (report.notes.length === 0) return undefined
  return `还有 ${report.notes.length} 组进程没能收回来：${report.notes.join('；')}`
}
