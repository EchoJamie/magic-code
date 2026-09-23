/**
 * 共享语言 · 模型与供应商（U41）——**连接与模型资料的形态 ＋ 缓存端口**。
 *
 * 出处：设计 · 模型与上下文（「模型信息获取与缓存」「令牌规格、实际用量与容量消费」
 * 「技术实现方案 · 数据与持久化」）· 设计 · 命令行与配置（「供应商连接与默认模型」）。
 *
 * 一句话的立场：**供应商接口是模型信息的来源，本地保存的是可更新缓存，不是一份独立于
 * 供应商的权威目录**。「目录」只作列表呈现的说法，不在此另立业务对象。
 *
 * 本文件只管**形态与端口**：
 * - 连接的形制在 `config.ts`（`ProviderConfig`）；这里给**读面**（缓存读出来的那几格）；
 * - 供应商适配（认证 · 官方地址 · 列表/详情 API · 字段归一 · 调用协议 · 令牌口径）
 *   是**模型域内部的端口与实现**，不上公开面（见 `@magic/model`）；
 * - 缓存**持久化**只走 `ModelInfoCache` 端口，实现归装配（域不碰文件系统）。
 *
 * ⚠️ **key 永不入这里**：本文件的每一个字段都可能上事件面或落进缓存文件——
 * 凭据、完整请求头、对话正文一律不在其中。
 */

import type { ModelTraits } from './ports.ts'

// —— 引用 ——

/**
 * 模型引用——**连接 id ＋ 精确模型 id** 两件一起。
 *
 * ⚠️ 凡是「哪一条连接」的地方一律带 id（`providers` 的键，不是供应商品牌名）：
 * 「同一家可以有两条连接」（个人号 / 团队号 · 两个区域）是设计里明写的前提，
 * 按供应商名去认会串在一起。
 *
 * 设计原文：「实际选择键是"连接 id ＋ 精确模型 id"，不是只有供应商名」。
 * 两件缺一不可：合法的两条连接可以各有一个**同名**模型（区域不同 / 端点不同），
 * 只有模型名认不出是谁。
 */
export type ModelRef = {
  readonly provider: string
  /** **供应商原始 id 原样**——查询与调用送出去的就是它。 */
  readonly model: string
}

// —— 模型信息 ——

/**
 * 令牌规格——**三种可选值**（设计 · 模型与上下文「规格与参数」）。
 *
 * 三种各表一件事，**不许互相推**：
 * - `maxInputTokens`——**独立**输入上限（不机械减去输出上限）；
 * - `maxOutputTokens`——输出上限；
 * - `maxContextTokens`——输入输出**合用**上限（联合窗口）。
 *
 * 供应商只给前两种时**不相加猜出第三种**；零 / 非法规格不当作无限大或有效容量——
 * 读不懂就**不给这一位**（未知）。
 */
export type ModelLimits = {
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly maxContextTokens?: number
}

/**
 * 模型能力——**未知 ＝ 不给这一位**。
 *
 * 设计原文：「信息未知不冒充"不支持"，默认参数仍可调用时不因缺描述而拒绝；
 * 明确不支持当前必需能力时说明原因」。故这里是**三态**（`true` / `false` / 缺省＝未知），
 * 不是布尔默认值。
 */
export type ModelCapabilities = {
  /**
   * 适用于**对话调用**——`false` ＝明确只支持嵌入 / 音频等其它用途，选择器不混入它。
   *
   * 判断依据**只能**是 API 或有依据的供应商适配（设计：「不以型号前缀猜」）。
   */
  readonly chat?: boolean
}

/**
 * 思考设置的形态——四支（设计 · 模型与上下文「思考能力与供应商适配」）：
 *
 * - `default`——**模型默认**（不发送任何思考参数，让服务端自己定）；
 * - `off`——**明确关闭**（与 `default` 不是一回事：那是「说了别想」）；
 * - `level`——**指定档位**（值来自该模型的 `ReasoningSupport.levels`）；
 * - `budget`——**指定 token 预算**（范围来自 `ReasoningSupport.budget`）。
 *
 * 档位值**不设通用词表**（不假设所有模型都有同一套低/中/高）；未声明支持就不能发送
 * 假参数。思考强度既不是最大输出长度，也不是输出里有多少思考文字。
 */
export type ReasoningSetting =
  | { readonly mode: 'default' }
  | { readonly mode: 'off' }
  | { readonly mode: 'level'; readonly level: string }
  | { readonly mode: 'budget'; readonly budgetTokens: number }

/**
 * 某模型支持的思考形态——**能力描述只指导校验，不证明服务端已经采用参数**
 * （实际请求与服务端结果仍要验）。
 */
export type ReasoningSupport = {
  /** 支持的档位值（**不假设同一套低/中/高**）。 */
  readonly levels?: readonly string[]
  /** 支持的预算范围（token）；只给一头也是合法的。 */
  readonly budget?: {
    readonly minTokens?: number
    readonly maxTokens?: number
  }
  /** 支持**明确关闭**。 */
  readonly disable?: boolean
}

/**
 * 一个模型的信息——**归一之后**的形态（供应商原始 JSON 不出适配器）。
 *
 * 缺字段与「不支持」是两件事：未返回的字段保持**未知**（不给这一位），
 * `null` / 缺省**不转换成零或"不支持"**。
 *
 * 模型名称与描述**只用于资料呈现**，不成为系统指令。
 */
export type ModelInfo = {
  /** 供应商原始 id **原样保留**（大小写与符号都不动——它就是调用时要送的那个名字）。 */
  readonly id: string
  /** 显示名——资料呈现用；缺省＝用 `id`。 */
  readonly name?: string
  readonly description?: string
  readonly capabilities?: ModelCapabilities
  readonly limits?: ModelLimits
  /** 该模型支持的思考形态——没有依据时不给这一位。 */
  readonly reasoning?: ReasoningSupport
  /**
   * **正文与思考的通道特征**——决定归一要不要把内嵌的 `<think>…</think>` 切到
   * `thinking` 通道（形态与判据见 `ports.ts` · `ModelTraits`，「**键在即接管**」）。
   *
   * 它随模型信息一起走（由供应商适配按**该家 + 精确型号**补，或按该模型的用户覆盖给），
   * 而不是按裸型号名在域里查一张跨供应商的表——这正是 U41 要撤的那件事。
   * 缺省 ＝ 无依据：正文原样走 `text`，**不猜、不切**。
   */
  readonly traits?: ModelTraits
}

// —— 快照与读取 ——

/**
 * 模型信息快照——某连接在某个**接入范围**下成功取得的完整列表。
 *
 * 一致性边界：**分页全部成功之后才替换**——重复游标或中途失败不提交半份快照。
 */
export type ModelInfoSnapshot = {
  readonly provider: string
  /**
   * **接入范围标识**——供应商适配 ＋ 官方区域/端点 ＋ 账号/项目范围。
   *
   * 它的用处只有一个但很硬：**范围一变，旧快照作废**，迟到的结果不得重新发布为当前信息
   * （设计：「认证或接入范围改变时废弃该连接的旧缓存及在途获取」）。
   *
   * ⚠️ **不含密钥**：不用密钥或密钥摘要作标识（设计明文），也不作文件名。
   */
  readonly scope: string
  /** 这次**成功**获取的时刻（epoch 毫秒）。失败不伪造新的值。 */
  readonly fetchedAt: number
  /** 本次完整列表（空数组是合法读数——「供应商名下确实一个模型都没有」）。 */
  readonly models: readonly ModelInfo[]
}

/** 一次获取的失败——**不伪造新的 `fetchedAt`**，也不清空旧缓存。 */
export type ModelFetchFailure = {
  /** 失败时刻（epoch 毫秒）。 */
  readonly at: number
  /** **说给人听**的一句话（脱敏：错误文案里不许出现 key）。 */
  readonly reason: string
}

/**
 * 一次读取的结果——缓存读面的**那几格**（`model.catalog` 的一行里带它）。
 *
 * 「有没有缓存」与「刷不刷得动」是两件事，故分成四个可选位而不是一个状态词：
 * 有旧缓存而这次刷失败时，用户要同时看到「还能用」与「刚才没刷成」。
 */
export type ModelInfoRead = {
  /**
   * 最后一次**成功**的快照——从未成功过＝不给这一位。
   *
   * ⚠️ **不拿空列表冒充「供应商没有模型」**：没有快照时如实显示未获取
   * （设计 · 模型与上下文「失败」那一条）。
   */
  readonly snapshot?: ModelInfoSnapshot
  /** 快照已过有效期（默认 24 小时）。**没有快照时不给这一位**（无从谈起）。 */
  readonly stale?: boolean
  /** 这次读取时**正在后台获取**（在途共享：同一连接同一进程只跑一趟）。 */
  readonly refreshing?: boolean
  /** 最近一次获取失败——成功过后仍可带着（「有旧缓存，但这次没刷动」）。 */
  readonly failure?: ModelFetchFailure
}

/**
 * 模型信息缓存端口——**模型域只经它读取/替换**。
 *
 * 实现归装配：`<dataDir>/cache/models/` 下按连接一份文件（安全编码文件名 · 仅本用户读写 ·
 * 临时文件后原子替换）。缓存**可删除重建**，不是会话事实、任务记忆或材料版本系统——
 * 故这里没有版本号、迁移账或对照表。
 */
export interface ModelInfoCache {
  /** 读某连接的最后成功快照——没有 / 读不出（损坏）＝`undefined`（丢弃重取即可）。 */
  read(provider: string): Promise<ModelInfoSnapshot | undefined>
  /**
   * 整份替换。
   *
   * ⚠️ **旧范围的晚到写入必须被拒绝**（设计明文）——同一进程里两次在途获取交错时，
   * 先发起、后到达的那一份不得盖掉范围已变之后的新结果。判定归实现：
   * 已存快照的 `scope` 与本次不同且更新时，丢弃本次写入。
   */
  replace(snapshot: ModelInfoSnapshot): Promise<void>
  /** 废弃某连接的快照——连接移除 / 接入范围变更时（文件不存在不是错）。 */
  drop(provider: string): Promise<void>
}

// —— 设置面（配置里的覆盖位）——

/**
 * 按**精确模型 id** 的一条覆盖——用户对该连接与那个模型的明确声明。
 *
 * 优先级最高的一档（设计：「用户对该连接与精确模型的明确覆盖 → 供应商 API 当前有效信息
 * → 该供应商有官方依据的缺项补充 → 未知」）。
 *
 * ⚠️ **不覆盖供应商原始缓存**——覆盖与原始信息**分开存**（不改写缓存来伪装供应商声明）。
 */
export type ProviderModelOverride = {
  /** 令牌规格覆盖——只覆盖给出的那几位。 */
  readonly limits?: ModelLimits
  /**
   * 模型特征标记覆盖（旧字段 `traits` 的新落点）——判据仍是「**键在即接管**」
   * （含 `{}` ＝显式声明无特征）。形态见 `ports.ts` · `ModelTraits`。
   */
  readonly traits?: ModelTraits
  /** 该模型的思考设置覆盖——合法值由模型能力给出。 */
  readonly reasoning?: ReasoningSetting
}
