/**
 * 工具执行前的权限闸门（U129 · 默认放行与禁止清单）。
 *
 * **默认放行**：不在禁止清单里的调用一律放行，不再产生人工询问。
 *
 * 闸门只做两件事：
 * 1. **禁止清单**——`rm` / `shred` / `srm` 那族与 `su` 直接拒；
 * 2. **sudo 形状**——不合格的 sudo 直接拒；合格的放行，认证在执行前由工具域经
 *    `SudoAuth` 端口完成（认证失败时原命令不启动）。
 *
 * 放行与拒绝都落一条 `tool.decision` 事件（审计用，不产生界面卡片）。
 */

import type {
  Decision,
  EventSink,
  EventStamper,
  PermissionGate as PermissionGatePort,
  RecordId,
  SudoPlan,
} from '@magic/contracts'
import { analyze } from './analyze.ts'
import { decisionMade } from './events.ts'

export type PermissionGate = PermissionGatePort

export type PermissionGateOptions = {
  /** 事件扇出入口（装配注入；本域只发不收）。 */
  readonly sink: EventSink
  /** 信封铸造器——产出方铸（技术方案 · 领域划分 · 信封的归属 v0 锚定）。 */
  readonly stamper: EventStamper
  /** 时钟（毫秒）——度量用；缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined
}

/** 造一个权限闸门——内核的裁决者（契约端口 `PermissionGate` 的落地）。 */
export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { sink, stamper } = options
  const now = options.now ?? Date.now

  /** 落一条裁决事件——放行是 `auto`，禁止清单是 `kernel`。 */
  function record(callRef: RecordId, started: number, decision: Decision, decider: 'auto' | 'kernel'): Decision {
    sink.emit(decisionMade(stamper, {
      call: callRef,
      decision,
      decider,
      elapsedMs: now() - started,
    }))
    return decision
  }

  return {
    decide(call, ctx, callRef, signal) {
      const started = now()
      const analysis = analyze(call, ctx)
      if (analysis.refusal !== undefined || signal?.aborted === true) {
        return Promise.resolve(record(callRef, started, 'reject', 'kernel'))
      }
      return Promise.resolve(record(callRef, started, 'approve', 'auto'))
    },

    refusalOf(call, ctx) {
      return analyze(call, ctx).refusal
    },

    refusalDetail(call, ctx) {
      const analysis = analyze(call, ctx)
      return analysis.refusal === undefined ? undefined : analysis.detail
    },

    sudoPlan(call, ctx): SudoPlan | undefined {
      const analysis = analyze(call, ctx)
      return analysis.refusal === undefined ? analysis.sudo : undefined
    },
  }
}
