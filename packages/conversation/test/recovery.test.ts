/**
 * U15 · 对话域 —— **恢复**（技术方案 · 记录 ·「恢复（阶段 2 · 细部）」五条）。
 *
 * ```
 *   ① 在途识别        —— 有 tool.call 无 tool.result（记录域提供查询面，本域只管处置）
 *   ② 处置依幂等       —— 幂等 → 静默重放；非幂等 → 拒绝自动恢复、提交用户裁决
 *                          ★ 绝不静默重试非幂等操作
 *   ③ 未完成流式消息   —— 丢弃（半截正文本就不落账）＋ 记中止（补 turn.end{aborted}）
 *   ④ 未答复裁决       —— 按「拒绝」落账（保守）
 *   ⑤ 上下文由条目重建 —— 恢复后的上下文合法：助手消息的 toolCalls 条条有结果
 * ```
 *
 * **本文件在边界上测**：「在途长什么样」由记录域的查询面负责（那边的用例在
 * `packages/records/test/recovery.test.ts`），这里把扫描结果**当输入给定**（fixture），
 * 只验**处置**。两侧合起来的那一次，在试跑区的真跑里验（杀进程 → 重起）。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, KernelEvent } from '@magic/contracts'
import { DEFAULT_CONTEXT_POLICY } from '../src/policy.ts'
import type { InFlightCall, RecoveryScan } from '../src/recovery.ts'
import { recoverSession } from '../src/recovery.ts'
import { createConversationSession } from '../src/service.ts'
import { makeStage, waitFor, waitUntilIdle } from './support/harness.ts'
import type { Stage } from './support/harness.ts'
import { buildSystemPrompt } from '../src/prompt/index.ts'
import { assembleContext } from '../src/context.ts'

const SESSION = 's-recovery'
const T0 = 1_700_000_000_000

/** 一笔在途调用——除注明外都是「已批准、两侧齐全」的样子。 */
function callOf(overrides: Partial<InFlightCall> = {}): InFlightCall {
  return {
    call: 42,
    entry: 2,
    name: 'exec',
    args: { cmd: 'ls' },
    turn: 1,
    requested: true,
    decision: 'approve',
    decider: 'user',
    ...overrides,
  }
}

function scanOf(calls: readonly InFlightCall[], openTurn: number | null = 1): RecoveryScan {
  return { session: SESSION, openTurn, lastTurn: openTurn, calls }
}

/** 恢复的运行束——从测试台的一束替身拼出来（记录 / 工具 / 扇出 / 铸造器同源）。 */
function runtimeOf(
  stage: Stage,
  scan: RecoveryScan,
  idempotent?: (call: { readonly name: string }) => boolean,
) {
  return {
    session: SESSION,
    records: stage.records,
    tools: stage.toolDomain,
    sink: stage.sink,
    stamper: stage.stamper,
    now: () => T0,
    blobThreshold: DEFAULT_CONTEXT_POLICY.blobThreshold,
    inFlight: async (): Promise<RecoveryScan> => scan,
    ...(idempotent === undefined
      ? {}
      : { idempotent: (call: { readonly name: string; readonly args: Readonly<Record<string, unknown>> }) => idempotent(call) }),
  }
}

/** 结果条目——`tool-result` 的那些（恢复补的就是它）。 */
const resultsOf = (entries: readonly Entry[]): readonly Entry[] =>
  entries.filter((entry) => entry.kind === 'tool-result')

/** 某条目载荷里的记录侧输出文本（内联支）。 */
function payloadTextOf(entry: Entry): string {
  const payload: unknown = entry.payload
  if (typeof payload !== 'object' || payload === null) return ''
  const output = (payload as { output?: unknown }).output
  if (typeof output !== 'object' || output === null) return ''
  const text = (output as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

/** 事件的 JSON 文本（断措辞用——事件与条目两处都该说同一件事）。 */
const jsonOf = (event: KernelEvent): string => JSON.stringify(event)

describe('② 幂等的那笔——静默重放', () => {
  test('重放：工具域被调一次，结果条目与原调用条目成对', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: 'a.txt\n' }) } })
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

    const report = await recoverSession(runtimeOf(stage, scanOf([callOf()]), () => true))

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
    const stage = makeStage({ auto: 'reject', handlers: { exec: () => ({ ok: true, output: '不该跑' }) } })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    await recoverSession(runtimeOf(stage, scanOf([callOf()]), () => true))

    expect(stage.tools.calls).toEqual([]) // 闸门未批准 ⇒ 执行体压根不存在
    const result = resultsOf(stage.records.entries)[0]
    expect(payloadTextOf(result as Entry)).toContain('拒绝')
  })
})

describe('② 非幂等的那笔——拒绝自动恢复（本单元最硬的一条）', () => {
  test('已批准但非幂等：**一次都不重跑**，落「未重跑」失败', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: '不该跑' }) } })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'mkdir -p src/new' } },
      at: T0,
    })

    const report = await recoverSession(
      runtimeOf(stage, scanOf([callOf({ args: { cmd: 'mkdir -p src/new' } })]), () => false),
    )

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

  test('幂等判定缺省从严——没接线就一律不重放', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: '不该跑' }) } })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(runtimeOf(stage, scanOf([callOf()]))) // 不给 idempotent

    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'non-idempotent' })
  })
})

describe('④ 未答复裁决＝按「拒绝」落账（保守）', () => {
  test('问了没答：不重跑、按拒绝落账，措辞点明「未答复」', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: '不该跑' }) } })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'rm -rf build' } },
      at: T0,
    })

    const report = await recoverSession(
      runtimeOf(stage, scanOf([callOf({ decision: null, decider: null })]), () => true),
    )

    // 幂等与否都不重跑——**没答复＝没批准**
    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'unanswered' })
    expect(payloadTextOf(resultsOf(stage.records.entries)[0] as Entry)).toContain('未答复')
  })

  test('已被拒（崩在回填窗口）：按拒绝落账', async () => {
    const stage = makeStage()
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(
      runtimeOf(stage, scanOf([callOf({ decision: 'reject' })]), () => true),
    )

    expect(stage.tools.calls).toEqual([])
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'rejected' })
  })
})

describe('③ 未完成流式消息丢弃、记中止', () => {
  test('补 turn.end{aborted}；半截正文**不落账**（没有凭空多出的助手条目）', async () => {
    const stage = makeStage()
    stage.records.appendEntry({ kind: 'user', content: { text: '跑个 ls' }, at: T0 })

    const report = await recoverSession(runtimeOf(stage, scanOf([], 3)))

    const turnEnds = stage.sink.byKind('turn.end')
    expect(turnEnds).toHaveLength(1)
    expect(turnEnds[0]?.data.reason).toBe('aborted')
    expect(turnEnds[0]?.turn).toBe(3) // 信封的 turn ＝中断那一轮

    expect(stage.records.entries.map((entry) => entry.kind)).toEqual(['user'])
    expect(report.turn).toBe(3)
  })

  test('无事可干就什么都不发（干净的会话不该被恢复搅一遍）', async () => {
    const stage = makeStage()

    const report = await recoverSession(runtimeOf(stage, scanOf([], null)))

    expect(stage.sink.events).toEqual([])
    expect(stage.records.entries).toEqual([])
    expect(report.dispositions).toEqual([])
    expect(report.turn).toBe(null)
  })

  test('收尾回到等待输入；轮号水位交回调用方（续跑接着走）', async () => {
    const stage = makeStage()
    const report = await recoverSession(runtimeOf(stage, scanOf([], 7)))

    expect(stage.sink.byKind('agent.state').at(-1)?.data.state).toBe('waiting')
    expect(report.lastTurn).toBe(7)
  })
})

describe('⑤ 上下文由条目重建——恢复后仍然合法', () => {
  test('助手消息的 toolCalls 条条有工具消息跟随（带 toolCalls 而无回填会被供应商拒）', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: 'a.txt\n' }) } })
    // 崩溃前的现场：用户交代 → 助手请求一次调用 → 调用条目 → （无结果）
    stage.records.appendEntry({ kind: 'user', content: { text: '看看目录' }, at: T0 })
    const assistant = stage.records.appendEntry({
      kind: 'assistant',
      content: { text: '我看看' },
      at: T0,
    })
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })
    void assistant

    await recoverSession(runtimeOf(stage, scanOf([callOf({ entry: assistant + 1 })]), () => true))

    const messages = await assembleContext({
      records: stage.records,
      session: SESSION,
      systemPrompt: buildSystemPrompt({ cwd: '/w', platform: 'darwin', date: '2026-09-18' }),
    })

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    const backfill = messages[3]
    expect(backfill).toMatchObject({ role: 'tool', name: 'exec', ok: true, output: 'a.txt\n' })
  })
})

describe('真跑一遍到在途（测试台 · 与真装配同形的接线）', () => {
  test('工具在途时「进程没了」→ 恢复不重跑、按未答复落账，上下文重新合法', async () => {
    const stage = makeStage({
      turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'mkdir -p src/new' } }] }],
      // 执行体**永不落定**——真跑里就是那一刻被 SIGKILL（命令还挂在沙箱里）
      handlers: { exec: () => new Promise(() => {}) },
    })

    const { agentLoop } = await import('../src/agent-loop.ts')
    const running = agentLoop(
      {
        session: SESSION,
        model: 'faux-1',
        systemPrompt: 'sys',
        gateway: stage.gateway,
        tools: stage.toolDomain,
        records: stage.records,
        sink: stage.sink,
        stamper: stage.stamper,
        nextTurnId: () => 1,
        now: () => T0,
        blobThreshold: DEFAULT_CONTEXT_POLICY.blobThreshold,
        blobTextLimit: DEFAULT_CONTEXT_POLICY.blobTextLimit,
      },
      { text: '建个目录' },
      new AbortController().signal,
    )

    // 等它把工具跑起来——那正是崩溃点：调用条目已落、`tool.call` 已铸、结果没有
    await waitFor(() => (stage.sink.byKind('tool.call').length >= 1 ? true : undefined), '工具跑起来')
    void running // 进程没了：这个 promise 永远不会落定（真跑里就是被 SIGKILL）

    const callEntry = stage.records.entries.find((entry) => entry.kind === 'tool-call')
    const callEvent = stage.sink.byKind('tool.call')[0]
    expect(callEntry).toBeDefined()
    expect(callEvent).toBeDefined()
    expect(stage.sink.byKind('tool.result')).toEqual([]) // 在途：有调用无结果

    const report = await recoverSession(
      runtimeOf(
        stage,
        scanOf([
          callOf({
            call: callEvent?.id ?? null,
            entry: callEntry?.id ?? null,
            args: { cmd: 'mkdir -p src/new' },
            // 记录里**没有**裁决事件（这一束替身的闸门不发事件——见 U04 备案 9），
            // 故扫描如实报「未走到裁决」；真装配里权限域会发，轨迹照读
            requested: false,
            decision: null,
            decider: null,
          }),
        ]),
        () => false,
      ),
    )

    expect(stage.tools.calls).toHaveLength(1) // 还是原来那一次——**没有重跑**
    expect(report.dispositions[0]?.action).toEqual({ kind: 'not-replayed', why: 'unanswered' })

    const messages = await assembleContext({
      records: stage.records,
      session: SESSION,
      systemPrompt: 'sys',
    })
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool'])
  })
})

describe('ConversationService · 恢复面（recover()）', () => {
  /** 端口实现的构造入参——恢复面接上（其余与 `service.test.ts` 同源）。 */
  function serviceOf(
    stage: Stage,
    scan: RecoveryScan,
    idempotent?: (call: { readonly name: string }) => boolean,
  ) {
    return createConversationSession({
      session: SESSION,
      model: 'faux-1',
      prompt: { cwd: '/w', platform: 'darwin', date: '2026-09-18' },
      gateway: stage.gateway,
      tools: stage.toolDomain,
      records: stage.records,
      sink: stage.sink,
      stamper: stage.stamper,
      now: () => T0,
      recovery: {
        inFlight: async (): Promise<RecoveryScan> => scan,
        ...(idempotent === undefined ? {} : { idempotent: (call) => idempotent(call) }),
      },
    })
  }

  test('未接线即报错——不静默返回「没事」（静默降级会让人以为恢复过了）', async () => {
    const stage = makeStage()
    const service = createConversationSession({
      session: SESSION,
      model: 'faux-1',
      prompt: { cwd: '/w', platform: 'darwin', date: '2026-09-18' },
      gateway: stage.gateway,
      tools: stage.toolDomain,
      records: stage.records,
      sink: stage.sink,
      stamper: stage.stamper,
    })

    await expect(service.recover()).rejects.toThrow('未接线恢复面')
  })

  test('干净会话：什么都不做（不发事件、不落条目）', async () => {
    const stage = makeStage()
    const report = await serviceOf(stage, scanOf([], null)).recover()

    expect(report.dispositions).toEqual([])
    expect(stage.sink.events).toEqual([])
  })

  test('有活：起 · 处置 · 记中止 · 回到等待输入——首个 submit 不再重发 agent.start', async () => {
    const stage = makeStage({ turns: [{ text: '接着干' }] })
    const service = serviceOf(stage, scanOf([], 5))

    await service.recover()

    expect(stage.sink.events.map((event) => event.kind)).toEqual([
      'agent.start',
      'turn.end',
      'agent.state',
    ])
    expect(stage.sink.byKind('agent.state')[0]?.data.state).toBe('waiting')

    service.submit({ text: '接着说' })
    await waitUntilIdle(stage.sink)

    // `agent.start` 全流程只有一条——恢复已经代表了本实例的「首次开工」
    expect(stage.sink.byKind('agent.start')).toHaveLength(1)
  })

  test('轮号续跑：记录里的水位抬过来，下一轮接着那串号走（不从 1 重来）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = serviceOf(stage, scanOf([], 5))

    await service.recover()
    service.submit({ text: '接着说' })
    await waitUntilIdle(stage.sink)

    expect(stage.sink.byKind('turn.start').map((event) => event.turn)).toEqual([6])
  })

  test('干活时不许恢复——与循环抢同一条记录流', async () => {
    const stage = makeStage({
      turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'sleep 100' } }] }],
      handlers: { exec: () => new Promise(() => {}) },
    })
    const service = serviceOf(stage, scanOf([], null))

    service.submit({ text: '跑个长命令' })
    await waitFor(() => (stage.sink.byKind('tool.call').length >= 1 ? true : undefined), '工具跑起来')

    await expect(service.recover()).rejects.toThrow('放开输入之前')
  })
})

describe('判据之外的钉子', () => {
  test('缺链引用的半笔（只有条目）：仍了结，只是没有事件可铸', async () => {
    const stage = makeStage()
    stage.records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: T0,
    })

    const report = await recoverSession(
      runtimeOf(stage, scanOf([callOf({ call: null, entry: 2, decision: null })]), () => true),
    )

    expect(stage.sink.byKind('tool.result')).toEqual([]) // 没有链引用就不铸结果事件（不编造）
    expect(resultsOf(stage.records.entries)).toHaveLength(1) // 条目侧照样了结
    expect(report.dispositions[0]?.resultEntry).not.toBe(null)
  })

  test('两笔在途按序处置（同轮多工具）', async () => {
    const stage = makeStage({ handlers: { exec: () => ({ ok: true, output: 'ok' }) } })
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

    const calls: readonly InFlightCall[] = [
      callOf({ call: 42, entry: 2, args: { cmd: 'ls' } }),
      callOf({ call: 43, entry: 3, args: { cmd: 'pwd' }, decision: null }),
    ]
    const report = await recoverSession(runtimeOf(stage, scanOf(calls), () => true))

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
