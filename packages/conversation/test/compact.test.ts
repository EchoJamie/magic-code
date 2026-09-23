/**
 * 上下文压缩 —— **长会话不爆**（U19 判据 · 技术方案 · 上下文压缩（阶段 3））。
 *
 * 设计条款逐条钉在此处：
 *
 * | 条款 | 用例 |
 * | --- | --- |
 * | 触发：用量达阈值 / 上下文超限错误 | 触发判据 · 阈值端到端 · 超限重发 |
 * | 机制：摘要入库 / 摘要 ＋ 近段原文 / 记录不动 | 阈值端到端（＋ `context.test.ts`） |
 * | 摘要要素：任务与状态 · 关键决定 · 未完成事项 · 触碰文件面 | 摘要指令 |
 * | 失败不降级（B5） | 摘要生成失败 · 空摘要 · 连续失败报 `error` |
 * | 反复压缩（B6） | 摘要的摘要 |
 *
 * 测的是**域内件**（相对路径取 `../src/`）——压缩器不上公开面（技术方案 · 代码治理 ·
 * 公开面：域包只出端口实现 ＋ 装配期构造入参形态）。
 *
 * **判据挑的载体**：端到端那两条走 `agentLoop` ＋ Faux 脚本，看的是「模型收到了什么」
 * （`gateway.requests`）与「记录里多了什么」——**不是**复述实现的内部状态。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry, ModelMessage } from '@magic/contracts'
import { FIXED_AT } from '@magic/faux'
import { agentLoop } from '../src/agent-loop.ts'
import { makeCompactor, makeLoopRuntime, makeStage } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

/** 每次调用一把新信号（`AbortSignal` 用过就废，别在用例之间串） */
const signal = (): AbortSignal => new AbortController().signal

/** 送模型的那一份拼成一段文本。 */
function sentText(messages: readonly ModelMessage[]): string {
  return messages.map((message) => (message.role === 'tool' ? message.output : message.content)).join('\n')
}

/** 第 `index` 次调用的请求正文——够不着＝空串（断言里好写）。 */
function sentTextAt(requests: readonly { readonly messages: readonly ModelMessage[] }[], index: number): string {
  const request = requests[index]
  return request === undefined ? '' : sentText(request.messages)
}

/** 铺一段旧账——端到端用例的「长会话」素材（近段边界之外都算旧段）。 */
function seedOldBusiness(stage: Stage, count: number): void {
  for (let index = 0; index < count; index += 1) {
    stage.records.appendEntry({ kind: 'user', content: { text: `旧账 ${index}` }, at: FIXED_AT })
  }
}

/** 摘要条目——记录里那一条（压缩的产物）。 */
function summariesOf(stage: Stage): readonly Entry[] {
  return stage.records.entries.filter((entry) => entry.kind === 'summary')
}

describe('压缩 · 触发判据', () => {
  /**
   * 规格：「触发——**用量达阈值（常量）**」（技术方案 · 上下文压缩）。
   * 阈值两个算法：窗长已声明按占比、未声明按绝对常量（B4 · 实现级常量）。
   */
  test('用量达阈值：窗长已声明按占比、未声明按绝对常量；**没读数就不触发**', () => {
    const stage = makeStage()
    const compact = makeCompactor(stage, { policy: { compactAtFraction: 0.5, compactAtTokens: 100 } })

    // 没读数——不触发（不猜上下文有多长；Faux 与未上报的端点都不给用量）
    expect(compact.needed()).toBe(false)

    // 窗长已声明：分母取它（1000 × 0.5 = 500）
    compact.observe({ inputTokens: 499, contextWindow: 1000 })
    expect(compact.needed()).toBe(false)
    compact.observe({ inputTokens: 500, contextWindow: 1000 })
    expect(compact.needed()).toBe(true)

    // 窗长未声明：落到绝对阈值（D10：`providers.<id>.contextWindow` 没声明就不给分母）
    compact.observe({ inputTokens: 100 })
    expect(compact.needed()).toBe(true)
    compact.observe({ inputTokens: 99 })
    expect(compact.needed()).toBe(false)
  })

  /** 规格：「摘要要素——任务与状态 · 关键决定 · 未完成事项 · 触碰文件面」。 */
  test('摘要指令含四要素——四件都是**从对话里读出来的**，不指任何字段名', async () => {
    const stage = makeStage({ turns: [{ text: '摘要正文' }] })
    seedOldBusiness(stage, 3)

    const compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
    const outcome = await compact.run({ trigger: 'threshold' })

    expect(outcome.ok).toBe(true)
    const instruction = stage.gateway.requests[0]?.messages[0]
    const text = instruction?.role === 'system' ? instruction.content : ''

    for (const element of ['任务与状态', '关键决定', '未完成事项', '触碰文件面']) {
      expect(text).toContain(element)
    }
  })
})

describe('压缩 · 摘要入库（阈值触发，真跑一遍循环）', () => {
  /**
   * 规格：「旧段交模型生成摘要 → 以 `summary` 条目入库；上下文＝摘要 ＋ 近段原文；
   * **记录不动**」（技术方案 · 上下文压缩 · 机制）＋ 事件 `context.compacted`。
   */
  test('用量达阈值：下一轮开跑前压一次——摘要入库 · 上下文变短 · 接着干活不断', async () => {
    const stage = makeStage({
      turns: [
        { text: '第一轮答复', usage: { inputTokens: 100, outputTokens: 5 } },
        // ↑ 这一轮的用量越过阈值 ⇒ 下一轮开跑前先压
        { text: '摘要：早先铺了六笔旧账，动过 /w' },
        { text: '第二轮答复', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
    })
    // 铺一段长会话：近段边界（4 条）之外都算旧段
    for (let index = 0; index < 6; index += 1) {
      stage.records.appendEntry({ kind: 'user', content: { text: `第 ${index} 件：${'长'.repeat(120)}` }, at: FIXED_AT })
      stage.records.appendEntry({
        kind: 'assistant',
        content: { text: `办了第 ${index} 件：${'好'.repeat(120)}` },
        at: FIXED_AT,
      })
    }

    const compact = makeCompactor(stage, { policy: { compactAtTokens: 50, nearEntries: 4 } })
    const runtime = makeLoopRuntime(stage, { compact })

    await agentLoop(runtime, { text: '第一件事' }, signal())
    await agentLoop(runtime, { text: '第二件事' }, signal())

    // ① 摘要条目入库——正文取模型给的那份
    const summaries = summariesOf(stage)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.content).toEqual({ text: '摘要：早先铺了六笔旧账，动过 /w' })

    // ② 记录 append-only 不破——旧段那些条目一条不少，摘要只是追加在末尾
    expect(stage.records.entries.map((entry) => entry.kind)).toEqual([
      ...Array.from({ length: 12 }, (_, index) => (index % 2 === 0 ? 'user' : 'assistant')),
      'user',
      'assistant', // 第一轮
      'user', // 第二件事的交代（在轮外落账，压缩之前）
      'summary',
      'assistant', // 第二轮
    ])

    // ③ 事件带引用——载荷取那条条目的 id（契约 `context.compacted` 的 `summary`）
    const compacted = stage.sink.byKind('context.compacted')
    expect(compacted).toHaveLength(1)
    expect(compacted[0]?.data.summary).toBe(summaries[0]?.id)

    // ④ 上下文变短——同一个网关的两次请求：压前那一轮 vs 压后那一轮
    const before = sentTextAt(stage.gateway.requests, 0)
    const after = sentTextAt(stage.gateway.requests, 2)
    expect(after.length).toBeLessThan(before.length)

    // ⑤ 接着干活不断——近段原文还在、旧段不在了、这一轮照常收束
    expect(after).toContain('办了第 5 件')
    expect(after).not.toContain('第 0 件')
    expect(after).toContain('第二件事')
    expect(stage.sink.byKind('turn.end').at(-1)?.data).toEqual({ reason: 'settled' })
  })

  /**
   * 规格：「事件＝过程」——压缩那次调用是**内核的内务**，不是会话里的一轮：
   * 它进了事件流，外壳就会把摘要正文当助手的答复渲染出来、用量也记到用户头上。
   */
  test('压缩那次调用不进事件流——摘要正文不出现在任何转发出去的事件里', async () => {
    const stage = makeStage({
      turns: [
        { text: '第一轮答复', usage: { inputTokens: 100, outputTokens: 5 } },
        { text: '内部摘要正文' },
        { text: '第二轮答复' },
      ],
    })
    seedOldBusiness(stage, 4)

    const compact = makeCompactor(stage, { policy: { compactAtTokens: 50, nearEntries: 1 } })
    const runtime = makeLoopRuntime(stage, { compact })

    await agentLoop(runtime, { text: '第一件事' }, signal())
    await agentLoop(runtime, { text: '第二件事' }, signal())

    // 网关被调了三次（两轮 ＋ 一次摘要），事件流里只该有两轮的痕迹
    expect(stage.gateway.requests).toHaveLength(3)
    expect(stage.sink.byKind('model.call.start')).toHaveLength(2)
    expect(stage.sink.byKind('message.assistant')).toHaveLength(2)

    const deltas = stage.sink
      .byKind('model.delta')
      .map((event) => event.data.text)
      .join('')
    expect(deltas).toContain('第一轮答复')
    expect(deltas).toContain('第二轮答复')
    expect(deltas).not.toContain('内部摘要正文')
  })

  /** 规格：「反复压缩——`summary` 条目可被再次摘要」（B6）。 */
  test('摘要的摘要——旧摘要落在待压的旧段里，照旧喂给模型', async () => {
    const stage = makeStage({ turns: [{ text: '第二份摘要正文' }] })
    stage.records.appendEntry({ kind: 'user', content: { text: '老交代' }, at: FIXED_AT })
    stage.records.appendEntry({ kind: 'summary', content: { text: '第一份摘要正文' }, at: FIXED_AT })
    stage.records.appendEntry({ kind: 'user', content: { text: '近处的交代' }, at: FIXED_AT })

    // 近段 1 条 ⇒ 旧段 ＝〔老交代 · 第一份摘要〕——旧摘要就在里面
    const compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
    const outcome = await compact.run({ trigger: 'threshold' })

    expect(outcome.ok).toBe(true)
    expect(sentTextAt(stage.gateway.requests, 0)).toContain('第一份摘要正文')
    expect(summariesOf(stage)).toHaveLength(2)
  })
})

describe('压缩 · 上下文超限（第二条触发路径）', () => {
  /**
   * 规格：「触发——**用量达阈值（常量）或上下文超限错误**」——超限这条路是
   * 「压一次再把本轮重发一遍（不换模型）」（`@magic/model` 的错误分档：`context-limit`）。
   */
  test('超限错误：压一次、本轮重发，重发那次带着摘要', async () => {
    const stage = makeStage({
      turns: [
        { text: '第一轮答复' }, // 没报用量 ⇒ 阈值那条路不触发，隔离出超限这一条
        { error: { tier: 'context-limit', message: 'context length exceeded' } },
        { text: '摘要：此前跑过一轮，动过 /w' },
        { text: '重发后的答复' },
      ],
    })
    seedOldBusiness(stage, 4)

    const compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
    const runtime = makeLoopRuntime(stage, { compact })

    await agentLoop(runtime, { text: '第一件事' }, signal())
    const outcome = await agentLoop(runtime, { text: '第二件事' }, signal())

    // 收束（不是出错）——压完重发成了
    expect(outcome).toBe('settled')
    // 四次调用：轮1 · 轮2首发（超限）· 摘要 · 轮2重发
    expect(stage.gateway.requests).toHaveLength(4)
    expect(sentTextAt(stage.gateway.requests, 3)).toContain('此前跑过一轮')
    // 重发**不另开一轮**——同一轮里重来（`turn.start` 只有两次：两个交代各一次）
    expect(stage.sink.byKind('turn.start')).toHaveLength(2)
    expect(stage.sink.byKind('turn.end').at(-1)?.data).toEqual({ reason: 'settled' })
    expect(summariesOf(stage)).toHaveLength(1)
  })
})

describe('压缩 · 失败不降级（B5）', () => {
  /**
   * 规格：「**失败不降级**——压缩失败 → **本轮不压缩、照常推进**（不删原文、不写坏摘要）」
   * （技术方案 · 上下文压缩）。
   */
  test('摘要生成失败：本轮照常推进——不删原文、不写坏摘要、不发 `context.compacted`', async () => {
    const stage = makeStage({
      turns: [
        { text: '第一轮答复', usage: { inputTokens: 100, outputTokens: 5 } },
        { error: { tier: 'terminal', message: '摘要服务挂了' } },
        { text: '第二轮答复', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
    })
    seedOldBusiness(stage, 4)

    const compact = makeCompactor(stage, { policy: { compactAtTokens: 50, nearEntries: 1 } })
    const runtime = makeLoopRuntime(stage, { compact })

    await agentLoop(runtime, { text: '第一件事' }, signal())
    const outcome = await agentLoop(runtime, { text: '第二件事' }, signal())

    // **照常推进**：这一轮以「收束」收场，答复照常落账
    expect(outcome).toBe('settled')
    expect(stage.records.entries.at(-1)).toMatchObject({
      kind: 'assistant',
      content: { text: '第二轮答复' },
    })

    // **不写坏摘要**：没有条目、没有事件
    expect(summariesOf(stage)).toHaveLength(0)
    expect(stage.sink.byKind('context.compacted')).toHaveLength(0)

    // **不删原文**：旧段一条不少、内容原样
    expect(stage.records.entries[0]).toMatchObject({ kind: 'user', content: { text: '旧账 0' } })
    expect(stage.records.entries[1]).toMatchObject({ kind: 'user', content: { text: '旧账 1' } })

    // 这一轮的上下文＝原样（压没成，就按老样子送——「原文本就在，读不完也得接着读」）
    expect(sentTextAt(stage.gateway.requests, 2)).toContain('旧账 0')
  })

  /** 规格同上：「不写坏摘要」——模型空手而归也不许落一条空条目。 */
  test('模型没给摘要正文：不落空条目（空摘要＝坏摘要）', async () => {
    const stage = makeStage({ turns: [{ text: '   ' }] })
    seedOldBusiness(stage, 3)

    const compact = makeCompactor(stage, { policy: { nearEntries: 1 } })
    const outcome = await compact.run({ trigger: 'threshold' })

    expect(outcome.ok).toBe(false)
    expect(outcome.ok === false ? outcome.reason : '').toContain('摘要')
    expect(summariesOf(stage)).toHaveLength(0)
    expect(stage.sink.byKind('context.compacted')).toHaveLength(0)
  })

  /**
   * 规格：「**连续失败 → 报 `error`**」（技术方案 · 上下文压缩）——不静默：
   * 一条会话压不动了，用户得知道它迟早会撞上超限。
   */
  test('连续失败达上限：报一条 `error`——不聊胜于无地静默', async () => {
    const stage = makeStage({
      turns: [
        { text: '答复一', usage: { inputTokens: 100, outputTokens: 5 } },
        { error: { tier: 'terminal', message: '摘要服务挂了' } }, // 第 2 轮开跑前：失败 1
        { text: '答复二', usage: { inputTokens: 100, outputTokens: 5 } },
        { error: { tier: 'terminal', message: '摘要服务挂了' } }, // 第 3 轮开跑前：失败 2 ⇒ 报
        { text: '答复三', usage: { inputTokens: 100, outputTokens: 5 } },
      ],
    })
    seedOldBusiness(stage, 4)

    const compact = makeCompactor(stage, {
      policy: { compactAtTokens: 50, nearEntries: 1, compactFailureLimit: 2 },
    })
    const runtime = makeLoopRuntime(stage, { compact })

    for (const text of ['第一件事', '第二件事', '第三件事']) {
      await agentLoop(runtime, { text }, signal())
    }

    const errors = stage.sink.byKind('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.data.message).toContain('压缩')
    expect(errors[0]?.data.message).toContain('原文一条未动')

    // 报归报，三轮**都照常收束**（不降级）
    expect(stage.sink.byKind('turn.end').map((event) => event.data.reason)).toEqual([
      'settled',
      'settled',
      'settled',
    ])
  })
})

// ══ U37 · 图片与压缩：摘要里报名字，字节不动（要用的那一刻仍取回得来）═══════

/**
 * 判据（设计 · 文件与图片）：「压缩保留附件引用及已得出的信息；**再次需要图像时可以取回**，
 * 不能把『有附件引用』写成『模型本轮已看见原图』」。
 *
 * 落到这一层是两件：
 * - **摘要那一段**报得出「这一轮带过一张图」（`@shot.png（图片）`）——否则压缩之后接着
 *   干活的模型只当用户提过一份叫这个名字的材料；
 * - **不把字节当文本渲染**（二进制进摘要只会糊一屏乱码），也**不谎称模型看过了**。
 */
describe('U37 · 压缩：图片只报名字，不说话过了', () => {
  /** 1×1 真 PNG——摘要那一段里它只该以名字出现。 */
  const PNG = new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  )

  test('旧段里那张图：摘要请求里报名字（不铺字节、不说「已看见」）', async () => {
    const stage = makeStage({
      turns: [
        { text: '第一轮答复', usage: { inputTokens: 100, outputTokens: 5 } },
        { text: '摘要：看了一张图' },
        { text: '第二轮答复', usage: { inputTokens: 20, outputTokens: 5 } },
      ],
    })

    // 旧段里那条带图的交代（字节落在记录域的 blob 里）
    const blob = await stage.records.blobs.put(PNG)
    stage.records.appendEntry({
      kind: 'user',
      content: { text: '看 @shot.png' },
      payload: {
        refs: [
          {
            kind: 'image',
            at: 2,
            marker: '@shot.png',
            source: '/ws/shot.png',
            label: 'shot.png',
            name: 'shot.png',
            mime: 'image/png',
            blob,
          },
        ],
      },
      at: FIXED_AT,
    })
    for (let index = 0; index < 3; index += 1) {
      stage.records.appendEntry({ kind: 'user', content: { text: `第 ${index} 件：${'长'.repeat(120)}` }, at: FIXED_AT })
      stage.records.appendEntry({ kind: 'assistant', content: { text: `办了 ${'好'.repeat(120)}` }, at: FIXED_AT })
    }

    const compact = makeCompactor(stage, { policy: { compactAtTokens: 50, nearEntries: 2 } })
    const runtime = makeLoopRuntime(stage, { compact })
    // 第一轮跑出用量（越过阈值）⇒ **下一轮开跑前**才压——故两趟
    await agentLoop(runtime, { text: '接着来' }, signal())
    await agentLoop(runtime, { text: '再来' }, signal())

    // 摘要那一次调用（第 2 条请求）的正文——旧段渲染成的文本
    const asked = sentTextAt(stage.gateway.requests, 1)

    expect(asked).toContain('@shot.png（图片）') // 报得出「带过一张图」
    expect(asked).not.toContain('iVBORw0KGgo') // 字节没被当文本铺进来
    expect(asked).not.toContain('已看见')
    expect(asked).not.toContain('已送达')

    // **字节还在**（压缩只动送模型的那一份，记录 append-only）——再要它时取回得来
    expect([...(await stage.records.blobs.get(blob))]).toEqual([...PNG])
  })
})
