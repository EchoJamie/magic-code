/**
 * `@magic/model` —— 模型域公开面（技术方案 · 领域划分：模型域）。
 *
 * 职责：**模型接入接缝**——注册 · 流式归一 · 错误分档 · 用量 · 模型特征标记。
 * 对外端口：**`ModelGateway`**（`stream(req, opts) → { events; result }`）。
 *
 * 域纪律（技术方案 · 代码治理）：
 * - **只依赖 `@magic/contracts`**（＋许可外部库：AI SDK）——域之间互不 import、域不认知外壳与装配；
 * - **供应商细节不出域**（防腐层）——端点常量 · 字段改写 · SDK chunk 形态皆封在域内；
 * - **key 永不入事件与记录**——只在装配层解析（`resolveApiKey`），产出的一切文本先过 `redactSecrets`；
 * - 不碰文件系统、不读配置文件（配置加载是 U11 的活）。
 *
 * 出口五件：
 * ① **端口装配**——`createModelGateway`（单条目）· **`createModelRegistry`**（多条目的注册表 ＋ 运行时切换）；
 * ② **形态**——`ModelGateway` / `ModelStream` / `ModelCallResult` / 中间件位 / 注册表形态；
 * ③ **构造子**——事件构造子与信封来源（Faux Provider 与循环测试用）；
 * ④ **纯函数**——错误分档 / 脱敏 / 特征标记与容量（窗长）裁定；
 * ⑤ **策略**——退避重试的策略形态与缺省（`RetryPolicy` / `DEFAULT_RETRY_POLICY`）。
 *
 * 不出去的：取件层 chunk 形态（`VendorStreamPart`）· SDK 类型 · 错误分档的正则表 ·
 * 归一过程 · 内嵌思考的切分器 · 退避重试的循环（只出策略与计数，不出实现）。
 */

// —— ② 形态 ——

export type {
  ModelCallResult,
  ModelError,
  ModelGateway,
  ModelStream,
  ModelStreamOptions,
} from './call.ts'

export type { ModelCallContext, ModelMiddleware } from './middleware.ts'
export { applyEventMiddleware, applyRequestMiddleware } from './middleware.ts'

// —— ① 端口装配 ——

export { createModelGateway, MissingApiKeyError, resolveApiKey } from './gateway.ts'
export type { ModelGatewayOptions } from './gateway.ts'

// 注入用 fetch（假端点回放 SSE）——`fetch` 是构造入参的一件，其形态随之出口
export type { FetchLike } from './ai-sdk.ts'

// —— ①之二 多条目的注册表 ＋ 运行时切换（技术方案 · 模型策略 · 切换）——

export { createModelRegistry } from './registry.ts'
export type {
  ModelRegistry,
  ModelRegistryOptions,
  ModelSelection,
  ModelSwitchRequest,
  ModelSwitchResult,
  ProviderEntry,
} from './registry.ts'

// —— ①之三 模型信息（U41：缓存与时效策略 · 供应商适配）——
//
// ⚠️ **适配本身不上公开面**（`VendorAdapter` / `MINIMAX_VENDOR` / `DEEPSEEK_VENDOR`
// 都是域内件，装配只见 `ProviderConfig.vendor` 这个名字）：出去的只有「一份可用读数」
// 与「拿它要什么」。测试要深链 `../src/vendors.ts`（照测试面分面的先例）。

export { createModelInfoService, resolveConnection } from './model-info.ts'

// 内置供应商与官方区域的**读面**（U41 返修）——界面「接入」时据此列；
// 适配本身仍不上公开面（出去的是归一后的 `VendorInfo`，见 `vendors.ts`）
export { vendorCatalog } from './vendors.ts'
export type { ModelConnection, ModelInfoService, ModelInfoServiceOptions } from './model-info.ts'
export { MODEL_INFO_FAILURE_COOLDOWN_MS, MODEL_INFO_TTL_MS } from './model-info.ts'

// —— ③ 构造子（Faux Provider 与循环测试用；信封由注入的 `EventStamper` 铸）——

export {
  modelCallEnd,
  modelCallStart,
  modelDelta,
  modelErrorEvent,
  modelUsage,
} from './events.ts'

// —— ④ 纯函数 ——

export { classifyModelError, describeModelError, isAbortError, redactSecrets } from './errors.ts'

export { MODEL_TRAITS_BUILTIN, resolveModelTraits } from './traits.ts'

// 容量（上下文窗总量 · U30）——与 `traits` 同族的内置表 ＋ 覆盖判定。
// ⚠️ **旧的「窗长表」出口已撤**（U41 返修）：分母改由 `ModelRegistry.capacityOf` 一次解析，
// 经事件给外壳（`model.switched` / `model.call.start` 的 `inputBudget`）。这两件留着——
// 它们是域内的容量资料与**兼容接入**那条路的判定（别按「没人调」删掉）。
export { MODEL_CONTEXT_BUILTIN, resolveContextWindow } from './capacity.ts'

// —— ⑤ 策略（退避重试——见 `retry.ts`）——

export { DEFAULT_RETRY_POLICY } from './retry.ts'
export type { RetryPolicy, Sleeper } from './retry.ts'

// —— 首接供应商常量（装配根取用；供应商细节本身仍是域内物，这里只出「默认值」）——

export {
  MAX_COMPLETION_TOKENS,
  MINIMAX_BASE_URL,
  MINIMAX_MODEL,
  MINIMAX_PROVIDER_ID,
} from './ai-sdk.ts'
