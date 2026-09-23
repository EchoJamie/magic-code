/**
 * 装配根 —— 全链的五步（技术方案 · 领域划分 · 装配视图）。
 *
 * 1. **读配置与密钥**——`loadConfig()`（`./config.ts`）；key 的解析在造模型网关那一刻
 *    （构造期缺 key 即抛——启动期就报，不留到第一次调用）。
 * 2. **构造各域实现**——记录域（数据目录 · 库 / blob）· 模型域（provider 注册）·
 *    执行域（工作区根注册 · 首站单根＝启动目录）。
 * 3. **依次注入**——权限域（＋ 配置里的**权限规则**）→ 工具域（沙箱 · 权限）→ 对话域
 *    （模型 · 工具 · 记录 · `EventSink` · 提示词变量 `cwd` / `platform` / `date`）。
 * 4. **控制域与扇出**——`hub.bind(routes)`（命令 → 各域）· `hub.attach(kernel)`；
 *    `EventSink` 扇出＝**控制广播全部、记录落持久类**。
 * 5. **接外壳**——返回外壳侧一端（`ControlTransport`）。
 *
 * **多会话（U16）在哪儿**——第 2 / 3 步的会话相关部分收进 `open(session)` 这个工厂：
 * 「开一条会话」＝记录实例 · 铸造器 · 闸门 · 工具域 · 对话实例一整束（单活跃，同时只留一束）。
 * **启动不预设会话**（D4：「启动＝新会话，不接续」；D5：会话懒建立）——`startup` 只在
 * 显式接续时才给 id，否则一条都不开；首条消息按下回车时由对话域经 `open` 开第一束，
 * 之后的切换同路——**装配只出工厂，不出判断**。
 * 网关（供应商注册表）**不在束里**：选中的模型不该随会话漂，故它拿转发铸造器（见其注）。
 *
 * **应用层（U25）在哪儿**——第 3 / 4 步之间多绑一处：`createActions`（对话域端口 ＋
 * 扇出 ＋ 时钟）；会话级的那几件按调用给（`actionPorts`，取的是 `open` 造出来的**同一束**）。
 * 起步唯一那个用例是**恢复**，`boot()` 就是它的入口——启动参数 `--session` 从此进得来
 * （审计第 1 条：恢复入口没有归处）。
 *
 * **本文件只做「选择 ＋ 绑定」**——不承载逻辑：判断归各域，呈现归外壳，机制归域内件。
 * 唯一必须落在装配根的东西是**信封铸造器**（契约：产出方铸 · 按会话实例构造 ·
 * `id` 取自记录域）与路径 / 时钟 / 环境变量的取材——它们是「从外面拿值」，不是逻辑。
 *
 * **编号是概念次序，代码按数据依赖展开**：扇出（第 4 步的后半）没有依赖、而各域都要它，
 * 故在代码里先立；`bind` / `attach` 确实在第 3 步之后（路由要用到各域实例）。
 *
 * **顺序纪律**（技术方案 · 控制域：无订阅方时命令丢弃——不排队、不补发）：
 * `hub.bind(routes)` → `hub.attach(kernel)` → **接外壳订阅** → 最后才放开输入。
 * 本函数做完前三步就返回；第四步（订阅）与「放开输入」是调用方的纪律——
 * 两者之间**没有任何事件产出**（各域构造期都不发事件），故丢不了。外壳位的驱动
 * （`./shell.ts`）把这条次序写在订阅与发命令的相对位置上，别处别自己拼。
 */

import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import type {
  ControlTransport,
  EventDataOf,
  EventKind,
  EventSink,
  EventStamper,
  GrantRow,
  KernelEvent,
  McpConnection,
  McpConnectionState,
  McpToolRejection,
  ModelCatalogRow,
  ModelDefaultRequest,
  ModelGateway,
  ModelSwitchRequest,
  ProviderConfig,
  ProviderSaveRequest,
  RecordsService,
  RulesLoad,
  RulesProblem,
  SessionId,
  SkillCatalog,
  Timestamp,
  TurnId,
  WorkspaceService,
} from '@magic/contracts'
import { GRANTS_FILE, TRANSIENT_EVENT_KINDS, apiKeyEnvVarOf, expandHome } from '@magic/contracts'
import { createActions } from '@magic/actions'
import type { SessionPorts } from '@magic/actions'
import { createConversationService, createConversationSession } from '@magic/conversation'
import type {
  ContextPolicy,
  ConversationSession,
  PromptVars,
  SessionInstance,
} from '@magic/conversation'
import { createControlHub, createInProcessTransportPair } from '@magic/control'
import {
  DEFAULT_CANDIDATES,
  createMaterials,
  createProjectRules,
  createSandbox,
  createSkills,
  createWorkspaceService,
} from '@magic/execution'
import type {
  FetchLike,
  ModelInfoService,
  ModelRegistry,
  ModelSwitchResult,
  WindowTable,
} from '@magic/model'
import {
  createModelInfoService,
  createModelRegistry,
  resolveConnection,
  vendorCatalog,
  windowOfSelection,
} from '@magic/model'
import { createGrantLedger, createPermissionGate, parseRules } from '@magic/permission'
import type { PermissionRule, RuleProblem } from '@magic/permission'
import { createRecordsStore } from '@magic/records'
import type { RecordsStore } from '@magic/records'
import { createMcpServers } from '@magic/mcp'
import type { McpServers } from '@magic/mcp'
import { createToolRuntime, defineMcpTools, defineSkillTool } from '@magic/tools'
import type { ToolDefinition } from '@magic/tools'
import type { LoadedConfig } from './config.ts'
import { ConfigError, loadConfig } from './config.ts'
import { removeProvider, saveProvider, setModelDefault } from './config-save.ts'
import { loadGrants, saveGrants } from './grants-file.ts'
import { createFileModelInfoCache } from './model-cache.ts'

/** 瞬时类不落库（契约 `TRANSIENT_EVENT_KINDS`——记录 schema v0 规则 ①）。 */
const TRANSIENT: ReadonlySet<EventKind> = new Set(TRANSIENT_EVENT_KINDS)

/** 提示词注入项的环境来源——只放**环境**；`cwd` 是工作区默认根，两处必须同一个值。 */
export type EnvironmentVars = {
  /** 平台（注入项 `platform`）——缺省 `process.platform`。 */
  readonly platform?: string
  /** 日期（注入项 `date`）——缺省取 `now()` 的本地日期（`YYYY-MM-DD`）。 */
  readonly date?: string
}

/** 装配入参——一切「从外面拿的」都经此进来（测试与入口复用同一条路径）。 */
export type AssembleOptions = {
  /** **启动目录**——首站单根＝默认根（技术方案 · 执行 · 工作区）。须是**已存在**的路径。 */
  readonly cwd: string
  /** 已加载的配置——缺省 `loadConfig()`（读 `~/.magic/config.json`）。 */
  readonly config?: LoadedConfig | undefined
  /**
   * 模型实现——**工厂**（入参＝装配刚造好的那个铸造器）；缺省＝按配置造真端点网关
   * （那是唯一会解析 key 的一步，缺 key 当场抛）。
   *
   * 测试替身（Faux）在此进：`(stamper) => createFauxGateway({ stamper, turns })`。
   * **为什么是工厂而不是现成实例**——铸造器按会话实例构造、`id` 取自记录域，故
   * 网关必须用**同一个**铸造器；让调用方先造网关＝它得先自备一个铸造器，两套 id
   * 空间当场打架（同一张库里两串 1、2、3）。工厂把「谁造铸造器」这件事留给装配本身。
   *
   * ⚠️ **给了它就没有注册表**（`Assembly.models` 随之缺席）——替身是**单件**，
   * 没有「多个条目」可言，切换在那条路上不适用（见 `Assembly.models`）。
   */
  readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined
  /**
   * 模型域的注入用 fetch（**假端点回放 SSE，不经网络**）——真路径缺省＝真网络。
   *
   * 用途与 `@magic/model` 的同名构造入参一致：让装配层用例能拿**两个真条目**
   * （真注册表 · 真取件层 · 真归一）跑切换，而不必依赖网络与 key。
   * 注入了替身网关（`modelGateway`）时本项无意义——那条路不走注册表。
   */
  readonly modelFetch?: FetchLike | undefined
  /**
   * **显式接续**：给 id ＝ 开局就装载这条会话（并跑一次恢复处置在途）。
   * **不给 ＝ 启动＝新会话**（D4）：一个会话都不开，首条消息按下回车才建立（D5）。
   */
  readonly session?: SessionId | undefined
  /** 时钟——条目 / 信封的时间戳（域不各自取时钟）；缺省 `Date.now`。 */
  readonly now?: (() => Timestamp) | undefined
  /**
   * 上下文策略的覆盖位（对话域的 `ContextPolicy`，**只增不改**）——缺省＝对话域的缺省
   * （`DEFAULT_CONTEXT_POLICY`：blob 阈值 / 截断 ＋ 压缩的触发阈值 / 近段边界）。
   *
   * 由头：策略是**域内件**、缺省值在域里，而「这一次装配用哪一套」只有装配根说了算
   * （同 `modelGateway` / `now` 的分寸）。**不设配置键**——这是装配期入参，不是用户配置
   * （阶段 3 的压缩阈值归实现级常量，B4：没有让用户调的需求，就不长配置面）。
   */
  readonly context?: Partial<ContextPolicy> | undefined
  /** 提示词的环境注入项（见 `EnvironmentVars`）。 */
  readonly prompt?: EnvironmentVars | undefined
  /**
   * **授权文件的落点**——缺省 `GRANTS_FILE`（`~/.magic/grants.json`，`~` 在此展开）。
   *
   * ⚠️ **不跟 `dataDir` 走**：它是**授权**的落点，与 `config.json` 一样住 `~/.magic`
   * （`dataDir` 是**记录**的落点，可被用户指到别处）。给这个覆盖位是为了测试能指到临时目录。
   */
  readonly grantsFile?: string | undefined
  /** 家目录（展开 `GRANTS_FILE` 的 `~`；缺省 `os.homedir()`）——与配置加载器同一个来处。 */
  readonly home?: string | undefined
  /**
   * **外部工具（MCP）两条上限的覆盖位**（U38）——连接 / 发现与一次调用各一道（毫秒）。
   *
   * 缺省＝适配器里那两个实现级常量（10s / 120s）。给这个口的理由同 `context`：
   * 它是**装配期入参、不是用户配置**（用户没有调它的需求），而用例**必须**能把它调小
   * ——不然「超时」那条路要真等两分钟。
   */
  readonly mcpTimeouts?:
    | { readonly connectTimeoutMs?: number; readonly callTimeoutMs?: number }
    | undefined
}

/** 装配产物——外壳侧一端 ＋ 自检 / 验收要用的把手。 */
/** 注册表缺席时那条切换结果的缘由（注入了替身网关＝这批装配换不了模型）。 */
const NO_REGISTRY = '本次装配没有供应商注册表（注入了替身网关）'

/** 授权名录的一屏（`Assembly.grantsView`）——**一处取，两处用**（`/grants` 与 `--check`）。 */
export type GrantsView = {
  /** 本工作区（分节键＝默认根的规范形）。 */
  readonly workspace: string
  /** 本工作区的授权（声明序）。 */
  readonly grants: readonly GrantRow[]
  /** **陈旧的节**——路径已不在的那些（`B11`）。 */
  readonly stale: readonly string[]
}

/**
 * 一条外部服务器的读数（`Assembly.mcpServers` · U38/U39）——**状态 ＋ 它报的工具名**。
 *
 * 工具名是**服务器那边报的**（`echo`），不是注册名（`mcp__<服务器>__echo`）：
 * 这一屏答的是「我配的那台服务器上有什么」，对得上服务器自己的文档。
 */
export type McpServerView = {
  readonly server: string
  /** 哪一种接入（`stdio` / `http`）——这一屏有两条来路，读数上分得开。 */
  readonly transport: 'stdio' | 'http'
  readonly state: McpConnectionState
  readonly tools: readonly string[]
  /**
   * **发现时拒收的那些**（名字不合规 / 同一台服务器重名）——`--check` 逐条报出来。
   *
   * 与 `tools` 一起看才完整：这一台**报了什么、我们用了什么、没用什么**（返工 B 的两条
   * 判据都建在这份读数上：不合规的拒收要说得清、重名的全拒且列表与注册一致）。
   */
  readonly rejected: readonly McpToolRejection[]
}

export type Assembly = {
  /**
   * **换模型**——装配侧的**唯一**切换入口：命令面（`model.switch`）与 `--script` 的
   * `{switch}` 都调它，**成败都发一条 `model.switched`（落库）**（缺陷 D16 收拢的产出路径）。
   * 结果原样交回调用方（脚本据以决定继续还是当场停）。
   */
  readonly switchModel: (request: ModelSwitchRequest) => ModelSwitchResult
  /**
   * **模型信息面**（U41）——`model.catalog` 里那份缓存读数的出处。
   *
   * 装配之外（自检 / 验收装置）要它，是为了能**显式刷新**与读当下那一格，
   * 而不必绕控制面发命令。
   */
  readonly modelInfo: ModelInfoService
  /**
   * **外壳侧一端**（契约 `ControlTransport`）——接外壳。
   * 用法＝先 `subscribe(…)`、后 `send(…)`（顺序纪律见文件头注）。
   */
  readonly shell: ControlTransport
  /**
   * **当下活跃**的会话 id（单活跃——切换之后跟着变）；
   * **`undefined` ＝ 还没有会话**（空手打开；首条消息按下回车才建立——D5）。
   */
  readonly session: SessionId | undefined
  /** 本次装配用的配置（自检报告用；**不含 key**）。 */
  readonly config: LoadedConfig
  /**
   * **供应商注册表**（多条目的真路径）——`providers` 里有多少条就注册多少条；
   * 会话中途换模型＝调它的 `use()`（技术方案 · 模型策略 · 切换）。
   *
   * **何时缺席**：注入了替身网关（`AssembleOptions.modelGateway`，测试用）——替身是单件，
   * 没有条目表可言。缺席是**看得见的**（`undefined`），不是静默失效：调用方据以决定
   * 「这次装配不谈切换」。
   */
  readonly models: ModelRegistry | undefined
  /** 库把手——收尾（`close`）· 入口那道 `--session` 校验（U28）· 验收脚本用。 */
  readonly records: RecordsStore
  /** 数据落点（`records.db` 与 `blobs/` 的绝对路径）。 */
  readonly paths: { readonly database: string; readonly blobs: string }
  /**
   * 本次生效的**权限规则**（配置 `permissions.rules` 经权限域 `parseRules` 的落地）——
   * 自检 / 验收据以确认「规则真的接进闸门了」。
   */
  readonly permissionRules: readonly PermissionRule[]
  /**
   * **被拒的规则条目**（连同缘由）——解析从严：读不懂的**不生效**（而不是退化成更宽的规则）。
   * 缘由交回装配是**给用户看的**：静默丢弃会让人对着一条不生效的规则发呆。
   */
  readonly rejectedRules: readonly RuleProblem[]
  /**
   * **授权文件的落点**（`~/.magic/grants.json`，已展开）——自检那一行与报错都用它。
   *
   * 由头：这是**内核自持**的一个文件（技术方案 · 权限「授权的落点」），写回它的是内核自己；
   * 用户要能一眼找到它、手改它、删它——故自检里报出来。
   */
  readonly grantsPath: string
  /**
   * **授权名录 ＋ 陈旧的节**（U22）——`/grants` 那一屏的取材，`--check` 那一行也读它
   * （**一处判定，两处说同一句话**）。
   *
   * `stale` ＝**路径已不在**的那些节（`B11` 的「陈旧节」）——判它要问文件系统，故判在这里。
   * **只列不删**：删用户数据不归内核，撤销入口在 `/grants`。
   */
  readonly grantsView: () => GrantsView
  /**
   * **启动那几句要说的话**（U22 · 审计第 13 条）——外壳开局进记录区**一行回执**。
   *
   * 由头：解析从严（读不懂的规则 / 授权**不生效**）这件事原先**只有 `--check` 会说**，
   * 走 TUI 那条路时**一声不响**——用户对着一条不生效的规则发呆，不知道它压根没被读进来。
   *
   * 三条来路：**被拒的权限规则**（`rejectedRules`）· **授权文件读不懂**（`loadGrants` 的
   * `note`）· **外部服务器连不上**（U38，见下）。都**没到非报不可的量**（正常时是空数组）
   * ——空数组＝启动一句多余的话都不说。
   *
   * ⚠️ **取值器而不是快照**（U38）：外部服务器连上连不上是**发现那一趟**（`ready()`）才
   * 落定的事，而 `assemble()` 是同步的。故这一位现读（调用方在 `ready()` 之后取，拿到的是
   * 落定后的说法）；「首轮模型请求前完成发现」那条纪律由 `ready()` 保证，不靠这一位。
   */
  readonly notices: readonly string[]
  /**
   * **外部服务器的一屏**（U38）——每条连接的当下状态与工具表（`--check` 那一行读它；
   * **U39 的 `/mcp` 也接在这一处**：查询面一处产出，两处说同一句话）。
   *
   * 工具名是**服务器那边报的**（未加前缀）——注册名（`mcp__<服务器>__<工具>`）由工具域合成，
   * 这一屏报的是「服务器自己有哪些东西」（对得上服务器文档）。
   */
  readonly mcpServers: () => readonly McpServerView[]
  /**
   * **发现那一跳**（U38）——等所有已配置的外部服务器「起手 → 发现」落定（各自有界）。
   *
   * **起手在 `assemble()` 里就发车了**（同步那一步不等），这里是**收口**：等过它，
   * 工具表才是最终那一份；失败的那几条落成「不可用 ＋ 缘由」（**不拖垮内置工具**）。
   *
   * **入口在放开输入之前调它**（`cli.ts`）：设计明文「首轮模型请求前完成发现」——
   * 不早不晚就是这一跳。没有配置任何服务器时它是**空转**（一步就完）。
   */
  ready(): Promise<void>
  /**
   * **释放本进程拉起的外部服务器**（U38）——关 stdin → 等 → 杀（传输规范 · Shutdown），
   * **只碰自己拉起的那些**（用户自己的服务不归我们动）。
   *
   * 与 `close()` 分家的理由：关库是同步的（一条语句），而子进程的收尾**天然是异步的**
   * （要等它自己退，等不到才杀）。收尾路径要真等到它落定，就得有个能 await 的口。
   * `close()` 也会**发起**这件事（`void`，不等）——忘了 await 也不至于把子进程留下。
   */
  shutdown(): Promise<void>
  /**
   * **当前条目**的上下文窗总量——状态行 ④ 的**分母**（缺陷 `D10` 第 1 样；U20 留的位，
   * U21 接上、U30 补来处）。
   *
   * **来处两条**（判定在模型域 `resolveContextWindow`）：用户声明的
   * `providers.<id>.contextWindow` 优先；没声明就查**内置容量表**（按条目的模型名，
   * 官方出处见 `capacity.ts`）——已知模型不要求用户自己补客观容量（U30）。
   *
   * **两处都没有就是 `null`**——不是 0、也不是某个惯例值：`null` 让外壳**只报已用量**
   * （「拿不到的不编」是这条读数立起来时的判据）。注册表缺席（注入了替身网关）同此。
   *
   * 与 `/model` 那条来路（`model.catalog`）同源同判据——两处都出自**注册表条目**那一个数，
   * 不会分叉。
   */
  readonly contextWindow: number | null
  /**
   * **项目规约的按需读数**（U32）——现读一次「各根一级 ＋ 显式来源」，连**没加载进来的那些**
   * 一起交回（`--check` 那一行与启动回执的话都从这儿来）。
   *
   * **现读而不是取装配那一刻的快照**：规约是随用户编辑变的文件，「自检」这件事的意义正在于
   * 「现在这会儿是什么样」。参数与 `ProjectRules.load` 同形——给目标就按目标算。
   */
  readonly readRules: (targets?: readonly string[]) => RulesLoad
  /**
   * **技能目录的按需读数**（U33）——现读一次「都发现了哪些、有哪些没读进来」，
   * 连**没进来的那些**一起交回（`--check` 那一行从这儿来）。
   *
   * 与 `readRules` 同一条姿势：现读而不是取装配那一刻的快照（技能是随用户编辑变的目录）。
   * **没有「只报一部分」那种形态**：发现面是**一层子目录**，读得到的就是全的
   * （与规约的按目标筛选不同——技能不按目标适用，它是一份清单）。
   */
  readonly readSkills: () => SkillCatalog
  /**
   * **窗长表**（U30）——内置容量表 ＋ 各条目**自己声明**的覆盖位，**分开装**：
   * 内置表按**准确模型 id** 算（与条目无关），声明**只属于配置它的条目及对应模型**
   * （消费按 `provider ＋ model` 一起看——见 `windowOfSelection`）。
   *
   * 为什么要整张表进外壳：换模型是**运行时**的事（`/model` 一按就换），那一刻外壳得
   * **当场**知道新模型多长——而它够不着注册表。表递过去，`model.switched` 一到就查得出；
   * 查不到＝不知道（分母 `null`），**不沿用前一个模型的容量**。
   *
   * 注册表缺席 ⇒ **空表**（＝什么都不知道）：与上面 `contextWindow` 的 `null` 同一条口径
   * ——不编。（两者不并成一个位：`contextWindow` 是**开机那一刻**的读数，本表是**之后**
   * 每一次切换的取材——外壳开机时手里还没有模型名，查不了表。）
   */
  readonly windowTable: WindowTable
  /**
   * 工作区**注册根列表**（阶段 3 多根）——执行域构造时逐条取的 `realpath`，**不是**入参原值：
   * macOS 上 `/var/…` 实为 `/private/var/…`，提示词与沙箱都该说**真路径**这同一个。
   *
   * **序即语义**——`[0]` ＝**默认根**（相对路径与新文件的落点）；单根＝一项的特例。
   * 提示词注入的 `cwd` 报的是**整组根**（`[0]` 标为默认根，其余在列——见
   * `promptVarsOf` / `workspaceLineOf`：多根下模型得**一开始就知道**有哪几条根）。
   */
  readonly workspaceRoots: readonly string[]
  /**
   * **启动流转**——对开局那条会话跑一次恢复（应用层的用例：处置在途操作 ＋ 重建现场；
   * 干净会话照样装载、照样告诉外壳「你在这儿」）。
   *
   * 由**外壳**在**接好订阅之后、放开输入之前**调一次（技术方案 · 控制域：无订阅方时
   * 命令 / 事件都丢——恢复要发事件，得先有人听着）。**这一跳完成才算「放开输入」**
   * （技术方案 · 装配视图第 5 步：「以 `boot` 完成为界」，U25 收敛）——外壳侧那一半
   * 在 `@magic/tui`（输入闸）。
   *
   * 返回值不交出去：报告是应用层的形态，要看细节请直接调 `actions.recover`。
   */
  boot(): Promise<void>
  /**
   * 关库（blob 无需收尾）＋ **发起**外部服务器的释放（不等它——要等请 `await shutdown()`）。
   */
  close(): void
}

/**
 * 造信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
 *
 * 四件的来处：`id` ＝记录域 `nextId()`（条目 / 事件共用同一 id 空间）· `session` ＝本实例
 * 设定 · `turn` ＝对话域在轮起止时调 `beginTurn`（`undefined` ＝轮止 → 信封的 `null`）·
 * `at` ＝此处盖（**产出方不各自取时钟**）。
 *
 * ⚠️ 泛型 `K` 与 `data: EventDataOf[K]` 的对应关系 TS **无法在函数体内自证**（构造面的
 * 固有限制）——故有一次断言。测试桩那一处同理（`@magic/faux` · `stamper.ts`）；两处是
 * 同一限制在两个面的落点（生产面 / 测试面），不是重复实现。
 */
export function createStamper(input: {
  readonly records: { nextId(): number }
  readonly session: SessionId
  readonly now: () => Timestamp
}): EventStamper {
  let turn: TurnId | null = null

  return {
    stamp: <K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent =>
      ({
        id: input.records.nextId(),
        session: input.session,
        turn,
        at: input.now(),
        kind,
        data,
      }) as KernelEvent,

    beginTurn: (value: TurnId | undefined): void => {
      turn = value ?? null
    },
  }
}

/**
 * 开工作区（U18）——**根的校验错转成「配置事故」那一句话**（`ConfigError`）。
 *
 * 由头（本轮实测）：`workspaceRoots` 是**用户手写在配置文件里**的东西——路径打错一个字母、
 * 写成相对路径、两条重复，都是**配置事故**，不是程序异常。而执行域抛的是普通 `Error`
 * （它**不该**认识 `ConfigError`——那是本层的形态），裸抛出去就是「一句 `error:` ＋ 三段内部栈」，
 * 栈里还写着「技术方案 · 执行 · 工作区」这种给开发者看的话——**用户读完不知道该改哪儿**。
 *
 * 故这里转一道：**域只管判「合不合格」，报给人听的那句话归装配**——它手上正好有
 * 「是哪份配置」（`loaded.path`），于是用户拿到的是 `配置有问题：<缘由>（<哪份文件>）`
 * 一行话，与加载期那几条同形（「报错不降级」两条都守，只是把「报得有人看得懂」也补上）。
 *
 * ⚠️ **只包根注册这一步**——网关（缺 key）· 记录域那些构造期的抛各有各的处置，
 * 别顺手一起裹：那是另一件事，得单独议（本轮已随回报备案）。
 */
function openWorkspace(loaded: LoadedConfig, cwd: string): WorkspaceService {
  try {
    return createWorkspaceService({ roots: loaded.config.workspaceRoots ?? [cwd] })
  } catch (error) {
    throw new ConfigError(loaded.path, error instanceof Error ? error.message : String(error))
  }
}

/** 本地日期（`YYYY-MM-DD`）——提示词的注入项 `date` 取它（用户的一天，不是 UTC 的一天）。 */
function localDate(at: Timestamp): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 装配 —— 五步走完，返回外壳侧一端。
 *
 * **不做的事**：不订阅（那是外壳）、不发命令（那是用户）、不呈现（那是外壳）、
 * 不判断（那是各域）。反过来说，凡在此处出现的 `if`，都该先问一句「这判断归谁」。
 */
export function assemble(options: AssembleOptions): Assembly {
  const loaded = options.config ?? loadConfig()
  const now = options.now ?? Date.now

  // ── 2 构造各域实现 ────────────────────────────────────────────────
  // 执行域先立：**工作区是记录域构造入参的一半**（U26——会话归属工作区，见下），
  // 且装配根只做选择、不判断根合不合格（那归执行域，一个真源）。
  // **多根（U18）**——配置 `workspaceRoots` 在即**整组接管**；缺省 → 回落启动目录
  // （阶段 1 姿态：「启动目录＝默认根（唯一）」）。这条 `??` 正是「装配根只做选择」：
  // 判断（哪几条合格）归执行域，缺省值归装配，两侧各一处（见契约 `WorkspaceRoots`）。
  const workspace = openWorkspace(loaded, options.cwd)
  const sandbox = createSandbox({ workspace })

  /**
   * **外部工具服务器**（U38）——配置里显式写了的那几条，一条一个进程。
   *
   * 两件事在这一步定：
   * - **只按配置连**（`loaded.config.mcp?.servers`）——不扫文件、不猜：工作区里出现
   *   `.mcp.json` 一类文件**不等于获准运行启动命令**（设计明文）。没配＝一条都不连。
   * - **起手在这儿发车、落定在 `ready()`**：装配是同步的（第 2 / 3 步都在造实例），
   *   而拉起进程是异步的——故「先发车、到该落定的那一处等」（`Assembly.ready`）。
   *
   * 调用上限随 `options.mcpTimeouts` 走（用例要把它调小；用户配置里没有这一项——
   * 它是实现级常量的装配期覆盖，同 `context` 那个先例）。
   */
  const mcp: McpServers = createMcpServers({
    servers: loaded.config.mcp?.servers ?? {},
    ...(options.mcpTimeouts?.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.mcpTimeouts.connectTimeoutMs }),
    ...(options.mcpTimeouts?.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.mcpTimeouts.callTimeoutMs }),
  })

  /**
   * **外部工具的定义**（U38）——发现的结果 → 注册表要的那一件（工具域合成，此处只取）。
   *
   * **每次开一条会话现取**（不在装配那一刻定死）：连接是**进程级**的一束，会话是**按条**
   * 开的，而工具表属于前者——现取才与「发现之后又变过」对得上；发现没落定时它就是空表
   * （或只有已连上的那几条），内置工具照常。
   */
  const mcpTools = (): readonly ToolDefinition[] =>
    mcp.connections.flatMap((connection) => [...defineMcpTools(connection)])

  /**
   * **项目规约的来源面**（U32）——归执行域落地（**文件读取在执行 / 基础设施边界**），
   * 装配这一步只做**选择**：哪几条根 ＋ 用户显式点名的两处（**读进来**的补充规约
   * 与**只放行链接**的那份名册）。
   *
   * 它在装配期就造好（无状态、构造不碰 I/O），随后**注入每一条会话实例**——
   * 「什么时候送、送哪些」归对话域（它才知道这一轮在动哪儿）。
   */
  const projectRules = createProjectRules({
    workspace,
    sources: loaded.config.rules?.sources ?? [],
    // 两张名册两件事（契约 `RulesConfig`）：`sources` 读进来，`linkSources` 只放行链接
    linkSources: loaded.config.rules?.linkSources ?? [],
  })

  /**
   * **技能来源面**（U33）——同样归执行域落地（文件读取在执行 / 基础设施边界），
   * 装配这一步只做**选择**：哪几条根（默认那两处由实现自己按工作区与用户目录拼）＋
   * 用户点名的补充目录 ＋ 用户目录本身。
   *
   * ⚠️ **它要交给两处**（见下）：对话域（目录块 ＋ 显式选定取主文）与**工具域**
   * （模型自主选用走 `skill` 工具）——工单明写「同一个来源口」，故**同一个实例**递两处。
   * 各造一份的话，两条路对「有什么、在哪儿」会各说一套。
   *
   * `home` 从与配置、授权文件**同一个**来处取（`options.home ?? homedir()`）——
   * 三处指同一个家目录，测试沙箱化时才不会漏掉一处（真家目录被写脏是本项目栽过的坑）。
   */
  const skills = createSkills({
    workspace,
    home: options.home ?? homedir(),
    sources: loaded.config.skills?.sources ?? [],
  })

  /**
   * **材料来源面**（U36 · 正文里的 `@`）——同一条分工的第三次：路径解析、有界读取、
   * 二进制判定、有界目录清单都在执行域，装配这一步只把**工作区**递过去。
   *
   * **只出读的那一半**：它与沙箱共用同一个 `workspace`（边界同源），但**不碰沙箱**——
   * 工作区外那一个文件走的是「用户明确选定的只读附件」，**沙箱的根一条都不动**
   * （后续工具的可写范围不因此扩大）。
   *
   * 两处用同一个实例：对话域（按引用取材料）与**路径候选**（`paths.list` 的答复）。
   */
  const materials = createMaterials({ workspace })

  /**
   * **技能读取入口那一件工具**（U33）——`options.tools` 追加集里的一件。
   *
   * 只造**一次**（与 `skills` 同源），随后每开一条会话链都递同一个（见 `open`）：
   * 它读的是只读材料、走 `Skills` 端口而不走沙箱，故不落在默认七件里。
   */
  const skillTool = defineSkillTool(skills)

  // ── 授权（U22）：`a` 的落点是**工作区**，存 `~/.magic/grants.json` ──────────────
  //
  // 三件都在这一步：**读文件**（启动期一次，同配置）→ **造账本**（纯内存，跨会话共用）
  // → **接落盘**（账本变了就写回）。权限域自己不碰文件系统，读写都在这一层。
  const grantsPath = expandHome(options.grantsFile ?? GRANTS_FILE, options.home ?? homedir())
  const loadedGrants = loadGrants(grantsPath)
  /** 有攒着没落的记账（命中统计）——收尾时补一次（见 `close`）。 */
  let grantsDirty = false
  /**
   * **上次没写进盘**的那一句（`/grants` 里说）——写盘会失败（权限 / 盘满），而失败**不该静默**：
   * 授权还在内存里生效，用户却以为它已经记下了 ⇒ 下次启动它就不在了。
   *
   * 说在哪儿：**`/grants` 那一屏**（授权的门面）。那一刻要说的通道（`grants.catalog` 的 `note`）
   * 正好在那儿，不必另长一条告警路径。
   */
  let grantsWriteError: string | undefined

  /**
   * **授权账本**（工作区级）——`a` 写进这里，进程内**跨会话共用**。
   *
   * 分节键＝**默认根的规范形**（`workspace.defaultRoot()`）：工作区是进程级的（配置在则整组
   * 接管、缺省则启动目录），故账本也是进程级的一件——这正是「授权跨会话存活」在进程内的形态。
   * 取舍见 `@magic/permission` · `grants.ts` 的「分节键」。
   */
  const grants = createGrantLedger({
    workspace: workspace.defaultRoot(),
    file: loadedGrants.file,
    now,
    onChange: (file, change) => {
      // **授权的新增 / 撤销＝立刻落盘**：那份文件存在的理由就是它们，攒着＝掉电丢授权。
      // **命中记账＝攒着**：每一次自动放行都写盘是白烧 io，而掉电丢的只是统计（不是授权）。
      if (change === 'hit') {
        grantsDirty = true
        return
      }
      grantsDirty = false

      // 写盘**不抛进裁决回路**：这一跳在 `resolve()` 的调用栈里（用户在按 `a`），
      // 抛上去会炸掉外壳的按键处理——而「授权没记住」不是那一刻该打断用户的事。
      // 失败方向安全：**最坏丢一次授权**（内存里仍生效），下一回 `/grants` 里说清楚。
      try {
        saveGrants(grantsPath, file)
        grantsWriteError = undefined
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        grantsWriteError = `授权没能写进 ${grantsPath}（${reason}）——本次仍在生效，但重启动就没了`
      }
    },
  })

  /** 陈旧节——路径**已不在**的那些（`B11`；只列不删，撤销入口在 `/grants`）。 */
  const staleSections = (): readonly string[] =>
    grants.sections().filter((section) => !isDirectory(section))

  const grantsView = (): GrantsView => ({
    workspace: workspace.defaultRoot(),
    grants: grants.view(),
    stale: staleSections(),
  })

  // 记录域：数据目录（`~` 已在加载时展开——记录域拒收 `~`）＋ **本进程的工作区**。
  //
  // **工作区为何在构造时交出去**（U26）：会话**建立时锚定**它——建行的动作在记录域
  // 的事务里（首写即建会话，`D5`：首条消息按下回车那一刻），故归属只能随库的构造进域。
  // 交的是 `roots()`（`realpath` 后的规范形 · 声明序），**整组**——只记默认根的话，
  // 多根工作区日后恢复就重建不回去（那一列正是为「回到原位」立的）。
  // 工作区是**进程级**的（配置在则整组接管、缺省则启动目录），同进程开的会话同属一个
  // ——这与「归属随记录持久」不冲突：库里那一列只在建行那一次写，此后谁开都改不动。
  const recordsStore = createRecordsStore({
    dataDir: loaded.config.dataDir,
    workspace: workspace.roots(),
  })
  /**
   * **启动＝新会话（不接续）**——第 19 轮按 D4 改回来：给的是「显式接续」的那条路
   * （启动参数 `--session` 的同义物），**不给就是「还没有会话」**。
   *
   * 一度取过「启动＝接着最近一条」（U16 · 以产品方案 功能 8 与阶段 2 验证句为据），
   * 用户亲跑后推翻：**一个字都没输入却接上了上次的会话**，每次空手打开都落在旧会话上。
   * 裁决：**接着来是显式的**（`/session` 选，或这里给 id）；验证句的「关掉能接着来」
   * 由显式 resume 满足即可。
   *
   * 与 D5（会话懒建立）同源：不给 id ⇒ **一个会话都不开**——不铸 id、不占存储、
   * 不把列表塞满空壳；首条消息按下回车才开张（`SessionHost.submit`）。
   */
  const startup = options.session

  // ── 4 控制域 ＋ 扇出 ──────────────────────────────────────────────
  // 扇出在代码里先立：它没有依赖，而各域都要它（编号是概念次序，见文件头注）
  const hub = createControlHub()
  const sink: EventSink = {
    emit(event) {
      // ① 控制广播**全部**（含瞬时增量——渲染要实时）
      //    先广播后落库：反过来的话，落库一炸（载荷非 JSON 等）就是外壳**静默**漏事件
      //    ——比如一条裁决询问没显示出来，用户永远等不到提示。丢持久可查、丢渲染会挂。
      hub.emit(event)
      // ② 记录落**持久类**（瞬时类不落库——规则 ①）
      //    注：记录域**自己也拦一道**（`appendEvent` 按 `TRANSIENT_EVENT_KINDS` 就地丢），
      //    故此处的过滤是**第二道**——它决定「推给谁」，记录域那道是「落不落」的兜底。
      //    **按信封分束**（U16）：多会话之后扇出是进程级的，落给哪条会话由信封说了算——
      //    装配再维护一份「哪条会话用哪个实例」就是第二真源。
      if (!TRANSIENT.has(event.kind)) recordsStore.appendEvent(event)
    },
  }

  // ── 3 依次注入：权限域 → 工具域（沙箱 · 权限）→ 对话域 ──────────────
  // 权限规则（阶段 2）：配置里那段的**原值**交给权限域的 `parseRules`——条目形态归它裁
  // （解析从严：读不懂的条目逐个拒收、连同缘由交回，见 `Assembly.rejectedRules`）
  const parsedRules = parseRules(loaded.config.permissions?.rules ?? [])

  /**
   * **当下的活跃铸造器**——按会话实例各一份（契约 · 信封的归属：上下文 `session` 由
   * 铸造器持），换会话即换它。
   *
   * 注册表却是**进程级**的（选中的供应商 / 模型不该随会话漂——那是用户对「这台机器走谁」
   * 的选择，不是某条会话的属性），故它拿下面这个**转发铸造器**：盖章时指向**当下**那条。
   * 转发之所以成立，靠的是**单活跃 ＋ 忙时切不动**（对话域保证）：盖章的那一下，
   * 当下的活跃会话恒是正在干活的那条。
   */
  let activeStamper: EventStamper | undefined
  const forwardStamper: EventStamper = {
    stamp: (kind, data) => requireActiveStamper().stamp(kind, data),
    beginTurn: (turn) => requireActiveStamper().beginTurn(turn),
  }

  const requireActiveStamper = (): EventStamper => {
    if (activeStamper === undefined) {
      throw new Error('信封铸造器还没就位——装配次序错了（会话链要先开一条）')
    }
    return activeStamper
  }

  /**
   * **连接资料的真源**（U41）——开局的取自配置；`provider.save` / `remove` / 设为默认
   * 落盘成功后**换掉它**（注册表与模型信息面都从这儿读，故两处不会各说一套）。
   *
   * 为什么不是直接把 `loaded.config` 改掉：那是**加载那一刻**的读数（自检、数据目录、
   * 权限段都指着它），改它等于把「这一趟读到了什么」与「现在配的是什么」混成一件。
   */
  let providerBook: Readonly<Record<string, ProviderConfig>> = loaded.config.providers
  /** 默认连接 id——「设为默认」会换它（同上，与 `loaded` 分开）。 */
  let defaultProviderId: string | undefined = loaded.providerId
  /** 配置文件当下的 `mtimeMs`——每次保存成功后更新（保存前比它，见 `config-save.ts`）。 */
  let configMtime: number | undefined = loaded.mtimeMs

  // 模型域：provider 注册表（`providers` 加条目即多一个；`traits` 覆盖位随条目进）
  // **key 在这一步解析**——按条目各解析一次；缺省那条缺 key 即启动期抛（与单供应商时代同）
  const registryOf = (): ModelRegistry =>
    createModelRegistry({
      providers: providerBook,
      ...(defaultProviderId === undefined ? {} : { defaultProvider: defaultProviderId }),
      stamper: forwardStamper,
      fetch: options.modelFetch,
    })

  let models: ModelRegistry | undefined
  if (options.modelGateway === undefined) models = registryOf()

  /**
   * **按当下的连接资料重建注册表**（保存之后）。
   *
   * 不成（新连接缺 key / 缺省指向了不存在的连接）时**保留原来那一张**：
   * 配置已经落盘了，这一次装配用不上它——如实说一句，别把装配整个带崩。
   */
  const rebuildRegistry = (): { readonly ok: true } | { readonly ok: false; readonly reason: string } => {
    if (options.modelGateway !== undefined) return { ok: true }
    try {
      models = registryOf()
      return { ok: true }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: `配置已保存，但这次装配还用不上它：${reason}` }
    }
  }

  /**
   * **模型信息面**（U41）——连接资料现取（改完配置立刻对得上）、缓存落盘走 app 的实现。
   *
   * `onChange`：取到新列表 / 这次没取成 ⇒ **再发一屏 `model.catalog`**。
   * 还没有会话时没有信封可铸，那次不发——`/model` 按下去会现问一次，不会丢。
   */
  const modelCache = createFileModelInfoCache(loaded.config.dataDir)
  const modelInfo: ModelInfoService = createModelInfoService({
    connections: () =>
      Object.entries(providerBook).map(([id, config]) => resolveConnection({ providerId: id, config })),
    cache: modelCache,
    fetch: options.modelFetch ?? (globalThis.fetch as FetchLike),
    now,
    onChange: () => {
      if (chain === undefined) return
      sink.emit(requireActiveStamper().stamp('model.catalog', catalogOf(models)))
    },
  })

  /**
   * **窗长表**（U30）——内置表 ＋ 各条目自己声明的覆盖位；**注册表缺席＝空表**
   * （＝什么都不知道，与 `Assembly.contextWindow` 的 `null` 同一条口径）。
   *
   * 这是一份**值**（配置定的，不随切换漂）——开机那一格与外壳此后每次切换的取材
   * 都读它，判定统一走 `windowOfSelection`（一处口径，不会分叉）。
   */
  const windowTable: WindowTable = models?.windowTable() ?? { builtin: {}, declared: {} }

  /** 一次「开一条会话」的产物——切换时整束换掉（单活跃：同时只留一束）。 */
  type Chain = {
    readonly session: SessionId
    readonly records: RecordsService
    readonly gate: ReturnType<typeof createPermissionGate>
    readonly tools: ReturnType<typeof createToolRuntime>
    readonly service: ConversationSession
    /** 铸造器（按会话实例构造）——**也在这里**：应用层的现场束要用同一个（见 `actionPorts`）。 */
    readonly stamper: EventStamper
  }
  let chain: Chain | undefined

  /**
   * **开一条会话的实例链**（U16）——装配的 `open` 工厂。
   *
   * 换会话＝换这一整束：记录实例 · 铸造器 · **闸门** · 工具域 · 对话实例。
   * **不缓存**旧束：「一个活跃对话实例」是结构，不是计数。
   *
   * ⚠️ **闸门换了，授权不换**（U22）：闸门按会话各一份（裁决的账、在途询问各归各的），
   * 而**授权账本（`grants`）是工作区级的那一个**、跨会话共用——故「换会话」不再意味着
   * 「把 `a` 记下的东西清零」（技术方案 · 权限「授权的落点」：会话不是信任的边界）。
   *
   * ⚠️ 网关（注册表）**不在此列**——见 `forwardStamper` 的注。
   */
  const open = (session: SessionId): SessionInstance => {
    const records = recordsStore.serviceFor(session)
    const stamper = createStamper({ records, session, now })
    // 闸门按会话各一份（裁决的账按会话分列），**账本却是工作区级的那一个**（跨会话共用）
    const gate = createPermissionGate({ sink, stamper, now, rules: parsedRules.rules, grants })
    const tools = createToolRuntime({
      sandbox,
      workspace,
      gate,
      sink,
      stamper,
      // 大块转存经记录域公开面（blob 写权唯一归它）
      blobs: records.blobs,
      // **追加集**（`options.tools` 出口：机制在内、工具集在外）——两件来路：
      // ① **技能读取入口**（U33）：读的是只读材料，走 `Skills` 端口而不走沙箱，
      //    故不落在默认七件里；递进去的是**上面那一个** `skills` 实例（与对话域同源）。
      // ② **外部工具**（U38）：连上就有、断开就没有，跟着连接的实况走。
      //
      // ⚠️ **给函数、不给数组**（U38 返工 A）：外部连接是**进程级**的一束，会话链却
      // **按条建**——`--session` 那条路上链在装配期就建好了，而发现要等 `ready()`。
      // 快照会让那一条链的工具表永远停在「还没连上」的那一刻。给函数＝**每次现取**。
      tools: () => [skillTool, ...mcpTools()],
    })
    // **转发**而不是取值：注册表会在保存配置之后重建（U41），而这一束链是会话级的——
    // 抓一份快照会让已开的会话一直用旧表（同 `forwardStamper` 那条理由）。
    //
    // ⚠️ **只有注册表那一路是转发**：替身网关与缺省桩在开束时**求值一次**——
    // 替身工厂每次调用都造一个新的（`makeStage` 那个还往数组里记），开一次会话造一个
    // 是原样，**每次 `stream` 都造**会把它的进度归零（实测：Faux 的固定事件序列永远
    // 走不到头，用例挂死在等 `turn.end`）。
    const fixed = models ?? options.modelGateway?.(stamper) ?? missingGateway()
    const gateway: ModelGateway = {
      stream: (request, streamOptions) => (models ?? fixed).stream(request, streamOptions),
    }

    const service = createConversationSession({
      session,
      // **开局的模型名**——缺省连接 ＋ 它默认的模型，随每次调用送模型域
      //（技术方案：模型名取自请求）。
      // 会话中途换模型**不经过这里**：注册表的选中会在这个名字之上接管（换模型＝换接缝下游，
      // 对话域不知道发生过切换——它照旧把这一行送出去，接缝按选中改道）。
      //
      // ⚠️ **U41：可能一个都拿不到**（注册表缺席的替身网关 / 还没选过默认模型）——
      // 空串在这里是「还没定」的占位，**不是**一个可用的模型名：真送出去会被供应商拒。
      // 「没定就拒绝提交并提示先选模型」的拦截归**后端接线那一笔**（本笔先落契约与读面，
      // 见回报）；在那之前，这条路径只保证装配不因缺模型名而崩。
      model: models?.current()?.model ?? loaded.provider?.model ?? '',
      prompt: promptVarsOf(workspace, options, now),
      gateway,
      tools,
      records,
      sink,
      stamper,
      now,
      // 项目规约（U32）——域内那一半（送哪些、什么时候送）自己会造，此处只把来源递进去
      rules: projectRules,
      // 技能（U33）——同上，且**与工具域那一个入口共用同一个实例**（见 `skills` 的注）
      skills,
      // 材料（U36）——正文里的 `@文件` / `@目录` 由它按引用取（同一个实例也供 `paths.list`）
      materials,
      // 上下文策略的覆盖位（U19 的压缩阈值走这里进域；不给＝域内缺省）
      context: options.context,
      // ⚠️ **恢复不在这儿接线**（U25）——在途识别与②③④的处置归应用层（`@magic/actions`），
      // 对话域只出重建面（`ConversationService.rebuild`）。见下 `actions`。
    })

    const opened: Chain = { session, records, gate, tools, service, stamper }
    chain = opened
    activeStamper = stamper
    return opened
  }

  /**
   * **应用层的现场束**——**当下那一束**（单活跃：同时只留一束）。
   *
   * 取的是 `open` 造出来的**同一个实例**（记录实例 / 工具域 / 铸造器都在 `Chain` 里），
   * 不是另开一套：铸造器按会话实例构造、`id` 取自记录域——两套就是两串 id 打架
   * （同一张库里两串 1、2、3）。
   *
   * ⚠️ 这也是本文件里**唯一**一处为应用层写的代码：装配照旧只做「选择与绑定」
   * （技术方案 · 领域划分：「装配根照旧只做选择与绑定」），编排在 `@magic/actions`。
   */
  const actionPorts = (): SessionPorts => {
    const current = active()
    return {
      session: current.session,
      records: current.records,
      tools: current.tools,
      stamper: current.stamper,
    }
  }

  /** 装配期就该定好的事——走到这儿＝`modelGateway` 给了却是空的（类型上的不可能）。 */
  function missingGateway(): never {
    throw new Error('模型网关没造出来——`AssembleOptions.modelGateway` 给了空值')
  }

  /** 当下这束——路由转发用（`open` 至少跑过一次，见 `createConversationService` 的构造）。 */
  const active = (): Chain => {
    if (chain === undefined) throw new Error('会话链还没开——装配次序错了')
    return chain
  }

  // **会话主面**——`ConversationService` 的落地（U16）：持活跃会话、转发控制面命令。
  // 记录域端口：目录与首条消息都按会话 id 取（`readEntries(sessionId)`），
  // 故这条实例绑哪条会话都一样——给开局那条即可。
  const conversation = createConversationService({
    session: startup,
    open,
    // 记录域**读面**（窄口）：会话未定时也要能读（目录 / 首条消息 / 重建展示）
    records: recordsStore,
    setTitle: (session, title, at) => recordsStore.setSessionTitle(session, title, at),
    sink,
    now,
  })

  /**
   * **应用层**（U25）——编排那一层的落地：恢复是它的第一个真用例。
   *
   * 绑三件：**对话域端口**（⑤ 的重建面）· **扇出**（它不自己发事件）· **时钟**。
   * 会话级的那几件（记录实例 / 工具域 / 铸造器）**不在这儿**——按调用给（`actionPorts`），
   * 因为它们随会话实例各一份（「不持状态」正在于此）。
   *
   * ⚠️ `idempotent` **不传**：`ToolSpec` 没有幂等声明位，「幂等 → 静默重放」无从判定
   * ⇒ 首站**一律交用户裁决**（技术方案 · 记录 · 恢复②的 2026-09-19 裁决）。缺省从严。
   */
  const actions = createActions({ conversation, sink, now })

  /**
   * 换模型 —— **判别式处置**（技术方案 · 领域划分：「切不动就不动」）。
   *
   * **成败都发一条 `model.switched`**（**落库**）——切换是**会话的可观测事实**：
   * 「何时改的、改成了谁、没改成是为什么」三件都得能回看，而 `model.call.start` 只说得出
   * 「这次用了谁」那一面。外壳据它即时呈现（成了报一句、没成报缘由）。
   *
   * 注：状态行的**最终真相**仍是 `model.call.start`（「真跑过的那一格」）——两条事件同源于
   * 注册表，不会分叉；前者是「改了什么」，后者是「用了什么」。
   *
   * 第 17 轮这里曾借兜底 kind `error` 顶上（「不为一条消息长一个新 kind」）——规划侧裁决
   * **改判**：`error` 的语义是「内核**自身异常**」，与「用户命令不成立」不是一类，
   * 混用会污染观测；且切换这件事 `model.call.start` 说不了（它只说「这次用了谁」）。
   *
   * ⚠️ **两条入口、一条产出路径**（缺陷 D16）——命令面（`model.switch`）与 `--script`
   * 的 `{switch}` **都走这一个函数**：产事件这件事只在这一处发生，谁调都一样落库。
   * 第 17 轮曾把两者判为「两条入口、不收拢」，于是脚本那条**直调注册表** ⇒ 库里缺一笔
   * `model.switched`。收拢的是**产出**，不是入口——入口仍两条（一个是产品路径、一个是
   * 验收装置的方便），但那不再是「留不留痕」的分叉。
   */
  const switchModel = (request: ModelSwitchRequest): ModelSwitchResult => {
    // **还没有会话**（空手打开就 `/model`，第 19 轮起这是常态）——选中**照换**：
    // 注册表是**进程级**的（选中的供应商不该随会话漂），换完第一条消息就用新条目。
    //
    // 但**不发事件**：`model.switched` 记的是**会话的可观测事实**，而没有会话就没有
    // 可记之处（信封必带会话 id、铸造器按会话实例构造——`forwardStamper` 会抛）。
    // 真相不会丢：第一次调用时 `model.call.start` 带上真选中，状态行随之更正。
    // ⚠️ 代价如实记：这一下（含「条目名写错」）在屏上**没有回声**——见回报「待决」。
    if (chain === undefined) {
      return models?.use(request) ?? { ok: false, reason: NO_REGISTRY }
    }

    // 注册表缺席（注入了替身网关）＝如实报「这批装配换不了模型」——同样是一条**切换结果**
    if (models === undefined) {
      const missing: ModelSwitchResult = { ok: false, reason: NO_REGISTRY }
      sink.emit(forwardStamper.stamp('model.switched', missing))
      return missing
    }

    const result = models.use(request)

    // **结果落库**（技术方案 · 记录 · kind 族）：切换是会话的**可观测事实**——
    // `model.call.start` 只说「这次用了谁」，说不出「何时改的、为什么没改成」。
    // 成了＝带上落地后的选中；没成＝原选原样保留（切不动就不动），只说缘由。
    // 盖章走**转发铸造器**（U16）：注册表是进程级的，事件要落在**当下那条会话**上。
    sink.emit(
      result.ok
        ? forwardStamper.stamp('model.switched', {
            ok: true,
            provider: result.selection.provider,
            model: result.selection.model,
          })
        : forwardStamper.stamp('model.switched', { ok: false, reason: result.reason }),
    )

    return result
  }

  /**
   * 模型条目表 —— 读面的**产出路径**（缺陷 D10 · 第 3 样）。
   *
   * **为什么要经过一层「借会话」**：信封必带会话（契约 · `EventEnvelope`），而注册表是
   * **进程级**的（选中的供应商不随会话漂——见 `forwardStamper` 的注）。于是「还没有会话」
   * 这个**常态**（D4：启动＝新会话，空手打开）也得答得出来：走法照 `session.list` 的
   * 先例——**空手也照答，那一下开一张空壳**（对话域 `current()` 的既有姿势）。
   *
   * `handle` 的**开壳与铸造器就位是同步的**（`fresh` → 装配的 `open` 一路没有 await），
   * 故这里不必等它那条 `session.state` 答复就能盖章；那条答复异步随后到，不影响本事件。
   * 空壳**不列进会话目录**（目录只列落过账的）——不把列表塞满空壳（D5）。
   *
   * 注册表缺席（注入了替身网关）＝如实报一句，**不是**静默空表：空表本身就是合法的
   * 读数（`providers` 可以一条都没有），两者混作一谈会让外壳把「没有注册表」显示成
   * 「一条都没有」。
   */
  const listModels = (note?: string): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    const catalog = catalogOf(models)
    sink.emit(requireActiveStamper().stamp('model.catalog', note === undefined ? catalog : { ...catalog, note }))
  }

  /**
   * **技能目录** —— 读面的**产出路径**（U33 · 终端入口）。
   *
   * 与 `listModels` 逐条同法（空手打开也照答——那一下开一张空壳；原因与姿势见它那段注），
   * 只有一处不同：**每次现扫**。注册表在内存里，读它不花什么；技能是一棵**随用户编辑变的
   * 目录树**，缓存一份就等于给「有哪些技能」另立一个会过期的真源。发现面本来就是现扫的
   * （`Skills.discover`），这里只是**每次按都问它一次**。
   *
   * ⚠️ **只搬元数据**（名称 / 简述 / 身份 / 来源标签）——**不搬正文**：外壳列个候选不该把
   * 仓库里所有技能的主文读一遍，主文到真实提交那一刻才取（见契约 `SkillCatalogRow`）。
   */
  const listSkills = (): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('skills.catalog', skillCatalogOf()))
  }

  /**
   * 技能目录 → 契约载荷——**照列一排**（不把端口形态直接推上事件面）。
   *
   * 由头同 `catalogOf` 的改名那一层：端口形态是**发现面**的形态，事件面是**读出来的那几格**
   * ——两处同形是此刻的实情，不是承诺。照列一排，将来端口那边多出一格（如某个新的诊断位）
   * 时，它不会**悄悄**跟着上线路。
   */
  /**
   * **路径候选** —— 读面的**产出路径**（U36 · 正文里的 `@`）。
   *
   * 与 `listSkills` 同法（空手打开也照答——那一下开一张空壳；原因与姿势见它那段注），
   * 两处不同：
   * - **异步**——它真要看一眼目录（`Materials.candidates`）；答复到达时外壳自己认领
   *   （`paths.catalog` 带回 `query`）；
   * - **一次问一次**——`@` 之后每改一个字问一次，这一条就是那一下的现况。
   *
   * ⚠️ **只列候选，不读内容、不授权**：选定（回车把引用放进正文）才是用户的动作，
   * 材料到提交那一刻才读（见契约 `PathList`）。
   */
  const listPaths = async (query: string): Promise<void> => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })

    const found = await materials.candidates(query, DEFAULT_CANDIDATES)

    sink.emit(
      requireActiveStamper().stamp('paths.catalog', {
        query,
        rows: found.rows.map((row) => ({
          path: row.path,
          display: row.display,
          kind: row.kind,
          external: row.external,
        })),
        ...(found.note === undefined ? {} : { note: found.note }),
      }),
    )
  }

  const skillCatalogOf = (): EventDataOf['skills.catalog'] => {
    const found = skills.discover()

    return {
      skills: found.skills.map((one) => ({
        name: one.name,
        description: one.description,
        path: one.path,
        label: one.label,
        source: one.source,
        origin: one.origin,
      })),
      problems: found.problems.map((one) => ({
        path: one.path,
        message: one.message,
        kind: one.kind,
      })),
    }
  }

  /**
   * 模型条目表 —— 注册表 → 契约载荷。
   *
   * 这一层只做**改名**（`id` → `provider`）与**缺席位的转发**：域内叫「条目 id」，事件面上
   * 叫「条目名」（`model.call.start` / `model.switched` 都是 `provider`，同一件事一个词）。
   * `contextWindow` **有没有就带不带**——没声明就不给这一位（外壳拿不到就不显示，不编）。
   */
  /**
   * ④ 的开局分母——**一次选中**的窗长（见 `Assembly.contextWindow`）。
   *
   * 判定与取表全在模型域（`windowOfSelection`）：条目对上就用它声明的数，否则查内置表，
   * 两处皆无＝`null`。本函数只做**取当下那一次选中**这件事。
   *
   * 取 `current()` 而不是 `defaultProviderId()`：`--provider` / `--model` 是**开局就落地**
   * 的选中（见 `cli.ts` 那段注），故开屏那一刻要报的是**它**的窗，不是缺省条目的。
   *
   * ⚠️ 选中是**两件**（条目 ＋ 模型）——`--model` 换到同条目的另一个模型时，
   * 那份**属于该条目自己模型的**声明不跟过去（查内置表；查不到就是 `null`）。
   */
  const contextWindowOf = (registry: ModelRegistry | undefined): number | null => {
    if (registry === undefined) return null

    // 还没有去向（没配缺省连接 / 还没选过模型）⇒ **没有分母可言**——不取列表第一项，
    // 也不拿别的模型的窗长顶上（「拿不到的不编」）
    const current = registry.current()
    if (current === undefined) return null

    return windowOfSelection(windowTable, current)
  }

  /**
   * **授权名录**（U22）——`/grants` 的读侧答复。
   *
   * 走法照 `listModels`：**空手打开也照答**（那一下开一张空壳）——原因同它：
   * 信封必带会话，而 `grants.list` 在「还没有会话」时就会被按到（`/grants` 是最先想看的东西
   * 之一）。空壳不列进会话目录（目录只列落过账的），故不违 D5。
   *
   * ⚠️ `handle` 的开壳与铸造器就位是**同步**的（`fresh` → 装配的 `open` 一路没有 await），
   * 故这里不必等它那条 `session.state` 答复就能盖章（同 `listModels` 那段注）。
   */
  const listGrants = (note?: string): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('grants.catalog', grantsCatalogOf(note)))
  }

  /**
   * 名录 ＋ 陈旧的节 ＋ 两笔账（本会话 / 历史累计）—— `grants.catalog` 的载荷。
   *
   * `decisions` 取**当下这一束**闸门的账（裁决按会话分列——切了会话就是另一本账，
   * 与「本会话」这个措辞一致）；那一屏要是空手打开的那张壳，账自然全是 0。
   *
   * `history`（U28）取**记录域的读面**——**跨会话**那笔账：闸门按会话实例构造，
   * 故它只答得了「这一趟」；「这个项目值不值得配规则」得看库里那些（见 `DecisionHistory`）。
   * **每次现读**（不在这儿攒）：裁决是随打随落的，攒一份就等于给「历史」另立一个真源。
   */
  const grantsCatalogOf = (note?: string): EventDataOf['grants.catalog'] => {
    const view = grantsView()
    // 三句话合成一句：调用方给的那句 · 落盘失败（见 `grantsWriteError`）——都没事时不给 `note`
    const said = [note, grantsWriteError].filter((line): line is string => line !== undefined)

    return {
      workspace: view.workspace,
      grants: view.grants,
      stale: view.stale,
      decisions: active().gate.tally(),
      history: recordsStore.decisionHistory(),
      ...(said.length === 0 ? {} : { note: said.join('；') }),
    }
  }

  /**
   * **撤销**（U22）——`index` 给了撤一条（选定即撤）；不给＝**整节撤掉**（陈旧节那条路）。
   *
   * 撤完**再回一份名录**（同一个 kind）：外壳据以刷新抽屉，并把 `note` 那一句留成一行回执
   * ——这正是「撤销＝选定即撤 ＋ 一行回执」那一句规格的落点。
   */
  const revokeGrants = (section?: string, index?: number): void => {
    const target = section ?? workspace.defaultRoot()

    if (index === undefined) {
      const dropped = grants.dropSection(target)
      listGrants(
        dropped === 0
          ? `没撤成：${target} 那一节不在名录里`
          : `已撤销整节：${target}（${dropped} 条）`,
      )
      return
    }

    // 回执要报出**撤掉的是哪一条**——名录得在撤销**之前**取（撤完它就没了）。
    // 只有撤**本工作区**时才取得到：`view()` 读的就是本工作区那一节，
    // 撤别处（陈旧节那条路走的是 index 缺省，到不了这里）时如实说「那一条」而不编名字
    const named =
      target === workspace.defaultRoot() ? grants.view()[index]?.describe : undefined
    const done = grants.revoke(target, index)

    listGrants(done ? `已撤销：${named ?? '那一条'}` : '没撤成：那一条已经不在了')
  }

  /**
   * **外部服务器的一屏**（U39）——`/mcp` 的读侧答复。
   *
   * 走法照 `listGrants`：**空手打开也照答**（信封必带会话，而 `/mcp` 在还没有会话时就会被
   * 按到——那一下开一张空壳，不列进会话目录）。
   *
   * 读的是连接自己的当下值（`state` / `tools()` / `rejected`）——**不另立一本账、不后台轮询**。
   * 地址与 `headers` 不上这一屏（见契约 `McpCatalogRow`）。
   */
  const listMcp = (note?: string): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('mcp.catalog', mcpCatalogOf(note)))
  }

  /**
   * 那一屏的读数 —— `Assembly.mcpServers` 与 `/mcp` 的答复**同一处产出**
   * （查询面一处：`--check` 那一行与那一屏说的是一句话）。
   *
   * 工具名取**服务器那边报的**（未加前缀）：注册名由工具域合成，这一屏报的是
   * 「服务器自己有哪些东西」（对得上服务器自己的文档）。
   */
  const mcpServers = (): readonly McpServerView[] =>
    mcp.connections.map((connection) => ({
      server: connection.server,
      transport: connection.transport,
      state: connection.state,
      tools: connection.tools().map((tool) => tool.name),
      rejected: connection.rejected,
    }))

  /** 那一屏 → 契约载荷（照列一排：端口形态到此为止，事件面只出现读得出来的那几格）。 */
  const mcpCatalogOf = (note?: string): EventDataOf['mcp.catalog'] => ({
    servers: mcpServers(),
    ...(note === undefined ? {} : { note }),
  })

  /**
   * **显式重连一台**（U39）——重走一趟起手与发现，**不重放任何业务调用**。
   *
   * 认不出的名字不当作错误：名录照给，缘由写在答复的 `note` 上（那一屏照旧说得出全部内容）。
   */
  const reconnectMcp = (server: string): void => {
    // 重连本身是异步的（起手有界），故**先开壳、后重连**：那一份名录由重连落定之后再发
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })

    void mcp.reconnect(server).then((connection) => {
      if (connection === undefined) {
        listMcp(`没有配这一台：「${server}」——配置里 mcp.servers 的条目名才是身份`)
        return
      }

      // ⚠️ **回执按最终状态说**，不按「找到了这一台」：重连真的走了一趟，而它落到
      // 「可用」还是「不可用」是两件事——要认证的对端连完照样不可用，那却说「已重连」
      // 就是这一屏自己跟自己打架（那一句缘由就在同一屏的明细里）。
      // 只报**这一趟的结果**，不复述状态：那一台可不可用就在同一屏的读数里
      // （窄窗下再写一遍「仍不可用」是多占两行、说同一件事）
      listMcp(
        connection.state.status === 'available' ? `已重连「${server}」` : `重连没成：「${server}」`,
      )
    })
  }

  /** 项目规约的按需读数——见 `Assembly.readRules`。 */
  const readRules = (targets: readonly string[] = []): RulesLoad => projectRules.load(targets)

  /** 技能目录的按需读数——见 `Assembly.readSkills`。 */
  const readSkills = (): SkillCatalog => skills.discover()

  /**
   * 连接一览 —— `model.catalog` 与 `provider.catalog` **共用的一份**（U41）。
   *
   * 两个读面说的是同一批连接，故只产出一次：选择器与「管理供应商」那一屏看到的
   * 「这条连接叫什么、走哪家、默认用哪个模型」必须是同一份，不能两处各拼一遍。
   *
   * 一位一位地**有才给**（`name` / `vendor` / `region` / `baseURL` / `model` / `reasoning`
   * / `contextWindow`）：缺的那一位＝**不知道或没设置**，外壳据此少显示一格，不显示空串。
   */
  /**
   * 认证的**来处**（U41）——`config`（配置文件里写了 `apiKey`）｜ `env`（回退环境变量）。
   *
   * ⚠️ **给的是来处，不是凭据**：判据只看「有没有」与「从哪来」，值一个字符都不出这一层
   *（管理页据它说「认证：配置文件 / 环境变量」，而不是含糊的「已设置」）。
   */
  const keySourceOf = (
    id: string,
    config: ProviderConfig | undefined,
  ): 'config' | 'env' | undefined => {
    if (config?.apiKey !== undefined && config.apiKey.trim().length > 0) return 'config'
    const fromEnv = process.env[apiKeyEnvVarOf(id)]
    return fromEnv !== undefined && fromEnv.trim().length > 0 ? 'env' : undefined
  }

  const catalogRows = (registry: ModelRegistry | undefined): readonly ModelCatalogRow[] => {
    if (registry === undefined) return []

    return registry.list().map((entry) => {
      const config = providerBook[entry.id]
      return {
        provider: entry.id,
        ...(config?.name === undefined ? {} : { name: config.name }),
        ...(config?.vendor === undefined ? {} : { vendor: config.vendor }),
        ...(config?.region === undefined ? {} : { region: config.region }),
        ...(config?.baseURL === undefined ? {} : { baseURL: config.baseURL }),
        ...(entry.model === undefined ? {} : { model: entry.model }),
        ...(config?.reasoning === undefined ? {} : { reasoning: config.reasoning }),
        ...(keySourceOf(entry.id, config) === undefined
          ? {}
          : { keySource: keySourceOf(entry.id, config) }),
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
        // 缓存读数（U41）——**有才给**：空对象（还没取过、兼容接入）就不给这一位
        ...(Object.keys(modelInfo.read(entry.id)).length === 0 ? {} : { cache: modelInfo.read(entry.id) }),
      }
    })
  }

  const catalogOf = (registry: ModelRegistry | undefined): EventDataOf['model.catalog'] => {
    if (registry === undefined) return { entries: [], note: NO_REGISTRY }

    const current = registry.current()
    return {
      entries: catalogRows(registry),
      // 还没有去向（没配缺省连接 / 还没选过模型）⇒ **不给这一位**——外壳报「先选模型」，
      // 不拿列表第一项当成「当前」（设计明文）
      ...(current === undefined ? {} : { current }),
    }
  }

  /**
   * `provider.catalog` 的载荷——与 `model.catalog` 同一份行（见 `catalogRows`）
   * ＋ **内置供应商与官方区域**（U41 返修）。
   *
   * 后者是**适配现取的**（`vendorCatalog()`），不是装配这一层另存的一张表：
   * 官方信息只有一个出处，界面接入选供应商 / 区域时读的就是它。
   */
  const providerCatalogOf = (note?: string): EventDataOf['provider.catalog'] => ({
    entries: catalogRows(models),
    vendors: vendorCatalog(),
    ...(note === undefined ? {} : { note }),
  })

  /**
   * **管理面的连接一览**（U41）——`/model` 的「管理供应商」那一屏。
   *
   * 走法照 `listModels`：**空手打开也照答**（那一下开一张空壳；原因与姿势见它那段注）。
   * 读的是**配置**（连接的身份与设置）——已在手上，不必再问谁要。
   */
  const listProviders = (note?: string): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('provider.catalog', providerCatalogOf(note)))
  }

  /** 取文件的 `mtimeMs`（拿不到＝`undefined`——保存前那次比对据此跳过）。 */
  const mtimeOf = (path: string): number | undefined => {
    try {
      return statSync(path).mtimeMs
    } catch {
      return undefined
    }
  }

  /**
   * **接入范围变了吗**——变了就该废弃那条连接的模型信息缓存（设计明文）。
   *
   * 比四件：供应商适配 · 地址 · 区域 · 认证。⚠️ 认证只在此处**比较相等性**，
   * 不进任何文案、不入快照、不落日志（「凭据只进不出」）。
   */
  const scopeChanged = (
    before: ProviderConfig | undefined,
    after: ProviderConfig | undefined,
  ): boolean => {
    // 新建 / 移除：一律作废（那是另一条连接的缓存，留着没有用）
    if (before === undefined || after === undefined) return true

    return (
      before.vendor !== after.vendor ||
      before.baseURL !== after.baseURL ||
      before.region !== after.region ||
      before.apiKey !== after.apiKey
    )
  }

  /**
   * **显式刷新模型信息**（U41）——绕开有效期与失败冷却（那是用户明确的要求，不是自动重试）。
   *
   * 答复走 `model.catalog`：**先回旧缓存那一屏**，刷新完成后再由 `modelInfo` 的
   * `onChange` 发一屏（成或不成都有话说）。**不硬闯**：`refresh` 自己会等冷却。
   */
  const refreshModels = async (provider?: string): Promise<void> => {
    const target = provider ?? models?.current()?.provider ?? defaultProviderId
    if (target === undefined) {
      listModels('还没有可刷新的连接——先接入一个供应商')
      return
    }
    if (!modelInfo.canFetch(target)) {
      listModels(`「${target}」是兼容接入——它没有模型列表接口，取不到可刷新的东西`)
      return
    }

    listModels()
    await modelInfo.refresh(target)
  }

  /**
   * **设为默认**（U41）——写**配置里的默认选择**，与 `model.switch` 改当下那一件分开。
   *
   * 写盘成功才动内存真源（失败保留原样，缘由交回答复）；重建注册表让新默认立刻生效。
   */
  const setDefaultModel = (request: ModelDefaultRequest): void => {
    const outcome = setModelDefault({
      path: loaded.path,
      ...(configMtime === undefined ? {} : { loadedAt: configMtime }),
      request,
    })
    if (!outcome.ok) {
      listModels(outcome.reason)
      return
    }

    configMtime = mtimeOf(loaded.path)
    providerBook = {
      ...providerBook,
      [request.provider]: {
        ...providerBook[request.provider],
        model: request.model,
        ...(request.reasoning === undefined ? {} : { reasoning: request.reasoning }),
      },
    }
    defaultProviderId = request.provider

    const rebuilt = rebuildRegistry()
    listModels(rebuilt.ok ? undefined : rebuilt.reason)
  }

  /**
   * **保存一条连接**（接入 / 改名 / 更新认证 / 改地址）——落盘 → 读回来 → 换内存真源。
   *
   * 「读回来」这一步不是多余：它用的是**加载器同一把尺子**（形制 · `~` 展开 · 必填项），
   * 写进去的东西必须读得回来才算成了。
   */
  const saveProviderCommand = (request: ProviderSaveRequest): void => {
    const before = providerBook[request.provider]

    const outcome = saveProvider({
      path: loaded.path,
      ...(configMtime === undefined ? {} : { loadedAt: configMtime }),
      request,
    })
    if (!outcome.ok) {
      listProviders(outcome.reason)
      return
    }

    configMtime = mtimeOf(loaded.path)

    let reloaded: LoadedConfig
    try {
      reloaded = loadConfig({ path: loaded.path, home: options.home ?? homedir() })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      listProviders(`配置已写盘，但读不回来：${reason}`)
      return
    }

    providerBook = reloaded.config.providers
    defaultProviderId = reloaded.providerId

    // **认证或接入范围改变 ⇒ 废弃该连接的旧缓存及在途获取**（设计明文）
    if (scopeChanged(before, providerBook[request.provider])) {
      modelInfo.drop(request.provider)
      void modelCache.drop(request.provider)
    }

    const rebuilt = rebuildRegistry()
    listProviders(rebuilt.ok ? undefined : rebuilt.reason)
  }

  /**
   * **移除一条连接**（U41）——**不静默级联**（设计：「有引用先替换或取消」）。
   *
   * 拦在装配这一层的是「**正在用的那条**」：那是本次装配的实况（`current()`），
   * 配置层拦的是「它是默认」（那在文件里）。两处各拦一半，合起来才是「有引用先处理」。
   * 已发生的记录不随移除而删除（那是记录域的事，本命令碰都不碰）。
   */
  const removeProviderCommand = (provider: string): void => {
    if (models?.current()?.provider === provider) {
      listProviders(`「${provider}」正在用——先换到别的连接再移除它`)
      return
    }

    const outcome = removeProvider({
      path: loaded.path,
      ...(configMtime === undefined ? {} : { loadedAt: configMtime }),
      provider,
    })
    if (!outcome.ok) {
      listProviders(outcome.reason)
      return
    }

    configMtime = mtimeOf(loaded.path)

    const next = { ...providerBook }
    delete next[provider]
    providerBook = next
    if (defaultProviderId === provider) defaultProviderId = undefined

    modelInfo.drop(provider)
    void modelCache.drop(provider)

    const rebuilt = rebuildRegistry()
    listProviders(rebuilt.ok ? undefined : rebuilt.reason)
  }

  // ── 4 命令路由 → 各域（`input.submit` / `turn.interrupt` / `session.*` → 对话域；
  //                      `decision.answer` → 权限域；`model.switch` → 装配）──
  hub.bind({
    onInput: (input) => conversation.submit(input),
    onInterrupt: () => conversation.interrupt(),
    // 答复**原样转手**（含「总是允许」位）——装配不解释它，落地归权限域。
    // 闸门**按会话各一份**（在途询问与裁决的账各归各的），故取当下这束的；
    // 而它记下的授权进的是**工作区级**账本（跨会话那个），两者不是一回事
    onDecision: (id, decision, opts) => active().gate.resolve(id, decision, opts),
    // 换模型（阶段 2）——**判别式处置**（技术方案 · 领域划分：「切不动就不动」）
    onModelSwitch: (request) => switchModel(request),
    // 会话四支（U16）——**原样转手**给对话域（它才是会话的持有者）
    onSession: (command) => void conversation.handle(command),
    // 读侧命令——**原样转手**给对话域（会话与条目归它）；答复走事件（`session.history`）
    onHistoryRead: (session) => void conversation.readHistory(session),
    // 模型条目表（读侧）——**归装配**（注册表在它手上，同 `model.switched` 的产出路径）；
    // 答复走事件（`model.catalog`，不落库）
    onModelList: () => listModels(),
    // 供应商与模型管理（U41）——**归装配**（配置的读写 · 缓存的落点都在它这一层，
    // 域不碰文件系统；同 `grants.list` 之于授权文件）。前三条答复走 `provider.catalog`、
    // 后两条走 `model.catalog`（用户按一下就该看到那一屏的新样子）。
    onModelRefresh: (provider) => void refreshModels(provider),
    onModelDefaultSet: (request) => setDefaultModel(request),
    onProviderList: () => listProviders(),
    onProviderSave: (request) => saveProviderCommand(request),
    onProviderRemove: (provider) => removeProviderCommand(provider),
    // 授权名录 ＋ 撤销（U22）——**归装配**（`grants.json` 的读写都在它这一层，域不碰文件系统）
    onGrantsList: () => listGrants(),
    onGrantsRevoke: (workspace, index) => revokeGrants(workspace, index),
    // 技能目录（读侧 · U33）——**归装配**（执行域的发现面是它组起来的，同 `model.list`
    // 之于注册表、`grants.list` 之于授权文件）；答复走事件（`skills.catalog`，不落库）
    onSkillList: () => listSkills(),
    // 路径候选（读侧 · U36）——**归装配**（它握着执行域的路径面，同技能目录那一处）；
    // 答复走事件（`paths.catalog`，不落库）。**异步**：它要真去看一眼目录。
    onPathList: (query) => void listPaths(query),
    // 外部服务器（读侧 ＋ 显式重连 · U39）——**归装配**（那一束连接是它编排的，同
    // `model.list` 之于注册表）；答复走事件（`mcp.catalog`，不落库）
    onMcpList: () => listMcp(),
    onMcpReconnect: (server) => reconnectMcp(server),
  })

  // ── 5 接传输（内核侧一端）——外壳侧一端随返回值交出去 ────────────────
  const { kernel, shell } = createInProcessTransportPair()
  hub.attach(kernel)

  return {
    shell,
    // **活跃**那条（切换之后跟着变）——**`undefined` ＝ 还没有会话**（空手打开，
    // 首条消息才开张）。不是开局那条（`Assembly.session` 的旧义）。
    get session(): SessionId | undefined {
      return conversation.active()
    },
    config: loaded,
    models,
    modelInfo,
    switchModel,
    records: recordsStore,
    paths: recordsStore.paths,
    permissionRules: parsedRules.rules,
    rejectedRules: parsedRules.rejected,
    grantsPath,
    grantsView,
    readRules,
    readSkills,
    // **现读**（见 `Assembly.notices` 的注）：外部服务器连不上那一条要等 `ready()` 才落定，
    // 而这一位在放开输入之前（`boot`）与自检（`--check`）两处都会被读——快照会在前一处漏话。
    get notices(): readonly string[] {
      return noticesOf(
        parsedRules.rejected,
        loadedGrants.note,
        loaded.path,
        readRules().problems,
        mcp.connections,
      )
    },
    mcpServers,
    // 发现那一跳（见 `Assembly.ready`）：空转（没配服务器）时一步就完
    //
    // 顺带**预热模型信息缓存**（U41）：启动时把盘上那份读回内存——读面（同步）才有东西可给。
    // 缺文件 / 损坏都只是「还没有」，不是错。
    ready: async () => {
      await modelInfo.warmup()
      await mcp.ready()
    },
    // 释放自有子进程（见 `Assembly.shutdown`）——幂等，收尾路径可以走两遍
    shutdown: () => mcp.shutdown(),
    // **当下**那一条的窗（不是装配那一刻的快照）——理由同下面 `session` 那个取值器：
    // `--provider` / `--model` 是**开局就落地**的选中（`cli.ts` 在起外壳之前先跑 `applySwitch`），
    // 快照会把缺省条目的数报成选中条目的——**报错一个数比不报更坏**。
    get contextWindow(): number | null {
      return contextWindowOf(models)
    },
    // 窗长表（U30）——注册表缺席＝空表（不知道有哪些模型的窗长，同 `contextWindow` 的 `null`）
    windowTable,
    workspaceRoots: workspace.roots(),
    // **没有会话就不跑恢复**：空手打开没有在途可处置，跑了反而要铸一个 id 才有信封——
    // 那正是 D5 要免掉的。显式接续（`startup` 给了 id）时才跑。
    //
    // **跑的是应用层的用例**（U25）：① 在途识别 ②③④ 处置 ⑤ 上下文由条目重建 ＋ 界面重建展示，
    // 全在 `@magic/actions` 那一处编排。回到 `Promise<void>`：报告是应用层的形态，
    // 要看细节请直接调 `actions.recover`（本函数只担保「跑完了」）。
    boot: () =>
      startup === undefined ? Promise.resolve() : actions.recover(actionPorts()).then(() => undefined),
    close: () => {
      // 攒着的记账（命中统计）在这儿补落一次——**授权本身早写过了**（`onChange` 那条路），
      // 故这里失败也只是统计没落上（`saveGrants` 抛就抛出去：收尾那条路上没人能应答它，
      // 静默吞掉反而让人以为写成了）
      if (grantsDirty) saveGrants(grantsPath, grants.snapshot())
      recordsStore.close()
      // **发起**外部服务器的释放（不等：收尾这一跳是同步的，等它要 `await shutdown()`）。
      // 放在最后：先落自己的账，再去收子进程。忘了 await 也不至于把它们留下——
      // 这一下已经把「关 stdin」按下去了（服务器收到 EOF 就自己退，那是规范里的头号信号）。
      void mcp.shutdown()
    },
  }
}

/**
 * 启动那几句话（`Assembly.notices` · U22 · 审计第 13 条）——**空数组＝一句都不说**。
 *
 * 三条都只说「有几条没生效、去哪儿看」，**不在这里复述缘由**：缘由在 `--check` 里逐条列着
 * （那才是对着改的地方），屏上那行回执只要把人指过去。
 *
 * **项目规约（U32）为什么也在这儿**——它同属「解析从严、不生效」那一类（读不懂的
 * front-matter、没配来源的外部符号链接、超限、目录读不动、同目录 AGENTS 与 CLAUDE 的取舍）：
 * 用户写了一份规约**却一条都没生效**，走界面这条路时原先会**一声不响**——那正是这条通道
 * 立起来的理由（审计第 13 条）。规约出问题的概率比权限规则还高：它是一堆人各自在加的散文件。
 *
 * **外部服务器连不上（U38）为什么也在这儿**——设计明文：「单个连接失败**显示**该连接不可用，
 * 不拖垮内置工具」。显示在哪儿？`/mcp` 那一屏归 U39，而 U38 需要的正是**开屏那一句**：
 * 用户配了一台服务器、盼着它的工具出现，结果一件都没有、还一声不响——那是最让人对着
 * 空气发呆的一种失败。故这里**点名到服务器**（`--check` 那一行给全貌）。
 */
function noticesOf(
  rejectedRules: readonly RuleProblem[],
  grantsNote: string | undefined,
  configPath: string,
  rulesProblems: readonly RulesProblem[],
  connections: readonly McpConnection[],
): readonly string[] {
  const said: string[] = []

  if (rejectedRules.length > 0) {
    said.push(
      `配置里有 ${rejectedRules.length} 条权限规则读不懂（未生效）——${configPath}（\`--check\` 看缘由）`,
    )
  }
  // **只数「坏了」那一类**（2026-09-20 裁）：取舍那类（原生顶掉同名的兼容规则、AGENTS
  // 顶掉 CLAUDE）是**产品按设计做的选择**——为它每次开屏报一句就是噪音，而它**不是故障**。
  // 用户要查「我写的那份为什么没在管」，`--check` 里逐条列着（口径同权限规则那句）。
  const broken = rulesProblems.filter((problem) => problem.kind === 'error')
  if (broken.length > 0) {
    said.push(`项目规约里有 ${broken.length} 条没能加载（\`--check\` 看缘由）`)
  }
  // 连不上的那几条**各说一句**（不与别的并成一句：这一条要能一眼看出是哪台服务器）
  for (const connection of connections) {
    if (connection.state.status !== 'unavailable') continue
    said.push(
      `外部工具服务器「${connection.server}」连不上：${connection.state.reason}` +
        '——本次它的工具不可用（内置工具不受影响）',
    )
  }
  // 有工具被拒收也说一句（返工 B）——**说清「没进来几件」并把人指去 `--check`**：
  // 拒收是**服务器那边**的毛病（名字不合规 / 重名），不说的话用户只会觉得「少了几件工具」
  for (const connection of connections) {
    if (connection.rejected.length === 0) continue
    said.push(
      `外部工具服务器「${connection.server}」有 ${connection.rejected.length} 件工具没能收下` +
        '——名字不合规或与同台重名（`--check` 看缘由）',
    )
  }
  if (grantsNote !== undefined) said.push(grantsNote)

  return said
}

/** 目录还在不在——陈旧节的判据（`B11`：「路径已不在 → 你删或留」）。 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 提示词注入项 —— 三段齐（缺项由对话域构造期报错，此处只管取值）。
 *
 * `cwd` 取**工作区注册根**（执行域构造时 `realpath` 过的那些），**不是**装配入参的原值：
 * 两处一旦分叉，提示词说的目录与沙箱认的目录就不是一回事了（macOS 上 `/var/…` 与
 * `/private/var/…` 就是现成的反例——U11 自验时冒烟当场抓到）。故根的权威**只有一个**：
 * 执行域给的注册根；此处不设覆盖位，免得又长出一条分叉路。
 */
function promptVarsOf(
  workspace: WorkspaceService,
  options: AssembleOptions,
  now: () => Timestamp,
): PromptVars {
  return {
    cwd: workspaceLineOf(workspace),
    platform: options.prompt?.platform ?? process.platform,
    date: options.prompt?.date ?? localDate(now()),
  }
}

/**
 * 「工作目录」那一行的值 —— **报全根列表**（U27 · `U18` 待决 5）。
 *
 * 由头：多根下模型**不知道另几条根存在**——只有当它给出越界绝对路径时才从报文里知道
 * ⇒ **一开始就报全**：一行提示词的成本，换少撞几次越界。
 *
 * 单根＝光那条路径（**不为多根这条功能给单根长噪音**——单根是常态，提示词每一行都占注意力）；
 * 多根＝把**默认根**标出来（相对路径与新文件落它）、其余根在列。措辞与入口自检那一行
 * （`cli.ts` · `describeRoots`）同词——同一个事实在哪儿都说同一句话。
 */
function workspaceLineOf(workspace: WorkspaceService): string {
  const roots = workspace.roots()
  const first = roots[0] as string // 注册面保证 ≥ 1 条（空列表在执行域已被拒）
  const rest = roots.slice(1)

  return rest.length === 0
    ? first
    : `${first}（默认根——相对路径与新文件落它） · 另注册：${rest.join(' · ')}`
}
