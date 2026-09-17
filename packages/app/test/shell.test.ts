/**
 * 外壳位（`--script` 驱动 · `./shell.ts`）——判据：**答复的加宽位过得去**。
 *
 * 这个驱动是**验收装置的协议那一半**（无人值守跑全链）。第 15 轮它表达不了
 * 「总是允许」——`decide` 只返回 `Decision`、`ShellScript.decisions` 是 `Decision[]`——
 * 于是「批准 ＋ 记住」这条链**没法脚本化真跑**。本轮的判据就是补上这个位，且**向后兼容**：
 * 旧写法（裸 `Decision`、`() => 'approve'`）一字不动照常工作。
 *
 * 这里用**最小假传输**（不起装配、不碰模型）：测的是钩子到消息那一跳。
 */

import { describe, expect, test } from 'bun:test'
import type { Command, ControlTransport, Decision, KernelEvent } from '@magic/contracts'
import { attachShell, runShellScript } from '../src/index.ts'

/** 一次询问（配对键＝**请求事件** id）。 */
function request(id: number): KernelEvent {
  return {
    id,
    session: 's1',
    turn: null,
    at: 0,
    kind: 'tool.decision.request',
    data: { call: 71, name: 'exec', material: 'ls', weight: 'light' },
  }
}

/** 「回到等待输入」——`submit` 的水位等的是它。 */
function waiting(): KernelEvent {
  return { id: 999, session: 's1', turn: null, at: 0, kind: 'agent.state', data: { state: 'waiting' } }
}

/**
 * 最小假外壳侧一端。
 *
 * `askOnSubmit` 模拟「这一趟交代期间内核侧发生的事」：**先按序问、再回等待输入**
 * （次序与真内核一致——`submit` 的水位先记后发，故这一点必须在 `send` 的同一步发生）。
 */
function fakeTransport(askOnSubmit: readonly number[] = []) {
  const sent: Command[] = []
  let listener: ((event: KernelEvent) => void) | undefined

  const transport: ControlTransport = {
    send: (command) => {
      sent.push(command)
      if (command.type !== 'input.submit') return

      for (const id of askOnSubmit) listener?.(request(id))
      listener?.(waiting())
    },
    subscribe: (next) => {
      listener = next
      return () => {
        listener = undefined
      }
    },
  }

  return {
    transport,
    sent,
    /** 手推一条询问。 */
    ask: (id: number): void => listener?.(request(id)),
  }
}

describe('壳钩子 · 答复的加宽位', () => {
  test('`decide` 返回对象形 —— 答复带上 `remember` 位（批准 ＋ 记住）', () => {
    const shell = fakeTransport()
    const handle = attachShell(shell.transport, {
      decide: () => ({ decision: 'approve', remember: true }),
    })

    shell.ask(88)

    expect(shell.sent).toEqual([
      { type: 'decision.answer', id: 88, decision: 'approve', remember: true },
    ])
    handle.dispose()
  })

  test('`decide` 返回裸 `Decision` —— 答复里**没有那个键**（旧写法向后兼容）', () => {
    const shell = fakeTransport()
    const legacy = (): Decision => 'approve'
    const handle = attachShell(shell.transport, { decide: legacy })

    shell.ask(88)

    // 键**在不在**是判据：`remember: undefined` 过不了通道的可序列化门（丢键＝有损）
    expect(shell.sent).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])
    expect('remember' in (shell.sent[0] ?? {})).toBe(false)
    handle.dispose()
  })

  test('答复留痕原样记 —— 给了就在、没给就不在（与真外壳同形）', () => {
    const shell = fakeTransport()
    let first = true
    const handle = attachShell(shell.transport, {
      decide: () => {
        const answer = first ? { decision: 'approve' as const, remember: true } : 'reject'
        first = false
        return answer
      },
    })

    shell.ask(88)
    shell.ask(89)

    expect(handle.decisions).toEqual([
      { id: 88, name: 'exec', material: 'ls', weight: 'light', decision: 'approve', remember: true },
      { id: 89, name: 'exec', material: 'ls', weight: 'light', decision: 'reject' },
    ])
    handle.dispose()
  })
})

describe('壳脚本 · 决策清单也收对象形', () => {
  test('`decisions` 按询问次序取 —— 混着写（裸词与对象形）都认', async () => {
    const shell = fakeTransport([88, 89])

    await runShellScript(shell.transport, {
      inputs: ['跑两遍同样的命令'],
      decisions: ['approve', { decision: 'approve', remember: true }],
    })

    // 第一条是 input.submit；其后是两次答复——次序即清单次序
    expect(shell.sent).toEqual([
      { type: 'input.submit', text: '跑两遍同样的命令' },
      { type: 'decision.answer', id: 88, decision: 'approve' },
      { type: 'decision.answer', id: 89, decision: 'approve', remember: true },
    ])
  })

  test('清单用尽 → 回落 `options.decide`（脚本不必逐条写全）', async () => {
    const shell = fakeTransport([88, 89])

    await runShellScript(
      shell.transport,
      { inputs: ['跑'], decisions: [{ decision: 'approve', remember: true }] },
      { decide: () => 'reject' },
    )

    expect(shell.sent.slice(1)).toEqual([
      { type: 'decision.answer', id: 88, decision: 'approve', remember: true },
      { type: 'decision.answer', id: 89, decision: 'reject' },
    ])
  })
})
