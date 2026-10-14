import type { InputPurpose, MagicConfig, StoredInput } from '@magic/contracts'
import { isTurnTimingEvent, type TurnTimingEvent } from '@magic/contracts'
import { foldRound, type RoundTiming } from './round.ts'
import type { GrantsCatalog } from './view/grants.ts'
import type { McpCatalog } from './view/mcp.ts'
import { modelLabel } from './view/models.ts'

import type { ModelSelectionRef } from '@magic/contracts'

import type {
  AgentId,
  BlobRef,
  CollaborationView,
  DecisionWeight,
  Entry,
  EventDataOf,
  InputRefEntry,
  KernelEvent,
  ModelCatalogRow,
  ModelErrorTier,
  ModelRef,
  PlanNote,
  PlanSnapshot,
  ReasoningSetting,
  RecordId,
  RunNotice,
  RunRow,
  RunSnapshot,
  RunState,
  SessionId,
  SessionSummary,
  SkillCatalogRow,
  SnapshotDecision,
  SnapshotTool,
  StatusLineConfig,
  StopPhase,
  StopScope,
  UsedSkill,
  UsedSkillEntry,
  VendorInfo,
} from '@magic/contracts'
import { mcpToolLabel, parseMcpToolName } from '@magic/contracts'
// 草稿里那几处引用的形态（外壳侧）——纯编辑规则在 `./components/inline.ts`
import type { DraftRef } from './components/inline.ts'
import { MARKS } from './marks.ts'

function toolNameOf(name: string): string {
  const external = parseMcpToolName(name)
  return external === undefined ? name === 'consult_arcane' ? '咨询 Arcane' : name : mcpToolLabel(external)
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
export type ToolRunState = 'running' | 'ok' | 'failed' | 'rejected' | 'unexecuted' | 'interrupted'

export const INTERRUPTED_TEXT = '已停止 · 结果未确认'

/** 记录区的一行。`session` 那三类是**会话内容**，其余是**屏上痕迹**。 */

export type UserImage = {
  /** 正文里那一段是什么（`Image#1`）。 */
  readonly marker: string
  /** 人读的名字（元数据，不是身份）——「加入本次输入」之后那一行还报得出来。 */
  readonly name: string
  readonly mime: string
  /** 字节所在（**不透明**，同 `BlobRef`）。 */
  readonly blob: BlobRef
  /** 来源真路径——可能已经不在了（取回不依赖它）。 */
  readonly source: string
  /** 来源的人读写法。 */
  readonly label: string
}

export type LogRow =
  | { readonly kind: 'round'; readonly key: string; readonly timing: RoundTiming }
  // —— 会话内容（落库 · 可重建）——
  | {
      readonly kind: 'user'
      readonly key: string
      readonly text: string
      readonly inputRef?: string
      readonly inputState?: string
      readonly echoed: boolean

      readonly images?: readonly UserImage[]

      readonly skills?: readonly UsedSkill[]
    }
  | { readonly kind: 'assistant'; readonly key: string; readonly text: string; readonly entry?: RecordId }

  | {
      readonly kind: 'thinking'
      readonly key: string
      readonly text: string
      /** 起算时刻（第一条思考增量的 `at`）；**接回那一路没有它**（`null` ⇒ 那一行不报计时）。 */
      readonly startedAt: number | null
      /** 最后一条思考增量的 `at`——收梢之后计时就钉在它上面。 */
      readonly lastAt: number | null
      /** **还在流**（此刻正吐字）——`false` ＝ 那一段已经收梢（定住）。 */
      readonly flowing: boolean
    }
  | {
      readonly kind: 'tool'
      readonly key: string
      /** `tool.call` 事件的 id——请求 / 询问 / 裁决 / 结果四处同指它。未配对时为 `null`。 */
      readonly call: RecordId | null
      readonly name: string
      /** 参数（流式片段累积；`tool.call` 到时落定）。 */
      readonly argsText: string

      readonly args: Readonly<Record<string, unknown>> | null
      readonly state: ToolRunState

      readonly elapsedMs: number | null
      /**
       * **起算时刻** —— `tool.call` 的 `at`；**批准之后换成裁决那一刻**（见
       * `reduceVerdict`：重新起算＝「从零开始」）。
       */
      readonly startedAt: number | null

      readonly awaitingDecision?: true
      /** 结果 / 输出的行（dim 缩进块）。 */
      readonly output: readonly string[]

      readonly bulk?: true

      readonly quiet?: true
    }

  | { readonly kind: 'toolgroup'; readonly key: string; readonly names: readonly string[] }
  // —— 屏上痕迹（不落库 · 不重建）——
  /**
   * **启动字标**（品牌视觉 · TUI Banner）——记录区**最前面那一块**，启动印一次。
   *
   * 归**屏上痕迹**那一类（不落库、不进上下文）：它是装饰，不是「这一趟发生过什么」。
   * 但它与其余痕迹有两点不同，两点都有由头：
   *
   * - **它比其余痕迹优先**——`rebuild` 把 `settled` 整个换掉时，它得**留在最前面**
   *   （见 `bannerFirst`）。不保这一手，`resume` 接续那条路开局就把它换没了
   *   （同一笔账，`ShellOptions.receipts` 已经吃过一次）。
   * - **它不带宽度**——画哪一版由**渲染层按当时的列数**挑（`components/log.ts` 的
   *   `case 'banner'` → `bannerOf`）。列数只有渲染层知道（`useWindowSize`），
   *   视图这层没有它，也不该去猜一个（「拿不到的不编」）。
   */
  | { readonly kind: 'banner'; readonly key: string }
  | { readonly kind: 'output'; readonly key: string; readonly lines: readonly string[] }
  | { readonly kind: 'receipt'; readonly key: string; readonly text: string; readonly source?: RunNotice['source'] }

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

export type PlanProjection = PlanSnapshot

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
  readonly session?: SessionId
  readonly submitted?: boolean
  readonly selected?: number
  readonly top?: number
  readonly member?: string
  /** **配对键**——`tool.decision.request` 事件的 id（答复原样带回）。 */
  readonly id: RecordId
  readonly call: RecordId
  readonly name: string
  /** 判断材料——diff / 命令分解 / 影响面（**内联**，不另套容器）。 */
  readonly material: string
  readonly weight: DecisionWeight

  readonly external?: boolean

  readonly host?: string
  /**
   * 多件裁决的**第几件 / 共几件**（原型 · 场景 7：件数报两处——卡上 ＋ 状态行）。
   * 单件时 `null`（不报数）。
   */
  readonly position: { readonly index: number; readonly total: number } | null
}

/** 选择器的一行。 */
export type PickerRow = {
  readonly detail?: readonly string[]
  readonly label: string
  readonly meta: string
  /** 当前那一条（原型 · 场景 9：`正在用`）。 */
  readonly current: boolean
  /** 选定后要用的值（会话 id / 条目名 / **技能目录真路径**）。 */
  readonly value: string

  readonly group?: string

  readonly pick?: ModelRef

  readonly reasoning?: ReasoningSetting

  readonly pinned?: boolean
  /**
   * **压暗**——「别的项目」的行（工作区≠你此刻所在的那个）。
   * 这是**视觉次序**，不是可用性：压暗的行**照样选得中、切得过去**。
   */
  readonly faint?: boolean
  /**
   * **明确撤销**（`/grants`）——这一行要发的撤销负载（`grants.revoke` 的两件）。
   *
   * 只有授权那个抽屉给：别的选择器「选定」是**切过去**，授权这里「选定」是**撤掉它**
   * （B13 的一句规格）。故这一位存在＝回车之后要发一条撤销，而不是打开什么。
   */
  readonly revoke?: { readonly workspace?: string; readonly index?: number }

  readonly oneLine?: boolean
  /**
   * **必留的那一段**（`oneLine` 行用）——它是 `meta` 的**前缀**（如 MCP 那行的状态说法、
   * 连接那行的连接名）。
   *
   * 由头（独立验收二轮）：一行的额度是「名称 ＋ meta」两段分，而**截断该落在 meta 的后半**
   * （设计 · 终端交互：「窄窗先保住名称、再截断简述」）。渲染层光看 `meta` 不知道
   * 哪一截不许被挤掉——量错地方就会在宽窗下也去截名称（那正是二轮退回的那条「过正」）。
   * 故由**造行的人**（它知道哪一段必留）把这一格交出来，渲染层据它留额度：
   * 名称按需取，但**先扣掉这一段**。
   *
   * ⚠️ 与 `meta` 同源、是它的前缀——两格给同一串不重复：`meta` 是整行要写的字，
   * 这一格只说「其中哪一部分不许被挤掉」。
   * ⚠️ **技能那一行不给这一格**（2026-09-25 起）：它的 meta 只有简述，没有必留段。
   */
  readonly keep?: string
}

/** 选择器（`/resume` · `/model` · `/grants` · `/skills` · `@` 路径）——**只在左下开**。 */
export type Picker = {

  readonly source:
    | 'background'
    | 'background-detail'
    | 'collaboration'
    | 'collaboration-member'
    | 'collaboration-stop'
    | 'collaboration-records'
    | 'collaboration-discussions'
    | 'session'
    | 'session-actions'
    | 'session-history'
    | 'model'
    | 'grants'
    | 'input-purpose'
    | 'input-pending'
    | 'input-detail'
    | 'grants-detail'
    | 'paths-info'
    | 'skills'
    | 'paths'
    | 'mcp'
    | 'vendor'
    | 'provider'
    | 'provider-detail'
    | 'model-editor'
    | 'model-manual'
    | 'model-choice'
    | 'model-detail'
    | 'model-reasoning'

    | 'config'

    | 'task'

    | 'statusline'

  readonly title?: string
  readonly rows: readonly PickerRow[]
  readonly selected: number
  /** 关联记录在原交互层内阅读，不换会话、不抄进原会话日志。 */
  readonly reader?: { readonly key: string; readonly title: string; readonly rows: readonly LogRow[]; readonly top: number }
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
  readonly detail?: readonly string[]
  /** 当前焦点详情的折行位置；原始正文始终保留。 */
  readonly detailTop?: number
  readonly filterCaret?: number
  readonly filter?: string

  readonly anchor?: { readonly start: number; readonly end: number }
}

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

  | { readonly kind: 'prompt'; readonly prompt: PromptState }

/** 一条命令的样子（候选里给「名字 ＋ 一句话说明」）。 */
export type CommandSpec = {
  readonly name: string
  readonly summary: string
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: '/connect', summary: '重连当前会话并刷新，保留草稿' },
  { name: '/clear', summary: '新建会话并清屏，保留历史记录' },
  { name: '/ps', summary: '查看协作成员与后台命令' },
  { name: '/resume', summary: '查看记录或接回工作' },
  { name: '/rename', summary: '修改当前会话名称' },

  { name: '/exit', summary: '停止当前工作并退出界面' },
  { name: '/status', summary: '查看会话、模型、用量与调用状态' },

  { name: '/config', summary: '调整终端、模型、授权与工具设置' },
  { name: '/model', summary: '选择工作模型与思考等级' },
  { name: '/grants', summary: '查看或撤销工作区授权' },

  { name: '/skills', summary: '浏览或搜索技能，选定后加入草稿' },

  { name: '/mcp', summary: '查看外部工具服务器和工具' },
  { name: '/help', summary: '显示帮助' },
]

/** 候选状态——`selected` 是**筛过之后**的次序。 */
export type CompletionState = {
  readonly candidates: readonly CommandSpec[]
  readonly selected: number
}

export function matchCommands(
  word: string,
  skills: readonly SkillCatalogRow[] = [],

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

export function activeWordOf(draft: string, caret: number): ActiveWord | undefined {
  const at = Math.max(0, Math.min(caret, draft.length))
  const head = draft.slice(0, at)
  const start = head.search(/[^\s]*$/)
  const word = head.slice(start)
  if (!word.startsWith('/')) return undefined

  return { start, end: at, word, atStart: /^\s*$/.test(draft.slice(0, start)) }
}

function skillCommands(word: string, skills: readonly SkillCatalogRow[]): readonly CommandSpec[] {
  if (word.replace(/^\//, '') === '') return []

  const reserved = new Set(COMMANDS.map((command) => command.name))
  const commands: CommandSpec[] = []

  for (const skill of skills) {
    const name = `/${skill.name}`
    if (reserved.has(name)) continue

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

function hintKeepingDock(from: ShellView, next: string): string {
  return from.dock.kind === 'input' ? next : from.status.hint
}

export type StatusState = 'background' | 'idle' | 'working' | 'waiting' | 'retrying' | 'error' | 'lost'

/** 空闲态右位提示。 */
export const HINT_IDLE = '/ 命令 · ctrl+c 退出'

export const HINT_LOST = '/connect 重连 · ctrl+r 刷新 · ctrl+c 退出'

export const HINT_WORKING = 'Esc 停止 · ctrl+c 停或离开'
/** 退避中右位提示（后段动态：`1.6s 后重发 · 不用管`）。 */
export const HINT_RETRYING_TAIL = '后重发 · 不用管'
/** 裁决态右位提示（必闸类没有 `a`）。 */
export const HINT_DECIDE_LIGHT = '↑↓ 选择 · Enter 确认 · Esc 返回'
export const HINT_DECIDE_HEAVY = HINT_DECIDE_LIGHT

export const HINT_BOOTING = '启动中——恢复跑完才受理输入'
/** 临时层提示留在菜单；纯列表支持 ← 返回，字段保留光标编辑。 */
export const HINT_PICKER = '↑↓ 选择 · Enter 选定 · ← / Esc 返回'
/**
 * **纯读那一屏**的右位提示（`/mcp`）——没有「选定」这回事，故不报「回车 定」。
 *
 * 由头：键位提示得**对得上键位**。`/mcp` 的抽屉里回车什么都不做（重连是另一条命令，
 * 明写 `/mcp reconnect <名字>`），照抄 `HINT_PICKER` 就是教用户按一个没有用的键。
 */
export const HINT_PICKER_READ = '↑↓ 选择 · ← / Esc 返回'

export const HINT_PICKER_SESSION = '↑↓ 选择 · 打字筛选 · Ctrl+G 操作 · Esc 返回'

/** 设置筛词原位编辑；Esc 退当前层。 */
export const HINT_PICKER_CONFIG = '↑↓ 选择 · 输入筛词 · Esc 返回'

export const HINT_PICKER_TASK = '↑↓ 选 · 回车 定 · esc 返回'

export const STOP_KEYS_HINT = 'ctrl+x 停 · ctrl+w 只停这一轮'

export function stopReceiptOf(input: {
  readonly title: string
  readonly scope: StopScope
  readonly phase: StopPhase
  readonly note?: string | undefined
}): string {
  const who = `「${input.title}」`
  const why = input.note === undefined || input.note === '' ? '' : `：${input.note}`

  if (input.scope === 'turn') {
    return input.phase === 'done'
      ? `只停了${who}这一轮——那条运行还在（可以接着用）`
      : `没能中断${who}那一轮${why}`
  }

  switch (input.phase) {
    case 'accepted':
      return `正在停${who}${why}`
    case 'done':
      return `${who}停了${input.note === undefined ? '' : `（${input.note}）`}`
    case 'unconfirmed':
      return `没能停掉${who}${why}`
  }
}
/** 自动补全右位提示（原型 · 场景 11）。 */
export const HINT_COMPLETION = '↑↓ 选 · Tab 补全 · esc 收起'

/** 通知只关联当前实际内容，不生成完成／审批回执。 */
export function presentedNoticeOf(view: ShellView): string | undefined {
  const notice = view.notice
  if (!notice?.unread) return
  const source = notice.source
  if (notice.kind === 'needs-you') {
    const pending = view.dock.kind === 'decision' ? view.dock.pending : view.pendingDecision
    return source?.event !== undefined && pending?.id === source.event && pending.session === source.session ? notice.id : undefined
  }
  return view.settled.some(row => notice.kind === 'done'
    ? source?.session === view.sessionId && source.entry !== undefined && row.kind === 'assistant' && row.entry === source.entry && row.text.trim() !== ''
    : row.kind === 'receipt' && (row.key === `notice:${notice.id}` || (source?.event !== undefined && row.source?.session === source.session && row.source.event === source.event)))
    ? notice.id : undefined
}

export function unreadSummaryOf(notices: readonly RunNotice[]): string | undefined {
  const unread = notices.filter((one) => one.unread)
  if (unread.length === 0) return undefined

  const count = (kind: RunNotice['kind']): number =>
    unread.filter((one) => one.kind === kind).length
  const said: string[] = []
  if (count('done') > 0) said.push(`${count('done')} 项跑完`)
  if (count('failed') > 0) said.push(`${count('failed')} 项出错`)
  if (count('needs-you') > 0) said.push(`${count('needs-you')} 项等你`)

  return `你不在的时候：${said.join(' · ')} —— /resume 看是哪几条`
}

export const HINT_PROMPT = 'Enter 确定 · ←/→ 编辑 · Esc 取消'

export const HINT_EXIT_ARMED = '再按一次 ctrl+c 退出'

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

  readonly window: number | null

  readonly reasoning: string | null

  readonly allowAll: boolean
  /** 右位提示——**独立一栏，出现/消失不推动左半**。 */
  readonly hint: string
}

// ══ 一屏 ═════════════════════════════════════════════════════════════

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
  /** Engine 当前提醒的来源；只用于确认对应内容已呈现。 */
  readonly notice?: RunNotice | undefined
  readonly round: RoundTiming | null
  /** 从现有审批队列投影；Esc 返回后仍可见。 */
  readonly pendingDecision?: PendingDecision | undefined
  readonly pendingInputs: readonly StoredInput[]
  readonly inputPurpose: InputPurpose
  readonly collaboration?: CollaborationView
  readonly background?: import('@magic/contracts').BackgroundView
  readonly inputMember?: AgentId
  /** **本轮**的行——还在流式、还会变（活动区就地重绘）。 */
  readonly rows: readonly LogRow[]

  readonly settled: readonly LogRow[]

  readonly page: number

  readonly completion: CompletionState | null
  readonly status: ShellStatus
  readonly dock: Dock
  /** 输入草稿——**归模型**（接管时收进 `stashed`，答完原样归还）。 */
  readonly draft: string

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

  readonly refs: readonly DraftRef[]
  /** 接管期间「不静默吞键」的提示（一次性，按下一个键即清）。 */
  readonly flash: string | null

  readonly exitArmed: boolean

  readonly leaving: boolean
  /** 当前绑定会话的 Engine 归档投影，目录筛选不改变此事实。 */
  readonly archived: boolean
  /** 当前会话 id（还没有会话＝`null`）。 */
  readonly sessionId: SessionId | null
  /** 会话目录（`session.list` 的答复）。 */
  readonly catalog: readonly SessionSummary[]

  readonly runs: readonly RunRow[]

  readonly grants: GrantsCatalog | null

  readonly skills: SkillsCatalog | null

  readonly paths: PathsCatalog | null

  readonly mcp: McpCatalog | null
  /**
   * **连接一览**（`model.catalog` / `provider.catalog` 的答复）——`/model` 与 `/model manage`
   * 两屏的取材（同一份行，内核那边就是一处产出）。
   *
   * ⚠️ 与 `catalog` 分开：那个是**会话**目录（`SessionSummary`）——同名不同物，别合。
   */
  readonly models: readonly ModelCatalogRow[]

  readonly vendors: readonly VendorInfo[]

  readonly modelCurrent: ModelSelectionRef | null

  readonly configuredModels: NonNullable<MagicConfig['models']>
  /** 本轮已出现的工具调用数（多件裁决报 `n/m` 的取材——只数本轮）。 */
  readonly turnTools: number

  readonly plan: PlanProjection

  readonly planCollapsed: boolean

  readonly planTop: number

  readonly echoes: number

  readonly taskEntry: RecordId | null

  readonly statusLine: StatusLineConfig | undefined

  readonly turnDuration: 'elapsed' | 'active'
  readonly reducedMotion: boolean

  readonly workspace: string | null
}

/** 空视图。 */

export type CreateViewInput = {
  readonly statusLine?: StatusLineConfig | undefined
  readonly turnDuration?: 'elapsed' | 'active' | undefined
  readonly reducedMotion?: boolean | undefined
  readonly workspace?: string | null | undefined
}

export function createView(input: CreateViewInput = {}): ShellView {
  return {
    round: null,
    rows: [],
    settled: [],
    // 开机那一页（此后每换一条会话 ＋1——见 `ShellView.page`）
    page: 0,
    completion: null,
    status: {
      state: 'idle',
      amount: null,
      session: null,
      model: null,
      usage: null,
      window: null,
      // 思考档：起手什么都不知道（还没问过模型列表）——那一格整格省掉
      reasoning: null,
      // 起手先按「不是」——**报它由执行者给**（见 `ShellStatus.allowAll`），
      // 而执行者还没起来时本来也就没有闸门，没有哪一次放行是「全放行放的」
      allowAll: false,
      hint: HINT_IDLE,
    },
    dock: { kind: 'input' },
    pendingInputs: [], inputPurpose:'current',
    draft: '',
    caret: 0,
    refs: [],
    stashed: null,
    flash: null,

    exitArmed: false,

    leaving: false,
    archived: false,
    sessionId: null,
    catalog: [],
    runs: [],
    skills: null,
    paths: null,
    mcp: null,
    models: [],
    vendors: [],
    modelCurrent: null,
    configuredModels: {},
    grants: null,
    turnTools: 0,
    // **没有计划**（不占位）· 默认展开（设计）· 视口从头开始
    plan: { entry: null, plan: null },
    planCollapsed: false,
    planTop: 0,
    echoes: 0,
    taskEntry: null,

    statusLine: input.statusLine,
    turnDuration: input.turnDuration ?? 'elapsed',
    reducedMotion: input.reducedMotion === true,
    workspace: input.workspace ?? null,
  }
}

export function workspaceLabelOf(roots: readonly string[] | undefined): string | null {
  if (roots === undefined || roots.length === 0) return null
  if (roots.length > 1) return `${roots.length} 个根`

  const parts = (roots[0] ?? '').split('/').filter((piece) => piece !== '')

  return parts[parts.length - 1] ?? '/'
}

export type SkillsCatalog = EventDataOf['skills.catalog']

export type PathsCatalog = EventDataOf['paths.catalog']

// ══ 归约（事件 → 一屏）═══════════════════════════════════════════════

export type PageTurn = 'new' | 'open'

export function reduce(
  view: ShellView,
  event: KernelEvent,
  options: { readonly turn?: PageTurn | null; readonly timing?: boolean } = {},
): ShellView {
  if (options.timing !== false && isTurnTimingEvent(event) && (view.sessionId === null || event.session === view.sessionId)) {
    const round = foldRound(view.round, event)
    view = { ...view, round }
  }
  switch (event.kind) {
    case 'model.delta':
      return reduceDelta(view, event.id, event.data, event.at)

    case 'tool.call':
      return reduceToolCall(view, event.id, event.data, event.at)
    case 'tool.output.delta':
      return reduceToolOutput(view, event.data)
    case 'tool.result':
      return reduceToolResult(view, event.data, event.at)
    case 'tool.decision.request': {
      const next = reduceDecision(view, event.id, event.data)
      const member = view.collaboration?.members.find((one) => one.agent.sessionId === event.session)?.agent.name
      return member === undefined || next.dock.kind !== 'decision' ? next : {
        ...next, dock: { kind: 'decision', pending: { ...next.dock.pending, member } },
      }
    }
    case 'tool.decision':
      return reduceVerdict(view, event.data, event.at)

    case 'message.user':

      return reduceUserEntry({ ...view, taskEntry: event.data.entry,
        sessionId: view.sessionId ?? (event.session || null) })
    case 'message.assistant':
      return { ...view, rows: view.rows.map(row => row.kind === 'assistant' && row.entry === undefined
        ? { ...row, entry: event.data.entry } : row) }

    case 'turn.start':
      return patchStatus({ ...clearFlash(view), turnTools: 0, notice: undefined }, {
        state: 'working',
        amount: null,
        hint: hintKeepingDock(view, HINT_WORKING),
      })
    case 'turn.end':

      const final = !event.data.continues && view.round?.end !== null && view.round !== null
        && ![...view.settled, ...view.rows].some(row => row.key === view.round?.key)
        ? { ...view, rows: [...view.rows, { kind: 'round' as const, key: view.round.key, timing: view.round }] } : view
      const settled = settle(undock(final))
      return patchStatus(settled, {
        state: event.data.continues ? 'working' : event.data.reason === 'error' ? 'error' : 'idle',
        amount: null,
        // ⚠️ `undock` 在前：卡收了之后 `dock` 回到输入行 ⇒ 这一格**才**归本状态
        hint: hintKeepingDock(settled, event.data.continues ? HINT_WORKING : HINT_IDLE),
      })

    case 'agent.state':
    case 'agent.start':
    case 'agent.end':
      return view

    case 'model.call.start':

      return patchStatus(view, {
        model: event.data.choice === undefined ? view.status.model : modelLabel(event.data.choice),
        window: event.data.inputBudget ?? null,
      })
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

    case 'paths.catalog':
      return { ...view, paths: event.data }

    case 'model.switched':
      // 一次性的事**进记录区当回执**（状态行只放「此刻」）；成了顺手更新 ③ **和 ④ 的分母**
      // （换过去那一刻分母就得跟着走——**切换事件自己带着新预算**；未知＝`null`，
      // **不沿用换之前那个模型的容量**）。**没换成＝原样不动**（切不动就不动）。
      return appendReceipt(
        event.data.ok && event.data.model !== undefined
          ? patchStatus({ ...view, modelCurrent: event.data.provider === undefined || event.data.choice === undefined || event.data.protocol === undefined || event.data.endpoint === undefined ? view.modelCurrent : { protocol: event.data.protocol, endpoint: event.data.endpoint, choice: event.data.choice, provider: event.data.provider, model: event.data.model, ...(event.data.reasoning === undefined ? {} : { reasoning: event.data.reasoning }) } }, {
              model: event.data.choice === undefined ? view.status.model : modelLabel(event.data.choice),
              window: event.data.inputBudget ?? null,
            })
          : view,
        event.data.ok
          ? `已选择 ${event.data.choice === undefined ? '模型' : modelLabel(event.data.choice)}`
          : `换模型未成：${event.data.reason ?? '未说缘由'}`,
      )

    case 'model.catalog':
      return {
        ...view,
        models: event.data.entries,
        // **此刻会走哪一条**——答复说没有（还没选过模型）就落回 `null`：不沿用上一条，
        // 也不拿列表首项顶上（那不是「此刻在用的」，是个编出来的事实）
        modelCurrent: event.data.current ?? null,

        configuredModels: event.data.configuredModels ?? {},
        status: { ...view.status, model: event.data.current === undefined ? view.status.model : modelLabel(event.data.current.choice), window: event.data.currentInputBudget ?? null },
      }

    case 'provider.catalog':
      return {
        ...view,
        models: event.data.entries,
        // 内置供应商与官方区域——名单随答复来、**不落壳里**（适配现取，契约的 `VendorInfo`）
        vendors: event.data.vendors,
      }

    case 'grants.catalog':
      return { ...view, grants: event.data }

    case 'skills.catalog':
      return { ...view, skills: event.data }

    case 'mcp.catalog':
      return { ...view, mcp: event.data }

    case 'plan.changed':
      if (view.sessionId !== null && event.session !== view.sessionId) return view

      return withPlan(view, event.data.entry, event.data.plan)

    case 'session.managed':
      return view
    case 'session.changed':
      return { ...view, archived: event.data.session === view.sessionId || event.data.session === view.collaboration?.originSession ? event.data.archived : view.archived,
        catalog: view.catalog.map(one => one.id === event.data.session ? { ...one, ...event.data } : one) }
    case 'session.state':
      return reduceSessionState(view, event.data, options.turn ?? null)

    // 读面答复——**攒与重建归外壳**（`shell.ts` 里按块收，收齐了调 `rebuild`）；
    // 归约这层收到它就丢（它不逐条进记录区）
    case 'session.history':
      return view

    case 'skill.used':
      return appendReceipt(
        view,
        `本次使用技能：${event.data.skills.map((one) => one.name).join(' · ')}`,
      )

    case 'input.unread':
      return event.data.markers.length === 0
        ? view
        : appendReceipt(view, `本次没读：${event.data.markers.join(' · ')}`)

    case 'input.pending':
      return event.data.note === undefined ? {...view,pendingInputs:event.data.inputs} : appendReceipt({...view,pendingInputs:event.data.inputs},event.data.note)
    case 'input.settled':
      { const inputState = event.data.ok ? (event.data.stage === 'included' ? undefined : view.pendingInputs.find(one=>one.ref===event.data.ref)?.purpose==='next'?'下一件排队中':'待带入') : `失败：${event.data.reason ?? '未说缘由'}`
        if(event.data.ref!==undefined){const update=(row:LogRow)=>row.kind==='user'&&row.inputRef===event.data.ref?{...row,inputState}:row;view={...view,rows:view.rows.map(update),settled:view.settled.map(update)}} }
      return event.data.ok ? view : appendReceipt(view, `没送出：${event.data.reason ?? '未说缘由'}`)

    case 'exec.background.done':
      return appendReceipt(view, backgroundDoneText(event.data))

    case 'model.error':
      return patchStatus(
        appendReceipt(view, `模型错误（${tierLabel(event.data.tier)}）：${event.data.message}`, { session: event.session, event: event.id }),
        { state: 'error', amount: null, hint: HINT_IDLE },
      )
    case 'error':
      return patchStatus(appendReceipt(view, `内核异常：${event.data.message}`, { session: event.session, event: event.id }), {
        state: 'error',
        amount: null,
        hint: HINT_IDLE,
      })

    case 'context.compacted':
      return view

    case 'background.state':
      return { ...view, background: event.data }
    case 'paths.identified':
    case 'collaboration.view':
      return view

    case 'input.pasted':
      return view

    case 'image.exported':
      return appendReceipt(view, event.data.path === undefined ? `原图没能导出：${event.data.problem ?? '（没说为什么）'}` : `原图已导出 → ${event.data.path}`)

    case 'input.local':
    case 'prefs.state':
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

function reduceDelta(view: ShellView, id: RecordId, data: DeltaData, at: number): ShellView {
  if (data.channel === 'text') {

    return appendText(closeThinking(view), id, 'assistant', data.text, at)
  }
  if (data.channel === 'thinking') return appendText(view, id, 'thinking', data.text, at)

  return appendToolFragment(closeThinking(view), id, data.name, data.id, data.text)
}

function appendText(
  view: ShellView,
  id: RecordId,
  kind: 'assistant' | 'thinking',
  text: string,
  /** 这一片增量的时刻（事件自己的 `at`）；**接回那一路没有它**（`null` ⇒ 那一行不报计时）。 */
  at: number | null,
): ShellView {
  const last = view.rows[view.rows.length - 1]

  if (last?.kind === kind && (last.kind !== 'assistant' || last.entry === undefined)) {
    // **还在流**：起算不动，只把「最后吐字那一刻」往前推（收梢时拿它当终点）
    return replaceLast(
      view,
      last.kind === 'thinking'
        ? { ...last, text: last.text + text, lastAt: at ?? last.lastAt, startedAt: last.startedAt ?? at }
        : { ...last, text: last.text + text },
    )
  }

  return appendRow(
    view,
    kind === 'thinking'
      ? { kind, key: `${kind}:${id}`, text, startedAt: at, lastAt: at, flowing: true }
      : { kind, key: `${kind}:${id}`, text },
  )
}

function closeThinking(view: ShellView): ShellView {
  const last = view.rows[view.rows.length - 1]
  if (last?.kind !== 'thinking' || !last.flowing) return view

  return replaceLast(view, { ...last, flowing: false })
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
  return addToolOutput(view, data.call, data.text)
}

/**
 * 往某一行的工具输出尾部接一段——**增量与接回快照共用这一处**。
 *
 * 共用是为了「两处各写一套『怎么接』」那类分叉：接回来的那几行与当场看的几行必须
 * 长得一模一样，否则同一条工具在别人屏上是一种折行、在接回来的人屏上是另一种。
 */
function addToolOutput(view: ShellView, call: RecordId, text: string): ShellView {
  const target = indexOfCall(view, call)
  if (target === -1) return view

  return patchTool(view, target, (row) => ({ ...row, output: appendText2(row.output, text) }))
}

type ToolResultData = Extract<KernelEvent, { kind: 'tool.result' }>['data']

function reduceToolResult(view: ShellView, data: ToolResultData, at: number): ShellView {
  const target = indexOfCall(view, data.call)
  if (target === -1) return view

  const bulk = 'blob' in data.output
  const text = 'text' in data.output ? data.output.text : ''
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

    ...(bulk ? { bulk: true as const } : { output: textOfLines(text) }),

    elapsedMs:
      unexecuted || row.state === 'rejected' || row.startedAt === null || at < row.startedAt
        ? null
        : at - row.startedAt,
  }))
}

type VerdictData = Extract<KernelEvent, { kind: 'tool.decision' }>['data']

function reduceVerdict(view: ShellView, data: VerdictData, at: number): ShellView {
  const target = indexOfCall(view, data.call)
  const rows =
    target === -1
      ? view.rows
      : view.rows.map((row, index) => {
          if (index !== target || row.kind !== 'tool') return row
          const { awaitingDecision, ...rest } = row
          return {
                ...rest,
                // 裁决的耗时（提示 → 答复）**不进工具行**——那是裁决的账（见行上 `elapsedMs` 的注）
                ...(data.decision === 'reject' ? { state: 'rejected' as const } : {}),
                // **批准 ⇒ 起算点挪到这一刻**（见上注：批准在执行之前，故是「从零开始」）
                ...(data.decision === 'approve' && awaitingDecision === true
                  ? { startedAt: at }
                  : {}),
              }
        })

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

  const asked = patchTool(view, indexOfCall(view, data.call), (row) => ({
    ...row,
    awaitingDecision: true as const,
  }))

  const pending: ShellView = {
    ...asked,
    dock: {
      kind: 'decision',
      pending: {
        id,
        call: data.call,
        name: data.name,
        material: data.material,
        weight: data.weight,

        ...(data.external === true ? { external: true } : {}),

        ...(data.host === undefined ? {} : { host: data.host }),
        position,
      },
    },
  }

  return withDecisionStatus(takeOver(pending))
}

type SessionStateData = Extract<KernelEvent, { kind: 'session.state' }>['data']

/**
 * 目录回执确认当前会话。普通查询只在已知身份变更时换页；
 * 成功的 /clear 总是清屏，包括尚未创建会话的空白页；忙时拒绝不换页。
 */
function reduceSessionState(view: ShellView, data: SessionStateData, turn: PageTurn | null): ShellView {
  const active = data.active || null
  const switched = view.sessionId !== null && view.sessionId !== active
  const turned = data.note === undefined && (turn === 'new' || (turn === 'open' ? view.sessionId !== active : switched))
  const title = data.sessions.find((row) => row.id === data.active)?.title ?? (active === view.sessionId ? view.status.session : null)

  const base: ShellView = {
    ...view,
    sessionId: active,
    notice: active === view.sessionId ? view.notice : undefined,
    archived: data.sessions.find(row => row.id === active)?.archived ?? (active === view.sessionId && view.archived),
    catalog: data.sessions,
    status: { ...view.status, session: title },
  }

  const after = turned
    ? {
        ...base,
        round: null,
        rows: [],
        // **开一条新的 ⇒ 这一页从字标起**（幂等：`bannerFirst` 先把已有的滤掉再放一个）。
        // 别的路（`/resume`）给的是空的一页——**别在这儿替它补一个**。
        settled: turn === 'new' ? bannerFirst([]) : [],
        page: view.page + 1,
        plan: { entry: null, plan: null },
        planCollapsed: false,
        planTop: 0,
      }
    : base

  return foldRunState(after)
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

  return { ...view, settled: [...view.settled, ...view.rows], rows: [] }
}

// ══ 写入口（外壳用）══════════════════════════════════════════════════

/** 字标那一行的 key——**一屏只有一行**（记录区最前面那一块，不会来第二次）。 */
const BANNER_KEY = 'banner'

/** 字标那一行（渲染层按当时列数挑版，见 `LogRow` 里那一支的注）。 */
function bannerRow(): LogRow {
  return { kind: 'banner', key: BANNER_KEY }
}

function bannerFirst(rows: readonly LogRow[]): readonly LogRow[] {
  return [bannerRow(), ...rows.filter((row) => row.kind !== 'banner')]
}

const PAGE_NOTE_KEY = 'page:note'

/**
 * 一行**开页回执**——只归换会话那一跳（`shell.ts` 的 `turn` 收了场、且带名字的那一支）。
 *
 * 与 `appendReceipt` 只差 key：这样 `pageHeaderOf` 认得出它是页头（见 `PAGE_NOTE_KEY` 的注）。
 */
export function appendPageNote(view: ShellView, text: string): ShellView {
  return appendSettled(view, { kind: 'receipt', key: `${PAGE_NOTE_KEY}:${view.settled.length}`, text })
}

/** 历史到达前已印出的字标、开屏说明或切页回执，保留原位置与对象。
 * Static 按条目数追加；删掉这些已印行会让它跳过后来的正文。
 */
function pageHeaderOf(view: ShellView): readonly LogRow[] {
  return view.settled.filter((row) => row.kind === 'banner' || row.key.startsWith(`${PAGE_NOTE_KEY}:`))
}

export function withBanner(view: ShellView): ShellView {
  return { ...view, settled: bannerFirst(view.settled) }
}

/** 本地回显一次用户输入（提交时立即显示——事件里没有正文）。 */
export function appendEcho(view: ShellView, text: string, images: readonly UserImage[] = []): ShellView {
  // key 用**单调计数**而不是 `rows.length`——后者在收束清空之后会**撞回同一个数**
  // （同一个列表里两个同 key ⇒ React 说「子节点可能重复或丢失」）。见 `ShellView.echoes`。
  return {
    ...appendRow(view, {
      kind: 'user',
      key: `user.echo:${view.echoes}`,
      text,
      echoed: true,
      // 没带图就不给这一格（空数组与「这一格不在」在渲染上同义，少一格少一处可对不上的地方）
      ...(images.length === 0 ? {} : { images }),
    }),
    echoes: view.echoes + 1,
  }
}

export function appendReceipt(view: ShellView, text: string, source?: RunNotice['source']): ShellView {
  return appendSettled(view, { kind: 'receipt', key: `recpt:${view.settled.length}`, text, ...(source === undefined ? {} : { source }) })
}

/** 一块**命令输出**（dim 块，无标记）。**不落库、不重建**（同回执，进定局那侧）。 */
export function appendOutput(view: ShellView, title: string, lines: readonly string[]): ShellView {
  return appendSettled(view, { kind: 'output', key: `out:${view.settled.length}`, lines: [title, ...lines] })
}

export function withContextWindow(view: ShellView, window: number | null): ShellView {
  return patchStatus(view, { window })
}

/** 追加一行**已定局**的行（写一次即入 scrollback）。 */
function appendSettled(view: ShellView, row: LogRow): ShellView {
  return { ...view, settled: [...view.settled, row] }
}

export function rebuild(view: ShellView, entries: readonly Entry[], options: { readonly collapseTools?: boolean; readonly timing?: readonly TurnTimingEvent[] } = {}): ShellView {

  const plan = planFromEntries(entries)
  const fresh = plan.entry !== null && (view.plan.entry === null || plan.entry > view.plan.entry)

  let round: RoundTiming | null = null
  const rounds: RoundTiming[] = []
  for (const event of options.timing ?? []) {
    const next = foldRound(round, event)
    if (next !== null && next !== round && next.end !== null) rounds.push(next)
    round = next
  }
  // 读历史期间新到的事实不能被较旧的读面水位覆盖。
  if (view.round !== null && (round === null || view.round.lastId > round.lastId)) round = view.round
  for (const row of [...view.settled, ...view.rows]) {
    if (row.kind === 'round' && !rounds.some(one => one.key === row.key)) rounds.push(row.timing)
  }
  return {
    ...view,
    settled: [...pageHeaderOf(view), ...rebuildRows(entries, options.collapseTools, rounds)],
    round,
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
function rebuildRows(entries: readonly Entry[], collapseTools = true, rounds: readonly RoundTiming[] = []): readonly LogRow[] {
  const rows: LogRow[] = []
  /** 待配对的那条工具行在 `rows` 里的下标（`-1` ＝ 没有）。 */
  let pendingAt = -1

  const timeline = [...entries, ...rounds.map(timing => ({ kind: 'round' as const, id: timing.lastId, timing }))].sort((a, b) => a.id - b.id)
  for (const entry of timeline) {
    if (entry.kind === 'round') {
      rows.push({ kind: 'round', key: entry.timing.key, timing: entry.timing }); pendingAt = -1; continue
    }
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
        /**
         * **初值是「在跑」，不是「已完成」**——配到结果的那条随后覆盖它。
         *
         * 由头（接回那一路量出来的）：一条 `tool-call` 条目**没有**配对的 `tool-result`
         * 就是**在途**（记录与恢复明文：「从有 `tool.call` 无 `tool.result` 识别在途」）。
         * 早先默认写 `ok`，于是「重开一页 / 切回来看」时，一件**可能还在跑**的工具
         * 在屏上是「✓ 完成」——那正是「把半段当完整结果」。
         */
        state: 'running',
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

        const bulk = 'blob' in entry.content
        const text = bulk ? '' : contentTextOf(entry)
        rows[pendingAt] = {
          ...row,
          // **与事件那一路同判**：读的是**同一位**（条目载荷与事件数据同源，见
          // `ToolResultPayload`）——屏上的样子只该有一种：切了会话 / 重开一页回来，
          // 扣下的那行不能变回「失败」。
          state: payload?.notExecuted === true ? 'unexecuted' : ok ? 'ok' : 'failed',
          // ⚠️ **重建这一路没有流式那份正文**（没跑过，自然没攒下）——行里只有引用，
          // 故只说「大块、没铺全」，展开也没有更多可看（限度见上面那条注释块）
          output: bulk ? [] : textOfLines(text),
          ...(bulk ? { bulk: true as const } : {}),
        }
      }
      pendingAt = -1
      continue
    }

    pendingAt = -1
    const text = contentTextOf(entry)

    if (entry.kind === 'user' && noticeOf(entry.payload)) {

      rows.push({ kind: 'receipt', key: `rb:x:${entry.id}`, text })
    } else if (entry.kind === 'user') {
      const skills = usedSkillsOf(entry.payload)
      const images = imagesOf(entry.payload)
      rows.push({
        kind: 'user',
        key: `rb:u:${entry.id}`,
        text,
        echoed: false,

        ...(images.length === 0 ? {} : { images }),

        ...(skills.length === 0 ? {} : { skills }),
      })
    } else if (entry.kind === 'assistant') rows.push({ kind: 'assistant', key: `rb:a:${entry.id}`, text, entry: entry.id })
    else rows.push({ kind: 'receipt', key: `rb:s:${entry.id}`, text: `（摘要）${text}` })
  }

  return collapseTools ? collapseToolGroups(rows) : rows
}

/**
 * 接回快照在记录区里用的那个「来源 id」——`0` **不在 id 空间里**（记录域从 1 起发号）。
 *
 * 造行要一个 id（键就是 `${kind}:${id}`），而快照里那几段**不是某一条事件**——
 * 它是「此刻的样子」。给 0 是为了让那些行的键一眼看得出是接回来的，且永不与真事件撞号。
 */
const RESUME_SOURCE = 0

/** 执行连接已核销：撤去失效裁决与在飞提示，保留记录和未发送草稿。 */
export function finishExecution(view: ShellView): ShellView {
  const awaiting = view.dock.kind === 'decision' ? view.dock.pending.call : undefined
  const next = undock(view)
  const rows = next.rows.map((row): LogRow => {
    if (row.kind !== 'tool' || row.state !== 'running') return row
    const { awaitingDecision, ...body } = row
    const notExecuted = awaitingDecision === true || row.call === awaiting
    return { ...body,
      state: notExecuted ? 'unexecuted' : 'failed',
      output: [...row.output, notExecuted ? '该询问已失效，未执行' : '执行中断，外部效果待确认'],
    }
  })
  return patchStatus(settle({ ...next, rows }), { state: 'idle', amount: null, hint: HINT_IDLE })
}

export function applyResume(view: ShellView, snapshot: RunSnapshot): ShellView {
  let next = view

  if (snapshot.thinking !== undefined) {
    next = closeThinking(
      appendText(
        next,
        RESUME_SOURCE,
        'thinking',
        snapshot.thinkingTruncated === true ? `（接回只带了末尾）\n${snapshot.thinking}` : snapshot.thinking,
        // **接回没有起点**（那是另一个进程里发生的事）⇒ 不报计时（「拿不到的不编」）
        null,
      ),
    )
  }
  if (snapshot.text !== undefined) {
    next = appendText(
      next,
      RESUME_SOURCE,
      'assistant',
      snapshot.textTruncated === true ? `（这一段太长，接回只带了末尾）\n${snapshot.text}` : snapshot.text,
      null,
    )
  }

  for (const tool of snapshot.tools) {
    next = adoptTool(next, tool)
    for (const line of tool.output) next = addToolOutput(next, tool.call, `${line}\n`)
  }

  /**
   * ⚠️ **状态行先铺、裁决卡后挂**：卡一挂上就把输入接管了，它那句键位提示也该压过
   * 「ctrl+c 中断」——次序反了的话，接回来的人看着一张卡，状态行却说「中断」。
   */
  if (snapshot.turnOpen) {
    next = patchStatus(next, { state: 'working', amount: null, hint: HINT_WORKING })
  }
  // 在跑的是哪个模型 / 它的窗——不画回去的话，状态行左半边是空的（同一个界面两种样子）
  if (snapshot.model !== undefined) {
    next = patchStatus(next, { model: snapshot.model, window: snapshot.window ?? null })
  }

  next = patchStatus(next, { allowAll: snapshot.allowAll === true })

  if (snapshot.decisions.length > 0 && next.dock.kind !== 'decision') {
    const one = snapshot.decisions[0] as SnapshotDecision
    next = reduceDecision(next, one.id, {
      call: one.call,
      name: one.name,
      material: one.material,
      weight: one.weight,
      ...(one.external === true ? { external: true } : {}),
    })
  }

  return next
}

/**
 * **把一笔在飞的工具认到屏上**（接回用）——三条路，各对一种现状：
 *
 * 1. **屏上已经有它**（`call` 对得上）⇒ 把它标回「在跑」（重建那一路初值本就如此，
 *    这里补的是「实时那一行」）；
 * 2. **记录里有一笔对得上、还没有结果的**（切回来时记录已经铺好了）⇒ **认领**过来：
 *    那一行的 `call` 改写成这一次调用的 id，此后它的输出与结果就都落在它身上了。
 *    配对的判据是**工具名 ＋ 参数**——两处说的是**同一次调用**（同一个 `ToolCall`），
 *    不是「拿名字猜」：名字与参数都在事件上，逐字比得出来；
 * 3. **哪儿都没有** ⇒ 照事件那一路新起一行。
 *
 * ⚠️ 第 2 条要的由头：条目与事件**各有各的 id**（契约明文：`tool-call` 载荷「**不带**
 * `call` 引用——条目自身即那次调用」）。不认领的话，接回来那一笔的结果**永远落不到
 * 那一行上**（按 id 找不到），屏上就一直停在它切走时的样子。
 */
function adoptTool(view: ShellView, tool: SnapshotTool): ShellView {
  const known = indexOfCall(view, tool.call)
  if (known !== -1) return patchTool(view, known, (row) => ({ ...row, state: 'running' }))

  const argsText = argsJson(tool.args)
  const pending = findToolIndex(
    view,
    (row) =>
      row.call !== null &&
      row.state === 'running' &&
      row.name === tool.name &&
      row.argsText === argsText,
  )
  if (pending !== -1) {
    return patchTool(view, pending, (row) => ({ ...row, call: tool.call, startedAt: tool.at }))
  }

  return reduceToolCall(view, tool.call, { name: tool.name, args: tool.args }, tool.at)
}

const RECENT_GROUPS = 5

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

function backgroundDoneText(data: EventDataOf['exec.background.done']): string {
  const how =
    data.stopped === true
      ? `已停掉 ${data.id}`
      : data.ok
        ? `${data.id} 跑完了`
        : `${data.id} 结束了（非正常退出）`

  const code = data.exit === null ? '退出码读不到' : `exit ${data.exit}`
  return `${how}（${code}）· ${firstLine(data.command)} · 输出 ${data.outputPath}`
}

/** 一条命令的第一行——回执里点名用（整条多行命令铺上去只会把那行撑成一堵墙）。 */
function firstLine(command: string): string {
  const line = command.split('\n', 1)[0]?.trim() ?? ''
  return line
}

function noticeOf(payload: Entry['payload']): boolean {
  return (payload as { readonly notice?: unknown } | undefined)?.['notice'] === true
}

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

export function userImages(refs: readonly DraftRef[]): readonly UserImage[] {
  return refs
    .filter((one): one is Extract<DraftRef, { kind: 'image' }> => one.kind === 'image')
    .map((one) => ({
      marker: one.marker,
      name: one.name,
      mime: one.mime,
      blob: one.blob,
      source: one.source,
      label: one.label,
    }))
}

function imagesOf(payload: Entry['payload']): readonly UserImage[] {
  const source = payload as { readonly refs?: readonly InputRefEntry[] } | undefined
  const refs = source?.['refs']
  if (!Array.isArray(refs)) return []

  return refs
    .filter((one): one is Extract<InputRefEntry, { kind: 'image' }> => one.kind === 'image')
    .map((one) => ({
      marker: one.marker,
      name: one.name,
      mime: one.mime,
      blob: one.blob,
      source: one.source,
      label: one.label,
    }))
}

function contentTextOf(entry: Entry): string {
  return 'text' in entry.content ? entry.content.text : '（这一条很长，屏幕上没铺全）'
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

    rows: clearAwaiting(view.rows, view.dock.pending.call),
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

function clearAwaiting(rows: readonly LogRow[], call: RecordId): readonly LogRow[] {
  return rows.map((row) => {
    if (row.kind !== 'tool' || row.call !== call || row.awaitingDecision !== true) return row

    const { awaitingDecision: _answered, ...rest } = row
    return rest
  })
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

export function stateMark(state: StatusState): string {
  switch (state) {
    case 'background':
    case 'idle':
      return MARKS.idle
    case 'working':
    case 'retrying':
      // 重试与工作中**同形**（都是「这一轮还在跑」）——分别靠**文案**（「正在重试」）与
      // 颜色（同为 warn）。它不该与「在等你」混形，那才是这一格要分开的那一对。
      return MARKS.dot
    case 'waiting':
      return MARKS.ring
    case 'error':
      return MARKS.error
    case 'lost':
      return MARKS.unknown
  }
}

/** 状态词（五态固定词——原型 · 状态行规格）。 */
export function stateText(state: StatusState): string {
  switch (state) {
    case 'background':
      return '等待后台结果'
    case 'idle':
      return '空闲'
    case 'working':
      return '工作中'
    case 'waiting':
      return '等你定夺'
    case 'retrying':
      return '正在重试'
    case 'error':
      return '出错'
    case 'lost':
      return '状态待确认'
  }
}

/**
 * 状态那一格的整句（形状 ＋ 词）——`● 工作中`。
 *
 * ⚠️ **屏上那一格不这么拼**（它要把形状那一位单独拿出来上色/呼吸，见 `components/status.ts`）；
 * 这一支是给**纯文本的读法**用的（用例、`/status` 那种一句话，以及本层别的文案拼串）。
 */
export function stateLabel(state: StatusState): string {
  return `${stateMark(state)} ${stateText(state)}`
}

export function withRunFacts(view: ShellView, rows: readonly RunRow[]): ShellView {
  return foldRunState({ ...view, runs: rows })
}

/** 那一格该长什么样——`undefined` ＝ 这条事实（或这条会话）**不碰它**。 */
function factFaceOf(state: RunState): StatusState | undefined {
  if (state === 'running') return 'working'
  if (state === 'idle' || state === 'stopped') return 'idle'

  // `waiting` / `stopping` / `unknown`——见 `withRunFacts` 那两段：它们的「在不在跑」半截，
  // 或压根证不出来，故不归这一格管
  return undefined
}

/** 折一次：**当前那条会话**的运行事实说「在跑 / 没在跑」，那一格就照它收。 */

function interruptedRows(view: ShellView): ShellView {
  const rows = view.rows.map((row) =>
    row.kind === 'tool' && row.state === 'running' ? { ...row, state: 'interrupted' as const } : row,
  )

  return rows === view.rows ? view : { ...view, rows }
}

function foldRunState(view: ShellView): ShellView {
  const run = view.sessionId === null ? undefined : view.runs.find((one) => one.session === view.sessionId)

  // **那一代核销了 ⇒ 还在「运行中」的行改判成「已中断」**（见 `INTERRUPTED_TEXT`）：
  // 这两条来路（挂着卡 / 没挂卡）都要走它——卡那一支另加「卡作废 ＋ 行定局」。
  if (run?.state === 'stopped' && hasRunningTool(view)) view = interruptedRows(view)

  if (run?.state === 'stopped' && view.dock.kind === 'decision') {
    // **行也一起定局**：那一代没了，这一轮的行再也不会变——留着「⟳ 跑动中」的行会
    // 让 `hasRunningTool` 一直为真（`ctrl+c` 于是永远走「有在途工作」那条路 ✗，
    // 与卡那一半是同一个死角）
    return patchStatus(settle(interruptedRows(undock(view))), {
      state: 'idle',
      amount: null,
      hint: HINT_IDLE,
    })
  }

  const said = run === undefined ? undefined : factFaceOf(run.state)
  if (said === undefined || said === view.status.state) return view

  // **只在「工作中 ⇄ 空闲」这一轴上来回**（别的三面不归这条管，见 `withRunFacts`）
  const was = said === 'working' ? 'idle' : 'working'
  if (view.status.state !== was) return view

  return patchStatus(view, {
    state: said,
    amount: null,
    // 右位是本状态的键位提示——收了尾，它得跟着换，否则一屏上「● 空闲 ＋ ctrl+c 中断」又打架。
    // ⚠️ 只换**本状态那一句**：抽屉 / 卡开着的右位归它们自己（`HINT_PICKER*` / `HINT_DECIDE*`），
    // 那不是这一格的脸，替它改了就是把别人的提示抹掉。
    hint: view.status.hint === (said === 'working' ? HINT_IDLE : HINT_WORKING)
      ? (said === 'working' ? HINT_WORKING : HINT_IDLE)
      : view.status.hint,
  })
}

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

/** 打开临时层；空列表也保留查询、原因与返回入口。 */
export function openPicker(view: ShellView, picker: Picker): ShellView {
  // 键位提示按**这一屏能做什么**给：纯读那一屏没有「选定」（见 `HINT_PICKER_READ`）、
  // 能筛的那两屏要报「打字筛」（见 `HINT_PICKER_SESSION` / `HINT_PICKER_CONFIG`）、
  // 任务去向那一屏 `esc` 是「返回」（见 `HINT_PICKER_TASK`）
  const keys =
    picker.reader !== undefined ? '' : picker.source==='paths'?'↑↓ 候选 · Tab 补全 · Enter 引用 · Esc 返回':picker.source==='skills'?'↑↓ 候选 · Enter 引用 · Esc 返回':picker.source === 'mcp'
      ? HINT_PICKER_READ
      : picker.source === 'task'
        ? HINT_PICKER_TASK
        : picker.source === 'session'
          ? HINT_PICKER_SESSION
          : picker.source === 'config'
            ? HINT_PICKER_CONFIG
            : HINT_PICKER

  const supplied=picker.hint??''
  const hint = /↑↓|Enter|Esc|esc|回车/.test(supplied) ? supplied : [supplied,keys].filter(Boolean).join('\n')
  return patchStatus({ ...view, dock: { kind: 'picker', picker:{...picker,...(hint===''?{}:{hint})} } }, { hint: '' })
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

export function patchStatus(view: ShellView, patch: Partial<ShellStatus>): ShellView {
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

/**
 * 结果里的**非空行**（空行不上屏——密度那条）。
 *
 * 归这一处（与 `textOfLines` 挨着）是因为**两个地方要用同一个数**：屏上画的是它
 * （`components/log.ts` 的结果块），而大块那一行报的「几行」也是它（同处 `bulkSummaryOf`）
 * ——两处各判一遍的话，报的数与画出来的行数迟早对不上。
 */
export function nonEmptyLines(lines: readonly string[]): readonly string[] {
  return lines.filter((line) => line.trim() !== '')
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
