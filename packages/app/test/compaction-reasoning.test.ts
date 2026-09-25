/**
 * U97 · **压缩那一次调用：走统一契约、显式不要思考**。
 *
 * ## 本单的要害（工单原话）
 *
 * 「`summarize` 只传 `{ model, messages }`，**绕过了思考设置那一套契约**——对 DeepSeek
 * 就落到它的官方默认（**开 ＋ high**）」，修法是**给 `{ mode: 'off' }`**：
 *
 * | `reasoningOf` 返回 | 本单怎么处置 |
 * | --- | --- |
 * | `{ params }`（DeepSeek） | 照发 ⇒ `thinking.type = 'disabled'` |
 * | `undefined`（这家没有对应参数） | 什么都不发，照旧 |
 * | `{ gap }`（MiniMax：思考内嵌在正文里，官方没给开关） | 照**既有形制**办——不静默、也不硬塞一个它不认的参数 |
 *
 * ⚠️ **不许在压缩这一处判供应商**：给一套设置，各家适配自己翻（`vendors.ts` 的
 * `reasoningOf`）——故这里咬的是**真出站请求体**，不是「我们记得传了没有」。
 *
 * ## 走的是整条真路
 *
 * 真装配（真配置 · 真记录库 · 真对话域 · 真模型域 · 真适配）→ 真
 * `@ai-sdk/openai-compatible` → **环回 HTTP 端点**（`startFixture`，真 `Bun.serve`）：
 * 整条链上**只有端点地址是假的**（环回 ＋ 合成假 key，一个付费请求都不发）。
 * 判据读的是夹具留下的**请求体原文**（`FixtureRequest.body`）——那正是「真发出去的是什么」。
 *
 * ## 五条判据（正反两面）
 *
 * | 用例 | 咬什么 |
 * | --- | --- |
 * | ① | 压缩那一次带着 `thinking.type = disabled`；**循环那几次一个字都没有**（会话没设档 ⇒ 模型默认） |
 * | ② | 反面 · MiniMax / 兼容接入 ⇒ **一位都不发**（`{ gap }` 那条既有形制），压缩照常成 |
 * | ③ | 反面 · **循环那条路一个字没动**：会话里设的档位照旧生效，而压缩那次仍不思考 |
 * | ④ | 反面 · 压缩用的是**当前那个模型**：中途换过模型时，它跟的是**换过之后**那个（与循环那几次同一个名字） |
 * | ⑤ | 反面 · **关思考失败不把压缩整死**：那一跳报错 ⇒ 本轮不压缩、照常收束（失败不降级） |
 *
 * ⚠️ **改前这条是红的**：压缩那一次的请求体里**一个思考参数都没有**（DeepSeek 落到它
 * 自己的默认：开 ＋ high）。物证（改前 / 改后两份出站请求体并排）见
 * `验证/U97-压缩不思考-20260926/`。
 */

import { describe, expect, test } from 'bun:test'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase, type Stage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureRequest, FixtureTurn } from './ui/fixture.ts'

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
  options: { readonly vendor?: string; readonly reasoning?: Record<string, unknown> } = {},
): Stage {
  return makeStage({
    config: {
      defaultProvider: 'local',
      providers: {
        local: {
          ...(options.vendor === undefined ? {} : { vendor: options.vendor }),
          baseURL: fixture.baseURL,
          apiKey: FAKE_API_KEY,
          model: MODEL,
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        },
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

describe('U97 · 压缩那一次调用带上了「关思考」', () => {
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

  test('④ 反面·中途换过模型 ⇒ 压缩用的是**当前那个**（不是开局那个）', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      // 中途换模型（换的是接缝下游，对话域不知道发生过切换——照旧把开局那个名字送出去）
      expect(assembly.switchModel({ provider: 'local', model: 'deepseek-v4-pro' }).ok).toBe(true)
      await handle.submit('第二件事')

      const chats = chatsOf(fixture)
      const compact = chats.filter(isCompaction)
      const loop = chats.filter((one) => !isCompaction(one))
      expect(compact.length).toBeGreaterThan(0)

      // **当前那个**：压缩那次送的就是换过之后的模型名（与它后面那几次循环同一个）
      const current = loop.at(-1)?.body['model']
      expect(current).toBe('deepseek-v4-pro')
      for (const one of compact) expect(one.body['model']).toBe(current)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('③ 反面·循环那条路一个字没动：会话里设的档位照旧生效，压缩那次仍不思考', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    // 会话里那一档（配置里的默认思考设置 ⇒ 注册表按选中态补齐，与用户 `/model` 选的是同一条路）
    const stage = stageOn(fixture, { vendor: 'deepseek', reasoning: { mode: 'level', level: 'high' } })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
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

  test('② 反面·MiniMax：官方没有关思考的开关 ⇒ 一位都不发（`{ gap }` 那条既有形制），压缩照常成', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'minimax' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      const compact = chatsOf(fixture).filter(isCompaction)
      expect(compact.length).toBeGreaterThan(0)

      // **不硬塞一个它不认的参数**：出站体里一个思考参数都没有（`thinking` / `reasoning_effort` 皆无）
      for (const one of compact) {
        expect('thinking' in one.body).toBe(false)
        expect('reasoning_effort' in one.body).toBe(false)
      }

      // **也没静默成「不压缩」**：摘要条目照落、压缩事件照发（用它自己的默认接着干）
      expect(eventsOfKind(handle.events, 'context.compacted').length).toBeGreaterThan(0)
      const db = readDatabase(assembly.paths.database)
      const summaries = db.entries.filter((entry) => entry.kind === 'summary')
      db.close()
      expect(summaries.length).toBeGreaterThan(0)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('② 反面·兼容接入（没有适配）：同一条口径——一位都不发，压缩照常成', async () => {
    const fixture = startFixture({ model: MODEL, turns: turnsOf() })
    const stage = stageOn(fixture) // 不给 vendor ＝兼容接入
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, context: COMPACT_AT })
      const handle = attachShell(assembly.shell)

      await handle.submit('第一件事')
      await handle.submit('第二件事')

      const compact = chatsOf(fixture).filter(isCompaction)
      expect(compact.length).toBeGreaterThan(0)
      for (const one of compact) {
        expect('thinking' in one.body).toBe(false)
        expect('reasoning_effort' in one.body).toBe(false)
      }
      expect(eventsOfKind(handle.events, 'context.compacted').length).toBeGreaterThan(0)
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

      // 一次失败**够不着**连败上限（缺省 3）——不报 error，也不写坏摘要
      expect(eventsOfKind(handle.events, 'error')).toEqual([])
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
