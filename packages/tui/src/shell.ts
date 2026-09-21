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

import type {
  Command,
  ControlTransport,
  Entry,
  EventKind,
  KernelEvent,
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
  REMOVE_SKILL,
  appendEcho,
  appendOutput,
  appendReceipt,
  closePicker,
  createView,
  matchCommands,
  movePicker,
  openPicker,
  resolveSkill,
  sessionHint,
  grantsHint,
  grantsRows,
  sessionRows,
  skillHint,
  skillRows,
  picked,
  rebuild,
  reduce,
  withBanner,
  withContextWindow,
  withWindowTable,
} from './view.ts'
import { leftSpan, rightSpan, stepLeft, stepRight } from './components/composer.ts'
import { usageLabel } from './components/lines.ts'
import type { BoundSkill, ShellView, WindowTable } from './view.ts'

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
type PendingPicker = 'session' | 'model' | 'grants' | 'skills'

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

/** 剥过之后的那份草稿——**正文** ＋ 它在原草稿里的起点（见 `stripSkillWord`）。 */
type StrippedBody = {
  readonly body: string
  /**
   * 正文在原草稿里的**起点**——原草稿里下标 `n` 那个位置，在正文里是 `n - at`。
   *
   * 为什么要把这个数交出来：**插入点要跟着左移**。不搬的话，用户刚在正文中间打的字，
   * 选完技能接着打就落到尾巴上去了（真 PTY 反例：`/twins abc|d` 选完再打 `Z` 得到
   * `abcdZ`，而不是原位的 `abcZd`）。
   */
  readonly at: number
}

/**
 * 把草稿开头那个 `/名字` 剥掉，留下**正文**（不是那个形态就原样交回，`at: 0`）。
 *
 * 三件是工单写死的（「直接命令后面的正文（含换行、绝对路径、`/session` 字样）不重复
 * 解析成控制命令」）：
 * - **只认第一个词**——剥掉它之后**全算正文**，故正文里的 `/session`、绝对路径、
 *   换行都原样留着（不再递归解析斜杠）；
 * - **内部换行保留**：只削掉「斜杠词与其后正文之间」那一段分隔空白，不 `join(' ')`
 *   （那会把用户按下 `shift+回车` 打的换行抹平——多行交代当场变成一行）；
 * - **名字对不上就不剥**（原样交回）：剥了名不副实的一截，等于替用户改了他写的话。
 *
 * 正文是原草稿的**一段后缀**，故起点直接用长度差算得——不必再记一遍剥离过程的账
 * （两处各记一遍，迟早分家）。
 */
function stripSkillWord(draft: string, name: string): StrippedBody {
  const head = draft.replace(/^\s+/, '')
  const word = /^\/\S+/.exec(head)
  if (word === null || word[0] !== `/${name}`) return { body: draft, at: 0 }

  const body = head.slice(word[0].length).replace(/^\s+/, '')

  return { body, at: draft.length - body.length }
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

  /** 输入历史（`↑` 取上一条）。 */
  const history: string[] = []
  let historyAt = -1

  /** 重建的攒块——按 `session.history` 的 `data.session` 分（不是当下那条的直接丢）。 */
  let rebuildFor: SessionId | null = null
  let rebuildEntries: Entry[] = []

  /** 等回话的选择器意图（`/session` / `/model` / `/grants` / `/skills` 各问一次）。 */
  let waiting: PendingPicker | null = null

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
   * **刚交出去的那一份草稿**——配对键 ＋ 正文 ＋ 绑的技能。`null` ＝ 没有等着认领的。
   *
   * 两个时机把它清掉：用户**动过草稿**（`edit` 里清——「失败不覆盖后来编辑的新稿」
   * 正落在这条）· 已经认领过一次（同一份不会被两条失败各还一遍）。
   */
  let lastSubmit: {
    readonly ref: string
    readonly text: string
    readonly bound: BoundSkill | null
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

    const found = matchCommands(next.draft, next.skills?.skills ?? [])
    // **封顶在列、报数在右位**（见 `MAX_CANDIDATES`）：截掉几条不静默——状态行说得出
    // 「还有 N 条」，而想浏览全量走 `/skills`（那才是浏览面，这一栏只是边打边认的辅助）。
    const candidates = found.slice(0, MAX_CANDIDATES)
    const open = candidates.length > 0

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
    if (!from.draft.startsWith('/')) return

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

  /** 在插入点处改草稿的**唯一口子**——改完插入点跟着落（越界夹回）。 */
  const editAt = (next: string, caret: number): void => {
    edit({ ...view, draft: next, caret: Math.max(0, Math.min(caret, next.length)) })
  }

  /** 插入点处插一段（打字 / 粘贴 / 换行共用）——插入点落在插进去的那一段**之后**。 */
  const insertAt = (text: string): void => {
    const at = caretAt()

    editAt(view.draft.slice(0, at) + text + view.draft.slice(at), at + text.length)
  }

  /** 抹掉 `[from, to)` 那一段（退格 / 删除共用）——插入点落到 `from`。 */
  const eraseAt = (from: number, to: number): void => {
    editAt(view.draft.slice(0, from) + view.draft.slice(to), from)
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

    // 条目表回来了 ⇒ 开选择器（`/model` 不带参数的那条路）。说明取 `note`——
    // 只在有事要说时给（如「本次装配没有供应商注册表」），不给＝表自明。
    if (event.kind === 'model.catalog' && waiting === 'model') {
      waiting = null
      openModelPicker(event.data.note ?? '')
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
        openSkillsPicker(skillSeed)
      }
    }

    // 提交**没收下** ⇒ 按原 pairing 键认回那份草稿（U33）。回执那半行由 `reduce` 落
    // （「没送出：…」），这里只管草稿那三件——正文 · 插入点 · 绑着的技能。
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
   * `/model`——**条目表不在事件里**（契约没有读侧），故列表只有「见过的 ＋ 当前那条」，
   * 而内核回话里的缘由（它本就列出已注册的名字）作列表下方的说明 ✓ 不解析、只照贴。
   */
  const openModelPicker = (note: string): void => {
    const current = view.status.model
    // **取材＝`model.catalog` 的全量条目**（D10）——不是「边看边攒」的那些：
    // 攒的那些只认得**这趟会话调过 / 换过**的条目，注册表里没碰过的一律列不出来。
    const rows = view.models.map((entry) => ({
      label: entry.provider,
      meta: entry.model,
      current: entry.model === current,
      value: entry.provider,
    }))

    commit(
      openPicker(view, {
        source: 'model',
        selected: Math.max(0, rows.findIndex((row) => row.current)),
        rows,
        hint: note === '' ? '也可直接打 `/model <条目>`' : note,
      }),
    )
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
  const openSkillsPicker = (filter: string): void => {
    const catalog = view.skills
    const rows = skillRows(skillScope ?? catalog?.skills ?? [], view.bound, filter)

    commit(
      openPicker(view, {
        source: 'skills',
        selected: 0,
        rows,
        filter,
        hint: skillHint({ catalog, filter, shown: rows.length, hasBound: view.bound !== null }),
      }),
    )
  }

  /**
   * **选定一份技能 ⇒ 只绑草稿**（工单：「选择只绑定草稿，保留正文/光标」）。
   *
   * 三件同时成立才是对的：
   * - **不加载主文、不发模型请求**（绑的是 `SkillRef`——两件身份，见契约），
   *   真实提交那一刻内核才按身份取；
   * - **不发送**（按回车确认一个选择，不该顺手把草稿发出去——工单：「按确认选择不同时误发草稿」）；
   * - **正文与插入点照旧**，只把斜杠那一行的正文剥出来（从 `/<名字> <交代>` 走进来时，
   *   那一截已经成了提交内容，留在草稿里就成了「重复解析」）。
   */
  const bindSkill = (skill: SkillCatalogRow): void => {
    const cut = stripSkillWord(view.draft, skill.name)
    // **插入点跟着剥离左移**（见 `StrippedBody.at`）——它在正文里的位置是「原来那个减掉
    // 被剥掉的那一截」，夹回 `[0, 正文长]`：插入点若正落在被剥掉的那一段里
    // （`/tw|ins`），落到正文开头（那一格已经不在屏上了，就近落脚最不意外）。
    // ⚠️ **不摆到末尾**——「选定只绑草稿，保留正文/光标」里的那个「光标」就是这一行。
    const caret = Math.max(0, Math.min(view.caret - cut.at, cut.body.length))

    commit(
      withCompletion({
        ...closePicker(view),
        bound: { ref: { name: skill.name, path: skill.path }, label: skill.label },
        draft: cut.body,
        caret,
      }),
    )
  }

  /**
   * **一次提交**（U33）——正文 ＋ 绑着的技能 ＋ 配对键，三件一起交给内核。
   *
   * 三条写在一处：
   * - **正文原样**（`/<名字>` 那一截已剥掉、**内部换行留着**）——其后全部是正文，
   *   不再当斜杠命令解析（正文里写 `/session`、绝对路径都只是正文）；
   * - **技能随这一份**（`skills`）：内核按身份取主文，取不到就**这一条不跑**
   *   （不换同名项、不忽略它继续）；
   * - **配对键**（`ref`）：`input.settled` 按它认回这份草稿（失败时原样还回来，
   *   见 `restoreDraft`）。
   */
  const sendInput = (text: string, bound: BoundSkill | null): ShellEffect => {
    submits += 1
    const ref = `draft-${submits}`
    lastSubmit = { ref, text, bound }

    const cleared: ShellView = { ...view, draft: '', caret: 0, bound: null }
    // 历史记的是**输入行里那一串**（不是剥过之后的正文）：`↑` 翻回来再按一次回车，
    // 技能照旧认得到——「我刚才打的那一句」原样回来才是历史该有的样子。
    const typed = view.draft.trim()
    if (history[history.length - 1] !== typed) history.push(typed)
    historyAt = -1

    // ⚠️ **先落地、后发命令**（D23 那条次序）——进程内传输是同步直连的，
    // 反过来的话这次 `draft()` 拿的是发命令**之前**的快照，会把答复刚写进去的东西盖掉。
    draft(appendEcho(cleared, text))
    send({
      type: 'input.submit',
      text,
      ref,
      ...(bound === null ? {} : { skills: [bound.ref] }),
    })

    return NONE
  }

  /**
   * **按原 ref 认回原稿**——失败那一条交出去的正文与技能，回到草稿上（原型：草稿不丢）。
   *
   * 三条分寸：
   * - **只认自己交出去的那一份**（`ref` 对不上、或没有等着认领的＝不是这一次，不动）；
   * - **用户动过草稿就不认**（`edit` 已经把 `lastSubmit` 清了）——那正是「不覆盖后来编辑的新稿」；
   * - **认领一次就清掉**：同一份不会被两条失败各还一遍。
   *
   * 回执（「没送出：…」那一行）由 `reduce` 落——它说的是**这一次交代没出去**，
   * 本函数只管把草稿那三件还回来（正文 · 插入点 · 技能）。
   */
  const restoreDraft = (ref: string | undefined): void => {
    // 名字避开外面那个 `waiting`（等选择器的意图）——两件不相干的事，别撞名
    const held = lastSubmit
    if (held === null || ref === undefined || held.ref !== ref) return

    lastSubmit = null
    // 插入点摆到末尾（那一份交出去时多半已经打完了）；技能原样挂回去
    commit(
      withCompletion({
        ...view,
        draft: held.text,
        caret: held.text.length,
        bound: held.bound,
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

    switch (input.kind) {
      case 'ctrl+c':
        return exitOrInterrupt()

      case 'ctrl+o':
        commit({ ...view, expanded: !view.expanded })
        return NONE

      case 'paste':
        if (view.dock.kind === 'decision') {
          commit(said(view, '先答复——此刻粘不了（这一轮在等你）。草稿在，答完接着打。'))
          return NONE
        }
        insertAt(input.text)
        return NONE

      case 'escape':
        if (view.dock.kind === 'picker') return (commit(closePicker(view)), NONE)
        if (view.dock.kind === 'decision') return NONE // 接管期间 `esc` **无动作**
        // 候选开着 ⇒ 先**收起候选**（原型：`esc` 收起；草稿留着）
        if (view.completion !== null) return (commit({ ...view, completion: null }), NONE)
        // **绑着技能 ⇒ 先摘技能**（U33）——`esc` 本来就是「一层一层往回退」：收起候选 →
        // 摘掉材料 → 清掉正文。技能是这条草稿上**最后挂上去的材料**，故排在正文之前。
        //
        // 为什么需要这一层：`/skills` 那条路要求草稿**以 `/skills` 开头**（斜杠命令的老姿势），
        // 而「正文已经打了、这时想摘掉技能」正是要保住正文的那个场景——没有这一层，
        // 那条需求（工单：「移除技能保留正文」）在终端上根本走不到。
        // ⚠️ **只摘材料，一个字都不动正文**；再按一次 `esc` 才是清正文。
        if (view.bound !== null) return (commit(withCompletion({ ...view, bound: null })), NONE)
        if (view.draft === '') {
          edit({ ...view, expanded: false })
          return NONE
        }
        editAt('', 0)
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
        if (view.dock.kind === 'input' && view.completion !== null) commit(applyCompletion(view))
        return NONE

      case 'enter':
        return submit()

      case 'left':
        if (view.dock.kind === 'decision') return refuse('左移')
        if (view.dock.kind === 'picker') return NONE
        // **草稿一个字都不动**（只挪插入点）⇒ 不走 `edit()`：翻出来的历史还认得上一条
        commit({ ...view, caret: stepLeft(view.draft, caretAt()) })
        return NONE

      case 'right':
        if (view.dock.kind === 'decision') return refuse('右移')
        if (view.dock.kind === 'picker') return NONE
        commit({ ...view, caret: stepRight(view.draft, caretAt()) })
        return NONE

      case 'backspace':
        if (view.dock.kind === 'decision') return refuse('退格')
        // 技能抽屉里退格＝**放宽筛选**（打字那一支的对面；按字素删，中文也删得对）
        if (view.dock.kind === 'picker') {
          if (view.dock.picker.source !== 'skills') return NONE
          const filter = view.dock.picker.filter ?? ''
          openSkillsPicker(filter.slice(0, leftSpan(filter, filter.length)[0]))
          return NONE
        }
        eraseAt(...leftSpan(view.draft, caretAt()))
        return NONE

      // 前向删除（`delete` 键）——删插入点右边那一个字素（不同键、同一套插入点）
      case 'delete':
        if (view.dock.kind === 'decision') return refuse('删除')
        if (view.dock.kind === 'picker') return NONE
        eraseAt(...rightSpan(view.draft, caretAt()))
        return NONE

      case 'char':
        if (view.dock.kind === 'decision') return answer(input.char)
        // 技能抽屉里打字＝**筛**（U33：`/skills` 的搜索）——其余选择器照旧：接管期间字符吞掉
        if (view.dock.kind === 'picker') {
          if (view.dock.picker.source !== 'skills') return NONE
          openSkillsPicker((view.dock.picker.filter ?? '') + input.char)
          return NONE
        }
        insertAt(input.char)
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

      // 技能抽屉（U33）：选定＝**绑草稿**（不发送、不加载主文）；「移除当前技能」那一行
      // 选定＝**摘掉绑定**（正文一个字不动）——两件都不发命令，故没有回执，
      // 屏上的凭据是草稿那一行（出现 / 消失）。
      if (view.dock.picker.source === 'skills') {
        if (row.value === REMOVE_SKILL) {
          commit(withCompletion({ ...closePicker(view), bound: null }))
          return NONE
        }

        const chosen = view.skills?.skills.find((one) => one.path === row.value)
        // 找不到＝目录在这一屏开着的时候被换掉了（理论上不会：抽屉开着不发查询）。
        // 照实收起抽屉、什么都不绑，不拿一个编出来的身份凑数。
        if (chosen === undefined) return (commit(closePicker(view)), NONE)

        bindSkill(chosen)
        return NONE
      }

      // 换模型：回执由内核的 `model.switched` 事件给（那才是真结果，不由外壳先报）
      send({ type: 'model.switch', provider: row.value })
      commit(closePicker(view))
      return NONE
    }

    // 候选开着 ⇒ 回车**先补全**（原型 · 场景 11）；**已经打全了就直接发**
    // （全名再补一次＝只多一个空格，却要人多按一次回车——参照物不这么做）
    if (view.completion !== null && !isComplete(view)) {
      commit(applyCompletion(view))
      return NONE
    }

    const text = view.draft.trim()
    if (text === '') return NONE

    if (text.startsWith('/')) {
      const word = text.split(/\s+/)[0] ?? ''

      // **技能直达 ＞ 不认得的命令**（U33）：内置那五条**先让给 slash**（工单：内置命令
      // 保留含义，同名技能仍能从 `/skills` 选），其余 `/名字` 才按技能名解析。
      // `/名字` 与 `/名字 交代` 都是这一条路：后者把其后那一段当正文（`sendInput` 剥）。
      if (!COMMANDS.some((command) => command.name === word)) {
        const hit = resolveSkill(word.slice(1), view.skills?.skills ?? [])

        // 同一档里分不出唯一 ⇒ **展开同名候选让用户点**（不静默随目录顺序挑一个）——
        // 草稿**原样留着**：选定之后由 `bindSkill` 把其后那一段剥成正文。
        if (hit.kind === 'many') {
          skillScope = hit.skills
          openSkillsPicker(word.slice(1))
          return NONE
        }

        if (hit.kind === 'one') {
          const body = stripSkillWord(view.draft, hit.skill.name).body

          // **只输入了名称**（`/pdf` 后面没有正文）＝**只绑定草稿**（设计：「选定或仅输入名称
          // 时只绑定草稿，后面的正文仍可编辑」）——此刻一个模型请求都不发，用户接着补交代。
          // 空正文**不提交**还有一条由头：一次交代里一个字都没有，内核那边落下的会是一条
          // 「用户什么都没说、但带了份技能」的条目（`user` 条目 ＋ 载荷），那不是交代。
          if (body === '') {
            bindSkill(hit.skill)
            return NONE
          }

          return sendInput(body, {
            ref: { name: hit.skill.name, path: hit.skill.path },
            label: hit.skill.label,
          })
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

    return sendInput(text, view.bound)
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
    const cleared: ShellView = { ...from, draft: '', caret: 0 }
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
      if (arg === 'new') {
        return only(appendReceipt(cleared, '已新建一条会话（首条消息按下回车才落库）'), {
          type: 'session.new',
        })
      }
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

    if (word === '/model') {
      if (arg !== '') return only(cleared, { type: 'model.switch', provider: arg })

      // 不带参数 ⇒ **问一次条目表**（D10 的读侧命令 `model.list`）：答复是 `model.catalog`，
      // 外壳据它铺选择器（**全量**，含从未调用过的条目）并把 ④ 的分母定下来。
      // ⚠️ 原先是发空参的 `model.switch`、拿**失败的缘由**当列表说明——那不是读面
      //（以「换失败了」作答，还白落一笔 `model.switched`）。
      waiting = 'model'
      return only(cleared, { type: 'model.list' })
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

  const recallHistory = (delta: number): void => {
    if (history.length === 0) return

    const next = historyAt === -1 ? history.length - 1 : historyAt + delta
    if (next < 0 || next >= history.length) return

    const text = history[next] ?? ''
    historyAt = next
    draft({ ...view, draft: text, caret: text.length })
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
