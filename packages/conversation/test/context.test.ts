/**
 * Context 装配 —— **由会话条目重建模型消息**（U04 判据 · 上下文装配）。
 *
 * 装配三步，判据逐条钉在此处：
 * ① 系统提示词即 `role:'system'` 的**首条**消息；
 * ② 条目按序展开——助手消息带 `toolCalls`，工具结果即 `role:'tool'`
 *    （`callId` / `name` / `ok` / `output`）；
 * ③ 条目里的 blob 引用在装配时**解析为文本**（按策略截断）。
 *
 * 测的是**域内件**（相对路径取 `../src/context.ts`）——装配面不上公开面
 * （技术方案 · 代码治理 · 公开面：域包只出端口实现 ＋ 装配期构造入参形态）。
 */

import { describe, expect, test } from 'bun:test'
import type { ModelMessage } from '@magic/contracts'
import { makeFauxRecords } from '@magic/faux'
import { assembleContext } from '../src/context.ts'

/** 会话 id——条目按会话读（本单元装配时必带）。 */
const SESSION = 's1'

/** 装配产物里的系统提示词——内容归提示词部件，此处只验「在首条」且**原样**。 */
const SYSTEM_PROMPT = '## 身份\n你是 Magic Code。\n\n## 环境\n- 工作目录：/w'

/** 条目时间戳——记录域不取时钟，`at` 一律由调用方给。 */
const AT = 1_700_000_000_000

/** 取消息的正文（工具消息取 `output`）——断言用的窄化助手。 */
function textOfMessage(message: ModelMessage): string {
  return message.role === 'tool' ? message.output : message.content
}

/** 造一束记录域桩——装配只经 `RecordsService` 读（不认知记录域内部）。 */
function recordsWith(): ReturnType<typeof makeFauxRecords> {
  const records = makeFauxRecords()
  records.appendEntry({ kind: 'user', content: { text: '看下目录' }, at: AT })
  return records
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
    const callEntry = records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: AT,
    })
    records.appendEntry({
      kind: 'tool-result',
      content: { text: '' },
      payload: { ok: true, output: { text: 'a.txt\n' } },
      at: AT,
    })

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
    records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'rm -rf /' } },
      at: AT,
    })
    records.appendEntry({
      kind: 'tool-result',
      content: { text: '' },
      payload: { ok: false, output: { text: '用户拒绝' } },
      at: AT,
    })

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
      records.appendEntry({
        kind: 'tool-call',
        content: { text: '' },
        payload: { name: 'exec', args: { cmd: command } },
        at: AT,
      })
      records.appendEntry({
        kind: 'tool-result',
        content: { text: '' },
        payload: { ok: true, output: { text: output } },
        at: AT,
      })
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
      records.appendEntry({
        kind: 'tool-call',
        content: { text: '' },
        payload: { name: 'exec', args: { cmd: command } },
        at: AT,
      })
      records.appendEntry({
        kind: 'tool-result',
        content: { text: '' },
        payload: { ok: true, output: { text: `出了 ${index}` } },
        at: AT,
      })
    }

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    const assistant = messages[1]
    const calls = assistant?.role === 'assistant' ? (assistant.toolCalls ?? []) : []
    expect(calls.map((call) => call.args['cmd'])).toEqual(['a', 'b', 'c'])
    expect(messages.slice(2).map(textOfMessage)).toEqual(['出了 0', '出了 1', '出了 2'])
  })

  test('落单的 `tool-call`（无结果）不进上下文——在途调用的处置归阶段 2 恢复', async () => {
    const records = makeFauxRecords()
    records.appendEntry({ kind: 'assistant', content: { text: '我跑一下' }, at: AT })
    records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls' } },
      at: AT,
    })
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

  test('工具结果的大输出（载荷里的 blob 引用）同样解析为文本', async () => {
    const records = makeFauxRecords()
    const ref = await records.blobs.put('一屏刷不完的输出')
    records.appendEntry({ kind: 'assistant', content: { text: '' }, at: AT })
    records.appendEntry({
      kind: 'tool-call',
      content: { text: '' },
      payload: { name: 'exec', args: { cmd: 'ls -R' } },
      at: AT,
    })
    records.appendEntry({
      kind: 'tool-result',
      content: { text: '' },
      payload: { ok: true, output: { blob: ref } },
      at: AT,
    })

    const messages = await assembleContext({
      records,
      session: SESSION,
      systemPrompt: SYSTEM_PROMPT,
    })

    expect(messages[2]).toMatchObject({ role: 'tool', ok: true, output: '一屏刷不完的输出' })
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
})
