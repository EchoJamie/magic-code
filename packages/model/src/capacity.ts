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
 * **两处来处的归属也不同**（2026-09-20 裁 · 见 `WindowTable` 的注）：内置表按**准确模型 id**、
 * 与条目无关；`providers.<id>.contextWindow` 是**条目自己**的声明，**只对它那一条目且
 * 选中就是那条目的模型时**算数。
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
 * 用在**条目自己身上**（`ProviderEntry.contextWindow`）：`providers.<id>.contextWindow`
 * 给了就用它（本地端点 / 私有部署的真实窗长只有用户知道）；没给才查内置表
 * ——**用户不该为一个我们已知的客观数字去翻官方文档**。
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

/**
 * **窗长表**——给外壳的那张（U30）：内置表 ＋ 各条目**自己声明**的覆盖位，**分开装**。
 *
 * 为什么不是一个「模型名 → 窗长」的平表（第一版就是那么写的，被规划侧打回）——
 * **声明属于「条目 ＋ 模型」两件，不能按模型名全局生效**：合法的两个端点可以给
 * **同名模型**声明不同的窗长（本地部署量化过 / 网关另有一层裁法），平表会让甲条目的
 * 声明盖到乙条目头上（实测：`mm` 与 `mm2` 都挂 `MiniMax-M2`，`mm2` 声明 32,768 ⇒
 * 平表里 `MiniMax-M2` 一律成了 32,768，`mm` 那个官方 204,800 被顶掉）。
 * 内置表不同——它是**模型的客观属性**，按**准确的 model id** 算，与条目无关。
 *
 * 消费见 `windowOfSelection`（**一份判定**：条目对上就用它的声明，否则查内置表，
 * 两处皆无 ⇒ `null`）。外壳那侧另有一份同形的结构类型（它只依赖 `@magic/contracts`，
 * 认不得本域——靠结构类型在两处赋值点卡住形状）。
 */
export type WindowTable = {
  /** 内置表：**准确的 model id** → 窗长（任何条目下都算，与条目无关）。 */
  readonly builtin: Readonly<Record<string, number>>
  /**
   * 各条目**自己声明**的窗长：条目 id → `{ 它声明的模型, 那个数 }`。
   *
   * **只在上面的模型对上时才进这张表**——消费时还要按选中一起看（见 `windowOfSelection`）：
   * 选中不是这条目的模型（同条目换到别的模型）时，这份声明**不跟过去**。
   */
  readonly declared: Readonly<Record<string, { readonly model: string; readonly window: number }>>
}

/**
 * **一次选中的窗长**——外壳问的那一个（`provider ＋ model` ⇒ 窗长 ｜ `null`）。
 *
 * 次序与 `resolveContextWindow` **同一条**（声明 → 内置 → 未知），只是声明多了个归属条件：
 *
 * - 选中对得上某条目的声明（**条目 id 与模型名两件都对上**）⇒ 用它；
 * - 否则查内置表（按**准确的 model id**）；
 * - 两处皆无 ⇒ `null`——**不知道就是不知道**，不沿用别的条目/别的模型的容量，不编。
 *
 * `provider` 可缺（`model.call.start` 的供应商是可选位）：缺了就**只认内置表**
 * ——声明认不了主，不猜是哪一条目的。
 */
export function windowOfSelection(
  table: WindowTable,
  selection: { readonly provider?: string | undefined; readonly model: string },
): number | null {
  const declared = selection.provider === undefined ? undefined : table.declared[selection.provider]
  if (declared !== undefined && declared.model === selection.model) return declared.window

  return table.builtin[selection.model] ?? null
}
