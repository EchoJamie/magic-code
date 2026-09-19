/**
 * 共享语言 · 配置形制（已冻结 · 字面冻结字段名）。
 *
 * 出处：技术方案 · 配置与密钥。
 * 配置文件 `~/.magic/config.json`；字段随阶段生长——**形制首站即立**。
 * **密钥纪律**——`apiKey` 存配置文件（提示 600 权限）或环境变量覆盖；**key 永不入记录 / 事件**。
 *
 * 本文件是共享语言中**唯一带物的地方**——两个无依赖纯函数（规则载体）；其余皆类型。
 */

import type { ModelTraits } from './ports.ts'

/** 配置文件落点。 */
export const CONFIG_FILE = '~/.magic/config.json'

/**
 * 数据目录默认值（`dataDir` 键缺省时由加载器补）——`records.db` + `blobs/` 落于此。
 * ⚠️ 用前须经 `expandHome`（下文）——字面 `~` 直接交给运行时库会静默落于 cwd。
 */
export const DEFAULT_DATA_DIR = '~/.magic'

/**
 * **授权文件落点**（U22 · 技术方案 · 权限「授权的落点」）——内核**自持**的那一个文件。
 *
 * **为什么不写 `config.json`**：那是**用户手写**的（写回它要操心原子写 · 保留用户编辑 ·
 * 并发）；授权的写回只落在**一个内核全权持有的文件**上，那三件麻烦就都不成问题。
 *
 * **一个文件，不是一项目一文件**——安全相关的东西价值在**一眼看全**（能扫、能删）；
 * 散进几十个小文件的那一刻它就不再被审。**按工作区绝对路径分节**（见 `grants.catalog`）。
 *
 * ⚠️ 用前须经 `expandHome`（同 `DEFAULT_DATA_DIR`）——字面 `~` 直接交给运行时库
 * 会在 cwd 下造一个名为 `~` 的目录，且不报错。
 */
export const GRANTS_FILE = '~/.magic/grants.json'

/**
 * 供应商条目（`providers.<id>`——`<id>` 任意命名）。
 * 加供应商 / 同家多模型＝`providers` 加条目，形制不变。
 */
export type ProviderConfig = {
  readonly baseURL: string
  /** 空 / 缺省 → 回退环境变量（见 `apiKeyEnvVarOf`）；**永不入记录 / 事件**。 */
  readonly apiKey?: string
  readonly model: string
  /**
   * **模型特征标记的覆盖位**——内置表未覆盖的模型在此标注（表外模型 / 私有端点 /
   * 供应商改了行为的唯一出口）。
   * 判据「**键在即接管**」——本键存在即**整组覆盖**内置表（含 `{}` ＝显式声明无特征）；
   * 键缺省 → 常规行为（不猜、不切）。形态见 `ports.ts` · `ModelTraits`。
   */
  readonly traits?: ModelTraits
  /**
   * **上下文窗口总量**（token）——状态行 `12.4k/200k` 的**分母**（缺陷 D10 · 第 1 样）。
   *
   * **为什么键在这**——窗长是**供应商 / 模型元数据**，模型域自己算不出来（它只见消息，
   * 不见模型的规格）。两条真来处，本键是**当下唯一有实测来处的那条**：用户在此声明。
   * 另一条是模型域的内置表（按模型名，照 `traits` 的 `MODEL_TRAITS_BUILTIN` 之例）——
   * 该表**暂不落窗长**：没有对任何一家的窗长做过实测，**不编**（有来处再加，形状已留）。
   *
   * **缺省 ＝ 不给分母**——`model.usage` 上就没有 `contextWindow` 这个位，外壳显示不出
   * `12.4k/200k` 就不显示（拿不到就说拿不到，不拿假数占位）。
   *
   * **按条目声明**（不是按模型）：与 `traits` 同一姿势——一条目一个值。若同一条目下
   * 换到窗长不同的另一个模型（`model.switch { model }`），这个值不会自己跟着变；
   * 那时改这一行的值即可（或等内置表按模型名长出这一位）。
   */
  readonly contextWindow?: number
}

/**
 * 权限段——`permissions.rules`（阶段 2 加键 · 技术方案 · 配置与密钥 · 权限「规则化」）。
 *
 * **条目形态的权威在权限域**——`@magic/permission` 的 `parseRules` 是唯一的解析器
 * （形态见其 `PermissionRule`：工具 × 路径模式 × 操作类型 → 允许）。**解析从严**：
 * 读不懂的条目**逐个拒收、连同缘由交回装配**（静默丢弃会让人对着一条不生效的规则发呆）。
 *
 * 故本契约只认「**这个键在哪**」，条目长什么样不在这里复述一遍——两处各写一份形态，
 * 迟早分叉成「配置认一种、解析器认另一种」。取值交 `parseRules`：它连「整个值不是数组」
 * 这种情形都要给出缘由，所以此处取**原值**。
 *
 * **键缺省 ＝ 无规则 ＝ 一律问**（阶段 1 姿态）——故不接线也能跑；**必闸禁区照旧凌驾其上**。
 */
export type PermissionsConfig = {
  readonly rules?: unknown
}

/**
 * 工作区根列表（**阶段 3 加键** · 技术方案 · 执行 · 工作区）。
 *
 * **平等平铺 ＋ 一个默认**——**默认根＝列表第一项**（相对路径与新文件落它）；
 * 不引入「主根」概念（多一个概念就多一处解释）。单根＝一项的特例。
 *
 * **判据「键在即接管」**（照 `traits` 的先例）——本键存在即**整组接管**工作区根注册，
 * **不再并入启动目录**；键缺省 → 装配根回落**启动目录**（阶段 1 的行为原样：
 * 「阶段 1：启动目录＝默认根（唯一）」）。两义不可混：接管就是接管，
 * 一边声明三根、一边又悄悄把启动目录塞进去，注册的东西就没人说得清了。
 *
 * **校验分两层，两层都不降级**（技术方案 · 执行：「根是绝对路径——加载时校验」）：
 * - **形制**（须是非空字符串的数组）归**配置加载器**——那是 JSON 的事；
 * - **语义**（绝对 / 存在 / 是目录 / 重复）归**执行域** `createWorkspaceService`——
 *   那要碰 fs，且**根的身份**（`realpath` 之后的规范形）只有它说了算。
 *   一个真源；加载器不另判一遍，免得两处各说一套「什么算合格的根」。
 */
export type WorkspaceRoots = readonly string[]

/**
 * 配置形制（首站 · 字面冻结）——`{ defaultProvider, providers, dataDir }`；
 * **阶段 2 加键 `permissions`**；**阶段 3 加键 `workspaceRoots`**。
 * **「参数」暂不入首站形制**——供应商差异封接缝（取件层常量），需要时按生长加键。
 */
export type MagicConfig = {
  readonly defaultProvider: string
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly dataDir: string
  /** 权限段（阶段 2）——见 `PermissionsConfig`。 */
  readonly permissions?: PermissionsConfig
  /** 工作区根列表（阶段 3）——见 `WorkspaceRoots`；**键缺省＝启动目录单根**。 */
  readonly workspaceRoots?: WorkspaceRoots
}

/**
 * 密钥的环境变量回退名——`apiKey` 空 / 缺省时读 `MAGIC_<PROVIDER>_API_KEY`：
 * ID 大写，**非字母数字字符映射为 `_`**——如 `my-vendor` → `MAGIC_MY_VENDOR_API_KEY`。
 */
export function apiKeyEnvVarOf(providerId: string): string {
  return `MAGIC_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

/**
 * **前导 `~` 展开**（家目录）——在**加载时**展开；无 `~` 即字面路径。
 * 运行时库（`Bun.file` / `node:fs` / `bun:sqlite`）**不展开 `~`**（且写侧静默），故这一步须显式做。
 *
 * 家目录由调用方注入（配置加载器取 `node:os` 的 `homedir()`）——契约层保持无依赖。
 *
 * **名字是 `expandHome`，不是 `expandDataDir`**（U28 改名）：射程从一开始就是「前导 `~`
 * 展开」这件事本身，而用它的**不止 `dataDir`**——工作区根（U27）与授权文件落点
 * （`GRANTS_FILE`，U22）走的是**同一个**展开器（「一处展开，四处同理」）。
 * 旧名是它的出身（最早只为 `dataDir` 写），留着会让读的人以为「这函数只管数据目录」，
 * 于是别处再写一套更宽的规则——**名字与射程错位**，迟早分叉（`U27` 备案 1）。
 */
export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return home + raw.slice(1)
  return raw
}
