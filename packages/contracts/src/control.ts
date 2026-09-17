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
  /**
   * **「总是允许」——答复意图，不是裁决词表的第三词**（技术方案 · 领域划分 · 端口内类型）。
   *
   * `Decision`（`approve` / `reject`）是**结果词**——`tool.decision.decision` 用的是同一个
   * 两词表，不扩。而「总是允许」是**用户答复时的意图**（批准 ＋ 记住），故落在**命令侧**
   * 这一个可选的位上。**向后兼容**——不给 ＝ 一次性批准，与阶段 1 逐字同义。
   *
   * 流转：控制域**原样转手**（`gate.resolve(id, decision, { remember })`），**不由它翻译**；
   * 会话级记忆归**权限域**（按 工具 × 路径模式 × 操作类型 记，新会话即清零）。
   * **只在批准时生效**——规则的条目只有「允许」这一形，没有「总是拒绝」。
   */
  readonly remember?: boolean
}

/** `turn.interrupt`——中断（首站：Ctrl+C）。 */
export type TurnInterrupt = {
  readonly type: 'turn.interrupt'
}

/** 命令目录（首站）——外壳发往内核的全部消息。 */
export type Command = InputSubmit | DecisionAnswer | TurnInterrupt

/** 裁决配对的事件侧——内核发此事件（带呈现材料），外壳以 `decision.answer` 答复。 */
export const DECISION_REQUEST_KIND = 'tool.decision.request'
