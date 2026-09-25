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

import type { InputRefPlace } from './entries.ts'
import type { Decision } from './events.ts'
import type { BlobRef, DecisionId, RecordId, SessionId } from './ids.ts'
import type { ReasoningSetting } from './model.ts'

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
 * **正文里的引用**（U36）——文件 / 目录 / 技能 / 图片，**留在用户说的那个位置**。
 *
 * 与 `InputRefEntry`（记录侧）的分工：这里只有**位置 ＋ 身份**——正文是那一句原话
 * （引用文字就在里面），材料本身**到真实提交那一刻才取**（文件读当前内容、技能取主文）。
 * 取回来之后与位置、来源一起落进 `InputRefEntry`（那是记录侧，多一份「实际交付内容」）。
 *
 * - `at` —— 引用文字在 `text` 里的起点（UTF-16 下标）；
 * - `marker` —— 那一段文字是什么（`@src/login.ts` / `/review` / `@shot.png`），随正文一起走；
 * - `source` —— **身份**（真路径）：技能＝技能目录真路径，文件 / 目录 / 图片＝那条路径的真身。
 *   同名两份技能靠它分开；「失效不换同名项」也才有判据。
 */
export type InputRef = InputRefPlace &
  (
    | { readonly kind: 'skill'; readonly name: string; readonly source: string }
    | { readonly kind: 'file'; readonly source: string; readonly external?: true }
    | { readonly kind: 'dir'; readonly source: string; readonly external?: true }
    /**
     * **从历史里取回的那一张图**（U37）——`/attachments` 的「加入本次输入」给的引用。
     *
     * ⚠️ **与上面三支不同：它不按 `source` 现读**。那一份字节早随当时的条目落库了，
     * 而它恰恰可能是「源文件已经删掉」的那一张——设计明写「复用保存字节，**不依赖原路径**」。
     * 故这一支带的是**字节所在**（`blob`，对消费者不透明，同 `BlobRef` 的定义）＋
     * 「它是什么」（`mime` / `name`），提交那一刻按引用取回字节、不再碰文件系统。
     *
     * `source` / `label` 仍在：它们是**这份材料的出处**（历史行与记录都要它——
     * 「这是从哪儿来的那一张」不能因为源文件没了就答不上来）。
     */
    | {
        readonly kind: 'image'
        readonly source: string
        readonly label: string
        readonly name: string
        readonly mime: string
        readonly blob: BlobRef
        readonly external?: true
      }
  )

/**
 * 用户输入。
 * 命令负载与 `ConversationService.submit` 入参**同一形态**——两处不各立一份。
 *
 * **一次交代＝正文 ＋ 它里面的引用**（U36 起）——整份随 FIFO 排队、整份落账，
 * 不在「取出时才拼一个当下的材料」：忙时两条交代各带各的材料，出队后不能被串成同一条。
 *
 * **引用在正文里的位置是用户表达的一部分**——「先读 @需求.md，再按 /review 检查
 * @src/login.ts」里的前后文字指向哪件事，靠的就是那个次序。故 `refs` 是一份**有序**表，
 * 而正文一个字都不剥（`/review` 留在原处，不再被抽成一个独立参数）。
 */
export type UserInput = {
  readonly text: string
  /**
   * 本次交代带上的材料——**有序**（按各自在正文里的位置），可为空。
   *
   * 缺省 ＝ 纯文本输入（`pending:string[]` 时代的行为一字不动）。给了就**必须送到**：
   * 其中任何一份取不到（文件读不了 / 技能主文取不到），这一次交代**不跑**
   * （不换同名项、不忽略它继续）——「我让你拿这份材料做这件事」是用户的明确交代，
   * 内核不能替他把这句话删掉一半，也不能拿另一份顶上去冒充。
   */
  readonly refs?: readonly InputRef[]
  /**
   * **旧写法**（U33）：只带技能、**没有位置**。
   *
   * 留它只为一件事——**旧脚本与旧调用方照跑**（`--script` 的 `{ input: { skills } }`）。
   * 那一份照旧按「材料在正文之前」展开、照旧落进 `UserPayload.skills`（旧形）：
   * **不替它编一个位置**（设计 · 终端交互：旧记录没有位置信息就按原记录呈现，
   * 不编造原插入点）。新写入一律走 `refs`。
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
  /**
   * **这一条是内核自己投的，不是用户说的**（U70）——当前只有一件：后台命令跑完了，
   * 内核把那条「跑完了 ＋ 输出在哪儿」投进它自己那条会话。
   *
   * 走的是**同一条交代通道**（它要让模型看见，而模型认的正是这一条），代价只是这一位：
   * 带上它，条目载荷记下说话人（`UserPayload.notice`），会话标题与屏上那一行因此都不会
   * 把它当成用户的话（见契约 `UserPayload.notice`）。
   *
   * ⚠️ **它不是权限或校验上的「免检」标记**：内容一样进上下文、一样落账。
   */
  readonly notice?: true
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
  /** `providers` 的键（**连接 id**）。 */
  readonly provider?: string
  /** **精确模型 id**（供应商原始 id）——不是型号族名。 */
  readonly model?: string
  /**
   * **这次采用的思考设置**（U41）——合法值由该模型的能力给出（见 `ReasoningSupport`）。
   *
   * 缺省 ＝ **模型默认**（不发送任何思考参数）。不把原模型的档位 / 预算盲目带过去：
   * 换了模型而没显式指定时，取**目标模型**的默认。
   */
  readonly reasoning?: ReasoningSetting
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
export type ProviderList = { readonly type: 'provider.list' }

/**
 * 保存一条连接（U41）——**接入 / 改名 / 更新认证 / 改地址**共一个动作。
 *
 * `provider` 是在**没接过的 id** 上给 ＝ 新建（那时 `vendor` 必给：新建官方连接必有）；
 * 在已有 id 上给 ＝ 改那一条。**改名保留 id**（改名是改 `name`，不是换 id——
 * id 是引用键，换掉它等于把默认选择、记录里的归属一起切断）。
 *
 * `apiKey` **缺省 ＝ 不动已存的那个**：管理页改个名字不该顺手把凭据抹掉。
 * 给了空串 ＝ **清除**（回到环境变量回退）。
 *
 * 保存**不静默改**别的东西：不动默认选择、不动思考设置、不动别的连接
 * （设计 · 模型与上下文「维护连接」）。
 */
export type ProviderSave = { readonly type: 'provider.save' } & ProviderSaveRequest

/** `provider.save` 的负载——命令负载与路由入参同一形态（同 `ModelSwitchRequest` 之例）。 */
export type ProviderSaveRequest = {
  /** 连接 id（`providers` 的键）——新建时就是用户起的那一个。 */
  readonly provider: string
  /** 内置供应商适配名——**只在接入 / 更换供应商时给**；认不出就不猜（不换适配）。 */
  readonly vendor?: string
  readonly name?: string
  readonly region?: string
  readonly baseURL?: string
  /** 凭据——**缺省 ＝ 不改**；空串 ＝ 清除（回退环境变量）。**不入日志 / 事件 / 记录**。 */
  readonly apiKey?: string
}

/**
 * 移除一条连接（U41）——**不静默级联**（设计 · 模型与上下文「维护连接」）。
 *
 * 有引用（默认选择 / 角色 / 正在用）时**先要求替换或取消**：命令照发，答复说明缘由，
 * 由用户决定。已发生的记录**不随移除而删除**。
 */
export type ProviderRemove = {
  readonly type: 'provider.remove'
  readonly provider: string
}

/**
 * **设为默认**（U41）——把这条连接与这个模型写成「新建普通会话采用的默认选择」。
 *
 * 与 `model.switch` **分开**（设计明文「换当前模型与保存默认分开」）：那条只改**当下**
 * 走谁、**不写配置**；这一条写配置、**不改当前**。两个动作各有各的时机与后果，
 * 混成一条会让人分不清「我刚才改的是这次还是以后」。
 */
export type ModelDefaultSet = { readonly type: 'model.default.set' } & ModelDefaultRequest

/** `model.default.set` 的负载——命令负载与路由入参同一形态。 */
export type ModelDefaultRequest = {
  readonly provider: string
  /** **精确模型 id**。 */
  readonly model: string
  /** 该模型的思考设置——缺省 ＝ 不写这一位（模型默认）。 */
  readonly reasoning?: ReasoningSetting
}

/**
 * `model.refresh`——**显式刷新意图**（U41）。
 *
 * 由头：自动检查走**有效期**（新鲜就用、过期先回旧缓存再后台刷），而用户有时明确要知道
 * 「现在供应商那儿有哪些」——**手动刷新可绕过时效**（设计 · 模型与上下文「刷新」）。
 *
 * `provider` 缺省 ＝ **当前选中那条连接**（`/model` 停在哪儿就刷哪儿）。
 * 答复走 `model.catalog`：**先回旧缓存那一屏，刷新完成后按同一条 kind 再回一屏**
 * （不落库）。不刷新没有缓存的连接也不报错——如实说「还没取过」即可。
 * 撞上 60 秒退避窗口时**不硬闯**（缘由写在答复的 `note` 上），不自行循环重试。
 */
export type ModelRefresh = {
  readonly type: 'model.refresh'
  readonly provider?: string
}

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
 * `paths.list`——**路径候选的读侧命令**（U36 · 正文里的 `@`）。
 *
 * **由头**：`@` 要边打边列候选（「`src/lo` 有哪几条」），而那要**看文件系统**——
 * 外壳不碰盘（域与外壳都只经控制面说话），故与 `model.list` / `grants.list` /
 * `skills.list` 同一处境：读也走命令面，答复走事件（`paths.catalog`，**不落库**）。
 *
 * `query` ＝ `@` 之后用户正在打的那一段（可以是空串＝列出默认根那一层）。它是**用户打的
 * 写法**，不是路径：解析（相对默认根 / 绝对）与「它在哪个根里」的判定**全在实现那一侧**
 * （执行域的路径面），外壳只把那一串原样递过来。
 *
 * ⚠️ **这一条只回答「有这么一条吗、它是文件还是目录」**——**不读内容、不授权任何东西**：
 * 选定（按下回车把引用放进正文）才是用户明确的动作，材料到提交那一刻才读
 * （见 `InputRef`）。
 */
export type PathList = { readonly type: 'paths.list'; readonly query: string }

/**
 * `paths.identify`——**认一认「我选定的这一条」**（U62 · 图片的名字）。
 *
 * **由头**：图片的**名字**是 `Image#N`（设计 · 文件与图片「图片的身份与名字」），
 * 而名字要**指认得出来**——同一张图（同内容）在一段输入里必须是同一个名字，
 * 两张不同的图必须分得开。判据是**内容身份**（字节的 sha256），而外壳**不碰盘**
 * （域与外壳都只经控制面说话）——它按不下 sha256 这一刀。
 *
 * 所以选定那一下要**问一次**：这一条是不是一张图？是的话，它的内容身份是什么？
 *
 * ⚠️ **为什么与 `paths.list` 分开，而不是把它加宽**：那一条是**边打边问**的浏览
 * （每改一个字问一次），设计明写它**不读内容**（「选定才是用户的动作，材料到提交那一刻
 * 才读」）。把「读一次内容」塞进浏览面，等于**每打一个字就把候选里那几张图读一遍**。
 * 这一条只在**回车选定之后**发——那正是设计说的那个「用户的动作」。
 *
 * ⚠️ **只认得出「是 / 不是图片」与它的身份，不改这次交代的送达**：材料怎么到模型那条
 * 归别处（U63 那一面）；这里问到的身份，是**块上的名字**据以取号的那一件。
 *
 * `path` ＝选定的**真路径**（`PathCatalogRow.path`，身份就是它）；
 * `external` ＝那一条在不在工作区里（用户在候选里看到的那一格，**原样带过来**——
 * 「工作区外只收单个文件、走只读附件」那条判据在实现侧，外壳不自己判里外）。
 */
export type PathIdentify = {
  readonly type: 'paths.identify'
  readonly path: string
  readonly external?: true
}

/**
 * `attachments.list`——**本会话已送出的图片**（U37 · `/attachments` 的读侧）。
 *
 * **由头**：源文件删掉、会话重开之后仍要取得回那一张图（设计 · 文件与图片：
 * 「删掉原文件、重开会话后仍能取回并继续使用」），而取回的依据是**记录里那份字节**，
 * 不是盘上那个路径。外壳够不着记录（域与外壳都只经控制面说话），故与
 * `history.read` / `skills.list` 同一处境：读走命令面，答复走事件（`attachments.catalog`，
 * **不落库** —— 条目本来就在库里，再存一遍读数只是多一张会过期的表）。
 *
 * **无参**——问的就是「这一条会话送过哪些图片」。会话由内核按**当下活跃**那条绑
 * （同一族命令的既定姿势：不让外壳指定别的会话）。
 */
export type AttachmentList = { readonly type: 'attachments.list' }

/**
 * `attachments.export`——**把那一张的原图导出成本地文件**（U37 · 「查看原图」）。
 *
 * 与 `attachments.list` 分开的理由：那一条是**读**（不改变任何东西），这一条
 * **真的在盘上落一个文件**——用户的动作（按下「查看原图」），答复照走 `attachments.catalog`
 * （`note` 说导出到哪儿 / 为什么没成），与 `mcp.reconnect` 之后照走 `mcp.catalog` 同一条姿势。
 *
 * `entry` ＝那一张**落在哪条记录上**（`AttachmentRow.entry`）——记录位置就是身份，
 * 不另编一串 id。**导出不碰原路径**：字节从记录里取（源文件没了照样导得出）。
 *
 * **只写新文件**：落点是唯一命名的临时文件，**不覆盖已有文件**、**不自动打开外部应用**
 * （设计明文）；「自动用看图软件打开」不在内核的射程里。
 */
export type AttachmentExport = { readonly type: 'attachments.export'; readonly entry: RecordId }

/**
 * 命令目录（首站 ＋ 阶段 2 的 `model.switch` / 会话四支 / 读侧两支 ＋ U22 的授权两支
 * ＋ U33 的技能目录一支 ＋ U36 的路径候选一支 ＋ U62 的认出选定那一条）——外壳发往内核的全部消息。
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
  | ModelRefresh
  | ModelDefaultSet
  | ProviderList
  | ProviderSave
  | ProviderRemove
  | GrantsList
  | GrantsRevoke
  | SkillList
  | PathList
  | PathIdentify
  | AttachmentList
  | AttachmentExport
  | McpList
  | McpReconnect

/** 裁决配对的事件侧——内核发此事件（带呈现材料），外壳以 `decision.answer` 答复。 */
export const DECISION_REQUEST_KIND = 'tool.decision.request'
