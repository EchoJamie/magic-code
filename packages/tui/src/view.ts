/**
 * 外壳 · 视图模型与归约（U09）——**事件 → 一屏**。
 *
 * 归约是纯函数：显示逻辑全在这层，Ink 只把模型画出来（换皮不动此层——U20）。
 * 事件按 `KernelEvent` 的 `kind` **自动收窄**（契约的判别联合视图——无须强转）。
 *
 * 两条口径（事件只带引用，正文在别处）：
 * - **用户正文**——`message.user` 只带条目引用（`entry: RecordId`），**事件里没有正文**。
 *   故外壳在提交时本地回显（`appendEcho`），`message.user` 到达即为「已记账」的配平；
 *   无回显可配（恢复场景）时留一条引用痕。
 * - **工具结果**——`tool.result.output` 可能是 blob 引用。**外壳不解析引用**
 *   （大负载归记录域），只把引用显示出来。
 *
 * 工具条目与 `model.delta(toolcall)` 的**按序配对**：同一次模型产出里，工具调用增量
 * 先到（流式），`tool.call` 后到（模型产出结束后由工具域分发）。两者顺序一致，
 * 故 `tool.call` 认领**最老的未配对**工具条目；没有流式前情时（供应商不流式工具调用）
 * 自建条目。
 */

import type {
  AgentState,
  Decision,
  DecisionWeight,
  Decider,
  KernelEvent,
  ModelErrorTier,
  OutputChannel,
  RecordId,
  SessionId,
  SessionSummary,
  Timestamp,
  TurnEndReason,
} from '@magic/contracts'

// —— 视图模型 ——

/** 工具输出的一路流（stdout / stderr 各自累积）。 */
export type ToolStream = {
  readonly channel: OutputChannel
  readonly text: string
}

/** 工具条目的结果（收束）。`blob` 为真时 `output` 是**引用**，不是正文。 */
export type ToolOutcome = {
  readonly ok: boolean
  readonly output: string
  readonly blob: boolean
}

/** 工具条目上的裁决留痕。 */
export type ToolVerdict = {
  readonly decision: Decision
  readonly decider: Decider
  readonly elapsedMs: number
}

/** 对话流条目（判别联合——渲染侧按 `kind` 收窄）。 */
export type TranscriptItem =
  | { readonly kind: 'user'; readonly key: string; readonly text: string; readonly echoed: boolean }
  | { readonly kind: 'assistant'; readonly key: string; readonly text: string }
  | { readonly kind: 'thinking'; readonly key: string; readonly text: string }
  | {
      readonly kind: 'tool'
      readonly key: string
      readonly name: string
      /** `tool.call` 事件的 id——请求 / 询问 / 裁决 / 结果四处同指它。未配对时为 `null`。 */
      readonly call: RecordId | null
      /** 参数（流式片段累积；`tool.call` 到时落定为完整 JSON）。 */
      readonly argsText: string
      readonly output: readonly ToolStream[]
      readonly verdict: ToolVerdict | null
      readonly result: ToolOutcome | null
    }
  | {
      readonly kind: 'notice'
      readonly key: string
      readonly text: string
      readonly tone: 'info' | 'error'
    }
  /** 会话目录块（`/session` 问了才列——见 `appendSessionList`）。 */
  | {
      readonly kind: 'sessions'
      readonly key: string
      /** 当前活跃会话（那一条带标记）。 */
      readonly active: SessionId | null
      readonly rows: readonly SessionRow[]
    }

/** 目录里的一行——`title` 已归一（没改过、也派生不出时**退回 id**，屏上不空一格）。 */
export type SessionRow = {
  /** 屏上的序号（**从 1 起**——`/session <序号>` 按它解析）。 */
  readonly index: number
  readonly id: SessionId
  readonly title: string
  readonly at: Timestamp
}

/** 待答的裁决询问——审批提示就是它。 */
export type PendingDecision = {
  /** **配对键**——`tool.decision.request` 事件的 id（答复原样带回）。 */
  readonly id: RecordId
  readonly call: RecordId
  readonly name: string
  /** 判断材料——diff / 命令分解 / 影响面。 */
  readonly material: string
  readonly weight: DecisionWeight
}

/** 一次退避等待的实时状态（`model.retry`）——**只在等待期间亮着**，见 `reduce`。 */
export type RetryStatus = {
  /** 第几次尝试即将开工（从 2 起）。 */
  readonly attempt: number
  readonly delayMs: number
}

/** 状态行的内容。 */
export type ShellStatus = {
  readonly phase: 'idle' | 'busy'
  readonly agent: AgentState | null
  /**
   * 当前供应商（`providers` 的键）——**取自真跑过的那次调用**（`model.call.start` 的
   * `provider`），不是用户命令的自我报告：切不动就不动，拿意图当状态会显示一个并没在用的条目。
   */
  readonly provider: string | null
  readonly model: string | null
  /** 退避等待中——非 `null` 即屏上该说「正在重试」。 */
  readonly retry: RetryStatus | null
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number } | null
  readonly turnEnd: TurnEndReason | null
  /**
   * 当前活跃会话（**单活跃**）——`session.state` 报什么就是什么。
   *
   * 取的是**内核报的**，不是用户命令的自我报告（同 `provider` 的分寸：命令可能没生效）。
   * `title` 缺席＝没有名字（屏上退回报 id）——**不编一个出来**。
   */
  readonly session: { readonly id: SessionId; readonly title: string | null } | null
}

/** 一屏的全部状态（对话流 ＋ 状态；审批提示在 `pending`）。 */
export type ShellView = {
  readonly items: readonly TranscriptItem[]
  readonly pending: PendingDecision | null
  readonly status: ShellStatus
  /**
   * 会话目录（最近在前）——`session.state` 带回来的那一份。
   *
   * 它**不是对话流的一部分**（不进 `items`）：目录是「此刻的事实」，不是「发生过的事」。
   * `/session` 要列时由 `appendSessionList` 取它渲染成一块（那一块才进流）。
   */
  readonly sessions: readonly SessionSummary[]
}

/** 空视图。 */
export function createView(): ShellView {
  return {
    items: [],
    pending: null,
    sessions: [],
    status: {
      phase: 'idle',
      agent: null,
      provider: null,
      model: null,
      retry: null,
      usage: null,
      turnEnd: null,
      session: null,
    },
  }
}

/** 本地回显一次用户输入（提交时立即显示——事件里没有正文，见文件头）。 */
export function appendEcho(view: ShellView, text: string): ShellView {
  return append(view, { kind: 'user', key: echoKey(text, view.items.length), text, echoed: true })
}

/**
 * 屏上怎么称呼一条会话——**标题优先，没有就报 id**（截到 8 位：屏上是人看的，
 * 全 id 36 位会把一行撑爆；要认准一条会话请用列表里的**序号**）。
 *
 * 一个规则三处用（切换提示 · 状态行 · 目录块）——各写各的截法就是三处迟早不一样。
 */
export function sessionLabel(title: string | undefined | null, id: SessionId): string {
  if (title !== undefined && title !== null && title !== '') return title

  return id.length <= 8 ? id : `${id.slice(0, 8)}…`
}

/**
 * 把会话目录渲染成对话流里的一块（`/session` 问了才调——**要看得见**才列）。
 *
 * 与 `appendEcho` 同法：**视图层的纯函数**，由外壳在合适的时机拼进来
 * （归约只管「状态怎么变」，列不列是**呈现的选择**——两件事分开，`reduce` 才保持纯粹）。
 */
export function appendSessionList(view: ShellView): ShellView {
  return append(view, {
    kind: 'sessions',
    key: `sessions:${view.items.length}`,
    active: view.status.session?.id ?? null,
    rows: view.sessions.map((row, index) => ({
      index: index + 1,
      id: row.id,
      // 标题缺席退回 id——屏上留一格空白比报个 id 更让人犯嘀咕
      title: sessionLabel(row.title, row.id),
      at: row.at,
    })),
  })
}

// —— 归约 ——

/** 归约一步：`event → 新视图`（纯函数——不改动入参）。 */
export function reduce(view: ShellView, event: KernelEvent): ShellView {
  switch (event.kind) {
    // — 对话流 · 模型增量（瞬时——落库收束为调用级）—
    case 'model.delta':
      // 内容来了 ⇒ 退避结束（重试位撤下——它只描述「正在等」）
      return reduceDelta(clearRetry(view), event.id, event.data)

    // — 对话流 · 工具调用链 —
    case 'tool.call':
      return reduceToolCall(view, event.id, event.data)
    case 'tool.output.delta':
      return reduceToolOutput(view, event.data)
    case 'tool.result':
      return reduceToolResult(view, event.data)

    // — 审批 —
    case 'tool.decision.request':
      return { ...view, pending: { id: event.id, ...event.data } }
    case 'tool.decision':
      return reduceVerdict(view, event.data)

    // — 用户条目（正文不在事件内——本地回显配平）—
    case 'message.user':
      return reduceUserEntry(view, event.data.entry)
    case 'message.assistant':
      // 正文已由 `model.delta` 流式呈现——此处只是「已记账」的确认。
      return view

    // — 状态行 —
    case 'turn.start':
      return patchStatus(view, { phase: 'busy', turnEnd: null })
    case 'turn.end':
      // 轮收束 ⇒ 悬着的询问随之作废（询问是轮内的：轮结束，那个工具就跑不成了）。
      // 不撤的话，中断之后那条提示会赖着不走——Ctrl+C 也会一直被它按在「工作中」。
      return patchStatus(
        { ...view, pending: null },
        { phase: 'idle', retry: null, turnEnd: event.data.reason },
      )
    case 'agent.start':
      return patchStatus(view, { agent: 'waiting' })
    case 'agent.state':
      return patchStatus(view, { agent: event.data.state })
    case 'agent.end':
      return patchStatus(view, { agent: null })
    case 'model.call.start':
      // 供应商 + 模型各归各位；**缺席即 `null`**（不拿旧值充数——旧值可能是另一个条目的）
      return patchStatus(clearRetry(view), {
        provider: event.data.provider ?? null,
        model: event.data.model,
      })
    case 'model.usage': {
      const { inputTokens, outputTokens } = event.data
      return patchStatus(clearRetry(view), { usage: { inputTokens, outputTokens } })
    }
    case 'model.call.end':
      return clearRetry(view)

    // — 退避重试（瞬时档）——**状态位，不是对话流**（退避三次不刷三行）—
    case 'model.retry':
      return patchStatus(view, {
        retry: { attempt: event.data.attempt, delayMs: event.data.delayMs },
      })

    // — 换模型的结果（用户命令；**落库**）—
    case 'model.switched':
      return reduceSwitched(view, event.id, event.data)

    // — 错误 —
    case 'model.error':
      return appendNotice(
        clearRetry(view),
        event.id,
        `模型错误（${tierLabel(event.data.tier)}）：${event.data.message}`,
        'error',
      )
    case 'error':
      return appendNotice(view, event.id, `内核异常：${event.data.message}`, 'error')

    // — 会话面（阶段 2 · U16）——目录 ＋ 当前在哪条 —
    case 'session.state':
      return reduceSessionState(view, event.data)

    // — 预留（阶段 3）—
    case 'context.compacted':
      return view

    default:
      return assertNever(event)
  }
}

// —— 各分支实现 ——

type DeltaData = Extract<KernelEvent, { kind: 'model.delta' }>['data']

function reduceDelta(view: ShellView, id: RecordId, data: DeltaData): ShellView {
  if (data.channel === 'text') return appendText(view, id, 'assistant', data.text)
  if (data.channel === 'thinking') return appendText(view, id, 'thinking', data.text)

  return appendToolFragment(view, id, data.name, data.id, data.text)
}

/** 正文 / 思考——落到末尾同类条目上（交替出现即分块）。 */
function appendText(
  view: ShellView,
  id: RecordId,
  kind: 'assistant' | 'thinking',
  text: string,
): ShellView {
  const last = lastItem(view)
  if (last?.kind === kind) {
    return replaceLast(view, { ...last, text: last.text + text })
  }

  return append(view, { kind, key: `${kind}:${id}`, text })
}

/** 工具调用增量——按供应商侧调用 id 分组；无 id 时并进最老的未配对条目。 */
function appendToolFragment(
  view: ShellView,
  id: RecordId,
  name: string | undefined,
  providerId: string | undefined,
  text: string,
): ShellView {
  const target =
    providerId === undefined
      ? findToolIndex(view, (item) => item.call === null)
      : findToolIndex(view, (item) => item.key === toolKey(`tc:${providerId}`))

  if (target === -1) {
    return append(view, {
      kind: 'tool',
      key: toolKey(providerId === undefined ? `d${id}` : `tc:${providerId}`),
      name: name ?? '工具',
      call: null,
      argsText: text,
      output: [],
      verdict: null,
      result: null,
    })
  }

  return patchItem(view, target, (item) => ({
    ...item,
    name: name ?? item.name,
    argsText: item.argsText + text,
  }))
}

type ToolCallData = Extract<KernelEvent, { kind: 'tool.call' }>['data']

/** `tool.call`——认领最老的未配对工具条目（流式前情）；没有则自建。 */
function reduceToolCall(view: ShellView, id: RecordId, data: ToolCallData): ShellView {
  const target = findToolIndex(view, (item) => item.call === null)

  if (target === -1) {
    return append(view, {
      kind: 'tool',
      key: toolKey(`call:${id}`),
      name: data.name,
      call: id,
      argsText: argsJson(data.args),
      output: [],
      verdict: null,
      result: null,
    })
  }

  return patchItem(view, target, (item) => ({
    ...item,
    name: data.name,
    call: id,
    argsText: argsJson(data.args),
  }))
}

type ToolOutputData = Extract<KernelEvent, { kind: 'tool.output.delta' }>['data']

function reduceToolOutput(view: ShellView, data: ToolOutputData): ShellView {
  const target = indexOfCall(view, data.call)
  if (target === -1) return view

  return patchItem(view, target, (item) => {
    const last = item.output[item.output.length - 1]
    const output =
      last?.channel === data.channel
        ? [...item.output.slice(0, -1), { channel: last.channel, text: last.text + data.text }]
        : [...item.output, { channel: data.channel, text: data.text }]

    return { ...item, output }
  })
}

type ToolResultData = Extract<KernelEvent, { kind: 'tool.result' }>['data']

function reduceToolResult(view: ShellView, data: ToolResultData): ShellView {
  const target = indexOfCall(view, data.call)
  if (target === -1) return view

  const content = data.output
  const blob = 'blob' in content

  return patchItem(view, target, (item) => ({
    ...item,
    result: { ok: data.ok, output: blob ? content.blob : content.text, blob },
  }))
}

type VerdictData = Extract<KernelEvent, { kind: 'tool.decision' }>['data']

function reduceVerdict(view: ShellView, data: VerdictData): ShellView {
  const target = indexOfCall(view, data.call)
  const items =
    target === -1
      ? view.items
      : view.items.map((item, index) =>
          index === target && item.kind === 'tool'
            ? {
                ...item,
                verdict: {
                  decision: data.decision,
                  decider: data.decider,
                  elapsedMs: data.elapsedMs,
                },
              }
            : item,
        )

  return {
    ...view,
    items,
    // 询问已收束——提示撤下（同一次询问才清；他次询问的答复不动本案）
    pending: view.pending?.call === data.call ? null : view.pending,
  }
}

type SwitchedData = Extract<KernelEvent, { kind: 'model.switched' }>['data']

/**
 * 换模型的结果——成了报一句、没成报缘由。
 *
 * **不是「内核异常」**（第 17 轮借兜底 `error` 顶上时屏上就是那么写的）：这是**用户命令的结果**，
 * 与内核自己出事不是一类。成了顺手把状态行改过去——不必干等下轮 `model.call.start`；
 * 没成则**状态行不动**：切不动就不动，上一条仍是最后真跑过的那格。
 */
function reduceSwitched(view: ShellView, id: RecordId, data: SwitchedData): ShellView {
  if (!data.ok) {
    return appendNotice(view, id, `换模型未成：${data.reason ?? '未说缘由'}`, 'error')
  }

  return patchStatus(
    appendNotice(view, id, `已换到 ${data.provider ?? '？'}/${data.model ?? '？'}`, 'info'),
    { provider: data.provider ?? null, model: data.model ?? null },
  )
}

type SessionStateData = Extract<KernelEvent, { kind: 'session.state' }>['data']

/**
 * `session.state`——目录 ＋ 当前会话。
 *
 * **当前会话换了＝重开一屏**：上一屏说的是另一条会话的事，留着就是骗人（一次误读的
 * 代价比清屏高）。三处分寸：
 * - **首见不算切换**（`null → 某条`）——启动那一刻没有旧屏可清，也没什么可说的；
 * - **没换不清**——同一会话再报一次（问目录 / 改名）不该把屏清了；
 * - `note` 有话就单起一条（没开成 / 忙时切不动）——**失败不静默**。
 */
function reduceSessionState(view: ShellView, data: SessionStateData): ShellView {
  const previous = view.status.session?.id ?? null
  const switched = previous !== null && previous !== data.active
  const title = data.sessions.find((row) => row.id === data.active)?.title ?? null

  // 换会话＝换一屏：旧的对话流清掉（新旧混在一屏里分不清谁说的）
  const base: ShellView = switched ? { ...view, items: [] } : view
  const named: ShellView = {
    ...base,
    sessions: data.sessions,
    status: { ...base.status, session: { id: data.active, title } },
  }

  const withSwitch = switched
    ? appendLocalNotice(named, `已切到会话：${sessionLabel(title, data.active)}`, 'info')
    : named

  return data.note === undefined ? withSwitch : appendLocalNotice(withSwitch, data.note, 'error')
}

/** `message.user`——配平本地回显；配不上（恢复场景）则留一条引用痕。 */
function reduceUserEntry(view: ShellView, entry: RecordId): ShellView {
  const target = itemIndex(view, (item) => item.kind === 'user' && item.echoed)

  if (target === -1) {
    return append(view, {
      kind: 'user',
      key: `user.ref:${entry}`,
      text: `（用户条目 ${entry}）`,
      echoed: false,
    })
  }

  return patchItem(view, target, (item) => ({ ...item, echoed: false }))
}

// —— 小工具（纯函数）——

function append(view: ShellView, item: TranscriptItem): ShellView {
  return { ...view, items: [...view.items, item] }
}

function appendNotice(
  view: ShellView,
  id: RecordId,
  text: string,
  tone: 'info' | 'error',
): ShellView {
  return append(view, { kind: 'notice', key: `notice:${id}`, text, tone })
}

/**
 * 本地提示（外壳自己说的话——不是内核事件）。
 *
 * 键按位置取（同 `appendEcho` 的 `echoKey`）：本地提示没有事件 id 可借，
 * 而位置在一条流里本就唯一。两处键**前缀不同**（`notice.local:` vs `notice:`），
 * 免得同一位置的内核提示与本地提示撞键。
 */
function appendLocalNotice(view: ShellView, text: string, tone: 'info' | 'error'): ShellView {
  return append(view, {
    kind: 'notice',
    key: `notice.local:${view.items.length}:${text}`,
    text,
    tone,
  })
}

/** 外壳自己说一句——`shell.ts` 用它（本地就有答案的事不必过内核）。 */
export function appendNoticeText(
  view: ShellView,
  text: string,
  tone: 'info' | 'error' = 'info',
): ShellView {
  return appendLocalNotice(view, text, tone)
}

function patchStatus(view: ShellView, patch: Partial<ShellStatus>): ShellView {
  return { ...view, status: { ...view.status, ...patch } }
}

/**
 * 撤下重试位——**这次调用又在动了**（首块内容到位 / 收束 / 出错终局 / 另起一次调用）。
 *
 * 一条规则胜过四处判断：重试位只描述「正在等」，等完了就该灭；留着它，屏上会一直
 * 挂着「3 秒后重试」，而实际早就答完了。
 */
function clearRetry(view: ShellView): ShellView {
  return view.status.retry === null ? view : patchStatus(view, { retry: null })
}

function lastItem(view: ShellView): TranscriptItem | undefined {
  return view.items[view.items.length - 1]
}

/** 换掉末条（流式累积用——只动末条，前面的条目引用不变）。 */
function replaceLast(view: ShellView, item: TranscriptItem): ShellView {
  return { ...view, items: [...view.items.slice(0, -1), item] }
}

function patchItem(
  view: ShellView,
  index: number,
  patch: (item: Extract<TranscriptItem, { kind: 'tool' }>) => TranscriptItem,
): ShellView {
  const item = view.items[index]
  if (item === undefined || item.kind !== 'tool') return view

  return { ...view, items: view.items.map((current, at) => (at === index ? patch(item) : current)) }
}

/** 找工具条目——按条目级谓词。 */
function findToolIndex(
  view: ShellView,
  predicate: (item: Extract<TranscriptItem, { kind: 'tool' }>) => boolean,
): number {
  return view.items.findIndex((item) => item.kind === 'tool' && predicate(item))
}

/** 找任意条目（用户回显配平用）。 */
function itemIndex(view: ShellView, predicate: (item: TranscriptItem) => boolean): number {
  return view.items.findIndex(predicate)
}

function indexOfCall(view: ShellView, call: RecordId): number {
  return findToolIndex(view, (item) => item.call === call)
}

function toolKey(scope: string): string {
  return `tool:${scope}`
}

function echoKey(text: string, index: number): string {
  return `user.echo:${index}:${text}`
}

function argsJson(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(args)
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
