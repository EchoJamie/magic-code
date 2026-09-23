/**
 * 外壳 · 视图模型与归约（缺陷轮 II 重画）——**事件 → 一屏**。
 *
 * 出处：`界面原型.html`（已定稿）——组件规格 · 状态行规格 · 十四屏场景 · 交互逻辑。
 * 本文件是**纯模型**：归约是纯函数；Ink 只把模型画出来（换皮不动此层）。
 *
 * **记录区三类行**（原型 · 交互逻辑）：
 * - **会话内容**（`›` 用户 · `⏺` 助手 · `▶` 工具）——落库、进上下文；切走 / 重开时**重建**；
 * - **命令输出**（纯输出型 slash 的结果）· **命令回执**（交互配置型的完成回执）——
 *   **不落库、不进上下文、不重建**（「屏上痕迹」：换会话或重开就没了）。
 *
 * **左下交互区 `Dock` 四种用法同一位置**（输入 / 裁决 / 会话列表 / 模型候选）——同一开合。
 *
 * **状态行只放「此刻」**——一次性的事（「已切到 #2」）进记录区当回执。
 */

import type {
  DecisionWeight,
  Entry,
  EventDataOf,
  InputRefEntry,
  KernelEvent,
  ModelCatalogRow,
  ModelErrorTier,
  ModelInfo,
  ModelRef,
  ReasoningSetting,
  ReasoningSupport,
  VendorInfo,
  PathCatalogRow,
  PlanNote,
  PlanSnapshot,
  RecordId,
  SessionId,
  SessionSummary,
  SkillCatalogRow,
  UsedSkill,
  UsedSkillEntry,
} from '@magic/contracts'
import { apiKeyEnvVarOf, mcpToolLabel, parseMcpToolName, sanitizeForDisplay } from '@magic/contracts'
// 草稿里那几处引用的形态（外壳侧）——纯编辑规则在 `./components/inline.ts`
import type { DraftRef } from './components/inline.ts'

/**
 * 工具行上那个名字（U38）——**外部工具的注册名不照抄**。
 *
 * 注册名（`mcp__<服务器>__<工具>`）是**编码**（为的是跨服务器唯一），给人看的写法是
 * `服务器 / 工具`——与审批卡同一个形态（契约 `mcpToolLabel` 一处产出，两处同形）。
 * 内置工具名照旧（`exec` 就写 `exec`）。
 */
function toolNameOf(name: string): string {
  const external = parseMcpToolName(name)
  return external === undefined ? name : mcpToolLabel(external)
}

// ══ 记录区（三类行）══════════════════════════════════════════════════

/**
 * 工具行的跑动状态——「在跑」（`⟳` ＋ 耗时）与「跑完」（`▶` ＋ 结果）一眼可分。
 *
 * 收尾那四件里有**两件是「压根没跑」**：`rejected`（裁决拒了）与 `unexecuted`（规约重审扣下 /
 * 材料超限停批）。它们与 `failed`（跑了没成）**含义不同**，屏上因此不报耗时、不打失败那个叉。
 * 后者的判据是**结果自己带的那一位**（`notExecuted`）——谁拦下的谁写，外壳不猜（见
 * `reduceToolResult`）。
 */
export type ToolRunState = 'running' | 'ok' | 'failed' | 'rejected' | 'unexecuted'

/** 记录区的一行。`session` 那三类是**会话内容**，其余是**屏上痕迹**。 */
export type LogRow =
  // —— 会话内容（落库 · 可重建）——
  | {
      readonly kind: 'user'
      readonly key: string
      readonly text: string
      readonly echoed: boolean
      /**
       * **随这条交代送出去的技能**（U33）——**只有重建那一趟才有**（`rebuildRows` 从条目
       * 载荷里取），当场发的那一次不给：现场有草稿材料行与 `本次使用技能` 回执两处说着
       * 这件事，再挂一条就是同一句话第三遍。
       *
       * 为什么重建要补：切走一条会话再切回来 / `--session` 接续之后，屏上只剩用户那句
       * 话——「这条交代当时带了哪份技能」在屏上**一处都没有了**（依据在条目载荷里、
       * 没丢，缺的是显示）。设计：「恢复后来源可辨」。
       *
       * ⚠️ **不是使用回执**：那一条说的是「模型真用上了」（当时发生的事），此处说的是
       * 「这条记录里存着这份材料」。恢复时**不重放、不伪造**回执。
       */
      readonly skills?: readonly UsedSkill[]
    }
  | { readonly kind: 'assistant'; readonly key: string; readonly text: string }
  | { readonly kind: 'thinking'; readonly key: string; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly key: string
      /** `tool.call` 事件的 id——请求 / 询问 / 裁决 / 结果四处同指它。未配对时为 `null`。 */
      readonly call: RecordId | null
      readonly name: string
      /** 参数（流式片段累积；`tool.call` 到时落定）。 */
      readonly argsText: string
      /**
       * 参数的**结构化**那一份（`tool.call` 到时落定；流式那几帧还是 `null`）。
       *
       * 由头（U20 · 差距 1/2）：已知形态要**就近渲染**——`edit` / `write` 的参数里塞着
       * 整段正文（JSON 化之后是一条长到没法读的行），而上屏要的是「改了哪个文件、
       * 这一处改了什么」。`argsText` 留着作**原文回退**（流式片段不全，解析不了）。
       */
      readonly args: Readonly<Record<string, unknown>> | null
      readonly state: ToolRunState
      /**
       * 这次调用**经过的墙钟**（`tool.call` 的事件时刻 → `tool.result` 的事件时刻）。
       *
       * ⚠️ **不是**裁决耗时：`tool.decision.elapsedMs` 是权限域「提示 → 答复」那一段
       * （自动放行时≈0），拿它当工具耗时就会在屏上报「✓ 0ms」（第 22 轮查明并改）。
       * 语义如实记：这是**发起 → 落地**的墙钟——**含**闸门等待（人工批准时那段是人在想）。
       */
      readonly elapsedMs: number | null
      /** 发起时刻（`tool.call` 的 `at`）——算上面那个差用。 */
      readonly startedAt: number | null
      /** 结果 / 输出的行（dim 缩进块）。 */
      readonly output: readonly string[]
      /**
       * **这一笔不必上屏**（U34 · `quietTool`）——计划读写与历史回查那三个辅助工具。
       *
       * 由头（设计 · 任务推进 · 终端投影与布局）：「成功的三个辅助工具**默认不另刷一串工具卡**
       * 或重复计划全文；原始调用/结果仍完整保存，既有工具详情展开可查，**失败正常可见**。」
       * 计划本身另有去处（清单那一块就地刷新），再刷一串卡就是把同一件事说两遍。
       *
       * ⚠️ **只是「默认不画」，不是「丢掉」**：行照旧进记录区（定局与重建都留着它，
       * 多件裁决报数、耗时也还要它）。画不画是**渲染那一处**的事：`components/log.ts`
       * 的 `rowBody` 按这一格与 `expanded`（既有那一个展开键）判——**失败 / 被拒 / 被扣下
       * 照旧可见**，`ctrl+o` 展开之后与别的工具行长得一模一样（详情可查）。
       */
      readonly quiet?: true
    }
  /**
   * 折叠的**一组**工具调用（重建时同轮的连续调用并成一行——原型 · 场景 12：
   * 「▶ 3 次工具调用（ls · read · grep）」）。
   * 收的判据两条（缺陷 D18）：**≥2 次**才收 · **末尾 `RECENT_GROUPS` 组不收**。
   */
  | { readonly kind: 'toolgroup'; readonly key: string; readonly names: readonly string[] }
  // —— 屏上痕迹（不落库 · 不重建）——
  /**
   * **启动字标**（品牌视觉 · TUI Banner）——记录区**最前面那一块**，启动印一次。
   *
   * 归**屏上痕迹**那一类（不落库、不进上下文）：它是装饰，不是「这一趟发生过什么」。
   * 但它与其余痕迹有两点不同，两点都有由头：
   *
   * - **它比其余痕迹优先**——`rebuild` 把 `settled` 整个换掉时，它得**留在最前面**
   *   （见 `bannerFirst`）。不保这一手，`--session` 接续那条路开局就把它换没了
   *   （同一笔账，`ShellOptions.receipts` 已经吃过一次）。
   * - **它不带宽度**——画哪一版由**渲染层按当时的列数**挑（`components/log.ts` 的
   *   `case 'banner'` → `bannerOf`）。列数只有渲染层知道（`useWindowSize`），
   *   视图这层没有它，也不该去猜一个（「拿不到的不编」）。
   */
  | { readonly kind: 'banner'; readonly key: string }
  | { readonly kind: 'output'; readonly key: string; readonly lines: readonly string[] }
  | { readonly kind: 'receipt'; readonly key: string; readonly text: string }

/**
 * **有没有工具正在跑**（那类行标记是 `⟳`）——两处据它：
 * ① 活壳的钟（只在这时候滴答，闲着一格都不动）；② 输入行的面孔（工具在跑 / 等模型回来）。
 *
 * 只看**本轮**的行（`rows`）：定局那一侧的行不再变，留着「跑动中」的只可能是被中断的残影。
 */
export function hasRunningTool(view: ShellView): boolean {
  return view.rows.some((row) => row.kind === 'tool' && row.state === 'running')
}

/** 是不是**会话内容**那一类（重建只挑它们；其余是屏上痕迹，切走就没了）。 */
export function isSessionRow(row: LogRow): boolean {
  return row.kind === 'user' || row.kind === 'assistant' || row.kind === 'thinking' || row.kind === 'tool'
}

// ══ 计划（U34）：投影 ＋ 块 ═══════════════════════════════════════════

/**
 * **手上的当前计划**（U34）——外壳只认**已提交记录**来的那一份（设计：`ShellView` 只保存
 * 来自已提交记录的当前投影及本地展开/滚动位置）。
 *
 * 两条来路，**都经 `withPlan` 一处收口**：初始与切会话走 `session.history` 重建
 * （`planFromEntries` 从条目里取），实时走瞬时事件 `plan.changed`。
 */
export type PlanProjection = PlanSnapshot

/**
 * **辅助工具名**（U34）——计划读写与历史回查那三个。
 *
 * 名字按契约（设计 · 数据与工具契约的表：`plan_read` / `plan_update` / `history_read`）。
 * 它们只读同会话记录或写协作笔记，**不需要用户逐次审批**；成功时也**不另刷工具卡**
 * （见 `LogRow` 里 `quiet` 那一格）。失败照旧可见——故是「默认不画」，不是「不认」。
 */
export const PLAN_TOOLS: ReadonlySet<string> = new Set(['plan_read', 'plan_update', 'history_read'])

/** 这个工具名是不是那三个辅助工具之一（参数由调用方给**注册名**，不是给显示名）。 */
export function quietTool(name: string): boolean {
  return PLAN_TOOLS.has(name)
}

/**
 * 这一行**默认画不画**——**一处判定、两处用**：
 * ① 渲染那一处（`components/log.ts` 的 `rowBody`）收起时不出行；② **历史重建的收拢**
 * （`collapseToolGroups`）不把它算进分组的名称与计数。
 *
 * 写在一处是有由头的（2026-09-23 复验退回）：两处各判一套的话，收拢只认「是不是 tool 行」，
 * 于是**成功辅助调用在历史里又被重新印出来**——`● 2 次工具调用（plan_update · plan_read）`，
 * 而单看某一行它明明是「默认不画」的。
 *
 * 判据三件：成功（含跑动中）⇒ 默认不画；**没跑成（失败 / 被拒 / 被扣下）⇒ 照旧可见**；
 * 展开由调用方另判（`expanded` 只影响画不画，不影响「算不算进分组」）。
 */
export function quietRowHidden(row: LogRow): boolean {
  if (row.kind !== 'tool' || row.quiet !== true) return false

  return row.state !== 'failed' && row.state !== 'rejected' && row.state !== 'unexecuted'
}

/** 手上有没有一份**画得出来**的清单（没有步骤＝没有清单——辅助笔记不铺在清单里）。 */
export function hasPlan(view: ShellView): boolean {
  return (view.plan.plan?.steps.length ?? 0) > 0
}

/**
 * **收下一份新的当前计划**（`plan.changed`）——**按条目 id 判新旧**。
 *
 * 设计明写：「以计划条目 id 比较新旧，**历史晚到不能覆盖更新或清空**」。两条来路都会
 * 落到这儿（实时事件、分块读回来的历史），而读历史那一趟比实时慢——晚到的那一份
 * **旧**内容不许把已经上屏的新计划盖回去。
 *
 * `entry` 是**数字**且单调（契约 `RecordId`：「单调，排序权威」），故「新」就是「大」。
 * 还没有计划时（`entry === null`）一律收下。
 */
export function withPlan(view: ShellView, entry: RecordId, plan: PlanNote | null): ShellView {
  const current = view.plan.entry
  if (current !== null && entry <= current) return view

  return { ...view, plan: { entry, plan } }
}

/**
 * **条目里那一条当前计划**（重建用）——**从后往前，遇到第一个带 `plan` 字段的工具结果就停**。
 *
 * 两条分寸直接来自设计（·保存与读取是一条链）：
 * - **「含 `plan` 字段」与「`plan` 是 `null`」是两件事**：缺字段＝普通工具结果（跳过），
 *   `null`＝清空（**到此为止，不继续往前找**——清空之后旧的计划不是当前计划）；
 * - **失败结果不携带有效更新**：`ok === false` 的那一条跳过（它没写进去）。
 *
 * 找不到 ⇒ `{entry: null, plan: null}`：**没建立过计划**，如实说没有。
 */
export function planFromEntries(entries: readonly Entry[]): PlanSnapshot {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.kind !== 'tool-result') continue

    const payload = entry.payload as { readonly ok?: boolean; readonly plan?: PlanNote | null } | undefined
    if (payload === undefined || payload.ok === false) continue
    if (!Object.hasOwn(payload, 'plan')) continue

    // 字段在 = 这一条就是那次更新（值可以是 `null`＝清空）；缺字段才是「不是它」
    return { entry: entry.id, plan: payload.plan ?? null }
  }

  return { entry: null, plan: null }
}

// ══ 左下交互区（四种用法同一位置）════════════════════════════════════

/** 待答的裁决——**接管输入框**的那一件。 */
export type PendingDecision = {
  /** **配对键**——`tool.decision.request` 事件的 id（答复原样带回）。 */
  readonly id: RecordId
  readonly call: RecordId
  readonly name: string
  /** 判断材料——diff / 命令分解 / 影响面（**内联**，不另套容器）。 */
  readonly material: string
  readonly weight: DecisionWeight
  /**
   * **这是一次外部操作**（U38 · 来自 `tool.decision.request.data.external`）。
   *
   * 两处据它换口径：副题改说 `外部操作 · 效果由服务器决定`（**不说可逆 / 不可逆**——
   * 本机判不出），以及**不给「总是允许」**（划掉，同必闸类那条姿态）。缺席＝内置工具。
   */
  readonly external?: boolean
  /**
   * 多件裁决的**第几件 / 共几件**（原型 · 场景 7：件数报两处——卡上 ＋ 状态行）。
   * 单件时 `null`（不报数）。
   */
  readonly position: { readonly index: number; readonly total: number } | null
}

/**
 * **摘掉全局的「移除当前技能」那一行**（U36）。
 *
 * U33 时草稿上挂着一条「当前技能」，故抽屉里要有一行为它准备；U36 起引用**就长在正文
 * 里**——要摘掉它，在那一处按退格（或删掉那几个字）即可，位置就在用户眼前。
 * 再留一行全局的移除，等于同一件事有两个入口，而其中一个（全局的）说不出「摘的是哪一处」。
 */

/** 选择器的一行。 */
export type PickerRow = {
  readonly label: string
  readonly meta: string
  /** 当前那一条（原型 · 场景 9：`正在用`）。 */
  readonly current: boolean
  /** 选定后要用的值（会话 id / 条目名 / **技能目录真路径**）。 */
  readonly value: string
  /**
   * 这一行属于哪一组——**分组头**（`/session` 按工作区分组，U26）。
   * 分组头画在**这一组第一行之前**（见 `groupHeads`）；`/model` 不给（不分组的列表）。
   */
  readonly group?: string
  /**
   * **这一行选中的是什么**（U41）——模型行给**连接 id ＋ 精确模型 id** 两件。
   *
   * 由头：模型这一摊的**选择键是两件**（合法的两条连接可以有同名模型，只报模型名认不出是谁
   * ——设计 · 模型与上下文明文）。而 `value` 是一格字符串，把它拼成 `连接/模型` 再在选定那一刻
   * **拆回来**，就是「按字面反推结构」——那种协议最容易在两处各写一半（模型名里有个 `/`
   * 就当场分家）。故**在造行的地方**把结构带着走（同 `/grants` 行的 `revoke`）。
   */
  readonly pick?: ModelRef
  /**
   * **这一行选定之后要用的思考设置**（U41）——思考那一屏给。
   *
   * 与 `pick` 同一条由头：**结构不从字面反推**（`level:high` 那种写法要在两处各解析一半）。
   * 缺省 ＝ 这一行不是选思考设置的。
   */
  readonly reasoning?: ReasoningSetting
  /**
   * **这一行不参与折叠**（U41 返修）——候选窗口折起来时它照旧画在列表末尾。
   *
   * 由头：`/model` 末尾那三条**入口行**（连接供应商 / 管理连接 / 刷新模型）是「这一刻能做
   * 什么」，而不是「有哪些可挑的」——它们被几十条模型折到看不见，等于没有入口
   * （首验的判据就是这个：**空态也要有可操作的入口**，而空态之外更不该把它藏起来）。
   * 故它们**常驻**：窗口只折候选那一头，常驻行照旧在末尾（额度各占各的）。
   */
  readonly pinned?: boolean
  /**
   * **压暗**——「别的项目」的行（工作区≠你此刻所在的那个）。
   * 这是**视觉次序**，不是可用性：压暗的行**照样选得中、切得过去**。
   */
  readonly faint?: boolean
  /**
   * **选定即撤**（`/grants`）——这一行要发的撤销负载（`grants.revoke` 的两件）。
   *
   * 只有授权那个抽屉给：别的选择器「选定」是**切过去**，授权这里「选定」是**撤掉它**
   * （B13 的一句规格）。故这一位存在＝回车之后要发一条撤销，而不是打开什么。
   */
  readonly revoke?: { readonly workspace?: string; readonly index?: number }
  /**
   * **这一行保证只占一行**（超宽由渲染层截断加 `…`）——技能那两处给（`/skills` 的候选行、
   * 输入行的候选）。
   *
   * 由头：交互区的高度账（`dockHeightOf`）**一行一行数**（候选 N 条＝N 行），而简述是
   * 用户自己写的、可以很长——折行了就是「账 N 行、屏 N+1 行」，矮终端上帧正好顶满，
   * 真光标当场高一行（U31 三轮那条账的分家）。故**行自己担保一行**：截断在渲染层做
   * （列数只有那一层知道），账照旧一行一条。
   *
   * 其余选择器不给这一位——它们沿用老面孔（长标题照旧折行，那是**既有行为**，
   * 本单不改）。
   */
  readonly oneLine?: boolean
  /**
   * **必留的那一段**（`oneLine` 行用）——它是 `meta` 的**前缀**（技能行里＝来源那半截）。
   *
   * 由头（独立验收二轮）：一行的额度是「名称 ＋ meta」两段分，而**截断该落在简述身上**
   * （设计 · 终端交互：「窄窗先保住名称/来源、再截断简述」）。渲染层光看 `meta` 不知道
   * 哪一截是来源、哪一截是简述——量错地方就会在宽窗下也去截名称（那正是二轮退回的那条
   * 「过正」）。故由**造行的人**（它知道哪一段是来源）把这一格交出来，渲染层据它留额度：
   * 名称按需取，但**先扣掉这一段**。
   *
   * ⚠️ 与 `meta` 同源、是它的前缀——两格给同一串不重复：`meta` 是整行要写的字，
   * 这一格只说「其中哪一部分不许被挤掉」。
   */
  readonly keep?: string
}

/** 选择器（`/session` · `/model` · `/grants` · `/skills` · `@` 路径）——**只在左下开**。 */
export type Picker = {
  /**
   * 取材的来路。五处各一门：`/session` 读目录、`/model` 读条目表、`/grants` 读授权名录
   * （U22 · B13）、`/skills` 读技能目录（U33）、**`@` 读路径候选**（U36）——**同位置同开合**。
   */
  readonly source:
    | 'session'
    | 'model'
    | 'region'
    | 'grants'
    | 'skills'
    | 'paths'
    | 'mcp'
    | 'vendor'
    | 'provider'
    | 'provider-detail'
    | 'model-detail'
    | 'model-reasoning'
  readonly rows: readonly PickerRow[]
  readonly selected: number
  /** 列表下方那行说明（可选）。 */
  readonly hint?: string
  /**
   * **正在筛的词**（`/skills` 与 `@` 给）——列表下方报出它，并说明「接着打能收窄」。
   *
   * 为什么要有这一格而不是只留在外壳里：用户**看得见自己在筛什么**，才知道那些键去哪了
   * （选择器接管输入，打进正文的只有 `@` 那一段，不报一句就成了「按了没反应」）。
   *
   * ⚠️ `@` 那一门另有不同：**筛词同时写进草稿**（就写在 `@` 之后）——它是用户那句交代的
   * 一部分，不是抽屉里的一个临时输入框（见 `Picker.anchor`）。
   */
  readonly filter?: string
  /**
   * **选定之后，引用插回正文的哪一段**（U36 · 只有 `@` 与 `/skills` 给）。
   *
   * 设计写死了两条（终端交互 · 技能调用）：选择**只替换当前查询片段**；选定后**插在打开
   * 列表前的那个位置**——**不移到开头、也不一律追加到末尾**。
   *
   * `start`/`end` 就是「那一段查询」在草稿里的范围：`@` 是从那个 `@` 到它当前打到的位置；
   * `/skills` 那条路草稿已被命令清空，故是 `[0, 0)`。选定即把这一段换成引用文字
   * （`replaceWith`）。
   */
  readonly anchor?: { readonly start: number; readonly end: number }
}

/**
 * **一次本地小输入**要画的那几格（U41）——改名 / 密钥走的都是这一形。
 *
 * ⚠️ **密钥那一路，`display` 是圆点**：真值只在**外壳手上**那一份（`Shell` 的 `asking`），
 * 不进视图对象——视图是要被渲染、被取景、被快照的东西，凭据没有理由出现在里面
 * （设计：「配置写入 600，界面隐藏输入不进入普通输入历史」）。
 */
export type PromptState = {
  /** 问的是什么——一行标签（如「新名字」「密钥（输入不回显）」）。 */
  readonly label: string
  /** 输入行**要画的那一串**（密钥＝圆点；不是真值）。 */
  readonly display: string
  /** 插入点在这串里的下标（与 `display` 同尺——密钥也一字符一格）。 */
  readonly caret: number
  /** 空着时那一行的占位（一句实话：要输入什么）。 */
  readonly placeholder: string
  /** 底下那行补充说明（可省）——如「留空＝不动已存的那把」。 */
  readonly note?: string
}

/** 左下交互区——**四种用法同一位置、同一开合**。 */
export type Dock =
  | { readonly kind: 'input' }
  | { readonly kind: 'decision'; readonly pending: PendingDecision }
  | { readonly kind: 'picker'; readonly picker: Picker }
  /**
   * **本地小输入**（U41）——接管输入行，问一件小事（改名 / 密钥）。
   *
   * 与 `input` 的分野：那一路提交出去的是**交代**（`input.submit`，进记录、进模型），
   * 这一路提交出去的是**一次设置**（`provider.save` 一类），**不进记录、不给模型看**。
   * 故它不是「草稿的另一种面孔」——是一块**另起的小界面**（同 `decision` / `picker` 一样接管）。
   */
  | { readonly kind: 'prompt'; readonly prompt: PromptState }

// ══ slash 候选（D12）═════════════════════════════════════════════════

/** 一条命令的样子（候选里给「名字 ＋ 一句话说明」）。 */
export type CommandSpec = {
  readonly name: string
  readonly summary: string
}

/**
 * **命令登记表**——只列**真存在**的命令（原型 · 场景 11 的自律：
 * 列一个按下去会报错的，比不列更坏）。
 *
 * 六条各自的性质：
 * - `/help` · `/status`——**纯输出型**（本地就能答，不进记录区的对话）；
 * - `/session` · `/model` · `/grants` · `/skills`——**交互配置型**（开选择器）。
 *
 * ⚠️ `/grants` **原先不在这张表上**，理由正是上一条自律（「内核还没有，故不列」）——
 * `U22` 到站后它有了：名录从 `grants.json` 来（走 `grants.list`），选定即撤。
 * `/skills` 同理（`U33` 到站后它有了：目录走 `skills.list`，选定只绑草稿）。
 *
 * ⚠️ **这张表也是「同名技能让位」的判据**（`matchCommands` / `shell.ts` 的 `submit`）：
 * 表上的名字归内置命令，同名技能不抢它的含义（仍能从 `/skills` 里明确选出来）。
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: '/session', summary: '会话：列表 · 切换 · 新建 · 改名' },
  { name: '/status', summary: '看这一趟用了多少、模型是谁' },
  { name: '/model', summary: '换模型（列出可用条目，选定即切）' },
  { name: '/grants', summary: '本工作区的授权：查看 · 撤销' },
  // U33——**它是内置命令**（不是技能）：故在表上、名字不许被技能顶掉。
  // 选定只说「挂到这条草稿上」，不说「发送」——那是两件事（选定不发送，那里另有提示）。
  { name: '/skills', summary: '技能：浏览 · 搜索 · 选定' },
  // U39——**纯查询型**（选项＝读一眼，回车不改变任何东西）；`/mcp <名字>` 看那一台的明细。
  { name: '/mcp', summary: '外部工具服务器：状态 · 工具 · 重连' },
  { name: '/help', summary: '这张表' },
]

/** 候选状态——`selected` 是**筛过之后**的次序。 */
export type CompletionState = {
  readonly candidates: readonly CommandSpec[]
  readonly selected: number
}

/**
 * 一条输入该出哪些候选（**边打边筛 · 按匹配度**）。
 *
 * 打分：**前缀** ＞ **子串** ＞ **子序列**（`/md` 也认 `/model`）；都不中＝不列。
 * 输入不是以 `/` 开头、或已经打了空白（进了参数）＝**不出候选**。
 *
 * ## 技能名也在候选里（U33 · 终端入口）
 *
 * 「`/<skill-name>` 直接引用已知技能」要能**边打边认**，故技能名与内置命令同列一张候选
 * ——候选里认出来就能按 Tab / 回车填进草稿，随后是直达那条路（见 `shell.ts` 的 `submit`）。
 *
 * 三条分寸：
 * - **打了名字才列**（`/` 之后一个字都没打时不列技能）：`/` 那一下问的是「有哪些命令」，
 *   把仓库里几十个技能一并倒出来会把那一屏淹掉，也让 `/skills` 这个入口看不见了；
 * - **同名只列一条**（按发现次序取头一份）：直达本来就是按来源优先级取唯一一份
 *   （`resolveSkill`），列两条同名的行只会让人以为要挑；要挑去 `/skills`
 *   ——那里**同名各占一行**，来源可辨；
 * - **与内置命令同名的技能不列**：内置命令保留含义（工单明写），该技能仍能从 `/skills`
 *   选出来——故此处是「不列」，不是「不认」。
 */
export function matchCommands(
  word: string,
  skills: readonly SkillCatalogRow[] = [],
  /**
   * 这个词在**草稿最前**吗（前面只有空白）。
   *
   * 内置命令只在这一档列：它们是**整行的操作入口**（`/status` 写在一句话中间不成立），
   * 而技能引用**在任何词边界都成立**（U36：句中那处 `/review` 正是要选进来的东西）。
   */
  atStart = true,
): readonly CommandSpec[] {
  if (!word.startsWith('/')) return []
  if (/\s/.test(word)) return [] // 进了参数——不再筛（空格与换行都算「进了参数」）

  const pool = atStart ? [...COMMANDS, ...skillCommands(word, skills)] : skillCommands(word, skills)
  const scored = pool
    .map((command) => ({ command, score: scoreOf(command.name, word) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name))

  return scored.map((row) => row.command)
}

/** 插入点所在的那个「斜杠词」——候选按它筛（见 `matchCommands`）。 */
export type ActiveWord = {
  /** 词在草稿里的起点。 */
  readonly start: number
  /** 词在草稿里的终点（＝插入点）。 */
  readonly end: number
  /** 词本身（含前导斜杠）。 */
  readonly word: string
  /** 它在草稿最前（前面只有空白）——内置命令只在那一档列。 */
  readonly atStart: boolean
}

/**
 * **插入点正打着的那个斜杠词**——`/<名称>` 在**任何词边界**都能唤起候选（U36）。
 *
 * 判据三条（都在这一处收口，别处不必再判）：
 * - 词从**上一个空白**之后起（词边界——`半/full-width` 都算空白，`\s` 说了算）；
 * - 词以 `/` 开头（不是斜杠词就没什么可筛的）；
 * - 词一直连到**插入点**（打完之后的那一段不算：`/rev 后面` 已经在参数里了）。
 */
export function activeWordOf(draft: string, caret: number): ActiveWord | undefined {
  const at = Math.max(0, Math.min(caret, draft.length))
  const head = draft.slice(0, at)
  const start = head.search(/[^\s]*$/)
  const word = head.slice(start)
  if (!word.startsWith('/')) return undefined

  return { start, end: at, word, atStart: /^\s*$/.test(draft.slice(0, start)) }
}

/** 技能名那一批候选（见 `matchCommands` 那三条分寸）——`summary` 用技能的简述。 */
function skillCommands(word: string, skills: readonly SkillCatalogRow[]): readonly CommandSpec[] {
  if (word.replace(/^\//, '') === '') return []

  const taken = new Set(COMMANDS.map((command) => command.name))
  const commands: CommandSpec[] = []

  for (const skill of skills) {
    const name = `/${skill.name}`
    if (taken.has(name)) continue
    taken.add(name) // 同名多份只留头一份（次序即优先级，同 `resolveSkill` 的取法）

    commands.push({ name, summary: skill.description })
  }

  return commands
}

/** 匹配度：前缀 3 · 子串 2 · 子序列 1 · 不中 0。 */
function scoreOf(name: string, word: string): number {
  const haystack = name.toLowerCase()
  const needle = word.toLowerCase()
  if (needle === '') return 1
  if (haystack.startsWith(needle)) return 3
  if (haystack.includes(needle)) return 2

  // 子序列（按序散落也算）
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at += 1
    if (at === needle.length) return 1
  }

  return 0
}

// ══ 状态行（左半四格次序恒定 ＋ 右位独立）════════════════════════════

/** 五态固定词（原型 · 状态行规格）——**量挂在状态后面**。 */
export type StatusState = 'idle' | 'working' | 'waiting' | 'retrying' | 'error'

/** 空闲态右位提示。 */
export const HINT_IDLE = '/ 命令 · ctrl+c 退出'
/** 工作中右位提示。 */
export const HINT_WORKING = 'ctrl+c 中断'
/** 退避中右位提示（后段动态：`1.6s 后重发 · 不用管`）。 */
export const HINT_RETRYING_TAIL = '后重发 · 不用管'
/** 裁决态右位提示（必闸类没有 `a`）。 */
export const HINT_DECIDE_LIGHT = 'y / a / n'
export const HINT_DECIDE_HEAVY = 'y / n'
/**
 * **启动中**右位提示（U25 · 技术方案 · 装配视图第 5 步：「以 `boot` 完成为界」）。
 *
 * 订阅接上 ≠ 可以干活：`boot`（装载 ＋ 恢复）要跑完才受理输入——反了就是
 * 「用户能在恢复跑完前打字」。打字照旧进草稿（本地的事），**回车不受理**。
 */
export const HINT_BOOTING = '启动中——恢复跑完才受理输入'
/** 选择器右位提示。 */
export const HINT_PICKER = '↑↓ 选 · 回车 定 · esc 收起'
/**
 * **纯读那一屏**的右位提示（`/mcp`）——没有「选定」这回事，故不报「回车 定」。
 *
 * 由头：键位提示得**对得上键位**。`/mcp` 的抽屉里回车什么都不做（重连是另一条命令，
 * 明写 `/mcp reconnect <名字>`），照抄 `HINT_PICKER` 就是教用户按一个没有用的键。
 */
export const HINT_PICKER_READ = '↑↓ 选 · esc 收起'
/** 自动补全右位提示（原型 · 场景 11）。 */
export const HINT_COMPLETION = '↑↓ 选 · Tab 补全 · esc 收起'
/**
 * 本地小输入的右位提示（U41）——这一屏能做的就两件：回车交出去、`esc` 收回。
 *
 * ⚠️ 与上面那几条**分开一句**是有由头的：那几句里都有「↑↓ 选」，而这一屏没有「选」
 * 这回事（它就是一行字）——照抄一句带「↑↓」的提示，就是教用户按一个没有用的键。
 */
export const HINT_PROMPT = '回车 确定 · esc 取消'

export type ShellStatus = {
  readonly state: StatusState
  /** 挂状态后面的量：耗时 / 第几件 / 第几次（`● 工作中 0.6s` · `● 等你定夺 2/3`）。 */
  readonly amount: string | null
  /** ② 会话——**标题**（还没有会话时 `null`，屏上显示「新会话」）。 */
  readonly session: string | null
  /** ③ 模型——模型名（条目名在 `/model` 的列表里示人）。 */
  readonly model: string | null
  /**
   * ④ 用量——已用 token（输入侧）。
   * 原型写 `3.1k/200k`；`model.usage` 只给**已用量**，窗总量得另有来处。
   */
  readonly usage: number | null
  /**
   * ④ 的**分母**——上下文窗总量（U20 · 差距 5：用量要显示成 `12.4k/200k`）。
   *
   * ⚠️ **这一格是给 `D10` 留的位**：内核侧的出口（配置 / 注册表 / 事件）**还没合入**，
   * 故此刻一律 `null` ⇒ 屏上**只报已用量**（`12.4k`）。**不编一个 200k 出来**——
   * 「拿不到的不编」是项目反复立的规矩（`D10` 那三条读数、状态行的「工作中」耗时都栽在这上面）。
   * 出口合入后，`createShell` 的 `contextWindow` 一接即上屏（渲染那半已经写好并有用例）。
   */
  readonly window: number | null
  /** 右位提示——**独立一栏，出现/消失不推动左半**。 */
  readonly hint: string
}

// ══ 一屏 ═════════════════════════════════════════════════════════════

/**
 * **窗长表**（U30）——给外壳的那张，装配递进来（`Assembly.windowTable`）。
 *
 * ⚠️ **形态与 `@magic/model` 的 `WindowTable` 逐字相同**（两份声明）：外壳只依赖
 * `@magic/contracts`（域不认知外壳、外壳也不认知域），认不得模型域那个类型——故形态在
 * 这儿照写一份，靠**结构类型**在两处赋值点（`tuiOptions` 返回、`runTui` 转发）卡住：
 * 形状一散，那两处当场编译不过。
 *
 * - `builtin`——**准确的模型 id** → 窗长（模型的客观属性，与条目无关）；
 * - `declared`——条目 id → `{ 它声明的模型, 那个数 }`：**只属于配置它的条目及对应模型**。
 */
export type WindowTable = {
  readonly builtin: Readonly<Record<string, number>>
  readonly declared: Readonly<Record<string, { readonly model: string; readonly window: number }>>
}

/**
 * 接管期间收着的东西——**草稿 ＋ 它的插入点 ＋ 它绑着的技能**（一起收、一起还，见
 * `ShellView.stashed`）。
 *
 * 三件同为「那份草稿的一部分」：正文是打的字、插入点是打到哪儿、技能是随它一起发出去的
 * 材料。接管（裁决）是**不经过用户**的一段，归还时少一件就是把用户的草稿改掉了一半
 * （终端交互：「选择、查询与审批保护整份草稿（正文、技能、附件、光标/选区）」）。
 */
export type Stashed = {
  readonly draft: string
  /** 收起来那一刻的插入点（`draft` 的下标）——归还时**原样**放回去，不摆到末尾。 */
  readonly caret: number
  /**
   * 收起来那一刻草稿上的引用（与正文同生共死）。
   *
   * 设计明写「选择、查询与审批保护整份草稿（正文、技能、附件、光标/选区）」——
   * 引用是那份草稿的一部分，少收一样就是归还时把用户那句话改掉了一半。
   */
  readonly refs: readonly DraftRef[]
}

/** 一屏的全部状态（记录区 ＋ 左下交互区 ＋ 状态行）。 */
export type ShellView = {
  /** **本轮**的行——还在流式、还会变（活动区就地重绘）。 */
  readonly rows: readonly LogRow[]
  /**
   * **已定局**的行（上一轮及更早）——写进 `<Static>` 一次，此后不重绘：
   * 它们落进终端 scrollback（滚动与复制归终端 ✓），也是 D11 的结构性护栏。
   */
  readonly settled: readonly LogRow[]
  /** 输入行的**候选**（D12）——不在补全里就是 `null`。 */
  readonly completion: CompletionState | null
  readonly status: ShellStatus
  readonly dock: Dock
  /** 输入草稿——**归模型**（接管时收进 `stashed`，答完原样归还）。 */
  readonly draft: string
  /**
   * **插入点**（U31）——`draft` 里的下标（UTF-16 码元，与 `slice` 同尺；**落在字素边界上**）。
   *
   * 唯一的「光标在哪」：真终端光标由它算出来（`composer.ts`），**不再另存一套坐标**。
   * 改动草稿的每一条路都要同步它（打字 / 退格 / 删除 / 粘贴 / 换行 / 清空 / 提交 /
   * 历史召回 / 补全 / 接管收起与归还）——`shell.ts` 里走 `edit` 那一处收口。
   */
  readonly caret: number
  /**
   * 接管期间**收起来的草稿**（`null` ＝ 没收着）。
   *
   * ⚠️ **连插入点一起收**（返工轮 · 2026-09-20 首轮验收退回②）：接管不经过用户，
   * 而草稿与它的插入点是**同一件事**（「我刚才在哪儿打」）——只收文字、归还时一律摆到末尾，
   * 等于把用户打到一半的位置改掉。故两件装在一个值里：**收一起收、还一起还**。
   * 装一个字段还有一层：`stashed !== null` 就是「已经收着了」那个判据（多件裁决只收一次）。
   */
  readonly stashed: Stashed | null
  /**
   * **草稿上的引用**（U36）——正文里那几处（`@src/login.ts` / `/review`）的**位置与身份**。
   *
   * 它是「引用留在交代的位置」在外壳这一侧的落点：文字在 `draft` 里（用户看得见、打得动），
   * 身份（真路径）在这里。两件**同生共死**——删掉正文里那一段，这里的那一处跟着没
   * （见 `inline.ts` 的编辑规则），故**不存在「正文删了、材料还在」的暗带**。
   *
   * ⚠️ **U33 的 `bound`（一个全局「当前技能」）已删除**：它正是「重复草稿状态」——
   * 技能既在正文里（`/review` 那几个字）又在旁边挂着一份，两处各说各的。现在只有一处
   * 真源，`/skills` 与 `@` 都只是**往正文里插一段带身份的文字**。
   */
  readonly refs: readonly DraftRef[]
  /** 接管期间「不静默吞键」的提示（一次性，按下一个键即清）。 */
  readonly flash: string | null
  /** `ctrl+o` 展开（思考与老工具调用默认折一行）。 */
  readonly expanded: boolean
  /** 当前会话 id（还没有会话＝`null`）。 */
  readonly sessionId: SessionId | null
  /** 会话目录（`session.list` 的答复）。 */
  readonly catalog: readonly SessionSummary[]
  /**
   * **授权名录**（`grants.catalog` 的答复 · U22）——`/grants` 抽屉的取材。
   *
   * 与 `catalog` / `models` 并列的第三张表：**拿到过就有**，没问过是 `null`
   * （「拿不到的不编」——空名录与「还没问过」不是一回事，抽屉等答复才开）。
   */
  readonly grants: GrantsCatalog | null
  /**
   * **技能目录**（`skills.catalog` 的答复 · U33）——两处取材：
   * `/skills` 的选择器铺行；**输入行的候选**（打 `/` 之后按名筛）。
   *
   * 与 `grants` 同一条：**拿到过就有**，没问过是 `null`（「拿不到的不编」——空目录与
   * 「还没问过」不是一回事）。技能是随用户编辑变的目录，故它**只当一帧的快照用**：
   * 每按一次 `/skills` 现问一次（见 `shell.ts`），不拿它当「有哪些技能」的长期真源。
   */
  readonly skills: SkillsCatalog | null
  /**
   * **路径候选**（`paths.catalog` 的答复 · U36）——`@` 那一栏的取材。
   *
   * 与 `skills` / `grants` 同一条：**拿到过就有**，没问过是 `null`。它说的是**最后一次
   * 问的那一段**（答复带回 `query`，外壳拿它对上自己正在打的那一段——边打边问，答复可能后到）。
   */
  readonly paths: PathsCatalog | null
  /**
   * **外部服务器的一屏**（`mcp.catalog` 的答复 · U39）——`/mcp` 选择器的取材。
   *
   * 与 `grants` / `skills` 同一条：**拿到过就有**，没问过是 `null`（「拿不到的不编」——
   * 「一台都没配」与「还没问过」不是一回事，抽屉等答复才开）。读数随连接变，
   * 故它只当**一帧的快照**用：每按一次 `/mcp` 现问一次。
   */
  readonly mcp: McpCatalog | null
  /**
   * **连接一览**（`model.catalog` / `provider.catalog` 的答复）——`/model` 与 `/model manage`
   * 两屏的取材（同一份行，内核那边就是一处产出）。
   *
   * ⚠️ 与 `catalog` 分开：那个是**会话**目录（`SessionSummary`）——同名不同物，别合。
   */
  readonly models: readonly ModelCatalogRow[]
  /**
   * **内置供应商与官方区域**（U41 返修）——`provider.catalog` 答复里那一格。
   *
   * 没问过 / 那一格没来 ⇒ 空数组（「拿不到的不编」）：接入那一步那时就没得挑，
   * 界面**如实说一句**，不拿壳里的常量顶上。
   */
  readonly vendors: readonly VendorInfo[]
  /**
   * **此刻会走哪一条**（`model.catalog` 的 `current`）——「正在用」那一格标在谁头上。
   *
   * ⚠️ **可以没有**（`null`）：还没选过模型的新连接、或一条连接都没有时**没有去向**——
   * 那时**一行都不标当前**（设计明文：不取列表第一项顶上）。原先这格取自
   * `status.model`（真跑过才有的那一格），U41 起改读答复里的 `current`：它说的是
   * 「**此刻**会走哪一条」，包含「换过但还没调用过」那种（那才是选择器该标的）。
   */
  readonly modelCurrent: ModelRef | null
  /**
   * **窗长表**（U30）——换模型之后 ④ 的分母的取材（形态见 `WindowTable`）。
   *
   * 由装配给（`Assembly.windowTable`），**在壳外不动**：`model.switched` /
   * `model.call.start` 一到，就按**那一刻的选中**（条目 ＋ 模型两件）查——
   * 查得到就换分母，查不到＝`null`（**不沿用前一个模型的容量**）。
   *
   * `null` ＝**没有这张表**（调用方没给）：那时**一个数都不改**——分母照旧只认
   * 开机那一格与 `model.catalog` 的答复（见 `withModelWindow`）。
   */
  readonly windowTable: WindowTable | null
  /** 本轮已出现的工具调用数（多件裁决报 `n/m` 的取材——只数本轮）。 */
  readonly turnTools: number
  /**
   * **当前计划**（U34）——步骤清单与辅助笔记那一份（投影见 `PlanProjection`）。
   *
   * 它**不是**外壳自己攒的账：内容只有两个来处——**已提交的记录**（重建时从条目里取）
   * 与**瞬时事件 `plan.changed`**（那一条也是「条目已经落账」之后才发的）。外壳既不
   * 从显示文案里猜，也不另存一份进度。
   *
   * 缺席＝`{entry: null, plan: null}`：**没有计划**（不占位、不强制生成）。
   */
  readonly plan: PlanProjection
  /**
   * **清单收起没有**（U34 · `Ctrl T`）——**本地视图**：不落库、不进上下文、不发模型请求
   * （设计：默认展开，`Ctrl T` 收起/展开**只改本地视图**）。
   */
  readonly planCollapsed: boolean
  /**
   * **清单行视口的第一行**（U34）——**本地**滚动位置，同上不落库。
   *
   * ⚠️ **只夹下界（≥0），上界留给渲染层**：一份清单总共折成几行、屏上放得下几行，
   * 只有渲染那一层量得出（列数与终端高度都在那儿）。故这儿存的是「想去第几行」，
   * 画的时候由 `planWindow` 夹回范围（计划变短、窗口变小都不会把视口留在半空）。
   */
  readonly planTop: number
  /**
   * 回显过几条用户消息（**单调递增**，只给 React 的 key 用）。
   *
   * 由头（U24 顺带查出 · 本轮收）：用户行的 key 原先是 `user.echo:${rows.length}`——
   * 而一轮收束后 `rows` 清进 `settled`，下一条回显**又拿到同一个数** ⇒ 同一个列表里
   * 两个同 key（React 报 `Encountered two children with the same key`）。同 key 的后果是
   * **子节点重复或丢失**——那正是「显示」这一摊的账，故记在视图里、随视图走。
   */
  readonly echoes: number
}

/** 空视图。 */
export function createView(): ShellView {
  return {
    rows: [],
    settled: [],
    completion: null,
    status: {
      state: 'idle',
      amount: null,
      session: null,
      model: null,
      usage: null,
      window: null,
      hint: HINT_IDLE,
    },
    dock: { kind: 'input' },
    draft: '',
    caret: 0,
    refs: [],
    stashed: null,
    flash: null,
    expanded: false,
    sessionId: null,
    catalog: [],
    skills: null,
    paths: null,
    mcp: null,
    models: [],
    vendors: [],
    modelCurrent: null,
    windowTable: null,
    grants: null,
    turnTools: 0,
    // **没有计划**（不占位）· 默认展开（设计）· 视口从头开始
    plan: { entry: null, plan: null },
    planCollapsed: false,
    planTop: 0,
    echoes: 0,
  }
}

/** 授权名录（`grants.catalog` 的载荷 · U22）——抽屉与那一行度量都读它。 */
export type GrantsCatalog = EventDataOf['grants.catalog']

/** 技能目录（`skills.catalog` 的载荷 · U33）——选择器与输入行的候选都读它。 */
export type SkillsCatalog = EventDataOf['skills.catalog']

/** 路径候选（`paths.catalog` 的载荷 · U36）——`@` 那一栏的取材（只回答「有哪几条」）。 */
export type PathsCatalog = EventDataOf['paths.catalog']

/** 外部服务器的一屏（`mcp.catalog` 的载荷 · U39）——`/mcp` 选择器的取材。 */
export type McpCatalog = EventDataOf['mcp.catalog']

// ══ 归约（事件 → 一屏）═══════════════════════════════════════════════

/** 归约一步：`event → 新视图`（纯函数——不改动入参）。 */
export function reduce(view: ShellView, event: KernelEvent): ShellView {
  switch (event.kind) {
    case 'model.delta':
      return reduceDelta(view, event.id, event.data)

    case 'tool.call':
      return reduceToolCall(view, event.id, event.data, event.at)
    case 'tool.output.delta':
      return reduceToolOutput(view, event.data)
    case 'tool.result':
      return reduceToolResult(view, event.data, event.at)
    case 'tool.decision.request':
      return reduceDecision(view, event.id, event.data)
    case 'tool.decision':
      return reduceVerdict(view, event.data)

    case 'message.user':
      return reduceUserEntry(view)
    case 'message.assistant':
      return view

    case 'turn.start':
      return patchStatus({ ...clearFlash(view), turnTools: 0 }, {
        state: 'working',
        amount: null,
        hint: HINT_WORKING,
      })
    case 'turn.end':
      // 轮收束 ⇒ ① 悬着的裁决作废（那件工具跑不成了）：**撤卡 ＋ 归还草稿**；
      //           ② 本轮的**行定局**——交给 `Static` 写一次，此后不再重绘（D11 护栏）
      return patchStatus(settle(undock(view)), {
        state: event.data.reason === 'error' ? 'error' : 'idle',
        amount: null,
        hint: HINT_IDLE,
      })

    case 'agent.state':
    case 'agent.start':
    case 'agent.end':
      return view

    case 'model.call.start':
      // 「这次**真用了**谁」——分母与它同刻对齐（U30：查表；真跑用的那个模型名才是准的，
      // 空手打开时就 `/model` 换过的那种也由此走上正轨——那时内核不发 `model.switched`）
      return withModelWindow(view, { provider: event.data.provider, model: event.data.model })
    case 'model.usage':
      return patchStatus(view, { usage: event.data.inputTokens })
    case 'model.call.end':
      return view
    case 'model.retry':
      return patchStatus(view, {
        state: 'retrying',
        amount: `${event.data.attempt}/${RETRY_MAX}`,
        hint: `${secondsLabel(event.data.delayMs)}${HINT_RETRYING_TAIL}`,
      })

    // 路径候选回来了（U36）——只把它落进视图（`view.paths`）：**怎么用是外壳那一层的
    // 口径**（`@` 那一栏正开着才铺行，见 `shell.ts` 的 `onEvent`），与 `skills.catalog`
    // 同一条分工（`reduce` 只落数据、不判断此刻该开什么）。
    case 'paths.catalog':
      return { ...view, paths: event.data }

    case 'model.switched':
      // 一次性的事**进记录区当回执**（状态行只放「此刻」）；成了顺手更新 ③ **和 ④ 的分母**
      // （U30：换过去那一刻分母就得跟着走——新模型多长查表；查不到＝`null`，
      // **不沿用换之前那个模型的容量**）。**没换成＝原样不动**（切不动就不动，
      // 读数与选中一样保持现状——那正是「切不动」该有的样子）。
      return appendReceipt(
        event.data.ok && event.data.model !== undefined
          ? withModelWindow(view, { provider: event.data.provider, model: event.data.model })
          : view,
        event.data.ok
          ? `已换模型 → ${event.data.model ?? '？'}`
          : `换模型未成：${event.data.reason ?? '未说缘由'}`,
      )

    // 模型条目表（读侧答复 · 缺陷 D10 第 3 样）——**出口在这条链上的落点**，两件：
    // ① 收进视图 ⇒ `/model` 的选择器列**全量**（含从未调用过的条目）；
    // ② 把 ④ 的**分母**定下来——**当前那条**声明的窗总量（没声明就是 `null`，不编）。
    case 'model.catalog':
      return {
        ...view,
        models: event.data.entries,
        // **此刻会走哪一条**——答复说没有（还没选过模型）就落回 `null`：不沿用上一条，
        // 也不拿列表首项顶上（那不是「此刻在用的」，是个编出来的事实）
        modelCurrent: event.data.current ?? null,
        status: { ...view.status, window: windowOfCatalog(view, event.data) },
      }

    // 供应商管理面的一屏（U41）——**收进视图**：与 `model.catalog` **同一份行**
    //（同一批连接的两个读面，内核那边就是一处产出，见 `catalogRows`），故落在同一格：
    // 开 / 关与回执是外壳的事（`shell.ts`），此处只落数据。
    case 'provider.catalog':
      return {
        ...view,
        models: event.data.entries,
        // 内置供应商与官方区域——名单随答复来、**不落壳里**（适配现取，契约的 `VendorInfo`）
        vendors: event.data.vendors,
      }


    // 授权名录（读侧答复 · U22）——**收进视图**：抽屉据它铺行，那一行度量据它算；
    // 开抽屉 / 刷新 / 留回执是外壳的事（`shell.ts` 的 `onEvent`），此处只落数据
    // （照 `model.catalog` 的姿势：归约落数据，处置归外壳）
    case 'grants.catalog':
      return { ...view, grants: event.data }

    // 技能目录（读侧答复 · U33）——**收进视图**（输入行的候选与 `/skills` 的选择器都读它）；
    // 开选择器 / 铺行是外壳的事（`shell.ts` 的 `onEvent`），此处只落数据
    // （照 `model.catalog` / `grants.catalog` 的姿势：归约落数据，处置归外壳）
    case 'skills.catalog':
      return { ...view, skills: event.data }

    // 外部服务器一屏（读侧答复 · U39）——**收进视图**（`/mcp` 的选择器据它铺行）；
    // 开抽屉 / 重连之后刷新是外壳的事（`shell.ts` 的 `onEvent`），此处只落数据
    case 'mcp.catalog':
      return { ...view, mcp: event.data }

    // 计划那一份落账之后发的瞬时事件（U34）——**落进视图的唯一实时来路**。
    // 「新旧」由 `withPlan` 一处判（历史晚到不能覆盖更新或清空）。
    //
    // **会话隔离**：信封不是当前这条会话的一律丢——换会话之后，旧会话那条流上**晚到**的
    // 更新 / 清空不许串进新会话（工单：「换会话先移除旧清单，不能短暂串到新会话」）。
    // 判据与 `shell.ts` 的 `accumulate`（历史分块）**同一条**：还没认到会话时（`null`）
    // 一律先收下，认得了才按信封挑。
    case 'plan.changed':
      if (view.sessionId !== null && event.session !== view.sessionId) return view

      return withPlan(view, event.data.entry, event.data.plan)

    case 'session.state':
      return reduceSessionState(view, event.data)

    // 读面答复——**攒与重建归外壳**（`shell.ts` 里按块收，收齐了调 `rebuild`）；
    // 归约这层收到它就丢（它不逐条进记录区）
    case 'session.history':
      return view

    // 技能使用回执（U33）——**主文确实进了本次上下文**之后内核才发这一条
    // （见契约 `skill.used`）：故它到了＝这件事成了，回执照说。
    // 一行一项，措辞与内核给的来源标签一致（`label` 由内核产出，外壳照印——
    // 恢复时也一样，见条目载荷里那一栏）。
    case 'skill.used':
      return appendReceipt(
        view,
        `本次使用技能：${event.data.skills.map((one) => `${one.name}（来源 ${one.label}）`).join(' · ')}`,
      )

    // 提交的收场（U33）——**只有「没跑」那一格进记录区**：收下了的那一条不必报
    // （同一件事 `turn.start` 的「正在干活」已经在说，再补一句就是每提交一次添一行噪声）。
    // 没跑的那一条**必须出声**：这一条交代一个字都没发出去，用户得知道为什么。
    case 'input.settled':
      return event.data.ok ? view : appendReceipt(view, `没送出：${event.data.reason ?? '未说缘由'}`)

    case 'model.error':
      return patchStatus(
        appendReceipt(view, `模型错误（${tierLabel(event.data.tier)}）：${event.data.message}`),
        { state: 'error', amount: null, hint: HINT_IDLE },
      )
    case 'error':
      return patchStatus(appendReceipt(view, `内核异常：${event.data.message}`), {
        state: 'error',
        amount: null,
        hint: HINT_IDLE,
      })

    case 'context.compacted':
      return view

    default:
      return assertNever(event)
  }
}

/**
 * 退避重试的档数（状态行报 `n/m` 的 `m`）——**外壳侧的常量**：
 * `model.retry` 只载 `attempt`，策略里的上限不出模型域（见回报「与原型不符」）。
 */
const RETRY_MAX = 3

// —— 各分支实现 ——

type DeltaData = Extract<KernelEvent, { kind: 'model.delta' }>['data']

function reduceDelta(view: ShellView, id: RecordId, data: DeltaData): ShellView {
  if (data.channel === 'text') return appendText(view, id, 'assistant', data.text)
  if (data.channel === 'thinking') return appendText(view, id, 'thinking', data.text)

  return appendToolFragment(view, id, data.name, data.id, data.text)
}

/** 正文 / 思考——落到末尾同类行上（交替出现即分块）。 */
function appendText(view: ShellView, id: RecordId, kind: 'assistant' | 'thinking', text: string): ShellView {
  const last = view.rows[view.rows.length - 1]
  if (last?.kind === kind) return replaceLast(view, { ...last, text: last.text + text })

  return appendRow(view, { kind, key: `${kind}:${id}`, text })
}

/** 工具调用增量——按供应商侧调用 id 分组；无 id 时并进最老的未配对工具行。 */
function appendToolFragment(
  view: ShellView,
  id: RecordId,
  name: string | undefined,
  providerId: string | undefined,
  text: string,
): ShellView {
  const target =
    providerId === undefined
      ? findToolIndex(view, (row) => row.call === null)
      : findToolIndex(view, (row) => row.key === `tool:tc:${providerId}`)

  if (target === -1) {
    return countTool(
      appendRow(view, {
        kind: 'tool',
        key: `tool:${providerId === undefined ? `d${id}` : `tc:${providerId}`}`,
        call: null,
        name: name === undefined ? '工具' : toolNameOf(name),
        argsText: text,
        args: null, // 流式片段不全——结构化那份要等 `tool.call`
        state: 'running',
        elapsedMs: null,
        startedAt: null,
        output: [],
        // 名字这就认得出时先收着（后面 `tool.call` 还会再认一次——两条路都要有）
        ...(name !== undefined && quietTool(name) ? { quiet: true as const } : {}),
      }),
    )
  }

  return patchTool(view, target, (row) => ({
    ...row,
    name: name === undefined ? row.name : toolNameOf(name),
    argsText: row.argsText + text,
  }))
}

type ToolCallData = Extract<KernelEvent, { kind: 'tool.call' }>['data']

/** `tool.call`——认领最老的未配对工具行（流式前情）；没有则自建。 */
function reduceToolCall(view: ShellView, id: RecordId, data: ToolCallData, at: number): ShellView {
  const target = findToolIndex(view, (row) => row.call === null)

  if (target === -1) {
    return countTool(
      appendRow(view, {
        kind: 'tool',
        key: `tool:call:${id}`,
        call: id,
        name: toolNameOf(data.name),
        argsText: argsJson(data.args),
        args: data.args,
        state: 'running',
        elapsedMs: null,
        // **发起时刻就在这条事件上**（`at`）——不取它，屏上就报不出「跑到第几秒」，
        // 落地后也算不出这次调用花了多久（跑动中的 `⟳ 1.4s` 与落地后的 `✓ 0.2s · …`
        // 都要它）。流式先建行的那条路（下面那个分支）一直有，这一支原先漏了。
        startedAt: at,
        output: [],
        ...(quietTool(data.name) ? { quiet: true as const } : {}),
      }),
    )
  }

  return patchTool(view, target, (row) => ({
    ...row,
    name: toolNameOf(data.name),
    call: id,
    argsText: argsJson(data.args),
    args: data.args,
    // 发起时刻：**事件自带 `at`**（域不各自取时钟，外壳只做差）
    startedAt: row.startedAt ?? at,
    // 「不必上屏」在这儿认（`tool.call` 一定带着注册名：流式那几个片段可能还没认出来）
    ...(quietTool(data.name) ? { quiet: true as const } : {}),
  }))
}

type ToolOutputData = Extract<KernelEvent, { kind: 'tool.output.delta' }>['data']

/** 执行输出增量——按行攒（末行继续接），等价于「流式 append」。 */
function reduceToolOutput(view: ShellView, data: ToolOutputData): ShellView {
  const target = indexOfCall(view, data.call)
  if (target === -1) return view

  return patchTool(view, target, (row) => ({ ...row, output: appendText2(row.output, data.text) }))
}

type ToolResultData = Extract<KernelEvent, { kind: 'tool.result' }>['data']

function reduceToolResult(view: ShellView, data: ToolResultData, at: number): ShellView {
  const target = indexOfCall(view, data.call)
  if (target === -1) return view

  const text = 'text' in data.output ? data.output.text : `（大块转存 ${data.output.blob}）`
  // **「这一笔没跑」是结果自己带的一位**（`notExecuted`，产生处写：`@magic/conversation`
  // 的 `withholds`）——不从正文里认字眼（2026-09-20 三轮裁，改的正是二轮那条正文协议：
  // 真跑失败、输出首行恰是「未执行后续步骤」时它会认错，把一次真写盘的调用画成没跑）。
  const unexecuted = data.notExecuted === true

  return patchTool(view, target, (row) => ({
    ...row,
    // **被拒是终态**：那件工具压根没跑，结果只是把话说全（「未获批准，未执行」）——
    // 不让它被降级成「失败」（两者含义不同：一个是没跑，一个是跑了没成）。
    // **扣下那一路同上**：也没跑，故单列一态——省得那行画成一次失败的耗时。
    state: row.state === 'rejected' ? 'rejected' : unexecuted ? 'unexecuted' : data.ok ? 'ok' : 'failed',
    output: textOfLines(text),
    // 墙钟＝发起 → 落地（`tool.call` 的 `at` → 这条 `tool.result` 的 `at`）。
    // **倒退的钟当没量到**（`null`）：负数上屏就是报了个假的耗时——如实记＝没有就是没有。
    // **没跑的那一笔根本没有「耗了多久」这回事**（拦截发生在动手之前，两个事件背靠背发出）：
    // 那个差是实现的偶然，不是这次调用的账，故一律 `null`。
    elapsedMs:
      unexecuted || row.startedAt === null || at < row.startedAt ? null : at - row.startedAt,
  }))
}

type VerdictData = Extract<KernelEvent, { kind: 'tool.decision' }>['data']

function reduceVerdict(view: ShellView, data: VerdictData): ShellView {
  const target = indexOfCall(view, data.call)
  const rows =
    target === -1
      ? view.rows
      : view.rows.map((row, index) =>
          index === target && row.kind === 'tool'
            ? {
                ...row,
                // 裁决的耗时（提示 → 答复）**不进工具行**——那是裁决的账（见行上 `elapsedMs` 的注）
                ...(data.decision === 'reject' ? { state: 'rejected' as const } : {}),
              }
            : row,
        )

  // 裁决落定 ⇒ 接管解除、**草稿归还**（多件时下一件会重新接管，草稿再收一次）
  const answered = undock({ ...view, rows })
  if (view.dock.kind !== 'decision') return answered

  // 答完之后**球在内核那边**——这一轮还在跑（工具要跑、模型要继续）。
  // 状态行得说回「工作中」：不归位它就停在「等你定夺」上，而那一刻**已经不是**那个状态了
  // （「状态行只放此刻」——第 23 轮真跑留帧时当场看出来的：卡收了、桌下却在说「等你定夺」）。
  return patchStatus(answered, { state: 'working', amount: null, hint: HINT_WORKING })
}

type DecisionRequestData = Extract<KernelEvent, { kind: 'tool.decision.request' }>['data']

/** `tool.decision.request`——挂上裁决（**接管输入框**）。件数从本轮的工具有几条推。 */
function reduceDecision(view: ShellView, id: RecordId, data: DecisionRequestData): ShellView {
  const position =
    view.turnTools <= 1 ? null : { index: toolIndex(view, data.call), total: view.turnTools }

  const pending: ShellView = {
    ...view,
    dock: {
      kind: 'decision',
      pending: {
        id,
        call: data.call,
        name: data.name,
        material: data.material,
        weight: data.weight,
        // 外部操作（U38）——只在真为外部时带键（缺席可辨：内置工具一字不动）
        ...(data.external === true ? { external: true } : {}),
        position,
      },
    },
  }

  return withDecisionStatus(takeOver(pending))
}

type SessionStateData = Extract<KernelEvent, { kind: 'session.state' }>['data']

/** `session.state`——目录 ＋ 当前会话。**换了会话＝记录区交给重建**（缺陷 D1）。 */
function reduceSessionState(view: ShellView, data: SessionStateData): ShellView {
  const switched = view.sessionId !== null && view.sessionId !== data.active
  const title = data.sessions.find((row) => row.id === data.active)?.title ?? null

  const base: ShellView = {
    ...view,
    sessionId: data.active,
    catalog: data.sessions,
    status: { ...view.status, session: title },
  }

  // 换了会话 ⇒ 记录区清空重来。**字标照旧在最前面**（`bannerFirst`）：
  // 它属于「记录区」而不是「哪一条会话」——切走一条就没有它，屏上会像是掉了块东西
  // （何况 `AppView` 的 `Static` 按会话换 key，切过去本就等于重开一页）。
  //
  // **计划那一块同一条**（U34）：换会话**先移除旧清单**（设计：不能短暂串到新会话）——
  // 新会话的那一份由随后读回来的历史（`rebuild`）重铺。收起的位与视口也归零：
  // 每一条会话都从「默认展开、从头看」开始。
  return switched
    ? { ...base, rows: [], settled: bannerFirst([]), plan: { entry: null, plan: null }, planCollapsed: false, planTop: 0 }
    : base
}

/**
 * `message.user`——配平本地回显（`entry` 是条目引用；屏上已有回显那一行，不必再用它）。
 * 配不上（重建 / 恢复场景）**不编一行出来**——重建走 `rebuild`，不靠这条事件。
 */
function reduceUserEntry(view: ShellView): ShellView {
  const target = view.rows.findIndex((row) => row.kind === 'user' && row.echoed)
  if (target === -1) return view

  return replaceAt(view, target, (row) => (row.kind === 'user' ? { ...row, echoed: false } : row))
}

/** 本轮的行 → 定局（`Static` 写一次即入 scrollback）。 */
export function settle(view: ShellView): ShellView {
  if (view.rows.length === 0) return view

  // ⚠️ **一行都不摘**（U34 返修：「默认不画」不许在这里变成「丢掉」）——安静的那几个工具
  // 行照旧进 `settled`（记录区里它在，展开之后看得见），画不画是渲染那一处的事
  // （`components/log.ts` 按 `quiet` ＋ `expanded` 判）。在这儿滤掉＝那一行**永久不可查**。
  return { ...view, settled: [...view.settled, ...view.rows], rows: [] }
}

// ══ 写入口（外壳用）══════════════════════════════════════════════════

/** 字标那一行的 key——**一屏只有一行**（记录区最前面那一块，不会来第二次）。 */
const BANNER_KEY = 'banner'

/** 字标那一行（渲染层按当时列数挑版，见 `LogRow` 里那一支的注）。 */
function bannerRow(): LogRow {
  return { kind: 'banner', key: BANNER_KEY }
}

/**
 * 记录区 → **带上字标**的形态：字标**恒在最前、且恒只一行**。
 *
 * 为什么要有这一处收口：`settled` 只在**追加**的两处（`settle` / `appendSettled`）天然保得住
 * 最前面那一行，而**整块换掉** `settled` 的两处——外壳开局（`withBanner`）、
 * 换会话（`reduceSessionState`）——各经一次本函数，就不必靠「记得别把它弄丢」。
 *
 * ⚠️ **本函数＝「开一页」**：它**种一条新的字标**，而字标那一行的**对象身份就是页的身份**
 * （渲染层据此认换页，见 `components/app.ts` 的 `pageOf`）。故**「填一页」的地方不归它管**——
 * 历史回来铺内容走 `pageHeaderOf`（`rebuild` 用），拿的是**这一页已有的那一条**，
 * 对象不变＝不换页。两处都开新页，屏上就多出字标（U29 验收：甲→乙一次切换印 4 份）。
 *
 * 幂等：先把已有的字标滤掉再放一个，故重复调用不会攒出两行。
 */
function bannerFirst(rows: readonly LogRow[]): readonly LogRow[] {
  return [bannerRow(), ...rows.filter((row) => row.kind !== 'banner')]
}

/**
 * 这一页的**页头**（字标那一行）——`settled[0]` 是它就**照用本尊**（**对象不变＝不换页**），
 * 没有才种一条新的。
 *
 * 与 `bannerFirst` 的分工就是「填」与「开」：`rebuild`（历史回来铺内容）走这一条。
 */
function pageHeaderOf(view: ShellView): LogRow {
  const first = view.settled[0]

  return first !== undefined && first.kind === 'banner' ? first : bannerRow()
}

/**
 * **印一次字标**（外壳开局调，见 `createShell`）——记录区最前面那一块。
 *
 * 只在外壳开局这一处种：`createView` 仍是「空视图」（`record.ts` 的标本、
 * 纯归约的用例都直接拿它当起点，那里没有「启动」这回事）。
 */
export function withBanner(view: ShellView): ShellView {
  return { ...view, settled: bannerFirst(view.settled) }
}

/** 本地回显一次用户输入（提交时立即显示——事件里没有正文）。 */
export function appendEcho(view: ShellView, text: string): ShellView {
  // key 用**单调计数**而不是 `rows.length`——后者在收束清空之后会**撞回同一个数**
  // （同一个列表里两个同 key ⇒ React 说「子节点可能重复或丢失」）。见 `ShellView.echoes`。
  return {
    ...appendRow(view, { kind: 'user', key: `user.echo:${view.echoes}`, text, echoed: true }),
    echoes: view.echoes + 1,
  }
}

/**
 * 一行**回执**（`·`）——一次性的事。**不落库、不重建**。
 *
 * ⚠️ 回执进的是 `settled`（已定局那一侧）——它即刻可见、**不该被重绘**：
 * 活动区只放还在变的东西（D11 的护栏），回执写完就归 scrollback。
 */
export function appendReceipt(view: ShellView, text: string): ShellView {
  return appendSettled(view, { kind: 'receipt', key: `recpt:${view.settled.length}`, text })
}

/** 一块**命令输出**（dim 块，无标记）。**不落库、不重建**（同回执，进定局那侧）。 */
export function appendOutput(view: ShellView, title: string, lines: readonly string[]): ShellView {
  return appendSettled(view, { kind: 'output', key: `out:${view.settled.length}`, lines: [title, ...lines] })
}

/**
 * ④ 的分母**开机那一格**的入口（U20 · 差距 5 的位）——见 `ShellStatus.window`。
 *
 * `D10` 的出口（内核侧给上下文窗总量）一处是它：装配把**当下那一条的**数递给它即可，
 * 渲染那一半（`12.4k/200k` 的排版与窄窗降级）已经写好并有用例。
 * 拿不到就传 `null` ⇒ 屏上只报已用量——**不编一个总量**。
 *
 * ⚠️ **开机之后**的分母不走这儿（U30）：那时是**换模型**在改它，取材是那次选中
 * ——见 `withWindowTable` 与 `withModelWindow`。
 */
export function withContextWindow(view: ShellView, window: number | null): ShellView {
  return patchStatus(view, { window })
}

/**
 * **窗长表**上屏的入口（U30）——装配给（`Assembly.windowTable`）。
 *
 * 表与那一格（`withContextWindow`）分工写清在 `ShellView.windowTable`：那一格是
 * **开机那一刻**的读数，本表供**此后每一次切换**取材。传 `null` ＝没有这张表
 * （旧路径原样：切换不动分母）。
 */
export function withWindowTable(view: ShellView, windowTable: WindowTable | null): ShellView {
  return { ...view, windowTable }
}

/**
 * 把 ③ 换成那次选中的模型，**并让 ④ 的分母跟着它走**（U30）——换模型 / 真跑用谁，
 * 两处同一条规则。
 *
 * - **表在**：按**那次选中**（条目 ＋ 模型两件）查——见 `windowOfSelection`。
 *   查不到＝`null`：**不知道就是不知道**，不沿用前一个模型的容量、不模糊匹配家族。
 * - **表不在**（`null`，调用方没给）：**一个数都不改**——分母照旧只认开机那一格与
 *   `model.catalog` 的答复（老路径）。
 */
function withModelWindow(
  view: ShellView,
  selection: { readonly provider?: string | undefined; readonly model: string },
): ShellView {
  const table = view.windowTable
  if (table === null) return patchStatus(view, { model: selection.model })

  return patchStatus(view, {
    model: selection.model,
    window: windowOfSelection(table, selection),
  })
}

/**
 * 一次选中的窗长——**与 `@magic/model` 的 `windowOfSelection` 同一条判定**
 * （那边是正身，这边是包边界逼出来的镜像；形状与规则都由两侧用例钉着）：
 *
 * **声明（对得上条目与模型）→ 内置表（按准确模型 id）→ `null`**。
 *
 * ⚠️ 声明**不按模型名全局生效**：别的条目给同名模型声明过什么，与本次选中无关
 * （合法的两个端点可以各有各的窗长）。
 *
 * ⚠️ 查表走 `ownOf`（只认自有键）——模型名 / 条目名都是用户给的字符串，
 * `'toString'` 这类名字走普通索引会从 `Object.prototype` 上摸到东西（那边 `capacity.ts`
 * 的 `ownOf` 注写了来龙去脉，本处是同一把尺子）。
 */
function windowOfSelection(
  table: WindowTable,
  selection: { readonly provider?: string | undefined; readonly model: string },
): number | null {
  const declared =
    selection.provider === undefined ? undefined : ownOf(table.declared, selection.provider)
  if (declared !== undefined && declared.model === selection.model) return declared.window

  return ownOf(table.builtin, selection.model) ?? null
}

/** 只认**自有键**的查表——见上面那段注（与 `@magic/model` 的 `ownOf` 同一条）。 */
function ownOf<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined
}

/**
 * `model.catalog` 里**当前那条**的上下文窗总量——④ 的分母（`12.4k/200k`）。
 *
 * 表在手上就走 `withModelWindow` 那一条（按**那次选中**查）：条目表答复里的窗长是按
 * **条目**给的（该条目的模型那一格），而选中未必就是它——同条目换到别的模型时，
 * 那份声明不该跟过去（U30 的裁决）。**表不在**（调用方没给）才退回条目那一格，
 * 与老路径逐字同义。
 *
 * `null` 的两种来处都**如实**：查不到（没声明、内置表也不认得）或这次装配没有注册表。
 * 屏上回退成**只报已用量**——**不编一个总量**
 * （「拿不到的不编」是项目反复立的规矩：`D10` 那三条读数、状态行的「工作中」耗时都栽在这上面）。
 */
function windowOfCatalog(view: ShellView, data: EventDataOf['model.catalog']): number | null {
  const current = data.current
  if (current === undefined) return null

  if (view.windowTable !== null) return windowOfSelection(view.windowTable, current)

  return data.entries.find((entry) => entry.provider === current.provider)?.contextWindow ?? null
}

/** 追加一行**已定局**的行（写一次即入 scrollback）。 */
function appendSettled(view: ShellView, row: LogRow): ShellView {
  return { ...view, settled: [...view.settled, row] }
}

/**
 * 用**重建的会话内容**替换记录区（缺陷 D1）——只挑会话内容那一类，
 * 屏上痕迹（输出 / 回执）**不回**；**收拢**：老工具调用并成一行，最近一组展开。
 *
 * ⚠️ **字标仍在最前面**，但**用的是这一页已有的那一条**（`pageHeaderOf`：对象不变）——
 * 这一跳把 `settled` 整个换掉，字标是「记录区最前面那一块」，不保它 `--session` 接续那条路
 * （开局 `boot` 跑完读一次历史 ⇒ 走到这儿）当场就没有字标了。
 *
 * ⚠️ **本函数不「开页」**（U29 验收改）：开页＝种新字标＝换页（见 `bannerFirst` 那段注），
 * 而这一跳是「往**已经开着的那一页**里填历史」——换会话那一下 `reduceSessionState`
 * 已经开过页了，这里再开一次，屏上就多一份字标（甲→乙一次切换实测 4 份：开局 1 ＋
 * `rebuild` 两处各 1 ＋ 换会话 1）。**别把这一处改回 `bannerFirst`。**
 */
export function rebuild(view: ShellView, entries: readonly Entry[]): ShellView {
  // **计划那一份也从这同一批条目里取**（U34）：切会话 / 重开之后清单要跟着回来，
  // 而它一直是会话记录的一部分（设计：读取、呈现与上下文同读这份来源）。
  const plan = planFromEntries(entries)
  const fresh = plan.entry !== null && (view.plan.entry === null || plan.entry > view.plan.entry)

  return {
    ...view,
    settled: [pageHeaderOf(view), ...rebuildRows(entries)],
    rows: [],
    // **比手上的新才落**——这一趟读库比实时事件慢，晚到的那一份旧内容不许把
    // 已经上屏的新计划（或清空）盖回去（与 `withPlan` 同一把尺子）。
    ...(fresh ? { plan } : {}),
  }
}

/**
 * 条目 → 记录行（重建用）。两件收拢：
 * - `tool-call` / `tool-result` **配对成一行**（结果并进去，不各占一行）；
 * - 同一轮的**连续工具调用**并成一行摘要（「3 次工具调用（ls · read · grep）· 1.4s」）。
 *
 * 「末尾 `RECENT_GROUPS` 组展开」——最近那几组工具保持逐条行，更早的组并成摘要
 * （原型 · 场景 12；收的判据见 `collapseToolGroups`）。
 */
function rebuildRows(entries: readonly Entry[]): readonly LogRow[] {
  const rows: LogRow[] = []
  /** 待配对的那条工具行在 `rows` 里的下标（`-1` ＝ 没有）。 */
  let pendingAt = -1

  for (const entry of entries) {
    if (entry.kind === 'tool-call') {
      const payload = entry.payload as { readonly name?: string; readonly args?: unknown } | undefined
      rows.push({
        kind: 'tool',
        key: `rb:c:${entry.id}`,
        call: entry.id,
        name: payload?.name ?? '工具',
        argsText:
          payload?.args === undefined ? '' : argsJson(payload.args as Readonly<Record<string, unknown>>),
        args: (payload?.args as Readonly<Record<string, unknown>> | undefined) ?? null,
        state: 'ok',
        elapsedMs: null,
        startedAt: null,
        output: [],
        // 辅助工具那三个：恢复时也照这条规矩走（默认不画 · 展开可查 · 失败可见）——
        // 判据全在渲染那一处（`components/log.ts`），行照旧留在记录区里
        ...(payload?.name !== undefined && quietTool(payload.name) ? { quiet: true as const } : {}),
      })
      pendingAt = rows.length - 1
      continue
    }

    if (entry.kind === 'tool-result') {
      const row = pendingAt === -1 ? undefined : rows[pendingAt]
      if (row !== undefined && row.kind === 'tool') {
        const payload = entry.payload as { readonly ok?: boolean; readonly notExecuted?: true } | undefined
        const ok = payload?.ok !== false
        const text = contentTextOf(entry)
        rows[pendingAt] = {
          ...row,
          // **与事件那一路同判**：读的是**同一位**（条目载荷与事件数据同源，见
          // `ToolResultPayload`）——屏上的样子只该有一种：切了会话 / 重开一页回来，
          // 扣下的那行不能变回「失败」。
          state: payload?.notExecuted === true ? 'unexecuted' : ok ? 'ok' : 'failed',
          output: textOfLines(text),
        }
      }
      pendingAt = -1
      continue
    }

    pendingAt = -1
    const text = contentTextOf(entry)

    if (entry.kind === 'user') {
      const skills = usedSkillsOf(entry.payload)
      rows.push({
        kind: 'user',
        key: `rb:u:${entry.id}`,
        text,
        echoed: false,
        // **随这条交代送出去的技能**（U33 · 独立验收退回③）——恢复时它是这条消息唯一的
        // 材料依据。**读的是记录里存的那一份**（当时送出去的名字与来源标签），
        // 不重新读盘：材料是动态的，重读会拿到今天的、冒充当时那一份。
        ...(skills.length === 0 ? {} : { skills }),
      })
    } else if (entry.kind === 'assistant') rows.push({ kind: 'assistant', key: `rb:a:${entry.id}`, text })
    else rows.push({ kind: 'receipt', key: `rb:s:${entry.id}`, text: `（摘要）${text}` })
  }

  // **一行都不摘**（返修）：安静的那几个工具行照旧铺进记录区——「默认不画」由渲染那一处
  // 按 `quiet` ＋ `expanded` 判（`components/log.ts`）。在这儿滤掉＝切一趟会话回来
  // 那一行就**永久不可查**了（`Static` 写一次就不再重绘）。
  return collapseToolGroups(rows)
}

/**
 * 末尾保留**逐条展开**的组数（实现级阈值 · 缺陷 D18②）。
 *
 * 取 5 的由头：「只展开最近一组」在长会话恢复时＝几乎全灰（前面几十组全是灰摘要，
 * 读起来像什么都看不清）。视口一屏落得下五组逐条行（每组两行上下），
 * 既看得见「最近在干什么」，又不至于把几十组全摊开。
 */
const RECENT_GROUPS = 5

/**
 * **收拢**（原型 · 场景 12）：工具调用并成一行摘要
 * （「3 次工具调用（ls · read · grep）」）。
 *
 * 收的判据**两条**（缺陷 D18）——两条都是「为什么要收」的账：
 * - **≥2 次才收**——收拢是为了**省行**：`● 1 次工具调用（ls）` 与 `● ls .` 同样占一行，
 *   却把参数丢了 ⇒ 1 次收是**净损失**；
 * - **末尾 `RECENT_GROUPS` 组不收**——展开策略按**条数**，不是「只有最后一组」。
 *
 * ⚠️ **数的是「看得见的」那几条**（2026-09-23 复验退回）：默认不画的行（成功辅助调用，
 * 见 `quietRowHidden`）既不进名称也不进计数——不这样的话，**单看某一行它明明不画**，
 * 恢复历史时却从分组摘要里又冒出来（`● 2 次工具调用（plan_update · plan_read）`）。
 * 一段里看得见的不足两条就不收：**收了反而是净损失**（同上面「≥2 次才收」那条账）。
 */
function collapseToolGroups(rows: readonly LogRow[]): readonly LogRow[] {
  const segments = toolSegments(rows)
  if (segments.length === 0) return rows

  /** 末尾这几段保持逐条展开。 */
  const recent = new Set(segments.slice(-RECENT_GROUPS).map((segment) => segment.start))

  /** 一段里**看得见**的那几个名字（默认不画的不算）。 */
  const visibleNames = (segment: { readonly start: number; readonly end: number }): readonly string[] =>
    rows
      .slice(segment.start, segment.end + 1)
      .filter((row): row is Extract<LogRow, { kind: 'tool' }> => row.kind === 'tool' && !quietRowHidden(row))
      .map((row) => row.name)

  /** 摘要行插在每段的**首行**位置；段内其余行丢掉。 */
  const summaryAt = new Map<number, readonly string[]>()
  const dropped = new Set<number>()

  for (const segment of segments) {
    if (recent.has(segment.start)) continue
    if (segment.end === segment.start) continue // 单次调用不收

    const names = visibleNames(segment)
    if (names.length <= 1) continue // 看得见的不足两条：不收（收了只有净损失）

    summaryAt.set(segment.start, names)
    for (let index = segment.start + 1; index <= segment.end; index += 1) dropped.add(index)
  }

  const out: LogRow[] = []
  rows.forEach((row, index) => {
    const names = summaryAt.get(index)
    if (names !== undefined) {
      out.push({ kind: 'toolgroup', key: `rb:g:${index}`, names })
      return
    }
    if (!dropped.has(index)) out.push(row)
  })

  return out
}

/** 相邻工具行的连续段（收拢与「最后一组展开」都按它划）。 */
function toolSegments(rows: readonly LogRow[]): readonly { readonly start: number; readonly end: number }[] {
  const segments: { start: number; end: number }[] = []

  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.kind !== 'tool') continue

    let end = index
    while (rows[end + 1]?.kind === 'tool') end += 1
    segments.push({ start: index, end })
    index = end
  }

  return segments
}

/**
 * `user` 条目载荷里的**技能**——**只取显示要用的那三格**（名字 · 来源身份 · 来源标签）。
 *
 * 正文（载荷里那一份 `text`）**不带进行里**：显示只用名字与来源，而把几 KB 的材料再挂
 * 一份到屏上毫无用处（它本来就在记录里，要用的时候从那儿读）。
 *
 * 载荷形状按记录域的 `UserPayload`：两个键都可以缺席（纯文本交代）——缺席＝空数组，
 * 不编也不报（「这条交代没带技能」是常态，不是问题）。**两形都读**：
 * - `refs`（U36）——正文里带位置的那一份，只挑技能那一支（文件 / 目录**不在这一行**：
 *   它们的写法（`@src/login.ts`）本来就写在正文里，再列一遍是同一件事说两遍）；
 * - `skills`（U33 旧形）——旧记录里那一份照旧读出来。
 */
function usedSkillsOf(payload: Entry['payload']): readonly UsedSkill[] {
  const source = payload as
    | { readonly skills?: readonly UsedSkillEntry[]; readonly refs?: readonly InputRefEntry[] }
    | undefined

  const skills = source?.['skills']
  const legacy = Array.isArray(skills)
    ? skills.map((one) => ({ name: one.name, source: one.source, label: one.label }))
    : []

  const refs = source?.['refs']
  const positional = Array.isArray(refs)
    ? refs
        .filter((one): one is Extract<InputRefEntry, { kind: 'skill' }> => one.kind === 'skill')
        .map((one) => ({ name: one.name, source: one.source, label: one.label }))
    : []

  return [...legacy, ...positional]
}

/** 条目的正文——内联取文本，blob 引用不解析（外壳的既有姿势）。 */
function contentTextOf(entry: Entry): string {
  return 'text' in entry.content ? entry.content.text : `（大块转存 ${entry.content.blob}）`
}

// ══ 接管（裁决挂着时占住输入框）══════════════════════════════════════

/**
 * 接管——把草稿**连同插入点**收起来（原型：**草稿不丢**，答完原样归还）。
 *
 * 多件裁决时草稿**只收一次**：第一件接管时收起，其后各件沿用同一份（`stashed` 非空即已收）。
 *
 * ⚠️ 收的是 `view.caret`（不是「末尾」）——接管期间打不进草稿（`shell.ts` 的键映射把字
 * 喂给裁决作答），故此刻的插入点**就是**用户离开时那一个，答完照原样放回去。
 */
export function takeOver(view: ShellView): ShellView {
  if (view.dock.kind !== 'decision' || view.stashed !== null) return view

  return {
    ...view,
    stashed: {
      draft: view.draft,
      caret: Math.max(0, Math.min(view.caret, view.draft.length)),
      refs: view.refs,
    },
    draft: '',
    caret: 0,
    refs: [],
    flash: null,
  }
}

/**
 * 解除接管——**归还原草稿与它的插入点**（不自动发送）。
 *
 * 没有收起来的草稿时（接管前就没草稿）`stashed` 为 `null`：草稿与插入点**原样不动**
 * （接管那一刻草稿已被清空，这里不必替它摆一个位置）。
 */
export function undock(view: ShellView): ShellView {
  if (view.dock.kind !== 'decision') return view // 没在接管＝没得解除

  const stashed = view.stashed
  const draft = stashed?.draft ?? view.draft
  const caret = stashed?.caret ?? view.caret

  return {
    ...view,
    dock: { kind: 'input' },
    draft,
    // 夹一道：手搭的视图可能给过越界的插入点（同 `shell.ts` 的 `caretAt`）
    caret: Math.max(0, Math.min(caret, draft.length)),
    // 引用与正文**一起回来**——它俩是同一件事的两面（见 `Stashed.refs` 那条注）。
    // 撤回草稿若短于收起来那份（手搭的视图），区间照原样交回：编辑那几处会夹，
    // 此处不另编一套（`inline.ts` 的每一步都按当下的位置算）。
    refs: stashed?.refs ?? view.refs,
    stashed: null,
    flash: null,
  }
}

/** 「不静默吞键」——接管期间按了不认的键，当场说一句（原型 · 场景 6）。 */
export function flashTakeover(view: ShellView, message: string): ShellView {
  return view.dock.kind === 'decision' ? { ...view, flash: message } : view
}

function clearFlash(view: ShellView): ShellView {
  return view.flash === null ? view : { ...view, flash: null }
}

/** 裁决态的状态行（`● 等你定夺` ＋ 件数 ＋ 键位——键位**只在卡上**与右位各一次）。 */
export function withDecisionStatus(view: ShellView): ShellView {
  if (view.dock.kind !== 'decision') return view

  const { position, weight, external } = view.dock.pending

  return patchStatus(view, {
    state: 'waiting',
    amount: position === null ? null : `${position.index}/${position.total}`,
    // **外部件右位留空**（返工 B）：卡上已经写了 `y 批准这一次 / n 拒绝`，
    // 一屏上的键位**只说一次**（交互约束那条）——状态行再列一遍就是同一件事说两遍。
    hint: external === true ? '' : weight === 'heavy' ? HINT_DECIDE_HEAVY : HINT_DECIDE_LIGHT,
  })
}

/** 状态词（五态固定词——原型 · 状态行规格）。 */
export function stateLabel(state: StatusState): string {
  switch (state) {
    case 'idle':
      return '○ 空闲'
    case 'working':
      return '● 工作中'
    case 'waiting':
      return '● 等你定夺'
    case 'retrying':
      return '● 正在重试'
    case 'error':
      return '▲ 出错'
  }
}

// ══ 选择器（`/session` · `/model`）═══════════════════════════════════

/**
 * **`/session` 的行** —— 目录按**工作区分组**（U26；词典 · Workspace / Session：
 * 一个会话属于一个工作区）。
 *
 * 三条规格：
 * ① **分组头 ＋ 全部列出**——每一组顶着它的工作区路径；别的项目**不藏**（列表是
 *    「找到会话」的地方，藏起来＝找不到；而「换个目录接着上次的活」是真场景）；
 * ② **本工作区那组在前**——你此刻在那儿，那儿的会话排前头（组内仍是目录的序：最近在前）；
 * ③ **别的项目压暗**——视觉次序上的区分，**不挡路**（仍可切）。
 *
 * 归属**缺席**的（`workspace` 没有——列加上之前落账的会话）单列一组，头是
 * 「（工作区未记录）」：**不拿「当下的启动目录」顶上**（那正是这一列要断掉的东西），
 * 也**不压暗**（无从判断它是不是「别处」——**不编**；压暗留给判得实的那些）。
 *
 * `here` ＝ **本进程的工作区**（装配递进来，见 `ShellOptions.workspaceRoots`）。
 * **不给＝不知道自己在哪儿** ⇒ 一组都不压暗——「拿不到的不编」（同 `contextWindow` 那一路）。
 */
export function sessionRows(
  catalog: readonly SessionSummary[],
  active: SessionId | null,
  here?: readonly string[],
): readonly PickerRow[] {
  const mine = here === undefined ? null : identityOf(here)
  const found = new Map<string, Group>()
  const groups: Group[] = []

  for (const session of catalog) {
    const key = identityOf(session.workspace)
    let group = found.get(key)
    if (group === undefined) {
      const known = session.workspace !== undefined // 归属记着＝判得实；缺席＝无从判断
      group = {
        head: headOf(session.workspace),
        mine: known && key === mine, // 判得实才算「这儿」
        // 判得实才算「别处」：归属缺席的、以及「不知道自己在哪儿」的，都不压暗
        elsewhere: known && mine !== null && key !== mine,
        rows: [],
      }
      found.set(key, group)
      groups.push(group)
    }

    group.rows.push({
      label: session.title ?? '（无标题）',
      meta: session.id === active ? '正在用' : '',
      current: session.id === active,
      value: session.id,
    })
  }

  // 本工作区那组在前，其余照**出现序**（＝目录的序：组里最近一条的时间先后）
  const ordered = [...groups.filter((group) => group.mine), ...groups.filter((group) => !group.mine)]

  return ordered.flatMap((group) =>
    group.rows.map((row) => ({ ...row, group: group.head, faint: group.elsewhere })),
  )
}

/**
 * `/session` 列表下方那句话 —— **本工作区一条会话都没有**时报出「**这儿是哪儿**」
 * （U27 · `U26` 待决 2）。
 *
 * 由头：本工作区没有会话时，整张表都是暗的——用户看得出「这些不是这儿的」，但**看不出
 * 「这儿」是哪儿**。故在这一行报出本工作区，写法**与分组头同形**（`headOf`：整组根、
 * ` · ` 隔开）——不同形就对不上是哪一组。
 *
 * 三种情形**不报**（拿不到的不编 · 表自明的不占这行）：
 * - 本工作区**有**会话（表自明；这行留给别的用处：空态那句 / `/model` 的说明）；
 * - 目录**是空的**（留给空态那句——「还没有落过账的会话」）；
 * - **不知道自己在哪儿**（装配没给工作区）或给的是空组。
 */
export function sessionHint(
  catalog: readonly SessionSummary[],
  here?: readonly string[],
): string | undefined {
  if (here === undefined || here.length === 0 || catalog.length === 0) return undefined

  const mine = identityOf(here)
  // 判据与分组同一把尺子（`identityOf`）：归属缺席的（列加上之前落账的）不算「这儿」的
  const hasHere = catalog.some(
    (session) => session.workspace !== undefined && identityOf(session.workspace) === mine,
  )

  return hasHere ? undefined : `本工作区：${headOf(here)}`
}

/** **挑一家**那一屏的行（接入第一步）——取材就是答复里的那份名单。 */
export function vendorRows(vendors: readonly VendorInfo[]): readonly PickerRow[] {
  return vendors.map((one) => ({
    label: one.label,
    // 副文案**留空**：连接 id 就是它的名字（`MiniMax` / `minimax` 只差大小写）——
    // 再报一遍是同一条信息说两遍。有区域可选时，选择在下一步（见 `regionRows`）。
    meta: '',
    current: false,
    value: one.vendor,
    oneLine: true,
  }))
}

/** **挑区域**那一屏的行（接入第二步，只在真有得选时开）——区域名 ＋ 它指向的官方地址。 */
export function regionRows(vendor: VendorInfo): readonly PickerRow[] {
  return vendor.regions.map((region) => ({
    label: region.label,
    meta: region.baseURL,
    current: false,
    value: region.id,
    oneLine: true,
  }))
}

// ══ 模型选择（U41 · 供应商与模型）═════════════════════════════════════

/**
 * **`/model` 的行**——取材是**连接一览 ＋ 各自的缓存读数**（不再是「配置条目」）。
 *
 * 设计（模型与上下文 · 选择模型）：「先展示已有缓存，再按需刷新」「**行主文案为模型名，
 * 副文案为供应商/连接名**」「实际选择键是"连接 id ＋ 精确模型 id"」。
 *
 * 三条分寸写在行里：
 * - **只列适用于对话的**（`capabilities.chat === false` 的不混入——设计 · 列表取舍）
 *   而那判据**只认 API 给的**：这一位**缺省＝未知**，未知照列（不冒充「不支持」）；
 * - **已有选择照留**：不在最近一次列表里的那个模型**仍然列着**并标明这一事实
 *   （设计：「模型不在最新列表时，已有选择仍明确保留并提示此事实」）；
 * - **副文案是连接名**（缺省＝id）：合法的两条连接可以有同名模型，认谁就看这一格。
 */
export function modelRows(
  entries: readonly ModelCatalogRow[],
  current: ModelRef | null,
): readonly PickerRow[] {
  const rows: PickerRow[] = []

  for (const entry of entries) {
    const connection = entry.name ?? entry.provider

    for (const one of modelsOf(entry, current)) {
      rows.push({
        label: one.info.name ?? one.info.id,
        // 连接名打头（窄窗先保住它——同名模型靠它分辨），其后才是补充的那几格
        meta: [connection, ...(tailOf(one, entry) ?? [])].join(' · '),
        current:
          current !== null && current.provider === entry.provider && current.model === one.info.id,
        // `value` 只作行与行之间的区分（选定带的是 `pick` 那两件，见 `PickerRow.pick`）
        value: `${entry.provider} ${one.info.id}`,
        pick: { provider: entry.provider, model: one.info.id },
        oneLine: true,
        keep: connection,
      })
    }
  }

  return [...rows, ...modelActionRows(entries)]
}

/**
 * **`/model` 末尾那几条入口行**（U41 返修）——「这一刻能做什么」，与「有哪些可挑的」分开。
 *
 * 三条由头（首验退回那一处）：
 * - **空态也要有入口**：一条连接都没有时，这一屏原先**收回普通输入区**（0 行不接管输入），
 *   用户手上没有任何可操作的东西——「从头接一条」这条路就这么断了；
 * - **入口要在 `/model` 内直接可操作**：不能靠一串子命令说明去教用户另打一条命令；
 * - **常驻**（`pinned`）：几十条模型折起来时，这三行照旧在末尾（见 `PickerRow.pinned`）。
 *
 * ⚠️ **只在有用时才给**：「管理连接」「刷新模型」在一条连接都没有时无事可做——摆着就是
 * 占地方的实现细节（`AGENTS.md`：屏幕上常驻的每一格，问它「影响用户的哪个动作」）。
 */
export function modelActionRows(entries: readonly ModelCatalogRow[]): readonly PickerRow[] {
  const rows: PickerRow[] = [
    { label: '连接供应商', meta: '', current: false, value: 'connect', oneLine: true, pinned: true },
  ]

  if (entries.length > 0) {
    rows.push({
      label: '管理连接',
      meta: `${entries.length} 条连接`,
      current: false,
      value: 'manage',
      oneLine: true,
      pinned: true,
    })
    rows.push({
      label: '刷新模型',
      meta: '现在就去供应商那儿取一遍',
      current: false,
      value: 'refresh',
      oneLine: true,
      pinned: true,
    })
  }

  return rows
}

/**
 * 一个连接该列出哪些模型——缓存里的 ＋（不在缓存里的）**已有选择**。
 *
 * ⚠️ **两类「已有选择」都要留**（U41 返修 · 首验退回那一处）：
 * ① 这个连接的**配置默认**（`entry.model`）；
 * ② **此刻实际在用的那一条**（`current`）——它未必是默认：用户换过、或者它从最近一次
 *    列表里被移除了。**只补①就等于把用户手上那条偷偷换掉**（列表里显示的是默认，
 *    而实际发出去的还是原来那条——用户看着屏做判断，屏却在说另一件事）。
 */
function modelsOf(
  entry: ModelCatalogRow,
  current: ModelRef | null,
): readonly { readonly info: ModelInfo; readonly cached: boolean }[] {
  const cached = (entry.cache?.snapshot?.models ?? []).filter(
    // **列表取舍**：明确说了「不适用于对话」的不混入（`false` 才排除；**未知照列**）
    (one) => one.capabilities?.chat !== false,
  )
  const out = cached.map((info) => ({ info, cached: true }))
  const has = (id: string): boolean => out.some((one) => one.info.id === id)

  // ① 配置默认——缓存里没有也**留着**（且标明它不在最近一次列表里）
  if (entry.model !== undefined && !has(entry.model)) {
    out.push({ info: { id: entry.model }, cached: false })
  }

  // ② **实际当前那条**——同上，一条都不能丢（设计：「模型不在最新列表时，已有选择仍明确
  //    保留并提示此事实」；这里连「它是不是默认」都不假设）
  if (current !== null && current.provider === entry.provider && !has(current.model)) {
    out.push({ info: { id: current.model }, cached: false })
  }

  return out
}

/** 副文案里连接名之后的那几格——**只在真有话要说时才给**（没有就一个字不加）。 */
function tailOf(
  one: { readonly info: ModelInfo; readonly cached: boolean },
  entry: ModelCatalogRow,
): readonly string[] | undefined {
  const parts: string[] = []

  // **显示名与 id 不是同一个**时把 id 报出来（送出去的是它——用户核对得到）
  if (one.info.name !== undefined && one.info.name !== one.info.id) parts.push(one.info.id)
  if (!one.cached) parts.push('不在最近一次列表里')
  if (entry.vendor === undefined && entry.cache === undefined) parts.push('兼容接入')

  return parts.length === 0 ? undefined : parts
}

/** 管理面那一行连接长什么样（副文案）——**只报手上有的事实**，没有的不编。 */
export function manageMetaOf(entry: ModelCatalogRow): string {
  const parts = [entry.vendor ?? '兼容接入']
  if (entry.region !== undefined) parts.push(entry.region)
  parts.push(authLabelOf(entry))

  return parts.join(' · ')
}

/**
 * 认证来处那一句——**说清是哪儿来的**，不含糊说「已设置」（设计 · 维护连接）。
 * 两处都没有（这条连接还没有可用认证）＝**如实说没有**。
 */
export function authLabelOf(entry: ModelCatalogRow): string {
  if (entry.keySource === 'config') return '认证：配置文件'
  if (entry.keySource === 'env') return `认证：环境变量 ${apiKeyEnvVarOf(entry.provider)}`

  return '认证：还没有'
}

/** 缓存那半句——几个模型 / 什么时候取的 /（有则）这次没刷成。 */
export function cacheLabelOf(entry: ModelCatalogRow): string {
  const cache = entry.cache
  if (cache?.snapshot === undefined) return cache?.refreshing === true ? '正在取' : '还没取过'

  const count = `${cache.snapshot.models.length} 个模型`
  const when = dayLabel(cache.snapshot.fetchedAt)

  return cache.failure === undefined ? `${count} · ${when} 取的` : `${count} · ${when} 取的（上次没刷成）`
}


/**
 * **模型详情那一屏的行**（U41）——两条动作，连接与模型的资料写在下方那行说明里。
 *
 * 设计（模型与上下文 · 应用设置）：「**详情可改该模型支持的思考设置**，另有'**设为默认**'动作」。
 * 两件都是「对**这一条**模型做的事」，故与「选定＝切过去」分开：列表上回车是切换，
 * 要看详情得明确按 `→` 进这一屏（同 `enter` 与「详情」两个动作在别处的分寸）。
 */
export function modelDetailRows(): readonly PickerRow[] {
  return [
    { label: '思考设置', meta: '', current: false, value: 'reasoning', oneLine: true },
    {
      label: '设为默认',
      meta: '新建会话就用它',
      current: false,
      value: 'default',
      oneLine: true,
    },
  ]
}

/**
 * **思考那一屏的行**（U41）——只列**这个模型声明支持**的那几形。
 *
 * 设计（思考能力与供应商适配）：「思考设置在契约中区分'模型默认''明确关闭''指定档位'
 * '指定 token 预算'，**只开放具体模型和接入路径支持的形态**」「未声明支持就不能发送假参数」。
 * 故这一屏的行**完全由能力描述长出来**：
 *
 * - `模型默认` —— 永远有（它是「不发送任何思考参数」，不需要模型声明什么）；
 * - `明确关闭` —— **只在 `disable === true` 时给**（关闭与默认不是一回事：那是「说了别想」）；
 * - 档位 —— 由 `levels` 逐条给（**不假设同一套低/中/高**）；
 * - 预算 —— 本轮**不给**（要一个数值输入 + 范围校验，取舍见回报）；
 *   能力里只声明了预算而没有档位的模型，这一屏就只有「模型默认」。
 *
 * `current` ＝ 此刻这一条生效的设置——标出「正在用」那一格（没有＝模型默认）。
 */
export function reasoningRows(
  support: ReasoningSupport | undefined,
  current: ReasoningSetting | null,
): readonly PickerRow[] {
  const setting: ReasoningSetting = current ?? { mode: 'default' }
  const mark = (one: ReasoningSetting): boolean =>
    one.mode === setting.mode &&
    (one.mode !== 'level' || (setting.mode === 'level' && one.level === setting.level)) &&
    (one.mode !== 'budget' || (setting.mode === 'budget' && one.budgetTokens === setting.budgetTokens))

  const rows: PickerRow[] = [
    {
      label: '模型默认',
      meta: '不发送思考参数，服务端自己定',
      current: mark({ mode: 'default' }),
      value: 'default',
      reasoning: { mode: 'default' },
      oneLine: true,
    },
  ]

  if (support?.disable === true) {
    rows.push({
      label: '明确关闭',
      meta: '说了别想（与「默认」不是一回事）',
      current: mark({ mode: 'off' }),
      value: 'off',
      reasoning: { mode: 'off' },
      oneLine: true,
    })
  }

  for (const level of support?.levels ?? []) {
    rows.push({
      label: level,
      meta: '档位',
      current: mark({ mode: 'level', level }),
      value: `level:${level}`,
      reasoning: { mode: 'level', level },
      oneLine: true,
    })
  }

  return rows
}

/** 思考那一屏上方那句实话——**这个模型声明了什么，就说什么**（没声明＝如实说没有）。 */
export function reasoningHint(support: ReasoningSupport | undefined): string {
  if (support === undefined) return '这个模型没有声明思考档位——只能按模型默认用'

  const parts: string[] = []
  if (support.levels !== undefined && support.levels.length > 0) parts.push(`${support.levels.length} 个档位`)
  if (support.disable === true) parts.push('可明确关闭')
  if (support.budget !== undefined) parts.push('支持 token 预算（本版本还没做）')

  return parts.length === 0
    ? '这个模型没有声明思考档位——只能按模型默认用'
    : `这个模型支持：${parts.join(' · ')}`
}

/**
 * `/model` 列表下方那行说明——**只说有事要说的那几件**。
 *
 * 三件由头（各自都在别处查不到）：
 * - **缓存的状态**：还没取过 / 正在取 / 过期 / 上次没取成——「能用不能用、新不新」是用户此刻
 *   唯一要判断的事（设计：「失败……返回最后成功时间与本次失败原因」）；
 * - **三个动作怎么走**：它们沿 `/model` 展开（设计：不再新增一组按内部能力命名的 slash
 *   命令），故得在这儿指出来；
 * - **内核那句 `note`**（有则）——装配有话说时说（如「本次装配没有注册表」）。
 *
 * ⚠️ **更新时间只在这里出现一次**（过期的那些），新鲜的连接**不报时间**：设计写的是
 * 「供应商信息与更新时间**按需**可见」——按需＝详情里查得到，不是每个连接都在列表上挂一行。
 */
/**
 * 那一行说明里**最多逐条报几条连接**——实现级常量。
 *
 * 由头（真跑量出来的）：这一行原先**没有上界**——30 条「还没取过」的连接就是 30 行说明，
 * 而说明是**候选窗口之外**另加的，于是交互区一路长到把记录区整个顶出屏幕
 * （真 PTY 60×24 · 30 条连接实测：分隔线以上一行不剩）。
 *
 * 取 3 的由头：它是一屏里「还看得过来」的条数；再多就**折起来报数**并指到 `/model manage`
 * （那里逐条列着每条连接的认证与缓存读数，正是「到底哪条有状况」该去的地方）。
 */
const MAX_MODEL_NOTES = 3

export function modelHint(entries: readonly ModelCatalogRow[], note?: string): string {
  const lines: string[] = []

  for (const entry of entries) {
    const connection = entry.name ?? entry.provider
    const cache = entry.cache

    if (cache?.snapshot === undefined) {
      lines.push(
        cache?.refreshing === true
          ? `${connection}：正在取模型列表……`
          : `${connection}：还没取过模型`,
      )
    } else if (cache.stale === true) {
      lines.push(
        cache.refreshing === true
          ? `${connection}：列表是 ${dayLabel(cache.snapshot.fetchedAt)} 取的，正在重新去取`
          : `${connection}：列表是 ${dayLabel(cache.snapshot.fetchedAt)} 取的（过期了）`,
      )
    }

    // 失败**照说**，哪怕旧列表还在用（「有旧缓存而这次没刷成」是两件事，得都说清）
    if (cache?.failure !== undefined) lines.push(`${connection}：上次没取成——${cache.failure.reason}`)
  }

  // 「详情」那一个键放在这儿（不在右位）：右位那条键位提示是**共用**的
  // （`HINT_PICKER`，五扇抽屉同一句），各屏另加一个键就得各写一句——而它一变，
  // 认它当判据的装置（`app/test/ui/scenarios.ts` 的抽屉场景）当场全红。
  // 列表下方报键位有先例（`/grants` 的「回车＝撤销选定那条」），照它。
  // **折起来如实报数**（见 `MAX_MODEL_NOTES`）——超出的那几条不逐行铺，指到管理页去
  const heads = lines.slice(0, MAX_MODEL_NOTES)
  const rest = lines.length - heads.length
  if (rest > 0) heads.push(`… 另有 ${rest} 条连接也有状况——/model manage 里逐条看`)

  // **不在这儿列子命令**（U41 返修）：三个动作已经是列表末尾那几条**可操作的入口行**，
  // 再拿一行字教用户另打命令，就是把入口写成了说明（上面那几条逐连接的说明里也不指子命令
  // ——「刷新模型」那一行就常驻在下面）。这一行只剩「详情」那个键
  //（它是对**当前选中那一行**的动作，做不成一行——「这条」指谁得看焦点）。
  // 空态那一句**不再指路**：那一行入口就在它上面（且正被选中）——「选「连接供应商」接一条」
  // 是把行上的字再说一遍（一屏上的每一格都得说别处没说的）
  heads.push(entries.length === 0 ? '还没有接上任何供应商' : '→ 看这条的详情')

  if (note !== undefined && note !== '') heads.push(note)

  return heads.join('\n')
}

// ══ 授权抽屉（`/grants` · U22）═══════════════════════════════════════

/**
 * **`/grants` 的行** —— 名录 ＋ 陈旧的节（`B13` 的呈现形态：**与 `/session` · `/model`
 * 同位置同开合**的左下抽屉）。
 *
 * 两组：
 * - **本工作区的授权**——一行一条，`describe` 是内核给的措辞（工具 × 路径 × 操作，
 *   一处产出，外壳不重拼）；`meta` 是**用过的证据**（用了几次、最近什么时候）
 *   与**久未命中**那个标记；
 * - **陈旧的节**（`B11`）——**路径已不在**的那些工作区，一行一节，选定＝**整节撤掉**。
 *   ⚠️ **只是列出来**：内核**不自动删**（删用户数据不归内核），撤销的扳机在人手上。
 *
 * 行序即撤销要报的 `index`（本工作区那组在前，序号从 0 起）——故这里**不许重排**。
 */
export function grantsRows(catalog: GrantsCatalog): readonly PickerRow[] {
  const rows: PickerRow[] = catalog.grants.map((grant, index) => ({
    label: grant.describe,
    meta: grantMetaOf(grant),
    current: false,
    value: String(index),
    group: catalog.workspace,
    revoke: { index },
  }))

  for (const section of catalog.stale) {
    rows.push({
      label: section,
      meta: '路径已不在——整节撤销',
      current: false,
      value: section,
      group: STALE_HEAD,
      faint: true, // 压暗＝「这个多半是过去的事了」，但**照样选得中**（同 `/session` 的姿势）
      revoke: { workspace: section },
    })
  }

  return rows
}

/** 陈旧节那一组的头（本工作区那组用路径本身作头——两组的头分得开）。 */
const STALE_HEAD = '（已不在了的工作区）'

/** 一条授权的 meta 栏——**用过的证据**，不是评价（没记过账就说没记过）。 */
function grantMetaOf(grant: GrantsCatalog['grants'][number]): string {
  if (grant.lastHitAt === undefined) return grant.stale ? '还没用过 · 久未命中' : '还没用过'

  const when = `最近 ${dayLabel(grant.lastHitAt)}`
  // `hits` 与 `lastHitAt` 同来处（`grants.ts` 的记账）——有其一即有其二，此处仍是各判各的
  const times = grant.hits === undefined ? '' : `${grant.hits} 次 · `

  return grant.stale ? `${times}${when} · 久未命中` : `${times}${when}`
}

/**
 * 抽屉下方那行说明——**怎么用** ＋ **两笔账**（`B10` 的口径）。
 *
 * 两笔账**各占一行**（U28）：`本会话` 与 `历史累计` 的分母不是一回事（前者是这一趟、
 * 后者是这个项目的全部会话）——挤在一行里读不出哪半句说的是哪一边。
 */
export function grantsHint(catalog: GrantsCatalog): string {
  const head =
    catalog.grants.length === 0 && catalog.stale.length === 0
      ? `本工作区（${catalog.workspace}）还没有授权——批准时按 a 就是记一条`
      : '回车＝撤销选定那条'

  return [`${head} · ${frictionLabel(catalog.decisions)}`, historyLabel(catalog.history)]
    .filter((line) => line !== undefined)
    .join('\n')
}

// ══ 外部服务器抽屉（`/mcp` · U39）═══════════════════════════════════

/**
 * **`/mcp` 的行** —— 一台服务器一行（**与 `/grants` · `/skills` 同位置同开合**）。
 *
 * 一件要紧的事：行**保证只占一行**（`oneLine`）——`meta` 里是状态与件数，由渲染层按列宽
 * 截断；高度账按一行一条数（见 `PickerRow.oneLine`）。**不可用的缘由不放这儿**：
 * 它可能很长，放 `meta` 就折行、账就少了（那正是矮终端上真光标错位的老账）——放 `hint`。
 */
export function mcpRows(catalog: McpCatalog): readonly PickerRow[] {
  return catalog.servers.map((server) => ({
    label: server.server,
    // **状态打头**：窄窗 + 长名字时，行会被截（`oneLine`），先丢的必须是接入方式与件数
    // ——「这条可用不可用」是这一屏的全部意义，不能被一个长名字挤没（`keep` 再保一道）
    meta: `${mcpStateLabel(server)} · ${server.transport}` + mcpToolCount(server),
    current: false,
    value: server.server,
    oneLine: true,
    keep: mcpStateLabel(server),
  }))
}

/**
 * **一台服务器的明细行** —— 工具名各占一行（`/mcp <名字>` 看的那一屏）。
 *
 * 只报得出名字：读数里就这几格（契约 `McpCatalogRow`），说明与参数不在这一屏的取材里。
 */
export function mcpToolRows(catalog: McpCatalog, who: string): readonly PickerRow[] {
  const found = catalog.servers.find((server) => server.server === who)
  if (found === undefined) return []

  return found.tools.map((tool) => ({
    label: tool,
    meta: '',
    current: false,
    value: tool,
    oneLine: true,
  }))
}

/**
 * 抽屉下方那行说明——**总览**（不给 `who`）与**一台的明细**（给了 `who`）两用。
 *
 * 两条共用的分寸：
 * - **不可用就说缘由**（「某个服务失联时能看出哪条连接不可用」）：总览里逐台一行，
 *   明细则并进那一行状态；
 * - **拒收的那些要说出来**（名字不合规 / 重名）——它们是「服务器报了，我们没用」，
 *   不说就等于让用户对着一个不生效的工具发呆。名字是服务器自报的原文，
 *   **上屏前先洗控制字节**（`sanitizeForDisplay`）。
 */
export function mcpHint(catalog: McpCatalog, who?: string): string {
  if (who !== undefined) return mcpServerHint(catalog, who)

  if (catalog.servers.length === 0) {
    return '还没有配外部工具服务器——配置里写 mcp.servers 才连（工作区里的 .mcp.json 不算授权）'
  }

  const lines = catalog.servers
    .filter((server) => server.state.status === 'unavailable')
    .map((server) => `${server.server}：${server.state.status === 'unavailable' ? server.state.reason : ''}`)

  lines.push('/mcp <名字> 看那一台的工具与错误')
  return lines.join('\n')
}

/** 一台的明细那行说明——身份 ＋ 状态/缘由 ＋ 拒收的那些。 */
function mcpServerHint(catalog: McpCatalog, who: string): string {
  const found = catalog.servers.find((server) => server.server === who)

  if (found === undefined) {
    return `没有配这一台：「${sanitizeForDisplay(who)}」——配置里 mcp.servers 的条目名才是身份`
  }

  const lines = [`${found.server}（${found.transport}）· ${mcpStateLabel(found)}${mcpToolCount(found)}`]

  // **不可用时把那一句缘由摆出来**：`/mcp <服务器>` 正是设计给的「看工具/**错误**」入口
  // （总览那一屏也报，但点进这一台时不该反而看不到）
  if (found.state.status === 'unavailable') lines.push(found.state.reason)

  for (const one of found.rejected) {
    lines.push(`没收下「${sanitizeForDisplay(one.tool)}」——${one.reason}`)
  }

  return lines.join('\n')
}

/** 状态那一格——**连接中 / 可用 / 不可用**（不可用时缘由交给 `hint`）。 */
function mcpStateLabel(server: McpCatalog['servers'][number]): string {
  switch (server.state.status) {
    case 'connecting':
      return '还在连'
    case 'available':
      return '可用'
    default:
      return '不可用'
  }
}

/** 件数那一截——**只有连上了才报**（没连上时报 0 件是假账）。 */
function mcpToolCount(server: McpCatalog['servers'][number]): string {
  return server.state.status === 'available' ? ` · ${server.tools.length} 件工具` : ''
}

/**
 * 放行区的账 · **本会话**（`B10`）——**两个占比**，各自说各自的话（见契约 `grants.catalog`）：
 *
 * - **未配规则**：一条规则都没命中的那些 / 全部裁决；
 * - **还得你点**：前者 ＋「规则命中了却被必闸禁区否决」的那些 / 全部裁决。
 *
 * 两个数只差否决那一格——对用户是同一个体验，对规则作者不是一件事。**分母是 0 就不报**
 * （「0 次裁决」不是一个占比，报它等于编一个 0%）。
 */
function frictionLabel(decisions: GrantsCatalog['decisions']): string {
  const { total, uncovered, vetoed } = decisions
  if (total === 0) return '本会话还没走过裁决'

  const asked = uncovered + vetoed
  return (
    `本会话 ${total} 次裁决：未配规则 ${uncovered} 次（${percentOf(uncovered, total)}）` +
    ` · 还得你点 ${asked} 次（${percentOf(asked, total)}）`
  )
}

/**
 * 放行区的账 · **历史累计**（U28 · 跨会话）——**这个项目值不值得配规则**看的是它。
 *
 * ⚠️ **两格，不是本会话那三格**：库里那条事件只有 `decider`（`auto` / `user`），
 * 记不下「命中规则却被必闸禁区否决」——故这里**不报「未配规则」**（那是本会话分得出的
 * 细账，历史里分不开），只报历史真能分开的两类（见契约 `DecisionHistory` 那条注）。
 *
 * **没走过裁决就不报**（同 `frictionLabel`：0 次不是一个占比）——历史为空时这行整个不给。
 */
function historyLabel(history: GrantsCatalog['history']): string | undefined {
  const { total, auto } = history
  if (total === 0) return undefined

  const asked = total - auto
  return (
    `历史累计 ${total} 次裁决：自动放行 ${auto} 次（${percentOf(auto, total)}）` +
    ` · 还得你点 ${asked} 次（${percentOf(asked, total)}）`
  )
}

function percentOf(part: number, whole: number): string {
  return `${Math.round((part / whole) * 100)}%`
}

/** 时刻 → `MM-DD`（本地时区）——抽屉里只报「最近什么时候」，精确到分没必要。 */
export function dayLabel(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 一组（同一个工作区的那些行）——分组头 ＋ 是不是「这儿」/「别处」。 */
type Group = {
  readonly head: string
  readonly mine: boolean
  readonly elsewhere: boolean
  readonly rows: PickerRow[]
}

/**
 * 工作区的**身份**——那组根**照序**序列化（序即语义：`[0]` 是默认根）。
 *
 * 用 JSON 而不是拿个分隔符拼起来：无歧义、**可打印**（`['/a','/b']` 与 `['/a /b']`
 * 不会撞成同一个），且恒以 `[` 开头——与「缺席」那个哨兵永不同形。
 */
function identityOf(workspace?: readonly string[]): string {
  return workspace === undefined ? UNRECORDED : JSON.stringify(workspace)
}

/** 分组头——工作区的路径（多根＝整组报出来，` · ` 隔开）；缺席时如实说「未记录」。 */
function headOf(workspace?: readonly string[]): string {
  return workspace === undefined ? UNRECORDED_HEAD : workspace.join(' · ')
}

/** 归属缺席那一组的键与头（列加上之前落账的会话）——**如实说不知道**，不编。 */
const UNRECORDED = 'unrecorded'
const UNRECORDED_HEAD = '（工作区未记录）'

// ══ 技能（U33 · 终端入口）═══════════════════════════════════════════

/**
 * 同名直达的判据——**唯一确定没有**。
 *
 * 「取哪一份」由发现面的次序说了算（项目 → 用户 → 配置；同作用域原生 → 兼容），
 * 而次序之外还有一件：**同一档里并列时不许挑**（那等于随目录顺序蒙）。两档合在一处判，
 * 结果三态——取到了 / 要展开 / 没有这个名。
 */
export type SkillHit =
  | { readonly kind: 'one'; readonly skill: SkillCatalogRow }
  /**
   * 同名多份、且**最高那一档里也分不出唯一**——展开同名候选让用户点，不静默挑一个。
   * 携带的是**全部同名项**（含低一档的）：列表里本来就允许明确选其他来源。
   */
  | { readonly kind: 'many'; readonly skills: readonly SkillCatalogRow[] }
  | { readonly kind: 'none' }

/**
 * **同名直达**（`/<名称>` 敲回车那条路）——解析出唯一那一份（见 `SkillHit`）。
 *
 * 档的算法：`source` 三档（项目 0 · 用户 1 · 配置 2）× 10 ＋ `origin` 两档（原生 0 · 兼容 1）
 * ——两件都取自发现面的产物（`SkillCatalogRow` 那两格的注写了为什么必须随目录下来）。
 *
 * ⚠️ **不靠数组顺序取头一份**：目录确实是按优先级排的，但「排在前头」与「并列」在数组里
 * 长得一样——判据得来自那两格，不是下标。
 */
export function resolveSkill(name: string, catalog: readonly SkillCatalogRow[]): SkillHit {
  const same = catalog.filter((one) => one.name === name)
  const first = same[0]
  if (first === undefined) return { kind: 'none' }

  let best = first
  for (const one of same) if (rankOfSkill(one) < rankOfSkill(best)) best = one

  const top = same.filter((one) => rankOfSkill(one) === rankOfSkill(best))

  return top.length === 1 ? { kind: 'one', skill: best } : { kind: 'many', skills: same }
}

/** 一份技能在「同名取谁」上的档位（见 `resolveSkill`——两件都来自发现面）。 */
function rankOfSkill(skill: SkillCatalogRow): number {
  const source = skill.source === 'project' ? 0 : skill.source === 'user' ? 1 : 2
  const origin = skill.origin === 'magic' ? 0 : 1

  return source * 10 + origin
}

/**
 * **`/skills` 的行**——候选每项一行：名称 ＋ 来源 ＋ 简述。
 *
 * 两件写死在行里：
 * - **每项一行**（`oneLine`）——简述是用户自己写的，可以很长；折行了高度账当场分家
 *   （见 `PickerRow.oneLine` 的注）；
 * - **来源在前、简述在后**——窄窗截断时**先丢简述**：名称与来源才是分辨同名的那两眼
 *   （终端交互：「窄窗先保住名称/来源、再截断简述」）。
 *
 * ⚠️ **U36 起不再有「移除当前技能」那一行**（`REMOVE_SKILL` 已删）：引用长在正文里，
 * 要摘就在那一处按退格——抽屉里再放一行全局的移除，是同一件事的两个入口，
 * 而全局那个还说不出「摘的是哪一处」（见 `BoundSkill` 那一段的注）。
 */
export function skillRows(
  catalog: readonly SkillCatalogRow[],
  filter = '',
): readonly PickerRow[] {
  const needle = filter.trim().toLowerCase()
  const rows: PickerRow[] = []

  for (const skill of catalog) {
    const haystack = `${skill.name} ${skill.label} ${skill.description}`.toLowerCase()
    if (needle !== '' && !haystack.includes(needle)) continue

    rows.push({
      label: skill.name,
      meta: `${skill.label} · ${skill.description}`,
      // **来源那半截必留**（简述在后，先被截）——同名两份分不分得开全看它
      keep: skill.label,
      current: false,
      value: skill.path,
      oneLine: true,
    })
  }

  return rows
}

/**
 * **`@` 那一栏的行**（U36）——候选每项一行：路径 ＋（文件 / 目录 / 工作区外）。
 *
 * - **`value` 是那一条的真路径**（身份，选定即随引用走）；
 * - **`label` 是写进正文的写法**（相对默认根，或绝对）——用户在屏上看到的就是它，
 *   与草稿里那一段**逐字相同**（对齐不上时用户会以为选错了对象）；
 * - **每项一行**（`oneLine`）：路径可以很长（深目录 / 外部绝对路径），折行就是账与屏分家；
 * - **`meta` 说它是文件还是目录**——选定之前就得看得出（目录选进去给的是一份清单）；
 *   工作区外那一条另标一句（选定＝只读附件，不获准写）。
 */
export function pathRows(rows: readonly PathCatalogRow[]): readonly PickerRow[] {
  return rows.map((row) => ({
    label: row.external ? `${row.display}（工作区外 · 只读）` : row.display,
    meta: row.kind === 'directory' ? '目录' : '文件',
    current: false,
    value: row.path,
    oneLine: true,
  }))
}

/**
 * `@` 那一栏下方那句话——**怎么用 · 一条都没有时指路 ·（有则）内核那句说明**。
 *
 * ⚠️ **不复述查询那一段**（U36）：它就在输入行里（`@src/lo` 那半截，行就在这行字上面）——
 * 一屏上的每一行都得说别处没说的东西（`AGENTS.md`：答不上「告诉了我什么别处没说的」
 * 就是赘述）。
 */
export function pathHint(input: {
  readonly filter: string
  readonly shown: number
  /**
   * **这一趟还没回来**（边打边问，答复在路上）——见下。
   *
   * 为什么要有这一位：清单为空有两件不同的事实——「这一步对不上」与「还在看」。
   * 混成一句的话，用户刚打下一个字就被告知「没有对得上的」（而他明明有），
   * 那句话**当场就是假的**。拿不到的不编：正在看就说正在看。
   */
  readonly pending?: boolean
  readonly note?: string | undefined
}): string {
  const lines: string[] = []

  if (input.shown === 0 && input.pending === true) {
    lines.push('正在看这个写法……')
  } else if (input.shown === 0) {
    // 一条都没有时：内核那句说明优先（它说得出为什么），否则**指路**（怎么把它打出来）
    lines.push(input.note ?? '这一步没有对得上的——把路径打全，或退格换个写法')
  } else {
    lines.push(
      input.filter === ''
        ? '选一条放进这句话里（Tab 补全；目录再往里看一层）'
        : '接着打收窄，退格删一个字（Tab 补全）',
    )
    if (input.note !== undefined) lines.push(input.note)
  }

  return lines.join('\n')
}

/**
 * 列表下方那行说明——**筛选状态 · 空名录的出口 · 没读进来的那些**（各自说不同的东西）。
 *
 * 空名录指向的是**放哪儿**（设计：「空列表指向 `.magic/skills/<名称>/SKILL.md`」）——
 * 不解一句「没有技能」，那等于说了等于没说。
 *
 * 没读进来的只报**份数**：那些话（「front-matter 缺 `description`」一类）本来就是
 * `--check` 那一屏的正文，一条条搬进抽屉会把列表挤没；而**一个字不说**更坏——
 * 用户写了一份技能却发现它不在列表里，只能对着它发呆（静默丢弃是这一族最坏的形态）。
 * 故报数 ＋ 指路：`magic --check` 里逐条说得清。
 */
export function skillHint(input: {
  readonly catalog: SkillsCatalog | null
  readonly filter: string
  /** 筛过之后还剩几行——0 行时这句会落成记录区的一行回执（抽屉不开，见 `openPicker`）。 */
  readonly shown: number
}): string {
  const { catalog, filter, shown } = input
  const lines: string[] = []

  // **同名的那一摊**（`/<名字>` 分不出唯一时正是这么开的：拿名字当筛词，见 `shell.ts`）——
  // 与「随手打的筛词」不同，这一屏要的是「按来源挑一份」，说清楚才不至于让人以为筛错了
  const sameName = filter === '' ? 0 : (catalog?.skills ?? []).filter((one) => one.name === filter).length

  if (sameName > 1) {
    // 「回车」那半句归状态行（`↑↓ 选 · 回车 定 · esc 收起`）——这里只说**那一下意味着什么**
    // （选定不是发送），一句一事，不跟右位重述键位（独立验收 · 看帧「文案」那一条）
    lines.push(`「${filter}」有 ${sameName} 份同名的——按来源挑一份（选中不等于发送）`)
  } else if (shown === 0 && filter !== '') {
    // 筛空了 ⇒ 抽屉收起、这句话落成回执——得说清「怎么办」，不然就是「打了几个字，抽屉没了」
    lines.push(`没有匹配「${filter}」的技能——退格删一个字，或换个词再打 /skills`)
  } else if (filter !== '') {
    lines.push(`筛选「${filter}」——接着打收窄，退格删一个字`)
  } else if ((catalog?.skills.length ?? 0) === 0) {
    lines.push('还没有技能——放一份 .magic/skills/<名称>/SKILL.md 就来')
  } else {
    lines.push('直接打字可筛选')
  }

  if (shown > 0 && filter === '') {
    // U36：选定＝**把 `/<名字>` 放进这句话里**（放进你打开列表的那个位置），不是发送
    lines.push('选一份就放进这句话里（原位）——选中不等于发送')
  }

  const broken = catalog?.problems.filter((one) => one.kind === 'error').length ?? 0
  if (broken > 0) lines.push(`有 ${broken} 份没能读进来——magic --check 里逐条说得清`)

  return lines.join('\n')
}

/**
 * 候选最多列几条——**实现级常量**（D12 的候选是「边打边筛」的辅助，不是浏览面）。
 *
 * 取 9 的由头：一屏（常见 24 行）里除却记录区与交互区，候选占十行上下是上限；
 * 而技能目录可以很大（份数上限是几十），不封顶的话打一个 `/` 之后打个字母就把整屏占了
 * ——记录区被挤到一两行（活动区的预算正是这么扣的，`dockHeightOf` 一条一条数）。
 *
 * **不是静默截断**：截掉几条由状态行明说（`HINT_COMPLETION` 后面那半句），
 * 而想浏览全量走 `/skills`（那才是浏览面）。
 */
export const MAX_CANDIDATES = 9

/**
 * 哪几行**之前**要画一条分组头。
 *
 * 一处判定、两处用（`picker.ts` 画它 · `app.ts` 数交互区高度）——各写一遍的话，
 * 屏上多出一行而预算没算上，记录区就少一行。
 */
export function groupHeads(rows: readonly PickerRow[]): readonly boolean[] {
  return rows.map((row, index) => row.group !== undefined && row.group !== rows[index - 1]?.group)
}

/**
 * 开选择器——**记录区什么都不进**（原型：回车不进记录区）。
 *
 * ## ⚠️ 0 行**不许接管输入**（P0 · 用户真跑报的「`/grants` 卡死」）
 *
 * 抽屉是**接管输入**的三种用法之一（`Dock` 同一位置）。接管的代价是**作曲家让位**——
 * 屏幕上一个字都打不进去了（`dockOf` 收选择器时不给 `Composer`），而 `key()` 那边
 * 选择器开着时**字符一律吞掉**（`case 'char': if picker → NONE`，这是接管该有的样子）。
 *
 * 那代价**只有在「有东西可点」时才付得起**。0 行时接管过来，用户：**打不了字**、
 * **没得选**、屏上只剩一行暗提示 ⇒ **看着就是卡死**——而 `esc` 那句提示在状态行最右，
 * 不特意看根本注意不到。
 *
 * 而 `/grants` **默认就是这个形态**：没按过 `a` 的工作区没有 `grants.json`，
 * 名录**必空**（`dataDir` 缺省 `~/.magic`）⇒ 头一次打 `/grants` 必落这个坑。
 * `/session` 一条会话都没有时、`/model` 一条条目都没有时、`/skills` 一个技能都没有
 * （或筛词一个都不中）时，同理。
 *
 * 故 0 行时**不开抽屉**：把 `hint`（抽屉下方那句话）落成**记录区一行回执**——
 * 话一句不少、还更显眼，而**输入照常**。`hint` 没给就什么都不说（「拿不到的不编」）。
 *
 * ⚠️ 这是**共用的一处**：四条抽屉（`/session` · `/model` · `/grants` · `/skills`）都经这里，
 * 别在某个调用点另加判断（那样五条路就有五种口径）。
 *
 * ## 一条例外：**正在筛的时候**（U33 · `/skills`）
 *
 * 「0 行不开抽屉」要防的是**没得选的死胡同**。而筛选是另一回事：0 行时用户手上仍有动作
 * ——接着打字、退格删一个字、`esc` 收起——那正是搜索该有的样子（何况筛词本身还写在
 * 列表下方，屏上不是一片空白）。故**有筛词就照开**（行数为 0 也开）：此时零行是
 * **一个回答**（「没有这条」），不是一个空归档。
 *
 * 判据挂在 `picker.filter` 上（「这一屏在筛」是它自己的一位），不是某个调用点另加判断。
 */
export function openPicker(view: ShellView, picker: Picker): ShellView {
  // 「这一屏在筛」——有筛词，或**是 `@` 那一栏**（它一开就带着一段查询：空表的意思是
  // 「还在看 / 这一条对不上」，不是死胡同——用户手上的动作一个不少：打字、退格、`esc`）。
  const filtering =
    (picker.filter !== undefined && picker.filter !== '') || picker.source === 'paths'

  if (picker.rows.length === 0 && !filtering) {
    return picker.hint === undefined ? view : appendReceipt(view, picker.hint)
  }

  // 键位提示按**这一屏能做什么**给：纯读那一屏没有「选定」（见 `HINT_PICKER_READ`）
  const keys = picker.source === 'mcp' ? HINT_PICKER_READ : HINT_PICKER

  return patchStatus({ ...view, dock: { kind: 'picker', picker } }, { hint: keys })
}

/** 上下移动选择。 */
export function movePicker(view: ShellView, delta: number): ShellView {
  if (view.dock.kind !== 'picker') return view

  const { picker } = view.dock
  const count = picker.rows.length
  if (count === 0) return view

  const selected = (picker.selected + delta + count) % count
  return { ...view, dock: { kind: 'picker', picker: { ...picker, selected } } }
}

/** 开一次本地小输入——**接管输入行**（同选择器与裁决卡：同一位置、同一开合）。 */
export function openPrompt(view: ShellView, prompt: PromptState): ShellView {
  return patchStatus({ ...view, dock: { kind: 'prompt', prompt } }, { hint: HINT_PROMPT })
}

/** 收起本地小输入——`esc` **不留痕迹**（无回执、不发命令）。 */
export function closePrompt(view: ShellView): ShellView {
  return view.dock.kind === 'prompt'
    ? patchStatus({ ...view, dock: { kind: 'input' } }, { hint: HINT_IDLE })
    : view
}

/** 收起选择器——`esc` **不留痕迹**（无回执）。 */
export function closePicker(view: ShellView): ShellView {
  return view.dock.kind === 'picker'
    ? patchStatus({ ...view, dock: { kind: 'input' } }, { hint: HINT_IDLE })
    : view
}

/** 当前选中项。 */
export function picked(view: ShellView): PickerRow | undefined {
  if (view.dock.kind !== 'picker') return undefined

  return view.dock.picker.rows[view.dock.picker.selected]
}

// ══ 小工具（纯函数）══════════════════════════════════════════════════

function appendRow(view: ShellView, row: LogRow): ShellView {
  return { ...view, rows: [...view.rows, row] }
}

function replaceLast(view: ShellView, row: LogRow): ShellView {
  return { ...view, rows: [...view.rows.slice(0, -1), row] }
}

function replaceAt(view: ShellView, index: number, patch: (row: LogRow) => LogRow): ShellView {
  return { ...view, rows: view.rows.map((row, at) => (at === index ? patch(row) : row)) }
}

function patchStatus(view: ShellView, patch: Partial<ShellStatus>): ShellView {
  return { ...view, status: { ...view.status, ...patch } }
}

/** 本轮工具计数 ＋1（多件裁决报数的取材）。 */
function countTool(view: ShellView): ShellView {
  return { ...view, turnTools: view.turnTools + 1 }
}

/** 该次调用在本轮工具里的第几件（从 1 起）。 */
function toolIndex(view: ShellView, call: RecordId): number {
  const tools = view.rows.filter(
    (row): row is Extract<LogRow, { kind: 'tool' }> => row.kind === 'tool',
  )
  const at = tools.findIndex((row) => row.call === call)

  return at === -1 ? tools.length : at + 1
}

function patchTool(
  view: ShellView,
  index: number,
  patch: (row: Extract<LogRow, { kind: 'tool' }>) => LogRow,
): ShellView {
  const row = view.rows[index]
  if (row === undefined || row.kind !== 'tool') return view

  return replaceAt(view, index, () => patch(row))
}

function findToolIndex(
  view: ShellView,
  predicate: (row: Extract<LogRow, { kind: 'tool' }>) => boolean,
): number {
  return view.rows.findIndex(
    (row): row is Extract<LogRow, { kind: 'tool' }> => row.kind === 'tool' && predicate(row),
  )
}

function indexOfCall(view: ShellView, call: RecordId): number {
  return findToolIndex(view, (row) => row.call === call)
}

/** 增量 → 行（末行继续接，遇 `\n` 断开）。 */
function appendText2(lines: readonly string[], text: string): readonly string[] {
  const chunks = text.split('\n')
  const last = lines[lines.length - 1]
  const head = last === undefined ? [] : lines.slice(0, -1)

  if (chunks.length === 1) return [...head, (last ?? '') + (chunks[0] ?? '')]

  return [...head, (last ?? '') + (chunks[0] ?? ''), ...chunks.slice(1)]
}

function argsJson(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(args)
}

/** 文本 → 行（结果 / 输出共用）。 */
export function textOfLines(text: string): readonly string[] {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  return lines
}

function secondsLabel(delayMs: number): string {
  return `${(delayMs / 1000).toFixed(1)}s `
}

function tierLabel(tier: ModelErrorTier): string {
  if (tier === 'transient') return '瞬时'
  if (tier === 'context-limit') return '超限'
  return '终态'
}

/** 穷尽性检查——新增 kind 时这里编译不过（好过静默漏渲染）。 */
function assertNever(event: never): ShellView {
  throw new Error(`未处理的事件：${JSON.stringify(event)}`)
}
