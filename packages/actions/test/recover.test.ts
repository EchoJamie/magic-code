/**
 * U25 · 应用层 —— **用例：恢复**（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」五条 ·
 * 领域划分 ·「域之上：应用层」：首站唯一用例）。
 *
 * ```
 *   ① 在途识别        —— 有 tool.call 无 tool.result（记录域的查询面：`scanInFlight`）
 *   ② 处置            —— ★ 首站**不自动重放**：一律交用户裁决（重跑 / 记失败）
 *   ③ 未完成流式消息  —— 丢弃（半截正文本就不落账）＋ 记中止（补 turn.end{aborted}）
 *   ④ 未答复裁决      —— 按「拒绝」落账（保守）
 *   ⑤ 上下文由条目重建 —— 递手给对话域的重建面（见文件末那一组：入口的接线）
 * ```
 *
 * **本文件在边界上测**：「在途长什么样」由记录域的查询面负责（那边的用例在
 * `packages/records/test/recovery.test.ts`），这里把扫描结果**当输入给定**（`scanOf`），
 * 只验**处置**。两侧合起来的那一次，在装配面（`packages/app/test/recovery.test.ts`）
 * 与**真跑**里验（杀进程 → 重起 → 续跑）。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, KernelEvent } from '@magic/contracts'
import { createActions } from '../src/index.ts'
import type { SessionPorts } from '../src/index.ts'
import { recoverSession } from '../src/recover.ts'
import { SESSION, T0, callOf, jsonOf, payloadTextOf, resultsOf, runtimeOf, scanOf } from './support/harness.ts'
import { makeStage } from './support/harness.ts'

describe('② 幂等的那笔——静默重放（首站不可达：没有声明位 ⇒ 装配不传判定）', () => {
  test('重放：工具域被调一次，结果条目与原调用条目成对', async () => {
    const stage = makeStage({
      handlers: { exec: () => ({ ok: true, output: 'a.txt\n' }) },
      scan: scanOf([callOf()]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })
    stage.records.appendEvent({
      id: 42,
      session: SESSION,
      turn: 1,
      at: T0,
      kind: 'tool.call',
      data: { name: 'exec', args: { cmd: 'ls' } },
    } as KernelEvent)

    const report = await recoverSession(runtimeOf(stage, () => true))

    // 工具真跑了一次（这就是「重放」）
    expect(stage.tools.calls.map((call) => call.name)).toEqual(['exec'])

    // 条目侧：原调用条目之后的 `tool-result`——上下文重新合法（⑤）
    expect(stage.records.entries.map((entry) => entry.kind)).toEqual(['tool-call', 'tool-result'])
    expect(payloadTextOf(stage.records.entries[1] as Entry)).toBe('a.txt\n')

    // 事件侧：**重放自己那一对在前**（工具域的产出），**原笔的补记在后**（恢复的了结）
    const replayed = stage.sink.byKind('tool.call').at(-1)
    expect(replayed).toBeDefined()
    const results = stage.sink.byKind('tool.result')
    expect(results.map((event) => event.data.call)).toEqual([replayed?.id ?? -1, 42])
    expect(results.map((event) => event.data.ok)).toEqual([true, true])

    expect(report.dispositions).toEqual([
      { call: 42, entry: 2, name: 'exec', action: { kind: 'replayed', ok: true }, resultEntry: expect.any(Number) },
    ])
  })

  test('重放也走闸门（不可绕过）——闸门拒绝则如实记拒绝，不当作成功', async () => {
    const stage = makeStage({
      auto: 'reject',
      handlers: { exec: () => ({ ok: true, output: '不该跑' }) },
      scan: scanOf([callOf()]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    await recoverSession(runtimeOf(stage, () => true))

    expect(stage.tools.calls).toEqual([]) // 闸门未批准 ⇒ 执行体压根不存在
    const result = resultsOf(stage.records.entries)[0]
    expect(payloadTextOf(result as Entry)).toContain('拒绝')
  })
})

describe('② 非幂等的那笔——拒绝自动恢复（本单元最硬的一条）', () => {
  test('已批准但非幂等：**一次都不重跑**，落「未重跑」失败', async () => {
    const stage = makeStage({
      handlers: { exec: () => ({ ok: true, output: '不该跑' }) },
      scan: scanOf([callOf({ args: { cmd: 'mkdir -p src/new' } })]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'mkdir -p src/new' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, () => false))

    // ★ 绝不静默重试——工具域一次都没被调
    expect(stage.tools.calls).toEqual([])

    const result = resultsOf(stage.records.entries)[0]
    expect(result?.payload).toMatchObject({ ok: false })
    expect(payloadTextOf(result as Entry)).toContain('未自动重跑')

    // 事件侧同样了结（call 指回原笔），且明说是失败
    const closed = stage.sink.byKind('tool.result')[0]
    expect(closed?.data.call).toBe(42)
    expect(closed?.data.ok).toBe(false)

    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'non-idempotent' })

    // 材料要把「请裁决」说清楚（重跑 / 记失败）
    expect(jsonOf(closed as KernelEvent)).toContain('重跑')
  })

  test('幂等判定缺省从严——**没接线就一律不重放**（生产装配正是这条）', async () => {
    const stage = makeStage({
      handlers: { exec: () => ({ ok: true, output: '不该跑' }) },
      scan: scanOf([callOf()]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage)) // 不给 idempotent

    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'non-idempotent' })
  })
})

describe('④ 未答复裁决＝按「拒绝」落账（保守）', () => {
  test('问了没答：不重跑、按拒绝落账，措辞点明「未答复」', async () => {
    const stage = makeStage({
      handlers: { exec: () => ({ ok: true, output: '不该跑' }) },
      scan: scanOf([callOf({ decision: null, decider: null })]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'rm -rf build' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, () => true))

    // 幂等与否都不重跑——**没答复＝没批准**
    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'unanswered' })
    expect(payloadTextOf(resultsOf(stage.records.entries)[0] as Entry)).toContain('未答复')
  })

  test('已被拒（崩在回填窗口）：按拒绝落账', async () => {
    const stage = makeStage({ scan: scanOf([callOf({ decision: 'reject' })]) })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, () => true))

    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'rejected' })
  })
})

describe('③ 未完成流式消息丢弃、记中止', () => {
  test('补 turn.end{aborted}；半截正文**不落账**（没有凭空多出的助手条目）', async () => {
    const stage = makeStage({ scan: scanOf([], 3) })
    stage.records.appendEntry({ kind: 'user', content: { text: '跑个 ls' }, at: T0 })

    const report = await recoverSession(runtimeOf(stage))

    const turnEnds = stage.sink.byKind('turn.end')
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]?.data.reason).toBe('aborted')
    expect(turnEnds[0]?.turn).toBe(3) // 信封的 turn ＝中断那一轮

    expect(stage.records.entries.map((entry) => entry.kind)).toEqual(['user'])
    expect(report.turn).toBe(3)
  })

  test('无事可干就什么都不发（干净的会话不该被恢复搅一遍）', async () => {
    const stage = makeStage({ scan: scanOf([], null) })

    const report = await recoverSession(runtimeOf(stage))

    expect(stage.sink.events).toEqual([])
    expect(stage.records.entries).toEqual([])
    expect(report.dispositions).toEqual([])
    expect(report.turn).toBe(null)
    // 开工位如实报 false——干净会话没发过 `agent.start`（对话域据此照常自己发）
    expect(report.announced).toBe(false)
  })

  test('收尾回到等待输入；轮号水位与开工位交回调用方（⑤ 的递手件）', async () => {
    const stage = makeStage({ scan: scanOf([], 7) })
    const report = await recoverSession(runtimeOf(stage))

    expect(stage.sink.byKind('agent.state').at(-1)?.data.state).toBe('waiting')
    expect(report.lastTurn).toBe(7)
    expect(report.announced).toBe(true)
  })
})

describe('判据之外的钉子', () => {
  test('缺链引用的半笔（只有条目）：仍了结，只是没有事件可铸', async () => {
    const stage = makeStage({
      scan: scanOf([callOf({ call: null, entry: 2, decision: null, decider: null })]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, () => true))

    expect(stage.sink.byKind('tool.result')).toEqual([]) // 没有链引用就不铸结果事件（不编造）
    expect(resultsOf(stage.records.entries)).toHaveLength(1) // 条目侧照样了结
    expect(report.dispositions[0]?.resultEntry).not.toBe(null)
  })

  test('两笔在途按序处置（同轮多工具）', async () => {
    const stage = makeStage({
      handlers: { exec: () => ({ ok: true, output: 'ok' }) },
      scan: scanOf([
        callOf({ call: 42, entry: 2, args: { cmd: 'ls' } }),
        callOf({ call: 43, entry: 3, args: { cmd: 'pwd' }, decision: null, decider: null }),
      ]),
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'pwd' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, () => true))

    expect(report.dispositions.map((entry) => entry.action.kind)).toEqual(['replayed', 'not-replayed'])
    expect(stage.tools.calls.map((call) => call.args['cmd'])).toEqual(['ls'])
    expect(stage.records.entries.map((entry) => entry.kind)).toEqual([
      'tool-call',
      'tool-call',
      'tool-result',
      'tool-result',
    ])
  })
})

describe('用例入口（`createActions`）——⑤ 的递手', () => {
  /** 只记账的对话域替身——本组要验的是「入口把它接上了、递的是什么」。 */
  function fakeConversation() {
    const calls: { session: string; lastTurn: number | null; announced: boolean }[] = []
    return {
      calls,
      conversation: {
        rebuild: async (
          session: string,
          handoff: { readonly lastTurn: number | null; readonly announced: boolean },
        ) => {
          calls.push({ session, lastTurn: handoff.lastTurn, announced: handoff.announced })
          return { session, lastTurn: handoff.lastTurn }
        },
      },
    }
  }

  function portsOf(stage: ReturnType<typeof makeStage>): SessionPorts {
    return {
      session: SESSION,
      records: stage.records,
      tools: stage.toolDomain,
      stamper: stage.stamper,
    }
  }

  test('①②③④ 走完 → ⑤ 递手（水位 ＋ 开工位），顺序是处置在前、重建在后', async () => {
    const scan = scanOf([callOf({ decision: null, decider: null })], 4)
    const stage = makeStage({ scan })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const fake = fakeConversation()
    const actions = createActions({
      // 只记账的替身：本组验的是接线，不是对话域（那是 conversation 包的判据）
      conversation: fake.conversation as unknown as Parameters<typeof createActions>[0]['conversation'],
      sink: stage.sink,
      now: () => T0,
    })

    const report = await actions.recover(portsOf(stage))

    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'unanswered' })
    expect(fake.calls).toEqual([{ session: SESSION, lastTurn: 4, announced: true }])
  })

  test('干净会话也走⑤——①②③④ 一个事件都不发，但装载与「你在这儿」照旧发生', async () => {
    const stage = makeStage({ scan: scanOf([], null) })
    const fake = fakeConversation()
    const actions = createActions({
      conversation: fake.conversation as unknown as Parameters<typeof createActions>[0]['conversation'],
      sink: stage.sink,
      now: () => T0,
    })

    const report = await actions.recover(portsOf(stage))

    expect(stage.sink.events).toEqual([]) // 过程流里不留恢复的痕迹
    expect(report.announced).toBe(false)
    // 照旧递手——开工位报 false，对话域据此在首次 submit 时自己发 `agent.start`
    expect(fake.calls).toEqual([{ session: SESSION, lastTurn: null, announced: false }])
  })
})
