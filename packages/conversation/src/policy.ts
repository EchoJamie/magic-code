/** 上下文保存与压缩策略；业务历史按实际交付正文重建。 */

import { DEFAULT_NEAR_ENTRIES } from './context.ts'

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

export type ContextPolicy = {
  /** 正文超此长度即转 blob（字符数）——写侧。 */
  readonly blobThreshold: number
  /** 用量占**窗长**的比例达此值即压缩（窗长已声明时走这条）——阶段 3。 */
  readonly compactAtFraction: number
  /** 窗长**未声明**时的绝对触发阈值（token）——阶段 3。 */
  readonly compactAtTokens: number
  /** 「近段」＝尾部保留原文的条目数（压缩时不动它）——阶段 3。 */
  readonly nearEntries: number
}

/** 缺省上下文策略——阶段 1 两件 ＋ 阶段 3 压缩四件（只增不改）。 */
export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  blobThreshold: DEFAULT_BLOB_THRESHOLD,
  compactAtFraction: DEFAULT_COMPACT_AT_FRACTION,
  compactAtTokens: DEFAULT_COMPACT_AT_TOKENS,
  nearEntries: DEFAULT_NEAR_ENTRIES,
}
