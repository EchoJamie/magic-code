/**
 * U84 · **失败要留得下证**——真装配的端到端（真 SDK ＋ 注入 fetch ＋ 真记录库）。
 *
 * 由头（缺陷 D44「请求失败零留痕」）：用户 2026-09-26 用 DeepSeek 撞到报错之后问
 * 「报错日志没有记录留存吗」——**先得留得下证，才谈得上查**。
 *
 * ## 判据就是工单的完成出口
 *
 * - ① **必输的请求**（错 key / 端点必然失败）⇒ 事后**直读记录库**查得到那次失败：
 *   哪一家、哪个模型、什么错、什么时候；
 * - ② **反面**：那次失败**不进模型上下文**——接着对话，装配出来的消息里没有它；
 * - ③ **参数不成形**：「没给」与「给了但不成形」在留痕里**分得开**；
 * - ④ **脱敏**：留痕里找不到密钥（拿一条**带 key 的失败样本**自查）。
 *
 * 读法一律**直读库表**（`readDatabase`——不经 API 回读），与「记录可直读」那条判据同法：
 * 要证的是「事后查得到」，不是「经我们的代码才看得见」。
 */

import { describe, expect, test } from 'bun:test'
import type { EventStamper, KernelEvent, ModelGateway } from '@magic/contracts'
import { createModelGateway } from '@magic/model'
import { attachShell } from '../src/index.ts'
import type { ShellHandle } from '@magic/app'
import { makeStage, readDatabase, type RawDatabase, type Stage } from './support.ts'

// —— 夹具 ——

/**
 * 沙地上那条连接——与探针网关**同一格**（`deepseek` / `deepseek-flash`）。
 *
 * 不换掉它的话，会话开局那个模型名取自配置（`MiniMax-M3`），而注入的网关是 deepseek——
 * 记录里那句「哪个模型」就成了两个来源拼出来的东西，判据立不住。
 */
const STAND: Record<string, unknown> = {
  defaultProvider: 'deepseek',
  providers: {
    deepseek: {
      baseURL: 'http://test.invalid/v1',
      apiKey: 'sk-test-not-a-real-key',
      model: 'deepseek-flash',
    },
  },
}

/** 一块沙地——连接已按上面那一格摆好。 */
function stageOf(): Stage {
  return makeStage({ config: STAND })
}

/** 探针用的 key——**故意长得像真的**（脱敏那一关拿它自查）。 */
const PROBE_KEY = 'sk-probe-SECRET-abcdefghijklmnop'

/**
 * 一支**真实网关**（真 SDK ＋ 注入 fetch）——出站请求体留在闭包里，
 * 「失败之后接着对话，装配出来的消息里有没有它」靠它判（①与②）。
 *
 * `script` **先排后接**（`make` 读的是同一个数组）：第 n 次出站请求用第 n 个作答，
 * 用完了**沿用最后一个**——用例不必为「会不会被多问一次」操心（那会绕成死循环）。
 */
function probeGateway(): {
  readonly make: (stamper: EventStamper) => ModelGateway
  readonly bodies: string[]
  readonly script: (() => Response)[]
} {
  const bodies: string[] = []
  const script: (() => Response)[] = []
  let step = 0

  const make = (stamper: EventStamper): ModelGateway =>
    createModelGateway({
      providerId: 'deepseek',
      config: { baseURL: 'http://test.invalid/v1', model: 'deepseek-flash', apiKey: PROBE_KEY },
      env: {},
      stamper,
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: async (_input, init) => {
        bodies.push(String(init?.body))
        const pick = script[Math.min(step, script.length - 1)]
        step += 1
        if (pick === undefined) throw new Error('用例没排脚本（见 probeGateway 的注）')
        return pick()
      },
    })

  return { make, bodies, script }
}

/** 一段 OpenAI 兼容的流式分片。 */
function frame(delta: unknown, finish: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-probe',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`
}

function sse(parts: readonly string[]): Response {
  return new Response(parts.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** 好好回一句正文——把一轮收到头。 */
function plain(text = '好的'): Response {
  return sse([frame({ content: text }, null), frame({}, 'stop'), 'data: [DONE]\n\n'])
}

/** 一次工具调用：`arguments` 由若干片段拼成（真端点就是这么吐的）。 */
function toolCallSse(id: string, name: string, pieces: readonly string[]): Response {
  return sse([
    frame(
      {
        role: 'assistant',
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }],
      },
      null,
    ),
    ...pieces.map((piece) =>
      frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }, null),
    ),
    frame({}, 'tool_calls'),
    'data: [DONE]\n\n',
  ])
}

/** 端点必然失败：HTTP 400，响应体里**原样带着 key**（脱敏那一关的样本）。 */
function failing(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: `invalid api key ${PROBE_KEY}`,
        type: 'invalid_request_error',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

// —— 跑圈的小工具 ——

function attach(stage: Stage, gateway: (stamper: EventStamper) => ModelGateway) {
  const assembly = stage.assemble({ modelGateway: gateway })
  return { assembly, handle: attachShell(assembly.shell) }
}

/** 等「回到等待输入」攒够几次。 */
function waitIdle(handle: ShellHandle, times: number): Promise<void> {
  return new Promise((settle) => {
    const watch = setInterval(() => {
      const idle = handle.events.filter(
        (event) => event.kind === 'agent.state' && event.data.state === 'waiting',
      )
      if (idle.length < times) return
      clearInterval(watch)
      settle()
    }, 5)
  })
}

async function send(handle: ShellHandle, text: string): Promise<void> {
  const before = handle.events.filter(
    (event: KernelEvent) => event.kind === 'agent.state' && event.data.state === 'waiting',
  ).length
  handle.send({ type: 'input.submit', text })
  await waitIdle(handle, before + 1)
}

/** 落进库的一条事件（直读库表的那四列，判据要的都在这儿）。 */
type RecordedEvent = {
  readonly data: Record<string, unknown>
  readonly at: number
  readonly session: string
  readonly turn: number | null
}

/** 记下来的那一份事件（直读库表）——按 kind 挑。 */
function eventsOf(db: RawDatabase, kind: string): readonly RecordedEvent[] {
  return db.events
    .filter((row) => row.kind === kind)
    .map((row) => ({
      data: JSON.parse(row.data) as Record<string, unknown>,
      at: row.at,
      session: row.session,
      turn: row.turn,
    }))
}

// ══════════════════════════════════════════════════════════════════════

describe('U84 ① 必输的请求：事后从记录里查到那一次失败与原因', () => {
  test('错 key（HTTP 400）⇒ model.error 里四件齐全：哪一家 · 哪个模型 · 什么错 · 什么时候', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      gateway.script.push(failing, plain)
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '你好')
      const db = readDatabase(assembly.paths.database)

      try {
        const errors = eventsOf(db, 'model.error')
        expect(errors).toHaveLength(1)

        const one = errors[0]
        // **一条就把话说完**——这一条单独读也答得出这四件（不必回翻 model.call.start）
        expect(one?.data['tier']).toBe('terminal')
        expect(one?.data['provider']).toBe('deepseek')
        expect(one?.data['model']).toBe('deepseek-flash')
        expect(String(one?.data['message'])).toContain('invalid api key')
        // 什么时候：信封的 `at`（毫秒） ＋ 归哪条会话
        expect(typeof one?.at).toBe('number')
        expect(one?.session).toBe(assembly.session)
      } finally {
        db.close()
      }

      // 那一轮**如实以出错收场**（不假装跑完）
      const ended = handle.events.filter((event) => event.kind === 'turn.end').at(-1)
      expect(ended?.kind === 'turn.end' && ended.data.reason).toBe('error')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('端点连不上（网络层失败）⇒ 同样是 model.error，不是「对话域异常」', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      gateway.script.push(() => {
        throw new TypeError('fetch failed')
      }, plain)
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '你好')
      const db = readDatabase(assembly.paths.database)

      try {
        const errors = eventsOf(db, 'model.error')
        expect(errors).toHaveLength(1)
        expect(errors[0]?.data['provider']).toBe('deepseek')
        expect(errors[0]?.data['model']).toBe('deepseek-flash')
        expect(String(errors[0]?.data['message'])).toContain('fetch failed')
        // 兜底 `error`（内核自身异常）**一条都没有**——它不是内核的错，走的是模型域那条路
        expect(eventsOf(db, 'error')).toHaveLength(0)
      } finally {
        db.close()
      }

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U84 ② 反面：那次失败不进模型上下文', () => {
  test('失败之后接着对话——装配出来的消息里一个字都没有它', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      gateway.script.push(failing, plain)
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '第一条')
      await send(handle, '接着来')

      // 两趟出站：第一趟失败、第二趟成功——第二趟装出来的就是「失败之后」的上下文
      expect(gateway.bodies).toHaveLength(2)
      const after = gateway.bodies[1] ?? ''

      // 失败那件事（分档 / 消息 / 那一轮的措辞）**一处都不在请求体里**
      expect(after).not.toContain('invalid api key')
      expect(after).not.toContain('terminal')
      expect(after).not.toContain('model.error')
      // 但用户那两句话照旧在（失败不撤销已收下的交代）
      expect(after).toContain('第一条')
      expect(after).toContain('接着来')

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U84 ③ 参数不成形：「没给」与「给了但不成形」在留痕里分得开', () => {
  test('同一轮两次调用：一个没给参数、一个给了坏 JSON ⇒ 记录里两种形状不同', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      gateway.script.push(
        () =>
          sse([
            frame(
              {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_none', type: 'function', function: { name: 'ls', arguments: '' } },
                  { index: 1, id: 'call_bad', type: 'function', function: { name: 'write', arguments: '' } },
                ],
              },
              null,
            ),
            // 第二个调用：参数写到一半就断了（D42 现场那一形）
            frame({ tool_calls: [{ index: 1, function: { arguments: '{"path": "a.txt", ' } }] }, null),
            frame({}, 'tool_calls'),
            'data: [DONE]\n\n',
          ]),
        plain,
      )
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '写一个文件')
      const db = readDatabase(assembly.paths.database)

      try {
        const calls = eventsOf(db, 'tool.call')
        const none = calls.find((one) => one.data['name'] === 'ls')
        const bad = calls.find((one) => one.data['name'] === 'write')

        // **没给**：参数是空对象，**没有原文这一位**——不是坏参数
        expect(none?.data['args']).toEqual({})
        expect(none?.data['rawArgs']).toBeUndefined()

        // **给了但不成形**：参数也是空对象，但**原文在**——事后判得出「断在哪儿」
        expect(bad?.data['args']).toEqual({})
        expect(bad?.data['rawArgs']).toBe('{"path": "a.txt", ')

        // 两者的条目都只是 `{name, args}`（重放真源不动）——分开他们的是**事件**那一侧
        const entries = db.entries.filter((row) => row.kind === 'tool-call')
        expect(entries.map((row) => JSON.parse(row.payload ?? '{}')['args'])).toEqual([{}, {}])
      } finally {
        db.close()
      }

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })

  test('原文按上限截断——截断处写明还有多长', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      const head = '{"path": "'
      const tail = 'x'.repeat(3000)
      gateway.script.push(() => toolCallSse('call_long', 'write', [head, tail]), plain)
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '写一个很长的东西')
      const db = readDatabase(assembly.paths.database)

      try {
        const raw = String(eventsOf(db, 'tool.call')[0]?.data['rawArgs'] ?? '')
        // 头部照留（认清形状的那一段），尾巴截掉，且**写明还剩多少**
        expect(raw.startsWith(head)).toBe(true)
        expect(raw.endsWith(`…（原文共 ${head.length + tail.length} 字，已截断）`)).toBe(true)
        expect(raw.length).toBeLessThan(head.length + tail.length)
      } finally {
        db.close()
      }

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})

describe('U84 ④ 脱敏：失败留痕里找不到密钥', () => {
  test('带 key 的失败样本：错误消息与**参数原文**里都只剩 ***', async () => {
    const stage = stageOf()
    try {
      const gateway = probeGateway()
      // 第一次：端点把 key 原样回在错误体里；第二次：模型把 key 塞进了**不成形**的参数
      // （那一串正是 U84 新留的那一笔——旧留痕里本来就没有它）
      gateway.script.push(
        failing,
        () => toolCallSse('call_k', 'write', [`{"path": "${PROBE_KEY}`, '"]}']),
        plain,
      )
      const { assembly, handle } = attach(stage, gateway.make)

      await send(handle, '你好')
      await send(handle, '写一个文件')
      const db = readDatabase(assembly.paths.database)

      try {
        const raw = String(eventsOf(db, 'tool.call')[0]?.data['rawArgs'] ?? '')

        // ① **不是没记**——原文真在（这一条先立住，免得下面那句「找不到 key」是空过）
        expect(raw).toContain('{"path": "')
        expect(raw).toContain('***')
        // ② 留痕里**一处都没有那串 key**
        expect(raw).not.toContain(PROBE_KEY)
        const message = String(eventsOf(db, 'model.error')[0]?.data['message'] ?? '')
        expect(message).toContain('invalid api key ***')
        expect(message).not.toContain(PROBE_KEY)
      } finally {
        db.close()
      }

      handle.dispose()
      assembly.close()
    } finally {
      stage.dispose()
    }
  })
})
