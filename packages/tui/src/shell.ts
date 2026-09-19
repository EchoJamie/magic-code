/**
 * 外壳 · 会话壳（缺陷轮 II 重画）——**只认控制面**。
 *
 * 一件：把注入的 `ControlTransport`（外壳侧一端，装配注入）接成「事件 → 视图 ＋ 键 → 命令」
 * 的一条线。**键位语义全在这层**（`key()` 收一个按键、改视图、必要时发命令）——
 * 组件只把 Ink 的键喂进来、把模型画出来。好处：接管 / 草稿 / 选择器这些规矩**不起终端就能测**。
 *
 * 四条纪律（原型 · 交互逻辑）：
 * ① **先接订阅、后放开输入**（构造即订阅）；
 * ② **slash 两种走法**——纯输出型（`/help`）：输出进记录区、**命令本身不回显**；
 *    交互配置型（`/session` · `/model`）：**记录区什么都不进**，只在左下开选择器，
 *    选定后留**一行回执**，`esc` 取消＝**不留痕迹**；
 * ③ **接管**（裁决挂着）——看得见（占位换掉）· 草稿不丢（收起来、答完归还、**不自动发送**）·
 *    **不静默吞键**（只认 y/a/n ＋ 全局 ctrl+c，其余忽略但当场说一句；粘贴一律拒）；
 * ④ **重建**（缺陷 D1）——`session.history` 分块收、收齐了按块重建记录区（**收拢**）。
 */

import type { Command, ControlTransport, Entry, EventKind, KernelEvent, SessionId } from '@magic/contracts'
import {
  COMMANDS,
  HINT_BOOTING,
  HINT_COMPLETION,
  HINT_IDLE,
  HINT_WORKING,
  appendEcho,
  appendOutput,
  appendReceipt,
  closePicker,
  createView,
  matchCommands,
  movePicker,
  openPicker,
  sessionHint,
  sessionRows,
  picked,
  rebuild,
  reduce,
  withContextWindow,
} from './view.ts'
import { usageLabel } from './components/lines.ts'
import type { ShellView } from './view.ts'

/** 外壳认得的按键——组件把 Ink 的 `(input, key)` 收窄成这个（多出来的都算 `other`）。 */
export type ShellKey =
  | { readonly kind: 'char'; readonly char: string }
  | { readonly kind: 'enter' }
  /** `shift+回车`——**换行**（原型 · 键盘：`回车` 发送 · `shift+回车` 换行）。 */
  | { readonly kind: 'newline' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'backspace' }
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

/** 一次「等内核回话再开选择器」的意图——`/session` 与 `/model` 各一种。 */
type PendingPicker = 'session' | 'model'

/** 建壳的入参（都可省——省了＝按「拿不到」办）。 */
export type ShellOptions = {
  /**
   * **上下文窗总量**（U20 · 差距 5）——状态行 ④ 的分母（`12.4k/200k`）。
   *
   * ⚠️ **这是给 `D10` 留的位**：内核侧那条出口还没合入，故此刻**没人传**，
   * 屏上只报已用量。出口合入后由装配把数递进来（见 `withContextWindow`）——
   * 不编、不猜、不改事件契约。
   */
  readonly contextWindow?: number | null | undefined
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

/** 建会话壳——**构造即订阅**（先接订阅、后放开输入）。 */
export function createShell(transport: ControlTransport, options: ShellOptions = {}): Shell {
  const watchers = new Set<() => void>()
  const booting = options.inputReady === false
  let view = withContextWindow(createView(), options.contextWindow ?? null)
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

  /** 等回话的选择器意图（`/session` / `/model` 各问一次）。 */
  let waiting: PendingPicker | null = null

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

  const commit = (next: ShellView, streaming = false): void => {
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
   */
  const withCompletion = (next: ShellView): ShellView => {
    if (next.dock.kind !== 'input') return { ...next, completion: null }

    const candidates = matchCommands(next.draft)
    const open = candidates.length > 0

    return {
      ...next,
      completion: open ? { candidates, selected: 0 } : null,
      // 右位提示跟着候选走（原型 · 场景 11）；候选举起就报键位，收起就回常态
      status: { ...next.status, hint: open ? HINT_COMPLETION : idleHintOf(next) },
    }
  }

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
    draft(next)
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
  }

  const accumulate = (data: Extract<KernelEvent, { kind: 'session.history' }>['data']): void => {
    if (view.sessionId !== null && data.session !== view.sessionId) return // 切走之后的尾巴——丢

    if (rebuildFor !== data.session) {
      rebuildFor = data.session
      rebuildEntries = []
    }

    rebuildEntries = [...rebuildEntries, ...data.entries]
    if (!data.done) return

    commit(rebuild(view, rebuildEntries))
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
        edit({ ...view, draft: view.draft + input.text })
        return NONE

      case 'escape':
        if (view.dock.kind === 'picker') return (commit(closePicker(view)), NONE)
        if (view.dock.kind === 'decision') return NONE // 接管期间 `esc` **无动作**
        // 候选开着 ⇒ 先**收起候选**（原型：`esc` 收起；草稿留着）
        if (view.completion !== null) return (commit({ ...view, completion: null }), NONE)
        edit(view.draft === '' ? { ...view, expanded: false } : { ...view, draft: '' })
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

      case 'backspace':
        if (view.dock.kind === 'decision') return refuse('退格')
        edit({ ...view, draft: view.draft.slice(0, -1) })
        return NONE

      case 'char':
        if (view.dock.kind === 'decision') return answer(input.char)
        if (view.dock.kind === 'picker') return NONE
        edit({ ...view, draft: view.draft + input.char })
        return NONE

      // `shift+回车`——**换行**（原型 · 键盘）。接管期间同其余键：不静默吞，说一句。
      case 'newline':
        if (view.dock.kind === 'decision') return refuse('换行')
        if (view.dock.kind === 'picker') return NONE
        edit({ ...view, draft: `${view.draft}\n` })
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
        commit(said(view, '必闸类不可「总是允许」——按 y 批准这一次，或 n 拒绝。'))
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

    // ⚠️ 两条提交路**都走 `draft()`**（缺陷 D23）——提交也改变了草稿（都清成空串），
    // 候选与右位提示得跟着重算。走 `commit()` 就**绕过了 `withCompletion` 那个统一口**，
    // 于是**空输入框下还挂着候选**（右位也停在「↑↓ 选 · Tab 补全」）。
    if (text.startsWith('/')) {
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

    if (history[history.length - 1] !== text) history.push(text)
    historyAt = -1
    draft(appendEcho({ ...view, draft: '' }, text))
    send({ type: 'input.submit', text })

    return NONE
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
    const cleared: ShellView = { ...from, draft: '' }
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

    if (word === '/model') {
      if (arg !== '') return only(cleared, { type: 'model.switch', provider: arg })

      // 不带参数 ⇒ **问一次条目表**（D10 的读侧命令 `model.list`）：答复是 `model.catalog`，
      // 外壳据它铺选择器（**全量**，含从未调用过的条目）并把 ④ 的分母定下来。
      // ⚠️ 原先是发空参的 `model.switch`、拿**失败的缘由**当列表说明——那不是读面
      //（以「换失败了」作答，还白落一笔 `model.switched`）。
      waiting = 'model'
      return only(cleared, { type: 'model.list' })
    }

    // 不认得的 slash——**如实说一句**（别静默丢，也别当交代发给模型）
    return only(appendReceipt(cleared, `不认得的命令「${word}」——试试 /help`))
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

    return withCompletion({ ...from, draft: `${row.name} `, completion: null })
  }

  const recallHistory = (delta: number): void => {
    if (history.length === 0) return

    const next = historyAt === -1 ? history.length - 1 : historyAt + delta
    if (next < 0 || next >= history.length) return

    historyAt = next
    draft({ ...view, draft: history[next] ?? '' })
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
