/**
 * 一次模型调用的**接缝形态**——请求 / 结果 / 流 / 接缝接口。
 *
 * 供应商与 SDK 的形态不出这一层（技术方案 · 模型策略 · 接缝自留）——
 * 这里是内核其余部分（循环 / 上下文 / Faux）与接缝的界面。
 *
 * TODO(规划侧)：技术方案未定「请求 / 结果」之形制，此处**自决形态**（并行规约 4 ·
 * 只增不改 · 随 U03 回报备案）。U04（主循环）与 U12（Faux Provider）以此为界面。
 */

import type { JsonSchema, ModelErrorTier } from '../contracts/index.ts'
import type { ModelEvent } from './events.ts'

// —— 请求 ——

/** 模型请求的工具调用——工具名 + 已解析参数（`args` 对齐记录契约 `tool.call` 的 `args`）。 */
export type ModelToolCall = {
  readonly id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** 参数解析不出（模式不符 / JSON 残缺）——由调用方决定如何回填（如记为工具错误）。 */
  readonly invalid?: boolean
}

/** 送模型的工具定义——**执行体不在接缝**（模型只出请求；执行归工具机制 + 权限闸门）。 */
export type ModelToolSpec = {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
}

/**
 * 会话消息——内核侧最小形态。
 *
 * 形制自决（技术方案未定）；刻意贴四角色，避免为「再归一」另造一套词表。
 * 工具消息带 `name`——取件层回填工具结果时需要（OpenAI 兼容族的 `tool` 消息同此）。
 */
export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: readonly ModelToolCall[]
    }
  | {
      readonly role: 'tool'
      readonly callId: string
      readonly name: string
      readonly content: string
      readonly isError?: boolean
    }

/** 一次模型调用的请求。 */
export type ModelRequest = {
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ModelToolSpec[]
}

// —— 结果 ——

/** 用量（形态同记录契约 `model.usage` 的 `data`）。 */
export type ModelUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * 收束方式——供应商 `finish_reason` 归一后的**内核词表**（供应商措辞不出接缝）。
 * `unknown`＝流未给出收束原因（含被中断 / 半途而废）。
 */
export type ModelFinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown'

/**
 * 一次模型调用的结果——事件流之外的**聚合视图**（循环据此决定下一步：回填 / 收束 / 处置）。
 * 与事件流同源：`error` 与 `model.error` 事件同一份归一结论。
 */
export type ModelCallResult = {
  readonly model: string
  /** 正文全量（`model.delta` 的 text 通道拼合）。 */
  readonly text: string
  /** 思考全量（`model.delta` 的 thinking 通道拼合）。 */
  readonly thinking: string
  /** 模型请求的工具调用（按出现次序）。 */
  readonly toolCalls: readonly ModelToolCall[]
  /** 供应商未回用量时为 `undefined`——区别于「回了 0」。 */
  readonly usage: ModelUsage | undefined
  readonly finishReason: ModelFinishReason
  /** 归一后的错误——与 `model.error` 事件同一份结论；无错为 `undefined`。 */
  readonly error: { readonly tier: ModelErrorTier; readonly message: string } | undefined
  /** 被调用方中断（`signal` 触发）——**不是**模型错误，故不发 `model.error`。 */
  readonly aborted: boolean
  /** 事件流是否走完（消费方提前 `break` 时为 `false`）。 */
  readonly complete: boolean
}

// —— 流与接缝 ——

/**
 * 调用流——事件流（实时，逐条可渲染）+ 结果（聚合，供循环决策）。
 *
 * `result` 随 `events` **被消费完**而落定：拉到一半 `break` 亦会落定（`complete: false`）；
 * 但若 `events` 从未被迭代，`result` 不会落定——接缝不替消费方缓冲整条流。
 */
export type ModelStream = {
  readonly events: AsyncIterable<ModelEvent>
  readonly result: Promise<ModelCallResult>
}

/** 流选项——中断信号（首站 Ctrl+C，经控制面 `turn.interrupt` 落到循环，再落到此）。 */
export type ModelStreamOptions = {
  readonly signal?: AbortSignal
}

/**
 * 模型接缝——内核与供应商之间的**唯一界面**。
 *
 * 实现两处：`createModelSeam`（取件层：AI SDK 接 OpenAI 兼容端点）·
 * Faux（U12：注入固定事件序列，无 key 可测循环 / 恢复 / 渲染）。
 */
export interface ModelSeam {
  stream(request: ModelRequest, options?: ModelStreamOptions): ModelStream
}
