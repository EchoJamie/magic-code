/**
 * 外壳 · 协议侧（U09）——命令经控制面收发，不碰内核。
 *
 * 三条纪律在此钉住：
 * ① **先接订阅、后放开输入**（构造即订阅——命令只可能在订阅之后发出）；
 * ② **裁决配对键＝请求事件 id**（不是 `call`——M03 备案点名的坑）；
 * ③ **只认 `ControlTransport`**（发命令 / 收事件；传输由外部注入，外壳不构造）。
 */

import { describe, expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createScriptedKernel, createSpyTransport } from './fakes.ts'

describe('装配纪律 · 先接订阅、后放开输入', () => {
  test('构造即订阅——命令只可能在订阅之后发出', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('跑一下 ls')

    expect(spy.calls).toEqual(['subscribe', 'send'])
  })

  test('退订后不再发命令（外壳已收摊）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.dispose()
    shell.submit('跑一下 ls')

    expect(spy.listenerCount()).toBe(0)
    expect(spy.commands).toEqual([])
  })
})

describe('命令 · 用户输入', () => {
  test('提交发 `input.submit`，并立即本地回显', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('跑一下 ls')

    expect(spy.commands).toEqual([{ type: 'input.submit', text: '跑一下 ls' }])
    expect(shell.getView().items).toHaveLength(1)
    expect(shell.getView().items[0]).toMatchObject({ kind: 'user', text: '跑一下 ls' })
  })

  test('空白输入不发命令、不回显', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('   ')
    shell.submit('')

    expect(spy.commands).toEqual([])
    expect(shell.getView().items).toEqual([])
  })

  test('首尾空白去掉再发', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('  看下目录  ')

    expect(spy.commands).toEqual([{ type: 'input.submit', text: '看下目录' }])
  })
})

describe('命令 · 裁决答复', () => {
  test('答复带回**请求事件**的 id（配对键）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    spy.emit(
      event('tool.decision.request', {
        call: 71,
        name: 'exec',
        material: 'rm -rf x',
        weight: 'heavy',
      }, { id: 88 }),
    )
    shell.answer('approve')

    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])
  })

  test('「总是允许」——答复带上 `remember` 位（批准 ＋ 记住）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    spy.emit(
      event('tool.decision.request', {
        call: 71,
        name: 'exec',
        material: 'ls',
        weight: 'light',
      }, { id: 88 }),
    )
    shell.answer('approve', { remember: true })

    expect(spy.commands).toEqual([
      { type: 'decision.answer', id: 88, decision: 'approve', remember: true },
    ])
  })

  test('不给 `remember` —— 答复里**没有那个键**（向后兼容：与阶段 1 逐字同义）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    spy.emit(
      event('tool.decision.request', {
        call: 71,
        name: 'exec',
        material: 'ls',
        weight: 'light',
      }, { id: 88 }),
    )
    shell.answer('approve')

    expect(spy.commands).toEqual([{ type: 'decision.answer', id: 88, decision: 'approve' }])
    // 键**在不在**也算判据：`remember: undefined` 过不了通道的可序列化门（丢键＝有损），
    // 故「没给」必须表现为**键不出现**，而不是键在值为 undefined。
    expect('remember' in (spy.commands[0] ?? {})).toBe(false)
  })

  test('无待裁决时不发答复', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.answer('approve')

    expect(spy.commands).toEqual([])
  })

  test('答复后提示撤下——不再重复答复', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    spy.emit(
      event('tool.decision.request', {
        call: 71,
        name: 'exec',
        material: 'ls',
        weight: 'light',
      }, { id: 88 }),
    )
    shell.answer('reject')
    shell.answer('reject')

    expect(spy.commands).toHaveLength(1)
    expect(shell.getView().pending).toBeNull()
  })
})

describe('命令 · 中断', () => {
  test('中断发 `turn.interrupt`', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.interrupt()

    expect(spy.commands).toEqual([{ type: 'turn.interrupt' }])
  })
})

describe('事件 · 订阅与通知', () => {
  test('事件归约进视图，订阅者被通知', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    let notified = 0
    shell.subscribe(() => {
      notified += 1
    })

    spy.emit(event('model.delta', { channel: 'text', text: '嗨' }))

    expect(shell.getView().items[0]).toMatchObject({ kind: 'assistant', text: '嗨' })
    expect(notified).toBe(1)
  })

  test('退订后事件不再进视图', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.dispose()
    spy.emit(event('model.delta', { channel: 'text', text: '嗨' }))

    expect(shell.getView().items).toEqual([])
  })
})

describe('端到端（脚本化假内核）', () => {
  test('交代 → 流式 → 审批 → 答复 → 结果 —— 一屏走完一轮', () => {
    const kernel = createScriptedKernel()
    const shell = createShell(kernel.shell)

    shell.submit('看下工作区')
    const asked = shell.getView()

    // 流式：正文与思考各成块；工具条目已被 `tool.call` 认领
    expect(asked.status.phase).toBe('busy')
    expect(asked.items.map((item) => item.kind)).toEqual(['user', 'thinking', 'assistant', 'tool'])
    expect(asked.items[2]).toMatchObject({ text: '收到：「看下工作区」。我跑一下 ——' })
    expect(asked.pending).toMatchObject({ name: 'exec', weight: 'heavy', material: '在工作区根执行：ls' })

    shell.answer('approve')
    const done = shell.getView()

    expect(done.pending).toBeNull()
    expect(done.status).toMatchObject({ phase: 'idle', turnEnd: 'settled', model: 'faux-kernel' })
    expect(done.status.usage).toEqual({ inputTokens: 1284, outputTokens: 96 })
    expect(done.items.map((item) => item.kind)).toEqual([
      'user',
      'thinking',
      'assistant',
      'tool',
      'assistant',
    ])
    expect(done.items[3]).toMatchObject({
      kind: 'tool',
      name: 'exec',
      verdict: { decision: 'approve' },
      result: { ok: true },
      output: [{ channel: 'stdout', text: 'README.md\npackages\n' }],
    })

    kernel.stop()
  })

  test('中断——脚本作废，轮以 aborted 收束', () => {
    const kernel = createScriptedKernel()
    const shell = createShell(kernel.shell)

    shell.submit('看下工作区')
    shell.interrupt()

    expect(shell.getView().status).toMatchObject({ phase: 'idle', turnEnd: 'aborted' })

    kernel.stop()
  })
})
