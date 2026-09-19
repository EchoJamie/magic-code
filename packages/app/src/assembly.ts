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

import type {
  ControlTransport,
  EventDataOf,
  EventKind,
  EventSink,
  EventStamper,
  KernelEvent,
  ModelGateway,
  ModelSwitchRequest,
  RecordsService,
  SessionId,
  Timestamp,
  TurnId,
  WorkspaceService,
} from '@magic/contracts'
import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
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
import { createSandbox, createWorkspaceService } from '@magic/execution'
import type { FetchLike, ModelRegistry, ModelSwitchResult } from '@magic/model'
import { createModelRegistry } from '@magic/model'
import { createPermissionGate, parseRules } from '@magic/permission'
import type { PermissionRule, RuleProblem } from '@magic/permission'
import { createRecordsStore } from '@magic/records'
import type { RecordsStore } from '@magic/records'
import { createToolRuntime } from '@magic/tools'
import type { LoadedConfig } from './config.ts'
import { ConfigError, loadConfig } from './config.ts'

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
}

/** 装配产物——外壳侧一端 ＋ 自检 / 验收要用的把手。 */
/** 注册表缺席时那条切换结果的缘由（注入了替身网关＝这批装配换不了模型）。 */
const NO_REGISTRY = '本次装配没有供应商注册表（注入了替身网关）'

export type Assembly = {
  /**
   * **换模型**——装配侧的**唯一**切换入口：命令面（`model.switch`）与 `--script` 的
   * `{switch}` 都调它，**成败都发一条 `model.switched`（落库）**（缺陷 D16 收拢的产出路径）。
   * 结果原样交回调用方（脚本据以决定继续还是当场停）。
   */
  readonly switchModel: (request: ModelSwitchRequest) => ModelSwitchResult
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
  /** 库把手——收尾（`close`）与验收脚本用。 */
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
   * **当前条目**声明的上下文窗总量（`providers.<id>.contextWindow`）——状态行 ④ 的**分母**
   * （缺陷 `D10` 第 1 样；U20 留的位，本轮接上）。
   *
   * **没声明就是 `null`**——不是 0、也不是某个惯例值：`null` 让外壳**只报已用量**
   * （「拿不到的不编」是这条读数立起来时的判据）。注册表缺席（注入了替身网关）同此。
   *
   * 与 `/model` 那条来路（`model.catalog`）同源同判据——两处都由**条目自己声明的**那个数
   * 说了算，不会分叉。
   */
  readonly contextWindow: number | null
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
  /** 关库（blob 无需收尾）。 */
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

  // 模型域：provider 注册表（`providers` 加条目即多一个；`traits` 覆盖位随条目进）
  // **key 在这一步解析**——按条目各解析一次；缺省那条缺 key 即启动期抛（与单供应商时代同）
  let models: ModelRegistry | undefined
  if (options.modelGateway === undefined) {
    models = createModelRegistry({
      providers: loaded.config.providers,
      defaultProvider: loaded.providerId,
      stamper: forwardStamper,
      fetch: options.modelFetch,
    })
  }

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
   * 换会话＝换这一整束：记录实例 · 铸造器 · **闸门**（会话级「总是允许」记忆随会话各一份
   * ——「新会话即清零」，故切走再切回也不复原，与设计同源）· 工具域 · 对话实例。
   * **不缓存**旧束：「一个活跃对话实例」是结构，不是计数。
   *
   * ⚠️ 网关（注册表）**不在此列**——见 `forwardStamper` 的注。
   */
  const open = (session: SessionId): SessionInstance => {
    const records = recordsStore.serviceFor(session)
    const stamper = createStamper({ records, session, now })
    const gate = createPermissionGate({ sink, stamper, now, rules: parsedRules.rules })
    const tools = createToolRuntime({
      sandbox,
      workspace,
      gate,
      sink,
      stamper,
      // 大块转存经记录域公开面（blob 写权唯一归它）
      blobs: records.blobs,
    })
    const gateway: ModelGateway = models ?? options.modelGateway?.(stamper) ?? missingGateway()

    const service = createConversationSession({
      session,
      // **开局的模型名**——缺省条目的 `model`，随每次调用送模型域（技术方案：模型名取自请求）。
      // 会话中途换模型**不经过这里**：注册表的选中会在这个名字之上接管（换模型＝换接缝下游，
      // 对话域不知道发生过切换——它照旧把这一行送出去，接缝按选中改道）
      model: loaded.provider.model,
      prompt: promptVarsOf(workspace, options, now),
      gateway,
      tools,
      records,
      sink,
      stamper,
      now,
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
  const listModels = (): void => {
    if (conversation.active() === undefined) void conversation.handle({ type: 'session.new' })
    sink.emit(requireActiveStamper().stamp('model.catalog', catalogOf(models)))
  }

  /**
   * 模型条目表 —— 注册表 → 契约载荷。
   *
   * 这一层只做**改名**（`id` → `provider`）与**缺席位的转发**：域内叫「条目 id」，事件面上
   * 叫「条目名」（`model.call.start` / `model.switched` 都是 `provider`，同一件事一个词）。
   * `contextWindow` **有没有就带不带**——没声明就不给这一位（外壳拿不到就不显示，不编）。
   */
  /**
   * 当前条目声明的上下文窗总量——④ 的开局分母（见 `Assembly.contextWindow`）。
   *
   * 取 `current()` 而不是 `defaultProviderId()`：`--provider` 是**开局就落地**的选中
   * （见 `cli.ts` 那段注），故开屏那一刻要报的是**它**的窗，不是缺省条目的。
   */
  const contextWindowOf = (registry: ModelRegistry | undefined): number | null => {
    if (registry === undefined) return null

    const chosen = registry.current()

    return registry.list().find((entry) => entry.id === chosen.provider)?.contextWindow ?? null
  }

  const catalogOf = (registry: ModelRegistry | undefined): EventDataOf['model.catalog'] => {
    if (registry === undefined) return { entries: [], note: NO_REGISTRY }

    return {
      entries: registry.list().map((entry) => ({
        provider: entry.id,
        model: entry.model,
        ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
      })),
      current: registry.current(),
    }
  }

  // ── 4 命令路由 → 各域（`input.submit` / `turn.interrupt` / `session.*` → 对话域；
  //                      `decision.answer` → 权限域；`model.switch` → 装配）──
  hub.bind({
    onInput: (input) => conversation.submit(input),
    onInterrupt: () => conversation.interrupt(),
    // 答复**原样转手**（含「总是允许」位）——装配不解释它，落地归权限域。
    // 闸门**按会话各一份**（会话级记忆），故取当下这束的
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
    switchModel,
    records: recordsStore,
    paths: recordsStore.paths,
    permissionRules: parsedRules.rules,
    rejectedRules: parsedRules.rejected,
    // **当下**那一条的窗（不是装配那一刻的快照）——理由同下面 `session` 那个取值器：
    // `--provider` / `--model` 是**开局就落地**的选中（`cli.ts` 在起外壳之前先跑 `applySwitch`），
    // 快照会把缺省条目的数报成选中条目的——**报错一个数比不报更坏**。
    get contextWindow(): number | null {
      return contextWindowOf(models)
    },
    workspaceRoots: workspace.roots(),
    // **没有会话就不跑恢复**：空手打开没有在途可处置，跑了反而要铸一个 id 才有信封——
    // 那正是 D5 要免掉的。显式接续（`startup` 给了 id）时才跑。
    //
    // **跑的是应用层的用例**（U25）：① 在途识别 ②③④ 处置 ⑤ 上下文由条目重建 ＋ 界面重建展示，
    // 全在 `@magic/actions` 那一处编排。回到 `Promise<void>`：报告是应用层的形态，
    // 要看细节请直接调 `actions.recover`（本函数只担保「跑完了」）。
    boot: () =>
      startup === undefined ? Promise.resolve() : actions.recover(actionPorts()).then(() => undefined),
    close: () => recordsStore.close(),
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
