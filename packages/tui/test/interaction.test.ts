/**
 * 交互（缺陷轮 II）——**真按键**走活体渲染：打字 / 回车 / 接管 / Ctrl+C 语义。
 *
 * 这一层测的是键从 Ink 到外壳那一跳（`toShellKeys` ＋ `TuiApp`），比外壳用例多出来的
 * 正是这一跳：快照测不到它，而它正是用户手上那件事。
 */

import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import type { Command, KernelEvent } from '@magic/contracts'
import { TuiApp } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
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
    commands: (): readonly Command[] => spy.commands,
    /** 投事件并等画面跟上。 */
    async push(events: readonly KernelEvent[], expectFrame?: (frame: string) => boolean) {
      for (const item of events) spy.emit(item)
      if (expectFrame !== undefined) await app.waitForFrame(expectFrame)
    },
  }
}

describe('输入行', () => {
  test('打字显示在输入行，回车提交并清空', async () => {
    const { app, commands } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('看下工作区')
    await app.waitForFrame((frame) => frame.includes('› 看下工作区'))

    await app.type('\r')
    await app.waitForFrame((frame) => frame.includes('交代一件事'))

    expect(commands()).toEqual([{ type: 'input.submit', text: '看下工作区' }])

    app.unmount()
  })

  test('控制键不往输入框里塞字（Ctrl+D 不是字母 d）', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('ok')
    await app.waitForFrame((frame) => frame.includes('› ok'))

    await app.type('') // Ctrl+D
    await app.type('[1;5C') // Ctrl+右（转义序列）
    await app.type('!')
    await app.waitForFrame((frame) => frame.includes('› ok!'))

    app.unmount()
  })
})

describe('审批答复（接管）', () => {
  test('提示出现 → 输入行换成「等你的答复」；按 `y` 作答', async () => {
    const { app, commands, push } = liveApp()

    // 先等首帧落上再投事件（Ink 接管 stdin 之前投的事件不会丢——视图是外壳的；
    // 但首帧没出来时 `frame()` 是空的，断言会瞎等）
    await app.waitForFrame((frame) => frame.includes('交代一件事'))

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'exec', material: '命令 ls', weight: 'light' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('等你的答复'),
    )

    await app.type('y')
    expect(commands()).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])

    // 裁决落定（内核回 `tool.decision`）才解除接管——输入行回到常态
    await push([event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 300 })],
      (frame) => frame.includes('交代一件事'))

    app.unmount()
  })

  test('必闸类按 `a` —— 不发命令，屏上多一句缘由（`▲ …`）', async () => {
    const { app, commands, push } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'write', args: { path: 'a' } }, { id: 71 }),
        event(
          'tool.decision.request',
          { call: 71, name: 'write', material: '覆盖 a', weight: 'heavy' },
          { id: 88 },
        ),
      ],
      (frame) => frame.includes('等你的答复'),
    )

    await app.type('a')
    await app.waitForFrame((frame) => frame.includes('必闸类不可'))

    expect(commands()).toEqual([])

    app.unmount()
  })

  test('等裁决时打的字不进输入框——忽略但当场说一句', async () => {
    const { app, push } = liveApp()

    await push(
      [
        event('turn.start', {}),
        event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
        event('tool.decision.request', { call: 71, name: 'exec', material: 'ls', weight: 'light' }, { id: 88 }),
      ],
      (frame) => frame.includes('等你的答复'),
    )

    await app.type('x')
    await app.waitForFrame((frame) => frame.includes('先答复'))

    app.unmount()
  })
})

describe('Ctrl+C 语义', () => {
  test('空闲 —— 退出', async () => {
    const { app } = liveApp()

    await app.waitForFrame((frame) => frame.includes('交代一件事'))
    await app.type('')

    await app.waitForExit()
    app.unmount()
  })

  test('工作中 —— 中断本轮，不退出', async () => {
    const { app, commands, push } = liveApp()

    await push([event('turn.start', {})], (frame) => frame.includes('● 工作中'))
    await app.type('')

    expect(commands()).toEqual([{ type: 'turn.interrupt' }])
    // 还活着（没退出）：再敲一个字仍在输入框
    await app.type('a')
    await app.waitForFrame((frame) => frame.includes('› a'))

    app.unmount()
  })
})

describe('展开 / 折叠', () => {
  test('`ctrl+o` 展开——思考从一行变成全文', async () => {
    const { app, push } = liveApp()

    await push([
      event('model.delta', { channel: 'thinking', text: '第一行想法\n第二行想法' }),
    ])
    await app.waitForFrame((frame) => frame.includes('（思考）'))

    await app.type('') // ctrl+o
    await app.waitForFrame((frame) => frame.includes('第二行想法'))

    app.unmount()
  })
})
