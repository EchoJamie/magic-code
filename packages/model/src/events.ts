/**
 * 模型域事件 —— 接缝的**输出形态**（工作分解 · 迁移轨道 M02）。
 *
 * 归一终点＝共享语言 · 事件的 model 系列 kind（技术方案 · 模型策略 · 接缝自留）：
 * 取件层（AI SDK）已归一供应商差异；这里**再归一到内核事件模型**——内核只见自家事件。
 *
 * **构造面**——一律经注入的 `EventStamper`（技术方案 · 领域划分 · 信封的归属 v0 锚定）：
 * **信封由产出方铸**，故 `id` / `session` / `turn` / `at` 四件由铸造器盖——
 * **模型域不自造计数、不自取时钟**；铸造器由装配按会话实例构造并注入。
 *
 * `stamp` 的返回是 `KernelEvent`（判别联合视图）——消费侧按 `kind` 自动收窄。
 */

import type {
  DeltaChannel,
  EventStamper,
  KernelEvent,
  ModelErrorTier,
} from '@magic/contracts'

/** 调用起——只报模型名；端点 / key / 参数等供应商细节不出此域。 */
export function modelCallStart(stamper: EventStamper, model: string): KernelEvent {
  return stamper.stamp('model.call.start', { model })
}

/** 调用止——收束。失败走 `modelErrorEvent`，**不另发** `model.call.end`。 */
export function modelCallEnd(stamper: EventStamper): KernelEvent {
  return stamper.stamp('model.call.end', {})
}

/**
 * 用量——随事件流入记录（技术方案 · 模型策略 · 用量：成本可见的数据基础）。
 * 供应商未回用量时**不发**此事件（不发比发 `{0, 0}` 诚实）。
 */
export function modelUsage(
  stamper: EventStamper,
  inputTokens: number,
  outputTokens: number,
): KernelEvent {
  return stamper.stamp('model.usage', { inputTokens, outputTokens })
}

/**
 * 实时增量——**不落库**（共享语言 · 规则 ①：`model.delta` 属 `TRANSIENT_EVENT_KINDS`），
 * 供渲染订阅。
 *
 * `channel` 三选一：正文（`text`）/ 思考（`thinking`）/ 工具调用参数片段（`toolcall`）。
 *
 * toolcall 通道另带两件（`model.delta` 载荷 v0 锚定）：
 * - `name`＝工具名——流中**先于**参数片段出现，故 `tool-input-start` 时即发一条空文本增量
 *   （否则零参工具在流里将无名可示）；
 * - `id`＝**供应商侧调用 id**——渲染侧据以按调用分组（同轮可多次调用）。
 */
export function modelDelta(
  stamper: EventStamper,
  channel: DeltaChannel,
  text: string,
  name?: string,
  id?: string,
): KernelEvent {
  return stamper.stamp('model.delta', {
    channel,
    text,
    ...(name === undefined ? {} : { name }),
    ...(id === undefined ? {} : { id }),
  })
}

/** 模型域错误——已分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export function modelErrorEvent(
  stamper: EventStamper,
  tier: ModelErrorTier,
  message: string,
): KernelEvent {
  return stamper.stamp('model.error', { tier, message })
}
