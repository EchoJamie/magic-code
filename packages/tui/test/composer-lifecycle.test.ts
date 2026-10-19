/** 验证输入区生命周期与草稿保留；内存渲染不验证终端光标转义。 */

import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { AppView } from '../src/components/app.ts'
import type { ShellView } from '../src/view.ts'
import { createStage } from './screen.ts'
import { event } from './events.ts'

/** 一屏上的那几个孩子（`AppView` 是纯函数、没有钩子，故可以直接叫它拿元素树）。 */
function childrenOf(view: ShellView, columns = 200, rows = 40): readonly ReactElement[] {
  const element = AppView({ view, columns, rows, now: null }) as ReactElement<{
    readonly children: ReactElement[]
  }>

  return element.props.children
}

/** 那几个孩子身上的 key（没有 key 的记 `null`——判据要看得见「缺」）。 */
function keysOf(view: ShellView): readonly (string | null)[] {
  return childrenOf(view).map((child) => (child.key === null ? null : String(child.key)))
}

/**
 * 从**上沿那条线**往后数的那一串 key——「恒在的那几格」正落在这后面。
 *
 * 它前面是记录区（`Static` ＋ 本轮那几行），条数随会话长；后面那几格**不看行数**。
 */
function fixedTailOf(view: ShellView): readonly (string | null)[] {
  const keys = keysOf(view)
  const at = keys.indexOf('rule:record')

  return at === -1 ? [] : keys.slice(at)
}

describe('恒在的兄弟节点按 key 配对（真光标不被重挂推着走）', () => {
  test('那几个兄弟**都带 key、且互不相同**', () => {
    const stage = createStage()
    stage.type('查一下登录为什么失败')
    stage.press({ kind: 'enter' })

    const keys = keysOf(stage.shell.getView())

    expect(keys.filter((key) => key === null)).toEqual([])
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('⚠️ **记录区行数变了，那几个 key 逐字不动**（这才是重挂的根子）', () => {
    const stage = createStage()
    stage.type('查一下登录为什么失败')
    stage.press({ kind: 'enter' })

    const rowsBefore = childrenOf(stage.shell.getView()).length
    const before = fixedTailOf(stage.shell.getView())

    // 「记录区长出一条」——本轮多一行（模型开始回这一句）
    stage.feed([event('model.delta', { channel: 'text', id: 'x', text: '正在看。' })])

    const after = fixedTailOf(stage.shell.getView())

    // 前提：记录区那一段**真变长了**（不然这条判据是拿一屏没变的屏在自证）
    expect(childrenOf(stage.shell.getView()).length).toBeGreaterThan(rowsBefore)
    expect([...after]).toEqual([...before])
    // 而且那条线还在（`fixedTailOf` 找得到它——找不到会给空数组，那不算过）
    expect(before.length).toBeGreaterThanOrEqual(4)
  })

  test('清单出现前／后，那几个 key 也逐字不动（清单那一格自己带 key）', () => {
    const stage = createStage()
    const plan = { steps: [{ text: '第一步', status: 'pending' as const }], notes: '' }

    const before = fixedTailOf(stage.shell.getView())
    stage.feed([event('plan.changed', { entry: 1, plan })])
    const after = fixedTailOf(stage.shell.getView())

    // 多出来的那一格挂着自己的 key，且**恒在的那几格一个没挪**
    expect(after.length).toBe(before.length)
    expect(after.filter((key) => key !== 'plan')).toEqual([...before])
  })
})
