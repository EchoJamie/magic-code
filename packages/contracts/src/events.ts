/**
 * 共享语言 · 事件（kind 族与载荷 · 信封 · 不落库清单）——已冻结 v0。
 *
 * 出处：技术方案 · 记录（「记录 schema v0」· 事件）· 领域划分（事件产出）。
 * **过程流**——每一步发生了什么（模型调用 / 工具执行 / 裁决 / 回填）；append-only。
 * **事件＝发布语言**（不是域）——各域产生、`EventSink` 直发；落库（持久类）与推送
 * （含瞬时增量）在装配扇出。
 *
 * 两个名字，各司其职：
 * - `EventEnvelope<K>`——**构造面**：造事件时用，泛型收窄到单 kind；
 * - `KernelEvent`——**消费面**：判别联合视图，按 `kind` 自动收窄。
 */

import type { Content, Entry, SessionSummary } from './entries.ts'
import type { RecordId, SessionId, Timestamp, TurnId } from './ids.ts'

// —— 标量与枚举 ——

/** `agent.state` 携带的状态。 */
export type AgentState = 'waiting' | 'paused' | 'resumed'

/** `turn.end` 携带的结束方式（收束 · 中止 · 错误）。 */
export type TurnEndReason = 'settled' | 'aborted' | 'error'

/** 裁决——首站＝人工裁决（批准 / 拒绝）；「总是允许」归阶段 2。 */
export type Decision = 'approve' | 'reject'

/** `model.error` 的错误分档（瞬时 / 超限 / 终态——技术方案 · 模型策略 · 错误分档）。 */
export type ModelErrorTier = 'transient' | 'context-limit' | 'terminal'

/** `model.delta` 的通道（text / thinking / toolcall）。 */
export type DeltaChannel = 'text' | 'thinking' | 'toolcall'

/** 执行输出的通道（`tool.output.delta` 与沙箱 `onOutput` 共用）。 */
export type OutputChannel = 'stdout' | 'stderr'

/** 裁决询问的**呈现轻重**（轻 / 重——技术方案 · 权限：摩擦对准高危）。 */
export type DecisionWeight = 'light' | 'heavy'

/** 裁者——首站恒 `user`；`auto` 为阶段 2 规则化的留位。 */
export type Decider = 'user' | 'auto'

/**
 * **裁决的历史累计**（U28 · `B10` 口径的**跨会话**面）——按 `decider` 分出来的两格。
 *
 * 由头（`交接/进度台账.md` · 随批小修 12 · `U22` 待决 1 规划侧裁「要」）：
 * 本会话那个数（`grants.catalog` 的 `decisions`）只够看「**这一趟**顺不顺」；
 * **看「这个项目值不值得配规则」得跨会话**。
 *
 * **读数只有两格**（`decider` 在事件上，它只分得开这两类）：
 * - `total` ＝走过的裁决数（库里的 `tool.decision` 事件数——`decide` 每次都落一条）；
 * - `auto` ＝其中**没问就放行**的（`decider: 'auto'`：规则或授权命中、判定为轻）。
 *
 * ⇒ **还得你点 ＝ `total - auto`**（不另存一位：三个数里两个是数出来的，第三个是差）。
 *
 * ⚠️ **历史分不开 `vetoed`**：库里那条事件没有「命中规则却被必闸禁区否决」这一位
 * （那要读 `tool.decision.request` 的呈现材料——**文本不是判据**）。
 * 故历史的「还得你点」是本会话 `uncovered + vetoed` 的**并**：
 * 对本会话那两个数，这里是**上界**。**拿不准的那一格不报，不拿它对标本会话的细账。**
 */
export type DecisionHistory = {
  readonly total: number
  readonly auto: number
}

// —— kind 族 ——

/**
 * 事件 kind 族——命名以词典规范名族为准。
 * 产生方见技术方案 · 领域划分（对话域 / 模型域 / 工具域 / 权限域 / 兜底）。
 */
export type EventKind =
  // agent——起 / 状态 / 止（对话域）
  | 'agent.start'
  | 'agent.state'
  | 'agent.end'
  // turn——轮起止；end 带结束方式（对话域）
  | 'turn.start'
  | 'turn.end'
  // message——内容事件：正文归条目 / blob，事件只记「发生 + 引用」（对话域）
  | 'message.user'
  | 'message.assistant'
  // model——调用级；供应商细节不出模型域
  | 'model.call.start'
  | 'model.call.end'
  | 'model.usage'
  | 'model.error'
  // model · 实时——供渲染订阅；**不落库**（落库收束为调用级）
  | 'model.delta'
  // model · 实时——**退避重试中**（瞬时档）：是「正在等」的信号，不是重放事实（重放只看终局）
  | 'model.retry'
  // tool——请求 → 裁决询问（带呈现材料）→ 裁决（批准 / 拒绝 + 裁者 + 耗时）→ 结果
  | 'tool.call'
  | 'tool.decision.request'
  | 'tool.decision'
  | 'tool.result'
  // tool · 实时——执行输出增量；**不落库**
  | 'tool.output.delta'
  // model · 会话——换模型的**结果**（用户命令）；**落库**
  | 'model.switched'
  // 控制 · 模型——**读侧命令（`model.list`）的答复**：注册表全量（缺陷 D10 · 第 3 样）；**不落库**
  | 'model.catalog'
  // session——会话面（阶段 2 · U16）：此刻有哪些会话、当前在哪条；**不落库**
  | 'session.state'
  // 控制 · 会话——外壳**重建展示**的条目块（读侧命令的答复）；**不落库**
  | 'session.history'
  // 控制 · 权限——**授权名录**（U22）：`grants.list` 的答复 ＋ 撤销之后的回话；**不落库**
  | 'grants.catalog'
  // 兜底——内核自身异常（非模型 / 工具域；产生方就近）
  | 'error'
  // 预留——压缩（阶段 3 留位）
  | 'context.compacted'

// —— 事件负载（v0 锚定 · 逐 kind）——

/** 空负载——技术方案 · 记录：空负载＝`Record<string, never>`。 */
export type EmptyPayload = Readonly<Record<string, never>>

/**
 * 增量片段——`model.delta` / `tool.output.delta` 与沙箱 `onOutput` 的共用形态。
 * （`model.delta` 另带 `name?`——见其载荷。）
 */
export type OutputDelta = {
  readonly channel: OutputChannel
  readonly text: string
}

/**
 * 模型条目表的一行——`model.catalog` 的载荷（缺陷 D10 · 第 3 样）。
 *
 * 名字不取 `ModelEntry`：本项目里「条目」专职记录域的 `Entry`（`Entry` / `NewEntry`），
 * 两个「条目」在同一份契约里撞脸＝日后必混。
 */
export type ModelCatalogRow = {
  /** `providers` 的键（**条目名**）——不是供应商细节，是「哪一格」。 */
  readonly provider: string
  /** 该条目的默认模型（`providers.<id>.model`）。 */
  readonly model: string
  /** 上下文窗口总量——**配置声明了才有**（见 `ProviderConfig.contextWindow`）；没声明就不给。 */
  readonly contextWindow?: number
}

/**
 * 授权名录的一行——`grants.catalog` 的载荷（U22 · 技术方案 · 权限「授权的落点」）。
 *
 * **措辞归内核**（`describe`）：条目长什么样只有权限域的 `describeRule` 说了算——
 * 外壳再拼一遍「工具 × 路径 × 操作」就是两处各写一套措辞，改一处漏一处。
 * 而**记账那几件是数据**（次数 / 时刻），外壳据以排「用过几回、多久没用了」。
 */
export type GrantRow = {
  /** 这条授权长什么样（工具 × 路径模式 × 操作类型）——`describeRule` 一处产出。 */
  readonly describe: string
  /** 点下「总是允许」的时刻（毫秒）。 */
  readonly grantedAt: number
  /** 最近一次命中的时刻（毫秒）——**从未命中**时缺席（不给 0 冒充）。 */
  readonly lastHitAt?: number
  /** 命中次数——**从未命中**时缺席（同上，不编）。 */
  readonly hits?: number
  /**
   * **久未命中**（`B11`）——判据由权限域按注入的时钟算好（阈值是实现级常量），
   * 外壳只照着标。⚠️ 标出来**不删**：删用户数据不归内核。
   */
  readonly stale: boolean
}

/**
 * 模型选中——供应商 ＋ 模型两件（`model.switched` 落地后的那种）。
 *
 * 与 `ModelCatalogRow` 分开：选中**未必是表里的某一行**——`model.switch { model }`
 * 可以在同一格上换成本格默认之外的模型，那时选中仍成立，但表里那一行的 `model` 不变。
 */
export type ModelSelectionRef = {
  readonly provider: string
  readonly model: string
}

/**
 * 事件负载映射——逐 kind 的 `data` 形态（技术方案 · 记录 · data 字段 v0）。
 *
 * `entry` / `call` / `summary` 皆为**引用**（`RecordId` 空间共用）；
 * `call` ＝该次调用的 `tool.call` 事件 `id`——贯穿请求 / 询问 / 裁决 / 结果
 * （注：**裁决配对**仍按**请求事件** `id`，见控制面契约）。
 */
export type EventDataOf = {
  // agent——起 / 状态 / 止
  'agent.start': EmptyPayload
  'agent.state': { readonly state: AgentState }
  'agent.end': EmptyPayload
  // turn——轮起止；end 带结束方式
  'turn.start': EmptyPayload
  'turn.end': { readonly reason: TurnEndReason }
  // message——内容事件：正文归条目 / blob，事件只记「发生 + 引用」
  'message.user': { readonly entry: RecordId }
  'message.assistant': { readonly entry: RecordId }
  // model——调用级
  'model.call.start': {
    readonly model: string
    /**
     * 这条条目叫什么（`providers` 的键）——**只增不改**（技术方案 · 代码治理 · 契约生长受控）。
     *
     * 由头：外壳状态行要显示**当前供应商 / 模型**（技术方案 · 领域划分：「运行时切换」锚定），
     * 而外壳够不着注册表（那是装配的把手）。**取「真跑过的那一次」而不是命令的自我报告**：
     * 切不动就不动——若拿用户的意图当状态，屏上会显示一个并没在用的条目。
     *
     * 缺省＝未给（Faux 与直接喂 chunk 的用例不记这个）；取件层真实现一律给。
     */
    readonly provider?: string
  }
  'model.call.end': EmptyPayload
  'model.usage': {
    readonly inputTokens: number
    readonly outputTokens: number
    /**
     * **上下文窗口总量**（token）——`inputTokens/outputTokens` 之外，状态行
     * `12.4k/200k` 的**分母**（缺陷 D10 · 第 1 样）。
     *
     * **分母跟着分子走**：两者同刻同源（都在这一次调用的收束那一刻落定），外壳因此
     * 不会拿一个滞后的分母配一个新分子。来处＝`providers.<id>.contextWindow`
     * （配置加键——见其注）。
     *
     * ⚠️ **模型域的内置容量表（U30）不落这一位**：本条只认条目自己的声明——这个数还喂
     * 压缩阈值（`@magic/conversation`），内置表落这儿会连带改压缩行为（那是另一笔账）。
     * 上屏那一格的分母不走本条：它走条目的读数出口（见 `ModelCatalogRow` 与装配面）。
     *
     * `model.call.start` 也有 `model` / `provider`，但**窗长不从那儿走**：那条事件说的是
     * 「这次用了谁」，用量事件说的是「用了多少、还剩多少余地」——两件事各归各的 kind。
     *
     * 缺省 ＝ 未声明窗长（真实现一律给；Faux 与直接喂 chunk 的用例不记这个）。
     */
    readonly contextWindow?: number
  }
  'model.error': { readonly tier: ModelErrorTier; readonly message: string }
  'model.delta': {
    // 不落库——实时订阅专用
    readonly channel: DeltaChannel
    readonly text: string
    /** toolcall 通道——工具名。 */
    readonly name?: string
    /** toolcall 通道——**供应商侧调用 id**；渲染侧据以按调用分组（同轮可多次调用）。 */
    readonly id?: string
  }
  // tool——请求 → 裁决询问 → 裁决 → 结果
  'tool.call': {
    readonly name: string
    /** 工具各自的参数模式。 */
    readonly args: Readonly<Record<string, unknown>>
  }
  'tool.decision.request': {
    readonly call: RecordId
    readonly name: string
    /** 判断材料——diff / 命令分解 / 影响面。 */
    readonly material: string
    readonly weight: DecisionWeight
  }
  'tool.decision': {
    readonly call: RecordId
    readonly decision: Decision
    readonly decider: Decider
    /** 提示 → 答复。 */
    readonly elapsedMs: number
  }
  'tool.result': {
    readonly call: RecordId
    readonly ok: boolean
    /** 内联或 blob 引用。 */
    readonly output: Content
  }
  'tool.output.delta': {
    // 不落库——实时订阅专用
    readonly call: RecordId
    readonly channel: OutputChannel
    readonly text: string
  }
  'model.retry': {
    // 不落库——实时订阅专用
    /** 第几次尝试即将开工（**从 2 起**——第 1 次是首发，谈不上「重试」）。 */
    readonly attempt: number
    /**
     * **重试上限**（总尝试次数，含首次）——状态行 `2/3` 的**分母**（缺陷 D10 · 第 2 样）。
     *
     * 分母跟着分子走：`attempt` 与 `maxAttempts` 出自**同一个** `RetryPolicy`，外壳因此
     * 不必自钉一个常量（钉了就是编的——策略改了它不知道）。要关重试就说 `maxAttempts: 1`
     * （见 `retry.ts`：1 ＝ 不重试，不加开关），那时这一幕压根不会发生。
     *
     * 缺省 ＝ 未给（Faux 与直接喂 chunk 的用例不记这个）；取件层真实现一律给。
     */
    readonly maxAttempts?: number
    /** 这次退避等多久（毫秒）——呈现「x 秒后」的直接来源。 */
    readonly delayMs: number
    /** 必为 `transient`（退避只对瞬时档；超限 / 终态不重试）——留给渲染侧据以措辞。 */
    readonly tier: ModelErrorTier
  }
  // 控制 · 会话——`history.read` 的答复（技术方案 · 领域划分：「读面走控制面」）。
  // **分块**推：长会话一次塞一个事件＝一个巨型载荷；块大小**实现级**。末块 `done: true`。
  // **不落库**：它是**读出来的**（条目本来就在库里），落库＝把同一段内容存第二遍。
  'session.history': {
    /** 这批条目属于哪条会话——外壳据以丢弃**切走之后才到**的块（分块会跨切换）。 */
    readonly session: SessionId
    /** 这一块（按条目序；块与块之间拼起来即全日志）。 */
    readonly entries: readonly Entry[]
    /** **末块**为 `true`——外壳据此知道重建收尾了。 */
    readonly done: boolean
  }
  // model · 会话——换模型的结果（用户命令）。**落库**（技术方案 · 记录 · kind 族）：
  // 切换是**会话的可观测事实**——`model.call.start` 只说「这次用了谁」，
  // 说不出「何时改的、为什么没改成」；而用户命令不成立**不是内核异常**，
  // 混进 `error` 会污染观测（那一条的语义专留给「内核自身异常」）。
  'model.switched': {
    /** 换成了没有。`false` 时**原选原样保留**（切不动就不动）——`reason` 说为什么。 */
    readonly ok: boolean
    /** 落地后的选中（`ok: true` 时有 —— 也是「现在走的哪一格」）。 */
    readonly provider?: string
    readonly model?: string
    /** 没换成的缘由（**说给人听**的一句话，含已注册的条目名）。 */
    readonly reason?: string
  }
  // 控制 · 模型——**读侧命令（`model.list`）的答复**（缺陷 D10 · 第 3 样）。
  // 外壳的 `/model` 要的是**注册表全量**（含从未调用过的条目），而外壳够不着注册表
  // （那是装配的把手）——与 `session.history` 同一处境、同一走法：**命令进、事件出**。
  // **不落库**：它是**读出来的**（注册表本来就在内存里），落库＝把同一张表存 N 遍
  // （照 `session.history` 同一条理由）。
  'model.catalog': {
    /** 注册表里的**全部**条目（配置顺序）。空表 ＋ `note` ＝ 这次装配没有注册表。 */
    readonly entries: readonly ModelCatalogRow[]
    /**
     * 此刻会走哪一条——**未切换过＝缺省条目 ＋ 它的默认模型**（`stream` 的实际去向）。
     * 外壳据以在表里标「当前」；这次装配没有注册表时缺席。
     */
    readonly current?: ModelSelectionRef
    /** 一句话说明——只在有事要说时给（如「本次装配没有供应商注册表」）。不给＝表自明。 */
    readonly note?: string
  }
  // session——会话面（阶段 2 · U16）。**查询答复 ＋ 变更通报**两种时机共用一个 kind：
  // 外壳问一次（`session.list`）、内核切一条（`session.new` / `session.open`）都回这一条
  // ——三处各立一个 kind 只会让渲染侧写三遍同一段（列表 ＋ 当前）。
  'session.state': {
    /** 当前活跃会话（**单活跃**——同一时刻只有一条）。 */
    readonly active: SessionId
    /** 会话目录——最近在前；标题用 `SessionSummary.title`（改过的取存值，否则按首条消息现算）。 */
    readonly sessions: readonly SessionSummary[]
    /**
     * 一句话说明——**只在有事要说时给**（没开成 / 新建好了 / 改名落定）。
     *
     * 不给＝状态自明，不必赘述。失败**不静默**（打不开就不打开，但得说为什么）——
     * 且**不借 `error`**：那个 kind 的语义是「内核自身异常」，用户命令未成立混进去会污染观测。
     */
    readonly note?: string
  }
  // 控制 · 权限——**授权名录**（U22 · 技术方案 · 权限「授权的落点」）。
  // `grants.list` 的答复，与**撤销之后**的回话共用这一个 kind（三处各立一个只会让渲染侧
  // 写三遍同一段）——撤销选定即撤，撤完再回一份名录，屏上顺手就是新的那一份。
  // **不落库**：它是**读出来的**（`grants.json` 本来就在盘上），落库＝把同一张表存 N 遍。
  'grants.catalog': {
    /** **分节键**——本工作区（默认根的规范形）；授权按它分节存。 */
    readonly workspace: string
    /** 本工作区的授权（声明序）——撤销按这个序报 `index`。 */
    readonly grants: readonly GrantRow[]
    /**
     * **陈旧的节**（`B11`）——**路径已不在**的那些工作区（整节的名录，供撤销）。
     *
     * 判据归**装配**（要不在了得问文件系统，而域不碰 fs）：加载 `grants.json` 时逐节探一次。
     * **只列不删**——「你删或留」，内核不替用户拿主意。
     */
    readonly stale: readonly string[]
    /**
     * **本会话的裁决分布**——放行区那一笔账的**原料**（`B10` 口径：未配规则的调用占比）。
     *
     * 三格两句话（权限域 `GateTally` 那处的口径，此处只转述）：
     * ```
     *   未配规则的调用占比 ＝ uncovered / total
     *   还得人点一下的占比 ＝ (uncovered + vetoed) / total
     * ```
     * 两个数只差 `vetoed` 那一格——规则命中了却被必闸禁区否决的调用，对**用户**是同一个
     * 体验（还是弹了卡），对**规则作者**不是一件事（他得知道「我配的规则够不着这类」）。
     *
     * ⚠️ **是本会话的数，不是历史累计**：闸门按会话实例构造。累计要读记录库里的
     * `tool.decision`（裁者在事件上、分得开「没问」与「秒批」）——那条路归记录域，
     * **U28 起接上了**（见下 `history`）。
     */
    readonly decisions: {
      readonly total: number
      readonly uncovered: number
      readonly vetoed: number
    }
    /**
     * **同一个库里的历史累计**（U28 · 台账随批小修 12）——**跨会话**的那一笔账，
     * 读自记录域的读面（`RecordsStore.decisionHistory`）：本工作区的会话们走过的
     * 全部裁决，按 `decider` 分成两格（见 `DecisionHistory`）。
     *
     * 由头：`decisions` 只够看「这一趟顺不顺」（闸门按会话实例构造）；
     * **「这个项目值不值得配规则」得跨会话**——故这一格与它并列，不合并
     * （两边的分母不是一回事，合成一个数两边都说不准）。
     *
     * **两格都可为 0**（还没走过裁决 / 库里那几条会话没记归属）——外壳**据此不报**，
     * 不拿 0% 占位。
     */
    readonly history: DecisionHistory
    /** 一句话说明——只在有事要说时给（读不懂的条目 / 一条授权都没有 / 文件没读到）。 */
    readonly note?: string
  }
  // 兜底——内核自身异常（非模型 / 工具域）
  error: { readonly message: string }
  // 预留——压缩（阶段 3 留位）
  'context.compacted': { readonly summary: RecordId }
}

// —— 信封与视图 ——

/**
 * 事件信封——每事件必带。
 *
 * **构造面**：泛型 `K` 收窄到单个 kind 以取得该 kind 的 `data` 形态。
 */
export type EventEnvelope<K extends EventKind = EventKind> = {
  readonly id: RecordId
  readonly session: SessionId
  readonly turn: TurnId | null
  readonly at: Timestamp
  readonly kind: K
  readonly data: EventDataOf[K]
}

/**
 * 内核事件——**判别联合视图**（消费侧按 `kind` 自动收窄）。
 *
 * 构造用 `EventEnvelope<K>`；消费用本类型——`if (e.kind === 'tool.call')` 即可收窄 `e.data`。
 * 全仓只此一个事件类型名（构造面与消费面是同一件事的两个视角，不是两个概念）。
 */
export type KernelEvent = { readonly [K in EventKind]: EventEnvelope<K> }[EventKind]

// —— 规则（记录 schema v0）——

/**
 * 规则：
 * ① 流式增量**不逐条落库**（实时走订阅）；
 * ② 大负载落 blob（阈值＝实现级常量）；
 * ③ 裁决与用量**只走事件**；
 * ④ 命名以词典规范名族为准。
 */

/**
 * 规则 ① 的清单——**不落库**的事件 kind（实时订阅专用）。
 *
 * `model.retry` 与 `model.delta` 同列的理由：退避期间那个「正在等」**是实时信号、
 * 不是重放事实**——重放只看终局（这次调用成了没有、内容是什么）。重试次数另落
 * `ModelCallResult.attempts`（可断），故不落库不丢信息。
 */
export const TRANSIENT_EVENT_KINDS: readonly EventKind[] = [
  'model.delta',
  'model.retry',
  'tool.output.delta',
  // 会话状态同列的理由：它是「此刻有哪些会话、当前在哪条」的**快照**，
  // 而重放要的从来不是快照——是过程（谁切到了哪条）。落库只会把同一张表存 N 遍，
  // 且重放时越读越乱（旧快照会把新快照盖回去）。
  'session.state',
  // 读面答复同列的理由（第 19 轮）：它是**读出来的**——条目本来就在库里，
  // 落库＝把同一段内容存第二遍（长会话还会把库撑成两倍）。重放要的是「发生过什么」，
  // 不是「某人问过一次」。
  'session.history',
  // 模型面读答案同列的理由（D10 · 第 3 样）：与 `session.history` 同一条——它是
  // **读出来的**（注册表本来就在内存里），落库＝把同一张表存 N 遍；且外壳的 `/model`
  // 是**反复看**的动作（原型里就是拿它当选择器），每次按一下往库里留一笔「问过」
  // 只会污染观测。重放要的是「换过什么模型」（`model.switched` 落着），不是「看过几眼」。
  'model.catalog',
  // 授权名录同列的理由（U22）：与 `model.catalog` 同一条——它是**读出来的**
  // （`grants.json` 本来就在盘上），落库＝把同一张表存 N 遍；且 `/grants` 是**反复看**的动作
  // （原型的抽屉），每次按一下留一笔「问过」只会污染观测。改动本身**有痕**：撤销是用户动作，
  // 但它的**结果**是文件里少了一条——重放要的是「发生过什么」，不是「谁看过名录」。
  'grants.catalog',
]

/**
 * 记录库 schema 版本（`user_version` 自始写入——技术方案 · 记录 · schema 演进）。
 *
 * **版本 0**——阶段 1/2 的形状（冻结点＝阶段 2 末）。
 * **版本 1**（U26）——`sessions` 加 `workspace` 列（会话归属工作区）：
 * **冻结点已过，走顺序迁移**——既有库照开、数据一件不丢、**不许重建库**。
 */
export const RECORD_SCHEMA_VERSION = 1
