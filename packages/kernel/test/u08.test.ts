/**
 * U08 · 控制面（内核侧）测试 —— 验收：**通道回环：命令进 · 事件出**。
 *
 * 四组：
 * 1. 回环——送命令进 → 桩主循环收到 → 推事件出 → 订阅方收到（验收句本身）；
 * 2. 两方向——命令原样投给内核侧；事件投给全部订阅方，载荷 **JSON 往返等价**；
 * 3. 裁决配对——`tool.decision.request` ↔ `decision.answer` 同 **请求事件 id**；
 *    与 `tool.*` 的 `call` 字段**两 id 不混**（技术方案 · 记录 :159 明标）；
 * 4. 可序列化——订阅方收到的是**纯数据**；非纯数据在**投递前**被拦（点名路径）。
 *
 * 桩主循环＝U04 落位前的占位：本单元只验**通道**，不验循环（主循环归 U04）。
 */

import { describe, expect, test } from 'bun:test'
import { assertSerializable, createControlChannel, isSerializable } from '../src/control/index.ts'
import type { Command, KernelEvent } from '../src/contracts/index.ts'
import type { EventEnvelope } from '../src/contracts/index.ts'

// —— 类型层探针（tsc 校验；`bun test` 只剥类型，不做检查）——

/** 命令按 `type` 收窄——裁决答复的配对键是 `id`。 */
export function commandNarrowsByType(): void {
  const answer: Command = { type: 'decision.answer', id: 42, decision: 'approve' }

  if (answer.type === 'decision.answer') {
    const id: number = answer.id
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
  }
}

/** `KernelEvent` 即记录契约的事件信封（控制面不另立事件形态）。 */
export function kernelEventIsEnvelope(): void {
  const envelope: EventEnvelope = {
    id: 1,
    session: 's1',
    turn: null,
    at: 0,
    kind: 'turn.end',
    data: { reason: 'settled' },
  }
  const event: KernelEvent = envelope
  void event

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

// —— 夹具 ——

const SESSION = 's1'
const AT = 1_756_000_000_000

/** 造一条事件（信封六字段齐）——id 由调用方给，便于断言配对。 */
function envelope<K extends KernelEvent['kind']>(
  id: number,
  kind: K,
  data: EventEnvelope<K>['data'],
): EventEnvelope<K> {
  return { id, session: SESSION, turn: 1, at: AT, kind, data }
}

// —— 验收：通道回环 ——

describe('通道回环——命令进 · 事件出', () => {
  test('桩主循环：input.submit 进 → 事件出 · 订阅方按序收到', () => {
    const channel = createControlChannel()
    const seen: KernelEvent[] = []
    channel.subscribe((event) => seen.push(event))

    // 桩主循环——U04 落位前的占位：收命令 → 推事件（正是通道要保证的那一段）
    channel.onCommand((command) => {
      if (command.type === 'input.submit') {
        channel.publish(envelope(1, 'message.user', { entry: 11 }))
        channel.publish(envelope(2, 'turn.start', {}))
      } else if (command.type === 'turn.interrupt') {
        channel.publish(envelope(3, 'turn.end', { reason: 'aborted' }))
      }
    })

    channel.send({ type: 'input.submit', text: '在 playground 里跑一下 ls' })
    channel.send({ type: 'turn.interrupt' })

    expect(seen.map((event) => event.kind)).toEqual(['message.user', 'turn.start', 'turn.end'])
    expect(seen[0]?.data).toEqual({ entry: 11 }) // 事件载荷原样送达
    expect(seen[2]?.data).toEqual({ reason: 'aborted' }) // 命令语义 → 事件语义
    expect(seen[2]?.session).toBe(SESSION)
  })
})

// —— 命令进（外壳 → 内核）——

describe('命令进——外壳 → 内核', () => {
  test('三条命令原样投给内核侧订阅方，且 JSON 往返等价', () => {
    const channel = createControlChannel()
    const got: Command[] = []
    channel.onCommand((command) => got.push(command))

    channel.send({ type: 'input.submit', text: '把 README 读一遍' })
    channel.send({ type: 'decision.answer', id: 42, decision: 'approve' })
    channel.send({ type: 'turn.interrupt' })

    const expected: Command[] = [
      { type: 'input.submit', text: '把 README 读一遍' },
      { type: 'decision.answer', id: 42, decision: 'approve' },
      { type: 'turn.interrupt' },
    ]
    expect(got).toEqual(expected)
    expect(JSON.parse(JSON.stringify(got))).toEqual(expected)
  })

  test('桥接形态——对端 JSON 文本 parse 后照走通道（第二站留缝）', () => {
    const channel = createControlChannel()
    const got: Command[] = []
    channel.onCommand((command) => got.push(command))

    // 模拟跨进程桥接：外壳侧序列化成文本 → 内核侧 parse 回消息 → 喂进 send 即达
    const wire = JSON.stringify({ type: 'input.submit', text: '从另一进程来' })
    channel.send(JSON.parse(wire) as Command)

    expect(got).toEqual([{ type: 'input.submit', text: '从另一进程来' }])
  })

  test('裁决答复按**请求事件 id** 配对——与 `call` 字段两 id 不混', () => {
    const channel = createControlChannel()
    const answers: Command[] = []
    let requestId = 0

    channel.onCommand((command) => answers.push(command))
    channel.subscribe((event) => {
      if (event.kind !== 'tool.decision.request') return
      // 契约信封是**泛型收窄**（`EventEnvelope<'kind'>`）——消费侧按 kind 显式收窄
      const request = event as EventEnvelope<'tool.decision.request'>
      requestId = request.id
      expect(request.data.call).toBe(7) // 调用链 id ≠ 请求事件 id
    })

    // 内核出请求事件——id＝配对键 42；data.call＝该次调用的 tool.call 事件 id 7
    channel.publish(
      envelope(42, 'tool.decision.request', {
        call: 7,
        name: 'write',
        material: '覆盖 playground/a.txt（整写）',
        weight: 'heavy',
      }),
    )
    expect(requestId).toBe(42)

    // 外壳按**请求事件 id** 答复（不是按 call）
    channel.send({ type: 'decision.answer', id: requestId, decision: 'approve' })

    expect(answers).toEqual([{ type: 'decision.answer', id: 42, decision: 'approve' }])
    // 误用 call 配对时 id 会是 7——此处明证不是
    expect(answers).not.toEqual([{ type: 'decision.answer', id: 7, decision: 'approve' }])
  })
})

// —— 事件出（内核 → 外壳）——

describe('事件出——内核 → 外壳', () => {
  test('订阅方收到事件，且载荷 JSON 往返等价（可序列化）', () => {
    const channel = createControlChannel()
    const got: KernelEvent[] = []
    channel.subscribe((event) => got.push(event))

    const events: KernelEvent[] = [
      envelope(1, 'agent.start', {}),
      envelope(2, 'model.delta', { channel: 'text', text: '先看一眼目录…' }),
      envelope(3, 'model.usage', { inputTokens: 12, outputTokens: 3 }),
      envelope(4, 'tool.result', { call: 9, ok: false, output: { text: 'exit 1' } }),
      envelope(5, 'tool.result', { call: 9, ok: true, output: { blob: 'blob-7' } }),
    ]
    for (const event of events) channel.publish(event)

    expect(got).toEqual(events)

    for (const event of got) {
      const roundTripped: KernelEvent = JSON.parse(JSON.stringify(event))
      expect(roundTripped).toEqual(event) // 往返等价——跨进程 / 跨设备不会掉东西
      expect(isSerializable(roundTripped)).toBe(true) // 且仍过守护
    }
  })
})

// —— 订阅机制 ——

describe('订阅机制', () => {
  test('事件扇出给全部订阅方；退订后不再收；退订幂等', () => {
    const channel = createControlChannel()
    const first: KernelEvent[] = []
    const second: KernelEvent[] = []
    const offFirst = channel.subscribe((event) => first.push(event))
    channel.subscribe((event) => second.push(event))

    channel.publish(envelope(1, 'agent.start', {}))
    offFirst()
    offFirst() // 幂等——重复退订无害
    channel.publish(envelope(2, 'agent.end', {}))

    expect(first.map((event) => event.id)).toEqual([1])
    expect(second.map((event) => event.id)).toEqual([1, 2])
  })

  test('命令扇出给多个内核侧订阅方；退订后不再收', () => {
    const channel = createControlChannel()
    const first: Command[] = []
    const second: Command[] = []
    const offFirst = channel.onCommand((command) => first.push(command))
    channel.onCommand((command) => second.push(command))

    channel.send({ type: 'turn.interrupt' })
    offFirst()
    channel.send({ type: 'input.submit', text: '继续' })

    expect(first).toEqual([{ type: 'turn.interrupt' }])
    expect(second).toEqual([{ type: 'turn.interrupt' }, { type: 'input.submit', text: '继续' }])
  })

  test('无订阅方＝丢弃不抛（Emitter 语义 · 不排队）', () => {
    const channel = createControlChannel()

    expect(() => channel.send({ type: 'turn.interrupt' })).not.toThrow()
    expect(() => channel.publish(envelope(1, 'agent.end', {}))).not.toThrow()

    // 不滞留——后来者收不到先前那条（命令空转＝输入丢失，靠装配先接订阅方兜）
    const late: KernelEvent[] = []
    channel.subscribe((event) => late.push(event))
    expect(late).toEqual([])
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

  test('通道投递前拦截——违规消息不达订阅方；好消息照常通行', () => {
    const channel = createControlChannel()
    let commands = 0
    let events = 0
    channel.onCommand(() => {
      commands += 1
    })
    channel.subscribe(() => {
      events += 1
    })

    const badCommand = { type: 'input.submit', text: () => 'x' } as unknown as Command
    const badEvent = {
      ...envelope(1, 'tool.call', { name: 'exec', args: {} }),
      data: { name: 'exec', args: { env: new Map() } },
    } as unknown as KernelEvent

    expect(() => channel.send(badCommand)).toThrow(/命令不可序列化.*text/)
    expect(() => channel.publish(badEvent)).toThrow(/事件不可序列化.*data\.args\.env/)
    expect(commands).toBe(0) // 拦在投递前——订阅方没被惊动
    expect(events).toBe(0)

    channel.send({ type: 'turn.interrupt' })
    channel.publish(envelope(2, 'agent.end', {}))
    expect(commands).toBe(1) // 拦的是非纯数据，不是「一律拒」
    expect(events).toBe(1)
  })
})
