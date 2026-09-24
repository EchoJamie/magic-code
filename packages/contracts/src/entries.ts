/**
 * 共享语言 · 条目与 blob 引用（已冻结 v0）。
 *
 * 出处：技术方案 · 记录（「记录 schema v0」· 条目）。
 * **内容流**——对话、工具调用与结果的持久形态（append-only）；恢复＝由条目重建现场。
 */

import type { BlobRef, RecordId, SessionId, Timestamp } from './ids.ts'

/** 内容承载——正文内联，或大负载转 blob 引用。 */
export type Content = { readonly text: string } | { readonly blob: BlobRef }

/** 条目 kind。 */
export type EntryKind =
  | 'user' // 用户输入
  | 'assistant' // 助手产出
  | 'tool-call' // 名 + 参数
  | 'tool-result' // ok / error + 输出
  | 'summary' // 压缩摘要（阶段 3 留位）

/**
 * `tool-call` 载荷——**结构对齐事件侧**（`EventDataOf['tool.call']`），为重放真源。
 * 不带 `call` 引用——条目自身即那次调用。
 */
export type ToolCallPayload = {
  readonly name: string
  /** 工具各自的参数模式。 */
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * 步骤的状态（U34）——**只有这三格**（词表就是这三格，多余的状态不设）。
 *
 * 它是**模型报的推进位置**，不是运行状态：软件不据它自动续跑、不拿它当成功证明
 * （设计 · 长任务计划与进度辅助：勾选只表达模型的当前判断）。
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

/**
 * 计划笔记的一步（U34）——**要得到的结果 ＋ 进展标记**。
 *
 * 不设 id、不设依赖树、不设完成证据、不强制顺序（设计明写）：步骤的少量结构只为
 * **可靠呈现**，不从任意笔记文字猜进度。`text` 的「建议二十个字左右」只写在工具参数说明里，
 * 内核不做字数检查、不截断、不警告。
 */
export type PlanStep = {
  readonly text: string
  readonly status: PlanStepStatus
}

/**
 * **一份当前计划笔记**（U34）——有序步骤清单 ＋ 可选的短文本辅助笔记。
 *
 * 用户可见的那份清单就是它（`steps` 按序呈现），而「目标 · 约束 · 已确认事实 ·
 * 未解决问题 · 回查线索」放 `notes`（一段自由文本，可为空串）。**不填空表**：
 * 没有要记的就留空，不为形式产出一堆字段。
 *
 * 它**不是任务对象**：没有生命周期、没有第二本进度账、没有「证据齐全才许完成」；
 * 更新是**整体替换**（见 `ToolResultPayload.plan`）。
 */
export type PlanNote = {
  readonly steps: readonly PlanStep[]
  readonly notes: string
}

/**
 * **当前计划笔记的读数**（U34 · `plan_read` 的产物）——内容 ＋ 它落在哪条记录上。
 *
 * `entry` 是**这份内容的记录位置**（回查线索：模型需要复核或接着往前翻时用它）：
 * - 没建立过（也没清空过）＝ `entry: null` ＋ `plan: null`；
 * - 清空过＝**保留清空那一条的 id**（`plan: null`）——不回找旧计划
 *   （「最近一条含 `plan` 的结果就是当前内容」这条例在读取侧只有一处，别处不再判一遍）。
 *
 * ⚠️ **`plan: null` 有两种来路**（没建立过 / 清空过），分得开的是 `entry`：
 * 前者为 `null`，后者有值。界面上「没有清单」与「刚清空」因此不会混。
 */
export type PlanSnapshot = {
  readonly entry: RecordId | null
  readonly plan: PlanNote | null
}

/**
 * `tool-result` 载荷——**结构对齐事件侧**（`EventDataOf['tool.result']`），为重放真源。
 * 不带 `call` 引用（同上）。
 */
export type ToolResultPayload = {
  readonly ok: boolean
  /** 内联或 blob 引用。 */
  readonly output: Content
  /**
   * **这一笔压根没跑**（与事件侧 `EventDataOf['tool.result']` 同一位，理由见那边）。
   *
   * 记在位是必须的：重放 / 切会话回来看的是**这一份**（条目载荷），不重新收事件——
   * 状态若只活在事件里，重建那一路只能再猜一遍（屏上的样子就取决于从哪条路进来）。
   */
  readonly notExecuted?: true
  /**
   * **这一笔交付了一份计划更新**（U34）——**只有更新笔记的那件工具的成功结果**带它
   * （读写分工：读的那件是查询，查询结果不携带更新字段）。
   *
   * 三态**全靠这一位的在场与否**（缺字段 ＝ 普通工具结果）：
   * - **缺** —— 与计划无关的一次工具结果（既有七件工具照旧，载荷一个字不多）；
   * - **有值** —— 这份 `PlanNote` 就是**当前计划**；
   * - **`null`** —— **清空**（不再保留当前计划笔记）。
   *
   * ⚠️ **`null` 与缺字段必须分开**：用真假判断把两者混在一起，读侧就分不出
   * 「这次清空了」与「这次跟计划无关」——前者要落一条「当前计划已清空」的材料，
   * 后者什么都不该说（设计：清空也记一次更新，不把旧内容重新投影为当前清单）。
   *
   * 当前计划＝**最近一条成功且含 `plan` 字段的工具结果**（见 `PlanSnapshot`）：
   * 因此**落账即生效**，不另建任务表、独立状态账或检查点。
   */
  readonly plan?: PlanNote | null
}

/**
 * 一次**实际送达**的技能——记录依据（U33）。
 *
 * **三样**：用的是哪个技能（`name`）、从哪一份来源（`source`，技能目录真路径）、
 * 来源怎么念（`label`）。**不算内容版本**（2026-09-21 用户已定）——技能材料动态读取，
 * 不拿 hash 锚定「当时是哪一版」；「当时到底用了什么」由**来源身份 ＋ 送出去的正文**
 * 两件答（见 `UsedSkillEntry`）。
 *
 * 它同时是**端口形态**（`ToolResult.skill`：模型自主取到的那一份，回执据它产出）——
 * 一处定义、两处用。
 */
export type UsedSkill = {
  readonly name: string
  /** 技能目录真路径（`Skill.path`）——**身份**：同名不同来源靠它分开。 */
  readonly source: string
  /**
   * 来源的**人读标签**（如「项目 .magic/skills」）——送出去那一刻从发现结果上取。
   *
   * 为什么要存而不是用时现推：**「项目 / 用户 / 配置」是发现那一刻的分法**，
   * 而路径才是身份。时过境迁（根改了、配置删了）之后，光看一条路径推不出它当时属于哪一类；
   * 现推就是编。存下来的是一条**当时为真**的事实，与 `GrantRow.describe` 同法
   * （措辞由内核一处产出，外壳照印）。
   */
  readonly label: string
}

/**
 * `user` 条目的载荷（U33）——**这条交代带了哪些技能材料**。
 *
 * ## 正文装用户的话，载荷装随它一起送出去的材料
 *
 * 与工具条目**反着来**（那边：正文＝面向模型的文本、载荷＝记录侧形态），理由在两个「正文」
 * 的读者不同：用户条目的正文**用户自己也要读**（屏上那一行就是他说的话）——把几 KB 的
 * 技能正文拼进去，恢复会话时那面墙就顶在眼前，而它并不是用户说的话。
 *
 * 加工（正文 ＋ 载荷里的材料 → 一条 `user` 消息）由**装配方**做：装配上下文时把
 * `skills[].text` 排在用户正文**之前**合成一条消息——「先把这份技能的正文摆上，
 * 再是这个任务」。重放走同一条路，故模型当时看到的那一份**逐字可复原**。
 *
 * ## 为什么正文也在载荷里（而不只留个身份）
 *
 * 「恢复可说明当时使用的内容依据」＋「使用技能后修改源文件，再开会话：当时材料依据仍可追溯」
 * ——**只记身份的话，源文件一改，当时送出去的那一份就再也取不回来了**。材料随条目落账，
 * 历史才不被材料刷新重写：身份说明「从哪来」，正文就是「当时那一份」。
 *
 * ⚠️ **不记内容版本**（2026-09-21 用户已定）：材料动态读取，不拿 hash 锚定「是哪一版」；
 * 落下来的这两件已足够说明当时用了什么，多的那一串只会长成另一个要维护的东西。
 */
export type UsedSkillEntry = UsedSkill & {
  /** 当时送进上下文的那一份正文——**是它本体，不是引用**（见上注）。 */
  readonly text: string
}

/**
 * **一次交代里落在原位的引用**（U36）——**位置 ＋ 来源身份 ＋ 本次实际交付的内容**。
 *
 * ## 它是「有序文字与引用」在记录侧的落点
 *
 * 用户的一句交代里，引用**留在它被说出来的位置**：「先读 @需求.md，再按 /review 检查
 * @src/login.ts」里的三处各有各的位置——前后文字指向哪件事，靠的就是这个次序，
 * 而不是一组材料平铺在正文之前（`UsedSkillEntry` 那条老路把技能统一前置，U36 撤销）。
 *
 * `at` ＋ `marker` 是**位置的自证**：`content.text.slice(at, at + marker.length)`
 * 就是那一段引用文字。消费方据此把材料**展开在原文那个位置**，不必重新解析整段文字去猜
 * （设计 · 终端交互：「不靠名称或对整段文字重新猜位置」）。
 *
 * ## 为什么内容也在这里（而不只留个身份）
 *
 * 与 `UsedSkillEntry` 同一条理由：材料**动态读取**（不冻结、不算 hash、不做版本），
 * 但**实际交付出去的那一份**必须留下来——源文件后来改了或删了，历史输入不被改写，
 * 「当时到底送了什么」也还答得出（`text` 就是那一份）。目录另记**未展开**的部分
 * （`omitted`），不假装列全了。
 *
 * ## 正文在不在，本身就是一条事实（U63 · 送达方式按类型分）
 *
 * 文件 / 目录 / 技能的**送达方式**是「**模型按需自读**」——正文**不随请求展开**，引用留在
 * 交代里的原位（设计 · 终端交互：「引用留在交代的位置」）。故 U63 起写下的条目**没有 `text`**：
 *
 * - 提交那一刻取一趟，取的是**校验**——这一条在不在、是不是普通文本、写的目录是不是目录、
 *   工作区外那一条是不是用户明确选定的那一个（失败＝整条不跑，照旧还回原稿）；
 * - 送进会话的是**引用本身**（`marker` ＋ `source` ＋ `label`）——模型要用哪一份、用多少，
 *   自己用 `read` / `ls` / `grep` / `glob` / `skill` 去取。它取回来的那一份落在**工具条目**里
 *   ——那才是这一轮的「实际交付内容」（「引用了 ≠ 看过了」，设计明写）。
 *
 * ⚠️ **老记录带着 `text`**（U36 起那一版：引用即进，正文随请求展开）。装配按
 * 「**有条目正文就展开，没有就留在原位**」读：旧记录因此**逐字重放**，既不替它编一个插入点，
 * 也不假装它当时是自读的。**工作区外那一份只读附件同理**（见 `external` 那一格）。
 *
 * **图片**那一支不在此列：它照旧**引用即进**（没有读图的工具，而且一张图往往就是那件事
 * 本身）——见 `image` 支。
 *
 * ## 各支共有的那几格
 *
 * - `at` —— 在**正文**里的位置（UTF-16 下标，`content.text` 的坐标）；
 * - `marker` —— 正文里那一段是什么（`@src/login.ts` / `/review` / `@shot.png`）；
 * - `source` —— **身份**：技能＝技能目录真路径（`Skill.path`）· 文件 / 目录 / 图片＝真路径；
 * - `label` —— 来源的**人读标签**（技能＝发现处产出的「项目 .magic/skills」一类；
 *   文件 / 目录 / 图片＝写入那一刻相对所属根的写法 / 工作区外的绝对写法）。
 *
 * ⚠️ **`source` 与 `Entry.source` 是两件事**：后者是 `SessionId`（条目归属的会话），
 * 此处是**材料来源**。两个「来源」在同一张表上撞了名，但空格分明（同 `UserPayload.skills`
 * 那条注的老话）。
 */
export type InputRefEntry = InputRefPlace &
  (
    | {
        readonly kind: 'skill'
        /** 技能名——`skill.used` 回执与模型取引用都用它（`UsedSkill.name`）。 */
        readonly name: string
        readonly source: string
        readonly label: string
        /** 见下「正文在不在，本身就是一条事实」——自读那一版**没有这一格**。 */
        readonly text?: string
      }
    | {
        readonly kind: 'file'
        readonly source: string
        readonly label: string
        /** 见下「正文在不在，本身就是一条事实」——自读那一版**没有这一格**。 */
        readonly text?: string
        readonly truncated?: true
        /**
         * **取自工作区之外**（U36）——用户明确选定的那一个只读附件。
         *
         * 记它有两个用处：① 审计上说得清「这份材料不在工作区里」（它的来源路径也不在工作区
         * 内，光看 `source` 要另判一次才认得出）；② 重放时模型面前那一行据它标「只读附件」。
         * **它不是授权**——沙箱的根一条都没动（见契约 `Materials`）。
         *
         * ⚠️ **这一支照旧带 `text`**（U63）：模型手上没有能读它的路——沙箱只认根内的绝对路径，
         * 工作区外那一个读不到（权限那一侧「读的越界不闸」不改变这一点：砂箱压根不给它落点）。
         * 展开是它唯一的送达方式，故与图片同为**引用即进**。
         */
        readonly external?: true
      }
    | {
        readonly kind: 'dir'
        readonly source: string
        readonly label: string
        /** 见下「正文在不在，本身就是一条事实」——自读那一版**没有这一格**。 */
        readonly text?: string
        readonly omitted?: number
      }
    | {
        /**
         * **一张图片**（U37）——内容不在 `text` 里，而是一份 **blob 引用**。
         *
         * 二进制不当文本（设计 · 文件与图片）：字节落 blob，此处只留「在哪儿 ＋ 是什么」
         * ——`mime` 与 `name` 是下一轮**送模型**（拼图像部件）与**历史呈现**（报得出是
         * 哪一张）要用的两件。恢复不依赖原文件仍在：字节已随这条记录落库
         * （设计：「图片以 blob 保存字节，用户条目保存 MIME、名称及引用」）。
         *
         * ⚠️ **它≠「模型本轮已看见原图」**：这一支只证明「这份字节进了会话」；
         * 有没有真送进请求、压缩之后是不是还在窗口里，是**装配那一刻**的事
         * （设计：「不能把有附件引用写成模型本轮已看见原图」）。
         */
        readonly kind: 'image'
        readonly source: string
        readonly label: string
        /** 文件名——屏上与历史行报得出的那一个（「截图 2026-09-20.png」）。 */
        readonly name: string
        /** MIME 类型（按字节认出来的那一种，不是按扩展名猜的）。 */
        readonly mime: string
        /** 字节本体所在——**写权归记录域**（本格对消费者不透明，同 `BlobRef` 的定义）。 */
        readonly blob: BlobRef
        /** **取自工作区之外**（同 `file` 支那一位，理由同）。 */
        readonly external?: true
      }
  )

/** 引用的**位置那两格**（各支共有——见 `InputRefEntry`）。 */
export type InputRefPlace = {
  /** 在正文里的位置（UTF-16 下标；`content.text` 的坐标）。 */
  readonly at: number
  /** 正文里那一段的文字（`@src/login.ts` / `/review`）——位置的自证。 */
  readonly marker: string
}

/**
 * `user` 条目的载荷——**带了材料时才有**（纯文本交代不带载荷，一行都不多）。
 *
 * ## 两份并存：`refs` 是入口，`skills` 只读兼容
 *
 * - `refs`（**U36 起**）——有序、带位置，一条交代里的全部材料都在这里；
 * - `skills`（U33 的旧形）——**按绑定时序、没有位置**。留它只为一件事：**旧记录照读**。
 *   旧调用方（无人值守脚本的 `{ skills }` 写法）递进来的那一份也照旧落在这里——
 *   **不编一个 `at: 0` 出来**（那是替旧输入伪造原插入点，设计明写不许）。
 */
export type UserPayload = {
  readonly refs?: readonly InputRefEntry[]
  readonly skills?: readonly UsedSkillEntry[]
}

/**
 * `assistant` 条目的载荷（U41）——**供应商要求回传的那一份思考**。
 *
 * 由头：DeepSeek 的思考模式在**带 tools** 时要求把历史轮的 `reasoning_content` 原样
 * 回传（官方文档：不回传则 400）。那一份**不进屏**（屏上是 `thinking` 通道的展示：
 * 它已经作为正文旁边的思考流过一遍了），但**要进下一次请求**——正是载荷这一格的定位
 * （同 `UserPayload` 的「不进屏、进上下文」）。正文不重复：屏上那份走 `content`。
 *
 * ⚠️ 它是**这一家这一个模型**的私有协议内容：换供应商时由适配决定带不带
 * （设计：「不转发给其它供应商」）。
 *
 * ## 核准的**只有这一形**（U64 · 记录域跟上）
 *
 * `reasoning` **必给且是字符串**——不是可选位。理由与 `UserPayload` 那条同法：
 * 载荷在这里是**重放真源**，不是杂物抽屉；**空载荷（`{}`）＝「没有载荷」写错了地方**，
 * 不是一种合法的「带了点东西」。故「这一轮没有思考」的表达方式是**整个 `payload` 缺席**
 * （`Entry.payload?` 本来就是可选的），而不是写一个空对象。
 *
 * ⚠️ **U41 那一段（模型侧的原样回传）本单一个字没动**：错的是记录域那张表没跟上
 * （`assistant` 落在「其余必须没有」那一格里），不是由头不成立。
 */
export type AssistantPayload = {
  readonly reasoning: string
}

/**
 * 条目的载荷（技术方案 · 记录：条目字段「载荷」——工具条目有，`user` 条目自 U33 起有，
 * `assistant` 条目自 U41 起有：供应商要求回传的那份思考，见 `AssistantPayload`）。
 */
export type EntryPayload =
  | ToolCallPayload
  | ToolResultPayload
  | UserPayload
  | AssistantPayload

/** 会话条目——对话、工具调用与结果的持久形态（append-only）。 */
export type Entry = {
  readonly id: RecordId
  readonly kind: EntryKind
  readonly content: Content
  /**
   * 载荷——`tool-call` / `tool-result` 有（结构对齐事件侧、为重放真源）；
   * **`user` 条目自 U33 起可有**（随这次交代送出去的技能材料，见 `UserPayload`）；
   * **`assistant` 条目自 U41 起可有**（供应商要求回传的那份思考，见 `AssistantPayload`）
   * ——⚠️ **可有＝那一份核准形状**，不是「随便什么都能放」；其余 kind 一个都不带。
   *
   * TODO(规划侧)：kind 与载荷支的**强对应**未在类型上表达（此处为可选联合）；
   * 若需编译期强制，可改为按 kind 的映射——属只增不改，等单元实需时再定。
   */
  readonly payload?: EntryPayload
  readonly at: Timestamp
  /** 来源引用（协作立条前的占位——委派关系可表达为引用链）。 */
  readonly source?: SessionId
}

/** 新增条目——未分配 `id` 的条目（`RecordsService.appendEntry` 的入参）。 */
export type NewEntry = Omit<Entry, 'id'>

/**
 * 条目范围（读取用）。
 *
 * TODO(规划侧)：形态未定；占位为可选起止（含端点与否亦未定）。
 */
export type EntryRange = {
  readonly from?: RecordId
  readonly to?: RecordId
}

/**
 * 会话摘要（列表用）。
 *
 * TODO(规划侧)：形态未定；占位为 id + 标题 + 时间
 * （技术方案 · 会话与多会话：标题＝首条消息摘要、可改）。
 */
export type SessionSummary = {
  readonly id: SessionId
  readonly title?: string
  readonly at: Timestamp
  /**
   * **这条会话属于哪个工作区**（U26）——**建立时锚定的那组根**（绝对路径 · 声明序，
   * `[0]` ＝默认根；多根见词典 Workspace：「≥ 1 条路径的联合作用域」）。
   *
   * **为何记整组而不是单取默认根**：这一列是给**恢复**用的（「回到原位，不由当下的
   * 启动目录临时决定」）——只记默认根的话，多根工作区恢复时重建不回去。
   *
   * **缺席＝列加上之前落账的会话**（无法知道，**不编**——同 `title` 的缺席之辨）。
   * 词典 · Workspace / Session（2026-09-19 改）：一个会话属于一个工作区，归属
   * **随记录持久**。
   *
   * ⚠️ 形态与配置的 `WorkspaceRoots`（`config.ts`）同形——**不为它 import 那个名字**：
   * `entries → config → ports → entries` 会绕成一个环，而共享语言里这一处只是「一组根」。
   * 两处同形是**一件事的两个入口**（配置声明什么 / 会话记下什么），不是两个概念。
   */
  readonly workspace?: readonly string[]
}
