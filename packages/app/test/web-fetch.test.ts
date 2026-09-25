/**
 * U72 · 取网页 —— 从一次工具调用到**真出站请求体**（整条真路，只有两跳出网是假的）。
 *
 * ## 为什么在装配层再跑一遍
 *
 * 域内那几支已经钉住了「取回 → 转 markdown → 提炼 → 回执」。这里补的是**只有整条链
 * 才说得清的那三件**：
 *
 * 1. **那次提炼调用不带任何工具**——不看实现，看**发出去的那一份请求体**
 *    （`'tools' in body === false`）。域内用例能看到模型域的入参，看不到真出网的字节；
 *    这里补上那一跳。
 * 2. **主模型那一轮看到的是答案，不是原文**——判据落在**主轮第二次请求的正文**上：
 *    里面有答案，没有页面原文。
 * 3. **停住那一趟真的停住了**——没配提炼模型时只有**一次**请求；而剧本里紧跟着
 *    就摆着一发 `exec curl`（**反证**：不拦的话它会跑出去）。
 *
 * ## 假在哪儿
 *
 * 端点＝环回夹具（真 `Bun.serve`，剧本 SSE）；取回面＝注入的替身（`webSource`）。
 * 其余全真：真配置加载 · 真装配 · 真闸门（**卡是真弹的**，用例按 `y`/`a` 答）·
 * 真工具分发 · 真记录。
 */

import { describe, expect, test } from 'bun:test'
import type { PageFetch, WebSource } from '@magic/contracts'
import type { ShellHandle } from '../src/index.ts'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture, FixtureRequest } from './ui/fixture.ts'

/** 会话那一条连接上的模型。 */
const SESSION_MODEL = 'MiniMax-M3'
/** 「取网页用的模型」——**另一条**（判据要的是「它跟当前会话那个是两个」）。 */
const DISTILL_MODEL = 'distill-small'

/** 那一页的 HTML——页面原文里有一句**只在原文里**的话（判据靠它认「原文进没进上下文」）。 */
const PAGE_HTML =
  '<html><head><title>定价</title></head><body><h1>定价</h1>' +
  '<p>标准版每月 12 元。</p><p>内部备注：这一段只在原文里，答案里不该出现。</p></body></html>'

/** 提炼那一跳回的答案。 */
const ANSWER = '标准版每月 12 元。'

/** 替身的取回面——记下被叫了几次、取的哪个地址。 */
function fakeWeb(body = PAGE_HTML): WebSource & { readonly asked: string[] } {
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
        contentType: 'text/html',
      })
    },
  }
}

/** 一块接在受控端点上的沙地——`webFetch` 那一格给不给就是本文件两组用例的差别。 */
function stageOn(fixture: Fixture, options: { readonly configured: boolean }) {
  return makeStage({
    config: {
      defaultProvider: 'local',
      providers: {
        local: { baseURL: fixture.baseURL, apiKey: FAKE_API_KEY, model: SESSION_MODEL },
      },
      ...(options.configured ? { webFetch: { provider: 'local', model: DISTILL_MODEL } } : {}),
    },
  })
}

/** 等「回到等待输入」攒够几次。 */
function waitIdle(shell: ShellHandle, times: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const idle = eventsOfKind(shell.events, 'agent.state').filter((event) => event.data.state === 'waiting')
      if (idle.length < times) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

/** 全部**对话**请求（`/chat/completions`）——接了 `vendor` 的连接会先来一发目录刷新，不是对话。 */
function chatsOf(fixture: Fixture): readonly FixtureRequest[] {
  return fixture.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/** 一次请求里的**全部文本**（各条消息拼起来）——「这一轮看到了什么」就看它。 */
function textOf(request: FixtureRequest | undefined): string {
  const messages = (request?.body['messages'] ?? []) as readonly { role: string; content: unknown }[]

  return messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? ''),
    )
    .join('\n')
}

describe('U72 · 配好了的那一趟：取回 → 提炼 → 只交答案', () => {
  test('三次请求：主轮 → 提炼 → 主轮；提炼那一跳**不带任何工具**，用的是配置里那个模型', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [
        // 主轮 1：模型要求取网页
        {
          kind: 'tool',
          name: 'web_fetch',
          args: { url: 'https://example.com/pricing', prompt: '标准版多少钱？' },
        },
        // 提炼那一跳：回的是一段答案正文（不是工具调用）
        { kind: 'text', text: ANSWER },
        // 主轮 2：拿到答案之后收束
        { kind: 'text', text: '看完了。' },
      ],
    })
    const web = fakeWeb()
    const stage = stageOn(fixture, { configured: true })

    try {
      const assembly = stage.assemble({ modelGateway: undefined, webSource: web })
      const handle = attachShell(assembly.shell)

      handle.send({ type: 'input.submit', text: '查一下它的定价' })
      // 卡是真弹的（外发必闸）——批准
      await waitFor(handle, '卡挂上', (events) => events.some((event) => event.kind === 'tool.decision.request'))
      // 取网页那一张卡上有域名
      const card = eventsOfKind(handle.events, 'tool.decision.request')[0]
      expect(card?.data.host).toBe('example.com')
      answer(handle, card?.id as number, 'approve')

      await waitIdle(handle, 1)

      const chats = chatsOf(fixture)
      expect(chats.map((chat) => chat.model)).toEqual([SESSION_MODEL, DISTILL_MODEL, SESSION_MODEL])

      // ⚠️ **护栏**：提炼那一跳的请求体里**连 `tools` 这个键都没有**（不是 `[]`）——
      // 供应商因此压根不知道有什么工具可调，模型发不出工具调用。
      const distill = chats[1]
      expect(distill === undefined ? undefined : 'tools' in distill.body).toBe(false)
      expect(chats[0] === undefined ? 0 : ((chats[0].body['tools'] as unknown[]) ?? []).length).toBeGreaterThan(0)

      // ② 提炼那一跳带上了页面与问题（按问题提炼的来处）
      expect(textOf(distill)).toContain('标准版多少钱？')
      expect(textOf(distill)).toContain('标准版每月 12 元。')

      // ① 主轮第二次请求里：**答案在、原文不在**
      const second = chats[2]
      expect(textOf(second)).toContain(ANSWER)
      expect(textOf(second)).toContain('不是原文')
      expect(textOf(second)).not.toContain('内部备注')
      expect(textOf(second)).not.toContain('<html>')

      // 取回面被叫了一次，取的是归一之后那个地址
      expect(web.asked).toEqual(['https://example.com/pricing'])
    } finally {
      stage.dispose()
      await fixture.stop()
    }
    // 一次交代要走好几个来回（主轮 → 提炼 → 主轮）——`bun test` 缺省那 5 秒不够
  }, 30_000)

  test('② 换一个问题：两次提炼各自的请求体带着各自的问题，答案跟着变', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '多少钱？' } },
        { kind: 'text', text: '每月 12 元。' },
        { kind: 'text', text: '好。' },
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '支持退款吗？' } },
        { kind: 'text', text: '页面没提退款。' },
        { kind: 'text', text: '好。' },
      ],
    })
    const stage = stageOn(fixture, { configured: true })

    try {
      const handle = attachShell(stage.assemble({ modelGateway: undefined, webSource: fakeWeb() }).shell)

      // ⚠️ 等的是**第 n 张卡挂上来**（不是「有过卡」）：第二趟若不这么等，
      // 拿到的是上一趟那张早已答过的卡——答复打在一个已了结的 id 上，这一轮就挂住了。
      for (const round of [1, 2]) {
        handle.send({ type: 'input.submit', text: '问一件事' })
        await waitFor(
          handle,
          `第 ${round} 张卡挂上`,
          () => eventsOfKind(handle.events, 'tool.decision.request').length >= round,
        )
        answer(handle, eventsOfKind(handle.events, 'tool.decision.request')[round - 1]?.id as number, 'approve')
        // 这一轮**走完**了再问下一件（上一轮还在跑时提交，走的是排队那条路——
        // 那与「接着说一句」不是同一件事，本用例不测它）
        await waitIdle(handle, round)
      }

      const distillQuestions = chatsOf(fixture)
        .filter((chat) => chat.model === DISTILL_MODEL)
        .map((chat) => textOf(chat))

      expect(distillQuestions).toHaveLength(2)
      expect(distillQuestions[0]).toContain('多少钱？')
      expect(distillQuestions[1]).toContain('支持退款吗？')

      // 两趟的答案不同 → 主模型看到的也不同（「按问题提炼」，不是「把页面摘要了一遍」）
      const mains = chatsOf(fixture).filter((chat) => chat.model === SESSION_MODEL)
      expect(textOf(mains[1])).toContain('每月 12 元。')
      expect(textOf(mains[3])).toContain('页面没提退款。')
    } finally {
      stage.dispose()
      await fixture.stop()
    }
  }, 30_000)
})

describe('U72 · 没配的那一趟：这一轮停住', () => {
  test('只有一次请求——剧本里紧跟着的那发 `exec curl` **没有跑出去**（反证）', async () => {
    const fixture = startFixture({
      model: SESSION_MODEL,
      turns: [
        { kind: 'tool', name: 'web_fetch', args: { url: 'https://example.com/pricing', prompt: '多少钱？' } },
        // **反证用**：不拦的话，模型拿到「没配」这句多半接着来这一手——
        // 整件事（省上下文）就被绕过去了。它绝不该有机会跑。
        { kind: 'tool', name: 'exec', args: { cmd: 'curl -s https://example.com/pricing' } },
        { kind: 'text', text: '抓到了原文。' },
      ],
    })
    const stage = stageOn(fixture, { configured: false })
    const web = fakeWeb()

    try {
      const handle = attachShell(stage.assemble({ modelGateway: undefined, webSource: web }).shell)

      handle.send({ type: 'input.submit', text: '查一下它的定价' })
      await waitFor(handle, '卡挂上', (events) => events.some((event) => event.kind === 'tool.decision.request'))
      answer(handle, eventsOfKind(handle.events, 'tool.decision.request')[0]?.id as number, 'approve')
      await waitIdle(handle, 1)

      // ⚠️ **硬判据**：这一轮**就地收束**——只发过主轮那一次请求
      expect(chatsOf(fixture)).toHaveLength(1)
      // **一次取网都没有**（拦在取回之前）
      expect(web.asked).toEqual([])
      // 没有 exec 跑过（反证那一手没落地）
      expect(
        eventsOfKind(handle.events, 'tool.call').filter((event) => event.data.name === 'exec'),
      ).toHaveLength(0)

      // ① 模型看得到「还没配、取不到」（工具结果落进了记录与会话）
      const results = eventsOfKind(handle.events, 'tool.result')
      const text = JSON.stringify(results.map((event) => event.data.output))
      expect(text).toContain('还没配提炼用的模型')
      expect(text).toContain('/config')
      // 那一轮是**正常收束**的（不是出错收的尾），也没有第二轮
      expect(eventsOfKind(handle.events, 'turn.end').map((event) => event.data.reason)).toEqual(['settled'])
    } finally {
      stage.dispose()
      await fixture.stop()
    }
  }, 30_000)
})

// ══ 助手 ══════════════════════════════════════════════════════════════

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
