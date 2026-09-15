/**
 * 内核模型事件 —— 接缝的**输出形态**（工作分解 · U03）。
 *
 * 归一终点＝记录契约的 model 系列 kind（技术方案 · 模型策略 · 接缝自留）：
 * 取件层（AI SDK）已归一供应商差异；这里**再归一到内核事件模型**——内核只见自家事件。
 *
 * 信封（`id` / `session` / `turn` / `at`）**不在本层**：接缝只产出 `kind` + `data`
 * （按记录契约逐 kind 配对）；信封由记录侧（U02）装配——接缝不铸 `RecordId`。
 */

import type { DeltaChannel, EventDataOf, EventKind, ModelErrorTier } from '../contracts/index.ts'

/** 接缝会产出的内核事件 kind——记录契约 `EventKind` 的 model 系列子集。 */
export type ModelEventKind = Extract<
  EventKind,
  'model.call.start' | 'model.call.end' | 'model.usage' | 'model.delta' | 'model.error'
>

/** 内核模型事件——`kind` 与 `data` 按记录契约逐 kind 配对。 */
export type ModelEvent = {
  [K in ModelEventKind]: { readonly kind: K; readonly data: EventDataOf[K] }
}[ModelEventKind]

/** 调用起——只报模型名；端点 / key / 参数等供应商细节不出此层。 */
export function modelCallStart(model: string): ModelEvent {
  return { kind: 'model.call.start', data: { model } }
}

/** 调用止——收束。失败走 `modelErrorEvent`，**不另发** `model.call.end`。 */
export function modelCallEnd(): ModelEvent {
  return { kind: 'model.call.end', data: {} }
}

/**
 * 用量——随事件流入记录（技术方案 · 模型策略 · 用量：成本可见的数据基础）。
 * 供应商未回用量时**不发**此事件（不发比发 `{0, 0}` 诚实）。
 */
export function modelUsage(inputTokens: number, outputTokens: number): ModelEvent {
  return { kind: 'model.usage', data: { inputTokens, outputTokens } }
}

/**
 * 实时增量——**不落库**（记录契约 · 规则 ①：`model.delta` 属 `TRANSIENT_EVENT_KINDS`），
 * 供渲染订阅。
 *
 * `channel` 三选一：正文（`text`）/ 思考（`thinking`）/ 工具调用参数片段（`toolcall`）。
 * toolcall 通道的 `name`＝工具名——流中**先于**参数片段出现，故 `tool-input-start` 时
 * 即发一条空文本增量（否则零参工具在流里将无名可示）。
 */
export function modelDelta(channel: DeltaChannel, text: string, name?: string): ModelEvent {
  return {
    kind: 'model.delta',
    data: name === undefined ? { channel, text } : { channel, text, name },
  }
}

/** 模型域错误——已分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export function modelErrorEvent(tier: ModelErrorTier, message: string): ModelEvent {
  return { kind: 'model.error', data: { tier, message } }
}
