/**
 * 权限域桩 —— `PermissionGate` 的内存实现（**测试替身**，不是权限域）。
 *
 * 用处：对话域 / 工具域的测试要一个「问了能答」的闸门。**人工门的回路**正是这里的重点——
 * `decide` 挂起 → 测试（扮外壳）按**请求 id** 答复 → `resolve` 落定。首站阶段 1 一律人工门
 * （技术方案 · 权限），故这条回路是循环测试绕不开的一环。
 *
 * 两种姿势：
 * - **自动**——`{ auto: 'approve' }` 或 `{ auto: (call, ctx) => … }`：问了立答（循环测试的便捷路径）；
 * - **人工**——不给 `auto`：`decide` 挂起，`pending` 给出在途请求 id，`resolve` 答复。
 *
 * **三参必填**（第 2 轮契约对齐 · `PermissionGate.decide`）：第三件 `callRef` ＝该次
 * `tool.call` 事件的 id——「请求 → 询问 → 裁决 → 结果」串链的依据。桩**不自造、只留痕**
 * （它产生在权限域之外，只有调用方拿得到）；漏了**编译期就红**，且此处另有一道运行时钉子。
 *
 * 桩**不发事件**（`tool.decision.request` / `tool.decision` 是权限域的产出，不是桩的活）；
 * 迟到的 `resolve`（陌生 id）**静默忽略**——不该炸掉循环。
 *
 * ⚠️ 桩的**请求 id 是本地计数**（1 起）；真实现里它是**请求事件的 id**（铸造器铸）。
 * 桩不发事件故无从取那一个——测试里别把两者当同一串 id 比。
 */

import type {
  Decision,
  DecisionId,
  PermissionContext,
  PermissionGate,
  RecordId,
  ToolCall,
} from '@magic/contracts'

/** 自动答复——常量，或按调用算（要看参数的用例）。 */
export type FauxDecider =
  | Decision
  | ((call: ToolCall, ctx: PermissionContext) => Decision | Promise<Decision>)

export type FauxPermissionGateOptions = {
  /** 给了就自动答复；不给则人工（`decide` 挂起，等 `resolve`）。 */
  readonly auto?: FauxDecider
}

/** 一次询问的留痕——调用 ＋ 上下文 ＋ **链引用**。 */
export type FauxPermissionRequest = {
  readonly call: ToolCall
  readonly ctx: PermissionContext
  /** 该次 `tool.call` 事件的 id（「请求 → 询问 → 裁决 → 结果」串链的依据）。 */
  readonly callRef: RecordId
}

/** 权限域桩的观察面。 */
export type FauxPermissionGate = PermissionGate & {
  /** 每次询问的留痕（调用 ＋ 上下文 ＋ 链引用）。 */
  readonly requests: readonly FauxPermissionRequest[]
  /** **在途**询问的请求 id（人工模式下测试据此答复）。 */
  readonly pending: readonly DecisionId[]
  /** 已答复的裁决（按答复序）。 */
  readonly answers: readonly { readonly id: DecisionId; readonly decision: Decision }[]
}

/** 造一个权限域桩。 */
export function makeFauxPermissionGate(
  options: FauxPermissionGateOptions = {},
): FauxPermissionGate {
  const requests: FauxPermissionRequest[] = []
  const pending: DecisionId[] = []
  const answers: { id: DecisionId; decision: Decision }[] = []
  const waiting = new Map<DecisionId, (decision: Decision) => void>()

  let nextId: DecisionId = 1

  return {
    get requests(): readonly FauxPermissionRequest[] {
      return requests
    },
    get pending(): readonly DecisionId[] {
      return pending
    },
    get answers(): readonly { readonly id: DecisionId; readonly decision: Decision }[] {
      return answers
    },

    // 三参必填（契约 `PermissionGate.decide`）——`callRef` 桩**不自造、只留痕**：
    // 它是工具域那次 `tool.call` 事件的 id，只有调用方拿得到（权限域自己看不见）
    async decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision> {
      requests.push({ call, ctx, callRef })

      const auto = options.auto
      if (auto !== undefined) {
        return typeof auto === 'function' ? auto(call, ctx) : auto
      }

      const id = nextId
      nextId += 1
      pending.push(id)

      return new Promise<Decision>((resolve) => {
        waiting.set(id, resolve)
      })
    },

    resolve(requestId: DecisionId, decision: Decision): void {
      const settle = waiting.get(requestId)
      if (settle === undefined) return // 迟到 / 陌生答复——静默

      waiting.delete(requestId)
      const at = pending.indexOf(requestId)
      if (at >= 0) pending.splice(at, 1)

      answers.push({ id: requestId, decision })
      settle(decision)
    },
  }
}
