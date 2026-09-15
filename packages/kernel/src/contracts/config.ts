/**
 * 配置与密钥形制 —— **配置契约**（已冻结 · 字面冻结字段名）。
 *
 * 出处：技术方案 · 配置与密钥。
 * 配置文件 `~/.magic/config.json`；字段随阶段生长——**形制首站即立**。
 * **密钥纪律**——`apiKey` 存配置文件（提示 600 权限）或环境变量覆盖；**key 永不入记录 / 事件**。
 *
 * 本文件是**转写**：只落技术方案已冻结之形制，不加设计。
 */

/** 配置文件落点。 */
export const CONFIG_FILE = '~/.magic/config.json'

/** 数据目录默认值（`dataDir` 缺省时）——`records.db` + `blobs/` 落于此。 */
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
}

/**
 * 配置形制（首站 · 字面冻结）——`{ defaultProvider, providers, dataDir }`。
 * 权限规则 · 工作区根为阶段 2 / 3 加键。
 *
 * TODO(规划侧)：技术方案 :263 提到 providers 含「参数」而 :265 的字面冻结只列三字段；
 * 该键是否属首站形制未定——此处从其字面冻结（三字段）。
 */
export type MagicConfig = {
  readonly defaultProvider: string
  readonly providers: Readonly<Record<string, ProviderConfig>>
  readonly dataDir: string
}

/**
 * 密钥的环境变量回退名——`apiKey` 空 / 缺省时读 `MAGIC_<PROVIDER>_API_KEY`（ID 大写）。
 * 例：`providers.minimax` → `MAGIC_MINIMAX_API_KEY`。
 *
 * TODO(规划侧)：技术方案只写「ID 大写」——ID 含 `-` / `.` 等环境变量名非法字符时的
 * 处理（替换 / 拒绝）未定。
 */
export function apiKeyEnvVarOf(providerId: string): string {
  return `MAGIC_${providerId.toUpperCase()}_API_KEY`
}

/**
 * `dataDir` 解析规则——前导 `~` 在**加载时**展开为家目录；无 `~` 即字面路径。
 * 运行时库（`Bun.file` / `node:fs` / `bun:sqlite`）**不展开 `~`**——处理归配置加载器（U11）。
 */
