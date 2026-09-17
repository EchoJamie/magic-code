/**
 * 上下文策略 —— **域内策略端口**（技术方案 · 依赖规则 3：域内策略端口留在域内，
 * 不占跨域契约位）。
 *
 * 两处口径，一写一读，成对：
 * - **写侧**（`./entries.ts`）——正文超 `blobThreshold` 即转 blob；
 * - **读侧**（`./context.ts`）——blob 引用解析回文本时按 `blobTextLimit` 截断。
 *
 * 缺省值＝实现级常量（技术方案 · 记录 · 规则 ②「大负载落 blob（阈值＝实现级常量）」；
 * 领域划分 · 端口内类型「按策略截断」）。**压缩（阶段 3）**会在此处长出真正的上下文策略
 * ——届时换的是这个对象，循环与装配不动。
 */

import { DEFAULT_BLOB_TEXT_LIMIT } from './context.ts'

/**
 * 正文字数阈值——超者转 blob（**字符**，非字节：廉价且可预期，落数据库前的判断够用）。
 * 缺省 8192：一屏刷不完、但还没到「必须落盘」的量级——正常对话不进 blob。
 */
export const DEFAULT_BLOB_THRESHOLD = 8192

export type ContextPolicy = {
  /** 正文超此长度即转 blob（字符数）——写侧。 */
  readonly blobThreshold: number
  /** blob 正文解析回文本的上限（字符数）——读侧。 */
  readonly blobTextLimit: number
}

/** 缺省上下文策略——阶段 1 的取值；阶段 3 压缩在此长出新字段（只增不改）。 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  blobThreshold: DEFAULT_BLOB_THRESHOLD,
  blobTextLimit: DEFAULT_BLOB_TEXT_LIMIT,
}
