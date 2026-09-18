/**
 * 一屏快照（U09）——**渲染起步**，U20 / U21 在此之上打磨。
 *
 * 取景方式：事件经 `reduce` 走真归约 → `AppView` 渲染成字符串（`renderToString`——
 * 同步、不开终端、`columns` 定宽）。于是快照钉住的是**整条链**（事件 → 视图 → 一屏），
 * 而非手搓的视图对象。
 *
 * 快照文件：`test/__snapshots__/snapshot.test.ts.snap`（入库——改动即进 diff 可评审）。
 */

import { describe, expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { createElement as h } from 'react'
import type { KernelEvent } from '@magic/contracts'
import { AppView } from '../src/components/app.ts'
import { appendEcho, appendSessionList, createView, reduce } from '../src/view.ts'
import type { ShellView } from '../src/view.ts'
import { event } from './events.ts'

const COLUMNS = 80

/** 一屏渲染成字符串（取景用——同一条链，只有最后一跳是纯函数）。 */
function screen(view: ShellView, draft = ''): string {
  return renderToString(h(AppView, { view, draft }), { columns: COLUMNS })
}

function viewed(events: readonly KernelEvent[], from: ShellView = createView()): ShellView {
  return events.reduce(reduce, from)
}

describe('一屏 · 空屏与输入', () => {
  test('启动即用——开场提示与输入行在位', () => {
    expect(screen(createView())).toMatchSnapshot()
  })

  test('交代写完还没发——输入行的草稿显示出来', () => {
    expect(screen(createView(), '看下工作区')).toMatchSnapshot()
  })

  test('交代已发——对话流里留下用户那一行', () => {
    expect(screen(appendEcho(createView(), '看下工作区'))).toMatchSnapshot()
  })
})

describe('一屏 · 流式', () => {
  test('思考与正文各成块（流式累积中途的样子）', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.call.start', { model: 'MiniMax-M3' }),
      event('model.delta', { channel: 'thinking', text: '先看看工作区。' }),
      event('model.delta', { channel: 'text', text: '好，我跑一下 ——' }),
    ])

    expect(screen(view)).toMatchSnapshot()
  })

  test('工具调用流式（参数还没到齐）', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '我调用 exec：' }),
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'tc_1', text: '{"cmd":"ls"' }),
    ])

    expect(screen(view)).toMatchSnapshot()
  })
})

describe('一屏 · 审批', () => {
  test('审批提示 · 重 —— 必闸类不给「总是允许」，屏上说清缘由', () => {
    const view = viewed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event(
        'tool.decision.request',
        {
          call: 71,
          name: 'exec',
          material: '在工作区根执行：ls\n（只读，不改动任何文件）',
          weight: 'heavy',
        },
        { id: 88 },
      ),
    ])

    expect(screen(view, '继续')).toMatchSnapshot()
  })

  test('审批提示 · 轻 —— 三个答复键（「总是允许」在这里，且写明管多久）', () => {
    const view = viewed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event(
        'tool.decision.request',
        {
          call: 71,
          name: 'exec',
          material: '在工作区根执行：ls\n（只读，不改动任何文件）',
          weight: 'light',
        },
        { id: 88 },
      ),
    ])

    expect(screen(view, '继续')).toMatchSnapshot()
  })
})

describe('一屏 · 工具执行与收束', () => {
  test('工具输出两路流 ＋ 结果 ＋ 裁决留痕', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.delta', { channel: 'toolcall', name: 'exec', id: 'tc_1', text: '{"cmd":"ls"}' }),
      event('tool.call', { name: 'exec', args: { cmd: 'ls' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: 'ls', weight: 'light' },
        { id: 88 },
      ),
      event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 1200 }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'README.md\npackages\n' }),
      event('tool.output.delta', { call: 71, channel: 'stderr', text: 'ls: 无此目录：tmp\n' }),
      event('tool.result', { call: 71, ok: true, output: { text: 'README.md\npackages\n' } }),
      event('model.delta', { channel: 'text', text: '看完了：目录是干净的。' }),
      event('model.usage', { inputTokens: 1284, outputTokens: 96 }),
      event('turn.end', { reason: 'settled' }),
    ], appendEcho(createView(), '跑一下 ls'))

    expect(screen(view)).toMatchSnapshot()
  })

  test('未获批准——结果说明未执行', () => {
    const view = viewed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'rm -rf tmp' } }, { id: 71 }),
      event(
        'tool.decision.request',
        { call: 71, name: 'exec', material: 'rm -rf tmp', weight: 'heavy' },
        { id: 88 },
      ),
      event('tool.decision', { call: 71, decision: 'reject', decider: 'user', elapsedMs: 3000 }),
      event('tool.result', { call: 71, ok: false, output: { text: '（未获批准，未执行）' } }),
      event('turn.end', { reason: 'settled' }),
    ], appendEcho(createView(), '跑一下 ls'))

    expect(screen(view)).toMatchSnapshot()
  })

  test('大负载转存——结果只留 blob 引用（外壳不解析）', () => {
    const view = viewed([
      event('turn.start', {}),
      event('tool.call', { name: 'exec', args: { cmd: 'cat big' } }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { blob: 'blob_7' } }),
      event('turn.end', { reason: 'settled' }),
    ], appendEcho(createView(), '跑一下 ls'))

    expect(screen(view)).toMatchSnapshot()
  })
})

describe('一屏 · 供应商与退避重试（第 17 轮补锚）', () => {
  test('退避期间屏上有话说 —— 「正在重试（第 n 次，x 秒后）」，不是一动不动', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.delta', { channel: 'text', text: '让我想想 ——' }),
      event('model.retry', { attempt: 2, delayMs: 1500, tier: 'transient' }),
    ])

    expect(screen(view)).toMatchSnapshot()
  })

  test('状态行显示当前供应商 / 模型 —— 取自真跑过的那次调用', () => {
    const view = viewed([event('model.call.start', { model: 'glm-4.6', provider: 'zhipu' })])

    expect(screen(view)).toMatchSnapshot()
  })
})

describe('一屏 · 会话面（U16）', () => {
  /** 一份目录——三条，中间那条是当前；第三条没标题（退回 id）。 */
  const CATALOG = [
    { id: 's-a', title: '看看工作区里有什么', at: 1_700_000_003_000 },
    { id: 's-b', title: '跑一下测试', at: 1_700_000_002_000 },
    { id: 's-c', at: 1_700_000_001_000 },
  ]

  test('会话目录 —— 序号可记 · 当前那条有标记 · 标题缺席退回 id', () => {
    const view = viewed([event('session.state', { active: 's-b', sessions: CATALOG })])

    expect(screen(appendSessionList(view))).toMatchSnapshot()
  })

  test('切到另一条 —— **重开一屏** ＋ 一句「已切到」；状态行报当前会话', () => {
    const before = viewed(
      [event('session.state', { active: 's-b', sessions: CATALOG })],
      appendEcho(createView(), '跑一下测试'),
    )
    const after = viewed([event('session.state', { active: 's-a', sessions: CATALOG })], before)

    expect(screen(after)).toMatchSnapshot()
  })

  test('忙时切不动 —— 屏上出声，原来那一屏不动', () => {
    const before = viewed(
      [event('session.state', { active: 's-b', sessions: CATALOG })],
      appendEcho(createView(), '跑一下测试'),
    )
    const after = viewed(
      [
        event('session.state', {
          active: 's-b',
          sessions: CATALOG,
          note: '正在跑一轮——先 Ctrl+C 中断，再切会话（同一时刻只有一个活跃会话）',
        }),
      ],
      before,
    )

    expect(screen(after)).toMatchSnapshot()
  })
})

describe('一屏 · 异常与中断', () => {
  test('错误行分档呈现', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.error', { tier: 'context-limit', message: '上下文超了' }),
      event('error', { message: '内核自身异常' }, { turn: null }),
      event('turn.end', { reason: 'error' }),
    ])

    expect(screen(view)).toMatchSnapshot()
  })

  test('中断——本轮以 aborted 收束', () => {
    const view = viewed([
      event('turn.start', {}),
      event('model.delta', { channel: 'text', text: '好，我跑一下 ——' }),
      event('turn.end', { reason: 'aborted' }),
    ], appendEcho(createView(), '看下工作区'))

    expect(screen(view)).toMatchSnapshot()
  })
})
