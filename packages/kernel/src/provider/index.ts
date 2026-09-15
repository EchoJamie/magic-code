/**
 * `provider/` 公开面 —— 模型接缝（工作分解 · 单元落位：U03 `provider/`）。
 *
 * 跨单元只 import 契约或此入口（并行规约 1）。这里出去的东西：
 * - **形态**——`ModelEvent`（内核事件 · kind + data，信封归记录侧）· 请求 / 结果 / 流 · 中间件位；
 * - **装配**——`createModelSeam`（AI SDK 接 OpenAI 兼容端点，首接 MiniMax）；
 * - **构造子**——事件构造器（Faux Provider 与循环测试用）。
 *
 * 不出去的：取件层 chunk 形态、SDK 类型、错误分档的正则表、归一过程。
 * 归一终点是记录契约的 model 系列——**内核只见自家事件**（技术方案 · 模型策略）。
 *
 * 与契约的关系：本目录**不改契约**，只消费 `EventDataOf` / `ModelErrorTier` /
 * `DeltaChannel` / `ProviderConfig` / `apiKeyEnvVarOf` / `JsonSchema`。
 */

export {
  modelCallEnd,
  modelCallStart,
  modelDelta,
  modelErrorEvent,
  modelUsage,
} from './events.ts'
export type { ModelEvent, ModelEventKind } from './events.ts'

export type {
  ModelCallResult,
  ModelFinishReason,
  ModelMessage,
  ModelRequest,
  ModelSeam,
  ModelStream,
  ModelStreamOptions,
  ModelToolCall,
  ModelToolSpec,
  ModelUsage,
} from './call.ts'

export { applyEventMiddleware, applyRequestMiddleware } from './middleware.ts'
export type { ModelCallContext, ModelMiddleware } from './middleware.ts'

export { createModelSeam, MissingApiKeyError, resolveApiKey } from './seam.ts'
export type { ModelSeamOptions } from './seam.ts'

export {
  MAX_COMPLETION_TOKENS,
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  MINIMAX_PROVIDER_ID,
  requestBody,
} from './ai-sdk.ts'
export type { FetchLike } from './ai-sdk.ts'

export { classifyModelError, describeModelError, isAbortError, redactSecrets } from './errors.ts'
