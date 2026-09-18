/**
 * 视图归约（U09）——事件 → 一屏视图模型。
 *
 * 归约是**纯函数**：外壳的显示逻辑全在这里，Ink 只负责把模型画出来。
 * 逐 kind 覆盖（`model.delta` 三通道 · `tool.output.delta` · `tool.decision.*` ·
 * `turn.*` · `agent.*`），断言到「条目形状」一级——U20 换皮不动此层。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent } from '@magic/contracts'
import { appendEcho, createView, reduce } from '../src/view.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'

/** 依次投喂事件（归约是纯函数——每步都返回新视图）。 */
function feed(events: readonly KernelEvent[], from: ShellView = createView()): ShellView {
  return events.reduce(reduce, from)
}

/** 断言用取条目——越界即抛（免得 `[i]!` 满屏）。 */
function itemAt(view: ShellView, index: number): ShellView['items'][number] {
  const item = view.items[index]
  if (item === undefined) throw new Error(`没有第 ${index} 条条目（共 ${view.items.length} 条）`)
  return item
}

describe('对话流 · 模型增量（流式）', () => {
  test('正文增量累积成一条助手条目', () => {
    const view = feed([
      event('model.delta', { channel: 'text', text: '你' }),
      event('model.delta', { channel: 'text', text: '好' }),
    ])

    expect(view.items).toHaveLength(1)
    expect(itemAt(view, 0)).toMatchObject({ kind: 'assistant', text: '你好' })
  })

  test('思考与正文各自成块——交替出现也保序', () => {
    const view = feed([
      event('model.delta', { channel: 'thinking', text: '先想' }),
      event('model.delta', { channel: 'thinking', text: '一下' }),
      event('model.delta', { channel: 'text', text: '答案是' }),
      event('model.delta', { channel: 'thinking', text: '再想' }),
      event('model.delta', { channel: 'text', text: '42' }),
    ])

    expect(view.items.map((item) => [item.kind, 'text' in item ? item.text : ''])).toEqual([
      ['thinking', '先想一下'],
      ['assistant', '答案是'],
      ['thinking', '再想'],
      ['assistant', '42'],
    ])
  })

  test('工具调用增量按供应商侧调用 id 分组（同轮可多次调用）', () => {
    const view = feed([
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'call_a', text: '{"cmd":' }),
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'call_a', text: '"ls"}' }),
      event('model.delta', { channel: 'toolcall', name: 'read', id: 'call_b', text: '{"path":' }),
    ])

    expect(view.items).toHaveLength(2)
    expect(itemAt(view, 0)).toMatchObject({ kind: 'tool', name: 'exec', argsText: '{"cmd":"ls"}' })
    expect(itemAt(view, 1)).toMatchObject({ kind: 'tool', name: 'read', argsText: '{"path":' })
  })
})

describe('对话流 · 工具调用链', () => {
  test('`tool.call` 接管先到的流式片段——按序配成同一条目', () => {
    const view = feed([
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'call_a', text: '{"cmd":' }),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 77 }),
    ])

    expect(view.items).toHaveLength(1)
    expect(itemAt(view, 0)).toMatchObject({ kind: 'tool', name: 'exec', call: 77 })
    expect(itemAt(view, 0)).toHaveProperty('argsText', '{"cmd":"ls"}')
  })

  test('`tool.call` 无流式前情时自建条目', () => {
    const view = feed([event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 77 })])

    expect(itemAt(view, 0)).toMatchObject({ kind: 'tool', name: 'exec', call: 77 })
  })

  test('同轮两次调用——各归各的条目', () => {
    const view = feed([
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'call_a', text: '{"cmd":"ls"}' }),
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'call_b', text: '{"cmd":"pwd"}' }),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.call', { name: 'exec', args: { cmd: 'pwd' } }, { id: 72 }),
    ])

    expect(view.items).toHaveLength(2)
    expect(itemAt(view, 0)).toMatchObject({ call: 71, argsText: '{"cmd":"ls"}' })
    expect(itemAt(view, 1)).toMatchObject({ call: 72, argsText: '{"cmd":"pwd"}' })
  })

  test('输出增量按 `call` 归位，两通道各自累积', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'a.txt\n' }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'b.txt\n' }),
      event('tool.output.delta', { call: 71, channel: 'stderr', text: '警告\n' }),
    ])

    expect(itemAt(view, 0)).toMatchObject({
      output: [
        { channel: 'stdout', text: 'a.txt\nb.txt\n' },
        { channel: 'stderr', text: '警告\n' },
      ],
    })
  })

  test('同轮两次调用的输出各归各的条目（不许一律并到同一条上）', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.call', { name: 'exec', args: { cmd: 'pwd' } }, { id: 72 }),
      event('tool.output.delta', { call: 72, channel: 'stdout', text: 'b\n' }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'a\n' }),
    ])

    expect(itemAt(view, 0)).toMatchObject({ call: 71, output: [{ channel: 'stdout', text: 'a\n' }] })
    expect(itemAt(view, 1)).toMatchObject({ call: 72, output: [{ channel: 'stdout', text: 'b\n' }] })
  })

  test('`tool.result` 落到对应条目——ok 与输出文本', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { text: 'a.txt\n' } }),
    ])

    expect(itemAt(view, 0)).toMatchObject({ result: { ok: true, output: 'a.txt\n' } })
  })

  test('`tool.result` 的 blob 引用不解析——只留引用（大负载归记录域）', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { blob: 'blob_1' } }),
    ])

    expect(itemAt(view, 0)).toMatchObject({ result: { ok: true, output: 'blob_1' } })
  })
})

describe('审批（裁决配对）', () => {
  test('`tool.decision.request` 呈材料与轻重——配对键＝请求事件 id', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'rm -rf x' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: 'rm -rf x', weight: 'heavy' },
        { id: 88 },
      ),
    ])

    expect(view.pending).toMatchObject({
      id: 88,
      call: 71,
      name: 'exec',
      material: 'rm -rf x',
      weight: 'heavy',
    })
  })

  test('轮收束即撤下悬着的询问——轮都结束了，那条询问已作废', () => {
    const asked = feed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: 'ls', weight: 'light' },
        { id: 88 },
      ),
    ])
    expect(asked.pending).toMatchObject({ id: 88 })

    const aborted = reduce(asked, event('turn.end', { reason: 'aborted' }))
    expect(aborted.pending).toBeNull()
  })

  test('`tool.decision` 收束提示，并把裁决记在该条目上', () => {
    const view = feed([
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: 'ls', weight: 'light' },
        { id: 88 },
      ),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 1200 }),
    ])

    expect(view.pending).toBeNull()
    expect(itemAt(view, 0)).toMatchObject({
      // 条目上的留痕叫 `verdict`（裁决全量：判定 ＋ 裁者 ＋ 耗时）——`decision` 一词留给判定值本身
      verdict: { decision: 'approve', decider: 'user', elapsedMs: 1200 },
    })
  })
})

describe('状态行', () => {
  test('轮起止驱动忙碌位——结束方式随 `turn.end` 记下', () => {
    const busy = feed([event('turn.start', {})])
    expect(busy.status).toMatchObject({ phase: 'busy', turnEnd: null })

    const settled = reduce(busy, event('turn.end', { reason: 'settled' }))
    expect(settled.status).toMatchObject({ phase: 'idle', turnEnd: 'settled' })

    const aborted = reduce(busy, event('turn.end', { reason: 'aborted' }))
    expect(aborted.status).toMatchObject({ phase: 'idle', turnEnd: 'aborted' })
  })

  test('agent 状态与模型名、用量进状态行', () => {
    const view = feed([
      event('agent.start', {}, { turn: null }),
      event('agent.state', { state: 'waiting' }, { turn: null }),
      event('model.call.start', { model: 'MiniMax-M3' }),
      event('model.usage', { inputTokens: 120, outputTokens: 34 }),
    ])

    expect(view.status).toMatchObject({
      agent: 'waiting',
      model: 'MiniMax-M3',
      usage: { inputTokens: 120, outputTokens: 34 },
    })
  })

  test('模型错误与内核异常都落成错误行（分档只作呈现）', () => {
    const view = feed([
      event('model.error', { tier: 'transient', message: '断了一下' }),
      event('error', { message: '内核自身异常' }, { turn: null }),
    ])

    expect(view.items.map((item) => [item.kind, 'tone' in item ? item.tone : ''])).toEqual([
      ['notice', 'error'],
      ['notice', 'error'],
    ])
  })
})

describe('用户输入的回显', () => {
  test('本地回显与 `message.user` 配平——不重复显示', () => {
    const echoed = appendEcho(createView(), '跑一下 ls')
    const confirmed = feed([event('message.user', { entry: 12 })], echoed)

    expect(confirmed.items.map((item) => item.kind)).toEqual(['user'])
    expect(confirmed.items).toHaveLength(1)
    expect(itemAt(confirmed, 0)).toMatchObject({ kind: 'user', text: '跑一下 ls' })
  })

  test('无本地回显的 `message.user`（恢复场景）留痕——正文不在事件内', () => {
    const view = feed([event('message.user', { entry: 12 })])

    expect(itemAt(view, 0)).toMatchObject({ kind: 'user', text: '（用户条目 12）' })
  })
})

describe('归约是纯函数', () => {
  test('不改动入参视图', () => {
    const before = appendEcho(createView(), '你好')
    const snapshot = structuredClone(before)

    reduce(before, event('model.delta', { channel: 'text', text: '嗨' }))

    expect(before).toEqual(snapshot)
  })
})

// —— 第 17 轮补锚（阶段 2 波次 2）：供应商 / 重试位 ——

describe('第 17 轮 · 供应商与重试位', () => {
  test('`model.call.start` 带条目名——状态行据以显示当前供应商', () => {
    const view = reduce(
      createView(),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
    )

    expect(view.status.provider).toBe('minimax')
    expect(view.status.model).toBe('MiniMax-M3')
  })

  test('条目名缺席＝不知道（不拿旧值充数——那是另一个条目的事）', () => {
    const withProvider = reduce(
      createView(),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
    )
    const withoutProvider = reduce(withProvider, event('model.call.start', { model: 'X' }))

    expect(withoutProvider.status.provider).toBeNull()
  })

  test('`model.retry` 亮起重试位——屏上不再是「一动不动」', () => {
    const view = reduce(createView(), event('model.retry', { attempt: 2, delayMs: 1500, tier: 'transient' }))

    expect(view.status.retry).toEqual({ attempt: 2, delayMs: 1500 })
  })

  test('重试位只在等待期间亮着——调用再动起来即撤下', () => {
    const retrying = reduce(createView(), event('model.retry', { attempt: 2, delayMs: 800, tier: 'transient' }))
    expect(retrying.status.retry).not.toBeNull()

    // 三件都说明「这次调用又在动了」：首块内容到位 / 调用收束 / 出错终局
    expect(reduce(retrying, event('model.delta', { channel: 'text', text: '来了' })).status.retry).toBeNull()
    expect(reduce(retrying, event('model.call.start', { model: 'M' })).status.retry).toBeNull()
    expect(reduce(retrying, event('model.error', { tier: 'terminal', message: '停' })).status.retry).toBeNull()
  })

  test('重试位不落进对话流——它是状态、不是历史（退避几次不该刷几行）', () => {
    const once = reduce(createView(), event('model.retry', { attempt: 2, delayMs: 500, tier: 'transient' }))
    const twice = reduce(once, event('model.retry', { attempt: 3, delayMs: 1000, tier: 'transient' }))

    expect(twice.items).toEqual([])
    expect(twice.status.retry).toEqual({ attempt: 3, delayMs: 1000 })
  })
})
