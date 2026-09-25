/**
 * **运行连接的线上协议**（U48）——管理者 ↔ 执行者 ↔ 客户端三方之间的那一层线。
 *
 * ## 为什么不把 `Command` / `KernelEvent` 本身当消息
 *
 * 契约里那两件是**内核与外壳之间的语言**（冻结面，一字不动）。而这条线要运的是
 * **比它们多一层的东西**：谁在说话、说的是哪一代执行现场、这一句是不是一条生命探测。
 * 把那些塞进 `Command` 就是往冻结面里加字段；故线上一律是**信封**，`cmd` / `event`
 * 是信封里的一格。
 *
 * | 方向 | 消息 |
 * | --- | --- |
 * | 客户端 → 管理者 | `hello`（我是窗口）· `cmd`（带着我认的**代次**）· **`stop`**（停某一条运行）· `bye` |
 * | 管理者 → 客户端 | `welcome`（你连上了谁）· `target` · `detached` · `ev` · `line` · **`runs`**（这一摊的运行事实）· **`resumed`**（接回的那一份快照）· **`stopped`**（停止走到了哪一拍）· **`notice`**（刚发生的一件要告诉你的事） |
 * | 执行者 → 管理者 | `hello`（我是哪条会话的执行者）· `bound` · `ev` · `pong` · `done` · `stopping` · **`snapshot`** · **`owned`**（我握着哪几组自有进程） |
 * | 管理者 → 执行者 | `cmd` · `ping` · `bye` · **`snapshot`**（要一份接回快照） |
 *
 * ## 帧
 *
 * 换行分隔的 JSON（`JSON.stringify` 把换行转义掉了，故一条消息永远落在一行里）。
 * 断句这一层只做一件事：**攒够一整行就交出去**——它也是字节流与消息之间那条缝，
 * 读不懂的行**丢**（一条坏行不该把整条连接带死）。
 *
 * ⚠️ **不做的事**：不重传、不管业务失败。这一层只管「一句话原样过去、原样过来」——
 * 次序与去重是上面那几层的事。
 */

import type { Socket } from 'bun'
import type {
  Command,
  KernelEvent,
  McpConnectionState,
  ModelSwitchRequest,
  OwnedProcess,
  RunNotice,
  RunRow,
  RunSnapshot,
  SessionId,
  StopPhase,
  StopScope,
} from '@magic/contracts'

/**
 * **一台外部服务器的预检读数**（U48 第六段）——**探针的结论，不是工具连接的状态**。
 *
 * 两件事都叫「连 MCP」，但目的、生命周期、归属都不同（设计 · MCP 接入）：
 * 探针答的是「**此刻**配的东西通不通」、归**本机服务（管理者）**、连接 → 报状态 → **断开**；
 * 工具连接答的是「这一轮要用哪些工具」、归**执行者**、随会话存续。
 *
 * 故这一份上线路的只有**读数**：没有工具表、没有凭据、没有连接。执行者那一轮照旧
 * 自己连一次——「预检通过」不是那一次的免死金牌。
 */
export type McpProbeRow = {
  readonly server: string
  readonly state: McpConnectionState
  /** 发现时拒收的件数（服务器自报的名字不合规 / 与同台重名）。 */
  readonly rejected: number
}

/** 客户端 → 管理者。 */
export type ClientToManager =
  | {
      readonly t: 'hello'
      readonly role: 'client'
      readonly label?: string
      /**
       * **显式接续**那条会话（`--session <id>`，U25 的恢复入口）。
       *
       * 由窗口在这一跳说，而不是等它后来发 `session.open`：接续是**开局就定下**的目标
       * ——界面一起来就该落在那条会话上（开屏、读历史、恢复都在它上面）。晚一步说，
       * 那几件都得先问一句「我到哪条会话上」，多一次往返还多一个中间态。
       */
      readonly session?: string
      /**
       * **开局的换模型请求**（`--provider` / `--model`）。
       *
       * 为什么由窗口在这一跳说、而不是随后发一条 `model.switch`：选中要**落在第一轮之前**
       * ——「开局就落地」那条（`cli.ts` 的注）说的正是这件事。晚一步发，第一轮已经带着
       * 缺省模型跑出去了。它随窗口走到**管理者发车那一刻**，由执行者在装配之后、
       * 收第一条命令之前落地（见 `executor.ts`）。
       */
      readonly switch?: ModelSwitchRequest
      /**
       * **全放行**（U73）——命令行 `--allow-all` 在**这一个窗口**上定下的那个布尔。
       *
       * 由窗口在这一跳说、随窗口走到**管理者发车那一刻**，与 `switch` 同一个道理：
       * 它要落在执行者**造闸门之前**（闸门是装配期造的，造完就没有改它的口），
       * 晚一步说就只能干看着一代没有它的执行者。
       *
       * ⚠️ **只有为这个窗口新起的那一代收它**：接上一条已经活着的那一代时**不再 apply**
       * ——那一代有它自己的那一个（同 `switch` 那条「不共享可变选择」）。
       * ⚠️ **它说的是窗口的，不是「这条会话的」**：窗口是在哪儿起的、带没带那个参数，
       * 就是它；**会话本身不记住它**（库里没有这一列）。
       */
      readonly allowAll?: boolean
      /**
       * **启动目录**——窗口在哪儿起的。执行者按它算工作区默认根
       * （配置没写 `workspaceRoots` 时「启动目录＝默认根」，U18 那条`??`）。
       * 它是**窗口的属性**，而窗口是客户端：不给的话执行者只能拿管理者自己那一份，
       * 于是「在 A 目录敲 magic」会落到管理者当初被唤起时的目录上。
       */
      readonly cwd: string
    }
  /** `gen` ＝ 这个窗口认的执行者代次（`null` ＝ 还没认过任何一代）。 */
  | { readonly t: 'cmd'; readonly gen: number | null; readonly cmd: Command }
  /**
   * **停止某一条运行**（U50）——**止于管理者**，不转给执行者（它不是内核命令）。
   *
   * 为什么走这一条而不是 `cmd`：停止是**运行管理**的事——「按明确选择的整体或局部范围
   * 编排」要的正是应用层那一眼（谁在跑、哪一代、手上握着哪几组进程）。内核一个字的运行
   * 管理都不背（设计明文），`Command` 是内核与外壳之间的语言，故不往它里面塞。
   *
   * ⚠️ **不带代次**：窗口认的代次是「我在看哪一代」，而停止说的是「**这一条**别跑了」
   * ——用户按会话/工作操作（设计：「PID 和创建时间仅作诊断」），故按会话点名。
   */
  | { readonly t: 'stop'; readonly session: SessionId; readonly scope: StopScope }
  | { readonly t: 'bye'; readonly why: string }

/** 管理者 → 客户端。 */
export type ManagerToClient =
  | {
      readonly t: 'welcome'
      /** 这条连接的编号（诊断用——线上不长住任何用户可见的东西）。 */
      readonly conn: number
      /** 数据目录的规范形（管理者就是按它认的自己这一摊）。 */
      readonly dataDir: string
      /**
       * **这一摊的外部工具预检读数**（U48 第六段）——管理者启动时那一趟探针的结论。
       *
       * 窗口据它落开屏那一句（「外部工具服务器「broken」连不上：<缘由>」）。它是**服务
       * 状态**的一部分：接上管理者就读得到，与有没有会话、有没有执行者无关
       * ——「空白启动页只有客户端」那条因此不受影响。
       */
      readonly mcp: readonly McpProbeRow[]
      /**
       * **这条窗口服务不了**（`--session` 打错一个字母是唯一一条）。
       *
       * 为什么由管理者在这一跳回绝：它手上才有库（那条会话在不在**只有库说了算**），
       * 而窗口那一侧按设计**不开库**。回绝之后连接当场关——窗口拿不到一个可用的
       * 连接，就只能如实报错退场，而这正是「打错一个字母报错退场，不静默开一条空的」
       * 那条（U28）要的形态。
       */
      readonly refuse?: string
      /**
       * **这一摊的运行事实**（U49）——此刻有哪几条会话在跑、各自什么状态。
       *
       * 为什么随 `welcome` 一起下来：它是**服务状态**的一部分（同 `mcp` 那一格），
       * 与「这个窗口眼下在看哪条会话」无关——开屏那张摘要说的是**这一摊**有几项在跑。
       */
      readonly runs: readonly RunRow[]
      /**
       * **离开期间发生的那几件事**（U50）——只在「那一刻**没人正看着那条会话**」时留下的那些。
       *
       * ⚠️ 判据是**这条会话**有没有窗口正看着它，**不是**有没有窗口连着（U86 起三类同此）：
       * A 页开着而 B 那件事发生时，它**照留**（否则那一件事两头都没人说——D38）。
       *
       * 与 `runs` 一格并不同源：那一份说「此刻什么样」，这一份说「你不在的时候发生了
       * 什么，还没人跟你说过」。给过一次就算说过（管理者那边当场标已读）。
       */
      readonly notices: readonly RunNotice[]
    }
  /**
   * **刚刚发生了一件事**（U50）——完成的 / 出错的 / 等你的。
   *
   * 三类之外一个都不发（设计：「不持续播报『还在跑』」），同一条事实也一次（去重键在
   * 管理者那一头）。**说给用户的那句话由外壳拼**（会话标题在它手上），这一条只报料。
   *
   * ⚠️ **今天没有生产者**（U86 起）：三类**同一把尺子**——看着它 ⇒ 一个字都不说、
   * 没看着 ⇒ 系统通知 ＋ 未读（`welcome.notices`）。**两档都不走窗口**，故 `manager.ts`
   * 的广播拆了；这一格与它下游（`client.onNotice` · `ShellOptions.notices` ·
   * `noticeReceiptOf`）**一并成了死路**，清掉是一笔独立的活（不属任何一格判据）。
   */
  | { readonly t: 'notice'; readonly notice: RunNotice }
  /**
   * **运行事实变了**（U49）——管理者按需推（有了就推，不带请求）。
   *
   * 为什么是**推**而不是等窗口问：那张表的用处一半在「我不用问就知道它在等我」。
   * 让窗口轮询等于把「多久问一次」变成用户等待的下界；而事实是管理者手上现成的。
   * 合并推送（见 `manager.ts` 的 `pushRuns`）：状态变即刻推，输出那类变化按小窗合并。
   */
  | { readonly t: 'runs'; readonly rows: readonly RunRow[] }
  /**
   * **接回的那一份快照**（U49）——同一代次的「此刻」＋ 事件水位。
   *
   * ⚠️ **它必须先于水位之后的事件到达**：管理者是先订阅并缓冲、拿到快照才放行的
   * （见 `manager.ts` 的 `bind`）。窗口收到它就照它把在飞的那几件画回去。
   */
  | { readonly t: 'resumed'; readonly gen: number; readonly snapshot: RunSnapshot }
  /**
   * **客户端换到了另一个执行者**——`gen` 是**当下**那一代的号，`session` 是它认的会话
   * （`null` ＝ 那条执行者还没开张）。
   *
   * 为什么要有这一条：代次是**窗口认的**（它发命令时得带上），而换目标是管理者做的
   * ——不告诉它换成了哪一代，它下一步发的命令就会被当成过期的那一代（U48 第三段）。
   * 它也是外壳「我现在在看哪条会话」那条读数的**权威来处**。
   */
  | { readonly t: 'target'; readonly gen: number; readonly session: string | null }
  /**
   * **窗口与它那一代脱开了**——那一代收了（自退 / 被杀 / 管理者收摊），而这个窗口还在。
   *
   * ⚠️ **窗口不是跟着死**：它下一次发命令时管理者会按需要起新的一代（见 `onCommand`）。
   * 但**它手上那个代次必须先作废**——不作废的话，它带着旧号发的下一条命令会被当成
   * 「过期连接误操作」挡下来（U48 第三段那条判据），而它其实只是想接着干。
   * 「什么时候该忘掉旧号」这件事只有管理者说了算，故由这一条说。
   */
  | { readonly t: 'detached'; readonly why: string }
  /**
   * **停止走到了哪一拍**（U50）——回执**回给发起的那个窗口**（其余窗口看运行事实）。
   *
   * 为什么按会话 ＋ 范围报、不报一句现成的话：**说给用户的那句话要带上那条会话的标题**，
   * 而标题只有窗口手上有（目录在它那儿，管理者只读得到「这条会话在不在」）。故管理者报
   * 「哪一条、哪一档、到了哪一拍」，话由外壳按它自己的目录拼（`shell.ts` 的收据那一跳）。
   */
  | {
      readonly t: 'stopped'
      readonly session: SessionId
      readonly scope: StopScope
      readonly phase: StopPhase
      /** 为什么没停成（`unconfirmed` 时给）——说人话，外壳接在回执后面。 */
      readonly note?: string
    }
  /** `gen` ＝ 这条事件出自哪一代执行者（没有代次可言时给 `null`）。 */
  | { readonly t: 'ev'; readonly gen: number | null; readonly event: KernelEvent }
  /** 一句**给人看**的话（代次过期、管理者要退了……）——客户端把它落成一行回执。 */
  | { readonly t: 'line'; readonly text: string }

/** 执行者 → 管理者。 */
export type ExecutorToManager =
  | {
      readonly t: 'hello'
      readonly role: 'executor'
      /** 管理者发车时给的令牌——认它是「我叫起来的那一个」。 */
      readonly token: string
      /** **开工那条会话**（显式接续时就有）；`null` ＝ 还没开张（首条消息按下回车才建立，D5）。 */
      readonly session: string | null
      /** 工作区整组根（规范形 · 声明序）——登记里要它。 */
      readonly workspace: readonly string[]
    }
  /**
   * **这一代开工了**——发现那一跳跑完、恢复跑完、可以收命令了。
   *
   * 管理者据它把攒下的命令放行：起进程到能干活那一段（装载 ＋ 发现 ＋ 恢复）是秒级，
   * 而窗口那边已经在等着了——**先攒着、到点了再送**，比「命令发出去无声落空」好。
   */
  | { readonly t: 'ready' }
  | { readonly t: 'ev'; readonly event: KernelEvent }
  | { readonly t: 'pong'; readonly seq: number }
  /**
   * **我手上握着哪几组自有进程**（U50）——「执行者崩溃或被杀 ⇒ 管理者收回**已登记**
   * 自有进程组」那句里的**已登记**就是这一条（说出去了才算登记）。
   *
   * 三条口径与账一致（见契约 `ProcessLedger`）：**一组一笔**（不数进程树）· **带身份**
   * （`startedAt`，号会被回收再分配）· **只报我们起的**（`exec` 的命令与 MCP 的 stdio
   * 服务器；HTTP 连接与用户自己的服务从来不进这本账）。
   *
   * ⚠️ **它是「全量」不是「增量」**：账变了就报当下这一刻的全部——增量要配对，一条丢了
   * 就永远差一笔；全量最坏是白报一次（管理者按最后一次覆盖）。
   */
  | { readonly t: 'owned'; readonly processes: readonly OwnedProcess[] }
  /** **跑起来之后才开张**（D5 那条路）——补一条登记，管理者据以把它挂到会话名下。 */
  | { readonly t: 'bound'; readonly session: string }
  /**
   * **自己开始收摊了**（收缩那条路）——管理者据以把它记成「停止中」，**不再等它**。
   *
   * ⚠️ **它与 `stopping` 是一对，和 `done` 也是**：这一条说的是「我受理了这件事，正在
   * 把资源退出去」，而不是「我已经没了」。**核销在进程真退的那一刻**（管理者那头的
   * `onExit`）——「停止中不能提前显示已停止」这条判据靠的正是这个分界。
   */
  | { readonly t: 'done'; readonly why: string }
  /**
   * **已受理停止、正在退出资源**（U49）——`bye` 那条路（管理者收摊 / 到点没退）与
   * 信号那条路都经它说一声。
   *
   * 与 `done` 分开：`done` 是**自己决定**收的（没人看、手上也没事），这一条是**别人叫它
   * 收的**。对管理者来说两件事的后果一样（记成停止中），但缘由不同——诊断时看得清是谁
   * 让谁退的。
   */
  | { readonly t: 'stopping'; readonly why: string }
  /**
   * **接回快照**（U49）——回答管理者那一条 `snapshot`（按 `seq` 配对）。
   *
   * 它**在同一个事件循环里现算**（收到就答，中间不 await）：这样「水位之后的事件」与
   * 「快照里已含的内容」之间不可能夹进一条——事件 id 单调，凡 id 大于水位的都还没发生。
   */
  | { readonly t: 'snapshot'; readonly seq: number; readonly snapshot: RunSnapshot }

/** 管理者 → 执行者。 */
export type ManagerToExecutor =
  | { readonly t: 'cmd'; readonly cmd: Command }
  | { readonly t: 'ping'; readonly seq: number }
  /**
   * **还有几个窗口盯着你**——收缩那条路要看它（设计：「运行已结束、没有在途调用或待答项、
   * **也没有连接者** ⇒ 持久化状态后释放该执行者」）。
   *
   * 为什么由管理者说：连接是**它**在管，执行者看不见「外面还有没有人看」——而那正是
   * 收不收的**一半判据**。另一半（在途调用、待答项）归执行者自己（它看得见内核的状态）。
   */
  | { readonly t: 'watchers'; readonly count: number }
  /** **要一份接回快照**——管理者在把某个窗口挂到这一代上时发（见 `ManagerToClient` 的 `resumed`）。 */
  | { readonly t: 'snapshot'; readonly seq: number }
  | { readonly t: 'bye'; readonly why: string }

/** 线上消息的总表——判别收窄用得到它。 */
export type Wire = ClientToManager | ManagerToClient | ExecutorToManager | ManagerToExecutor

/** 收一条线上的帧——**解不出来就是 `undefined`**（不是抛：坏行不该把连接带死）。 */
export function wireOf(line: string): Wire | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const t = (parsed as { t?: unknown }).t
    return typeof t === 'string' ? (parsed as Wire) : undefined
  } catch {
    return undefined
  }
}

/**
 * 一条**已经通了信**的双向连接。
 *
 * 两个动作各说各话：`send` 是「往对端送」，`onMessage` 是「收对端来的」——名字与契约里
 * 那两个传输端口同一条口径（`ControlTransport` / `KernelTransport` 的两端也是这么分的）。
 */
export type Link<In extends Wire = Wire> = {
  /** 送一条消息；**对端没了**返回 `false`（不抛——收尾那几条路不该被一句送不出去的话打断）。 */
  send(message: Wire): boolean
  /**
   * 收对端来的消息。
   *
   * 泛型 `In` 是**这一端会收到的那一族**：四个方向里有两对判别联合（客户端收
   * `ManagerToClient`、管理者收 `ClientToManager | ExecutorToManager`……），
   * 而 `Wire` 是四者的并——不指出方向的话，`t: 'ev'` 那一支同时匹配两个形状，
   * 收窄当场退化。方向是**造这条连接的人知道的事**，故由他给。
   */
  onMessage(listener: (message: In) => void): void
  /** 断开时告知（**只报一次**，无论谁先断）。 */
  onClose(listener: (error?: Error) => void): void
  /** 关掉（先 FIN）。重复调用无害。 */
  close(): void
  readonly closed: boolean
}

/**
 * `socket` 与它的 `Link` 的对应表——**够不到 `socket.data` 那条路**。
 *
 * 为什么不用 `socket.data`：`Bun.listen` 的那个 `data` 是**监听器级**的一份，
 * 而每一条接进来的连接要有**自己**的一份——照那条路写，第二个连接会把第一个的
 * 收包回调顶掉，症状是「第一条连上的人永远收不到回话」。`WeakMap` 按 socket 认，
 * 各是各的，也不多占谁的生命周期。
 */
const LINKS = new WeakMap<Socket<unknown>, Link>()

/**
 * 把一个 Bun socket 包成 `Link`——**服务端接进来的与客户端连上的走同一条路**。
 *
 * 两处各写一份的代价是「服务端那条路忘了回报 `close`」这类只在一边出现的毛病。
 */
export function linkOf<In extends Wire = Wire>(socket: Socket<unknown>): Link<In> {
  const existing = LINKS.get(socket)
  if (existing !== undefined) return existing as Link<In>

  let buffered = ''
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let closed = false
  let listeners: ((message: Wire) => void)[] = []
  let closeListeners: ((error?: Error) => void)[] = []

  /**
   * **还没送出去的那一截**（空＝没有欠账）——见 `pump` 那段注。
   *
   * 收在**字节**这一层（不是字符串）：`socket.write` 报回来的是**字节数**，
   * 而按字符切一个含中文的串会切在**码点的中间**（一个汉字三个字节、一个字符）。
   */
  let pending: Uint8Array = EMPTY_BYTES

  const settle = (error?: Error): void => {
    if (closed) return
    closed = true
    // 人都走了，欠着的那一截没有送出去的地方了——丢掉（**不是悄悄丢**：对面收不全
    // 整条消息，它那一侧的断句本来就会把它认成坏行，与「这条连接断了」是同一件事）。
    pending = EMPTY_BYTES
    for (const listener of [...closeListeners]) listener(error)
    closeListeners = []
    listeners = []
  }

  /**
   * **把欠着的那一截尽量送出去**（`send` 与 `drain` 两处都走它）。
   *
   * ⚠️ **这是这一层唯一容易做错的地方**（U75 的真因）：`socket.write` **一次只收得下
   * 发送缓冲装得下的那么多**，返回的是**真收下的字节数**——**超出的那一截它不会替你留着**
   * （实测：这条路上一次写 30 468 字节，对面只收到 8 192；再写第二条又把缓冲装到 8 192 为止）。
   * 早先那一版把整条消息交给一次 `write`、**返回值看都不看**，于是**消息一超过那个缓冲就少一截**：
   * 对面收到半行 JSON、按坏行丢掉（这一层的既定口径），而**那半行后面的一切也跟着错位**——
   * 症状是「小消息一直好好的，大的那一条**一个字都到不了**」。
   *
   * 故两条：**写不完的留成欠账**（`pending`），**缓冲满了就等 `drain`**（Bun 在那条路上
   * 回调 `socket.data.drain`，见 `socketHandlers`）——这一跳是**同步**的（`send` 各处都当
   * 它立刻送出），等的责任只能在连接自己身上。
   *
   * 次序不变：欠账与后来的消息**首尾相接**地攒在一起，先欠的先出。
   */
  const pump = (): void => {
    while (!closed && pending.length > 0) {
      let accepted: number
      try {
        accepted = socket.write(pending)
      } catch {
        settle(new Error('写不进去'))
        return
      }
      // **0 ＝ 这一下一点都塞不进去**（发送缓冲满）——欠账留着，等 `drain` 那一跳
      if (accepted <= 0) break
      pending = accepted >= pending.length ? EMPTY_BYTES : pending.slice(accepted)
    }

    if (closed) return
    // **每条都 flush**（实测要的）：不 flush 的话小消息躺在用户态缓冲里等下一次写，
    // 而「下一次写」可能是几秒之后——线上就成了「发出去半分钟没动静」。
    socket.flush()
  }

  const link: Link = {
    send(message) {
      if (closed) return false

      let wire: string
      try {
        wire = `${JSON.stringify(message)}\n`
      } catch {
        settle(new Error('写不进去'))
        return false
      }

      const bytes = encoder.encode(wire)
      pending = pending.length === 0 ? bytes : concat(pending, bytes)
      pump()
      return true
    },

    onMessage(listener) {
      if (closed) return
      listeners.push(listener)
    },

    onClose(listener) {
      if (closed) {
        listener()
        return
      }
      closeListeners.push(listener)
    },

    close() {
      try {
        socket.end()
      } catch {
        // 已经断了 / 对端先断：收尾这一跳不该抛
      }
      settle()
    },

    get closed() {
      return closed
    },
  }

  LINKS.set(socket, link)

  // 收到的字节 → 整行 → 消息（坏行丢掉）
  ;(socket as Socket<LinkSlot>).data = {
    chunk: (bytes) => {
      buffered += decoder.decode(bytes, { stream: true })

      let at = buffered.indexOf('\n')
      while (at !== -1) {
        const line = buffered.slice(0, at)
        buffered = buffered.slice(at + 1)
        if (line.trim() !== '') {
          const message = wireOf(line)
          if (message !== undefined) {
            for (const listener of [...listeners]) listener(message)
          }
        }
        at = buffered.indexOf('\n')
      }
    },
    // **发送缓冲又能装了**（Bun 的回调）——欠着的那一截接着送（见 `pump` 的注）。
    drain: pump,
    gone: settle,
  }

  return link as Link<In>
}

/** 没欠账时那一格（**空数组不新造**——`pending.length === 0` 就是「不欠」的判据）。 */
const EMPTY_BYTES = new Uint8Array(0)

/** 两截字节接起来（欠账 ＋ 新来的那一条）。只在**真有欠账**时才走这一处。 */
function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

/** 挂在 `socket.data` 上的三件——`Bun.listen` / `Bun.connect` 的回调据以找到自己的 `Link`。 */
type LinkSlot = {
  chunk?: (bytes: Uint8Array) => void
  /** 发送缓冲腾出来了（`socket.write` 又能装了）——把欠着的那一截送出去。 */
  drain?: () => void
  gone?: (error?: Error) => void
}

/**
 * `Bun.listen` / `Bun.connect` 的 socket 回调——**两处共用这一份**。
 *
 * `close` 与 `error` 都收成同一次「这一条断了」：对上层来说那两件事的后果一样
 * （这一端没了），分开报只会让每处调用点各写一遍「两种都要当断」。
 *
 * `open` 那一跳由调用方给（服务端要在此把接进来的连接包成 `Link` 并挂上处理；
 * 客户端那头 `Bun.connect` 的 promise 已经交了 socket，用不上它）。
 */
export function socketHandlers(onOpen?: (socket: Socket<LinkSlot>) => void) {
  return {
    open(socket: Socket<LinkSlot>): void {
      onOpen?.(socket)
    },
    data(socket: Socket<LinkSlot>, bytes: Uint8Array): void {
      socket.data?.chunk?.(bytes)
    },
    /**
     * **发送缓冲腾出来了**——`socket.write` 收不下的那一截还欠着，这一跳接着送
     * （见 `pump` 的注）。⚠️ **少了它，超缓冲的消息就永远差着那一截**：收的人等到的是
     * 一条半行，按坏行丢掉——而发送那一侧看起来「已经送出去了」（`write` 没抛）。
     */
    drain(socket: Socket<LinkSlot>): void {
      socket.data?.drain?.()
    },
    close(socket: Socket<LinkSlot>): void {
      socket.data?.gone?.()
    },
    error(socket: Socket<LinkSlot>, error: Error): void {
      socket.data?.gone?.(error)
    },
  }
}
