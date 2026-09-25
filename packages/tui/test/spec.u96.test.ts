/**
 * U96 · **有清单 ＋ 空草稿时真光标藏着的根子**——动态区那几个**恒在的兄弟节点**。
 *
 * ## 查出来的那一形（不是猜的）
 *
 * 真跑取帧 + 探针量到：**记录区行数一变**（模型那一轮落定、流式长出一行……），
 * 交互区那一片**整块重挂**——`Composer` 的 `useState(anchor)` 当场清零，那一趟
 * `spot` 就是 `undefined` ⇒ `setCursorPosition(undefined)` ⇒ **真光标先藏一帧**
 * （空草稿时最刺眼：屏上正要打字，插入点却没了）。
 *
 * **根子在 React 的隐式 key**：`AppView` 根盒子那几个孩子里，恒在的那几格
 * （两条线、交互区那个盒子、状态行）**原先没有 key**——数组里没有 key 的孩子按**下标**
 * 配对，而记录区那几条（`Static` 与本轮那几行）**是有 key 的**：它们的条数一变，
 * 后面那几个的下标跟着挪 ⇒ 配不上 ⇒ **旧的卸、新的挂**。
 *
 * 故判据落在**结构**上（两处，都说得清「错了会怎样」）：
 *
 * | 判据 | 错了会怎样 |
 * | --- | --- |
 * | 那几个兄弟**都带 key、且互不相同** | 没有 key ＝ 按下标配对 ＝ 行数一变就重挂 |
 * | **记录区行数变了，从 `rule:record` 往后那几个 key 逐字不动** | key 若跟着行数走，等于没 key |
 *
 * ⚠️ **真光标本身不在这里量**（`ink-testing-library` 走 Ink 的 debug 那一支，
 * **一个光标转义都不发**，量不到）——那一头归真 PTY 的帧套件（`frames-u96-tui.ts`）。
 * 这一层钉的是**根因**：只要「恒在的兄弟按 key 配对」这条不破，重挂就回不来。
 */

import { describe, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { AppView } from '../src/components/app.ts'
import type { ShellView } from '../src/view.ts'
import { createStage } from './screen.ts'
import { event } from './events.ts'

/** 一屏上的那几个孩子（`AppView` 是纯函数、没有钩子，故可以直接叫它拿元素树）。 */
function childrenOf(view: ShellView, columns = 80, rows = 24): readonly ReactElement[] {
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

describe('U96 · 恒在的兄弟节点按 key 配对（真光标不被重挂推着走）', () => {
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
    expect(after.length).toBe(before.length + 1)
    expect(after.filter((key) => key !== 'plan')).toEqual([...before])
  })
})
