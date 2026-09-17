/**
 * Faux Provider —— `ModelGateway` 的假实现（判据 ①·②）。
 *
 * 要钉住的：
 * ① **回放**——注入固定序列（正文 / 思考 / 工具调用 / 错误分档）→ 经端口可消费；
 * 产物是合法的 `ModelStream`（`events` 可迭代 ＋ `result` 聚合）；
 * ② **落位**——只是 `ModelGateway` 的一个实现（无网络、无 key）；
 * ③ **不变式照真实现**（技术方案 · 模型策略 · 接缝自留——`normalize.ts` 文件头注解）：
 *    首条恒 `model.call.start`；出错以 `model.error` **终结**（无 `model.call.end`）；
 *    中断**静默结束**（无 error、无 call.end）；提前 `break` 落定于未完成态。
 *
 * 事件序列的读法：`kind` 太粗（`model.delta` 一屏都是），故用 `shape()` 把
 * kind ＋ 通道 ＋ 文本（＋工具名）压成一行——**照真端点观察到的序列比**。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, ModelGateway, ModelRequest } from '@magic/contracts'
import {
  createFauxGateway,
  drainStream,
  FauxScriptExhaustedError,
  makeTestStamper,
} from '../src/index.ts'
import type { FauxTurn } from '../src/index.ts'

/** 请求——Faux 不看内容（脚本说了算），给一个最小合法形态即可。 */
const REQUEST: ModelRequest = {
  model: 'faux-1',
  messages: [{ role: 'user', content: '你好' }],
}

/** 事件序列的紧凑读法——`model.delta` 展开为 `delta:<通道>:<文本>[|<工具名>]`。 */
function shape(events: readonly KernelEvent[]): string[] {
  return events.map((e) => {
    if (e.kind !== 'model.delta') return e.kind
    const { channel, text, name } = e.data
    return `delta:${channel}:${text}${name === undefined ? '' : `|${name}`}`
  })
}

/** 造一个 Faux ＋ 铸造器——多数用例只要这一句。 */
function fauxOf(turns: readonly FauxTurn[]) {
  const stamper = makeTestStamper()
  const gateway = createFauxGateway({ stamper, turns })
  return { stamper, gateway }
}

// ═══════════════════════════════════════════════════════════════════════
// 一 · 回放：注入固定序列 → 事件流
// ═══════════════════════════════════════════════════════════════════════

describe('回放 · 正文', () => {
  test('正文一段 → call.start → delta(text) → call.end', async () => {
    const { gateway } = fauxOf([{ text: '你好' }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual([
      'model.call.start',
      'delta:text:你好',
      'model.call.end',
    ])
    expect(result.finishReason).toBe('stop')
    expect(result.complete).toBe(true)
  })

  test('正文多段 → 逐条增量（流式渲染要能看见「一段段来」）', async () => {
    const { gateway } = fauxOf([{ text: ['你', '好', '呀'] }])

    const { events } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual([
      'model.call.start',
      'delta:text:你',
      'delta:text:好',
      'delta:text:呀',
      'model.call.end',
    ])
  })

  test('思考与正文分列——各走各的通道', async () => {
    const { gateway } = fauxOf([{ thinking: '想一下', text: '答案是 42' }])

    const { events } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual([
      'model.call.start',
      'delta:thinking:想一下',
      'delta:text:答案是 42',
      'model.call.end',
    ])
  })

  test('用量随事件流入——缺省不发（未上报就不发，与真实现同）', async () => {
    const withUsage = fauxOf([{ text: 'x', usage: { inputTokens: 12, outputTokens: 3 } }])
    const without = fauxOf([{ text: 'x' }])

    const a = await drainStream(withUsage.gateway.stream(REQUEST))
    const b = await drainStream(without.gateway.stream(REQUEST))

    expect(shape(a.events)).toEqual([
      'model.call.start',
      'delta:text:x',
      'model.usage',
      'model.call.end',
    ])
    expect(a.result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(shape(b.events)).not.toContain('model.usage')
    expect(b.result.usage).toBeUndefined()
  })
})

describe('回放 · 工具调用', () => {
  test('工具调用 → 先出名字（空文本）再出参数 JSON——同 id', async () => {
    const { gateway } = fauxOf([{ toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }] }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    // 名字先于参数出现（真端点观察②的形状）；空参数工具也见得着名字
    expect(shape(events).slice(0, 3)).toEqual([
      'model.call.start',
      'delta:toolcall:|exec',
      'delta:toolcall:{"cmd":"ls"}|exec',
    ])
    expect(result.finishReason).toBe('tool-calls')
  })

  test('聚合结果载工具调用——循环据以回填（不解析事件流拼装）', async () => {
    const { gateway } = fauxOf([
      { toolCalls: [{ name: 'exec', args: { cmd: 'ls' }, id: 'call_a' }] },
    ])

    const { result } = await drainStream(gateway.stream(REQUEST))

    expect(result.toolCalls).toEqual([
      { id: 'call_a', name: 'exec', args: { cmd: 'ls' } },
    ])
  })

  test('缺省调用 id 可预测（`call_1` 起 · 轮内递增）——断言不必靠猜', async () => {
    const { gateway } = fauxOf([
      {
        toolCalls: [
          { name: 'read', args: { path: 'a' } },
          { name: 'ls', args: {} },
        ],
      },
    ])

    const { result } = await drainStream(gateway.stream(REQUEST))

    expect(result.toolCalls?.map((c) => c.id)).toEqual(['call_1', 'call_2'])
    expect(result.toolCalls?.map((c) => c.name)).toEqual(['read', 'ls'])
  })

  test('工具调用的两条增量带同一个供应商侧 id——渲染侧据以分组', async () => {
    const { gateway } = fauxOf([{ toolCalls: [{ name: 'exec', args: { cmd: 'pwd' } }] }])

    const { events } = await drainStream(gateway.stream(REQUEST))
    const toolDeltas = events.flatMap((e) =>
      e.kind === 'model.delta' && e.data.channel === 'toolcall' ? [e.data] : [],
    )

    expect(toolDeltas.map((d) => d.id)).toEqual(['call_1', 'call_1'])
  })
})

describe('回放 · 错误分档', () => {
  test('瞬时——call.start → model.error(transient) 终结（其后无 call.end）', async () => {
    const { gateway } = fauxOf([{ error: { tier: 'transient', message: '限流' } }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual(['model.call.start', 'model.error'])
    expect(result.error).toEqual({ tier: 'transient', message: '限流' })
    expect(result.complete).toBe(true)
  })

  test('上下文超限——同形，档位不同', async () => {
    const { gateway } = fauxOf([{ error: { tier: 'context-limit', message: '超窗' } }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual(['model.call.start', 'model.error'])
    expect(result.error?.tier).toBe('context-limit')
  })

  test('终态——同形，档位不同', async () => {
    const { gateway } = fauxOf([{ error: { tier: 'terminal', message: '内容策略' } }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    expect(shape(events)).toEqual(['model.call.start', 'model.error'])
    expect(result.error?.tier).toBe('terminal')
  })

  test('错误事件的载荷与聚合结果同一份结论', async () => {
    const { gateway } = fauxOf([{ error: { tier: 'terminal', message: '内容策略' } }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))
    const errorEvent = events.find((e) => e.kind === 'model.error')

    if (errorEvent?.kind !== 'model.error') throw new Error('序列里没有 model.error 事件')
    const error = result.error
    if (error === undefined) throw new Error('聚合结果里没有 error')

    expect(error).toEqual({ tier: 'terminal', message: '内容策略' })
    expect(errorEvent.data).toEqual(error) // 同一份结论——不是两处各归一一次
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二 · 多轮与用尽：脚本一段一轮
// ═══════════════════════════════════════════════════════════════════════

describe('脚本 · 一段一轮', () => {
  test('两次 stream 取两段——调用 → 工具 → 回填 → 收束 的往复可写', async () => {
    const { gateway, stamper } = fauxOf([
      { toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }] },
      { text: '跑完了' },
    ])

    const first = await drainStream(gateway.stream(REQUEST))
    const second = await drainStream(gateway.stream(REQUEST))

    expect(first.result.finishReason).toBe('tool-calls')
    expect(second.result.finishReason).toBe('stop')

    // 同一铸造器**接续**铸：第一轮占 id 1–4（start · 两条 toolcall 增量 · end），
    // 第二轮从 5 起——不是每轮各自从 1 重来（那样跨轮的 id 就撞了）
    const startIds = stamper.stamped
      .filter((e) => e.kind === 'model.call.start')
      .map((e) => e.id)
    expect(startIds).toEqual([1, 5])
  })

  test('脚本用尽即报错——多调一轮是 bug，不该静默重复上一段', async () => {
    const { gateway } = fauxOf([{ text: '只有一轮' }])

    await drainStream(gateway.stream(REQUEST))

    expect(() => gateway.stream(REQUEST)).toThrow(FauxScriptExhaustedError)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 二·五 · 请求留痕（回填链路的断言面）
// ═══════════════════════════════════════════════════════════════════════

describe('请求留痕', () => {
  test('每次 stream 的请求都留痕——「回填送达模型」可断言', async () => {
    const { gateway } = fauxOf([{ toolCalls: [{ name: 'exec', args: {} }] }, { text: '好了' }])

    await drainStream(gateway.stream(REQUEST))
    await drainStream(
      gateway.stream({
        model: 'faux-1',
        messages: [
          ...REQUEST.messages,
          { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'exec', args: {} }] },
          { role: 'tool', callId: 'call_1', name: 'exec', ok: true, output: 'a.txt' },
        ],
      }),
    )

    expect(gateway.requests).toHaveLength(2)
    expect(gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      callId: 'call_1',
      ok: true,
    })
  })

  test('留痕不参与回放——Faux 不看请求（脚本说了算），请求只作观察面', async () => {
    const { gateway } = fauxOf([{ text: '固定产出' }, { text: '固定产出' }])

    const a = await drainStream(gateway.stream(REQUEST))
    const b = await drainStream(
      gateway.stream({ model: '完全不同的模型名', messages: [{ role: 'user', content: '别的' }] }),
    )

    expect(shape(a.events)).toEqual(shape(b.events))
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 三 · 流的收场：中断 · 提前 break · 未消费
// ═══════════════════════════════════════════════════════════════════════

describe('收场 · 中断', () => {
  test('signal 中止 → 静默结束——无 model.error、无 call.end', async () => {
    const { gateway } = fauxOf([{ text: ['一', '二', '三'] }])
    const controller = new AbortController()

    const stream = gateway.stream(REQUEST, { signal: controller.signal })
    const seen: KernelEvent[] = []
    for await (const event of stream.events) {
      seen.push(event)
      if (event.kind === 'model.delta' && event.data.text === '一') controller.abort()
    }

    expect(shape(seen)).toEqual(['model.call.start', 'delta:text:一'])
    const result = await stream.result
    expect(result.aborted).toBe(true) // 中断不是模型错误
    expect(result.error).toBeUndefined()
    expect(result.complete).toBe(true)
  })

  test('调起时已中止 → 仍发 call.start，随即静默结束（「调用已发起」是事实）', async () => {
    const { gateway } = fauxOf([{ text: '不该出现' }])
    const controller = new AbortController()
    controller.abort()

    const stream = gateway.stream(REQUEST, { signal: controller.signal })
    const { events, result } = await drainStream(stream)

    expect(shape(events)).toEqual(['model.call.start'])
    expect(result.aborted).toBe(true)
  })
})

describe('收场 · 消费方提前收手', () => {
  test('提前 break → 以未完成态落定（complete: false）', async () => {
    const { gateway } = fauxOf([{ text: ['一', '二', '三'] }])

    const stream = gateway.stream(REQUEST)
    for await (const event of stream.events) {
      if (event.kind === 'model.delta') break // 只看第一条增量就走
    }

    const result = await stream.result
    expect(result.complete).toBe(false)
    expect(result.aborted).toBe(false)
  })

  test('events 从未被迭代 → result 不落定（接缝不替消费方缓冲整条流）', async () => {
    const { gateway } = fauxOf([{ text: 'x' }])

    const stream = gateway.stream(REQUEST)
    const raced = await Promise.race([
      stream.result.then(() => 'settled'),
      Promise.resolve('pending'),
    ])

    expect(raced).toBe('pending')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 四 · 落位：它只是端口的一个实现
// ═══════════════════════════════════════════════════════════════════════

describe('落位', () => {
  test('满足 `ModelGateway` 端口签名——可按端口取用（换插不动消费者）', () => {
    const gateway: ModelGateway = createFauxGateway({
      stamper: makeTestStamper(),
      turns: [{ text: 'x' }],
    })

    expect(typeof gateway.stream).toBe('function')
  })

  test('不依赖网络——把全局 fetch 换成炸弹，照样跑通', async () => {
    const original = globalThis.fetch
    globalThis.fetch = ((): never => {
      throw new Error('Faux 不该碰网络')
    }) as unknown as typeof globalThis.fetch

    try {
      const { gateway } = fauxOf([{ text: 'x' }])
      const { result } = await drainStream(gateway.stream(REQUEST))

      expect(result.complete).toBe(true)
    } finally {
      globalThis.fetch = original
    }
  })

  test('不依赖 key——构造面只有脚本与铸造器', () => {
    // 选项类型即证据：端点 / apiKey / env / fetch 一概没有位（对比模型域 `ModelGatewayOptions`）
    const options: Parameters<typeof createFauxGateway>[0] = {
      stamper: makeTestStamper(),
      turns: [{ text: 'x' }],
    }

    expect(Object.keys(options).sort()).toEqual(['stamper', 'turns'])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 五 · 消费助手
// ═══════════════════════════════════════════════════════════════════════

describe('drainStream', () => {
  test('消费完事件流并取聚合结果——两出口一次到手', async () => {
    const { gateway } = fauxOf([{ text: '好', usage: { inputTokens: 1, outputTokens: 1 } }])

    const { events, result } = await drainStream(gateway.stream(REQUEST))

    expect(events.length).toBeGreaterThan(0)
    expect(result.complete).toBe(true)
  })
})
