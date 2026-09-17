/**
 * 主循环 —— `agentLoop`（U04 判据 · 主循环与上下文）。
 *
 * 判据逐条钉在此处：
 * - **Faux 全链**——调用 → 工具 → 回填 → 收束，走通一轮与多轮；
 * - **中断**——在途打断：流停止 · 本轮以 `turn.end{reason:'aborted'}` 收束；
 * - **同轮多工具**——按序逐个；一个被拒只影响该调用（以「拒绝」回填），其余照常；
 * - **提示词装配**——四段 ＋ 环境注入块齐；注入三项对。
 *
 * 接线走**测试台**（`./support/harness.ts`）——其中的工具域替身与真装配同形
 * （铸 `tool.call` → 问闸门 → 执行 → 铸 `tool.result`）。
 */

import { describe, expect, test } from 'bun:test'
import type { TurnEndReason } from '@magic/contracts'
import { agentLoop } from '../src/agent-loop.ts'
import type { LoopRuntime } from '../src/agent-loop.ts'
import { buildSystemPrompt } from '../src/prompt/index.ts'
import { PROMPT_VARS, makeLoopRuntime, makeStage, waitFor } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

/** 一个不打断的信号——多数用例只关心跑完。 */
function idleSignal(): AbortSignal {
  return new AbortController().signal
}

/** 跑一串轮并等它收场——用例的开场白。 */
function run(runtime: LoopRuntime, text: string, signal = idleSignal()): Promise<TurnEndReason> {
  return agentLoop(runtime, { text }, signal)
}

/** 事件序列（只取 kind）——「顺序对不对」的断言读起来最省事。 */
function kindsOf(stage: Stage): readonly string[] {
  return stage.sink.events.map((event) => event.kind)
}

/** 某次模型请求里各消息的角色序。 */
function rolesOf(stage: Stage, requestIndex: number): readonly string[] {
  return (stage.gateway.requests[requestIndex]?.messages ?? []).map((message) => message.role)
}

describe('主循环 · Faux 全链', () => {
  test('一轮：调用 → 工具 → 回填 → 收束（事件序列与条目逐条对得上）', async () => {
    const stage = makeStage({
      turns: [
        { toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }] }, // 第一轮：模型要调工具
        { text: '跑完了' }, // 第二轮：收束
      ],
    })

    const outcome = await run(makeLoopRuntime(stage), '看下目录')

    expect(outcome).toBe('settled')

    // —— 过程流：两轮，每轮以 turn.start / turn.end 包住 ——
    expect(kindsOf(stage)).toEqual([
      'message.user', // 轮外（输入先于轮）
      'turn.start',
      'model.call.start',
      'model.delta', // 工具名
      'model.delta', // 参数 JSON
      'model.call.end',
      'message.assistant',
      'tool.call', // 工具域替身铸
      'tool.result',
      'turn.end',
      'turn.start',
      'model.call.start',
      'model.delta', // 正文
      'model.call.end',
      'message.assistant',
      'turn.end',
    ])

    expect(stage.sink.byKind('turn.end').map((e) => e.data.reason)).toEqual(['settled', 'settled'])

    // —— 内容流：四类条目按序落账（工具条目成对，为重放真源）——
    expect(stage.records.entries.map((entry) => entry.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
      'assistant',
    ])

    // —— 回填**送达模型**（循环写给模型看的证据）——
    expect(stage.gateway.requests).toHaveLength(2)
    expect(rolesOf(stage, 1)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(stage.gateway.requests[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'exec',
      ok: true,
      output: '跑了 ls', // 配对键与助手侧同一（见 context.ts 文件头注 1）
    })

    // 工具规格随每次调用送模型（`ToolRuntime.definitions()` 的去处）
    expect(stage.gateway.requests[0]?.tools?.map((tool) => tool.name)).toEqual(['exec'])

    // —— 链引用：询问带的 `callRef` 指向那次 `tool.call` 事件（三参必填的那一件）——
    expect(stage.gate.requests[0]?.callRef).toBe(stage.sink.byKind('tool.call')[0]?.id)
  })

  test('多轮：两次交代各走一串轮，上下文接着长（条目是唯一真源）', async () => {
    const stage = makeStage({
      turns: [{ text: '好' }, { toolCalls: [{ name: 'exec', args: { cmd: 'pwd' } }] }, { text: '完事了' }],
    })
    const runtime = makeLoopRuntime(stage)

    expect(await run(runtime, '第一件')).toBe('settled')
    expect(await run(runtime, '第二件')).toBe('settled')

    // 第二次交代的第一轮：把**前面几轮的内容**原样带上（由条目重建，不是另存一份）
    expect(rolesOf(stage, 1)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(stage.gateway.requests[1]?.messages[1]).toEqual({ role: 'user', content: '第一件' })
    expect(stage.gateway.requests[1]?.messages[2]).toEqual({ role: 'assistant', content: '好' })

    // 第二次交代的工具回填同样送达
    expect(rolesOf(stage, 2)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'tool'])

    // 轮号跨批次续着走（阶段 2 恢复要按记录重建同一串）
    expect(stage.stamper.turns).toEqual([1, undefined, 2, undefined, 3, undefined])
  })

  test('轮起止由对话域调 `beginTurn`——轮外事件 `turn` 为 `null`', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })

    await run(makeLoopRuntime(stage), '你好')

    // 「模型域被测试钉死不调 beginTurn」（M02 备案）——接上时得自己调
    expect(stage.stamper.turns).toEqual([1, undefined])
    // 输入在轮外；轮内事件都带本轮号
    expect(stage.sink.byKind('message.user')[0]?.turn).toBeNull()
    expect(stage.sink.byKind('turn.start')[0]?.turn).toBe(1)
    expect(stage.sink.byKind('model.delta')[0]?.turn).toBe(1)
    expect(stage.sink.byKind('turn.end')[0]?.turn).toBe(1)
  })
})

describe('主循环 · 提示词装配', () => {
  test('首条消息是系统提示词——四段 ＋ 环境注入块齐，注入三项对', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })

    await run(makeLoopRuntime(stage), '你好')

    const first = stage.gateway.requests[0]?.messages[0]
    expect(first?.role).toBe('system')

    const prompt = first?.role === 'system' ? first.content : ''
    for (const heading of ['## 身份', '## 行为规范', '## 工具使用指引', '## 权限姿态', '## 环境']) {
      expect(prompt).toContain(heading)
    }

    // 注入三项（`cwd` / `platform` / `date`）值取自构造入参，非就地取材
    expect(prompt).toContain('工作目录：/w')
    expect(prompt).toContain('平台：darwin')
    expect(prompt).toContain('日期：2026-09-18')

    // 逐字节即部件产物——循环不加工系统提示词
    expect(prompt).toBe(buildSystemPrompt(PROMPT_VARS))
  })
})

describe('主循环 · 同轮多工具', () => {
  test('按序逐个——前一个跑完才起下一个（不是并发）', async () => {
    const timeline: string[] = []
    const stage = makeStage({
      turns: [
        {
          toolCalls: [
            { name: 'exec', args: { cmd: 'a' } },
            { name: 'exec', args: { cmd: 'b' } },
            { name: 'exec', args: { cmd: 'c' } },
          ],
        },
        { text: '都跑完了' },
      ],
      handlers: {
        exec: async (call) => {
          const command = String(call.args.cmd)
          timeline.push(`开始 ${command}`)
          // 给「并发执行」留出插队的窗口——真并发的话这里会交错
          await new Promise((resolve) => setTimeout(resolve, 0))
          timeline.push(`结束 ${command}`)
          return { ok: true, output: `跑了 ${command}` }
        },
      },
    })

    expect(await run(makeLoopRuntime(stage), '三件事')).toBe('settled')

    expect(timeline).toEqual([
      '开始 a',
      '结束 a',
      '开始 b',
      '结束 b',
      '开始 c',
      '结束 c',
    ])

    // 三次调用各铸一条 `tool.call`（同轮多次，按序）
    expect(stage.sink.byKind('tool.call').map((e) => e.data.args['cmd'])).toEqual(['a', 'b', 'c'])

    // 回填按序进上下文——三条工具消息，次序即调用序
    const tools = (stage.gateway.requests[1]?.messages ?? []).filter((m) => m.role === 'tool')
    expect(tools.map((m) => (m.role === 'tool' ? m.output : ''))).toEqual([
      '跑了 a',
      '跑了 b',
      '跑了 c',
    ])

    // 三次调用的配对键两两同一（助手侧 `ToolCall.id` ≡ 工具侧 `callId`），且互不串位
    const assistant = (stage.gateway.requests[1]?.messages ?? [])[2]
    const ids = assistant?.role === 'assistant' ? (assistant.toolCalls ?? []).map((c) => c.id) : []
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    expect(tools.map((m) => (m.role === 'tool' ? m.callId : ''))).toEqual(ids)
  })

  test('一个被拒只影响该调用——以「拒绝」回填，其余照常执行', async () => {
    const stage = makeStage({
      turns: [
        {
          toolCalls: [
            { name: 'exec', args: { cmd: 'a' } },
            { name: 'exec', args: { cmd: 'b' } },
            { name: 'exec', args: { cmd: 'c' } },
          ],
        },
        { text: '好' },
      ],
      // 扮闸门：只有中间那个拒绝
      auto: (call) => (call.args['cmd'] === 'b' ? 'reject' : 'approve'),
    })

    expect(await run(makeLoopRuntime(stage), '三件事')).toBe('settled')

    // 被拒者不执行；其余两个照常（阶段 1 全人工门：每个调用都问过）
    expect(stage.gate.requests.map((r) => r.call.args['cmd'])).toEqual(['a', 'b', 'c'])
    expect(stage.tools.calls.map((c) => c.args['cmd'])).toEqual(['a', 'c'])

    // 三条回填各归各位：拒绝以 `ok:false` 回填，不串位、不吞掉整轮
    const tools = (stage.gateway.requests[1]?.messages ?? []).filter((m) => m.role === 'tool')
    expect(tools.map((m) => (m.role === 'tool' ? [m.ok, m.output] : []))).toEqual([
      [true, '跑了 a'],
      [false, '已拒绝：exec'],
      [true, '跑了 c'],
    ])

    // 结果条目同样是三条（拒绝也落账——记录里看得到「问过、被拒了」）
    expect(stage.records.entries.filter((e) => e.kind === 'tool-result')).toHaveLength(3)
  })
})

describe('主循环 · 中断', () => {
  test('在途打断（模型流）：流停止 · 本轮以「中止」收束 · 半截正文不落账', async () => {
    const stage = makeStage({
      turns: [{ text: ['一', '二', '三', '四'] }],
      stepDelayMs: 2, // 给消费方留出打断的窗口
    })
    const controller = new AbortController()

    const running = run(makeLoopRuntime(stage), '说点长的', controller.signal)

    // 扮外壳：见到第一条正文增量就按 Ctrl+C
    await waitFor(
      () => (stage.sink.byKind('model.delta').length >= 1 ? true : undefined),
      '第一条正文增量',
    )
    controller.abort()

    expect(await running).toBe('aborted')

    // 流停止——四段只出来了一部分（不是跑完才停）
    expect(stage.sink.byKind('model.delta').length).toBeLessThan(4)

    // 本轮以「中止」收束
    expect(stage.sink.byKind('turn.end').map((e) => e.data.reason)).toEqual(['aborted'])

    // 半截流式消息**丢弃**（技术方案 · 恢复：未完成流式消息丢弃、记中止）
    expect(stage.records.entries.map((e) => e.kind)).toEqual(['user'])
    expect(stage.sink.byKind('message.assistant')).toHaveLength(0)
  })

  test('在途打断（执行中命令）：工具侧收 `signal` · 本轮以「中止」收束 · 结果照落账', async () => {
    const stage = makeStage({
      turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'sleep 100' } }] }],
      handlers: {
        // 长命令：一直等着被中止（真沙箱的 `signal` 语义——取消即返回，不抛）
        exec: (_call, opts) =>
          new Promise((resolve) => {
            const finish = (): void => resolve({ ok: false, output: '已中止' })
            if (opts.signal?.aborted === true) finish()
            else opts.signal?.addEventListener('abort', finish, { once: true })
          }),
      },
    })
    const controller = new AbortController()

    const running = run(makeLoopRuntime(stage), '跑个长命令', controller.signal)

    await waitFor(
      () => (stage.sink.byKind('tool.call').length >= 1 ? true : undefined),
      '工具跑起来',
    )
    controller.abort()

    expect(await running).toBe('aborted')
    expect(stage.sink.byKind('turn.end').map((e) => e.data.reason)).toEqual(['aborted'])

    // 中止的调用**照落账**（工具—结果成对）——记录不缺口；
    // 「有调用无结果」的在途标记留给「进程被杀」那一路（阶段 2 恢复的判据）
    expect(stage.records.entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
    ])

    // 被中止的那一轮不再开下一轮（回到等待输入）
    expect(stage.gateway.requests).toHaveLength(1)
  })

  test('开跑前已中止——不发任何模型调用（不白起一轮）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const controller = new AbortController()
    controller.abort()

    expect(await run(makeLoopRuntime(stage), '你好', controller.signal)).toBe('aborted')

    expect(stage.gateway.requests).toHaveLength(0)
    expect(kindsOf(stage)).toEqual(['message.user'])
  })
})

describe('主循环 · 收场与兜底', () => {
  test('模型终态错误——本轮以「错误」收束，半截正文不落账（退避重发归阶段 2）', async () => {
    const stage = makeStage({
      turns: [{ text: '半截正文', error: { tier: 'terminal', message: '内容策略' } }],
    })

    expect(await run(makeLoopRuntime(stage), '你好')).toBe('error')

    expect(kindsOf(stage)).toEqual([
      'message.user',
      'turn.start',
      'model.call.start',
      'model.delta',
      'model.error', // 模型域铸（出错即终结，其后无 call.end）
      'turn.end',
    ])
    expect(stage.sink.byKind('turn.end').map((e) => e.data.reason)).toEqual(['error'])
    expect(stage.records.entries.map((e) => e.kind)).toEqual(['user'])
  })

  test('工具抛异常——以失败回填，不炸掉整轮（端口承诺「结果，不是异常」）', async () => {
    const stage = makeStage({
      turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'x' } }] }, { text: '知道了' }],
      handlers: {
        exec: () => {
          throw new Error('桩炸了')
        },
      },
    })

    expect(await run(makeLoopRuntime(stage), '跑一下')).toBe('settled')

    expect(stage.gateway.requests[1]?.messages.at(-1)).toMatchObject({ role: 'tool', ok: false })
    const last = stage.gateway.requests[1]?.messages.at(-1)
    expect(last?.role === 'tool' ? last.output : '').toContain('桩炸了')

    // 异常照落账（也是 `tool-result` 条目——模型下一轮看得到「这次没成」）
    expect(stage.records.entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool-call',
      'tool-result',
      'assistant',
    ])
  })
})

describe('主循环 · 大负载落 blob', () => {
  test('超阈值正文转 blob（条目存引用）——装配时解析回文本', async () => {
    // 阈值 4：用户那句（4 字）内联、助手那句（5 字）超限转 blob——两边都验到
    const stage = makeStage({ turns: [{ text: '很长的正文' }, { text: '收到' }] })
    const runtime = makeLoopRuntime(stage, { blobThreshold: 4 })

    expect(await run(runtime, '说点长的')).toBe('settled')

    // 写侧：超阈值即转 blob——条目里只有引用（规则 ②：大负载落 blob）
    // ⚠️ 别用 `expect.any(...)` 断活对象：bun 的 `toMatchObject` 会把断言结果**回写**进
    // received（此处曾把 blob 引用写成 `"[object ExpectAny]"`，下一轮装配当场取不到 blob）
    expect(stage.records.entries[0]?.content).toEqual({ text: '说点长的' })
    expect(stage.records.entries[1]?.kind).toBe('assistant')
    expect('blob' in (stage.records.entries[1]?.content ?? {})).toBe(true)

    // 全文在 blob 里等着被取回（条目只存引用，正文不重复落库）
    expect(stage.records.blobRefs).toHaveLength(1)
    const [ref] = stage.records.blobRefs
    if (ref === undefined) throw new Error('助手正文没落 blob')
    expect(new TextDecoder().decode(await stage.records.blobs.get(ref))).toBe('很长的正文')

    // 读侧：下一次调用把引用解析回文本（上下文里看得见原文）
    expect(await run(runtime, '接着说')).toBe('settled')
    expect(stage.gateway.requests[1]?.messages[1]).toEqual({ role: 'user', content: '说点长的' })
    expect(stage.gateway.requests[1]?.messages[2]).toEqual({
      role: 'assistant',
      content: '很长的正文',
    })
  })
})
