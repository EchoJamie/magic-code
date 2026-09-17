/**
 * 权限域事件 —— 两个 kind（技术方案 · 领域划分 · 事件产出：权限域 | `tool.decision.request` ·
 * `tool.decision`）。
 *
 * **构造面**——一律经注入的 `EventStamper`（技术方案 · 领域划分 · 信封的归属 v0 锚定）：
 * **信封由产出方铸**，故 `id` / `session` / `turn` / `at` 四件由铸造器盖——权限域不自造计数、
 * 不自取时钟。而「产出方铸」对本域是**硬约束**：请求事件的 `id` 就是答复的配对键
 * （`DecisionId`），id 若由扇出处后配，这条回路就断了。
 */

import type { Decision, Decider, DecisionWeight, EventStamper, KernelEvent, RecordId } from '@magic/contracts'

/**
 * 询问——带判断材料与呈现轻重（`weight`）：外壳据以决定怎么问（重呈现 / 轻呈现）。
 *
 * `call` 是**调用链引用**（`RecordId` 空间）——贯穿请求 / 询问 / 裁决 / 结果的那次调用，
 * **不是**答复配对键（配对键＝本事件的 `id`，见契约 `ids.ts` 头注）。
 */
export function decisionRequest(
  stamper: EventStamper,
  input: {
    readonly call: RecordId
    readonly name: string
    readonly material: string
    readonly weight: DecisionWeight
  },
): KernelEvent {
  return stamper.stamp('tool.decision.request', {
    call: input.call,
    name: input.name,
    material: input.material,
    weight: input.weight,
  })
}

/**
 * 裁决——批准 / 拒绝 ＋ 裁者 ＋ 耗时。
 *
 * `elapsedMs`（提示 → 答复）是**度量埋点**（技术方案 · 权限：度量——高危盲批是失控信号）：
 * 阶段 3 摩擦调优的数据基础，本期只埋点、不解读。
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
