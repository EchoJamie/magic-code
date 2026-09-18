/**
 * 交互（缺陷轮 II）——**真按键**走活体渲染：打字 / 回车 / 接管 / Ctrl+C 语义。
 *
 * 这一层测的是键从 Ink 到外壳那一跳（`toShellKeys` ＋ `TuiApp`），比外壳用例多出来的
 * 正是这一跳：快照测不到它，而它正是用户手上那件事。
 *
 * ⚠️ **假终端是取件的**（`ink-testing-library`，U23 换）——U09 当时手搓过一份
 * （`ink-harness.ts`：一对假流 ＋ `debug: true` 的 Ink）。那份已删：它做的正是这个库做的事，
 * 而按当前口径**取件优先**（少一处自己维护的假流）。本文件只剩两点胶水，
 * 都是库**不提供**而这一层真要用的：
 *
 * - `ready()`——**Ink 接管 stdin 之前敲的键会静默丢掉**（实测踩过），故敲键前先等监听挂上；
 * - `waitForFrame / waitForExit`——库只给 `frames` / `lastFrame()`（同步快照），
 *   而 Ink 的渲染是**异步**的，断言前得等画面跟上。
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink-testing-library'
import { createElement as h } from 'react'
import type { Command, KernelEvent } from '@magic/contracts'
import { TuiApp } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain } from './screen.ts'

const POLL_MS = 5
const TIMEOUT_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 库转出来的那一坨（只要用到的那几样）。 */
type Ui = ReturnType<typeof render>

/**
 * 帧 → **只剩文字与布局**（剥掉 ANSI）。
 *
 * ⚠️ **不剥就是缺陷 D17**：`ink-testing-library` 交的是**带色码的帧**（有 `FORCE_COLOR` 时），
 * 而这一层的断言全是「屏上有没有这一段文字」——色码插在中间，子串**不再连续**，
 * 于是三条用例**每次都要白等满 2 秒超时**才红（实测：`FORCE_COLOR=3` 下三条各耗 2050ms）。
 * 色不在这一层量（要量色去 `screen.ts` 那条真终端的路）。
 */
function plainFrame(ui: Ui): string {
  return plain(ui.lastFrame() ?? '')
}

/** 等一帧满足条件（超时抛——时间给了，还是没等到就是真没渲染出来）。 */
async function waitForFrame(
  ui: Ui,
  predicate: (frame: string) => boolean,
  label?: string,
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS

  while (Date.now() < deadline) {
    const frame = plainFrame(ui)
    if (predicate(frame)) return frame
    await sleep(POLL_MS)
  }

  throw new Error(`等不到满足条件的帧${label === undefined ? '' : `（${label}）`}：\n${plainFrame(ui)}`)
}

/** 起一个活壳：外壳 ＋ 间谍传输（可按需投事件）。 */
function liveApp() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  const ui = render(h(TuiApp, { shell }))

  /** 等 Ink 真正接管 stdin——`useInput` 的 effect 先于 App 挂监听，故 `readable` 在监听上，两个都就位了。 */
  const ready = async (): Promise<void> => {
    const stdin = ui.stdin as unknown as EventEmitter
    const deadline = Date.now() + TIMEOUT_MS

    while (Date.now() < deadline) {
      if (stdin.listenerCount('readable') > 0) return
      await sleep(POLL_MS)
    }

    throw new Error('Ink 未接管 stdin——`readable` 监听没挂上')
  }

  const app = {
    /** 最近一帧（还没渲染过则为空串）——同样**先归一化**（见 `plainFrame`）。 */
    frame: (): string => plainFrame(ui),

    /** 敲键（`\r` 回车 · `\u0003` Ctrl+C · `\u000f` ctrl+o · `y` / `n` 答复）。 */
    type: async (data: string): Promise<void> => {
      await ready()
      ui.stdin.write(data)
    },

    waitForFrame: (predicate: (frame: string) => boolean, label?: string) =>
      waitForFrame(ui, predicate, label),

    /**
     * 等进程退出（Ink 的 `exit()`）。
     *
     * 库不转出 Ink 的 `waitUntilExit`，故认**收尾帧**：退出时 Ink 写最后一笔
     * （`log.done()`），此后 `lastFrame()` 只剩空白（实测：内容帧 → `"\n"`）。
     */
    waitForExit: () => waitForFrame(ui, (frame) => frame.trim() === '', '退出'),

    unmount: () => ui.unmount(),
  }

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

    await app.type('\u0004') // Ctrl+D
    await app.type('\u001b[1;5C') // Ctrl+右（转义序列）
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
    await app.type('\u0003')

    await app.waitForExit()
    app.unmount()
  })

  test('工作中 —— 中断本轮，不退出', async () => {
    const { app, commands, push } = liveApp()

    await push([event('turn.start', {})], (frame) => frame.includes('● 工作中'))
    await app.type('\u0003')

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

    await app.type('\u000f') // ctrl+o
    await app.waitForFrame((frame) => frame.includes('第二行想法'))

    app.unmount()
  })
})
