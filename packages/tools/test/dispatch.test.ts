/**
 * U06 · 分发回环 —— 机制的第二件（分发：请求 → 闸门 → 执行 → 回填）。
 *
 * 判据（任务书 · 退出条件）——
 * ① **分发回环**：请求 → 闸门 → 执行 → 结果走通一遍，四件事各留其痕；
 * ② **闸门不可绕过**：`invoke` 内必经 `PermissionGate.decide`；拒绝则该调用以「拒绝」回填、
 *    **不执行**；
 * ③ **危险归类**：本域只声明 `by-call`，**不替权限域判**——故用例反钉「本域没往闸门塞结论」。
 *
 * 事件链口径（契约 · 三个 id 各有空间）——`tool.call` / `tool.output.delta` / `tool.result`
 * 三处的 `call` 同指**该次 `tool.call` 事件的 id**；`ToolCall.id`（供应商侧）只用于回填配对，
 * 与它**不是一串**。用例两处都钉。
 */

import { describe, expect, test } from 'bun:test'
import type { ToolResult, ToolRuntime as ToolRuntimePort } from '@magic/contracts'
import { TRANSIENT_EVENT_KINDS } from '@magic/contracts'
import { FIXED_AT } from '@magic/faux'
import { execCall, makeToolDeps, ROOT, SESSION } from './helpers.ts'

describe('U06 · 分发回环：请求 → 闸门 → 执行 → 结果', () => {
  test('批准 → 执行 → 回填：三件事各留其痕，返回值照终值', async () => {
    const deps = makeToolDeps({ exec: { 'ls -a': { ok: true, exit: 0, stdout: 'a\nb\n', stderr: '' } } })

    const outcome = await deps.runtime.invoke(execCall('ls -a'), {})

    // ① 真的执行了——命令原样交沙箱
    expect(deps.sandbox.execs.map((e) => e.cmd)).toEqual(['ls -a'])

    // ② 回填给调用方（循环据以喂模型）
    expect(outcome.ok).toBe(true)
    expect(outcome.output).toBe('a\nb\n')

    // ③ 事件链——请求 → 结果，同一条链
    expect(deps.sink.events.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    const call = deps.sink.byKind('tool.call')[0]
    const result = deps.sink.byKind('tool.result')[0]
    if (call === undefined || result === undefined) throw new Error('请求 / 结果两个事件没发全')

    expect(call.data).toEqual({ name: 'exec', args: { cmd: 'ls -a' } })
    expect(result.data.call).toBe(call.id)
    expect(result.data.ok).toBe(true)
    expect(result.data.output).toEqual({ text: 'a\nb\n' })

    // ④ 信封照铸造器——会话 / 轮 / 时间由铸造器盖，本域**不自取时钟**
    //    （对的是铸造器桩的固定时钟：若本域自己 `Date.now()`，这一条当场红）
    expect(call.session).toBe(SESSION)
    expect(call.at).toBe(FIXED_AT)
    expect(result.at).toBe(FIXED_AT)
  })

  test('链引用＝该次 tool.call 事件的 id——与供应商侧调用 id 不是一串', async () => {
    const deps = makeToolDeps()

    const outcome = await deps.runtime.invoke(execCall('ls', 'call_vendor_9'), {})

    const call = deps.sink.byKind('tool.call')[0]
    if (call === undefined) throw new Error('请求事件没发')

    expect(outcome.callRef).toBe(call.id)
    expect(outcome.callRef).not.toBe('call_vendor_9')

    // 闸门拿到的是**链引用**（第四件必填——不设哨兵兜底）
    expect(deps.gate.requests[0]?.callRef).toBe(call.id)
  })

  test('闸门在路径内：问在前、执行在后；决策时执行体一次都没碰', async () => {
    const order: string[] = []
    const deps = makeToolDeps({
      decider: () => {
        order.push('decide')
        return 'approve'
      },
      exec: () => {
        order.push('exec')
        return { ok: true, exit: 0, stdout: '', stderr: '' }
      },
    })

    await deps.runtime.invoke(execCall('ls'), {})

    expect(order).toEqual(['decide', 'exec'])
  })

  test('闸门拿到的根视图＝工作区给的纯数据（端口不进端口）', async () => {
    const deps = makeToolDeps()

    await deps.runtime.invoke(execCall('ls'), {})

    expect(deps.gate.requests[0]?.ctx).toEqual({ roots: [ROOT], defaultRoot: ROOT })
    // 纯数据——不许夹带端口（工作区 / 沙箱的成员一个都不能有）
    expect(Object.keys(deps.gate.requests[0]?.ctx ?? {})).toEqual(['roots', 'defaultRoot'])
  })

  test('本域不替权限域判：危险结论不进闸门调用', async () => {
    const deps = makeToolDeps()

    // 一条命令、一份参数——闸门收到的只有调用本身与上下文，没有“轻重”之类的判定
    await deps.runtime.invoke(execCall('rm -rf build'), {})

    expect(Object.keys(deps.gate.requests[0] ?? {}).sort()).toEqual(['call', 'callRef', 'ctx'])
  })

  test('拒绝 → 以「拒绝」回填、不执行；链照样收尾（请求 → 结果）', async () => {
    const deps = makeToolDeps({ decider: 'reject' })

    const outcome = await deps.runtime.invoke(execCall('rm -rf build'), {})

    expect(deps.gate.requests).toHaveLength(1) // 问了
    expect(deps.sandbox.execs).toHaveLength(0) // 但没执行
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toBe('已拒绝——未执行')

    expect(deps.sink.events.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
    const result = deps.sink.byKind('tool.result')[0]
    expect(result?.data.ok).toBe(false)
    expect(result?.data.output).toEqual({ text: '已拒绝——未执行' })
    expect(result?.data.call).toBe(deps.sink.byKind('tool.call')[0]?.id)
  })

  test('未注册的工具 → 照样过闸门（不留暗路），批准后以失败回填、不抛', async () => {
    const deps = makeToolDeps()

    const outcome = await deps.runtime.invoke({ id: 'c1', name: 'nope', args: {} }, {})

    expect(deps.gate.requests).toHaveLength(1)
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('未注册')
    expect(deps.sink.byKind('tool.result')[0]?.data.call).toBe(outcome.callRef)
  })

  test('参数解析不出（call.invalid）→ 照样过闸门，批准后以失败回填', async () => {
    const deps = makeToolDeps()

    const outcome = await deps.runtime.invoke(
      { id: 'c1', name: 'exec', args: {}, invalid: true },
      {},
    )

    expect(deps.gate.requests).toHaveLength(1)
    expect(deps.sandbox.execs).toHaveLength(0) // 解析不出的调用不执行
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('参数解析不出')
  })

  test('「每个调用都问」是硬规矩——四个分支逐个过闸门各一次', async () => {
    const cases = [
      { id: 'c1', name: 'exec', args: { cmd: 'ls' } },
      { id: 'c2', name: 'nope', args: {} },
      { id: 'c3', name: 'exec', args: { cmd: 42 } },
      { id: 'c4', name: 'exec', args: {}, invalid: true },
    ]

    for (const call of cases) {
      const deps = makeToolDeps()
      await deps.runtime.invoke(call, {})
      expect(deps.gate.requests).toHaveLength(1)
    }
  })

  test('工具自己抛错 → 以失败回填（炸掉循环不是工具域该干的事）', async () => {
    const deps = makeToolDeps({
      tools: [
        {
          spec: { name: 'boom', summary: '炸', parameters: {}, danger: { level: 'light' } },
          run: () => {
            throw new Error('执行体炸了')
          },
        },
      ],
    })

    const outcome = await deps.runtime.invoke({ id: 'c1', name: 'boom', args: {} }, {})

    expect(outcome.ok).toBe(false)
    expect(outcome.output).toContain('执行体炸了')
    expect(deps.sink.byKind('tool.result')[0]?.data.ok).toBe(false)
  })

  test('端口面：返回的就是契约 ToolResult——三件齐备，且不自造补充', async () => {
    const deps = makeToolDeps()

    // 编译期探针——工具域的实现**即**契约端口（U11 装配按端口注入各域）。
    // 第 1 轮的「结构超集」已随契约补锚撤掉：本域不再有第二套形态。
    const port: ToolRuntimePort = deps.runtime
    const result: ToolResult = await port.invoke(execCall('ls'), {})

    expect(result.ok).toBe(true)
    expect(result.output).toBe('')

    // 键集钉死：契约三件之外**不许再多**（谁再塞回一个自造补充字段，这一条当场红）
    expect(Object.keys(result).sort()).toEqual(['callRef', 'content', 'ok', 'output'])

    // 定义面照端口出（默认集＝工具集 v1 七件——U13 到站后；阶段 1 的「仅 exec」作废）
    expect(port.definitions().map((d) => d.name)).toEqual([
      'exec',
      'read',
      'write',
      'edit',
      'grep',
      'glob',
      'ls',
    ])
  })

  test('两处 callRef 是同一次调用的同一个 id；content 与事件同物（第 2 轮契约补锚核对）', async () => {
    const deps = makeToolDeps()

    const outcome = await deps.runtime.invoke(execCall('ls'), {})

    const call = deps.sink.byKind('tool.call')[0]
    const result = deps.sink.byKind('tool.result')[0]
    const request = deps.gate.requests[0]
    if (call === undefined || result === undefined || request === undefined) {
      throw new Error('请求 / 询问 / 结果三者没发全')
    }

    // ① 条目侧的来处（`ToolResult.callRef`）＝ 询问侧的来处（`decide` 第三参）＝ `tool.call` 的 id
    //    ——**同一次调用、同一个 id**，四事件才串得成一条链
    expect(outcome.callRef).toBe(request.callRef)
    expect(outcome.callRef).toBe(call.id)

    // ② `content` 与 `tool.result` 事件的 `output` **同物**（不是「值相等」，是同一个）
    //    ——各造一份就会在重放时分叉
    expect(result.data.output).toBe(outcome.content)
  })

  test('瞬时增量不进持久面——扇出照契约的不落库清单判别', async () => {
    const deps = makeToolDeps({
      exec: (_cmd, opts) => {
        opts.onOutput?.({ channel: 'stdout', text: '走' })
        return { ok: true, exit: 0, stdout: '走', stderr: '' }
      },
    })

    await deps.runtime.invoke(execCall('x'), {})

    // 扮装配的扇出：持久类落库，瞬时类只推送（契约 · 规则 ①）
    expect(TRANSIENT_EVENT_KINDS).toContain('tool.output.delta')
    for (const event of deps.sink.events) {
      if (!TRANSIENT_EVENT_KINDS.includes(event.kind)) deps.records.appendEvent(event)
    }

    expect(deps.records.events.map((e) => e.kind)).toEqual(['tool.call', 'tool.result'])
  })
})
