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

import type { Content, Entry, SessionSummary, UsedSkill } from './entries.ts'
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
  // skill——**技能材料真的送进了模型**（U33）；**不落库**（依据在条目载荷里）
  | 'skill.used'
  // 控制 · 输入——**完整输入已被会话收下**（或没成，U33）；**不落库**
  | 'input.settled'
  // 控制 · 模型——**读侧命令（`model.list`）的答复**：注册表全量（缺陷 D10 · 第 3 样）；**不落库**
  | 'model.catalog'
  // session——会话面（阶段 2 · U16）：此刻有哪些会话、当前在哪条；**不落库**
  | 'session.state'
  // 控制 · 会话——外壳**重建展示**的条目块（读侧命令的答复）；**不落库**
  | 'session.history'
  // 控制 · 权限——**授权名录**（U22）：`grants.list` 的答复 ＋ 撤销之后的回话；**不落库**
  | 'grants.catalog'
  // 控制 · 技能——**技能目录**（U33）：`skills.list` 的答复；**不落库**
  | 'skills.catalog'
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
 * 技能目录的一行——`skills.catalog` 的载荷（U33 · 终端入口）。
 *
 * **只有元数据**（名称 / 简述 / 来源身份），**不含正文**——与端口侧的「启动只发现名称与
 * 描述」是同一条规矩：外壳列个候选不该把仓库里所有技能的主文读一遍，主文到真实提交那一刻
 * 才取（`Skills.readMain`）。
 *
 * 形态为什么不直接借端口侧的 `SkillCatalog`：`events` 是共享语言的地基，而那个类型在
 * `ports.ts`（它反过来 import 本文件）——`events → ports → events` 会绕成一个环。故此处
 * 照列一排（同 `ModelCatalogRow` 之于注册表条目、`GrantRow` 之于权限域的授权）：
 * **事件面上只出现读得出来的那几格**。
 */
export type SkillCatalogRow = {
  /** 名称——敲 `/<名称>` 时敲的就是它（`Skills.readMain` 的身份两件之一）。 */
  readonly name: string
  /** 简述——取自 `SKILL.md` 的 front-matter（人据它浏览，模型据它选用）。 */
  readonly description: string
  /**
   * 技能目录的**真路径**——**身份**就在这儿（`Skill.path`）。
   *
   * 选定带的是它（`SkillRef.path`）：同名两份来源因此分得开，而「失效不换同名项」
   * 也才有判据——按同一个真路径找不回来，就是真失效了。
   */
  readonly path: string
  /**
   * 来源的**人读标签**（如「项目 .magic/skills」）——发现处产出、外壳照印
   * （候选那一行要让人一眼分得出同名的是哪一份）。
   */
  readonly label: string
  /**
   * **同名直达时的先后**（端口侧 `Skill.source` / `Skill.origin` 的原样搬运）。
   *
   * 为什么这两格要随目录一起下来：`/<名称>` 直达是**用户敲的名字**，得当场分出「取哪一份」
   * ——次序是发现面给的（`source` 项目 → 用户 → 配置；同作用域 `origin` 原生 → 兼容），
   * 而外壳只看得到一个数组，**分不出「排在前头」与「同一档里并列」**。并列时不能静默挑一个
   * （那等于随目录顺序蒙），故把这两格带上：外壳据它们判「唯一确定没有」。
   *
   * ⚠️ **两个联合在此**照写**，不 import 端口侧那两个名字**（`SkillSource` / `SkillOrigin`）：
   * 本文件被 `ports.ts` import，反向再引会绕成一个环；而共享语言里 `export *` 出去的同名
   * 两份会**静默消失**（含糊导出），谁也用不成。两处同形是**一件事的两个入口**
   * （端口侧是「发现面怎么说的」、事件面是「读出来的是哪几格」），不是两个概念
   * ——同 `SessionSummary.workspace` 之于配置的 `WorkspaceRoots`。
   */
  readonly source: 'project' | 'user' | 'configured'
  readonly origin: 'magic' | 'agents'
}

/**
 * **一处技能没能照常进来**——形态同端口侧 `SkillProblem`（同一条环的由头，见 `SkillCatalogRow`）。
 *
 * 两类的分量不同（端口侧那条注写全了）：`error` 是**坏了**（用户必须知道，
 * 因为他写的那份压根没生效），`choice` 是**有意的取舍**（同名被顶掉——产品按设计做的选择，
 * 不是故障，不该每次开屏被报一句）。
 */
export type SkillProblemRow = {
  /** 出问题的来源（技能目录或文件真路径；连路径都取不到时给用户写的那一串）。 */
  readonly path: string
  /** 一句人读得懂的话——说清**是什么、为什么、怎么办**。 */
  readonly message: string
  readonly kind: 'error' | 'choice'
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
    /**
     * **卡上的名字**——内置工具＝工具名（`exec`）；外部工具＝**`服务器 / 工具`**
     * （U38：标题取注册表的身份，措辞归内核一处产出，外壳不自己拼）。
     */
    readonly name: string
    /** 判断材料——diff / 命令分解 / 影响面。 */
    readonly material: string
    readonly weight: DecisionWeight
    /**
     * **这是一次外部操作**（U38）——外壳据它换措辞（`外部操作 · 效果由服务器决定`），
     * **不给「总是允许」**（外部效果不由本机裁定，一条「总是允许」记不下那个判断）。
     *
     * 缺席＝内置工具（既有两处措辞一字不动）。**不落库的瞬时位以外的语义**：它是呈现口径，
     * 不是判定——判定（必闸 / 从宽）在 `weight` 与材料里。
     */
    readonly external?: boolean
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
    /**
     * **这一笔压根没跑**——规约重审扣下 · 材料超限停批，由**产生处**写下的事实。
     *
     * 为什么 `ok` 不够（2026-09-20 三轮裁）：「没有开始」与「跑了没成」是两回事——前者没有
     * 耗时这回事、也不该打失败那个叉，而 `ok: false` 把两者说成一件。下游曾退而按**结果正文
     * 首行**去认，那是把一句给人看的文案当成了跨域协议：真跑失败、输出里恰有「未执行后续步骤」
     * 时当场认错（实测把一次真写盘的调用画成没跑）。它是**这一笔结果的事实**，不是第二套执行
     * 状态机。缺省 ＝ 未标（沿旧语义，由 `ok` 说事）。
     */
    readonly notExecuted?: true
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
  // skill——**一次技能材料真的进了上下文**（U33）。**两种选用共用它**：
  // 用户显式选定（随交代提交）与模型按描述自主选用（经受限读取入口），
  // 「实际使用给一次简短回执」是同一句话，不该有两种说法。
  //
  // **产出时机＝材料真的送进了模型**（不是选定那一刻、也不是读取成功那一刻、
  // 更不是「上下文装好了」那一刻）：判据是**这一次请求真回来了**——只有供应商流产出的
  // 事件（`model.delta` / `model.usage` / `model.call.end`）才算数；本地的
  // `model.call.start` / `model.retry` / `model.error` 一律不算（前两种在 fetch 之前就发，
  // 第三种本地与远端同形）。材料在不在这一次的消息里由装配保证，**发出去了没有**由另一端保证，
  // 两件都成立，「已使用」才是一句有据的话。
  //
  // **不落库**：依据在**条目载荷**里（`UserPayload.skills` 的名字 / 来源 / 正文）
  // ——重放读的是那份，落库＝把同一件事存第二遍。这条事件的读者是**当下的屏**。
  'skill.used': {
    /** 这一次实际送达的技能。空数组＝不可能出现（产出方只在送到之后发）。 */
    readonly skills: readonly UsedSkill[]
  }
  // 控制 · 输入——**完整输入已被会话收下**（U33）。两格：收下了 / 没收下。
  //
  // **它说的是「会话收下了这份完整输入」**（正文 ＋ 随它绑定的技能材料已经落进记录），
  // **不是「模型用上了」**——后者是 `skill.used`（见上）。两件**分开报**（2026-09-21 规划裁）：
  // 收下是内核这一侧的事实（落账那一刻就成立），送进模型是另一端的事实（要真回来才算）。
  // 混在一个时点上，要么把「没发出去」说成收下了，要么把「收下了但模型那边失败」说成没收下。
  //
  // **由头**（工单预查）：输入要有**能配对本次提交**的接收 / 失败结果——外壳据以知道
  // 「哪一份草稿可以清、哪一份得留着」。异步失败**不能覆盖用户后来编辑的新稿**：
  // 配对键 `ref` 是外壳自己给的（内核说不出「这是屏上哪一份草稿」），外壳按它跟草稿对，
  // 对不上的（用户已经改了 / 又打了一份）就不动。
  //
  // **出的时机**（三种，一次一条）：
  // - `ok:true` —— **完整条目落账之后**立刻（材料已经随条目落进会话）；
  //   此后模型那边再怎么失败（SDK 参数错 / 网络断 / 被停止），**照模型失败报**
  //   （`model.error` · `turn.end{reason:'error'}`），**不撤销这条已收下的事实**、
  //   也不暗示用户重发；
  // - `ok:false` —— 材料读取失败（技能取不到）· 落账失败 · **停下时清掉的没入会话的排队输入**；
  // - 没给 `ref` 的：`ok:true` 不发（旧路径一字不动，也不给观测添噪声）；
  //   `ok:false` 照发（**失败不静默**）。
  //
  // ⚠️ **给了 `ref` 就必须有终态**：白名单式的「成了才回」会让外壳永等一份草稿。
  'input.settled': {
    /** 配对键——外壳在 `UserInput.ref` 上给的那一个；没给就不在此带键（不编）。 */
    readonly ref?: string
    /** 收下了没有。`false` ＝ 这一份输入**没进会话**（材料取不到 / 落账失败 / 停下时被清掉）。 */
    readonly ok: boolean
    /**
     * 没收下的缘由（**说给人听的一句话**：是哪一份来源出的问题 / 这一条还没轮到就停了）。
     *
     * `ok: true` 时不给——成事不必解释。
     */
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
  // 控制 · 技能——**技能目录**（U33 · 终端入口）。`skills.list` 的答复。
  // **不落库**：与 `model.catalog` / `grants.catalog` 同一条——它是**读出来的**
  // （技能目录本来就在盘上），落库＝把同一张表存 N 遍；且 `/skills` 是**反复看**的动作
  // （选择器），每按一下留一笔「问过」只会污染观测。重放要的是「当时用了哪一份材料」
  // （那在 `user` 条目的载荷里），不是「谁拉过一次目录」。
  'skills.catalog': {
    /**
     * 这一趟发现的技能——**次序即优先级**（项目 → 用户 → 配置；同作用域原生 → 兼容），
     * 与发现面 `discover()` 的产物同序（外壳的「同名直达取哪一份」就按它判）。
     */
    readonly skills: readonly SkillCatalogRow[]
    /**
     * **没进来的那些**（读不懂 / 读不到 / 被顶掉）——与端口侧同一条：静默丢弃会让人
     * 对着一个不生效的技能发呆。外壳据此在列表下方说一句（`choice` 是设计里的取舍，
     * 不必每次都念叨；`error` 必须说）。
     */
    readonly problems: readonly SkillProblemRow[]
    /** 一句话说明——只在有事要说时给。不给＝表自明。 */
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
  // 技能目录同列的理由（U33 · 终端入口）：与 `model.catalog` 同一条——它是**读出来的**
  // （技能目录本来就在盘上），落库＝把同一张表存 N 遍；且 `/skills` 是**反复看**的动作
  // （选择器），每按一下留一笔「问过」只会污染观测。当时到底用了哪一份材料**另有痕**
  // （`user` 条目的载荷：名字 · 来源 · 正文），重放读的是那份。
  'skills.catalog',
  // 技能使用回执同列的理由（U33）：它是**读出来的**——依据本来就在条目载荷里
  // （`UserPayload.skills`：名字 · 来源 · 正文），落库＝把同一件事存第二遍。
  // 重放要的是「当时用了哪一份材料」（读条目就有），不是「当时屏上闪了一句什么」。
  'skill.used',
  // 提交收场同列的理由（U33）：它是**一次收下 / 没跑的答复**，与 `session.state` 同类
  // ——重放要的是过程（`turn.*` 与条目），不是「某人提交过一次」。且它是**异步答复**：
  // 落库之后，恢复时读到的旧回执会与当下的草稿状态对不上（它的配对键是外壳给的，
  // 跨进程重开就没人认领了）。
  'input.settled',
]

/**
 * 记录库 schema 版本（`user_version` 自始写入——技术方案 · 记录 · schema 演进）。
 *
 * **版本 0**——阶段 1/2 的形状（冻结点＝阶段 2 末）。
 * **版本 1**（U26）——`sessions` 加 `workspace` 列（会话归属工作区）：
 * **冻结点已过，走顺序迁移**——既有库照开、数据一件不丢、**不许重建库**。
 */
export const RECORD_SCHEMA_VERSION = 1
