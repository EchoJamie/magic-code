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
  KernelEvent,
  ModelErrorTier,
  RecordId,
  SessionId,
  SessionSummary,
} from '@magic/contracts'

// ══ 记录区（三类行）══════════════════════════════════════════════════

/** 工具行的跑动状态——「在跑」（`⟳` ＋ 耗时）与「跑完」（`▶` ＋ 结果）一眼可分。 */
export type ToolRunState = 'running' | 'ok' | 'failed' | 'rejected'

/** 记录区的一行。`session` 那三类是**会话内容**，其余是**屏上痕迹**。 */
export type LogRow =
  // —— 会话内容（落库 · 可重建）——
  | { readonly kind: 'user'; readonly key: string; readonly text: string; readonly echoed: boolean }
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
    }
  /**
   * 折叠的**一组**工具调用（重建时同轮的连续调用并成一行——原型 · 场景 12：
   * 「▶ 3 次工具调用（ls · read · grep）」）。
   * 收的判据两条（缺陷 D18）：**≥2 次**才收 · **末尾 `RECENT_GROUPS` 组不收**。
   */
  | { readonly kind: 'toolgroup'; readonly key: string; readonly names: readonly string[] }
  // —— 屏上痕迹（不落库 · 不重建）——
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
   * 多件裁决的**第几件 / 共几件**（原型 · 场景 7：件数报两处——卡上 ＋ 状态行）。
   * 单件时 `null`（不报数）。
   */
  readonly position: { readonly index: number; readonly total: number } | null
}

/** 选择器的一行。 */
export type PickerRow = {
  readonly label: string
  readonly meta: string
  /** 当前那一条（原型 · 场景 9：`正在用`）。 */
  readonly current: boolean
  /** 选定后要用的值（会话 id / 条目名）。 */
  readonly value: string
}

/** 选择器（`/session` · `/model`）——**只在左下开，记录区什么都不进**。 */
export type Picker = {
  readonly source: 'session' | 'model'
  readonly rows: readonly PickerRow[]
  readonly selected: number
  /** 列表下方那行说明（可选）。 */
  readonly hint?: string
}

/** 左下交互区——**四种用法同一位置、同一开合**。 */
export type Dock =
  | { readonly kind: 'input' }
  | { readonly kind: 'decision'; readonly pending: PendingDecision }
  | { readonly kind: 'picker'; readonly picker: Picker }

// ══ slash 候选（D12）═════════════════════════════════════════════════

/** 一条命令的样子（候选里给「名字 ＋ 一句话说明」）。 */
export type CommandSpec = {
  readonly name: string
  readonly summary: string
}

/**
 * **命令登记表**——只列**真存在**的命令（原型 · 场景 11 的自律：
 * 列一个按下去会报错的，比不列更坏）。`/grants` 内核还没有，故**不列**。
 *
 * 四条各自的性质：
 * - `/help` · `/status`——**纯输出型**（本地就能答，不进记录区的对话）；
 * - `/session` · `/model`——**交互配置型**（开选择器）。
 */
export const COMMANDS: readonly CommandSpec[] = [
  { name: '/session', summary: '会话：列表 · 切换 · 新建 · 改名' },
  { name: '/status', summary: '看这一趟用了多少、模型是谁' },
  { name: '/model', summary: '换模型（列出可用条目，选定即切）' },
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
 * 输入不是以 `/` 开头、或已经打了空格（进了参数）＝**不出候选**。
 */
export function matchCommands(text: string): readonly CommandSpec[] {
  if (!text.startsWith('/')) return []

  const word = text.split(/\s+/)[0] ?? ''
  if (text.includes(' ')) return [] // 进了参数——不再筛

  const scored = COMMANDS.map((command) => ({ command, score: scoreOf(command.name, word) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.command.name.localeCompare(right.command.name))

  return scored.map((row) => row.command)
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
/** 选择器右位提示。 */
export const HINT_PICKER = '↑↓ 选 · 回车 定 · esc 收起'
/** 自动补全右位提示（原型 · 场景 11）。 */
export const HINT_COMPLETION = '↑↓ 选 · Tab 补全 · esc 收起'

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
  /** 接管期间**收起来的草稿**（`null` ＝ 没收着）。 */
  readonly stashed: string | null
  /** 接管期间「不静默吞键」的提示（一次性，按下一个键即清）。 */
  readonly flash: string | null
  /** `ctrl+o` 展开（思考与老工具调用默认折一行）。 */
  readonly expanded: boolean
  /** 当前会话 id（还没有会话＝`null`）。 */
  readonly sessionId: SessionId | null
  /** 会话目录（`session.list` 的答复）。 */
  readonly catalog: readonly SessionSummary[]
  /** 本轮已出现的工具调用数（多件裁决报 `n/m` 的取材——只数本轮）。 */
  readonly turnTools: number
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
    stashed: null,
    flash: null,
    expanded: false,
    sessionId: null,
    catalog: [],
    turnTools: 0,
    echoes: 0,
  }
}

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
      return patchStatus(view, { model: event.data.model })
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

    case 'model.switched':
      // 一次性的事**进记录区当回执**（状态行只放「此刻」）；成了顺手更新 ③
      return appendReceipt(
        patchStatus(view, event.data.ok && event.data.model !== undefined ? { model: event.data.model } : {}),
        event.data.ok
          ? `已换模型 → ${event.data.model ?? '？'}`
          : `换模型未成：${event.data.reason ?? '未说缘由'}`,
      )

    // 模型条目表（读侧答复）——**契约加 kind 的连带落点**：这一支现在只是「收到了、不动屏」。
    // 消费它（`/model` 拿它铺选择器、状态行拿 `usage.contextWindow` 报 `12.4k/200k`）
    // 归 U20 显示打磨——见 D10 回报的「消费面」。
    case 'model.catalog':
      return view

    case 'session.state':
      return reduceSessionState(view, event.data)

    // 读面答复——**攒与重建归外壳**（`shell.ts` 里按块收，收齐了调 `rebuild`）；
    // 归约这层收到它就丢（它不逐条进记录区）
    case 'session.history':
      return view

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
        name: name ?? '工具',
        argsText: text,
        args: null, // 流式片段不全——结构化那份要等 `tool.call`
        state: 'running',
        elapsedMs: null,
        startedAt: null,
        output: [],
      }),
    )
  }

  return patchTool(view, target, (row) => ({ ...row, name: name ?? row.name, argsText: row.argsText + text }))
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
        name: data.name,
        argsText: argsJson(data.args),
        args: data.args,
        state: 'running',
        elapsedMs: null,
        // **发起时刻就在这条事件上**（`at`）——不取它，屏上就报不出「跑到第几秒」，
        // 落地后也算不出这次调用花了多久（跑动中的 `⟳ 1.4s` 与落地后的 `✓ 0.2s · …`
        // 都要它）。流式先建行的那条路（下面那个分支）一直有，这一支原先漏了。
        startedAt: at,
        output: [],
      }),
    )
  }

  return patchTool(view, target, (row) => ({
    ...row,
    name: data.name,
    call: id,
    argsText: argsJson(data.args),
    args: data.args,
    // 发起时刻：**事件自带 `at`**（域不各自取时钟，外壳只做差）
    startedAt: row.startedAt ?? at,
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

  return patchTool(view, target, (row) => ({
    ...row,
    // **被拒是终态**：那件工具压根没跑，结果只是把话说全（「未获批准，未执行」）——
    // 不让它被降级成「失败」（两者含义不同：一个是没跑，一个是跑了没成）
    state: row.state === 'rejected' ? 'rejected' : data.ok ? 'ok' : 'failed',
    output: textOfLines(text),
    // 墙钟＝发起 → 落地（`tool.call` 的 `at` → 这条 `tool.result` 的 `at`）。
    // **倒退的钟当没量到**（`null`）：负数上屏就是报了个假的耗时——如实记＝没有就是没有。
    elapsedMs: row.startedAt === null || at < row.startedAt ? null : at - row.startedAt,
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

  return switched ? { ...base, rows: [], settled: [] } : base
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
 * ④ 的分母上屏的**唯一入口**（U20 · 差距 5 的位）——见 `ShellStatus.window`。
 *
 * `D10` 的出口（内核侧给上下文窗总量）**合入后从这里接**：把数字递给它即可，
 * 渲染那一半（`12.4k/200k` 的排版与窄窗降级）已经写好并有用例。
 * 拿不到就传 `null` ⇒ 屏上只报已用量——**不编一个总量**。
 */
export function withContextWindow(view: ShellView, window: number | null): ShellView {
  return patchStatus(view, { window })
}

/** 追加一行**已定局**的行（写一次即入 scrollback）。 */
function appendSettled(view: ShellView, row: LogRow): ShellView {
  return { ...view, settled: [...view.settled, row] }
}

/**
 * 用**重建的会话内容**替换记录区（缺陷 D1）——只挑会话内容那一类，
 * 屏上痕迹（输出 / 回执）**不回**；**收拢**：老工具调用并成一行，最近一组展开。
 */
export function rebuild(view: ShellView, entries: readonly Entry[]): ShellView {
  return { ...view, settled: rebuildRows(entries), rows: [] }
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
      })
      pendingAt = rows.length - 1
      continue
    }

    if (entry.kind === 'tool-result') {
      const row = pendingAt === -1 ? undefined : rows[pendingAt]
      if (row !== undefined && row.kind === 'tool') {
        const payload = entry.payload as { readonly ok?: boolean } | undefined
        rows[pendingAt] = {
          ...row,
          state: payload?.ok === false ? 'failed' : 'ok',
          output: textOfLines(contentTextOf(entry)),
        }
      }
      pendingAt = -1
      continue
    }

    pendingAt = -1
    const text = contentTextOf(entry)

    if (entry.kind === 'user') rows.push({ kind: 'user', key: `rb:u:${entry.id}`, text, echoed: false })
    else if (entry.kind === 'assistant') rows.push({ kind: 'assistant', key: `rb:a:${entry.id}`, text })
    else rows.push({ kind: 'receipt', key: `rb:s:${entry.id}`, text: `（摘要）${text}` })
  }

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
 */
function collapseToolGroups(rows: readonly LogRow[]): readonly LogRow[] {
  const segments = toolSegments(rows)
  if (segments.length === 0) return rows

  /** 末尾这几段保持逐条展开。 */
  const recent = new Set(segments.slice(-RECENT_GROUPS).map((segment) => segment.start))

  /** 摘要行插在每段的**首行**位置；段内其余行丢掉。 */
  const summaryAt = new Map<number, readonly string[]>()
  const dropped = new Set<number>()

  for (const segment of segments) {
    if (recent.has(segment.start)) continue
    if (segment.end === segment.start) continue // 单次调用不收

    summaryAt.set(
      segment.start,
      rows.slice(segment.start, segment.end + 1).map((row) => (row.kind === 'tool' ? row.name : '')),
    )
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

/** 条目的正文——内联取文本，blob 引用不解析（外壳的既有姿势）。 */
function contentTextOf(entry: Entry): string {
  return 'text' in entry.content ? entry.content.text : `（大块转存 ${entry.content.blob}）`
}

// ══ 接管（裁决挂着时占住输入框）══════════════════════════════════════

/**
 * 接管——把草稿收起来（原型：**草稿不丢**，答完原样归还）。
 *
 * 多件裁决时草稿**只收一次**：第一件接管时收起，其后各件沿用同一份（`stashed` 非空即已收）。
 */
export function takeOver(view: ShellView): ShellView {
  if (view.dock.kind !== 'decision' || view.stashed !== null) return view

  return { ...view, stashed: view.draft, draft: '', flash: null }
}

/** 解除接管——**归还草稿**（光标回末尾＝草稿原样，不自动发送）。 */
export function undock(view: ShellView): ShellView {
  if (view.dock.kind !== 'decision') return view // 没在接管＝没得解除

  return {
    ...view,
    dock: { kind: 'input' },
    draft: view.stashed ?? view.draft,
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

  const { position, weight } = view.dock.pending

  return patchStatus(view, {
    state: 'waiting',
    amount: position === null ? null : `${position.index}/${position.total}`,
    hint: weight === 'heavy' ? HINT_DECIDE_HEAVY : HINT_DECIDE_LIGHT,
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

/** 开选择器——**记录区什么都不进**（原型：回车不进记录区）。 */
export function openPicker(view: ShellView, picker: Picker): ShellView {
  return patchStatus({ ...view, dock: { kind: 'picker', picker } }, { hint: HINT_PICKER })
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
