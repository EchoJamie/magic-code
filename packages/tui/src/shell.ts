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
 *    交互配置型（`/session` · `/model` · `/grants`）：**记录区什么都不进**，只在左下开选择器，
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
  ReasoningSetting,
  SessionId,
  SkillCatalogRow,
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
  appendReceipt,
  closePicker,
  createView,
  matchCommands,
  movePicker,
  openPicker,
  pathHint,
  pathRows,
  resolveSkill,
  sessionHint,
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
  reduce,
  withBanner,
  withContextWindow,
  withWindowTable,
} from './view.ts'
import {
  backspaceRange,
  deleteRange,
  insertText,
  markerOf,
  putRef,
  refStartingAt,
  removeRange,
  shiftedRefs,
  replaceWith,
  stepLeftOver,
  stepRightOver,
  wire,
} from './components/inline.ts'
import type { DraftRef } from './components/inline.ts'
import type {
  PromptState,
  ShellView,
  VendorOption,
  VendorRegionOption,
  WindowTable,
} from './view.ts'
import { leftSpan, rightSpan, stepLeft, stepRight } from './components/composer.ts'
import { isPrintable, tokenLabel, usageLabel } from './components/lines.ts'

// 建壳入参里用到的形态在视图那层（`view.ts`）——转出去，好让拿 `ShellOptions` 的人
// 一处就取全（`run.ts` 的 `RunTuiOptions` 正是这么取的）
export type { WindowTable }

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
   * **清单翻页**——把行视口挪到第 `top` 行（U34）。
   *
   * ⚠️ **收的是「到哪一行」而不是「翻几行」**：一页 ＝ 屏上放得下的那几行，而**列数、
   * 终端高度、交互区的高度账只有渲染那一层有**。故目标位置由渲染层按手里那一窗算好
   * （`plan.ts` 的 `planScrolled`：夹在两头之间），外壳只存不猜——同一条「拿不到的不编」。
   */
  | { readonly kind: 'planTop'; readonly top: number }
  | { readonly kind: 'paste'; readonly text: string }
  | { readonly kind: 'other'; readonly label: string }

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

/** 一次「等内核回话再开选择器」的意图——`/session` · `/model` · `/grants` · `/skills` 各一种。 */
type PendingPicker = 'session' | 'model' | 'grants' | 'skills' | 'mcp' | 'connect' | 'manage'


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

/** 建壳的入参（都可省——省了＝按「拿不到」办）。 */
export type ShellOptions = {
  /**
   * **上下文窗总量**（U20 · 差距 5）——状态行 ④ 的**开机那一格**分母（`12.4k/200k`）。
   *
   * 装配把**当下那一条的**数递进来（`Assembly.contextWindow`：配置声明或内置表，
   * 见 `resolveContextWindow`）；拿不到／没声明就不给 ⇒ `null` ⇒ 屏上只报已用量
   * ——不编、不猜、不改事件契约（见 `withContextWindow`）。
   *
   * ⚠️ 只管**开机那一刻**：外壳那时还不知道模型名，查不了表。此后的分母归
   * `windowTable`（下面那一格）。
   */
  readonly contextWindow?: number | null | undefined
  /**
   * **窗长表**（U30 · 形态见 `WindowTable`）——**换模型之后** ④ 的分母的取材。
   *
   * 装配把注册表那张表递进来（`Assembly.windowTable`：内置表按准确模型 id ＋ 各条目
   * **自己声明**的覆盖位）。`model.switched` / `model.call.start` 一到，外壳按**那一刻的
   * 选中**（条目 ＋ 模型两件）查：查得到就换分母，查不到＝`null`（**不沿用别的容量**）。
   *
   * **不给** ⇒ `null` ＝没有这张表：切换**不动分母**（旧路径原样，见 `ShellView.windowTable`）。
   */
  readonly windowTable?: WindowTable | undefined
  /**
   * **本进程的工作区**（U26）——`/session` 列表据它认「哪个是别的项目」
   * （分组头永远都有；**压暗**只落在判得实的那些：工作区记着、且与这一组不同）。
   *
   * 装配把执行域的 `roots()` 递进来（`realpath` 后的规范形 · 声明序）——与记录域
   * 构造时交出去的是**同一个值**：一头锚进记录、一头用于认路，两处同源。
   *
   * **不给＝不知道自己在哪儿** ⇒ 一组都不压暗（「拿不到的不编」——同 `contextWindow`）。
   */
  readonly workspaceRoots?: readonly string[] | undefined
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
  // ④ 的两件一起种：**开机那一格**的数（`contextWindow`）＋ **此后切换**查的那张表
  // （`windowTable` · U30）——两者分工见 `ShellOptions`。
  let view = withBanner(
    withWindowTable(withContextWindow(createView(), options.contextWindow ?? null), options.windowTable ?? null),
  )

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

  /** 等回话的选择器意图（`/session` / `/model` / `/grants` / `/skills` 各问一次）。 */
  let waiting: PendingPicker | null = null

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
   * `/mcp <名字>` 的**预置那一台**——只在「等外部服务器一屏」那一趟有效（答复到了交给抽屉）。
   * 空串＝总览那一屏（`/mcp` 无参）。
   */
  let mcpServer = ''

  /**
   * `/skills <词>` 的**预置筛词**——只在「等技能目录」那一趟有效（答复到了交给抽屉）。
   *
   * 同时也是**同名直达分不出唯一时的入口**：那时拿技能名当筛词开同一扇抽屉
   * （见 `submit` 里 `hit.kind === 'many'` 那一支）——一套机制两处用，
   * 不另造一个「同名候选」界面。
   */
  let skillSeed = ''

  /**
   * 同名那一路的**取材范围**（`/<名字>` 在同一档里分不出唯一时给）——`null` ＝ 全目录。
   *
   * 为什么不拿「筛词＝名字」当同一件事：筛词是**子串**匹配，`pdf` 会把 `pdftools` 和
   * 「简述里提到 pdf」的都筛进来——那样子挑出来的那份名字与草稿里那个斜杠词**对不上**，
   * 剥正文会落空、再按回车又回到同一个岔口。同名就是同名：范围在这里**钉死**。
   */
  let skillScope: readonly SkillCatalogRow[] | null = null

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
    commit(reduce(view, event), STREAMING.has(event.kind))

    if (event.kind === 'session.state') {
      // 换了会话 ⇒ 记录区已清空（`reduce` 里做）＋ 主动读一次历史（D1：换一条＝换一屏）
      if (before !== null && before !== event.data.active) readHistory(event.data.active)
      if (waiting === 'session') {
        waiting = null
        openSessionPicker()
      }
    }

    // 连接一览回来了 ⇒ 两件（U41）：
    // ① **正等着开抽屉**（`/model` 那条路）：开；0 行时 `openPicker` 会把说明落成一行回执；
    // ② **抽屉已经开着**（`/model refresh` 那一路，或刷新回来的第二屏）：**就地重铺**
    //    ——设计：「刷新只更新信息，**不抢走列表当前焦点**、不清草稿、不写回默认」。
    //    故重铺要保住当前选中那一行（`refreshModelPicker` 里做），且**不关抽屉**。
    if (event.kind === 'model.catalog') {
      if (waiting === 'model') {
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
      if (waiting === 'connect') {
        waiting = null
        openVendorPicker()
      } else if (waiting === 'manage') {
        waiting = null
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

    // 提交**没收下** ⇒ 按原 pairing 键认回那份草稿（U33）。回执那半行由 `reduce` 落
    // （「没送出：…」），这里只管草稿那几件——正文 · 插入点 · 它里面的引用。
    if (event.kind === 'input.settled' && !event.data.ok) restoreDraft(event.data.ref)

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
  }

  const unsubscribeTransport = transport.subscribe(onEvent)

  // —— 选择器 ——

  /** `/session`——目录已到手，开它（行：按工作区分组，U26——见 `sessionRows`）。 */
  const openSessionPicker = (): void => {
    const rows = sessionRows(view.catalog, view.sessionId, options.workspaceRoots)
    // 下方那行说明：**空态优先**（「还没有会话」比「这儿是哪儿」更该先知道）；
    // 否则本工作区一条都没有时报一句「这儿是哪儿」——整表皆暗时那是唯一说得通的话（U27）
    const hint =
      rows.length === 0
        ? '还没有落过账的会话——交代一句就开张'
        : sessionHint(view.catalog, options.workspaceRoots)

    commit(
      openPicker(view, {
        source: 'session',
        // 选中项＝**当前那条**——分组之后行序变了，故在**分好组的行**里找它
        selected: Math.max(0, rows.findIndex((row) => row.value === view.sessionId)),
        rows,
        ...(hint === undefined ? {} : { hint }),
      }),
    )
  }

  /**
   * `/grants`（U22 · B13）——名录已到手，开抽屉：**与 `/session` · `/model` 同位置同开合**
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

    commit(closePicker(next))
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

    const lines = [
      `连接 ${entry.provider}`,
      `默认模型 ${entry.model ?? '还没选过'}`,
      `缓存 ${cacheLabelOf(entry)}`,
      ...(entry.baseURL === undefined ? [] : [`地址 ${entry.baseURL}`]),
    ]

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

      case 'left':
        editAsk(held.value, stepLeft(held.value, held.caret))
        return NONE

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
  const openRegionPicker = (vendor: VendorOption): void => {
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
  const askKeyFor = (vendor: VendorOption, region: VendorRegionOption | undefined): void => {
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
    const rows = modelRows(view.models, view.modelCurrent)

    commit(
      openPicker(view, {
        source: 'model',
        // 落在**此刻会走的那一条**上（没有去向就从头起——不拿首项冒充当前）
        selected: Math.max(0, rows.findIndex((row) => row.current)),
        rows,
        hint: modelHint(view.models, note === '' ? undefined : note),
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
    const rows = modelRows(view.models, view.modelCurrent)
    const hint = modelHint(view.models, note === '' ? undefined : note)

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
   */
  const openSkillsPicker = (filter: string, anchor: { readonly start: number; readonly end: number }): void => {
    const catalog = view.skills
    const rows = skillRows(skillScope ?? catalog?.skills ?? [], filter)

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
   * **一次提交**（U33 起，U36 改形）——正文 ＋ 它里面的引用 ＋ 配对键，三件一起交给内核。
   *
   * 三条写在一处：
   * - **正文原样**（引用那几个字**留在原处**、**内部换行留着**）——前后文字指向哪件事，
   *   靠的就是这个次序；`/session`、绝对路径写在正文里仍只是正文（不递归解析斜杠）；
   * - **引用随这一份**（`refs`）：每处带**位置 ＋ 身份**，内核按身份取材料，取不到就
   *   **这一条不跑**（不换同名项、不忽略它继续）——文件读不了与技能取不到同一条出口；
   * - **配对键**（`ref`）：`input.settled` 按它认回这份草稿（失败时原样还回来，见 `restoreDraft`）。
   */
  const sendInput = (text: string, refs: readonly DraftRef[]): ShellEffect => {
    submits += 1
    const ref = `draft-${submits}`
    lastSubmit = { ref, text, refs }

    const cleared: ShellView = { ...view, draft: '', caret: 0, refs: [] }
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
   * **按原 ref 认回原稿**——失败那一条交出去的正文与引用，回到草稿上（原型：草稿不丢）。
   *
   * 三条分寸：
   * - **只认自己交出去的那一份**（`ref` 对不上、或没有等着认领的＝不是这一次，不动）；
   * - **用户动过草稿就不认**（`edit` 已经把 `lastSubmit` 清了）——那正是「不覆盖后来编辑的新稿」；
   * - **认领一次就清掉**：同一份不会被两条失败各还一遍。
   *
   * 回执（「没送出：…」那一行）由 `reduce` 落——它说的是**这一次交代没出去**，
   * 本函数只管把草稿那几件还回来（正文 · 插入点 · 引用）。
   */
  const restoreDraft = (ref: string | undefined): void => {
    // 名字避开外面那个 `waiting`（等选择器的意图）——两件不相干的事，别撞名
    const held = lastSubmit
    if (held === null || ref === undefined || held.ref !== ref) return

    lastSubmit = null
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

  const exitOrInterrupt = (): ShellEffect => {
    const busy = view.status.state === 'working' || view.status.state === 'retrying'

    if (busy || view.dock.kind === 'decision') {
      send({ type: 'turn.interrupt' })
      return NONE
    }

    return EXIT
  }

  const key = (input: ShellKey): ShellEffect => {
    if (disposed) return NONE

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
        // 选择器开着 ⇒ 收起（**不留痕迹**）；`@` 那一栏另把「还只是查询、没成引用」的那一段
        // 从草稿里撤回（设计：「取消归还原稿及选区」——那一段本来就不算用户说的话）。
        if (view.dock.kind === 'picker') {
          const anchor = view.dock.picker.source === 'paths' ? view.dock.picker.anchor : undefined
          commit(closePicker(view))
          if (anchor !== undefined) eraseAt(anchor.start, anchor.end)
          return NONE
        }
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
          return NONE
        }
        if (view.completion !== null) pickCompletion()
        return NONE

      case 'enter':
        return submit()

      case 'left':
        if (view.dock.kind === 'decision') return refuse('左移')
        if (view.dock.kind === 'picker') return NONE
        // **草稿一个字都不动**（只挪插入点）⇒ 不走 `edit()`：翻出来的历史还认得上一条。
        // 插入点挨着一处引用时**整处跨过去**（引用是一个编辑单位，见 `inline.ts`）。
        commit({ ...view, caret: stepLeftOver(view.refs, view.draft, caretAt()) })
        return NONE

      case 'right':
        if (view.dock.kind === 'decision') return refuse('右移')
        if (view.dock.kind === 'picker') {
          // **`→` ＝ 看这一条的详情**（U41）——只有模型那一屏给了这个键（别的抽屉没有「详情」
          // 这回事，故它们的左右照旧什么都不做，见列表下方那行说明）
          if (view.dock.picker.source === 'model') {
            const pick = picked(view)?.pick
            if (pick !== undefined) openModelDetail(pick)
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
      if (pending.weight === 'heavy') {
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

      if (view.dock.picker.source === 'session') {
        send({ type: 'session.open', session: row.value })
        // **选定后留一行回执**（原型 · 场景 10）；切过去之后重建由 `session.state` 触发
        commit(appendReceipt(closePicker(view), `已切到 ${row.label}`))
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

      // 外部服务器那一屏（U39）：**纯读**——回车不改变任何东西（重连是另一条命令，
      // 明写 `/mcp reconnect <名字>`）。留着这一支是**必须**的：不然它会落到下面的换模型上。
      if (view.dock.picker.source === 'mcp') return NONE

      // 模型详情那一屏（U41）：两件动作
      if (view.dock.picker.source === 'model-detail') {
        if (row.value === 'reasoning') openReasoningPicker(detailAt)
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

        askKeyFor(pickedVendor, region)
        return NONE
      }

      // 模型那一屏（U41）：两类行。
      // ① **入口行**（列表末尾那几条，`modelRows` 铺的）——动作就在这一屏里做，不必另打命令；
      // ② **模型行**——选定＝切到这条连接的这个精确模型（两件一起给——合法的两条连接
      //    可以有同名模型，只报模型名认不出是谁）。回执由内核的 `model.switched` 给。
      if (view.dock.picker.source === 'model') {
        if (row.pick === undefined) return modelAction(row.value)

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
        const hit = resolveSkill(word.slice(1), view.skills?.skills ?? [])

        // 同一档里分不出唯一 ⇒ **展开同名候选让用户点**（不静默随目录顺序挑一个）——
        // 草稿**原样留着**，锚点就定在那个词上（选定即把它换成 `/名称` 并绑上身份）。
        if (hit.kind === 'many') {
          skillScope = hit.skills
          openSkillsPicker(word.slice(1), { start: 0, end: word.length })
          return NONE
        }

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
          // 已经绑过的（先前从候选里选过一次）不重复绑。
          const bound = refStartingAt(placed, 0) !== undefined
            ? placed
            : putRef(placed, {
                kind: 'skill',
                marker: `/${hit.skill.name}`,
                name: hit.skill.name,
                source: hit.skill.path,
                start: 0,
                end: word.length,
              })

          return sendInput(text, bound)
        }
      }

      // ⚠️ **先落地、后发命令**——次序要紧：`send` 在进程内传输上是**同步**的，
      // 答复**当场**回来改视图；反过来（先发后 commit）这一次 `draft()` 拿的是
      // **发命令之前**的快照，会把答复刚写进去的东西整个盖掉。
      // 实测（真外壳 ＋ 真装配）：`/model` 的选择器就是这么开不出来的——
      // `model.catalog` 到了、`view.models` 也写上了，随即被盖回输入区。
      const { next, commands } = runSlash(view, text)
      draft(next)
      for (const command of commands) send(command)
      return NONE
    }

    return sendInput(text, placed)
  }

  /**
   * **候选里选定一条**（`Tab` 与「回车先选定」共用）。
   *
   * 两种归宿，按那一行是什么分：
   * - **内置命令** ⇒ 照旧补全文字（它是整行的操作入口，补完接着打参数）；
   * - **技能名** ⇒ **在词的原处放一句技能引用**（U36：带身份，不再只是几个字）——
   *   同名两份分不出唯一时展开抽屉让用户按来源挑（草稿原样留着，锚点定在那个词上）。
   */
  const pickCompletion = (): void => {
    const row = view.completion?.candidates[view.completion.selected]
    const word = activeWordOf(view.draft, view.caret)
    if (row === undefined || word === undefined) return

    if (COMMANDS.some((command) => command.name === row.name)) {
      commit(applyCompletion(view))
      return
    }

    const hit = resolveSkill(row.name.slice(1), view.skills?.skills ?? [])

    if (hit.kind === 'many') {
      skillScope = hit.skills
      openSkillsPicker(row.name.slice(1), { start: word.start, end: word.end })
      return
    }

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
  ): { readonly next: ShellView; readonly commands: readonly Command[] } => {
    const [word, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ')
    // 命令把这一行整个吃掉了（交互配置型不带正文）——**引用也跟着走**：
    // 它们指向的那段文字已经不在草稿里了（留着就是「正文没了、材料还在」的暗带）。
    const cleared: ShellView = { ...from, draft: '', caret: 0, refs: [] }
    /** 本地这一下的改动 ＋ 待发的命令——两件一起交回调用方（它决定次序）。 */
    const only = (next: ShellView, ...commands: Command[]): { next: ShellView; commands: readonly Command[] } => ({
      next,
      commands,
    })

    // —— 纯输出型：输出进记录区，**命令本身不回显** ——
    if (word === '/help') return only(appendOutput(cleared, HELP_TITLE, HELP_LINES))
    if (word === '/status') return only(appendOutput(cleared, STATUS_TITLE, statusLines(from)))

    // —— 交互配置型：记录区什么都不进 ——
    if (word === '/session') {
      if (arg === '' || arg === 'list') {
        waiting = 'session'
        return only(cleared, { type: 'session.list' })
      }
      // **没有回执**（D28甲）：新建说的是「存储什么时候发生」，答不出「影响用户的哪个动作」；
      // 而它在首条消息之前既不上屏也不落库（D5）。换会话那一路的重建归 `session.state`。
      if (arg === 'new') return only(cleared, { type: 'session.new' })
      if (arg === 'title' || arg.startsWith('title ')) {
        const title = arg.slice('title'.length).trim()
        if (title === '' || from.sessionId === null) {
          return only(appendReceipt(cleared, '要改成什么？`/session title <文本>`'))
        }
        return only(cleared, { type: 'session.rename', session: from.sessionId, title })
      }

      return only(appendReceipt(cleared, '认得的用法：/session · /session new · /session title <文本>'))
    }

    // `/skills`（U33）——**交互配置型**：记录区什么都不进，只在左下开抽屉。
    // 与 `/model` 同一姿势：**先问一次目录**（答复是 `skills.catalog`），外壳据它铺行。
    // `/skills <词>` 拿那一段当预置筛词（敲完就直接筛到你说的那个词上）。
    if (word === '/skills') {
      waiting = 'skills'
      skillSeed = arg
      // 这是**浏览面**：从头看全目录，不是「同名挑一份」那一摊
      skillScope = null
      return only(cleared, { type: 'skills.list' })
    }

    // `/model`（U41 改形）——**交互配置型**：主体是模型选择，另三个动作沿它展开
    // （设计：「不再新增一组按内部能力命名的 slash 命令」——动作挂在同一个入口下，
    // 写法照 `/session new` · `/mcp reconnect` 的既有姿势）。
    if (word === '/model') {
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
      unsubscribeTransport()
      watchers.clear()
    },
  }
}
