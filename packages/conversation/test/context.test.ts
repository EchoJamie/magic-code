/**
 * Context 装配 —— **由会话条目重建模型消息**（U04 判据 · 上下文装配）。
 *
 * 装配四步，判据逐条钉在此处：
 * ① 系统提示词即 `role:'system'` 的**首条**消息；
 * ② **定边界**——压过的会话：旧段由一条 `summary` 顶掉、近段与新增照旧（阶段 3 · U19，
 *    见下文「摘要 ＋ 近段原文」那一组）；
 * ③ 余下条目按序展开——助手消息带 `toolCalls`，工具结果即 `role:'tool'`
 *    （`callId` / `name` / `ok` / `output`）；
 * ④ 条目里的 blob 引用在装配时**解析为文本**（按策略截断）。
 *
 * **工具结果的正文取哪一份**（第 2 轮 · 契约补锚后）——工具条目两个字段载两样东西：
 * **正文**（`content`）＝**面向模型的文本**（工具域 `ToolResult.output`，按上限截断）；
 * **载荷**（`payload.output`）＝**记录侧形态**（`ToolResult.content`，内联或 blob，与该次
 * `tool.result` 事件的 `output` 同物）。装配送模型的是**正文**——重放时逐字复原模型当时
 * 看到的那一份；载荷留给审计与阶段 2 恢复的处置。
 *
 * 测的是**域内件**（相对路径取 `../src/context.ts`）——装配面不上公开面
 * （技术方案 · 代码治理 · 公开面：域包只出端口实现 ＋ 装配期构造入参形态）。
 */

import { describe, expect, test } from 'bun:test'
import type { Content, ModelMessage, UserMessageContent } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import type { FauxRecords } from '@magic/faux'
import { assembleContext } from '../src/context.ts'

/** 会话 id——条目按会话读（本单元装配时必带）。 */
const SESSION = 's1'

/** 装配产物里的系统提示词——内容归提示词部件，此处只验「在首条」且**原样**。 */
const SYSTEM_PROMPT = '## 身份\n你是 Magic Code。\n\n## 环境\n- 工作目录：/w'

/** 条目时间戳——记录域不取时钟，`at` 一律由调用方给。 */
const AT = 1_700_000_000_000

/** 取消息的正文（工具消息取 `output`）——断言用的窄化助手。 */
function textOfMessage(message: ModelMessage): string {
  return message.role === 'tool' ? message.output : textOfContent(message.content)
}

/** 一条模型消息的正文（U37 起可能是**部件串**——带图那条）——只取文字那几件。 */
function textOfContent(content: UserMessageContent): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => (part.type === 'text' ? part.text : '〔图片〕')).join('')
}


/** 造一束记录域桩——装配只经 `RecordsService` 读（不认知记录域内部）。 */
function recordsWith(): FauxRecords {
  const records = makeFauxRecords()
  records.appendEntry({ kind: 'user', content: { text: '看下目录' }, at: AT })
  return records
}

/**
 * 一条工具结果条目——**两样输出各归其位**（第 2 轮 · 契约补锚）：
 * 正文 ＝ 面向模型的文本（`ToolResult.output`）· 载荷 ＝ 记录侧形态（`ToolResult.content`）。
 * 缺省两处同源（小输出：记什么、给模型看什么，是一回事）。
 */
function appendToolResult(
  records: FauxRecords,
  input: { readonly ok: boolean; readonly text: string; readonly record?: Content },
): number {
  return records.appendEntry({
    kind: 'tool-result',
    content: { text: input.text },
    payload: { ok: input.ok, output: input.record ?? { text: input.text } },
    at: AT,
  })
}

/** 一条工具调用条目——`{ name, args }` 载荷（重放真源）。 */
function appendToolCall(records: FauxRecords, command: string): number {
  return records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { name: 'exec', args: { cmd: command } },
    at: AT,
  })
}

/** 一条摘要条目——压缩的产物（`./compact.ts` 落的那种形态）。 */
function appendSummary(records: FauxRecords, text: string): number {
  return records.appendEntry({ kind: 'summary', content: { text }, at: AT })
}

/** 送模型的那一份拼成一段文本——断言「在不在里面」用。 */
function sentText(messages: readonly ModelMessage[]): string {
  return messages.map(textOfMessage).join('\n')
}

/** 第 `index` 条消息的正文——够不着＝空串（断言里好写，不必逐个 `?.` 加收窄）。 */
function textAt(messages: readonly ModelMessage[], index: number): string {
  const message = messages[index]
  return message === undefined ? '' : textOfMessage(message)
}

describe('Context 装配 · 骨架', () => {
  test('空会话——产物只有系统提示词一条，且是首条 `system`', async () => {
    const messages = await assembleContext({
      records: makeFauxRecords(),
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages).toEqual([{ role: 'system', content: SYSTEM_PROMPT }])
  })

  test('条目按序展开——`user` / `assistant` 各归其位，正文原样', async () => {
    const records = recordsWith()
    records.appendEntry({ kind: 'assistant', content: { text: '好，我看下' }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages).toEqual([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '看下目录' },
      { role: 'assistant', content: '好，我看下' },
    ])
  })
})

describe('Context 装配 · 工具往返', () => {
  test('助手消息带 `toolCalls`，工具结果即工具消息——配对键两处同一', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '我跑一下' }, at: AT })
    const callEntry = appendToolCall(records, 'ls')
    appendToolResult(records, { ok: true, text: 'a.txt\n' })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    const assistant = messages[1]
    const tool = messages[2]
    expect(assistant?.role).toBe('assistant')
    expect(tool?.role).toBe('tool')

    // 助手消息的 `toolCalls`——名与参数取自那次调用的条目
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: '我跑一下',
      toolCalls: [{ name: 'exec', args: { cmd: 'ls' } }],
    })

    // 工具消息四件——`callId` 与助手侧的 `ToolCall.id` 必须**同一**（回填配对）
    const pairingKey = assistant?.role === 'assistant' ? assistant.toolCalls?.[0]?.id : undefined
    expect(pairingKey).toBeDefined()
    expect(tool).toMatchObject({
      role: 'tool',
      callId: pairingKey,
      name: 'exec',
      ok: true,
      output: 'a.txt\n',
    })

    // 目视锚——配对键由 `tool-call` 条目的 id 派生（条目不载供应商侧调用 id，见文件头注）
    expect(callEntry).toBe(2)
  })

  test('失败回填——`ok:false` 与失败输出原样进工具消息（被拒 / 出错同一形状）', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: AT })
    appendToolCall(records, 'rm -rf /')
    appendToolResult(records, { ok: false, text: '用户拒绝' })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages[2]).toMatchObject({ role: 'tool', ok: false, output: '用户拒绝' })
  })

  test('多轮工具——次序即条目序（助手 / 工具交替，不重排不合并）', async () => {
    const records = makeFauxRecords()

    for (const [command, output] of [
      ['ls', 'a.txt\n'],
      ['pwd', '/w\n'],
    ] as const) {
      records.appendEntry({ kind: 'assistant', content: { text: `跑 ${command}` }, at: AT })
      appendToolCall(records, command)
      appendToolResult(records, { ok: true, text: output })
    }

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'assistant',
      'tool',
      'assistant',
      'tool',
    ])
    expect(messages.slice(1).map(textOfMessage)).toEqual(['跑 ls', 'a.txt\n', '跑 pwd', '/w\n'])
  })

  test('同轮多工具的次序＝条目序（三次调用按序配对，不串位）', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: AT })

    for (const [index, command] of ['a', 'b', 'c'].entries()) {
      appendToolCall(records, command)
      appendToolResult(records, { ok: true, text: `出了 ${index}` })
    }

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    const assistant = messages[1]
    const calls = assistant?.role === 'assistant' ? (assistant.toolCalls ?? []) : []
    expect(calls.map((call) => call.args['cmd'])).toEqual(['a', 'b', 'c'])

    // 配对键**两两不同**——同轮多调用共用一个键，供应商侧就分不清哪条回填配哪次调用
    const keys = calls.map((call) => call.id)
    expect(new Set(keys).size).toBe(3)
    expect(messages.slice(2).map((m) => (m.role === 'tool' ? m.callId : ''))).toEqual(keys)
    expect(messages.slice(2).map(textOfMessage)).toEqual(['出了 0', '出了 1', '出了 2'])
  })

  test('落单的 `tool-call`（无结果）不进上下文——在途调用的处置归阶段 2 恢复', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '我跑一下' }, at: AT })
    appendToolCall(records, 'ls')
    // 无 tool-result——进程被杀 / 中止留下的在途调用

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    // 带 toolCalls 而无对应 tool 消息的助手消息会被供应商拒——故落单调用不进上下文
    expect(messages[1]).toEqual({ role: 'assistant', content: '我跑一下' })
    expect(messages).toHaveLength(2)
  })
})

/**
 * 压缩后（阶段 3 · U19）——**规格**：技术方案 · 上下文压缩
 * 「上下文＝**摘要 ＋ 近段原文**；**记录不动**——压缩只是上下文装配」。
 *
 * 这几条钉的是**送模型的那一份**怎么变（记录里一条不少是记录域的事，
 * 但「送出去的变短了」正是压缩的全部意义，故在此量它）。
 */
describe('Context 装配 · 摘要 ＋ 近段原文', () => {
  /** 规格：「旧段交模型生成摘要 → 以 `summary` 条目入库；上下文＝摘要 ＋ 近段原文」。 */
  test('摘要顶掉旧段——摘要块摆在系统提示词之后，旧段正文不再送模型', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '早先的交代' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '早先的答复' }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '近段的交代' }, at: AT })
    appendSummary(records, '此前在做 A，已定 B，待办 C，动过 /w/a.ts')

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      nearEntries: 1,
    })

    // 次序：系统提示词 → 摘要 → 近段原文
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user'])
    expect(textAt(messages, 0)).toBe(SYSTEM_PROMPT)
    expect(textAt(messages, 1)).toContain('此前在做 A')
    expect(messages[2]).toEqual({ role: 'user', content: '近段的交代' })

    // 旧段那两条**不送了**——「上下文变短」就短在这儿；它们仍在记录里（本单元不删）
    const sent = sentText(messages)
    expect(sent).not.toContain('早先的交代')
    expect(sent).not.toContain('早先的答复')
  })

  /** 规格：「近段」——摘要**前 N 条**原文照送，再往前的一律被摘要顶掉。 */
  test('近段边界＝摘要前 N 条——边界之外的不送，边界之内原样', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '第一件事' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '第一件答复' }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '第二件事' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '第二件答复' }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '第三件事' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '第三件答复' }, at: AT })
    // 摘要落在末尾——它前面两条（第三件事 / 第三件答复）即近段
    appendSummary(records, '前两件都办完了')

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      nearEntries: 2,
    })

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'user', 'assistant'])
    const sent = sentText(messages)
    expect(sent).toContain('第三件事')
    expect(sent).toContain('第三件答复')
    expect(sent).not.toContain('第二件事')
    expect(sent).not.toContain('第一件事')
  })

  /** 规格：「压缩只是上下文装配」——压完接着干，新增的条目照旧原文送达。 */
  test('摘要之后的条目照常展开——压完接着干，新内容原样进上下文', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '更早的交代' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '更早的答复' }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '近处的交代' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '近处的答复' }, at: AT })
    const summaryAt = appendSummary(records, '早先的摘要')
    // 压完接着干的两条——新增的一律在摘要**之后**
    records.appendEntry({ kind: 'user', content: { text: '压完接着问的' }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '压完接着答的' }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      nearEntries: 2,
    })

    // 次序：系统提示词 → 摘要 → 近段原文（两条）→ 新增原文（两条）
    expect(messages.slice(2)).toEqual([
      { role: 'user', content: '近处的交代' },
      { role: 'assistant', content: '近处的答复' },
      { role: 'user', content: '压完接着问的' },
      { role: 'assistant', content: '压完接着答的' },
    ])
    expect(textAt(messages, 1)).toContain('早先的摘要')
    expect(sentText(messages)).not.toContain('更早的交代')
    expect(summaryAt).toBe(5) // 目视锚：摘要落在被压的旧段之后、新增之前
  })

  /** 规格：「反复压缩——`summary` 条目可被再次摘要」（B6）。 */
  test('反复压缩——旧摘要离得远就被新摘要一并顶掉；离得近则作为摘要块留在窗口里', async () => {
    const far = makeFauxRecords()
    far.appendEntry({ kind: 'user', content: { text: '更早的交代' }, at: AT })
    appendSummary(far, '第一份摘要')
    far.appendEntry({ kind: 'user', content: { text: '近处一' }, at: AT })
    far.appendEntry({ kind: 'user', content: { text: '近处二' }, at: AT })
    appendSummary(far, '第二份摘要（含第一份的意思）')

    const farMessages = await assembleContext({
      records: far,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      nearEntries: 2,
    })

    // 第二份摘要在末尾、它前面留两条——第一份摘要落在**被顶掉**的那一侧
    expect(farMessages).toHaveLength(4)
    expect(textAt(farMessages, 1)).toContain('第二份摘要')
    expect(sentText(farMessages)).not.toContain('第一份摘要')

    // 反过来：旧摘要**就在近段窗口里**（离得近，新摘要没覆盖它）——那就得原样带着，
    // 丢了就是真丢（它讲的事没有别处可查）
    const near = makeFauxRecords()
    near.appendEntry({ kind: 'user', content: { text: '更早的交代' }, at: AT })
    appendSummary(near, '第一份摘要')
    near.appendEntry({ kind: 'user', content: { text: '近处' }, at: AT })
    appendSummary(near, '第二份摘要')

    const nearMessages = await assembleContext({
      records: near,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      nearEntries: 2,
    })

    const sent = sentText(nearMessages)
    expect(sent).toContain('第二份摘要')
    expect(sent).toContain('第一份摘要')
  })

  /** 规格：「数据落点 / 大负载落 blob」（记录 schema v0 · 规则 ②）——摘要条目同样适用。 */
  test('摘要正文是 blob 引用——装配时照样解析回文本', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('很长的摘要正文')
    records.appendEntry({ kind: 'summary', content: { blob: ref }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '接着问' }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(textAt(messages, 1)).toContain('很长的摘要正文')
  })
})

describe('Context 装配 · blob 引用', () => {
  test('条目正文是 blob 引用——装配时解析为文本', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('很长很长的正文')
    records.appendEntry({ kind: 'assistant', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages[1]).toEqual({ role: 'assistant', content: '很长很长的正文' })
  })

  test('工具结果：送模型的是**条目正文**（面向模型的截断文本），不是载荷里的记录形态', async () => {
    const records = makeFauxRecords()
    // 记录形态是大输出（blob 全量）；面向模型的那份由工具域截好（两处**刻意不同**，
    // 好让断言能分辨装配取的是哪一份）
    const ref = await records.blobs.put('全量输出（记录形态，可能很大）')
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: AT })
    appendToolCall(records, 'ls -R')
    appendToolResult(records, { ok: true, text: '截断后的输出', record: { blob: ref } })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages[2]).toMatchObject({ role: 'tool', ok: true, output: '截断后的输出' })
    // 顺带钉住「载荷里的记录形态不参与上下文」——取错源会拿到全量那句
    expect(textOfMessage(messages[2] as ModelMessage)).not.toContain('全量输出')
  })

  test('blob 文本按策略截断——取前 N 字符，并留可读的截断标记（原文长度在内）', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('一二三四五六七八九十')
    records.appendEntry({ kind: 'user', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      blobTextLimit: 4,
    })

    const user = textOfMessage(messages[1] as ModelMessage)
    expect(user.startsWith('一二三四')).toBe(true)
    expect(user).toContain('截断')
    expect(user).toContain('10') // 原文长度——截断与否看得见
  })

  test('不超限的 blob 文本原样——不无谓改写字面', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('短')
    records.appendEntry({ kind: 'user', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      blobTextLimit: 4,
    })

    expect(textOfMessage(messages[1] as ModelMessage)).toBe('短')
  })

  /**
   * **那条 `blobTextLimit` 只管 blob 的节选**（U34 返修 · 独立验收退回的那条反例）。
   *
   * 两个方向都钉：
   * - **内联正文原样**——它就是「面向模型的文本」，那条 limit 的由头是 blob 取回
   *   （记录只存引用、正文归装配取回，取回的那一份可能极长）。把内联也套上它，
   *   等于**凭空给所有条目加一道暗限**：实测 2225 字符的用户交代只剩 2030，
   *   尾巴上的要求当场丢掉，而使用者一个字都看不见；
   * - **blob 照旧节选**——修法不许在这一头过头（上面那两条用例接着管这一头）。
   */
  test('内联正文**不受** blobTextLimit 约束——整份送达，一个字不截', async () => {
    const records = makeFauxRecords()
    const long = `${'a'.repeat(2200)}TAIL_REQUIREMENT_PRESERVE`
    records.appendEntry({ kind: 'user', content: { text: long }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
      blobTextLimit: 4,
    })

    const user = textOfMessage(messages[1] as ModelMessage)
    expect(user).toBe(long)
    expect(user).toContain('TAIL_REQUIREMENT_PRESERVE')
    expect(user).not.toContain('截断')
  })
})
