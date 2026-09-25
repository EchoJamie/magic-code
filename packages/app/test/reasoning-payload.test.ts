/**
 * U64 · **assistant 条目的思考载荷**——从真输入到**真出站请求体**。
 *
 * ## 本单的要害（工单原话）
 *
 * 「用**受控端点**造一个『**回复里带 reasoning**』的轮次 ⇒ 那一轮跑通、且**下一轮请求里
 * 那条回传了**」——**只跑不带思考的那条不算**（那正是它一直没被发现的原因）。
 *
 * 故本文件走**整条真路**：真装配（真记录库 · 真对话域 · 真模型域 · 真适配）→ 真
 * `@ai-sdk/openai-compatible` → **环回 HTTP 端点**（`startFixture`，真 `Bun.serve`）。
 * 整条链上**只有端点地址是假的**（环回 ＋ 合成假 key，一个付费请求都不发）。
 *
 * ## 三处判据，各咬一件事
 *
 * | 用例 | 咬什么 |
 * | --- | --- |
 * | ① 思考那一轮 | **落得进去**（那一轮不炸）· **读得回来**（条目里就是那份思考）· **下一轮回传**（出站请求体里 `reasoning_content`） |
 * | ② 反面 · 兼容接入 | 同一份构造换成**没有 `vendor`** 的连接 ⇒ **一个字都不回传**（U41：思考是那一家私有协议，不转发给别家） |
 *
 * ①里那三条**缺一不可**：只验「跑通了」的话，条目里那份思考丢在取件层也照样绿——
 * 而那正是 U41 存在的理由（不回传则 400）。
 *
 * ⚠️ **修前这条是红的**（真机上第一次接真实供应商就是这么炸的）：模型回完了、
 * 在收尾落账那一步抛（记录域的硬闸把 `assistant` 判成「不带载荷」那一格）⇒
 * **那一轮的回复整份丢掉**。修前现场见 `验证/U64-思考载荷-20260925/`。
 */

import { describe, expect, test } from 'bun:test'
import type { ShellHandle } from '@magic/app'
import { attachShell } from '../src/index.ts'
import { eventsOfKind, makeStage, readDatabase, type Stage } from './support.ts'
import { FAKE_API_KEY } from './ui/sandbox.ts'
import { startFixture } from './ui/fixture.ts'
import type { Fixture } from './ui/fixture.ts'

/** 那一轮的思考——**逐字**当判据用（回传的那一份要与它一字不差）。 */
const REASONING = '先看清路径再动手：这一句不进屏，但要进下一次请求'

/** 那一轮的正文——**进屏**那一份（载荷不重复它）。 */
const REPLY = '看完了，没动它。'

const MODEL = 'deepseek-flash'

/** 等「回到等待输入」攒够几次——一次交代跑完就是一次。 */
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

/** 交代一件事，等这一轮真跑完。 */
function sendAndWait(shell: ShellHandle, text: string): Promise<void> {
  const before = eventsOfKind(shell.events, 'agent.state').filter((event) => event.data.state === 'waiting').length
  shell.send({ type: 'input.submit', text })
  return waitIdle(shell, before + 1)
}

/**
 * 一块**接在受控端点上的**沙地——配置里那一条连接指环回夹具。
 *
 * `vendor` 给不给就是本文件那两条用例的全部差别：
 * - 给 `deepseek`（官方适配，`echoesReasoning`）＝①；
 * - 不给（兼容接入，原协议原样）＝②。
 */
function stageOn(fixture: Fixture, options: { readonly vendor?: string } = {}): Stage {
  return makeStage({
    config: {
      defaultProvider: 'local',
      providers: {
        local: {
          ...(options.vendor === undefined ? {} : { vendor: options.vendor }),
          baseURL: fixture.baseURL,
          apiKey: FAKE_API_KEY,
          model: MODEL,
        },
      },
    },
  })
}

/**
 * 夹具收到的**对话**那几跳——接了 `vendor` 的连接会先来一发 `GET /models` 刷能力表，
 * 它不是一次对话（也不吃剧本，见夹具那条注）。判据问的是「模型那几轮」，故按路径滤一道。
 */
function chatsOf(fixture: Fixture): readonly { readonly assistantReasoning: string | undefined }[] {
  return fixture.requests().filter((request) => request.path.endsWith('/chat/completions'))
}

/** 直读条目表里那几条 `assistant`（绕开 API——判据不靠回读闭环自证）。 */
function assistantRows(database: string): readonly { readonly text: string; readonly payload: unknown }[] {
  const db = readDatabase(database)
  try {
    return db.entries
      .filter((entry) => entry.kind === 'assistant')
      .map((entry) => ({ text: entry.content_text ?? '', payload: JSON.parse(entry.payload ?? 'null') }))
  } finally {
    db.close()
  }
}

describe('U64 · 思考那一轮：落得进去 · 读得回来 · 下一轮回传', () => {
  test('受控端点回了思考——那一轮跑通，且下一次请求里 `reasoning_content` 一字不差', async () => {
    const fixture = startFixture({
      model: MODEL,
      turns: [
        { kind: 'text', text: REPLY, reasoning: REASONING },
        { kind: 'text', text: '好，接着来。' },
      ],
    })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    // ⚠️ **`modelGateway: undefined` 是刻意的**：不给替身 ⇒ 走**真注册表**那条路
    //    （真适配按 `vendor` 取，思考回传与否由 `echoesReasoning` 定）——
    //    换掉这一步，验的就只是「我们记得住」，不是「真发出去了」。
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined })
      const handle = attachShell(assembly.shell)

      // —— 第一轮：回复里带思考 ——
      await sendAndWait(handle, '看一下这个仓库')

      // ① **没炸**：整条路上一条 `error` 都没有（修前这儿就是「对话域异常」那条）
      expect(eventsOfKind(handle.events, 'error').map((event) => event.data.message)).toEqual([])
      // 那一轮是**正常收束**的（不是出错收的尾）
      expect(eventsOfKind(handle.events, 'turn.end').map((event) => event.data.reason)).toEqual(['settled'])

      // ② **读得回来**：条目里那份思考就是端点回的那份（逐字），正文另存（载荷不重复它）
      const landed = assistantRows(assembly.paths.database)
      expect(landed).toHaveLength(1)
      expect(landed[0]?.payload).toEqual({ reasoning: REASONING })
      expect(landed[0]?.text).toBe(REPLY)

      // —— 第二轮：那一份要随历史轮回传 ——
      await sendAndWait(handle, '接着做')

      const chats = chatsOf(fixture)
      expect(chats).toHaveLength(2)
      // ③ **要害**：第二次请求体里，上一条 assistant 消息带着那份思考（一字不差）
      expect(chats[1]?.assistantReasoning).toBe(REASONING)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('**反面**·兼容接入：同一份思考**一个字都不回传**（不转发给别的供应商）', async () => {
    const fixture = startFixture({
      model: MODEL,
      turns: [
        { kind: 'text', text: REPLY, reasoning: REASONING },
        { kind: 'text', text: '好，接着来。' },
      ],
    })
    // 没有 `vendor` ＝ 兼容接入（原协议原样）——思考是**那一家私有**的协议内容
    const stage = stageOn(fixture)
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined })
      const handle = attachShell(assembly.shell)

      await sendAndWait(handle, '看一下这个仓库')
      await sendAndWait(handle, '接着做')

      // 条目里**照旧留着**那份思考（记录域与供应商无关：如实留痕）
      expect(assistantRows(assembly.paths.database)[0]?.payload).toEqual({ reasoning: REASONING })

      // 而**出站请求体里没有它**——「不转发给其它供应商」这条口径本单没动
      const chats = chatsOf(fixture)
      expect(chats).toHaveLength(2)
      expect(chats[1]?.assistantReasoning).toBeUndefined()
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })
})

/**
 * U95 · **D45 的真正修法**：末尾那个助手回合**必须带着这一位出门**。
 *
 * 上面那一组验的是「有思考时回不回传」；这一组验的是**没有思考时**——而 D45 恰恰是这一形：
 * 那一轮 DeepSeek **压根没产出思考**（`reasoningTokens: 0`），载荷按契约整个键不写，
 * 于是回传时拿不出东西、对面 400（成因由 U92 查穿）。
 *
 * ## 判据落在**出站请求体**上（不是条目、也不是我们记不记得）
 *
 * 补的那一位必须**非空**：`@ai-sdk/openai-compatible` 写这一格的条件是
 * `reasoning.length > 0`——空串会被整键丢掉，等于没补（U92 实验 A ④）。
 * 故这里除了逐字对那一句，还**单独钉一次「非空」**：只对逐字的话，把那一句改成空串
 * 会连判据一起绿过去。
 *
 * ⚠️ **补的是说明、不是思考**（不许编造模型想过什么）——原文见 `EXPECTED_NOTE` 那条注。
 */
describe('U95 · 没有思考的那一轮：要求回传的那家补上一句说明', () => {
  /**
   * 取件层补的那一句的**原文**（`packages/model/src/ai-sdk.ts` 的 `ABSENT_REASONING_NOTE`）。
   * 此处**逐字**写死：它是「往上下文里塞的话」，改一个字都该让人过目（设计 · 提示词与指令 丙）。
   */
  const EXPECTED_NOTE = '（这一轮没有产出思考。）'

  test('模型这一轮没产出思考——下一次请求里那条助手消息带着补上的这一位（非空）', async () => {
    const fixture = startFixture({
      model: MODEL,
      // ⚠️ 剧本**不给 `reasoning`**——正是 D45 那一形（模型没产出思考）
      turns: [
        { kind: 'text', text: REPLY },
        { kind: 'text', text: '好，接着来。' },
      ],
    })
    const stage = stageOn(fixture, { vendor: 'deepseek' })
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined })
      const handle = attachShell(assembly.shell)

      await sendAndWait(handle, '看一下这个仓库')
      await sendAndWait(handle, '接着做')

      // 条目里**照旧没有思考那一格**（记录如实：那一轮真没有，不伪造痕迹）
      expect(assistantRows(assembly.paths.database)[0]?.payload).toEqual(null)

      const chats = chatsOf(fixture)
      expect(chats).toHaveLength(2)
      // **要害**：出站体里那一位补上了，且**非空**（空串会被 SDK 整键丢掉）
      expect(chats[1]?.assistantReasoning).toBe(EXPECTED_NOTE)
      expect((chats[1]?.assistantReasoning ?? '').length).toBeGreaterThan(0)
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })

  test('**反面**·兼容接入：同一形**一位都不补**（不给不要求的那家塞）', async () => {
    const fixture = startFixture({
      model: MODEL,
      turns: [
        { kind: 'text', text: REPLY },
        { kind: 'text', text: '好，接着来。' },
      ],
    })
    // 没有 `vendor` ＝ 兼容接入（不要求回传）⇒ 补这一位的那条路整个不走
    const stage = stageOn(fixture)
    let assembly: ReturnType<Stage['assemble']> | undefined

    try {
      assembly = stage.assemble({ modelGateway: undefined })
      const handle = attachShell(assembly.shell)

      await sendAndWait(handle, '看一下这个仓库')
      await sendAndWait(handle, '接着做')

      const chats = chatsOf(fixture)
      expect(chats).toHaveLength(2)
      expect(chats[1]?.assistantReasoning).toBeUndefined()
    } finally {
      assembly?.close()
      await fixture.stop()
      stage.dispose()
    }
  })
})
