/**
 * 工具实现的共用小件 —— 规格行的取处 ＋ 失败结果的形态。
 *
 * **规格的静态三件只此一处**（技术方案 · 工具 · 机制）：名称 / 描述 / 危险归类一律取自契约的
 * `TOOLSET_V1` 冻结行——工具集 v1 七件同此一源。本域**不另抄一份**：抄一份就有对不上的那天
 * （契约改了、手抄没改，而两边都「看着对」）。取不到即抛——那是契约被动了，不该在本域
 * 静默退化成一份手抄。
 */

import type { ToolSetRow } from '@magic/contracts'
import { TOOLSET_V1 } from '@magic/contracts'
import type { ToolRunResult } from './registry.ts'

/** 取工具集 v1 的某一行（名称 / 描述 / 危险归类）。 */
export function rowOf(name: string): ToolSetRow {
  const row = TOOLSET_V1.find((candidate) => candidate.name === name)
  if (row === undefined) {
    throw new Error(`工具集 v1 表里没有 ${name} —— 契约的冻结行被动过了`)
  }
  return row
}

/**
 * 失败结果——面向模型的文本。
 *
 * 工具执行体**不抛**（抛出去会被分发捕成「工具执行异常」，那是给 bug 用的措辞）：
 * 认得出的失败（参数错 / 文件没找到 / 越界 / 失配）都是**正常结果的一种**——
 * 模型要据此改法，不是看一句异常。
 */
export function refused(output: string): ToolRunResult {
  return { ok: false, output }
}

/** 抛出的原委——`Error` 取 `message`，其余照字面（与分发同一口径）。 */
export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
