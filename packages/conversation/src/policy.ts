/**
 * 上下文策略 —— **域内策略端口**（技术方案 · 依赖规则 3：域内策略端口留在域内，
 * 不占跨域契约位）。
 *
 * 两处口径，一写一读，成对：
 * - **写侧**（`./entries.ts`）——正文超 `blobThreshold` 即转 blob；
 * - **读侧**（`./context.ts`）——blob 引用解析回文本时按 `blobTextLimit` 截断。
 *
 * 缺省值＝实现级常量（技术方案 · 记录 · 规则 ②「大负载落 blob（阈值＝实现级常量）」；
 * 领域划分 · 端口内类型「按策略截断」）。**压缩（阶段 3 · U19）**在此长出后半截——
 * 触发判据（`compactAt*`）与「近段」边界（`nearEntries`）三项。换的是这个对象，
 * 循环与装配不动。
 */

import { DEFAULT_BLOB_TEXT_LIMIT, DEFAULT_NEAR_ENTRIES } from './context.ts'

/**
 * 正文字数阈值——超者转 blob（**字符**，非字节：廉价且可预期，落数据库前的判断够用）。
 * 缺省 8192：一屏刷不完、但还没到「必须落盘」的量级——正常对话不进 blob。
 */
export const DEFAULT_BLOB_THRESHOLD = 8192

/**
 * **压缩触发阈值（占比）**——用量达**窗长**的这一成即压缩（技术方案 · 上下文压缩：
 * 「用量达阈值（常量）」）。0.8 的由头：留两成给「这一轮还要塞进去的东西」
 * （工具定义 ＋ 本轮工具结果 ＋ 模型的答复），压早了白压、压晚了下一轮就撞超限。
 */
export const DEFAULT_COMPACT_AT_FRACTION = 0.8

/**
 * **压缩触发阈值（绝对 token 数）**——**窗长没声明时**的退路（`providers.<id>.contextWindow`
 * 缺省不给，见 D10 的注）。
 *
 * 不编一个「大概是 200k」的窗长：那是替用户猜他的模型。取一个**保守的下限**——
 * 多数端点容得下 128k，故 120k 作为「该收了」的信号；真压早了只是白跑一次摘要，
 * 真撞上超限还有第二条触发路径（`model.error{context-limit}`）兜着。
 */
export const DEFAULT_COMPACT_AT_TOKENS = 120_000

/**
 * **连续失败上限**——压缩连败这么多次就报一条 `error`（技术方案 · 上下文压缩：
 * 「连续失败 → 报 error」）。报后计数清零：再连败这么多条会再报一次，
 * 既不让失败静默、也不让它每轮刷屏。
 */
export const DEFAULT_COMPACT_FAILURE_LIMIT = 3

export type ContextPolicy = {
  /** 正文超此长度即转 blob（字符数）——写侧。 */
  readonly blobThreshold: number
  /** blob 正文解析回文本的上限（字符数）——读侧。 */
  readonly blobTextLimit: number
  /** 用量占**窗长**的比例达此值即压缩（窗长已声明时走这条）——阶段 3。 */
  readonly compactAtFraction: number
  /** 窗长**未声明**时的绝对触发阈值（token）——阶段 3。 */
  readonly compactAtTokens: number
  /** 「近段」＝尾部保留原文的条目数（压缩时不动它）——阶段 3。 */
  readonly nearEntries: number
  /** 压缩连续失败多少次报一条 `error`——阶段 3。 */
  readonly compactFailureLimit: number
}

/** 缺省上下文策略——阶段 1 两件 ＋ 阶段 3 压缩四件（只增不改）。 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  blobThreshold: DEFAULT_BLOB_THRESHOLD,
  blobTextLimit: DEFAULT_BLOB_TEXT_LIMIT,
  compactAtFraction: DEFAULT_COMPACT_AT_FRACTION,
  compactAtTokens: DEFAULT_COMPACT_AT_TOKENS,
  nearEntries: DEFAULT_NEAR_ENTRIES,
  compactFailureLimit: DEFAULT_COMPACT_FAILURE_LIMIT,
}
