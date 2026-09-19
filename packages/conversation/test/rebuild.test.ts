/**
 * U25 · 对话域 —— **重建面**（恢复的第 ⑤ 步 · 技术方案 · 领域划分 ·「域之上：应用层」）。
 *
 * ```
 *   ⑤ 上下文由条目重建（`ConversationService`）＋ 界面重建展示（外壳，经事件）
 * ```
 *
 * 本文件只测**对话域这一半**：装载 ＋ 认下应用层算好的两件（`RebuildHandoff`）。
 * ①②③④（在途识别 / 处置 / 记中止 / 未答复按拒）的判据在 `@magic/actions`；
 * 五步连起来的那一次在装配面（`packages/app/test/recovery.test.ts`）与**真跑**里验
 * （杀进程 → 重起 → 续跑）。
 *
 * 上线是「上下文由条目重建」——它每轮由 `./context.ts` 装配，故本面**不必搬上下文**；
 * 真正要认的只有水位（轮号续跑）与开工位（`agent.start` 别发两遍）。
 */

import { describe, expect, test } from 'bun:test'
import { createConversationSession } from '../src/service.ts'
import { makeStage, waitUntilIdle } from './support/harness.ts'
import type { Stage } from './support/harness.ts'

const SESSION = 's-rebuild'
const T0 = 1_700_000_000_000

/** 一条会话的实例——重建面接上（其余与 `service.test.ts` 同源）。 */
function sessionOf(stage: Stage) {
  return createConversationSession({
    session: SESSION,
    model: 'faux-1',
    prompt: { cwd: '/w', platform: 'darwin', date: '2026-09-18' },
    gateway: stage.gateway,
    tools: stage.toolDomain,
    records: stage.records,
    sink: stage.sink,
    stamper: stage.stamper,
    now: () => T0,
  })
}

describe('轮号续跑——记录里的水位抬过来', () => {
  test('下一轮接着那串号走（不从 1 重来）', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = sessionOf(stage)

    const report = service.rebuild({ lastTurn: 5, announced: true })
    service.submit({ text: '接着说' })
    await waitUntilIdle(stage.sink)

    expect(report).toEqual({ session: SESSION, lastTurn: 5 })
    expect(stage.sink.byKind('turn.start').map((event) => event.turn)).toEqual([6])
  })

  test('水位缺席（新会话 / 空会话）——照旧从 1 起', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = sessionOf(stage)

    service.rebuild({ lastTurn: null, announced: false })
    service.submit({ text: '第一句' })
    await waitUntilIdle(stage.sink)

    expect(stage.sink.byKind('turn.start').map((event) => event.turn)).toEqual([1])
  })
})

describe('开工位——`agent.start` 每个实例一条（U04 口径）', () => {
  test('恢复那趟发过（`announced: true`）——首次 submit 不再发第二遍', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = sessionOf(stage)

    service.rebuild({ lastTurn: null, announced: true })
    service.submit({ text: '接着说' })
    await waitUntilIdle(stage.sink)

    // 全过程一条都没有——恢复已经代表了本实例的「首次开工」
    expect(stage.sink.byKind('agent.start')).toHaveLength(0)
  })

  test('干净会话（`announced: false`）——首次 submit 照旧自己发', async () => {
    const stage = makeStage({ turns: [{ text: '好' }] })
    const service = sessionOf(stage)

    service.rebuild({ lastTurn: null, announced: false })
    service.submit({ text: '第一句' })
    await waitUntilIdle(stage.sink)

    expect(stage.sink.byKind('agent.start')).toHaveLength(1)
  })
})

describe('纪律', () => {
  test('干活时不许重建——与循环抢同一条记录流', async () => {
    const stage = makeStage({
      turns: [{ toolCalls: [{ name: 'exec', args: { cmd: 'sleep 100' } }] }],
      handlers: { exec: () => new Promise(() => {}) },
    })
    const service = sessionOf(stage)

    service.submit({ text: '跑个长命令' })
    // 等工具跑起来（那一下实例就是忙的）
    for (let i = 0; i < 100 && stage.sink.byKind('tool.call').length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect(() => service.rebuild({ lastTurn: null, announced: false })).toThrow('放开输入之前')
  })

  test('重建**不发事件**——过程流里那几笔归应用层（它编排了②③④）', () => {
    const stage = makeStage()
    const service = sessionOf(stage)

    service.rebuild({ lastTurn: 9, announced: true })

    expect(stage.sink.events).toEqual([])
    expect(stage.records.entries).toEqual([])
  })
})
