/**
 * 一次模型调用的**域内形态**——流 / 聚合结果 / 端口。
 *
 * 请求与消息的形制**已归契约**（`@magic/contracts` · 端口内类型：`ModelRequest` ·
 * `ModelMessage` · `ModelFinishReason` · `ModelResult` · `ModelUsage` · `ModelTraits`），
 * 本文件只补契约未载的两件：**工具调用的聚合形态**与**聚合结果的内容视图**。
 *
 * ⚠️ 待决（已随 M02 回报提请规划侧锚定）——契约 `ModelResult` 只载
 * `finishReason` / `usage` / `complete`：**循环要的内容**（正文 / 思考 / 请求的工具调用）
 * 在端口上取不到。本域按规约 4「只增不改」把聚合结果**增补**为 `ModelResult & {…}`
 * （结构上仍是 `ModelResult`，契约未动）——是否升格进契约，请规划侧裁。
 */

import type {
  KernelEvent,
  ModelErrorTier,
  ModelGateway as ModelGatewayPort,
  ModelRequest,
  ModelResult,
  ToolCall,
} from '@magic/contracts'

// —— 聚合结果 ——

/**
 * 模型域聚合出的工具调用——契约 `ToolCall`（`id` ＝**供应商侧**调用 id）＋ 一处本域补充。
 *
 * `invalid`＝参数解析不出（模式不符 / JSON 残缺）——由调用方决定如何回填（如记为工具错误）。
 * ⚠️ 契约 `ToolCall` 未载此位，故仅存在于本域的聚合视图，**不上线**（不送模型、不入条目）。
 */
export type ModelToolCall = ToolCall & {
  readonly invalid?: boolean
}

/** 归一后的错误——与 `model.error` 事件同一份结论。 */
export type ModelError = {
  readonly tier: ModelErrorTier
  readonly message: string
}

/**
 * 一次模型调用的聚合结果——**事件流之外的第二出口**（循环据此决定下一步：回填 / 收束 / 处置）。
 *
 * 与事件流同源：`error` 与 `model.error` 事件同一份归一结论。
 * 承契约 `ModelResult`（`finishReason?` / `usage?` / `complete`），另加内容视图（见文件头注）。
 */
export type ModelCallResult = ModelResult & {
  readonly model: string
  /** 正文全量（`model.delta` 的 text 通道拼合；已切分——不含内嵌思考的标签与内容）。 */
  readonly text: string
  /** 思考全量（`model.delta` 的 thinking 通道拼合；含切开的内嵌思考）。 */
  readonly thinking: string
  /** 模型请求的工具调用（按出现次序）。 */
  readonly toolCalls: readonly ModelToolCall[]
  /** 归一后的错误——与 `model.error` 事件同一份结论；无错为 `undefined`。 */
  readonly error: ModelError | undefined
  /** 被调用方中断（`signal` 触发）——**不是**模型错误，故不发 `model.error`。 */
  readonly aborted: boolean
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
 * 本接口是契约端口的**结构超集**（返回的 `ModelStream` 是契约 `ModelStream` 的收窄——
 * 聚合结果多带了内容视图）。**消费者按契约端口取用即可**；供应商细节不出本域。
 *
 * 实现两处：`createModelGateway`（取件层：AI SDK 接 OpenAI 兼容端点）·
 * Faux（U12：注入固定事件序列，无 key 可测循环 / 恢复 / 渲染）。
 */
export interface ModelGateway extends ModelGatewayPort {
  stream(request: ModelRequest, options?: ModelStreamOptions): ModelStream
}
