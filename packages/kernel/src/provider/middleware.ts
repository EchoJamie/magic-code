/**
 * 中间件位 —— 横切逻辑（日志 / 用量 / 改写）的挂点（技术方案 · 模型策略 · 接缝自留）。
 *
 * **阶段 1 只留位**：定下形态与次序语义，**不附任何实现**——位子空着不花成本，
 * 而「事后往接缝里塞横切」要改接缝本身。U17（模型扩展）起按需落实现。
 *
 * 两个挂点对应两类横切：
 * - `transformRequest`——**改写**（改提示 / 加参数 / 换模型名），请求方向；
 * - `transformEvents`——**观察与改写**（日志 / 用量统计 / 过滤增量），事件方向。
 *
 * 次序语义：数组**由外到内**——`[a, b]` 时 a 是外层。
 * 请求方向 a 先见原始请求、b 见 a 的产物；事件方向 a 包住 b（a 先见、且能看到 b 之后的整条流）。
 * 与取件层 `wrapLanguageModel` 的嵌套直觉一致（参考文档 · 模型接入调研 · 设计观察 3）。
 */

import type { ModelRequest } from './call.ts'
import type { ModelEvent } from './events.ts'

/** 调用上下文——横切逻辑的判据（谁在调、调什么）。不含 key。 */
export type ModelCallContext = {
  /** 供应商 id（配置 `providers.<id>` 的键）。 */
  readonly provider: string
  /** 模型名（配置条目里的 `model`）。 */
  readonly model: string
  /** 中间件链**之前**的原始请求（免受改写影响，便于对账）。 */
  readonly request: ModelRequest
}

/**
 * 中间件——一个具名、可选的横切单元。
 * 两个挂点皆可选：只写日志的中间件只实现 `transformEvents`。
 */
export type ModelMiddleware = {
  readonly name: string
  transformRequest?: (request: ModelRequest, ctx: ModelCallContext) => ModelRequest
  transformEvents?: (
    events: AsyncIterable<ModelEvent>,
    ctx: ModelCallContext,
  ) => AsyncIterable<ModelEvent>
}

/** 依序应用请求改写（数组由外到内：`[a, b]` → `b(a(request))`）。 */
export function applyRequestMiddleware(
  middlewares: readonly ModelMiddleware[],
  request: ModelRequest,
  ctx: ModelCallContext,
): ModelRequest {
  let current = request
  for (const middleware of middlewares) {
    current = middleware.transformRequest?.(current, ctx) ?? current
  }
  return current
}

/**
 * 依序套上事件改写（数组由外到内：`[a, b]` → `a(b(events))`）。
 * 逆序折叠——使先列者成为最外层，与请求方向同向。
 */
export function applyEventMiddleware(
  middlewares: readonly ModelMiddleware[],
  events: AsyncIterable<ModelEvent>,
  ctx: ModelCallContext,
): AsyncIterable<ModelEvent> {
  let current = events
  for (let index = middlewares.length - 1; index >= 0; index -= 1) {
    const middleware = middlewares[index]
    if (middleware?.transformEvents === undefined) continue
    current = middleware.transformEvents(current, ctx)
  }
  return current
}
