/**
 * `ConversationService` —— 端口实现（U04 判据 · 中断路径 · 回到等待输入）。
 *
 * 三件事钉在此处：
 * - **公开面**——装配期构造入参 → 端口实现；消费者按契约 `ConversationService` 取用；
 * - **状态转场**——`agent.start` / `agent.state{resumed|waiting}`：干活 / 回到等待输入；
 * - **中断语义**——在途打断以「中止」收束并回到等待；空闲时打断什么都不做
 *   （「空闲时 Ctrl+C ＝ 退出」由外壳发起——本域只保证中断语义正确）。
 *
 * 接线走测试台（`./support/harness.ts`）；脚本与替身同 `loop.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationService, KernelEvent, RecordsService } from '@magic/contracts'
import type { FauxRecords } from '@magic/faux'
import { PromptVarsError } from '../src/prompt/index.ts'
import { createConversationService } from '../src/service.ts'
import type { ConversationDeps } from '../src/service.ts'
import { makeLoopRuntime, makeStage, waitFor, waitUntilIdle } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

/** 事件序列（只取 kind）——状态转场读起来最省事。 */
function kindsOf(stage: Stage, from = 0): readonly string[] {
  return stage.sink.events.slice(from).map((event) => event.kind)
}

/** 状态事件的状态值序（`agent.state` 的载荷）。 */
function statesOf(stage: Stage): readonly string[] {
  return stage.sink.byKind('agent.state').map((event) => event.data.state)
}

/** 端口实现的构造入参——与测试台的替身同源（见 harness 的 `ConversationDeps` 用法）。 */
function depsOf(stage: Stage, overrides: Partial<ConversationDeps> = {}): ConversationDeps {
  const runtime = makeLoopRuntime(stage)

  return {
    session: runtime.session,
    model: runtime.model,
    prompt: stage.promptVars,
    gateway: stage.gateway,
    tools: stage.toolDomain,
    records: stage.records,
    sink: stage.sink,
    stamper: stage.stamper,
    now: runtime.now,
    ...overrides,
  }
}

describe('ConversationService · 公开面', () => {
  test('端口实现可按契约取用（结构兼容由编译期钉住）', () => {
    const stage = makeStage()
    const service: ConversationService = createConversationService(depsOf(stage))

    expect(typeof service.submit).toBe('function')
    expect(typeof service.interrupt).toBe('function')
  })

  test('提示词注入值缺项——构造期就报错，不静默降级送一份缺环境的提示词', () => {
    const stage = makeStage()

    let thrown: unknown
    try {
      createConversationService(depsOf(stage, { prompt: { cwd: '  ', platform: 'darwin', date: '2026-09-18' } }))
    } catch (error) {
      thrown = error
    }

    expect(thrown instanceof PromptVarsError).toBe(true)
    if (!(thrown instanceof PromptVarsError)) throw new Error('没抛 PromptVarsError')
    expect(thrown.missing).toEqual(['cwd'])
  })
})

describe('ConversationService · 状态转场', () => {
  test('交代一件事——起 · 干活 · 收束 · 回到等待输入', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = createConversationService(depsOf(stage))
    service.submit({ text: '你好' })

    // 端口是 `void`——工作异步跑，但状态转场**当场**发生（外壳据此立刻改界面）
    expect(kindsOf(stage).slice(0, 2)).toEqual(['agent.start', 'agent.state'])
    expect(statesOf(stage)).toEqual(['resumed'])

    await waitUntilIdle(stage.sink)

    expect(kindsOf(stage)).toEqual([
      'agent.start',
      'agent.state', // resumed
      'message.user',
      'turn.start',
      'model.call.start',
      'model.delta',
      'model.call.end',
      'message.assistant',
      'turn.end',
      'agent.state', // waiting——收束后回到等待输入
    ])
    expect(statesOf(stage)).toEqual(['resumed', 'waiting'])
  })

  test('`agent.start` 只在首次开工前发一次（构造期不发——外壳那时还没订上）', async () => {
    const stage = makeStage({ turns: [{ text: '一' }, { text: '二' }] })
    const service = createConversationService(depsOf(stage))

    service.submit({ text: '第一件' })
    await waitUntilIdle(stage.sink)
    service.submit({ text: '第二件' })
    await waitUntilIdle(stage.sink)

    expect(stage.sink.byKind('agent.start')).toHaveLength(1)
    expect(statesOf(stage)).toEqual(['resumed', 'waiting', 'resumed', 'waiting'])
  })
})

describe('ConversationService · 排队', () => {
  test('干活时又来一件——排队，收束后接着跑（一次只干一件）', async () => {
    const stage = makeStage({
      turns: [{ text: '回第一件' }, { text: '回第二件' }],
      stepDelayMs: 1, // 留出「边跑边交代」的窗口
    })
    const service = createConversationService(depsOf(stage))

    service.submit({ text: '第一件' })
    service.submit({ text: '第二件' }) // 第一件还没跑完

    await waitUntilIdle(stage.sink)

    // 两件都跑了、按序，且第二件不会另起一段工作（`resumed` 只发过一次）
    expect(stage.sink.byKind('message.user')).toHaveLength(2)
    expect(stage.records.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.content)).toEqual([
      { text: '第一件' },
      { text: '第二件' },
    ])
    expect(statesOf(stage)).toEqual(['resumed', 'waiting'])
    expect(stage.sink.byKind('turn.end').map((event) => event.data.reason)).toEqual([
      'settled',
      'settled',
    ])
  })
})

describe('ConversationService · 中断', () => {
  test('在途打断——本轮以「中止」收束，随后回到等待输入', async () => {
    const stage = makeStage({ turns: [{ text: ['一', '二', '三', '四'] }], stepDelayMs: 2 })
    const service = createConversationService(depsOf(stage))

    service.submit({ text: '说点长的' })
    await waitFor(
      () => (stage.sink.byKind('model.delta').length >= 1 ? true : undefined),
      '第一条正文增量',
    )

    service.interrupt()
    await waitUntilIdle(stage.sink)

    expect(stage.sink.byKind('turn.end').map((event) => event.data.reason)).toEqual(['aborted'])
    expect(statesOf(stage)).toEqual(['resumed', 'waiting'])
  })

  test('打断一并清掉排队中的交代——「停下」就是停下', async () => {
    const stage = makeStage({ turns: [{ text: ['一', '二', '三', '四'] }], stepDelayMs: 2 })
    const service = createConversationService(depsOf(stage))

    service.submit({ text: '头一件' })
    service.submit({ text: '还没轮到的那件' })
    await waitFor(
      () => (stage.sink.byKind('model.delta').length >= 1 ? true : undefined),
      '第一条正文增量',
    )

    service.interrupt()
    await waitUntilIdle(stage.sink)

    // 排队的第二件没跑（记录里只有第一件）
    expect(stage.records.entries.map((entry) => entry.content)).toEqual([{ text: '头一件' }])
    expect(stage.sink.byKind('turn.end').map((event) => event.data.reason)).toEqual(['aborted'])
  })

  test('空闲时打断——什么都不发生（空闲时的 Ctrl+C ＝ 退出，归外壳发起）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = createConversationService(depsOf(stage))

    service.interrupt()

    expect(stage.sink.events).toEqual([])
    // 打断过之后照常能干活（不是一次性开关）
    service.submit({ text: '你好' })
    await waitUntilIdle(stage.sink)
    expect(stage.sink.byKind('turn.end').map((event) => event.data.reason)).toEqual(['settled'])
  })
})

describe('ConversationService · 兜底', () => {
  test('记录写炸——发 `error` 且回到等待输入（不静默、不挂死）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = createConversationService(depsOf(stage, { records: brokenRecords(stage.records) }))

    service.submit({ text: '你好' })
    await waitUntilIdle(stage.sink)

    expect(statesOf(stage)).toEqual(['resumed', 'waiting'])
    const errors = stage.sink.byKind('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]?.data.message).toContain('库写坏了')
  })
})

/** 记录桩：写入即炸——验内核自身异常的就近兜底（库坏掉时不许静默）。 */
function brokenRecords(base: FauxRecords): RecordsService {
  return {
    get blobs() {
      return base.blobs
    },
    nextId: (): number => base.nextId(),
    appendEntry: () => {
      throw new Error('库写坏了')
    },
    appendEvent: (event: KernelEvent): void => base.appendEvent(event),
    readEntries: (session, range) => base.readEntries(session, range),
    readEvents: (session) => base.readEvents(session),
    listSessions: () => base.listSessions(),
  }
}
