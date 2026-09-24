/**
 * **本机执行管理者**（U48）——一摊运行里**唯一**的那一个。
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
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { Socket } from 'bun'
import type { Command, KernelEvent, MagicHome, McpServerConfig, ModelSwitchRequest } from '@magic/contracts'
import { probeMcp } from './preflight.ts'
import type { McpProbeRow } from './wire.ts'
import { createRecordsStore } from '@magic/records'
import { ensureRunDir, tightenSocket } from './paths.ts'
import type { RunPaths } from './paths.ts'
import { linkOf, socketHandlers } from './wire.ts'
import type { ClientToManager, ExecutorToManager, Link } from './wire.ts'

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
  /** 当下认的会话（`null` ＝ 还没开张）。 */
  session: string | null
  workspace: readonly string[]
  readonly pid: number | undefined
  readonly spawned: SpawnedExecutor
  /** 连上之后才有；在那之前它还没开口。 */
  link: Link<ExecutorToManager> | undefined
  /** 出过 `ready` 没有——`hello` → `ready` 之间攒下的命令见 `pending`。 */
  ready: boolean
  /** 还没送出去的命令（**先攒后送**：没人接的话发出去就是「敲了没反应」）。 */
  pending: Command[]
  /** 盯着它的窗口连接号——事件按这一份广播。 */
  readonly watchers: Set<number>
  /** 上一次听见它（`pong` / 任何一条消息）——诊断与生命探测用。 */
  lastSeen: number
  pingSeq: number
  /**
   * **手里有没有活**——从 `agent.state` 认（与执行者收缩那一跳同一个判据）。
   *
   * 管理者为什么要知道它：`session.new` / `session.open` 这两条**内核忙时会挡回**
   * （`BUSY_NOTE`），而那正是「屏上得有话说」的一条。挡回这件事只有内核说了算，
   * 故忙的时候管理者**不替它换目标**，把命令原样转过去让它自己回话。
   */
  busy: boolean
  /** 已经核销（自己退了 / 被杀 / 管理者叫停）——不再收命令、不再广播。 */
  dead: boolean
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
   * 只有**为这个窗口新起的那一代**收它：接上一代已经在跑的会话时不再apply（那一代
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

  let nextConn = 1
  let nextGen = 1
  let stopped = false
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

  /** 一摊运行的那几件工具——`stop` 与各自的收尾都要它们，故在闭包里立。 */
  const manager: Manager = {
    record,
    socketPath: paths.socket,
    clients: () => clients.size,
    executors: () =>
      [...executors]
        .filter((one) => !one.dead)
        .map((one) => ({ session: one.session, gen: one.gen, pid: one.pid })),
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
        void preflight.then((rows) => {
          probed = rows
          if (link.closed) return
          link.send({ t: 'welcome', conn: conn.id, dataDir: options.dataDir, mcp: probed })
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
      found.session = message.session ?? found.session
      found.workspace = message.workspace
      found.lastSeen = now()
      // 认领的这一刻补一条「现在有几个人看你」——`bind` 那一次发的时候它还没连上来
      // （`link` 是空的），而它接下来的收缩判据正需要这个数。
      tellWatchers(found)
      return found
    }
  }

  function dropClient(id: number): void {
    const conn = clients.get(id)
    if (conn === undefined) return
    clients.delete(id)
    conn.target?.watchers.delete(id)
    if (conn.target !== undefined) tellWatchers(conn.target)
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

    // **换目标的只有这两条**（见文件头注）
    if (command.type === 'session.open' || command.type === 'session.new') {
      // **忙时不动目标**——原样转给当下那一代，由**内核**自己回话
      // （`BUSY_NOTE`：「正在跑一轮——先 Ctrl+C 中断，再切会话」）。
      // 这条不让管理者替它换目标，是因为「忙时挡回」是**内核的口径**：拦在这里另起一代，
      // 就成了「明明在跑，按一下却什么也没发生就换了会话」——那一句该说的话没了。
      if (conn.target !== undefined && conn.target.busy) {
        deliver(conn.target, command)
        return
      }

      if (command.type === 'session.open') {
        retarget(conn, { kind: 'open', session: command.session })
        return
      }

      // **开一条新的不换目标**——原样转给当下那一代，由它自己开一条新链
      // （与今天同一个形态、同一次往返）。换一代在这里没有好处：
      // 旧的会话是**空闲**的（忙时上面已经挡回去了），而空闲且没人看的会话本来就会被收缩；
      // 反倒多出「起一个新进程」那两百毫秒——屏上那次翻页会因此**挪到两百毫秒之后**，
      // 而 `/clear` 看着就该是「按下去就翻」。
      const target = conn.target ?? spawnFresh(conn)
      if (target === undefined) {
        conn.link.send({ t: 'line', text: '起不了执行者——这一条没能送到' })
        return
      }
      deliver(target, command)
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
      return
    }

    const command: Command = { type: 'session.new' }

    if (reusable(current, conn)) {
      const reused = current as Executor
      bind(conn, reused)
      deliver(reused, command)
      return
    }

    const spawned = spawn({
      session: null,
      explicit: false,
      cwd: conn.cwd,
      ...(conn.switch === undefined ? {} : { switch: conn.switch }),
    })
    if (spawned === undefined) {
      conn.link.send({ t: 'line', text: '起不了执行者——没开成新的那条' })
      return
    }
    bind(conn, spawned)
    deliver(spawned, command)
  }

  /** 「当下这个执行者还有用吗」——**没开张 ＋ 只有这一个看客**才敢往上叠新目标。 */
  function reusable(current: Executor | undefined, conn: ClientConn): boolean {
    if (current === undefined || current.dead) return false
    if (current.session !== null) return false
    return current.watchers.size <= 1 && (current.watchers.size === 0 || current.watchers.has(conn.id))
  }

  /** 把窗口挂到某一代上——**换看客**是这一处的全部动作（旧的那一代照跑）。 */
  function bind(conn: ClientConn, executor: Executor): void {
    const from = conn.target
    from?.watchers.delete(conn.id)
    if (from !== undefined && from !== executor) tellWatchers(from)

    conn.target = executor
    executor.watchers.add(conn.id)
    conn.gen = executor.gen
    conn.link.send({ t: 'target', gen: executor.gen, session: executor.session })
    tellWatchers(executor)
  }

  /** 告诉某一代「现在还有几个人看你」——收缩那条路的一半判据（见 `wire.ts` 的 `watchers`）。 */
  function tellWatchers(executor: Executor): void {
    executor.link?.send({ t: 'watchers', count: executor.watchers.size })
  }

  /** 已经活着的那一代（按会话找）——**独占推进权**就落在这一条上：一条会话至多一个。 */
  function liveOf(session: string): Executor | undefined {
    for (const one of executors) {
      if (!one.dead && one.session === session) return one
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
      session: input.session,
      workspace: [],
      pid: spawned.pid,
      spawned,
      link: undefined,
      ready: false,
      pending: [],
      watchers: new Set(),
      lastSeen: now(),
      pingSeq: 0,
      busy: false,
      dead: false,
    }

    executors.add(executor)
    awaiting.set(token, executor)

    spawned.onExit((reason) => {
      retire(executor, reason)
    })

    options.log?.(`起了执行者 第 ${gen} 代 pid=${spawned.pid ?? '?'} 会话=${input.session ?? '（还没开张）'}`)
    touch()
    return executor
  }

  /**
   * 送一条命令给执行者。
   *
   * **没 `ready` 就先攒着**：从起进程到能干活那一段（装载 ＋ 发现 ＋ 恢复）是秒级，
   * 而窗口那边已经在等着了——先送出去只会是「敲了没反应」。攒着的那一份在 `ready`
   * 到达时按序放行。
   */
  function deliver(executor: Executor, command: Command): void {
    if (executor.dead) return

    if (executor.link === undefined || !executor.ready) {
      executor.pending.push(command)
      return
    }
    executor.link.send({ t: 'cmd', cmd: command })
  }

  // —— 执行者那一路 ——

  function onExecutorMessage(executor: Executor, message: ExecutorToManager): void {
    executor.lastSeen = now()

    switch (message.t) {
      case 'hello':
        // 认领在 `adopt` 里做了（那是**连接**那一跳的事）；这里只补一次登记
        return
      case 'ready': {
        executor.ready = true
        const queued = executor.pending
        executor.pending = []
        for (const command of queued) deliver(executor, command)
        return
      }
      case 'bound':
        executor.session = message.session
        return
      case 'ev':
        onEvent(executor, message.event)
        return
      case 'pong':
        return
      case 'done':
        retire(executor, `自己收摊：${message.why}`)
        return
      default:
        return
    }
  }

  /** 一条内核事件——**广播给盯着这一代的窗口**，顺带把登记里那几格更新到与内核一致。 */
  function onEvent(executor: Executor, event: KernelEvent): void {
    // 会话从事件里认（这就是 `bound` 那条路的日常形态：首条消息一按下回车，
    // 事件就带上了真会话号）——**不另立一份「它现在在哪条会话上」的真源**。
    if (event.session !== '' && event.session !== undefined) {
      if (executor.session === null || event.kind === 'session.state') {
        executor.session = event.session
      }
    }
    if (event.kind === 'session.state') {
      const active = event.data.active
      if (typeof active === 'string' && active !== '') executor.session = active
    }
    // 「手里有没有活」——与执行者收缩那一跳同一个判据（`agent.state` 说在跑还是在等）
    if (event.kind === 'agent.state') executor.busy = event.data.state !== 'waiting'

    for (const id of [...executor.watchers]) {
      const conn = clients.get(id)
      if (conn === undefined) continue
      conn.link.send({ t: 'ev', gen: executor.gen, event })
    }
  }

  /** 核销——自己退了 / 被杀 / 管理者叫停；**只走一遍**。 */
  function retire(executor: Executor, reason: string): void {
    if (executor.dead) return
    executor.dead = true
    executors.delete(executor)
    awaiting.delete(executor.token)
    executor.pending = []

    for (const id of [...executor.watchers]) {
      const conn = clients.get(id)
      if (conn === undefined) continue
      conn.target = undefined
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
    touch()
  }

  /** 生命探测——**只看「连还通不通」**，不看它在不在干活（长测试静默照样是活的）。 */
  const probe = setInterval(() => {
    for (const executor of [...executors]) {
      if (executor.dead || executor.link === undefined) continue
      executor.pingSeq += 1
      executor.link.send({ t: 'ping', seq: executor.pingSeq })
    }
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

    for (const executor of [...executors]) {
      executor.link?.send({ t: 'bye', why: `管理者收摊：${why}` })
    }

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
