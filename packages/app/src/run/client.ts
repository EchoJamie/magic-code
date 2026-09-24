/**
 * **终端侧那一端的连接**（U48）——窗口经本机连接接入管理者。
 *
 * 这一层只做三件：**连上、说声我是谁、把话递来递去**。它**不认识任何域**，也不持有
 * 任何执行状态——「窗口只是展示入口」这条（设计 · 会话与运行管理）在这里是结构上的
 * 事实：本文件里一个字都没有「会话 / 运行 / 执行者」的概念，它只有一条连接与一个
 * **代次**（那个代次是机器要的：过期连接的命令一律拒绝，见 `manager.ts` 的 `onCommand`）。
 *
 * 转成外壳要的 `ControlTransport` 是**下一跳**的事（`./terminal.ts`）：那一跳要把
 * 「哪条事件属于我正看的那条会话」「失联怎么显示」这些加上去，而它们不属于
 * 「一条连接怎么说话」。
 *
 * ## 代次为什么由这一层自己记
 *
 * 「我认的是哪一代」不是调用方要操心的东西——它是**连接的状态**，由管理者告知
 * （`welcome` / `target` / `detached` 三条），也由这一层在每条命令上原样带上。
 * 让每个调用点自己记一个数，迟早有一处忘了更新——而那一处的症状是**命令被静默拒绝**。
 *
 * ## 收话这一跳为什么排在打招呼**之前**（U53 · D33）
 *
 * 管理者的 `welcome` **押在外部工具预检上**（U48 第六段：那几台此刻通不通），而
 * 「开局就接哪条会话」这件事它在收到 `hello` 的**同一刻**就办了——`--session <id>`
 * 那条路上，`target`（连同它那条会话）**先于 `welcome`** 发出来。
 *
 * 而 `greet` 里那一个监听只认 `welcome`、别的一律丢（`wire.ts` 的 `linkOf` 按**派发
 * 那一刻**挂着的监听逐个送）。故本层若把收话这一跳挂在 `await greet(...)` **之后**，
 * 那条 `target` 就落在这一层还不认识它的时候：**这一整条连接从此不知道自己认的是哪一代**
 * （`gen` 一直是 `null`）。症状不是报错，是**静默**——
 * `terminal.ts` 那道闸（「还没有目标就别问历史」）据此把开局那一次 `history.read` 丢掉，
 * 于是记录区一个字都不铺，而状态行照旧认得出那条会话（标题是从 `session.list` 那一跳
 * 来的）。这正是 D33。
 *
 * 故次序反过来：**先订阅、后说话**——与设计给重连定的那条同一句话
 * （「先订阅并缓冲……避免快照与订阅之间丢事件」· 状态可信度、独占与重新连接 ③）。
 */

import type { Socket } from 'bun'
import type {
  Command,
  KernelEvent,
  RunNotice,
  RunRow,
  RunSnapshot,
  SessionId,
  StopPhase,
  StopScope,
} from '@magic/contracts'
import { linkOf, socketHandlers } from './wire.ts'
import type { Link, ManagerToClient, McpProbeRow } from './wire.ts'

/**
 * 管理者说「这条窗口我服务不了」——**只有 `--session` 打错一个字母那一条**。
 *
 * 为什么这一处**抛**（而别处一律「连不上就返回 `undefined`」）：这不是「连不上」——
 * 连接是通的、对面是活的，它只是**明确回绝了**。而回绝的理由是要给人看的
 * （`没有这条会话：s-typo——…`），故不能糊成一个 `undefined` 让调用方自己猜。
 */
export class ManagerRefused extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'ManagerRefused'
  }
}

/**
 * **停止走到了哪一拍**（U50）——管理者报的四件，话由外壳按自己的目录拼。
 *
 * 为什么不直接回一句话：**那句话要带上会话的标题**，而标题只有窗口手上有（目录在它那儿，
 * 管理者只读得到「这条会话在不在」）。故这一头只报「哪一条、哪一档、到了哪一拍」。
 */
export type StopReport = {
  readonly session: SessionId
  readonly scope: StopScope
  readonly phase: StopPhase
  readonly note?: string
}

export type ManagerClient = {
  /** 管理者给的连接编号（诊断用）。 */
  readonly conn: number
  /** 这一摊运行的数据目录（管理者的自报）。 */
  readonly dataDir: string
  /**
   * **这一摊的外部工具预检读数**（U48 第六段）——管理者启动时那一趟探针的结论。
   *
   * 它是**服务状态**的一部分（不是执行状态、更不是工具连接）：窗口据它落开屏那一句
   * 「外部工具服务器「broken」连不上：<缘由>」。空数组＝一条都没配，或都通。
   */
  readonly mcp: readonly McpProbeRow[]
  /** 我此刻认的执行者代次（`null` ＝ 还没有目标）。 */
  gen(): number | null
  /**
   * **这一摊此刻的运行事实**（U49）——「谁在跑、什么状态」。
   *
   * 它是**服务状态**（推来的，不必问）：`welcome` 里那一份就在这儿，此后每次变化
   * 由管理者推进来。窗口的会话列表据它给每一行标状态、开屏那张摘要据它数几条在跑。
   */
  runs(): readonly RunRow[]
  /** 运行事实变了（**订阅**；`welcome` 那一份之后才算「变了」——初值走 `runs()`）。 */
  onRuns(listener: (rows: readonly RunRow[]) => void): void
  /**
   * **接回的那一份快照**（U49）——挂到某一代上之后，管理者取来那一代的「此刻」＋ 水位。
   *
   * ⚠️ **它一定先于水位之后的事件到达**（管理者那一侧先订阅并缓冲、拿到快照才放行，
   * 见 `manager.ts` 的 `bind`）。外壳据此把在飞的回复、在跑的工具与挂着的卡画回去。
   */
  onResumed(listener: (gen: number, snapshot: RunSnapshot) => void): void
  /** 管理者指派的目标换了一条会话——外壳据以认「我现在在看哪条」（`null` ＝ 还没开张）。 */
  onTarget(listener: (session: string | null) => void): void
  /** 内核来的事件 ＋ 它的**执行者代次**。 */
  onEvent(listener: (event: KernelEvent, gen: number | null) => void): void
  /**
   * **停止某一条运行**（U50）——整体（`run`）或局部（`turn`），由用户明确选择。
   *
   * 它是**运行管理**的动作，不是内核命令：不经过 `Command` 那一族（见 `wire.ts` 的注）。
   */
  stop(session: SessionId, scope: StopScope): void
  /** 停止走到了哪一拍（受理 / 已核销 / 没能证实）——外壳据它落一行回执。 */
  onStopped(listener: (report: StopReport) => void): void
  /** **离开期间留下的那几件事**（U50）——接上时随 `welcome` 一起下来，此后不重发。 */
  readonly unread: readonly RunNotice[]
  /** **刚刚发生了一件事**（U50）——完成 / 失败 / 需要你，三类之外没有。 */
  onNotice(listener: (notice: RunNotice) => void): void
  /** 管理者**给人看**的话（代次过期、它要退了……）——外壳落成一行回执。 */
  onLine(listener: (text: string) => void): void
  /** 连接断了（**只报一次**）——「管理者不可达」那一路。 */
  onClose(listener: (error?: Error) => void): void
  /** 发一条命令（代次由这一层带上）。 */
  send(command: Command): void
  close(): void
  readonly closed: boolean
}

export type ConnectOptions = {
  /** **显式接续**那条会话（`--session <id>`）——开局就落在这条上（见 `wire.ts` 的注）。 */
  readonly session?: string | undefined
  /** 启动目录——管理者按它起执行者（工作区默认根的缺省）。缺省 `process.cwd()`。 */
  readonly cwd?: string | undefined
  /** 诊断用的标签（哪一类窗口）——缺省不给。 */
  readonly label?: string | undefined
  readonly timeoutMs?: number | undefined
}

/** 连上管理者——连不上（没人 listen / 路径是尸首）返回 `undefined`，不抛。 */
export async function connectManager(
  socketPath: string,
  options: ConnectOptions = {},
): Promise<ManagerClient | undefined> {
  let socket: Socket<unknown>
  try {
    socket = (await Bun.connect({
      unix: socketPath,
      socket: socketHandlers(),
    })) as Socket<unknown>
  } catch {
    return undefined
  }

  const link = linkOf<ManagerToClient>(socket)

  /** 我认的执行者代次——由管理者那三条消息维护（见文件头注）。 */
  let gen: number | null = null
  /** 这一摊的运行事实——`welcome` 那一份是初值（那一下在下面补），此后由 `runs` 那一条推着走。 */
  let runRows: readonly RunRow[] = []
  const noticeListeners: ((notice: RunNotice) => void)[] = []
  const targetListeners: ((session: string | null) => void)[] = []
  const eventListeners: ((event: KernelEvent, gen: number | null) => void)[] = []
  const lineListeners: ((text: string) => void)[] = []
  const runListeners: ((rows: readonly RunRow[]) => void)[] = []
  const resumedListeners: ((gen: number, snapshot: RunSnapshot) => void)[] = []
  const stoppedListeners: ((report: StopReport) => void)[] = []

  link.onMessage((message) => {
    switch (message.t) {
      case 'runs':
        runRows = message.rows
        for (const listener of [...runListeners]) listener(runRows)
        return
      case 'resumed':
        for (const listener of [...resumedListeners]) listener(message.gen, message.snapshot)
        return
      case 'notice':
        for (const listener of [...noticeListeners]) listener(message.notice)
        return
      case 'stopped':
        for (const listener of [...stoppedListeners]) {
          listener({
            session: message.session,
            scope: message.scope,
            phase: message.phase,
            ...(message.note === undefined ? {} : { note: message.note }),
          })
        }
        return
      case 'target':
        gen = message.gen
        for (const listener of [...targetListeners]) listener(message.session)
        return
      case 'detached':
        // 那一代收了——**当下就作废旧号**（不作废的话，下一条命令会被当成过期误操作
        // 挡下来，而这个窗口其实只是想接着干，见 `manager.ts` 的 `retire`）。
        gen = null
        for (const listener of [...targetListeners]) listener(null)
        for (const listener of [...lineListeners]) listener(message.why)
        return
      case 'ev':
        for (const listener of [...eventListeners]) listener(message.event, message.gen)
        return
      case 'line':
        for (const listener of [...lineListeners]) listener(message.text)
        return
      default:
        // `welcome` 已经在上面的往返里收掉了
        return
    }
  })

  // **订阅接上了，才开口说话**（见文件头注：`--session` 那条路上 `target` 先于 `welcome`）
  const greeted = await greet(
    link,
    {
      cwd: options.cwd ?? process.cwd(),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.session === undefined ? {} : { session: options.session }),
    },
    options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS,
  )
  if (greeted === undefined) {
    link.close()
    return undefined
  }

  // **这条窗口服务不了**（`--session` 打错一个字母）——如实把它交出去，让入口报错退场。
  // 「报错不降级」在这里是结构上的：连接已经关了，拿不到一个能用的 `ManagerClient`。
  if (greeted.refuse !== undefined) {
    link.close()
    throw new ManagerRefused(greeted.refuse)
  }

  // `welcome` 那一份运行事实**是初值**——它现算于预检落定的那一刻，故不比此前任何一条
  // 推送旧（推送的读数也算在同一个当下，而它更晚）；此后的变化由 `runs` 那一条推着走。
  runRows = greeted.runs

  return {
    conn: greeted.conn,
    dataDir: greeted.dataDir,
    mcp: greeted.mcp,
    gen: () => gen,
    runs: () => runRows,
    onRuns(listener) {
      runListeners.push(listener)
    },
    onResumed(listener) {
      resumedListeners.push(listener)
    },
    onStopped(listener) {
      stoppedListeners.push(listener)
    },
    unread: greeted.notices,
    onNotice(listener) {
      noticeListeners.push(listener)
    },
    onTarget(listener) {
      targetListeners.push(listener)
    },
    onEvent(listener) {
      eventListeners.push(listener)
    },
    onLine(listener) {
      lineListeners.push(listener)
    },
    onClose(listener) {
      link.onClose(listener)
    },
    send(command) {
      link.send({ t: 'cmd', gen, cmd: command })
    },
    stop(session, scope) {
      link.send({ t: 'stop', session, scope })
    },
    close() {
      link.send({ t: 'bye', why: '窗口收摊' })
      link.close()
    },
    get closed() {
      return link.closed
    },
  }
}

/**
 * 握手的等待上限——**三十秒**。
 *
 * 为什么不是「本机 socket 只要一秒」那个量级：管理者的 `welcome` **押在外部工具预检上**
 * （U48 第六段）——它要把「你配的那几台此刻通不通」一并答出来，而那一趟的每台上限
 * 是十秒。三秒会把「一台连不上的服务器」误判成「这个过程序不对」。
 *
 * 三十秒＝预检那一趟的最坏情形（并行等，各十秒）＋ 一截余量。到点仍然**当场放弃**
 * （不是重试、也不是降级成一个没有 `conn` 的客户端）：回话没来意味着对面那条路不对。
 */
const HANDSHAKE_TIMEOUT_MS = 30_000

/**
 * 说一声「我是窗口」，等管理者回话。
 *
 * 超时**当场放弃**（不是重试、也不是降级成一个没有 `conn` 的客户端）：回话没来意味着
 * 对面那条路不对，而拿一个半开的东西去跑界面，只会把故障拖到用户按第一个键那一刻。
 */
async function greet(
  link: Link<ManagerToClient>,
  hello: {
    readonly cwd: string
    readonly label?: string
    readonly session?: string
  },
  timeoutMs: number,
): Promise<
  | {
      readonly conn: number
      readonly dataDir: string
      readonly mcp: readonly McpProbeRow[]
      readonly runs: readonly RunRow[]
      readonly notices: readonly RunNotice[]
      readonly refuse?: string
    }
  | undefined
> {
  return new Promise((resolve) => {
    let done = false
    const finish = (
      value:
        | {
            readonly conn: number
            readonly dataDir: string
            readonly mcp: readonly McpProbeRow[]
            readonly runs: readonly RunRow[]
            readonly notices: readonly RunNotice[]
            readonly refuse?: string
          }
        | undefined,
    ): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }

    const timer = setTimeout(() => finish(undefined), timeoutMs)

    link.onMessage((message) => {
      if (message.t !== 'welcome') return
      finish({
        conn: message.conn,
        dataDir: message.dataDir,
        mcp: message.mcp,
        runs: message.runs,
        notices: message.notices,
        ...(message.refuse === undefined ? {} : { refuse: message.refuse }),
      })
    })
    link.onClose(() => finish(undefined))

    link.send({ t: 'hello', role: 'client', ...hello })
  })
}
