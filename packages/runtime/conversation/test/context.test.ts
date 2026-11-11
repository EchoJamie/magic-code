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
import { readHistoryOf } from '../src/plan.ts'

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

/** 一条工具调用条目——`{ id, name, args }` 载荷（重放真源）。 */
function appendToolCall(records: FauxRecords, command: string): number {
  return records.appendEntry({
    kind: 'tool-call',
    content: { text: '' },
    payload: { id: `call_00_ET_${command}`, name: 'exec', args: { cmd: command } },
    at: AT,
  })
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
  test('缺少原始调用 ID 时明确拒绝协议重建，原始调用仍可回查', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: AT })
    // 模拟从已有记录读出的不完整载荷，不经新调用写入入口。
    const id = records.appendEntry({ kind: 'tool-call', content: { text: '' },
      payload: JSON.parse('{"name":"exec","args":{"cmd":"ls"}}'), at: AT })
    appendToolResult(records, { ok: true, text: 'a.txt' })
    await expect(assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT }))
      .rejects.toThrow(`工具调用记录 #${id} 缺少模型原始调用 ID`)
    expect((await readHistoryOf(records, SESSION, { entry: id })).entries[0]?.text).toBe('exec {"cmd":"ls"}')
  })

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
    expect(pairingKey).toBe('call_00_ET_ls')
    expect(tool).toMatchObject({
      role: 'tool',
      callId: pairingKey,
      name: 'exec',
      ok: true,
      output: 'a.txt\n',
    })

    // 记录编号独立于模型调用 ID。
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

describe('Context 装配 · 接续覆盖', () => {
  test('只移出已提交范围；摘要与辅助消息不冒充业务历史', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'user', content: { text: '旧交代' }, at: AT })
    const through = records.appendEntry({ kind: 'assistant', content: { text: '旧答复' }, at: AT })
    records.appendEntry({ kind: 'user', content: { text: '近段真实交代' }, at: AT })
    records.coverage.publish({ previousSummary: null, from: 1, through, at: AT, notesSaved: true })
    records.appendEntry({ kind: 'continuation', content: { text: '' }, payload: { preparation: 'p', message: { role: 'assistant', content: '辅助历史' } }, at: AT })
    records.appendEntry({ kind: 'assistant', content: { text: '新增真实答复' }, at: AT })
    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT })
    expect(messages).toEqual([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '近段真实交代' }, { role: 'assistant', content: '新增真实答复' }])
  })
  test('旧摘要不形成工作笔记覆盖；原业务历史仍完整可见', async () => {
    const records = makeFauxRecords()
    const through = records.appendEntry({ kind: 'user', content: { text: '仍有效的原始要求' }, at: AT })
    records.appendEntry({ kind: 'summary', content: { text: '旧压缩摘要' }, payload: { from: through, coveredThrough: through, memoryRevision: 1, previousSummary: null, sources: [] }, at: AT })
    const messages = await assembleContext({ records, session: SESSION, systemPrompt: SYSTEM_PROMPT })
    expect(messages).toEqual([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: '仍有效的原始要求' }])
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

  test('工具结果逐字复原当时交付正文，全量载荷留待真实回查', async () => {
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
    expect(textOfMessage(messages[2] as ModelMessage)).not.toContain('全量输出（记录形态，可能很大）')
  })

  /**
   * ⚠️ **U82 改判**：这一条原先是「取**前** N 字符」（`startsWith('一二三四')`）。
   * 现在 blob 那一支**头尾都留**——故断言换成「头部那半 ＋ 尾部那半都在」，
   * 判据没有放宽：省略处照样要报数（原文字数），且另加一条「怎么看全」的引导。
   * 尾部那半是这一改的**要害**（构建日志的报错在末尾），故它单独咬一句。
   */
  test('用户原文不受普通blob节选上限截断，有效要求逐字带入', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('一二三四五六七八九十')
    records.appendEntry({ kind: 'user', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    const user = textOfMessage(messages[1] as ModelMessage)
    expect(user).toBe('一二三四五六七八九十')
    expect(user).not.toContain('截断')
  })

  /**
   * **尾部是这一改的要害**（U82 · `D40`）：构建日志 / 测试报告的结论在末尾，
   * 只取头部那一版把它们整个丢掉了。故这一条拿一段「开头无信息、结尾才是答案」的
   * 构造去咬——模型必须看得到最后那几行。
   */
  test('长 blob 的**尾部结论**进得了上下文（开头是噪声、答案在末尾）', async () => {
    const records = makeFauxRecords()
    const noise = `${'编译中……\n'.repeat(40)}`
    const answer = 'error: 这里就是失败原因'
    const ref = await records.blobs.put(`${noise}${answer}`)
    records.appendEntry({ kind: 'user', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    const user = textOfMessage(messages[1] as ModelMessage)
    expect(user).toContain(answer)
    expect(user).not.toContain('省略')
  })

  test('不超限的 blob 文本原样——不无谓改写字面', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('短')
    records.appendEntry({ kind: 'user', content: { blob: ref }, at: AT })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
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
    })

    const user = textOfMessage(messages[1] as ModelMessage)
    expect(user).toBe(long)
    expect(user).toContain('TAIL_REQUIREMENT_PRESERVE')
    expect(user).not.toContain('截断')
  })
})
