/**
 * 配置加载 —— 装配视图第 1 步（技术方案 · 配置与密钥）。
 *
 * 读 `~/.magic/config.json`（形制**字面冻结**：`{ defaultProvider, providers{<id>{baseURL,
 * apiKey, model, traits?, contextWindow?}}, dataDir }`）→ 校验 → 落地成 `LoadedConfig`。
 *
 * **两处规矩落在这里**：
 * - **`dataDir` 前导 `~` 在加载时展开**（契约 `expandDataDir`）——记录域**不展开**且对 `~`
 *   即拒（`assertPlainDataDir`）。字面 `~` 直通运行时库会在 cwd 下造一个名为 `~` 的目录，
 *   不报错；故展开**必须发生在交给记录域之前**，本文件是那一步。
 * - **key 不在这里解析**——解析归模型域的装配面（`resolveApiKey` / `createModelGateway`
 *   构造期抛 `MissingApiKeyError` 即启动期报错），**装配根是它唯一的调用者**；
 *   次序＝显式 → 配置 `apiKey` → `MAGIC_<ID>_API_KEY`。本文件只把 `ProviderConfig`
 *   原样交出去——**key 文本不落日志、不入事件、不入记录**（技术方案 · 配置与密钥）。
 *
 * 报错取「一声响」而非静默兜底：配置文件缺失 / JSON 坏 / 字段缺**都在启动期抛**——
 * 与记录域拒收 `~` 同一条口径（能靠设计兜底的，别靠自觉）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { MagicConfig, ProviderConfig } from '@magic/contracts'
import { apiKeyEnvVarOf, CONFIG_FILE, DEFAULT_DATA_DIR, expandDataDir } from '@magic/contracts'

/** 配置加载失败——CLI 捕它、打印消息、退场（不带栈：这不是程序 bug，是配置的事）。 */
export class ConfigError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(path === '' ? message : `${message}（${path}）`)
    this.name = 'ConfigError'
    this.path = path
  }
}

/**
 * 加载结果——**已校验 ＋ 已展开**的配置，外加「用哪个供应商」的落地。
 *
 * `config.dataDir` 已是字面路径（可直接交记录域）；`provider` 是 `providers[defaultProvider]`。
 */
export type LoadedConfig = {
  /** 实际读的配置文件（已展开的绝对路径）——自检报告与报错都用它。 */
  readonly path: string
  /** 形制原样（`dataDir` 已展开）。 */
  readonly config: MagicConfig
  /** `defaultProvider` 的落地——也是环境变量回退名的来源。 */
  readonly providerId: string
  /** `providers[providerId]` 原样——含 `traits` 覆盖位（模型域按「键在即接管」裁定）。 */
  readonly provider: ProviderConfig
}

/** 加载入参——三项皆可注入（测试与入口复用同一函数，规则只写一遍）。 */
export type LoadConfigOptions = {
  /** 配置文件路径（可含前导 `~`）——缺省 `CONFIG_FILE`（`~/.magic/config.json`）。 */
  readonly path?: string
  /** 家目录——缺省 `os.homedir()`；契约层保持无依赖，故由调用方注入。 */
  readonly home?: string
}

/** 报错一律点名到字段（`path → providers.minimax.model`），省得用户对着整份 JSON 找。 */
function asObject(value: unknown, path: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(path, `${field} 须是对象`)
  }
  return value as Record<string, unknown>
}

function asText(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(path, `${field} 须是非空字符串`)
  }
  return value
}

/** `traits` 覆盖位——可选；形态照契约 `ModelTraits`（**键在即接管**，`{}` 是合法值）。 */
function asTraits(value: unknown, path: string, field: string): ProviderConfig['traits'] {
  const traits = asObject(value, path, field)
  const inline = traits['inlineThinking']
  if (inline === undefined) return {}

  const tag = asText(asObject(inline, path, `${field}.inlineThinking`)['tag'], path, `${field}.inlineThinking.tag`)
  return { inlineThinking: { tag } }
}

/**
 * `contextWindow` 覆盖位（D10 · 第 1 样）——**可选**；给了就须是正整数（token）。
 *
 * ⚠️ **漏带＝静默失效**（同下面权限段那条教训）：配置里写了窗长而这里不接，
 * 状态行的分母**永远不出现**，且不报错——故这一行有测试钉着，别顺手删。
 * 写坏了照旧**报错不降级**（窗长填错时宁可启动期一声响，也别拿一个假分母去画进度）。
 */
function asContextWindow(value: unknown, path: string, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(path, `${field} 须是正整数（token；缺省 / 不写＝不声明窗长）`)
  }
  return value
}

/** 一个供应商条目——`{ baseURL, apiKey?, model, traits?, contextWindow? }`。 */
function asProvider(value: unknown, path: string, field: string): ProviderConfig {
  const raw = asObject(value, path, field)
  const apiKey = raw['apiKey']

  if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw new ConfigError(path, `${field}.apiKey 须是字符串（缺省 / 空串 → 回退环境变量）`)
  }

  const contextWindow = asContextWindow(raw['contextWindow'], path, `${field}.contextWindow`)

  return {
    baseURL: asText(raw['baseURL'], path, `${field}.baseURL`),
    apiKey: apiKey as string | undefined,
    model: asText(raw['model'], path, `${field}.model`),
    ...(raw['traits'] === undefined ? {} : { traits: asTraits(raw['traits'], path, `${field}.traits`) }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
  }
}

/**
 * 读并校验配置文件。
 *
 * 形制字面冻结（技术方案 · 配置与密钥）——**`dataDir` 缺省**由加载器补 `DEFAULT_DATA_DIR`；
 * 其余键缺省即报错（首站形制里它们不是可选的）。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const home = options.home ?? homedir()
  const path = expandDataDir(options.path ?? CONFIG_FILE, home)

  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConfigError(
      path,
      `读不到配置文件——首站形制见 技术方案 · 配置与密钥（${reason}）`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConfigError(path, `配置不是合法 JSON（${reason}）`)
  }

  const raw = asObject(parsed, path, '配置根')

  const providerId = asText(raw['defaultProvider'], path, 'defaultProvider')

  const providersRaw = asObject(raw['providers'], path, 'providers')
  const providers: Record<string, ProviderConfig> = {}
  for (const [id, entry] of Object.entries(providersRaw)) {
    providers[id] = asProvider(entry, path, `providers.${id}`)
  }

  const provider = providers[providerId]
  if (provider === undefined) {
    const known = Object.keys(providers).join(' / ') || '（一个都没有）'
    throw new ConfigError(
      path,
      `defaultProvider「${providerId}」不在 providers 里——已配：${known}`,
    )
  }

  // 前导 `~` 在此展开（记录域拒收 `~`——见文件头注）
  const dataDir = expandDataDir(
    raw['dataDir'] === undefined ? DEFAULT_DATA_DIR : asText(raw['dataDir'], path, 'dataDir'),
    home,
  )

  // 权限段（阶段 2）：`rules` 的值**原样带过**——条目形态的权威是权限域的 `parseRules`
  // （连「整个值不是数组」都由它给缘由），故加载器**不在这里另做一套校验**，只把它递下去。
  // ⚠️ 漏带＝配置里写了规则而闸门一条也收不到——**静默失效**（U14 合入后第一次接线就踩过，
  // 由 app 的权限用例当场抓住）。故这一段有测试钉着，别顺手删。
  const permissions = raw['permissions'] === undefined
    ? undefined
    : asObject(raw['permissions'], path, 'permissions')

  return {
    path,
    config: {
      defaultProvider: providerId,
      providers,
      dataDir,
      ...(permissions === undefined ? {} : { permissions: { rules: permissions['rules'] } }),
    },
    providerId,
    provider,
  }
}

/**
 * 供自检报告用的一行话——**只说 key 的来处，不吐 key 本身**（key 永不落日志 / 事件 / 记录）。
 * 「来处」的判据与 `resolveApiKey` 同源：配置里非空即用配置，否则回退环境变量。
 */
export function describeConfig(loaded: LoadedConfig): string {
  const keyFrom = loaded.provider.apiKey?.trim()
    ? '配置文件'
    : `环境变量 ${apiKeyEnvVarOf(loaded.providerId)}`

  return (
    `配置 ${loaded.path} · 供应商 ${loaded.providerId}（${loaded.provider.model}）` +
    ` · key 取自${keyFrom} · 数据目录 ${loaded.config.dataDir}`
  )
}
