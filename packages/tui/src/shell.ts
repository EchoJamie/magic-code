/**
 * 外壳 · 会话壳（缺陷轮 II 重画）——**只认控制面**。
 *
 * 一件：把注入的 `ControlTransport`（外壳侧一端，装配注入）接成「事件 → 视图 ＋ 键 → 命令」
 * 的一条线。**键位语义全在这层**（`key()` 收一个按键、改视图、必要时发命令）——
 * 组件只把 Ink 的键喂进来、把模型画出来。好处：接管 / 草稿 / 选择器这些规矩**不起终端就能测**。
 *
 * 四条纪律（原型 · 交互逻辑）：
 * ① **先接订阅、后放开输入**（构造即订阅）；
 * ② **slash 两种走法**——纯输出型（`/help` · `/status`）：输出进记录区、**命令本身不回显**；
 *    交互配置型（`/resume` · `/model` · `/grants`）：**记录区什么都不进**，只在左下开选择器，
 *    选定后留**一行回执**，`esc` 取消＝**不留痕迹**；
 * ③ **接管**（裁决挂着）——看得见（占位换掉）· 草稿不丢（收起来、答完归还、**不自动发送**）·
 *    **不静默吞键**（只认 y/a/n ＋ 全局 ctrl+c，其余忽略但当场说一句；粘贴一律拒）；
 * ④ **重建**（缺陷 D1）——`session.history` 分块收、收齐了按块重建记录区（**收拢**）。
 */

import { apiKeyEnvVarOf } from '@magic/contracts'
import type {
  Command,
  ControlTransport,
  Entry,
  EventKind,
  KernelEvent,
  ModelInfo,
  ModelRef,
  VendorInfo,
  VendorRegion,
  ReasoningSetting,
  RunNotice,
  SessionId,
  SkillCatalogRow,
  StopPhase,
  StopScope,
} from '@magic/contracts'
import {
  COMMANDS,
  HINT_BOOTING,
  HINT_COMPLETION,
  HINT_IDLE,
  HINT_WORKING,
  MAX_CANDIDATES,
  activeWordOf,
  appendEcho,
  appendOutput,
  appendPageNote,
  appendReceipt,
  closePicker,
  createView,
  matchCommands,
  movePicker,
  openPicker,
  pathHint,
  ATTACH_ACTION,
  EXPORT_ACTION,
  attachmentDetailRows,
  attachmentHint,
  attachmentRows,
  pathRows,
  resolveSkill,
  sessionHint,
  // **配置一览（U71）**——四行怎么铺、筛词怎么说、第 4 项那一屏报什么，都在 `view.ts` 一处
  // （这一层只管开屏 / 重铺 / 选定之后进哪儿）
  CONFIG_PATHS_TITLE,
  configHint,
  configPathLines,
  configRows,
  grantsHint,
  grantsRows,
  hasPlan,
  mcpHint,
  mcpRows,
  mcpToolRows,
  modelHint,
  modelRows,
  reasoningHint,
  reasoningRows,
  sessionRows,
  applyResume,
  inActiveSection,
  runDetail,
  runSummary,
  skillHint,
  skillRows,
  authLabelOf,
  cacheLabelOf,
  modelDetailRows,
  regionRows,
  vendorRows,
  closePrompt,
  dayLabel,
  manageMetaOf,
  openPrompt,
  picked,
  rebuild,
  noticeReceiptOf,
  reduce,
  STOP_KEYS_HINT,
  stopReceiptOf,
  withBanner,
  withContextWindow,
  // **运行事实收尾状态行那一格**（U54）——构造与推来那两跳都走它（见 `withRunFacts`）
  withRunFacts,
} from './view.ts'
import type { Dock, ModelScope, PageTurn, PickerRow, SessionScope } from './view.ts'
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
  shiftedRefs,
  stepLeftOver,
  stepRightOver,
  wire,
} from './components/inline.ts'
import type { DraftRef } from './components/inline.ts'
import type { PromptState, ShellView } from './view.ts'
import type { AttachmentRow, RecordId, RunRow, RunSnapshot } from '@magic/contracts'
import { leftSpan, rightSpan, stepRight } from './components/composer.ts'
import { isPrintable, tokenLabel, usageLabel } from './components/lines.ts'

/** 外壳认得的按键——组件把 Ink 的 `(input, key)` 收窄成这个（多出来的都算 `other`）。 */
export type ShellKey =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'enter' }
  /** `shift+回车`——**换行**（原型 · 键盘：`回车` 发送 · `shift+回车` 换行）。 */
  | { readonly kind: 'newline' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'backspace' }
  /** 光标键（U31）——插入点左右挪一个**字素**（中文 / emoji 不切坏）。 */
  | { readonly kind: 'left' }
  | { readonly kind: 'right' }
  /** `delete`（前向删除）——删插入点**右边**那一个字素。 */
  | { readonly kind: 'delete' }
  | { readonly kind: 'escape' }
  | { readonly kind: 'up' }
  | { readonly kind: 'down' }
  | { readonly kind: 'ctrl+c' }
  | { readonly kind: 'ctrl+o' }
  /**
   * **`Ctrl T`**——收起/展开当前清单（U34）。
   *
   * 设计 · 任务推进：「`Ctrl T` 保留主动收起/展开当前清单的能力，默认仍为展开，
   * 不成为看计划的必经步骤」。**只改本地视图**——不发模型请求、不动草稿与引用、
   * 不动插入点、也不动输入历史（故它走 `commit` 而不是 `edit`：后者会把翻历史那一格归位）。
   */
  | { readonly kind: 'ctrl+t' }
  /**
   * **`Ctrl X`**——停**选中的那一条运行**（U50 · **整体**那一档）。
   *
   * 由头（设计 · 会话与运行管理）：「会话/成员详情选择停止」（**按明确选择的整体或局部
   * 范围编排**）。会话列表就是「详情」入口，故两个范围各有一个键——**这一条是整体**：
   * 收这条运行的全部资源（在途 ＋ 自有进程组），执行者随后退出。
   */
  | { readonly kind: 'ctrl+x' }
  /**
   * **`Ctrl W`**——**只停这一轮**（U50 · **局部**那一档）。
   *
   * 与上一条分开是有由头的：设计把「中断这一轮」与「停这件事」当两件事写（一个是局部
   * 原语，一个要「全部相关成员及递归分发」），且明写「**不能把局部成功显示为整体成功**」
   * ——两个范围共用一个键，用户就没法表达他要哪一个。
   */
  | { readonly kind: 'ctrl+w' }
  /**
   * **清单翻页**——把行视口挪到第 `top` 行（U34）。
   *
   * ⚠️ **收的是「到哪一行」而不是「翻几行」**：一页 ＝ 屏上放得下的那几行，而**列数、
   * 终端高度、交互区的高度账只有渲染那一层有**。故目标位置由渲染层按手里那一窗算好
   * （`plan.ts` 的 `planScrolled`：夹在两头之间），外壳只存不猜——同一条「拿不到的不编」。
   */
  | { readonly kind: 'planTop'; readonly top: number }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'other'; readonly label: string }

/**
 * 「再按一次」那道门**开着多久**（毫秒 · U68）。
 *
 * 到点就**撤掉那一行、同时取消那次监听**——此后再按是**新的一次**（重新挂上），
 * 不是「接着上一次」。
 *
 * ⚠️ **一秒**（2026-09-25 用户真跑之后从 1.5 秒缩到 1 秒）——设计那一节写的时限
 * 随之改成 1 秒。它是**那一刻回执**：一次按下的确认，一秒足够看清。
 *
 * ⚠️ **它为什么该有时限**（U68 推翻了 U46 的「不加时限」）：按三分类——
 * **配置不回显 · 状态可常驻 · 刚发生的事 ⇒ 那一刻回执**——「你按了一次 Ctrl+C」是
 * **刚发生的事**，那就该是**那一刻回执**（过一会儿自己撤），不是常驻一格。
 * 原先那条理由（「加了就是『按了没反应』的变体」）**把归类的错当成了交互的错**：
 * 加时限不是「没反应」，是「回执该有的样子」。
 */
export const EXIT_ARM_MS = 1_000

/** 按键的结果——`exit` 由组件去真退出（外壳不碰终端）。 */
export type ShellEffect = { readonly exit: boolean }

const NONE: ShellEffect = { exit: false }
const EXIT: ShellEffect = { exit: true }

export type Shell = {
  /** 当前视图（引用稳定——只在事件 / 按键之后才换对象）。 */
  getView(): ShellView
  /** 订阅视图变化（React 的 `useSyncExternalStore` 直接吃它）。 */
  subscribe(listener: () => void): () => void
  /** 一个按键。 */
  key(key: ShellKey): ShellEffect
  /**
   * **终端那头没人了**（断流 / 关窗信号）——同一条收尾语义，但**不设「按两次」那道门**
   * （那是键盘那条路上的确认；此刻对面已经没人在按了）。
   *
   * 空闲＝当场放行 · 工作中／有待答＝替我们发中断。由头见 `shell.ts` 里那一处的注。
   */
  hangUp(): ShellEffect
  /**
   * **放开输入**——`boot` 跑完那一下（技术方案 · 装配视图第 5 步：「以 `boot` 完成为界」）。
   *
   * 这一跳之前：打字照旧进草稿（本地的事），**回车不受理**（当场说一句，草稿留着），
   * 发给内核的命令一律丢弃。之所以要有这道闸——`boot` 里的恢复**要发事件**，而
   * 恢复没跑完就提交，等于让循环与恢复抢同一条记录流（对话域会当场抛）。
   */
  releaseInput(): void
  /** 主动读一次历史（开局接续 / 恢复之后调——重建记录区）。 */
  readHistory(session?: SessionId): void
  /** 收摊——退订传输、清订阅者。 */
  dispose(): void
}

/** `/help` 的正文（纯输出型）——**从命令表出**（一处权威：候选与帮助不会分叉）。 */
const HELP_TITLE = '可用命令'
const HELP_LINES: readonly string[] = COMMANDS.map(
  (command) => `${command.name}　${command.summary}`,
)

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

/**
 * 一次「等内核回话再开选择器」的意图——`/resume` · `/model` · `/grants` · `/skills` 各一种。
 *
 * ⚠️ **`'config'` 是唯一一个等三份答复的**（见 `configPending`）：那一屏的四行里三行的
 * 当前值各有自己的读侧命令，缺一份那一格就只能写「还没问到」。
 */
type PendingPicker =
  | 'session'
  | 'model'
  | 'grants'
  | 'skills'
  | 'mcp'
  | 'connect'
  | 'manage'
  | 'attachments'
  | 'config'
  /**
   * **等「取网页用的模型」那一次保存的回话**（U78）——与 `'model'` 分开：那一样是等
   * 一屏新读数（回去铺列表），这一样是等**一次动作的结果**（收起抽屉、留一行回执）。
   */
  | 'webFetchSave'

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
]


/**
 * 一次**本地小输入**（U41）——问一件小事、收一行字（改名 / 密钥那一类）。
 *
 * 与草稿那份输入的分野（见 `Dock` 里 `prompt` 那一支）：那一路提交出去的是**交代**，
 * 这一路是**一次设置**——不进记录、不给模型看、不进输入历史。
 */
type Ask = {
  /** 问的是什么——一行标签（密钥那一路会自动补上「输入不回显」）。 */
  readonly label: string
  /** 隐藏输入（密钥）：屏上只见圆点，真值只在壳里。 */
  readonly secret: boolean
  /** 初始值（改名时给现名；密钥一律空串）。 */
  readonly value: string
  readonly caret: number
  /** 空着时那一行的占位（一句实话）。 */
  readonly placeholder: string
  /** 底下那行补充说明（可省）。 */
  readonly note?: string
  /** 回车时**要发什么**——`null` ＝ 什么都不发（只是收起来）。 */
  readonly submit: (value: string) => Command | null
}

/**
 * **一屏**——`←` 弹回来要照原样摆回去的那一份（U61）。
 *
 * 设计 · 终端交互：「**选择器是「层」，一套栈管所有**」——`←` 弹一层、弹到空就收起、
 * `esc` 一律全收。⚠️ **栈的单位是「那一屏」，不是「那个选择器」**：接入那一路是
 * 「选供应商 → 选区域 → 问密钥」，**选择器与本地小输入交替**，它们都是层。
 *
 * 装的就是「把这一屏重新摆出来」所需的全部：
 * - `dock`——这一屏本身（行、选中、筛词、锚点都在 `Picker` 里；`prompt` 那一支在下面另说）；
 * - `manageAt` / `detailAt` / `attachmentAt`——**明细那一屏的主语**。它们住在壳里而不在
 *   视图里（同 `Dock` 那条由头：拿不到的不编、结构不从字面反推），故弹回来时得一起还；
 * - `asking`——本地小输入**问的是什么**。⚠️ 与视图里那一份（圆点）不同，这一份带着
 *   用户敲进去的**真值**（密钥也走它）——它只在壳手上，弹回来还给壳。
 */
type Layer = {
  readonly dock: Dock
  readonly manageAt: string
  readonly detailAt: ModelRef
  readonly attachmentAt: RecordId | null
  readonly asking: Ask | null
}

/** 建壳的入参（都可省——省了＝按「拿不到」办）。 */
export type ShellOptions = {
  /**
   * **上下文窗总量**（U20 · 差距 5）——状态行 ④ 的**开机那一格**分母（`12.4k/200k`）。
   *
   * 装配把**当下那一条的**数递进来（`Assembly.contextWindow`：配置声明或内置表，
   * 见 `resolveContextWindow`）；拿不到／没声明就不给 ⇒ `null` ⇒ 屏上只报已用量
   * ——不编、不猜、不改事件契约（见 `withContextWindow`）。
   *
   * ⚠️ 只管**开机那一刻**：外壳那时还不知道模型名。此后的分母归**事件**
   * （`model.switched` / `model.call.start` 各自带着那一刻的有效输入预算，U41 返修）。
   */
  readonly contextWindow?: number | null | undefined
  /**
   * **本进程的工作区**（U26）——`/resume` 那一屏据它认「哪个是别的项目」
   * （分组头永远都有；**压暗**只落在判得实的那些：工作区记着、且与这一组不同）。
   *
   * 装配把执行域的 `roots()` 递进来（`realpath` 后的规范形 · 声明序）——与记录域
   * 构造时交出去的是**同一个值**：一头锚进记录、一头用于认路，两处同源。
   *
   * **不给＝不知道自己在哪儿** ⇒ 一组都不压暗（「拿不到的不编」——同 `contextWindow`）。
   */
  readonly workspaceRoots?: readonly string[] | undefined
  /**
   * **数据目录**（U71 · `/config` 第 4 项那一格）——配置 `dataDir` 的落点，**已解析的绝对路径**。
   *
   * 为什么要从外面递：它是**启动那一刻定下的**（配置 ＋ `MAGIC_HOME`），没有任何一条读侧
   * 命令答得出来——而窗口这一侧本来就「读配置只为呈现」（见 `packages/app/src/run/terminal.ts`
   * 那张表）。**不给＝那一格空着**（「拿不到的不编」，同 `contextWindow` / `workspaceRoots`）。
   */
  readonly dataDir?: string | undefined
  /**
   * **系统家目录**（U71）——**只用来把屏上的路径缩成 `~/…`**（`/config` 那一行右边还摆着
   * 别的字，一长串 `/Users/<谁>/…` 会把值那一格撑满）。
   *
   * **不给＝照原样写绝对路径**（缩不了就不缩，不编一个家目录出来）。
   */
  readonly home?: string | undefined
  /**
   * **受理输入了没有**——缺省 `true`（不设闸）。
   *
   * 「放开输入」以 `boot` **完成为界**（技术方案 · 装配视图第 5 步 · U25 收敛）：
   * 起真外壳时先给 `false`，`boot` 跑完再 `releaseInput()`。不设闸的调用方
   * （不跑 `boot` 的测试 / 演示）照旧一挂载就能提交。
   */
  readonly inputReady?: boolean | undefined
  /**
   * **启动那几句要说的话**（U22 · 审计第 13 条）——开局进记录区，一行回执。
   *
   * 由头：解析从严（读不懂的规则 / 授权**不生效**）原先**只有 `--check` 会说**，
   * 走 TUI 这条路时**一声不响**。装配把话备好（`Assembly.notices`），外壳只负责说。
   *
   * ⚠️ **等记录区重建完再贴**（见 `accumulate`）——开盘那一下 `readHistory` 会把
   * 屏上痕迹连同这几行一起换掉（`rebuild` 只回会话内容）。不补这一手，回执在真外壳上
   * **一句都留不下**（`run.ts` 的次序正是「boot → 放开输入 → 读历史」）。
   */
  readonly receipts?: readonly string[] | undefined
  /**
   * **运行事实的来路**（U49）——「谁在跑、什么状态」由管理者**推**来（不必问）。
   *
   * 为什么走一条**独立于事件**的路：它是**服务状态**（管理者手上的事实），不是内核事件
   * ——内核一个字都不背运行管理（设计 · 本机执行结构）。混进事件面就是拿内核的语言
   * 说管理面的话，两边迟早各说一套。
   *
   * **不给**（用例 / 演示）⇒ 那一屏照旧只有目录，一行状态都不标——「拿不到的不编」。
   */
  readonly runs?: RunFeed | undefined
  /**
   * **接回快照的来路**（U49）——挂到某一代上之后，管理者取来那一代的「此刻」。
   *
   * **不给** ⇒ 接回那一手不做（照旧只铺记录里的历史）。
   */
  readonly resumed?: ResumeFeed | undefined
  /**
   * **这一趟开局就接的那条会话**（`--session <id>`）——只作开屏那张摘要的排除项
   * （设计：摘要说的是**其他**活跃工作，而这条正是用户为它来的）。
   */
  readonly openingSession?: string | undefined
  /**
   * **停一条运行**（U50）——整体（`run`）或局部（`turn`），**由用户明确选择**。
   *
   * 由外层转给本机管理者（窗口这一侧不做判断：谁是管理者、那一代还在不在，都不归它知道）。
   * **不给**（用例 / 演示）⇒ 那一屏的停止键收起（按下去只落一句「这儿停不了」）。
   */
  readonly stop?: ((session: SessionId, scope: StopScope) => void) | undefined
  /**
   * **停止走到了哪一拍**（U50）——受理 / 已核销 / 没能证实，各落一行回执。
   *
   * 报的是**结构化**的（哪一条、哪一档、哪一拍），**话由这一层拼**——因为那句话要带上
   * 会话的标题，而标题只有这一层手上有（目录在这儿）。
   */
  readonly stopped?: ((listener: (report: StopReport) => void) => void) | undefined
  /**
   * **管理者说的一句给人看的话**（U50 接上）——代次过期、它要收摊、那一代收摊了……
   *
   * ⚠️ 这一条**原先是断的**（U48 起了线、U49 没用上）：管理者说了话，屏上一行都没有。
   * 停止那条路正要靠它（「没切到」「起不了执行者」那几句都在这一条上）。
   */
  readonly lines?: ((listener: (text: string) => void) => void) | undefined
  /**
   * **刚刚发生了一件事**（U50）——完成 / 失败 / 需要你，三类之外没有（见 `RunNotice`）。
   *
   * 与 `stopped` 分开：那一条是**用户自己按的**那一下的回执，这一条是**他没看着的时候**
   * 发生的事——两件事的读者心情都不一样（一个在等结果，一个刚回来）。
   */
  readonly notices?: ((listener: (notice: RunNotice) => void) => void) | undefined
}

/**
 * **停止走到了哪一拍**（U50）——与 `@magic/app` 那一侧同形（那边是产出方）。
 *
 * 契约里没有它：它是**管理者 ↔ 外壳**之间的运行管理读数，不是内核的语言（同 `RunRow`）。
 * 两处各写一个形状会分叉，故这一份是**照抄那边那条消息**的最小形（字段一字不差）。
 */
export type StopReport = {
  readonly session: SessionId
  readonly scope: StopScope
  readonly phase: StopPhase
  readonly note?: string
}

/**
 * **运行事实的来路**（U49）——当下那一份 ＋ 变化时的通知。
 *
 * 两件都要：`current()` 给「现在就打开列表」那一刻的读数（不等下一次变化），
 * `subscribe` 给此后的变化。
 */
export type RunFeed = {
  readonly current: () => readonly RunRow[]
  readonly subscribe: (listener: (rows: readonly RunRow[]) => void) => void
}

/** **接回快照的来路**（U49）——`gen` 是这份快照出自哪一代（诊断与配对用）。 */
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
 * 草稿上还剩下多少**不是引用**的文字（去掉引用那几段之后）。
 *
 * 它答一个问题：这一条按得下去吗。设计：「正文或附件任一非空即可提交」——
 * 而**只有引用、一个字都没有**的那一份不算交代（「/review」自己不是一个任务）。
 * U33 时这条判据写作 `body === ''`（剥掉斜杠词之后）；U36 起引用留在正文里，
 * 故按**引用的位置**把那几段挖掉，剩下的才是「用户要说的话」。
 */
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

/**
 * **这一条按得下去吗**——设计：「正文或附件任一非空即可提交」。
 *
 * 三条：
 * - **有正文**（去掉引用之后还有别的话）⇒ 发；
 * - **只有文件 / 目录引用** ⇒ 也发——那正是「读这份材料」这件事本身（设计明写：纯附件也能提交）；
 * - **只有技能引用**（或句首一个还没成引用的 `/名称`）⇒ **不发**：技能说的是「怎么做」，
 *   它不指一个对象。一条只有「按这个做法」而没有「做什么」的交代，内核那边落下的会是一条
 *   「用户什么都没说、但带了份材料」的条目——那不是交代（U33 那条判据的延续）。
 */
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

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport, options: ShellOptions = {}): Shell {
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
  let view = withBanner(withContextWindow(createView(), options.contextWindow ?? null))

  /**
   * **启动那几句**（见 `ShellOptions.receipts`）——开局先贴一遍，**重建之后再补一遍**。
   *
   * 两份是必要的：不先贴，没跑 `readHistory` 的调用方（测试 / 演示）永远看不到；
   * 不在重建后补，真外壳上那几行会被 `rebuild` 换掉（它只回会话内容）。
   * 补一次就够（`startupSaid`）——此后再换会话就不重复念叨了。
   */
  const startup: readonly string[] = options.receipts ?? []
  let startupSaid = false
  if (startup.length > 0) view = startup.reduce((acc, text) => appendReceipt(acc, text), view)

  /**
   * 运行事实（U49）——接上那一份当下读数；此后由管理者推着走（下面那一段订阅）。
   *
   * ⚠️ **与「启动那几句」不同**：它**不进记录区**（不是回执），只是视图里的一格——
   * 列表每次现读它。摘要那一行才落记录（而且只落一次，见下）。
   */
  view = withRunFacts(view, options.runs?.current() ?? [])

  // **开屏那张摘要**（U49 · 设计：「首页仅在**确有其他活跃工作**时出现一次摘要，例如
  // 『2 项执行中 · 1 项需要你』，指向列表，**不反复刷屏**」）。
  //
  // 三处分寸都在这一跳上：
  // - **一次**——它是一条回执（落进记录区、此后随页面走），不是状态行那种常驻读数；
  // - **确有**——一条活跃的都没有就一个字都不说（空白开一条新的时屏上不该多一行）；
  // - **其他**——这一趟开局就接的那条会话（`--session`）不算「别的活跃工作」：
  //   用户正是为它来的。
  {
    const summary = runSummary(view.runs, options.openingSession)
    if (summary !== undefined) view = appendReceipt(view, summary)
  }

  let disposed = false
  /** 「放开输入」了没有——`boot` 完成那一下翻真（见 `Shell.releaseInput`）。 */
  let ready = !booting
  // 启动中：右位说清楚「为什么回车没反应」（不然就是「按了没反应」——最难查的那种）
  if (booting) view = { ...view, status: { ...view.status, hint: HINT_BOOTING } }

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
  type HistoryEntry = { readonly text: string; readonly refs: readonly DraftRef[] }
  const history: HistoryEntry[] = []
  /** 翻到第几条（`-1` ＝**没在翻**，输入行里是用户自己那份草稿）。 */
  let historyAt = -1

  /**
   * **开始浏览前收着的那份原稿**（正文 ＋ 引用 ＋ 插入点）——设计：「开始浏览前保存完整草稿
   * （正文、技能、附件、光标/选区），**从最新历史按下返回原稿**」。
   *
   * `null` ＝ 没在翻（或翻的时候草稿本来就空着）。往回翻到最新那一条再按一下 `↓` 就还给它；
   * 用户一动草稿（打字 / 退格 / 粘贴 / `esc`）就不要了——那时**屏上这一份**才是他的原稿。
   */
  let browsing: { readonly text: string; readonly refs: readonly DraftRef[]; readonly caret: number } | null =
    null

  /** 两条历史是不是同一份（连着提交两次一模一样的不重复记）。 */
  const sameEntry = (left: HistoryEntry, right: HistoryEntry): boolean =>
    left.text === right.text &&
    left.refs.length === right.refs.length &&
    left.refs.every((ref, index) => {
      const other = right.refs[index]
      return (
        other !== undefined &&
        ref.start === other.start &&
        ref.end === other.end &&
        ref.source === other.source &&
        ref.kind === other.kind
      )
    })

  /** 重建的攒块——按 `session.history` 的 `data.session` 分（不是当下那条的直接丢）。 */
  let rebuildFor: SessionId | null = null
  let rebuildEntries: Entry[] = []

  /** 等回话的选择器意图（`/resume` / `/model` / `/grants` / `/skills` 各问一次）。 */
  let waiting: PendingPicker | null = null

  /**
   * **`/config` 还在等几份读数**（U71）——`0` ＝ 没在等。
   *
   * 由头：那一屏四行里有三行的「当前值」**各有自己的读侧命令**（连接一览 · 授权名录 ·
   * 外部工具一屏）。要「不进去就知道现在是什么」，就得**先问全再开屏**——少问一份，
   * 那一格就只能写「还没问到」，而这一屏存在的全部理由正是**竖着扫一眼就看全**。
   *
   * ⚠️ **三份一起问、齐了才开**（不是来一份开一次）：先开再补的话，用户会看见那一格
   * 从空到有地自己变一次——而「它现在是什么」这个问题，屏上不该有第二个答案。
   * 三份都是便宜的本机读数（读注册表 / 读授权文件 / 读内存里的连接状态）。
   */
  let configPending = 0

  /**
   * **这一屏正在筛的词**（U71）——同 `/resume` 的 `sessionQuery`：只留在这一屏，
   * **不写进草稿**（它不是用户那句交代的一部分，与 `@` 那一段不同，见 `Picker.anchor`）。
   *
   * 开一屏就是一屏新的（`openConfigPicker` 里清零）：筛词是「我这一次找哪一项」的临时状态，
   * 不是一条该被记住的偏好。
   */
  let configQuery = ''

  /**
   * **一次换页动作发出去了、还在等答复**（U44）——`/clear` 或 `/resume` 选定某条。`null` ＝ 没在等。
   *
   * `kind` 说的是**这一跳是哪一种**（U45 · `PageTurn`）——它决定**这一页带不带字标**：
   * `'new'`（`/clear`＝开一条新的）**印**、`'open'`（`/resume`＝翻回已有的一页）**不印**。
   * `label` 是回执要带的名字：`/resume` 那条是**那一条的名字**，`/clear` 一个字都不说，
   * 故为 `null`。
   *
   * 它管两件（都按**真实结果**办，见 `onEvent` 里那一支）：
   * - **这一页要不要翻、翻成哪一副面孔**——归约据它把 `null → 头一条` 也算成换页，
   *   并按 `kind` 决定种不种字标（由头见 `reduceSessionState`）；
   * - **要不要说一句**——`/resume` 说 `· 已切到 <名字>`；`/clear` **一个字都不说**
   *   （回执就是清屏本身，设计 · 命令行与配置）。
   *
   * 与 `waiting` 分开：那个管的是「答复到了开哪一扇抽屉」，这个管的是这一跳的收场。
   * 也**只认自己发出去的那一条**——外来的 `session.state`（别的面开了会话）不该跟着翻页。
   *
   * ⚠️ **回执从「选定那一刻」挪到「答复到了」**（U44）：翻页把可见屏清掉——**在这一跳
   * 之前**留的那行字会被一并推进 scrollback，新那一页的界上就**没有它**了。挪到答复这一侧，
   * 它才是**新页自己的**头一行；顺带也就按真实结果说话（内核忙时切不动，那时不该说「已切到」）。
   */
  let turn: { readonly kind: PageTurn; readonly label: string | null } | null = null

  /**
   * **一次等着答复的动作意图**（U41）——`provider.save` 之后的回话到了要接着做的那件事
   * （「确认后保存连接并获取列表」：保存完顺手去取一次模型列表）。
   *
   * 为什么需要它：契约把「保存 / 移除的结果」定成**回话**（`provider.catalog` 带 `note`），
   * 而不是命令上的返回值——而外壳要按**这一次动作**决定下一步。认不回是哪一次就不接。
   */
  let awaiting: 'connect' | 'edit' | null = null

  /**
   * **管理明细正说着哪一条连接**（U41）——空串＝没在明细那一屏。
   *
   * 由 `submit` 进那一屏时写下、由重铺那一处读它：明细是「**某一条连接**的一屏」，
   * 而这一位就是「哪一条」——同 `/mcp <名字>` 的 `mcpServer`（不靠行内容反推）。
   */
  let manageAt = ''

  /** **详情那一屏正说着哪一条模型**（U41）——与 `manageAt` 同一条由头（明细得有主语）。 */
  let detailAt: ModelRef = { provider: '', model: '' }

  /**
   * **模型那一屏这一次是替谁挑**（U78）——`session` ＝「当前会话走谁」（`/model` 那一趟，
   * 选一条就切过去）；`webFetch` ＝「取网页用哪个模型」（`/config` 那一行进来的那一趟，
   * 选一条是**写配置**）。
   *
   * ⚠️ **这一位必须存在，不能拿行文案或来源反推**（同 `manageAt` / `detailAt` 那条由头）：
   * 两趟开的是**同一扇抽屉**（`source: 'model'`），行也是同一个函数铺的——差别只在
   * 「怎么读当前那一条」「那行说明怎么说」「回车之后干什么」这三处，而它们都归这一位管。
   *
   * 由 `submit` 进那一屏之前写下（`/config` 那一行写 `webFetch`、`/model` 那一支写回
   * `session`），此后由重铺那一处读它——**出那一屏就把它还原**（`session` 是常态）。
   */
  let modelScope: ModelScope = 'session'

  /**
   * 「此刻的当前那一条」——**按作用对象取**（U78）：会话那一趟取 `view.modelCurrent`，
   * 取网页那一趟取 `view.webFetch`（`null` ＝ 还没配，那一屏一行都不标「现在配的是它」）。
   *
   * 两处都用这**一个**函数：列表标「当前」与 `selected` 落在谁头上必须是同一份读数
   * （各取一套的话，屏上标着 A、光标却落在 B 上）。
   */
  const scopeCurrent = (): ModelRef | null =>
    modelScope === 'webFetch' ? view.webFetch : view.modelCurrent

  /**
   * 本会话里用户**亲手选过**的思考设置——按「连接 ＋ 模型」那一对记着（U41）。
   *
   * 由头：思考设置是**当前选择的一部分**（`model.switch` 的 `reasoning`），而「设为默认」
   * 也接受它。可外壳手上没有「此刻的思考设置」这份读数（契约的 `current` 只给两件）。
   * 这一格记的是**外壳自己那一下动作**（用户在这台壳上选过什么），不是从别处推的——
   * 换了模型就不带过去（设计明文：不把原模型的档位或预算盲目带过另一个模型）。
   */
  let chosenReasoning: {
    readonly provider: string
    readonly model: string
    readonly setting: ReasoningSetting
  } | null = null

  /** 这一条此刻的思考设置（**用户在这台壳上选过的才算**——没选过就是「没设过」）。 */
  const reasoningOf = (pick: ModelRef): ReasoningSetting | undefined =>
    chosenReasoning !== null &&
    chosenReasoning.provider === pick.provider &&
    chosenReasoning.model === pick.model
      ? chosenReasoning.setting
      : undefined

  /**
   * **正在问的一件小事**（U41）——改名 / 密钥那一类，`null` ＝ 没在问。
   *
   * ⚠️ **值存在这里、不在视图里**（见 `PromptState` 的注）：密钥进不了视图对象，
   * 也就进不了渲染、取帧与快照；`submit` 那一格是外壳自己按用途给的（一次设置要发什么命令）。
   */
  let asking: Ask | null = null

  /**
   * **屏的栈**（U61）——`←` 弹一层弹的就是它；**栈底是输入行本身**（不在这个数组里，
   * 「弹到空」就是弹到它＝收起，与 `esc` 同效）。
   *
   * 三处口径（缺一处就是两套交互）：
   * - **进一层**就在那一跳 `enterLayer()`：打开选择器 · `→` 看详情 · 接入那种
   *   「一步接一步」的每一屏（**含本地小输入**——那是本单最容易做窄的地方）；
   * - **回输入行就清空**（`commit` 那一处收口）：屏都收起来了，栈里那几屏便没有主语
   *   （再弹出来就是把一屏**早撤下的**东西硬摆回去）；
   * - **`esc` 不走这里**——它一贯「一律全收」（收起这一屏，栈随上面那条清掉），
   *   与 `←` 井水不犯河水（设计：两个动作、两个键，不混）。
   */
  let layers: readonly Layer[] = []

  /** 此刻这一屏——收进栈里的那一份（见 `Layer`）。 */
  const layerNow = (): Layer => ({
    dock: view.dock,
    manageAt,
    detailAt,
    attachmentAt,
    asking,
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
    manageAt = layer.manageAt
    detailAt = layer.detailAt
    attachmentAt = layer.attachmentAt
    asking = layer.asking

    if (layer.dock.kind === 'picker') {
      commit(openPicker(view, layer.dock.picker))
      return
    }
    if (layer.dock.kind === 'prompt' && layer.asking !== null) {
      commit(openPrompt(view, promptViewOf(layer.asking)))
    }
  }

  /**
   * 收起此刻这一屏、回输入行——**`esc` 那一支与「`←` 弹到空」共用这一处**。
   *
   * ⚠️ 设计写的是「弹到空就收起（**与 `esc` 同效**）」——同效就得**真同效**：`esc` 在这
   * 几屏上本来就不只是「把抽屉关掉」，故那两件收尾的事一并放这儿：
   * - `@` 那一栏另把「还只是查询、没成引用」的那一段从草稿里撤回（设计：「取消归还原稿
   *   及选区」——那一段本来就不算用户说的话）；
   * - 图片详情那一屏收起来时把主语放下（「这一屏在说哪一张」不跨屏留着，同 `manageAt`）。
   */
  const collapseDock = (): void => {
    if (view.dock.kind === 'picker') {
      const anchor = view.dock.picker.source === 'paths' ? view.dock.picker.anchor : undefined
      if (view.dock.picker.source === 'attachment-detail') attachmentAt = null
      commit(closePicker(view))
      if (anchor !== undefined) eraseAt(anchor.start, anchor.end)
      return
    }
    if (view.dock.kind === 'prompt') closeAsk()
  }

  /**
   * **`←` 弹一层**——有上一层就摆回去，弹到空便收起（与 `esc` 同效）。
   *
   * ⚠️ **不与输入打架**（设计明文）：「选择器开着时归选择器（那时光标不在输入行）；
   * 没开时照旧移光标」——`←` 这一支只在**接管屏**（选择器 / 本地小输入）上收，
   * 草稿那一头照旧由 `case 'left'` 移插入点。与 `↑↓` 同一分工。
   */
  const popLayer = (): void => {
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

  /**
   * `/skills <词>` 的**预置筛词**——只在「等技能目录」那一趟有效（答复到了交给抽屉）。
   *
   * （U57 时它还有第二个来路：「同名直达分不出唯一」那一支也拿技能名当筛词开同一扇抽屉。
   * 同名在发现那一层只剩一条之后，那一支没了，这一格只剩 `/skills <词>` 一处用。）
   */
  let skillSeed = ''

  /**
   * **详情那一屏正说着哪一张图**（U37）——那条记录的 id；`null` ＝ 没在详情那一屏。
   *
   * 与 `manageAt` / `detailAt` 同一条由头：**明细得有主语**。而这一位尤其要紧——
   * 「查看原图」要按它去问内核要那一条记录里的字节；拿行内容反推（比如再去名字里找）
   * 就撞上「同名两张图」那道墙（同一张名字送两次是常事）。
   */
  let attachmentAt: RecordId | null = null

  /**
   * **`/exit` 正等着哪一条会话停下来**（U52）——`null` ＝ 没在等。
   *
   * 认的是**两样都对上**（会话 ＋ 整体那一档）：正等着的时候，别的窗口停的、或者同一
   * 会话的局部那一档（`turn`）的报告不该把我放走——放早了就是「资源还没确认退出，
   * 界面已经没了」，正是设计那句「不是发出去就走」要防的。
   *
   * 放行之后**当场清空**（`null`）：一条会话只放行一次，此后别的报告与这一趟无关。
   */
  let exitWait: SessionId | null = null

  /**
   * **`/exit` 敲在「这条会话还没认出来」的时候**（U52）——把意图挂上，等活跃位一到再办。
   *
   * 撞见它的窗口（真 PTY 上量到）：窗口刚开张、**首条消息正跑着**的那几百毫秒里，
   * 外壳手上还没有会话 id——`session.state`（活跃位那一条）还没到。而 `/exit` 要停的正是
   * 「当前这条会话」：认不出是哪一条就停不了。
   *
   * ⚠️ **此刻不能降级成「只离开」**（那正是这一单要补的那个缺：工作中退出＝真停），
   * 也不猜一条（猜错就是停错了别人的运行）。故只挂一个「等」——那一声答复一到，
   * 照常停、停了再走（见 `onEvent` 里 `session.state` 那一支的收尾）。
   *
   * 它**不带时限**：等的是「这一轮正在跑」这个事实所依附的那一条会话，而那一轮还在跑，
   * 那一份事实就一定会到。真要半路不想走了，`ctrl+c` 两下仍是「只离开」那扇门。
   */
  let exitWaitsForSession = false

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
    readonly text: string
    readonly refs: readonly DraftRef[]
  } | null = null

  /**
   * **这一段输入里图片的名字表**（U62）——**内容身份 → 编号**（`Image#N` 那个 `N`）。
   *
   * 三条都写在这一处：
   * - **身份是内容**（字节的 sha256），不是名字、也不是路径——图不一定来自文件
   *   （剪贴板来的就没有文件），拿文件名当身份，同名不同内容的两张就分不开；
   * - **一段输入内**：所以它是一段草稿的表，交出去（`sendInput` 清稿）就重置——
   *   下一段输入从 `Image#1` 重新数；
   * - **同一份内容恒是同一个名字**：同一张图引用两次得到同一个号（不然模型以为那是两张），
   *   两张不同的图得到两个号。
   *
   * ⚠️ **编号不回收**：把 `Image#1` 那一处删掉之后，再来一张新图拿的是**下一个号**，
   * 不是 1。回收会撞上「用户已经在正文里写了『看 Image#1』」那件事——名字是给人和模型
   * **指认**用的，改一个已经说出口的名字比多号一个更坏。
   */
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
    const next = ready ? input : { ...input, status: { ...input.status, hint: HINT_BOOTING } }
    // **回了输入行 ⇒ 屏的栈清空**（U61）——栈里装的是「还在底下的那几屏」，而屏全收起来
    // 之后它们已经没有主语了。这是**唯一的收口**（视图的每一处改动都经这里），
    // 故 `esc` 那条路不必另写一句：它收起屏、dock 一回到 `input`，栈自然跟着空。
    if (next.dock.kind === 'input') layers = []
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

  /**
   * 草稿变了 ⇒ **重算候选**（D12：打 `/` 即出、边打边筛）。
   * 一个口子管全部改草稿的地方——省得每处各刷一次（迟早漏一处）。
   *
   * **技能名也在候选里**（U33）：目录取自视图里那一份最近问回来的
   * （`skills.catalog` 的答复——问的时机见 `askSkills` 与 `/skills`）。没问过就是空数组：
   * 候选里少几条技能名而已，内置那五条照旧 ✓（拿不到的不编，也不因此挡路）。
   */
  const withCompletion = (next: ShellView): ShellView => {
    if (next.dock.kind !== 'input') return { ...next, completion: null }

    // 候选按**插入点正打着的那个斜杠词**筛（U36：`/<名称>` 在任何词边界都唤起候选——
    // 「先读 @需求.md，再按 /review」里的 `/review` 正是在句中被选进来的）。
    // 内置命令只在这一词位于草稿最前时才列（它们是整行的操作入口，不写在句子中间）。
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
    if (from.status.state === 'working') return HINT_WORKING
    if (from.status.state === 'retrying') return from.status.hint

    return HINT_IDLE
  }

  /** 改草稿的统一入口。 */
  const draft = (next: ShellView): void => commit(withCompletion(next))

  /**
   * **人改草稿**的统一入口（打字 / 退格 / 粘贴 / 换行 / `esc` 清）——比 `draft()` 多一件事：
   * **把翻历史的游标归位**。
   *
   * 由头（U20 · 差距 4）：`↑` 翻出一条旧话之后接着改它，再按 `↑` 应当**从末尾重新翻**
   * （改过的那条不是历史里的那一条了）。不归位的话游标停在历史中间，
   * 再按 `↑` 只会往回退一格——甚至顶到头上什么都不动（「按了没反应」）。
   * `recallHistory` 自己要设游标，故它走 `draft()`，不走这里。
   */
  const edit = (next: ShellView): void => {
    historyAt = -1
    // 人一动草稿，**屏上这一份**就是他的原稿了——先前收着的那份不要了（再翻 `↑` 时重收）
    browsing = null
    // **动过草稿就不再认领那一份**（U33）——「失败不覆盖用户后来编辑的新稿」全在这一行：
    // 认领（`restoreDraft`）只在「交出去之后一个字都没动」时才发生。提交那一跳不走这里
    // （它清草稿走的是 `draft`），故刚交出去的那一份还认领得回来。
    lastSubmit = null
    draft(next)
    askSkills(next)
  }

  /**
   * **技能名问一次**（每个壳一次）——草稿一成了 `/` 开头的，就问一遍目录（U33）。
   *
   * 问来的那一份就是输入行候选的取材（见 `withCompletion`）：`/ui` 能筛出 `/ui-review`
   * 全靠它。时机取「打 `/` 那一下」而不是「外壳一造好就问」——这样问的时机与用它的时机
   * 是同一件事（也就没有「开屏白扫一遍目录树，整场没人打斜杠」）。
   *
   * ⚠️ **放开输入之前不问**（`ready`）：那会儿命令进不去内核（`send` 直接丢），
   * 而标记一置上就再没有第二次——候选里会一直少着技能名那几条。故等 `ready` 再说，
   * 那一刻草稿还在（打字本来就不受闸），下一次按字补问。
   */
  const askSkills = (from: ShellView): void => {
    if (skillsAsked || !ready) return
    // 插入点正打着一个**斜杠词**就问——不限于句首（U36：`/<名称>` 在任何词边界都唤起候选，
    // 句中那个 `/review` 正是要从候选里选进来的那一个）。
    const word = activeWordOf(from.draft, from.caret)?.word
    if (word === undefined || !word.startsWith('/')) return

    skillsAsked = true
    send({ type: 'skills.list' })
  }

  /**
   * 插入点（U31）——**唯一的「光标在哪」**：草稿里的一个下标。
   *
   * 读的时候一律夹回 `[0, 草稿长]`：手搭出来的视图（用例 / 标本）可能只给了草稿、
   * 没给插入点（那是 0），夹一道就总有个定义。
   */
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
    transport.send(command)
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
    if (disposed) return

    if (event.kind === 'session.history') {
      accumulate(event.data)
      return
    }

    const before = view.sessionId
    // 流式增量按帧合批；其余一律当场（判据见 `STREAMING` 的注）
    //
    // ⚠️ `turn` **只在这一声答复是换页那一跳时**给（`turn` 是刚发出去、还没收场的那一次）：
    //    它管两格——「`null → 头一条` 也算换页」（由头见 `reduceSessionState`）与
    //    **这一页带不带字标**（U45：`'new'` 印 / `'open'` 不印）。
    //    给宽了，「问一次目录」开出来的空壳会话也会把屏翻掉。
    commit(reduce(view, event, { turn: turn?.kind ?? null }), STREAMING.has(event.kind))

    // **`/config` 那三份读数**（U71）——三份都到齐了才开屏（由头见 `configPending` 那段注）。
    //
    // ⚠️ **不 `return`**：下面那几支各有自己的一点活（授权文件读不懂那句、重连回执那一句
    // 都挂在各自那一支上），这一跳只管**开屏**——它不该把别人的话吞掉。
    // ⚠️ **排在 `reduce` 之后**：开屏要的那三格刚由 `reduce` 落进视图。
    if (waiting === 'config' && CONFIG_READINGS.some((one) => one.event === event.kind)) {
      configPending -= 1
      if (configPending <= 0) {
        waiting = null
        openConfigPicker()
      }
    }

    if (event.kind === 'session.state') {
      // 换了会话 ⇒ 记录区已清空（`reduce` 里做）＋ 主动读一次历史（D1：换一条＝换一屏）
      if (before !== null && before !== event.data.active) readHistory(event.data.active)
      if (waiting === 'session') {
        waiting = null
        openSessionPicker()
      }

      // **内核有话要说**（U44）——`note` 这一格原先**没有出口**：忙时挡回的那条路
      //（`BUSY_NOTE`：正在跑一轮，切不动）屏上零输出，用户按下去像按在空气上。
      // 照既有回执的形制落一行（不新造块）。
      //
      // ⚠️ **有话说就不再说「已切到」**：`note` 到了＝这一跳**没成**（活跃位没动），
      // 那时再补一句「已切到」就是自己打自己（下面那一支据此让位）。
      if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))

      // 换页那一跳的收场 ⇒ **按真实结果**留一行回执（`/clear` 一个字都不留）。
      //
      // ⚠️ **在答复这一侧发、不在选定那一侧发**（U44 改；由头见 `turn` 那段注）：
      // 翻页在**页号一变**的那一瞬就把可见屏清了（渲染层干的，见 `components/app.ts`），
      // 选定那一刻留的字会被推走。判据是「活跃位换没换」这一格——与上面 `readHistory`
      // 同一把尺子。
      //
      // ⚠️ **走 `appendPageNote` 而不是 `appendReceipt`**（U44）：这一行是**新那一页的界**
      // ——`/resume` 翻回的那一页不印字标（U45），顶上那行就是它。故它得与字标同一格：
      // `rebuild` 随后铺历史时**要把它留在最前面**（`pageHeaderOf` 按 key 认它），
      // 不然头一行记录会被 `<Static>` 的游标跳过（那一页凭空少一行）。
      //（`/clear` 那一路 `kind` 是 `'new'`、`label` 是 `null` ⇒ 走不进来：那一页的界是字标。）
      if (turn !== null) {
        const label = turn.label
        turn = null
        if (label !== null && event.data.note === undefined && before !== event.data.active) {
          commit(appendPageNote(view, `已切到 ${label}`))
        }
      }

      // **`/exit` 正等着「这条会话是哪一条」**（U52）——活跃位一到，接着把它停掉
      // （见 `exitWaitsForSession` 那一格的注）。**只在这一声答复真把活跃位带出来时**才办：
      // `note` 到了＝这一跳没成（活跃位没动），那不算认出来了。
      if (exitWaitsForSession && view.sessionId !== null && event.data.note === undefined) {
        exitWaitsForSession = false
        stopForExit(view.sessionId)
      }
    }

    // **那一道闸跟着它等的那一轮走**（U52）——这一轮收场了、会话 id 始终没来 ⇒ 已经没有
    // 可停的东西了，照「真·空手开机」办：直接走。
    //
    // ⚠️ **不带这一条，那道闸就是个会活过头的东西**：用户不再等它（敲了别的、又回来做了
    // 点别的）时，它会在**下一次**活跃位到达时把一条**他不打算停的**会话停掉。带上它之后
    // 这道闸只在「那一轮还在跑」期间有效——而那一轮在跑时，这一屏**切不动会话**
    // （忙时 `/resume` / `/clear` 被内核挡回），故它等的那一条只可能是它原来那一条。
    if (exitWaitsForSession && event.kind === 'turn.end' && view.sessionId === null) {
      exitWaitsForSession = false
      commit({ ...view, leaving: true })
    }

    // 连接一览回来了 ⇒ 两件（U41）：
    // ① **正等着开抽屉**（`/model` 那条路）：开；0 行时 `openPicker` 会把说明落成一行回执；
    // ② **抽屉已经开着**（`/model refresh` 那一路，或刷新回来的第二屏）：**就地重铺**
    //    ——设计：「刷新只更新信息，**不抢走列表当前焦点**、不清草稿、不写回默认」。
    //    故重铺要保住当前选中那一行（`refreshModelPicker` 里做），且**不关抽屉**。
    if (event.kind === 'model.catalog') {
      if (waiting === 'webFetchSave') {
        // **「取网页用的模型」保存的回话**（U78）——那一屏在回车上就收了（见 `submit`），
        // 这里只留一行回执：装配在 `note` 里说清「成了是存了哪一对 / 没成是为什么」。
        //
        // ⚠️ **它不改会话的模型**：这一位是那一件工具用谁（设计 · 网页与搜索那条
        //    「两处不能混」）——故这里不碰状态行、也不动 `view.modelCurrent`
        //    （两者都来自答复里各自的格子，`reduce` 那一处已经落地了）。
        waiting = null
        modelScope = 'session'
        if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
      } else if (waiting === 'model') {
        waiting = null
        openModelPicker(event.data.note ?? '')
      } else {
        // 两处都试：各自只认自己那一扇开着（刷新模型那一屏 / 管理那两屏上刚发起的「刷新这一条」）
        refreshModelPicker(event.data.note ?? '')
        refreshManagePicker()
      }
    }

    // 连接一览 / 保存回话回来了（U41）——三路分得开，按**在等什么**判（不认字面）：
    // ① 正等「接入」的第一步 ⇒ 开「挑一家」那一屏；
    // ② 正等「管理」 ⇒ 开连接一览那一屏；
    // ③ 都不是 ⇒ 这是**保存 / 移除之后的回话**：留一行回执（有话说时）、照新一览重铺，
    //    而接入那一路还接着办一件收尾的事——**保存成功就去取一次模型列表**
    //    （设计：「确认后保存连接并获取列表」）。
    if (event.kind === 'provider.catalog') {
      // ⚠️ **这一跳是「打开选择器」＝进一层**（U61）：`enterLayer()` 只在**底下那一屏还在**
      //    时才压栈——从入口行点进来时它把 `/model` 那张列表压住（`←` 退得回去），
      //    从命令行打进来时底下就是输入行，它什么都不做（`←` 那一下便是收起）。
      if (waiting === 'connect') {
        waiting = null
        enterLayer()
        openVendorPicker()
      } else if (waiting === 'manage') {
        waiting = null
        enterLayer()
        openManagePicker(event.data.note ?? '')
      } else {
        if (event.data.note !== undefined) commit(appendReceipt(view, event.data.note))
        refreshManagePicker()
        if (awaiting === 'connect') {
          awaiting = null
          waiting = 'model'
          send({ type: 'model.list' })
        }
      }
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

    // 选定那一条认出来了（U62）⇒ **是图就把那一处改写成 `Image#N`**（见 `identifyPicked`）。
    if (event.kind === 'paths.identified') identifyPicked(event.data)

    // 提交**没收下** ⇒ 按原 pairing 键认下那一份草稿（U33）。回执那半行由 `reduce` 落
    // （「没送出：…」），这里只管草稿那几件——正文 · 插入点 · 它里面的引用。
    // ⚠️ **不还回输入行的那一种也要走这一趟**：配对键得收掉，不然那一份永远等着认领的
    // 稿子会在用户改完草稿再回来时被认错（见 `settleDraft`）。
    if (event.kind === 'input.settled' && !event.data.ok) {
      settleDraft(event.data.ref, event.data.keepDraft !== false)
    }
    /**
     * **首条交代开张之后，把目录取回来一次**（U50）。
     *
     * 由头：会话是**首条消息**那一刻才建的，而目录（`session.state` 带的 `sessions`）
     * 只在**会话命令**那几支上发——于是这条新会话的**标题**在窗口这一侧一直缺席，直到
     * 下一次 `/resume`。而通知那几行回执要拿标题说话（「「<标题>」那一轮跑完了」），
     * 缺席就只剩一个 id——那是**内部东西漏到屏上**，最不该有的一种漏。
     *
     * ⚠️ **不是每一条交代都问**：只在「这一条是新开张的」时候值得（`ok:true` 且目录里
     * 还没有它）——不然每发一句就多一趟往返，而那一趟什么新东西都没带回来。
     */
    if (event.kind === 'input.settled' && event.data.ok && event.session !== '') {
      if (!view.catalog.some((one) => one.id === event.session)) send({ type: 'session.list' })
    }

    // 送过的图片一屏回来了（U37）——两只分得开，按**在等什么**判（不认字面）：
    // ① 正等「送过的图片」（`/attachments` 那条路）⇒ 开抽屉；
    // ② 不是 ⇒ 那是**导出那一下的回话**：留一行回执（「导到哪儿了 / 为什么没成」）。
    //    ⚠️ 回执**不跟着抽屉走**（同 `grants.catalog` 那条）：导出那一屏照旧开着，
    //    用户接着还能按「加入本次输入」——两件事互不耽误。
    if (event.kind === 'attachments.catalog') {
      if (waiting === 'attachments') {
        waiting = null
        openAttachments()
      } else if (event.data.note !== undefined) {
        commit(appendReceipt(view, event.data.note))
      }
    }

    // 授权名录回来了 ⇒ 开抽屉（`/grants` 那条路）／**撤销之后刷新它 ＋ 留一行回执**。
    // 两处分得开：`waiting` 只在「刚问过」时为真；撤销那次是抽屉**已经开着**。
    if (event.kind === 'grants.catalog') {
      if (waiting === 'grants') {
        waiting = null
        openGrantsPicker(view.grants)
      } else {
        // 选定即撤的后半句：**照着新名录重铺**（撤掉那条就没了），
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
  }

  const accumulate = (data: Extract<KernelEvent, { kind: 'session.history' }>['data']): void => {
    if (view.sessionId !== null && data.session !== view.sessionId) return // 切走之后的尾巴——丢

    if (rebuildFor !== data.session) {
      rebuildFor = data.session
      rebuildEntries = []
    }

    rebuildEntries = [...rebuildEntries, ...data.entries]
    if (!data.done) return

    let next = rebuild(view, rebuildEntries)

    // 启动那几句**补一回**——`rebuild` 只回会话内容，屏上痕迹（含开局那几行回执）
    // 会被它换掉；不补就真的一句都留不下（见 `ShellOptions.receipts`）
    if (!startupSaid && startup.length > 0) {
      startupSaid = true
      next = startup.reduce((acc, text) => appendReceipt(acc, text), next)
    }

    commit(next)
    rebuildFor = null
    rebuildEntries = []
    // **接回来的那一段画在历史之后**（U49）——早一步画会被这一跳的 `rebuild` 抹掉
    drawResumed()
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  /**
   * **接回的那一份快照**（U49）——**先收着，等记录区铺完再画**。
   *
   * 两件在次序上咬着的：① 快照说的是「此刻」——比记录里任何一条都新，故它必须画在
   * 历史**之后**（不然会被 `rebuild` 一并抹去）；② 而历史是**随后**一趟才回来的
   * （`session.open` → `session.state` → `history.read` → `session.history`）。
   * 故它到这儿先进暂存格，`accumulate` 那一跳铺完历史立刻叫我（`drawResumed`）。
   *
   * ⚠️ **没人叫就自己画**（`resumed` 一到而当时并没有重建在跑）——那种情形下没有
   * 「等」的理由：它就是一个当场要画的东西。
   */
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
    commit(applyResume(view, snapshot))
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

  /**
   * **`/resume` 那一屏自己的两格**（U49）——筛选（当前工作区 / 全部）与搜索词。
   *
   * 它们**只活在这一屏开着的时候**（收起即重置）：那是「我这一次要找哪一条」的临时状态，
   * 不是一条该被记住的偏好——下次打开时用户要的是全貌（而全貌里第一条正是「需要你」）。
   */
  let sessionScope: SessionScope = 'all'
  let sessionQuery = ''

  /** 那一屏的行（**一处算**——开、筛、运行事实变了这三条路都走它）。 */
  const sessionPickerRows = (): readonly PickerRow[] =>
    sessionRows({
      catalog: view.catalog,
      active: view.sessionId,
      here: options.workspaceRoots,
      runs: view.runs,
      scope: sessionScope,
      query: sessionQuery,
    })

  /**
   * 抽屉下方那一行说明（U49）——**选中那一条的执行详情**（设计：「长信息放选中详情」
   * 与「执行详情给当前动作、开始时间、最近一次可确认进展与输出」）。
   *
   * 没有运行事实的那一条（历史里从没在这一次运行里跑过的会话）**不编详情**，
   * 退回既有的那句话（「这儿是哪儿」/ 空态）。
   */
  const sessionPickerHint = (rows: readonly PickerRow[]): string | undefined => {
    const selected = rows[view.dock.kind === 'picker' ? view.dock.picker.selected : 0]
    const run = selected === undefined ? undefined : view.runs.find((one) => one.session === selected.value)
    // 两件**各说各的**，故都在：筛的是什么（筛词）与**这一屏收窄到哪儿**（范围）。
    // 只说一半的话，用户看着一张短表不知道另一半去哪了（收窄的那一条最常见）
    const head = [
      sessionQuery === '' ? '' : `筛选「${sessionQuery}」`,
      sessionScope === 'here' ? '只看本工作区' : '',
    ]
      .filter((piece) => piece !== '')
      .join(' · ')

    if (run !== undefined) {
      // 活跃那一段里，状态与动作都已经在「组头 ＋ 副文案」上了——详情只补别处没说过的
      const detail = runDetail(run, Date.now(), { inActiveSection: inActiveSection(run.state) })
      // **这一条真能停**才报停止那两个键（U50 · 低频操作按需出现）：报在详情这一行，
      // 不挤状态行右位（那一行放不下就整段不出现，见 `STOP_KEYS_HINT` 的注）
      const actions = inActiveSection(run.state) ? STOP_KEYS_HINT : ''
      return [head, detail, actions].filter((piece) => piece !== '').join(' · ')
    }

    // 空态优先（「还没有会话」比「这儿是哪儿」更该先知道）；否则本工作区一条都没有时
    // 报一句「这儿是哪儿」——整表皆暗时那是唯一说得通的话（U27）
    const tail =
      rows.length === 0
        ? '还没有落过账的会话——交代一句就开张'
        : sessionHint(view.catalog, options.workspaceRoots)

    const said = [head, tail].filter((piece) => piece !== undefined && piece !== '').join(' · ')
    // **一句都没有就不给这一格**（`undefined`，不是空串）：空串会照样占一行
    // ——屏上凭空多一条空白（真帧上量出来的）
    return said === '' ? undefined : said
  }

  /**
   * **停选中的那一条**（U50）——`ctrl+x` ＝ 整体（这条运行）· `ctrl+w` ＝ 局部（这一轮）。
   *
   * 设计那句「会话/成员详情选择停止」在这里落成两个键：**范围由用户明确选择**，而这一层
   * 只做两件——把选的是哪一条读出来、把它交出去。**一个判断都不做**：那条运行是死是活、
   * 该不该核销、收没收到，全归本机管理者（它手上才有那一摊的运行事实）。
   *
   * 回执**不在这里落**（那是 `options.stopped` 的事）：按下的这一刻还什么都不知道，
   * 当场说一句「已停止」正是设计要防的那种谎话（「资源确认退出后才报已停止」）。
   */
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

  /**
   * **这条会话在目录里叫什么**（U50）——回执那一行要带上标题。
   *
   * ⚠️ **认不得就不拿 id 顶**：会话 id 是内部的一半（UUID），把它印到屏上是最坏的一种
   * 「实现细节漏出去」。认不得就说**用户视角的那一句**（「你这条会话」/「另一条会话」）
   * ——少一点信息，但一个字都不编。
   */
  const nameOfSession = (session: SessionId): string =>
    view.catalog.find((one) => one.id === session)?.title ??
    (session === view.sessionId ? '你这条会话' : '另一条会话')

  /** `/resume`——目录已到手，开它（行：活跃在前、再按工作区分组，见 `sessionRows`）。 */
  const openSessionPicker = (): void => {
    // **开一屏就是一屏新的**：筛词与范围从零起（它们是「我这一次要找哪一条」的临时状态，
    // 不是一条该被记住的偏好——下次打开时用户要的是全貌，而全貌第一条正是「需要你」）
    sessionScope = 'all'
    sessionQuery = ''

    const rows = sessionPickerRows()
    const hint = sessionPickerHint(rows)

    commit(
      openPicker(view, {
        source: 'session',
        // 选中项＝**当前那条**——分组之后行序变了，故在**分好组的行**里找它。
        // 一条都没有（筛没了 / 目录空）时落 0：`openPicker` 那一跳自己会判开不开。
        selected: Math.max(0, rows.findIndex((row) => row.value === view.sessionId)),
        rows,
        filter: sessionQuery,
        ...(hint === undefined ? {} : { hint }),
      }),
    )
  }

  /**
   * **这一屏开着的时候，行与详情就地重铺**（U49）——两处都调它：
   *
   * - **筛选 / 搜索**（用户刚敲了一个字）：行跟着变，**选中项尽量留在原来那一条上**
   *   （能留住就留住——用户是在找它）；
   * - **运行事实变了**（管理者推来新的一份）：状态与详情跟着变。⚠️ 这一条是那张表的
   *   用处所在——**列表开着不动，也能看见「它刚变成需要你了」**。
   */
  const refreshSessionPicker = (): void => {
    if (view.dock.kind !== 'picker' || view.dock.picker.source !== 'session') return

    const picker = view.dock.picker
    const rows = sessionPickerRows()
    // 一条都没有且**没在筛**时不开抽屉（P0：0 行的抽屉看着就是卡死）——收起它，照旧
    // 走「0 行不开抽屉」那条既有口径（`openPicker`）
    if (rows.length === 0 && sessionQuery === '') {
      commit(openPicker({ ...view, dock: { kind: 'input' } }, { ...picker, rows, filter: sessionQuery }))
      return
    }

    const keep = picker.rows[picker.selected]?.value
    const found = rows.findIndex((row) => row.value === keep)
    const hint = sessionPickerHint(rows)

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          source: 'session',
          rows,
          selected: found === -1 ? Math.min(picker.selected, Math.max(0, rows.length - 1)) : found,
          filter: sessionQuery,
          ...(hint === undefined ? {} : { hint }),
        },
      },
    })
  }

  // —— U49：运行事实与接回快照的订阅（**构造即接**，与技术方案 · 控制域同一条纪律）——

  /**
   * **运行事实变了**——落进视图，顺手把开着的那一屏就地重铺。
   *
   * 两件都要：视图那一格是**下一次**开列表时的取材；而列表**此刻开着**时，用户正看着
   * 它——「它刚变成需要你了」这件事得当场看得见（那正是这张表存在的理由）。
   */
  options.runs?.subscribe((rows) => {
    if (disposed) return
    // **收下那一份事实，顺手把状态行那一格收尾**（U54）——见 `withRunFacts`：那一格答的是
    // 「这条会话此刻在不在跑」，而**只有管理者说得出来**（停这个动作从它那一头发起，
    // 执行者退场之后没人再报 `turn.end`——外壳那一头于是没有下文，那一格就永远停在
    // 「● 工作中」，与回执那句「停了」在同一屏上打架）。
    commit(withRunFacts(view, rows))
    refreshSessionPicker()
  })

  // —— U50：停止那一族（回执 · 管理者说的话）——

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

    // **`/exit` 正等着这一条**（U52）——两拍终局都放行，中间那拍（`accepted`）不放：
    //
    // - `done`——**资源确认退出了**，这才是「等了再退」等的那个事实；
    // - `unconfirmed`——到点还没收完。**如实说过就放行**（上面那一行已经说了「没能停掉
    //   『X』」＋ 缘由）。不把用户卡在一个他明确说了要走的界面上：要只离开，另一扇门
    //   （Ctrl+C 两次）一直开着，而这一条该说的实话已经落进 scrollback 了。
    //
    // ⚠️ **`accepted` 那一拍绝不放行**——它只是「受理了」，此刻走出门就是「发出去就走」，
    //    正是设计那句话防的事。
    const go =
      exitWait !== null &&
      report.session === exitWait &&
      report.scope === 'run' &&
      (report.phase === 'done' || report.phase === 'unconfirmed')

    if (go) exitWait = null
    commit(go ? { ...said, leaving: true } : said)
  })

  /**
   * **管理者说了一句给人看的话**——落一行回执（U50 把这条线接上）。
   *
   * 由头：U48 就把这条线架起来了（`client.onLine`），可**屏上一行都没有**——管理者说的
   * 「这一代已经过去了」「起不了执行者」全落在空气里。停止那条路正要靠它。
   */
  options.lines?.((text) => {
    if (disposed) return
    commit(appendReceipt(view, text))
  })

  /**
   * **刚刚发生了一件事**（U50）——完成的 / 出错的 / 等你的，落一行回执。
   *
   * ⚠️ **三类之外一个都不来**（谁在什么时候说，判据在管理者那一头：设计「不持续播报
   * 『还在跑』」）；同一条事实也只来一次（跨窗口去重按那条事实的号）。
   */
  options.notices?.((notice) => {
    if (disposed) return
    const line = noticeReceiptOf(notice, nameOfSession(notice.session))
    // ⚠️ **没有那一句就不落行**（U74）：「跑完了」那一条**不再产出**——它不是「换了个
    // 落点」也不是「往后挪一挪」，是**不要了**（设计 · 会话与运行管理「通知」那一格）。
    // 其余两类照旧各落一行（`failed` / `needs-you` 一个字没动）。
    if (line === undefined) return
    commit(appendReceipt(view, line))
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

  /**
   * `/grants`（U22 · B13）——名录已到手，开抽屉：**与 `/resume` · `/model` 同位置同开合**
   * （左下，`esc` 收起**不留痕迹**）。
   *
   * 选中项从 0 起（每次开都从头）——授权是**要撤的东西**，不是「当前在哪条」，
   * 没有一条该被预先选中。
   */
  const openGrantsPicker = (catalog: ShellView['grants']): void => {
    // 名录没到手＝不该走到这儿（开抽屉那条路先问后开）；照防御性办：什么都不开
    if (catalog === null) return

    commit(
      openPicker(view, {
        source: 'grants',
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
    if (catalog === null || view.dock.kind !== 'picker') return

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

  /**
   * `/mcp`（U39）——一屏已到手，开抽屉：**与 `/grants` 同位置同开合**（左下，`esc` 收起
   * 不留痕迹）。
   *
   * `who` 空串＝**总览**（一台一台列，状态 ＋ 件数）；给了名字＝**那一台的明细**
   * （工具名 ＋ 状态，不可用的缘由与拒收的那些在下方那行说明里）。
   *
   * 0 行那两路（一台都没配 / 点了名却不在读数里）由 `openPicker` 按既有规矩办：
   * 那行说明落成记录区的一行回执，**不接管输入**。
   */
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

  // —— 配置一览（U71 · `/config`）——

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
    // 「取网页用的模型」那一格（U78）——与 `current` 同一个来处（`model.catalog`），
    // 但**各是各的**：那是当前会话走谁，这一位是那一件工具用谁（空着＝还没配）
    webFetch: view.webFetch,
    grants: view.grants,
    mcp: view.mcp,
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

  // —— 模型详情 / 思考设置（U41）——

  /** 这一条模型在手上的资料（缓存里那一条；`undefined` ＝ 缓存里没有它）。 */
  const infoOf = (pick: ModelRef): ModelInfo | undefined =>
    view.models
      .find((one) => one.provider === pick.provider)
      ?.cache?.snapshot?.models.find((one) => one.id === pick.model)

  /**
   * **模型详情那一屏**——两条动作（思考设置 / 设为默认），资料写在下方那行说明里。
   *
   * 资料那几行都是**手上有才报**（规格 / 描述 / 缓存时间）：拿不到的不编——
   * 与状态行 ④ 那条「分母拿不到就不显示」是同一条规矩。
   */
  const openModelDetail = (pick: ModelRef): void => {
    const entry = view.models.find((one) => one.provider === pick.provider)
    const info = infoOf(pick)
    const limits = info?.limits
    const spec =
      limits === undefined
        ? '规格：供应商没给'
        : `规格：${
            [
              limits.maxInputTokens === undefined ? null : `输入 ${tokenLabel(limits.maxInputTokens)}`,
              limits.maxOutputTokens === undefined ? null : `输出 ${tokenLabel(limits.maxOutputTokens)}`,
              limits.maxContextTokens === undefined ? null : `窗口 ${tokenLabel(limits.maxContextTokens)}`,
            ]
              .filter((one): one is string => one !== null)
              .join(' · ') || '供应商没给'
          }`

    const lines = [
      `${pick.model}　@ ${entry?.name ?? pick.provider}`,
      ...(info?.name === undefined ? [] : [`显示名 ${info.name}`]),
      ...(info?.description === undefined ? [] : [info.description]),
      spec,
      `缓存：${
        entry?.cache?.snapshot === undefined
          ? '还没取过这一条的模型列表'
          : `${dayLabel(entry.cache.snapshot.fetchedAt)} 取的`
      }`,
    ]

    detailAt = pick
    commit(
      openPicker(view, {
        source: 'model-detail',
        selected: 0,
        rows: modelDetailRows(),
        hint: lines.join('\n'),
      }),
    )
  }

  /** 思考那一屏——**行由能力描述长出来**（见 `reasoningRows`），说明照实说清它声明了什么。 */
  const openReasoningPicker = (pick: ModelRef): void => {
    const support = infoOf(pick)?.reasoning
    const rows = reasoningRows(support, reasoningOf(pick) ?? null)

    commit(
      openPicker(view, {
        source: 'model-reasoning',
        selected: Math.max(0, rows.findIndex((row) => row.current)),
        rows,
        hint: [reasoningHint(support), '回车＝把这一条用到当前模型上'].join('\n'),
      }),
    )
  }

  /**
   * 管理明细上那四件动作（U41）。
   *
   * 三处分寸：
   * - **改名 / 更新认证** 都借本地小输入那一屏（`openAsk`）——一件**一次设置**，
   *   不走草稿那条路（那条是给模型的交代）；
   * - **留空的分寸各不相同**（故各写各的说明）：新名字留空＝**取消**（空名字不是一个名字）；
   *   密钥留空＝**清除**（设计明文：「回到环境变量回退」）；
   * - **移除只发一条命令**：引用检查归内核（设计：「移除前列出默认/角色/活跃使用引用；
   *   有引用先替换或取消，不静默级联删除」）——它拒绝时把缘由写进回话的 `note`，
   *   外壳照印，不在这儿预判。
   */
  const manageAction = (value: string): void => {
    const entry = view.models.find((one) => one.provider === manageAt)
    if (entry === undefined) return

    if (value === 'rename') {
      const now = entry.name ?? entry.provider
      enterLayer() // 进「问新名字」那一屏（U61）——`←` 退回管理明细
      openAsk({
        label: '新名字',
        secret: false,
        value: now,
        caret: now.length,
        placeholder: '连接名',
        note: `连接 id 仍是「${entry.provider}」——改名不动引用`,
        submit: (name) => {
          const trimmed = name.trim()
          awaiting = 'edit' // 回话到了重铺这一屏（改名不动模型列表，故不去拉它）

          return trimmed === '' ? null : { type: 'provider.save', provider: entry.provider, name: trimmed }
        },
      })
      return
    }

    if (value === 'key') {
      enterLayer() // 进「问密钥」那一屏（U61）——`←` 退回管理明细
      openAsk({
        label: '密钥',
        secret: true,
        value: '',
        caret: 0,
        placeholder: '粘贴或输入新密钥',
        note: '回车＝换掉 · 留空＝清除（回到环境变量回退）',
        submit: (key) => {
          awaiting = 'edit'

          return { type: 'provider.save', provider: entry.provider, apiKey: key }
        },
      })
      return
    }

    if (value === 'address') {
      // **高级地址**（设计 · 命令行与配置：「通常不填 URL……**高级地址只在明确需要时编辑**」）
      // ——它此前没有落点，而「接一条自己那台兼容端点 / 受控端点」正需要它。
      // ⚠️ 地址是**接入范围**的一部分：改它＝这条连接换了地方（内核据此废弃旧缓存，
      //    「改变服务地址/认证范围须明确影响该连接」），故留空＝**回到官方地址**，不是「不改」。
      enterLayer() // 进「问地址」那一屏（U61）——`←` 退回管理明细
      openAsk({
        label: '高级地址',
        secret: false,
        value: entry.baseURL ?? '',
        caret: (entry.baseURL ?? '').length,
        placeholder: 'https://…（留空＝按官方地址）',
        note: '留空＝回到适配给的官方地址 · 改地址会作废这条连接的模型缓存',
        submit: (address) => {
          awaiting = 'edit'

          return { type: 'provider.save', provider: entry.provider, baseURL: address.trim() }
        },
      })
      return
    }

    if (value === 'refresh') {
      send({ type: 'model.refresh', provider: entry.provider })
      return
    }

    if (value === 'remove') {
      send({ type: 'provider.remove', provider: entry.provider })
    }
  }

  /**
   * **`/model` 末尾那几条入口行**（U41 返修）——与 slash 子命令**共用同一段动作**。
   *
   * 由头：`/model connect` 那几条子命令留着**兼容**（首验要求「已有子命令的兼容性不借此
   * 任意破坏」），而入口行才是正身；两处各写一套「点了之后干什么」，改一处漏一处。
   * 故入口行把词喂给**同一个 `runSlash`**——动作只有一处。
   */
  const modelAction = (value: string): ShellEffect => {
    const word =
      value === 'connect' ? '/model connect' : value === 'manage' ? '/model manage' : '/model refresh'
    const { next, commands } = runSlash(view, word)

    // ⚠️ **这一屏先不关**（U61）：这一跳只是**把命令发出去**，答复一到就接着开下一屏
    //    （挑一家 / 连接一览）——那一下才是「进一层」，压栈就发生在答复那一头
    //    （`provider.catalog` 那两处 `enterLayer()`）。关上再开的话，中间那一跳
    //    会把 dock 打回输入行，栈跟着被清（「回输入行就清空」那条）——列表就压不住了。
    //
    //    顺带也更好看：答复那几毫秒里屏上留的是**刚才那一屏**，而不是闪一下输入行。
    // ⚠️ **刷新那一条不受影响**：它回来照旧是**这一屏**（就棫重铺），答复那一头不压栈。
    commit(next)
    for (const command of commands) send(command)

    return NONE
  }

  // —— 管理连接（U41 · `/model manage`）——

  /** `/model manage` 的第一步：**连接一览**（同一份行，取材就是 `view.models`）。 */
  const openManagePicker = (note: string): void => {
    const rows = view.models.map((entry) => ({
      label: entry.name ?? entry.provider,
      meta: manageMetaOf(entry),
      current: false,

      value: entry.provider,
      oneLine: true,
    }))

    const lines = [
      rows.length === 0 ? '还没有接上任何供应商——/model connect 接一条' : '回车＝管理这一条',
      ...(note === '' ? [] : [note]),
    ]

    commit(openPicker(view, { source: 'provider', selected: 0, rows, hint: lines.join('\n') }))
  }

  /**
   * 管理第二步：**这一条能做那几件**（改名 / 更新认证 / 刷新 / 移除）。
   *
   * 连接自己的那几格（id · 供应商 · 区域 · 地址 · 模型 · 缓存）写在**下方那行说明**里——
   * 它们是**查阅**用的，不占候选格（一屏上的每一格都得影响用户的动作）。
   */
  const openManageDetail = (who: string): void => {
    const entry = view.models.find((one) => one.provider === who)
    if (entry === undefined) return // 一览里没有这一条＝不该走到这儿

    manageAt = who

    // 说明只放**行上没说过的**：连接 id（行上给的是**名字**，id 才是身份）与默认模型。
    // ⚠️ 缓存状态与地址**不在这儿重复**——「刷新这一条」「高级地址」那两行的副文案就是它们
    //（一屏上的每一格都得说别处没说的；这条第一版两处各报了一遍）。
    const lines = [`连接 ${entry.provider}`, `默认模型 ${entry.model ?? '还没选过'}`]

    commit(
      openPicker(view, {
        source: 'provider-detail',
        selected: 0,
        rows: [
          {
            label: '改名',
            meta: `现在是「${entry.name ?? entry.provider}」`,
            current: false,
            value: 'rename',
            oneLine: true,
          },
          { label: '更新认证', meta: authLabelOf(entry), current: false, value: 'key', oneLine: true },
          {
            label: '高级地址',
            // 写明了就报它；没写＝**按官方地址**（适配给的，不在这儿拼一份）
            meta: entry.baseURL ?? '按官方地址（适配给的）',
            current: false,
            value: 'address',
            oneLine: true,
          },
          {
            label: '刷新这一条',
            meta: cacheLabelOf(entry),
            current: false,
            value: 'refresh',
            oneLine: true,
          },
          {
            label: '移除这条连接',
            meta: '已发生的记录不随它删除',
            current: false,
            value: 'remove',
            oneLine: true,
          },
        ],
        hint: lines.join('\n'),
      }),
    )
  }

  /**
   * 保存 / 移除 / 刷新之后**照新的读面重铺**（抽屉还开着才动它，收起时就只留那一行回执）。
   *
   * 重铺哪一屏由**当下开着的那一扇**说了算（加上 `manageAt` 那位：管理明细是**某一条连接**的
   * 一屏）——不靠行内容反推（那要靠字面比较，改一句话就静默失配）。
   *
   * 连接**没了**（刚移除掉）就退回一览：明细说的是那一条，它不在了，这一屏就立不住。
   */
  const refreshManagePicker = (): void => {
    if (view.dock.kind !== 'picker') return

    if (view.dock.picker.source === 'provider') {
      openManagePicker('')
      return
    }

    if (view.dock.picker.source === 'provider-detail') {
      if (view.models.some((one) => one.provider === manageAt)) {
        openManageDetail(manageAt)
        return
      }

      // 这一条没了（刚移除掉）⇒ **把这一屏收起**，退回输入行——明细说的是那一条，
      // 它不在了，这一屏就没有主语了。⚠️ 不改成「开一张空的一览」：0 行的抽屉接管着
      // 输入却不给东西可点（打不了字、没得选，看着就是卡死——`openPicker` 那条 P0 的由来）
      commit(closePicker(view))
    }
  }

  // —— 本地小输入（U41）：改名 / 密钥那一类 ——
  //
  // 这一小段是**一切本地小输入的共用出口**：`openAsk` 接管输入行、`askKey` 认那几个编辑键、
  // 回车交给问的人那一格 `submit`（一次设置要发什么命令）、`esc` 收回**不留痕迹**。
  // 密钥那一路另有一条硬规矩：**值只在壳里**（视图拿到的是圆点，见 `PromptState` 的注）。

  /** 一次小输入要画的几格——密钥那一路在这儿换成圆点（真值不出去）。 */
  const promptViewOf = (ask: Ask): PromptState => {
    if (!ask.secret) {
      return {
        label: ask.label,
        display: ask.value,
        caret: ask.caret,
        placeholder: ask.placeholder,
        ...(ask.note === undefined ? {} : { note: ask.note }),
      }
    }

    return {
      // 「输入不回显」是**这一屏的事实**，写在标签上——用户得知道自己打的字为什么看不见
      label: `${ask.label}（输入不回显）`,
      display: '•'.repeat([...ask.value].length),
      // 圆点一字符一格：插入点按**码点**数，与画出来的那一串同尺
      caret: [...ask.value.slice(0, ask.caret)].length,
      placeholder: ask.placeholder,
      ...(ask.note === undefined ? {} : { note: ask.note }),
    }
  }

  /** 视图里那一份（派生：值在 `asking`，屏上那一份按它算出来）。 */
  const withAskView = (ask: Ask): ShellView => ({
    ...view,
    dock: { kind: 'prompt', prompt: promptViewOf(ask) },
  })

  const openAsk = (ask: Ask): void => {
    asking = ask
    commit(openPrompt(view, promptViewOf(ask)))
  }

  const closeAsk = (): void => {
    asking = null
    commit(closePrompt(view))
  }

  /** 编辑当前这一份小输入（值一变就重画——视图那一份是**派生**的，不另存）。 */
  const editAsk = (value: string, caret: number): void => {
    const held = asking
    if (held === null) return

    asking = { ...held, value, caret: Math.max(0, Math.min(caret, value.length)) }
    commit(withAskView(asking))
  }

  /**
   * 按下回车——**交回给问的人**：`submit` 给一条命令就发出去，给 `null` 就只是收起来。
   *
   * ⚠️ **先落地、后发命令**（那条老次序）：进程内传输是同步直连的，反过来的话这次
   * `commit` 拿的是发命令**之前**的快照，会把答复刚写进去的东西盖掉。
   */
  const submitAsk = (): ShellEffect => {
    const held = asking
    if (held === null) return NONE

    const command = held.submit(held.value)
    asking = null
    commit(closePrompt(view))
    if (command !== null) send(command)

    return NONE
  }

  /** 小输入那几键——只认**单行编辑**该认的那些（没有换行、没有历史、没有候选）。 */
  const askKey = (input: ShellKey): ShellEffect => {
    const held = asking
    if (held === null) return NONE

    switch (input.kind) {
      case 'char':
        if (!isPrintable(input.char)) return NONE
        editAsk(
          held.value.slice(0, held.caret) + input.char + held.value.slice(held.caret),
          held.caret + input.char.length,
        )
        return NONE

      case 'backspace': {
        const [from, to] = leftSpan(held.value, held.caret)
        if (from === to) return NONE
        editAsk(held.value.slice(0, from) + held.value.slice(to), from)
        return NONE
      }

      case 'delete': {
        const [from, to] = rightSpan(held.value, held.caret)
        if (from === to) return NONE
        editAsk(held.value.slice(0, from) + held.value.slice(to), from)
        return NONE
      }

      // ⚠️ **`←` 不在这一屏了**（U61）：接管屏里它一律是「弹一层」——归 `key()` 那道门
      //（在选择器 / 本地小输入上收口），到不了这里。`→` 照旧：它是**这一行字里**的移动，
      // 而这一屏没有「进一层」可言（同别的抽屉「没有详情就不报那个键」那条口径）。
      case 'right':
        editAsk(held.value, stepRight(held.value, held.caret))
        return NONE

      case 'paste': {
        // **单行**：控制字符（含换行、Tab）不收——粘一串**带尾换行**的密钥是常事，
        // 而那一个换行落进值里就是一条查不出来的错（屏上是圆点，看不出多了一格）
        const text = [...input.text].filter((char) => isPrintable(char)).join('')
        if (text === '') return NONE
        editAsk(
          held.value.slice(0, held.caret) + text + held.value.slice(held.caret),
          held.caret + text.length,
        )
        return NONE
      }

      case 'escape':
        closeAsk()
        return NONE

      case 'enter':
        return submitAsk()

      // 上下键 / Tab / 换行在这一屏没有活——**什么都不做**（不当正文，也不装作有别的用法）
      default:
        return NONE
    }
  }

  // —— 接入供应商（U41 · `/model connect`）——

  /**
   * **取一个还没被占的连接 id**——拿供应商名打底，撞了就加序号。
   *
   * 为什么要这一步：契约的 `provider.save`「在**已有 id** 上给 ＝ 改那一条」——同一个 id
   * 再存一次是**改写**，不是新建。故接新连接之前先算一个空的（一览在手上：`view.models`）。
   */
  const freeIdOf = (vendor: string): string => {
    const taken = new Set(view.models.map((entry) => entry.provider))
    if (!taken.has(vendor)) return vendor

    for (let at = 2; ; at += 1) {
      const next = `${vendor}-${at}`
      if (!taken.has(next)) return next
    }
  }

  /**
   * 接入第一步：**挑一家**——名单来自调用线的查询出口（`provider.catalog` 答复里那一格），
   * **壳里不留一份**（工单：「官方信息由适配统一提供，不能让界面维护第二份表」）。
   *
   * 取不到那一格时（本分支现在正是这样：那一笔依赖调用线的 `vendors.ts` 与装配接线，
   * 落不到这里）**如实说一句**——0 行的抽屉接管着输入却不给东西可点，那是死胡同
   * （`openPicker` 那条 P0）。
   */
  const openVendorPicker = (): void => {
    commit(
      openPicker(view, {
        source: 'vendor',
        selected: 0,
        rows: vendorRows(view.vendors),
        hint: '接上之后就能从它的接口取模型列表——不用逐个型号登记',
      }),
    )
  }

  /**
   * 接入第二步（**只在真有得选时才开**）：**挑官方区域**。
   *
   * 一家只有一个区域时不问——那一步没有选择可言（「一屏上的每一格，问它影响用户的
   * 哪个动作」）。区域与地址都来自适配（`VendorRegion`），界面只显示、不拼。
   */
  const openRegionPicker = (vendor: VendorInfo): void => {
    commit(
      openPicker(view, {
        source: 'region',
        // 落在**缺省**那一项上（约定：`regions[0]` 是缺省）
        selected: 0,
        rows: regionRows(vendor),
        hint: `${vendor.label}：选一个官方区域（地址由适配给出，通常不必自己填）`,
      }),
    )
  }

  /**
   * 接入第二步：**问密钥**（隐藏输入）。
   *
   * 三条分寸都在这一屏上：
   * - **不回显**（`secret`）——屏上只见圆点，值只在壳里；
   * - **可以留空**：设计「认证使用独立的隐藏输入**或既有环境变量引用**」——留空＝不往配置里
   *   写凭据，走 `MAGIC_<连接 id>_API_KEY` 回退（那一行的说明把这句写出来，指到具体那个名字）；
   * - **保存之后顺手取一次列表**（设计：「确认后保存连接并获取列表」）——见 `awaiting`。
   */
  const askKeyFor = (vendor: VendorInfo, region: VendorRegion | undefined): void => {
    const id = freeIdOf(vendor.vendor)

    openAsk({
      label: '密钥',
      secret: true,
      value: '',
      caret: 0,
      placeholder: '粘贴或输入密钥',
      // 交代清楚「这一下存的是什么」：哪一家、哪个区域、凭据从哪儿来。
      // ⚠️ 说明里报的区域**用「这一次会用的那一个」**（没得选时就是缺省那一项），
      //    而写进配置的只在**真选过**时给（`region` 缺省＝用缺省那项，见下面的展开）
      note: [
        `回车＝保存 ${vendor.label} · ${(region ?? vendor.regions[0])?.label ?? '默认区域'}`,
        `留空＝改用环境变量 ${apiKeyEnvVarOf(id)}`,
      ].join(' · '),
      submit: (value) => {
        awaiting = 'connect'

        return {
          type: 'provider.save',
          provider: id,
          vendor: vendor.vendor,
          // **选了才写**（约定：不写 region＝用缺省那一项）——只有一个区域时没得选，故不写
          ...(region === undefined ? {} : { region: region.id }),
          ...(value === '' ? {} : { apiKey: value }),
        }
      },
    })
  }

  const openModelPicker = (note: string): void => {
    // **取材＝连接一览 ＋ 各自的缓存读数**（U41）——不再是「配置条目」（那正是本项要拆掉的
    // 约束：型号得逐个登记才列得出来）。铺行的规矩全在 `modelRows` 一处（行主文案＝模型名 ·
    // 副文案＝连接名 · 只列适用于对话的 · 已有选择照留）。
    //
    // ⚠️ **两趟共用这一屏、行的铺法一字不差**（U78）：差的只有「谁算当前那一条」与那行说明
    //    ——`/model` 那一趟是**当前会话**走谁，`/config` 那一趟是**取网页**用谁（见 `modelScope`）。
    const rows = modelRows(view.models, scopeCurrent())

    commit(
      openPicker(view, {
        source: 'model',
        // 落在**此刻会走的那一条**上（没有去向就从头起——不拿首项冒充当前）
        selected: Math.max(0, rows.findIndex((row) => row.current)),
        rows,
        hint: modelHint(view.models, note === '' ? undefined : note, modelScope),
      }),
    )
  }

  /**
   * **就地重铺**（U41 · 刷新那一路）——设计：「刷新只更新信息，**不抢走列表当前焦点**、
   * 不清草稿、不写回默认」。
   *
   * 重铺＝换掉行与说明，**选中那条按身份（连接 ＋ 模型）认回来**：列表顺序变了、新增了几条、
   * 甚至当前那条挪了位置，用户手上那一下都不该被抢走。
   *
   * 0 行照 `refreshGrantsPicker` 那条老规矩办：**收起抽屉**（0 行的抽屉接管着输入却不给
   * 东西可点——打不了字、没得选，看着就是卡死），内核那句说明落成记录区一行回执。
   */
  const refreshModelPicker = (note: string): void => {
    if (view.dock.kind !== 'picker') return

    // 详情 / 思考两屏的资料也来自这一份读数（规格 · 缓存时间 · 思考能力）——照旧的读数重铺
    if (view.dock.picker.source === 'model-detail') {
      openModelDetail(detailAt)
      return
    }
    if (view.dock.picker.source === 'model-reasoning') {
      openReasoningPicker(detailAt)
      return
    }

    if (view.dock.picker.source !== 'model') return

    const held = picked(view)?.pick
    // 重铺与铺**同一份读数、同一句话**（U78）——不然刷新一次那一屏就换了个人说话
    const rows = modelRows(view.models, scopeCurrent())
    const hint = modelHint(view.models, note === '' ? undefined : note, modelScope)

    if (rows.length === 0) {
      commit(closePicker(view))
      if (hint !== '') commit(appendReceipt(view, hint))
      return
    }

    const at =
      held === undefined
        ? view.dock.picker.selected
        : rows.findIndex((row) => row.pick?.provider === held.provider && row.pick.model === held.model)

    commit({
      ...view,
      dock: {
        kind: 'picker',
        picker: {
          ...view.dock.picker,
          rows,
          // 认不回来（那条模型从列表里没了）⇒ **夹回范围内**，不跳远、也不越界
          selected: Math.min(
            Math.max(0, at === -1 ? view.dock.picker.selected : at),
            rows.length - 1,
          ),
          hint,
        },
      },
    })
  }

  // —— 技能（U33 · 终端入口）——

  /**
   * **`/skills` 的抽屉**——行：名称 ＋ 来源 ＋ 简述（见 `skillRows`）。
   *
   * `filter` 一变就整个重铺（打字筛、退格放宽、同名直达那一路拿名字当筛词）——
   * 一处铺行，三种来路共用，不各写一遍。
   *
   * 取材是**视图里那一份目录**（`view.skills`）：`/skills` 每次都发一次 `skills.list`
   * 现问，故这一屏说的就是那一下的现况（技能是随用户编辑变的目录）。
   *
   * 0 行时（没筛词的）`openPicker` 会把它落成一行回执、不开抽屉——空名录不开空抽屉（P0）。
   *
   * 取材是**视图里那一份目录**（`view.skills`），不再有第二份取材（U57 那个 `skillScope`
   * 随「同名 ⇒ 展开候选」一起退回：候选栏上停哪一条、那一屏就停在谁头上，都得有名有姓的
   * 一对同名才谈得上，而**同名在发现那一层只剩一条**了）。
   */
  const openSkillsPicker = (
    filter: string,
    anchor: { readonly start: number; readonly end: number },
  ): void => {
    const catalog = view.skills
    const rows = skillRows(catalog?.skills ?? [], filter)

    commit(
      openPicker(view, {
        source: 'skills',
        selected: 0,
        rows,
        filter,
        anchor,
        hint: skillHint({ catalog, filter, shown: rows.length }),
      }),
    )
  }

  /**
   * **选定一份技能 ⇒ 在它该在的位置放进一句引用**（U36）。
   *
   * 三件同时成立才是对的：
   * - **不加载主文、不发模型请求**（带的是身份：名字 ＋ 真路径），真实提交那一刻内核才按身份取；
   * - **不发送**（按回车确认一个选择，不该顺手把草稿发出去）；
   * - **插在打开列表前那个位置**（`anchor`）——不移到开头、也不一律追加到末尾
   *   （设计 · 技能调用：「选定后在打开选择器前的输入位置插入技能引用」）。
   */
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

  // —— 图片附件（U37 · `/attachments`）——

  /**
   * **开「送过的图片」那一屏**——行取自视图里那一份答复（`view.attachments`）。
   *
   * 与 `/skills` / `@` 同一处开合（左下抽屉）：**只是列一列**，选定才进详情那一屏。
   * 0 行时 `openPicker` 会把说明落成一行回执（`attachmentHint` 给的那句话）——
   * 空表**不接管输入**（P0 那条既有分寸）。
   */
  const openAttachments = (): void => {
    const rows = view.attachments?.rows ?? []

    commit(
      openPicker(view, {
        source: 'attachments',
        selected: 0,
        rows: attachmentRows(rows),
        hint: attachmentHint({ count: rows.length, detail: false }),
      }),
    )
  }

  /**
   * **进一张图的详情那一屏**（U37）——两条动作：查看原图 / 加入本次输入。
   *
   * 找不着那一行＝答复在抽屉开着的时候被换掉了（换了会话 / 内核重问了）：照实收起、
   * 什么都不做，不拿一个编出来的身份凑数（同 `/skills` 那条无名录时的处置）。
   */
  const openAttachmentDetail = (entry: RecordId): void => {
    attachmentAt = entry

    commit(
      openPicker(view, {
        source: 'attachment-detail',
        selected: 0,
        rows: attachmentDetailRows(),
        hint: attachmentHint({ count: 1, detail: true }),
      }),
    )
  }

  /**
   * **「加入本次输入」**（U37）——把那一张**放回输入行**（不发送、不读盘）。
   *
   * 三件同时成立才是对的：
   * - **引用带回那份字节的把手**（`blob`）——提交那一刻内核按它取回，**一路不碰原路径**；
   *   这正是「源文件删掉、会话重开之后仍能再用它」的落点；
   * - **插在打开列表前那个位置**（`anchor`，同 `/skills` / `@` 两处）：`/attachments`
   *   是命令，草稿已被它清空，故那一格即句首的 `[0, 0)`——**不一律追加到末尾**
   *   （设计 · 文件与图片：「在打开查询前的输入位置插入引用」）；
   * - **不发送**：选定一个动作不等于把交代发出去。
   *
   * 那一处的名字是**编号**（`Image#N`，U62）——取号按**内容身份**（`row.blob` 就是那一份
   * 字节的 sha256），故同一张图从这一屏放回两次、或与 `@` 选进来的同一张并用，都是同一个名字。
   */
  const attachImage = (row: AttachmentRow, anchor: { readonly start: number; readonly end: number }): void => {
    const marker = markerOf({ kind: 'image', n: imageNumberOf(row.blob, view.refs) })

    commit(
      withCompletion({
        ...closePicker(view),
        ...replaceWith(
          view.draft,
          view.refs,
          { from: anchor.start, to: anchor.end },
          {
            kind: 'image',
            marker,
            name: row.name,
            mime: row.mime,
            blob: row.blob,
            label: row.label,
            source: row.source,
          },
          view.caret,
        ),
      }),
    )
  }

  // —— 路径（U36 · 正文里的 `@`）——

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
        selected: view.dock.kind === 'picker' && view.dock.picker.source === 'paths' ? view.dock.picker.selected : 0,
        rows: pathRows(catalog?.rows ?? []),
        filter: query,
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
  const typePath = (char: string): void => {
    const picker = view.dock.kind === 'picker' ? view.dock.picker : undefined
    const anchor = picker?.anchor
    if (anchor === undefined || picker === undefined) return

    const query = (picker.filter ?? '') + char
    const at = anchor.end

    editAt(
      view.draft.slice(0, at) + char + view.draft.slice(at),
      at + char.length,
      insertText(view.refs, at, char.length),
    )
    reopenPaths({ start: anchor.start, end: at + char.length }, query)
    askPaths(query)
  }

  /** 退格删一格查询（`@` 那一栏里退格）——草稿与锚点一起缩。 */
  const backspacePath = (short: string, anchor: { readonly start: number; readonly end: number }): void => {
    const filter = view.dock.kind === 'picker' ? view.dock.picker.filter ?? '' : ''
    const removed = filter.length - short.length
    if (removed <= 0) return

    eraseAt(anchor.end - removed, anchor.end)
    reopenPaths({ start: anchor.start, end: anchor.end - removed }, short)
    askPaths(short)
  }

  /**
   * `Tab` 补全（`@` 那一栏）——把选中的那一条**补进查询**；目录再补一个尾斜杠，
   * 于是下一趟列的就是它里面那一层（设计：「目录加 `/` 后向内浏览」）。
   *
   * `Enter`（选定）与 `Tab`（补全）分开是设计明写的：候选开着时回车只选入，
   * 而补全之后多半还想接着打（`src/com` → `src/components/`）。
   */
  const tabPath = (): void => {
    const anchor = view.dock.kind === 'picker' ? view.dock.picker.anchor : undefined
    const row = picked(view)
    const found = view.paths?.rows.find((one) => one.path === row?.value)
    if (anchor === undefined || found === undefined) return

    const text = found.kind === 'directory' ? `${found.display}/` : found.display
    const from = anchor.start + 1 // `@` 自己留着——查询那一段是它后面这一截
    // 把 `[from, anchor.end)` 换成补全后的那一段：先按删的算位移，再按插的算
    const refs = insertText(removeRange(view.refs, from, anchor.end), from, text.length)

    editAt(view.draft.slice(0, from) + text + view.draft.slice(anchor.end), from + text.length, refs)
    reopenPaths({ start: anchor.start, end: from + text.length }, text)
    askPaths(text)
  }

  /**
   * `Enter`（`@` 那一栏）——**选定即把引用放进正文原处**。
   *
   * 替换掉的是**整段查询**（从 `@` 到用户打到的位置）：设计 · 文件与图片
   * 「选定后收起候选，在查询原处留下文件/目录引用，其余正文不动；不追加独立附件行」。
   *
   * ## 文件再问一句「它是什么」（U62）
   *
   * 目录到此为止（`@src/` 就是它该有的样子）。**文件**多走一趟 `paths.identify`：
   * 它可能**是一张图**，而图片那一处的写法是**编号**（`Image#N`）——不是路径，也不用文件名。
   * 这一问要读一次内容，故只在**选定之后**发（设计：「选定才是用户的动作」）。
   *
   * ⚠️ **先落稿、后问**（次序是刻意的，与 `input.submit` 那条同）：答复回来时那一处引用
   * 得**已经在稿子里**——改名那一步是在原处替换（`retype`），不是另插一处。
   * 问不出来（不是图 / 读不了 / 不在了）⇒ 什么都不发生：那一处**照旧是 `@路径`**
   * （真到提交那一刻取不到，由那一条如实报错）。
   */
  const pickPath = (): void => {
    const anchor = view.dock.kind === 'picker' ? view.dock.picker.anchor : undefined
    const row = picked(view)
    const found = view.paths?.rows.find((one) => one.path === row?.value)
    if (anchor === undefined || found === undefined) return

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

  /**
   * **选定那一条认出来了**（U62）——是图就把那一处**在原处**改成 `Image#N`。
   *
   * 四条分寸：
   * - **没认出图 ⇒ 什么都不做**：那一处照旧是 `@路径`（设计：不假装有文件名——
   *   一份读不出图的文件本来就没有「图片的名字」可言），也不在选入的时候就先报一串；
   * - **认的是路径**（答复原样回声）⇒ 改的是**稿子里 `source` 正是它**的那几处：
   *   同一份文件选进来两次，两处一起改，而它们**共用同一个编号**（同内容同名字）；
   * - **已经不在稿子里的**（答复后到，用户已经删了那一段 / 已经交出去了）⇒ 无一处可改，
   *   `retype` 原样还回来，这里也就不动（不新插、不复活）；
   * - 走 `edit`（人动草稿那条口）而不是 `commit`：这确实是**改草稿**——历史游标该归位，
   *   而「交出去那一份等着认领」也就此作罢（稿子已经不是交出去时那一份了）。
   */
  const identifyPicked = (data: Extract<KernelEvent, { kind: 'paths.identified' }>['data']): void => {
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

  /**
   * **一次提交**（U33 起，U36 改形）——正文 ＋ 它里面的引用 ＋ 配对键，三件一起交给内核。
   *
   * 三条写在一处：
   * - **正文原样**（引用那几个字**留在原处**、**内部换行留着**）——前后文字指向哪件事，
   *   靠的就是这个次序；`/clear`、绝对路径写在正文里仍只是正文（不递归解析斜杠）；
   * - **引用随这一份**（`refs`）：每处带**位置 ＋ 身份**，内核按身份取材料，取不到就
   *   **这一条不跑**（不换同名项、不忽略它继续）——文件读不了与技能取不到同一条出口；
   * - **配对键**（`ref`）：`input.settled` 按它认回这份草稿（失败时原样还回来，见 `restoreDraft`）。
   */
  const sendInput = (text: string, refs: readonly DraftRef[]): ShellEffect => {
    submits += 1
    const ref = `draft-${submits}`
    lastSubmit = { ref, text, refs }

    const cleared: ShellView = { ...view, draft: '', caret: 0, refs: [] }
    // **这一段输入到此为止，编号也归零**（U62）：`Image#N` 是**一段输入内**的编号，
    // 下一段交代从 `Image#1` 重新数（留着上一段的号只会让新的一句里平地冒出个 `Image#4`）。
    // ⚠️ 失败还稿那一路（`settleDraft`）会整份把引用摆回来，编号在那时**认回来**
    // （见 `adoptImageNames`）——这里先清掉不会让还回来的那几个名字撞号。
    imageNames = new Map()
    // 历史记的是**整份草稿**：正文 ＋ 它里面的引用（位置与身份都在，见 `HistoryEntry`）——
    // `↑` 翻回来的是**当时那一句**，接着改、再发一次都不必重选。
    // 连着提交两份一模一样的不重复记（与从前那条「同上一条相同就不记」同一分寸）。
    const entry: HistoryEntry = { text, refs }
    const last = history[history.length - 1]
    if (last === undefined || !sameEntry(last, entry)) history.push(entry)
    historyAt = -1
    browsing = null // 交出去之后输入行是空的：没有「原稿」可返回了

    // ⚠️ **先落地、后发命令**（D23 那条次序）——进程内传输是同步直连的，
    // 反过来的话这次 `draft()` 拿的是发命令**之前**的快照，会把答复刚写进去的东西盖掉。
    draft(appendEcho(cleared, text))
    send({
      type: 'input.submit',
      text,
      ref,
      ...(refs.length === 0 ? {} : { refs: wire(refs) }),
    })

    return NONE
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
    const held = lastSubmit
    if (held === null || ref === undefined || held.ref !== ref) return

    lastSubmit = null
    if (!keepDraft) return
    // 插入点摆到末尾（那一份交出去时多半已经打完了）；引用原样回到原位
    commit(
      withCompletion({
        ...view,
        draft: held.text,
        caret: held.text.length,
        refs: held.refs,
      }),
    )
  }

  // —— 键 ——

  /**
   * **这一屏还在干活吗**（这一轮在跑，或在等你答复）——与 `hangUp` / `run.ts` 的
   * `busy()` 同一套口径：一处定义，三处别各判各的。
   */
  const busy = (): boolean =>
    view.status.state === 'working' || view.status.state === 'retrying' || view.dock.kind === 'decision'

  /** 工作中／有待答 ⇒ **替我们发中断**并返回 `true`（「这一下不是退出」）；否则 `false`。 */
  const interruptPending = (): boolean => {
    if (!busy()) return false

    send({ type: 'turn.interrupt' })
    return true
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

  /**
   * **挂上那道门 ＋ 起钟**（U68）——第一下按 Ctrl+C 走的就是这一跳。
   *
   * 钟到点干两件：**撤掉那一行** · **取消这一次监听**（`exitArmed` 落回假 ⇒ 下一次按
   * 从头算）。两件其实是同一件：那一道门的状态就是 `exitArmed` 这一格。
   *
   * ⚠️ `unref`：测试 / 演示里不该因为一支钟把进程多拽住 1.5 秒（同 `holdResumed` 那一处）。
   */
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

  /**
   * 空闲按 Ctrl+C——**按两次才走**（U46 · U68 加了时限 · 设计「离开、停止与异常退出」）。
   *
   * 第一下**不退出**，只把那一行挂上（`HINT_EXIT_ARMED`）**并起 1.5 秒的钟**；
   * 钟内再按一下才放行。两条清理由：
   * - **到点**（`armExit` 里那支钟）——那一行自己撤，再按是**新的一次**；
   * - **任何别的输入**（`key` 兜着，见那一处）——用户又不想走了。
   *
   * 两者都收在 `disarmExit` 一处——「那一行还在不在」与「那一下算不算数」是**同一格**，
   * 两处各清各的迟早分开（只撤了行、监听还挂着，就会「看不见那一行却一按就退」）。
   */
  const exitOrInterrupt = (): ShellEffect => {
    if (interruptPending()) {
      // ⚠️ **中断不是「第二次按」**：它是另一件事（这一轮在跑），故那一道门当场撤掉——
      //    不然「按一次挂上 → 干了点别的（比如提交了一句话）→ 再来一下」会直接退出。
      disarmExit()
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

  /**
   * **`/exit` 那一下**（U52）——**先停掉当前这条会话，资源确认退出之后再退界面**。
   *
   * ## 为什么是「停」而不只是「关」
   *
   * 2026-09-24 用户裁：TUI 与服务已经分开（U48），`/exit` 是**明确说出口的动作**
   * （与「按两次」那条同源：打出来的词就是有意的），故它承载得了更强的语义——
   * **「这条我不做了」**。两个动作于是各管各的：
   *
   * | 动作 | 语义 |
   * | --- | --- |
   * | `/exit` | **停掉当前会话，然后退出界面** |
   * | Ctrl+C 两次 | **只离开**，工作继续 |
   *
   * 顺带把「服务侧怎么退出」答了：**逐条停 ⇒ 没有执行者 ⇒ 管理者自己收缩**（那条规则
   * 早就有），**不另造一个「服务退出」的开关**。
   *
   * ## 三件不许（工单「要做对的几件」）
   *
   * - **不另造一条停止通路**：走的就是 U50 交付的那个入口（`options.stop` ＋ 整体那一档
   *   `run`），连回执都是 `stopped` 那条线拼好的（`正在停「X」` / `「X」停了`）——
   *   这一处**一个字都不多说**（同一条事实说两遍是设计明防的）。
   * - **不是发出去就走**：**这一跳不退**。放行在 `stopped` 那一头——`done` 才置
   *   `view.leaving`（设计：「资源确认退出后才报已停止」）。
   * - **不谎称已停**：停不掉那一拍（`unconfirmed`）照实说，也**照样放行**——到点还没
   *   收完就如实说「还没收完」，但不把用户**卡在这儿**。他要是只想离开，另一扇门
   *   （Ctrl+C 两次）一直开着；而这一条已经说过实话了。
   */
  const beginExit = (): ShellEffect => {
    const target = view.sessionId

    // ① **没有停止的来路**（用例 / 演示：`options.stop` 没接上）：这台外壳背后没有
    //    「服务那一头」，自然也没有可停的运行——直接走，**不留话**（没有发生过
    //    「停掉什么」这件事，印一句「没停成」反倒是在报一件没发生的事）。
    if (options.stop === undefined) {
      commit({ ...view, leaving: true })
      return NONE
    }

    // ② **还没有会话**。两件要分开：
    //
    // - **窗内没有这一轮在跑** ⇒ 真·空手开机：没有可停的东西，直接走；
    // - **有这一轮在跑** ⇒ 这条会话**才刚开张、外壳还没认出它是哪一条**（`session.state`
    //   那一声答复还没到——U44 起就记着这件事：首条消息开张时外壳收不到它，`/clear`
    //   那一跳踩过同一个窗口）。此刻**不能降级成「只离开」**：那正是这一单要补的那个缺
    //   （工作中退出＝真停）。故把意图挂上，那一声答复一到就接着办（见 `onEvent`）。
    if (target === null) {
      if (busy()) exitWaitsForSession = true
      else commit({ ...view, leaving: true })
      return NONE
    }

    stopForExit(target)
    return NONE
  }

  /**
   * **停这一条，然后等着走**（U52）——`beginExit` 与「等会话认出来」那一路共用。
   *
   * 认的是「会话 ＋ 整体那一档」两样都对上：正等着的时候，别的窗口停的、或者同一会话
   * 局部那一档（`turn`）的报告，都不该把我放走。
   */
  const stopForExit = (target: SessionId): void => {
    exitWait = target
    options.stop?.(target, 'run')
  }

  /**
   * **终端那头没人了**（断流 / 关窗信号 · `run.ts` 的 `onTerminalGone`）——同一条收尾语义，
   * 但**不设「按两次」那道门**：那是**键盘**那条路上的确认（设计：「按两次」只管键盘那条路），
   * 而此刻对面已经没人在按了——让他再按一次，就是谁都不动。
   *
   * 空闲＝当场放行收摊 · 工作中／有待答＝替我们发中断（沿既有）。
   */
  const hangUp = (): ShellEffect => (interruptPending() ? NONE : EXIT)

  const key = (input: ShellKey): ShellEffect => {
    if (disposed) return NONE

    // **别的输入把那一行收掉**（U46）——用户又不想走了。
    //
    // 收口就这一处：`HINT_EXIT_ARMED` 那一行说的是「再按一次」，而**任何别的输入**都
    // 说明他不是要退出（敲字 / 翻历史 / 开选择器 / 移动插入点…）——留着它就是一句
    // 不再为真的话，再按一下还会走。`ctrl+c` 那一支不走这里：它自己管（第一下挂上、
    // 第二下走），故那一下不会被自己的清理抹掉。
    //
    // ⚠️ **钟也一起收**（U68）：只撤行、不收钟的话，那支钟到点还会把**后来重新挂上的**
    //    那一次误撤掉（`disarmExit` 一处管两件）。
    //
    // ⚠️ 先 `commit` 再往下走：`view` 是本闭包里的 `let`，下面各支读到的就是清过的那一份。
    if (input.kind !== 'ctrl+c') disarmExit()

    // **`←` 弹一层**（U61）——接管屏（选择器 ／ 本地小输入）里 `←` 一律归屏，
    // **草稿那一头（没开屏）才照旧移插入点**（见下面 `case 'left'`）。与 `↑↓`
    // 「选择器里选择／不在就翻历史」同一分工（设计明文）。
    //
    // ⚠️ **这一支排在本地小输入那道门之前**：小输入的键位归 `askKey`，而它认的 `←`
    // 是老面孔（移插入点）——照那个走，本单的要害那一趟（问密钥 →「←」→ 选区域）
    // 就还是回不去。屏里有屏的键位，这一格说清楚的是「`←` 在这一屏干什么」。
    if (input.kind === 'left' && (view.dock.kind === 'picker' || view.dock.kind === 'prompt')) {
      popLayer()
      return NONE
    }

    // **本地小输入开着的时候，键归它**（U41）——但 `ctrl+c` 是全局的（空闲＝退出、
    // 工作中＝中断），故它照旧落下去走 `exitOrInterrupt`：一条本地小输入不该把退出挡住。
    if (view.dock.kind === 'prompt' && input.kind !== 'ctrl+c') return askKey(input)

    {
    }


    switch (input.kind) {
      case 'ctrl+c':
        return exitOrInterrupt()

      case 'ctrl+o':
        commit({ ...view, expanded: !view.expanded })
        return NONE

      // `Ctrl T`——收起/展开当前清单（U34）。**只改本地视图**：不发送、不碰草稿。
      // 没有清单时不切（切了也没人看得见，而「默认展开」是设计明写的——别让它悄悄
      // 变成一个「下次建立计划就收着」的埋伏）。接管（裁决）期间照旧管用：它不经过
      // 输入框，也不是答复键，挡它没有理由。
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

      case 'escape':
        // 选择器开着 ⇒ 收起（**不留痕迹**）。⚠️ **一律全收**，与本单新加的 `←`（弹一层）
        // 分开走（设计：「两个动作、两个键，不混」）——`esc` 一按到底，`←` 一次一层。
        // 这一支的语义一个字没改（U61 只是把「收起」那几步抽进了 `collapseDock`——
        // 「弹到空」那一跳要**与它同效**，两处各写一遍迟早分家）。
        if (view.dock.kind === 'picker') {
          collapseDock()
          return NONE
        }
        // 本地小输入开着时到不了这一支（上面那道门把它交给 `askKey`，它认 `esc`＝`closeAsk`）
        if (view.dock.kind === 'prompt') return NONE
        if (view.dock.kind === 'decision') return NONE // 接管期间 `esc` **无动作**
        // 候选开着 ⇒ 先**收起候选**（原型：`esc` 收起；草稿留着）
        if (view.completion !== null) return (commit({ ...view, completion: null }), NONE)
        // ⚠️ **U36 撤销了 U33 那一层「先摘技能」**（`esc` 一层层往回退里的那一档）：
        // 技能现在**长在正文里**，摘它就在那一处按退格——再挂一个全局「摘当前技能」，
        // 等于同一件事两个入口，而全局那个说不出「摘的是哪一处」。故 `esc` 只剩两层：
        // 收起候选 → 清正文（清正文自然把引用一起带走，那是同一份草稿）。
        if (view.draft === '') {
          edit({ ...view, expanded: false })
          return NONE
        }
        edit({ ...view, draft: '', caret: 0, refs: [] })
        return NONE

      case 'up':
      case 'down': {
        const delta = input.kind === 'up' ? -1 : 1
        if (view.dock.kind === 'picker') {
          commit(movePicker(view, delta))
          return NONE
        }
        // 候选开着 ⇒ 在候选里选（原型 · 场景 11）；否则才是输入历史
        if (view.completion !== null) {
          commit(moveCompletion(view, delta))
          return NONE
        }
        recallHistory(delta)
        return NONE
      }

      case 'tab':
        // `Tab` 补全（原型 · 场景 11）；没有候选时什么也不做（Tab 不当正文）
        if (view.dock.kind === 'picker') {
          // 路径那一栏里 `Tab` ＝ **把选中的那一条补进查询**（目录则再往里看一层）
          if (view.dock.picker.source === 'paths') tabPath()
          // **`/resume` 那一屏**（U49）——`Tab` ＝ **只看本工作区 / 全部**（设计：
          // 「提供当前工作区/全部的筛选」）。切换**不关抽屉、不丢搜索词**：用户是在
          // 「同一件事换个看法」，不是在换一件事。
          if (view.dock.picker.source === 'session') {
            sessionScope = sessionScope === 'all' ? 'here' : 'all'
            refreshSessionPicker()
          }
          return NONE
        }
        if (view.completion !== null) pickCompletion()
        return NONE

      // —— 停止（U50）：`/resume` 那一屏的两个键，各对应设计里那两档「明确选择的」范围 ——
      case 'ctrl+x':
        return askStop('run')

      case 'ctrl+w':
        return askStop('turn')

      case 'enter':
        return submit()

      // ⚠️ **接管屏（选择器 / 本地小输入）到不了这一支**——上面那道门已经把
      //    「`←` 弹一层」收走了（U61）。这里只剩**草稿那一头**：真移插入点。
      case 'left':
        if (view.dock.kind === 'decision') return refuse('左移')
        // **草稿一个字都不动**（只挪插入点）⇒ 不走 `edit()`：翻出来的历史还认得上一条。
        // 插入点挨着一处引用时**整处跨过去**（引用是一个编辑单位，见 `inline.ts`）。
        commit({ ...view, caret: stepLeftOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'right':
        if (view.dock.kind === 'decision') return refuse('右移')
        if (view.dock.kind === 'picker') {
          // **`→` ＝ 看这一条的详情**（U41）——只有模型那一屏给了这个键（别的抽屉没有「详情」
          // 这回事，故它们的左右照旧什么都不做，见列表下方那行说明）
          //
          // ⚠️ **取网页那一趟不给**（U78）：详情那一屏的两条动作（思考设置 / 设为默认）
          // 都是**当前会话**那一摊的事，在这一趟里一个都不该做——摆着就是两条会走错的岔路。
          // 那一屏的说明里也**不报这个键**（按下去没反应比不报更坏，见 `modelHint`）。
          if (view.dock.picker.source === 'model' && modelScope === 'session') {
            const pick = picked(view)?.pick
            // `→` 看详情＝**进一层**（U61：设计「进一层：打开选择器 · `→` 看详情 ·
            // 接入那种一步接一步的每一屏——都算」）——`←` 退回列表，焦点照旧那一格
            if (pick !== undefined) {
              enterLayer()
              openModelDetail(pick)
            }
          }
          return NONE
        }
        commit({ ...view, caret: stepRightOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'backspace':
        if (view.dock.kind === 'decision') return refuse('退格')
        // 抽屉里退格＝**放宽筛选**（打字那一支的对面；按字素删，中文也删得对）
        if (view.dock.kind === 'picker') {
          const picker = view.dock.picker

          // **`/resume` 那一屏**（U49）——退格＝**把搜索词删一个字**（与打字那一支对称）。
          // 它不给「整段撤回」那条：搜的是用户自己打的词，删空就是没有筛词（不关抽屉）。
          if (picker.source === 'session') {
            const query = sessionQuery.slice(0, leftSpan(sessionQuery, sessionQuery.length)[0])
            if (query !== sessionQuery) {
              sessionQuery = query
              refreshSessionPicker()
            }
            return NONE
          }

          // **`/config` 那一屏**（U71）——退格＝**把筛词删一个字**（与打字那一支对称）。
          // 退到空＝**全表**（设计明文）。
          //
          // ⚠️ **它没有 `/skills` 那一条「整段撤回」**：那一支撤的是 `@` 写进草稿的那一段
          //（`anchor`），而这一屏的筛词**压根不在草稿里**（它就是这一屏自己的临时状态）——
          // 撤到空就停在空表＝全表，不顺手把抽屉也收了（那会让「想看一眼全表」变成「按没了」）
          // ——照 `/resume` 的先例（那一屏的退格也是这个走法）。
          //
          // ⚠️ **`esc` 不走这里**（设计明文）：清过滤归退格，`esc` 一律全收——不许把
          //    「先清过滤、再全收」两段造在同一个键上（见上面 `case 'escape'` 那一支）。
          if (picker.source === 'config') {
            const query = configQuery.slice(0, leftSpan(configQuery, configQuery.length)[0])
            if (query !== configQuery) {
              configQuery = query
              refreshConfigPicker()
            }
            return NONE
          }

          if (picker.source !== 'skills' && picker.source !== 'paths') return NONE

          const filter = picker.filter ?? ''
          const short = filter.slice(0, leftSpan(filter, filter.length)[0])
          // 筛完了再退格 ＝ **把这一处查询整个撤回**（`@` 那一段本来就不是用户说的话）
          if (short === filter) {
            const anchor = picker.anchor
            commit(closePicker(view))
            if (anchor !== undefined) eraseAt(anchor.start, anchor.end)
            return NONE
          }

          if (picker.source === 'skills') openSkillsPicker(short, picker.anchor ?? { start: 0, end: 0 })
          else backspacePath(short, picker.anchor ?? { start: 0, end: 0 })
          return NONE
        }
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
        if (view.dock.kind === 'decision') return answer(input.char)
        // 抽屉里打字＝**筛**（U33 `/skills` 的搜索 · U36 `@` 的路径）——其余选择器照旧吞掉
        if (view.dock.kind === 'picker') {
          const picker = view.dock.picker

          // **`/resume` 那一屏**（U49）——打字＝**按名字筛**（设计：「提供……名称搜索」）。
          // 筛词**只留在这一屏**（`sessionQuery`），不写进草稿：它不是用户那句交代的一部分
          // （与 `@` 那一段不同，见 `Picker.anchor`）。
          if (picker.source === 'session') {
            sessionQuery += input.char
            refreshSessionPicker()
            return NONE
          }

          // **`/config` 那一屏**（U71）——打字＝**筛**（设计：「打字即过滤」，不设专门的
          // 搜索模式）。筛词只留在这一屏（`configQuery`），不写进草稿：它不是用户那句交代的
          // 一部分（与 `@` 那一段不同，见 `Picker.anchor`）。
          //
          // ⚠️ **筛的是「名称 ＋ 当前值」两处**（行上写着的那些字，见 `configRows` 的 `hits`）
          // ——不是只筛名称：用户想找「数据目录」未必记得这一项叫什么。
          if (picker.source === 'config') {
            configQuery += input.char
            refreshConfigPicker()
            return NONE
          }

          if (picker.source !== 'skills' && picker.source !== 'paths') return NONE

          const filter = (picker.filter ?? '') + input.char
          if (picker.source === 'skills') openSkillsPicker(filter, picker.anchor ?? { start: 0, end: 0 })
          else typePath(input.char)
          return NONE
        }
        insertAt(input.char)
        // `@` 在**词边界**上 ⇒ 开路径候选（邮箱那种紧挨着字的 `@` 不触发；
        // 前面带反斜杠的转义 `@` 也不触发——它只想打一个 `@`）
        if (input.char === '@' && opensPath(view.draft, caretAt())) openPathsAt()
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

  /** 接管期间的作答键——只认 `y` / `a` / `n`（必闸类没有 `a`）。 */
  const answer = (char: string): ShellEffect => {
    const pending = view.dock.kind === 'decision' ? view.dock.pending : undefined
    if (pending === undefined) return NONE

    if (char === 'y') {
      send({ type: 'decision.answer', id: pending.id, decision: 'approve' })
      return NONE
    }
    if (char === 'n') {
      send({ type: 'decision.answer', id: pending.id, decision: 'reject' })
      return NONE
    }
    if (char === 'a') {
      // **必闸类不给 `a`——外发那一件是例外**（U72）：它带域名时按域名记
      //（卡上那一格也照实画成活的、措辞「总是允许这个域名」，见 `decision.ts`）。
      // 两处判据同一位（`pending.host`）：一处改一处漏，屏上就会出现「画得出来、
      // 按下去说不行」那种卡。
      if (pending.weight === 'heavy' && pending.host === undefined) {
        // 外部操作说不出「可逆 / 不可逆」那套词——按它自己的缘由说（U38）；
        // 键位也不在这儿再列一遍（卡上就写着，返工 B：一屏只说一次）
        commit(
          said(
            view,
            pending.external === true
              ? '外部操作不可「总是允许」——效果由服务器决定，只能批准这一次。'
              : '必闸类不可「总是允许」——按 y 批准这一次，或 n 拒绝。',
          ),
        )
        return NONE
      }
      send({ type: 'decision.answer', id: pending.id, decision: 'approve', remember: true })
      return NONE
    }

    return refuse(char)
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
    if (view.dock.kind === 'decision') return refuse('回车')
    // 本地小输入开着 ⇒ 回车是**把它交出去**（不是发交代——那一路归 `input.submit`）
    if (view.dock.kind === 'prompt') return submitAsk()

    if (view.dock.kind === 'picker') {
      const row = picked(view)
      if (row === undefined) return NONE

      // **配置一览**（U71）——选定＝**进那一项自己那一屏**。
      //
      // ⚠️ **这一条不重造任何一件交互**（设计：「不在 `/config` 里重造一遍」）：前三项
      //    各把**那一条读侧命令原样发出去**，答复到了走的是**与直接打那条 slash 一模一样**
      //    的那几支（`onEvent` 里的 `openModelPicker` / `openGrantsPicker` / `openMcpPicker`）
      //    ——故屏上「逐字同形」不是靠照抄，是**同一条路**。
      //
      // ⚠️ **进那一项＝进一层**（U61：栈的单位是「那一屏」）：`←` 退回这一屏接着挑。
      //    从输入行打 `/model` 时这一跳不压栈（栈底就是输入行）——两处的差别只在**回来的
      //    地方不一样**，那一屏本身一个字都不差。
      if (view.dock.picker.source === 'config') {
        if (row.value === 'model') {
          // `/model` 那一趟：换**当前会话**走谁（不写配置）
          modelScope = 'session'
          enterLayer()
          waiting = 'model'
          send({ type: 'model.list' })
          return NONE
        }

        // **取网页用的模型**（U78）——**同一扇选择器、另一件事**：选一条是**写配置里那一格**
        // （`webfetch.set`），**不换当前会话的模型**（设计 · 网页与搜索：两处不能混）。
        // ⚠️ **读的还是那条读侧命令**（`model.list`）：那一屏要的连接一览 ＋ 缓存读数 ＋
        //    「现在配的是哪一对」都在同一条答复上（`model.catalog` 的 `webFetch`），
        //    不另立一条只问一格的命令。
        if (row.value === 'webFetch') {
          modelScope = 'webFetch'
          enterLayer()
          waiting = 'model'
          send({ type: 'model.list' })
          return NONE
        }

        if (row.value === 'grants') {
          enterLayer()
          waiting = 'grants'
          send({ type: 'grants.list' })
          return NONE
        }

        if (row.value === 'mcp') {
          enterLayer()
          waiting = 'mcp'
          mcpServer = '' // 总览那一屏（`/mcp` 无参）——不是某一台的明细
          send({ type: 'mcp.list' })
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
        commit(
          lines.length === 0
            ? appendReceipt(closePicker(view), '这一趟没拿到数据目录与工作区根')
            : appendOutput(closePicker(view), CONFIG_PATHS_TITLE, lines),
        )
        return NONE
      }

      // `/resume` 那一屏：选定＝切过去。
      if (view.dock.picker.source === 'session') {
        // **选的是当下这条**：什么都没发生——内核那一边 `switchTo` 也知道是同一条、
        // 一个事件都不发（见 `conversation` 的 `run`）。故回执**这一侧当场给**
        // （等答复就是白等），页也不翻（没换记录区，翻了反而是「凭空清一屏」）。
        if (row.value === view.sessionId) {
          commit(appendReceipt(closePicker(view), `已切到 ${row.label}`))
          return NONE
        }

        // **换一条**：回执与翻页都在**答复**那一侧落（见 `turn` 那段注）——
        // 这一侧只管把意图记下、把抽屉收起。
        // **翻回已有的一页**（`'open'`）⇒ 那一页**不印字标**（U45）：它马上有记录铺出来，
        // 顶上那行 `· 已切到 <名字>` 就是它的界。
        turn = { kind: 'open', label: row.label }
        send({ type: 'session.open', session: row.value })
        commit(closePicker(view))
        return NONE
      }

      // 授权（U22 · B13）：选定＝**撤掉它**（不是切过去）。抽屉**不关**——撤完刷新，
      // 接着还能撤下一条；回执行由内核那一句 `note` 给（它才知道撤成没撤成）。
      if (view.dock.picker.source === 'grants') {
        if (row.revoke === undefined) return NONE // 不该有这种行（行是 `grantsRows` 铺的）
        send({
          type: 'grants.revoke',
          ...(row.revoke.workspace === undefined ? {} : { workspace: row.revoke.workspace }),
          ...(row.revoke.index === undefined ? {} : { index: row.revoke.index }),
        })
        return NONE
      }

      // `@` 那一栏（U36）：选定＝**把引用放进正文原处**（不发送、不读材料——
      // 材料到提交那一刻才读，见 `pickPath`）。
      if (view.dock.picker.source === 'paths') {
        pickPath()
        return NONE
      }

      // 技能抽屉（U33/U36）：选定＝**在打开列表前那个位置放一句技能引用**
      // （不发送、不加载主文）。找不着那一份＝目录在抽屉开着的时候被换掉了，照实收起、
      // 什么都不放（不拿一个编出来的身份凑数）。
      if (view.dock.picker.source === 'skills') {
        const chosen = view.skills?.skills.find((one) => one.path === row.value)
        if (chosen === undefined) return (commit(closePicker(view)), NONE)

        bindSkill(chosen, view.dock.picker.anchor ?? { start: 0, end: 0 })
        return NONE
      }

      // 送过的图片那一屏（U37）：选定＝**进这一张的详情**（不发送、不导出——
      // 那两条动作在下一屏，见 `attachmentDetailRows`）。
      if (view.dock.picker.source === 'attachments') {
        const entry = Number(row.value)
        // 进这一张的详情＝**进一层**（U61）——`←` 退回列表那一屏（`/attachments` 也是多级的）
        if (Number.isInteger(entry)) {
          enterLayer()
          openAttachmentDetail(entry)
        }
        return NONE
      }

      // 一张图的详情（U37）：两条动作**各走各的**——导出交给内核（它握着那份字节），
      // 「加入本次输入」在本地就把引用放进输入行（不惊动内核，等用户真的回车）。
      if (view.dock.picker.source === 'attachment-detail') {
        if (attachmentAt === null) return NONE

        if (row.value === EXPORT_ACTION) {
          // 抽屉**不关**：导出结果是一条回执（`attachments.catalog` 带 `note`），
          // 关掉的话用户就看不见那句「导到哪儿了」
          send({ type: 'attachments.export', entry: attachmentAt })
          return NONE
        }

        const row2 = view.attachments?.rows.find((one) => one.entry === attachmentAt)
        // 找不着那一行＝答复在开着的时候被换掉了——照实收起、什么都不放（同 `pickPath`）
        if (row2 === undefined || row.value !== ATTACH_ACTION) return (commit(closePicker(view)), NONE)

        attachImage(row2, { start: 0, end: 0 })
        return NONE
      }

      // 外部服务器那一屏（U39）：**纯读**——回车不改变任何东西（重连是另一条命令，
      // 明写 `/mcp reconnect <名字>`）。留着这一支是**必须**的：不然它会落到下面的换模型上。
      if (view.dock.picker.source === 'mcp') return NONE

      // 模型详情那一屏（U41）：两件动作
      if (view.dock.picker.source === 'model-detail') {
        // 思考那一屏是**从详情那一屏进的一层**（U61）——用 `←` 退回来时详情照旧在
        if (row.value === 'reasoning') {
          enterLayer()
          openReasoningPicker(detailAt)
        }
        if (row.value === 'default') {
          const setting = reasoningOf(detailAt)
          send({
            type: 'model.default.set',
            provider: detailAt.provider,
            model: detailAt.model,
            // 用户在这台壳上给这一条选过思考设置就一并存下来；没选过＝不写这一位（模型默认）
            ...(setting === undefined ? {} : { reasoning: setting }),
          })
        }
        return NONE
      }

      // 思考那一屏（U41）：选定＝**把这一条用到当前模型上**（`model.switch` 带 `reasoning`）
      if (view.dock.picker.source === 'model-reasoning') {
        const setting = row.reasoning
        if (setting === undefined) return NONE // 不该有这种行（行是 `reasoningRows` 铺的）

        chosenReasoning = { provider: detailAt.provider, model: detailAt.model, setting }
        send({
          type: 'model.switch',
          provider: detailAt.provider,
          model: detailAt.model,
          reasoning: setting,
        })
        commit(closePicker(view))
        return NONE
      }

      // 连接一览（U41 · `/model manage` 的第一步）：选定＝**进这一条的管理明细**
      if (view.dock.picker.source === 'provider') {
        enterLayer() // 进了明细那一屏（U61）——`←` 退回一览
        openManageDetail(row.value)
        return NONE
      }

      // 管理明细那一屏：四件动作各走各的（★ 都已由内核的**回话**收尾——见 `onEvent`）
      if (view.dock.picker.source === 'provider-detail') {
        manageAction(row.value)
        return NONE
      }

      // 供应商那一屏（U41 · 接入第一步）：选定＝**接着问区域**（有得选时）或**直接问密钥**
      if (view.dock.picker.source === 'vendor') {
        const pickedVendor = view.vendors.find((one) => one.vendor === row.value)
        if (pickedVendor === undefined) return NONE // 名单里没有这一家（不该有这种行）

        // **接入那一路是「一步接一步」的每一屏都算一层**（U61）：这里要么进区域那一屏、
        // 要么直接进问密钥那一屏——两条都是进一层，故先压栈再开（选错家想重选就回得来）。
        enterLayer()
        if (pickedVendor.regions.length > 1) openRegionPicker(pickedVendor)
        else askKeyFor(pickedVendor, undefined) // 没得选 ⇒ 不写 `region`（约定：缺省那项）

        return NONE
      }

      // 区域那一屏（接入第二步）：选定＝接着问密钥，区域随这一条连接一起存
      if (view.dock.picker.source === 'region') {
        const pickedVendor = view.vendors.find((one) =>
          one.regions.some((region) => region.id === row.value),
        )
        const region = pickedVendor?.regions.find((one) => one.id === row.value)
        if (pickedVendor === undefined || region === undefined) return NONE

        // ⚠️ **这一跳是本单的要害**（U61）：问密钥那一屏是**本地小输入**，不是选择器——
        //    它照样是一层（设计：栈的单位是「那一屏」，不是「那个选择器」）。
        enterLayer()
        askKeyFor(pickedVendor, region)
        return NONE
      }

      // 模型那一屏（U41）：两类行。
      // ① **入口行**（列表末尾那几条，`modelRows` 铺的）——动作就在这一屏里做，不必另打命令；
      // ② **模型行**——选定＝切到这条连接的这个精确模型（两件一起给——合法的两条连接
      //    可以有同名模型，只报模型名认不出是谁）。回执由内核的 `model.switched` 给。
      if (view.dock.picker.source === 'model') {
        if (row.pick === undefined) return modelAction(row.value)

        // **取网页那一趟：回车＝保存**（U78）——同一个键、同一个位置，做的是另一件事
        // （写配置里 `webFetch` 那一格）。**保存是显式动作**：这一屏的全部意义就是它，
        // 故回车上不多加一道确认（同 `/model` 的回车不多问一句）。
        // 回执由答复那一侧落（见 `waiting` 的 `'webFetchSave'`）——成了说一句、没成说缘由。
        if (modelScope === 'webFetch') {
          send({ type: 'webfetch.set', provider: row.pick.provider, model: row.pick.model })
          waiting = 'webFetchSave'
          commit(closePicker(view))
          return NONE
        }

        send({ type: 'model.switch', provider: row.pick.provider, model: row.pick.model })
        commit(closePicker(view))
        return NONE
      }

      return NONE // 认不出的来路（不该走到这儿）——**什么都不做**，不拿它当换模型
    }

    // 候选开着 ⇒ 回车**先选定**（原型 · 场景 11）；**已经打全了就直接发**
    // （全名再补一次＝只多一个空格，却要人多按一次回车——参照物不这么做）
    if (view.completion !== null && !isComplete(view)) {
      pickCompletion()
      return NONE
    }

    const text = view.draft.trim()
    if (text === '') return NONE

    // 交出去的那一份是**掐过头尾空白**的文字，而引用的位置记的是**原草稿**里的坐标——
    // 故按掐掉的头几格把引用整体左移（尾部的空白不影响位置）。不搬的话，头上有空格时
    // 那一处材料会展开在**错一格**的地方（位置是自证的，`at` 与 `marker` 得对得上）。
    const head = view.draft.length - view.draft.trimStart().length
    const placed = shiftedRefs(view.refs, -head)

    // **只有技能引用、一个字都没有** ⇒ 这一条按不下去（见 `submittable`）。
    // 出声说一句，不静默吞——「按了没反应」是最难查的那种。
    if (!submittable(view.draft, view.refs)) {
      commit(said(view, '这一句只有一处技能引用——补上要它做什么，再回车发送。'))
      return NONE
    }

    if (text.startsWith('/')) {
      const word = text.split(/\s+/)[0] ?? ''

      // **技能直达 ＞ 不认得的命令**（U33）：内置那几条**先让给 slash**（工单：内置命令
      // 保留含义，同名技能仍能从 `/skills` 选），其余 `/名字` 才按技能名解析。
      //
      // ⚠️ **U36：名称不再被剥掉**——`/review 检查 @src/login.ts` 原样是提交内容，
      // 那一处引用**就排在句首**（`marker` ＝ `/review`），随正文一起进模型请求。
      if (!COMMANDS.some((command) => command.name === word)) {
        // ⚠️ **句首这个词上已经贴着一处绑好的引用 ⇒ 这一下就是提交**（U57 修 D32 第 4 步）。
        //
        // 当初这一行在「同名 ⇒ 展开候选」那一支里：名字分不出唯一时那一支会**再展开一遍
        // 选择器**，把用户刚挑好的那一处引用吃掉——请求一条都发不出去，而屏上看着像发出去了
        // （「按了没反应」最难查的那一形）。
        //
        // **U58 之后同名不再并存**（发现那一层只留一条，见 `skills.ts`）⇒ 那一支没了，
        // 这一行也就不该再挂在它底下：它守的本来就不是「同名」，而是一条**独立的不变量**——
        // 来源**用户已经指明过**（引用是带身份的），回车不该再问一遍。故提到这一层来，
        // 与「分不分得出唯一」无关。（`submittable` 已经在上面拦掉了「只有引用、没有交代」
        // 那一形，故这里走到的一定是有正话说的一次提交。）
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

      // ⚠️ **先落地、后发命令**——次序要紧：`send` 在进程内传输上是**同步**的，
      // 答复**当场**回来改视图；反过来（先发后 commit）这一次 `draft()` 拿的是
      // **发命令之前**的快照，会把答复刚写进去的东西整个盖掉。
      // 实测（真外壳 ＋ 真装配）：`/model` 的选择器就是这么开不出来的——
      // `model.catalog` 到了、`view.models` 也写上了，随即被盖回输入区。
      const { next, commands, leaving } = runSlash(view, text)
      draft(next)
      for (const command of commands) send(command)
      // `/exit`（U52）——**先落地、后动手**（同上面那条次序）：停止那一跳的答复有可能
      // **当场**回来（进程内传输是同步的），先 commit 再调它，答复改的那份视图才不会被
      // 这一跳的旧快照盖回去。
      return leaving ? beginExit() : NONE
    }

    return sendInput(text, placed)
  }

  /**
   * **候选里选定一条**（`Tab` 与「回车先选定」共用）。
   *
   * 两种归宿，按那一行是什么分：
   * - **内置命令** ⇒ 照旧补全文字（它是整行的操作入口，补完接着打参数）；
   * - **技能名** ⇒ **在词的原处放一句技能引用**（U36：带身份，不再只是几个字）。
   *
   * ⚠️ U57 那一手（同名 ⇒ 把候选栏上停的那一条原样带到「按来源挑一份」那一屏）随
   * 2026-09-25 的裁定退回：**同名在发现那一层只剩一条**，候选栏上一个名字也只剩一条行，
   * 「挑哪一份」这件事不再存在——选定就是选定，没有第二跳。
   */
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
    const arg = rest.join(' ')
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

    // —— 纯输出型：输出进记录区，**命令本身不回显** ——
    if (word === '/help') return only(appendOutput(cleared, HELP_TITLE, HELP_LINES))
    if (word === '/status') return only(appendOutput(cleared, STATUS_TITLE, statusLines(from)))

    // —— 交互配置型：记录区什么都不进 ——
    //
    // **会话那三条按动作命名**（U44 · 设计 · 命令行与配置）：`/session` 整条撤掉、不留别名
    // ——留了，那条实体入口就还在（这一改就成了改名字，不是改入口）。三条各自的性质：
    // `/clear` 清屏 ＋ 开一条新的（**回执就是清屏本身**，不另发文案）· `/resume` 回到之前
    // 某一条（空着回车＝列出可选）· `/rename <文本>` 改当下这条的名字。
    //
    // ⚠️ **这一族的意图每一条都重判一遍**：上一句留下的旗子不许落到下一句头上——
    // 故 `turn` 只在**真发得出那一跳**时置上（`/clear` 不带参数、`/resume` 真选定了一条），
    // 认不出的写法这一侧就回绝了，一个旗子都不留。
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
      // **一个字都不发**（回执就是清屏本身）——故 `label` 为 `null`：那一跳只翻页、不落字。
      //
      // ⚠️ **不是「一个字都不印」**（U45）：字标照种——`'new'` 那一格说的正是
      // 「这一页是**开一条新的**」。清屏说的是「旧的走了」，字标补的是另一半「新的来了」；
      // 少了它，这一屏只剩分隔线、输入行、状态行贴在屏顶，**看着像故障，不像开张**。
      // 两者都不算「文案」（`label` 仍旧是 `null`，回执那一格一个字都不添）。
      turn = { kind: 'new', label: null }
      return only(cleared, { type: 'session.new' })
    }

    if (word === '/resume') {
      if (arg === '') {
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

    // `/exit`（U52 · 设计 · 命令行与配置的会话入口表 ＋ 会话与运行管理的「离开、停止与
    // 异常退出」）——**停掉当前这条会话，资源确认退出之后才退界面**。
    //
    // ⚠️ **不挂 `exitArmed`**（那条是指向 Ctrl+C 的）。「按两次」那道门的由头是**同一个键
    // 在同一个状态下有时一次有时两次，用户没法预期**——`ctrl+c` 在「工作中＝中断／空闲＝
    // 退出」之间跳才需要它；`/exit` 是**打出来的词**，本来就已经是「有意的」，再要两下
    // 只是白费（设计原文）。它**补的正是那个缺**：想退出时，`ctrl+c` 在工作中只会中断，
    // 而「这条我不做了」此前没有说出口的地方。
    //
    // ⚠️ **这一跳只把意图带出去**（`leaving: true`），**退出不在这儿发生**：停一条会话要
    // 等管理者那条编排走完（`done` 才放行，见 `beginExit`）。
    //
    // ⚠️ **不带参数**（同 `/clear` 的姿势）：`/exit` 是个动作，不是一族动作的入口。
    // 多写的词如实回一句——**不静默吞**，也不当交代发出去。
    if (word === '/exit') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/exit（不带参数）'))
      // 本地这一下只有一个意图：停掉这条、然后走。**当场不留回执**——「停哪一条」那句话
      // 由停止编排那一头拼（`正在停「X」`），此处再印一句就是同一条事实说两遍
      // （设计：一屏上的提示各自说不同的东西）。
      return { next: cleared, commands: [], leaving: true }
    }

    // `/skills`（U33）——**交互配置型**：记录区什么都不进，只在左下开抽屉。
    // 与 `/model` 同一姿势：**先问一次目录**（答复是 `skills.catalog`），外壳据它铺行。
    // `/skills <词>` 拿那一段当预置筛词（敲完就直接筛到你说的那个词上）。
    if (word === '/skills') {
      waiting = 'skills'
      skillSeed = arg
      return only(cleared, { type: 'skills.list' })
    }

    // `/config`（U71 · 设计 · 命令行与配置「一个看得到『现在配成什么样』的入口」）——
    // **交互配置型**：记录区什么都不进，只在左下开一屏（四行：可配项 ＋ 它的当前值）。
    //
    // ⚠️ **三份读数一起问、齐了才开**（见 `configPending`）：四行里三行的当前值各有自己的
    //    读侧命令，缺哪一份那一格就只能写「还没问到」——而「不进去就知道现在是什么」
    //    正是这一屏的全部理由。
    //
    // ⚠️ **这一条自己不铺行、更不重造任何一件交互**：选中哪一行，就把那一条读侧命令
    //    **原样发出去**（与直接打 `/model` / `/grants` / `/mcp` 走同一条路，见 `submit`
    //    那一支）——设计：「选中之后进到它们本来的那一屏，行为逐字同形」。
    if (word === '/config') {
      if (arg !== '') return only(appendReceipt(cleared, '认得的用法：/config（不带参数）'))
      waiting = 'config'
      configPending = CONFIG_READINGS.length
      return only(cleared, ...CONFIG_READINGS.map((one) => one.command))
    }

    // `/model`（U41 改形）——**交互配置型**：主体是模型选择，另三个动作沿它展开
    // （设计：「不再新增一组按内部能力命名的 slash 命令」——动作挂在同一个入口下，
    // 写法照 `/mcp reconnect` 的既有姿势）。
    if (word === '/model') {
      // **这一趟挑的是谁**（U78）：在模型那一屏里按动作（「刷新模型」那一行）＝**留在同一趟**
      // ——它是那一屏的原地重铺，不该把作用对象换了；从输入行打 `/model` ＝**当前会话那一趟**
      // （不沿用上一屏留下的那个作用对象：那样 `/model` 会莫名其妙地开成「取网页」那一趟）。
      modelScope =
        from.dock.kind === 'picker' && from.dock.picker.source === 'model' ? modelScope : 'session'

      // **刷新**：显式意图可绕过时效（设计 · 刷新）。`provider` 缺省＝当前选中那条连接。
      // ⚠️ 按**完整命令词**认（同 `/mcp reconnect` 那条注：连接 id 可以长成 `refresh-2`）
      if (arg === 'refresh' || arg.startsWith('refresh ')) {
        const who = arg.slice('refresh'.length).trim()
        waiting = 'model'
        // 先回旧缓存那一屏、刷新完成再回一屏（契约这么定的）——两趟都归 `model.catalog`
        return only(cleared, who === '' ? { type: 'model.refresh' } : { type: 'model.refresh', provider: who })
      }

      // 不带参数 ⇒ **问一次连接一览**（读侧命令 `model.list`）：答复是 `model.catalog`，
      // 外壳据它铺选择器（连接 ＋ 各自缓存里的模型）并把 ④ 的分母定下来。
      // ⚠️ 原先是发空参的 `model.switch`、拿**失败的缘由**当列表说明——那不是读面
      //（以「换失败了」作答，还白落一笔 `model.switched`）。
      // **接入**：先问一次连接一览（要拿它算一个还没被占的连接 id——见 `freeIdOf`），
      // 答复到了再开「挑一家」那一屏。
      if (arg === 'connect') {
        waiting = 'connect'
        return only(cleared, { type: 'provider.list' })
      }

      // **管理**：先问一次连接一览，答复到了开「一览」那一屏（同一份行，两个读面共用）
      if (arg === 'manage') {
        waiting = 'manage'
        return only(cleared, { type: 'provider.list' })
      }

      if (arg === '') {
        waiting = 'model'
        return only(cleared, { type: 'model.list' })
      }

      // 认不出那个词 ⇒ **如实说一句**（不静默丢，也不当交代发出去）。
      // ⚠️ U41 起**取消了 `/model <条目>` 那条直达**：列表的取材从「配置条目」换成了
      // 「模型」——同一个词现在既可能是连接也可能是模型，按字面猜一个再切过去，
      // 猜错就是「换到了另一个模型上」而用户以为只是敲了个名字。
      return only(appendReceipt(cleared, `认得的用法：/model · /model refresh [连接] · /model connect · /model manage`))
    }

    // `/mcp`（U39）——**纯查询型**：记录区什么都不进，只在左下开抽屉。
    // 与 `/grants` 同一姿势：**先问一次**（答复是 `mcp.catalog`），外壳据它铺行。
    // `/mcp <名字>` 看那一台的明细；`/mcp reconnect <名字>` 显式重连（仍走启动授权，
    // 不重放业务调用）——重连之后答复照走 `mcp.catalog`，那一屏当场说清新状态。
    if (word === '/mcp') {
      // ⚠️ 按**完整命令词**认（`reconnect` / `reconnect <名字>`）：服务器名可以长成
      // `reconnect-db` 那样，`startsWith('reconnect')` 会把 `/mcp reconnect-db` 误当重连指令
      if (arg === 'reconnect' || arg.startsWith('reconnect ')) {
        const who = arg.slice('reconnect'.length).trim()
        if (who === '') return only(appendReceipt(cleared, '要重连哪一台？`/mcp reconnect <名字>`'))

        waiting = 'mcp'
        mcpServer = who
        return only(cleared, { type: 'mcp.reconnect', server: who })
      }

      waiting = 'mcp'
      mcpServer = arg
      return only(cleared, { type: 'mcp.list' })
    }

    // `/attachments`（U37）——**读侧 ＋ 两条动作**：记录区什么都不进，只在左下开抽屉。
    // 与 `/skills` 同一姿势：**先问一次**（答复是 `attachments.catalog`），外壳据它铺行。
    // 无参——问的就是「这条会话送过哪些图」（会话由内核按当下活跃那条绑）。
    if (word === '/attachments') {
      waiting = 'attachments'
      return only(cleared, { type: 'attachments.list' })
    }

    // `/grants`（U22 · B13）——**交互配置型**：记录区什么都不进，只在左下开抽屉。
    // 与 `/model` 同一姿势：**先问一次名录**（答复是 `grants.catalog`），外壳据它铺行。
    if (word === '/grants') {
      waiting = 'grants'
      return only(cleared, { type: 'grants.list' })
    }

    // 不认得的 slash——**如实说一句**（别静默丢，也别当交代发给模型）。
    // 顺口带上 `/skills`：它正是「我明明有个技能叫这个名」时该去的地方（U33）。
    return only(appendReceipt(cleared, `不认得的命令「${word}」——试试 /help，或到 /skills 里找`))
  }

  /** 草稿是不是已经**打全**了选中的那条命令。 */
  const isComplete = (from: ShellView): boolean => {
    const row = from.completion?.candidates[from.completion.selected]
    if (row === undefined) return false

    return from.draft.trim() === row.name
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
      draft({
        ...view,
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
    draft({ ...view, draft: entry.text, caret: entry.text.length, refs: entry.refs })
  }

  const said = (from: ShellView, message: string): ShellView => ({ ...from, flash: message })

  const readHistory = (session?: SessionId): void => {
    send(session === undefined ? { type: 'history.read' } : { type: 'history.read', session })
  }

  return {
    getView: () => view,

    subscribe: (listener) => {
      watchers.add(listener)

      return () => {
        watchers.delete(listener)
      }
    },

    key,
    hangUp,
    readHistory,

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

    dispose: () => {
      disposed = true
      if (pending !== undefined) clearTimeout(pending)
      pending = undefined
      // 「再按一次」那道门的钟（U68）——收摊之后它再来一下只是白叫醒一个没人看的屏
      stopExitClock()
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
