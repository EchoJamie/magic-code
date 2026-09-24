/**
 * **运行事实与那张六行状态表**（U49）——「谁在跑、跑到哪一步、我该做什么」的**唯一判定处**。
 *
 * 设计（会话与运行管理 · 用户如何发现和接回）那张表的每一行都写明了**事实依据**。
 * 本文件把那六条依据落成一份**读数**（`RunRecord`）与**一条判定**（`runStateOf`）——
 * 两处各判一遍必然分叉（一处的「等待你」是「有卡挂着」，另一处成了「刚问过」），
 * 故判定只有这一份，管理者与窗口都照它读。
 *
 * | 用户看见 | 事实依据 |
 * | --- | --- |
 * | 执行中 | 执行者有效，正有一段在途的模型调用或工具调用 |
 * | 等待你 | 存在仍有效的提问或审批（答复了／轮收束了就不算） |
 * | 停止中 | **已受理停止**，资源尚未全部退出 |
 * | 已停止 | 那一代**不是正常结束**的（手动中断 / 异常退出） |
 * | 当前空闲 | 没有在途调用与待答项，上一轮**正常结束** |
 * | 状态待确认 | 控制连接失效，**尚未证实**执行结束 |
 *
 * ## 为什么「已停止」与「当前空闲」要分开
 *
 * 两行的依据**不是同一件事**：前者说的是**上一轮是怎么没的**（被打断 / 出错 / 那一代崩了），
 * 后者说的是**手上确实没有活、上一次是好好收的**。一条正常跑完、窗口走了、执行者收摊的
 * 会话属于后者——把它显示成「已停止」是**凭空吓人**；反过来，一条被打断的会话显示成
 * 「当前空闲」，用户就不会去检查停点——而那正是那一行的用处（「看停点、检查未知效果、
 * 明确继续」）。
 *
 * ## 不编的三条
 *
 * - **没有运行记录的会话没有状态**（`runStateOf` 只对**有过一次运行**的会话说得出来）：
 *   一个从没在这一次运行里跑过的历史会话，我们没有关于它的运行事实，列表不替它编一个
 *   「当前空闲」。
 * - **心跳不算进展**（见 `PROGRESS_KINDS`）：生命探测与业务进展是两件事（设计明文）；
 *   拿心跳当「最近有进展」是在编业务事实。
 * - **拿不到的不填**：没有输出就是没有输出，详情只说「已持续多久」。
 */

import type { KernelEvent, RunRow, RunState, TurnEndReason } from '@magic/contracts'

/**
 * 这一代是怎么收的。
 *
 * - `normal`——它自己把活干完、按收缩那条路退的（手上没有在途调用与待答项）；
 * - `aborted`——上一轮是被打断的，而它随后正常收了摊；
 * - `crashed`——被杀、装配没成、连不上那一类：**没有收场回执**。
 */
export type EndKind = 'normal' | 'aborted' | 'crashed'

/**
 * **一条运行记录**——管理者手上关于「这一代在干什么」的全部所知。
 *
 * ⚠️ 它是**管理者的事实**，不是内核的：条目、计划笔记与审批正文都不在这儿（设计明文
 * 「不复制对话、计划笔记与审批事实」）。这里只有**量与句**：跑没跑、跑到哪一步、
 * 最近一句进展是什么、有没有人等着你答复。
 */
export type RunRecord = {
  /** 代次——管理者发的号（一条会话换一个执行者就换一代）。 */
  readonly gen: number
  /** 这条会话（还没开张的空白执行者为 `null`）。 */
  session: string | null
  /** 这一代**发车**的时刻（执行详情「开始时间」的第一档）。 */
  readonly startedAt: number
  /** 显式接续起的一代（`--session` / `/resume` 选定）——普通开一条新的为 `false`。 */
  readonly explicit: boolean
  /** 工作区整组根（执行者报的；还没报＝空数组）。 */
  workspace: readonly string[]
  /** 进程号——**仅作诊断与重启核对**，一个界面都不印它（设计：「不把 PID 常驻」）。 */
  pid: number | undefined
  /** 它的控制连接**接上过**没有——「失联」的判据要它（没接上过就谈不上失去）。 */
  everConnected: boolean
  /** 控制连接此刻还在不在（认领之后、核销之前为真）。 */
  connected: boolean
  /** 执行者报过 `ready` 没有（发现 ＋ 恢复那一跳跑完了吗）。 */
  ready: boolean
  /** 手里有活吗——`agent.state` 那一格（与执行者收缩用**同一个判据**）。 */
  busy: boolean
  /** 这一轮开着（`turn.start` 之后、`turn.end` 之前）。 */
  turnActive: boolean
  /**
   * **还没答复的裁决**——`决策请求事件的 id → 那次工具调用`。
   *
   * 两个键都要：答复（`decision.answer`）带的是**请求事件的 id**，而轮收束 /
   * 答复落地那两条事件认的是**调用**（`tool.decision.call`）。留一份对应关系，
   * 「这条答复还作不作数」才判得出来（见 `manager.ts` 里那一跳）。
   */
  readonly decisions: Map<number, number>
  /**
   * **这一轮里已经答复过的裁决**（请求事件的 id）——「晚到答复明确已处理」那一句的判据。
   *
   * 留着它的代价是几个数；不留的代价是**一个窗口按了半天没反应**（它手里那张卡其实
   * 早被别的窗口答掉了）。清了它的时机是**下一轮开始**（`turn.start`）——一轮之内
   * 的答复终归都能被认出来，而不必留住整段历史。
   */
  readonly resolvedDecisions: Set<number>
  /** **已受理停止**、资源尚未全部退出（`bye` 发出 / 执行者自己说 `stopping`）。 */
  stopping: boolean
  /** 核销的缘由与时刻——**有它就说明这一代结束了**。 */
  ended: { readonly at: number; readonly why: string; readonly kind: EndKind } | undefined
  /** **此刻在做什么**（进行时）——「正在跑测试」那一格。没有在途的事时清空。 */
  action: string | undefined
  /** **最近一次可确认进展**——{时刻, 一句}（只有 `PROGRESS_KINDS` 更新它）。 */
  progress: { readonly at: number; readonly what: string } | undefined
  /** **最近一次输出**——{时刻, 末尾一小段}；长测试的「还在动」由它作证，不是由心跳。 */
  output: { readonly at: number; readonly sample: string } | undefined
  /** 上一轮是怎么收的（`turn.end.reason`）——「已停止」与「当前空闲」的分水岭。 */
  lastTurn: TurnEndReason | undefined
  /** 上一轮**什么时候**收的（毫秒）——详情里「最近一次回复」那一刻。 */
  lastTurnAt: number | undefined
  /** 最近一次听见它（任何一条消息）——生命探测用，**不进任何读数**。 */
  lastSeen: number
  /** 当下这一行是哪一行（`refresh` 维护）——**对外只读这一格**，不在别处再判一遍。 */
  state: RunState
  /** 这一行**从什么时候起**（毫秒）——「已停止 3 分钟」那类时长按它算。 */
  since: number
}

/** 一个执行者刚发车时的记录（其余各格都是「还没有」）。 */
export function newRunRecord(input: {
  readonly gen: number
  readonly session: string | null
  readonly startedAt: number
  readonly explicit: boolean
  readonly pid: number | undefined
}): RunRecord {
  return {
    gen: input.gen,
    session: input.session,
    startedAt: input.startedAt,
    explicit: input.explicit,
    workspace: [],
    pid: input.pid,
    everConnected: false,
    connected: false,
    ready: false,
    /**
     * **`busy` 说的是内核**（`agent.state`）——发车那一刻它是**假**的，而**尚未 `ready`**
     * 由 `ready` 那一格单独说（见 `runStateOf`）。
     *
     * ⚠️ 不能拿 `busy` 兼任「正在起进程」：它还是**忙时挡回**那条判据的取材（内核忙时
     * 不替窗口换会话）——拿它兼起来，刚 spawn 的那一瞬就会被当成「内核在跑一轮」，
     * 于是第二次 `session.open` 被挡回去，而其实什么都没在跑。
     */
    busy: false,
    turnActive: false,
    decisions: new Map(),
    resolvedDecisions: new Set(),
    stopping: false,
    ended: undefined,
    action: '正在起执行者',
    progress: undefined,
    output: undefined,
    lastTurn: undefined,
    lastTurnAt: undefined,
    lastSeen: input.startedAt,
    state: 'running',
    since: input.startedAt,
  }
}

/**
 * **那一条判定**——事实 → 六行里的一行。
 *
 * 次序即优先级，每一档都对应设计那一行的事实依据：
 *
 * 1. **已受理停止、资源没退完**（`stopping` 且还没 `ended`）⇒ 停止中。「**不能提前显示
 *    已停止**」正落在这一档上：`ended` 一到它就跳过去了，没到就一直是停止中。
 * 2. **控制连接失效、尚未证实结束**（接上过、现在不在、且没有 `ended`）⇒ 状态待确认。
 *    ⚠️ 这一档**排在「没在跑」前面**：失联期间历史 `running` 不是现况，而「没在跑」
 *    同样无从谈起——拿不准的那一格不报成「空闲」。
 * 3. **有仍有效的提问或审批** ⇒ 等待你（它优先于执行中：模型正卡在等你）。
 * 4. **有在途的模型/工具调用**（`busy` 或这一轮开着）⇒ 执行中。
 * 5. **上一轮不是好好收的**（被打断 / 出错），或那一代是异常收的 ⇒ 已停止。
 * 6. 其余（手上没活，上一轮正常结束）⇒ 当前空闲。
 */
export function runStateOf(record: RunRecord): RunState {
  if (record.stopping && record.ended === undefined) return 'stopping'

  if (record.ended === undefined && record.everConnected && !record.connected) return 'unknown'

  if (record.decisions.size > 0) return 'waiting'
  // **还没起来也算在跑**：从起进程到 `ready` 那一段是在把这件活支起来——显示成「当前空闲」
  // 是错的（它此刻既不能收交代，也没有一份可以看的最近结果）
  if (record.busy || record.turnActive || (record.ended === undefined && !record.ready)) {
    return 'running'
  }

  const broke = record.lastTurn === 'aborted' || record.lastTurn === 'error'
  if (record.ended !== undefined) {
    return !broke && record.ended.kind === 'normal' ? 'idle' : 'stopped'
  }

  return broke ? 'stopped' : 'idle'
}

/**
 * 把那一行重算一遍，**行变了就换 `since`**——只有这一处写 `state` / `since`。
 *
 * 为什么要有它而不是每处自己判：`since` 说的是「这一行从什么时候起」，而它只有在
 * **行真的换了**那一刻才该动。散在十几个调用点上各写一遍，必然有一处忘了或写反了。
 */
export function refresh(record: RunRecord, at: number): RunState {
  const next = runStateOf(record)
  if (next !== record.state) {
    record.state = next
    record.since = at
  }
  return next
}

/**
 * **「已停止」那一句缘由**——异常那一档要说得出是哪种。
 *
 * 手动中断与异常退出在设计里同属一行，但**缘由分得开才有人能查**：一个是用户按的，
 * 一个是没人按、它自己没的。判据全在事实上（`ended` 的来路 ＋ 上一轮怎么收的），
 * 不另存一句话。
 */
export function stopReasonOf(record: RunRecord): string | undefined {
  // **现判一次**，不读 `record.state` 那一格：它是 `refresh` 维护的（写完 `ended` 而没
  // 来得及 `refresh` 的中间态很常见）——读它会让「缘由」比「状态」慢半拍，而两者本是同一件事
  if (runStateOf(record) !== 'stopped') return undefined
  if (record.ended !== undefined && record.ended.kind === 'crashed') {
    return `异常退出：${record.ended.why}`
  }
  if (record.lastTurn === 'error') return '这一轮出错了'
  if (record.lastTurn === 'aborted') return '手动中断'
  return record.ended?.why ?? '没跑完就停了'
}

/** 上一轮怎么收的 → 这一代的收法（**只用于「它自己退的」那条路**）。 */
export function endKindOf(lastTurn: TurnEndReason | undefined): EndKind {
  return lastTurn === 'aborted' ? 'aborted' : 'normal'
}

/**
 * **哪几类事件算「可确认进展」**——`progress` 只由它们更新。
 *
 * 判据是**业务里程碑**（一件事真发生 / 真结束了），不是「有字节流过」：
 *
 * - `model.delta` / `tool.output.delta` 不算——它们是合批的**渲染增量**，把它们当进展
 *   等于把「模型正在吐字」与「这一步做完了」混为一谈（输出另有一格，见 `output`）；
 * - **心跳更不算**（生命探测根本不走事件面，见文件头注）。
 *
 * 长测试静默十分钟：`progress` 停在「开始跑测试」那一刻，而详情如实显示**已持续多久**
 * ——不谎称卡死，也不伪造进展。
 */
const PROGRESS_KINDS = new Set<KernelEvent['kind']>([
  'turn.start',
  'turn.end',
  'model.call.start',
  'model.call.end',
  'tool.call',
  'tool.result',
  'tool.decision',
  'message.user',
  'message.assistant',
  'plan.changed',
  'error',
])

/** 这条事件值不值得记成「最近一次可确认进展」。 */
export function isProgress(event: KernelEvent): boolean {
  return PROGRESS_KINDS.has(event.kind)
}

/** 一条事件 → 「最近一次可确认进展」那句话（不值一记的返回 `undefined`）。 */
export function progressOf(event: KernelEvent): string | undefined {
  switch (event.kind) {
    case 'turn.start':
      return '开始这一轮'
    case 'turn.end':
      return event.data.reason === 'settled' ? '这一轮收束了' : '这一轮没跑完就停了'
    case 'model.call.start':
      return `向 ${event.data.model} 发了请求`
    case 'model.call.end':
      return '模型回完了'
    case 'tool.call':
      return `开始跑 ${event.data.name}`
    case 'tool.result':
      // ⚠️ 这一条的载荷里**没有工具名**（只有那次调用的 id 与结果）——名字在
      // `tool.call` 那一条上（「开始跑 X」）。此处不拿 id 冒充名字：用户认不得它。
      return '那件工具跑完了'
    case 'tool.decision':
      return `你答复了（${event.data.decision === 'approve' ? '批准' : '拒绝'}）`
    case 'message.user':
      return '收到你的交代'
    case 'message.assistant':
      return '回完了'
    case 'plan.changed':
      return '计划笔记更新了'
    case 'error':
      return `出错：${event.data.message}`
    default:
      return undefined
  }
}

/**
 * **此刻在做的那件事**（进行时）——「正在跑测试」那一格。
 *
 * `null` ＝ 那件在途的事结束了（清空），`undefined` ＝ 这条事件不说「此刻在干什么」。
 * 两者分开，是为了不与 `progress`（回看的里程碑）混成一格。
 */
export function actionOf(event: KernelEvent): string | null | undefined {
  switch (event.kind) {
    case 'model.call.start':
      return `正在等 ${event.data.model} 回话`
    case 'model.call.end':
    case 'turn.end':
      return null
    case 'tool.call':
      return `正在跑 ${event.data.name}`
    case 'tool.result':
      return null
    case 'tool.decision.request':
      // 卡挂着的这一刻就是「等你」——这一格与 `waiting` 那一行是同一件事实的两种说法
      return `等你定夺：${event.data.name}`
    case 'tool.decision':
      return null
    default:
      return undefined
  }
}

/**
 * 输出样本的上限（字符）——详情里那一行「最近输出」。
 *
 * 取**末尾**：测试的输出末尾才是「刚才在说什么」，取开头等于永远停在同一句上。
 */
export const OUTPUT_SAMPLE_CHARS = 200

/** 一条输出增量 → 新的末尾样本（有界，**不把整段输出留在内存里**）。 */
export function tailOf(
  sample: string | undefined,
  chunk: string,
  limit = OUTPUT_SAMPLE_CHARS,
): string {
  const merged = `${sample ?? ''}${chunk}`
  return merged.length <= limit ? merged : merged.slice(-limit)
}

/**
 * 这一条现在还占着那条会话吗——**「接回同一会话只有一个执行者」的另一半**。
 *
 * 判据是设计那句「**不能重复启动同会话**」：只要一代**没被证明结束**，就不能为同一条
 * 会话另起一代。这正是「确认旧执行者仍有独占权时**只能接回**」。
 *
 * 三个「占着」：`running` / `waiting` 手上真有事；`stopping` 资源没退完；
 * `unknown` **尚未证实**结束——最后这一条是「拿不准的不编」在准入上的落点：
 * 证不出来的那件事，宁可不许，也不能放一个新的出来跟它抢同一条会话。
 */
export function blocksNewRun(state: RunState): boolean {
  return state === 'running' || state === 'waiting' || state === 'stopping' || state === 'unknown'
}

/** `RunRecord` → `RunRow`（**未开张的执行者没有会话可挂**，由调用方滤掉）。 */
export function runRowOf(record: RunRecord): RunRow {
  const reason = stopReasonOf(record)
  const lastTurnAt = record.lastTurnAt
  return {
    session: record.session as string,
    state: record.state,
    since: record.since,
    startedAt: record.startedAt,
    ...(lastTurnAt === undefined ? {} : { lastTurnAt }),
    ...(record.action === undefined ? {} : { action: record.action }),
    ...(record.progress === undefined ? {} : { progress: record.progress }),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(reason === undefined ? {} : { reason }),
    workspace: record.workspace,
    holds: blocksNewRun(record.state),
  }
}

/**
 * **落盘形**（`runs.json`）——重启核对的取材。
 *
 * 它是**诊断与核对**用的，不是权威状态：权威是活着的那些 `Executor`。故它缺了、坏了、
 * 陈旧了，都**不该拦住启动**（同 `manager.json` 那条口径）。
 *
 * 一条会话留一条：这一代结束之后它留作「最近一次运行」——列表要的正是「当前/最近状态」。
 */
export type StoredRun = {
  readonly session: string
  readonly gen: number
  readonly pid?: number
  readonly startedAt: number
  readonly workspace: readonly string[]
  readonly state: RunState
  readonly since: number
  readonly lastTurn?: TurnEndReason
  readonly why?: string
  readonly kind?: EndKind
}

/** 落盘那一份的形制版本——将来加字段时读的人据此判。 */
export const RUNS_VERSION = 1

export type StoredRuns = {
  readonly v: number
  readonly at: number
  readonly runs: readonly StoredRun[]
}

/**
 * **保留几条「最近一次运行」**。
 *
 * 判据不是「库里有几条会话」，而是**这份文件是给谁看的**：重启核对要的是「上一次有哪几代
 * 没收拾干净」，而列表要的是「哪几条会话最近在跑」。两条都用不着全史，故有界——文件
 * 不该随会话数无限长大（它是诊断品，不是第二个账本）。
 */
export const STORED_RUNS_LIMIT = 64

/**
 * 一个进程还在不在——**只能问操作系统**。
 *
 * `kill(pid, 0)`：信号 0 不真发信号，只做「这个 pid 归不归我管」那一次判定；`EPERM`
 * 同样是**它还在**（存在但不归我管）。
 *
 * ⚠️ **限度（如实记）**：pid 会被复用。重启核对因此是**保守**的——一个复用了同一个号的
 * 无关进程会让那条会话停在「状态待确认」。这个方向是设计要的（「拿不准的不编」），
 * 且那种情形下唯一的影响是**暂时不能为这条会话另起一代**，而不是误报一个假状态。
 * 更深的句柄身份核对归 U50（「重启核对代次、句柄身份与在途事实」）。
 */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/**
 * **重启核对**——盘上那一份说的事，今天还成不成立。
 *
 * 两条判据，各对一种实情：
 * - **进程还在** ⇒ 上一代**尚未证实结束**：控制连接已经随管理者一起没了，而它自己还在
 *   （执行者的生命连接那条路是自停，但**那是它的动作，不是我们的证明**）⇒ 状态待确认，
 *   且**占着这条会话**；
 * - **进程没了** ⇒ 它与自有资源已经核销，而且是从**上一次管理者的意外退出**里没的
 *   ⇒ 已停止 · 异常退出。这不是猜：设计写着「管理者异常退出 ⇒ 执行者收到断开后自行停止」，
 *   而我们**没有它的收场回执**，故按异常记，不冒充正常收束。
 *
 * 落盘里那条 `state` 只用于一件事：**它当时是不是已经结束了**。是（`idle` / `stopped`）
 * 就照原样留作「最近一次运行」——**已经结束的事实回不去**，重启不该把它翻成「待确认」。
 */
export function reconcile(stored: StoredRun, now: number): RunRecord {
  const record = newRunRecord({
    gen: stored.gen,
    session: stored.session,
    startedAt: stored.startedAt,
    explicit: false,
    pid: stored.pid,
  })
  record.workspace = stored.workspace
  record.lastTurn = stored.lastTurn
  record.busy = false
  record.action = undefined
  // 它当年是**连着**那个管理者的（不然不会落进这份核对表）；「失联」这条判据因此成立
  record.everConnected = true
  // 同理：它当年走到了「能干活」那一跳（没走到的那些由 `everConnected` 那条收）
  record.ready = true

  if (stored.state === 'stopped' || stored.state === 'idle') {
    record.ended = {
      at: stored.since,
      why: stored.why ?? '上一代已经收摊',
      kind: stored.kind ?? 'normal',
    }
    record.state = stored.state
    record.since = stored.since
    return record
  }

  // 盘上那一条说的还不是「结束了」——那今天还成不成立，**由进程在不在说了算**
  if (stored.pid !== undefined && alive(stored.pid)) {
    record.stopping = stored.state === 'stopping'
    record.state = runStateOf(record)
    record.since = stored.since
    return record
  }

  record.ended = { at: now, why: '上一次管理者退出之后它就没了', kind: 'crashed' }
  record.state = 'stopped'
  record.since = stored.since
  return record
}

/** 一条记录 → 落盘形（**未开张的执行者不落**——它还没有会话可挂）。 */
export function storedRunOf(record: RunRecord): StoredRun | undefined {
  if (record.session === null) return undefined
  return {
    session: record.session,
    gen: record.gen,
    ...(record.pid === undefined ? {} : { pid: record.pid }),
    startedAt: record.startedAt,
    workspace: record.workspace,
    state: record.state,
    since: record.since,
    ...(record.lastTurn === undefined ? {} : { lastTurn: record.lastTurn }),
    ...(record.ended === undefined ? {} : { why: record.ended.why, kind: record.ended.kind }),
  }
}
