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
 * `elapsedMs` 是**度量埋点**（技术方案 · 权限：度量——高危盲批是失控信号）：
 * 阶段 3 摩擦调优的数据基础，本期只埋点、不解读。
 *
 * **口径（U14 定义 · 两种路径同一把尺子）**——本域**开始处理这次裁决 → 裁决落定**：
 * - 人工路径（`decider: 'user'`）：提示就发生在处理开始的同一瞬间，故它**仍等于**
 *   「提示 → 答复」（技术方案的原措辞），量到的就是人在闸门前的停留时间；
 * - 自动路径（`decider: 'auto'`）：**没有提示**，量到的是规则判定本身的耗时——
 *   **真实测得**，不是拿 0 顶替（0 会冒充「有人 0 毫秒批了」）。
 *
 * **读法**：两种裁者的数按 `decider` 分列——人工盲批分布（高危被秒批＝失控信号）的分母是人，
 * `auto` 条目进的是另一张表（规则命中分布），两者混起来读会把「没问」读成「秒批」。
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
