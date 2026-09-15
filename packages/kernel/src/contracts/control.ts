/**
 * 控制面消息 —— **接入契约**（已冻结）。
 *
 * 出处：技术方案 · 接入：控制面与外壳（「消息目录（首站）」）。
 * 形态——类型化接口 + 事件订阅；首站同进程直连；消息按**可序列化**设计（JSON 友好）——
 * **即便同进程也走此协议**（不走内部直调）：并行开发与后续换壳的共同地基。
 *
 * 本文件是**转写**：只落技术方案已冻结之名与结构，不加设计。
 * 未定之处标 `TODO(规划侧)`。
 */

import type { Decision, EventEnvelope, RecordId } from './records.ts'

// —— 命令（外壳 → 内核）——

/**
 * `input.submit`——用户输入。
 *
 * TODO(规划侧)：技术方案只写「用户输入」，未定负载字段；占位为单文本。
 */
export type InputSubmit = {
  readonly type: 'input.submit'
  readonly text: string
}

/**
 * `decision.answer`——裁决答复，与 `tool.decision.request` **配对**。
 * 配对键＝请求事件的 `id`（技术方案 · 接入：同 `id`）；首站＝人工裁决（批准 / 拒绝）。
 */
export type DecisionAnswer = {
  readonly type: 'decision.answer'
  readonly id: RecordId
  readonly decision: Decision
}

/** `turn.interrupt`——中断（首站：Ctrl+C）。 */
export type TurnInterrupt = {
  readonly type: 'turn.interrupt'
}

/** 命令目录（首站）——外壳发往内核的全部消息。 */
export type Command = InputSubmit | DecisionAnswer | TurnInterrupt

// —— 事件（内核 → 外壳）——

/** 事件推送——即事件流 kind 族；信封与 kind 见**记录契约**（控制面不另立事件形态）。 */
export type KernelEvent = EventEnvelope

/** 裁决配对的事件侧——内核发此事件（带呈现材料），外壳以 `decision.answer` 答复。 */
export const DECISION_REQUEST_KIND = 'tool.decision.request'
