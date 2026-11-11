/**
 * 权限域的裁决事件构造子。
 *
 * U129 起不再有「请求」那一半：默认放行与禁止清单都在闸门内落定，界面没有审批卡。
 * 留下的 `tool.decision` 是**审计事实**——谁定的（`auto` / `kernel`）、定了什么、耗时多少。
 */

import type {
  Decision,
  Decider,
  EventStamper,
  KernelEvent,
  RecordId,
} from '@magic/contracts'

/**
 * 裁决落定——`decider` 分得开「没问就放行」（`auto`）与「内核按清单拒」（`kernel`）。
 */
export function decisionMade(
  stamper: EventStamper,
  input: {
    readonly call: RecordId
    readonly decision: Decision
    readonly decider: Decider
    readonly elapsedMs: number
  },
): KernelEvent {
  return stamper.stamp('tool.decision', {
    call: input.call,
    decision: input.decision,
    decider: input.decider,
    elapsedMs: input.elapsedMs,
  })
}
