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
  SessionId,
  Timestamp,
  TurnId,
} from '@magic/contracts'
import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import { createConversationService } from '@magic/conversation'
import type { PromptVars } from '@magic/conversation'
import { createControlHub, createInProcessTransportPair } from '@magic/control'
import { createSandbox, createWorkspaceService } from '@magic/execution'
import type { FetchLike, ModelRegistry } from '@magic/model'
import { createModelRegistry } from '@magic/model'
import { createPermissionGate, parseRules } from '@magic/permission'
import type { PermissionRule, RuleProblem } from '@magic/permission'
import { createRecordsStore } from '@magic/records'
import type { RecordsStore } from '@magic/records'
import { createToolRuntime } from '@magic/tools'
import type { LoadedConfig } from './config.ts'
import { loadConfig } from './config.ts'

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
  /** 会话 id——首站「启动＝新会话」，缺省现造一个。 */
  readonly session?: SessionId | undefined
  /** 时钟——条目 / 信封的时间戳（域不各自取时钟）；缺省 `Date.now`。 */
  readonly now?: (() => Timestamp) | undefined
  /** 提示词的环境注入项（见 `EnvironmentVars`）。 */
  readonly prompt?: EnvironmentVars | undefined
}

/** 装配产物——外壳侧一端 ＋ 自检 / 验收要用的把手。 */
export type Assembly = {
  /**
   * **外壳侧一端**（契约 `ControlTransport`）——接外壳。
   * 用法＝先 `subscribe(…)`、后 `send(…)`（顺序纪律见文件头注）。
   */
  readonly shell: ControlTransport
  readonly session: SessionId
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
   * 工作区**注册根**（首站单根）——执行域构造时取的 `realpath`，**不是**入参原值：
   * macOS 上 `/var/…` 实为 `/private/var/…`，提示词与沙箱都该说**真路径**这同一个。
   */
  readonly workspaceRoot: string
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
  const session = options.session ?? crypto.randomUUID()

  // ── 2 构造各域实现 ────────────────────────────────────────────────
  // 记录域：数据目录（`~` 已在加载时展开——记录域拒收 `~`）
  const recordsStore = createRecordsStore({ dataDir: loaded.config.dataDir })
  const records = recordsStore.serviceFor(session)
  // 执行域：工作区根注册（首站单根＝启动目录）＋ 沙箱（cwd 约束经工作区）
  const workspace = createWorkspaceService({ root: options.cwd })
  const sandbox = createSandbox({ workspace })
  // 信封铸造器：按**会话实例**构造（跨会话不共享）
  const stamper = createStamper({ records, session, now })

  // 模型域：provider 注册表（`providers` 加条目即多一个；`traits` 覆盖位随条目进）
  // **key 在这一步解析**——按条目各解析一次；缺省那条缺 key 即启动期抛（与单供应商时代同）
  let gateway: ModelGateway
  let models: ModelRegistry | undefined

  if (options.modelGateway !== undefined) {
    // 替身（测试 / 别的实现）：单件，没有条目表——切换在那条路上不适用
    gateway = options.modelGateway(stamper)
  } else {
    models = createModelRegistry({
      providers: loaded.config.providers,
      defaultProvider: loaded.providerId,
      stamper,
      fetch: options.modelFetch,
    })
    gateway = models
  }

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
      if (!TRANSIENT.has(event.kind)) records.appendEvent(event)
    },
  }

  // ── 3 依次注入：权限域 → 工具域（沙箱 · 权限）→ 对话域 ──────────────
  // 权限规则（阶段 2）：配置里那段的**原值**交给权限域的 `parseRules`——条目形态归它裁
  // （解析从严：读不懂的条目逐个拒收、连同缘由交回，见 `Assembly.rejectedRules`）
  const parsedRules = parseRules(loaded.config.permissions?.rules ?? [])
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
  const conversation = createConversationService({
    session,
    // **开局的模型名**——缺省条目的 `model`，随每次调用送模型域（技术方案：模型名取自请求）。
    // 会话中途换模型**不经过这里**：注册表的选中会在这个名字之上接管（换模型＝换接缝下游，
    // 对话域不知道发生过切换——它照旧把这一行送出去，接缝按选中改道）
    model: loaded.provider.model,
    prompt: promptVarsOf(workspace.defaultRoot(), options, now),
    gateway,
    tools,
    records,
    sink,
    stamper,
    now,
  })

  /**
   * 换模型 —— **判别式处置**（技术方案 · 领域划分：「切不动就不动」）。
   *
   * **成功不发事件**——状态的真相在「**真的用了哪个**」：下一次 `model.call.start` 会带上
   * 新条目的 `provider`，外壳状态行随之更正。再发一条「已切换」等于**多一个状态源**，
   * 它与事实分叉的那天没人知道该信谁。（外壳在换完到下轮之间仍显示上一条目——那是**实话**：
   * 上一条确实是最后真跑过的那条。）
   *
   * **失败必须出声**——用户打了 `/model x` 总得知道为什么没变（切不动就不动，但不静默）。
   * 走既有的兜底 kind `error`：它是「内核自身异常——产生方就近」，而装配正是产生方；
   * **不为一条消息长一个新 kind**（kind 族是 schema 冻结点）。
   * ⚠️ 这处是**权宜**：`error` 的语义比「用户命令不成立」重，屏上会显示成「内核异常：…」。
   * 更好的形态是一个专用的切换结果事件——见回报「第 17 轮 · 待决」。
   */
  const switchModel = (request: ModelSwitchRequest): void => {
    if (models === undefined) {
      sink.emit(
        stamper.stamp('error', { message: '换模型不适用：本次装配没有供应商注册表（注入了替身网关）' }),
      )
      return
    }

    const result = models.use(request)
    // 切不动就不动——原选原样保留（注册表自己保证），此处只把缘由说出来
    if (!result.ok) sink.emit(stamper.stamp('error', { message: `换模型未成：${result.reason}` }))
  }

  // ── 4 命令路由 → 各域（`input.submit` / `turn.interrupt` → 对话域；`decision.answer` → 权限域）──
  hub.bind({
    onInput: (input) => conversation.submit(input),
    onInterrupt: () => conversation.interrupt(),
    // 答复**原样转手**（含「总是允许」位）——装配不解释它，落地归权限域
    onDecision: (id, decision, opts) => gate.resolve(id, decision, opts),
    // 换模型（阶段 2）——**判别式处置**（技术方案 · 领域划分：「切不动就不动」）
    onModelSwitch: (request) => switchModel(request),
  })

  // ── 5 接传输（内核侧一端）——外壳侧一端随返回值交出去 ────────────────
  const { kernel, shell } = createInProcessTransportPair()
  hub.attach(kernel)

  return {
    shell,
    session,
    config: loaded,
    models,
    records: recordsStore,
    paths: recordsStore.paths,
    permissionRules: parsedRules.rules,
    rejectedRules: parsedRules.rejected,
    workspaceRoot: workspace.defaultRoot(),
    close: () => recordsStore.close(),
  }
}

/**
 * 提示词注入项 —— 三段齐（缺项由对话域构造期报错，此处只管取值）。
 *
 * `cwd` 取**工作区注册根**（`workspace.defaultRoot()`——执行域构造时 `realpath` 过的那个），
 * **不是**装配入参的原值：两处一旦分叉，提示词说的目录与沙箱认的目录就不是一回事了
 * （macOS 上 `/var/…` 与 `/private/var/…` 就是现成的反例——U11 自验时冒烟当场抓到）。
 * 故根的权威**只有一个**：执行域给的注册根；此处不设覆盖位，免得又长出一条分叉路。
 */
function promptVarsOf(root: string, options: AssembleOptions, now: () => Timestamp): PromptVars {
  return {
    cwd: root,
    platform: options.prompt?.platform ?? process.platform,
    date: options.prompt?.date ?? localDate(now()),
  }
}
