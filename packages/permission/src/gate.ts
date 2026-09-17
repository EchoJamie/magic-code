/**
 * `PermissionGate` —— 权限域端口（技术方案 · 领域划分：工具域 → 权限域，闸门在 `invoke` 路径内）。
 *
 * 一次裁决的全流程：
 *
 *   机械分析（工具名 ＋ 参数）→ 危险分级 → 发 `tool.decision.request`（带材料与呈现轻重）
 *     → 等答复（`resolve`，配对＝**请求事件 id**）→ 发 `tool.decision` → 返回裁决
 *
 * **阶段 1 全人工门**（技术方案 · 权限）：无自动放行——每个调用都问、都等、都记；
 * 危险分级只定**呈现轻重**（阶段 2 起才是自动放行禁区）。
 *
 * 纪律（技术方案 · 领域划分 · 权限域）：**裁决独立**（不自证、不押模型自述）·
 * **只走事件、不入条目**——故本域注入面只有 `EventSink`（`emit` 一件）与 `EventStamper`，
 * **结构上拿不到条目面**（`RecordsService` 才是条目面，本域不注入）。
 *
 * **调用链引用（`callRef`）必填**（第 2 轮契约对齐 · `PermissionGate.decide` 三参）——
 * 它是「请求 → 询问 → 裁决 → 结果」四事件**串链**的依据（审计与阶段 2 恢复的在途识别
 * 都按它找）；而它产生在本域之外（工具域铸 `tool.call` 时才有），故只能由调用方传入。
 * **不设哨兵兜底**：静默的 `-1` 比缺参更坏——接线漏了应当在**编译期**就报。
 */

import type {
  Decision,
  DecisionId,
  EventSink,
  EventStamper,
  PermissionContext,
  PermissionGate as PermissionGatePort,
  RecordId,
  ToolCall,
} from '@magic/contracts'
import { analyze } from './analyze.ts'
import { decisionMade, decisionRequest } from './events.ts'

/**
 * 权限域公开面——**即契约端口**（`decide` 三参 · `resolve` 两件），本域不另立形态、不加宽。
 *
 * 第 2 轮契约对齐：`callRef` 由可选注入位**升为必填参数**（见 `decide` 头注）。
 */
export interface PermissionGate extends PermissionGatePort {
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision>
  /** 控制域答复路由至此——配对键＝**请求事件** `id`。 */
  resolve(requestId: DecisionId, decision: Decision): void
}

export type PermissionGateOptions = {
  /** 事件扇出入口（装配注入；本域只发不收）。 */
  readonly sink: EventSink
  /**
   * 信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
   *
   * 对本域是硬约束：请求事件的 `id` 就是答复配对键，id 必须**当场铸**。
   * ⚠️ **必填，本域无缺省**——权限域不自造计数、不自取时钟。
   */
  readonly stamper: EventStamper
  /**
   * 时钟（毫秒）——**度量**用：裁决耗时 ＝ 提示 → 答复（`tool.decision.elapsedMs`）。
   * 缺省 `Date.now`；显式注入便于测试（域不各自读时钟，取用经此一处）。
   */
  readonly now?: (() => number) | undefined
}

/** 一件在途询问。 */
type Pending = {
  /** 调用链引用——裁决事件沿用（与配对键不是同一个 id）。 */
  readonly call: RecordId
  /** 提示时刻（度量：`elapsedMs` ＝ 提示 → 答复）。 */
  readonly at: number
  readonly settle: (decision: Decision) => void
}

/** 造一个权限闸门——内核的裁决者（契约端口 `PermissionGate` 的落地）。 */
export function createPermissionGate(options: PermissionGateOptions): PermissionGate {
  const { sink, stamper } = options
  const now = options.now ?? Date.now

  /** 在途询问——**请求事件 id** → 待答复（答复按此配对）。 */
  const pending = new Map<DecisionId, Pending>()

  return {
    decide(call, ctx, callRef) {
      const { weight, material } = analyze(call, ctx)

      const request = decisionRequest(stamper, {
        call: callRef,
        name: call.name,
        material,
        weight,
      })

      // **先登记、后扇出**——外壳可能在同一调用栈里答复（答复不必等一轮事件循环），
      // 顺序反了这条答复就落在空表上（丢答复＝永久挂起）。
      const answered = new Promise<Decision>((settle) => {
        pending.set(request.id, { call: callRef, at: now(), settle })
      })

      sink.emit(request)

      return answered
    },

    resolve(requestId, decision) {
      const question = pending.get(requestId)
      // 陌生 id（迟到 / 重复 / 伪造）＝忽略——不抛、不猜、不改写
      if (question === undefined) return
      pending.delete(requestId)

      // 裁决只走事件、不入条目（技术方案 · 领域划分 · 权限域）；耗时＝提示 → 答复（度量埋点）
      sink.emit(
        decisionMade(stamper, {
          call: question.call,
          decision,
          decider: 'user', // 首站恒人工；`auto` 是阶段 2 规则化的留位
          elapsedMs: now() - question.at,
        }),
      )

      question.settle(decision)
    },
  }
}
