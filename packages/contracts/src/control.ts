/**
 * 共享语言 · 控制面（命令面 · 配对）——已冻结。
 *
 * 出处：技术方案 · 接入（「消息目录（首站）」）。
 * 形态——类型化接口 + 事件订阅；首站同进程直连；消息按**可序列化**设计（JSON 友好）——
 * **即便同进程也走此协议**（不走内部直调）：并行开发与后续换壳的共同地基。
 *
 * 事件侧＝**事件流 kind 族**（不在此另立形态）；外壳按 `kind` 判别收窄——用
 * `events.ts` 的判别联合视图 `KernelEvent`。
 */

import type { Decision } from './events.ts'
import type { DecisionId } from './ids.ts'

/**
 * 用户输入。
 * 命令负载与 `ConversationService.submit` 入参**同一形态**——两处不各立一份。
 */
export type UserInput = {
  readonly text: string
}

/**
 * `input.submit`——用户输入。
 *
 * TODO(规划侧)：技术方案只写「用户输入」，未定负载字段；占位为单文本。
 */
export type InputSubmit = { readonly type: 'input.submit' } & UserInput

/**
 * `decision.answer`——裁决答复，与 `tool.decision.request` **配对**。
 * 配对键＝**请求事件** `id`（`DecisionId`）；首站＝人工裁决（批准 / 拒绝）。
 */
export type DecisionAnswer = {
  readonly type: 'decision.answer'
  readonly id: DecisionId
  readonly decision: Decision
}

/** `turn.interrupt`——中断（首站：Ctrl+C）。 */
export type TurnInterrupt = {
  readonly type: 'turn.interrupt'
}

/** 命令目录（首站）——外壳发往内核的全部消息。 */
export type Command = InputSubmit | DecisionAnswer | TurnInterrupt

/** 裁决配对的事件侧——内核发此事件（带呈现材料），外壳以 `decision.answer` 答复。 */
export const DECISION_REQUEST_KIND = 'tool.decision.request'
