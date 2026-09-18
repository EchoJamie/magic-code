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
  expandDataDir,
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
      const tokens: number = e.data.inputTokens
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
  }
  const widened: CommandRoutes = {
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: (id, decision, opts) => void [id, decision, opts?.remember],
    onModelSwitch: () => undefined,
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

/** `model.retry` 的载荷——`attempt` / `delayMs` / `tier`（退避只对瞬时档，见其注）。 */
export function modelRetryPayloadShape(): void {
  const retry: EventDataOf['model.retry'] = { attempt: 2, delayMs: 1500, tier: 'transient' }
  void retry
}

// ══ 运行时断言 ════════════════════════════════════════════════════════

describe('事件契约', () => {
  test('不落库清单含三个实时增量（model.delta · model.retry · tool.output.delta）', () => {
    // `model.retry` 是**退避期间那个「正在等」**——实时信号、不是重放事实（重放只看终局）；
    // 重试次数另落 `ModelCallResult.attempts`（可断），故不落库不丢信息。
    expect(TRANSIENT_EVENT_KINDS).toEqual(['model.delta', 'model.retry', 'tool.output.delta'])
  })

  test('`model.switched` **落库**（换模型是会话的可观测事实，不是实时信号）', () => {
    // 与 `model.retry` 恰成对照：那条描述「正在等」（重放无意义），这条是「何时改的、改成了谁」
    // ——回看时正要看它（第 18 轮补锚：`model.call.start` 只说「这次用了谁」）。
    expect(TRANSIENT_EVENT_KINDS).not.toContain('model.switched')
  })

  test('schema 版本自始写入（v0）', () => {
    expect(RECORD_SCHEMA_VERSION).toBe(0)
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

describe('配置契约', () => {
  test('环境变量名——ID 大写、非字母数字映射为下划线', () => {
    expect(apiKeyEnvVarOf('minimax')).toBe('MAGIC_MINIMAX_API_KEY')
    expect(apiKeyEnvVarOf('my-vendor')).toBe('MAGIC_MY_VENDOR_API_KEY')
    expect(apiKeyEnvVarOf('a.b')).toBe('MAGIC_A_B_API_KEY')
  })

  test('dataDir 展开——前导 ~ 换家目录，其余字面', () => {
    expect(expandDataDir('~/.magic', '/home/u')).toBe('/home/u/.magic')
    expect(expandDataDir('~', '/home/u')).toBe('/home/u')
    expect(expandDataDir('/abs/path', '/home/u')).toBe('/abs/path')
    expect(expandDataDir('rel/path', '/home/u')).toBe('rel/path')
    // 中段 `~` 不是前导——不展开
    expect(expandDataDir('/a/~/b', '/home/u')).toBe('/a/~/b')
  })
})

describe('控制面契约（迁移忠实性）', () => {
  test('裁决配对的事件侧 kind 不变', () => {
    expect(DECISION_REQUEST_KIND).toBe('tool.decision.request')
  })
})

