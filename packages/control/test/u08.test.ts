/**
 * M03 · 控制域（搬自旧 U08）测试 —— 验收：**通道回环：命令进 · 事件出**。
 *
 * 与旧版的分别：**一切经端口**——域侧只认 `ControlHub`（`bind` / `attach` / `emit`），
 * 外壳侧只认 `ControlTransport`（`send` / `subscribe`）；旧的 `createControlChannel`
 * 直接调用姿势已收进实现内部，测试不再碰（工作分解 · M03：对外只经两个端口）。
 *
 * 六组：
 * 1. 回环——命令进 → 路由 → 事件出 → 订阅方收到（验收句本身）；
 * 2. 命令进——原样投给路由；**裁决配对＝请求事件 id**（不是 `call`）；无路可走＝丢弃；
 * 3. 事件出——订阅方收到，载荷 **JSON 往返等价**；按 `kind` **自动收窄**（无 `as`）；
 * 4. 端口纪律——二次 `bind` / `attach` 换新摘旧；退订幂等；无订阅方丢弃不抛；
 * 5. 可序列化——订阅方收到的是**纯数据**；非纯数据在**投递前**被拦（点名路径）；
 * 6. 跨进程留缝——JSON 文本往返后喂进通道，原样到达对端（第二站 / 第三站）。
 *
 * 桩路由＝U04 / U07 落位前的占位：本单元只验**通道**，不验循环与裁决。
 */

import { describe, expect, test } from 'bun:test'
import type {
  Command,
  CommandRoutes,
  ControlHub,
  ControlTransport,
  DecisionId,
  EventEnvelope,
  EventKind,
  EventSink,
  KernelEvent,
  KernelTransport,
} from '@magic/contracts'
import {
  assertSerializable,
  createControlHub,
  createInProcessTransportPair,
  isSerializable,
} from '../src/index.ts'

// —— 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）——

/** 命令按 `type` 收窄——裁决答复的配对键是 `id`。 */
export function commandNarrowsByType(): void {
  const answer: Command = { type: 'decision.answer', id: 42, decision: 'approve' }

  if (answer.type === 'decision.answer') {
    const id: DecisionId = answer.id
    const decision: 'approve' | 'reject' = answer.decision
    void id
    void decision
  }

  // @ts-expect-error 裁决答复必须带配对键 id（请求事件的 id）
  const missingId: Command = { type: 'decision.answer', decision: 'approve' }
  void missingId
}

/** 命令目录穷尽——新增 kind 时此处缺返回，tsc 报错。 */
export function commandSubjectOf(command: Command): string {
  switch (command.type) {
    case 'input.submit':
      return command.text
    case 'decision.answer':
      return `${command.id}：${command.decision}`
    case 'turn.interrupt':
      return '中断'
    case 'model.switch':
      // 第 17 轮第四支——两件都可缺，缺了就说「缺什么」
      return `换模型：${command.provider ?? '（不换条目）'} / ${command.model ?? '（不换模型）'}`
    case 'session.list':
      return '列会话'
    case 'session.new':
      return '新会话'
    case 'session.open':
      return `开会话：${command.session}`
    case 'session.rename':
      return `改会话名：${command.session} → ${command.title}`
  }
}

/**
 * 事件按 `kind` **自动收窄**——M01 判别联合视图带来的姿势（旧结构此处须 `as` 强转）。
 * 本探针是 M03 判据「消费不走强转」的编译期证据。
 */
export function kernelEventNarrowsByKind(event: KernelEvent): number {
  if (event.kind === 'tool.decision.request') {
    return event.data.call // 自动收窄——无 `as`
  }
  if (event.kind === 'tool.decision') {
    return event.data.elapsedMs // 另一个 kind：同样自动收窄
  }
  return 0
}

/** 收窄是**判别式**——载荷不合该 kind 的形态即报错。 */
export function kernelEventRejectsWrongPayload(): void {
  const wrongReason: KernelEvent = {
    id: 1,
    session: 's1',
    turn: null,
    at: 0,
    kind: 'turn.end',
    // @ts-expect-error `turn.end` 的结束方式只有收束 / 中止 / 错误
    data: { reason: 'exploded' },
  }
  void wrongReason
}

/** 外壳侧一端即契约 `ControlTransport`——换传输（第二站 / 第三站）认的就是这个形状。 */
export function shellEndIsContractTransport(): void {
  const { shell } = createInProcessTransportPair()
  const transport: ControlTransport = shell
  void transport
}

/**
 * 域面即端口——`createControlHub()` 的产物**直接就是**契约 `ControlHub`（两动作），
 * 其 `emit` 即契约 `EventSink`。**编译期自证**：端口与实现靠 tsc 钉住，不靠注释对齐。
 */
export function hubFaceRealizesPort(): void {
  const hub = createControlHub()

  // 两动作 → 契约 `ControlHub`
  const port: ControlHub = hub
  port.bind({
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: () => undefined,
    onModelSwitch: () => undefined,
    onSession: () => undefined,
  })
  port.attach({ send: () => undefined, subscribe: () => () => undefined })

  // 广播入口 → 契约 `EventSink`
  const sink: EventSink = hub
  sink.emit(envelope(1, 'agent.end', {}))
}

/** 内核侧一端即契约 `KernelTransport`——`attach` 的入参就是它（端口内类型）。 */
export function kernelEndIsContractTransport(): void {
  const { kernel } = createInProcessTransportPair()
  const transport: KernelTransport = kernel
  void transport
}

/** 域侧路由即契约 `CommandRoutes`——五条命令各一路由，不多不少。 */
export function routesAreContractShape(): void {
  const routes: CommandRoutes = {
    onInput: (input) => void input.text,
    onInterrupt: () => undefined,
    onDecision: (id, decision) => void [id, decision],
    onModelSwitch: (request) => void [request.provider, request.model],
    onSession: (command) => void command.type,
  }
  void routes
}

// —— 夹具 ——

const SESSION = 's1'
const AT = 1_756_000_000_000

/** 造一条事件（信封六字段齐）——id 由调用方给，便于断言配对。 */
function envelope<K extends EventKind>(
  id: number,
  kind: K,
  data: EventEnvelope<K>['data'],
): EventEnvelope<K> {
  return { id, session: SESSION, turn: 1, at: AT, kind, data }
}

/** 空路由——只关心某一支时补齐其余（`CommandRoutes` 五路由皆必填）。 */
function routesWith(overrides: Partial<CommandRoutes>): CommandRoutes {
  return {
    onInput: () => undefined,
    onInterrupt: () => undefined,
    onDecision: () => undefined,
    onModelSwitch: () => undefined,
    onSession: () => undefined,
    ...overrides,
  }
}

// —— 验收：通道回环 ——

describe('通道回环——命令进 · 事件出', () => {
  test('桩主循环：input.submit 进 → 事件出 · 订阅方按序收到', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const seen: KernelEvent[] = []

    // 桩主循环——U04 落位前的占位：收命令 → 推事件（正是通道要保证的那一段）
    hub.bind(
      routesWith({
        onInput: (input) => {
          hub.emit(envelope(1, 'message.user', { entry: 11 }))
          hub.emit(envelope(2, 'turn.start', {}))
          expect(input.text).toContain('ls') // 命令原样到达
        },
        onInterrupt: () => {
          hub.emit(envelope(3, 'turn.end', { reason: 'aborted' }))
        },
      }),
    )
    hub.attach(kernel)
    shell.subscribe((event) => seen.push(event))

    shell.send({ type: 'input.submit', text: '在 playground 里跑一下 ls' })
    shell.send({ type: 'turn.interrupt' })

    expect(seen.map((event) => event.kind)).toEqual(['message.user', 'turn.start', 'turn.end'])
    expect(seen[0]?.data).toEqual({ entry: 11 }) // 事件载荷原样送达
    expect(seen[2]?.data).toEqual({ reason: 'aborted' }) // 命令语义 → 事件语义
    expect(seen[2]?.session).toBe(SESSION)
  })

  test('装配顺序纪律——先接订阅、后放开输入：反向则命令丢弃（不排队）', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    let inputs = 0
    hub.bind(
      routesWith({
        onInput: () => {
          inputs += 1
        },
      }),
    )

    // 传输还没接上就放开输入——用户输入无声丢失（Emitter 语义）
    expect(() => shell.send({ type: 'input.submit', text: '早了' })).not.toThrow()
    expect(inputs).toBe(0)

    hub.attach(kernel)
    shell.send({ type: 'input.submit', text: '接上了' })
    expect(inputs).toBe(1) // 后来者能到——但先前那条不补发
  })
})

// —— 命令进（外壳 → 内核）——

describe('命令进——外壳 → 内核', () => {
  test('三条命令原样投给路由，且 JSON 往返等价', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const got: Command[] = []

    hub.bind(
      routesWith({
        onInput: (input) => got.push({ type: 'input.submit', ...input }),
        onInterrupt: () => got.push({ type: 'turn.interrupt' }),
        onDecision: (id, decision) => got.push({ type: 'decision.answer', id, decision }),
      }),
    )
    hub.attach(kernel)

    shell.send({ type: 'input.submit', text: '把 README 读一遍' })
    shell.send({ type: 'decision.answer', id: 42, decision: 'approve' })
    shell.send({ type: 'turn.interrupt' })

    const expected: Command[] = [
      { type: 'input.submit', text: '把 README 读一遍' },
      { type: 'decision.answer', id: 42, decision: 'approve' },
      { type: 'turn.interrupt' },
    ]
    expect(got).toEqual(expected)
    expect(JSON.parse(JSON.stringify(got))).toEqual(expected)
  })

  test('「总是允许」**原样转手**——控制域不翻译，只把位递给路由', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    // 路由侧记下**收到的第三参**——这正是权限域 `resolve` 会拿到的那一件
    const seen: { readonly id: DecisionId; readonly decision: string; readonly remember: boolean | undefined }[] = []

    hub.bind(
      routesWith({
        onDecision: (id, decision, opts) => seen.push({ id, decision, remember: opts?.remember }),
      }),
    )
    hub.attach(kernel)

    shell.send({ type: 'decision.answer', id: 42, decision: 'approve', remember: true })
    shell.send({ type: 'decision.answer', id: 43, decision: 'approve' })

    // 给了＝递下去；没给＝`undefined`（**不替用户补 `false`**——控制域没有语义可翻）
    expect(seen).toEqual([
      { id: 42, decision: 'approve', remember: true },
      { id: 43, decision: 'approve', remember: undefined },
    ])
  })

  test('带 `remember` 的答复照过可序列化门（**布尔位**，不是类实例 / undefined）', () => {
    // 通道投递前逐条校验（JSON 往返无损）——`remember: true` 必须安然通过。
    // 反面：若有人图省事写成 `remember: undefined`，那一位会被拒投（丢键＝有损）。
    expect(isSerializable({ type: 'decision.answer', id: 42, decision: 'approve', remember: true })).toBe(true)
    expect(isSerializable({ type: 'decision.answer', id: 42, decision: 'approve', remember: undefined })).toBe(false)
  })

  test('换模型**原样转手**——控制域不认识注册表，也不知道换得成换不成', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const seen: { readonly provider: string | undefined; readonly model: string | undefined }[] = []

    hub.bind(
      routesWith({
        onModelSwitch: (request) => seen.push({ provider: request.provider, model: request.model }),
      }),
    )
    hub.attach(kernel)

    shell.send({ type: 'model.switch', provider: 'minimax-m2' })
    shell.send({ type: 'model.switch', model: 'glm-4.6' })
    shell.send({ type: 'model.switch' })

    // 缺的那一件是 `undefined`（**不替用户补空串**——空串是个合法名字，补了就分不清「没给」）
    expect(seen).toEqual([
      { provider: 'minimax-m2', model: undefined },
      { provider: undefined, model: 'glm-4.6' },
      { provider: undefined, model: undefined },
    ])
  })

  test('会话命令**原样转手**——控制域不认识会话，也不知道开得成开不成', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const seen: Command[] = []

    hub.bind(routesWith({ onSession: (command) => seen.push(command) }))
    hub.attach(kernel)

    shell.send({ type: 'session.list' })
    shell.send({ type: 'session.new' })
    shell.send({ type: 'session.open', session: 's-beta' })
    shell.send({ type: 'session.rename', session: 's-beta', title: '换了个名字' })

    // 一字不改地到达——控制域**不做翻译**（同 `remember` 与 `model.switch` 的姿势）
    expect(seen).toEqual([
      { type: 'session.list' },
      { type: 'session.new' },
      { type: 'session.open', session: 's-beta' },
      { type: 'session.rename', session: 's-beta', title: '换了个名字' },
    ])
  })

  test('裁决答复按**请求事件 id** 配对——与 `call` 字段两 id 不混', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const answers: [DecisionId, string][] = []
    let requestId = 0

    hub.bind(routesWith({ onDecision: (id, decision) => answers.push([id, decision]) }))
    hub.attach(kernel)

    shell.subscribe((event) => {
      if (event.kind !== 'tool.decision.request') return
      // **自动收窄**——`event.data` 已是该 kind 的载荷，无 `as`（旧写法须强转）
      requestId = event.id
      expect(event.data.call).toBe(7) // 调用链 id ≠ 请求事件 id
      expect(event.data.weight).toBe('heavy')
    })

    // 内核出请求事件——id＝配对键 42；data.call＝该次调用的 tool.call 事件 id 7
    hub.emit(
      envelope(42, 'tool.decision.request', {
        call: 7,
        name: 'write',
        material: '覆盖 playground/a.txt（整写）',
        weight: 'heavy',
      }),
    )
    expect(requestId).toBe(42)

    // 外壳按**请求事件 id** 答复（不是按 call）
    shell.send({ type: 'decision.answer', id: requestId, decision: 'approve' })

    expect(answers).toEqual([[42, 'approve']])
    // 误用 call 配对时 id 会是 7——此处明证不是
    expect(answers).not.toEqual([[7, 'approve']])
  })

  test('未装路由＝丢弃不抛（与无订阅方同一条纪律）', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    hub.attach(kernel)

    expect(() => shell.send({ type: 'turn.interrupt' })).not.toThrow()
    expect(() => hub.emit(envelope(1, 'agent.end', {}))).not.toThrow()
  })
})

// —— 事件出（内核 → 外壳）——

describe('事件出——内核 → 外壳', () => {
  test('订阅方收到事件，且载荷 JSON 往返等价（可序列化）', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const got: KernelEvent[] = []
    hub.attach(kernel)
    shell.subscribe((event) => got.push(event))

    const events: KernelEvent[] = [
      envelope(1, 'agent.start', {}),
      envelope(2, 'model.delta', { channel: 'text', text: '先看一眼目录…' }),
      envelope(3, 'model.usage', { inputTokens: 12, outputTokens: 3 }),
      envelope(4, 'tool.result', { call: 9, ok: false, output: { text: 'exit 1' } }),
      envelope(5, 'tool.result', { call: 9, ok: true, output: { blob: 'blob-7' } }),
    ]
    for (const event of events) hub.emit(event)

    expect(got).toEqual(events)

    for (const event of got) {
      const roundTripped: KernelEvent = JSON.parse(JSON.stringify(event))
      expect(roundTripped).toEqual(event) // 往返等价——跨进程 / 跨设备不会掉东西
      expect(isSerializable(roundTripped)).toBe(true) // 且仍过守护
    }
  })
})

// —— 端口纪律 ——

describe('端口纪律', () => {
  test('事件扇出给全部订阅方；退订后不再收；退订幂等', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const first: KernelEvent[] = []
    const second: KernelEvent[] = []
    const offFirst = shell.subscribe((event) => first.push(event))
    shell.subscribe((event) => second.push(event))
    hub.attach(kernel)

    hub.emit(envelope(1, 'agent.start', {}))
    offFirst()
    offFirst() // 幂等——重复退订无害
    hub.emit(envelope(2, 'agent.end', {}))

    expect(first.map((event) => event.id)).toEqual([1])
    expect(second.map((event) => event.id)).toEqual([1, 2])
  })

  test('二次 bind 换路由——新路由接手，旧的摘掉', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    let first = 0
    let second = 0
    hub.bind(routesWith({ onInterrupt: () => (first += 1) }))
    hub.attach(kernel)

    shell.send({ type: 'turn.interrupt' })
    hub.bind(routesWith({ onInterrupt: () => (second += 1) }))
    shell.send({ type: 'turn.interrupt' })

    expect(first).toBe(1)
    expect(second).toBe(1)
  })

  test('二次 attach 换传输——新传输接手，旧的摘掉（不留两条链路）', () => {
    const hub = createControlHub()
    const before = createInProcessTransportPair()
    const after = createInProcessTransportPair()
    const seenByFirst: KernelEvent[] = []
    const seenBySecond: KernelEvent[] = []
    before.shell.subscribe((event) => seenByFirst.push(event))
    after.shell.subscribe((event) => seenBySecond.push(event))

    hub.attach(before.kernel)
    hub.emit(envelope(1, 'agent.start', {}))
    hub.attach(after.kernel)
    hub.emit(envelope(2, 'agent.end', {}))

    expect(seenByFirst.map((event) => event.id)).toEqual([1])
    expect(seenBySecond.map((event) => event.id)).toEqual([2])
  })
})

// —— 可序列化守护 ——

describe('可序列化守护（消息是纯数据）', () => {
  test('契约消息形态皆过——含冻结对象', () => {
    const messages: unknown[] = [
      { type: 'input.submit', text: 'x' },
      { type: 'turn.interrupt' },
      envelope(1, 'tool.call', { name: 'exec', args: { cmd: 'ls', flags: ['-la'], depth: 1 } }),
      envelope(2, 'tool.decision.request', {
        call: 7,
        name: 'write',
        material: '',
        weight: 'light',
      }),
      Object.freeze({ type: 'decision.answer', id: 1, decision: 'reject' }),
    ]

    for (const message of messages) expect(isSerializable(message)).toBe(true)
  })

  test('函数 / 类实例 / undefined / 非有限数 / 环 皆不过；图不误判', () => {
    expect(isSerializable({ material: () => 'diff' })).toBe(false) // 函数
    expect(isSerializable({ at: new Date() })).toBe(false) // 类实例
    expect(isSerializable({ name: undefined })).toBe(false) // JSON 丢键——有损
    expect(isSerializable({ inputTokens: Number.NaN })).toBe(false) // 变 null——有损
    expect(isSerializable({ inputTokens: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isSerializable([undefined])).toBe(false) // 数组洞里变 null
    expect(isSerializable({ big: 1n })).toBe(false)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isSerializable(cyclic)).toBe(false) // 环——JSON.stringify 抛

    const shared = { text: '同一份' } // 图（多处引用同一对象）不是环
    expect(isSerializable({ a: shared, b: shared })).toBe(true)
  })

  test('assertSerializable——抛 TypeError 并点名路径', () => {
    expect(() => assertSerializable({ data: { args: { env: new Map() } } }, '事件')).toThrow(
      /事件不可序列化.*data\.args\.env/,
    )
    expect(() => assertSerializable(() => 'x')).toThrow(TypeError)
    expect(() => assertSerializable({ ok: true }, '事件')).not.toThrow()
  })

  test('通道投递前拦截——违规消息不达对端；好消息照常通行', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    let commands = 0
    let events = 0
    hub.bind(
      routesWith({
        onInterrupt: () => {
          commands += 1
        },
      }),
    )
    hub.attach(kernel)
    shell.subscribe(() => {
      events += 1
    })

    const badCommand = { type: 'input.submit', text: () => 'x' } as unknown as Command
    const badEvent = {
      ...envelope(1, 'tool.call', { name: 'exec', args: {} }),
      data: { name: 'exec', args: { env: new Map() } },
    } as unknown as KernelEvent

    expect(() => shell.send(badCommand)).toThrow(/命令不可序列化.*text/)
    expect(() => hub.emit(badEvent)).toThrow(/事件不可序列化.*data\.args\.env/)
    expect(commands).toBe(0) // 拦在投递前——对端没被惊动
    expect(events).toBe(0)

    shell.send({ type: 'turn.interrupt' })
    hub.emit(envelope(2, 'agent.end', {}))
    expect(commands).toBe(1) // 拦的是非纯数据，不是「一律拒」
    expect(events).toBe(1)
  })
})

// —— 跨进程留缝（第二站 / 第三站）——

describe('跨进程留缝', () => {
  test('桥接形态——对端 JSON 文本 parse 后照走通道', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const got: Command[] = []
    hub.bind(routesWith({ onInput: (input) => got.push({ type: 'input.submit', ...input }) }))
    hub.attach(kernel)

    // 模拟跨进程桥接：外壳侧序列化成文本 → 内核侧 parse 回消息 → 喂进 send 即达
    const wire = JSON.stringify({ type: 'input.submit', text: '从另一进程来' })
    shell.send(JSON.parse(wire) as Command)

    expect(got).toEqual([{ type: 'input.submit', text: '从另一进程来' }])
  })

  test('事件过线往返——JSON 文本落地再 parse，原样到达订阅方', () => {
    const hub = createControlHub()
    const { kernel, shell } = createInProcessTransportPair()
    const seen: KernelEvent[] = []
    hub.attach(kernel)
    shell.subscribe((event) => seen.push(event))

    const request = envelope(42, 'tool.decision.request', {
      call: 7,
      name: 'write',
      material: '覆盖 playground/a.txt',
      weight: 'heavy',
    })

    // 模拟跨设备：内核侧序列化 → 文本过线 → 外壳侧 parse 回消息
    const wire = JSON.stringify(request)
    const arrived: KernelEvent = JSON.parse(wire)

    expect(arrived).toEqual(request) // 过线无损
    expect(isSerializable(arrived)).toBe(true)
  })
})
