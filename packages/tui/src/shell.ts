import type { BackgroundCommand, BackgroundView } from '@magic/contracts'
import { backgroundDetail, backgroundKey, backgroundPicker } from './background.ts'
import { createModelSettings, type ModelNavigation } from './model-settings.ts'
import { createPrompt, type Ask } from './prompt.ts'
import { foldRound } from './round.ts'
import { createSessionPicker } from './session-picker.ts'

import { sanitizeForDisplay } from '@magic/contracts'
import { dirname } from 'node:path'
import { composerLayout } from './components/composer.ts'
import { decisionActions } from './components/decision.ts'

import type {
  AgentId,
  CollaborationView,
  Command,
  ControlTransport,
  Entry,
  EventKind,
  KernelEvent,
  RecordId,
  RunNotice,
  RunRow,
  RunSnapshot,
  SessionId,
  SkillCatalogRow,
  StatusLineCell,
  StatusLineConfig,
  StopPhase,
  StopScope,
} from '@magic/contracts'
import {
  collaborationRow,
  delegationState,
  discussionRecords,
  memberRecords,
  memberRows,
  memberState,
} from './collaboration.ts'
import { lineSpan, stepLeft, stepRight } from './components/composer.ts'
import type { DraftRef } from './components/inline.ts'
import {
  backspaceRange,
  deleteRange,
  imageIndexOf,
  insertText,
  markerOf,
  putRef,
  refStartingAt,
  removeRange,
  replaceWith,
  retype,
  stepLeftOver,
  stepRightOver,
  wire,
} from './components/inline.ts'
import { usageLabel } from './components/lines.ts'
import type { Dock, PageTurn, Picker, PickerRow, ShellView, UserImage } from './view.ts'
import {
  COMMANDS,
  HINT_BOOTING,
  HINT_COMPLETION,
  HINT_IDLE,
  HINT_LOST,
  HINT_WORKING,
  MAX_CANDIDATES,
  activeWordOf,
  appendEcho,
  appendOutput,
  appendPageNote,
  appendReceipt,
  applyResume,
  closePicker,
  closePrompt,
  createView,
  finishExecution,
  hasPlan,
  hasRunningTool,
  matchCommands,
  movePicker,
  presentedNoticeOf,
  openPicker,
  openPrompt,
  patchStatus,
  picked,
  rebuild,
  reduce,
  settle,
  stopReceiptOf,
  undock,
  userImages,
  withBanner,
  withContextWindow,
  withDecisionStatus,
  withRunFacts,
  workspaceLabelOf,
} from './view.ts'
import {
  STATUSLINE_COLOR_ACTION,
  STATUS_LINE_DEFAULT,
  configHint,
  configPathLines,
  configRows,
  statusLineColorOf,
  statusLineHint,
  statusLineRows,
} from './view/config.ts'
import { grantsHint, grantsRows } from './view/grants.ts'
import { pathHint, pathRows, resolveSkill, skillHint, skillRows } from './view/materials.ts'
import { mcpHint, mcpRows, mcpToolRows } from './view/mcp.ts'
import { configReasoningOf, reasoningText } from './view/models.ts'
import { runSummary } from './view/sessions.ts'

export type { ShellKey } from './input.ts'
import type { ShellKey } from './input.ts'

export const EXIT_ARM_MS = 1_000

export type ShellEffect = { readonly exit: boolean; readonly screen?: boolean }

const NONE: ShellEffect = { exit: false }
const EXIT: ShellEffect = { exit: true }
/** `ctrl+o`——开那一屏（同一格还管退出：那一屏里 `ctrl+o` 也退出，见 `src/screen.ts`）。 */
const OPEN_SCREEN: ShellEffect = { exit: false, screen: true }

export type Shell = {
  /** 当前视图（引用稳定——只在事件 / 按键之后才换对象）。 */
  getView(): ShellView
  exitNote(): string | null
  /** 订阅视图变化（React 的 `useSyncExternalStore` 直接吃它）。 */
  subscribe(listener: () => void): () => void
  /** 一个按键。 */
  key(key: ShellKey): ShellEffect
  /**
   * **放开输入**——`boot` 跑完那一下（技术方案 · 装配视图第 5 步：「以 `boot` 完成为界」）。
   *
   * 这一跳之前：打字照旧进草稿（本地的事），**回车不受理**（当场说一句，草稿留着），
   * 发给内核的命令一律丢弃。之所以要有这道闸——`boot` 里的恢复**要发事件**，而
   * 恢复没跑完就提交，等于让循环与恢复抢同一条记录流（对话域会当场抛）。
   */
  releaseInput(): void
  /** 管理者断开，留屏与草稿；只有明确重开动作可恢复连接。 */
  hostGone(): void
  /** 主动读一次历史（开局接续 / 恢复之后调——重建记录区）。 */
  readHistory(session?: SessionId): void

  presented(ids: readonly string[]): boolean
  disconnected(why?: string): void

  attachMaterial(material: UserImage): void

  exportMaterial(material: UserImage): void
  /** 收摊——退订传输、清订阅者。 */
  dispose(): void
}

/** `/help` 沿用记录区输出；命令用法与候选共用登记表。 */
const HELP_TITLE = '使用帮助'
const HELP_COMMAND_WIDTH = Math.max(...COMMANDS.map(command => command.name.length))
const HELP_LINES: readonly string[] = [
  '输入任务描述开始工作；/ 查找命令，@ 引用文件。',
  '命令：',
  ...COMMANDS.map(command => `  ${command.name.padEnd(HELP_COMMAND_WIDTH + 2)}${command.summary}`),
  '参数用法：',
  '  /rename <名称> · /skills [关键词]',
  '  /model connect              接入模型连接',
  '  /model manage               管理连接与档位',
  '  /model refresh [连接]       刷新模型列表',
  '  /mcp [服务器]               查看服务器详情',
  '  /mcp reconnect <服务器>     重连服务器',
  '快捷键：',
  '  Enter                发送',
  '  Shift+Enter          换行',
  '  Tab                  补全',
  '  ↑ / ↓                选择候选',
  '  Esc                  临时层返回；主输入运行中停止，保留草稿',
  '  Ctrl+R / /connect    重连当前会话并刷新',
  '  待决策面板           ↑↓ 选择，Enter 确认；返回输入后 Tab 再进入',
  '  Ctrl+P / Ctrl+N      召回上一条 / 下一条输入',
  '  Ctrl+O               查看记录',
  '  Ctrl+T               展开或收起计划',
  '  Alt+Enter            选择本条输入用途',
  'Ctrl+C：工作中或有待答时选择停止、转后台或退出。',
  '空闲时 1 秒内连按两次 Ctrl+C 退出界面，App 继续运行。',
]

/**
 * `/status` 的正文——**本地就能答**（模型 / 用量 / 会话都在外壳手上，不必问内核）。
 *
 * 「连得上不」只说实话：最近一次模型调用**出错**就说出错（那是外壳看得见的事实），
 * 否则说「未见异常」——**不编一个「已连接」**（那要真去连一次才知道）。
 */
function statusLines(view: ShellView): readonly string[] {
  const { status } = view

  return [
    `会话　${status.session ?? '新会话'}`,
    `模型　${status.model ?? '（还没调用过）'}`,
    // 与状态行 ④ **同一个口径**（`usageLabel`）——两处各报各的，迟早分叉
    `用量　${usageLabel(status.usage, status.window) ?? '（还没上报）'}`,
    `状态　${status.state === 'error' ? '最近一次模型调用出错' : '未见异常'}`,
  ]
}

const STATUS_TITLE = '此刻'

const STATUSLINE_TITLE = '状态行放哪几格'

/**
 * 模型之外的「等内核回话再开选择器」意图；模型入口由 model-settings 自持。
 *
 * ⚠️ **`'config'` 是唯一一个等三份答复的**（见 `configPending`）：那一屏的四行里三行的
 * 当前值各有自己的读侧命令，缺一份那一格就只能写「还没问到」。
 */
type PendingPicker =
  | 'session'
  | 'grants'
  | 'skills'
  | 'mcp'
  | 'web'
  | 'config'

/**
 * `/config` 开屏要问的那三份读数——**一份都不能少**（少一份，那一格就成了「还没问到」）。
 *
 * ⚠️ **命令与它回来的那一发事件成对写在一处**：分两处写（一处列命令、一处列事件）就有
 * 「加了一份读数、忘了加那条命令」那一类静默失配——而它的表现是**这一屏再也开不出来**
 * （等一份永远不来的答复），最难查的那一形。条数也从这一处取（`CONFIG_READINGS.length`）。
 */
const CONFIG_READINGS: readonly {
  readonly command: Command
  readonly event: KernelEvent['kind']
}[] = [
  { command: { type: 'model.list' }, event: 'model.catalog' },
  { command: { type: 'grants.list' }, event: 'grants.catalog' },
  { command: { type: 'mcp.list' }, event: 'mcp.catalog' },
  { command: { type: 'web.list' }, event: 'web.state' },
]

type Layer = {
  readonly dock: Dock
  readonly model: ModelNavigation
  readonly asking: Ask | null
  readonly collaborationAt?: AgentId
  readonly draft: string; readonly caret: number; readonly refs: readonly DraftRef[]
  readonly inputPurpose: ShellView['inputPurpose']
}

/** 建壳的入参（都可省——省了＝按「拿不到」办）。 */

function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}

export type ShellOptions = {
  readonly settingsOnly?: boolean
  readonly copyText?: ((text: string) => Promise<void>) | undefined
  readonly detached?: ((listener: (why: string) => void) => void) | undefined
  readonly reopen?: (() => Promise<void>) | undefined

  readonly contextWindow?: number | null | undefined

  readonly workspaceRoots?: readonly string[] | undefined
  /** 基础目录派生的实际数据目录，仅用于设置回显。 */
  readonly dataDir?: string | undefined
  /** 系统家目录，只用于将显示路径缩成 ~/…，不参与位置选择。 */
  readonly home?: string | undefined
  /** 入口选定的绝对 .magic 路径；保留符号链接写法，用其父目录生成接回命令。 */
  readonly magicBase: string

  readonly statusLine?: StatusLineConfig | undefined
  /** 整轮耗时的显示口径；缺省为完整经过时间。 */
  readonly turnDuration?: 'elapsed' | 'active' | undefined

  readonly reducedMotion?: boolean | undefined

  readonly inputReady?: boolean | undefined

  readonly receipts?: readonly string[] | undefined

  readonly runs?: RunFeed | undefined

  readonly resumed?: ResumeFeed | undefined
  /**
   * **这一趟开局就接的那条会话**（`resume <id>`）——只作开屏那张摘要的排除项
   * （设计：摘要说的是**其他**活跃工作，而这条正是用户为它来的）。
   */
  readonly openingSession?: string | undefined

  readonly stop?: ((session: SessionId, scope: StopScope) => void) | undefined

  readonly stopped?: ((listener: (report: StopReport) => void) => void) | undefined

  readonly lines?: ((listener: (text: string) => void) => void) | undefined

  readonly markRead?: ((ids: readonly string[]) => void) | undefined
  readonly notices?: ((listener: (notice: RunNotice) => void) => void) | undefined
}

export type StopReport = {
  readonly session: SessionId
  readonly scope: StopScope
  readonly phase: StopPhase
  readonly note?: string
}

export type RunFeed = {
  readonly current: () => readonly RunRow[]
  readonly subscribe: (listener: (rows: readonly RunRow[]) => void) => void
}

export type ResumeFeed = {
  readonly subscribe: (listener: (gen: number, snapshot: RunSnapshot) => void) => void
}

/**
 * **流式节流**的窗口（毫秒）——实现级常量（`对表.md`·C 组授权：频率归实现级自决）。
 *
 * ## 为什么要它
 *
 * 事件来得可以很密（一条 token 一条 `model.delta`），而**每一件**都会叫醒 React 去重画一屏。
 * 实测（`bench-stream.ts` · 优化前）：2000 条增量 **29.5 秒**——每一件都在重算整段正文。
 *
 * ## 取 16 的由头
 *
 * 一对账就定了：**Ink 自己的写档是 30fps**（`maxFps` 缺省 ⇒ 33ms 一帧，
 * `renderInteractiveFrame` 那条路）。节流窗口若比 33ms 还宽，就是**在 Ink 本就要合掉的那些
 * 帧上再加一层等待**——纯亏。16ms（60Hz 那一档）比 Ink 的写档细一半：够把爆发期的
 * 一串事件收成一两次重绘，又不会成为那笔账里更慢的那一环。
 *
 * ## 领头立即、窗口末尾补一次
 *
 * **不是**延迟节流——那样每次按键都要白等一个窗口（输入回声正是最不该等的东西）。
 * 这里第一个事件**当场放行**，其后同一个窗口里的挤到窗口末尾合一次。于是：
 * 稀疏事件（流式那种 20ms 一条）**一件一放，不加任何延迟**；爆发事件（回放 / 快供应商）
 * 被收成一窗两次。**按键与其余的**（非流式那几条）走 `flushNow`——一步都不等。
 */
const STREAM_WINDOW_MS = 16

/**
 * 按帧合批的那几件——**流式增量**，且只有它们。
 *
 * 判据是「这条事件单看**没有任何**屏上意义」：一条 token 自己能说的只是「正文长了一个字」，
 * 攒起来一起画与一件一画，**屏上最终一模一样**。别的事件不行——
 * 按键（`key` 那条路）、`turn.end`、裁决、换会话，每一件都可能把左下那一整片换掉，
 * 晚一帧就是「按了没反应」。
 */
const STREAMING: ReadonlySet<EventKind> = new Set<EventKind>(['model.delta', 'tool.output.delta'])

/**
 * 一句交代里**用户说的话**——去掉已有的引用区间，再去掉句首那个还没绑上的技能名。
 *
 * 与 `bodyOf` 分开的理由：句首那个斜杠词**此刻还不是引用**（用户正按回车让它变成引用），
 * 故它自己那一截要从「有没有别的话」这笔账里去掉——不去掉的话，`/pdf` 单独一条会被
 * 当成「说了点什么」而直接发出去（一次一个字都没有的交代）。
 */
export function spokenOf(draft: string, refs: readonly DraftRef[], word: string): string {
  const spoken = bodyOf(draft, refs)

  return spoken.startsWith(word) ? spoken.slice(word.length) : spoken
}

export function submittable(draft: string, refs: readonly DraftRef[]): boolean {
  if (bodyOf(draft, refs).trim() !== '') return true

  return refs.some((ref) => ref.kind !== 'skill')
}

export function bodyOf(draft: string, refs: readonly DraftRef[]): string {
  let out = ''
  let cursor = 0

  for (const ref of [...refs].sort((left, right) => left.start - right.start)) {
    out += draft.slice(cursor, Math.max(cursor, Math.min(ref.start, draft.length)))
    cursor = Math.max(cursor, Math.min(ref.end, draft.length))
  }

  return out + draft.slice(cursor)
}

/** 当前正文与目录预览共用保存历史的条目投影，保留本地命令记录。 */
function historyEntries(data: Extract<KernelEvent, { kind: 'session.history' }>['data']): Entry[] {
  return [...data.entries, ...(data.inputs ?? []).map(event => ({ id: event.id, kind: 'user' as const, at: event.at,
    content: { text: event.data.text }, payload: { local: true as const, inputRefs: event.data.refs } }))]
}

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport, options: ShellOptions): Shell {
  const watchers = new Set<() => void>()
  const booting = options.inputReady === false

  // **印一次启动字标**（品牌视觉 · TUI Banner）——记录区最前面那一块。
  //
  // 种在这儿（而不是 `createView` 里）有两条由头：
  // ① **「启动」这件事的入口就在本函数**——`createView` 是空视图的构造子，
  //    `record.ts` 的标本与纯归约的用例都直接拿它当起点，那里没有「启动」；
  // ② 与**启动那几句回执同源**（见 `ShellOptions.receipts`）：都是「开局往记录区
  //    放一次的东西」，都得另保一手才活得过 `rebuild`（那半由 `bannerFirst` 管）。
  //
  // ⚠️ **画哪一版由渲染层按列数定**（视图这层不知道列数）——见 `LogRow` 里 `banner` 那一支。
  // 这里种的只有 ④ 的**开机那一格**（`contextWindow`）——此后的分母随事件来（见 `ShellOptions`）。
  let view = withBanner(
    withContextWindow(
      createView({

        statusLine: options.statusLine,
        reducedMotion: options.reducedMotion,
        turnDuration: options.turnDuration,
        workspace: workspaceLabelOf(options.workspaceRoots),
      }),
      options.contextWindow ?? null,
    ),
  )

  // 开屏说明属于这一页的页头。历史到达时保留原位置，避免 Static 跳过首条正文。
  for (const text of options.receipts ?? []) view = appendPageNote(view, text)

  view = withRunFacts(view, options.runs?.current() ?? [])

  {
    const summary = runSummary(view.runs, options.openingSession)
    if (summary !== undefined) view = appendPageNote(view, summary)
  }

  let disposed = false
  /** 「放开输入」了没有——`boot` 完成那一下翻真（见 `Shell.releaseInput`）。 */
  let ready = !booting
  let connected = options.settingsOnly !== true
  const disconnectedHint = options.settingsOnly ? '本地设置 · /model · /config · ctrl+c 退出' : HINT_LOST
  let reopening = false
  // 启动中：右位说清楚「为什么回车没反应」（不然就是「按了没反应」——最难查的那种）
  if (booting) view = { ...view, status: { ...view.status, hint: HINT_BOOTING } }
  if (options.settingsOnly) view = { ...view, status: { ...view.status, hint: disconnectedHint } }

  /**
   * **输入历史**（`↑` 取上一条）——**整份草稿**：正文 ＋ 它里面的引用（位置与身份）。
   *
   * 设计（终端交互：「输入编辑与历史」＋「引用留在交代的位置」）：**输入历史保留文字与引用
   * 的相对位置**——翻回来的是**当时那一句**，那几处引用连同身份一起回来，**不必重新选一遍**。
   *
   * 两条分寸：
   * - **翻历史不读材料、也不发送**（这里只是把一段本地的草稿放回输入行）；
   * - **重新提交时才读当前材料**（走的是与头一次完全同一条通路——出队那一刻现读，见
   *   `agent-loop.ts`）。故历史里存的是**身份**，不是当初那份内容。
   */
  type HistoryEntry = { readonly text: string; readonly refs: readonly DraftRef[]; readonly caret?: number; readonly cleared?: number }
  let history: HistoryEntry[] = []
  /** 翻到第几条（`-1` ＝**没在翻**，输入行里是用户自己那份草稿）。 */
  let historyAt = -1
  let clearedSequence = 0
  // 提交回执与批次独立于还稿状态；用户继续编辑不会丢失旧提交的清理归属。
  const submittedBatches = new Map<string, { history: HistoryEntry[]; through: number; replies?: Set<KernelEvent['kind']> }>()
  const acceptBatch = (ref: string | undefined, ok: boolean): void => {
    if (ref === undefined) return
    const batch = submittedBatches.get(ref)
    if (batch === undefined) return
    submittedBatches.delete(ref)
    if (!ok) return
    const kept = batch.history.filter(entry => entry.cleared === undefined || entry.cleared > batch.through)
    batch.history.splice(0, batch.history.length, ...kept)
    if (history === batch.history) { historyAt = -1; browsing = null }
    for (const [member, context] of inputContexts) {
      if (context.history === batch.history) inputContexts.set(member, { ...context, historyAt: -1, browsing: null })
    }
    for (const [session, work] of workContexts) {
      const reset = (context: InputContext): InputContext => context.history === batch.history ? { ...context, historyAt: -1, browsing: null } : context
      workContexts.set(session, { ...work, current: reset(work.current), members: new Map([...work.members].map(([member, context]) => [member, reset(context)])) })
    }
  }

  /**
   * **开始浏览前收着的那份原稿**（正文 ＋ 引用 ＋ 插入点）——设计：「开始浏览前保存完整草稿
   * （正文、技能、附件、光标/选区），**从最新历史按下返回原稿**」。
   *
   * `null` ＝ 没在翻（或翻的时候草稿本来就空着）。往回翻到最新那一条再按一下 `↓` 就还给它；
   * 用户一动草稿（打字 / 退格 / 粘贴 / `esc`）就不要了——那时**屏上这一份**才是他的原稿。
   */
  let browsing: { readonly text: string; readonly refs: readonly DraftRef[]; readonly caret: number } | null =
    null

  /** 重建的攒块——按 `session.history` 的 `data.session` 分（不是当下那条的直接丢）。 */
  let rebuildFor: SessionId | null = null
  let rebuildEntries: Entry[] = []

  /** 模型之外的选择器等待意图；新的读侧入口会撤销旧模型开页意图。 */
  let waiting: PendingPicker | null = null

  /**
   * **`/config` 尚未收到的读数种类**——重复回话不提前开屏。
   *
   * 由头：那一屏四行里有三行的「当前值」**各有自己的读侧命令**（连接一览 · 授权名录 ·
   * 外部工具一屏）。要「不进去就知道现在是什么」，就得**先问全再开屏**——少问一份，
   * 那一格就只能写「还没问到」，而这一屏存在的全部理由正是**竖着扫一眼就看全**。
   *
   * ⚠️ **三份一起问、齐了才开**（不是来一份开一次）：先开再补的话，用户会看见那一格
   * 从空到有地自己变一次——而「它现在是什么」这个问题，屏上不该有第二个答案。
   * 三份都是便宜的本机读数（读注册表 / 读授权文件 / 读内存里的连接状态）。
   */
  let configPending = new Set<KernelEvent['kind']>()

  let configQuery = ''

  let turn: { readonly kind: PageTurn; readonly label: string | null } | null = null

  const directory = createSessionPicker({
    get view() { return { catalog: view.catalog, runs: view.runs, sessionId: view.sessionId, collaboration: view.collaboration } },
    get picker() { return view.dock.kind === 'picker' && view.dock.picker.source === 'session' ? { ...view.dock.picker, source: 'session' as const } : null },
    workspaceRoots: options.workspaceRoots,
    present: picker => commit(openPicker(view, picker)),
    notify: flash => commit({ ...view, flash }),
    send: command => send(command),
  })

  const models = createModelSettings({
    get view() { return { models: view.models, vendors: view.vendors, modelCurrent: view.modelCurrent, configuredModels: view.configuredModels, collaboration: view.collaboration } },
    get picker() { return view.dock.kind === 'picker' ? view.dock.picker : null },
    present: picker => commit(picker === null ? closePicker(closePrompt(view)) : openPicker(view, picker)),
    receipt: text => commit(appendReceipt(view, text)),
    send: command => send(command),
    enterLayer: () => enterLayer(),
    popLayer: () => popLayer(),
    get prompt() { return prompt },
  })

  let collaborationAt: AgentId | undefined
  let collaborationQuery: { readonly member?: AgentId } | null = null
  const memberViews = new Map<AgentId, CollaborationView>()
  const reading = new Map<string, number>()
  const decisions = new Map<RecordId, Extract<KernelEvent, { kind: 'tool.decision.request' }>>()
  const answeredDecisions = new Set<RecordId>()
  let decisionReturn: { readonly dock: Dock; readonly layers: readonly Layer[]; readonly status: ShellView['status'] } | null = null

  const prompt = createPrompt({
    present: state => commit(state === null ? closePrompt(view) : openPrompt(view, state)),
    send: command => send(command),
    popLayer: () => popLayer(),
    onSubmit: (command, value) => {
      if (command.type !== 'session.rename' || sessionTarget !== command.session) return false
      if (managementPending !== null) return true
      if (!connected) { commit({ ...view, flash: 'Engine 未连接，请先 Ctrl+R 重连' }); return true }
      if (value.trim() === '') { commit({ ...view, flash: '名称不能为空' }); return true }
      managementPending = command.type
      commit({ ...view, flash: '正在保存…' })
      send(command)
      return true
    },
  })

  /** 临时层保存进入时的输入、目标和字段；Esc 逐层恢复。 */
  let layers: readonly Layer[] = []
  let editingPending: {ref:string;revision:number;back:Layer;purpose:ShellView['inputPurpose']}|null=null

  /** 此刻这一屏——收进栈里的那一份（见 `Layer`）。 */
  const layerNow = (): Layer => ({
    dock: view.dock,
    model: models.snapshot(),
    asking: prompt.snapshot(),
    collaborationAt,
    draft:view.draft, caret:view.caret, refs:view.refs, inputPurpose:view.inputPurpose,
  })

  /**
   * **进一层**——开一屏新的：把此刻这一屏收进栈里，`←` 那一下好照原样摆回来。
   *
   * ⚠️ **只在「屏 → 屏」那一跳叫它**（`submit` 里进明细 / 接入那几步 · `→` 看详情 ·
   * 明细里那几件要问一件小事的动作）。**重铺不算**（刷新之后照旧那一屏、`@` 那个筛词
   * 一变就重开同一栏）——那些也叫它，栈里就会堆上一串「同一屏的旧快照」，
   * 用户按一次 `←` 看着像没动。
   */
  const enterLayer = (): void => {
    // 从输入行开的屏底下没有「上一屏」（栈底就是输入行）——不压，`←` 那一下便是收起
    if (view.dock.kind === 'input' || view.dock.kind === 'decision') return
    layers = [...layers, layerNow()]
  }

  /** 把栈里那一层照原样摆回来——**光标位置、草稿与选区照旧**（草稿那三格压根没动过）。 */
  const restoreLayer = (layer: Layer): void => {
    models.restore(layer.model)
    prompt.restore(layer.asking)
    collaborationAt = layer.collaborationAt
    view = {...view,draft:layer.draft,caret:layer.caret,refs:layer.refs,inputPurpose:layer.inputPurpose}
    if(layer.dock.kind==='input'){commit({...view,dock:layer.dock});return}

    if (layer.dock.kind === 'picker') {
      commit(openPicker(view, layer.dock.picker))
      if (layer.dock.picker.source === 'model-editor') models.showEditor()
      if (layer.dock.picker.source === 'background') openBackground(layer.dock.picker.rows[layer.dock.picker.selected]?.value)
      if (layer.dock.picker.source === 'collaboration') openCollaboration(layer.dock.picker.rows[layer.dock.picker.selected]?.value)
      if (layer.dock.picker.source === 'session') directory.refresh()
      if (layer.dock.picker.source === 'session-actions' && sessionTarget !== undefined) showSessionActions(sessionTarget, false)
      return
    }
    if (layer.dock.kind === 'prompt' && layer.asking !== null) {
      prompt.show()
      return
    }

    if (layer.dock.kind === 'decision') {

      const run = view.sessionId === null ? undefined : view.runs.find((one) => one.session === view.sessionId)
      const gone = run?.state === 'stopped'
      const lost = view.status.state === 'lost'

      if (gone || lost || !decisions.has(layer.dock.pending.id)) {
        const back = undock({ ...view, dock: layer.dock })

        const settled = gone ? settle(back) : back
        commit(lost ? settled : patchStatus(settled, { state: 'idle', amount: null, hint: HINT_IDLE }))
        return
      }

      commit(withDecisionStatus({ ...view, dock: layer.dock }))
    }
  }

  /**
   * 收起此刻这一屏、回输入行——**`esc` 那一支与「`←` 弹到空」共用这一处**。
   *
   * ⚠️ 设计写的是「弹到空就收起（**与 `esc` 同效**）」——同效就得**真同效**：`esc` 在这
   * 几屏上本来就不只是「把抽屉关掉」，故那两件收尾的事一并放这儿：
   * - `@` 那一栏另把「还只是查询、没成引用」的那一段从草稿里撤回（设计：「取消归还原稿
   *   及选区」——那一段本来就不算用户说的话）。
   */
  const collapseDock = (): void => {
    collaborationQuery = null
    models.clearTarget()
    if (view.dock.kind === 'picker') {
      commit(closePicker(view))
      return
    }
    if (view.dock.kind === 'prompt') prompt.close()
  }

  /**
   * **`←` 弹一层**——有上一层就摆回去，弹到空便收起（与 `esc` 同效）。
   *
   * ⚠️ **不与输入打架**（设计明文）：「选择器开着时归选择器（那时光标不在输入行）；
   * 没开时照旧移光标」——`←` 这一支只在**接管屏**（选择器 / 本地小输入）上收，
   * 草稿那一头照旧由 `case 'left'` 移插入点。与 `↑↓` 同一分工。
   */
  const popLayer = (): void => {
    if(view.dock.kind==='picker'&&view.dock.picker.reader!==undefined)reading.set(view.dock.picker.reader.key,view.dock.picker.reader.top)
    const below = layers.at(-1)
    if (below === undefined) {
      collapseDock()
      return
    }

    layers = layers.slice(0, -1)
    restoreLayer(below)
  }

  /**
   * `/mcp <名字>` 的**预置那一台**——只在「等外部服务器一屏」那一趟有效（答复到了交给抽屉）。
   * 空串＝总览那一屏（`/mcp` 无参）。
   */
  let mcpServer = ''

  let skillSeed = ''

  let exitWait: SessionId | null = null

  let waitsForSession: 'exit' | 'stop' | 'background' | null = null

  /**
   * **技能名问过没有**（每个壳一次）——打 `/` 那一下问一遍（见 `askSkills`）。
   *
   * 为什么要这一位：输入行的候选要按技能名筛，而那需要一份目录；可发现面是**真的扫目录树**，
   * 逐键问一次就是逐键扫一遍盘。问一次够用：`/skills` 每次再问一次（那才是浏览面，
   * 要的是现况），而两次之间目录变了的话——直达那条路本来就会**当场失败并说清缘由**
   * （内核按身份取主文，取不到这一条不跑）。
   */
  let skillsAsked = false

  /** 提交的**配对键**计数——每次提交一枚（`draft-1` · `draft-2`…），`input.settled` 按它认回草稿。 */
  let submits = 0

  /**
   * **刚交出去的那一份草稿**——配对键 ＋ 正文 ＋ 它里面的引用。`null` ＝ 没有等着认领的。
   *
   * 两个时机把它清掉：用户**动过草稿**（`edit` 里清——「失败不覆盖后来编辑的新稿」
   * 正落在这条）· 已经认领过一次（同一份不会被两条失败各还一遍）。
   */
  let lastSubmit: {
    readonly ref: string
    readonly local?:true
    readonly caret?:number
    readonly text: string
    readonly refs: readonly DraftRef[]
  } | null = null

  let imageNames = new Map<string, number>()

  /**
   * 把稿子里**已经在的**图片名字认下来（历史翻回来 / 提交失败把稿子还回来那两处）。
   *
   * 由头：那几处的名字**已经写在正文里**（`Image#3`），而这张表是外壳的现编账——
   * 整份换稿之后不认下来的话，接着新加一张图会**又编出一个 3**，同一段输入里就撞名了。
   * 认下来之后新号从「已有的张数 ＋ 1」往下发（`imageNumberOf`）。
   *
   * 只认得出「编号 ＋ 内容身份」都齐的那种（`Image#N` 的写法 ＋ 那一支带的 blob）：
   * 用户自己打的字、旧记录里没有编号的那种不编（见 `inline.ts` 的 `imageIndexOf`）。
   */
  const adoptImageNames = (refs: readonly DraftRef[]): void => {
    for (const ref of refs) {
      if (ref.kind !== 'image') continue
      const n = imageIndexOf(ref.marker)
      if (n === undefined || imageNames.has(ref.blob)) continue

      imageNames.set(ref.blob, n)
    }
  }

  /**
   * 给一份**内容身份**取编号——已经有的照旧（同内容同名字），没有的发下一个。
   *
   * 「下一个」取**已发出的那个最大的 ＋ 1**，不是「几张 ＋ 1」：历史里翻回来的一句可能
   * 只带着 `Image#3` 那一处（另外两张删掉了），按张数发会从 2 起，而 3 已经有人用了
   * ——那就是**撞名**。按最大号往下发，撞不上。
   */
  const imageNumberOf = (blob: string, refs: readonly DraftRef[]): number => {
    adoptImageNames(refs)
    const known = imageNames.get(blob)
    if (known !== undefined) return known

    const next = Math.max(0, ...imageNames.values()) + 1
    imageNames.set(blob, next)

    return next
  }

  /** 攒着的那一次补发（`undefined` ＝ 窗口里没排着）。 */
  let pending: ReturnType<typeof setTimeout> | undefined

  /** 立刻就通知——键盘、结构性事件、以及窗口末尾那一次补发都走它。 */
  const flushNow = (): void => {
    for (const watcher of [...watchers]) watcher()
  }

  /**
   * 合批：领头的**当场放行**，窗口里其余的挤到末尾补一次（理由见 `STREAM_WINDOW_MS`）。
   *
   * ⚠️ **视图本身一律是即时更新的**（`commit` 里先落 `view`）——节流的是**通知**
   * （「叫 React 重画」），不是状态。故 `getView()` / `key()` 拿到的永远是当下这一份，
   * 晚的只有屏。这条也是 `/model` 那次顺序修复（`2f3fc4c`）赖以成立的前提。
   */
  const notifyCoalesced = (): void => {
    if (pending !== undefined) return // 窗口里已经排着补发了——这一件跟着它走
    flushNow()
    pending = setTimeout(() => {
      pending = undefined
      flushNow()
    }, STREAM_WINDOW_MS)
  }

  const commit = (input: ShellView, streaming = false): void => {
    // **启动中，右位提示一律按「启动中」铺**——**这个口子是唯一的**（视图的每一处改动都经
    // 这里），故不必逐条路径去堵：打字（`withCompletion` 会按状态重算提示）、退格、
    // 恢复自己发的那几条事件（`reduce` 把 `agent.state{waiting}` 翻成 `HINT_IDLE`）——
    // 任何一条都会把「启动中」抹掉，而**回车那时仍是不受理的** ⇒ 屏上就变成
    // 「看着闲着、按了却没反应」（原型 · 交互逻辑最不想要的那种）。
    const next = !connected
      ? { ...input, status: { ...input.status, hint: reopening ? '正在重新打开 Magic Code' : disconnectedHint } }
      : ready ? input : { ...input, status: { ...input.status, hint: HINT_BOOTING } }

    if (next.dock.kind === 'input' && editingPending===null) layers = []
    if (next.dock.kind === 'picker' && next.dock.picker.reader !== undefined) {
      reading.set(next.dock.picker.reader.key, next.dock.picker.reader.top)
    }
    const request = decisions.values().next().value
    const member = view.collaboration?.members.find(one => one.agent.sessionId === request?.session && request?.session !== view.sessionId)?.agent.name
    const pendingDecision = request === undefined ? undefined : { ...request.data, id: request.id, session: request.session, ...(member === undefined ? {} : { member }), submitted: answeredDecisions.has(request.id), position: { index: 1, total: decisions.size } }
    view = { ...next, pendingDecision }
    if (view.dock.kind === 'decision') view = withDecisionStatus({ ...view, dock: { ...view.dock, pending: { ...view.dock.pending, session: decisions.get(view.dock.pending.id)?.session, submitted: answeredDecisions.has(view.dock.pending.id), position: { index: 1, total: decisions.size } } } })
    if (streaming) notifyCoalesced()
    else {
      if (pending !== undefined) {
        clearTimeout(pending)
        pending = undefined
      }
      flushNow()
    }
  }

  const withCompletion = (next: ShellView): ShellView => {
    if (next.dock.kind !== 'input' || historyAt !== -1) return { ...next, completion: null }

    const at = activeWordOf(next.draft, next.caret)
    const found = matchCommands(at?.word ?? '', next.skills?.skills ?? [], at?.atStart ?? true)
    // **封顶在列、报数在右位**（见 `MAX_CANDIDATES`）：截掉几条不静默——状态行说得出
    // 「还有 N 条」，而想浏览全量走 `/skills`（那才是浏览面，这一栏只是边打边认的辅助）。
    const candidates = found.slice(0, MAX_CANDIDATES)

    // **刚选定过的那一处不再自荐**：插入点正停在一处**已成引用**的名字尾巴上时不再列候选
    // ——那一栏接着列同一条，就是「刚选完又问你一遍」；更要紧的是它会**吞掉下一次回车**
    // （回车先给候选选中，发不出去。真 PTY 上栽过：选完技能紧接回车，交代发不出去）。
    // 想换一份：把那一段删了重打（那时它不再是引用，候选照常列）。
    const standing = at === undefined ? undefined : refStartingAt(next.refs, at.start)
    const already = standing !== undefined && standing.end === at?.end
    const open = candidates.length > 0 && !already

    return {
      ...next,
      completion: open ? { candidates, selected: 0 } : null,
      // 右位提示跟着候选走（原型 · 场景 11）；候选举起就报键位，收起就回常态
      status: {
        ...next.status,
        hint: open ? completionHint(found.length - candidates.length) : idleHintOf(next),
      },
    }
  }

  /** 右位那句——候选被截时如实补一句（截了几条说几条）。 */
  const completionHint = (more: number): string =>
    more > 0 ? `${HINT_COMPLETION}（还有 ${more} 条）` : HINT_COMPLETION

  /** 没在补全、没在裁决 / 选择器时的右位提示——按状态给。 */
  const idleHintOf = (from: ShellView): string => {
    if (from.draft.length > 0 || from.refs.length > 0) return from.status.state === 'working' ? 'Esc 停止 · ctrl+c 清空草稿' : '/ 命令 · ctrl+c 清空草稿'
    if (from.status.state === 'working') return HINT_WORKING
    if (from.status.state === 'retrying') return from.status.hint

    return HINT_IDLE
  }

  /** 改草稿的统一入口。 */
  const draft = (next: ShellView): void => commit(withCompletion(next))

  const edit = (next: ShellView): void => {
    historyAt = -1
    // 人一动草稿，**屏上这一份**就是他的原稿了——先前收着的那份不要了（再翻 `↑` 时重收）
    browsing = null

    lastSubmit = null
    draft(next)
    askSkills(next)
  }

  const askSkills = (from: ShellView): void => {
    if (skillsAsked || !ready || !connected) return

    const word = activeWordOf(from.draft, from.caret)?.word
    if (word === undefined || !word.startsWith('/')) return

    skillsAsked = true
    send({ type: 'skills.list' })
  }

  const caretAt = (): number => Math.max(0, Math.min(view.caret, view.draft.length))

  /**
   * 在插入点处改草稿的**唯一口子**——改完插入点跟着落（越界夹回），**引用也跟着走**。
   *
   * 引用那一趟由调用方按编辑的类型算好（插一段／抹一段，两张情形位移规则不同——
   * 见 `inline.ts`），故此处收的是算好的那一份：**编辑规则只有 `inline.ts` 一处**，
   * 这里不另判一次。
   */
  const editAt = (next: string, caret: number, refs: readonly DraftRef[] = view.refs): void => {
    edit({ ...view, draft: next, caret: Math.max(0, Math.min(caret, next.length)), refs })
  }

  /** 插入点处插一段（打字 / 粘贴 / 换行共用）——插入点落在插进去的那一段**之后**。 */
  const insertAt = (text: string): void => {
    const at = caretAt()
    const refs = insertText(view.refs, at, text.length)

    editAt(view.draft.slice(0, at) + text + view.draft.slice(at), at + text.length, refs)
  }

  /**
   * 抹掉 `[from, to)` 那一段（退格 / 删除共用）——插入点落到 `from`。
   *
   * 被压到的引用**整个跟着走**（`removeRange`）——「删了可见引用，不能还暗带着那份材料」。
   */
  const eraseAt = (from: number, to: number): void => {
    editAt(view.draft.slice(0, from) + view.draft.slice(to), from, removeRange(view.refs, from, to))
  }

  /**
   * **`@` 是不是在词边界上**（该开路径候选）。
   *
   * 设计 · 文件与图片：「正文边界的 `@` 开路径候选，输入筛选；**邮箱或转义 `@` 不触发**」。
   * 那一格的插入点由调用方给（`@` 已经插进去了，故它在 `at - 1`）。
   */
  const opensPath = (draft: string, at: number): boolean => {
    if (at < 1 || draft[at - 1] !== '@') return false

    const before = at >= 2 ? (draft[at - 2] ?? '') : ''
    if (before === '\\') return false // 转义：只想打一个 `@`

    return before === '' || /\s/.test(before) // 词边界（行首，或空白之后）
  }

  const send = (command: Command): void => {
    if (disposed) return
    // **放开输入之前一律不受理**（见 `Shell.releaseInput`）——命令进内核＝让内核干活，
    // 而 `boot`（装载 ＋ 恢复）还没跑完。丢弃＋出声由调用方给（`submit` 那一处），
    // 这儿是兜底：别的路径（选择器 / 裁决）此刻本就不该有，有也一并拦下。
    if (!ready) return
    if (!connected && !transport.offlineCommands?.includes(command.type)) {
      commit(appendReceipt(view, 'Engine 未连接，这项运行操作暂不可用。')); return
    }
    if (view.archived && (command.type === 'input.submit' && command.local !== true || ['collaboration.input', 'collaboration.resume', 'decision.answer'].includes(command.type) || command.type === 'input.manage' && command.action === 'continue')) {
      commit({ ...view, flash: '会话已归档，请明确恢复后继续' }); return
    }
    transport.send(command.type==='input.manage'&&view.inputMember!==undefined?{...command,member:view.inputMember}:command)
  }

  /**
   * 启动中的那一句——**不静默吞**（原型 · 交互逻辑：按键要么管用、要么当场说一句）。
   * 草稿**留着**：那是本地的事，`boot` 一完就能发。
   */
  const bootRefusal = (): ShellEffect => {
    commit(said(view, '正在启动（装载 ＋ 恢复）——跑完就受理。草稿留着，回车再按一次即可。'))
    return NONE
  }

  // —— 事件 ——

  const onEvent = (event: KernelEvent): void => {
    if (disposed || (!connected && !reopening && !['model.catalog', 'provider.catalog', 'prefs.state', 'grants.catalog', 'web.state', ...(options.settingsOnly ? ['mcp.catalog'] : [])].includes(event.kind))) return

    for (const [ref, batch] of submittedBatches) {
      if (!batch.replies?.has(event.kind)) continue
      const failed = ('ok' in event.data && event.data.ok === false) || (event.kind === 'session.state' && event.data.note !== undefined)
      batch.replies.delete(event.kind)
      if (failed || batch.replies.size === 0) acceptBatch(ref, !failed)
      break
    }

    if (event.kind === 'session.state' && event.data.note === undefined && view.flash === '正在读取会话目录…') commit({ ...view, flash: null })
    if (event.kind === 'session.state' && (waiting === 'session' || view.dock.kind === 'picker' && view.dock.picker.source === 'session') && turn === null) {
      if (event.data.note !== undefined) {
        if (waiting === 'session') { waiting = null; directory.open() }
        commit({ ...view, flash: `${event.data.note} · Enter 重试` }); return
      }
    }
    if (event.kind === 'session.changed') {
      const next = reduce(view, event)
      commit(next.archived && next.dock.kind === 'decision' ? undock(next) : next)
      directory.refresh()
      if (view.dock.kind === 'picker' && view.dock.picker.source === 'session-actions' && sessionTarget === event.data.session) {
        showSessionActions(sessionTarget, false)
      }
      return
    }
    if (event.kind === 'session.managed') {
      if (event.data.session !== sessionTarget || managementPending === null) {
        if (event.data.action === 'rename') {
          if (!event.data.ok) { if (lastSubmit?.local === true) settleDraft(lastSubmit.ref, true); commit({ ...view, flash: event.data.error ?? '改名失败' }) }
          else send({ type: 'session.list', archived: directory.archived })
        }
        return
      }
      managementPending = null
      if (!event.data.ok) { commit({ ...view, flash: event.data.error ?? '会话操作失败，请重试' }); return }
      commit({ ...view, flash: null })
      if (event.data.action === 'rename') { prompt.clear(); popLayer(); popLayer() }
      else {
        if (view.dock.kind === 'picker' && view.dock.picker.source === 'session-actions') popLayer()
        if (event.data.action === 'restore') { directory.restored(event.data.session) }
      }
      directory.query()
      return
    }
    if(lastSubmit?.local===true && (('ok' in event.data&&event.data.ok===false)||(event.kind==='session.state'&&event.data.note!==undefined)))settleDraft(lastSubmit.ref,true)

    if(event.kind==='input.pending'){const target=view.inputMember===undefined?view.sessionId:view.collaboration?.members.find(one=>one.agent.agentId===view.inputMember)?.agent.sessionId;if(target!=null&&event.session!==target)return;commit({...view,pendingInputs:event.data.inputs});if(view.dock.kind==='picker'&&view.dock.picker.source==='input-pending')openPendingInputs();if(event.data.note!==undefined)commit(appendReceipt(view,event.data.note));return}
    if (event.kind === 'background.state') {
      if (view.sessionId !== null && event.session !== view.sessionId) return
      const picker = view.dock.kind === 'picker' ? view.dock.picker : undefined
      if (backgroundAt && event.data.result && backgroundKey(event.data.result.target) === backgroundKey(backgroundAt.command)) backgroundAt.result = event.data.result
      commit({ ...view, background: event.data })
      if (picker?.source === 'background') openBackground(picker.rows[picker.selected]?.value)
      else if (picker?.source === 'background-detail' && backgroundAt) showBackgroundDetail(picker.rows[picker.selected]?.value, picker.detailTop)
      return
    }
    if (event.kind === 'collaboration.view') {
      const data = event.data
      if (view.sessionId !== null && data.originSession !== view.sessionId) return
      if (data.selectedMember !== undefined) memberViews.set(data.selectedMember, data)
      const previous = view.collaboration
      commit({ ...view, collaboration: data })
      for (const member of data.members) {
        if (member.agent.purpose !== 'consultation' || member.delegation?.deliveryMessageId === undefined) continue
        if (previous?.members.some(one => one.delegation?.deliveryMessageId === member.delegation?.deliveryMessageId)) continue
        commit(appendReceipt(view, `咨询 Arcane · 来自顾问 · ${memberState(member)} · Tab 查看原始建议与查证过程`))
      }
      if (data.note !== undefined) commit(appendReceipt(view, data.note))
      const requested = collaborationQuery
      if (requested !== null && requested.member === data.selectedMember) {
        collaborationQuery = null
        if (requested.member === undefined) { if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'background') openCollaboration() }
        else {
          const member = data.members.find(one => one.agent.agentId === requested.member)
          collaborationAt = requested.member
          if (member !== undefined) openRecords(`${requested.member}:records`, `${member.agent.name} · 对话与工具`, memberRecords(data, requested.member))
        }
      } else if (view.dock.kind === 'picker') {
        const picker = view.dock.picker
        if (picker.source === 'collaboration') openCollaboration(picker.rows[picker.selected]?.value)
        else if (picker.source === 'collaboration-member' && collaborationAt !== undefined) openMember(collaborationAt, picker.rows[picker.selected]?.value)
        else if (picker.reader !== undefined && data.selectedMember !== undefined) {
          const reader = picker.reader
          const member = data.selectedMember
          const discussion = reader.key.startsWith(`${member}:discussion:`) ? reader.key.slice(`${member}:discussion:`.length) : undefined
          const rows = reader.key === `${member}:records` && data.entries !== undefined ? memberRecords(data, member)
            : discussion !== undefined && data.messages !== undefined
              ? discussionRecords(data, data.messages.filter(message => String(message.discussionRoot ?? message.messageId) === discussion)) : undefined
          if (rows !== undefined) commit({ ...view, dock: { kind: 'picker', picker: { ...picker, reader: { ...reader, rows } } } })
        }
      }
      return
    }

    // 成员运行事件不混进原会话正文；审批与输入回执仍按唯一 id 接收。
    if (view.collaboration?.members.some((one) => one.agent.sessionId === event.session && event.session !== view.collaboration?.originSession)
      && event.kind !== 'tool.decision.request' && event.kind !== 'tool.decision' && event.kind !== 'input.settled') return

    if (event.kind === 'session.history') {
      if (preview?.session === event.data.session) {
        if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'session-history') { if (event.data.done) preview = null; return }
        if (event.data.error !== undefined) { commit({ ...view, flash: `${event.data.error} · Enter 重试` }); preview = null; return }
        preview.entries.push(...historyEntries(event.data))
        preview.entries.sort((a, b) => a.at - b.at || a.id - b.id)
        const picker = view.dock.picker
        const rebuilt = rebuild(createView(), preview.entries, { ...(event.data.timing === undefined ? {} : { timing: event.data.timing }) })
        commit({ ...view, dock: { kind: 'picker', picker: { ...picker, reader: { ...picker.reader!,
          title: picker.reader!.title.replace(' · 正在读取', event.data.done ? '' : ' · 正在读取'), rows: [...rebuilt.settled, ...rebuilt.rows] } } } })
        if (event.data.done) preview = null
        return
      }
      accumulate(event.data)
      return
    }

    if (event.kind === 'tool.decision.request') {
      if (decisions.has(event.id) || answeredDecisions.has(event.id)) return
      if (event.session === view.sessionId) commit({ ...view, round: foldRound(view.round, event) })
      decisions.set(event.id, event)
      if (view.dock.kind !== 'decision') openDecision()
      else commit(view)
      return
    }
    if(event.kind==='turn.end'){for(const [id,request] of decisions)if(request.session===event.session){decisions.delete(id);answeredDecisions.add(id)}}
    if (event.kind === 'tool.decision') {
      const request = [...decisions.values()].find(one => one.data.call === event.data.call)
      if (request !== undefined) { decisions.delete(request.id); answeredDecisions.add(request.id) }
    }
    const before = view.sessionId
    const prior = view
    if(event.kind==='session.state'&&event.data.active!==before)workContexts.set(before,{member:view.inputMember,current:currentInput(view),members:new Map(inputContexts),purpose:view.inputPurpose})

    if (event.kind === 'tool.decision' || event.kind === 'turn.end') {
      // **先把那一张摆回 `dock`**（若它正被菜单罩在下面）：下面那条常规 `reduce` 走的就是
      // 它的老路——`undock` **归还草稿**、清掉「等你答」那一笔、按结果换状态行。
      // 不先摆回去，`undock`（`view.ts`：`dock` 不是 decision 就直接返回）什么都不做 ✗
      // ——草稿就留在 `stashed` 里、屏上那一格也不动（复核用探针直接量到过）。
      const parked =
        view.dock.kind === 'picker' && view.dock.picker.source === 'task'
          ? layers.filter((layer) => layer.dock.kind === 'decision').at(-1)
          : undefined

      layers = layers.filter((layer) => layer.dock.kind !== 'decision')
      // 照原设计：**已被别人答掉的卡，罩在它上面的那一屏一并收起**（那一屏问的是「这件事
      // 往哪去」，而这件事已经往前走了）——`undock` 会把 dock 交回输入行。
      if (parked !== undefined) view = { ...view, dock: parked.dock }
    }

    let reduced = reduce(view, event, { turn: turn?.kind ?? null })
    if (view.collaboration?.collaboration !== undefined && event.kind === 'turn.end' && prior.dock.kind === 'decision') {
      if (event.session === view.sessionId && decisionReturn !== null) decisionReturn = { ...decisionReturn, status: reduced.status }
      const request = decisions.get(prior.dock.pending.id)
      if (request !== undefined && request.session !== event.session) reduced = { ...reduced, dock: prior.dock, stashed: prior.stashed, draft: prior.draft, refs: prior.refs, caret: prior.caret, status: prior.status }
    }
    if (event.kind==='tool.decision' && decisions.size===0 && reduced.status.state==='waiting')
      reduced=patchStatus(reduced,{state:'working',amount:null,hint:reduced.dock.kind==='input'?HINT_WORKING:reduced.status.hint})
    commit(reduced, STREAMING.has(event.kind))

    const reasoning = configReasoningOf(view.modelCurrent)
    const reasoningLabel = reasoning === undefined ? null : reasoningText(reasoning)
    if (view.status.reasoning !== reasoningLabel) commit(patchStatus(view, { reasoning: reasoningLabel }))
    if(prior.dock.kind==='decision'&&((event.kind==='tool.decision'&&prior.dock.pending.call===event.data.call)||(event.kind==='turn.end'&&!decisions.has(prior.dock.pending.id)))){ returnDecision(); openDecision() }

    if (waiting === 'config' && CONFIG_READINGS.some((one) => one.event === event.kind)) {
      configPending.delete(event.kind)
      if (configPending.size === 0) {
        waiting = null
        openConfigPicker()
      }
    }

    if (event.kind === 'prefs.state') {
      const held = view.dock.kind === 'picker' ? view.dock.picker.source : null
      commit({
        ...view,
        statusLine: event.data.statusLine,
        reducedMotion: event.data.reducedMotion === true,
        turnDuration: event.data.turnDuration ?? 'elapsed',
      })
      if (held === 'statusline') openStatusLinePicker(picked(view)?.value === undefined ? 0 : view.dock.kind === 'picker' ? view.dock.picker.selected : 0)
      if (held === 'config') refreshConfigPicker()
      if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
    }

    if (event.kind === 'session.state') {

      if (before !== (event.data.active||null)) {
        collaborationQuery = null
        collaborationAt = undefined
        backgroundAt = undefined
        psPositions.clear()
        models.clearTarget()
        const sameCollaboration = prior.collaboration?.originSession === event.data.active
        if (!sameCollaboration) memberViews.clear()
        inputContexts.clear()
        const saved=workContexts.get(event.data.active||null)??(before===null&&(lastSubmit!==null||turn===null)?workContexts.get(null):undefined)
        if(saved!==undefined)for(const [member,context] of saved.members)inputContexts.set(member,context)
        history=saved?.current.history??[];historyAt=saved?.current.historyAt??-1;browsing=saved?.current.browsing??null;lastSubmit=saved?.current.lastSubmit??null
        if (!sameCollaboration) { decisions.clear(); answeredDecisions.clear(); decisionReturn = null }
        commit({...view,background:undefined,collaboration:sameCollaboration ? prior.collaboration : undefined,inputMember:saved?.member,inputPurpose:saved?.purpose??'current',draft:saved?.current.draft??'',refs:saved?.current.refs??[],caret:saved?.current.caret??0})
        if (event.data.active !== '') readHistory(event.data.active)
      }
      if (waiting === 'session') {
        waiting = null
        directory.open()
      } else directory.refresh()

      if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))

      if (turn !== null) {
        const label = turn.label
        turn = null
        if (label !== null && event.data.note === undefined && before !== event.data.active) {
          commit(appendPageNote(view, `已切到 ${label}`))
        }
      }

      if (waitsForSession !== null && view.sessionId !== null && event.data.note === undefined) {
        const waiting = waitsForSession
        waitsForSession = null
        if (waiting === 'exit') stopForExit(view.sessionId)
        else if (waiting === 'background') leaveForBackground()
        else options.stop?.(view.sessionId, 'run')
      }
    }

    if (waitsForSession !== null && event.kind === 'turn.end' && view.sessionId === null) {
      const waiting = waitsForSession
      waitsForSession = null
      // **这一轮收场了、会话 id 始终没来**：`/exit` 与「转到后台」照旧走（没有可停 / 可接的
      // 东西，如实说一句就是，**不假装留了接回入口**）；**「停止任务」什么都不做**（它本来就
      // 是「停掉、留下」——没有可停的东西不是失败）
      if (waiting === 'exit') commit({ ...view, leaving: true })
      if (waiting === 'background') {
        commit({ ...view, leaving: true })
      }
    }

    if (event.kind === 'model.catalog' || event.kind === 'provider.catalog') {
      models.receive(event)
    }
    // 连接表后到也得把网页选择器的候选补齐（`/web` 同时问了 `model.list` 与 `web.list`）。
    if (event.kind === 'model.catalog' && view.dock.kind === 'picker' && view.dock.picker.source === 'web') {
      refreshWebPicker()
    }

    // 技能目录回来了 ⇒ 两件。
    // ① **候选跟着这一份重算**：此刻草稿多半正是一条 `/…`（问就是打斜杠那一下问的），
    //    技能名要能**立刻**上候选——不然得等下一个按键才认得出来（`reduce` 只落数据，
    //    重算候选是外壳这一层的口径，见 `withCompletion`）；
    // ② 若正等着开抽屉（`/skills`），铺行归 `openSkillsPicker`（它读视图里那一份）。
    if (event.kind === 'skills.catalog') {
      commit(withCompletion(view))
      if (waiting === 'skills') {
        waiting = null
        // `/skills` 那条路：草稿已被命令清空，故锚点就是 `[0, 0)`——
        // 「选定后在打开选择器前的输入位置插入技能引用」在这一档即句首那个位置。
        openSkillsPicker(skillSeed, { start: 0, end: 0 })
      }
    }

    // 路径候选回来了 ⇒ **只认正开着 `@` 那一栏、且 query 对得上的那一次**（边打边问，
    // 答复可能后到——先到的那一份不该盖掉用户已经改过的查询）。
    if (event.kind === 'paths.catalog') refreshPaths()

    if (event.kind === 'paths.identified') identifyPicked(event.data)

    if (event.kind === 'input.pasted') pastedClipboard(event.data)

    if (event.kind === 'input.settled') acceptBatch(event.data.ref, event.data.ok)
    if (event.kind === 'input.settled' && event.data.stage !== 'accepted') {
      settleDraft(event.data.ref, !event.data.ok && event.data.keepDraft !== false)
    }

    if (event.kind === 'input.settled' && event.data.ok && event.session !== '') {
      if (!view.catalog.some((one) => one.id === event.session)) send({ type: 'session.list' })
    }

    // 授权名录回来了 ⇒ 开抽屉（`/grants` 那条路）／**撤销之后刷新它 ＋ 留一行回执**。
    // 两处分得开：`waiting` 只在「刚问过」时为真；撤销那次是抽屉**已经开着**。
    if (event.kind === 'grants.catalog') {
      if (waiting === 'grants') {
        waiting = null
        openGrantsPicker(view.grants)
      } else {
        // 明确撤销后的刷新：**照着新名录重铺**（撤掉那条就没了），
        // 并把内核那一句留成**记录区的一行回执**。
        refreshGrantsPicker() // 抽屉还开着才重铺（`esc` 收起了就只留回执）
        // `note` 只在有事要说时给（撤成了 / 没撤成 / 写盘失败）——不给＝没什么可说的。
        // ⚠️ **回执不跟着抽屉走**：撤了就得知会一声，哪怕抽屉已经收起
        if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
      }
    }

    // 外部服务器一屏回来了 ⇒ 开抽屉（`/mcp` 那条路）／**重连之后刷新它 ＋ 留一行回执**。
    // 与 `grants.catalog` 同一条分寸：`waiting` 只在「刚问过」时为真；重连那次是抽屉已开着。
    if (event.kind === 'mcp.catalog') {
      if (waiting === 'mcp') {
        waiting = null
        // 点了名的（`/mcp <名字>` · `/mcp reconnect <名字>`）要那一台**在读数里**才开抽屉：
        // 认不出的名字没有明细可看，那一行回执（`note`）就是它的答复。
        if (mcpServer === '' || event.data.servers.some((one) => one.server === mcpServer)) {
          openMcpPicker(mcpServer)
        }
      } else {
        refreshMcpPicker() // 抽屉还开着才重铺（`esc` 收起了就只留回执）
      }

      // 重连的**结果**只有答复说得清（成没成 · 有没有这一台）——抽屉开不开都留这一行
      if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
    }

    // 网页服务读数回来了 ⇒ 开抽屉（`/web`）／保存之后照着新读数重铺 ＋ 留一行回执。
    if (event.kind === 'web.state') {
      if (waiting === 'web') {
        waiting = null
        openWebPicker()
      } else {
        refreshWebPicker()
      }
      // 浏览那一句不必上记录区；保存的回话（成 / 没成）要说一声。
      if (event.data.saved !== undefined && event.data.note !== undefined) {
        commit(appendReceipt(view, event.data.note))
      }
    }
  }

  const accumulate = (data: Extract<KernelEvent, { kind: 'session.history' }>['data']): void => {
    if (view.sessionId !== null && data.session !== view.sessionId) return // 切走之后的尾巴——丢

    if (rebuildFor !== data.session) {
      rebuildFor = data.session
      rebuildEntries = []
    }

    rebuildEntries = [...rebuildEntries, ...historyEntries(data)]
    if (!data.done) return

    rebuildEntries = [...rebuildEntries].sort((a,b)=>a.at-b.at||a.id-b.id)
    if(history.length===0)for(const entry of rebuildEntries){
      if(entry.kind!=='user'||!('text'in entry.content)||(entry.payload as {notice?:true}|undefined)?.notice===true)continue
      const payload=entry.payload as import('@magic/contracts').UserPayload|undefined
      const refs=payload?.local===true?payload.inputRefs??[]:payload?.refs??[]
      history.push({text:entry.content.text,refs:refs.map(({at,...ref})=>({...ref,start:at,end:at+ref.marker.length}))})
    }
    const unconfirmed = [...view.settled, ...view.rows].filter(row => row.kind === 'user' && row.inputState !== undefined && !view.pendingInputs.some(input => input.ref === row.inputRef && input.entry !== undefined))
    const rebuilt = rebuild(view, rebuildEntries, { ...(data.timing === undefined ? {} : { timing: data.timing }) })
    commit({ ...rebuilt, rows: [...rebuilt.rows, ...unconfirmed] })
    rebuildFor = null
    rebuildEntries = []

    drawResumed()
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  let pendingResume: RunSnapshot | null = null
  /** 那一份暂存的快照最多等多久（毫秒）——见 `drawResumed`。 */
  const RESUME_SETTLE_MS = 300
  let resumeTimer: ReturnType<typeof setTimeout> | undefined

  const drawResumed = (): void => {
    if (resumeTimer !== undefined) {
      clearTimeout(resumeTimer)
      resumeTimer = undefined
    }
    if (pendingResume === null) return
    if (rebuildFor !== null) return // 记录区正在重建——等它铺完（`accumulate` 那一跳）
    const snapshot = pendingResume
    pendingResume = null
    const held=view
    const resumed=applyResume(view,snapshot)
    for(const one of snapshot.decisions){
      if(!answeredDecisions.has(one.id))decisions.set(one.id,{kind:'tool.decision.request',id:one.id,session:view.sessionId??'',turn:null,at:Date.now(),data:one})
    }
    commit({...resumed,dock:held.dock,draft:held.draft,refs:held.refs,caret:held.caret,stashed:held.stashed,status:resumed.status})
    openDecision()
  }

  /**
   * 收下一份快照，**等历史铺完再画**（见 `pendingResume` 的注）。
   *
   * 「等」有一个**上界**（`RESUME_SETTLE_MS`）：一旦这一趟并没有换会话（比如就那么
   * 重绑回原来那条），`session.history` 那一趟根本不会来——那时死等就是**把事实扣在手里**。
   * 到点照画：画的是**此刻的事实**，不是「等一个可能不来的东西」。
   */
  const holdResumed = (snapshot: RunSnapshot): void => {
    pendingResume = snapshot
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = setTimeout(drawResumed, RESUME_SETTLE_MS)
    resumeTimer.unref?.()
  }

  // —— 选择器 ——

  let sessionTarget: string | undefined
  let managementPending: 'session.archive' | 'session.restore' | 'session.rename' | null = null
  let preview: { session: string; entries: Entry[] } | null = null

  const showSessionHistory = (session: string): void => {
    preview = { session, entries: [] }
    enterLayer()
    const archived = view.catalog.find(one => one.id === session)?.archived ?? (session === view.sessionId && view.archived)
    commit(openPicker(view, { source: 'session-history', rows: [], selected: 0,
      reader: { key: `session:${session}`, title: `${nameOfSession(session)}${archived ? ' · 已归档' : ''} · 正在读取`, rows: [], top: reading.get(`session:${session}`) ?? 0 } }))
    send({ type: 'history.read', session })
  }
  const showSessionActions = (session: string, push = true): void => {
    sessionTarget = session
    const item = view.catalog.find(one => one.id === session)
    const archived = item?.archived ?? (session === view.sessionId && view.archived)
    const keep = push ? undefined : picked(view)?.value
    const rows = [collaborationRow('history', '查看记录'), ...(archived ? [] : [collaborationRow('rename', '改名')]),
      ...(archived ? [collaborationRow('restore', '恢复', '恢复后需另行接回或发送')] : connected && item?.canArchive === true ? [collaborationRow('archive', '归档')] : []),
      ...(session === view.sessionId && archived ? [collaborationRow('draft', '查看／复制原草稿'), collaborationRow('sessions', '/resume · 切换其他会话')] : [])]
    if (push) enterLayer()
    commit(openPicker(view, { source: 'session-actions', title: `${nameOfSession(session)}${archived ? ' · 已归档' : ''}`,
      selected: Math.max(0, rows.findIndex(row => row.value === keep)), rows, hint: '↑↓ 选择 · Enter 执行 · Esc 返回' }))
  }
  const manageSession = (type: 'session.archive' | 'session.restore'): void => {
    if (sessionTarget === undefined || managementPending !== null) return
    if (!connected) { commit({ ...view, flash: 'Engine 未连接，请先 Ctrl+R 重连' }); return }
    managementPending = type
    commit({ ...view, flash: '正在保存…' })
    send({ type, session: sessionTarget })
  }

  const askStop = (scope: StopScope): ShellEffect => {
    if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'session') return NONE

    const row = picked(view)
    if (row === undefined) return NONE

    if (options.stop === undefined) {
      // 没有来路（用例 / 演示）——**如实说**，不留一个按下去没反应的键
      commit(appendReceipt(view, '这个窗口没有连着运行管理——停不了'))
      return NONE
    }

    options.stop(row.value, scope)
    return NONE
  }

  const nameOfSession = (session: SessionId): string =>
    view.catalog.find((one) => one.id === session)?.title ??
    (session === view.sessionId ? '你这条会话' : '另一条会话')

  /**
   * **运行事实变了**——落进视图，顺手把开着的那一屏就地重铺。
   *
   * 两件都要：视图那一格是**下一次**开列表时的取材；而列表**此刻开着**时，用户正看着
   * 它——「它刚变成需要你了」这件事得当场看得见（那正是这张表存在的理由）。
   */
  options.runs?.subscribe((rows) => {
    if (disposed) return

    const prior = view.dock
    for (const [id, request] of decisions) {
      if (rows.some(row => row.session === (view.collaboration?.members.some(member => member.agent.sessionId === request.session) ? request.session : view.sessionId) && row.state === 'stopped')) {
        decisions.delete(id)
        answeredDecisions.add(id)
      }
    }
    commit(withRunFacts(view, rows))
    if (prior.kind === 'decision' && !decisions.has(prior.pending.id)) { returnDecision(); openDecision() }
    directory.refresh()
  })

  /**
   * **停止走到了哪一拍**——落一行回执，**话在这一层拼**（它要带上那条会话的标题，
   * 而标题只有这一层手上有：目录在这儿，管理者只读得到「这条会话在不在」）。
   *
   * ⚠️ **三拍说三件事**（`stopReceiptOf`）：受理不是停、核销了才叫停、没能停掉的要说出
   * 缘由——「不把局部成功显示为整体成功」就落在这一处。
   */
  options.stopped?.((report) => {
    if (disposed) return
    const title = nameOfSession(report.session)
    const said = appendReceipt(
      view,
      stopReceiptOf({
        title,
        scope: report.scope,
        phase: report.phase,
        note: report.note,
      }),
    )

    const go =
      exitWait !== null && report.session === exitWait && report.scope === 'run' && report.phase === 'done'

    if (go) exitWait = null
    commit(go ? { ...said, leaving: true } : said)
  })

  options.lines?.((text) => {
    if (disposed) return
    commit(appendReceipt(view, text))
  })

  // 仅保留当前工作的提醒来源；真实内容呈现后确认，不追加同义摘要。
  options.notices?.((notice) => {
    if (disposed || !notice.unread) return
    if (notice.session !== view.sessionId && notice.session !== view.collaboration?.originSession) return
    const next = { ...view, notice }
    // 历史记录不重建错误事件；接回或执行者退出时保留唯一的失败说明。
    if (notice.kind === 'failed' && presentedNoticeOf(next) === undefined) {
      commit({ ...next, settled: [...view.settled, { kind: 'receipt', key: `notice:${notice.id}`,
        text: notice.detail ?? '本轮无法继续，具体错误暂不可用' }] })
    } else {
      commit(next)
    }
  })

  /**
   * **接回快照到了**——先收着，等记录区铺完再画（见 `pendingResume`）。
   *
   * ⚠️ **断了的那条不算**：`disposed` 之后什么都不做（收摊之后画的每一帧都是白画）。
   */
  options.resumed?.subscribe((_gen, snapshot) => {
    if (disposed) return
    holdResumed(snapshot)
  })
  const finishCurrent = (): void => {
    pendingResume = null
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = undefined
    let next = finishExecution(view)
    // detached 只核销当前入口执行者；成员审批仍由各自的执行身份负责。
    for (const [id, request] of decisions) {
      if (!view.collaboration?.members.some(member => member.agent.sessionId === request.session && request.session !== view.sessionId)) {
        decisions.delete(id)
        answeredDecisions.add(id)
      }
    }
    const activeRequest = view.dock.kind === 'decision' ? decisions.get(view.dock.pending.id) : undefined
    const activeMemberDecision = activeRequest !== undefined && view.collaboration?.members.some(member => member.agent.sessionId === activeRequest.session)
    if (activeMemberDecision) next = withDecisionStatus({...next, dock:view.dock, stashed:view.stashed, draft:view.draft, refs:view.refs, caret:view.caret})
    if (decisionReturn !== null && !activeMemberDecision) {
      decisionReturn = { ...decisionReturn, status: next.status }
      {
        if (view.dock.kind === 'decision' || (view.dock.kind === 'picker' && view.dock.picker.source === 'task')) next = { ...next, dock: decisionReturn.dock }
        layers = decisionReturn.layers
        decisionReturn = null
      }
    }
    commit(next)
    openDecision()
  }
  options.detached?.(() => {
    if (disposed) return
    finishCurrent()
    // 尚未收到服务端接收回执的输入仍是草稿，执行者退出不能把它丢掉。
    const held = view.inputMember === undefined ? lastSubmit : inputContexts.get(undefined)?.lastSubmit
    if (held?.local !== true) settleDraft(held?.ref, true)
  })

  const openGrantsPicker = (catalog: ShellView['grants']): void => {
    // 名录没到手＝不该走到这儿（开抽屉那条路先问后开）；照防御性办：什么都不开
    if (catalog === null) return

    commit(
      openPicker(view, {
        source: 'grants',
        title: '工作区授权',
        selected: 0,
        rows: grantsRows(catalog),
        // 列表下方那行：内核有话说就说（读不懂的条目 / 写盘失败），否则「怎么用 ＋ 那笔账」
        hint: catalog.note ?? grantsHint(catalog),
      }),
    )
  }

  /**
   * 撤销之后**照着新名录重铺**——行数可能少了一条，选中项**夹回范围内**（不越界、不跳远）。
   *
   * ⚠️ **撤空了 ⇒ 收起抽屉**（P0 的同一条规矩，见 `view.ts` 的 `openPicker`）：
   * 0 行的抽屉**接管着输入却不给东西可点**——打不了字、没得选，而 `esc` 只在状态行右位提一句
   * ⇒ 看着就是卡死。收起＝把输入还回去；内核那一句 `note` 照旧落成记录区一行回执
   * （`onEvent` 那一段，不动）。
   */
  const refreshGrantsPicker = (): void => {
    const catalog = view.grants
    if (catalog === null || view.dock.kind !== 'picker' || view.dock.picker.source !== 'grants') return

    const rows = grantsRows(catalog)
    if (rows.length === 0) {
      commit(closePicker(view))
      return
    }

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...view.dock.picker,
          rows,
          selected: Math.min(view.dock.picker.selected, Math.max(0, rows.length - 1)),
          hint: catalog.note ?? grantsHint(catalog),
        },
      },
    })
  }

  const openMcpPicker = (who: string): void => {
    const catalog = view.mcp
    if (catalog === null) return // 一屏没到手＝不该走到这儿（开抽屉那条路先问后开）

    commit(
      openPicker(view, {
        source: 'mcp',
        selected: 0,
        rows: who === '' ? mcpRows(catalog) : mcpToolRows(catalog, who),
        hint: mcpHint(catalog, who === '' ? undefined : who),
      }),
    )
  }

  /**
   * 重连之后照着新读数重铺（抽屉还开着才动它——收起时就只留那一行回执）。
   *
   * 铺哪一屏由 `mcpServer` 说了算（它就是「这一扇开的是哪一屏」）——转了一圈回来
   * 状态还是同一个，不必从行内容反推（那要靠字面比较，改一句话就静默失配）。
   */
  const refreshMcpPicker = (): void => {
    const catalog = view.mcp
    if (catalog === null || view.dock.kind !== 'picker' || view.dock.picker.source !== 'mcp') return

    const picker = view.dock.picker
    const who = mcpServer
    const rows = who === '' ? mcpRows(catalog) : mcpToolRows(catalog, who)

    if (rows.length === 0) {
      commit(closePicker(view))
      return
    }

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...picker,
          rows,
          selected: Math.min(picker.selected, Math.max(0, rows.length - 1)),
          hint: mcpHint(catalog, who === '' ? undefined : who),
        },
      },
    })
  }

  /**
   * **网页服务那一屏**（U94）——未配置 ＋ 合格的 DeepSeek 官方连接。
   *
   * 合格＝`vendor: deepseek` 且没有自定义地址 / 区域（与配置加载同一判据）；
   * 不合格的连接不列出来——选了也保存不了，列出来只会让人对着一条点不中的项发呆。
   */
  const webRows = (): readonly PickerRow[] => {
    const current = view.web?.provider
    const rows: PickerRow[] = [{
      label: '未配置',
      meta: current === undefined ? '当前 · 两项网页工具都不可用' : '清除网页服务引用',
      current: current === undefined,
      value: '',
      oneLine: true,
    }]

    for (const entry of view.models) {
      // 官方区域（`region`）是既有模型连接字段，不在这里额外排除；保存/运行时按解析后的地址判。
      if (entry.vendor !== 'deepseek' || entry.baseURL !== undefined) continue
      rows.push({
        label: entry.name ?? entry.provider,
        meta: current === entry.provider ? `当前 · ${entry.provider}` : entry.provider,
        current: current === entry.provider,
        value: entry.provider,
        oneLine: true,
      })
    }

    return rows
  }

  const openWebPicker = (): void => {
    commit(openPicker(view, {
      source: 'web',
      title: '网页查询与搜索',
      selected: 0,
      rows: webRows(),
      hint: 'Search 只用这条连接；Fetch 另需 Cantrip（在 /model 配置）',
    }))
  }

  const refreshWebPicker = (): void => {
    if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'web') return
    const rows = webRows()
    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...view.dock.picker,
          rows,
          selected: Math.min(view.dock.picker.selected, Math.max(0, rows.length - 1)),
        },
      },
    })
  }

  /**
   * **`/config` 的取材**——**一处取**（开屏与每次重铺共用一份，免得两处取成两样）。
   *
   * 四路：三份读数从**视图**里取（`model.catalog` / `grants.catalog` / `mcp.catalog` 各自
   * 落下的那一格），两条路径从**入参**里取（`ConfigPaths`——那两件没有命令问得到，
   * 由装配递进来）。筛词从壳上那一位取（它不住在视图里，同 `sessionQuery`）。
   */
  const configInput = (): Parameters<typeof configRows>[0] => ({
    paths: {
      dataDir: options.dataDir,
      home: options.home,
      workspaceRoots: options.workspaceRoots,
    },
    models: view.models,
    current: view.modelCurrent,

    grants: view.grants,
    mcp: view.mcp,
    web: view.web,

    statusLine: view.statusLine,
    reducedMotion: view.reducedMotion,
    turnDuration: view.turnDuration,
    filter: configQuery,
  })

  /**
   * **`/config` 那一屏**——三份读数都到齐了才开（见 `configPending`）。
   *
   * 选中项从 0 起（每次开都从头）：这一屏不是「当前在哪条」，是**一扇门**——四行都是要进的
   * 地方，没有一条该被预先选中。
   */
  const openConfigPicker = (): void => {
    // 开一屏就是一屏新的：筛词从零起（见 `configQuery`）
    configQuery = ''
    const rows = configRows(configInput())

    commit(
      openPicker(view, {
        source: 'config',
        selected: 0,
        rows,
        filter: configQuery,
        hint: configHint({ filter: configQuery, shown: rows.length }),
      }),
    )
  }

  /**
   * **筛词一变就整个重铺**（打字 / 退格两处都调它）——与 `/resume` 那一屏同一姿势：
   * 行跟着筛词变，**选中项尽量留在原来那一项上**（用户是在找它）。
   *
   * 0 行照开（不是「收起」）：`openPicker` 那条「0 行不开抽屉」的例外正是为**正在筛**立的
   * ——0 行在筛的时候**是一个回答**（「没有这一项」），而用户手上那几个动作一个不少
   * （接着打、退格、`esc`）。那一句回答由 `configHint` 写在列表下方。
   */

  const openStatusLinePicker = (selected = 0): void => {
    const rows = statusLineRows({ config: view.statusLine })

    commit(
      openPicker(view, {
        source: 'statusline',
        selected: Math.min(Math.max(selected, 0), rows.length - 1),
        rows,
        title: STATUSLINE_TITLE,
        hint: statusLineHint(),
      }),
    )
  }

  /** 此刻那一份（没配过＝默认那条）——改一格时以它为底。 */
  const statusLineNow = (): StatusLineConfig => view.statusLine ?? { cells: [...STATUS_LINE_DEFAULT] }

  /**
   * 改一格就发 `prefs.set`；写盘结果由 `prefs.state` 回来说。
   * 收到落定读数前保留当前设置，不能把提前回显当成保存成功。
   */
  const changeStatusLine = (next: StatusLineConfig): void => {
    send({ type: 'prefs.set', statusLine: next })
  }

  /** 选定那一行＝**放上 / 拿下**（`颜色` 那一行是切换上色开关——见 `statusLineRows`）。 */
  const toggleStatusLine = (value: string): void => {
    const config = statusLineNow()

    if (value === STATUSLINE_COLOR_ACTION) {
      changeStatusLine({ ...config, color: !statusLineColorOf(config) })
      return
    }

    const key = value as StatusLineCell
    // **顺序＝挑的先后**：放上就接在末尾（它显示在状态行最右边），拿下就从表里摘掉
    const cells = config.cells.includes(key)
      ? config.cells.filter((one) => one !== key)
      : [...config.cells, key]

    changeStatusLine({ ...config, cells })
  }

  const toggleReducedMotion = (): void => {
    const next = !view.reducedMotion
    send({ type: 'prefs.set', reducedMotion: next })
  }

  const refreshConfigPicker = (): void => {
    if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'config') return

    const held = picked(view)?.value
    const rows = configRows(configInput())
    // 认不回来（那一项被筛掉了）⇒ 从头起——**不夹在旧下标上**（那会指到别的项上去）
    const at = held === undefined ? 0 : rows.findIndex((row) => row.value === held)

    commit(
      openPicker(view, {
        source: 'config',
        selected: at === -1 ? 0 : at,
        rows,
        filter: configQuery,
        hint: configHint({ filter: configQuery, shown: rows.length }),
      }),
    )
  }

  const openSkillsPicker = (
    filter: string,
    anchor: { readonly start: number; readonly end: number },
  ): void => {
    const catalog = view.skills
    const rows = skillRows(catalog?.skills ?? [], filter)

    commit(
      openPicker(view, {
        source: 'skills',
          title: '技能 · 选择后加入草稿',
        selected: 0,
        rows,
        filter,
        filterCaret:filter.length,
        anchor,
        hint: skillHint({ catalog, filter, shown: rows.length }),
      }),
    )
  }

  const bindSkill = (skill: SkillCatalogRow, anchor: { readonly start: number; readonly end: number }): void => {
    const marker = `/${skill.name}`

    commit(
      withCompletion({
        ...closePicker(view),
        ...replaceWith(
          view.draft,
          view.refs,
          { from: anchor.start, to: anchor.end },
          { kind: 'skill', marker, name: skill.name, source: skill.path },
          view.caret,
        ),
      }),
    )
  }

  /**
   * **开 `@` 那一栏**——`anchor` 是「那一段查询」在草稿里的范围（选定即替换它）。
   *
   * 与 `/skills` 同一处开合（左下抽屉）：**只是列一列**（一次列一层），选定才把引用放进正文。
   * 行由 `paths.catalog` 铺（`refreshPaths`），铺之前先把已在手上的那一份摆上（`view.paths`）。
   */
  const openPaths = (anchor: { readonly start: number; readonly end: number }, query: string): void => {
    // 行取**手上那一份**（`view.paths`）：新的一问还在路上——此刻清空列表只会闪一下
    // （答复几毫秒就到，`refreshPaths` 会把新的一批铺上；旧的那一份比空白有用）。
    const catalog = view.paths
    // 手上这一份**是不是这一问的**——不是就还在路上（那行说明据此换一句，见 `pathHint`）
    const pending = catalog === null || catalog.query !== query

    commit(
      openPicker(view, {
        source: 'paths',
        title: '引用文件或目录',
        selected: view.dock.kind === 'picker' && view.dock.picker.source === 'paths' ? view.dock.picker.selected : 0,
        rows: pathRows(catalog?.rows ?? []),
        filter: query,
        filterCaret:query.length,
        anchor,
        hint: pathHint({
          filter: query,
          shown: pending ? 0 : (catalog?.rows.length ?? 0),
          pending,
          ...(pending || catalog?.note === undefined ? {} : { note: catalog.note }),
        }),
      }),
    )
  }

  /**
   * **`@` 那一下**——开候选，并把锚点定在刚打的那个 `@` 上。
   *
   * 锚点是「选定之后要替换掉的那一段」：从 `@` 起，到用户打到哪儿为止。查询文字**同时写进
   * 草稿**（见 `typePath`）——它长在用户那句话里，不是抽屉里的一个临时输入框。
   */
  const openPathsAt = (): void => {
    const at = caretAt()
    const anchor = { start: Math.max(0, at - 1), end: at }

    openPaths(anchor, '')
    askPaths('')
  }

  /** 抽屉换成新的锚点与筛词——**不动行**（行由答复铺）。 */
  const reopenPaths = (anchor: { readonly start: number; readonly end: number }, query: string): void => {
    const picker = view.dock.kind === 'picker' && view.dock.picker.source === 'paths' ? view.dock.picker : undefined
    if (picker === undefined) return

    const catalog = view.paths
    const pending = catalog === null || catalog.query !== query

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...picker,
          filter: query,
          rows:pending?[]:picker.rows,
          anchor,
          hint: pathHint({
            filter: query,
            shown: picker.rows.length,
            ...(pending ? { pending: true } : {}),
            ...(pending || catalog?.note === undefined ? {} : { note: catalog.note }),
          }),
        },
      },
    })
  }

  /**
   * **在查询尾巴上打一个字**（`@` 那一栏里打字）——两处一起长：
   * - **草稿**（那一段查询就写在 `@` 后面，位置在锚点的尾巴上）；
   * - **锚点**（尾巴跟着长一格，选定那一刻才替换得准）。
   */
  const tabPath = (): void => {
    const anchor = view.dock.kind === 'picker' ? view.dock.picker.anchor : undefined
    const row = picked(view)
    const found = view.paths?.rows.find((one) => one.path === row?.value)
    if (anchor === undefined || found === undefined || view.dock.kind!=='picker' || view.paths?.query!==view.dock.picker.filter) return

    const text = found.kind === 'directory' ? `${found.display}/` : found.display
    const from = anchor.start + 1 // `@` 自己留着——查询那一段是它后面这一截
    // 把 `[from, anchor.end)` 换成补全后的那一段：先按删的算位移，再按插的算
    const refs = insertText(removeRange(view.refs, from, anchor.end), from, text.length)

    editAt(view.draft.slice(0, from) + text + view.draft.slice(anchor.end), from + text.length, refs)
    reopenPaths({ start: anchor.start, end: from + text.length }, text)
    askPaths(text)
  }

  const pickPath = (): void => {
    const anchor = view.dock.kind === 'picker' ? view.dock.picker.anchor : undefined
    const row = picked(view)
    const found = view.paths?.rows.find((one) => one.path === row?.value)
    if (anchor === undefined || found === undefined || view.dock.kind!=='picker' || view.paths?.query!==view.dock.picker.filter) return

    const kind = found.kind === 'directory' ? 'dir' : 'file'

    commit(
      withCompletion({
        ...closePicker(view),
        ...replaceWith(
          view.draft,
          view.refs,
          { from: anchor.start, to: anchor.end },
          {
            kind,
            marker: markerOf({ kind, name: found.display }),
            source: found.path,
            ...(found.external ? { external: true as const } : {}),
          },
          view.caret,
        ),
      }),
    )

    if (kind === 'file') {
      send({
        type: 'paths.identify',
        path: found.path,
        ...(found.external ? { external: true as const } : {}),
      })
    }
  }

  /**
   * **答复回来了，铺行**——只认「正开着 `@` 那一栏」且 query 对得上的那一次。
   *
   * 两条都由 `query` 判：**边打边问，答复可能后到**（问一次看一眼目录，是异步的）——
   * 用户已经又打了一个字时，先到的那一份就不该再铺上去（否则列表会跳回上一个词的结果）。
   */
  const refreshPaths = (): void => {
    if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'paths') return

    const query = view.dock.picker.filter ?? ''
    const catalog = view.paths
    if (catalog === null || catalog.query !== query) return

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...view.dock.picker,
          rows: pathRows(catalog.rows),
          // 选中项夹回范围内（新一批可能短了）——不越界、也不跳远
          selected: Math.min(view.dock.picker.selected, Math.max(0, catalog.rows.length - 1)),
          hint: pathHint({ filter: query, shown: catalog.rows.length, note: catalog.note }),
        },
      },
    })
  }

  /** 问一次路径候选——`query` 是 `@` 之后那一段（可以是空串）。 */
  const askPaths = (query: string): void => {
    send({ type: 'paths.list', query })
  }

  const identifyPicked = (data: Extract<KernelEvent, { kind: 'paths.identified' }>['data']): void => {
    if (view.archived) return
    const image = data.image
    if (image === undefined) return
    // 稿子里已经没有那一处了（答复后到：用户删了它 / 已经交出去了）⇒ 连号都不取
    // （取号是「这一段输入」的账，取一个用不上的只会平白多出个空号）
    if (!view.refs.some((ref) => ref.kind === 'file' && ref.source === data.path)) return

    const marker = markerOf({ kind: 'image', n: imageNumberOf(image.blob, view.refs) })
    const renamed = retype(view.draft, view.refs, caretAt(), (ref) =>
      ref.kind === 'file' && ref.source === data.path
        ? {
            marker,
            ref: {
              kind: 'image',
              source: ref.source,
              label: image.label,
              name: image.name,
              mime: image.mime,
              blob: image.blob,
              ...(ref.external === true ? { external: true as const } : {}),
            },
          }
        : undefined,
    )
    // 一处都没换 ⇒ `retype` 把**原来那个数组**原样还回来了（一个字节都没动过）
    if (renamed.refs === view.refs) return

    editAt(renamed.draft, renamed.caret, renamed.refs)
  }

  type InputContext = {
    readonly draft: string; readonly caret: number; readonly refs: readonly DraftRef[]
    readonly history: HistoryEntry[]; readonly historyAt: number; readonly browsing: { readonly text: string; readonly refs: readonly DraftRef[]; readonly caret: number } | null
    readonly lastSubmit: { readonly ref: string; readonly local?:true; readonly caret?:number; readonly text: string; readonly refs: readonly DraftRef[] } | null
  }
  const inputContexts = new Map<AgentId | undefined, InputContext>()
  const workContexts=new Map<SessionId|null,{member:AgentId|undefined;current:InputContext;members:Map<AgentId|undefined,InputContext>;purpose:ShellView['inputPurpose']}>()
  const currentInput=(from:ShellView):InputContext=>({draft:from.draft,caret:from.caret,refs:from.refs,history,historyAt,browsing,lastSubmit})
  const switchInput = (member?: AgentId): void => {
    if (member !== undefined && view.collaboration?.members.find(one => one.agent.agentId === member)?.agent.purpose === 'consultation') return
    if (member === view.inputMember) { layers=[];commit(closePicker(view)); return }
    inputContexts.set(view.inputMember,currentInput(view))
    const saved = inputContexts.get(member)
    history = saved?.history ?? []
    historyAt = saved?.historyAt ?? -1
    browsing = saved?.browsing ?? null
    lastSubmit = saved?.lastSubmit ?? null
    imageNames = new Map()
    adoptImageNames(saved?.refs ?? [])
    layers=[]
    draft({ ...closePicker(view),pendingInputs:[], inputPurpose:'current', inputMember: member, draft: saved?.draft ?? '', caret: saved?.caret ?? 0, refs: saved?.refs ?? [] })
    manageInput({type:'input.manage',action:'list'})
  }

  const showCollaborationPicker = (source: 'collaboration' | 'collaboration-member' | 'collaboration-stop', rows: readonly PickerRow[], hint: string, selected?: string): void => {
    commit(openPicker(view, { source, rows, hint: sanitizeForDisplay(hint), selected: Math.max(0, rows.findIndex((row) => row.value === selected)) }))
  }
  const openCollaboration = (selected?: string): void => {
    const snapshot = view.collaboration
    collaborationAt = undefined
    const rows = [
      ...(snapshot?.collaboration ? memberRows(snapshot) : []),
      ...(snapshot?.collaboration ? [collaborationRow('whole', '向整件工作补充', '恢复整体草稿；共同要求送达相关成员'),
      collaborationRow('constraints', '共同补充的带入情况'),
      collaborationRow('default-model', '后续派生的默认模型', '按需配置'),
      collaborationRow('stop-work', '停止整件工作', '覆盖全部成员及继续委派'),
      ...(snapshot.collaboration.state === 'stopped' ? [collaborationRow('resume-work', '明确继续整件工作', '先核对停点')] : [])] : []),
    ]
    commit(openPicker(view, { source: 'collaboration', title: '[协作成员]  │  后台命令', rows, selected: Math.max(0, rows.findIndex(row => row.value === selected)), hint: `${snapshot?.collaboration ? '查看记录不改变输入目标' : '没有协作成员'}\nTab/Shift+Tab 切换 · ↑↓ 选择 · Enter 查看 · Esc 返回` }))
  }
  const psPositions = new Map<string, { selected?: string; detailTop?: number }>()
  let backgroundAt: { command: BackgroundCommand; result?: BackgroundView['result'] } | undefined
  const openBackground = (selected?: string): void => {
    commit(openPicker(view, backgroundPicker(view.background, selected)))
  }
  const showBackgroundDetail = (selected?: string, detailTop?: number): void => {
    if (!backgroundAt) return
    const picker = backgroundDetail(backgroundAt.command, view.background, backgroundAt.result)
    commit(openPicker(view, { ...picker, selected: Math.max(0, picker.rows.findIndex(row => row.value === selected)), ...(detailTop === undefined ? {} : { detailTop }) }))
  }
  const switchPs = (): boolean => {
    if (view.dock.kind !== 'picker' || !['background', 'collaboration'].includes(view.dock.picker.source)) return false
    const picker = view.dock.picker
    psPositions.set(picker.source, { selected: picker.rows[picker.selected]?.value, detailTop: picker.detailTop })
    const source = picker.source === 'background' ? 'collaboration' : 'background'
    const position = psPositions.get(source)
    if (source === 'background') openBackground(position?.selected)
    else openCollaboration(position?.selected)
    send({ type: 'background.list' })
    if (source === 'collaboration') send({ type: 'collaboration.read' })
    return true
  }
  const openMember = (member: AgentId, selected?: string): void => {
    const snapshot = view.collaboration
    const found = snapshot?.members.find((one) => one.agent.agentId === member)
    if (found === undefined) return
    collaborationAt = member
    showCollaborationPicker('collaboration-member', [
      collaborationRow('whole', '返回整体'),
      ...(found.agent.purpose === 'consultation' ? [] : [collaborationRow('input', `向「${found.agent.name}」补充`, '仅本次委派；共同约束请给整件工作')]),
      collaborationRow('stop-member', '停止该份工作', '下一步点名具体委派'),
      collaborationRow('records', '查看完整对话与工具'),
      collaborationRow('discussions', '查看关联讨论与结果'),
      ...(found.agent.purpose === 'consultation' ? [] : [collaborationRow('member-model', '模型与思考设置', '仅这个成员')]),
    ], `${found.agent.name} · ${found.agent.purpose === 'consultation' ? '只读咨询' : found.agent.role} · ${memberState(found)} · ${found.delegation?.scope ?? '协调与整合'}`, selected)
  }
  const readCollaboration = (member?: AgentId): void => {
    if (member === undefined) { enterLayer(); openCollaboration(); send({ type: 'background.list' }) }
    collaborationQuery = member === undefined ? {} : { member }
    send({ type: 'collaboration.read', ...(member === undefined ? {} : { member }) })
  }
  const openRecords = (key: string, title: string, rows: readonly import('./view.ts').LogRow[]): void => {
    enterLayer()
    commit(openPicker(view, { source: 'collaboration-records', rows: [], selected: 0,
      reader: { key, title, rows, top: reading.get(key) ?? 0 } }))
  }
  const configureCollaboration = (member?: AgentId): void => {
    enterLayer()
    models.target(member)
    waiting = null
    send(models.request('model'))
  }
  const collaborationAction = (row: PickerRow): void => {
    const snapshot = view.collaboration
    if (snapshot?.collaboration === undefined || view.dock.kind !== 'picker') return
    const source = view.dock.picker.source
    if (source === 'collaboration-stop') {
      const delegation = snapshot.delegations.find((one) => String(one.delegationId) === row.value)
      if (delegation !== undefined) { commit(closePicker(view)); send({ type: 'collaboration.stop', delegation: delegation.delegationId }) }
      return
    }
    if (row.value === 'whole') { switchInput(); return }
    if (source === 'collaboration') {
      if (row.value === 'default-model') configureCollaboration()
      else if (row.value === 'stop-work' || row.value === 'resume-work') {
        commit(closePicker(view))
        send({ type: row.value === 'stop-work' ? 'collaboration.stop' : 'collaboration.resume' })
      } else if (row.value === 'constraints') {
        openRecords('constraints', '共同补充 · 带入不代表已遵守', snapshot.constraints.map((constraint, index) => ({
          kind: 'output', key: String(constraint.messageId), lines: [`共同补充 ${index + 1}`, ...constraint.states.map((state) =>
            `${snapshot.members.find((one) => one.agent.agentId === state.agentId)?.agent.name ?? '成员'}：${state.state === 'included' ? '已带入后续请求' : '已接收 / 待带入'}`)],
        })))
      } else readCollaboration(row.value)
      return
    }
    const member = collaborationAt
    const found = snapshot.members.find((one) => one.agent.agentId === member)
    if (member === undefined || found === undefined) return
    if (source==='collaboration-discussions') {
      const detail=memberViews.get(member)
      const messages=(detail?.messages??[]).filter(message=>String(message.discussionRoot??message.messageId)===row.value)
      if(detail!==undefined)openRecords(`${member}:discussion:${row.value}`,`${found.agent.name} · 讨论 #${row.value} · ${row.label}`,discussionRecords(detail,messages))
      return
    }
    if (row.value === 'input' && found.agent.purpose !== 'consultation') switchInput(member)
    else if (row.value === 'member-model' && found.agent.purpose !== 'consultation') configureCollaboration(member)
    else if (row.value === 'stop-member') {
      enterLayer()
      const delegations = snapshot.delegations.filter((one) => one.assigneeId === member && !['received', 'rejected', 'cancelled'].includes(one.state))
      showCollaborationPicker('collaboration-stop', delegations.map((one) => collaborationRow(String(one.delegationId),
        `停止「${one.scope}」`, delegationState[one.state])), `${found.agent.name}：只撤回选中委派及其继续分出的部分；其他委派保留`)
    } else {
      const detail = memberViews.get(member)
      if (detail === undefined) { readCollaboration(member); return }
      if (row.value === 'records') openRecords(`${member}:records`, `${found.agent.name} · 对话与工具`, memberRecords(detail, member))
      if (row.value === 'discussions') {
        enterLayer()
        const roots = [...new Set((detail.messages??[]).map(message=>message.discussionRoot??message.messageId))]
        commit(openPicker(view,{source:'collaboration-discussions',title:`${found.agent.name} · 关联讨论与结果`,selected:0,
          rows:roots.map(root=>{
            const messages=(detail.messages??[]).filter(message=>(message.discussionRoot??message.messageId)===root)
            const text=messages[0]?.body.find(part=>part.kind==='text')?.text??`讨论 #${root}`
            const title=text.split('\n')[0]!
            return {...collaborationRow(String(root),title,`讨论 #${root} · ${messages.length} 条`),oneLine:true,detail:[text]}
          }),hint:'Enter 阅读整份讨论 · Esc 返回'}))
      }
    }
  }

  const pastedClipboard = (data: Extract<KernelEvent, { kind: 'input.pasted' }>['data']): void => {

    if (view.archived) return
    if (view.dock.kind === 'picker') {
      if (data.image !== undefined || data.problem !== undefined) {
        commit(appendReceipt(view, '剪贴板里那一张取到了，但这一栏开着没收——收起之后再按一次 ctrl+v。'))
      }
      return
    }

    const image = data.image
    if (image === undefined) {
      if (data.problem !== undefined) commit(appendReceipt(view, data.problem))
      return
    }

    const at = caretAt()
    const next = replaceWith(
      view.draft,
      view.refs,
      { from: at, to: at },
      {
        kind: 'image',
        marker: markerOf({ kind: 'image', n: imageNumberOf(image.blob, view.refs) }),
        // 剪贴板来的那一张**没有落位**（设计：图不一定来自文件），故「身份」那一格
        // 写的是**出处**（内核给的 `label`），不编一个路径出来。
        source: image.label,
        label: image.label,
        name: image.name,
        mime: image.mime,
        blob: image.blob,
      },
      at,
    )

    editAt(next.draft, next.caret, next.refs)
  }

  const rememberInput = (text: string, refs: readonly DraftRef[]): void => {
    const firstCleared = history.findIndex(entry => entry.cleared !== undefined)
    history.splice(firstCleared === -1 ? history.length : firstCleared, 0, { text, refs })
    historyAt = -1; browsing = null
  }

  const manageInput = (command: import('@magic/contracts').InputManage):void => send({...command,...(view.inputMember===undefined?{}:{member:view.inputMember})})
  const inputStateText = (state: import('@magic/contracts').StoredInput['state']):string => ({pending:'待带入',consumed:'待请求带入',included:'已带入实际请求',withdrawn:'已撤回',failed:'受理失败'})[state]
  const openPendingInputs=():void=>{
    const focus=view.dock.kind==='picker'&&view.dock.picker.source==='input-pending'?picked(view)?.value:undefined
    const rows=view.pendingInputs.map(one=>collaborationRow(one.ref,one.input.text,`${one.purpose==='next'?'下一件':'当前补充'} · ${one.reason??inputStateText(one.state)}`))
    commit(openPicker(view,{source:'input-pending',title:'输入受理记录',selected:Math.max(0,rows.findIndex(row=>row.value===focus)),rows,hint:'Enter 查看详情 · Esc 返回'}))
  }

  const sendInput = (text: string, refs: readonly DraftRef[]): ShellEffect => {
    if (!connected) { commit(appendReceipt(view, 'Engine 未连接，草稿未发送。')); return NONE }
    submits += 1
    const ref = crypto.randomUUID()
    lastSubmit = { ref, text, refs }
    submittedBatches.set(ref, { history, through: clearedSequence })
    const purpose = view.inputPurpose

    const cleared: ShellView = { ...view, draft: '', caret: 0, refs: [], inputPurpose:'current' }

    imageNames = new Map()
    // 历史记的是**整份草稿**：正文 ＋ 它里面的引用（位置与身份都在，见 `HistoryEntry`）——
    // `↑` 翻回来的是**当时那一句**，接着改、再发一次都不必重选。
    // 每次明确提交都记一次，召回与取消不另记。
    rememberInput(text, refs)

    const echoed = view.inputMember === undefined ? appendEcho(cleared,text,userImages(refs)) : cleared
    draft({...echoed,rows:echoed.rows.map((row,index)=>row.kind==='user'&&index===echoed.rows.length-1?{...row,inputRef:ref,inputState:'提交中'}:row)})
    const input = { text, ref, purpose, ...(refs.length === 0 ? {} : { refs: wire(refs) }) }
    send(view.collaboration?.collaboration === undefined ? { type: 'input.submit', ...input }
      : { type: 'collaboration.input', input, ...(view.inputMember === undefined ? { shared: true } : { member: view.inputMember }) })

    return NONE
  }

  const attachMaterial = (material: UserImage): void => {
    if (view.archived) return
    const at = Math.max(0, Math.min(view.caret, view.draft.length))

    commit(
      withCompletion({
        ...view,
        ...replaceWith(
          view.draft,
          view.refs,
          { from: at, to: at },
          {
            kind: 'image',
            // 编号按**内容身份**发：同一张图（同一个 blob）放两次拿到同一个号
            marker: markerOf({ kind: 'image', n: imageNumberOf(material.blob, view.refs) }),
            name: material.name,
            mime: material.mime,
            blob: material.blob,
            label: material.label,
            source: material.source,
          },
          view.caret,
        ),
      }),
    )
  }

  const exportMaterial = (material: UserImage): void => {
    send({ type: 'image.export', blob: material.blob, name: material.name, mime: material.mime })
  }

  /**
   * **认下「这一份交出去的东西」的终态**——失败那一条的正文与引用，按 `keepDraft` 处置。
   *
   * 三条分寸：
   * - **只认自己交出去的那一份**（`ref` 对不上、或没有等着认领的＝不是这一次，不动）；
   * - **用户动过草稿就不认**（`edit` 已经把 `lastSubmit` 清了）——那正是「不覆盖后来编辑的新稿」；
   * - **认领一次就清掉**：同一份不会被两条失败各还一遍。
   *
   * 回执（「没送出：…」那一行）由 `reduce` 落——它说的是**这一次交代没出去**。
   * 本函数只管草稿：交出那一份**还在**，但要不要摆回输入行，由产生方说（`keepDraft`）。
   * **不摆回去≠丢掉**——它在 `↑` 历史里（`sendInput` 交出去那一刻就记下了），
   * 用户按 `↑` 照样翻得回来（见 `input.settled.keepDraft` 那条注）。
   */
  const settleDraft = (ref: string | undefined, keepDraft: boolean): void => {
    // 名字避开外面那个 `waiting`（等选择器的意图）——两件不相干的事，别撞名
    for (const [target, context] of inputContexts) {
      const held = context.lastSubmit
      if (target === view.inputMember || held === null || held.ref !== ref) continue
      inputContexts.set(target, { ...context, lastSubmit: null, ...(keepDraft ? { draft: held.text, refs: held.refs, caret: held.text.length } : {}) })
      return
    }
    const held = lastSubmit
    if (held === null || ref === undefined || held.ref !== ref) return

    lastSubmit = null
    if (!keepDraft) return
    // 插入点摆到末尾（那一份交出去时多半已经打完了）；引用原样回到原位
    commit(
      withCompletion({
        ...view,
        draft: held.text,
        caret: held.caret??held.text.length,
        refs: held.refs,
      }),
    )
  }

  // —— 键 ——

  /**
   * **这一轮还在跑吗**（模型在途 / 工具在跑）——**与左下开着哪一屏无关**。
   *
   * 「工具在跑」那一支也认**挂着卡那一笔**：卡占住屏的时候它的行状态照旧是 `running`
   * （`reduceToolResult` 才落地）——「等你」不是「没在跑」，别把它漏出去。
   */
  const working = (): boolean =>
    view.status.state === 'working' ||
    view.status.state === 'retrying' ||
    hasRunningTool(view)

  /** 在途那三档（运行事实里）——`stopped` / `idle` / `unknown` 不算「手上还有事」。 */
  const ACTIVE_RUN_STATES: ReadonlySet<RunRow['state']> = new Set(['running', 'waiting', 'stopping'])

  /** 本窗这条会话、运行事实说的那一格——还没有会话 / 表里没它 ⇒ `undefined`（不编）。 */
  const runStateNow = (): RunRow['state'] | undefined => {
    const id = view.sessionId
    if (id === null) return undefined

    return view.runs.find((one) => one.session === id)?.state
  }

  const inFlight = (): boolean => {

    if (view.status.state === 'lost') return false
    if (working() || decisions.size > 0 || view.dock.kind === 'decision') return true

    const state = runStateNow()
    return state !== undefined && ACTIVE_RUN_STATES.has(state)
  }

  /** 那道门的钟（`undefined` ＝ 没挂着）。挂上时起、撤下时清——**两处收口见下**。 */
  let exitArmTimer: ReturnType<typeof setTimeout> | undefined

  /** 撤钟——只清定时器，**不动视图**（视图那一半按调用处的情形走）。 */
  const stopExitClock = (): void => {
    if (exitArmTimer === undefined) return

    clearTimeout(exitArmTimer)
    exitArmTimer = undefined
  }

  /**
   * **把那一行撤掉 ＋ 收钟**——「任何别的输入」与「中断那一下」两条路共用这一处。
   *
   * ⚠️ **两件必须一起做**（只撤行、不收钟的话，那支钟到点还会把**后来重新挂上的**那一次
   * 误撤掉：用户会看到「明明刚按过，它却自己没了」）。同理，起钟前也得先清旧的
   * （见 `armExit`），一处挂只留一支钟。
   */
  const disarmExit = (): void => {
    stopExitClock()
    if (view.exitArmed) commit({ ...view, exitArmed: false })
  }

  const armExit = (): void => {
    stopExitClock()
    commit({ ...view, exitArmed: true })
    exitArmTimer = setTimeout(() => {
      exitArmTimer = undefined
      if (!view.exitArmed) return
      commit({ ...view, exitArmed: false })
    }, EXIT_ARM_MS)
    exitArmTimer.unref?.()
  }

  const exitOrInterrupt = (): ShellEffect => {
    // **菜单正中开着**（三选已经摆在那儿）——再按 `ctrl+c` 只**返回**，不隐式执行任何一项
    // （设计明文：「菜单中再按 Ctrl+C 也只返回，不隐式执行任何一项；没有倒计时或自动确认」）。
    if (view.dock.kind === 'picker' && view.dock.picker.source === 'task') {
      closeTaskMenu()
      return NONE
    }

    if (inFlight()) {
      disarmExit()
      openTaskMenu()
      return NONE
    }

    if (!view.exitArmed) {
      armExit()
      return NONE
    }

    // 第二下（在钟内）——放行。钟随这一下收掉：退出之后它再烧一次只是白叫醒一个没人看的屏。
    stopExitClock()
    return EXIT
  }

  const TASK_ROWS: readonly PickerRow[] = [
    {
      label: '停止任务',
      meta: '停止当前任务，留在 Magic',
      current: false,
      value: 'stop',

      oneLine: true,
    },
    { label: '转到后台', meta: '退出界面，任务继续运行', current: false, value: 'background', oneLine: true },
    { label: '停止并退出', meta: '停止当前任务并退出 Magic', current: false, value: 'stop-exit', oneLine: true },
  ]

  const taskPickerOf = (asked: boolean, selected = 0): Picker => ({
    source: 'task',
    title: asked ? '当前任务正在等待你' : '当前任务仍在运行',
    rows: TASK_ROWS,
    selected,
  })

  /**
   * **这一屏正开着吗**——`dock` 是唯一真源（`taskMenu` 只是「打开那一刻绑定的是哪条」）。
   */

  let taskMenu: {
    readonly session: SessionId | null
    readonly taskEntry: RecordId | null
    readonly runStartedAt: number | null
    readonly asked: boolean
  } | null = null

  const openTaskMenu = (): void => {
    if (view.dock.kind === 'picker' && view.dock.picker.source === 'task') return

    const asked = view.dock.kind === 'decision'
    const row = view.runs.find((one) => one.session === view.sessionId)
    taskMenu = {
      session: view.sessionId,
      taskEntry: view.taskEntry,
      runStartedAt: row?.startedAt ?? null,
      asked,
    }

    if (asked) layers = [...layers, layerNow()]
    else enterLayer()

    commit(openPicker(view, taskPickerOf(asked || decisions.size > 0)))
  }

  const closeTaskMenu = (): void => {
    taskMenu = null
    popLayer()
  }

  const stillBound = (bound: typeof taskMenu): boolean => {
    if (bound === null) return true // 手搭的视图 / 不是从菜单进来的——没绑过，不拦

    if (!inFlight()) return false
    if (bound.session !== null && view.sessionId !== bound.session) return false
    if (bound.taskEntry !== null && view.taskEntry !== bound.taskEntry) return false

    // **那一代运行换没换**——⚠️ **只在两边都读得到时比**：打开那一刻运行事实还没推到
    // （首条消息刚发出去的那几百毫秒），格子里是 `null`；那一档**不拦**（拿不准的不拦，
    // 真换了那一代，管理者那一头会照实回一句——它才是判「停的是谁」的人）。
    const row = view.runs.find((one) => one.session === view.sessionId)
    if (row === undefined || bound.runStartedAt === null) return true
    return row.startedAt === bound.runStartedAt
  }

  /** 接回固定携带所选父目录，覆盖目标终端的环境；路径沿 POSIX 单引号引用。 */
  const resumeCommandOf = (session: SessionId): string => {
    const instance = `MAGIC_HOME=${shellQuote(dirname(options.magicBase))} `
    const workspace = view.catalog.find(one => one.id === session)?.workspace?.[0] ?? options.workspaceRoots?.[0]
    const cwd = workspace === undefined ? '' : `cd -- ${shellQuote(workspace)} && `
    return `${cwd}${instance}magic resume ${shellQuote(session)}`
  }

  const taskAction = (value: string): ShellEffect => {
    const bound = taskMenu
    // 无论走哪一支，这一屏都算答完了（下面两支停止的「话」由 `stopped` 那条线说）
    taskMenu = null

    if (!stillBound(bound)) {
      closeTaskMenu()
      return NONE
    }

    if (value === 'stop') {
      closeTaskMenu()
      if (options.stop === undefined) {
        // 没有来路（用例 / 演示）——**如实说**，不留一个按下去没反应的选项
        commit(appendReceipt(view, '这个窗口没有连着运行管理——停不了'))
        return NONE
      }
      // 会话还没认出来（首条消息刚开张那几百毫秒）：挂上「等」，活跃位一到再停（见 `waitsForSession`）
      if (view.sessionId === null) {
        waitsForSession = 'stop'
        return NONE
      }
      options.stop(view.sessionId, 'run')
      return NONE
    }

    // ② **转到后台**——退出界面，工作照跑。**这一支只改本地视图一格**（见上）。
    //
    //    ⚠️ **离开之前留一条接回入口**（设计明文：「转后台成功离开时，**留一条可复制的
    //    接回入口**（沿用 `magic resume <id>`；按实际配置保留必要启动参数），不追加常驻
    //    状态栏」）。它是**一行记录**（进 scrollback）：这一屏走后内容留在终端里，
    //    用户想接回来时那串命令就在眼前、可以整行复制。
    //    ⚠️ 不关菜单再走：这一屏马上就要没了（`leaving` 一置，`app.ts` 那一处 `useEffect`
    //    当场收摊），先关它只是多画一帧。
    if (value === 'background') {
      if (view.sessionId === null) {
        // **会话还没认出来**：此刻走掉就**留不出一条可复制的接回入口**（设计要的那一条），
        // 而「转到后台了」也是一句没底的话。故**留在界面等**——活跃位一到就照常走
        // （见 `waitsForSession`；它与 `/exit`、「停止任务」共用那一条等待）。
        waitsForSession = 'background'
        return NONE
      }

      leaveForBackground()
      return NONE
    }

    closeTaskMenu()
    return beginExit()
  }

  const beginExit = (): ShellEffect => {
    const target = view.sessionId

    // ① **没有停止的来路**（用例 / 演示：`options.stop` 没接上）：这台外壳背后没有
    //    「服务那一头」，自然也没有可停的运行——直接走，**不留话**（没有发生过
    //    「停掉什么」这件事，印一句「没停成」反倒是在报一件没发生的事）。
    if (options.stop === undefined) {
      commit({ ...view, leaving: true })
      return NONE
    }

    if (target === null) {
      if (inFlight()) waitsForSession = 'exit'
      else commit({ ...view, leaving: true })
      return NONE
    }

    stopForExit(target)
    return NONE
  }

  /** 仅断开入口；恢复命令由 runTui 在终端卸载后统一输出。 */
  const leaveForBackground = (): void => {
    commit({ ...view, leaving: true })
  }

  const stopForExit = (target: SessionId): void => {
    exitWait = target
    options.stop?.(target, 'run')
  }

  const reconnect = (): ShellEffect => {
    if (reopening || options.reopen === undefined) return NONE
    reopening = true
    commit(view)
    void options.reopen().then(() => {
      if (disposed) return
      connected = true
      commit(appendReceipt(withRunFacts(patchStatus({ ...view, flash: null }, { state: 'idle', amount: null, hint: HINT_IDLE }), options.runs?.current() ?? view.runs), 'Magic Code 已连接，正在刷新当前会话。草稿未发送。'))
      readHistory()
      openDecision()
    }, error => {
      if (!disposed) commit(appendReceipt(view, `重新连接失败：${String(error)}`))
    }).finally(() => { reopening = false; if (!disposed) commit(view) })
    return NONE
  }

  const disconnect = (why?: string): void => {
    if (disposed || !connected) return
    connected = false
    view = { ...view, background: { commands: view.background?.commands ?? [], waiting: [], unknown: true } }
    const unconfirmed = new Set([...view.settled, ...view.rows].filter(row => row.kind === 'user' && row.inputState === '提交中').map(row => row.kind === 'user' ? row.inputRef : undefined))
    if (lastSubmit !== null && unconfirmed.has(lastSubmit.ref)) settleDraft(lastSubmit.ref, true)
    const mark = (row: import('./view.ts').LogRow) => row.kind === 'user' && unconfirmed.has(row.inputRef) ? { ...row, inputState: '未确认接收（连接已断开）' } : row
    for (const id of decisions.keys()) answeredDecisions.delete(id)
    decisions.clear()
    returnDecision()
    pendingResume = null
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = undefined
    const waiting = exitWait !== null
    exitWait = null
    commit(patchStatus(appendReceipt({ ...view, settled: view.settled.map(mark), rows: view.rows.map(mark) }, `连接已断开${why ? `（${why}）` : ''}，暂时无法确认任务状态。${waiting ? '停止尚未确认。' : ''}`), { state: 'lost', amount: null, hint: HINT_LOST }))
  }

  let verticalColumn:number|null=null
  const key = (input: ShellKey): ShellEffect => {
    if(input.kind!=='up'&&input.kind!=='down')verticalColumn=null
    if (disposed) return NONE
    if (input.kind === 'ctrl+r') { managementPending = null; return reconnect() }
    if (managementPending !== null && input.kind !== 'ctrl+c') return NONE
    if (input.kind === 'enter' && view.dock.kind === 'picker' && view.dock.picker.source === 'session' && view.flash?.endsWith(' · Enter 重试')) { directory.query(); return NONE }
    if (input.kind === 'ctrl+g') {
      if (view.dock.kind === 'picker' && view.dock.picker.source === 'session') {
        const row = picked(view); if (row !== undefined) showSessionActions(row.value)
      } else if (view.archived && view.dock.kind === 'input' && view.sessionId !== null) showSessionActions(view.sessionId)
      return NONE
    }
    if (view.archived && view.dock.kind === 'input') {
      if (input.kind === 'char' && input.char.startsWith('/')) {
        prompt.open({ label: '只读会话命令', secret: false, value: input.char, caret: input.char.length, placeholder: '/resume',
          submit: value => { if (value.trim() === '/resume') { models.cancelOpen(); waiting = 'session'; directory.ordinary(); return { type: 'session.list', archived: false } }; return null } })
        return NONE
      }
      if (!['ctrl+c', 'ctrl+o', 'escape', 'planTop', 'ctrl+t'].includes(input.kind)) {
        commit({ ...view, flash: '已归档，原草稿保留。Ctrl+G 查看草稿或明确恢复；/resume 切换会话。' }); return NONE
      }
    }
    if (input.kind === 'enter' && view.dock.kind === 'input' && view.draft.trim() === '/connect') {
      commit({ ...view, draft: '', caret: 0, refs: [], completion: null })
      return reconnect()
    }
    if (!connected && input.kind === 'enter' && view.dock.kind === 'input' && !view.draft.trim().startsWith('/')) {
      commit({ ...view, flash: options.settingsOnly ? '本地设置不发送任务，草稿已保留；退出后运行 magic 开始工作。' : '连接已断开，草稿未发送。输入 /connect 或按 Ctrl+R 重连。' })
      return NONE
    }

    if (input.kind !== 'ctrl+c') disarmExit()
    if (input.kind === 'escape' && collaborationQuery !== null) {
      collaborationQuery = null
      collapseDock()
      return NONE
    }
    if (input.kind === 'pickerDetailTop') {
      if (view.dock.kind === 'picker') commit({...view, dock:{kind:'picker',picker:{...view.dock.picker,detailTop:input.top}}})
      return NONE
    }
    if (input.kind === 'readerTop') {
      if (view.dock.kind === 'decision' && decisionReturn?.dock.kind === 'picker' && decisionReturn.dock.picker.reader !== undefined) {
        const picker = decisionReturn.dock.picker
        decisionReturn = { ...decisionReturn, dock: { kind: 'picker', picker: { ...picker, reader: { ...picker.reader!, top: Math.max(0, input.top) } } } }
        return NONE
      }
      if (view.dock.kind === 'picker' && view.dock.picker.reader !== undefined) {
        const picker = view.dock.picker
        commit({ ...view, dock: { kind: 'picker', picker: { ...picker, reader: { ...picker.reader!, top: Math.max(0, input.top) } } } })
      }
      return NONE
    }
    if (view.dock.kind === 'picker' && view.dock.picker.source === 'session-history' && input.kind === 'enter' && view.flash !== null) {
      const session = view.dock.picker.reader!.key.slice('session:'.length)
      preview = { session, entries: [] }; commit({ ...view, flash: null }); send({ type: 'history.read', session }); return NONE
    }
    if (view.dock.kind === 'picker' && view.dock.picker.reader !== undefined
      && !['left', 'escape', 'ctrl+c', 'memberInput', 'memberMenu', 'ctrl+o', 'tab'].includes(input.kind)) return NONE

    if (view.dock.kind === 'picker' && ['paths','skills','session','config'].includes(view.dock.picker.source)) {
      const picker=view.dock.picker, query=picker.filter??''
      const caret=picker.filterCaret??query.length
      if(input.kind==='left'||input.kind==='right'){
        const at=input.kind==='left'?stepLeft(query,caret):stepRight(query,caret)
        commit({...view,...(picker.source==='paths'&&picker.anchor!==undefined?{caret:picker.anchor.start+1+at}:{}),dock:{kind:'picker',picker:{...picker,filterCaret:at}}})
        return NONE
      }
      if (input.kind === 'backspace' && picker.source === 'paths' && query === '' && caret === 0) { popLayer(); return NONE }
      if(['char','paste','backspace','delete'].includes(input.kind)){
        const from=input.kind==='backspace'?stepLeft(query,caret):caret
        const to=input.kind==='delete'?stepRight(query,caret):caret
        const text=input.kind==='char'?input.char:input.kind==='paste'?sanitizeForDisplay(input.text):''
        const next=query.slice(0,from)+text+query.slice(to), at=from+text.length
        if(picker.source==='paths'&&picker.anchor!==undefined){
          const anchor=picker.anchor, start=anchor.start+1
          editAt(view.draft.slice(0,start)+next+view.draft.slice(anchor.end),start+at,insertText(removeRange(view.refs,start,anchor.end),start,next.length))
          reopenPaths({start:anchor.start,end:start+next.length},next);askPaths(next)
        }else if(picker.source==='skills')openSkillsPicker(next,picker.anchor??{start:0,end:0})
        else if(picker.source==='session'){directory.filter(next)}
        else {configQuery=next;refreshConfigPicker()}
        if(view.dock.kind==='picker')commit({...view,dock:{kind:'picker',picker:{...view.dock.picker,filterCaret:at}}})
        return NONE
      }
    }

    // 纯列表左键返回；查询和本地字段优先处理光标移动。
    if (input.kind === 'left' && view.dock.kind === 'picker' && !['paths','skills','session','config'].includes(view.dock.picker.source)) {
      popLayer()
      return NONE
    }

    if (view.dock.kind === 'prompt' && input.kind !== 'ctrl+c') { prompt.key(input); return NONE }

    switch (input.kind) {
      case 'ctrl+c':
        if (view.dock.kind === 'input' && editingPending === null && (view.draft.length > 0 || view.refs.length > 0)) {
          if (historyAt === -1 || history[historyAt]?.cleared === undefined) {
            history.push({ text: view.draft, refs: view.refs, caret: view.caret, cleared: ++clearedSequence })
          }
          disarmExit()
          imageNames = new Map()
          edit({ ...view, draft: '', caret: 0, refs: [], completion: null })
          return NONE
        }
        return exitOrInterrupt()

      case 'ctrl+p':
      case 'ctrl+n':
        if (view.dock.kind === 'input') recallHistory(input.kind === 'ctrl+p' ? -1 : 1)
        return NONE

      case 'alt+enter':
        if(view.dock.kind!=='input')return NONE
        layers=[...layers,layerNow()]
        commit(openPicker(view,{source:'input-purpose',title:'本条输入用途',selected:view.inputPurpose==='next'?1:0,rows:[collaborationRow('current','当前补充','当前工具结束、下一工具前带入'),collaborationRow('next','下一件','前项工具、委派及待答结束后开始'),collaborationRow('pending','待处理输入','查看、编辑、撤回或明确继续')],hint:'选择用途不发送 · Esc 返回'}))
        return NONE

      case 'memberInput':
        if (collaborationAt !== undefined) switchInput(collaborationAt)
        return NONE
      case 'memberMenu':
        if (collaborationAt !== undefined) { enterLayer(); openMember(collaborationAt, 'records') }
        return NONE

      case 'ctrl+o':
        return OPEN_SCREEN

      case 'ctrl+t':
        if (!hasPlan(view)) return NONE
        commit({ ...view, planCollapsed: !view.planCollapsed })
        return NONE

      // 翻页的目标位置由渲染层算好（见 `ShellKey.planTop` 那段注）——这儿只存。
      //
      // ⚠️ **接管着就不翻**（设计：翻页只在清单溢出且**没有选择器/审批接管**时生效）：
      //    那两种时候左下那一块另有主人（候选要上下选、裁决要作答），翻页让位。
      //    「溢出」那一半不必再判：没溢出时渲染层给的 `top` 就是当前值（`planWindow`
      //    夹住了），存下去等于没动。
      // 夹一道下界：手搭的视图可能给过负数（同 `caretAt` 那种防御）。
      case 'decisionTop':
        if (view.dock.kind === 'decision') commit({ ...view, dock: { ...view.dock, pending: { ...view.dock.pending, top: input.top } } })
        return NONE

      case 'planTop':
        if (view.dock.kind !== 'input') return NONE
        commit({ ...view, planTop: Math.max(0, Math.trunc(input.top) || 0) })
        return NONE

      case 'paste':
        if (view.dock.kind === 'decision') {
          commit(said(view, '先答复——此刻粘不了（这一轮在等你）。草稿在，答完接着打。'))
          return NONE
        }
        // 抽屉开着时粘贴一律不收：`@` 那一栏的查询与草稿是**同一段文字**（见 `typePath`），
        // 从旁路插一刀会让锚点与正文对不上；其余抽屉更是接管着输入（打进去的字一律吞掉）。
        if (view.dock.kind === 'picker') return NONE
        // **原文照收**：粘贴进来的那一串一个字不改（Tab、多行都留着——它们是正文）
        insertAt(input.text)
        return NONE

      case 'ctrl+v':
        if (view.dock.kind === 'decision') {
          commit(said(view, '先答复——此刻贴不了图（这一轮在等你）。答完接着贴。'))
          return NONE
        }
        if (view.dock.kind === 'picker') return NONE
        send({ type: 'input.paste' })
        return NONE

      case 'escape':
        if(editingPending!==null){const pending=editingPending;editingPending=null;restoreLayer(pending.back);return NONE}
        if (view.dock.kind === 'picker') {

          if (view.dock.picker.source === 'task') {
            closeTaskMenu()
            return NONE
          }
          popLayer()
          return NONE
        }
        // 本地小输入开着时到不了这一支（上面那道门把它交给 `askKey`，它认 `esc`＝`closeAsk`）
        if (view.dock.kind === 'prompt') return NONE
        if (view.dock.kind === 'decision') { returnDecision(); return NONE }
        // 候选开着 ⇒ 先**收起候选**（原型：`esc` 收起；草稿留着）
        if (view.completion !== null) return (commit({ ...view, completion: null }), NONE)
        // 主输入复用菜单的停止动作及其身份校验。
        if (inFlight()) { openTaskMenu(); return taskAction('stop') }
        return NONE

      case 'up':
      case 'down': {
        const delta = input.kind === 'up' ? -1 : 1
        if (view.dock.kind === 'picker') {
          const moved = movePicker(view, delta)
          commit(moved.dock.kind === 'picker' ? {...moved,dock:{kind:'picker',picker:{...moved.dock.picker,detailTop:0}}} : moved)
          return NONE
        }
        // 候选开着 ⇒ 在候选里选（原型 · 场景 11）；否则才是输入历史
        if (view.dock.kind !== 'decision' && view.completion !== null) {
          commit(moveCompletion(view, delta))
          return NONE
        }
        if (view.dock.kind === 'decision') {
          const pending = view.dock.pending
          const count = decisionActions(pending).length
          const selected = pending.selected === undefined ? (delta > 0 ? 0 : count - 1) : (pending.selected + delta + count) % count
          commit({ ...view, dock: { ...view.dock, pending: { ...pending, selected } } })
          return NONE
        }
        if (historyAt !== -1) { recallHistory(delta); return NONE }
        const columns = input.columns ?? 160
        const layout = composerLayout(view.draft, view.caret, columns)
        if (layout.rows.length > 1) {
          const row = layout.caretRow ?? 0
          const target = Math.max(0, Math.min(layout.rows.length - 1, row + delta))
          if (target === row) return NONE
          verticalColumn??=layout.caretCol
          const points=[0,...Array.from(new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(view.draft),one=>one.index+one.segment.length)].filter(at=>!view.refs.some(ref=>ref.start<at&&at<ref.end))
          const geometry=new Map<number,ReturnType<typeof composerLayout>>()
          const at=(index:number)=>{let found=geometry.get(index);if(found===undefined){found=composerLayout(view.draft,points[index]!,columns);geometry.set(index,found)}return found}
          const lower=(pred:(index:number)=>boolean,from=0,to=points.length)=>{while(from<to){const mid=Math.floor((from+to)/2);if(pred(mid))to=mid;else from=mid+1}return from}
          const start=lower(index=>(at(index).caretRow??0)>=target)
          const end=lower(index=>(at(index).caretRow??0)>target,start)
          const near=lower(index=>at(index).caretCol>=verticalColumn!,start,end)
          const choices=[near-1,near].filter(index=>index>=start&&index<end)
          const best=choices.sort((a,b)=>Math.abs(at(a).caretCol-verticalColumn!)-Math.abs(at(b).caretCol-verticalColumn!))[0]
          if(best!==undefined)commit({...view,caret:points[best]!})
        } else recallHistory(delta)
        return NONE
      }

      case 'shift+tab':
        if (switchPs()) return NONE
        if (view.dock.kind === 'picker' && view.dock.picker.source === 'session') {
          directory.toggleArchived()
        }
        return NONE
      case 'tab':
        if (switchPs()) return NONE
        if (view.dock.kind === 'input' && historyAt !== -1) { historyAt = -1; browsing = null; draft(view); if (view.completion !== null) return NONE }
        if (decisions.size > 0 && ((view.dock.kind === 'input' && view.completion === null) || (view.dock.kind === 'picker' && view.dock.picker.reader !== undefined))) { openDecision(); return NONE }
        // `Tab` 补全（原型 · 场景 11）；没有候选时什么也不做（Tab 不当正文）
        if (view.dock.kind === 'picker') {
          // 路径那一栏里 `Tab` ＝ **把选中的那一条补进查询**（目录则再往里看一层）
          if (view.dock.picker.source === 'paths') tabPath()

          if (view.dock.picker.source === 'session') {
            directory.toggleScope()
          }
          return NONE
        }
        if (view.completion !== null) pickCompletion()
        else if (view.collaboration?.collaboration !== undefined || view.background !== undefined) readCollaboration()
        return NONE

      case 'ctrl+x':
        return askStop('run')

      case 'ctrl+w':
        return askStop('turn')

      case 'enter':
        return submit()

      case 'left':
        if (view.dock.kind === 'decision') return refuse('左移')
        // 明确移动插入点后退出历史浏览，回到文字编辑。
        // 插入点挨着一处引用时**整处跨过去**（引用是一个编辑单位，见 `inline.ts`）。
        historyAt = -1; browsing = null
        draft({ ...view, caret: stepLeftOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'right':
        if (view.dock.kind === 'decision') return refuse('右移')
        if (view.dock.kind === 'picker') {
          if (view.dock.picker.source === 'session' && picked(view)?.value === view.sessionId) { readCollaboration(); return NONE }

          if (view.dock.picker.source === 'model' && models.snapshot().modelScope !== 'session') {
            const pick = picked(view)?.pick

            if (pick !== undefined) {
              enterLayer()
              models.openDetail(pick)
            }
          }
          return NONE
        }
        historyAt = -1; browsing = null
        draft({ ...view, caret: stepRightOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'lineStart':
      case 'lineEnd': {
        const to = input.kind === 'lineStart' ? '行首' : '行末'
        if (view.dock.kind === 'decision') return refuse(to)
        if (view.dock.kind === 'picker') return NONE

        const [start, end] = lineSpan(view.draft, caretAt())
        historyAt = -1; browsing = null
        draft({ ...view, caret: input.kind === 'lineStart' ? start : end })
        return NONE
      }

      case 'backspace':
        if (view.dock.kind === 'decision') return refuse('退格')
        if (view.dock.kind === 'picker') return NONE
        const erase = backspaceRange(view.refs, view.draft, caretAt())
        eraseAt(erase.from, erase.to)
        return NONE

      // 前向删除（`delete` 键）——删插入点右边那一个单位（引用整个走）
      case 'delete':
        if (view.dock.kind === 'decision') return refuse('删除')
        if (view.dock.kind === 'picker') return NONE
        const gone = deleteRange(view.refs, view.draft, caretAt())
        eraseAt(gone.from, gone.to)
        return NONE

      case 'char':
        if (view.dock.kind === 'decision') return refuse(input.char)
        if (view.dock.kind === 'picker') return NONE
        const previous=layerNow()
        insertAt(input.char)
        // `@` 在**词边界**上 ⇒ 开路径候选（邮箱那种紧挨着字的 `@` 不触发；
        // 前面带反斜杠的转义 `@` 也不触发——它只想打一个 `@`）
        if (input.char === '@' && opensPath(view.draft, caretAt())) { layers=[...layers,previous];openPathsAt() }
        return NONE

      // `shift+回车`——**换行**（原型 · 键盘）。接管期间同其余键：不静默吞，说一句。
      case 'newline':
        if (view.dock.kind === 'decision') return refuse('换行')
        if (view.dock.kind === 'picker') return NONE
        insertAt('\n')
        return NONE

      case 'other':
        return view.dock.kind === 'decision' ? refuse(input.label) : NONE
    }
  }

  const returnDecision = (): void => {
    const saved = decisionReturn
    if (saved === null) return
    decisionReturn = null
    const back = undock(view)
    commit({ ...back, dock: saved.dock })
    layers = saved.layers
  }

  const openDecision = (): void => {
    const request = decisions.values().next().value
    if (request === undefined || !connected || view.dock.kind === 'decision') return
    decisionReturn = { dock: view.dock, layers, status: view.status }
    commit(reduce(view, request, { timing: false }))
  }

  const answer = (): ShellEffect => {
    const pending = view.dock.kind === 'decision' ? view.dock.pending : undefined
    if (pending === undefined || !connected || !decisions.has(pending.id) || answeredDecisions.has(pending.id)) return NONE
    const action = pending.selected === undefined ? undefined : decisionActions(pending)[pending.selected]
    if (action === undefined) return refuse('回车；请先用 ↑↓ 选择')
    // 回执前保留卡与草稿暂存，连续 Enter 既不能重复作答，也不能发送原稿。
    answeredDecisions.add(pending.id)
    send({ type: 'decision.answer', id: pending.id, decision: action.decision, ...(action.remember ? { remember: true } : {}) })
    commit(view)
    return NONE
  }

  /** 接管期间的非答复键——忽略，但**当场说一句**（「不静默吞键」）。 */
  const refuse = (label: string): ShellEffect => {
    const what = label === '' ? '这个键' : `「${label}」`
    commit(said(view, `先答复——${what}此刻不管用（这一轮在等你）。草稿在，答完接着打。`))
    return NONE
  }

  /** 回车——接管 / 选择器 / 输入三种归处。 */
  const submit = (): ShellEffect => {
    // **启动中不收**（技术方案 · 装配视图第 5 步：以 `boot` 完成为界）——草稿留着
    if (!ready) return bootRefusal()
    if (view.archived && (view.dock.kind === 'input' || view.dock.kind === 'decision')) { commit({ ...view, flash: '会话已归档，请明确恢复后继续' }); return NONE }
    if (view.dock.kind === 'decision') return answer()
    // 本地小输入开着 ⇒ 回车是**把它交出去**（不是发交代——那一路归 `input.submit`）
    if (view.dock.kind === 'prompt') { prompt.submit(); return NONE }

    if (view.dock.kind === 'picker') {
      const row = picked(view)
      if (row === undefined) return NONE
      if (view.dock.picker.source === 'background') {
        const command = view.background?.commands.find(one => backgroundKey(one) === row.value)
        if (command) { enterLayer(); backgroundAt = { command }; showBackgroundDetail() }
        return NONE
      }
      if (view.dock.picker.source === 'background-detail' && backgroundAt) {
        if (row.value === 'back') popLayer()
        else if (row.value === 'copy') {
          const copying = options.copyText?.(backgroundAt.command.outputPath) ?? Promise.reject(new Error('本机剪贴板未接入'))
          void copying.then(() => { if (!disposed) commit(appendReceipt(view, '已复制完整输出路径')) },
            error => { if (!disposed) commit(appendReceipt(view, `复制失败：${String(error)}`)) })
        }
        else if (row.value === 'stop') {
          const { execution, session, id } = backgroundAt.command
          send({ type: 'background.stop', target: { execution, session, id } })
        }
        return NONE
      }
      if (view.dock.picker.source === 'session-actions') {
        if (sessionTarget === undefined) return NONE
        if (row.value === 'history') showSessionHistory(sessionTarget)
        else if (row.value === 'archive' || row.value === 'restore') manageSession(row.value === 'archive' ? 'session.archive' : 'session.restore')
        else if (row.value === 'rename') {
          const session = sessionTarget, title = nameOfSession(session)
          enterLayer()
          prompt.open({ label: '会话名称', secret: false, value: title, caret: title.length, placeholder: '名称', submit: value => ({ type: 'session.rename', session, title: value.trim() }) })
        } else if (row.value === 'draft') {
          openRecords(`draft:${sessionTarget}`, '原草稿 · 只读，可用终端选择复制', [{ kind: 'user', key: `draft:${sessionTarget}`, text: view.draft, echoed: true, images: userImages(view.refs) }])
        } else if (row.value === 'sessions') { popLayer(); models.cancelOpen(); waiting = 'session'; send({ type: 'session.list', archived: false }) }
        return NONE
      }
      if (view.dock.picker.source === 'input-purpose') {
        if (row.value === 'pending') {
          manageInput({type:'input.manage',action:'list'})
          enterLayer(); openPendingInputs()
        } else { const purpose=row.value==='next'?'next':'current'; popLayer();commit({...view,inputPurpose:purpose}) }
        return NONE
      }
      if (view.dock.picker.source === 'input-pending') {
        const input=view.pendingInputs.find(one=>one.ref===row.value)
        if(input===undefined)return NONE
        enterLayer()
        commit(openPicker(view,{source:'input-detail',title: input.purpose==='current'?'当前补充':'下一件', selected:0,detail:[`状态：${input.reason??inputStateText(input.state)}`,input.input.text],rows:[collaborationRow('back','返回'),...(input.state==='pending'?[collaborationRow(`edit:${input.ref}`,'编辑未消费输入'),collaborationRow(`withdraw:${input.ref}`,'撤回未消费输入'),collaborationRow(`continue:${input.ref}`,'明确继续这条输入')]:[])],hint:'↑↓ 选择 · Enter 执行 · Esc 返回'}))
        return NONE
      }
      if(view.dock.picker.source==='input-detail'){
        if(row.value==='back'){popLayer();return NONE}
        const [action,ref]=row.value.split(':')
        const input=view.pendingInputs.find(one=>one.ref===ref)
        if(input===undefined)return NONE
        if(action==='edit'){
          // 复用正文编辑，不另造输入字段；提交仍以旧身份及版本参与消费竞争。
          editingPending={ref:input.ref,revision:input.revision,back:layerNow(),purpose:input.purpose}
          commit({...closePicker(view),draft:input.input.text,caret:input.input.text.length,refs:(input.input.refs??[]).map(({at,...ref})=>({...ref,start:at,end:at+ref.marker.length}))})
        }else if(action==='withdraw'||action==='continue'){manageInput({type:'input.manage',action,ref:input.ref,revision:input.revision});popLayer()}
        return NONE
      }

      if (['collaboration', 'collaboration-member', 'collaboration-stop', 'collaboration-discussions'].includes(view.dock.picker.source)) {
        collaborationAction(row)
        return NONE
      }

      if (view.dock.picker.source === 'task') return taskAction(row.value)

      if (view.dock.picker.source === 'config') {
        if (row.value === 'model') {
          // 共用 /model 设置入口，工作选择的作用对象为当前会话。
          models.sessionScope()
          enterLayer()
          waiting = null
          send(models.request('model'))
          return NONE
        }

        if (row.value === 'statusLine') {
          enterLayer()
          openStatusLinePicker()
          return NONE
        }

        if (row.value === 'turnDuration') {
          send({ type: 'prefs.set', turnDuration: view.turnDuration === 'active' ? 'elapsed' : 'active' })
          return NONE
        }
        if (row.value === 'motion') {
          if (view.dock.kind === 'picker' && view.dock.picker.source === 'config') {
            enterLayer()
          }
          toggleReducedMotion()
          return NONE
        }

        if (row.value === 'grants') {
          enterLayer()
          models.cancelOpen()
          waiting = 'grants'
          send({ type: 'grants.list' })
          return NONE
        }

        if (row.value === 'mcp') {
          enterLayer()
          models.cancelOpen()
          waiting = 'mcp'
          mcpServer = '' // 总览那一屏（`/mcp` 无参）——不是某一台的明细
          send({ type: 'mcp.list' })
          return NONE
        }

        if (row.value === 'web') {
          enterLayer()
          models.cancelOpen()
          waiting = 'web'
          // 候选来自连接表（`model.list`），当前值来自 `web.state`——两份都问。
          send({ type: 'model.list' })
          send({ type: 'web.list' })
          return NONE
        }

        // **第 4 项没有可进的入口**——它今天要手改配置文件才动得了，故它「自己那一屏」
        // 就是**一份读出来的账**（纯输出进记录区，同 `/status` 的姿势）：两件事实**写全**
        // （列表里那一格是缩过、截过的，见 `configRows` 的那条注）。
        //
        // ⚠️ **这一跳不压栈**：记录区那一块不是「一屏能退回来的东西」（`←` 在那儿是移光标）。
        //    收屏之后输入行照旧在，接着打 `/config` 就是这一屏——比一个退不回去的层干净。
        const lines = configPathLines({
          dataDir: options.dataDir,
          home: options.home,
          workspaceRoots: options.workspaceRoots,
        })
        enterLayer()
        commit(openPicker(view, { source:'paths-info', title:'数据与工作区', rows:[collaborationRow('back','返回')], selected:0, detail:lines, hint:'Esc 返回' }))
        return NONE
      }

      if (view.dock.picker.source === 'statusline') {
        toggleStatusLine(row.value)
        return NONE
      }

      // `/resume` 那一屏：选定＝切过去。
      if (view.dock.picker.source === 'session') {
        if (directory.archived) { showSessionHistory(row.value); return NONE }
        // **选的是当下这条**：什么都没发生——内核那一边 `switchTo` 也知道是同一条、
        // 一个事件都不发（见 `conversation` 的 `run`）。故回执**这一侧当场给**
        // （等答复就是白等），页也不翻（没换记录区，翻了反而是「凭空清一屏」）。
        if (row.value === view.sessionId) {
          commit(appendReceipt(closePicker(view), `已切到 ${row.label}`))
          return NONE
        }

        turn = { kind: 'open', label: row.label }
        send({ type: 'session.open', session: row.value })
        commit(closePicker(view))
        return NONE
      }

      if (view.dock.picker.source === 'paths-info') { popLayer(); return NONE }
      if (view.dock.picker.source === 'grants') {
        enterLayer()
        const grant = row.revoke?.index === undefined ? undefined : view.grants?.grants[row.revoke.index]
        commit(openPicker(view, { source:'grants-detail', title:'授权详情', selected:0,
          detail:[`工作区：${row.revoke?.workspace ?? view.grants?.workspace ?? ''}`,`操作范围：${row.label}`, ...(grant === undefined ? [] : [`状态：${row.meta}`])],
          rows:[collaborationRow('back','返回授权列表'),{current:false,label:'撤销这条授权',meta:'明确撤销所示范围',value:'revoke',...(row.revoke===undefined?{}:{revoke:row.revoke})}], hint:'↑↓ 选择 · Enter 执行所选动作 · Esc 返回' }))
        return NONE
      }
      if (view.dock.picker.source === 'grants-detail') {
        if (row.value === 'back') { popLayer(); return NONE }
        if (row.revoke !== undefined) { popLayer(); send({type:'grants.revoke',...row.revoke}) }
        return NONE
      }

      if (view.dock.picker.source === 'paths') {
        pickPath()
        return NONE
      }

      if (view.dock.picker.source === 'skills') {
        const chosen = view.skills?.skills.find((one) => one.path === row.value)
        if (chosen === undefined) return (commit(closePicker(view)), NONE)

        bindSkill(chosen, view.dock.picker.anchor ?? { start: 0, end: 0 })
        return NONE
      }

      if (view.dock.picker.source === 'mcp') return NONE

      if (view.dock.picker.source === 'web') {
        // 「未配置」那一行的 value 是空串——发出去的是 null（清除引用），不是空 id。
        send({ type: 'web.configure', provider: row.value === '' ? null : row.value })
        return NONE
      }

      if (models.select(row)) return NONE

      return NONE // 认不出的来路（不该走到这儿）——**什么都不做**，不拿它当换模型
    }

    const text = view.draft
    if(editingPending!==null){const pending=editingPending;editingPending=null;manageInput({type:'input.manage',action:'edit',ref:pending.ref,revision:pending.revision,input:{text,refs:wire(view.refs),purpose:pending.purpose}});restoreLayer(pending.back);return NONE}
    if (text.trim() === '') return NONE
    const placed = view.refs

    // **只有技能引用、一个字都没有** ⇒ 这一条按不下去（见 `submittable`）。
    // 出声说一句，不静默吞——「按了没反应」是最难查的那种。
    if (!submittable(view.draft, view.refs)) {
      commit(said(view, '这一句只有一处技能引用——补上要它做什么，再回车发送。'))
      return NONE
    }

    if (text.trim() === '/ps') {
      const { next, commands } = runSlash(view, text.trim())
      draft(next)
      for (const command of commands) send(command)
      return NONE
    }

    if (text.startsWith('/')) {
      const word = text.split(/\s+/)[0] ?? ''

      if (!COMMANDS.some((command) => command.name === word)) {

        if (refStartingAt(placed, 0) !== undefined) return sendInput(text, placed)

        const hit = resolveSkill(word.slice(1), view.skills?.skills ?? [])

        if (hit.kind === 'one') {
          // **只输入了名称**（`/pdf` 后面没有别的话）＝**只把它放进草稿**
          // （设计：「选定或仅输入名称时只绑定草稿，后面的正文仍可编辑」）——
          // 此刻一个模型请求都不发，用户接着补交代。
          // 一条只有引用、一个字都没有的交代**不提交**：内核那边落下的会是一条
          // 「用户什么都没说、但带了份材料」的条目，那不是交代。
          //
          // ⚠️ 判「还有没有别的话」时，句首这个词**不算话**（它正是要放进草稿的那一处引用）
          // ——故先把它去掉再问（`bodyOf` 只挖已知的引用区间，此刻它还没绑上）。
          if (spokenOf(view.draft, view.refs, word).trim() === '') {
            commit(
              withCompletion({
                ...view,
                ...replaceWith(
                  view.draft,
                  view.refs,
                  { from: 0, to: word.length },
                  { kind: 'skill', marker: `/${hit.skill.name}`, name: hit.skill.name, source: hit.skill.path },
                  view.caret,
                ),
              }),
            )
            return NONE
          }

          // 名称已在正文里（原位），只补一处身份上去——引用就排在它原来的位置。
          // 已经绑过的那一形在上面那道闸上就走了（它直接提交），故这里是**还没绑**的这一形。
          return sendInput(
            text,
            putRef(placed, {
              kind: 'skill',
              marker: `/${hit.skill.name}`,
              name: hit.skill.name,
              source: hit.skill.path,
              start: 0,
              end: word.length,
            }),
          )
        }
      }

      if (COMMANDS.some(command => text.startsWith(command.name + ' '))) {
        rememberInput(text, placed)
        const ref=crypto.randomUUID()
        lastSubmit={ref,text,refs:placed,caret:view.caret,local:true}
        const batch = { history, through: clearedSequence }
        const input={text,refs:wire(placed),local:true as const,ref}
        if (connected) send(view.inputMember===undefined?{type:'input.submit',...input}:{type:'collaboration.input',member:view.inputMember,input})
        const echoed = settle(appendEcho(view, text, userImages(placed)))
        const { next, commands, leaving } = runSlash(echoed, text)
        const failed=!leaving&&commands.length===0&&([...next.settled,...next.rows].at(-1)?.kind==='receipt'||next.flash!==null&&next.flash!==view.flash)
        draft(failed ? {...next,draft:text,refs:placed,caret:view.caret} : next)
        if (!failed) {
          const replyOf: Partial<Record<Command['type'], KernelEvent['kind']>> = {
            'session.new': 'session.state', 'session.rename': 'session.managed', 'session.list': 'session.state',
            'model.list': 'model.catalog', 'model.refresh': 'model.catalog', 'provider.list': 'provider.catalog',
            'skills.list': 'skills.catalog', 'grants.list': 'grants.catalog', 'mcp.list': 'mcp.catalog', 'mcp.reconnect': 'mcp.catalog',
          }
          const replies = new Set(commands.flatMap(command => replyOf[command.type] === undefined ? [] : [replyOf[command.type]!]))
          if (commands.length === 0 || connected) {
            submittedBatches.set(ref, { ...batch, replies })
            if (replies.size === 0) acceptBatch(ref, true)
          }
        }
        for (const command of commands) send(command)
        return leaving ? beginExit() : NONE
      }
    }

    return sendInput(text, placed)
  }

  const pickCompletion = (): void => {
    const completion = view.completion
    const row = completion?.candidates[completion.selected]
    const word = activeWordOf(view.draft, view.caret)
    if (row === undefined || word === undefined) return

    if (COMMANDS.some((command) => command.name === row.name)) {
      commit(applyCompletion(view))
      return
    }

    const hit = resolveSkill(row.name.slice(1), view.skills?.skills ?? [])

    if (hit.kind === 'one') {
      commit(
        withCompletion({
          ...view,
          ...replaceWith(
            view.draft,
            view.refs,
            { from: word.start, to: word.end },
            { kind: 'skill', marker: `/${hit.skill.name}`, name: hit.skill.name, source: hit.skill.path },
            view.caret,
          ),
        }),
      )
      return
    }

    // 认不出这个名字（目录里没有）——**什么都别放**：那是几个普通字，
    // 补全成别的名字反而改掉了用户写的话。
  }

  /**
   * slash 分发——**两种走法在这一处落定**。
   *
   * ⚠️ **返回待发的命令、自己不 `send`**（顺序见 `submit` 里那段注）：进程内传输是
   * **同步**直连的——命令一发出，答复**当场**回到 `onEvent` 改视图；命令若发在 `commit`
   * **之前**，外层那次**基于旧快照**的 `commit` 会把答复的改动整个盖掉。
   * （`/model` 的选择器就这么一直开不出来：`model.catalog` 明明到了，又被盖回输入区。）
   */
  const runSlash = (
    from: ShellView,
    text: string,
  ): { readonly next: ShellView; readonly commands: readonly Command[]; readonly leaving: boolean } => {
    const [word, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ').trim()
    // 命令把这一行整个吃掉了（交互配置型不带正文）——**引用也跟着走**：
    // 它们指向的那段文字已经不在草稿里了（留着就是「正文没了、材料还在」的暗带）。
    const cleared: ShellView = { ...from, draft: '', caret: 0, refs: [] }
    /** 本地这一下的改动 ＋ 待发的命令——两件一起交回调用方（它决定次序）。 */
    const only = (
      next: ShellView,
      ...commands: Command[]
    ): { next: ShellView; commands: readonly Command[]; leaving: boolean } => ({
      next,
      commands,
      leaving: false,
    })

    // —— 本地结果进记录区，原文已按用户输入回显 ——
    if (word === '/help') return only(appendOutput(cleared, HELP_TITLE, HELP_LINES))
    if (word === '/status') return only(appendOutput(cleared, STATUS_TITLE, statusLines(from)))

    if (word === '/clear') {
      // 开一条新的——**清屏由内核那一声答复触发**（页号一变，渲染层就翻页，见
      // `components/app.ts`）：这一侧只发命令。内核忙时会把它挡回（`BUSY_NOTE`），
      // 那时活跃位不动、页也不翻，屏幕上落的是那行 note（见 `onEvent`）——
      // 说出来的话就都是真发生过的。
      //
      // ⚠️ **不带参数**：`/clear` 是个动作，不是一族动作的入口（`/session new` 那套
      // 「同一入口下挂动作」的姿势留给 `/model`）。多写的词照 `submit` 那一侧的老规矩
      // 如实回一句，不当交代发出去。
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/clear（不带参数）'))

      turn = { kind: 'new', label: null }
      return only(cleared, { type: 'session.new' })
    }

    if (word === '/ps') {
      if (arg) return only(appendReceipt(cleared, '用法：/ps'))
      collaborationQuery = {}
      return only(openPicker(cleared, { source: 'collaboration', title: '[协作成员]  │  后台命令', rows: [], selected: 0, hint: '正在读取 · Tab/Shift+Tab 切换 · Esc 返回' }), { type: 'collaboration.read' }, { type: 'background.list' })
    }

    if (word === '/resume') {
      if (arg === '') {
        models.cancelOpen()
        waiting = 'session'
        return only(cleared, { type: 'session.list' })
      }
      // **`/resume <参数>` 先不做**（设计明文）：标题就是第一句交代，又长又会重名——
      // 「有参数」得先定一个不含糊的认法（序号？名字前缀？）。故如实说一句，
      // **不按字面猜一条切过去**（猜错就是「切到了另一条上」而用户以为敲的是名字）。
      return only(appendReceipt(cleared, '认得的用法：/resume——空着回车＝列出可选（带名字找那一路还没定）'))
    }

    if (word === '/rename') {
      // 名字取**这一行剩下的全部**（名字里可以有空格）；两头空白不算——空到没有
      // （`/rename` 或 `/rename   `）就照「没给」办，**不静默**（设计明文）。
      const title = arg.trim()
      if (title === '') return only(appendReceipt(cleared, '要改成什么？`/rename <文本>`'))
      // 还没有会话＝没有「当下这条」可改（空手开机就是这个状态）——如实说一句，不静默，
      // 也不替他把会话开出来（改名不是开张的动作）。
      if (from.sessionId === null) {
        return only(appendReceipt(cleared, '还没有会话可改名——先交代一句开张'))
      }
      return only(cleared, { type: 'session.rename', session: from.sessionId, title })
    }

    if (word === '/exit') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/exit（不带参数）'))
      // 本地这一下只有一个意图：停掉这条、然后走。**当场不留回执**——「停哪一条」那句话
      // 由停止编排那一头拼（`正在停「X」`），此处再印一句就是同一条事实说两遍
      // （设计：一屏上的提示各自说不同的东西）。
      return { next: cleared, commands: [], leaving: true }
    }

    if (word === '/skills') {
      models.cancelOpen()
      waiting = 'skills'
      skillSeed = arg
      return only(cleared, { type: 'skills.list' })
    }

    if (word === '/web') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/web（不带参数）'))
      models.cancelOpen()
      waiting = 'web'
      return only(cleared, { type: 'model.list' }, { type: 'web.list' })
    }

    if (word === '/config') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/config（不带参数）'))
      models.cancelOpen()
      waiting = 'config'
      configPending = new Set(CONFIG_READINGS.map(one => one.event))
      return only(cleared, ...CONFIG_READINGS.map((one) => one.command))
    }

    if (word === '/model') {
      if (from.dock.kind !== 'picker' || from.dock.picker.source !== 'model') models.clearTarget()

      if (from.dock.kind !== 'picker' || from.dock.picker.source !== 'model') models.sessionScope()

      // 先登记开页意图，外层落下草稿后再发送；同步回执不能被旧视图覆盖。
      waiting = null
      if (arg === 'refresh' || arg.startsWith('refresh ')) {
        return only(cleared, models.request('refresh', arg.slice('refresh'.length).trim()))
      }
      if (arg === 'connect' || arg === 'manage') return only(cleared, models.request(arg))
      if (arg === '') return only(cleared, models.request('model'))

      return only(appendReceipt(cleared, `认得的用法：/model · /model refresh [连接] · /model connect · /model manage`))
    }

    if (word === '/mcp') {
      // ⚠️ 按**完整命令词**认（`reconnect` / `reconnect <名字>`）：服务器名可以长成
      // `reconnect-db` 那样，`startsWith('reconnect')` 会把 `/mcp reconnect-db` 误当重连指令
      if (arg === 'reconnect' || arg.startsWith('reconnect ')) {
        const who = arg.slice('reconnect'.length).trim()
        if (who === '') return only(appendReceipt(cleared, '要重连哪一台？`/mcp reconnect <名字>`'))

        models.cancelOpen()
        waiting = 'mcp'
        mcpServer = who
        return only(cleared, { type: 'mcp.reconnect', server: who })
      }

      models.cancelOpen()
      waiting = 'mcp'
      mcpServer = arg
      return only(cleared, { type: 'mcp.list' })
    }

    if (word === '/grants') {
      models.cancelOpen()
      waiting = 'grants'
      return only(cleared, { type: 'grants.list' })
    }

    return only(appendReceipt(cleared, `不认得的命令「${word}」——试试 /help，或到 /skills 里找`))
  }

  /** 候选里上下选（环形）。 */
  const moveCompletion = (from: ShellView, delta: number): ShellView => {
    const completion = from.completion
    if (completion === null) return from

    const count = completion.candidates.length
    const selected = (completion.selected + delta + count) % count

    return { ...from, completion: { ...completion, selected } }
  }

  /**
   * 补全——把选中的命令写进草稿（**留一个空格**：一条命令多半还要打参数），
   * 并收起候选（补完那一下，候选的活就干完了）。
   */
  const applyCompletion = (from: ShellView): ShellView => {
    const row = from.completion?.candidates[from.completion.selected]
    if (row === undefined) return from

    return withCompletion({
      ...from,
      draft: `${row.name} `,
      caret: row.name.length + 1, // 补完落在末尾（一条命令多半还要接着打参数）
      completion: null,
    })
  }

  /**
   * **上下切换输入历史**（设计「输入编辑与历史」那一段的四条，都落在这里）：
   *
   * - **开始浏览前保存完整草稿**（正文 · 引用 · 插入点）——`browsing`；
   * - **从最新历史按下返回原稿**：往回翻过最新那一条（`↓`）＝ 把那份原稿**整份**还回来；
   * - **已在草稿位置继续按下保持原稿**：原稿那一格再按 `↓`**什么都不做**（不清空、不环绕）；
   * - **翻的是整份草稿**：正文 **＋ 它里面的引用**（位置与身份），故召回之后不必重选一遍。
   *
   * ⚠️ **这一跳不读材料、也不发命令**——它只是把一段**本地**的草稿放回输入行；
   * 材料到「这一次重新提交、内核轮到它」时才现读（与头一次完全同一条通路）。
   */
  const recallHistory = (delta: number): void => {
    if (history.length === 0) return

    /** 当下停在哪一格：`history.length` ＝ 原稿那一格（历史之后）。 */
    const at = historyAt === -1 ? history.length : historyAt
    const next = at + delta
    if (next < 0) return // 到头（最旧那条再往上）——保持不动，不环绕

    // 往回翻过最新那一条 ⇒ **原稿整份还回来**（正文 · 引用 · 插入点）
    if (next >= history.length) {
      const back = browsing
      browsing = null
      historyAt = -1
      // 没在翻的时候按 `↓`（`browsing === null`）＝ 已在草稿位置：**保持原稿**，什么都不做
      if (back === null) return
      commit({
        ...view,
        completion: null,
        draft: back.text,
        caret: Math.max(0, Math.min(back.caret, back.text.length)),
        refs: back.refs,
      })
      return
    }

    // 头一次离开原稿那一格：把它整份收起来（正文 · 引用 · 插入点）
    if (historyAt === -1) browsing = { text: view.draft, refs: view.refs, caret: caretAt() }

    const entry = history[next]
    if (entry === undefined) return

    historyAt = next
    commit({ ...view, completion: null, draft: entry.text, caret: entry.caret ?? entry.text.length, refs: entry.refs, status: { ...view.status, hint: idleHintOf({ ...view, draft: entry.text, refs: entry.refs }) } })
  }

  const said = (from: ShellView, message: string): ShellView => ({ ...from, flash: message })

  const readHistory = (session?: SessionId): void => {
    send(session === undefined ? { type: 'history.read' } : { type: 'history.read', session })
  }

  return {
    getView: () => view,
    exitNote: () => view.sessionId === null || view.archived ? null : `恢复此会话：\n${resumeCommandOf(view.sessionId)}`,

    subscribe: (listener) => {
      watchers.add(listener)

      return () => {
        watchers.delete(listener)
      }
    },

    key,
    presented: (ids) => {
      if (disposed || !connected || options.markRead === undefined) return false
      options.markRead(ids)
      return true
    },
    readHistory,
    attachMaterial,
    exportMaterial,
    hostGone: () => disconnect('Magic Code 已退出'),

    /**
     * 放开输入——`boot` 完成那一下（真外壳在 `run.ts` 里按这个次序调）。
     *
     * 幂等：重复调只是再翻一次真；右位提示**回落到本来的那一条**（空闲态），
     * 不然「启动中」会一直挂在状态行上——那会变成一句假话。
     */
    releaseInput: (): void => {
      if (ready) return
      ready = true
      commit({ ...view, status: { ...view.status, hint: idleHintOf(view) } })
    },

    disconnected: disconnect,

    dispose: () => {
      disposed = true
      models.dispose(); prompt.clear(); layers = []
      if (pending !== undefined) clearTimeout(pending)
      pending = undefined

      stopExitClock()
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
