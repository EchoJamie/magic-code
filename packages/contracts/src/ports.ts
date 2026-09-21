/**
 * 跨域端口（九签名 ＋ 端口内类型）——已冻结 v0。
 * **阶段 3 加第十条**：`ProjectRules`（项目规约的来源面，U32）——源头是只读文件树，
 * 与既有九条同一条纪律（域间只经契约、域不碰别人的内部）。
 * **加第十一条**：`Skills`（技能来源面，U33）——同一处境（只读文件树）、同一分工
 * （读在边界、选与送在对话侧）。
 * **加第十二条**：`Materials`（文件 / 目录材料来源面，U36）——同一条分工的第三次；
 * 多一条**只读边界**：工作区外的那一个只收**单个文件**（用户明确选定的只读附件），
 * 目录不在此列。
 *
 * 出处：技术方案 · 领域划分（「契约（耦合契约）」· 端口签名 v0 · 依赖规则）。
 * **依赖倒置的落点**——域包只 import `@magic/contracts`（＋许可外部库）；域之间互不 import、
 * 域不认知外壳与装配；**装配根是唯一 import 具体实现的地方**。
 *
 * 两个端口之外的东西也在此（技术方案 · 领域划分：端口内类型）——
 * **沙箱原语**（`exec` / 读 / 写 / 列 / 匹配）与**工具规格**（`ToolSpec` / 危险归类 / 工具集 v1）。
 *
 * **三个 id 各有空间，不许混**（技术方案 · 领域划分 · 端口内类型）：
 * ① `ToolCall.id` ＝**供应商侧**调用 id（只用于回填配对）；
 * ② 事件的 `call`（`RecordId` 空间）＝贯穿调用链（请求 / 询问 / 裁决 / 结果）的那次调用；
 * ③ `DecisionId` ＝裁决配对的**请求事件** id。
 */

import type { Command, ModelSwitchRequest, SessionCommand, UserInput } from './control.ts'
import type { Content, Entry, EntryRange, NewEntry, SessionSummary, UsedSkill } from './entries.ts'
// MCP 那一支的身份源（`mcp.ts` 与本节互为类型引用——两边都是 `import type`，编译期擦除）
import type { ExternalToolRef } from './mcp.ts'
import type { Decider, Decision, EventDataOf, EventKind, KernelEvent, OutputDelta } from './events.ts'
import type { BlobRef, DecisionId, RecordId, SessionId, TurnId } from './ids.ts'

// ══ 端口 ══════════════════════════════════════════════════════════════

/** 各域 → 装配扇出（技术方案 · 领域划分：事件不经调用箭头，各域直发 `EventSink`）。 */
export type EventSink = {
  emit(event: KernelEvent): void
}

/**
 * 控制域 → 对话域。
 *
 * **多会话（阶段 2 · U16）的「新建 / 切换 / 列表」在此扩展**（技术方案 · 领域划分 ·
 * 端口签名原话）——五件落在**同一个端口**上，不另立一个「会话端口」（同一件事两处各立
 * 一份＝两处各有一套语义，迟早分叉）。故本端口的实现是**会话主面**（单活跃：它持一个
 * 活跃会话，`submit` / `interrupt` 转发给它），而不是某一条会话的实例。
 */
export interface ConversationService {
  submit(input: UserInput): void // input.submit
  interrupt(): void // turn.interrupt
  /**
   * 会话目录——**最近在前**。
   *
   * 标题走既有的 `SessionSummary.title`（可选位）：改过的取存值，没改过的由对话域
   * **按首条消息现算**（技术方案 · 会话与多会话：标题＝首条消息摘要）。两处都没有
   * （首条消息不是用户输入 / 读不出）就缺席——**不拿空串占位**（缺席可辨，空串不可辨）。
   */
  listSessions(): Promise<readonly SessionSummary[]>
  /** 新建一条会话并切过去——返回新会话 id（外壳据以显示 / 记账）。 */
  newSession(): Promise<SessionId>
  /** 切换会话（**装载**该会话的上下文继续推进；在途处置是恢复的事，不在此捎带）。 */
  openSession(session: SessionId): Promise<void>
  /** 改标题（`title` 为原文——裁剪 / 归一归本域）。 */
  renameSession(session: SessionId, title: string): Promise<void>
  /**
   * **重建面** —— 恢复的**第 ⑤ 步**：「上下文由条目重建」（技术方案 · 领域划分 ·
   * 应用层：「首站唯一用例：恢复——照「记录」节那五步……⑤ 上下文由条目重建
   * （`ConversationService`）＋ 界面重建展示（外壳，经事件）」）。
   *
   * **它是什么**——把这条会话的**现场按记录重建**：装载该会话（单活跃，切过去即装载；
   * 已经是它＝无事）· **认下别处已经算好的两件事**（见 `RebuildHandoff`）。
   * 上下文本身**不必搬**——它每轮由条目装配（`context.ts`），本面只把「活的那部分」
   * 与记录对齐。
   *
   * **它不是什么**——① 在途识别（记录域的查询面）· ②③④ 处置（重放 / 落账 / 记中止）
   * 都由**应用层**（`@magic/actions`）编排，不在本面。恢复的**入口**（启动参数 `--session`）
   * 也归应用层受理——那是这一层立起来的意义（审计第 1 条：恢复入口没有归处）。
   *
   * 返回 `Promise<unknown>`——报告是**对话域的域内形态**，不进契约（U15 的分寸：没出，
   * 就没承诺）。`unknown` 是「有返回值、但契约不替它命名」的准确写法：实现可以给**更具体**的，
   * 而契约上的消费者拿不到任何未承诺的形状。
   */
  rebuild(session: SessionId, handoff: RebuildHandoff): Promise<unknown>
}

/**
 * **重建的递手**（`ConversationService.rebuild` 的入参）——应用层算好、交给对话域认下的两件。
 *
 * 为什么由调用方给而不是对话域自己再读一遍：两件都是**跨域编排的产物**，而编排归应用层
 * （它刚从记录域那趟扫描里拿到它们）。让对话域再扫一遍记录＝同一件事两个产地。
 *
 * - `lastTurn` —— 记录里出现过的**最大轮号**：本轮实例的轮号水位从这里接着走
 *   （不从 1 重来——同一会话重启两回不该把两轮都叫「第 1 轮」）。没有＝这条会话
 *   还没有过轮（新会话／空会话）。
 * - `announced` —— **开工是否已经宣告过**：恢复那趟有活可干时，应用层已经替这个实例
 *   发过 `agent.start`（U04 口径：首次干活前发一次）。对话域据此**别发第二遍**；
 *   干净会话（没有活）为 `false`——首次 `submit` 照旧自己发。
 */
export type RebuildHandoff = {
  readonly lastTurn: TurnId | null
  readonly announced: boolean
}

/** 对话域 → 模型域。 */
export interface ModelGateway {
  stream(req: ModelRequest, opts: { signal?: AbortSignal }): ModelStream
}

/** 对话域 → 工具域。闸门在 `invoke` 路径内（不可绕过）。 */
export interface ToolRuntime {
  definitions(): readonly ToolSpec[]
  invoke(
    call: ToolCall,
    opts: { signal?: AbortSignal; onOutput?: (d: OutputDelta) => void },
  ): Promise<ToolResult>
}

/** 工具域 → 权限域。 */
export interface PermissionGate {
  /**
   * 请裁决。
   *
   * `callRef` ＝**该次 `tool.call` 事件的 id**（事件载荷 `call` 的来处）——「请求 → 询问 →
   * 裁决 → 结果」四事件串链的依据（审计与阶段 2 恢复的**在途识别**都按它找）。
   * 权限域自己拿不到（那是工具域发的事件），故由调用方传入；**必填**——
   * 不设哨兵兜底：静默的 `-1` 比缺参更坏，接线漏了应当在**编译期**就报。
   */
  decide(call: ToolCall, ctx: PermissionContext, callRef: RecordId): Promise<Decision>
  /**
   * 控制域答复路由至此。
   *
   * 第三参 `opts.remember` ＝答复上的**「总是允许」位**（见 `control.ts` · `DecisionAnswer.remember`）
   * ——控制域**原样转手**、不翻译；**授权的落点归权限域**（凝成一条授权，按
   * 工具 × 路径模式 × 操作类型 记，**落点是工作区**）。**缺省＝不给＝一次性**（向后兼容）。
   */
  resolve(requestId: DecisionId, decision: Decision, opts?: { remember?: boolean }): void
}

/** 对话域 → 记录域。 */
export interface RecordsService {
  /**
   * 取下一个记录 id——**id 空间归记录域**（条目 / 事件共用）。
   * 装配据以构造 `EventStamper`（技术方案 · 领域划分 · 信封的归属）。
   */
  nextId(): RecordId
  appendEntry(entry: NewEntry): RecordId
  appendEvent(event: KernelEvent): void
  readEntries(sessionId: SessionId, range?: EntryRange): AsyncIterable<Entry>
  /** 恢复 / 审计。 */
  readEvents(sessionId: SessionId): AsyncIterable<KernelEvent>
  /**
   * **在途识别**（恢复 ①）——有 `tool.call` 无 `tool.result` 的那几笔，连同它们走过的
   * 裁决轨迹与中断的轮（见 `RecoveryScan`）。
   *
   * **查询面归记录域**（技术方案 · 领域划分 · 各域结构规则：「恢复的查询面（在途识别）
   * 由它提供」）：处置（重放 / 落账）不在这里——那是应用层的编排（`@magic/actions`）。
   * 本条只**说不判**：把记录里读得出的事实说全，判定留给读的人。
   *
   * ⚠️ 与 `readEvents` 的分工：`readEvents` 是**逐条的流**（审计与重建展示要全量），
   * 本方法是**一次扫描的结论**（恢复只要那几笔在途）。两者不同物，不是一个方法的别名。
   */
  scanInFlight(session: SessionId): Promise<RecoveryScan>
  listSessions(): Promise<readonly SessionSummary[]>
  /** put / get——**写权唯一**（各域大块转存皆经此）。 */
  blobs: BlobStore
}

/**
 * **一笔在途调用**（恢复 ① 的产物）——「有调用、无结果」的那一次。
 *
 * 两侧各有一半，缺则如实为 `null`（**不猜**——恢复宁可见到「这笔说不全」，
 * 也不要一个看着圆满的错配对）：
 * - **事件侧**（链引用）说得出「问过闸门吗、裁决是什么」——处置要的就是这条轨迹；
 * - **条目侧**（配对）管的是上下文合法性（⑤）：助手消息的 `toolCalls` 得条条有回填。
 */
export type InFlightCall = {
  /** 该次 `tool.call` 事件的 id——**链引用**（请求 / 询问 / 裁决 / 结果四事件按它串）。缺则 `null`。 */
  readonly call: RecordId | null
  /** 该次 `tool-call` 条目的 id——**条目侧配对键**。缺则 `null`。 */
  readonly entry: RecordId | null
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /** 该次调用属哪一轮（轮外为 `null`）。 */
  readonly turn: TurnId | null
  /** 问过闸门吗（`tool.decision.request` 在）——措辞用：问了没答与被拒不是同一件事。 */
  readonly requested: boolean
  /** 裁决结论。**未答复 / 未问 ＝ `null`**——④按它落账（保守）。 */
  readonly decision: Decision | null
  /** 裁者（与 `decision` 同来处；无裁决则 `null`）。 */
  readonly decider: Decider | null
}

/**
 * **恢复扫描的产物**（`RecordsService.scanInFlight` 的返回）——一次把「要处置什么」说全。
 *
 * 判据（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」① ③）：
 * ```
 *   有 `tool.call` 无 `tool.result`   ← 在途（①）
 *   有 `turn.start` 无 `turn.end`     ← 中断的轮（③「记中止」的落点）
 * ```
 */
export type RecoveryScan = {
  readonly session: SessionId
  /** **中断的轮**——有 `turn.start` 无 `turn.end` 的那个（多个取最大号）；没有＝`null`。 */
  readonly openTurn: TurnId | null
  /** 记录里出现过的**最大轮号**——轮号续跑用（见 `RebuildHandoff.lastTurn`）。没有＝`null`。 */
  readonly lastTurn: TurnId | null
  /** 在途调用（按出现序）。 */
  readonly calls: readonly InFlightCall[]
}

/**
 * 工具域 → 执行域。
 *
 * **失败形态分两路**（技术方案 · 执行 · 原语形态）——**正常结果用判别式 · 调用不成立用抛**：
 * - **判别式**载正常结果里的失败——命令跑了但 `exit` 非 0、超时（`ExecResult` 的 `ok` /
 *   `reason`）、读到上限（`ReadResult.truncated`）。这些是「做成了，结果如此」。
 * - **调用不成立＝抛**——越界 · 不存在 · 是否目录 · 无权限 · 参数无效：沙箱侧抛**精确报文**，
 *   由**工具边界**捕之、收敛为 `ToolResult` 的判别式。故对模型与其余消费者，
 *   「错误＝返回值」照旧成立；抛只发生在原语这一层。
 *
 * 由头：`write` 的返回是 `void`、`list` / `match` 是数组——**冻签名载不下失败位**，
 * 兜一个哨兵值比抛更坏（静默的空数组会被当成「这个目录就是空的」）。
 */
export interface Sandbox {
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>
  /**
   * 读文件——`opts.maxBytes` 缺省＝**实现常量**（64 KiB）。
   *
   * **为什么要有这个口子**：`write` / `edit` 走「读 → 改 → 写回」时，按缺省上限读到的
   * 是**截断文本**——原样写回即**抹掉尾巴**（数据安全件）。故 `edit` 显式放大上限
   * （实现常量 1 MiB），仍超限则**即拒并指出出口**（走 `exec`）。
   */
  read(path: string, opts?: { maxBytes?: number }): Promise<ReadResult>
  write(path: string, data: WriteData): Promise<void>
  list(path: string): Promise<readonly ListEntry[]>
  match(pattern: string, opts: MatchOptions): Promise<readonly MatchHit[]>
}

/** 工具域 / 装配 → 执行域。 */
export interface WorkspaceService {
  /**
   * **规范形**（`realpath` 之后）——根的身份：越界报文 / 记录那一列 / 会话分组都用它。
   * **`[0]` ＝默认根**（相对路径与新文件的落点）；单根＝一项的特例。
   */
  roots(): readonly string[]
  /**
   * **声明原形**——用户手写在配置里的那一串（`resolvePath` 归一、**不** `realpath`），
   * 与 `roots()` **同序等长**：`roots()[i]` 与 `declaredRoots()[i]` 是同一条根的两张表。
   *
   * 由头（U27）：`/tmp/proj` 在 macOS 上实为 `/private/tmp/proj`，注册成真路径，
   * 而模型照**用户写的**那一串给 `/tmp/proj/src`——只比规范形的话它被判越界。
   * **两张表都认**是执行域的落点判据（`workspace.ts`），权限域要与它**同源**
   * （`PermissionContext` 一并带上这一张，见其注）。
   */
  declaredRoots(): readonly string[]
  defaultRoot(): string
  /**
   * 解析路径——**越界即拒：抛**（沙箱侧捕之、归 `reason: 'out-of-bounds'`）。
   * 越界判据与执行域**同源**：相对按默认根 · 绝对须落根内。
   */
  resolve(path: string): ResolvedPath
}

// —— 项目规约（U32）——

/**
 * **一条项目规约文档**——发现与读取的产物（只读）。
 *
 * 「项目规约」＝工作区里那些**说明这个项目怎么做事**的文档：目录里的 `AGENTS.md` /
 * `CLAUDE.md`，以及 `.magic/rules/**` / `.claude/rules/**` 下的规则文档。
 * 它们是**只读材料**——不改 `permissions.rules`、不运行其中脚本、不接 hooks、不授权路径。
 *
 * **来源与范围分开报**（技术方案 · 记录：「保留来源 / 作用域」）——
 * `kind` 说来自哪一类入口，`root` / `scope` 说管到哪儿。
 *
 * **正文就是这一趟读到的当前文件**（2026-09-21 裁）：材料**不做版本管理**——没有内容 hash、
 * 没有版本号、没有历史版本对照。故这里没有「是哪一版」这一格：判「送过没有」的那些人
 * （对话域的送达账）拿**实际送出去的那份材料**逐字比，不另造一个材料身份。
 * 动态就动态：文件改了，下一趟读到的就是新的。
 */
export type ProjectRule = {
  /**
   * 来源类别——五类入口各一类：
   * - `agents` —— 目录里的 `AGENTS.md`（Magic 的第一入口）；
   * - `claude-md` —— 同目录没有 `AGENTS.md` 时的 `CLAUDE.md`（兼容回退）；
   * - `magic-rules` —— `<root>/.magic/rules/**` 下的规则文档（**原生**）；
   * - `claude-rules` —— `<root>/.claude/rules/**` 下的规则文档（**兼容**）；
   * - `source` —— 用户**显式配置**的补充来源（`rules.sources` 点名的那些）。
   */
  readonly kind: 'agents' | 'claude-md' | 'magic-rules' | 'claude-rules' | 'source'
  /** 文件**真路径**（`realpath` 之后）——物理同源的两条路径报到同一个它，故只入一次。 */
  readonly path: string
  /**
   * **所属项目根**（规范形）——多根下「甲根的规范不作乙根的全局规范」按它分。
   * `null` ＝ **用户显式配置的补充来源**（不在任何根内）：来源是用户点名的，故不分根。
   */
  readonly root: string | null
  /**
   * **作用目录**（规范形）——这条规约管到哪儿：
   * 目录规约是它所在的目录（「近目录约定仅细化其子树」）；规则文档是**所属根**
   * （规则子目录只是组织方式，路径基准仍是项目根）。
   * `null` ＝ 不分根（同 `root`——用户点名的补充来源，不在任何根内）。
   */
  readonly scope: string | null
  /** 稳定短名（诊断与材料抬头）——相对所属根的写法；补充来源用绝对路径。 */
  readonly name: string
  /**
   * **生效模式**（`paths:` 展开后的结果，根相对）——`[]` ＝ **无条件**（会话开局就送）。
   *
   * 交给消费方（对话域）的理由（2026-09-20 裁）：材料里**不能剥完 YAML 只剩下正文**。
   * 一条 `paths: ["src/**"]` 的规则若只把正文摆给模型看，模型无从知道它**只管 src**——
   * 它会拿这条去管别处的文件。范围必须随材料一起走。
   */
  readonly paths: readonly string[]
  /** 正文——**已摘掉 front-matter**（送模型的不该带上那段元数据）。 */
  readonly text: string
}

/**
 * **一条只读来源没能照常进来**（读不懂 / 读不到 / 被略过）——连**缘由**一起报。
 *
 * 两类都要说：**坏了**（YAML 读不懂、模式无效、超限、外部符号链接没配来源、目录成环）与
 * **取舍**（同目录 AGENTS 与 CLAUDE 是两份不同实体 ⇒ 采 AGENTS；同根同名规则 ⇒ Magic 优先）。
 * 后一类不是错误，但**同样不能静默**——用户得知道自己写的那一份**没生效**。
 * 由头同权限域的 `RuleProblem`：「静默丢弃会让人对着一条不生效的规则发呆」。
 */
export type RulesProblem = {
  /** 出问题的来源（文件 / 目录的真路径；连路径都取不到时给用户写的那一串）。 */
  readonly path: string
  /** 一句人读得懂的话——说清**是什么、为什么、怎么办**。 */
  readonly message: string
  /**
   * 这一条的**分量**——两类都报，但**报法不同**（2026-09-20 裁）：
   *
   * - `error` ——**坏了**（YAML 读不懂、模式无效、超限、没配来源的外部链接、目录成环）：
   *   用户**必须知道**，因为它多半意味着「我写的那份规约压根没生效」。启动那句回执数它。
   * - `choice` ——**有意的取舍**（同根同名 ⇒ 原生优先；同目录两份不同实体 ⇒ 采 AGENTS）：
   *   这是**产品按设计做的选择**，不是故障。`--check` 里照说（用户要能查「我写的那份为什么
   *   没在管」），但**不计进「没能加载」的条数、不在启动时报警**——那份被顶掉的兼容规则
   *   本来就是**预期被顶掉**的，为它每次开屏报一句就是噪音。
   */
  readonly kind: 'error' | 'choice'
}

/**
 * **一次规约读取的产物**——文档 ＋ 没进来的那些（连同缘由）。
 *
 * `problems` 随产物一起走，**不分开取**：说「有哪几条没进来」与「进来了哪几条」是同一件事的
 * 两面，分两个入口就会有人只读一半——那正是「静默截掉关键约定后宣称已生效」。
 */
export type RulesLoad = {
  /** 当前适用的文档（去重后，按作用范围由外向内）。 */
  readonly documents: readonly ProjectRule[]
  /** 没进来的那些 —— 空数组＝全都照常进来了。 */
  readonly problems: readonly RulesProblem[]
  /**
   * **这一趟有没有丢掉材料**——`true` ＝「回来的是全的」这句话**不成立**。
   *
   * 由头（2026-09-20 裁）：停下的那几处**都报得出来**（上限 · 层级），但**消费方光看
   * `documents` 是看不出来的**——被挡在外面的那些**压根不在列表里**，于是「目标上的规约
   * 都送到了吗」这个问题会被答成「送到了」。对话域据本字段把那种情形**当成未送达**处理：
   * 宁可停下来明说，也不在规约没齐的情况下动手（不静默执行）。
   *
   * **两处来源，一个出口**（2026-09-20 三轮裁；四轮把前者的判据说全）：份数 / 总量到顶，
   * 与**发现面没看成**（扫描层级到顶 · 目录读不动——底下那一摊一份都没看过，见
   * `@magic/execution` 的 `tryLook`）。判据都不是「读到了什么」，而是
   * 「**有没有该看而没看到的地方**」：只报一句错、照旧放行，等于说「没读到也不要紧」。
   *
   * ⚠️ 它说的是**这一趟的完整性**，不是「仓库里有问题」——目录里多到超过上限，正常读取
   * 也是 `true`。**具体是哪一处丢的，由 `problems` 说**（这一位只答「全不全」）。
   */
  readonly truncated: boolean
}

/**
 * **项目规约的来源面**（执行域实现）——**文件读取在执行 / 基础设施边界**。
 *
 * 分工（技术方案 · 记录：读在边界、选与装配在对话侧）：
 * - **本端口**只做「**有什么、在哪儿、是哪一版**」——发现 · 读取 · 解析 · 去重 · 诊断；
 * - **选哪些、什么时候送**归对话侧（`@magic/conversation`）：它是唯一知道「这一轮在动哪儿」
 *   的一层；
 * - **谁来源、允许读哪些**归装配：用户显式配置的补充来源随构造入参进实现。
 *
 * **同步**——读的是一棵小文件树（目录规约 ＋ 规则文档），量与配置加载（`loadFileSync`）、
 * 工作区根注册（`realpathSync`）同类；同步换来的是装配期就能给读数与诊断，不必为此把
 * 提示词装配整条链改成异步。**限度如实记**：它在模型调用与工具预查两处各跑一次，
 * 故实现侧必须有**上限**兜底（超限报 `problems`，不静默截）。
 *
 * **只读**——本端口不写盘、不改任何东西；来源是**只读材料**，与「工作区执行范围」是
 * 两份互不相干的东西（能从这儿读到，不等于能对它执行工具）。
 */
export interface ProjectRules {
  /**
   * 按目标求**当前适用**的规约。
   *
   * - `targets` ＝ 本会话**接触过的**目标路径（累积、去重；相对按默认根、绝对须落根内，
   *   与沙箱同一条解析规则）。**空数组**＝只取各根一级的规约（会话开局那一趟）。
   * - 适用的三类：各根一级的目录规约与规则文档 · 目标**祖先目录**里的目录规约 ·
   *   **模式命中该目标**的条件规则文档。
   *
   * ⚠️ **限度（如实记，不假装没有）**：任意 shell 字符串实际会碰哪些文件**静态推不出来**
   * （`cd src && ./build.sh` 就是现成的反例）。故 `exec` 一类没有路径参数的调用，其范围
   * 按**执行 cwd**（＝工作区默认根）算——那几条根一级的规约在会话开局就已经送达了。
   */
  load(targets: readonly string[]): RulesLoad
}

// —— 技能（U33）——

/**
 * 技能目录的**入口**——同作用域内的两个来源，次序即优先级（原生在前、兼容在后）。
 *
 * 与项目规约的两个入口（`AGENTS.md` / `CLAUDE.md`、`.magic/rules` / `.claude/rules`）
 * **同一条产品原则**：Magic 自身的入口第一，兼容入口只提供**输入格式**（`SKILL.md`）。
 */
export type SkillOrigin = 'magic' | 'agents'

/**
 * 技能的作用域——**在哪儿被发现的**（同名项靠它区分，不靠目录顺序）。
 *
 * - `project` —— 工作区根下的 `<root>/.magic/skills` / `<root>/.agents/skills`；
 * - `user` —— 用户目录下的 `~/.magic/skills` / `~/.agents/skills`；
 * - `configured` —— 用户**显式配置**的补充目录（`skills.sources` 点名的那些）。
 *
 * **项目优先于用户**：同名时项目那份是「这个项目的做法」，用户那份是「我这台机器的习惯」。
 * `configured` 排在最后——**「Magic 自身第一」**用在这儿＝默认两处（项目、用户）才是主，
 * 用户点名的补充目录是外来的（与 `ProjectRule.kind` 把 `source` 排最后同一条理由）。
 */
export type SkillSource = 'project' | 'user' | 'configured'

/**
 * **一个被发现的技能**——只有元数据（名称 / 描述），**不含正文**。
 *
 * 这是「启动只取得名称与描述」那句话在契约上的落点：列表可以便宜地取（一个目录一项、
 * 读一份 `SKILL.md` 的 front-matter），正文另有一趟（`Skills.readMain`）。
 * 正文若跟着列表一起走，那么每次装配提示词都要把仓库里所有技能的全文读一遍——
 * 「未选中不加载」是设计要的行为，不是优化。
 *
 * **格式依据**＝Agent Skills 规范（`SKILL.md`：YAML front-matter 的 `name` / `description`
 * ＋ Markdown 正文）。**Magic 定义选择、权限与生命周期，外部格式只作适配**——
 * 故上游的 `allowed-tools` 等扩展**一个都不进这里**：它们不授予 Magic 的任何权限。
 */
export type Skill = {
  /**
   * 名称——取自 front-matter 的 `name`；它与目录名一致（规范要求，不一致按无效报出）。
   *
   * ⚠️ **它不是身份**：同名技能可以来自不同来源，二者都在列、都能被明确选中。
   */
  readonly name: string
  /** 描述——取自 front-matter 的 `description`（模型据它选用，人据它浏览）。 */
  readonly description: string
  /**
   * **技能目录的真路径**（软链接解析之后）——**身份**就在这儿。
   *
   * 选定的引用带的是它（`SkillRef.path`），读取按它归位：同名两个来源因此分得开，
   * 而「失效不换同名项」也才有判据——按同一个真路径找不回来，就是真失效了。
   *
   * 它同时是**读取的边界**：技能内的引用（`references/x.md`）只能落在这棵子树里，
   * 越不出去；但这**不是执行授权**——符号链接解析后的目录是只读来源，
   * 不扩大执行范围（能从这儿读到，不等于能对它执行工具）。
   */
  readonly path: string
  readonly source: SkillSource
  readonly origin: SkillOrigin
  /**
   * **来源的人读标签**（如「项目 .magic/skills」）——由**发现处**产出（它才知道这一份
   * 是从哪一类来源的哪个入口长出来的），此后一路照印：系统提示词的目录块、`--check`
   * 那一行、回执、记录里的 `UsedSkill.label` 用的是**同一串**。
   *
   * 一处产出、多处照印的理由同 `GrantRow.describe`：措辞若在两处各写一遍，
   * 改一处就会漏另一处（而它恰好是用户用来分辨同名技能的那一眼）。
   *
   * ⚠️ **位置那一段只在名字没说的时候补**（U33 独立验收退回①）：名字取自 front-matter、
   * 不取目录名，故「同一作用域同一入口下两份同名」真会出现——那时前两段逐字相同，
   * 用户在候选列表里认不出哪份是哪份。故标签补上它所在的那个目录名
   * （`项目 .magic/skills/first`），**除非那个目录名与技能名相同**（那就不带新信息，
   * 只会在草稿行与回执上白白重复一个名字）。限度与完整起见见
   * `@magic/execution` 的 `sourceLabelOf`。
   */
  readonly label: string
}

/**
 * **一处技能没能照常进来**（读不懂 / 读不到 / 被顶掉）——形态与由头同 `RulesProblem`：
 * 静默丢弃会让人对着一个不生效的技能发呆。
 *
 * - `error` —— **坏了**（`SKILL.md` 缺失 / front-matter 读不懂 / 名称不符规范 / 超限）；
 * - `choice` —— **有意的取舍**（同名：原生顶掉兼容、项目顶掉用户）——产品按设计做的选择，
 *   不是故障；用户要能查「我写的那份为什么没生效」，但不该每次开屏被报一句。
 */
export type SkillProblem = {
  /** 出问题的来源（技能目录或文件真路径；连路径都取不到时给用户写的那一串）。 */
  readonly path: string
  /** 一句人读得懂的话——说清**是什么、为什么、怎么办**。 */
  readonly message: string
  readonly kind: 'error' | 'choice'
}

/**
 * **一次技能发现的产物**——都发现了哪些（按优先级排序）＋ 没进来的那些（连同缘由）。
 *
 * 与 `RulesLoad` 同一条姿势：**两件一起走**，不分开取——说「有哪几个没进来」与
 * 「进来了哪几个」是同一件事的两面。
 *
 * **没有 `truncated` 这一位**：技能树的形状是死的（一层目录、每目录一份 `SKILL.md`），
 * 发现面没有「扫不进去的深处」可言；份数上限仍然有（超限的报成 `problems`，
 * 但它读得到的有哪些是确定的，不像规约那样「没读到的可能正是关键那一份」）。
 */
export type SkillCatalog = {
  /** 发现到的技能——**次序即优先级**（项目 → 用户 → 配置；同作用域内原生 → 兼容）。 */
  readonly skills: readonly Skill[]
  /** 没进来的那些——空数组＝全都照常进来了。 */
  readonly problems: readonly SkillProblem[]
}

/**
 * **按需读到的一份技能材料**——读到的是哪一份，正文是什么。
 *
 * **不算内容版本**（2026-09-21 用户已定）：技能材料**动态读取**——用的时候读当前内容，
 * 排队期间文件变了不是缺陷，故不需要 hash / 版本串来锚定「是哪一版」。
 * 记录侧留下的仍是**来源身份 ＋ 当时实际送出去的正文**（见 `UsedSkillEntry`），
 * 两者足够说明「当时用了什么」；材料本身不背「版本」这个概念。
 */
export type SkillMaterial = {
  /** 读的是哪一个技能（身份随材料一起走——材料自己说得出自己从哪来）。 */
  readonly skill: Skill
  /**
   * 正文——主文＝去掉 front-matter 的 `SKILL.md` 正文；引用＝那份文件的原文。
   *
   * **限长、超限即失败**（不给半截正文）：模型按这份材料干活，掐头去尾的指令比没有更坏。
   */
  readonly text: string
}

/**
 * 一次技能读取的结果——**判别式，不抛**（与 `ToolResult` 同法）。
 *
 * 失败是**正常结果的一种**：技能目录被删了、`SKILL.md` 读不懂、引用的文件不在、
 * 越出了来源边界——这些都要**定位到来源、如实说清**，而不是一句异常。
 * 显式选定的技能读不到时，这一次交代**不跑**（不换同名项、不忽略技能继续）——
 * 那条判断在对话域，「读不到」这个事实在这儿。
 */
export type SkillRead =
  | { readonly ok: true; readonly material: SkillMaterial }
  | { readonly ok: false; readonly reason: string }

/**
 * **技能来源面**（执行域实现）——与 `ProjectRules` 同一处境、同一分工：
 *
 * - **本端口**只做「**有什么、在哪儿、读到的是什么**」——发现 · 读取 · 解析 · 去重 · 诊断；
 * - **选哪些、什么时候送**归对话侧：显式选定随提交、模型自主选用经受限读取入口；
 * - **谁来源、允许读哪些**归装配：用户配置的补充目录随构造入参进实现。
 *
 * **不记内容版本**（2026-09-21 用户已定）：材料**动态读取**——用的时候读当前内容，
 * 排队期间文件变了不是缺陷，故不必也不许拿 hash 锚「是哪一版」。
 *
 * ## 一次只读一棵小树，但**每次现扫**
 *
 * 与规约同法：不设全仓 watcher、不缓存——改过的技能下一趟就是新的（验收明写：
 * 「使用技能后修改源文件，再开会话：新调用按刷新后的来源取得内容」）。
 *
 * ## 两条边界（都是代码里唯一的入口，不靠自觉）
 *
 * - **只读**——只有 `readdir` / `readFile` / `realpath` / `stat`，一个写操作都没有；
 * - **不能借加载器读任意文件**——发现面只有三处（项目两处、用户两处、用户点名的补充目录），
 *   读取面只有两处（**已发现身份的**技能目录，与它**来源内**的相对引用）。
 *   一个越出技能目录的引用（`../..`、绝对路径）不是「读不到」，是**不许读**。
 *
 * ## 同步
 *
 * 理由同 `ProjectRules`：读的是小文件树，且发现面在**装配系统提示词的同一处**要结果
 * （那条链是同步的），同步换来的是不必把提示词装配整条改成异步。
 */
export interface Skills {
  /**
   * 发现——名称 / 描述 / 身份（**不读正文**）。
   *
   * 每次调用现扫：目录名与 `SKILL.md` 的 front-matter 就是全部代价，量级同配置加载。
   */
  discover(): SkillCatalog

  /**
   * 取**主文**（`SKILL.md` 正文）——按身份（名称 ＋ 真路径）归位。
   *
   * 两个参数**缺一不可**：只给名称的话，同名两条会静默取到先发现的那一条，
   * 而「不能静默选错技能」要求给的是**明确的身份**。找不到那一对（改名 / 删除 /
   * 来源变了）＝ `ok: false`，**不退回同名项**。
   */
  readMain(name: string, path: string): SkillRead

  /**
   * 取**来源内的引用**（`references/x.md`、`REFERENCE.md`…）——相对技能目录。
   *
   * `relative` 必须是**相对路径且落在技能目录内**：绝对路径、`..` 越出、经软链接绕出去，
   * 一律拒绝（那是「越出技能来源」，仍经各自边界——不因为它在技能里就放行）。
   */
  readReference(name: string, path: string, relative: string): SkillRead
}

// —— 材料（文件 / 目录引用 · U36）——

/**
 * **一条要带的材料**（用户用 `@` 明确选定的那一份）——按身份归位。
 *
 * - `kind` —— 文件还是目录（目录**只取有界清单**，内容后续按需读）；
 * - `source` —— **身份**：那条路径的真身（选定那一刻解析出来的绝对路径）；
 * - `external` —— **工作区之外的那一个**：用户明确选定之后才带这一位。它取的是一份
 *   **只读附件**——读一次内容，**不扩大任何工具的可写范围**（沙箱的根一条都不动）。
 *   目录不给这一位：外部目录的递归列出不属于「单个外部材料」。
 */
export type MaterialRequest = {
  readonly kind: 'file' | 'dir'
  readonly source: string
  readonly external?: true
}

/**
 * **取到的一份材料**——来源身份 ＋ 本次实际交付的内容。
 *
 * - `path` —— 真路径（身份；记录侧 `InputRefEntry.source` 用它）；
 * - `label` —— 人读的来源写法（写进正文的那一段 / 工作区外的绝对写法）：模型面前
 *   材料的抬头要用它对上「用户说的是哪一份」；
 * - `text` —— **本次实际交付的内容**（文件的当前内容 / 目录的有界清单）；
 * - `truncated` —— 文件内容到上限为止（**如实标**，不假装读全了）；
 * - `omitted` —— 目录清单没列出来的项数（**不静默少列**：模型要知道还有没看见的）。
 */
export type Material =
  | {
      readonly kind: 'file'
      readonly path: string
      readonly label: string
      readonly text: string
      readonly truncated?: true
    }
  | {
      readonly kind: 'dir'
      readonly path: string
      readonly label: string
      readonly text: string
      readonly omitted?: number
    }

/**
 * 一次材料读取的结果——**判别式，不抛**（与 `ToolResult` / `SkillRead` 同法）。
 *
 * 失败是**正常结果的一种**：文件不见了、是二进制、超了上限、工作区外没被选定——
 * 这些都要**指着那一份如实说清**（哪一份、为什么、怎么办）。显式选定的材料取不到时，
 * 这一次交代**不跑**（不发残缺输入——那条判断在对话域，事实在这儿）。
 */
export type MaterialRead =
  | { readonly ok: true; readonly material: Material }
  | { readonly ok: false; readonly reason: string }

/**
 * **成套取**的结果——一次交代里的材料是**一并送到**的：一个取不到，整条不跑。
 *
 * 为什么不成套不行：用户那句交代里几份材料指向几件事（「按 @需求.md 改 @src/login.ts」），
 * 少一份就不是他要的那件事了。半套送出去，模型会按一份残缺的现场动手。
 */
export type MaterialLoad =
  | { readonly ok: true; readonly materials: readonly Material[] }
  | { readonly ok: false; readonly reason: string }

/**
 * **材料来源面**（执行域实现）——与 `ProjectRules` / `Skills` 同一处境、同一分工：
 *
 * - **本端口**只做「**这条路是什么、读到的是什么**」——解析 · 判定 · 有界读取 · 诊断；
 * - **选哪些、什么时候送**归对话侧（它按用户交代里的引用取）；
 * - **谁是工作区、允许读哪些**归装配（工作区根与用户配置随构造入参进实现）。
 *
 * ## 三条边界（都是代码里唯一的入口，不靠自觉）
 *
 * - **只读**——没有写面。能从这儿读到，不等于能对它执行工具；
 * - **越界即拒**——工作区外的路径**不因输入 `@` 或粘贴而获准**；唯一进口是
 *   `MaterialRequest.external`（用户明确选定那一个），且只收**单个文件**；
 * - **二进制不当文本**——按路径引用只收文本材料；二进制给出确定的拒绝与出口
 *   （让模型用工具去处理），不糊一串乱码进上下文。
 *
 * ## 路径候选是同一个面
 *
 * `candidates` 只回答「有这么一条吗、它是文件还是目录」——**不读内容**。放在同一端口上
 * 是因为它与读取走的是**同一棵只读树、同一条解析规则**；两条入口各写一遍解析，迟早分叉。
 */
export interface Materials {
  /**
   * 按身份取材料——**成套**（见 `MaterialLoad`）。
   *
   * ⚠️ **现读**（2026-09-21 用户已定）：不冻结排队期间的文件、不算 hash、不做版本；
   * 排队期间源文件变了不是缺陷。记录侧留下来的是**这一次实际交付的那一份**
   * （`InputRefEntry.text`），历史因此不被后来的修改重写。
   */
  load(requests: readonly MaterialRequest[]): Promise<MaterialLoad>

  /**
   * 路径候选——`@` 之后边打边列（`query` ＝ 用户打的那一段，可以是空串）。
   *
   * 三条分寸：
   * - **只列一层**：`query` 落在一个目录上就列它下面那一层，不递归；
   * - **有界**：超过上限由调用方（装配的答复）说一句「还有更多」，不静默截；
   * - **工作区外只认打全的那一条**：外部路径**不做目录浏览**（那是「`@` 即获准浏览」），
   *   但用户**打全的那一条**照实回一行——选定它才是那个明确的动作。
   */
  candidates(query: string, limit: number): Promise<PathCandidates>
}

/**
 * 一次候选查询的产物——**行 ＋（有则）一句说明**。
 *
 * `note` 说的事：列到头了（「还有 N 条——接着打几个字收窄」）· 这一条为什么一条都不给
 * （工作区外只收单个文件 / 这个写法读不了）。**不静默**：一条都不给与「这里就是空的」
 * 是两件事，用户得知道是哪一种。
 */
export type PathCandidates = {
  readonly rows: readonly PathCandidate[]
  readonly note?: string
}

/**
 * 一条路径候选——`Materials.candidates` 的产物（事件面照它列一排，见 `PathCatalogRow`）。
 *
 * `path` 是真路径（选定即身份）；`display` 是**写进正文的写法**（相对默认根，或绝对）。
 */
export type PathCandidate = {
  readonly path: string
  readonly display: string
  readonly kind: 'file' | 'directory'
  readonly external: boolean
}

/** 装配 → 控制域（外壳经传输接入）。 */
export interface ControlHub {
  /** 命令 → 各域。 */
  bind(routes: CommandRoutes): void
  /** 接**内核侧**一端（`KernelTransport`）——外壳侧一端由外壳自持。 */
  attach(transport: KernelTransport): void
}

// ══ 端口内类型 ════════════════════════════════════════════════════════

// —— 对话域 ——

// `UserInput` 与命令负载 `InputSubmit` 同一形态，定义在 control.ts（不在此重复）。

// —— 模型域 ——

/**
 * 模型消息（内核侧形态——供应商无关）。
 *
 * **上下文由对话域装配**——系统提示词即 `role:'system'` 的首条消息；工具结果回填即
 * `role:'tool'`（`callId` 配对**供应商侧**调用 id——见文件头注 ①）；条目里的 blob 引用
 * 在装配时解析为文本（按策略截断）（技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelMessage =
  | { readonly role: 'system'; readonly content: string }
  | { readonly role: 'user'; readonly content: string }
  | {
      readonly role: 'assistant'
      readonly content: string
      readonly toolCalls?: readonly ToolCall[]
    }
  | {
      readonly role: 'tool'
      /** **供应商侧**调用 id——与发起它的 assistant 消息里的 `ToolCall.id` 配对。 */
      readonly callId: string
      /**
       * 工具名——**取件层回填需要**。不补就得从上下文里的 assistant 消息反查，
       * 而上下文压缩（阶段 3）正是设计目标——反查届时会**静默退化成空串**。
       */
      readonly name: string
      readonly ok: boolean
      readonly output: string
    }

/** 模型请求（内核侧请求形制）。 */
export type ModelRequest = {
  readonly model: string
  readonly messages: readonly ModelMessage[]
  readonly tools?: readonly ToolSpec[]
}

/**
 * 模型流——**双出口**：事件序列 ＋ 聚合结果。
 *
 * 结果随事件被消费而落定；提前 `break` 亦落定（以未完成态）——见技术方案 · 领域划分。
 */
export type ModelStream = {
  readonly events: AsyncIterable<KernelEvent>
  readonly result: Promise<ModelResult>
}

/**
 * 模型结束原因——词表**对齐取件层（SDK）的结束原因，接缝近恒等映射**
 * （技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelFinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'other'

/**
 * 模型聚合结果。
 * `finishReason` **可缺**——供应商未给 / 出错 / 提前 `break` 时缺省；
 * 「是否走完」由 `complete` 表述（技术方案 · 领域划分 · 端口内类型）。
 */
export type ModelResult = {
  readonly finishReason?: ModelFinishReason
  readonly usage?: ModelUsage
  readonly complete: boolean
  /**
   * 模型本轮请求的工具调用——**循环据以回填**（面向端口者不解析事件流拼装）。
   * 注：`model.delta(toolcall)` 是**流式片段**，事件流拼不出归属——故聚合结果必须载它
   * （双出口设计的完成，非重复）。
   */
  readonly toolCalls?: readonly ToolCall[]
}

/**
 * 模型特征标记——**覆盖位**（技术方案 · 领域划分 · 端口内类型 · 模型策略）。
 *
 * **内置表**（模型域持有 · **不入契约**）给默认；判据取「**键在即接管**」——
 * `traits` 存在就**整组覆盖**（含 `{}` ＝**显式声明无特征**）；两处皆无 → 常规行为（不猜、不切）。
 *
 * 理由——一条规则胜过一个二级判据，且**内置表判错时用户关得掉**：若 `{}` 回落内置表，
 * 错的模型就没有出口。
 *
 * 首站一条：`inlineThinking`——思考**内嵌在正文**（`<think>…</think>` 是少数模型的行为，
 * 不当通例处理）；`tag` 给出包裹标签，归一据它把标签内容切出到 `thinking` 通道
 * （`text` 通道不带标签）。
 */
export type ModelTraits = {
  readonly inlineThinking?: { readonly tag: string }
}

/** token 用量。 */
export type ModelUsage = {
  readonly inputTokens: number
  readonly outputTokens: number
}

// —— 工具域 ——

/**
 * 工具调用（模型请求的一次调用）。
 * `id` ＝**供应商侧**调用 id——只用于回填配对（三个 id 空间见文件头注）。
 */
export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  /**
   * 参数**解析不出**（模式不符 / JSON 残缺）——工具域据以决定回填什么。
   * 不靠各消费者重新解析参数串（重复劳动，且丢掉「哪一次调用坏了」的定位）。
   */
  readonly invalid?: boolean
  /**
   * **外部工具的注册表身份**（U38）——这一位在＝这是一次**外部调用**。
   *
   * **来处唯一**：分发查到工具定义之后附上（`ToolDefinition.external` → 此位），
   * 权限域据它取真实来源与「外部操作」那条呈现口径。**模型侧给不出这一位**——
   * 模型给的是名字与参数，名字对不对由注册表说了算（参数里写个 `server` 字段冒充来源
   * 在这儿一文不值）。名字像外部工具而注册表里没有 ⇒ 这一位缺席，权限域仍按外部从严
   * （见 `analyze`），但材料会说明它**不在已配置的工具表里**。
   */
  readonly external?: ExternalToolRef
}

/**
 * 工具结果——**载两样输出**（一字之差，别混）。
 *
 * - `output` ＝**面向模型的文本**（按上限截断）——回填给模型看的那份；
 * - `content` ＝**记录侧形态**（内联或 blob 引用）——**即该次 `tool.result` 事件的
 *   `output`，两者同物**。
 *
 * **两样都要**：只给文本，条目就只能当内联记——大输出下条目与事件**当场分叉**、重放丢尾巴；
 * 只给 Content，模型侧拿不到截断文本（blob 要取回才知道长度）。
 * `callRef` 同理——条目侧 `tool-result` 的 `call` 字段取它，**四事件才串得成一条链**。
 */
export type ToolResult = {
  readonly ok: boolean
  /** 面向模型的文本（按上限截断）。 */
  readonly output: string
  /** 记录侧形态（内联或 blob 引用）——即 `tool.result` 事件的 `output`。 */
  readonly content: Content
  /** 该次 `tool.call` 事件的 id（链引用）。 */
  readonly callRef: RecordId
  /**
   * **这一次调用交付了一份技能主文**（U33）——只有读技能的那件工具会带，其余一律不带。
   *
   * 由头：模型**自主**取技能时，「实际使用」的回执得由**知道那是哪一份材料**的人交出身份。
   * 说话的是工具（它读的），发回执的是对话域（只有它知道材料什么时候真进了模型请求）。
   * 中间这条结构化通道是必须的——**不能靠匹配结果正文的抬头去猜**（那是拿一句给人看的
   * 文案当跨域协议，改个措辞就断）。取**引用**那一趟不带它：「后续引用不重复报整项技能」。
   */
  readonly skill?: UsedSkill
}

// —— 权限域 ——

/**
 * 裁决上下文——**纯数据**（技术方案 · 领域划分 · 端口内类型）。
 *
 * 越界判定所需的根视图由**调用方（工具域）给出**：**不传端口进端口**。
 * 越界判据与执行域**同源**（相对按默认根 · 绝对须落根内）——两处须一致。
 *
 * **两张表**（U22 · 技术方案 · 权限「权限域的根表要与执行域同源」）——`roots` 是**规范形**
 * （`realpath` 之后），`declaredRoots` 是**声明原形**（用户手写的那一串），**同序等长**。
 *
 * 由头：`U27` 把**执行域**的落点判定改成两张表之后，闸门这一侧还只有规范形
 * ⇒ **声明原形下的读类每次都要人点一下**（沙箱认了、闸门不认 ✗）。
 * 故这张表跟着一起过来：**落点判两张 · 规则也认两张**（见 `@magic/permission` · `paths.ts`）。
 *
 * **必填**（不是可选位）：漏接线＝退回「每次读都弹卡」那个坑，而它**不报错**——
 * 那正是本轮要收掉的东西。缺参应当在编译期就报（照 `PermissionGate.decide` 的 `callRef` 之例）。
 */
export type PermissionContext = {
  /** **规范形**（根的身份）——`[0]` ＝默认根。 */
  readonly roots: readonly string[]
  /**
   * **声明原形**（用户认得的那个写法）——与 `roots` 同序等长。
   *
   * 单根且写法本来就规范时，它与 `roots` 逐字相同（那是多数情形：显式声明原形只是
   * 多一张表，**不改行为**）。
   */
  readonly declaredRoots: readonly string[]
  readonly defaultRoot: string
}

// —— 记录域 ——

/**
 * blob 存取——**写权唯一归记录域**（技术方案 · 记录 · 标量口径 v0）。
 * **取异步**——`bun:sqlite` 同步、文件读写异步，异步面容两者（技术方案 · 领域划分 · 端口内类型）。
 */
export type BlobStore = {
  put(data: Uint8Array | string): Promise<BlobRef>
  get(ref: BlobRef): Promise<Uint8Array>
}

// —— 执行域（沙箱原语）——

/**
 * `exec` 返回——**判别式**（技术方案 · 执行 · 原语形态）。
 *
 * 命令跑了 ＝ `ok: true`（`exit` 非 0 ＝**命令失败**，不是沙箱失败）；
 * 沙箱级失败 ＝ `ok: false` + `reason`。**错误＝返回值**（不抛）。
 */
export type ExecResult =
  | {
      readonly ok: true
      readonly exit: number
      readonly stdout: string
      readonly stderr: string
      /** 超限截断（到 `maxOutputBytes` 为止）；大块转存归调用方。 */
      readonly truncated?: boolean
    }
  | {
      readonly ok: false
      readonly reason: ExecFailureReason
      readonly message: string
    }

/** 沙箱级失败三例（技术方案 · 执行 · 原语形态）。 */
export type ExecFailureReason =
  | 'timeout' // 超时
  | 'out-of-bounds' // cwd 越界（进程不启动）
  | 'spawn' // 启动失败

/**
 * `exec` 选项——cwd 约束 · 流式回调 · 取消 · 超时 / 输出上限。
 * **毫秒 / 字节**；缺省＝实现级常量（技术方案 · 执行 · 原语形态）。
 */
export type ExecOptions = {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** 流式增量——实时回调；消费方转 `tool.output.delta` 事件（**不落库**）。 */
  readonly onOutput?: (delta: OutputDelta) => void
  /** 取消——中止在途（**返回不抛**）。 */
  readonly signal?: AbortSignal
}

/**
 * `read` 返回——读文件（超长截断）。
 *
 * 落形态（U13）：`content` ＝**解码后的文本**；`truncated` ＝**到上限为止**，
 * **字段缺席＝没截**（与 `ExecResult.truncated` 同口径——缺省态不占位）。
 * 上限是**字节**：调用方可经 `Sandbox.read` 的 `opts.maxBytes` 指定（缺省＝实现常量 64 KiB）——
 * `truncated` 即「到上限为止」，工具侧据它措辞（`edit` 放大到 1 MiB 再读，仍超限才拒）。
 */
export type ReadResult = {
  readonly content: string
  readonly truncated?: boolean
}

/**
 * `write` 入参内容——**收字节，不收引用**。
 *
 * 两选一：文本，或字节（`Uint8Array`）。
 *
 * **原 `blob` 支已撤**（技术方案 · 领域划分 · 端口内类型）：blob 存取归记录域、**写权唯一**，
 * 沙箱手上根本没有 blob 面、域间也不许私连——要写 blob 内容 ＝ **调用方先取回字节**再传。
 * 留着那一支只会让人以为传个引用就能落地，实际写个静默的空文件。
 */
export type WriteData = { readonly text: string } | { readonly bytes: Uint8Array }

/**
 * `list` 条目——名（必给）＋ 类型 / 尺寸（可选）。
 *
 * 两个可选位是**只增不改的兼容位**（既有桩只给 `name`）；真实现两件都给。
 * 名**不是路径**——相对被列的那个目录。
 */
export type ListEntry = {
  readonly name: string
  readonly kind?: 'file' | 'directory' | 'other'
  /** 字节数（仅文件——`kind: 'file'` 时有意义）。 */
  readonly size?: number
}

/**
 * `match` 命中——`glob` 只给 `path`；`grep` 另给行 / 列 / 该行文本。
 *
 * `path` ＝**根内的绝对路径**（沙箱解析后的真身——消费方不必再拼）。
 * 行 / 列**从 1 起**（人看的数，不是偏移量）。
 */
export type MatchHit = {
  readonly path: string
  readonly line?: number
  readonly column?: number
  /** 命中行原文（不含行尾换行）。 */
  readonly text?: string
}

/** 匹配模式——`grep`（内容搜索）/ `glob`（文件名匹配）**共用一条底**（技术方案 · 执行）。 */
export type MatchMode = 'grep' | 'glob'

/**
 * `match` 选项（grep / glob 共用底）。
 *
 * - `mode` —— 判别式：按内容搜、还是按名匹配（同一条原语的两个面）；
 * - `path` —— 搜索起点；缺省＝**默认根**（相对按默认根 · 绝对须落根内——与执行域同一判据）；
 * - `maxResults` —— 命中数**上限**，至多返回这么多条（`grep` 的「输出截断」据此：
 *   取满即**可能**还有更多——消费方按此措辞，不当作「恰好这么多」）；缺省＝实现级常量；
 * - `signal` —— 取消：中止在途，**返回已收到的**（不抛——与 `exec` 的取消同一姿态）。
 */
export type MatchOptions = {
  readonly mode: MatchMode
  readonly path?: string
  readonly maxResults?: number
  readonly signal?: AbortSignal
}

/**
 * 已解析的工作区路径。
 *
 * `absolute` 已归一化（**词法**——同步纯词法判定，见 `WorkspaceService.resolve` 的限度）；
 * `root` ＝承载它的那条根。
 *
 * **越界即拒＝抛**（端口注释）——沙箱各原语捕之：`exec` 归 `reason: 'out-of-bounds'`；
 * 余四者的「正常结果 vs 调用不成立」两路之分见 `Sandbox` 头注（失败形态分两路）。
 */
export type ResolvedPath = {
  readonly absolute: string
  readonly root: string
}

// —— 控制域 ——

/**
 * 命令路由（装配 → 控制域，技术方案 · 领域划分 · 装配视图：`input.submit` / `turn.interrupt`
 * → 对话域；`decision.answer` → 权限域）。
 */
export type CommandRoutes = {
  onInput(input: UserInput): void
  onInterrupt(): void
  /**
   * 裁决答复 → 权限域。
   *
   * `opts` 是**答复上的加宽位**（目前只有「总是允许」）——控制域**原样转手**给
   * `PermissionGate.resolve`，**不由它翻译**（技术方案 · 领域划分 · 端口内类型）。
   */
  onDecision(id: DecisionId, decision: Decision, opts?: { remember?: boolean }): void
  /**
   * 换模型 → 模型域（装配接注册表的 `use()`）。
   *
   * 控制域**原样转手**（同 `onDecision` 的姿势）——它不认识注册表，也不知道换得成换不成；
   * 「切不动就不动」的判别式处置归**装配**（技术方案 · 领域划分 · 端口内类型）。
   */
  onModelSwitch(request: ModelSwitchRequest): void
  /**
   * 会话命令 → 对话域。
   *
   * 控制域**原样转手**（同 `onDecision` / `onModelSwitch` 的姿势）——它不认识会话，
   * 也不知道开得成开不成；「打不开就不打开」的处置归对话域。
   */
  onSession(command: SessionCommand): void
  /**
   * 读侧命令 → 对话域（技术方案 · 领域划分：「读面走控制面，不靠装配偷接」）。
   *
   * 控制域**原样转手**（同 `onSession` 的姿势）——它不认识记录域、也不读条目；
   * 答复走事件（`session.history`，**不落库**）：命令面只发不收，回话一律经事件流。
   */
  onHistoryRead(session?: SessionId): void
  /**
   * 模型条目表 → **装配**（它握着注册表——技术方案 · 装配视图 4）。
   *
   * 控制域**原样转手**（同 `onModelSwitch` 的姿势）——它不认识注册表，也不知道有哪些条目；
   * 答复走事件（`model.catalog`，**不落库**）：命令面只发不收，与 `onHistoryRead` 同一条路。
   *
   * **为什么归装配而不是模型域**：注册表是**进程级**的（选中的供应商不随会话漂，见
   * 装配的 `switchModel`），而模型域的网关是按会话实例造的那一束里的一件——
   * 条目表的真源在装配这一步，`model.switched` 的产出也早已收拢在这儿（缺陷 D16）。
   */
  onModelList(): void
  /**
   * **授权名录**（`/grants` 的读侧）→ **装配**（它握着 `~/.magic/grants.json` 的读写）。
   *
   * 控制域**原样转手**（同 `onModelList` 的姿势）——它不认识授权文件，也不知道里边有什么；
   * 答复走事件（`grants.catalog`，**不落库**）：命令面只发不收。
   *
   * **为什么归装配**：授权文件是**内核自持**的一个文件（技术方案 · 权限「授权的落点」），
   * 盘的读写归装配那一层（同配置文件之例——域不碰文件系统），权限域只持**账本**。
   */
  onGrantsList(): void
  /**
   * **撤销授权** → 装配（同 `onGrantsList` 的姿势：落盘归它）。
   *
   * `workspace` 缺省＝**本工作区那一节**；`index` 缺省＝**整节撤掉**（陈旧节那条路）。
   * 撤销**不是裁决**——它不进 `tool.decision` 那条链，只改文件 ＋ 回一条 `grants.catalog`
   * （外壳据以刷新抽屉并留一行回执）。
   */
  onGrantsRevoke(workspace?: string, index?: number): void
  /**
   * **技能目录**（`/skills` 的读侧 · U33）→ **装配**（它握着执行域的发现面）。
   *
   * 控制域**原样转手**（同 `onModelList` / `onGrantsList` 的姿势）——它不认识技能目录，
   * 也不知道发现了哪些；答复走事件（`skills.catalog`，**不落库**）：命令面只发不收。
   *
   * **为什么归装配而不是对话域**：技能来源面是**执行域的实现**，而把「用什么工作区 /
   * 什么用户目录 / 用户点名了哪些」组装成它的是装配（同 `ProjectRules` 那一处）——
   * 对话域只认得 `Skills` 这个端口（它据以取主文），不持有「有哪些」这个读面。
   */
  onSkillList(): void
  /**
   * **路径候选**（`@` 的读侧 · U36）→ **装配**（它握着执行域的路径面）。
   *
   * 控制域**原样转手**（同 `onSkillList` 的姿势）——它不认识文件系统，也不知道有哪些路径；
   * 答复走事件（`paths.catalog`，**不落库**）：命令面只发不收。
   *
   * **为什么归装配而不是对话域**：与技能目录同一条——文件系统那面是**执行域的实现**，
   * 把它组起来（工作区根 / 用户目录 / 用户点名的来源）是装配的活。
   */
  onPathList(query: string): void
}

/**
 * 控制传输 · **外壳侧**一端——首站同进程直连；跨进程（第二站）/ 跨设备（第三站）接同一接口。
 */
export type ControlTransport = {
  send(command: Command): void
  /** 订阅事件；返回**退订**。 */
  subscribe(listener: (event: KernelEvent) => void): () => void
}

/**
 * 控制传输 · **内核侧**一端（镜像：收命令 / 出事件）——`ControlHub.attach` 的入参。
 */
export type KernelTransport = {
  send(event: KernelEvent): void
  /** 订阅命令；返回**退订**。 */
  subscribe(handler: (command: Command) => void): () => void
}

// —— 信封铸造 ——

/**
 * 信封铸造器——**产出方铸**（技术方案 · 领域划分 · 信封的归属 v0 锚定）。
 *
 * **为什么必须产出方铸**——裁决配对要求产出方**当场知道事件 id**：权限域发
 * `tool.decision.request`，外壳的答复按**该事件的 id** 回来（`PermissionGate.resolve`）。
 * id 若由扇出处或落库处后配，这条回路就断了。
 *
 * 铸造器由**装配按会话实例**构造并注入各域：
 * - `id` 取自记录域（`RecordsService.nextId()`）；
 * - 上下文（`session` / `turn`）按实例持有——装配设 `session`，对话域在轮起止时调 `beginTurn`；
 * - `at` 由铸造器盖——**产出方不各自取时钟**。
 *
 * **跨实例不共享**——多会话 / 多 Agent 时各持一份。
 */
export type EventStamper = {
  stamp<K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent
  /** 对话域在轮起止时调。 */
  beginTurn(turn: TurnId | undefined): void
}

// ══ 工具规格（端口内类型）════════════════════════════════════════════

/** 必闸判据（危险分级 v0）——命中其一即须闸。 */
export type DangerReason =
  | 'external' // 外部操作（效果由服务器决定——U38）
  | 'irreversible' // 不可逆（收不回）
  | 'out-of-bounds' // 越界（工作区之外）
  | 'system' // 系统级（机器全局 / 已装环境）
  | 'outbound' // 外发（出去即收不回）
  | 'unknown' // 看不懂（无法归类 → 按不可逆假定问）

/**
 * 危险归类——「轻」（放行区）·「必闸」·「**按调用判定**」（技术方案 · 工具 · 机制）。
 *
 * `by-call` 支承载**随调用参数而变**的归类（如 `exec` 按命令解析 · `write` 新建＝轻、覆盖＝必闸）。
 * 阶段 1 全人工门下，本节定**呈现轻重**；阶段 2 起，必闸清单＝自动放行禁区。
 */
export type DangerClass =
  | { readonly level: 'light' }
  | { readonly level: 'gated'; readonly reason?: DangerReason }
  /** 按调用判定——`note` 说明判定依据。 */
  | { readonly level: 'by-call'; readonly note: string }

/**
 * 参数模式——取**自写朴素 JSON Schema**（技术方案 · 领域划分 · 端口内类型）。
 *
 * 工具参数模式只需要「**类型 ＋ 必填 ＋ 描述**」这一层：手写对象字面量本就落在本形态内，
 * **不取件**（取件会为几个字段背一整套校验器）、不加依赖；送模型即 JSON 往返不变量。
 */
export type JsonSchema = Readonly<Record<string, unknown>>

/** 工具规格——定义随每次调用送模型（名称 · 描述 · 参数模式 · 危险归类）。 */
export type ToolSpec = {
  readonly name: string
  readonly summary: string
  readonly parameters: JsonSchema
  readonly danger: DangerClass
}

/**
 * 工具集规格表的行——**只列静态可判的部分**（名称 / 语义 / 危险归类）；
 * 参数模式由各工具实现时给出。
 */
export type ToolSetRow = Omit<ToolSpec, 'parameters'>

/**
 * **参数键（工具集 v1 全表 · U13 锚定）**——工具的参数模式按此命名：工具域**分发**与
 * 权限域**分析**都按它取字段（危险归类＝按命令 / 按路径判定，见 `by-call` 支）。
 *
 * - `exec` —— `cmd`（命令；阶段 1 即锚定，**收窄为单一键**，不按候选键兜底）
 * - `read` —— `path`
 * - `write` —— `path` · `content`（**整写**——不是追加；空串＝写空文件）
 * - `edit` —— `path` · `old` · `new`（`old` 须在文件中**唯一**出现；`new` 空串＝删除）
 * - `grep` —— `pattern`（正则）· `path?`（搜索起点）
 * - `glob` —— `pattern`（glob 模式）· `path?`
 * - `ls` —— `path?`
 *
 * 通例：`path` 一律按工作区规则解析（相对按默认根 · 绝对须落根内）；**可选键缺席即取缺省**
 * （不是空串）；**错键名不被猜中**——取不到即报「参数错误」，故键名不带方言
 * （没有 `file` / `filepath` / `query` / `old_string` 一类近义变体）。
 *
 * 承载形态＝**自写朴素 JSON Schema**（`JsonSchema` 的类型不动——手写对象字面量本就落在
 * 它的形态内：不取件、不加依赖，送模型即 JSON 往返不变量）。
 */

/**
 * 工具集 v1 规格（阶段 2 · 已冻结）——供并行实现。
 * 归类随调用而变的条目取 `by-call`（判定在调用时落定）。
 */
export const TOOLSET_V1 = [
  {
    name: 'exec',
    summary: '命令执行（经沙箱 · 工作目录约束）',
    danger: { level: 'by-call', note: '按命令解析' },
  },
  { name: 'read', summary: '读文件（超长截断）', danger: { level: 'light' } },
  {
    name: 'write',
    summary: '新建 / 整写文件',
    danger: { level: 'by-call', note: '新建＝轻；覆盖＝必闸' },
  },
  { name: 'edit', summary: '串替换增量编辑（唯一定位 · 失配即报）', danger: { level: 'light' } },
  { name: 'grep', summary: '内容搜索（正则 · 输出截断）', danger: { level: 'light' } },
  { name: 'glob', summary: '文件名匹配', danger: { level: 'light' } },
  { name: 'ls', summary: '列目录', danger: { level: 'light' } },
] as const satisfies readonly ToolSetRow[]
