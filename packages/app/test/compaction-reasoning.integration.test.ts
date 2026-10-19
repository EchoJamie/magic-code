/** U113：辅助调用固定 Cantrip，按能力选择思考且与主选择隔离。 */

import { describe, expect, test } from 'bun:test'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase, type Stage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureRequest, FixtureTurn } from './ui/fixture.ts'
import type { ProviderConfig } from '@magic/contracts'
import { makeTestStamper } from '@magic/faux'
import { createPageDistiller } from '@magic/model'
import { bindModelChoice } from '../src/agent-models.ts'

const MODEL = 'deepseek-flash'

/** 摘要指令的头一句（`compact.ts` 的 `SUMMARY_INSTRUCTION`）——**认压缩那一次请求**靠它。 */
const SUMMARY_MARK = '你是会话压缩器'

/**
 * 这一跳是不是**压缩**——出站体里带着摘要指令的那一次。
 *
 * 不靠「第几次请求」（那会把「循环开了几轮」耦合进判据）：压缩那次与别的调用**内容不同**，
 * 就按内容认。系统消息留在 `messages` 里（实测出站体：`messages[0].role === 'system'`）。
 */
function isCompaction(request: FixtureRequest): boolean {
  const messages = request.body['messages']
  if (!Array.isArray(messages)) return false
  return JSON.stringify(messages).includes(SUMMARY_MARK)
}

/** 夹具收到的**对话**那几跳（`GET /models` 那一发不是对话，见夹具那条注）。 */
function chatsOf(fixture: Fixture): readonly FixtureRequest[] {
  return fixture.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/**
 * 一块**接在受控端点上的**沙地——配置里那一条连接指环回夹具。
 *
 * 压缩阈值压到脚本体量（**实现级常量 · 装配期入参**，不是用户配置）：
 * 每个用例两三条交代就要真看见一次压缩，不能真等到 12 万 token。
 */
function stageOn(
  fixture: Fixture,
  options: { readonly vendor?: string; readonly model?: string } = {},
): Stage {
  const model = options.model ?? MODEL
  return makeStage({
    config: {
      models: {default: {provider: "local", model}, cantrip: {provider: "local", model}, spell: {provider: "local", model: options.vendor === 'minimax' ? model : 'deepseek-v4-pro'}, arcane: {provider: "local", model}},
      providers: {
        local: { vendor: options.vendor ?? 'deepseek', protocol: 'chat-completions', baseURL: fixture.baseURL, apiKey: FAKE_API_KEY },
      },
    },
  })
}

/** 压缩的触发阈值——压到 0（窗长已声明时走占比，故两个数都要压，见探针那条注）。 */
const COMPACT_AT = { compactAtTokens: 1, compactAtFraction: 0, nearEntries: 1 } as const

/** 一串还能用的剧本：第一轮 · 摘要 · 第二轮。 */
function turnsOf(extra: readonly FixtureTurn[] = []): readonly FixtureTurn[] {
  return [
    { kind: 'text', text: '答复一', chunks: 1, chunkDelayMs: 0 },
    { kind: 'text', text: '摘要：前一件事办完了', chunks: 1, chunkDelayMs: 0 },
    { kind: 'text', text: '答复二', chunks: 1, chunkDelayMs: 0 },
    ...extra,
  ]
}

describe('压缩那一次调用带上了「关思考」', () => {
  test('① DeepSeek：压缩那次带 `thinking.type = disabled`；循环那几次一个字都没有', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      // ⚠️ **`modelGateway: undefined` 是刻意的**：不给替身 ⇒ 走**真注册表**那条路
      //    （真适配按 `vendor` 取、真取件层拼请求体）——换掉这一步，验的就只是
      //    「我们记得传了没有」，不是「真发出去了什么」。
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      const chats = chatsOf(fixture)
      const compact = chats.filter(isCompaction)
      const loop = chats.filter((one) => !isCompaction(one))

      // 压缩真发生过（没发生的话下面几条会「因为没得可查」而假绿）
      expect(compact.length).toBeGreaterThan(0)
      expect(eventsOfKind(handle.events, 'context.compacted').length).toBeGreaterThan(0)

      // ① **要害**：官方文档的关闭形态
      for (const one of compact) expect(one.body['thinking']).toEqual({ type: 'disabled' })

      // 反面：循环那几次**没有**这一位，也没有档位那一位（会话没设档 ⇒ 模型默认，一位不发）
      expect(loop.length).toBeGreaterThan(0)
      for (const one of loop) {
        expect('thinking' in one.body).toBe(false)
        expect('reasoning_effort' in one.body).toBe(false)
      }

      // ④ 压缩用的是**当前那个模型**（与循环那几次同一个名字）
      expect(new Set(compact.map((one) => one.body['model']))).toEqual(
        new Set(loop.map((one) => one.body['model'])),
      )
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('④ 反面·中途切换主模型 ⇒ 压缩仍用 Cantrip', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      // 中途换模型（换的是接缝下游，对话域不知道发生过切换——照旧把开局那个名字送出去）
      expect(assembly.switchModel({ choice: 'spell' }).ok).toBe(true)
      await handle.submit('第二件事')

      const chats = chatsOf(fixture)
      const compact = chats.filter(isCompaction)
      const loop = chats.filter((one) => !isCompaction(one))
      expect(compact.length).toBeGreaterThan(0)

      // 主循环切换生效，压缩仍保持 Cantrip 的型号。
      const current = loop.at(-1)?.body['model']
      expect(current).toBe('deepseek-v4-pro')
      for (const one of compact) expect(one.body['model']).toBe(MODEL)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('③ 反面·循环那条路一个字没动：会话里设的档位照旧生效，压缩那次仍不思考', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    // 会话里那一档（配置里的默认思考设置 ⇒ 注册表按选中态补齐，与用户 `/model` 选的是同一条路）
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      expect(assembly.switchModel({ reasoning: { mode: 'level', level: 'high' } }).ok).toBe(true)
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      const chats = chatsOf(fixture)
      const compact = chats.filter(isCompaction)
      const loop = chats.filter((one) => !isCompaction(one))

      // ③ 循环照旧：用户设的那一档**原样发出去**（`reasoning_effort = high`）
      expect(loop.length).toBeGreaterThan(0)
      for (const one of loop) expect(one.body['reasoning_effort']).toBe('high')

      // ⚠️ **「不看会话里那个设置」**：压缩那一跳说的是它自己的那一套（明确关闭），
      // 注册表**不覆盖调用方明说的那一份**（改前实测：这里跟着会话档走，仍是 high）
      expect(compact.length).toBeGreaterThan(0)
      for (const one of compact) {
        expect(one.body['thinking']).toEqual({ type: 'disabled' })
        expect('reasoning_effort' in one.body).toBe(false)
      }
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test.each(['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'])('② MiniMax %s 使用默认思考，同一 Cantrip 正常压缩', async model => {
    const fixture = startFixture({ model, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'minimax', model })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      const requests = chatsOf(fixture).filter(isCompaction)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body['model']).toBe(model)
      expect(requests[0]?.body['thinking']).toBeUndefined()
      expect(requests[0]?.body['reasoning_effort']).toBeUndefined()
      expect(eventsOfKind(handle.events, 'context.compacted')).toHaveLength(1)
      const db = readDatabase(assembly.paths.database)
      expect(db.entries.filter(entry => entry.kind === 'summary')).toHaveLength(1)
      expect(db.entries.filter(entry => entry.kind === 'user')).toHaveLength(2)
      db.close()
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('⑤ 反面·关思考那一跳被拒 ⇒ 本轮不压缩、照常收束（失败不降级）', async () => {
    const fixture = startFixture({
      model: MODEL,
      // 第二跳就是压缩那一次：对面**不认关思考这个参数**（400）
      turns: [
        { kind: 'text', text: '答复一', chunks: 1, chunkDelayMs: 0 },
        { kind: 'http', status: 400, message: "Unsupported parameter: 'thinking'" },
        { kind: 'text', text: '答复二', chunks: 1, chunkDelayMs: 0 },
      ],
    })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      // **压不成 ≠ 整死**：那一轮照常收束（不是被压缩的错收的尾）
      const endings = eventsOfKind(handle.events, 'turn.end').map((event) => event.data.reason)
      expect(endings.length).toBeGreaterThan(0)
      expect(endings.every((reason) => reason === 'settled')).toBe(true)

      // 具体失败即时提示一次，不写坏摘要。
      expect(eventsOfKind(handle.events, 'error').map(event => event.data.message).join('\n')).toContain("Unsupported parameter: 'thinking'")
      expect(eventsOfKind(handle.events, 'context.compacted')).toEqual([])

      const db = readDatabase(assembly.paths.database)
      const summaries = db.entries.filter((entry) => entry.kind === 'summary')
      db.close()
      expect(summaries).toEqual([])

      // 照常接着干活：压缩那次之后还有新一轮的调用
      expect(chatsOf(fixture).length).toBeGreaterThan(2)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })
})

describe('D56 · 内务绑定与提炼出站', () => {
  test.each(['minimax', 'custom'])('%s：默认思考只发一次，正文分离且保留页面代码', async kind => {
    const fixture = startFixture({ turns: [{ kind: 'text', reasoning: '内部提炼思考', text: '使用 <think>code</think>，版本 2。', chunks: 1, chunkDelayMs: 0 }] })
    try {
      const model = kind === 'minimax' ? 'MiniMax-M2.7-highspeed' : 'custom-distill'
      const config: ProviderConfig = { protocol: 'chat-completions', apiKey: FAKE_API_KEY, baseURL: fixture.baseURL,
        ...(kind === 'minimax' ? { vendor: 'minimax' } : { modelOverrides: { [model]: { reasoningSupport: { default: 'on', disable: false } } } }),
      }
      const bound = bindModelChoice({ options: { providers: { local: config }, stamper: makeTestStamper(), env: {} },
        configuredModels: { cantrip: { provider: 'local', model } }, request: { choice: 'cantrip' } })
      if ('failure' in bound) throw new Error(bound.failure)
      const outcome = await createPageDistiller({ gateway: bound.gateway }).distill({ url: 'https://example.com/doc', page: '版本 2，代码 <think>code</think>', prompt: '版本与代码是什么？' }, {})
      expect(outcome).toMatchObject({ ok: true, answer: '使用 <think>code</think>，版本 2。' })
      const requests = chatsOf(fixture)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body['model']).toBe(model)
      expect(requests[0]?.body['thinking']).toBeUndefined()
      expect(requests[0]?.body['reasoning_effort']).toBeUndefined()
      expect(requests[0]?.body['tools']).toBeUndefined()
    } finally { await fixture.stop() }
  })

  test('绑定后改连接配置，已绑定请求稳定，下一次使用新配置', async () => {
    const a = startFixture({ turns: [{ kind: 'text', text: 'A', chunks: 1, chunkDelayMs: 0 }] })
    const b = startFixture({ turns: [{ kind: 'text', text: 'B', chunks: 1, chunkDelayMs: 0 }] })
    try {
      const config = { vendor: 'minimax', protocol: 'chat-completions', apiKey: FAKE_API_KEY, baseURL: a.baseURL } satisfies ProviderConfig
      const options = { providers: { local: config }, stamper: makeTestStamper(), env: {} }
      const bind = () => bindModelChoice({ options, configuredModels: { cantrip: { provider: 'local', model: 'MiniMax-M2.7-highspeed' } }, request: { choice: 'cantrip' } })
      const first = bind()
      config.baseURL = b.baseURL
      const second = bind()
      if ('failure' in first || 'failure' in second) throw new Error('绑定失败')
      for (const bound of [first, second]) {
        const stream = bound.gateway.stream({ messages: [{ role: 'user', content: '摘要' }] }, {})
        for await (const _ of stream.events) { /* 完整消费 */ }
        expect((await stream.result).complete).toBe(true)
      }
      expect(chatsOf(a)).toHaveLength(1)
      expect(chatsOf(b)).toHaveLength(1)
      expect(first.identity).not.toBe(second.identity)
    } finally { await a.stop(); await b.stop() }
  })
})
