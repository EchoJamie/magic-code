/**
 * U79 · **「需要你」那一档：不回执、不广播**（外壳这一侧）。
 *
 * `bun test` **收它**。真帧那一趟在 `packages/app/test/frames-u79-tui.ts`
 * （真 PTY ＋ 两扇窗）；管理者那一侧的判据（谁收得到、系统通知、未读）在
 * `packages/app/test/run-stop.test.ts` 的「U79 · 通知」那一节。
 *
 * ## 这一格是什么（设计 · 会话与运行管理「通知」）
 *
 * > **需要你** —— **卡在那条会话里**（它不动）· **你连上它时直接进那张卡**
 * > （U49 的接回快照已承担）· **它不回执、不广播** · **一个窗口都没有时**，才加一记系统通知
 *
 * 故外壳这一侧只有一件事可判：**这句话不再产出**——不是「换个地方印」、也不是
 * 「往后挪一挪」，是**不要了**（同 U74 撤「跑完了」那一条的处置）。
 *
 * ## 两条判据，一正一反
 *
 * | | 判什么 |
 * | --- | --- |
 * | **正** | `needs-you` 不产出任何一行（带 `detail` 也不产）——**屏上那一格随之没有** |
 * | **反** | `failed` 照旧产出、逐字不变（U74 与 U79 两单都明写**它一个字没动**） |
 *
 * ⚠️ **别拿「三类里只剩一类还印」当成判据写完就算**：将来谁再加一类回来，
 * 下面那张**逐类的表**当场红——所以它一条一条写死，不写 `toEqual([...])` 那种一改就全绿的。
 *
 * ⚠️ **状态行那一格的「等你定夺」不在这条判据里**：它说的是「此刻在等你」
 * （`status.ts` 画），与「那一次转换留下的一行回执」是两件事——撤的是后者。
 */

import { describe, expect, test } from 'bun:test'
import type { NoticeKind, RunNotice } from '@magic/contracts'
import { noticeReceiptOf } from '../src/view.ts'

/** 一条通知（只给这一处判据要的那几格）。 */
const notice = (kind: NoticeKind, detail?: string): RunNotice => ({
  id: `${kind}:1`,
  session: 's1',
  kind,
  at: 1_000,
  ...(detail === undefined ? {} : { detail }),
  unread: true,
})

describe('U79 · 「需要你」那一行回执', () => {
  test('**不产出任何一行**（带不带那个名字都不产）', () => {
    expect(noticeReceiptOf(notice('needs-you'), '时区修正')).toBeUndefined()
    expect(noticeReceiptOf(notice('needs-you', 'exec'), '时区修正')).toBeUndefined()
  })

  test('**逐类写死**：今天只剩 `failed` 那一格还拼得出那句话', () => {
    // 「三类转换」那一张表的今天——一行一行写，不拿一条等式概括
    // （概括式的一改就全绿，而这正是要盯住的那一格：**哪几类还会印**）
    //
    // ⚠️ **U86 起这一条只管「这一支还拼不拼得出」**：管理者那一头三类**都不再往窗口送**
    // （「出错了」也按「还在看」判了），故这三格**今天一格都到不了屏上**。
    // 判据本身一个字没改——改的是它读出来的意思；清掉整条通道是另一笔活，见 `view.ts`。
    expect(noticeReceiptOf(notice('done'), '时区修正')).toBeUndefined()
    expect(noticeReceiptOf(notice('needs-you'), '时区修正')).toBeUndefined()
    expect(noticeReceiptOf(notice('failed'), '时区修正')).not.toBeUndefined()
  })

  test('**反面**：`failed` 逐字不变（U79 只碰了「需要你」那一格）', () => {
    expect(noticeReceiptOf(notice('failed'), '时区修正')).toBe('「时区修正」出错了')
    expect(noticeReceiptOf(notice('failed', '这一轮出错了'), '时区修正')).toBe(
      '「时区修正」出错了：这一轮出错了',
    )
  })
})
