import type { BackgroundCommand, BackgroundView } from '@magic/contracts'
import { backgroundDetail, backgroundKey, backgroundPicker } from './boards/conversation/background.ts'
import { createModelSettings, type ModelNavigation } from './boards/capabilities/model-settings.ts'
import { modelLabel } from './boards/capabilities/models.ts'
import { createPrompt, type Ask } from './prompt.ts'
import { createMemoryPicker } from './boards/records/memory-picker.ts'
import { createSessionPicker } from './boards/records/session-picker.ts'

import { sanitizeForDisplay, WIRE_MESSAGE_BUDGET_BYTES } from '@magic/contracts'
import { dirname } from 'node:path'
import { composerLayout } from './components/composer.ts'

import type {
  AgentId,
  CollaborationView,
  Command,
  ControlTransport,
  Entry,
  EventKind,
  KernelEvent,
  ModelChoice,
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
  currentMember,
  memberForSession,
  memberRows,
  memberState,
  messageRows,
  workTabs,
} from './boards/conversation/collaboration.ts'
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
  userImages,
  withBanner,
  withContextWindow,
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
} from './boards/settings/config.ts'
import { pathHint, pathRows, resolveSkill, sessionReferenceRows, skillHint, skillRows } from './boards/capabilities/materials.ts'
import { mcpHint, mcpRows, mcpToolRows } from './boards/capabilities/mcp.ts'
import { configReasoningOf, reasoningText } from './boards/capabilities/models.ts'
import { runSummary } from './boards/records/sessions.ts'

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
  '输入任务描述开始工作；/ 查找命令，@ 引用文件或会话。',
  '命令：',
  ...COMMANDS.map(command => `  ${command.name.padEnd(HELP_COMMAND_WIDTH + 2)}${command.summary}`),
  '参数用法：',
  '  /rename <名称> · /skills [关键词] · /compact [本次重点]',
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
  '  Ctrl+P / Ctrl+N      召回上一条 / 下一条输入',
  '  Ctrl+O               查看记录',
  '  Ctrl+T               展开或收起计划',
  '  Alt+Enter            选择本条输入用途',
  'Ctrl+C：工作中时选择停止、转后台或退出。',
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
  { command: { type: 'mcp.list' }, event: 'mcp.catalog' },
  { command: { type: 'web.list' }, event: 'web.state' },
]

type Layer = {
  readonly dock: Dock
  readonly model: ModelNavigation
  readonly asking: Ask | null
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
  /**
   * **开局落地的那一档模型**（`ModelChoice`）——状态行 ③ 开机那一格。
   *
   * 由装配从**与请求解析同一个来源**递进来（`terminal.ts` 的 `startupRegistry().current()`）；
   * 不给 ＝ 这一步不知道 ⇒ 那一格整格省掉（不写「未知」——那是编一个词）。
   */
  readonly modelChoice?: ModelChoice | undefined

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

  /** 实验性 · 语音输入（D75）——缺省关；此后随 `prefs.state` 走。 */
  readonly voiceEnabled?: boolean | undefined

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
  /** **sudo 密码组件**（U129）——请求与答复都走 UI→Engine 的瞬时通道。 */
  readonly sudo?: SudoFeed | undefined
  /**
   * **语音输入**（U135）——由装配注入（本机能力在 `@magic/client` 那一侧）。
   * 不给＝这台机器上不提供语音入口（键位照旧，只是没人接）。
   */
  readonly voice?: VoiceInput | undefined
}

/**
 * **语音那一条**（U135）——两件事：**开一次录音**、**听那一下按键**。
 *
 * 外壳只管：什么时候开始、什么时候收尾、文字往草稿哪儿插；采音、转写与按键监听都是
 * 注入进来的（本机的 Swift 助手，见 `@magic/client` 的 `startVoice`／`startVoiceHotkey`）。
 * 按键**不走终端**——裸修饰键要终端上报就得改键盘协议，而那个协议位会毁掉输入法。
 */
export type VoiceInput = {
  start(handlers: {
    readonly onFinal: (text: string) => void
    readonly onError: (code: string, message?: string) => void
  }): { readonly stop: () => void; readonly cancel: () => void }
  /**
   * 听「右 ⌥ 单独按一下」；返回退订（TUI 收摊时调）。
   *
   * ⚠️ **一次轻点报成两半**（D75）：`down` 是按下、`up` 是松开。配对与「哪一屏拿焦点」
   * 由外壳判（`focus.ts`）：这一侧听见的是**整台机器**，每个窗口都会收到同一下。
   */
  listen(onTap: (phase: 'down' | 'up') => void): () => void
}

/** sudo 密码通道（U129）——**只传密码，不落任何事件 / 记录**。 */
export type SudoFeed = {
  subscribe(listener: (event: SudoFeedEvent) => void): void
  /** `password: null` ＝ 取消。 */
  answer(requestId: string, password: string | null): void
}

type SudoFeedEvent =
  | { readonly kind: 'request'; readonly requestId: string; readonly command: string }
  | { readonly kind: 'settled'; readonly requestId: string }

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
function spokenOf(draft: string, refs: readonly DraftRef[], word: string): string {
  const spoken = bodyOf(draft, refs)

  return spoken.startsWith(word) ? spoken.slice(word.length) : spoken
}

function submittable(draft: string, refs: readonly DraftRef[]): boolean {
  if (bodyOf(draft, refs).trim() !== '') return true

  return refs.some((ref) => ref.kind !== 'skill')
}

function bodyOf(draft: string, refs: readonly DraftRef[]): string {
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
  //
  // 这里种的是状态行**开机就说得出的那三格**：④ 的分母（`contextWindow`）与模型
  // （`modelChoice`，开局落地的那一档）由装配递进来（与请求解析**同一个来源**：
  // `terminal.ts` 的 `startupRegistry().current()`）；已用量开机就是 `0`——这一条会话
  // 一个 token 都还没用（`magic resume <id>` 那一趟是例外：那一条的账这一侧不知道，
  // 照旧省掉那一格，见 `ShellOptions.openingSession`）。
  const openedWindow = options.contextWindow ?? null
  let view = withBanner(
    patchStatus(
      withContextWindow(
        createView({

          statusLine: options.statusLine,
          reducedMotion: options.reducedMotion,
          voiceEnabled: options.voiceEnabled,
          turnDuration: options.turnDuration,
          workspace: workspaceLabelOf(options.workspaceRoots),
        }),
        openedWindow,
      ),
      {
        usage: options.openingSession === undefined ? 0 : null,
        model: options.modelChoice === undefined ? null : modelLabel(options.modelChoice),
      },
    ),
  )

  // 开屏说明属于这一页的页头。历史到达时保留原位置，避免 Static 跳过首条正文。
  for (const text of options.receipts ?? []) view = appendPageNote(view, text)

  view = withRunFacts(view, options.runs?.current() ?? [])

  /** sudo 密码**只在闭包里**（屏上只画位数）——提交或取消即刻清空。 */
  let sudoPassword = ''

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
  type HistoryEntry = { readonly text: string; readonly refs: readonly DraftRef[]; readonly inputRef?: string; readonly caret?: number; readonly cleared?: number }
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

  /**
   * **还没有会话时，模型选择留在窗口自己身上**（用户 2026-11-19 定：连接是核心、会话懒建立）。
   *
   * 不发给引擎：那时没有装配、也没有会话可落这条事实。发送下一条消息时随它带过去
   * （`UserInput.model`），装配按它建注册表。返回 `false` ＝ 已有会话，调用方照旧发 `model.switch`。
   */
  const chooseInWindow = (request: import('@magic/contracts').ModelSwitchRequest): boolean => {
    if (view.sessionId !== null || view.collaboration?.collaboration !== undefined) return false
    const choice = request.choice ?? view.modelChoice?.choice
    const said = choice === undefined ? '已选择思考等级' : `已选择 ${modelLabel(choice)}`
    commit(noteResult({ ...view, modelChoice: { ...view.modelChoice, ...request }, status: { ...view.status, ...(choice === undefined ? {} : { model: modelLabel(choice) }) } }, `${said}；下一条消息起用它`))
    return true
  }

  const compactDrafts = new Map<string, { session: string; text: string; refs: readonly DraftRef[]; caret: number }>()
  const compactLabel = (state: import('@magic/contracts').CompactState['state']) => ({ pending: '等待完整交互边界', running: '正在整理笔记', completed: '压缩完成', failed: '压缩失败', cancelled: '已取消', interrupted: '已中断', 'no-material': '没有可压材料', unknown: '受理或结果尚未确认' })[state]
  const compactNote = (state: import('@magic/contracts').CompactState) => state.notesSaved && state.state !== 'completed' ? '已保存的笔记保留，本次历史收缩未完成' : ''
  /**
   * **结果通知进记录区**——用户 2026-11-19 定：输入区不放任何结果反馈。
   *
   * 拒绝、失败、完成这类「对用户那句话的结果」落进已定局的记录区（`appendReceipt`）：
   * 跟着会话记录走、能回查；输入行只留**正在进行**的提示（正在保存、正在读取、正在提交）。
   * 同一句话紧挨着重复时不重复追加——连按回车拒绝同一个动作，不在记录区刷出一排。
   */
  const noteResult = (from: ShellView, text: string): ShellView => {
    const last = from.settled[from.settled.length - 1]
    return last !== undefined && last.kind === 'receipt' && last.text === text ? from : appendReceipt(from, text)
  }
  const showCompactions = (): void => {
    const rows = view.compactions.filter(one => one.session === view.sessionId)
    commit(openPicker(view, { source: 'compact-status', title: '本会话压缩请求', selected: 0, rows: [
      ...rows.flatMap(one => [
        { value: `query:${one.state.requestId}`, label: `${compactLabel(one.state.state)} · 查询结果`, meta: '', current: false, detail: [`目标 ${nameOfSession(one.session)}`, `本次重点：${one.state.focus || '未指定'}`, one.state.reason ?? '', compactNote(one.state)].filter(Boolean) },
        ...(['pending', 'running', 'unknown'].includes(one.state.state) ? [{ value: `cancel:${one.state.requestId}`, label: '取消本次压缩', meta: '不停止其他工作', current: false }] : []),
      ]), { value: 'back', label: '返回', meta: '', current: false },
    ], hint: 'Enter 操作 · Esc 返回' }))
  }

  const memory = createMemoryPicker({
    get picker() { return view.dock.kind === 'picker' ? view.dock.picker : null },
    get session() { return view.sessionId },
    get archived() { return view.archived },
    get title() { return view.sessionId === null ? '尚无会话' : nameOfSession(view.sessionId) },
    present: picker => commit(openPicker(view, picker)),
    push: () => enterLayer(), back: () => popLayer(), send: command => send(command),
    correct: ref => {
      const target = view.inputMember === undefined ? view.sessionId : view.collaboration?.members.find(one => one.agent.agentId === view.inputMember)?.agent.sessionId
      if (ref.kind === 'note' && ref.session !== target) { commit(noteResult(view, `所选笔记属于 ${nameOfSession(ref.session)}；请回到该对象交代，原草稿与发送目标保留。`)); return }
      while (layers.length > 0) popLayer()
      collapseDock()
      commit(withCompletion({ ...view, ...replaceWith(view.draft, view.refs, { from: view.caret, to: view.caret }, ref, view.caret) }))
    },
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
    chooseInWindow: request => chooseInWindow(request),
  })

  let collaborationQuery: { readonly member?: AgentId } | null = null
  let referenceCatalog: Extract<KernelEvent, { kind: 'session.references' }>['data'] | null = null
  let referenceRequest: string | undefined
  let referenceFocus: string | undefined
  const reading = new Map<string, number>()

  const prompt = createPrompt({
    present: state => commit(state === null ? closePrompt(view) : openPrompt(view, state)),
    send: command => send(command),
    popLayer: () => popLayer(),
    onSubmit: (command, value) => {
      if (command.type !== 'session.rename' || sessionTarget !== command.session) return false
      if (managementPending !== null) return true
      if (!connected) { commit(noteResult(view, 'Engine 未连接，请先 Ctrl+R 重连')); return true }
      if (value.trim() === '') { commit(noteResult(view, '名称不能为空')); return true }
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
    if (view.dock.kind === 'input') return
    layers = [...layers, layerNow()]
  }

  /** 把栈里那一层照原样摆回来——**光标位置、草稿与选区照旧**（草稿那三格压根没动过）。 */
  const restoreLayer = (layer: Layer): void => {
    models.restore(layer.model)
    prompt.restore(layer.asking)
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
    view = next
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
      commit(appendReceipt(view, 'Engine 未连接，这项操作需要连接后使用。')); return
    }
    if (view.archived && (command.type === 'input.submit' && command.local !== true || ['collaboration.input', 'collaboration.resume'].includes(command.type) || command.type === 'input.manage' && command.action === 'continue')) {
      commit(noteResult(view, '会话已归档，请明确恢复后继续')); return
    }
    transport.send(command.type==='input.manage'&&view.inputMember!==undefined?{...command,member:view.inputMember}:command)
  }

  options.sudo?.subscribe((event) => {
    if (disposed) return
    if (event.kind === 'request') {
      sudoPassword = ''
      commit({ ...view, sudo: { requestId: event.requestId, command: event.command, masked: 0 } })
      return
    }
    if (view.sudo?.requestId === event.requestId) {
      sudoPassword = ''
      commit({ ...view, sudo: null })
    }
  })

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
    if (disposed || (!connected && !reopening && !['model.catalog', 'provider.catalog', 'prefs.state', 'web.state', ...(options.settingsOnly ? ['mcp.catalog'] : [])].includes(event.kind))) return

    if (event.kind === 'paths.catalog' && view.dock.kind === 'picker' && view.dock.picker.source === 'paths' && event.data.query !== view.dock.picker.filter) return
    if (memory.receive(event)) return
    if (event.kind === 'compact.state') {
      const pending = compactDrafts.get(event.data.requestId)
      if (pending?.session === event.session && (event.data.accepted === true || ['pending', 'running', 'completed'].includes(event.data.state))) {
        rememberInput(pending.text, pending.refs)
        if (view.sessionId === pending.session && view.draft === pending.text && view.refs === pending.refs) draft({ ...view, draft: '', caret: 0, refs: [], completion: null })
        compactDrafts.delete(event.data.requestId)
      }
      if (pending && event.data.accepted !== true && ['failed', 'no-material'].includes(event.data.state)) compactDrafts.delete(event.data.requestId)
      const next = reduce(view, event)
      if (next === view) return
      commit(next)
      if (view.dock.kind === 'picker' && view.dock.picker.source === 'compact-status') showCompactions()
      else if (view.sessionId === event.session) {
        const line = `${compactLabel(event.data.state)}${event.data.reason ? '：' + event.data.reason : ''}${compactNote(event.data) ? '；' + compactNote(event.data) : ''}`
        commit(['pending', 'running'].includes(event.data.state) ? { ...next, flash: null } : noteResult(next, line))
      }
      return
    }


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
        commit(noteResult(view, `${event.data.note} · Enter 重试`)); return
      }
    }
    if (event.kind === 'session.changed') {
      const next = reduce(view, event)
      commit(next)
      directory.refresh()
      if (view.dock.kind === 'picker' && view.dock.picker.source === 'session-actions' && sessionTarget === event.data.session) {
        showSessionActions(sessionTarget, false)
      }
      return
    }
    if (event.kind === 'session.managed') {
      if (event.data.session !== sessionTarget || managementPending === null) {
        if (event.data.action === 'rename') {
          if (!event.data.ok) { if (lastSubmit?.local === true) settleDraft(lastSubmit.ref, true); commit(noteResult(view, event.data.error ?? '改名失败')) }
          else send({ type: 'session.list', archived: directory.archived })
        }
        return
      }
      managementPending = null
      if (!event.data.ok) { commit(noteResult(view, event.data.error ?? '会话操作失败，请重试')); return }
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
      // 同一份协作里的任何一条会话（入口或子会话）都认这份快照；别的会话的不串线。
      const sameWork = data.originSession === view.sessionId
        || data.members.some(one => one.agent.sessionId === view.sessionId)
        || view.collaboration?.originSession === data.originSession
      if (view.sessionId !== null && !sameWork) return
      const previous = view.collaboration
      commit({ ...view, collaboration: data, ...(data.messages === undefined ? {} : { messages: data.messages }) })
      appendCollaborationMessages(data)
      for (const member of data.members) {
        if (member.agent.purpose !== 'consultation' || member.delegation?.deliveryMessageId === undefined) continue
        if (previous?.members.some(one => one.delegation?.deliveryMessageId === member.delegation?.deliveryMessageId)) continue
        commit(appendReceipt(view, `咨询 Arcane · 来自顾问 · ${memberState(member)} · 打开该子会话查看原始建议`))
      }
      if (data.note !== undefined) commit(appendReceipt(view, data.note))
      if (collaborationQuery !== null) {
        collaborationQuery = null
        if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'background') openCollaboration()
      } else if (view.dock.kind === 'picker' && view.dock.picker.source === 'collaboration') {
        openCollaboration(view.dock.picker.rows[view.dock.picker.selected]?.value)
      }
      return
    }

    // 别的成员的事件不混进当前会话正文；会话级事实（切换、目录、输入回执）仍要收。
    const controlFact = event.kind === 'session.state' || event.kind === 'input.settled'
    if (memberForSession(view.collaboration, event.session) !== undefined
      && event.session !== view.sessionId && !controlFact) return

    if (event.kind === 'session.history') {
      if (preview?.session === event.data.session) {
        if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'session-history') { if (event.data.done) preview = null; return }
        if (event.data.error !== undefined) { commit(noteResult(view, `${event.data.error} · Enter 重试`)); preview = null; return }
        preview.entries.push(...historyEntries(event.data))
        preview.entries.sort((a, b) => a.at - b.at || a.id - b.id)
        const picker = view.dock.picker
        const rebuilt = rebuild(createView(), preview.entries, { ...(event.data.plan === undefined ? {} : { plan: event.data.plan }), ...(event.data.timing === undefined ? {} : { timing: event.data.timing }) })
        commit({ ...view, dock: { kind: 'picker', picker: { ...picker, reader: { ...picker.reader!,
          title: picker.reader!.title.replace(' · 正在读取', event.data.done ? '' : ' · 正在读取'), rows: [...rebuilt.settled, ...rebuilt.rows] } } } })
        if (event.data.done) preview = null
        return
      }
      accumulate(event.data)
      return
    }

    const before = view.sessionId
    const prior = view
    if(event.kind==='session.state'&&event.data.active!==before)workContexts.set(before,{member:view.inputMember,current:currentInput(view),members:new Map(inputContexts),purpose:view.inputPurpose})

    let reduced = reduce(view, event, { turn: turn?.kind ?? null })
    commit(reduced, STREAMING.has(event.kind))
    if (event.kind === 'turn.end' && view.sudo != null) { sudoPassword = ''; commit({ ...view, sudo: null }) }

    const reasoning = configReasoningOf(view.modelCurrent)
    const reasoningLabel = reasoning === undefined ? null : reasoningText(reasoning)
    if (view.status.reasoning !== reasoningLabel) commit(patchStatus(view, { reasoning: reasoningLabel }))

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
        // 实验性那几项：**回话里没带就按关**（缺省＝关，见 `ExperimentalConfig`）
        voiceEnabled: event.data.voice === true,
        turnDuration: event.data.turnDuration ?? 'elapsed',
      })
      if (held === 'statusline') openStatusLinePicker(picked(view)?.value === undefined ? 0 : view.dock.kind === 'picker' ? view.dock.picker.selected : 0)
      if (held === 'config') refreshConfigPicker()
      if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
    }

    if (event.kind === 'session.state') {

      if (before !== (event.data.active||null)) {
        // 切会话那一下已把这一屏收起：等待中的读面答复不再替用户重开列表。
        collaborationQuery = null
        layers = []
        // 晚到的读面答复可能在切换后才把协作那一屏重新打开——它属于旧会话，一并收起。
        if (view.dock.kind === 'picker' && (view.dock.picker.source === 'collaboration' || view.dock.picker.source === 'collaboration-records')) {
          view = { ...view, dock: { kind: 'input' } }
        }
        backgroundAt = undefined
        psPositions.clear()
        models.clearTarget()
        // 入口与子会话同属一份协作时，快照与审批继续沿用；换到别的会话才清。
        const sameCollaboration = prior.collaboration !== undefined
          && (prior.collaboration.originSession === event.data.active
            || prior.collaboration.members.some(one => one.agent.sessionId === event.data.active))
        inputContexts.clear()
        const saved=workContexts.get(event.data.active||null)??(before===null&&(lastSubmit!==null||turn===null)?workContexts.get(null):undefined)
        if(saved!==undefined)for(const [member,context] of saved.members)inputContexts.set(member,context)
        history=saved?.current.history??[];historyAt=saved?.current.historyAt??-1;browsing=saved?.current.browsing??null;lastSubmit=saved?.current.lastSubmit??null
        commit({...view,background:undefined,collaboration:sameCollaboration ? prior.collaboration : undefined,messages:undefined,inputMember:saved?.member,inputPurpose:saved?.purpose??'current',draft:saved?.current.draft??'',refs:saved?.current.refs??[],caret:saved?.current.caret??0})
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
          // 页注说**会话名**（id 已在列表行上，切完的回执不再复读一遍）。
          commit(appendPageNote(view, `已切到 ${nameOfSession(event.data.active)}`))
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

    if (event.kind === 'model.catalog' || event.kind === 'provider.catalog' || event.kind === 'models.search') {
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
    if (event.kind === 'session.references' && event.data.requestId === referenceRequest) {
      const previous = referenceCatalog
      referenceCatalog = event.data.offset > 0 && previous?.query === event.data.query
        ? { ...event.data, rows: [...previous.rows, ...event.data.rows.filter(row => !previous.rows.some(one => one.id === row.id))] }
        : event.data
      refreshPaths()
    }

    if (event.kind === 'paths.identified') identifyPicked(event.data)

    if (event.kind === 'input.pasted') pastedClipboard(event.data)

    if (event.kind === 'input.settled') {
      const batch = event.data.ref === undefined ? undefined : submittedBatches.get(event.data.ref)
      if (event.data.ok && event.data.refs !== undefined && batch !== undefined) {
        const refs = event.data.refs.map(({ at, ...ref }) => ({ ...ref, start: at, end: at + ref.marker.length }))
        const at = batch.history.findIndex(entry => entry.inputRef === event.data.ref)
        const old = batch.history[at]
        if (old !== undefined) {
          batch.history[at] = { ...old, refs }
          if (view.refs === old.refs) commit({ ...view, refs })
        }
      }
      acceptBatch(event.data.ref, event.data.ok)
    }
    if (event.kind === 'input.settled' && event.data.stage !== 'accepted') {
      settleDraft(event.data.ref, !event.data.ok && event.data.keepDraft !== false)
    }

    if (event.kind === 'input.settled' && event.data.ok && event.session !== '') {
      if (!view.catalog.some((one) => one.id === event.session)) send({ type: 'session.list' })
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
    /**
     * 读取失败/降级时**不清屏**：已经收到的条目仍在，界面保留上一份内容并给一句
     * 可重试的说明。2026-11-21 的教训是「用着用着突然不能用了」——历史读失败
     * 不该等于历史消失。
     */
    if (data.error !== undefined && rebuildEntries.length === 0) {
      rebuildFor = null
      commit({ ...view, flash: data.error })
      return
    }

    rebuildEntries = [...rebuildEntries].sort((a,b)=>a.at-b.at||a.id-b.id)
    if (history.length === 0) {
      const past: { at: number; input: HistoryEntry }[] = []
      for (const entry of rebuildEntries) {
        if (entry.kind !== 'user' || !('text' in entry.content) || (entry.payload as { notice?: true } | undefined)?.notice === true) continue
        const payload = entry.payload as import('@magic/contracts').UserPayload | undefined
        const refs = payload?.local === true ? payload.inputRefs ?? [] : payload?.refs ?? []
        past.push({ at: entry.at, input: { text: entry.content.text, refs: refs.map(({ at, ...ref }) => ({ ...ref, start: at, end: at + ref.marker.length })) } })
      }
      const requests = new Set<string>()
      for (const event of data.compactions ?? []) if (!requests.has(event.data.requestId) && (event.data.accepted === true || ['pending', 'running', 'completed'].includes(event.data.state))) {
        requests.add(event.data.requestId)
        past.push({ at: event.at, input: { text: '/compact ' + (event.data.focus ?? ''), refs: [] } })
      }
      history.push(...past.sort((a, b) => a.at - b.at).map(one => one.input))
    }
    for (const event of data.compactions ?? []) view = reduce(view, event)
    const unconfirmed = [...view.settled, ...view.rows].filter(row => row.kind === 'user' && row.inputState !== undefined && !view.pendingInputs.some(input => input.ref === row.inputRef && input.entry !== undefined))
    const rebuilt = rebuild(view, rebuildEntries, {
      ...(data.plan === undefined ? {} : { plan: data.plan }),
      ...(data.timing === undefined ? {} : { timing: data.timing }),
      ...(data.messages === undefined ? {} : { messages: data.messages }),
    })
    /**
     * **接回这条会话的用量读数**（`session.history.usage`，末块给）——状态行 ④ 放回离开那一刻
     * 那个数：`/resume` 与 `magic resume <id>` 换过去时那一格先按「不知道」省掉（见
     * `reduceSessionState` 与开机那一格），这里补上。
     *
     * 已经在报的数是更新的现场（这一趟跑出来的），**不盖**——拿历史里那份旧读数盖回去就是
     * 「用旧账压新账」。`0` 不算「已经报过」：那是开机／刚开一条新会话那一位（一个 token 都
     * 还没用），真实调用报回来的分子不会是这个数。
     */
    const live = view.status.usage !== null && view.status.usage !== 0
    const withUsage = live || data.usage === undefined ? rebuilt : patchStatus(rebuilt, {
      ...(data.usage.inputTokens === undefined ? {} : { usage: data.usage.inputTokens }),
      ...(data.usage.contextWindow === undefined ? {} : { window: data.usage.contextWindow }),
    })
    commit({
      ...withUsage,
      rows: [...withUsage.rows, ...unconfirmed],
      ...(data.truncated === true ? { flash: '记录过长，已显示部分内容' } : {}),
    })
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
    commit({...resumed,dock:held.dock,draft:held.draft,refs:held.refs,caret:held.caret,stashed:held.stashed,status:resumed.status})
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
      ...(session === view.sessionId && archived ? [collaborationRow('draft', '查看／复制原草稿')] : [])]
    if (push) enterLayer()
    commit(openPicker(view, { source: 'session-actions', title: `${nameOfSession(session)}${archived ? ' · 已归档' : ''}`,
      selected: Math.max(0, rows.findIndex(row => row.value === keep)), rows, hint: '↑↓ 选择 · Enter 执行 · Esc 返回' }))
  }
  const manageSession = (type: 'session.archive' | 'session.restore'): void => {
    if (sessionTarget === undefined || managementPending !== null) return
    if (!connected) { commit(noteResult(view, 'Engine 未连接，请先 Ctrl+R 重连')); return }
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

    commit(withRunFacts(view, rows))
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
    // 子会话里的标准停止止于这份委派及其派生闭包——回执要把范围写明。
    const sub = currentMember(view)
    const title = sub !== undefined && report.session === view.sessionId
      ? `${sub.agent.name} · 委派「${sub.delegation?.scope ?? sub.agent.responsibility ?? sub.agent.role}」及派生闭包`
      : nameOfSession(report.session)
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
    if (notice.session !== view.sessionId && notice.session !== view.collaboration?.originSession
      && view.collaboration?.members.some(one => one.agent.sessionId === notice.session) !== true) return
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
    commit(finishExecution(view))
  }
  options.detached?.(() => {
    if (disposed) return
    finishCurrent()
    // 尚未收到服务端接收回执的输入仍是草稿，执行者退出不能把它丢掉。
    const held = view.inputMember === undefined ? lastSubmit : inputContexts.get(undefined)?.lastSubmit
    if (held?.local !== true) settleDraft(held?.ref, true)
  })

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
   * 读数从**视图**里取（`model.catalog` / `mcp.catalog` 各自落下的那一格），
   * 路径从**入参**里取（`ConfigPaths`——那几件没有命令问得到，由装配递进来）。
   * 筛词从壳上那一位取（它不住在视图里，同 `sessionQuery`）。
   */
  const configInput = (): Parameters<typeof configRows>[0] => ({
    paths: {
      dataDir: options.dataDir,
      home: options.home,
      workspaceRoots: options.workspaceRoots,
    },
    models: view.models,
    current: view.modelCurrent,

    mcp: view.mcp,
    web: view.web,

    statusLine: view.statusLine,
    reducedMotion: view.reducedMotion,
    voice: view.voiceEnabled,
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

  /**
   * **实验性 · 语音输入**（D75）——开了才接「右 ⌥ 那一跳」（监听器与焦点上报）。
   *
   * ⚠️ 生效**不重启界面**：落定读数经 `prefs.state` 回来（`view.voiceEnabled`），
   *    `run.ts` 那一侧据此起停——屏上这一格与真正接没接，永远取自同一处。
   */
  const toggleVoiceInput = (): void => {
    send({ type: 'prefs.set', voice: !view.voiceEnabled })
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
        title: '引用文件、目录或会话',
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

    referenceFocus = undefined
    referenceCatalog = null
    view = { ...view, paths: null }
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
          selected: query === picker.filter ? picker.selected : 0,
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
    const session = referenceCatalog?.rows.find(one => `session:${one.id}` === row?.value)
    if (anchor === undefined || view.dock.kind !== 'picker') return
    if (session === undefined && (found === undefined || view.paths?.query !== view.dock.picker.filter)) return
    if (session !== undefined && referenceCatalog?.query !== view.dock.picker.filter) return

    const text = session === undefined ? found!.kind === 'directory' ? `${found!.display}/` : found!.display : session.title ?? session.member?.name ?? '未命名会话'
    const from = anchor.start + 1 // `@` 自己留着——查询那一段是它后面这一截
    // 把 `[from, anchor.end)` 换成补全后的那一段：先按删的算位移，再按插的算
    const refs = insertText(removeRange(view.refs, from, anchor.end), from, text.length)

    editAt(view.draft.slice(0, from) + text + view.draft.slice(anchor.end), from + text.length, refs)
    reopenPaths({ start: anchor.start, end: from + text.length }, text)
    referenceFocus = session === undefined ? undefined : `session:${session.id}`
    askPaths(text)
  }

  const pickPath = (): void => {
    const anchor = view.dock.kind === 'picker' ? view.dock.picker.anchor : undefined
    const row = picked(view)
    if (row?.value === 'session:more' || row?.value === 'session:retry') {
      askReferenceSessions(view.dock.kind === 'picker' ? view.dock.picker.filter ?? '' : '', row.value === 'session:more' ? referenceCatalog?.next : undefined)
      return
    }
    const session = referenceCatalog?.rows.find(one => `session:${one.id}` === row?.value)
    if (session !== undefined && anchor !== undefined && view.dock.kind === 'picker' && referenceCatalog?.query === view.dock.picker.filter) {
      commit(withCompletion({ ...closePicker(view), ...replaceWith(view.draft, view.refs, { from: anchor.start, to: anchor.end },
        { kind: 'session', source: session.id, marker: markerOf({ kind: 'session', name: session.title ?? session.member?.name ?? '未命名会话' }) }, view.caret) }))
      referenceFocus = undefined
      return
    }
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
    const picker = view.dock.picker
    const paths = catalog?.query === query ? catalog.rows : []
    const sessions = referenceCatalog?.query === query ? referenceCatalog : null
    const rows: readonly PickerRow[] = [
      ...pathRows(paths).map(row => ({ ...row, group: '文件与目录' })),
      ...sessionReferenceRows(sessions?.rows ?? []),
      ...(sessions?.next === undefined ? [] : [{ value: 'session:more', label: '继续读取会话', meta: '', current: false, group: '会话' }]),
      ...(sessions?.error === undefined ? [] : [{ value: 'session:retry', label: '重新读取会话', meta: sessions.error, current: false, group: '会话' }]),
    ]
    const selectedIdentity = referenceFocus ?? picker.rows[picker.selected]?.value
    // 同一查询更新只跟随身份；来源消失时不让 Enter 暗选原行号上的另一份。
    const selected = selectedIdentity === undefined
      ? picker.selected < 0 ? -1 : 0
      : rows.findIndex(row => row.value === selectedIdentity)
    if (selected >= 0) referenceFocus = undefined

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...view.dock.picker,
          rows,
          selected,
          hint: selected < 0 && referenceFocus === undefined
            ? '原候选已不在列表中 · ↑↓ 重新选择 · Esc 返回'
            : [pathHint({ filter: query, shown: paths.length, pending: catalog?.query !== query, ...(catalog?.query === query ? { note: catalog.note } : {}) }),
              sessions === null ? '正在读取会话…' : sessions.rows.length === 0 && sessions.error === undefined ? '没有匹配会话' : '',
              '↑↓ 选择 · Tab 补全 · Enter 选入 · Esc 返回'].filter(Boolean).join('\n'),
        },
      },
    })
  }

  /** 问一次路径候选——`query` 是 `@` 之后那一段（可以是空串）。 */
  const askPaths = (query: string): void => {
    send({ type: 'paths.list', query })
    askReferenceSessions(query)
  }

  const askReferenceSessions = (query: string, offset?: number): void => {
    referenceRequest = crypto.randomUUID()
    send({ type: 'session.references', requestId: referenceRequest, query, ...(offset === undefined ? {} : { offset }) })
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

  /** 协作视图：整件工作摘要与操作 ＋ 平铺子会话列表（当前会话不在列表里）。 */
  const openCollaboration = (selected?: string): void => {
    const snapshot = view.collaboration
    const member = currentMember(view)
    /**
     * **工作级那几条**——独立成一组（`工作级`），与成员行之间只隔一组头，不画线。
     *
     * `停止整件工作` 走 `danger`（不可逆：铺不开回收）；`明确继续整件工作` 走 `wait`
     * （先核对停点）。两处都是「按下去有后果」的，颜色替用户先看一眼。
     */
    const workRow = (value: string, label: string, meta = '', tone?: 'run' | 'wait' | 'danger' | 'idle') =>
      ({ ...collaborationRow(value, label, meta, tone), group: '工作级' })
    const rows = [
      ...(snapshot?.collaboration ? memberRows(snapshot, view.sessionId) : []),
      ...(snapshot?.collaboration ? [workRow('whole', '回到主会话', '恢复入口草稿；输入只发给入口自己'),
        workRow('broadcast', '向所有成员补充', '共同要求送达相关成员'),
        workRow('constraints', '共同补充的带入情况'),
        workRow('default-model', '后续派生的默认模型', '按需配置'),
        workRow('stop-work', '停止整件工作', '覆盖全部成员及继续委派', 'danger'),
        ...(snapshot.collaboration.state === 'stopped' ? [workRow('resume-work', '明确继续整件工作', '先核对停点', 'wait')] : [])] : []),
    ]
    // 从子会话打开时主会话在列表里并预选（Enter 返回）；在主会话时它不出现。
    const preselected = selected ?? (member === undefined ? undefined : snapshot?.collaboration?.coordinatorId)
    commit(openPicker(view, {
      source: 'collaboration', title: '整件工作 · 子会话', tabs: workTabs('collaboration'), rows,
      selected: Math.max(0, rows.findIndex(row => row.value === preselected)),
      hint: `${snapshot?.collaboration ? '浏览列表不切输入 · Enter 进入子会话或执行操作' : '没有协作成员'}\nTab/Shift+Tab 切换 · ↑↓ 选择 · Enter 打开 · Esc 返回`,
    }))
  }
  /** 把新到的协作消息并入当前子会话正文；同一 messageId 只落一次。 */
  const appendCollaborationMessages = (snapshot: CollaborationView): void => {
    if (snapshot.messages === undefined || currentMember({ collaboration: snapshot, sessionId: view.sessionId }) === undefined) return
    const known = new Set([...view.settled, ...view.rows].map(row => row.key))
    const fresh = messageRows(snapshot, snapshot.messages).filter(row => !known.has(row.key))
    if (fresh.length === 0) return
    commit({ ...view, settled: [...view.settled, ...fresh.map(row => ({ kind: 'output' as const, key: row.key, lines: row.lines }))] })
  }
  /** 进入会话（子会话或返回主会话）——与 `/resume` 同一条切换路径，不新增快捷键。 */
  const openSession = (session: SessionId, label: string): void => {
    if (session === view.sessionId) { commit(closePicker(view)); return }
    turn = { kind: 'open', label }
    // 先收起这一屏再发切换：答复可能是一串同步事件，别让它之后的老视图盖回去。
    commit(closePicker(view))
    send({ type: 'session.open', session })
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
  const readCollaboration = (): void => {
    enterLayer()
    openCollaboration()
    send({ type: 'background.list' })
    collaborationQuery = {}
    send({ type: 'collaboration.read' })
  }
  const openRecords = (key: string, title: string, rows: readonly import('./view.ts').LogRow[]): void => {
    enterLayer()
    commit(openPicker(view, { source: 'collaboration-records', rows: [], selected: 0,
      reader: { key, title, rows, top: reading.get(key) ?? 0 } }))
  }
  const configureCollaboration = (): void => {
    enterLayer()
    models.target()
    waiting = null
    send(models.request('model'))
  }
  const collaborationAction = (row: PickerRow): void => {
    const snapshot = view.collaboration
    if (snapshot?.collaboration === undefined || view.dock.kind !== 'picker') return
    const member = snapshot.members.find((one) => one.agent.agentId === row.value)
    // 列表里的一行就是一条会话：Enter 切进去（从子会话选主会话即返回）。
    if (member !== undefined) { openSession(member.agent.sessionId, member.agent.name); return }
    if (row.value === 'whole') {
      // 「向整件工作补充」＝回到入口会话，用它的整体草稿发送（共同补充）。
      openSession(snapshot.originSession, snapshot.members.find((one) => one.agent.agentId === snapshot.collaboration?.coordinatorId)?.agent.name ?? '整件工作')
      return
    }
    if (row.value === 'default-model') configureCollaboration()
    else if (row.value === 'stop-work' || row.value === 'resume-work') {
      commit(closePicker(view))
      send({ type: row.value === 'stop-work' ? 'collaboration.stop' : 'collaboration.resume' })
    } else if (row.value === 'constraints') {
      openRecords('constraints', '共同补充 · 带入不代表已遵守', snapshot.constraints.map((constraint, index) => ({
        kind: 'output', key: String(constraint.messageId), lines: [`共同补充 ${index + 1}`, ...constraint.states.map((state) =>
          `${snapshot.members.find((one) => one.agent.agentId === state.agentId)?.agent.name ?? '成员'}：${state.state === 'included' ? '已带入后续请求' : '已接收 / 待带入'}`)],
      })))
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

  const rememberInput = (text: string, refs: readonly DraftRef[], inputRef?: string): void => {
    const firstCleared = history.findIndex(entry => entry.cleared !== undefined)
    history.splice(firstCleared === -1 ? history.length : firstCleared, 0, { text, refs, ...(inputRef === undefined ? {} : { inputRef }) })
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
    /**
     * 一条消息装不下时**不能静默丢**：发送端会拒发（连接保持），但用户会以为
     * 发出去了、界面停在「提交中」——那仍然是「突然不能用」。保留草稿、说清出口。
     */
    if (new TextEncoder().encode(text).byteLength > WIRE_MESSAGE_BUDGET_BYTES - 64 * 1024) {
      commit({ ...view, flash: '这一句太长，单条消息装不下——请拆成几条，或用 @ 引用文件' })
      return NONE
    }
    // 咨询子会话只供查看；纠正与补充要给原工作。
    if (currentMember(view)?.agent.purpose === 'consultation') {
      commit(appendReceipt(view, '咨询子会话只供查看；相关纠正请补充给原工作'))
      return NONE
    }
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
    rememberInput(text, refs, ref)

    const echoed = view.inputMember === undefined ? appendEcho(cleared,text,userImages(refs)) : cleared
    draft({...echoed,rows:echoed.rows.map((row,index)=>row.kind==='user'&&index===echoed.rows.length-1?{...row,inputRef:ref,inputState:'提交中'}:row)})
    const input = { text, ref, purpose, ...(refs.length === 0 ? {} : { refs: wire(refs) }), ...(view.modelChoice === null ? {} : { model: view.modelChoice }) }
    // 子会话里输入只发给这一条子会话；入口会话默认只给自己（不再广播给成员）。
    const sub = currentMember(view)
    send(view.collaboration?.collaboration === undefined ? { type: 'input.submit', ...input }
      : sub !== undefined ? { type: 'collaboration.input', member: sub.agent.agentId, input }
        : { type: 'collaboration.input', input, ...(view.inputMember === undefined ? {} : { member: view.inputMember }) })

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
    if (working() || view.compactions.some(one => one.session === view.sessionId && ['pending', 'running'].includes(one.state.state))) return true

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

  /** 子会话里的标准停止键止于这份委派及其派生闭包；入口会话仍是整件工作。 */
  const taskRowsOf = (): readonly PickerRow[] => currentMember(view) === undefined ? TASK_ROWS : [
    { label: '停止这份委派', meta: '停止该委派及其派生闭包；其他委派保留', current: false, value: 'stop', oneLine: true },
    { label: '转到后台', meta: '退出界面，任务继续运行', current: false, value: 'background', oneLine: true },
    { label: '停止并退出', meta: '停止这份委派并退出 Magic', current: false, value: 'stop-exit', oneLine: true },
  ]
  const taskPickerOf = (asked: boolean, selected = 0): Picker => ({
    source: 'task',
    title: asked ? '当前任务正在等待你' : '当前任务仍在运行',
    rows: taskRowsOf(),
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

    const asked = false
    const row = view.runs.find((one) => one.session === view.sessionId)
    taskMenu = {
      session: view.sessionId,
      taskEntry: view.taskEntry,
      runStartedAt: row?.startedAt ?? null,
      asked,
    }

    if (asked) layers = [...layers, layerNow()]
    else enterLayer()

    commit(openPicker(view, taskPickerOf(asked)))
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
      memory.reconnected()
      for (const one of view.compactions) if (['pending', 'running', 'unknown'].includes(one.state.state)) send({ type: 'compact.query', session: one.session, requestId: one.state.requestId })
    }, error => {
      if (!disposed) commit(appendReceipt(view, `重新连接失败：${String(error)}`))
    }).finally(() => { reopening = false; if (!disposed) commit(view) })
    return NONE
  }

  const disconnect = (why?: string): void => {
    if (disposed || !connected) return
    connected = false
    memory.disconnected()
    view = { ...view, compactions: view.compactions.map(one => ['pending', 'running'].includes(one.state.state) ? { ...one, state: { ...one.state, state: 'unknown' } } : one) }
    view = { ...view, background: { commands: view.background?.commands ?? [], waiting: [], unknown: true }, sudo: null }
    sudoPassword = ''
    const unconfirmed = new Set([...view.settled, ...view.rows].filter(row => row.kind === 'user' && row.inputState === '提交中').map(row => row.kind === 'user' ? row.inputRef : undefined))
    if (lastSubmit !== null && unconfirmed.has(lastSubmit.ref)) settleDraft(lastSubmit.ref, true)
    const mark = (row: import('./view.ts').LogRow) => row.kind === 'user' && unconfirmed.has(row.inputRef) ? { ...row, inputState: '未确认接收（连接已断开）' } : row
    pendingResume = null
    if (resumeTimer !== undefined) clearTimeout(resumeTimer)
    resumeTimer = undefined
    const waiting = exitWait !== null
    exitWait = null
    commit(patchStatus(appendReceipt({ ...view, settled: view.settled.map(mark), rows: view.rows.map(mark) }, `连接已断开${why ? `（${why}）` : ''}，暂时无法确认任务状态。${waiting ? '停止尚未确认。' : ''}`), { state: 'lost', amount: null, hint: HINT_LOST }))
  }

  let verticalColumn:number|null=null
  /** sudo 组件开着时，所有键归它——密码不进草稿、不回显、不静默吞。 */
  const sudoKey = (input: ShellKey): ShellEffect | undefined => {
    const sudo = view.sudo
    if (sudo == null) return undefined
    if (sudo.busy === true) return NONE
    if (input.kind === 'char') {
      sudoPassword += input.char
      commit({ ...view, sudo: { ...sudo, masked: sudoPassword.length, error: undefined } })
      return NONE
    }
    if (input.kind === 'backspace') {
      sudoPassword = [...sudoPassword].slice(0, -1).join('')
      commit({ ...view, sudo: { ...sudo, masked: sudoPassword.length, error: undefined } })
      return NONE
    }
    if (input.kind === 'enter') {
      const password = sudoPassword
      sudoPassword = ''
      options.sudo?.answer(sudo.requestId, password)
      commit({ ...view, sudo: { ...sudo, masked: 0, busy: true, error: undefined } })
      return NONE
    }
    if (input.kind === 'escape' || input.kind === 'ctrl+c') {
      sudoPassword = ''
      options.sudo?.answer(sudo.requestId, null)
      commit({ ...view, sudo: null })
      return NONE
    }
    return NONE
  }

  /**
   * **语音那一路**（U135）——录一句，把文字插到插入点。
   *
   * 它只做三件事：开、收、插。**不接管输入区**：录音期间照旧可以打字、按别的键
   * （语音只是又一个输入源）；Esc 那一支在录音时先归这里。
   *
   * 文字**等同键盘输入**：插在插入点、不自动发送、不碰引用——与手打出来的草稿没有区别，
   * 故上下文装配、输入契约、记录域一个字都不用改。
   */
  let voiceSession: { readonly stop: () => void; readonly cancel: () => void } | null = null
  /** 第几次录音——取消过的那些回调**不再算数**（麦克风那头可能晚一步才回来）。 */
  let voiceRun = 0

  /** 语音失败时那句人话——按助手给的码说清楚下一步，不把「没听见」当成功。 */
  const voiceProblem = (code: string, message?: string): string => {
    switch (code) {
      case 'denied':
        return '还没有麦克风／语音识别的授权：到「系统设置 › 隐私与安全性 › 麦克风（与语音识别）」里给这个终端打开，再轻点右 ⌥。'
      case 'restricted':
        return '这台机器不允许语音识别（受系统限制），语音这一路用不了。'
      case 'auth-timeout':
        return '系统没有回应授权请求（可能弹窗在别的桌面或没点）。授权完再轻点右 ⌥。'
      case 'locale-unavailable':
        return '系统里没有中文（zh-CN）的识别资源，语音这一路用不了。'
      case 'on-device-unavailable':
        return '端侧识别还没就绪：先在「系统设置 › 键盘 › 听写」里装上中文，再来一次。'
      case 'no-input-device':
        return '这台机器上没有可用的麦克风。'
      case 'audio-start':
        return `开不了麦克风：${message ?? '系统没给设备'}`
      default:
        return message === undefined ? `语音这一路没走通（${code}）。` : `语音这一路没走通（${code}）：${message}`
    }
  }

  const toggleVoice = (): ShellEffect => {
    const voice = options.voice
    if (voice === undefined) return NONE
    // 正在等文字：再点也不叠第二次录音。
    if (view.voice?.state === 'transcribing') return NONE
    if (view.voice?.state === 'recording') {
      voiceSession?.stop()
      commit({ ...view, voice: { state: 'transcribing' } })
      return NONE
    }
    if (voiceSession !== null) return NONE
    const run = voiceRun + 1
    voiceRun = run
    const session = voice.start({
      onFinal: (text) => {
        // 取消过的那一次：晚到的结果**丢掉**（它已经不算数了）。
        if (voiceRun !== run) return
        voiceSession = null
        const at = view.caret
        commit({ ...view, draft: view.draft.slice(0, at) + text + view.draft.slice(at), caret: at + text.length, voice: null })
      },
      onError: (code, message) => {
        if (voiceRun !== run) return
        voiceSession = null
        commit(noteResult({ ...view, voice: null }, voiceProblem(code, message)))
      },
    })
    voiceSession = session
    commit({ ...view, voice: { state: 'recording' } })
    return NONE
  }

  const key = (input: ShellKey): ShellEffect => {
    const sudo = sudoKey(input)
    if (sudo !== undefined) return sudo
    if(input.kind!=='up'&&input.kind!=='down')verticalColumn=null
    if (disposed) return NONE
    // **语音那一路**（U135）——放在最前面：它是「又一个输入源」，不该被下面
    // 「已归档 / 选择器 / 断线」那些分流吞掉（那些是**提交**那一步的规矩，不是打字的规矩）。
    if (input.kind === 'voice') return toggleVoice()
    // 录音中按 Esc＝**取消这一次**（不写草稿），不打断运行中的工作。
    if (input.kind === 'escape' && view.voice?.state === 'recording') {
      voiceSession?.cancel()
      voiceSession = null
      voiceRun += 1
      commit({ ...view, voice: null })
      return NONE
    }
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
          submit: value => { if (value.trim() === '/memory' && value.startsWith('/memory ')) { prompt.clear(); memory.open(); return null }; if (value.trim() === '/resume') { models.cancelOpen(); waiting = 'session'; directory.ordinary(); return { type: 'session.list', archived: false } }; return null } })
        return NONE
      }
      if (!['ctrl+c', 'ctrl+o', 'escape', 'planTop', 'ctrl+t'].includes(input.kind)) {
        commit(noteResult(view, '已归档，原草稿保留。Ctrl+G 查看草稿或明确恢复；/resume 切换会话。')); return NONE
      }
    }
    if (input.kind === 'enter' && view.dock.kind === 'input' && view.draft.trim() === '/connect') {
      commit({ ...view, draft: '', caret: 0, refs: [], completion: null })
      return reconnect()
    }
    if (!connected && input.kind === 'enter' && view.dock.kind === 'input' && !view.draft.trim().startsWith('/')) {
      commit(noteResult(view, options.settingsOnly ? '本地设置不发送任务，草稿已保留；退出后运行 magic 开始工作。' : '连接已断开，草稿未发送。输入 /connect 或按 Ctrl+R 重连。'))
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
      && !['left', 'escape', 'ctrl+c', 'ctrl+o', 'tab'].includes(input.kind)) return NONE

    if (view.dock.kind === 'picker' && (['paths','skills','session','config'].includes(view.dock.picker.source) || view.dock.picker.memory?.mode === 'knowledge')) {
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
        else if(picker.source==='memory'){memory.filter(next)}
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
      case 'planTop':
        if (view.dock.kind !== 'input') return NONE
        commit({ ...view, planTop: Math.max(0, Math.trunc(input.top) || 0) })
        return NONE

      case 'paste':
        // 抽屉开着时粘贴一律不收：`@` 那一栏的查询与草稿是**同一段文字**（见 `typePath`），
        // 从旁路插一刀会让锚点与正文对不上；其余抽屉更是接管着输入（打进去的字一律吞掉）。
        if (view.dock.kind === 'picker') return NONE
        // **原文照收**：粘贴进来的那一串一个字不改（Tab、多行都留着——它们是正文）
        insertAt(input.text)
        return NONE

      case 'ctrl+v':
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
        if (view.completion !== null) {
          commit(moveCompletion(view, delta))
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

      case 'enter': {
        // 候选开着、选中的是已注册命令、且草稿**还停在命令名上**（无空白、是它的前缀）
        // ⇒ 回车先把它补进草稿（`命令名 ＋ 空格`），不提交（U133）。
        //
        // 三条限定缺一不可：
        // - 只认**前缀**：候选是模糊匹配（包含／子序列），`/hlp` 也会列出 `/help`，
        //   那种是打正文，回车必须照发；
        // - 有空白就不拦：`/helpful text` 是正文；
        // - 裸命令例外：`/ps`、`/status`、`/connect` 本身就是可执行的一条，回车照执行。
        const bare = view.draft.trim()
        const picked = view.completion?.candidates[view.completion.selected]
        const isCommand = picked !== undefined && COMMANDS.some((command) => command.name === picked.name)
        const bareCommand = COMMANDS.some((command) => command.name === bare)
        if (isCommand && !/\s/.test(bare) && !bareCommand && picked !== undefined && picked.name.startsWith(bare)) {
          pickCompletion()
          return NONE
        }
        return submit()
      }

      case 'left':
        // 明确移动插入点后退出历史浏览，回到文字编辑。
        // 插入点挨着一处引用时**整处跨过去**（引用是一个编辑单位，见 `inline.ts`）。
        historyAt = -1; browsing = null
        draft({ ...view, caret: stepLeftOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'right':
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
        if (view.dock.kind === 'picker') return NONE

        const [start, end] = lineSpan(view.draft, caretAt())
        historyAt = -1; browsing = null
        draft({ ...view, caret: input.kind === 'lineStart' ? start : end })
        return NONE
      }

      case 'backspace':
        if (view.dock.kind === 'picker') return NONE
        const erase = backspaceRange(view.refs, view.draft, caretAt())
        eraseAt(erase.from, erase.to)
        return NONE

      // 前向删除（`delete` 键）——删插入点右边那一个单位（引用整个走）
      case 'delete':
        if (view.dock.kind === 'picker') return NONE
        const gone = deleteRange(view.refs, view.draft, caretAt())
        eraseAt(gone.from, gone.to)
        return NONE

      case 'char':
        if (view.dock.kind === 'picker') return NONE
        const previous=layerNow()
        insertAt(input.char)
        // `@` 在**词边界**上 ⇒ 开路径候选（邮箱那种紧挨着字的 `@` 不触发；
        // 前面带反斜杠的转义 `@` 也不触发——它只想打一个 `@`）
        if (input.char === '@' && opensPath(view.draft, caretAt())) { layers=[...layers,previous];openPathsAt() }
        return NONE

      // `shift+回车`——**换行**（原型 · 键盘）。接管期间同其余键：不静默吞，说一句。
      case 'newline':
        if (view.dock.kind === 'picker') return NONE
        insertAt('\n')
        return NONE

      case 'other':
        return NONE
    }
  }

  /** 回车——接管 / 选择器 / 输入三种归处。 */
  const submit = (): ShellEffect => {
    // **启动中不收**（技术方案 · 装配视图第 5 步：以 `boot` 完成为界）——草稿留着
    if (!ready) return bootRefusal()
    if (view.archived && view.dock.kind === 'input') { commit(noteResult(view, '会话已归档，请明确恢复后继续')); return NONE }
    // 本地小输入开着 ⇒ 回车是**把它交出去**（不是发交代——那一路归 `input.submit`）
    if (view.dock.kind === 'prompt') { prompt.submit(); return NONE }

    if (view.dock.kind === 'picker') {
      const row = picked(view)
      if (row === undefined) return NONE
      if (view.dock.picker.source === 'compact-status') {
        if (row.value === 'back') popLayer()
        else {
          const index = row.value.indexOf(':'), requestId = row.value.slice(index + 1)
          const target = view.compactions.find(one => one.session === view.sessionId && one.state.requestId === requestId)
          if (target) send({ type: row.value.startsWith('cancel:') ? 'compact.cancel' : 'compact.query', session: target.session, requestId })
        }
        return NONE
      }
      if (view.dock.picker.source === 'memory') { memory.select(row.value); return NONE }
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

      if (view.dock.picker.source === 'collaboration') {
        collaborationAction(row)
        return NONE
      }

      if (view.dock.picker.source === 'task') return taskAction(row.value)

      if (view.dock.picker.source === 'config') {
        if (row.value === 'model') {
          // 共用 /model 设置入口；子会话里作用对象是这条子会话的成员。
          const member = currentMember(view)
          if (member === undefined) models.sessionScope()
          else models.target(member.agent.agentId)
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
        if (row.value === 'voice') {
          if (view.dock.kind === 'picker' && view.dock.picker.source === 'config') enterLayer()
          toggleVoiceInput()
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
          commit(appendReceipt(closePicker(view), `已切到 ${nameOfSession(row.value)}`))
          return NONE
        }

        turn = { kind: 'open', label: row.label }
        send({ type: 'session.open', session: row.value })
        commit(closePicker(view))
        return NONE
      }

      if (view.dock.picker.source === 'paths-info') { popLayer(); return NONE }
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
      commit(noteResult(view, '这一句只有一处技能引用——补上要它做什么，再回车发送。'))
      return NONE
    }

    if (text.startsWith('/compact ') || text.trim() === '/compact') {
      if (view.sessionId === null) { commit(noteResult(view, '还没有会话可压缩；未建立新会话，命令保留。')); return NONE }
      if (!connected) { commit(noteResult(view, '连接已断开；命令保留，重连后先查询原请求。')); return NONE }
      const previous = [...compactDrafts].find(([, one]) => one.session === view.sessionId && one.text === text)
      if (previous) { send({ type: 'compact.query', session: previous[1].session, requestId: previous[0] }); return NONE }
      const requestId = crypto.randomUUID(), session = view.sessionId, focus = text.slice('/compact '.length).trim()
      compactDrafts.set(requestId, { session, text, refs: placed, caret: view.caret })
      commit({ ...view, compactions: [...view.compactions, { session, state: { requestId, focus, state: 'unknown' } }], flash: '正在提交本次压缩请求…' })
      send({ type: 'compact.request', session, requestId, ...(focus ? { focus } : {}) })
      return NONE
    }
    if (text.trim() === '/status' && text.startsWith('/status ') && view.compactions.some(one => one.session === view.sessionId)) {
      draft({ ...view, draft: '', refs: [], caret: 0, completion: null })
      showCompactions(); return NONE
    }

    if (text.startsWith('/memory ') || text.trim() === '/memory') {
      if (text.trim() !== '/memory') { commit(noteResult(view, '用法：/memory ')); return NONE }
      rememberInput(text, placed)
      draft({ ...view, draft: '', caret: 0, refs: [], completion: null })
      memory.open(); return NONE
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

      // 「命令名 ＋ 空格」是带参数的写法；草稿**恰好等于命令名**时回车也执行（U134）——
      // 原先 /ps、/connect 靠各自的特例分支才能裸执行，其余命令裸回车会被当正文发出去。
      if (COMMANDS.some(command => text.startsWith(command.name + ' ') || text.trim() === command.name)) {
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
            'skills.list': 'skills.catalog', 'mcp.list': 'mcp.catalog', 'mcp.reconnect': 'mcp.catalog',
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

    /**
     * **断线时先问连接、再动界面**：需要引擎的命令不在本地留下半开的页面或等待态——
     * 直接回一句说明、**草稿保留**（`submit` 见最后一行是回执就把草稿还原）。
     *
     * 判据取**这条命令要发的那些命令**是否都在 `offlineCommands` 里，而不是「断没断」：
     * 设置模式下 `mcp.list` 也由入口直接答，`/config` 因此照常可用；普通模式断线时它要等
     * 一份不会来的答复，才该拦。纯壳命令（`/help`、`/status`、`/exit`）不在表里。
     */
    const needs: readonly Command['type'][] = word === '/clear' ? ['session.new']
      : word === '/ps' ? ['collaboration.read', 'background.list']
        : word === '/resume' ? ['session.list']
          : word === '/rename' ? ['session.rename']
            : word === '/skills' ? ['skills.list']
              : word === '/config' ? ['model.list', 'mcp.list', 'web.list']
                : word === '/mcp' ? ['mcp.list']
                  : []
    const offline = (): { next: ShellView; commands: readonly Command[]; leaving: boolean } =>
      only(appendReceipt(cleared, `Engine 未连接，${word} 需要连接后使用；草稿保留`))
    if (!connected && needs.length > 0 && !needs.every(type => transport.offlineCommands?.includes(type) === true)) return offline()

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
      return only(openPicker(cleared, { source: 'collaboration', title: '整件工作', tabs: workTabs('collaboration'), rows: [], selected: 0, hint: '正在读取 · Tab/Shift+Tab 切换 · Esc 返回' }), { type: 'collaboration.read' }, { type: 'background.list' })
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
      if (from.dock.kind !== 'picker' || from.dock.picker.source !== 'model') {
        models.clearTarget()
        // 子会话里这个入口只改该成员；入口会话仍是当前工作。
        const member = currentMember(from)
        if (member === undefined) models.sessionScope()
        else models.target(member.agent.agentId)
      }

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
    // 子会话不占顶层：退出时给主会话的恢复命令，恢复后由协作视图再进来。
    exitNote: () => view.sessionId === null || view.archived ? null
      : `恢复此会话：\n${resumeCommandOf(currentMember(view) === undefined ? view.sessionId : view.collaboration!.originSession)}`,

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
