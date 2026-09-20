/**
 * 配置加载 —— 装配视图第 1 步（技术方案 · 配置与密钥）。
 *
 * 读 `~/.magic/config.json`（形制**字面冻结**：`{ defaultProvider, providers{<id>{baseURL,
 * apiKey, model, traits?, contextWindow?}}, dataDir }`）→ 校验 → 落地成 `LoadedConfig`。
 *
 * **两处规矩落在这里**：
 * - **`dataDir` 前导 `~` 在加载时展开**（契约 `expandHome`）——记录域**不展开**且对 `~`
 *   即拒（`assertPlainDataDir`）。字面 `~` 直通运行时库会在 cwd 下造一个名为 `~` 的目录，
 *   不报错；故展开**必须发生在交给记录域之前**，本文件是那一步。
 *   **工作区根同此**（U27）——同一个展开器、同一个落点（见 `asWorkspaceRoots` 头注）。
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
import type { MagicConfig, McpConfig, McpServerConfig, ProviderConfig } from '@magic/contracts'
import {
  apiKeyEnvVarOf,
  CONFIG_FILE,
  DEFAULT_DATA_DIR,
  expandHome,
  MCP_NAME_SEPARATOR,
} from '@magic/contracts'

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
 * 工作区根列表（阶段 3 加键）——判形制（须是非空字符串的数组）＋ **展开前导 `~`**。
 *
 * **语义（绝对 / 存在 / 是目录 / 重复）不在这里判**：那要碰 fs，且**根的身份**
 * （`realpath` 之后的规范形）只有执行域说了算——加载器再判一遍就是两处各说一套
 * 「什么算合格的根」（见契约 `WorkspaceRoots`）。报错不降级这条两边都在守：
 * 此处抛「形制不对」、执行域抛「第 N 条不合格」，都在启动期、都不静默放行。
 *
 * ⚠️ **形制那半里，「是不是绝对路径」这一条也不在这里判**——`~/work` 展开之后是绝对的，
 * 而展开后仍非绝对者（`relative/nope`）照旧交给执行域拒（`workspace.test.ts` 有相对的用例）。
 * 分工没变：此处只把用户写的那串**变成它指的那个路径**。
 *
 * **`~` 展开（U27 · `U18` 待决 3）**——**与 `dataDir` 同源：同一个展开器**
 * （契约 `expandHome`——它原先叫 `expandDataDir`，射程却一直是「前导 `~` 展开」
 * 这件事本身：`dataDir` 与工作区根共用它，U28 按射程改了名）。
 * 由头：根是**用户手写在配置文件里**的路径——手写就会写 `~/work`，而当相对路径拒只会
 * 让人困惑。落点也照 `dataDir`：**加载器展开、加载后即为字面路径**（执行域不展开，
 * 「`~` 不是绝对路径」那条规矩没动）。
 */
function asWorkspaceRoots(value: unknown, path: string, home: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(
      path,
      'workspaceRoots 须是数组（工作区根列表：[<绝对路径>, …]；第一项＝默认根）',
    )
  }

  return value.map((entry, index) =>
    expandHome(asText(entry, path, `workspaceRoots[${index}]`), home),
  )
}

/**
 * 项目规约的一处名册（阶段 3 · U32）——判形制（须是非空字符串的数组）＋ **展开前导 `~`**。
 *
 * 与 `workspaceRoots` 同一个姿势、同一个展开器：**只把用户写的那串变成它指的那个路径**。
 * 「存不存在 / 是文件还是目录」不在这里判——那要碰 fs，而归执行域（规约来源面）；
 * 加载器再判一遍就是两处各说一套「什么算合格的来源」。
 *
 * **`sources`（读进来）与 `linkSources`（放行链接）走同一个函数**：形制一模一样，
 * 差别在**语义**（归执行域），不在加载期（见契约 `RulesConfig` 那段注）。
 *
 * 不给（键缺省 / `rules` 整段缺省）＝那一处一个都没有——行为与不写这个键之前一字不变。
 */
function asRuleSources(
  value: unknown,
  path: string,
  home: string,
  book: 'sources' | 'linkSources',
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(
      path,
      `rules.${book} 须是数组（[<绝对路径>, …]；文件或目录都行）`,
    )
  }

  return value.map((entry, index) =>
    expandHome(asText(entry, path, `rules.${book}[${index}]`), home),
  )
}

/**
 * 外部工具服务器名的一条硬规矩——**不许含 `__`、且要是能当工具名使的一串**。
 *
 * 两件都由头：
 * - `__` 是**工具名的分隔符**（`mcp__<服务器>__<工具>`，契约 `MCP_NAME_SEPARATOR`）：
 *   服务器名里再出现它，工具名就切不回唯一的一种解释；
 * - 名字要拼进**送给模型的工具名**——各家供应商对函数名的字符集都有限制，
 *   在这儿挡住比让第一条请求在供应商那儿失败强（那时的错在对面，用户读不懂）。
 *
 * 口径：**字母数字开头，其后只许字母数字与 `._-`**。写错照旧报错不降级——
 * 名字是身份，改了名字就会换一批工具名（记录里的旧名从此对不上），不能悄悄替用户改。
 */
const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 一个外部服务器条目——`{ command, args?, env? }`（形制见契约 `McpServerConfig`）。 */
function asMcpServer(value: unknown, path: string, name: string): McpServerConfig {
  const field = `mcp.servers.${name}`
  const raw = asObject(value, path, field)

  const args = raw['args']
  if (args !== undefined && (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string'))) {
    throw new ConfigError(path, `${field}.args 须是字符串数组（命令行参数）`)
  }

  const env = raw['env']
  if (env !== undefined) {
    const entries = asObject(env, path, `${field}.env`)
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry !== 'string') {
        throw new ConfigError(path, `${field}.env.${key} 须是字符串（环境变量值）`)
      }
    }
  }

  return {
    command: asText(raw['command'], path, `${field}.command`),
    ...(args === undefined ? {} : { args: args as readonly string[] }),
    ...(env === undefined ? {} : { env: env as Readonly<Record<string, string>> }),
  }
}

/**
 * `mcp` 段 —— **用户显式配置的外部工具服务器**（U38）。
 *
 * ⚠️ **形制在这儿判、语义（连得上连不上）在适配置那一趟**：这一层只答「写对了没有」——
 * 命令非空 · 名字合规矩 · 参数与环境是字符串。**不做任何事**：不探测可执行文件、不试连、
 * 更不跑它（配置里写着 ≠ 获准运行，那条边界的落点就在这一层与装配之间）。
 *
 * 段缺省 / `servers` 缺省 ＝ **一个外部服务器都没有**（内置工具照常）——不是错。
 */
function asMcpConfig(value: unknown, path: string): McpConfig {
  const raw = asObject(value, path, 'mcp')

  if (raw['servers'] === undefined) return { servers: {} }

  const serversRaw = asObject(raw['servers'], path, 'mcp.servers')
  const servers: Record<string, McpServerConfig> = {}

  for (const [name, entry] of Object.entries(serversRaw)) {
    if (!MCP_SERVER_NAME.test(name) || name.includes(MCP_NAME_SEPARATOR)) {
      throw new ConfigError(
        path,
        `mcp.servers 的条目名「${name}」不合规矩——须是字母数字开头、只含字母数字与 . _ - 的` +
          `一串（它会拼进工具名 ${'mcp__<名字>__<工具>'}，故不许含 ${MCP_NAME_SEPARATOR}、` +
          '也不许有空格与别的符号）',
      )
    }
    servers[name] = asMcpServer(entry, path, name)
  }

  return { servers }
}

/**
 * 读并校验配置文件。
 *
 * 形制字面冻结（技术方案 · 配置与密钥）——**`dataDir` 缺省**由加载器补 `DEFAULT_DATA_DIR`；
 * 其余键缺省即报错（首站形制里它们不是可选的）。
 *
 * **`workspaceRoots` 是唯一「缺省＝有效行为」的新键**——缺省 → 装配根回落启动目录
 * （阶段 1 姿态）；**键在即接管**（见契约 `WorkspaceRoots`：不再并入启动目录）。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const home = options.home ?? homedir()
  const path = expandHome(options.path ?? CONFIG_FILE, home)

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
  const dataDir = expandHome(
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

  // 工作区根列表（阶段 3）——形制与 `~` 展开在此判、语义归执行域（见 `asWorkspaceRoots` 头注）。
  // ⚠️ **漏带＝静默失效**（同上面权限段那条教训）：配置里写了多根而这里不接，
  // 工作区就悄悄退回启动目录单根——**且不报错**，用户对着一个少了一半的作用域发呆。
  const workspaceRoots = raw['workspaceRoots'] === undefined
    ? undefined
    : asWorkspaceRoots(raw['workspaceRoots'], path, home)

  // 项目规约段（阶段 3 · U32）——**用户显式点名的补充来源**。
  // ⚠️ **漏带＝静默失效**（同上面权限段与多根那两条教训）：配置里点了名而这里不接，
  // 那几份规约就悄悄读不进来——**且不报错**，用户对着一个「明明写了却没生效」的来源发呆。
  const rulesSegment = raw['rules'] === undefined ? undefined : asObject(raw['rules'], path, 'rules')
  const rulesBook = (
    book: 'sources' | 'linkSources',
  ): readonly string[] | undefined =>
    rulesSegment?.[book] === undefined ? undefined : asRuleSources(rulesSegment[book], path, home, book)
  const ruleSources = rulesBook('sources')
  const ruleLinkSources = rulesBook('linkSources')

  // 外部工具服务器（U38）——**只有配置里写了才连**（这是「用户显式配置」的唯一落点）。
  // ⚠️ **漏带＝静默失效**（同上面三条的教训）：配置里写了服务器而这里不接，
  // 外部工具一件都出不来、也不报错——用户对着「明明配了却没有」发呆。
  const mcp = raw['mcp'] === undefined ? undefined : asMcpConfig(raw['mcp'], path)

  return {
    path,
    config: {
      defaultProvider: providerId,
      providers,
      dataDir,
      ...(permissions === undefined ? {} : { permissions: { rules: permissions['rules'] } }),
      ...(workspaceRoots === undefined ? {} : { workspaceRoots }),
      ...(ruleSources === undefined && ruleLinkSources === undefined
        ? {}
        : {
            rules: {
              ...(ruleSources === undefined ? {} : { sources: ruleSources }),
              ...(ruleLinkSources === undefined ? {} : { linkSources: ruleLinkSources }),
            },
          }),
      ...(mcp === undefined ? {} : { mcp }),
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
