/**
 * 交互（U09）——真按键走活体渲染：打字 / 回车 / 审批答复 / Ctrl+C 语义。
 *
 * 这一层测的是 `TuiApp`（订阅 ＋ 键盘），比归约层多出的是**键盘到命令**的那一跳：
 * 快照测不到它，而它正是用户手上那件事。
 */

import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import type { KernelEvent } from '@magic/contracts'
import { TuiApp } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createScriptedKernel, createSpyTransport } from './fakes.ts'
import type { SpyTransport } from './fakes.ts'
import { renderTui } from './ink-harness.ts'

/** 起一个活壳：外壳 ＋ 间谍传输（可按需投事件）。 */
function liveApp(columns = 80) {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  const app = renderTui(h(TuiApp, { shell }), { columns })

  return {
    spy,
    shell,
    app,
    /** 投事件并等画面跟上。 */
    async push(events: readonly KernelEvent[], expectFrame?: (frame: string) => boolean) {
      for (const item of events) spy.emit(item)
      if (expectFrame !== undefined) await app.waitForFrame(expectFrame)
    },
  }
}

describe('输入行', () => {
  test('打字显示在输入行，回车提交并清空', async () => {
    const { spy, app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('› 交代一件事'))

    await app.type('看下工作区')
    await app.waitForFrame((frame) => frame.includes('› 看下工作区'))

    await app.type('\r')
    await app.waitForFrame((frame) => frame.includes('› 交代一件事'))

    expect(spy.commands).toEqual([{ type: 'input.submit', text: '看下工作区' }])

    app.unmount()
  })

  test('控制键不往输入框里塞字（Ctrl+D 不是字母 d）', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('› 交代一件事'))

    await app.type('ok')
    await app.waitForFrame((frame) => frame.includes('› ok'))

    // Ctrl+D / Ctrl+A ——Ink 把控制字符解成「字母 ＋ ctrl」，不被拦就会被当正文打进去
    await app.type('\x04')
    await app.type('\x01')

    // 再打一个可见字符逼出下一帧：控制键若漏进去，这里就是 `› okdaz` 而非 `› okz`
    await app.type('z')
    await app.waitForFrame((frame) => frame.includes('› okz'))

    app.unmount()
  })

  test('退格修掉一个字符', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('› 交代一件事'))

    await app.type('abc')
    await app.waitForFrame((frame) => frame.includes('› abc'))

    await app.type('\x7f')
    await app.waitForFrame((frame) => frame.includes('› ab'))

    app.unmount()
  })
})

describe('审批答复', () => {
  test('提示出现 → 按 y 答复（配对键＝请求事件 id）', async () => {
    const { spy, app, push } = liveApp()

    await push(
      [
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: '在工作区根执行：ls', weight: 'heavy' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('需要裁决') && frame.includes('在工作区根执行：ls'),
    )

    await app.type('y')
    await app.waitForFrame((frame) => !frame.includes('需要裁决'))

    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    app.unmount()
  })

  test('按 n 则拒绝', async () => {
    const { spy, app, push } = liveApp()

    await push(
      [
        event('tool.call', { name: 'exec', args: { cmd: 'rm -rf x' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: 'rm -rf x', weight: 'heavy' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('需要裁决'),
    )

    await app.type('n')
    await app.waitForFrame((frame) => !frame.includes('需要裁决'))

    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'reject' }])

    app.unmount()
  })

  test('按 a ——「总是允许」（批准 ＋ `remember` 位；轻的询问才有这一键）', async () => {
    const { spy, app, push } = liveApp()

    await push(
      [
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: 'ls', weight: 'light' },
          { id: 88 },
        ),
      ],
      // 键位**写在屏上**才算到位（「总是允许」是本屏新增的那一键，用户不必记）
      (frame) => frame.includes('需要裁决') && frame.includes('a 总是允许'),
    )

    await app.type('a')
    await app.waitForFrame((frame) => !frame.includes('需要裁决'))

    expect(spy.commands).toEqual([
      { type: 'decision.answer', id: 88, decision: 'approve', remember: true },
    ])

    app.unmount()
  })

  test('重的询问按 a 不发命令——必闸类是禁区（屏上明说，键也真的不生效）', async () => {
    const { spy, app, push } = liveApp()

    await push(
      [
        event('tool.call', { name: 'exec', args: { cmd: 'rm -rf x' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: 'rm -rf x', weight: 'heavy' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('需要裁决') && frame.includes('必闸类不可「总是允许」'),
    )

    await app.type('a')
    expect(spy.commands).toEqual([])

    // 询问还在（没被按掉）——再按 y 照常答复
    await app.type('y')
    await app.waitForFrame((frame) => !frame.includes('需要裁决'))
    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    app.unmount()
  })

  test('等裁决时打的字不进输入框（先答复，草稿留着）', async () => {
    const { spy, app, push } = liveApp()

    await push(
      [
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: 'ls', weight: 'light' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('需要裁决'),
    )

    await app.type('x')
    await app.type('y')
    await app.waitForFrame((frame) => frame.includes('› 交代一件事'))

    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    app.unmount()
  })
})

describe('Ctrl+C 语义', () => {
  test('空闲 —— 退出', async () => {
    const { app, spy } = liveApp()

    await app.waitForFrame((frame) => frame.includes('空闲'))

    await app.type('\x03')
    await app.waitForExit()

    // 退出不是中断：不该发命令
    expect(spy.commands).toEqual([])
  })

  test('工作中 —— 中断（不退出）', async () => {
    const { app, spy, push } = liveApp()

    await push([event('turn.start', {})], (frame) => frame.includes('工作中'))

    await app.type('\x03')
    // 命令发出后由内核收束（间谍传输不会自己回——手动补 `turn.end`）
    await push([event('turn.end', { reason: 'aborted' })], (frame) => frame.includes('○ 空闲'))

    expect(spy.commands).toEqual([{ type: 'turn.interrupt' }])
    // 中断 ≠ 退出：应用还在（帧仍有输入行）
    expect(app.frame()).toContain('› 交代一件事')

    app.unmount()
  })

  test('等裁决时 Ctrl+C —— 指轮中断（不把答复替你做了）', async () => {
    const { app, spy, push } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: 'ls', weight: 'light' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('需要裁决'),
    )

    await app.type('\x03')
    await push([event('turn.end', { reason: 'aborted' })], (frame) => frame.includes('○ 空闲'))

    expect(spy.commands).toEqual([{ type: 'turn.interrupt' }])

    app.unmount()
  })
})

describe('端到端（脚本化假内核 ＋ 活体渲染）', () => {
  test('交代 → 见流式与审批 → 答复 → 见结果', async () => {
    const kernel = createScriptedKernel({ stepMs: 0 })
    const shell = createShell(kernel.shell)
    const app = renderTui(h(TuiApp, { shell }))

    await app.waitForFrame((frame) => frame.includes('还没有对话'))

    // 交代
    await app.type('看下工作区')
    await app.type('\r')
    await app.waitForFrame(
      (frame) => frame.includes('需要裁决') && frame.includes('在工作区根执行：ls'),
      '审批提示',
    )

    const asked = app.frame()
    expect(asked).toContain('（思考）先看看工作区。')
    expect(asked).toContain('收到：「看下工作区」。我跑一下 ——')
    expect(asked).toContain('▸ 工具 exec {"cmd":"ls"}')
    expect(asked).toContain('● 工作中')

    // 答复
    await app.type('y')
    await app.waitForFrame((frame) => frame.includes('看完了：工作区里是 README.md 与 packages。'), '结果')

    const done = app.frame()
    expect(done).toContain('stdout › README.md')
    expect(done).toContain('✓ 完成')
    expect(done).toContain('· 裁决：批准')
    expect(done).toContain('上轮 正常收束')

    kernel.stop()
    app.unmount()
  })
})

/** 让 TS 认住夹具类型（`SpyTransport` 在断言里用到）。 */
export type { SpyTransport }
