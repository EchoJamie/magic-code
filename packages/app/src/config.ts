import { isLogLevel } from '@magic/contracts'


import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { configStamp } from './cache-access.ts'
import { dirname, resolve } from 'node:path'
import type {
  AgentRoleConfig,
  MagicConfig,
  MagicHome,
  StatusLineConfig,
  StatusLineCell,
  MotionConfig,

  McpConfig,
  McpServerConfig,
  ModelLimits,
  ProviderConfig,
  ProviderModelOverride,
  ReasoningSetting,
  ReasoningSupport,
  ModelTraits,
  ModelChoice,
} from '@magic/contracts'
import {
  apiKeyEnvVarOf,
  CONFIG_FILE_NAME,
  expandHome,
  MAGIC_DIR,
  MCP_NAME_SEPARATOR,
  resolveMagicHome,
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


export type LoadedConfig = {
  /** 实际读的配置文件（已展开的绝对路径）——自检报告与报错都用它。 */
  readonly path: string
  /** 形制原样（`dataDir` 已展开）。 */
  readonly config: MagicConfig

  readonly providerId?: string
  /** `providers[providerId]` 原样——含 `traits` 覆盖位（模型域按「键在即接管」裁定）。 */
  readonly provider?: ProviderConfig
  /** 加载时的文件指纹；null 明确表示文件不存在。 */
  readonly stamp?: string | null


}

/** 加载入参——各件皆可注入（测试与入口复用同一函数，规则只写一遍）。 */
export type LoadConfigOptions = {
  /** 配置文件路径（可含前导 `~`）——缺省 `<基础目录>/config.json`。 */
  readonly path?: string
  /**
   * **统一基础路径**（契约 `MagicHome`：家目录 ＋ Magic 基础目录）。
   * 缺省按启动环境现解析（`MAGIC_HOME` → 家目录，其下追加 `.magic`）。
   *
   * 给这个口是为了**测试与脚本**能指一块自己的沙地（照 `path` 的先例）；
   * 产品路径上只有装配根调它一次，故这里是「拿到已解析的路径」，不另做一套解析。
   */
  readonly magic?: MagicHome | undefined
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
function asTraits(value: unknown, path: string, field: string): ModelTraits {
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

/** 可选文本位——写错了照旧报错，没写就不给这一位（不拿空串冒充「写过了」）。 */
function asOptionalText(value: unknown, path: string, field: string): string | undefined {
  return value === undefined ? undefined : asText(value, path, field)
}

/**
 * 思考设置（U41）——四支判别（`ReasoningSetting`）。
 *
 * 值本身**只判形制**（正整数 / 非空串）：「这个模型支不支持这一档」归模型域按能力判
 * （设计：能力描述只指导校验）——配置层没有能力表，不该在这儿猜。
 */
function asReasoning(value: unknown, path: string, field: string): ReasoningSetting {
  const raw = asObject(value, path, field)
  const mode = raw['mode']

  switch (mode) {
    case 'default':
    case 'off':
      return { mode }
    case 'level':
      return { mode, level: asText(raw['level'], path, `${field}.level`) }
    case 'budget': {
      const budget = raw['budgetTokens']
      if (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0) {
        throw new ConfigError(path, `${field}.budgetTokens 须是正整数（token）`)
      }
      return { mode, budgetTokens: budget }
    }
    default:
      throw new ConfigError(
        path,
        `${field}.mode 须是 default（模型默认）/ off（明确关闭）/ level（档位）/ budget（预算）之一`,
      )
  }
}

function asTextList(value: unknown, path: string, field: string): string[] {
  if (!Array.isArray(value)) throw new ConfigError(path, `${field} 须是字符串数组`)
  return value.map((one, index) => asText(one, path, `${field}[${index}]`))
}

function asReasoningSupport(value: unknown, path: string, field: string): ReasoningSupport {
  const raw = asObject(value, path, field)
  const levels = raw['levels'] === undefined ? undefined : asTextList(raw['levels'], path, `${field}.levels`)
  const disable = raw['disable']
  if (disable !== undefined && typeof disable !== 'boolean') {
    throw new ConfigError(path, `${field}.disable 须是布尔值`)
  }
  let budget: ReasoningSupport['budget']
  if (raw['budget'] !== undefined) {
    const given = asObject(raw['budget'], path, `${field}.budget`)
    const minTokens = asContextWindow(given['minTokens'], path, `${field}.budget.minTokens`)
    const maxTokens = asContextWindow(given['maxTokens'], path, `${field}.budget.maxTokens`)
    if (minTokens !== undefined && maxTokens !== undefined && minTokens > maxTokens) {
      throw new ConfigError(path, `${field}.budget 最小值不能大于最大值`)
    }
    budget = {
      ...(minTokens === undefined ? {} : { minTokens }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  }
  return {
    ...(levels === undefined ? {} : { levels }),
    ...(disable === undefined ? {} : { disable }),
    ...(budget === undefined ? {} : { budget }),
  }
}

/** 角色只存引用与约束；这里不读指导文件，也不启动技能或模型。 */
function asAgentRoles(
  value: unknown,
  path: string,
  home: string,
): Readonly<Record<string, AgentRoleConfig>> {
  const raw = asObject(value, path, 'agentRoles')
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
    asText(id, path, 'agentRoles 的角色 id')
    const field = `agentRoles.${id}`
    const role = asObject(value, path, field)
    const name = asText(role['name'], path, `${field}.name`)
    const instructions = asText(role['instructions'], path, `${field}.instructions`)
    const pick = (key: string) => role[key] === undefined ? undefined : asTextList(role[key], path, `${field}.${key}`)
    const guidanceFiles = pick('guidanceFiles')?.map((file) => resolve(dirname(path), expandHome(file, home)))
    const skills = pick('skills')
    const tools = pick('tools')
    let model: AgentRoleConfig['model']
    if (role['model'] !== undefined) {
      const given = asObject(role['model'], path, `${field}.model`)
      for (const key of Object.keys(given)) {
        if (!['choice', 'reasoning'].includes(key)) {
          throw new ConfigError(path, `${field}.model.${key} 不是模型配置字段`)
        }
      }
      const choice = given['choice'] === undefined ? undefined : asModelChoice(given['choice'], path, `${field}.model.choice`)
      const reasoning = given['reasoning'] === undefined ? undefined : asReasoning(given['reasoning'], path, `${field}.model.reasoning`)
      model = {
        ...(choice === undefined ? {} : { choice }),
        ...(reasoning === undefined ? {} : { reasoning }),
      }
    }
    for (const key of Object.keys(role)) {
      if (!['name', 'instructions', 'guidanceFiles', 'skills', 'tools', 'model'].includes(key)) {
        throw new ConfigError(path, `${field}.${key} 不是角色配置字段`)
      }
    }
    return [id, {
      name,
      instructions,
      ...(guidanceFiles === undefined ? {} : { guidanceFiles }),
      ...(skills === undefined ? {} : { skills }),
      ...(tools === undefined ? {} : { tools }),
      ...(model === undefined ? {} : { model }),
    }]
  }))
}

/** 令牌规格（可选三位）——判据同 `contextWindow`：给了就须是正整数。 */
function asLimits(value: unknown, path: string, field: string): ModelLimits {
  const raw = asObject(value, path, field)
  const pick = (key: keyof ModelLimits): number | undefined =>
    asContextWindow(raw[key], path, `${field}.${key}`)

  const maxInputTokens = pick('maxInputTokens')
  const maxOutputTokens = pick('maxOutputTokens')
  const maxContextTokens = pick('maxContextTokens')

  return {
    ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
  }
}

/**
 * 按精确模型 id 的规格与能力覆盖；思考设置归 Agent/角色。
 *
 * ⚠️ **漏带＝静默失效**（同权限段那几条教训）：配置里写了覆盖而这里不接，
 * 用户的明确声明就悄悄不起作用——且不报错。故这一行有测试钉着。
 */
function asModelOverrides(
  value: unknown,
  path: string,
  field: string,
): Readonly<Record<string, ProviderModelOverride>> {
  const raw = asObject(value, path, field)
  const overrides: Record<string, ProviderModelOverride> = Object.create(null)

  for (const [id, entry] of Object.entries(raw)) {
    const one = asObject(entry, path, `${field}.${id}`)
    if (Object.hasOwn(one, 'reasoning')) throw new ConfigError(path, `${field}.${id}.reasoning 已移除；思考设置请用于 Agent 或角色选择`)
    const limits = one['limits'] === undefined ? undefined : asLimits(one['limits'], path, `${field}.${id}.limits`)
    const traits = one['traits'] === undefined ? undefined : asTraits(one['traits'], path, `${field}.${id}.traits`)
    const reasoningSupport = one['reasoningSupport'] === undefined ? undefined : asReasoningSupport(one['reasoningSupport'], path, `${field}.${id}.reasoningSupport`)
    let capabilities: ProviderModelOverride['capabilities']
    if (one['capabilities'] !== undefined) {
      const given = asObject(one['capabilities'], path, `${field}.${id}.capabilities`)
      for (const key of Object.keys(given)) {
        if (!['chat', 'image'].includes(key) || typeof given[key] !== 'boolean') {
          throw new ConfigError(path, `${field}.${id}.capabilities.${key} 须是已知能力的布尔值`)
        }
      }
      capabilities = given as ProviderModelOverride['capabilities']
    }

    overrides[id] = {
      ...(limits === undefined ? {} : { limits }),
      ...(traits === undefined ? {} : { traits }),
      ...(reasoningSupport === undefined ? {} : { reasoningSupport }),
      ...(capabilities === undefined ? {} : { capabilities }),
    }
  }

  return overrides
}

/** 接入身份与精确型号规格；连接本身不保存模型或思考默认。 */
function asProvider(value: unknown, path: string, field: string): ProviderConfig {
  const raw = asObject(value, path, field)
  const apiKey = raw['apiKey']

  if (apiKey !== undefined && typeof apiKey !== 'string') {
    throw new ConfigError(path, `${field}.apiKey 须是字符串（缺省 / 空串 → 回退环境变量）`)
  }

  for (const key of ['model', 'reasoning', 'traits', 'contextWindow']) {
    if (Object.hasOwn(raw, key)) throw new ConfigError(path, `${field}.${key} 已移除；模型选择请配置 models，规格请配置 modelOverrides`)
  }
  const vendor = asText(raw['vendor'], path, `${field}.vendor`)
  const baseURL = asOptionalText(raw['baseURL'], path, `${field}.baseURL`)
  const name = asOptionalText(raw['name'], path, `${field}.name`)
  const region = asOptionalText(raw['region'], path, `${field}.region`)
  const modelOverrides =
    raw['modelOverrides'] === undefined
      ? undefined
      : asModelOverrides(raw['modelOverrides'], path, `${field}.modelOverrides`)

  return {
    ...(vendor === undefined ? {} : { vendor }),
    ...(name === undefined ? {} : { name }),
    ...(region === undefined ? {} : { region }),
    ...(baseURL === undefined ? {} : { baseURL }),
    apiKey: apiKey as string | undefined,
    ...(modelOverrides === undefined ? {} : { modelOverrides }),
  }
}

/**
 * **`dataDir` 的落地**（U42）——两步：**展开前导 `~`** ＋ **旧落点归位**。
 *
 * 归位那一步（设计明文：「指向原 `~/.magic` 及其子目录的 Magic 数据路径统一按下节基础路径
 * 解析，**不能因写在旧配置中而绕过 `MAGIC_HOME`**；指向其它目录的自定义数据路径保持原义」）：
 *
 * - `~/.magic` 本身 → **基础目录**（不设 `MAGIC_HOME` 时两者本就同一条，故这是零变化）；
 * - `~/.magic/data` 这类子路径 → 基础目录下**同样的相对位置**（`<基础目录>/data`）；
 * - **别处照旧**：`~/work` 还是用户家的 `work`、`/var/tmp/x` 还是那条绝对路径
 *   ——`MAGIC_HOME` 换的是 **Magic 自己的落点**，不是家目录（设计里与「不修改系统 HOME」
 *   同一条理由）。
 *
 * ⚠️ **判据是「展开之后落在旧 `.magic` 之下」，不是「字符串以 `~/.magic` 开头」**：
 * 拿字面串比对的话，`/Users/me/.magic` 这种**写全了的绝对路径**会从旁边溜过去——那正是
 * 「写死了就绕得过」的一种。子路径那一支比较时带上 `/`（`${old}/`），故 `~/.magicX`
 * 这类**同前缀的别的目录**不会被误伤。
 *
 * 只对 `dataDir` 做这一步：其余几处（工作区根 / 规约与技能的来源）点的是**用户的东西**，
 * 不是 Magic 的数据目录——给它们也套一层归位，等于把用户指到别处的路径悄悄改道。
 */
function asDataDir(raw: string, magic: MagicHome): string {
  const expanded = expandHome(raw, magic.home)
  const old = `${magic.home}/${MAGIC_DIR}`

  if (expanded === old) return magic.base
  if (!expanded.startsWith(`${old}/`)) return expanded

  // 分隔斜杠归一：`~/.magic/`（尾随）与 `~/.magic//data`（重复）都落成基础目录那一支的写法
  const tail = expanded.slice(old.length).replace(/^\/+/, '')
  return tail === '' ? magic.base : `${magic.base}/${tail}`
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
  /** 报错话里点名的那一串——`rules.sources` / `rules.linkSources` / `skills.sources`。 */
  label: string,
): readonly string[] {
  if (!Array.isArray(value)) {
    throw new ConfigError(path, `${label} 须是数组（[<绝对路径>, …]；文件或目录都行）`)
  }

  return value.map((entry, index) => expandHome(asText(entry, path, `${label}[${index}]`), home))
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

/**
 * 一个外部服务器条目——**两种接入共用一张表**（形制见契约 `McpServerConfig`）。
 *
 * 形制由**写了哪一位**分（`url` ／ `command`）：两位都给、都不给都当场报错——接入方式
 * 与条目名一样是**身份**，猜错一次就是接到另一台上去（不降级、不替用户挑一种）。
 *
 * ⚠️ **形制在这儿判、语义（连得上连不上）在适配置那一趟**：这一层只答「写对了没有」，
 * 不探测地址、不试连（配置里写着 ≠ 获准连：那条边界的落点在这一层与装配之间）。
 */
function asMcpServer(value: unknown, path: string, name: string): McpServerConfig {
  const field = `mcp.servers.${name}`
  const raw = asObject(value, path, field)

  if (raw['url'] !== undefined) return asMcpHttpServer(raw, path, field)

  if (raw['command'] === undefined) {
    throw new ConfigError(path, `${field} 里两样都没有——给 command（本地命令）或 url（HTTP 地址）`)
  }

  return asMcpStdioServer(raw, path, field)
}

/** stdio 那一支——`{ command, args?, env? }`。 */
function asMcpStdioServer(raw: Record<string, unknown>, path: string, field: string): McpServerConfig {
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
 * HTTP 那一支——`{ url, headers? }`（Streamable HTTP · U39）。
 *
 * `headers` 的值**是凭据**（`Authorization` 一类）：这一层只判它是字符串表，
 * 不读、不打印、不进任何读数（查询那一屏报的是名字，不是地址与头）。
 */
function asMcpHttpServer(raw: Record<string, unknown>, path: string, field: string): McpServerConfig {
  if (raw['command'] !== undefined) {
    throw new ConfigError(
      path,
      `${field} 里 command 与 url 都写了——一个条目只能是一种接入（url 走 HTTP，command 走本地运行）`,
    )
  }

  const url = asText(raw['url'], path, `${field}.url`)
  if (!URL.canParse(url)) {
    throw new ConfigError(path, `${field}.url 不是一条能用的地址（须是 http:// 或 https:// 开头的一串）`)
  }

  const headers = raw['headers']
  if (headers !== undefined) {
    const entries = asObject(headers, path, `${field}.headers`)
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry !== 'string') {
        throw new ConfigError(path, `${field}.headers.${key} 须是字符串（请求头的值）`)
      }
      // HTTP 头里放不下可见 ASCII 之外的字符（Bun 的 fetch 当场拒）。
      // ⚠️ **报错话里不许回显那个值**——`headers` 里的值是凭据；而运行时那条报错是带的
      // （实测：`Header 'Authorization' has invalid value: 'Bearer …'` 会原样进读数），
      // 故在这儿挡住，不去读它。「哨兵不出现在输出 / 事件 / 记录」这条防线有一半在这一行。
      if (!/^[ -~]*$/.test(entry)) {
        throw new ConfigError(
          path,
          `${field}.headers.${key} 里有 HTTP 头放不下的字符（须是可见 ASCII——中文一类要先编码）`,
        )
      }
    }
  }

  return { url, ...(headers === undefined ? {} : { headers: headers as Readonly<Record<string, string>> }) }
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


function asModelChoice(value: unknown, path: string, field: string): ModelChoice {
  if (typeof value !== 'string' || !['default', 'cantrip', 'spell', 'arcane'].includes(value)) {
    throw new ConfigError(path, `${field} 只能选择 default / cantrip / spell / arcane`)
  }
  return value as ModelChoice
}

function asModels(value: unknown, path: string, providers: MagicConfig['providers']): NonNullable<MagicConfig['models']> {
  const raw = asObject(value, path, 'models')
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    const choice = asModelChoice(key, path, `models.${key}`)
    const field = `models.${choice}`
    const item = asObject(value, path, field)
    for (const key of Object.keys(item)) if (!['provider', 'model'].includes(key)) throw new ConfigError(path, `${field}.${key} 不是模型映射字段`)
    const provider = asText(item['provider'], path, `${field}.provider`)
    const model = asText(item['model'], path, `${field}.model`)
    if (!Object.hasOwn(providers, provider)) throw new ConfigError(path, `${field}.provider 指向未知连接「${provider}」`)
    return [choice, { provider, model }]
  }))
}

/** 读取已保存的界面配置；缺省保持默认，坏值沿用配置加载错误出口。 */
function asStatusLine(value: unknown, path: string): StatusLineConfig {
  const raw = asObject(value, path, 'statusLine')
  const cells = raw['cells']
  if (!Array.isArray(cells) || cells.some(cell => !['session', 'model', 'reasoning', 'context', 'workspace'].includes(cell))) {
    throw new ConfigError(path, 'statusLine.cells 须是状态行字段数组')
  }
  if (raw['color'] !== undefined && typeof raw['color'] !== 'boolean') {
    throw new ConfigError(path, 'statusLine.color 须是布尔值')
  }
  return { cells: cells as StatusLineCell[], ...(raw['color'] === undefined ? {} : { color: raw['color'] as boolean }) }
}

function asMotion(value: unknown, path: string): MotionConfig {
  const raw = asObject(value, path, 'motion')
  if (raw['reduced'] !== undefined && typeof raw['reduced'] !== 'boolean') {
    throw new ConfigError(path, 'motion.reduced 须是布尔值')
  }
  return raw['reduced'] === undefined ? {} : { reduced: raw['reduced'] as boolean }
}

/**
 * 读并校验配置文件。
 *
 * 形制字面冻结（技术方案 · 配置与密钥）——**`dataDir` 缺省**由加载器补**基础目录**；
 * 其余键缺省即报错（首站形制里它们不是可选的）。
 *
 * **`workspaceRoots` 是唯一「缺省＝有效行为」的新键**——缺省 → 装配根回落启动目录
 * （阶段 1 姿态）；**键在即接管**（见契约 `WorkspaceRoots`：不再并入启动目录）。
 */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  // **统一基础路径在这一步解析**（U42）——读配置**之前**，且只在这里解析一次
  // （设计明文：app 在读取配置之前统一解析基础目录，各域只接收已解析路径）。
  const magic = options.magic ?? resolveMagicHome(process.env, homedir())
  /** 家目录——用户写的 `~/…` 展开到它（**不是**基础目录：`MAGIC_HOME` 不改写系统家目录）。 */
  const home = magic.home
  const path = expandHome(options.path ?? `${magic.base}/${CONFIG_FILE_NAME}`, home)

  const stamp = configStamp(path)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    // **文件不在 ≠ 配置坏**（U41）：首次运行就是这样——照旧一声响会把人挡在门外，
    // 而设计要的是「首次无配置允许进入接入流程」。故这里只放行 **ENOENT**
    // （文件根本没有）：空配置照常返回，用户接上供应商时**保存**才创建它。
    // 别的读失败（权限 / 是个目录…）照旧报——那不是「还没配」，那是真有问题。
    if ((error as { code?: string }).code === 'ENOENT') {
      // 数据目录按**基础目录**给（U42：不再是那个字面量常量——空配置也落得了账）
      return { path, config: { providers: {}, dataDir: magic.base }, stamp: null }

    }
    const reason = error instanceof Error ? error.message : String(error)
    throw new ConfigError(
      path,
      `读不到配置文件——首站形制见 技术方案 · 配置与密钥（${reason}）`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ConfigError(path, "配置不是合法 JSON，请修复文件后重新读取")
  }

  if (configStamp(path) !== stamp) throw new ConfigError(path, '配置在读取期间已改变，请重新读取')
  return { ...parseConfig(parsed, path, magic), stamp }
}

/** 读盘和局部保存共用的形制校验，不触发模型或 MCP。 */
export function parseConfig(parsed: unknown, path: string, magic: MagicHome): LoadedConfig {
  const home = magic.home
  const raw = asObject(parsed, path, '配置根')

  for (const key of ['defaultProvider', 'webFetch', 'modelAliases']) {
    if (Object.hasOwn(raw, key)) throw new ConfigError(path, `${key} 已移除；请在 models 配置 Default 与模型档位`)
  }

  const providersRaw = raw['providers'] === undefined ? {} : asObject(raw['providers'], path, 'providers')
  const providers: Record<string, ProviderConfig> = {}
  for (const [id, entry] of Object.entries(providersRaw)) {
    providers[id] = asProvider(entry, path, `providers.${id}`)
  }

  const configuredModels = raw['models'] === undefined ? undefined : asModels(raw['models'], path, providers)
  const providerId = configuredModels?.default?.provider
  const provider = providerId === undefined ? undefined : providers[providerId]
  const agentRoles = raw['agentRoles'] === undefined ? undefined : asAgentRoles(raw['agentRoles'], path, home)

  // 前导 `~` 在此展开（记录域拒收 `~`——见文件头注）＋ 旧落点归位（U42，见 `asDataDir` 头注）
  const dataDir = asDataDir(
    raw['dataDir'] === undefined ? magic.base : asText(raw['dataDir'], path, 'dataDir'),
    magic,
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
    rulesSegment?.[book] === undefined
      ? undefined
      : asRuleSources(rulesSegment[book], path, home, `rules.${book}`)
  const ruleSources = rulesBook('sources')
  const ruleLinkSources = rulesBook('linkSources')

  // 技能段（阶段 3 · U33）——**补充的技能目录**。形制与 `~` 展开同 `rules.sources`
  // （`asRuleSources` 那个函数只管「数组 ＋ 展开」，两处共用；键名只管报错话）。
  // ⚠️ **漏带＝静默失效**（上面三条教训同款）：配置里点了名而这里不接，
  // 那份技能就悄悄发现不了——且不报错。
  const skillsSegment = raw['skills'] === undefined ? undefined : asObject(raw['skills'], path, 'skills')
  const skillSources = skillsSegment?.['sources'] === undefined
    ? undefined
    : asRuleSources(skillsSegment['sources'], path, home, 'skills.sources')

  // 外部工具服务器（U38）——**只有配置里写了才连**（这是「用户显式配置」的唯一落点）。
  // ⚠️ **漏带＝静默失效**（同上面三条的教训）：配置里写了服务器而这里不接，
  // 外部工具一件都出不来、也不报错——用户对着「明明配了却没有」发呆。
  const mcp = raw['mcp'] === undefined ? undefined : asMcpConfig(raw['mcp'], path)
  const statusLine = raw['statusLine'] === undefined ? undefined : asStatusLine(raw['statusLine'], path)
  if (raw.debugMode !== undefined && typeof raw.debugMode !== 'boolean') throw new ConfigError(path, 'debugMode 须是布尔值')
  if (raw.logLevel !== undefined && !isLogLevel(raw.logLevel)) throw new ConfigError(path, 'logLevel 须是 error / warn / info / debug / trace')
  const motion = raw['motion'] === undefined ? undefined : asMotion(raw['motion'], path)

  return {
    path,
    config: {
      ...(configuredModels === undefined ? {} : { models: configuredModels }),
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
      ...(skillSources === undefined ? {} : { skills: { sources: skillSources } }),
      ...(mcp === undefined ? {} : { mcp }),
      ...(agentRoles === undefined ? {} : { agentRoles }),
      ...(statusLine === undefined ? {} : { statusLine }),
      ...(raw.debugMode === undefined ? {} : { debugMode: raw.debugMode as boolean }),
      ...(raw.logLevel === undefined ? {} : { logLevel: raw.logLevel as import('@magic/contracts').LogLevel }),
      ...(motion === undefined ? {} : { motion }),
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
  // 还没配过（首次运行 / 刚清空）——如实说「还没有默认供应商」，不印一个空名字
  if (loaded.providerId === undefined || loaded.provider === undefined) {
    const count = Object.keys(loaded.config.providers).length
    const connections =
      count === 0 ? '还没有接入任何供应商' : `已接入 ${count} 条连接，还没选定默认`
    return `配置 ${loaded.path} · ${connections} · 数据目录 ${loaded.config.dataDir}`
  }

  const keyFrom = loaded.provider.apiKey?.trim()
    ? '配置文件'
    : `环境变量 ${apiKeyEnvVarOf(loaded.providerId)}`
  // 型号可能还没选过（新接入的连接）——那就不印那一格，不写「（undefined）」
  const model = loaded.config.models?.default?.model === undefined ? '' : `（${loaded.config.models?.default?.model}）`

  return (
    `配置 ${loaded.path} · 供应商 ${loaded.providerId}${model}` +
    ` · key 取自${keyFrom} · 数据目录 ${loaded.config.dataDir}`
  )
}
