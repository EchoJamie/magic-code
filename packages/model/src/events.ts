/**
 * 模型域事件 —— 接缝的**输出形态**（工作分解 · 迁移轨道 M02）。
 *
 * 归一终点＝共享语言 · 事件的 model 系列 kind（技术方案 · 模型策略 · 接缝自留）：
 * 取件层（AI SDK）已归一供应商差异；这里**再归一到内核事件模型**——内核只见自家事件。
 *
 * **构造面**——一律经 `stampEvent` 铸 `EventEnvelope<'kind'>`：`kind` 与 `data` 逐 kind
 * 取自契约（`EventDataOf`），**信封四件由注入的 `EventEnvelopeSource` 给**（见 `envelope.ts`
 * 文件头注：`id` / `session` / `turn` 的归属未定，故不自铸）。
 */

import type { DeltaChannel, EventEnvelope, ModelErrorTier } from '@magic/contracts'
import type { EventEnvelopeSource } from './envelope.ts'
import { stampEvent } from './envelope.ts'

/** 调用起——只报模型名；端点 / key / 参数等供应商细节不出此域。 */
export function modelCallStart(
  source: EventEnvelopeSource,
  model: string,
): EventEnvelope<'model.call.start'> {
  return stampEvent(source, 'model.call.start', { model })
}

/** 调用止——收束。失败走 `modelErrorEvent`，**不另发** `model.call.end`。 */
export function modelCallEnd(source: EventEnvelopeSource): EventEnvelope<'model.call.end'> {
  return stampEvent(source, 'model.call.end', {})
}

/**
 * 用量——随事件流入记录（技术方案 · 模型策略 · 用量：成本可见的数据基础）。
 * 供应商未回用量时**不发**此事件（不发比发 `{0, 0}` 诚实）。
 */
export function modelUsage(
  source: EventEnvelopeSource,
  inputTokens: number,
  outputTokens: number,
): EventEnvelope<'model.usage'> {
  return stampEvent(source, 'model.usage', { inputTokens, outputTokens })
}

/**
 * 实时增量——**不落库**（共享语言 · 规则 ①：`model.delta` 属 `TRANSIENT_EVENT_KINDS`），
 * 供渲染订阅。
 *
 * `channel` 三选一：正文（`text`）/ 思考（`thinking`）/ 工具调用参数片段（`toolcall`）。
 * toolcall 通道的 `name`＝工具名——流中**先于**参数片段出现，故 `tool-input-start` 时
 * 即发一条空文本增量（否则零参工具在流里将无名可示）。
 */
export function modelDelta(
  source: EventEnvelopeSource,
  channel: DeltaChannel,
  text: string,
  name?: string,
): EventEnvelope<'model.delta'> {
  return stampEvent(source, 'model.delta', name === undefined ? { channel, text } : { channel, text, name })
}

/** 模型域错误——已分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export function modelErrorEvent(
  source: EventEnvelopeSource,
  tier: ModelErrorTier,
  message: string,
): EventEnvelope<'model.error'> {
  return stampEvent(source, 'model.error', { tier, message })
}
