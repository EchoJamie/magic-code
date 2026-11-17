/**
 * 机械分析 —— 默认放行与禁止清单（U129）的**唯一入口**。
 *
 * 默认放行：未被禁止清单命中的工具调用与命令不再询问。分析只产出三件：
 *
 * - `refusal`——命中禁止清单（`rm`/`shred`/`srm` 那族、`su`）或 sudo 形状不合法；
 * - `detail`——被拒的具体缘由（sudo 命中了哪一种不成形的写法）；
 * - `sudo`——形状合格的单行短 sudo，认证与执行只认这一份。
 *
 * 本域只做域内机械分析：不 import 执行域 / 工具域，不碰文件系统（域间只经契约）。
 */

import type { PermissionContext, RefusalKind, SudoPlan, ToolCall } from '@magic/contracts'
import { decompose } from './commands.ts'

/** 一次调用的分析结论。 */
export type Analysis =
  | {
    readonly refusal?: undefined
    readonly material: string
    /** 形状合格的 sudo 短命令——只有 `exec` 可能给。 */
    readonly sudo?: SudoPlan
  }
  | {
    readonly refusal: RefusalKind
    readonly material: string
    /** 命中的具体写法（`sudo-unsupported` 时给出）。 */
    readonly detail?: string
    readonly sudo?: undefined
  }

/**
 * 分析一次工具调用。
 *
 * 只有 `exec` 有禁止清单可判；其余工具（读、写、编辑、搜索、外部工具、协作工具、
 * 表外工具）一律放行——真实边界交给操作系统。
 */
export function analyze(call: ToolCall, _ctx: PermissionContext): Analysis {
  if (call.name !== 'exec') return { material: `工具：${call.name}` }
  if (call.invalid === true) return { material: '参数解析不出——调用形态不可信（分发会先拒，不执行）' }

  // 新调用写 `command`；旧记录里是 `cmd`——两把都认：认不出命令行，禁止清单就等于关掉了
  const cmd = call.args['command'] ?? call.args['cmd']
  if (typeof cmd !== 'string') return { material: '参数里没有命令字段' }

  const segments = decompose(cmd)
  const refused = segments.find((segment) => segment.refusal !== undefined)
  if (refused?.refusal !== undefined) {
    return {
      refusal: refused.refusal,
      material: cmd,
      ...(refused.detail === undefined ? {} : { detail: refused.detail }),
    }
  }

  const sudo = segments.length === 1 ? segments[0]?.sudo : undefined
  return { material: cmd, ...(sudo === undefined ? {} : { sudo }) }
}

/** 被拒那一笔的具体缘由——与 `analyze` 同一次分解。 */
export function refusalDetailOf(call: ToolCall, ctx: PermissionContext): string | undefined {
  const analysis = analyze(call, ctx)
  return analysis.refusal === undefined ? undefined : analysis.detail
}

/** 这一次是不是形状合格的 sudo 短命令。 */
export function sudoPlanOf(call: ToolCall, ctx: PermissionContext): SudoPlan | undefined {
  const analysis = analyze(call, ctx)
  return analysis.refusal === undefined ? analysis.sudo : undefined
}

/** 保留旧名给只取判定的调用方（工具域用的就是这一件）。 */
export function refusalOf(call: ToolCall, ctx: PermissionContext): RefusalKind | undefined {
  return analyze(call, ctx).refusal
}
