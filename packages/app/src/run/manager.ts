/**
 * **本机执行管理者**（U48 立起来 · U49 补上「可见入口」那一半）——一摊运行里**唯一**的那一个。
 *
 * 设计（会话与运行管理 · 本机执行结构）：
 *
 * > **管理者**：同一用户、同一规范化 dataDir 只有一个。启动以操作系统独占锁判归属，
 * > 本机 socket 限该用户访问；启动竞争的一方连接已有实例，不另起管理者。保存执行身份、
 * > 绑定关系、连接和子进程句柄，**不复制**对话、计划笔记与审批事实。
 *
 * ## 唯一性凭什么成立
 *
 * **靠 `bind` 那条路径**——Unix socket 的路径在一个时刻**只允许一个持有者**，这是内核
 * 给的（实测：第二次 `Bun.listen` 同一条路径当场抛）。故这里不另造一把锁文件：
 * 锁文件要自己处理残骸（谁死了、残骸什么时候能删、删的时候另一个人会不会刚好在拿），
 * 而 socket 路径**自带**这套语义——持有人在，`listen` 就失败；持有人没了，
 * 路径上那个尸首由**下一个**想当管理者的人清掉（且只在「连也连不上」时才清）。
 *
 * 三步走（启动竞争的全过程）：
 * 1. `listen` 成了 ⇒ **我是管理者**；
 * 2. 没成 ⇒ `connect` 那条既有实例——**连接它，不另起**；
 * 3. 连也连不上 ⇒ 那是**上一次没收拾干净的尸首**（进程被 SIGKILL 之后 socket 文件还在，
 *    但没人 listen）⇒ 清掉它，重试第 1 步（有界）。
 *
 * ⚠️ **第 3 步只在第 2 步失败时走**。反过来的话，两个进程同时启动时会各自清掉对方
 * 刚拿到的 socket——那就成了「谁跑得快谁说了算」，唯一性当场不成立。
 *
 * ## 它保存什么、不保存什么
 *
 * 保存：**执行身份、绑定关系、连接与子进程句柄**——也就是「谁在跑、跑到第几代、
 * 哪条连接还挂着」这一层事实。下面那张**登记表**（`Executor`）就是它。
 *
 * **不复制**对话、计划笔记与审批事实：那些归记录域（`records.db`）。管理者开库**只为
 * 两件事**——**先完成迁移再起执行者**（设计明文），与**判「那条会话在不在」**
 * （`--session` 打错一个字母要报错退场）。它一个字都不往库里写、不读条目、不读计划，
 * 「管理者不是第二个数据库」在这里是结构上的事实，不是纪律。
 *
 * 迁移为什么要抢在执行者前面：开库那一下（建表 / 换 WAL / 跑 `user_version`）**不是**
 * 并发安全的——两个执行者同时开一份**全新的**库会一起撞在 DDL 上。先让一个人把它带过
 * 去，后面来的就只是「打开一份已经成形的库」。
 *
 * ## 路由：它凭什么把话带到正确的执行者那里
 *
 * 一条规矩：**每个窗口有一个「目标执行者」**（`ClientConn.target`），命令照它转发、
 * 事件按它广播。目标什么时候换？只有两条命令会换：`session.open`（切到某条会话）
 * 与 `session.new`（开一条新的）——它们正是「用户在换我在看什么」的两个动作。
 *
 * 别的命令一律**原样转手**给当下那个目标（包括 `session.list`：目录是记录域的事实，
 * 而记录域的那一头是执行者手里的内核，管理者不替它抄一份）。没有目标时**先起一个**——
 * 一个还没开张的执行者（D5：首条消息按下回车才建会话，在那之前它一个会话都不占）。
 *
 * ## U49 补上的三件（都在这一层，内核一行没动）
 *
 * 1. **运行事实有了一份给窗口的读数**（`runs()` / `pushRuns`）：谁在跑、什么状态、
 *    在干什么、有没有人在等答复。判定只有一处（`facts.ts` 的 `runStateOf`）。
 * 2. **登记落盘 ＋ 重启核对**（`runs.json`）：U48 那份 `manager.json` 只说管理者自己，
 *    于是「重启核对」只到「路径有没有尸首」。现在盘上有「上次有哪几代、各自到哪儿」，
 *    重启按进程还在不在**逐条**核对。
 * 3. **接回＝先订阅并缓冲，再拿快照 ＋ 水位**（`bind`）：快照与订阅之间那条缝由
 *    「先缓冲、拿到水位再放行」补上——按 id 去重的落点也在那一跳。
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'bun'
import type {
  Command,
  KernelEvent,
  MagicHome,
  McpServerConfig,
  ModelSwitchRequest,
  OwnedProcess,
  RunRow,
  RunSnapshot,
} from '@magic/contracts'
import { probeMcp } from './preflight.ts'
import type { McpProbeRow } from './wire.ts'
import { createRecordsStore } from '@magic/records'
import { ensureRunDir, tightenSocket } from './paths.ts'
import type { RunPaths } from './paths.ts'
import { linkOf, socketHandlers } from './wire.ts'
import type { ClientToManager, ExecutorToManager, Link, ManagerToExecutor } from './wire.ts'
import {
  actionOf,
  endKindOf,
  holdsPid,
  isProgress,
  newRunRecord,
  progressOf,
  reconcile,
  refresh,
  runRowOf,
  storedRunOf,
  tailOf,
} from './facts.ts'
import type { RunRecord, StoredRun, StoredRuns } from './facts.ts'
import { RUNS_VERSION, STORED_RUNS_LIMIT } from './facts.ts'
import { reclaim, reclaimNoteOf } from './reclaim.ts'
import { startTimeOf } from '@magic/execution'

/** 管理者自报身份的落盘形（`manager.json`）——诊断与重启核对用，**不是**权威状态。 */
export type ManagerRecord = {
  readonly pid: number
  readonly at: number
  /** 数据目录的规范形——管理者就是按它认的自己这一摊。 */
  readonly dataDir: string
  readonly socket: string
  /** 本文件里那一版的形制——将来加字段时读的人据此判。 */
  readonly v: number
}

const RECORD_VERSION = 1

/** 一条挂着的客户端连接。 */
type ClientConn = {
  readonly id: number
  readonly link: Link<ClientToManager>
  /** 它认的执行者代次（`0` ＝ 还没认过任何一代）。 */
  gen: number
  /** 启动目录——按它起执行者（工作区默认根的缺省，见 `wire.ts` 的 `hello.cwd`）。 */
  readonly cwd: string
  /** 它此刻在跟哪个执行者说话（`undefined` ＝ 还没有目标）。 */
  target: Executor | undefined
  readonly label: string | undefined
  /** 开局那条换模型请求（`--provider` / `--model`）——为它起新的一代时带过去。 */
  readonly switch: ModelSwitchRequest | undefined
  /**
   * **这个窗口正等着的快照号**（U49）——非 `null` 时进来的事件**先攒着不发**。
   *
   * 这一格就是设计那句「**先订阅并缓冲**，或提供原子订阅快照」的落点：窗口一挂到某一代
   * 上就**已经在收**了，而快照是随后一趟往返才回来的——中间那段的事件若不攒着，
   * 就正好掉进「快照与订阅之间那条缝」。
   */
  awaiting: number | null
  /** 等着快照的那段时间里攒下的事件（按到达序，放行时按 id 去重、只放水位之后的）。 */
  buffered: KernelEvent[]
}

/**
 * **一个执行者的登记**——管理者侧的全部所知。
 *
 * 「同一个执行现场独占推进权」在这一层是**结构上的**：一条会话至多挂一个 `Executor`
 * （`liveOf(session)` 是按会话找的，而起新的之前先问它），故不可能有两个同时推同一条。
 */
type Executor = {
  /** **代次**——管理者发的号，一条会话换一个执行者就换一代（U48 第三段按它判过期）。 */
  readonly gen: number
  /** 发车时给的令牌——认「这条连上来的是我叫起来的那一个」。 */
  readonly token: string
  /** **显式接续**起的那一代（发车时就带着会话号）；`false` ＝ 还没开张（D5）。 */
  readonly explicit: boolean
  /** **运行事实**（U49）——会话 / 状态 / 进展 / 待答项全在这一格里，判定见 `facts.ts`。 */
  readonly run: RunRecord
  readonly spawned: SpawnedExecutor
  /** 连上之后才有；在那之前它还没开口。 */
  link: Link<ExecutorToManager> | undefined
  /** 还没送出去的东西（**先攒后送**：没人接的话发出去就是「敲了没反应」）。 */
  queued: ManagerToExecutor[]
  /** 盯着它的窗口连接号——事件按这一份广播。 */
  readonly watchers: Set<number>
  /** 上一次听见它（`pong` / 任何一条消息）——诊断与生命探测用。 */
  lastSeen: number
  pingSeq: number
  /** 快照的号（U49）——一问一答按它对上。 */
  snapSeq: number
  /** 发出去还没回来的那几个快照，各是给哪个窗口的（`seq → conn.id`）。 */
  readonly asking: Map<number, number>
}

export type ManagerOptions = {
  /** 这一摊运行的三条路径（`runPathsOf` 算出来的）。 */
  readonly paths: RunPaths
  /** 数据目录的规范形——写进自报的那一份里，也是发给执行者的那一份的来处。 */
  readonly dataDir: string
  /** 起执行者的方式——见 `ExecutorLauncher`。 */
  readonly launch: ExecutorLauncher
  /**
   * **统一基础路径**——执行者按它读配置（配置 / 授权 / 技能都从它派生，U42）。
   *
   * ⚠️ **必须显式传**，不靠环境变量：`MAGIC_HOME` 只说得清「Magic 落在哪」，而
   * `magic.home`（`~/…` 展开到哪）与 `magic.base` 是**两件**——测试沙地把它们指到
   * 临时目录时，子进程若照环境自己解析一遍，读到的是**开发者真那份**配置。
   */
  readonly magic: MagicHome
  /**
   * **外部工具预检要连的那几台**（`mcp.servers` 原样）——缺省一条都没有（空转）。
   *
   * 由入口（`cli.ts`）从**它刚读的那份配置**里取：管理者不自己再读一遍配置
   * ——一处读、两处同一个值，两边才不会各认一份。
   */
  readonly mcp?: Readonly<Record<string, McpServerConfig>> | undefined
  /** 预检的连接上限（毫秒）——缺省＝适配器那个实现级常量；用例把它调小。 */
  readonly mcpConnectTimeoutMs?: number | undefined
  /** 时钟——缺省 `Date.now`。 */
  readonly now?: (() => number) | undefined
  /** 生命探测的间隔（毫秒）——缺省 5 秒；见 `PROBE_INTERVAL_MS`。 */
  readonly probeIntervalMs?: number | undefined
  /** 诊断——缺省不打印（**这条线上不写业务日志**）。 */
  readonly log?: ((line: string) => void) | undefined
}

/**
 * 起一个执行者。
 *
 * 收成端口是为了**用例能把真进程换成别的**：多进程的用例贵在「真的分了进程」（那是要证
 * 的东西），而管理者这一层看不见差别——它只要求「有人按 `ExecutorRequest` 起得来、
 * 起得来之后会连上来」。
 */
export type ExecutorLauncher = {
  spawn(request: ExecutorRequest): SpawnedExecutor
}

/** 开一个执行者时给它的那几件——「哪一代、哪条会话、在哪个工作区、用哪份配置」。 */
export type ExecutorRequest = {
  /** **代次**——管理者发的号。 */
  readonly gen: number
  /** 发车令牌——它连上来时按这个认。 */
  readonly token: string
  /** 开工那条会话（显式接续时就有）；`null` ＝ 让它自己开张（D5）。 */
  readonly session: string | null
  /** **启动目录**——工作区默认根（配置没写 `workspaceRoots` 时就是它）。 */
  readonly cwd: string
  /** 统一基础路径——执行者按它读配置。 */
  readonly magic: MagicHome
  /** 管理者监听的那条 socket——执行者要连它。 */
  readonly socket: string
  /**
   * **开局的换模型请求**——窗口 `hello` 里带的那一个，随「为它起的那一代」落地。
   *
   * 只有**为这个窗口新起的那一代**收它：接上一代已经在跑的会话时不再 apply（那一代
   * 有它自己的选中——「模型选择按 Agent 独立装配，不共享可变选择」是设计明文）。
   */
  readonly switch?: ModelSwitchRequest | undefined
}

/** 一个真起了的进程——管理者只管「它还活着没有、叫它退它退不退」。 */
export type SpawnedExecutor = {
  /** 进程号——**仅作诊断**（用户按会话 / 工作操作，不按 PID）。 */
  readonly pid: number | undefined
  /** 子进程退出了（正常 / 被杀 / 起不来）——**「自有子进程退出」那一路**。 */
  onExit(listener: (reason: string) => void): void
  /** 叫它退——先礼（`bye` 走连接）后兵（这里是兵）。 */
  kill(): void
}

/**
 * 一个立起来的管理者。
 *
 * 三个读数给**诊断与验收装置**（客户端自己看不到这些——它只需要一条连接）。
 */
export type Manager = {
  readonly record: ManagerRecord
  readonly socketPath: string
  /** 挂着的客户端连接数。 */
  clients(): number
  /** 这一摊里活着的执行者（按会话归）。 */
  executors(): readonly { readonly session: string | null; readonly gen: number; readonly pid: number | undefined }[]
  /**
   * **这一摊此刻的运行事实**（U49）——与推给窗口的那一份**同一处产出**（`rows()`）。
   *
   * 给验收装置一个不必起窗口就能读的读数（同 `clients()` / `executors()` 的姿势）。
   */
  runs(): readonly RunRow[]
  /** 显式收摊（收缩那条路与用例的收尾都走它）。 */
  stop(why: string): void
  /** 等它真退干净（socket 摘掉、执行者收光、连接关光）。 */
  waitUntilExit(): Promise<void>
}

export type StartResult =
  | { readonly role: 'manager'; readonly manager: Manager }
  /** 已经有一个管理者了——**连接它，不另起**。 */
  | { readonly role: 'existing'; readonly record: ManagerRecord | undefined }
  | { readonly role: 'failed'; readonly reason: string }

/** 重试次数——「尸首清掉再 bind」那一步；给三次是因为它只该有一次成功或彻底失败。 */
const BIND_ATTEMPTS = 3

/**
 * 生命探测的间隔（毫秒）——**有限频率、只为识别失联**。
 *
 * 设计明文：「监听自有子进程退出和 IPC 断开；生命探测与业务进展分开。**有限频率**的
 * 连接健康探测**仅用于识别失联**，不扫描全机 PID、不以 CPU 阈值自动杀进程」。
 * 五秒是「人察觉不到、机器也不忙」的那个量级；判据是**连的断没断**，不是「它在不在干活」
 * ——长测试静默十分钟也照样是活的。
 */
const PROBE_INTERVAL_MS = 5_000

/**
 * 收摊时给执行者的**宽限期**（毫秒）——`bye` 之后等它自己走完收尾那两跳。
 *
 * 两秒是「它手上那两跳要多久」的量级：关外部服务器（关 stdin → 等 → 杀）本来就有界，
 * 关库是一条语句。到点还没退的按「不听话」处理（`kill`）。
 */
const SHUTDOWN_GRACE_MS = 2_000

/** 「两手都空」要空够多久才退（毫秒）——见 `bindManager` 里 `idle` 那一段的注。 */
const IDLE_MS = 2_000
/** 那件事多久看一次（毫秒）——它只是个判据，不需要比这更勤。 */
const IDLE_CHECK_MS = 250

/**
 * **运行事实变了之后隔多久推一次**（毫秒）。
 *
 * 这一格管的是「同一瞬间连着变好几处」那种情形：一轮里 `agent.state`・`tool.call`・
 * `progress` 会连着翻好几次，逐条推是白推（屏上只画最后那一份）。取一百毫秒：
 * 人眼分不出来，而合并掉的写与推送省下了数量级。
 */
const RUNS_PUSH_MS = 100

/** 运行登记落盘的合并窗（毫秒）——见 `saveRuns`。 */
const RUNS_SAVE_MS = 300

/**
 * **立一个管理者，或者认出已经有的那一个**。
 *
 * 返回 `existing` 时调用方该去 `connectManager`（见 `client.ts`）——本函数**不替它连**：
 * 「谁是管理者」与「客户端怎么用这条连接」是两件事，混在一起会让用例没法只验前一件。
 */
export async function startManager(options: ManagerOptions): Promise<StartResult> {
  const { paths } = options
  const now = options.now ?? Date.now

  ensureRunDir(paths.dir)

  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const bound = bindManager(options, now)
    if (bound !== undefined) return { role: 'manager', manager: bound }

    // bind 没成——**先问「是不是有人在」**，问到就连接它，一句都不清
    if (await someoneListens(paths.socket)) {
      return { role: 'existing', record: readRecord(paths) }
    }

    // 连也连不上 ⇒ 路径上是上一次的尸首。**清掉它**，下一轮重新 bind。
    // 清之前再确认一次（探测与清理合成不了一次原子动作）——探测失败的方向是**保守**的。
    if (!(await someoneListens(paths.socket))) clearStale(paths.socket)
  }

  return { role: 'failed', reason: `连着 ${BIND_ATTEMPTS} 次都没能占住 ${paths.socket}` }
}

/** bind 成了就返回一个立好的管理者；没成返回 `undefined`（判归属的那三步在调用方）。 */
function bindManager(options: ManagerOptions, now: () => number): Manager | undefined {
  const { paths } = options
  const probeIntervalMs = options.probeIntervalMs ?? PROBE_INTERVAL_MS

  const clients = new Map<number, ClientConn>()
  const executors = new Set<Executor>()
  /** 待认领的执行者——按令牌找（它连上来时给的正是那个令牌）。 */
  const awaiting = new Map<string, Executor>()
  /**
   * **已经不在跑的那些运行**（U49）——按会话留一条「最近一次运行」。
   *
   * 两个来处：这一趟里收掉的（`retire`），与**上一次管理者留下的**（`readRuns`）。
   * 列表上「当前/最近状态」那一格就是它；`ended !== undefined` ＝ 这一条已经结束。
   */
  const lastRuns = new Map<string, RunRecord>()

  let nextConn = 1
  let nextGen = 1
  let stopped = false
  /**
   * 手上那份库连接关了没有——**收摊那一路还要读运行事实**（`rows()` 按目录说话那一跳
   * 要查库），而库在收摊的前半段就关了。关了之后**不筛**：那时该照列（拿不到的不编）。
   */
  let storeClosed = false
  let settle: () => void = () => {}
  const exited = new Promise<void>((resolve) => {
    settle = resolve
  })

  /**
   * **先把库带过迁移那一跳**（设计明文：「管理者先完成库迁移再启动执行者」）。
   *
   * `workspace: []` 是**如实**的：管理者不建会话行，故那个「会话归属哪几条根」
   * 的参数在这儿没有内容可言——它只在建行那一刻被写进库里（那一步归执行者）。
   * 开不动库就**别当管理者**：连库都带不起来的进程，起执行者也只是把同一件事故
   * 推迟到别人那儿炸。
   */
  let store: ReturnType<typeof createRecordsStore>
  try {
    store = createRecordsStore({ dataDir: options.dataDir, workspace: [] })
  } catch (error) {
    options.log?.(`库迁移没成：${String(error)}`)
    return undefined
  }

  let server: ReturnType<typeof Bun.listen>
  try {
    server = Bun.listen({
      unix: paths.socket,
      socket: socketHandlers((socket) => accept(socket as Socket<unknown>)),
    })
  } catch {
    store.close()
    return undefined
  }

  tightenSocket(paths.socket)

  const record: ManagerRecord = {
    pid: process.pid,
    at: now(),
    dataDir: options.dataDir,
    socket: paths.socket,
    v: RECORD_VERSION,
  }
  writeRecord(paths, record)

  // **重启核对**（U49 立、U50 补上「句柄身份」那一半）：上一次留下的那几代，今天还成不成立
  // ——逐条读、逐条判（判据在 `facts.ts` 的 `reconcile`/`holdsPid`）。读不动就当没有：
  // 这份文件是**诊断品**，它坏了不该拦住启动（同 `manager.json` 那条口径）。
  //
  // U50 补的那一半：判「还在不在」时**连它的启动时刻一起核**（`startTimeOf`）——一个
  // 复用了同一个号的无关进程从此骗不过去（U49 如实记过的那条限度收在这一跳上）。
  for (const stored of readRuns(paths)) {
    const record = reconcile(stored, now(), startTimeOf)
    lastRuns.set(record.session as string, record)

    // **上一代留下的自有进程组**（U50）：已经证实不在的那些，照登记收回来——它当年
    // 多半没跑完收尾那两跳（管理者异常退出那条路），起的进程就成了没人认领的后台。
    // ⚠️ **只对「证实已结束」的那些动手**：还站着的（状态待确认）照旧一个都不碰。
    if (record.ended !== undefined && record.owned.length > 0) void reclaimRun(record)
  }

  /**
   * **外部工具预检**（U48 第六段）——**连接 → 报状态 → 断开**，一趟，挂在管理者的启动上。
   *
   * 三条都是从「它是探针不是工具连接」来的（设计 · MCP 接入 · 服务启动时的预检）：
   * - **不为它单起后台**：就在这个进程里跑，跑完就收——它不另起执行者、不建会话；
   * - **不持有工具、不供会话使用**：读数只上「服务状态」那一格（`welcome.mcp`），
   *   工具表交给谁这个问题**根本不出现在这一路上**；
   * - **不断路**：探针失败不影响管理者起得来（连不上的那几台落成 `unavailable` 的读数）。
   *
   * ⚠️ **窗口是「等它落定」而不是「拿到半份」**：`accept` 那一头把 `welcome` 押在这条
   * promise 上（见下）。押的代价是第一个窗口多等这一趟——而那与今天一样
   * （`cli.ts` 起外壳之前本来就要 `await assembly.ready()`）。
   */
  const preflight = probeMcp({
    servers: options.mcp ?? {},
    ...(options.mcpConnectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.mcpConnectTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  /** 预检的读数——它是**服务状态**，窗口接上就读得到（`welcome.mcp`）。 */
  let probed: readonly McpProbeRow[] = []

  // —— 运行事实：一处产出、两处用（推给窗口 ＋ 落盘）——

  /**
   * **这一摊此刻的运行事实**——列表与详情要的那一份。
   *
   * 两个来处合起来才是「当前/最近」：活着的那些执行者（**当前**），与已经收掉的那些
   * 「最近一次运行」（**最近**）。同一条会话两头都有时**以活着的为准**（那才是现况）。
   * 还没开张的执行者（`session === null`）没有会话可挂，故不入表——**列表按会话说话**。
   */
  function rows(): readonly RunRow[] {
    const out: RunRow[] = []
    const live = new Set<string>()

    /**
     * **列表按目录说话**——只对**库里点得出名**的会话发言。
     *
     * 挡的是那一格**空壳**：内核为「要点一次会话面的命令」（`session.list`）开的临时会话
     * （`conversation` 那一处的 `current()`），它还没有任何条目、**目录里也没有它**。
     * 让它进这张表，用户会在 `/resume` 里看见一条点不出来、也切不过去的行。
     * 判据就是「库里有没有这一行」（`hasSession`）——与 `--session` 那道校验同一把尺子。
     *
     * ⚠️ 首条消息一按下回车它就落账 ⇒ 那一格当场归位（不必等下一次推送）。
     */
    const known = (session: string): boolean =>
      storeClosed ? true : store.hasSession(session)

    for (const executor of executors) {
      const session = executor.run.session
      if (session === null || !known(session)) continue
      live.add(session)
      out.push(runRowOf(executor.run))
    }

    for (const [session, run] of lastRuns) {
      if (live.has(session) || !known(session)) continue
      out.push(runRowOf(run))
    }

    return out
  }

  /** 这一推的定时器——合并窗见 `RUNS_PUSH_MS`。 */
  let pushTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * **推运行事实**（合并一次）——窗口不必问，事实变了它自己知道。
   *
   * ⚠️ **不逐条推**：这一格最热的是流式输出（`tool.output.delta` 一秒几十条），
   * 逐条推等于把「进度」变成网络噪音。合并窗之内的变化只落最后那一份。
   */
  function pushRuns(immediate = false): void {
    if (pushTimer !== undefined) {
      if (!immediate) return
      clearTimeout(pushTimer)
      pushTimer = undefined
    }
    if (stopped) return

    if (!immediate) {
      pushTimer = setTimeout(() => {
        pushTimer = undefined
        pushRuns(true)
      }, RUNS_PUSH_MS)
      pushTimer.unref?.()
      return
    }

    const payload = rows()
    for (const conn of clients.values()) conn.link.send({ t: 'runs', rows: payload })
  }

  /** 落盘的合并窗定时器——见 `saveRuns`。 */
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * **把登记落盘**（`runs.json`）——重启核对的取材。
   *
   * 合并写（`RUNS_SAVE_MS`）：一轮里这几格会连着变好几次，而每一次都写一遍盘是白写
   * （读的人只看最后那一份）。⚠️ **合并窗的大小就是「管理者被杀时会丢多少登记」**，
   * 故它取的是一个**诊断可以接受**的量级——这份文件不是权威状态，权威是活着的那几个
   * `Executor`；丢了它顶多是重启后少认出一条「最近一次运行」。
   */
  function saveRuns(immediate = false): void {
    if (saveTimer !== undefined) {
      if (!immediate) return
      clearTimeout(saveTimer)
      saveTimer = undefined
    }

    if (!immediate) {
      saveTimer = setTimeout(() => {
        saveTimer = undefined
        saveRuns(true)
      }, RUNS_SAVE_MS)
      saveTimer.unref?.()
      return
    }

    // **活着的排在后面**——同一条会话两头都有时，新的那一份盖住旧的（读的人按序 set）
    const stored: StoredRun[] = []
    for (const run of lastRuns.values()) {
      const one = storedRunOf(run)
      if (one !== undefined) stored.push(one)
    }
    for (const executor of executors) {
      const one = storedRunOf(executor.run)
      if (one !== undefined) stored.push(one)
    }

    writeRuns(paths, stored.slice(-STORED_RUNS_LIMIT), now())
  }

  /** 一摊运行的那几件工具——`stop` 与各自的收尾都要它们，故在闭包里立。 */
  const manager: Manager = {
    record,
    socketPath: paths.socket,
    clients: () => clients.size,
    executors: () =>
      [...executors]
        .filter((one) => one.run.ended === undefined)
        .map((one) => ({ session: one.run.session, gen: one.gen, pid: one.run.pid })),
    runs: () => rows(),
    stop,
    waitUntilExit: () => exited,
  }

  /**
   * 接进来一条连接——**先当它是客户端，等它那句 `hello` 再定**。
   *
   * 执行者与窗口连的是**同一条 socket**：三者之间只有一条本机路径，谁是谁由 `hello`
   * 说（而不是「谁先连上」「连的是哪条端口」那种要看别处才知道的判据）。
   */
  function accept(socket: Socket<unknown>): void {
    const link = linkOf<ClientToManager | ExecutorToManager>(socket)
    /** 这条连接立起来的时候是谁的——`hello` 那一刻定下，之后不再变。 */
    let client: ClientConn | undefined
    let executor: Executor | undefined

    link.onMessage((message) => {
      if (message.t === 'hello') {
        if (message.role === 'executor') {
          executor = adopt(message)
          return
        }

        const conn: ClientConn = {
          id: nextConn,
          link: link as unknown as Link<ClientToManager>,
          gen: 0,
          cwd: message.cwd,
          target: undefined,
          label: message.label,
          switch: message.switch,
          awaiting: null,
          buffered: [],
        }
        nextConn += 1
        client = conn

        // **`--session` 那道校验**（U28 · 台账随批小修 8）——库里没有这条就**回绝**，
        // 不静默开一条空的。由管理者做，因为**只有它手上开着库**（窗口那一侧按设计
        // 不开库）；报的那句话与今天逐字同形，故「打错一个字母」这条路一处未变。
        if (message.session !== undefined && !store.hasSession(message.session)) {
          link.send({
            t: 'welcome',
            conn: conn.id,
            dataDir: options.dataDir,
            // 回绝这一条不必等预检（它连不上就是连不上，与外部工具无关）
            mcp: probed,
            // 这一条**不是给窗口的读数**（连接当场就关了）——给一份空的，形态上照旧
            runs: [],
            refuse:
              `没有这条会话：${message.session}——` +
              `--session 收的是会话 id（/resume 那张列表里那串）；库里没有它，本次一步都没走`,
          })
          link.close()
          return
        }

        clients.set(conn.id, conn)
        touch()

        // **押在预检上**（见 `preflight` 那一跳的注）：窗口接上就能读到结论，
        // 且读到的**一定是落定后的那一份**——半份读数比晚一会儿更坏（用户据此以为通了）。
        void preflight.then((mcpRows) => {
          probed = mcpRows
          if (link.closed) return
          link.send({
            t: 'welcome',
            conn: conn.id,
            dataDir: options.dataDir,
            mcp: probed,
            // 开屏那张摘要据它说「这一摊有几项在跑」——**接上就读得到**，不必先问一次
            runs: rows(),
          })
        })

        // **开局就定下的目标**：给了 `--session` ⇒ 现在就按它要一代执行者
        // （这也是「接回旧会话」那条路的起点：那条会话已经有一代在跑就直接接上，
        // 没有就为它起一代——`liveOf` 那一条判据两头都管）
        if (message.session !== undefined) {
          retarget(conn, { kind: 'open', session: message.session })
        }
        return
      }

      if (client !== undefined) {
        if (message.t === 'cmd') onCommand(client, message.gen, message.cmd)
        if (message.t === 'bye') dropClient(client.id)
        return
      }

      // 走到这儿＝这条连接立起来时说的是执行者那一路（`hello` 那一刻定下的，之后不变），
      // 故收下的是执行者那一族
      if (executor !== undefined) onExecutorMessage(executor, message as ExecutorToManager)
    })

    link.onClose(() => {
      if (client !== undefined) dropClient(client.id)
      if (executor !== undefined) retire(executor, '连接断了')
    })

    /** 认领一条执行者连接——令牌对上哪一代就是哪一代。 */
    function adopt(message: Extract<ExecutorToManager, { t: 'hello' }>): Executor | undefined {
      const found = awaiting.get(message.token)
      if (found === undefined) {
        // 令牌不认（上一代留下的 / 别的摊调错门了）：**不留一条无人负责的连接**
        link.send({ t: 'bye', why: '这个令牌不对应任何一代执行者' })
        link.close()
        return undefined
      }

      awaiting.delete(message.token)
      found.link = link as unknown as Link<ExecutorToManager>
      if (message.session !== null && message.session !== undefined) {
        found.run.session = message.session
      }
      found.run.workspace = message.workspace
      found.run.everConnected = true
      found.run.connected = true
      found.lastSeen = now()
      refresh(found.run, now())
      // 认领的这一刻补一条「现在有几个人看你」——`bind` 那一次发的时候它还没连上来
      // （`link` 是空的），而它接下来的收缩判据正需要这个数。
      tellWatchers(found)
      saveRuns()
      pushRuns()
      return found
    }
  }

  function dropClient(id: number): void {
    const conn = clients.get(id)
    if (conn === undefined) return
    clients.delete(id)
    conn.target?.watchers.delete(id)
    if (conn.target !== undefined) tellWatchers(conn.target)
    conn.awaiting = null
    conn.buffered = []
    conn.link.close()
    // 最后一个看客走了——**不是「停」**：执行者照跑。收不收它归收缩那条路：
    // 它自己按「没有连接者 ＋ 没有在途调用或待答项」判（见 `executor.ts` 的收缩那一跳）。
    options.log?.(`窗口 ${id} 断开（挂着的客户端 ${clients.size}）`)
    touch()
  }

  // —— 命令：路由 ——

  /**
   * 一条命令——**先验代次，再路由**。
   *
   * 验代次这一条（设计 · 状态可信度、独占与重新连接 ①：「**过期连接携带旧代次的命令
   * 一律拒绝**，不能让旧窗口误操作新运行」）落在这里：
   *
   * - 带了号 ⇒ 它必须**就是**当下那个目标的号（不是「曾经是」——目标一换，旧号当场作废）；
   * - 没带号 ⇒ 只收「还没有目标」的那些窗口说的（它还没被指派过，谈不上过期）。
   *
   * 拒绝是**有回声**的（一句 `line`）：静默丢弃会让窗口对着一个不动的屏发呆，
   * 而「我这条为什么不生效」正是那一刻唯一要答的问题。
   */
  function onCommand(conn: ClientConn, gen: number | null, command: Command): void {
    if (gen !== null && (conn.target === undefined || gen !== conn.target.gen)) {
      conn.link.send({
        t: 'line',
        text:
          conn.target === undefined
            ? '这一代已经不在了——它那条命令没生效（接着敲就是，会给你起新的一代）'
            : `这一代已经过去了（那是第 ${gen} 代，现在是第 ${conn.target.gen} 代）——它那条命令没生效`,
      })
      return
    }

    /**
     * **裁决答复**那一跳（U49 · 设计 ⑥）——「审批只有一份，第一条有效答复落账后其它窗口
     * 即时移除；**晚到答复明确已处理**」。
     *
     * 「不再次执行工具」那一半是**内核**保的（`gate.resolve` 对陌生 id 直接忽略：
     * 迟到 / 重复 / 伪造都进不去）。管理者这一跳补的是**那一句话**——晚到的那个窗口
     * 按了半天没反应，得有人告诉它「这一件已经处理过了」。
     *
     * ⚠️ **只在「我们知道它已经答复过」时拦下**：知道才拦，不知道就照原样转过去让内核
     * 判。反过来（没听说过的就丢掉）会把一条**合法**的答复吞了——那样这一轮就永远卡在
     * 等答复上，而卡住的那一头没有任何人看得见。
     */
    if (command.type === 'decision.answer' && conn.target !== undefined) {
      const run = conn.target.run
      if (!run.decisions.has(command.id) && run.resolvedDecisions.has(command.id)) {
        conn.link.send({
          t: 'line',
          text: '这一件已经处理过了——答复只算第一次，那件工具不会再跑一遍',
        })
        return
      }
      deliver(conn.target, command)
      return
    }

    // **换目标的只有这两条**（见文件头注）
    if (command.type === 'session.open' || command.type === 'session.new') {
      // **忙时不动目标**——原样转给当下那一代，由**内核**自己回话
      // （`BUSY_NOTE`：「正在跑一轮——先 Ctrl+C 中断，再切会话」）。
      // 这条不让管理者替它换目标，是因为「忙时挡回」是**内核的口径**：拦在这里另起一代，
      // 就成了「明明在跑，按一下却什么也没发生就换了会话」——那一句该说的话没了。
      if (conn.target !== undefined && conn.target.run.busy) {
        deliver(conn.target, command)
        return
      }

      if (command.type === 'session.open') {
        retarget(conn, { kind: 'open', session: command.session })
        return
      }

      // **`/clear` ＝ 这个窗口开一条新的**（U49 改判 · 由头见 `retarget` 里 `new` 那一段）。
      // 两条例外：还没开张的那个执行者直接用它（空白启动页按一下不必白起一个进程），
      // 以及忙时（上面已经挡回了）。
      const current = conn.target
      if (reusable(current, conn)) {
        const reused = current as Executor
        bind(conn, reused)
        deliver(reused, command)
        return
      }

      const fresh = spawnFresh(conn)
      if (fresh === undefined) {
        conn.link.send({ t: 'line', text: '起不了执行者——没开成新的那条' })
        return
      }
      deliver(fresh, command)
      return
    }

    const target = conn.target ?? spawnFresh(conn)
    if (target === undefined) {
      conn.link.send({ t: 'line', text: '起不了执行者——这条命令没能送到' })
      return
    }

    deliver(target, command)
  }

  /**
   * 换目标——`session` 给了就是「切到那一条」，不给就是「开一条新的」。
   *
   * 复用那一条规矩：**当下这个执行者还没开张、而且只有这一个看客**时就用它
   * （免得起一个只用几毫秒的进程）；否则按会话找已经活着的那一个，再没有才起新的。
   */
  function retarget(
    conn: ClientConn,
    how: { readonly kind: 'open'; readonly session: string } | { readonly kind: 'new' },
  ): void {
    const current = conn.target

    if (how.kind === 'open') {
      const command: Command = { type: 'session.open', session: how.session }

      const live = liveOf(how.session)
      if (live !== undefined) {
        bind(conn, live)
        // 它已经在那条会话上——`session.open` 过去是**无事**（内核不报）。
        // 故这里补一条 `session.list`：那一条**一定会**报一次状态，窗口据此重画、
        // 选择器据以合上。两句都发，是为了「换到了」这件事在屏上**有回声**。
        deliver(live, command)
        deliver(live, { type: 'session.list' })
        return
      }

      // **上一次那一代还没证实结束**（U49）——它可能还在收尾。设计明文：
      // 「失联……**不能重复启动同会话**」。故这一条**如实拒绝**并说清缘由，
      // 不悄悄起第二个（那正是要防的那件事）。
      const held = lastRuns.get(how.session)
      if (held !== undefined && held.ended === undefined) {
        conn.link.send({
          t: 'line',
          text:
            `没切到 ${how.session}：上一次那条执行者还没有证实结束（它可能正在收尾）` +
            '——同一个会话不能同时起两个。/resume 里那一行标着「状态待确认」',
        })
        return
      }

      if (reusable(current, conn)) {
        const reused = current as Executor
        bind(conn, reused)
        deliver(reused, command)
        return
      }

      const spawned = spawn({
        session: how.session,
        explicit: true,
        cwd: conn.cwd,
        ...(conn.switch === undefined ? {} : { switch: conn.switch }),
      })
      if (spawned === undefined) {
        conn.link.send({ t: 'line', text: `起不了执行者——没切到 ${how.session}` })
        return
      }
      bind(conn, spawned)
      deliver(spawned, command)
      // ⚠️ **这一条不能省**（同上面「接上已经活着的那一代」那一路）：为这条会话新起的那一代
      // 是**带着会话号装配**的（`assemble({ session })`），故它的 `switchTo` 判「已经在的那条
      // ＝无事」——`session.open` 过去**一声不响**，窗口就此停在旧那一页上（屏不动、回执也不来）。
      // `session.list` 那一条**一定会**报一次状态：窗口据此重画、选择器据以合上。
      deliver(spawned, { type: 'session.list' })
      return
    }

    const command: Command = { type: 'session.new' }

    if (reusable(current, conn)) {
      const reused = current as Executor
      bind(conn, reused)
      deliver(reused, command)
      return
    }

    const spawned = spawnFresh(conn)
    if (spawned === undefined) {
      conn.link.send({ t: 'line', text: '起不了执行者——没开成新的那条' })
      return
    }
    deliver(spawned, command)
  }

  /** 「当下这个执行者还有用吗」——**没开张 ＋ 只有这一个看客**才敢往上叠新目标。 */
  function reusable(current: Executor | undefined, conn: ClientConn): boolean {
    if (current === undefined || current.run.ended !== undefined) return false
    if (current.run.session !== null) return false
    return current.watchers.size <= 1 && (current.watchers.size === 0 || current.watchers.has(conn.id))
  }

  /**
   * 把窗口挂到某一代上——**换看客**是这一处的全部动作（旧的那一代照跑）。
   *
   * U49 在这一跳上加了**接回**那一手（设计 · 状态可信度、独占与重新连接 ③）：
   *
   * > 重连获取同一代次的「快照＋事件水位」，随后续接水位后的消息；**先订阅并缓冲**，
   * > 或提供原子订阅快照，避免快照与订阅之间丢事件。
   *
   * 走的是前者：**挂上去的同一刻**就把这个窗口记进 `watchers`（于是事件开始往它的
   * 缓冲里落），再向执行者要一份快照；快照回来（带水位）之后**先放快照、再放缓冲里
   * 水位之后的那几条**。订阅因此不晚于快照，而快照里的东西一定不重复。
   */
  function bind(conn: ClientConn, executor: Executor): void {
    const from = conn.target
    from?.watchers.delete(conn.id)
    if (from !== undefined && from !== executor) tellWatchers(from)

    conn.target = executor
    executor.watchers.add(conn.id)
    conn.gen = executor.gen

    conn.link.send({ t: 'target', gen: executor.gen, session: executor.run.session })

    // **先订阅并缓冲**——这一格就是那道缝的补丁（见本函数的注）
    conn.awaiting = 0
    conn.buffered = []
    askSnapshot(executor, conn)

    tellWatchers(executor)
  }

  /** 向某一代要一份快照，回来的那一份给这个窗口。 */
  function askSnapshot(executor: Executor, conn: ClientConn): void {
    executor.snapSeq += 1
    const seq = executor.snapSeq
    conn.awaiting = seq
    executor.asking.set(seq, conn.id)
    send(executor, { t: 'snapshot', seq })
  }

  /** 告诉某一代「现在还有几个人看你」——收缩那条路的一半判据（见 `wire.ts` 的 `watchers`）。 */
  function tellWatchers(executor: Executor): void {
    executor.link?.send({ t: 'watchers', count: executor.watchers.size })
  }

  /** 已经活着的那一代（按会话找）——**独占推进权**就落在这一条上：一条会话至多一个。 */
  function liveOf(session: string): Executor | undefined {
    for (const one of executors) {
      if (one.run.ended === undefined && one.run.session === session) return one
    }
    return undefined
  }

  /** 起一个还没开张的执行者——**窗口的第一条命令**走它（空白启动页此时才有进程）。 */
  function spawnFresh(conn: ClientConn): Executor | undefined {
    const spawned = spawn({
      session: null,
      explicit: false,
      cwd: conn.cwd,
      ...(conn.switch === undefined ? {} : { switch: conn.switch }),
    })
    if (spawned !== undefined) bind(conn, spawned)
    return spawned
  }

  /** 真起一个——登记在**发车那一刻**（不是等它连上来）：两个窗口同时要同一条会话时，
   *  第二个必须**当场**看得见第一个，否则会各起一个。 */
  function spawn(input: {
    readonly session: string | null
    readonly explicit: boolean
    readonly cwd: string
    readonly switch?: ModelSwitchRequest | undefined
  }): Executor | undefined {
    const gen = nextGen
    nextGen += 1
    const token = `${gen}-${crypto.randomUUID()}`

    let spawned: SpawnedExecutor
    try {
      spawned = options.launch.spawn({
        gen,
        token,
        session: input.session,
        cwd: input.cwd,
        magic: options.magic,
        socket: paths.socket,
        ...(input.switch === undefined ? {} : { switch: input.switch }),
      })
    } catch (error) {
      options.log?.(`起执行者不成：${String(error)}`)
      return undefined
    }

    const executor: Executor = {
      gen,
      token,
      explicit: input.explicit,
      run: newRunRecord({
        gen,
        session: input.session,
        startedAt: now(),
        explicit: input.explicit,
        pid: spawned.pid,
        // **身份那一位当场读**（U50）：那一刻它就站在眼前，是唯一读得准的时候；
        // 重启核对与生命探测拿它判「还是不是这一代」（读不到就缺席，那一档退回保守）
        procStartedAt: spawned.pid === undefined ? undefined : startTimeOf(spawned.pid),
      }),
      spawned,
      link: undefined,
      queued: [],
      watchers: new Set(),
      lastSeen: now(),
      pingSeq: 0,
      snapSeq: 0,
      asking: new Map(),
    }

    executors.add(executor)
    awaiting.set(token, executor)

    spawned.onExit((reason) => {
      retire(executor, reason)
    })

    options.log?.(`起了执行者 第 ${gen} 代 pid=${spawned.pid ?? '?'} 会话=${input.session ?? '（还没开张）'}`)
    saveRuns()
    pushRuns()
    touch()
    return executor
  }

  /**
   * 送一条东西给执行者（命令 / 快照请求）。
   *
   * **没 `ready` 就先攒着**：从起进程到能干活那一段（装载 ＋ 发现 ＋ 恢复）是秒级，
   * 而窗口那边已经在等着了——先送出去只会是「敲了没反应」。攒着的那一份在 `ready`
   * 到达时按序放行。
   */
  function send(executor: Executor, message: ManagerToExecutor): void {
    if (executor.run.ended !== undefined) return

    if (executor.link === undefined || !executor.run.ready) {
      executor.queued.push(message)
      return
    }
    executor.link.send(message)
  }

  /** 送一条**命令**——`send` 的那一层皮（读起来仍是「送一条命令」）。 */
  function deliver(executor: Executor, command: Command): void {
    send(executor, { t: 'cmd', cmd: command })
  }

  // —— 执行者那一路 ——

  function onExecutorMessage(executor: Executor, message: ExecutorToManager): void {
    executor.lastSeen = now()

    switch (message.t) {
      case 'hello':
        // 认领在 `adopt` 里做了（那是**连接**那一跳的事）；这里只补一次登记
        return
      case 'ready': {
        executor.run.ready = true
        // 起来那一刻「正在起执行者」这件事就完了（那一格由 `actionOf` 之外的一处写，
        // 故在这儿清）——`busy` 不动：它说的是**内核**手上有活没有，与本跳无关
        executor.run.action = undefined
        refresh(executor.run, now())
        const queued = executor.queued
        executor.queued = []
        for (const one of queued) {
          if (executor.run.ended !== undefined) break
          executor.link?.send(one)
        }
        saveRuns()
        pushRuns()
        return
      }
      case 'bound':
        executor.run.session = message.session
        refresh(executor.run, now())
        saveRuns()
        pushRuns()
        return
      /**
       * **它手上握着哪几组自有进程**（U50）——照单收下（全量，按最后一次覆盖）。
       *
       * 这一步只落账、不上屏（进程号不进任何读数——设计「不把 PID 常驻」），故**不推
       * 运行事实**；落盘则要（管理者自己没了那条路上，新一代照盘上这一份收）。
       */
      case 'owned':
        executor.run.owned = message.processes
        saveRuns()
        return
      case 'ev':
        onEvent(executor, message.event)
        return
      case 'pong':
        return
      case 'done':
        // **自己受理了收摊**——记成「停止中」，核销等进程真退（见 `retire`）
        markStopping(executor, message.why)
        return
      case 'stopping':
        markStopping(executor, message.why)
        return
      case 'snapshot':
        onSnapshot(executor, message.seq, message.snapshot)
        return
      default:
        return
    }
  }

  /**
   * **照登记收那一代的自有进程组**（U50）——收完把「没收回来的」写在缘由上。
   *
   * 两处调用它：这一趟里没了的（`retire`），与**上一次管理者留下的**（启动核对）。
   * 两处的判据都一样：**只对已经证实不在了的那一代动手**（见 `reclaim.ts` 的头注）。
   *
   * ⚠️ **它是异步的**：收尾有界但要走完三段（等 → TERM → 等 → KILL → 等）。故那一行
   * 的「已停止」照旧**当场**成立（进程真没了才叫核销），要不要补一句「没收干净」由这一跳
   * 回来时补——**不为了收尾把状态卡在半路**。
   */
  async function reclaimRun(record: RunRecord): Promise<void> {
    const report = await reclaim(record.owned)
    const note = reclaimNoteOf(report)
    if (note === undefined || record.ended === undefined) return

    record.reclaimNote = note
    refresh(record, now())
    options.log?.(`收回第 ${record.gen} 代的自有进程组：${note}`)
    saveRuns()
    pushRuns()
  }

  /** 记下「已受理停止」——**停止中**那一行的来处（`ended` 一到它就跳过去了）。 */
  function markStopping(executor: Executor, why: string): void {
    if (executor.run.ended !== undefined) return
    executor.run.stopping = true
    refresh(executor.run, now())
    options.log?.(`第 ${executor.gen} 代受理了停止：${why}`)
    saveRuns()
    pushRuns()
  }

  /**
   * 快照回来了——**先放快照，再放缓冲里水位之后的那几条**。
   *
   * 三处判据：
   * - **按 `seq` 对上**：回来的那一份属于哪一次请求（同一个窗口可能连着绑过两回）；
   * - **按 id 去重 ＋ 只放水位之后的**：缓冲里可能混着快照已经含进去的那几条
   *   （缓冲区比执行者算快照那一刻要早开一步）——设计明文「持久记录按 id 去重」；
   * - **先去重再排序**：缓冲按到达序，而 id 是排序权威，故放行前按 id 排一遍。
   */
  function onSnapshot(executor: Executor, seq: number, snapshot: RunSnapshot): void {
    const connId = executor.asking.get(seq)
    executor.asking.delete(seq)
    if (connId === undefined) return

    const conn = clients.get(connId)
    if (conn === undefined || conn.awaiting !== seq) return

    conn.awaiting = null
    conn.link.send({ t: 'resumed', gen: executor.gen, snapshot })

    const seen = new Set<number>()
    const rest: KernelEvent[] = []
    for (const event of conn.buffered.sort((left, right) => left.id - right.id)) {
      if (event.id <= snapshot.watermark || seen.has(event.id)) continue
      seen.add(event.id)
      rest.push(event)
    }
    conn.buffered = []

    for (const event of rest) conn.link.send({ t: 'ev', gen: executor.gen, event })
  }

  /** 一条内核事件——**广播给盯着这一代的窗口**，顺带把登记里那几格更新到与内核一致。 */
  function onEvent(executor: Executor, event: KernelEvent): void {
    const run = executor.run
    const at = now()

    // 会话从事件里认（这就是 `bound` 那条路的日常形态：首条消息一按下回车，
    // 事件就带上了真会话号）——**不另立一份「它现在在哪条会话」的真源**。
    if (event.session !== '' && event.session !== undefined) {
      if (run.session === null || event.kind === 'session.state') {
        run.session = event.session
      }
    }
    if (event.kind === 'session.state') {
      const active = event.data.active
      if (typeof active === 'string' && active !== '') run.session = active
    }

    // —— 运行事实那几格（U49）——**一处更新，判定在 `facts.ts` ——
    switch (event.kind) {
      case 'agent.state':
        run.busy = event.data.state !== 'waiting'
        break
      case 'turn.start':
        run.turnActive = true
        // 新的一轮开始 ⇒ 上一轮那些「已答复」的记账清掉（它们只在本轮之内管用）
        run.resolvedDecisions.clear()
        break
      case 'turn.end':
        run.turnActive = false
        run.lastTurn = event.data.reason
        run.lastTurnAt = event.at
        // **轮收束 ⇒ 悬着的裁决作废**——与执行者那一侧同一条口径（`executor.ts`）：
        // 卡挂着的时候这一轮没结束，故那条「等你」照旧成立。
        run.decisions.clear()
        break
      case 'tool.decision.request':
        run.decisions.set(event.id, event.data.call)
        break
      case 'tool.decision': {
        // 答复落地——请求那一条从「挂着」挪到「已处理」（晚到的答复据此被认出来）
        for (const [id, call] of run.decisions) {
          if (call === event.data.call) {
            run.decisions.delete(id)
            run.resolvedDecisions.add(id)
          }
        }
        break
      }
      case 'tool.output.delta':
        run.output = { at, sample: tailOf(run.output?.sample, event.data.text) }
        break
      default:
        break
    }

    const action = actionOf(event)
    if (action !== undefined) run.action = action ?? undefined

    if (isProgress(event)) {
      const what = progressOf(event)
      if (what !== undefined) run.progress = { at, what }
    }

    refresh(run, at)

    for (const id of [...executor.watchers]) {
      const conn = clients.get(id)
      if (conn === undefined) continue
      // 等着快照的那一段：**先攒着**（放行的次序与去重见 `onSnapshot`）
      if (conn.awaiting !== null) {
        conn.buffered.push(event)
        continue
      }
      conn.link.send({ t: 'ev', gen: executor.gen, event })
    }

    saveRuns()
    pushRuns()
  }

  /**
   * 核销——自己退了 / 被杀 / 管理者叫停；**只走一遍**。
   *
   * U49 把「这一代怎么收的」记进了运行事实（`ended`）：它是**已停止**与**当前空闲**
   * 那条分水岭（判据见 `facts.ts` 的 `runStateOf`）。三条来路各有各的真相：
   *
   * - **自己收的**（收缩那条路，`stopping` 为真）⇒ 上一轮怎么收的说了算：好好收的算
   *   `normal`（那一行是**当前空闲**），被打断过算 `aborted`（**已停止 · 手动中断**）；
   * - **被杀 / 连接断了而它没说自己要收** ⇒ `crashed`（**已停止 · 异常退出**）。
   *   这一条**不猜**：设计写着异常退出那条路「不伪报取消成功」，而我们没有它的收场回执。
   */
  function retire(executor: Executor, reason: string): void {
    if (executor.run.ended !== undefined) return

    const at = now()
    const kind = executor.run.stopping
      ? endKindOf(executor.run.lastTurn)
      : executor.run.lastTurn === 'aborted'
        ? ('aborted' as const)
        : ('crashed' as const)

    executor.run.ended = { at, why: reason, kind }
    executor.run.connected = false
    executor.run.busy = false
    executor.run.turnActive = false
    executor.run.decisions.clear()
    executor.run.action = undefined
    refresh(executor.run, at)

    executors.delete(executor)
    awaiting.delete(executor.token)
    executor.queued = []
    executor.asking.clear()

    // **留一条「最近一次运行」**——列表上「当前/最近状态」那一格要它
    if (executor.run.session !== null) lastRuns.set(executor.run.session, executor.run)

    for (const id of [...executor.watchers]) {
      const conn = clients.get(id)
      if (conn === undefined) continue
      conn.target = undefined
      conn.awaiting = null
      conn.buffered = []
      // **窗口不是跟着死**：它下一次发命令时管理者会按需要起新的那一代
      // （见 `onCommand`）——「断的是执行者，不是界面」。
      //
      // `detached`（作废旧号）与 `line`（说一句给人听）**两件都要**：前者是**机器**
      // 要的（不作废的话它下一条命令会被当成过期误操作挡下），后者是**人**要的。
      conn.link.send({ t: 'detached', why: reason })
      conn.link.send({ t: 'line', text: `它那一代执行者收摊了（${reason}）` })
    }
    executor.watchers.clear()
    executor.link?.close()

    options.log?.(`核销第 ${executor.gen} 代执行者（${reason}）`)
    saveRuns()
    pushRuns()
    touch()

    // **收回它手上的自有进程组**（U50）——被杀那一代自己跑不到收尾那两跳，这一份登记就是
    // 为它留的（设计：「执行者崩溃或被杀 ⇒ 管理者收回独占权与已登记自有进程组」）。
    // 收没收到如实写回缘由（`reclaim.ts`），**不伪报取消成功**。
    if (executor.run.owned.length > 0) void reclaimRun(executor.run)
  }

  /** 生命探测——**只看「连还通不通」**，不看它在不在干活（长测试静默照样是活的）。 */
  const probe = setInterval(() => {
    for (const executor of [...executors]) {
      if (executor.run.ended !== undefined || executor.link === undefined) continue
      executor.pingSeq += 1
      executor.link.send({ t: 'ping', seq: executor.pingSeq })
    }

    /**
     * **重启核对出来的那些「待确认」也要往下走**（U49）。
     *
     * 那些记录说的是「上一次管理者退出时它还在」——而它多半正在收尾，几秒后就没了。
     * 不往下走的话，那一条会话会**永远**停在「状态待确认」（用户看得见，却什么也没发生）。
     * 判据仍是**事实**：它那个进程还在不在。
     *
     * ⚠️ **「在不在」是两问**（U50）：号在，且那个号上站着的还是当初那一个（`holdsPid`）
     * ——只问前一半的话，一个复用了同一个号的无关进程会把这条会话永远钉在「待确认」上
     * （U49 如实记过的那条限度）。
     *
     * ⚠️ **只查我们记过号的那些**（不是扫全机 PID）——与设计那条一致：生命探测
     * 「不扫描全机 PID、不以 CPU 阈值自动杀进程」。
     */
    let moved = false
    for (const [session, run] of lastRuns) {
      if (run.ended !== undefined || run.stopping) continue
      if (liveOf(session) !== undefined) continue
      if (holdsPid(run, startTimeOf)) continue

      run.ended = { at: now(), why: '它已经不在了', kind: 'crashed' }
      refresh(run, now())
      moved = true
      // 落定为「异常退出」的这一刻，顺带把它登记过的自有进程组收回来（U50）
      if (run.owned.length > 0) void reclaimRun(run)
    }
    if (moved) saveRuns()
    // **顺带把运行事实重推一次**（U49）——同一趟「有限频率」，为的是「多久了」那一格。
    //
    // 由头：长测试**没有输出、没有事件**，而列表上「已跑 3 分 12 秒」这件事仍在变。
    // 不推的话那一格就冻在开列表那一刻（用户看着它，它却不动）。这不是心跳伪装进展
    // ——推的是**时长事实**，一个字都没说「它在干活」（`progress` 只由业务里程碑更新）。
    pushRuns()
  }, probeIntervalMs)
  probe.unref?.()

  /**
   * **它是不是该退了**——「没有执行者、客户端及待处理的投递 / 唤起责任时，管理者退出；
   * 单纯历史或笔记待办不阻止退出，**不成为永远占机器的 daemon**」（设计 · 收缩）。
   *
   * 投递与唤起那两件责任当前还没有（它们随 U50 与协作那一块到站），故这一跳的判据就是
   * **两手都空**。两处细节：
   *
   * - **不是在空的那一刻就退**，而是空够一段时间（`IDLE_MS`）：起管理者与连上来之间
   *   有一段（`magic` 先 `startManager`、再 `connectManager`），当场退的话会把
   *   「刚起来的那个」当成「没人要的那个」；
   * - 判据用的是**最后一次有动静的时刻**（`lastActivity`），不是「当下空不空」——
   *   窗口来了又走、执行者起了又收，那几跳之间也各有间隙。
   *
   * ⚠️ **「最近一次运行」那一份不拦它**：那是历史（设计：单纯历史不阻止退出）。
   */
  let lastActivity = now()

  function touch(): void {
    lastActivity = now()
  }

  const idle = setInterval(() => {
    if (stopped) return
    if (clients.size > 0 || executors.size > 0) return
    if (now() - lastActivity < IDLE_MS) return
    stop('没有执行者、也没有窗口了')
  }, IDLE_CHECK_MS)
  idle.unref?.()

  /**
   * 收摊——**先礼后兵，且「礼」是有界的**。
   *
   * 礼 ＝ 给每一代一句 `bye`，让它自己走到收尾那两跳（等外部服务器释放、再关库——
   * 顺序见 `executor.ts`）。那两跳里可能有**要落盘的东西**（没落完的授权记账），
   * 故不能`bye`完就开杀。
   *
   * 兵 ＝ 有界等待之后还没退的，`kill`。**先礼不等于无限期地等**：收摊这一跳要是能
   * 被一个不听话的执行者拖住，管理者的「无执行者、无客户端时就退出」那条当场不成立。
   *
   * ⚠️ **`server.stop(false)`**（不关在用的连接）：连接一断，执行者那边就只剩
   * 「断开＝自己停」那一条路了——那本来是对的，但那样一来 `bye` 就成了白说一句，
   * 而它的意义正是「让你把手上那两跳走完」。故监听先撤、连接留着。
   */
  function stop(why: string): void {
    if (stopped) return
    stopped = true
    clearInterval(probe)
    if (pushTimer !== undefined) clearTimeout(pushTimer)
    if (saveTimer !== undefined) clearTimeout(saveTimer)

    for (const executor of [...executors]) {
      // **已受理停止**——那一格进登记（「停止中」那一行的事实依据）
      if (executor.run.ended === undefined) {
        executor.run.stopping = true
        refresh(executor.run, now())
      }
      executor.link?.send({ t: 'bye', why: `管理者收摊：${why}` })
    }
    saveRuns(true)

    for (const conn of [...clients.values()]) {
      conn.link.send({ t: 'line', text: `管理者收摊：${why}` })
      conn.link.close()
    }
    clients.clear()

    try {
      server.stop(false)
    } catch {
      // 已经停了
    }
    clearRecord(paths)
    // 管理者手上那份库连接——**它活过任何一个窗口**（设计：「关闭一个窗口不能关闭
    // 其他会话的数据库连接」），故只在管理者自己退的这一跳关
    storeClosed = true
    try {
      store.close()
    } catch {
      // 已经关了
    }

    const deadline = now() + SHUTDOWN_GRACE_MS
    const wait = setInterval(() => {
      if (executors.size === 0 || now() > deadline) {
        clearInterval(wait)

        // 到点还没退的——**兵**。`retire` 顺手把它从表里摘掉，故这一跳走完表是空的
        for (const executor of [...executors]) {
          executor.spawned.kill()
          retire(executor, `管理者收摊：${why}（到点没退）`)
        }
        saveRuns(true)

        // 预检那一趟自己的收尾在它的 `finally` 里（断开它起的那些）——等它落定再
        // 报「退干净了」，否则入口一 `process.exit` 就把那一跳切在半路
        void preflight.catch(() => {}).finally(() => {
          options.log?.(`管理者收摊（${why}）`)
          settle()
        })
      }
    }, 25)
    wait.unref?.()
  }

  options.log?.(`管理者就位 pid=${manager.record.pid} socket=${paths.socket}`)
  return manager
}

/** 那条路径上有人 listen 吗——**用「连得上」判**（比 `stat` 准：尸首也 `stat` 得到）。 */
async function someoneListens(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false

  try {
    const socket = await Bun.connect({ unix: socketPath, socket: socketHandlers() })
    socket.end()
    return true
  } catch {
    return false
  }
}

/** 清掉路径上的尸首——**只在连也连不上时调**（判据在调用方，见 `startManager` 的注）。 */
function clearStale(socketPath: string): void {
  try {
    unlinkSync(socketPath)
  } catch {
    // 别人抢先清了 / 路径本来就没了：两种都等于「已经干净了」
  }
}

/** 自报身份那一份读得回来就读（读不懂＝没有——**它不是权威状态**，坏了不该拦住启动）。 */
export function readRecord(paths: RunPaths): ManagerRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.record, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as Partial<ManagerRecord>
    if (typeof record.pid !== 'number' || typeof record.socket !== 'string') return undefined
    return record as ManagerRecord
  } catch {
    return undefined
  }
}

function writeRecord(paths: RunPaths, record: ManagerRecord): void {
  try {
    writeFileSync(paths.record, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  } catch {
    // 写不下去只影响诊断（谁在管、什么时候起的）——它为这个把管理者拦下来说不过去
  }
}

function clearRecord(paths: RunPaths): void {
  try {
    unlinkSync(paths.record)
  } catch {
    // 同上
  }
}

/**
 * 读上一次留下的那份运行登记——**读不懂＝没有**（同 `manager.json` 那条口径）。
 *
 * 一处**逐条**校验：这份文件是诊断品，不是权威状态，坏了不该拦住启动；但读进来的
 * 每一条都得是像样的（按会话、代次、时刻），否则「重启核对」会拿着半截记录乱判。
 */
export function readRuns(paths: RunPaths): readonly StoredRun[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(paths.runs, 'utf8'))
  } catch {
    return []
  }

  if (typeof parsed !== 'object' || parsed === null) return []
  const runs = (parsed as Partial<StoredRuns>).runs
  if (!Array.isArray(runs)) return []

  const kept: StoredRun[] = []
  for (const one of runs) {
    if (typeof one !== 'object' || one === null) continue
    const run = one as Partial<StoredRun>
    if (typeof run.session !== 'string' || run.session === '') continue
    if (typeof run.gen !== 'number' || typeof run.startedAt !== 'number') continue
    if (!Array.isArray(run.workspace)) continue

    const owned = ownedOf(run.owned)
    kept.push({
      session: run.session,
      gen: run.gen,
      ...(typeof run.pid === 'number' ? { pid: run.pid } : {}),
      ...(typeof run.procStartedAt === 'number' ? { procStartedAt: run.procStartedAt } : {}),
      startedAt: run.startedAt,
      workspace: run.workspace,
      state: run.state ?? 'idle',
      since: typeof run.since === 'number' ? run.since : run.startedAt,
      ...(run.lastTurn === undefined ? {} : { lastTurn: run.lastTurn }),
      ...(typeof run.why === 'string' ? { why: run.why } : {}),
      ...(run.kind === undefined ? {} : { kind: run.kind }),
      // **自有进程组那一笔也要读得回来**（U50）——照登记收是重启核对的一半
      ...(owned === undefined ? {} : { owned }),
    })
  }
  return kept
}

/**
 * 盘上那一笔自有进程组的账——**逐条校验**（判据与这份文件里其余各格同）。
 *
 * 三条都要：号得是个正整数（否则 `kill(-pgid)` 打到的是别人）、`what` 得说得出来、
 * 启动时刻有就是数。**一条都没有 ⇒ `undefined`**（不写一个空数组进落盘形——缺席即无事）。
 */
function ownedOf(raw: unknown): readonly OwnedProcess[] | undefined {
  if (!Array.isArray(raw)) return undefined

  const kept: OwnedProcess[] = []
  for (const one of raw) {
    if (typeof one !== 'object' || one === null) continue
    const group = one as Partial<OwnedProcess>
    if (typeof group.pgid !== 'number' || !Number.isInteger(group.pgid) || group.pgid <= 0) continue
    if (typeof group.what !== 'string') continue
    kept.push({
      pgid: group.pgid,
      startedAt: typeof group.startedAt === 'number' ? group.startedAt : undefined,
      what: group.what,
    })
  }

  return kept.length === 0 ? undefined : kept
}

/**
 * 写那份运行登记——**原子替换**（同目录临时文件 ＋ `rename`）。
 *
 * 为什么不像 `manager.json` 那样直接写：那一份是「一行 JSON」级别的小东西，坏了顶多
 * 少一条诊断；而这一份**重启时要逐条读**——写一半被看见就是拿着半截记录乱判。
 * 临时文件先写、再换名，读到的要么是上一份完整的、要么是这一份完整的。
 */
function writeRuns(paths: RunPaths, runs: readonly StoredRun[], at: number): void {
  const body: StoredRuns = { v: RUNS_VERSION, at, runs }
  const temp = `${paths.runs}.tmp-${process.pid}`
  try {
    writeFileSync(temp, `${JSON.stringify(body)}\n`, { mode: 0o600 })
    renameSync(temp, paths.runs)
  } catch {
    // 写不下去只影响重启核对的那一份取材——它为这个把管理者拦下来说不过去
  }
}
