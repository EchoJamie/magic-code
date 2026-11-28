import { expect, test } from 'bun:test'
import type { ModelGateway, ModelRequest, ToolSpec } from '@magic/contracts'
import { agentLoop } from '../src/agent-loop.ts'
import { COMPACT_INSTRUCTION_PREFIX } from '../src/brief.ts'
import { createCompactor } from '../src/compact.ts'
import { COMPACTION_HANDOFF_PREFIX, assembleContext } from '../src/context.ts'
import { DEFAULT_TEST_SESSION, FIXED_AT } from '@magic/faux'
import { makeCompactor, makeLoopRuntime, makeStage } from './support/harness.ts'

/** 取消息正文——只取字符串形态。 */
const textOf = (message: unknown): string => {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : ''
}

const isCompactReq = (req: ModelRequest): boolean => {
  const last = req.messages.at(-1)
  return last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith(COMPACT_INSTRUCTION_PREFIX)
}

test('用量到 85% 触发压缩；预算读数更小时按预算算', async () => {
  const compact = makeCompactor(makeStage(), { policy: { compactAtFraction: .85, compactAtTokens: 100 } })
  compact.observe({ inputTokens: 849, contextWindow: 1000 })
  expect(compact.needed()).toBe(false)
  compact.observe({ inputTokens: 850, contextWindow: 1000 })
  expect(compact.needed()).toBe(true)

  const stage = makeStage()
  const budgeted = createCompactor({ records: stage.records, session: 'test', gateway: stage.gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => 1, compactAtFraction: .85, compactAtTokens: 120000,
    capacity: () => ({ inputBudget: 2000 }) })
  // 2000 − 512（准备预留）= 1488；1487 不压，1488 压
  budgeted.observe({ inputTokens: 1487, contextWindow: 128000 })
  expect(budgeted.needed()).toBe(false)
  budgeted.observe({ inputTokens: 1488, contextWindow: 128000 })
  expect(budgeted.needed()).toBe(true)
})

/** 一段像真的会话：几轮问答，最后再补一条最新交代。 */
function seed(stage: ReturnType<typeof makeStage>, turns: number): void {
  for (let n = 0; n < turns; n++) {
    stage.records.appendEntry({ kind: 'user', content: { text: `第${n}条` }, at: n })
    stage.records.appendEntry({ kind: 'assistant', content: { text: `答复${n}` }, at: n })
  }
  stage.records.appendEntry({ kind: 'user', content: { text: '最新一句' }, at: 100 })
}

test('压缩＝交接材料原子存进 summary，最新一句原文仍留在上下文里', async () => {
  const stage = makeStage({ turns: [{ text: '## 目标与当前状态\n把压缩改成交接\n## 未完成与下一步\n继续' }] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  seed(stage, 5)

  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome.ok).toBe(true)

  const coverage = stage.records.coverage.read()
  const rest = await Array.fromAsync(stage.records.readEntries(DEFAULT_TEST_SESSION, { from: (coverage.coveredThrough ?? 0) + 1 }))
  // 不再伪造 handoff 的 user 条目；用户最新说的那句原样留着
  expect(rest.some(entry => entry.kind === 'user' && entry.payload !== undefined && 'handoff' in entry.payload)).toBe(false)
  expect(rest.filter(entry => entry.kind === 'user').map(entry => (entry.content as { text?: string }).text)).toContain('最新一句')

  const messages = await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统提示' })
  expect(messages[1]).toMatchObject({ role: 'user' })
  expect(textOf(messages[1])).toContain(COMPACTION_HANDOFF_PREFIX)
  expect(textOf(messages[1])).toContain('把压缩改成交接')
  expect(messages.some(message => textOf(message).includes('最新一句'))).toBe(true)
  // 旧材料不再进上下文
  expect(messages.some(message => textOf(message).includes('第0条'))).toBe(false)
})

test('没有可交接的材料时明说，并且自动路径也要发状态', async () => {
  const stage = makeStage({ turns: [] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome).toMatchObject({ ok: false, kind: 'no-material' })
  expect(stage.sink.events.filter(event => event.kind === 'compact.state').at(-1)?.data).toMatchObject({ state: 'no-material' })
})

test('交接材料生成失败时保留原上下文并报出原因', async () => {
  const stage = makeStage({ turns: [] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  stage.records.appendEntry({ kind: 'user', content: { text: '原始交代' }, at: 0 })
  stage.records.appendEntry({ kind: 'assistant', content: { text: '做了一些事' }, at: 1 })
  stage.records.appendEntry({ kind: 'user', content: { text: '最新一句' }, at: 2 })
  const outcome = await compact.run({ trigger: 'threshold' })
  expect(outcome.ok).toBe(false)
  expect(stage.records.coverage.read().coveredThrough).toBeNull()
  expect(stage.sink.events.some(event => event.kind === 'compact.state' && event.data.state === 'failed')).toBe(true)
})

test('手动压缩与自动走同一条交接路径', async () => {
  const stage = makeStage({ turns: [{ text: '## 目标与当前状态\n手动交接\n## 未完成与下一步\n继续' }] })
  const compact = makeCompactor(stage, { capacity: () => ({ inputBudget: 8000 }) })
  seed(stage, 3)
  const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'req-1', focus: '保留 slash 部分' } })
  expect(outcome.ok).toBe(true)
  const coverage = stage.records.coverage.read()
  expect(coverage.coveredThrough).not.toBeNull()
  const rest = await Array.fromAsync(stage.records.readEntries(DEFAULT_TEST_SESSION, { from: (coverage.coveredThrough ?? 0) + 1 }))
  const summary = rest.find(entry => entry.id === coverage.summary)
  expect(summary?.kind).toBe('summary')
  expect(summary?.payload).toMatchObject({ format: 'compaction-v2' })
  expect(rest.filter(entry => entry.kind === 'user').map(entry => (entry.content as { text?: string }).text)).toContain('最新一句')
})

test('交接调用透传模型容量 maxOutputTokens，未指定时不硬编码 8192', async () => {
  const seenOpts: { maxOutputTokens?: number }[] = []
  const stage = makeStage({ turns: [
    { text: '## 目标与当前状态\n一' },
    { text: '## 目标与当前状态\n二' },
  ] })
  const gateway: ModelGateway = {
    stream(req, opts) {
      seenOpts.push(opts)
      return stage.gateway.stream(req, opts)
    },
  }
  seed(stage, 2)

  let cap: { inputBudget: number; maxOutputTokens?: number } = { inputBudget: 868_928, maxOutputTokens: 131_072 }
  const compact = createCompactor({
    records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
    compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => cap,
  })
  expect((await compact.run({ trigger: 'threshold', compact: { requestId: 'c1' } })).ok).toBe(true)
  expect(seenOpts[0]?.maxOutputTokens).toBe(131_072)

  stage.records.appendEntry({ kind: 'user', content: { text: '再加一句' }, at: 200 })
  cap = { inputBudget: 868_928 }
  expect((await compact.run({ trigger: 'threshold', compact: { requestId: 'c2' } })).ok).toBe(true)
  expect(seenOpts[1]?.maxOutputTokens).toBeUndefined()
})

test('finishReason=length 截断时返回明确诊断且 memory.model 记 ok=false 与 finishReason', async () => {
  const stage = makeStage()
  seed(stage, 2)
  const gateway: ModelGateway = {
    stream() {
      async function* events() {
        yield stage.stamper.stamp('model.call.start', { model: 'GLM', provider: 'sinoma' })
        yield stage.stamper.stamp('model.delta', { channel: 'thinking', text: '长推理过程' })
        yield stage.stamper.stamp('model.usage', { inputTokens: 1000, outputTokens: 8192, reasoningTokens: 8192 })
        yield stage.stamper.stamp('model.call.end', {})
      }
      return {
        events: events(),
        result: Promise.resolve({
          complete: true,
          finishReason: 'length',
          usage: { inputTokens: 1000, outputTokens: 8192, reasoningTokens: 8192 },
        }),
      }
    },
  }
  const compact = createCompactor({
    records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
    compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 64_000, maxOutputTokens: 8_192 }),
  })

  const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'req-len' } })
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) {
    expect(outcome.kind).toBe('local-capacity')
    expect(outcome.reason).toContain('GLM')
    expect(outcome.reason).toContain('finish_reason=length')
    expect(outcome.reason).toContain('8192')
  }
  expect(stage.sink.byKind('memory.model').at(-1)?.data).toMatchObject({
    ok: false,
    finishReason: 'length',
    model: 'GLM',
  })
})

test('只有首条用户交代且尚无助手轮次时前置拦截，不调用模型、不重复刷错', async () => {
  let calls = 0
  const stage = makeStage({ turns: [{ text: '不应该被调用' }] })
  const gateway: ModelGateway = {
    stream(req, opts) { calls++; return stage.gateway.stream(req, opts) },
  }
  stage.records.appendEntry({ kind: 'user', content: { text: '唯一一句' }, at: 1 })
  const compact = createCompactor({
    records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
    compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 8_000 }),
  })

  const first = await compact.run({ trigger: 'threshold' })
  expect(first).toMatchObject({ ok: false, kind: 'transient', reason: '没有可覆盖的旧段，交接不成立' })
  expect(calls).toBe(0)
  expect(stage.sink.byKind('error')).toHaveLength(1)

  const second = await compact.run({ trigger: 'threshold' })
  expect(second).toMatchObject({ ok: false, kind: 'no-material' })
  expect(calls).toBe(0)
  expect(stage.sink.byKind('error')).toHaveLength(1)
})

test('单用户百轮工具循环可按完整轮次切段压缩，保留近期现场并锚定真实用户原话；二次压缩不丢用户原话', async () => {
  const stage = makeStage({ turns: [
    { text: '## 目标与当前状态\n第一阶段工具循环摘要' },
    { text: '## 目标与当前状态\n第二阶段工具循环摘要' },
  ] })
  const user1Id = stage.records.appendEntry({ kind: 'user', content: { text: '请修完所有单测（唯一真实用户要求）' }, at: 1 })
  for (let i = 1; i <= 10; i++) {
    stage.records.appendEntry({ kind: 'assistant', content: { text: `执行第 ${i} 步` }, at: 10 + i * 3 })
    stage.records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: `c_${i}`, name: 'exec', args: { command: `step_${i}` } }, at: 11 + i * 3 })
    stage.records.appendEntry({ kind: 'tool-result', content: { text: '输出'.repeat(200) + ` RESULT_${i}` }, payload: { ok: true, call: `c_${i}`, output: { text: '输出'.repeat(200) + ` RESULT_${i}` } }, at: 12 + i * 3 })
  }
  // 夹入一条内核后台通知（notice: true），绝不能冒充真实用户原话
  stage.records.appendEntry({ kind: 'user', content: { text: '〔后台命令跑完了〕bg-1' }, payload: { notice: true }, at: 999 })

  const compact = createCompactor({
    records: stage.records, session: DEFAULT_TEST_SESSION, gateway: stage.gateway,
    sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
    compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 20_000 }),
  })

  const first = await compact.run({ trigger: 'threshold', compact: { requestId: 'single-1' } })
  expect(first.ok).toBe(true)
  if (first.ok) expect(first.kept).toBeGreaterThan(0)

  const cov1 = stage.records.coverage.read()
  expect(cov1.coveredThrough).toBeGreaterThanOrEqual(user1Id)
  const msgs1 = await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统' })
  const serialized1 = JSON.stringify(msgs1)
  expect(serialized1).toContain('第一阶段工具循环摘要')
  expect(serialized1).toContain('请修完所有单测（唯一真实用户要求）')
  expect(serialized1).toContain('RESULT_10')
  expect(serialized1).not.toContain('RESULT_1"')

  // 再跑 10 轮后触发第二次压缩：依然不丢 user1 原话，且新摘要覆盖掉第一轮尾部
  for (let i = 11; i <= 20; i++) {
    stage.records.appendEntry({ kind: 'assistant', content: { text: `执行第 ${i} 步` }, at: 1000 + i * 3 })
    stage.records.appendEntry({ kind: 'tool-call', content: { text: '' }, payload: { id: `c_${i}`, name: 'exec', args: { command: `step_${i}` } }, at: 1001 + i * 3 })
    stage.records.appendEntry({ kind: 'tool-result', content: { text: '输出'.repeat(200) + ` RESULT_${i}` }, payload: { ok: true, call: `c_${i}`, output: { text: '输出'.repeat(200) + ` RESULT_${i}` } }, at: 1002 + i * 3 })
  }
  const second = await compact.run({ trigger: 'threshold', compact: { requestId: 'single-2' } })
  expect(second.ok).toBe(true)
  const msgs2 = await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统' })
  const serialized2 = JSON.stringify(msgs2)
  expect(serialized2).toContain('第二阶段工具循环摘要')
  expect(serialized2).toContain('请修完所有单测（唯一真实用户要求）')
  expect(serialized2).toContain('RESULT_20')
})

test('同前缀保留 tools 遇模型误吐 toolCalls 自动回退无 tools 重试；遇 context-limit 头裁剪重试', async () => {
  // 1) tool-calls 回退重试
  {
    const stage = makeStage()
    seed(stage, 3)
    const seenTools: (readonly ToolSpec[] | undefined)[] = []
    let callIdx = 0
    const fakeTool: ToolSpec = { name: 'exec', summary: 'exec', parameters: {}, danger: { level: 'light' } }
    const gateway: ModelGateway = {
      stream(req, opts) {
        seenTools.push(req.tools)
        callIdx++
        return makeStage({
          turns: [callIdx === 1
            ? { toolCalls: [{ name: 'exec', args: { command: 'ls' } }] }
            : { text: '## 目标与当前状态\n回退成功' }],
        }).gateway.stream(req, opts)
      },
    }
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
      preparePrefix: async () => ({
        messages: await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统' }),
        tools: [fakeTool],
      }),
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 20_000 }),
    })
    const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'tool-fallback' } })
    expect(outcome.ok).toBe(true)
    expect(seenTools).toHaveLength(2)
    expect(seenTools[0]).toEqual([fakeTool])
    expect(seenTools[1]).toBeUndefined()
  }

  // 2) context-limit 自动头裁剪重试
  {
    const stage = makeStage()
    seed(stage, 5)
    const seenLengths: number[] = []
    let attempt = 0
    const gateway: ModelGateway = {
      stream(req, opts) {
        seenLengths.push(req.messages.length)
        attempt++
        if (attempt === 1) {
          return makeStage({ turns: [{ error: { tier: 'context-limit', message: 'prompt too long' } }] }).gateway.stream(req, opts)
        }
        return makeStage({ turns: [{ text: '## 目标与当前状态\n裁剪后成功' }] }).gateway.stream(req, opts)
      },
    }
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
      preparePrefix: async () => ({
        messages: await assembleContext({ records: stage.records, session: DEFAULT_TEST_SESSION, systemPrompt: '系统' }),
      }),
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 20_000 }),
    })
    const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'ctx-trim' } })
    expect(outcome.ok).toBe(true)
    expect(seenLengths).toHaveLength(2)
    expect(seenLengths[1]!).toBeLessThan(seenLengths[0]!)
  }
})

test('压缩超时中断与连续自动失败退避冷却（换模型或手动立即重置）', async () => {
  // 1) timeoutMs 超时中断
  {
    const stage = makeStage()
    seed(stage, 2)
    const hangingGateway: ModelGateway = {
      stream(_req, opts) {
        return {
          events: (async function* () {
            await new Promise<void>((_resolve, reject) => {
              opts.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
            })
          })(),
          result: new Promise(resolve => {
            opts.signal?.addEventListener('abort', () => resolve({ complete: false, finishReason: 'error' }), { once: true })
          }),
        }
      },
    }
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway: hangingGateway,
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      timeoutMs: 25, compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 8_000 }),
    })
    const outcome = await compact.run({ trigger: 'threshold', compact: { requestId: 'timeout-1' } })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toContain('超时')
  }

  // 2) 连续失败退避冷却，新增条目未达阈值不重复打模型；换模型 identity 或手动请求立即重置
  {
    const stage = makeStage()
    seed(stage, 2)
    let calls = 0
    const failingGateway: ModelGateway = {
      stream(req, opts) { calls++; return makeStage({ turns: [{ text: '   ' }] }).gateway.stream(req, opts) },
    }
    let identity = 'model-a'
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway: failingGateway,
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 8_000, identity }),
    })
    const r1 = await compact.run({ trigger: 'threshold' })
    expect(r1.ok).toBe(false)
    expect(calls).toBe(1)

    // 即使新写了 1 条助手记录导致 basisKey 变化，仍处于冷却期，不调模型
    stage.records.appendEntry({ kind: 'assistant', content: { text: '新工具轮' }, at: 300 })
    const r2 = await compact.run({ trigger: 'threshold' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.reason).toContain('冷却')
    expect(calls).toBe(1)

    // 切换模型 identity 后冷却立即清零
    identity = 'model-b'
    const r3 = await compact.run({ trigger: 'threshold' })
    expect(r3.ok).toBe(false)
    expect(calls).toBe(2)

    // 手动 /compact 始终绕过冷却直接执行
    const r4 = await compact.run({ trigger: 'threshold', compact: { requestId: 'manual-bypass' } })
    expect(r4.ok).toBe(false)
    expect(calls).toBe(3)
  }
})

test('agentLoop 遇装配预算压力时先触发自动压缩；压缩失败时降级继续不死循环', async () => {
  // 1) 成功路径：usage 低于阈值（或未上报），但装配估算超 room -> 先自动压缩再发主请求
  {
    const stage = makeStage()
    stage.records.appendEntry({ kind: 'user', content: { text: '第一件事' }, at: 1 })
    stage.records.appendEntry({ kind: 'assistant', content: { text: 'x'.repeat(6_000) }, at: 2 })
    const mainRequests: ModelRequest[] = []
    let compactCalls = 0
    const gateway: ModelGateway = {
      stream(req, opts) {
        if (isCompactReq(req)) {
          compactCalls++
          return makeStage({ turns: [{ text: '## 目标与当前状态\n已自动接续\n## 未完成与下一步\n继续' }] }).gateway.stream(req, opts)
        }
        mainRequests.push(req)
        return makeStage({ turns: [{ text: '主回复', usage: { inputTokens: 100, outputTokens: 10 } }] }).gateway.stream(req, opts)
      },
    }
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 4_500 }),
    })
    compact.observe({ inputTokens: 100, contextWindow: 100_000 })
    expect(compact.needed()).toBe(false)

    const outcome = await agentLoop(
      makeLoopRuntime(stage, { gateway, compact, capacity: () => ({ inputBudget: 4_500 }) }),
      { text: '新问题' },
      new AbortController().signal,
    )
    expect(outcome).toBe('settled')
    expect(compactCalls).toBe(1)
    expect(stage.sink.byKind('context.compacted')).toHaveLength(1)
    expect(mainRequests).toHaveLength(1)
    const sent = JSON.stringify(mainRequests[0])
    expect(sent).toContain('已自动接续')
    expect(sent).toContain('新问题')
    expect(sent).not.toContain('【上下文预算】')
  }

  // 2) 失败回退：压缩返回空材料时，不重复死循环，退回 fitBudget 降级结果正常发请求
  {
    const stage = makeStage()
    stage.records.appendEntry({ kind: 'user', content: { text: '第一件事' }, at: 1 })
    stage.records.appendEntry({ kind: 'assistant', content: { text: 'x'.repeat(6_000) }, at: 2 })
    const mainRequests: ModelRequest[] = []
    let compactCalls = 0
    const gateway: ModelGateway = {
      stream(req, opts) {
        if (isCompactReq(req)) {
          compactCalls++
          return makeStage({ turns: [{ text: '   ' }] }).gateway.stream(req, opts)
        }
        mainRequests.push(req)
        return makeStage({ turns: [{ text: '降级后回复', usage: { inputTokens: 100, outputTokens: 10 } }] }).gateway.stream(req, opts)
      },
    }
    const compact = createCompactor({
      records: stage.records, session: DEFAULT_TEST_SESSION, gateway,
      sink: stage.sink, stamper: stage.stamper, now: () => FIXED_AT,
      compactAtFraction: 0.85, compactAtTokens: 120_000, capacity: () => ({ inputBudget: 4_500 }),
    })

    const outcome = await agentLoop(
      makeLoopRuntime(stage, { gateway, compact, capacity: () => ({ inputBudget: 4_500 }) }),
      { text: '新问题' },
      new AbortController().signal,
    )
    expect(outcome).toBe('settled')
    expect(compactCalls).toBe(1)
    expect(stage.sink.byKind('context.compacted')).toHaveLength(0)
    expect(mainRequests).toHaveLength(1)
    expect(JSON.stringify(mainRequests[0])).toContain('【上下文预算】')
  }
})
