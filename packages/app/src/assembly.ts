/**
 * 装配根 —— 全链的五步（技术方案 · 领域划分 · 装配视图）。
 *
 * 1. **读配置与密钥**——`loadConfig()`（`./config.ts`）；key 的解析在造模型网关那一刻
 *    （构造期缺 key 即抛——启动期就报，不留到第一次调用）。
 * 2. **构造各域实现**——记录域（数据目录 · 库 / blob）· 模型域（provider 注册）·
 *    执行域（工作区根注册 · 首站单根＝启动目录）。
 * 3. **依次注入**——权限域 → 工具域（沙箱 · 权限）→ 对话域（模型 · 工具 · 记录 ·
 *    `EventSink` · 提示词变量 `cwd` / `platform` / `date`）。
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
  SessionId,
  Timestamp,
  TurnId,
} from '@magic/contracts'
import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import { createConversationService } from '@magic/conversation'
import type { PromptVars } from '@magic/conversation'
import { createControlHub, createInProcessTransportPair } from '@magic/control'
import { createSandbox, createWorkspaceService } from '@magic/execution'
import { createModelGateway } from '@magic/model'
import { createPermissionGate } from '@magic/permission'
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
   */
  readonly modelGateway?: ((stamper: EventStamper) => ModelGateway) | undefined
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
  /** 库把手——收尾（`close`）与验收脚本用。 */
  readonly records: RecordsStore
  /** 数据落点（`records.db` 与 `blobs/` 的绝对路径）。 */
  readonly paths: { readonly database: string; readonly blobs: string }
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

  // 模型域：provider 注册（`traits` 覆盖位随配置进；缺省＝真端点，**key 在这一步解析**）
  const gateway =
    options.modelGateway?.(stamper) ??
    createModelGateway({ providerId: loaded.providerId, config: loaded.provider, stamper })

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
  const gate = createPermissionGate({ sink, stamper, now })
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
    // 模型名随每次调用送模型域（配置条目里的 `model` 是默认可覆盖——运行时切换 U17 的落点）
    model: loaded.provider.model,
    prompt: promptVarsOf(workspace.defaultRoot(), options, now),
    gateway,
    tools,
    records,
    sink,
    stamper,
    now,
  })

  // ── 4 命令路由 → 各域（`input.submit` / `turn.interrupt` → 对话域；`decision.answer` → 权限域）──
  hub.bind({
    onInput: (input) => conversation.submit(input),
    onInterrupt: () => conversation.interrupt(),
    onDecision: (id, decision) => gate.resolve(id, decision),
  })

  // ── 5 接传输（内核侧一端）——外壳侧一端随返回值交出去 ────────────────
  const { kernel, shell } = createInProcessTransportPair()
  hub.attach(kernel)

  return {
    shell,
    session,
    config: loaded,
    records: recordsStore,
    paths: recordsStore.paths,
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
