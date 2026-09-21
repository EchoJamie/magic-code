/**
 * 共享语言 · 控制面（命令面 · 配对）——已冻结。
 *
 * 出处：技术方案 · 接入（「消息目录（首站）」）。
 * 形态——类型化接口 + 事件订阅；首站同进程直连；消息按**可序列化**设计（JSON 友好）——
 * **即便同进程也走此协议**（不走内部直调）：并行开发与后续换壳的共同地基。
 *
 * 事件侧＝**事件流 kind 族**（不在此另立形态）；外壳按 `kind` 判别收窄——用
 * `events.ts` 的判别联合视图 `KernelEvent`。
 */

import type { Decision } from './events.ts'
import type { DecisionId, SessionId } from './ids.ts'

/**
 * **草稿里绑定的技能引用**（U33）——**只带身份，不带正文**。
 *
 * 绑定与加载是两件事：外壳选定一个技能时只把这对身份挂上草稿（`text` 仍可继续编辑），
 * **主文到真实提交那一刻才取**。由头是硬要求：「提交前零主文加载」——
 * 选定即读正文，等于把一次纯浏览变成一次 IO，还读的是一份可能压根不会被发出去的东西。
 *
 * `path` 是技能目录的**真路径**（`Skill.path`）——身份就在这儿，同名不同来源因此分得开；
 * `name` 跟着走是为了**报错时指得出是谁**（失效的是「哪个技能」这句话的一半）。
 */
export type SkillRef = {
  readonly name: string
  readonly path: string
}

/**
 * 用户输入。
 * 命令负载与 `ConversationService.submit` 入参**同一形态**——两处不各立一份。
 *
 * **一次交代＝正文 ＋ 它绑着的技能**（U33 起）——整份随 FIFO 排队、整份落账，
 * 不在「取出时才拼一个当下的技能」：忙时两条交代各绑各的技能，出队后不能被串成同一条。
 */
export type UserInput = {
  readonly text: string
  /**
   * 本次交代绑定的技能（显式选定的）——**按绑定时序**，可为空。
   *
   * 缺省 ＝ 纯文本输入（`pending:string[]` 时代的行为一字不动）。给了就**必须送到**：
   * 其中一个取不到主文，这一次交代**不跑**（不换同名项、不忽略它继续）——
   * 「我让你用这份技能做这件事」是用户的明确交代，内核不能替他把这句话删掉一半。
   */
  readonly skills?: readonly SkillRef[]
  /**
   * **提交的配对键**（外壳给）——回执（`input.settled`）按它配对，供外壳把失败认回
   * 对应的那份草稿。
   *
   * 为什么必须由外壳给：内核看得到的只是「又进来一条交代」，说不出它是屏上哪一份草稿
   * ——而「异步失败不能覆盖用户后来编辑的新稿」正需要这个对应关系。缺省 ＝ 不回执
   * （旧调用方一字不动），但**失败照报**（见 `input.settled`）。
   */
  readonly ref?: string
}

/**
 * `input.submit`——用户输入。
 *
 * TODO(规划侧)：技术方案只写「用户输入」，未定负载字段；占位为单文本。
 */
export type InputSubmit = { readonly type: 'input.submit' } & UserInput

/**
 * `decision.answer`——裁决答复，与 `tool.decision.request` **配对**。
 * 配对键＝**请求事件** `id`（`DecisionId`）；首站＝人工裁决（批准 / 拒绝）。
 */
export type DecisionAnswer = {
  readonly type: 'decision.answer'
  readonly id: DecisionId
  readonly decision: Decision
  /**
   * **「总是允许」——答复意图，不是裁决词表的第三词**（技术方案 · 领域划分 · 端口内类型）。
   *
   * `Decision`（`approve` / `reject`）是**结果词**——`tool.decision.decision` 用的是同一个
   * 两词表，不扩。而「总是允许」是**用户答复时的意图**（批准 ＋ 记住），故落在**命令侧**
   * 这一个可选的位上。**向后兼容**——不给 ＝ 一次性批准，与阶段 1 逐字同义。
   *
   * 流转：控制域**原样转手**（`gate.resolve(id, decision, { remember })`），**不由它翻译**；
   * 授权的落点归**权限域**（按 工具 × 路径模式 × 操作类型 记）。
   *
   * **落点＝工作区**（U22 · 技术方案 · 权限「授权的落点」）——`a` 说的是「这类事在这个项目里
   * 我信任」：**会话不是信任的边界**（会话必然结束是实现的副产品，不是设计的安全边界）。
   * 故这一位写下的是**这个工作区**的授权，存 `~/.magic/grants.json`，跨会话存活。
   * **只在批准时生效**——规则的条目只有「允许」这一形，没有「总是拒绝」。
   */
  readonly remember?: boolean
}

/** `turn.interrupt`——中断（首站：Ctrl+C）。 */
export type TurnInterrupt = {
  readonly type: 'turn.interrupt'
}

/**
 * 换模型的请求（阶段 2）——**命令负载与路由入参同一形态**（同 `UserInput` 之例，两处不各立一份）。
 *
 * 两件都可缺，看要换什么：只给 `provider` ＝换条目（模型取该条目的默认）· 只给 `model`
 * ＝留在这家换模型 · 都给＝一起换 · **都不给＝不晓得更成什么**（如实报，不猜）。
 */
export type ModelSwitchRequest = {
  /** `providers` 的键（条目名）。 */
  readonly provider?: string
  readonly model?: string
}

/**
 * `model.switch`——运行时换模型（阶段 2 · 技术方案 · 模型策略「切换」）。
 *
 * **换模型＝换接缝下游**：上下文由内核构造，对话域 / 记录域**不知道发生过切换**——
 * 它们照旧把模型名送出去，接缝按选中改道。故本命令**不动会话、不动上下文**。
 *
 * **切不动就不动**：装配据注册表的判别式结果处置，失败**不半途改**（原选原样保留）；
 * 理由——「换了一半」比「没换成」坏得多（条目换了、模型名还是上家的，多半打不通）。
 */
export type ModelSwitch = { readonly type: 'model.switch' } & ModelSwitchRequest

// —— 会话面（阶段 2 · U16 · 技术方案 · 会话与多会话）——
//
// 四支与别的命令**同一条路**：外壳发命令 → 控制面传输 → 控制域 → 对话域
// （即便同进程也走协议——「不走内部直调」是并行开发与后续换壳的共同地基）。
// 结果不回在命令上：内核以事件答复（`session.state`——见 `events.ts`），
// 与命令面「只发不收」的既有姿势一致。

/** `session.list`——列出会话（外壳要一屏目录时发）。 */
export type SessionList = { readonly type: 'session.list' }

/** `session.new`——新建一条会话并切过去（产品方案 功能 1：多会话的新建）。 */
export type SessionNew = { readonly type: 'session.new' }

/**
 * `session.open`——切换会话（装载它、继续推进）。
 *
 * **与恢复是两条路径**（技术方案 · 会话与多会话）：本命令**只是装载**——
 * 处置在途操作是恢复的活（启动流转那一路），不在这里捎带。
 *
 * `session` ＝目标会话 id；**内核之外谁都不解释它**（id 是分束键，不是内容）。
 */
export type SessionOpen = { readonly type: 'session.open'; readonly session: SessionId }

/**
 * `session.rename`——改标题（技术方案 · 会话与多会话：标题＝首条消息摘要、**可改**）。
 *
 * 与「新建 / 切换 / 列表」同层：标题是会话的属性，改它既不是换模型也不是交代。
 * `title` 为**用户给出的原文**——截断 / 归一归对话域（命令面不替它裁剪）。
 */
export type SessionRename = {
  readonly type: 'session.rename'
  readonly session: SessionId
  readonly title: string
}

/** 会话命令四支——控制域**原样转手**给对话域（它不认识会话）。 */
export type SessionCommand = SessionList | SessionNew | SessionOpen | SessionRename

/**
 * `history.read`——**读侧命令**（阶段 2 补 · 技术方案 · 领域划分：「读面走控制面」）。
 *
 * **由头**：外壳**重建展示**（恢复第 5 条 / D1 切换后的重画）要条目，而**外壳够不着记录域**
 * （域不认知外壳）。给外壳注入一个只读端口同进程能跑，但**第二站跨进程时不通**——
 * **控制面是唯一一直通的路**（跨设备也一样）。故读也走命令面，答复走事件（`session.history`）。
 *
 * `session` 不给 ＝ **当下这条**（重建展示的常见情形：切换完就重画，不必先报 id）。
 */
export type HistoryRead = {
  readonly type: 'history.read'
  readonly session?: SessionId
}

/**
 * `model.list`——**模型条目表的读侧命令**（缺陷 D10 · 第 3 样）。
 *
 * **由头**：外壳的 `/model` 要列出**注册表全量**（含从未调用过的条目），而外壳够不着
 * 注册表（那是装配的把手）——与 `history.read` 同一处境（外壳够不着记录域）：
 * **控制面是唯一一直通的路**，故读也走命令面，答复走事件（`model.catalog`，**不落库**）。
 *
 * **无参**——问的就是「都有哪些」；「当前用的是哪条」由答复里的 `current` 一并给
 * （同一次往返说清一整屏）。
 *
 * 与 `model.switch`（空参）的分工：那条**只发不收**、回话是一句「没说要换成什么」的
 * 失败缘由——**那不是读面**（读面不该以「换失败了」作答，也不该因此落库一笔）。
 */
export type ModelList = { readonly type: 'model.list' }

/**
 * `grants.list`——**授权名录的读侧命令**（U22 · 技术方案 · 权限「授权的落点」：
 * 「配两件：**查看 / 撤销**（`/grants`）与**陈旧节**的显式列出」）。
 *
 * **由头**：授权存 `~/.magic/grants.json`（内核自持的一个文件），而外壳够不着它——
 * 与 `model.list` / `history.read` 同一处境：**控制面是唯一一直通的路**。
 * 答复走事件（`grants.catalog`，**不落库**）——它是**读出来的**，落库＝把同一张表存 N 遍。
 *
 * **无参**——问的就是「本工作区记着哪些、别处还有哪些节」；分节键（本工作区）由答复里的
 * `workspace` 一并给（同一次往返说清一整屏）。
 */
export type GrantsList = { readonly type: 'grants.list' }

/**
 * `grants.revoke`——**撤销**（授权落点那两件里的第二件）。
 *
 * 两形共一个命令（省得为「撤一条」与「撤一整节」长两条命令）：
 * - `index` 给了 ＝ 撤**本工作区**那一节里的**第 index 条**（`/grants` 选定即撤）；
 * - `index` 不给 ＋ `workspace` 给了 ＝ **整节撤掉**（陈旧节那条路：路径已不在 → 你删或留）。
 *
 * ⚠️ **不自动删**（`B11`）：内核**只在用户按下撤销时**才动这个文件——
 * 删用户数据不归内核自己拿主意。
 */
export type GrantsRevoke = {
  readonly type: 'grants.revoke'
  /** 撤哪一节——**缺省＝本工作区那一节**。 */
  readonly workspace?: string
  /** 撤这一节里的哪一条——**缺省＝整节撤掉**。 */
  readonly index?: number
}

/**
 * `skills.list`——**技能目录的读侧命令**（U33 · 终端入口）。
 *
 * **由头**：`/skills` 要列**当下发现的**技能（名称 / 简述 / 来源），而外壳够不着执行域的
 * 发现面（那是装配的把手）——与 `model.list` / `grants.list` 同一处境：
 * **控制面是唯一一直通的路**，故读也走命令面，答复走事件（`skills.catalog`，**不落库**）。
 *
 * **无参**——问的就是「都发现了哪些」。技能是**随用户编辑变的目录**，故这条命令
 * **每按一次问一次**（发现面自己每次现扫）：读到的就是那一下的当前内容。
 *
 * ⚠️ **不是「选定技能」**——选定只绑定草稿（`UserInput.skills` 带的是身份），
 * 主文到真实提交那一刻才取。读侧命令只管「有什么、在哪儿」。
 */
export type SkillList = { readonly type: 'skills.list' }

/**
 * `mcp.list`——**外部服务器的一屏**（U39）。
 *
 * **由头**：`/mcp` 要列已配置的身份、连接状态与工具数，而外壳够不着那一束连接
 * （生命周期是装配编排的）——与 `model.list` / `grants.list` / `skills.list` 同一处境：
 * **控制面是唯一一直通的路**，故读也走命令面，答复走事件（`mcp.catalog`，**不落库**）。
 *
 * **无参**——问的就是「配了哪些、各是什么状态」。状态是**读出来的当下值**：每条连接自己的
 * `state`，不另立一本账，也不后台轮询（见 `McpCatalogRow`）。
 */
export type McpList = { readonly type: 'mcp.list' }

/**
 * `mcp.reconnect`——**显式重连一台外部服务器**（U39）。
 *
 * 与 `grants.revoke` 同一个姿势：**不是读面**，而是一次用户动作（`/mcp reconnect <服务器>`）；
 * 答复照走 `mcp.catalog`——重连之后那一屏要能立刻说清新的状态与工具表。
 *
 * **不重放业务调用**：重做的只有连接与发现。认不出的服务器名不当作错误（清单照给，
 * 缘由写在答复的 `note` 上）。
 */
export type McpReconnect = {
  readonly type: 'mcp.reconnect'
  /** 重连哪一台——配置里的条目名（**身份**）。 */
  readonly server: string
}

/**
 * 命令目录（首站 ＋ 阶段 2 的 `model.switch` / 会话四支 / 读侧两支 ＋ U22 的授权两支
 * ＋ U33 的技能目录一支 ＋ U39 的外部服务器两支）——外壳发往内核的全部消息。
 */
export type Command =
  | InputSubmit
  | DecisionAnswer
  | TurnInterrupt
  | ModelSwitch
  | SessionCommand
  | HistoryRead
  | ModelList
  | GrantsList
  | GrantsRevoke
  | SkillList
  | McpList
  | McpReconnect

/** 裁决配对的事件侧——内核发此事件（带呈现材料），外壳以 `decision.answer` 答复。 */
export const DECISION_REQUEST_KIND = 'tool.decision.request'
