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
}

/**
 * 一次**实际送达**的技能——记录依据（U33）。
 *
 * 三样各答一个问题：**用的是哪个技能**（`name`）、**从哪一份来源**（`source`，技能目录真路径）、
 * **当时是哪一版**（`version`）。三样缺一，日后就说不清「当时到底用了什么」
 * ——同名不同来源、同一来源改过版，都得能分开。
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
  /** 内容版本（`SkillMaterial.version`）——正文改了，这一串就变。 */
  readonly version: string
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
 * 历史才不被材料刷新重写；版本串是它的索引，正文是它的内容。
 */
export type UsedSkillEntry = UsedSkill & {
  /** 当时送进上下文的那一份正文——**是它本体，不是引用**（见上注）。 */
  readonly text: string
}

/**
 * `user` 条目的载荷——**有技能材料时才有**（纯文本交代不带载荷，一行都不多）。
 *
 * ⚠️ **`source` 与 `Entry.source` 是两件事**：后者是 `SessionId`（条目归属的会话，
 * 协作立条前的占位），此处是**技能来源**。两个「来源」在同一张表上撞了名，
 * 但空格分明——故此处用 `source` 一词而不另造译名（`UsedSkill` 与 `Skill.path` 同字，
 * 材料与记录两边指同一件事：那份技能目录在哪）。
 */
export type UserPayload = {
  readonly skills?: readonly UsedSkillEntry[]
}

/** 条目的载荷（技术方案 · 记录：条目字段「载荷」——工具条目有，`user` 条目自 U33 起有）。 */
export type EntryPayload = ToolCallPayload | ToolResultPayload | UserPayload

/** 会话条目——对话、工具调用与结果的持久形态（append-only）。 */
export type Entry = {
  readonly id: RecordId
  readonly kind: EntryKind
  readonly content: Content
  /**
   * 载荷——`tool-call` / `tool-result` 有（结构对齐事件侧、为重放真源）；
   * **`user` 条目自 U33 起可有**（随这次交代送出去的技能材料，见 `UserPayload`）；
   * 其余 kind 无。
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
