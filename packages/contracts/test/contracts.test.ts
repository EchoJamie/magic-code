/**
 * 契约包测试（M01 · 契约包重组）。
 *
 * 契约是**纯类型层**——运行时几无可断言之物，故这里做三件事：
 * 1. **类型层探针**——判别联合收窄 · 信封构造面 · 端口可实现（由 tsc 校验；
 *    `bun test` 只剥离类型，不做检查）；
 * 2. 规则载体（常量与纯函数）的运行时断言；
 * 3. **迁移忠实性**——重组后旧契约的对外语义逐条仍成立。
 */

import { describe, expect, test } from 'bun:test'
import {
  DECISION_REQUEST_KIND,
  RECORD_SCHEMA_VERSION,
  TOOLSET_V1,
  TRANSIENT_EVENT_KINDS,
  apiKeyEnvVarOf,
  expandHome,
  isValidMcpToolName,
  mcpToolLabel,
  mcpToolName,
  parseMcpToolName,
} from '../src/index.ts'
import type {
  Command,
  CommandRoutes,
  ModelSwitchRequest,
  Content,
  Decision,
  DecisionAnswer,
  DecisionId,
  Entry,
  EntryRange,
  EventDataOf,
  EventEnvelope,
  EventKind,
  EventStamper,
  ExecResult,
  KernelEvent,
  KernelTransport,
  MagicConfig,
  ModelFinishReason,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResult,
  ModelStream,
  ModelTraits,
  ConversationService,
  NewEntry,
  PermissionGate,
  ProviderConfig,
  RecordId,
  RecordsService,
  Sandbox,
  ToolCall,
  ToolCallPayload,
  ToolResult,
  ToolResultPayload,
  TurnId,
  WriteData,
} from '../src/index.ts'

// ══ 类型层探针（tsc 校验；运行时无操作）══════════════════════════════

/** 判别联合视图——按 `kind` 自动收窄 `data`（M01 补锚 3）。 */
export function kernelEventNarrowsByKind(): void {
  const events: readonly KernelEvent[] = [
    {
      id: 1,
      session: 's1',
      turn: null,
      at: 0,
      kind: 'tool.call',
      data: { name: 'exec', args: { cmd: 'ls' } },
    },
    {
      id: 2,
      session: 's1',
      turn: 1,
      at: 1,
      kind: 'tool.output.delta',
      data: { call: 1, channel: 'stdout', text: 'hi' },
    },
    {
      id: 3,
      session: 's1',
      turn: 1,
      at: 2,
      kind: 'model.usage',
      data: { inputTokens: 12, outputTokens: 3 },
    },
    {
      id: 4,
      session: 's1',
      turn: 1,
      at: 3,
      kind: 'model.delta',
      data: { channel: 'toolcall', text: '', name: 'exec', id: 'call_x' },
    },
    {
      id: 5,
      session: 's1',
      turn: 1,
      at: 4,
      kind: 'model.error',
      data: { tier: 'transient', message: 'rate limited' },
    },
  ]

  for (const e of events) {
    if (e.kind === 'tool.call') {
      const name: string = e.data.name // 收窄生效——联合里只有它带 name
      void name
    }
    if (e.kind === 'tool.output.delta') {
      const ch: 'stdout' | 'stderr' = e.data.channel
      void ch
    }
    if (e.kind === 'model.usage') {
      // U41：用量各字段**分别可缺**（未上报＝不给这一位，不补零）——故收窄后的类型带
      // `undefined`，这正是要钉的形（拿它当必填就是「把未知当 0」）
      const tokens: number | undefined = e.data.inputTokens
      void tokens
    }
    if (e.kind === 'model.delta') {
      const ch: 'text' | 'thinking' | 'toolcall' = e.data.channel
      const callId: string | undefined = e.data.id // toolcall 分组用（供应商侧 id）
      void ch
      void callId
    }
    if (e.kind === 'model.error') {
      const tier: 'transient' | 'context-limit' | 'terminal' = e.data.tier
      void tier
    }
  }
}

/** 信封构造面——泛型收窄到单 kind。 */
export function envelopeConstructsByKind(): void {
  const delta: EventEnvelope<'tool.output.delta'> = {
    id: 1,
    session: 's1',
    turn: 1,
    at: 0,
    kind: 'tool.output.delta',
    data: { call: 1, channel: 'stderr', text: 'oops' },
  }

  // @ts-expect-error 收窄生效——`model.usage` 的形态不得塞进 `tool.call` 的 data
  const wrongShape: EventEnvelope<'tool.call'>['data'] = { inputTokens: 1, outputTokens: 2 }

  void delta
  void wrongShape
}

/** 命令面——判别式构造。 */
export function commandsConstruct(): void {
  const cmds: readonly Command[] = [
    { type: 'input.submit', text: '看下 playground' },
    { type: 'decision.answer', id: 7, decision: 'approve' },
    { type: 'turn.interrupt' },
  ]
  void cmds
}

/** 端口可实现——桩满足签名（端口一致性的雏形）。 */
export function portsAreImplementable(): void {
  const sandbox: Sandbox = {
    async exec(): Promise<ExecResult> {
      return { ok: true, exit: 0, stdout: '', stderr: '', truncated: false }
    },
    async read() {
      return { content: '' }
    },
    async write() {},
    async list() {
      return []
    },
    async match() {
      return []
    },
  }

  // 模型网关——双出口（事件序列 ＋ 聚合结果）可被实现
  const gateway: ModelGateway = {
    stream(req: ModelRequest, opts: { signal?: AbortSignal }): ModelStream {
      void req
      void opts
      return {
        events: (async function* (): AsyncIterable<KernelEvent> {})(),
        result: Promise.resolve({ complete: true, finishReason: 'stop' }),
      }
    },
  }

  void sandbox
  void gateway
}

// —— 第 3 轮补锚（M02 / M03 回报收口）——

/** 信封铸造器——`stamp` 返回可收窄 · `beginTurn` 可调。 */
export function eventStamperIsUsable(): void {
  const stamper: EventStamper = {
    stamp<K extends EventKind>(kind: K, data: EventDataOf[K]): KernelEvent {
      return { id: 1, session: 's1', turn: null, at: 0, kind, data } as KernelEvent
    },
    beginTurn(turn: TurnId | undefined): void {
      void turn
    },
  }

  const e = stamper.stamp('tool.call', { name: 'exec', args: { cmd: 'ls' } })
  if (e.kind === 'tool.call') {
    const name: string = e.data.name // 收窄生效
    void name
  }

  stamper.beginTurn(7)
  stamper.beginTurn(undefined)
}

/** 内核侧传输——可被实现（镜像：收命令 / 出事件）。 */
export function kernelTransportIsImplementable(): void {
  const transport: KernelTransport = {
    send(event: KernelEvent): void {
      void event
    },
    subscribe(handler: (command: Command) => void): () => void {
      void handler
      return () => {}
    },
  }

  const off = transport.subscribe((command) => void command)
  off()
}

/** 记录域桩——`nextId`（铸造器取号的来源）可被桩实现。 */
export function recordsServiceIsImplementable(): void {
  let next = 1
  const records: RecordsService = {
    nextId: () => next++,
    appendEntry: () => next++,
    appendEvent: () => {},
    readEntries: () => (async function* (): AsyncIterable<Entry> {})(),
    readEvents: () => (async function* (): AsyncIterable<KernelEvent> {})(),
    // 在途识别（恢复 ① · U25）——「干净会话」就是一条也说不出：空扫描
    scanInFlight: async (session) => ({ session, openTurn: null, lastTurn: null, calls: [] }),
    listSessions: async () => [],
    blobs: {
      put: async () => 'blob_1',
      get: async () => new Uint8Array(),
    },
  }
  void records
}

// —— 第 10 轮补锚（波次 2 · U04 / U06 共同报出的缺口）——

/** 工具结果——**载两样输出 ＋ 链引用**，三字段皆必填。 */
export function toolResultCarriesThreeParts(): void {
  const result: ToolResult = {
    ok: true,
    output: '截断后的文本',
    content: { text: '完整输出' },
    callRef: 7,
  }

  // content 两选一——内联或 blob 引用
  const inline: ToolResult = {
    ok: false,
    output: 'err',
    content: { text: 'e' },
    callRef: 1,
  }
  const blob: ToolResult = { ok: true, output: '…', content: { blob: 'b_1' }, callRef: 2 }

  // callRef 落在 RecordId 空间（链引用——条目侧 tool-result 的 call 取它）
  const ref: RecordId = result.callRef
  const asContent: Content = result.content

  void inline
  void blob
  void ref
  void asContent

  // @ts-expect-error 三字段皆必填——缺 `content` 不算数
  const missing: ToolResult = { ok: true, output: 'x', callRef: 3 }
  void missing
}

/** 条目的工具载荷——结构对齐事件侧。 */
export function entryCarriesToolPayload(): void {
  const call: ToolCallPayload = { name: 'exec', args: { cmd: 'ls' } }
  const result: ToolResultPayload = { ok: true, output: { text: 'done' } }
  const entry: NewEntry = { kind: 'tool-call', content: { text: '' }, payload: call, at: 0 }
  const full: Entry = { ...entry, id: 1 }
  void result
  void full
}

/** 条目范围可省略（端口签名 `range?`）。 */
export function entryRangeIsOptional(): void {
  const range: EntryRange = { from: 1, to: 9 }
  void range
}

// —— 端口内类型（M01 第 2 轮 · v0 锚定）——

/** 模型消息——判别联合按 `role` 收窄。 */
export function modelMessageNarrowsByRole(): void {
  const messages: readonly ModelMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'ok',
      toolCalls: [{ id: 'call_1', name: 'exec', args: { cmd: 'ls' } }],
    },
    // 补锚：`tool` 支带 `name`（取件层回填需要工具名——反查在压缩后会静默退化）
    { role: 'tool', callId: 'call_1', name: 'exec', ok: true, output: 'done' },
  ]

  for (const m of messages) {
    if (m.role === 'tool') {
      const callId: string = m.callId // 收窄生效——联合里只有它带 callId
      void callId
    }
    if (m.role === 'assistant') {
      const calls: readonly ToolCall[] | undefined = m.toolCalls
      void calls
    }
  }

  // @ts-expect-error 收窄生效——`tool` 支不带 `toolCalls`（单行：错误须落在被抑制的那一行）
  const bad: ModelMessage = { role: 'tool', callId: 'x', name: 'exec', ok: true, output: '', toolCalls: [] }
  void bad
}

/** 三个 id 空间不混——供应商侧调用 id 不是 `RecordId`。 */
export function threeIdSpacesAreDistinct(): void {
  const vendorCallId: ToolCall['id'] = 'call_abc' // ① 供应商侧调用 id
  const chainCall: RecordId = 7 // ② 事件的 call（RecordId 空间）
  const decisionPair: DecisionId = 9 // ③ 裁决配对的请求事件 id

  // @ts-expect-error ① 与 ② 不同空间——供应商侧 id 不可当 RecordId 用
  const wrong: RecordId = vendorCallId

  void chainCall
  void decisionPair
  void wrong
}

/** 模型特征标记——覆盖位**可空**（空缺＝常规行为，不是「无特征」的断言）。 */
export function traitsIsOptionalOverride(): void {
  const none: ModelTraits = {}
  const one: ModelTraits = { inlineThinking: { tag: 'think' } }
  const providerPlain: ProviderConfig = { baseURL: 'https://api.example/v1', model: 'm' }
  const providerWithTraits: ProviderConfig = {
    baseURL: 'https://api.example/v1',
    model: 'm',
    traits: one,
  }

  void none
  void providerPlain
  void providerWithTraits
}

/** 模型结束原因——词表对齐取件层；`finishReason` 可缺、`complete` 表「是否走完」。 */
export function modelResultShape(): void {
  const reasons: readonly ModelFinishReason[] = [
    'stop',
    'tool-calls',
    'length',
    'content-filter',
    'error',
    'other',
  ]
  const minimal: ModelResult = { complete: false } // finishReason 可缺（未给 / 出错 / 提前 break）
  const full: ModelResult = {
    finishReason: 'tool-calls',
    usage: { inputTokens: 1, outputTokens: 2 },
    complete: true,
  }

  void reasons
  void minimal
  void full
}

// —— 第 15 轮补锚（阶段 2 波次 1 · 契约三处 ＋ 「总是允许」）——

/** `WriteData` 两选一——文本或**字节**；`blob` 支已撤（写了即编译不过）。 */
export function writeDataTakesBytesOrText(): void {
  const text: WriteData = { text: '内容' }
  const bytes: WriteData = { bytes: new Uint8Array([1, 2, 3]) }

  void text
  void bytes

  // 撤 blob 支的判据就在这一行：沙箱没有 blob 面（要写 blob 内容＝调用方先取回字节再传），
  // 留着那一支只会让人以为传个引用就能落地，实际写个静默的空文件。
  // @ts-expect-error `WriteData` 上没有 `blob` 这一支
  const blob: WriteData = { blob: 'blob_7' }
  void blob
}

/** `Sandbox.read` 的 `opts` **可省**（省了走实现常量 64 KiB）；给了就是显式上限。 */
export function sandboxReadOptsAreOptional(): void {
  const call = (sandbox: Sandbox, path: string): void => {
    void sandbox.read(path) // 可省——阶段 1 的两参写法一字不动
    void sandbox.read(path, {}) // 空选项也是合法调用
    // `edit` 的口子：整文才能唯一定位与安全回写，故显式放大上限（实现常量 1 MiB）
    void sandbox.read(path, { maxBytes: 1024 * 1024 })
  }

  void call
}

/** 「总是允许」＝答复上的**位**——`DecisionAnswer.remember` 可省（**向后兼容**）。 */
export function decisionAnswerRememberIsOptional(): void {
  const oneShot: DecisionAnswer = { type: 'decision.answer', id: 1, decision: 'approve' }
  const always: DecisionAnswer = { type: 'decision.answer', id: 1, decision: 'approve', remember: true }

  void oneShot
  void always

  // **不是裁决词表的第三词**——`Decision` 仍是两词，`tool.decision.decision` 用的是同一个表。
  // @ts-expect-error `Decision` 只有 'approve' / 'reject'
  const thirdWord: DecisionAnswer = { type: 'decision.answer', id: 1, decision: 'always' }
  void thirdWord
}

/** 那个位**两个端口都过得去**：`CommandRoutes.onDecision` 与 `PermissionGate.resolve`。 */
export function rememberTravelsThroughBothPorts(): void {
  // 两参写法照收——旧装配的字面一字不动（向后兼容）
  const legacy: CommandRoutes = {
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: (id, decision) => void [id, decision],
    onModelSwitch: () => undefined,
    onSession: () => undefined,
    onHistoryRead: () => undefined,
    onModelList: () => undefined,
    onModelRefresh: () => undefined,
    onModelDefaultSet: () => undefined,
    onProviderList: () => undefined,
    onProviderSave: () => undefined,
    onProviderRemove: () => undefined,
    onGrantsList: () => undefined,
    onGrantsRevoke: () => undefined,
    onSkillList: () => undefined,
    onPathList: () => undefined,
    onMcpList: () => undefined,
    onMcpReconnect: () => undefined,
  }
  const widened: CommandRoutes = {
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: (id, decision, opts) => void [id, decision, opts?.remember],
    onModelSwitch: () => undefined,
    onSession: () => undefined,
    onHistoryRead: () => undefined,
    onModelList: () => undefined,
    onModelRefresh: () => undefined,
    onModelDefaultSet: () => undefined,
    onProviderList: () => undefined,
    onProviderSave: () => undefined,
    onProviderRemove: () => undefined,
    onGrantsList: () => undefined,
    onGrantsRevoke: () => undefined,
    onSkillList: () => undefined,
    onPathList: () => undefined,
    onMcpList: () => undefined,
    onMcpReconnect: () => undefined,
  }

  // 端口面持有 → 三参调用成立（这正是装配把位递给权限域的那一跳）
  const gate: PermissionGate = {
    decide(call: ToolCall): Promise<Decision> {
      void call
      return Promise.resolve('approve')
    },
    /** 实现面**可以少写参数**——端口上第三参是可选的 */
    resolve(requestId: DecisionId, decision: Decision): void {
      void [requestId, decision]
    },
  }

  void legacy
  void widened
  void gate.resolve(1, 'approve') // 不给＝一次性
  void gate.resolve(1, 'approve', { remember: true }) // 给了＝批准 ＋ 记住
}

/** 权限段——`MagicConfig.permissions.rules` 是阶段 2 的加键（缺省＝无规则＝一律问）。 */
export function configCarriesPermissionRules(): void {
  const bare: MagicConfig = { defaultProvider: 'p', providers: {}, dataDir: '/tmp' }
  const withRules: MagicConfig = {
    defaultProvider: 'p',
    providers: {},
    dataDir: '/tmp',
    // 条目形态**不在这里复述**——权威是权限域的 `parseRules`（故此处是原值，交它解析）
    permissions: { rules: [{ tool: 'exec', op: 'read' }] },
  }

  void bare
  void withRules
}

// —— 第 17 轮补锚（阶段 2 波次 2 · 换模型命令 ＋ 重试事件）——

/** `model.switch` ＝**第四支命令**——两件可选、都不给也合法（内核对空请求报「不知道换什么」）。 */
export function modelSwitchIsFourthCommand(): void {
  const byProvider: Command = { type: 'model.switch', provider: 'minimax-m2' }
  const byModel: Command = { type: 'model.switch', model: 'glm-4.6' }
  const both: Command = { type: 'model.switch', provider: 'zhipu', model: 'glm-4.6' }
  const bare: Command = { type: 'model.switch' } // 都不给——内核据以报「不知道要换成什么」

  void byProvider
  void byModel
  void both
  void bare

  // 旧三支**一字不动**：`input.submit` 少了 `text` 照样编译不过（加词没把老词写松）
  // @ts-expect-error `input.submit` 必须有 `text`
  const broken: Command = { type: 'input.submit' }
  void broken
}

/** 路由侧有 `onModelSwitch`——形态与命令负载同一份（`ModelSwitchRequest`）。 */
export function routesCarryModelSwitch(): void {
  const routes: CommandRoutes = {
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: () => undefined,
    onModelSwitch: (request: ModelSwitchRequest) => void [request.provider, request.model],
    onSession: () => undefined,
    onHistoryRead: () => undefined,
    onModelList: () => undefined,
    onModelRefresh: () => undefined,
    onModelDefaultSet: () => undefined,
    onProviderList: () => undefined,
    onProviderSave: () => undefined,
    onProviderRemove: () => undefined,
    onGrantsList: () => undefined,
    onGrantsRevoke: () => undefined,
    onSkillList: () => undefined,
    onPathList: () => undefined,
    onMcpList: () => undefined,
    onMcpReconnect: () => undefined,
  }
  void routes
}

/**
 * `model.switched` 的载荷（**落库** · 第 18 轮补锚）——换模型的**结果**（用户命令）。
 * 成了带选中、没成只带缘由；两件的可选性把这件事说清楚。
 */
export function modelSwitchedPayloadShape(): void {
  const done: EventDataOf['model.switched'] = { ok: true, provider: 'minimax-m2', model: 'MiniMax-M2' }
  const refused: EventDataOf['model.switched'] = { ok: false, reason: '未知条目「nowhere」' }
  void done
  void refused
}

/**
 * `model.retry` 的载荷——`attempt` / `delayMs` / `tier`（退避只对瞬时档，见其注）＋
 * **`maxAttempts`**（D10 · 第 2 样：`2/3` 的分母）。
 *
 * 两形都收：给了分母＝外壳报得出 `2/3`；没给（旧生产者 / Faux）＝外壳只报「第几次」
 * ——**加词没把老词写松，也没把旧写作方式写死**（可选位是只增不改的落法）。
 */
export function modelRetryPayloadShape(): void {
  const withCap: EventDataOf['model.retry'] = {
    attempt: 2,
    delayMs: 1500,
    tier: 'transient',
    maxAttempts: 3,
  }
  const withoutCap: EventDataOf['model.retry'] = { attempt: 2, delayMs: 1500, tier: 'transient' }
  void withCap
  void withoutCap
}

/**
 * D10 · 三样读数的出口（补锚 · 2026-09-19）——**只增不改**落进契约的三处形。
 *
 * 三样各锚一句「我要什么」：
 * ① `model.usage.contextWindow`——状态行的**分母**跟着**分子**同刻到；没声明窗长的条目
 *    就没这一位（**拿不到就不显示，不编**）；
 * ② `model.retry.maxAttempts`——分母跟着分子；外壳不必自钉常量；
 * ③ `model.list` 命令 → `model.catalog` 事件——`/model` 要**注册表全量** ＋ 「当前是哪条」。
 */
export function readoutsShape(): void {
  // ① 窗长（可选：声明了才有）
  const usageWithWindow: EventDataOf['model.usage'] = {
    inputTokens: 3_100,
    outputTokens: 40,
    contextWindow: 200_000,
  }
  const usageWithout: EventDataOf['model.usage'] = { inputTokens: 3_100, outputTokens: 40 }

  // ③ 条目表 ＋ 当前那条（表按配置顺序；`current` 未必是表里的某一行——见其注）
  const catalog: EventDataOf['model.catalog'] = {
    entries: [
      { provider: 'minimax', model: 'MiniMax-M3', contextWindow: 200_000 },
      { provider: 'local', model: 'qwen3', contextWindow: 32_768 },
    ],
    current: { provider: 'local', model: 'qwen3' },
  }
  // 没有注册表的那一次装配——空表 ＋ 一句说明（空表本身合法，两者不混作一谈）
  const empty: EventDataOf['model.catalog'] = { entries: [], note: '本次装配没有供应商注册表' }

  // 读侧命令：无参（问的就是「都有哪些」）
  const ask: Command = { type: 'model.list' }

  void usageWithWindow
  void usageWithout
  void catalog
  void empty
  void ask
}

/**
 * 会话面（阶段 2 · U16）——`ConversationService` 的会话扩展 ＋ 控制域的会话路由位。
 *
 * 设计原话（技术方案 · 领域划分 · 端口签名）：`interface ConversationService { … }
 * // 多会话（阶段 2）的新建 / 切换 / 列表在此扩展`——故五件落在**同一个端口**上，
 * 不另立一个「会话端口」（同一件事两处各立一份＝两处各有一套语义，迟早分叉）。
 */
export function sessionFaceShape(service: ConversationService, routes: CommandRoutes): void {
  void service.listSessions()
  void service.newSession()
  void service.openSession('s1')
  void service.renameSession('s1', '标题＝首条消息摘要')
  // 重建面（U25）——恢复的第 ⑤ 步：装载 ＋ 认下应用层算好的两件（水位 / 开工已宣告）
  void service.rebuild('s1', { lastTurn: null, announced: false })

  // 控制域**原样转手**——它不认识会话（同 `onDecision` / `onModelSwitch` 的姿势）
  routes.onSession({ type: 'session.list' })
  routes.onSession({ type: 'session.new' })
  routes.onSession({ type: 'session.open', session: 's1' })
  routes.onSession({ type: 'session.rename', session: 's1', title: '改过的标题' })
}

// ══ 运行时断言 ════════════════════════════════════════════════════════

describe('事件契约', () => {
  test('不落库清单含三个实时增量 ＋ 会话状态（U16）＋ 六条读面答复（D10 · U33 · U36 · U39 · U41）', () => {
    // `model.retry` 是**退避期间那个「正在等」**——实时信号、不是重放事实（重放只看终局）；
    // 重试次数另落 `ModelCallResult.attempts`（可断），故不落库不丢信息。
    // `session.state` 同列：它是快照，不是过程事实（见 events.ts 该处注）。
    // 次序照契约里的声明序（`toEqual` 看次序——它也是读清单时看到的那个序）
    expect(TRANSIENT_EVENT_KINDS).toEqual([
      'model.delta',
      'model.retry',
      'tool.output.delta',
      'session.state',
      // 第 19 轮：读面答复同列——它是**读出来的**（条目本就在库里），
      // 落库＝把同一段内容存第二遍；重放要的是「发生过什么」，不是「某人问过一次」
      'session.history',
      // D10 · 第 3 样：模型面读答案同列——**同一判据、不同来源**（原锚是「读出来的不落库」，
      // 表在内存里而不是库里；新锚多一格，判据一个字没松）。`/model` 是反复看的动作，
      // 每次往库里留一笔「问过」只会污染观测；「换过什么模型」另有 `model.switched` 落着。
      'model.catalog',
      // U22：授权名录同列——**又是同一条判据**（表在盘上的 `grants.json` 里，不在库里），
      // 且 `/grants` 也是反复看的抽屉。改动的痕不在「谁看过名录」上，而在文件本身少了一条。
      'grants.catalog',
      // U33 · 终端入口：技能目录同列——**同一条判据的第四处**（目录在盘上，不在库里），
      // 且 `/skills` 也是反复看的动作（选择器）。当时用了哪一份材料另有痕：
      // `user` 条目的载荷（名字 / 来源 / 正文），重放读的是那份。
      'skills.catalog',
      // U36：路径候选同列——**同一条判据的第五处**（目录在盘上，不在库里），
      // 且它是**边打边问**的动作（`@` 之后每改一个字问一次），留痕只会把观测淹掉。
      // 当时带了哪份材料另有痕：`user` 条目的载荷 `refs`（位置 / 来源 / 实际交付内容）。
      'paths.catalog',
      // U33：技能使用回执同列——**同一条判据的第三个来源**（依据在**条目载荷**里：
      // `UserPayload.refs` / 旧形的 `skills` 的名字 / 来源 / 正文），落库＝把同一件事存第二遍。
      'skill.used',
      // U33：提交收场同列——它是**一次答复**（与 `session.state` 同类：快照，不是过程事实），
      // 且它的配对键是**外壳给的**（`UserInput.ref`）：跨进程重开就没人认领了，
      // 落库只会让恢复时读到一堆对不上任何草稿的旧回执。
      'input.settled',
      // U39：外部服务器一屏同列——**同一条判据的第五处**（状态挂在连接上、工具表是
      // 发现的结果，都不在库里），且 `/mcp` 也是反复看的动作。重连也不落库：
      // 它不产生外部效果（重放要的是「发生过什么」）。
      'mcp.catalog',
      // U41：供应商管理面同列——**原锚**是 `model.catalog` 那条「读出来的不落库」
      // （配置本来就在盘上，不在库里）；**为何变**：模型面与供应商面各开了一条读面
      // （`/model` 的主体 ＋ 管理那一屏）；**新锚**：同一判据多一格，字面规则一个没动。
      // 保存 / 移除**这个动作**也不落库：它的痕在配置文件里（少了一条 / 多了一条）。
      'provider.catalog',
    ])
  })

  test('`model.switched` **落库**（换模型是会话的可观测事实，不是实时信号）', () => {
    // 与 `model.retry` 恰成对照：那条描述「正在等」（重放无意义），这条是「何时改的、改成了谁」
    // ——回看时正要看它（第 18 轮补锚：`model.call.start` 只说「这次用了谁」）。
    expect(TRANSIENT_EVENT_KINDS).not.toContain('model.switched')
  })

  test('schema 版本自始写入（当前＝1）', () => {
    // **原锚**（U02）：「自始写入（v0）」——冻结那一刻的形状就是 0。
    // **为何变**：U26 给 `sessions` 加了 `workspace` 列（会话归属工作区），而冻结点
    //   已过 ⇒ 走**顺序迁移**（0 → 1）：版本号得往前推一位，迁移链才有得走
    //   （迁移的落地与真跑见 `@magic/records` · `test/workspace.test.ts`）。
    // **新锚**：同一条规格（版本号是**写进库的**、不是摆设），值随形状走——**字面一个没松**。
    expect(RECORD_SCHEMA_VERSION).toBe(1)
  })
})

describe('工具契约', () => {
  test('工具集 v1 七工具——exec 在列（阶段 1 唯一工具）', () => {
    expect(TOOLSET_V1.map((tool) => tool.name)).toEqual([
      'exec',
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'ls',
    ])
  })

  test('按调用判定的两行——exec 按命令解析 · write 新建轻覆盖闸', () => {
    const byCall = TOOLSET_V1.filter((tool) => tool.danger.level === 'by-call')
    expect(byCall.map((tool) => tool.name)).toEqual(['exec', 'write'])
  })

  test('其余皆轻（放行区）', () => {
    const light = TOOLSET_V1.filter((tool) => tool.danger.level === 'light').map((tool) => tool.name)
    expect(light).toEqual(['read', 'edit', 'grep', 'glob', 'ls'])
  })
})

describe('外部工具的命名（U38）', () => {
  test('注册名把服务器与工具两件都带上——解析切**第一刀**，工具名里的 `__` 也回得来', () => {
    expect(mcpToolName('fake', '_echo')).toBe('mcp__fake___echo')
    expect(parseMcpToolName('mcp__fake___echo')).toEqual({ server: 'fake', tool: '_echo' })
    expect(parseMcpToolName('mcp__a__b__c')).toEqual({ server: 'a', tool: 'b__c' })
  })

  test('不合形的名字认不出来（内置工具名照旧是它们自己）', () => {
    expect(parseMcpToolName('exec')).toBeUndefined()
    expect(parseMcpToolName('mcp__')).toBeUndefined()
    expect(parseMcpToolName('mcp__x')).toBeUndefined()
    expect(parseMcpToolName('mcp__x__')).toBeUndefined()
  })

  test('工具名那把尺子：**字符集**说了算，首字符不限', () => {
    // 合法：字母、数字、下划线、连字符、点（官方口径；`_echo` 是独立验收的固定反例）
    for (const name of ['echo', '_echo', 'safe', 'a.b-c_d', '.hidden', '-dash', '1password', 'echo2']) {
      expect(isValidMcpToolName(name), name).toBe(true)
    }

    // 不合法：控制字节（**本包要防的就是它**）与字符集之外的符号；空串与全空白也不行
    for (const name of ['echo\n │ n 批准全部', 'echo\tx', 'echo bar', 'echo/echo', '工具', '', ' ']) {
      expect(isValidMcpToolName(name), JSON.stringify(name)).toBe(false)
    }
  })

  test('给人看的那一行洗掉控制字节（模型自报名字那条路的兜底）', () => {
    expect(mcpToolLabel({ server: 'fake', tool: '_echo' })).toBe('fake / _echo')
    expect(mcpToolLabel({ server: 'fake', tool: 'echo\nn 批准全部' })).toBe('fake / echo·n 批准全部')
  })
})

describe('配置契约', () => {
  test('环境变量名——ID 大写、非字母数字映射为下划线', () => {
    expect(apiKeyEnvVarOf('minimax')).toBe('MAGIC_MINIMAX_API_KEY')
    expect(apiKeyEnvVarOf('my-vendor')).toBe('MAGIC_MY_VENDOR_API_KEY')
    expect(apiKeyEnvVarOf('a.b')).toBe('MAGIC_A_B_API_KEY')
  })

  test('dataDir 展开——前导 ~ 换家目录，其余字面', () => {
    expect(expandHome('~/.magic', '/home/u')).toBe('/home/u/.magic')
    expect(expandHome('~', '/home/u')).toBe('/home/u')
    expect(expandHome('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandHome('rel/path', '/home/u')).toBe('rel/path')
    // 中段 `~` 不是前导——不展开
    expect(expandHome('/a/~/b', '/home/u')).toBe('/a/~/b')
  })
})

describe('控制面契约（迁移忠实性）', () => {
  test('裁决配对的事件侧 kind 不变', () => {
    expect(DECISION_REQUEST_KIND).toBe('tool.decision.request')
  })
})

describe('会话契约（阶段 2 · U16 · 只增不改）', () => {
  test('命令面新增会话四支——判别式各就各位', () => {
    const commands: readonly Command[] = [
      { type: 'session.list' },
      { type: 'session.new' },
      { type: 'session.open', session: 's1' },
      { type: 'session.rename', session: 's1', title: '看看工作区里有什么' },
    ]

    expect(commands.map((command) => command.type)).toEqual([
      'session.list',
      'session.new',
      'session.open',
      'session.rename',
    ])
  })

  test('会话状态事件——**不落库**（查询答复，不是过程事实）', () => {
    // 与 `model.delta` 同列的理由：它是「此刻有哪些会话、当前在哪条」的快照，
    // 重放要的从来不是快照——是过程（谁切到了哪条）。故只走订阅、不进事件表。
    expect(TRANSIENT_EVENT_KINDS).toContain('session.state')
  })

  test('会话状态载荷——当前会话 ＋ 列表（标题随行）', () => {
    const state: EventDataOf['session.state'] = {
      active: 's1',
      sessions: [
        { id: 's1', title: '看看工作区里有什么', at: 1 },
        { id: 's2', at: 2 },
      ],
    }

    expect(state.sessions[0]?.title).toBe('看看工作区里有什么')
    // 标题是可选位——没改过、也派生不出时缺席（不是空串占位）
    expect(state.sessions[1]?.title).toBeUndefined()
  })
})

