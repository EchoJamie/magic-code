/** U113：辅助调用固定 Cantrip，关闭思考且与主选择隔离。 */

import { describe, expect, test } from 'bun:test'
import type { PageFetch, WebSource } from '@magic/contracts'
import type { ShellHandle } from '../src/index.ts'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureRequest, FixtureTurn } from './ui/fixture.ts'

/** 会话那一条连接上的模型。 */
const SESSION_MODEL = 'deepseek-flash'
/** 「取网页用的模型」——**另一条**（判据 ④ 要的就是「它跟会话那个是两个」）。 */
const DISTILL_MODEL = 'deepseek-distill-small'

/** 那一页的 markdown（取回面替身直接给 md，绕开 HTML 转换那一跳）。 */
const PAGE = '# 定价\n\n标准版每月 12 元。\n\n内部备注：这一段只在原文里。'

/** 提炼那一跳回的答案。 */
const ANSWER = '标准版每月 12 元。'

/** 替身的取回面——记下被叫了几次、取的哪个地址。 */
function fakeWeb(body = PAGE): WebSource & { readonly asked: string[] } {
  const asked: string[] = []

  return {
    asked,
    fetchPage: (url: string): Promise<PageFetch> => {
      asked.push(url)
      return Promise.resolve({
        ok: true,
        url,
        status: 200,
        bytes: Buffer.byteLength(body),
        body,
        contentType: 'text/markdown',
      })
    },
  }
}

/**
 * 一块接在受控端点上的沙地。
 *
 * `distillVendor` 给了 ⇒ **另起一条连接**给 `webFetch` 用（判据 ②/④ 要的是「提炼走它自己
 * 那一条」）；不给 ⇒ 提炼与会话**共用一条**（判据 ① 要的是「同一家人、只差这一位」）。
 */
function stageOn(
  fixture: Fixture,
  options: {
    /** 会话那条连接的适配（不给 ＝兼容接入）。 */
    readonly vendor?: string
    /** 提炼那条连接的适配（给了就另起一条连接）。 */
    readonly distillVendor?: string
  } = {},
) {
  const providers: Record<string, Record<string, unknown>> = {
    local: { vendor: options.vendor ?? 'deepseek', baseURL: fixture.baseURL, apiKey: FAKE_API_KEY },
  }
  if (options.distillVendor !== undefined) {
    providers['distill'] = {
      vendor: options.distillVendor,
      baseURL: fixture.baseURL,
      apiKey: FAKE_API_KEY,
    }
  }

  return makeStage({
    config: {
      modelAliases: {default: {provider: "local", model: SESSION_MODEL}, cantrip: {provider: options.distillVendor === undefined ? 'local' : 'distill', model: DISTILL_MODEL}, spell: {provider: "local", model: "deepseek-v4-pro"}, arcane: {provider: "local", model: SESSION_MODEL}},
      providers,

    },
  })
}

/** 一串还能用的剧本：主轮 1（要取网页）· 提炼 · 主轮 2（收束）。 */
function turnsOf(middle: readonly FixtureTurn[] = [{ kind: 'text', text: ANSWER }]): readonly FixtureTurn[] {
  return [
    { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '标准版多少钱？' } },
    ...middle,
    { kind: 'text', text: '看完了。' },
  ]
}

/** 全部**对话**请求（`/chat/completions`）——接了 `vendor` 的连接会先来一发目录刷新，不是对话。 */
function chatsOf(fixture: Fixture): readonly FixtureRequest[] {
  return fixture.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/**
 * **提炼那一跳**——按**去往哪个模型**认（不是按「第几次」）。
 *
 * 不按序认的理由：本单要判的正是「它用的是它自己那一条模型」，序认不出来这件事。
 */
function distillOf(fixture: Fixture): FixtureRequest | undefined {
  return chatsOf(fixture).find((request) => request.body['model'] === DISTILL_MODEL)
}

/**
 * 走完一趟「要取网页 → 批卡 → 提炼 → 收束」，**等这一轮真回到等待输入**才交回。
 *
 * ⚠️ **按第 n 次等**（不是「有过就算」）：上一趟那张早已答过的卡 / 上一条 `turn.end`
 * 都还留在事件流里——照「有过」等，第二趟会拿着**上一趟**的 id 去答，这一轮当场挂住。
 * 回到等待输入同理：不等它，下一趟提交时上一轮还在跑（走的是排队那条路，不是同一件事）。
 */
async function runOneFetch(handle: ShellHandle, round: number, text: string): Promise<void> {
  handle.send({ type: 'input.submit', text })
  await waitFor(
    handle,
    `第 ${round} 张卡挂上`,
    () => eventsOfKind(handle.events, 'tool.decision.request').length >= round,
  )
  answer(handle, eventsOfKind(handle.events, 'tool.decision.request')[round - 1]?.id as number, 'approve')
  await waitFor(
    handle,
    `第 ${round} 次回到等待输入`,
    () =>
      eventsOfKind(handle.events, 'agent.state').filter((event) => event.data.state === 'waiting')
        .length >= round,
  )
}

describe('U99 · 提炼那一次调用带上了「关思考」', () => {
  test('① DeepSeek：提炼那次带 `thinking.type = disabled`；循环那几次一个字都没有', async () => {
    const fixture = startFixture({ model: SESSION_MODEL, turns: turnsOf() })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: Assembly | undefined

    try {
      // ⚠️ **`modelGateway: undefined` 是刻意的**：不给替身 ⇒ 走**真模型域**那条路
      //    （真适配按 `vendor` 取、真取件层拼请求体）——换掉这一步，验的就只是
      //    「我们记得传了没有」，不是「真发出去了什么」。
      assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const handle = attachShell(assembly.shell)
      await runOneFetch(handle, 1, '查一下它的定价')

      const distill = distillOf(fixture)
      expect(distill).toBeDefined()
      const loop = chatsOf(fixture).filter((request) => request.body['model'] === SESSION_MODEL)
      expect(loop.length).toBeGreaterThan(0)

      // ① **要害**：官方文档的关闭形态（`vendors.ts` 的 DeepSeek 适配翻出来的）
      expect(distill?.body['thinking']).toEqual({ type: 'disabled' })

      // 护栏 1 没被动过：提炼那一跳**连 `tools` 这个键都没有**
      expect(distill === undefined ? undefined : 'tools' in distill.body).toBe(false)

      // 反面：循环那几次**没有**这一位（会话没设档 ⇒ 模型默认，一位不发）
      for (const one of loop) {
        expect('thinking' in one.body).toBe(false)
        expect('reasoning_effort' in one.body).toBe(false)
      }
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  }, 30_000)

  test('④ 反面·提炼用的是**它自己那一条模型**——会话中途换过模型也不跟过去', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [
        // 第一趟：主轮 → 提炼 → 主轮
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '多少钱？' } },
        { kind: 'text', text: ANSWER },
        { kind: 'text', text: '看完了。' },
        // 第二趟：换过模型之后再来一次
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '支持退款吗？' } },
        { kind: 'text', text: ANSWER },
        { kind: 'text', text: '好。' },
      ],
    })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: Assembly | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const handle = attachShell(assembly.shell)

      await runOneFetch(handle, 1, '查一下它的定价')
      // 中途换模型（换的是接缝下游，对话域不知道发生过切换）
      expect(assembly.switchModel({ alias: 'spell' }).ok).toBe(true)
      await runOneFetch(handle, 2, '再查一次')

      const chats = chatsOf(fixture)
      // 会话那几次**真跟过去了**（反证：这一换是生效的，不是本用例自己没换动）
      const sessionModels = chats.filter((one) => one.body['model'] !== DISTILL_MODEL)
      expect(sessionModels.some((one) => one.body['model'] === 'deepseek-v4-pro')).toBe(true)

      // **提炼仍用它自己那一条**：两次提炼送的都是配置里那个名字，一次都没漂
      const distilled = chats.filter((one) => one.body['model'] === DISTILL_MODEL)
      expect(distilled).toHaveLength(2)
      const sessionSet = new Set(sessionModels.map((one) => one.body['model']))
      expect(sessionSet.has(DISTILL_MODEL)).toBe(false)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  }, 30_000)

  test('② 反面·MiniMax：未支持关闭思考 ⇒ 明确报失败、不发提炼请求', async () => {
    const fixture = startFixture({ model: SESSION_MODEL, turns: turnsOf() })
    // 会话走 DeepSeek、**提炼走它自己那一条（MiniMax）**——顺手把「走的是哪条连接」也钉住
    const stage = stageOn(fixture, { vendor: 'deepseek', distillVendor: 'minimax' })
    let assembly: Assembly | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const handle = attachShell(assembly.shell)
      await runOneFetch(handle, 1, '查一下它的定价')

      expect(distillOf(fixture)).toBeUndefined()
      const results = JSON.stringify(eventsOfKind(handle.events, 'tool.result').map(event => event.data.output))
      expect(results).toContain('思考能力未知，只能使用模型默认')
      expect(results).toContain('提炼没成')
      expect(chatsOf(fixture).every(one => one.body['model'] === SESSION_MODEL)).toBe(true)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  }, 30_000)

  test('⑤ 反面·关思考那一跳被拒 ⇒ 提炼报「没成」、这一轮照常收束（失败不降级）', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      // 第二跳就是提炼那一次：对面**不认关思考这个参数**（400）
      turns: turnsOf([{ kind: 'http', status: 400, message: "Unsupported parameter: 'thinking'" }]),
    })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: Assembly | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined, webSource: fakeWeb() })
      const handle = attachShell(assembly.shell)
      await runOneFetch(handle, 1, '查一下它的定价')

      // **提炼没成 ≠ 整轮死掉**：这一轮照常收束（不是被提炼的错收的尾）
      const endings = eventsOfKind(handle.events, 'turn.end').map((event) => event.data.reason)
      expect(endings.length).toBeGreaterThan(0)
      expect(endings.every((reason) => reason === 'settled')).toBe(true)
      expect(eventsOfKind(handle.events, 'error')).toEqual([])

      // 那句话如实交回模型（工具回执，不是内核异常）
      const results = JSON.stringify(
        eventsOfKind(handle.events, 'tool.result').map((event) => event.data.output),
      )
      expect(results).toContain('提炼没成')

      // 照常接着干活：提炼那次之后主模型还有一轮
      expect(chatsOf(fixture).some((one) => one.body['model'] === SESSION_MODEL)).toBe(true)
      expect(chatsOf(fixture).length).toBeGreaterThan(2)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  }, 30_000)
})

// ══ 助手 ══════════════════════════════════════════════════════════════

/** 装配件（本文件只拿它的 `close()` 与 `switchModel()`）。 */
type Assembly = ReturnType<ReturnType<typeof makeStage>['assemble']>

/** 等一个条件在事件流上成立。 */
async function waitFor(
  handle: ShellHandle,
  what: string,
  ok: (events: readonly { readonly kind: string }[]) => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const until = Bun.nanoseconds() + timeoutMs * 1e6
  for (;;) {
    if (ok(handle.events as readonly { readonly kind: string }[])) return
    if (Bun.nanoseconds() > until) throw new Error(`等「${what}」超时`)
    await Bun.sleep(10)
  }
}

/** 答一次裁决（`id` 是那一条询问事件）。 */
function answer(handle: ShellHandle, id: number, decision: 'approve' | 'reject'): void {
  handle.send({ type: 'decision.answer', id: id as never, decision })
}
