/**
 * U74 · **撤掉「那一轮跑完了」回执 ＋ 思考自成一块**（真链路，到屏为止）。
 *
 * `bun test` **收它**（本文件是 `*.test.ts`）——真帧那一趟在
 * `packages/app/test/frames-u74-tui.ts`（真 PTY ＋ 真 CLI）。
 *
 * 两件各咬正反两面：
 *
 * | 件 | 正面 | 反面 |
 * | --- | --- | --- |
 * | ① 「跑完了」那条回执 | `done` **不再产出**任何一行 | `failed` **逐字不变** |
 * | ② 思考自成一块 | `（思考）…` **上下各留一整行** | 不带思考的那一轮**一字不动**（不白撑一行） |
 *
 * ⚠️ ①②的「落点」「次序」不在这条判据里：①那一件不是「换个地方印」，是**不要了**
 * （「跑完了」那一条**整个撤掉**，2026-09-25 用户定）。
 *
 * ⚠️ **本文件当年那句「`needs-you` 一处没动」已经不再成立**——那一条是 **U79 撤的**
 * （同一个设计格子里的下一行：「需要你」不回执、不广播），本文件那一支跟着改；
 * 那一类自己的正反面判据在 `spec.u79.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { RunNotice } from '@magic/contracts'
import { noticeReceiptOf } from '../src/view.ts'
import { event } from './events.ts'
import { createStage } from './screen.ts'

/** 起一个壳，并投一条会话状态（与 `spec.log.test.ts` 同一份底子）。 */
function live() {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一条通知（只给这一处判据要的那几格）。 */
const notice = (kind: RunNotice['kind'], detail?: string): RunNotice => ({
  id: `${kind}:1`,
  session: 's1',
  kind,
  at: 1_000,
  ...(detail === undefined ? {} : { detail }),
  unread: true,
})

// ══ ① 「那一轮跑完了」那条回执：**不再产出** ═════════════════════════

describe('「跑完了」那条回执', () => {
  test('`done` **一个字都不印**（连落点都没有了——不是换个地方印）', () => {
    expect(noticeReceiptOf(notice('done'), '时区修正')).toBeUndefined()
  })

  test('`failed` **逐字不变**（那一类一处没动）', () => {
    // ⚠️ 逐字写死：这两句是**用户看的话**，改了就得在这儿改——不拿「包含」那种软判据糊过去
    expect(noticeReceiptOf(notice('failed'), '时区修正')).toBe('「时区修正」出错了')
    expect(noticeReceiptOf(notice('failed', '这一轮出错了'), '时区修正')).toBe(
      '「时区修正」出错了：这一轮出错了',
    )
  })

  test('⚠️ **`needs-you` 当年那一句也不产出了**（U79 改的口径，别把它当成「一字没动」）', () => {
    expect(noticeReceiptOf(notice('needs-you'), '时区修正')).toBeUndefined()
    expect(noticeReceiptOf(notice('needs-you', 'exec'), '时区修正')).toBeUndefined()
  })
})

// ══ ② 思考自成一块：上下各留一整行 ═══════════════════════════════════

describe('思考自成一块', () => {
  test('`› …` ／ 空行 ／ `（思考）…` ／ 空行 ／ `⏺ …`——**上下各一整行**', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'thinking', text: '先想一下。' }),
      event('model.delta', { channel: 'text', text: '想好了。' }),
    ])

    const frame = await stage.screen()

    expect(frame.content.map((line) => line.text)).toEqual([
      '› 看看工作区',
      '',
      '（思考）先想一下。',
      '',
      '⏺ 想好了。',
    ])
  })

  test('**反面**：不带思考的那一轮**一字不动**（没思考就不撑行）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '想好了。' })])

    const frame = await stage.screen()

    // 与 U67 判准的那一形**逐字同**：`›` ／ 空行 ／ `⏺`
    expect(frame.content.map((line) => line.text)).toEqual(['› 看看工作区', '', '⏺ 想好了。'])
  })

  test('块内紧凑：展开的那条思考**几行紧贴**（它自成一**块**，不是一行一块）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'thinking', text: '第一行\n第二行' }),
      event('model.delta', { channel: 'text', text: '好。' }),
    ])
    stage.press({ kind: 'ctrl+o' })

    const frame = await stage.screen()

    expect(frame.content.map((line) => line.text)).toEqual([
      '› 看看工作区',
      '',
      '（思考）第一行',
      '第二行',
      '',
      '⏺ 好。',
    ])
  })

  test('思考在**尾巴**上时不白留一行（它后面没有块）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'text', text: '先看。' }),
      event('model.delta', { channel: 'thinking', text: '再看一眼。' }),
    ])

    const frame = await stage.screen()

    expect(frame.content.map((line) => line.text)).toEqual([
      '› 看看工作区',
      '',
      '⏺ 先看。',
      '',
      '（思考）再看一眼。',
    ])
  })
})
