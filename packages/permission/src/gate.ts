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
 * 调用链引用的**未提供哨兵**——事件 `call` 是 `RecordId` 空间，值须由**发 `tool.call` 的
 * 工具域**给出；缺省时用 `-1`：**显式可辨**（记录域 id 单调非负，撞不上），
 * 且事件不静默冒充一条真实调用的引用。
 *
 * ⚠️ 这是**契约缺口的权宜**——`PermissionGate.decide(call, ctx)` 的入参 `ToolCall.id` 是
 * **供应商侧**调用 id（契约三空间不混），带不出 `tool.call` 的事件 id。见回报「待决」。
 */
export const CALL_REF_UNKNOWN: RecordId = -1

/**
 * `decide` 的第三参——**结构超集**，承端口签名而只增不改（规约 4）。
 *
 * 契约端口写死两参，而事件载荷 `call` 需要调用链引用；此处留**注入位**，
 * 由调用方（工具域）把 `tool.call` 事件的 `id` 带进来。不传则记哨兵（见上）。
 */
export type DecideOptions = {
  /** `tool.call` 事件的 `id`——贯穿请求 / 询问 / 裁决 / 结果的**调用链引用**。 */
  readonly call?: RecordId | undefined
}

/**
 * 权限域公开面——**结构超集**（契约端口 ＋ 注入位），与模型域 `ModelGateway` 同一姿势。
 * **消费者按契约端口取用即可**（`decide` 两参调用照常工作）。
 */
export interface PermissionGate extends PermissionGatePort {
  decide(call: ToolCall, ctx: PermissionContext, opts?: DecideOptions): Promise<Decision>
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
    decide(call, ctx, opts) {
      const { weight, material } = analyze(call, ctx)
      const callRef = opts?.call ?? CALL_REF_UNKNOWN

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
