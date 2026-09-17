/**
 * 模型特征标记 —— 生效判定（技术方案 · 模型策略 · 模型特征标记）。
 *
 * 常规模型的思考走**独立通道**（供应商字段 / SDK 已归一）；**内嵌在正文里**
 * （`<think>…</think>` 标签）是**少数模型的行为**，不当通例处理——无条件切分＝对正常模型的
 * 无谓改写。故两件定「生效标记」，归一据它决定是否切：
 *
 * ① **内置表**——模型域持有，按**模型名**匹配（首站一条：`MiniMax-M3`）。
 *    出厂即对、随代码版本升级——新模型不必等用户先知道它的怪癖（R1 / R2 / 准则 3）。
 * ② **覆盖位**——`providers.<id>.traits`（共享语言 · 配置形制）：**表外模型**（本地 / 私有端点 /
 *    供应商改了行为）的唯一出口；配置**非空则整组覆盖**内置表的判定。
 * ③ **皆未命中** → 按常规行为处理：正文原样走 `text`，**不猜、不切**。
 *
 * `ModelTraits` 的形态在 `@magic/contracts`（端口内类型）——**内置表不入契约**（模型域持有）。
 */

import type { ModelTraits } from '@magic/contracts'

/**
 * 内置表——按**模型名**匹配（不是供应商 id：同一家可挂多个模型，怪癖跟着模型走）。
 *
 * 生长方向（技术方案：「标记集合随用生长」）：是否支持工具调用 / 上下文窗等；
 * 首站只落「内嵌思考」一条。
 */
export const MODEL_TRAITS_BUILTIN: Readonly<Record<string, ModelTraits>> = {
  // 真端点实测（2026-09-16）：MiniMax-M3 经 OpenAI 兼容端点**不回** `reasoning_content`，
  // 而是把思考写在 `content` 里、用 `<think>…</think>` 包住。
  'MiniMax-M3': { inlineThinking: { tag: 'think' } },
}

/**
 * 生效标记——**查表 → 配置有则接管**（技术方案 · 模型策略 · 端口内类型）。
 *
 * 判据＝「**键在即接管**」：`traits` **存在就整组覆盖**（含 `{}` ＝**显式声明无特征**）。
 * 理由（锚定原文）——一条规则胜过一个二级判据，且**内置表判错时用户关得掉**：
 * 若 `{}` 回落内置表，错的模型就没有出口。
 *
 * 两处皆无（`undefined`）→ 返回 `undefined`，调用方走常规行为（不猜、不切）。
 */
export function resolveModelTraits(
  model: string,
  override?: ModelTraits | undefined,
): ModelTraits | undefined {
  if (override !== undefined) return override
  return MODEL_TRAITS_BUILTIN[model]
}
