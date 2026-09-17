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
 * ⚠️ 用前须经 `expandDataDir`（下文）——字面 `~` 直接交给运行时库会静默落于 cwd。
 */
export const DEFAULT_DATA_DIR = '~/.magic'

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
   * 供应商改了行为的唯一出口）；配置非空则**整组覆盖**内置表的判定。
   * **空缺＝按常规行为处理**，不是「无特征」的断言。形态见 `ports.ts` · `ModelTraits`。
   */
  readonly traits?: ModelTraits
}

/**
 * 配置形制（首站 · 字面冻结）——`{ defaultProvider, providers, dataDir }`。
 * 权限规则 · 工作区根为阶段 2 / 3 加键；
 * **「参数」暂不入首站形制**——供应商差异封接缝（取件层常量），需要时按生长加键。
 */
export type MagicConfig = {
  readonly defaultProvider: string
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly dataDir: string
}

/**
 * 密钥的环境变量回退名——`apiKey` 空 / 缺省时读 `MAGIC_<PROVIDER>_API_KEY`：
 * ID 大写，**非字母数字字符映射为 `_`**——如 `my-vendor` → `MAGIC_MY_VENDOR_API_KEY`。
 */
export function apiKeyEnvVarOf(providerId: string): string {
  return `MAGIC_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

/**
 * 展开 `dataDir`——前导 `~` 在**加载时**展开为家目录；无 `~` 即字面路径。
 * 运行时库（`Bun.file` / `node:fs` / `bun:sqlite`）**不展开 `~`**（且写侧静默），故这一步须显式做。
 *
 * 家目录由调用方注入（配置加载器取 `node:os` 的 `homedir()`）——契约层保持无依赖。
 */
export function expandDataDir(raw: string, home: string): string {
  if (raw === '~') return home
  if (raw.startsWith('~/')) return home + raw.slice(1)
  return raw
}
