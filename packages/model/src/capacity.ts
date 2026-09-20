/**
 * 模型容量（上下文窗总量）——**内置表** ＋ 覆盖判定（U30）。
 *
 * 与 `traits.ts` 的 `MODEL_TRAITS_BUILTIN` **同族**：按**模型名**匹配 · 模型域持有 ·
 * 「我们的知识，别推给用户」——窗长是模型的**客观属性**，不是用户该在配置里补的东西
 * （`进度台账` 2026-09-20 裁；`providers.<id>.contextWindow` 那条注里留的位正是这一条）。
 *
 * **与 `traits` 的两处不同**（别混）：
 * - **覆盖判据不同**：`traits` 是「键在即接管」（含 `{}` ＝显式声明无特征）；容量是**数字**，
 *   声明了就用声明的数（没有「显式声明未知」这一形——配置校验只收正整数）。
 * - **用途不同**：`traits` 管**怎么切正文**（行为）；容量管**读数**（状态行 `12.4k/200k` 的分母）。
 *
 * **只收有官方出处可核验的准确模型标识与容量**（U30 的已定行为）：**逐行精确 id**，
 * 不做前缀 / 家族匹配，不拿别名凑数；查不到就是查不到（分母 `null`），**不编**。
 *
 * ## 来处（2026-09-20 核）
 *
 * MiniMax 开放平台的模型表（单位 **token**）：
 * - https://platform.minimax.io/docs/guides/text-generation
 * - 同表亦见 https://platform.minimaxi.com/docs/guides/text-generation （首站端点的平台）
 *
 * 表里 `M2-her` 一行写的是「64 K」——**单位不肯定**（64 × 1024 还是 64 × 1000 无从判），
 * 故**不收**：宁可让它落到「未知 ⇒ 分母 `null`」，也不拿一个自己都说不准的数上屏。
 */

/**
 * 内置表——**模型名 → 上下文窗总量**（token）。
 *
 * 键是**模型标识原样**（大小写敏感：`MiniMax-M2` 与 `minimax-m2` 不是同一个键）——
 * 与真跑时请求里送出去的模型名逐字对齐；匹配不上的走「未知」。
 *
 * 生长方向：新模型 / 新供应商随用加行（同 `MODEL_TRAITS_BUILTIN`），**出厂即对**——
 * 用户不必先知道某个模型能装多少才用得上分母。
 */
export const MODEL_CONTEXT_BUILTIN: Readonly<Record<string, number>> = {
  // 旗舰（2026-09-20 官方表）：1,000,000 token 上下文
  'MiniMax-M3': 1_000_000,
  // M2 及同家变体——官方表**逐行**都给 204,800（变体是精确 id，不是家族匹配）
  'MiniMax-M2.7': 204_800,
  'MiniMax-M2.7-highspeed': 204_800,
  'MiniMax-M2.5': 204_800,
  'MiniMax-M2.5-highspeed': 204_800,
  'MiniMax-M2.1': 204_800,
  'MiniMax-M2.1-highspeed': 204_800,
  'MiniMax-M2': 204_800,
}

/**
 * 生效容量——**声明 → 内置表 → 未知**（两处皆无 ⇒ `undefined`）。
 *
 * 判据＝「**用户已明确配置的保持覆盖能力**」（U30 已定行为）：`providers.<id>.contextWindow`
 * 给了就用它（本地端点 / 私有部署的真实窗长只有用户知道，模型名可能撞上表里的同名条目）；
 * 没给才查内置表——**用户不该为一个我们已知的客观数字去翻官方文档**。
 *
 * 返回 `undefined` ＝**不知道**（不是 0、也不是某个惯例值）：调用方据此**不给分母**
 * （外壳只报已用量），**不编一个数顶上**。
 */
export function resolveContextWindow(
  model: string,
  override?: number | undefined,
): number | undefined {
  if (override !== undefined) return override
  return MODEL_CONTEXT_BUILTIN[model]
}
