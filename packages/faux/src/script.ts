/**
 * Faux 脚本 —— **注入固定事件序列**的输入形态（技术方案 · 模型策略 · 测试）。
 *
 * 一段脚本 ＝ **一次模型调用**（一次 `stream()`）；循环「调用 → 工具 → 回填 → 收束」
 * 就是依次取段。故脚本＝**数组**，不是单个回合描述。
 *
 * 写法照「模型做了什么」来（不是「发哪些事件」来）——信封 / 增量切分 / 收束事件
 * 由 Faux 按真实接缝的不变式展开（见 `gateway.ts` 文件头）；写测试的人只关心
 * 模型说了什么、调了什么、错在哪一档。
 */

import type { ModelErrorTier, ModelUsage } from '@magic/contracts'

/** 一段文本——字符串 ＝ 一条增量；数组 ＝ 多条增量（测流式渲染「一段段来」）。 */
export type FauxText = string | readonly string[]

/** 一次工具调用——参数会被序列化成 JSON 增量流式产出。 */
export type FauxToolCall = {
  readonly name: string
  /** 参数——缺省 `{}`。 */
  readonly args?: Readonly<Record<string, unknown>>
  /**
   * **供应商侧**调用 id（与 `ToolCall.id` 同空间）——缺省按段内序号造 `call_1` / `call_2`…
   * 可预测是刻意的：断言不必靠猜。
   */
  readonly id?: string
}

/**
 * 一次模型调用的脚本。
 *
 * 产出次序照真端点观察到的序列：**思考 → 正文 → 工具调用 → 用量 → 收束**；
 * 给了 `error` 则以 `model.error` **终结**（其后无 `model.call.end`——不变式 ④）。
 */
export type FauxTurn = {
  /** 思考通道（`model.delta` 的 `thinking`）。 */
  readonly thinking?: FauxText
  /** 正文通道（`model.delta` 的 `text`）。 */
  readonly text?: FauxText
  /** 本轮请求的工具调用（同段可多次）。 */
  readonly toolCalls?: readonly FauxToolCall[]
  /** 用量——缺省**不发** `model.usage`（未上报就不发，与真实现同）。 */
  readonly usage?: ModelUsage
  /** 错误分档（瞬时 / 超限 / 终态）——**终结本轮**。 */
  readonly error?: {
    readonly tier: ModelErrorTier
    readonly message: string
  }
}

/** 一段文本归一为增量序列——字符串即一条。 */
export function toPieces(text: FauxText | undefined): readonly string[] {
  if (text === undefined) return []
  return typeof text === 'string' ? [text] : text
}

/** 工具调用的参数序列化——与真接缝同形（JSON 文本片段）。 */
export function argsJsonOf(call: FauxToolCall): string {
  return JSON.stringify(call.args ?? {})
}
