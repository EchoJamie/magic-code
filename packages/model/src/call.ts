/**
 * 一次模型调用的**域内形态**——流 / 聚合结果 / 端口。
 *
 * 请求与消息的形制**已归契约**（`@magic/contracts` · 端口内类型：`ModelRequest` ·
 * `ModelMessage` · `ModelFinishReason` · `ModelResult` · `ModelUsage` · `ModelTraits` ·
 * `ToolCall`），本文件只补契约未载的**内容视图**（正文 / 思考 / 错误 / 中止）。
 *
 * ⚠️ 内容视图是**域内聚合**（不在契约里）：`ModelResult` 载「怎么结束的」，
 * 内容由归一另外拼出，供循环与渲染取用。`toolCalls` **不在此列**——已升格进契约
 * `ModelResult`（M01-3 补锚），面向端口者（U04）据以回填，不必解析事件流。
 */

import type {
  KernelEvent,
  ModelErrorTier,
  ModelGateway as ModelGatewayPort,
  ModelRequest,
  ModelResult,
} from '@magic/contracts'

// —— 聚合结果 ——

/** 归一后的错误——与 `model.error` 事件同一份结论。 */
export type ModelError = {
  readonly tier: ModelErrorTier
  readonly message: string
}

/**
 * 一次模型调用的聚合结果——**事件流之外的第二出口**（循环据此决定下一步：回填 / 收束 / 处置）。
 *
 * 承契约 `ModelResult`（`finishReason?` / `usage?` / `complete` / `toolCalls?`——已在契约里），
 * 另加**内容视图**：`text` / `thinking` / `error` / `aborted`。
 * 与事件流同源：`error` 与 `model.error` 事件同一份归一结论。
 */
export type ModelCallResult = ModelResult & {
  readonly model: string
  /** 正文全量（`model.delta` 的 text 通道拼合；已切分——不含内嵌思考的标签与内容）。 */
  readonly text: string
  /** 思考全量（`model.delta` 的 thinking 通道拼合；含切开的内嵌思考）。 */
  readonly thinking: string
  /** 归一后的错误——与 `model.error` 事件同一份结论；无错为 `undefined`。 */
  readonly error: ModelError | undefined
  /** 被调用方中断（`signal` 触发）——**不是**模型错误，故不发 `model.error`。 */
  readonly aborted: boolean
  /**
   * **尝试次数（含首次）**——瞬时档退避重试的读数（见 `retry.ts`）。
   *
   * 事件流里看不见重试（`model.error` 是终局信号，不能兼作进度信号），故次数落在这儿：
   * `2` ＝ 头一次失败、重来成了。缺省 / 未给 ＝ **1（未重试）**——Faux 与直接喂 chunk
   * 的用例不记这个数；取件层真实现一律给（`attempts > 1` 即「这一轮真重试过」）。
   */
  readonly attempts?: number
}

// —— 流与端口 ——

/**
 * 调用流——事件流（实时，逐条可渲染）+ 结果（聚合，供循环决策）。
 *
 * `result` 随 `events` **被消费完**而落定：拉到一半 `break` 亦会落定（`complete: false`）；
 * 但若 `events` 从未被迭代，`result` 不会落定——接缝不替消费方缓冲整条流。
 */
export type ModelStream = {
  readonly events: AsyncIterable<KernelEvent>
  readonly result: Promise<ModelCallResult>
}

/** 流选项——中断信号（首站 Ctrl+C，经控制面 `turn.interrupt` 落到循环，再落到此）。 */
export type ModelStreamOptions = {
  readonly signal?: AbortSignal
}

/**
 * 模型网关——内核与供应商之间的**唯一界面**（契约端口 `ModelGateway` 的落地）。
 *
 * 本接口是契约端口的**结构超集**（聚合结果多带了内容视图——见 `ModelCallResult`）。
 * **消费者按契约端口取用即可**；供应商细节不出本域。
 *
 * 实现两处：`createModelGateway`（取件层：AI SDK 接 OpenAI 兼容端点）·
 * Faux（U12：注入固定事件序列，无 key 可测循环 / 恢复 / 渲染）。
 */
export interface ModelGateway extends ModelGatewayPort {
  stream(request: ModelRequest, options?: ModelStreamOptions): ModelStream
}
