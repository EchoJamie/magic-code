/**
 * 共享语言 · **运行事实**（U49）——「谁在跑、跑到哪一步」这一层的话。
 *
 * 出处：设计 · 会话与运行管理「用户如何发现和接回」那张状态表，与「状态可信度、独占与
 * 重新连接」那一节（快照 ＋ 事件水位）。
 *
 * ## 它为什么在契约里
 *
 * 这类事实的**产出方是管理者**（`@magic/app` 的运行那一层），**消费方是外壳**
 * （`@magic/tui` 的会话列表与接回）。而外壳只许 import 本包（域 / 外壳 → 契约）——
 * 两边要说同一件事，话就得落在这儿。
 *
 * ⚠️ **它不是内核事件**：事件是「已发生的过程」（`events.ts`），而这里说的是**此刻的
 * 运行事实**（谁活着、有没有人在等你答复）。两者刻意分开：内核一个字的运行管理都不背。
 *
 * ## 三条不上线路的话
 *
 * 进程号、代次、令牌：设计明文「PID 和创建时间**仅作诊断**，用户按会话 / 工作操作」，
 * 故这份读数里一格都没有它们。列表上常见的那句「不把 PID 常驻」在这里是**结构上的**。
 */

import type { RecordId, SessionId } from './ids.ts'
import type { DecisionWeight, TurnEndReason } from './events.ts'

/**
 * **那六行状态**——设计那张表左栏的词，一个不多一个不少。
 *
 * 每一行的事实依据见 `@magic/app` 的 `run/facts.ts`（判定只有那一处）。
 */
export type RunState = 'running' | 'waiting' | 'stopping' | 'stopped' | 'idle' | 'unknown'

/**
 * **一条运行事实**——列表的一行、执行详情的那一份取材。
 *
 * 「缺席＝没有这一件」是本类型的一条纪律（同 `SessionSummary.title`）：没跑过就没有
 * `progress`，没输出就没有 `output`——外壳据此少显示一格，**不拿 0 或空串冒充**。
 */
export type RunRow = {
  readonly session: SessionId
  readonly state: RunState
  /** **这一行从什么时候起**（毫秒）——「已停止 3 分钟」那类时长按它算。 */
  readonly since: number
  /** 这一代**发车**的时刻（毫秒）——执行详情「开始时间」的第一档。 */
  readonly startedAt: number
  /** 上一轮是什么时候收的（毫秒）——没跑过就没有。 */
  readonly lastTurnAt?: number
  /** **此刻在做什么**（进行时）——「正在跑测试」那一格；没有在途的事时缺席。 */
  readonly action?: string
  /** **最近一次可确认进展**——{时刻, 一句}。心跳与流式增量都不更新它。 */
  readonly progress?: { readonly at: number; readonly what: string }
  /** **最近一次输出**——{时刻, 末尾一小段}；长测试的「还在动」由它作证。 */
  readonly output?: { readonly at: number; readonly sample: string }
  /** 「已停止」那一行的缘由（手动中断 / 异常退出…）——别的行不给。 */
  readonly reason?: string
  /**
   * **上一轮是怎么收的**（U50）——「上一轮被中断 / 出错了」那一句的取材。
   *
   * 为什么它得单独有一格：**「已停止」要有核销**（那一行的事实依据是「执行者与自有资源
   * 已核销」），故运行还在而上一轮被打断时，状态是「当前空闲」——那件事于是不能靠状态
   * 说了，由这一格说（详情里念成「上一轮被中断」）。缺省＝没跑过任何一轮。
   */
  readonly lastTurn?: TurnEndReason
  /** 这条会话的工作区整组根（执行者报的规范形）——记录里的归属与现状分得开。 */
  readonly workspace: readonly string[]
  /**
   * 这一行**还占着那条会话**吗——占着就**不能为同一条会话另起一代**
   * （设计：「不能重复启动同会话」）。外壳据它把「接回」与「重开」分开说。
   */
  readonly holds: boolean
}

/**
 * **三类转换**（U50）——设计那句「只在**完成、失败、需要用户**三类转换时通知」里的那三个词。
 *
 * 一个不多一个不少：用户自己按的停止（中断那一轮）**不说**——那是他刚做的事，弹一条通知
 * 复述一遍没有意义；「还在跑」更不说（设计：「**不持续播报**」）。
 */
export type NoticeKind = 'done' | 'failed' | 'needs-you'

/**
 * **一件要告诉用户的事**（U50）——「刚刚发生了一件你不在场时发生的事」。
 *
 * ⚠️ **它不是运行事实**（`RunRow` 那一份说的是「此刻什么样」）：那一份**随时可读**，
 * 这一份是**一次转换留下的那一下**。两者刻意分开——把「刚刚跑完了」塞进运行事实，
 * 就分不清「它是刚完的还是本来就不在跑」。
 *
 * ⚠️ **不自动答复或重跑**（设计明文）：它只是一句话，用户要不要接着干由他定。
 */
export type RunNotice = {
  /** **去重键**——**一条事实一条**（跨窗口、跨重启都按它认）。 */
  readonly id: string
  readonly session: SessionId
  readonly kind: NoticeKind
  readonly at: number
  /**
   * 细节一句（出错的那句话 / 等你定夺的那个名字）——**说给用户的那句话由外壳拼**
   * （会话标题在它手上），这一格是它拼的时候要的料。
   */
  readonly detail?: string
  /**
   * **还没跟用户照过面**——只在「那一刻没人在场」时置上。
   *
   * 它是「**下一次打开汇总未读事项**」的取材：有过窗口在场的那些**当场就说了**，
   * 再汇总一遍是重复念。
   *
   * ⚠️ **「在场」的判据按类分**（U74 / U79）：`failed` 照旧是「有没有窗口连着」；
   * **`done` 与 `needs-you` 是「这条会话有没有窗口正看着它」**——这两类的回执都撤了，
   * 「跟着」它们的这一格也就不能按「有没有窗口连着」算
   * （A 页开着、B 会话跑完 / 在等你：B 那件事正要说给用户听）。
   */
  readonly unread: boolean
}

/**
 * **停到哪一档**（U50）——设计那句「按**明确选择的整体或局部范围**编排」里的那两档。
 *
 * | 这一档 | 用户那句 | 要动的范围 | 完事长什么样 |
 * | --- | --- | --- | --- |
 * | `turn`（**局部**） | 「停这一轮」 | 这条运行**在途的那一件**（模型调用 / 工具调用） | 那条运行还在、还能接着用；**不报「已停止」** |
 * | `run`（**整体**） | 「停这件事」 | 这条运行的**全部资源**（在途 ＋ 自有进程组）＋它自己 | 资源确认退出之后才算停 |
 *
 * 两档都由**应用层**（本机管理者）映射成具体要动的那几条运行——`[设计/多智能体协作]`
 * 那层「整体覆盖全部成员、局部只撤对应部分」的范围语义**未授权实施**，今天的「这件事」
 * 就是这一条运行；映射那一处（`manager.ts` 的 `runsInScope`）是将来加成员档的唯一落点。
 *
 * 「**只停入口 Agent 不算整体已停**」这条判据落在**完成**上：整体那一档要范围内每一条都
 * 核销（执行者与自有资源都确认退出）才报「已停」——只中断了一轮不算。
 */
export type StopScope = 'turn' | 'run'

/**
 * **停止走到了哪一拍**（U50）——回执的三态。
 *
 * - `accepted`——**受理了**（重复停止也走这儿：设计「重复停止可安全受理」，不是报错）；
 * - `done`——范围内**全部核销**（进程真退）；这一拍才算「已停」；
 * - `unconfirmed`——**没能证实停掉**（失联那一代的进程还在、或是没有活着的一代）——
 *   如实说，**不冒充已停**。
 */
export type StopPhase = 'accepted' | 'done' | 'unconfirmed'

/**
 * **接回时那一份「此刻」**——同一代次的快照（设计 · 状态可信度、独占与重新连接 ③）。
 *
 * 三条都从那一句来：
 * - **快照 ＋ 水位**：`watermark` ＝ 这份快照所对应的**最后一条事件的 id**；此后续接
 *   水位之后的消息，**按 id 去重**；
 * - **活动流式内容从有效执行者取当前快照**：`text` / `thinking` 是**此刻**在飞的那一段
 *   （不是上一轮的半段增量）；
 * - **恢复流式内容、进度与待答项**：`tools` / `decisions` 就是另外两件。
 *
 * 时间戳都取自产生处（执行者的时钟），外壳**不自己盖钟**：报时间的是做事的那一头。
 */
export type RunSnapshot = {
  /** 水位——这份快照对应的最后一条事件 id（`0` ＝ 一条都还没有）。 */
  readonly watermark: RecordId
  /** 这一轮开着吗（`turn.start` 之后、`turn.end` 之前）。 */
  readonly turnOpen: boolean
  /** 在飞的助手正文（`text` 通道）——没有在飞的就缺席，**不给空串**。 */
  readonly text?: string
  /** 在飞的思考（`thinking` 通道）——同上。 */
  readonly thinking?: string
  /**
   * **那一段被截过**（只带了末尾）——一条消息长过实现级上限时如实标出来。
   *
   * 为什么要有这一位：快照带回来的那一段会**直接画成那一行**（此后的增量接着往上接），
   * 头被截掉而不说，用户看到的就是一段**没头没尾**的回复——设计那句「**不能把上一轮
   * 半段增量当完整结果**」防的正是这个。截了就说是截了。
   */
  readonly textTruncated?: boolean
  readonly thinkingTruncated?: boolean
  /** 在飞的工具调用（有 `tool.call` 还没有 `tool.result` 的那些）。 */
  readonly tools: readonly SnapshotTool[]
  /** 还挂着的裁决卡（有请求、还没答复）。 */
  readonly decisions: readonly SnapshotDecision[]
  /** 最近一次可确认进展——与 `RunRow.progress` 同一件事的同一份。 */
  readonly progress?: { readonly at: number; readonly what: string }
  /** 最近一次输出。 */
  readonly output?: { readonly at: number; readonly sample: string }
  /**
   * **在跑的是哪个模型 / 它的窗**——状态行那两格（③ 的名字与 ④ 的分母）。
   *
   * 为什么要带上：`model.call.start` 已经在**接回之前**发生过了，而它不落库——
   * 不画回去的话，同一块状态行在接回来的窗口上是**空的**（那两格要等到下一次调用才有）。
   */
  readonly model?: string
  readonly window?: number
  /**
   * **这一代在执行全放行**（U73 · 缺席＝不在全放行 · **一个布尔，没有第二档**）。
   *
   * 为什么要带上：它是**随使用变的状态**（起会话那一刻给的），而 `全放行` 那一格在状态行上
   * **常驻**——「用户必须随时知道自己在全放行」。而它是**执行者**的属性（闸门长在那一头），
   * 窗口这一侧**看不到**：不画回来的话，挂上一条**已经活着**的那一代时，窗口只能拿自己
   * 敲的命令行去猜——那正是最坏的一形（窗口写着「照常问」、闸门却静默放行）。
   * 故它随快照回来，取的是**这一代闸门此刻真的怎么判**。
   */
  readonly allowAll?: boolean
}

/** 快照里的一条在飞工具——够外壳把那一行原样画回去。 */
export type SnapshotTool = {
  /** 配对键：那次 `tool.call` 事件的 id（`tool.output.delta` / `tool.result` 都认它）。 */
  readonly call: RecordId
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** 这一次调用是什么时候开始的（毫秒）——外壳据它算「跑了多久」。 */
  readonly at: number
  /** 已经出来的输出（按行；有界，取末尾若干行）。 */
  readonly output: readonly string[]
}

/** 快照里的一张裁决卡——够外壳把那张卡原样挂回去。 */
export type SnapshotDecision = {
  /** 配对键：**请求事件**的 id（`decision.answer` 原样带回的就是它）。 */
  readonly id: RecordId
  /** 这次裁决问的是哪一次工具调用。 */
  readonly call: RecordId
  /** 卡上那个名字（外部工具＝`服务器 / 工具`，内置＝工具名）。 */
  readonly name: string
  /** 呈现材料——与 `tool.decision.request` 上那一份**同一份字**。 */
  readonly material: string
  readonly weight: DecisionWeight
  /** 外部操作（不给「总是允许」的那一类）。 */
  readonly external?: boolean
}
