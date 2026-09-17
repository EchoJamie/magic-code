/**
 * 测试骨架 —— **U02 / U04 的底座**（就位 · 能用即可）。
 *
 * 这不是「某域的测试」，而是**怎么把替身接起来**的活文档：两节各演示一条接线，
 * 到站的单元照此扩写自己的用例。
 *
 * - **骨架 · 记录**（U02）——铸事件 → 发 → 记 → 回读 的回环；U02 到站后把
 *   `makeFauxRecords()` 换成真的记录域实现，断言照用。
 * - **骨架 · 循环**（U04）——模型（Faux）→ 闸门（桩）→ 工具（桩）→ 回填 → 收束。
 *   其中的 `toyLoop` 是**接线示例，不是循环的规格**——U04 到站后换成真 `agentLoop`，
 *   「端口之间的流转」那几条断言照用。
 *
 * ⚠️ 边界：本文件的用例只钉**替身自身**与**端口之间的流转**（谁调了谁、什么进了上下文）。
 * 循环该怎么收束、中断该怎么处置、记录该怎么分束——**那是 U02 / U04 的判据**，不在这里替它们定。
 */

import { describe, expect, test } from 'bun:test'
import type { KernelEvent, ModelMessage, ModelResult, ToolCall } from '@magic/contracts'
import {
  createFauxGateway,
  drainStream,
  makeFauxPermissionGate,
  makeFauxRecords,
  makeFauxSandbox,
  makeFauxSink,
  makeFauxToolRuntime,
  makeTestStamper,
} from '../src/index.ts'

/** 工作区根——权限与沙箱共用同一份（契约：越界判据两处同源）。 */
const ROOTS = { roots: ['/w'], defaultRoot: '/w' }

// ═══════════════════════════════════════════════════════════════════════
// 骨架 · 记录（U02 的底座）
// ═══════════════════════════════════════════════════════════════════════

describe('骨架 · 记录', () => {
  test('事件回环：铸 → 发 → 记 → 回读（U02 到站后换真实现，断言照用）', async () => {
    const records = makeFauxRecords()
    const sink = makeFauxSink()
    const stamper = makeTestStamper({ session: 's1' })

    // 域这一侧：铸一条、发一条（真装配里 `sink` 就是扇出点：落库 ＋ 推送）
    sink.emit(stamper.stamp('turn.start', {}))
    sink.emit(stamper.stamp('model.call.start', { model: 'faux-1' }))
    sink.emit(stamper.stamp('turn.end', { reason: 'settled' }))

    // 扇出点这一侧：持久类落库（瞬时类不落——契约 · 规则 ① 的清单）
    for (const event of sink.events) records.appendEvent(event)

    // 回读：恢复 / 审计的入口
    const reread: KernelEvent[] = []
    for await (const event of records.readEvents('s1')) reread.push(event)

    expect(reread.map((e) => e.kind)).toEqual([
      'turn.start',
      'model.call.start',
      'turn.end',
    ])
    expect(reread.map((e) => e.id)).toEqual([1, 2, 3]) // 铸造器铸的 id 原样落库
  })

  test('条目回环：appendEntry 取号 → readEntries 回读', async () => {
    const records = makeFauxRecords()
    const stamper = makeTestStamper()

    const id = records.appendEntry({
      kind: 'user',
      content: { text: '看下 playground' },
      at: stamper.stamp('turn.start', {}).at,
    })

    const read: number[] = []
    for await (const entry of records.readEntries('s1')) read.push(entry.id)

    expect(id).toBe(1)
    expect(read).toEqual([1])
  })
})

// ═══════════════════════════════════════════════════════════════════════
// 骨架 · 循环（U04 的底座）
// ═══════════════════════════════════════════════════════════════════════

/**
 * 接线示例的依赖束——真循环（U04）的构造入参大致就是这一束（名字另定）。
 */
type ToyDeps = {
  readonly stamper: ReturnType<typeof makeTestStamper>
  readonly gateway: ReturnType<typeof createFauxGateway>
  readonly sink: ReturnType<typeof makeFauxSink>
  readonly records: ReturnType<typeof makeFauxRecords>
  readonly tools: ReturnType<typeof makeFauxToolRuntime>
  readonly gate: ReturnType<typeof makeFauxPermissionGate>
}

/**
 * **接线示例**（不是循环的规格）——把「模型 → 闸门 → 工具 → 回填 → 再问模型」跑通，
 * 好让 U04 一开工就有能跑的东西。
 *
 * 刻意从简：不做上下文装配、不落条目、不处置中断——那些都是 U04 的活。
 */
async function toyLoop(deps: ToyDeps, input: string): Promise<void> {
  const messages: ModelMessage[] = [{ role: 'user', content: input }]

  for (;;) {
    const stream = deps.gateway.stream({ model: 'faux-1', messages, tools: deps.tools.definitions() })
    const { events, result } = await drainStream(stream)
    for (const event of events) deps.sink.emit(event)

    const text = events
      .flatMap((e) => (e.kind === 'model.delta' && e.data.channel === 'text' ? [e.data.text] : []))
      .join('')

    const toolCalls = result.toolCalls ?? []
    messages.push({ role: 'assistant', content: text, toolCalls })

    if (toolCalls.length === 0) return // 没有工具调用＝收束

    for (const call of toolCalls) {
      // 工具域发 `tool.call`——**链引用的来处**（真装配里归工具域；玩具循环就地铸一条充任）
      const callEvent = deps.stamper.stamp('tool.call', { name: call.name, args: call.args })
      deps.sink.emit(callEvent)

      // `callRef` 必填（契约：不设哨兵兜底——静默的 -1 比缺参更坏）
      const decision = await deps.gate.decide(call, ROOTS, callEvent.id)
      const output =
        decision === 'approve'
          ? await deps.tools.invoke(call, {})
          : { ok: false, output: '被拒绝' }

      messages.push({
        role: 'tool',
        callId: call.id,
        name: call.name,
        ok: output.ok,
        output: output.output,
      })
    }
  }
}

/**
 * 等一个条件成立——**让出几次**（不是「睡够时间」）：异步流水线（消费流 → 问闸门）
 * 要跑过几处 `await` 才轮到测试关心的那一步。
 *
 * 人工门的测试绕不开它——「扮外壳答复」得先等闸门真的问起来。
 */
async function waitFor<T>(probe: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const found = probe()
    if (found !== undefined) return found
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`等不到：${what}`)
}

/** 一束现成的替身——多数用例照这样拼。铸造器**一束一份**（信封四件同源）。 */
function makeToyDeps(options?: Parameters<typeof createFauxGateway>[0]['turns']): ToyDeps {
  const stamper = makeTestStamper()

  return {
    stamper,
    gateway: createFauxGateway({ stamper, turns: options ?? [] }),
    sink: makeFauxSink(),
    records: makeFauxRecords(),
    tools: makeFauxToolRuntime({
      definitions: [
        { name: 'exec', summary: '命令执行', parameters: {}, danger: { level: 'light' } },
      ],
      handlers: { exec: (call) => ({ ok: true, output: `跑了 ${String(call.args.cmd)}` }) },
    }),
    gate: makeFauxPermissionGate({ auto: 'approve' }),
  }
}

describe('骨架 · 循环', () => {
  test('模型 → 闸门 → 工具 → 回填 → 收束（接线示例）', async () => {
    const deps = makeToyDeps([
      { toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }] }, // 第一轮：模型要调工具
      { text: '跑完了' }, // 第二轮：收束
    ])

    await toyLoop(deps, '看下目录')

    // —— 端口之间的流转 ——
    expect(deps.gate.requests.map((r) => r.call.name)).toEqual(['exec']) // 问了闸门
    expect(deps.gate.requests[0]?.ctx).toEqual(ROOTS) // 上下文是纯数据、由调用方给
    expect(deps.tools.calls.map((c) => c.name)).toEqual(['exec']) // 调了工具

    // —— 链引用（补锚契约）：询问带的 `callRef` 指向那次 `tool.call` 事件 ——
    expect(deps.gate.requests[0]?.callRef).toBe(deps.sink.byKind('tool.call')[0]?.id)

    expect(deps.sink.byKind('model.call.start')).toHaveLength(2) // 两轮模型调用
    expect(deps.sink.byKind('model.call.end')).toHaveLength(2)

    // —— 回填**送达模型**（U04 最要紧的那一问）：第二轮的请求尾巴上挂着工具结果 ——
    expect(deps.gateway.requests).toHaveLength(2)
    expect(deps.gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      callId: 'call_1', // 配对用的是**供应商侧**调用 id
      name: 'exec',
      ok: true,
      output: '跑了 ls',
    })
    // 工具规格随每次调用送模型（`ToolRuntime.definitions()` 的去处）
    expect(deps.gateway.requests[0]?.tools?.map((t) => t.name)).toEqual(['exec'])
  })

  test('模型产出的正文可从事件流拼出（`result` 只载契约四项）', async () => {
    const deps = makeToyDeps([{ text: ['跑', '完', '了'] }])

    await toyLoop(deps, '随便')

    const text = deps.sink.events
      .flatMap((e) => (e.kind === 'model.delta' && e.data.channel === 'text' ? [e.data.text] : []))
      .join('')

    expect(text).toBe('跑完了')
  })

  test('拒绝的调用不执行——以「拒绝」回填（闸门回路的人工姿势）', async () => {
    // 人工门（不给 `auto`）——测试扮外壳，按请求 id 答复
    const deps = {
      ...makeToyDeps([{ toolCalls: [{ name: 'exec', args: { cmd: 'rm -rf /' } }] }, { text: '好吧' }]),
      gate: makeFauxPermissionGate(),
    }

    const running = toyLoop(deps, '删库')

    // 扮外壳：等闸门问起，再按请求 id 答复
    const requestId = await waitFor(() => deps.gate.pending[0], '闸门问起')
    deps.gate.resolve(requestId, 'reject')

    await running

    expect(deps.gate.answers).toEqual([{ id: requestId, decision: 'reject' }])
    expect(deps.tools.calls).toEqual([]) // 被拒＝不执行
  })

  test('中断路径：Faux 慢下来 → 消费方中止 → 静默收场（接线示例）', async () => {
    const stamper = makeTestStamper()
    const gateway = createFauxGateway({
      stamper,
      turns: [{ text: ['一', '二', '三'] }],
      stepDelayMs: 5, // 给消费方留出中止的窗口
    })
    const controller = new AbortController()

    const stream = gateway.stream(
      { model: 'faux-1', messages: [] },
      { signal: controller.signal },
    )
    const seen: KernelEvent[] = []
    for await (const event of stream.events) {
      seen.push(event)
      controller.abort() // 收到第一条就走
    }

    const result: ModelResult = await stream.result
    expect(seen.map((e) => e.kind)).toEqual(['model.call.start'])
    expect(result.complete).toBe(true)
  })

  test('沙箱桩与工具桩串起来——工具实现里的「调沙箱」这一段（U06 的底座）', async () => {
    const sandbox = makeFauxSandbox({
      exec: { 'ls': { ok: true, exit: 0, stdout: 'a.txt\n', stderr: '' } },
    })
    const tools = makeFauxToolRuntime({
      definitions: [
        { name: 'exec', summary: '命令执行', parameters: {}, danger: { level: 'light' } },
      ],
      handlers: {
        exec: async (call) => {
          const result = await sandbox.exec(String(call.args.cmd), {})
          return { ok: result.ok, output: result.ok ? result.stdout : result.message }
        },
      },
    })

    const call: ToolCall = { id: 'call_1', name: 'exec', args: { cmd: 'ls' } }
    const out = await tools.invoke(call, {})

    expect(out).toEqual({ ok: true, output: 'a.txt\n' })
    expect(sandbox.execs.map((e) => e.cmd)).toEqual(['ls'])
  })
})
