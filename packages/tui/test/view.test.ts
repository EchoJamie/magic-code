/**
 * 视图模型（缺陷轮 II 重画）——**事件 → 一屏**的判据。
 *
 * 逐类覆盖：流式三通道 · 工具链（跑 / 完 / 被拒）· 裁决接管与草稿 · 回执与输出 ·
 * 状态行五态 · 会话与重建。取景一律走**真归约**（`reduce`），不手搓视图对象。
 */

import { describe, expect, test } from 'bun:test'
import type { Entry } from '@magic/contracts'
import {
  HINT_IDLE,
  HINT_WORKING,
  appendEcho,
  appendOutput,
  appendReceipt,
  createView,
  isSessionRow,
  rebuild,
  reduce,
} from '../src/view.ts'
import type { LogRow, ShellView } from '../src/view.ts'
import { event } from './events.ts'

const viewed = (events: readonly Parameters<typeof reduce>[1][], from: ShellView = createView()): ShellView =>
  events.reduce(reduce, from)

/**
 * 屏上的全部行（**定局那侧 ＋ 本轮**）。
 *
 * 第 21 轮起行分两侧：回执 / 命令输出 / 重建的内容走「定局」（写一次即入 scrollback），
 * 只有还在流式的那些留在本轮。断言「屏上有没有」时两处一起看。
 *
 * ⚠️ **不含启动字标**（TUI Banner）——**原锚**是「`settled` ＋ `rows` 原样」；
 * **为何变**：字标现在恒在 `settled[0]`（启动印一次，见 `src/banner.ts`）；
 * **新锚**是把那一行滤掉：本文件断言的全是**记录区的内容与骨架**
 * （「进了什么 / 重建回来什么 / 会话之间怎么切」），字标是**开局就在那儿**的装帧、
 * 不属于任何一条会话内容——它自己的判据在 `spec.banner.test.ts`。
 * 不滤的话，「记录区什么都不进」那类句子全要被一个恒在的装饰行顶红。
 */
const onScreen = (view: ShellView): readonly LogRow[] =>
  [...view.settled, ...view.rows].filter((row) => row.kind !== 'banner')

/** 一屏里的记录行 kind（断言骨架用）。 */
const kindsOf = (view: ShellView): readonly string[] => onScreen(view).map((row) => row.kind)

const rowAt = (view: ShellView, index: number): LogRow | undefined => onScreen(view)[index]

// ══ 流式 ═════════════════════════════════════════════════════════════

describe('流式（model.delta 三通道）', () => {
  test('正文与思考各成块——交替出现即分块', () => {
    const view = viewed([
      event('model.delta', { channel: 'text', text: '先看' }),
      event('model.delta', { channel: 'text', text: '一下。' }),
      event('model.delta', { channel: 'thinking', text: '想' }),
      event('model.delta', { channel: 'text', text: '好。' }),
    ])

    expect(kindsOf(view)).toEqual(['assistant', 'thinking', 'assistant'])
    expect(rowAt(view, 0)).toMatchObject({ text: '先看一下。' })
    expect(rowAt(view, 1)).toMatchObject({ text: '想' })
  })

  test('工具调用增量按供应商侧 id 分组——同轮两次调用不成一行', () => {
    const view = viewed([
      event('model.delta', { channel: 'toolcall', name: 'ls', id: 'c1', text: '{"path"' }),
      event('model.delta', { channel: 'toolcall', name: 'ls', id: 'c1', text: ':"."}' }),
      event('model.delta', { channel: 'toolcall', name: 'read', id: 'c2', text: '{"path":"a"}' }),
    ])

    const tools = view.rows.filter((row) => row.kind === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({ name: 'ls', argsText: '{"path":"."}' })
    expect(tools[1]).toMatchObject({ name: 'read' })
  })

  test('无 id 的增量并进最老的未配对工具行', () => {
    const view = viewed([
      event('model.delta', { channel: 'toolcall', name: 'ls', text: '{"a"' }),
      event('model.delta', { channel: 'toolcall', text: ':1}' }),
    ])

    expect(onScreen(view)).toHaveLength(1)
    expect(rowAt(view, 0)).toMatchObject({ argsText: '{"a":1}' })
  })
})

// ══ 工具链 ═══════════════════════════════════════════════════════════

describe('工具链（call → 询问 → 裁决 → 结果）', () => {
  test('`tool.call` 认领流式前情并落定参数——call 与 id 同指', () => {
    const view = viewed([
      event('model.delta', { channel: 'toolcall', name: 'ls', id: 'tc1', text: '{"path":"."}' }),
      event('tool.call', { name: 'ls', args: { path: '.' } }, { id: 71 }),
    ])

    expect(onScreen(view)).toHaveLength(1)
    expect(rowAt(view, 0)).toMatchObject({ kind: 'tool', call: 71, name: 'ls', state: 'running' })
  })

  test('结果落定——`ok: false` 记失败，输出按行摊开', () => {
    const view = viewed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: false, output: { text: '第一行\n第二行' } }, { id: 72 }),
    ])

    expect(rowAt(view, 0)).toMatchObject({ state: 'failed', output: ['第一行', '第二行'] })
  })

  test('被拒的裁决把工具行记成「未执行」', () => {
    const view = viewed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.decision', { call: 71, decision: 'reject', decider: 'user', elapsedMs: 900 }),
      event('tool.result', { call: 71, ok: false, output: { text: '（未获批准，未执行）' } }),
    ])

    // 被拒＝**未执行**（与「失败」两码事）；耗时走**墙钟**（发起 → 落地），
    // 不是裁决耗时（`tool.decision.elapsedMs` 是「提示 → 答复」那一段——第 22 轮改）
    expect(rowAt(view, 0)).toMatchObject({ state: 'rejected' })
  })

  test('大块转存——结果只留 blob 引用（外壳不解析）', () => {
    const view = viewed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.result', { call: 71, ok: true, output: { blob: 'blob_7' } }),
    ])

    expect(rowAt(view, 0)).toMatchObject({ output: ['（大块转存 blob_7）'] })
  })

  test('执行输出增量按行攒——末行继续接', () => {
    const view = viewed([
      event('tool.call', { name: 'ls', args: {} }, { id: 71 }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'a\nb' }),
      event('tool.output.delta', { call: 71, channel: 'stdout', text: 'c\nd' }),
    ])

    expect(rowAt(view, 0)).toMatchObject({ output: ['a', 'bc', 'd'] })
  })
})

// ══ 接管 ═════════════════════════════════════════════════════════════

describe('接管（裁决挂着时占住输入框）', () => {
  const ask = (weight: 'light' | 'heavy', id = 88) =>
    event('tool.decision.request', { call: 71, name: 'exec', material: '命令 ls', weight }, { id })

  test('裁决到了就接管——dock 换成裁决，状态行转「等你定夺」＋键位', () => {
    const view = viewed([ask('light')])

    expect(view.dock.kind).toBe('decision')
    expect(view.status).toMatchObject({ state: 'waiting', hint: 'y / a / n' })
  })

  test('必闸类（重）的键位少一个 `a`', () => {
    const view = viewed([ask('heavy')])

    expect(view.status.hint).toBe('y / n')
  })

  test('接管时**草稿收起来**——答完原样归还（不自动发送）', () => {
    // 插入点停在中间（`打了一|半`）——归还要**原样**放回这里，不是末尾（返工轮）
    const typed = { ...appendEcho(createView(), '打了一半'), draft: '打了一半', caret: 3 }
    const taken = reduce(typed, ask('light'))

    expect(taken.draft).toBe('')
    expect(taken.stashed).toEqual({ draft: '打了一半', caret: 3 })

    const answered = reduce(taken, event('tool.decision', { call: 71, decision: 'approve', decider: 'user', elapsedMs: 12 }))
    expect(answered.draft).toBe('打了一半')
    expect(answered.caret).toBe(3)
    expect(answered.stashed).toBeNull()
    expect(answered.dock.kind).toBe('input')
  })

  test('轮收束 ⇒ 撤卡 ＋ 归还草稿（那件工具跑不成了）', () => {
    const taken = reduce({ ...createView(), draft: '草稿' }, ask('light'))
    const ended = reduce(taken, event('turn.end', { reason: 'aborted' }))

    expect(ended.dock.kind).toBe('input')
    expect(ended.draft).toBe('草稿')
  })

  test('件数报两处——本轮有几件工具就报几件（单件不报）', () => {
    const one = viewed([event('tool.call', { name: 'ls', args: {} }, { id: 71 }), ask('light')])
    expect(one.dock.kind === 'decision' ? one.dock.pending.position : null).toBeNull()

    const three = viewed([
      event('tool.call', { name: 'a', args: {} }, { id: 71 }),
      event('tool.call', { name: 'b', args: {} }, { id: 72 }),
      event('tool.call', { name: 'c', args: {} }, { id: 73 }),
      event('tool.decision.request', { call: 73, name: 'c', material: 'm', weight: 'light' }, { id: 90 }),
    ])
    expect(three.dock.kind === 'decision' ? three.dock.pending.position : null).toEqual({ index: 3, total: 3 })
    expect(three.status.amount).toBe('3/3')
  })
})

// ══ 状态行 ═══════════════════════════════════════════════════════════

describe('状态行（五态固定词）', () => {
  test('空闲 → 工作中 → 空闲：状态词与右位提示同起同落', () => {
    const idle = createView()
    expect(idle.status).toMatchObject({ state: 'idle', hint: HINT_IDLE })

    const working = reduce(idle, event('turn.start', {}))
    expect(working.status).toMatchObject({ state: 'working', hint: HINT_WORKING })

    const done = reduce(working, event('turn.end', { reason: 'settled' }))
    expect(done.status).toMatchObject({ state: 'idle', hint: HINT_IDLE })
  })

  test('退避重试——状态词换掉，右位报「几秒后重发」', () => {
    const view = reduce(createView(), event('model.retry', { attempt: 2, delayMs: 1600, tier: 'transient' }))

    expect(view.status.state).toBe('retrying')
    expect(view.status.amount).toBe('2/3')
    expect(view.status.hint).toContain('1.6s')
  })

  test('模型名与用量随事件更新——③ 与 ④ 各自到位', () => {
    const view = viewed([
      event('model.call.start', { model: 'MiniMax-M3', provider: 'minimax' }),
      event('model.usage', { inputTokens: 3100, outputTokens: 40 }),
    ])

    expect(view.status.model).toBe('MiniMax-M3')
    expect(view.status.usage).toBe(3100)
  })

  test('出错 ⇒ `▲ 出错`；再开工 ⇒ 回「工作中」', () => {
    const failed = reduce(createView(), event('model.error', { tier: 'terminal', message: '停' }))
    expect(failed.status.state).toBe('error')

    const again = reduce(failed, event('turn.start', {}))
    expect(again.status.state).toBe('working')
  })

  test('**一次性的事进记录区**——换模型成功＝一行回执，不进状态行', () => {
    const view = reduce(
      createView(),
      event('model.switched', { ok: true, provider: 'minimax-m2', model: 'MiniMax-M2' }),
    )

    expect(rowAt(view, onScreen(view).length - 1)).toMatchObject({ kind: 'receipt' })
    const last = onScreen(view).at(-1)
    expect(last?.kind === 'receipt' ? last.text : '').toContain('MiniMax-M2')
    expect(view.status.model).toBe('MiniMax-M2')
  })
})

// ══ 会话与重建 ═══════════════════════════════════════════════════════

describe('会话与重建', () => {
  const state = (active: string, sessions: readonly { id: string; title?: string }[]) =>
    event('session.state', {
      active,
      sessions: sessions.map((row) => ({ id: row.id, at: 0, ...(row.title === undefined ? {} : { title: row.title }) })),
    })

  test('目录与当前会话落进视图——② 显示标题', () => {
    const view = reduce(createView(), state('s1', [{ id: 's1', title: '时区修正' }]))

    expect(view.status.session).toBe('时区修正')
    expect(view.catalog.map((row) => row.id)).toEqual(['s1'])
  })

  test('没有标题的会话——② 不编一个出来（屏上显示「新会话」由渲染层兜）', () => {
    const view = reduce(createView(), state('s1', [{ id: 's1' }]))

    expect(view.status.session).toBeNull()
    expect(view.catalog).toHaveLength(1)
  })

  test('**换了会话 ⇒ 记录区清空**（换一条＝换一屏，重建随后铺上）', () => {
    const before = reduce(appendEcho(createView(), '甲的事'), state('s1', [{ id: 's1' }]))
    const after = reduce(before, state('s2', [{ id: 's1' }, { id: 's2' }]))

    expect(after.rows).toEqual([])
    expect(after.sessionId).toBe('s2')
  })

  test('同一会话再报一次（问目录 / 改名）**不清屏**', () => {
    const before = reduce(appendEcho(createView(), '甲的事'), state('s1', [{ id: 's1' }]))
    const again = reduce(before, state('s1', [{ id: 's1', title: '改过的' }]))

    expect(again.rows).toHaveLength(1)
  })

  test('重建：条目配对成行（工具两条并一行）、屏上痕迹不回', () => {
    const entries: readonly Entry[] = [
      { id: 1, kind: 'user', content: { text: '看看有什么' }, at: 0 },
      { id: 2, kind: 'assistant', content: { text: '我列一下。' }, at: 1 },
      { id: 3, kind: 'tool-call', content: { text: '' }, payload: { name: 'ls', args: { path: '.' } }, at: 2 },
      { id: 4, kind: 'tool-result', content: { text: 'a.txt\nb.txt' }, payload: { ok: true, output: { text: 'a.txt\nb.txt' } }, at: 3 },
      { id: 5, kind: 'assistant', content: { text: '两个文件。' }, at: 4 },
    ]

    const view = rebuild(createView(), entries)

    expect(kindsOf(view)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(rowAt(view, 2)).toMatchObject({ kind: 'tool', name: 'ls', output: ['a.txt', 'b.txt'], state: 'ok' })
    expect(view.rows.every(isSessionRow)).toBe(true)
  })

  test('重建不吃屏上痕迹——回执与命令输出不进', () => {
    const withTraces = appendOutput(appendReceipt(createView(), '已切到 #2'), '可用命令', ['/help　这张表'])
    const view = rebuild(withTraces, [{ id: 1, kind: 'user', content: { text: '重新来' }, at: 0 }])

    expect(kindsOf(view)).toEqual(['user'])
  })
})

// ══ 屏上痕迹 ═════════════════════════════════════════════════════════

describe('屏上痕迹（不落库 · 不重建）', () => {
  test('回执行有 `·` 标记；命令输出是无标记的 dim 块', () => {
    const view = appendOutput(appendReceipt(createView(), '已切到 #2'), '可用命令', ['/help　这张表'])

    expect(rowAt(view, 0)).toMatchObject({ kind: 'receipt', text: '已切到 #2' })
    expect(rowAt(view, 1)).toMatchObject({ kind: 'output', lines: ['可用命令', '/help　这张表'] })
    expect(isSessionRow(rowAt(view, 0) as LogRow)).toBe(false)
    expect(isSessionRow(rowAt(view, 1) as LogRow)).toBe(false)
  })
})

// ══ 补：回显配平 · 陌生引用 · 错误分档 · 折叠与收拢 ═══════════════════

describe('回显与陌生引用', () => {
  test('`message.user` 配平本地回显——把 echoed 落回 false', () => {
    const echoed = appendEcho(createView(), '看下目录')
    expect(rowAt(echoed, 0)).toMatchObject({ kind: 'user', echoed: true })

    const paired = reduce(echoed, event('message.user', { entry: 7 }))
    expect(rowAt(paired, 0)).toMatchObject({ echoed: false })
  })

  test('没有回显可配（重建场景）——**不编一行出来**', () => {
    const view = reduce(createView(), event('message.user', { entry: 7 }))

    expect(onScreen(view)).toEqual([])
  })

  test('陌生 call 的结果 / 裁决——静默忽略（不炸、不新建行）', () => {
    const view = viewed([
      event('tool.result', { call: 999, ok: true, output: { text: 'x' } }),
      event('tool.decision', { call: 998, decision: 'approve', decider: 'user', elapsedMs: 1 }),
    ])

    expect(onScreen(view)).toEqual([])
  })
})

describe('错误分档（措辞进记录区）', () => {
  test('三档各说各的话，且状态行转 `▲ 出错`', () => {
    const tiers = ['transient', 'context-limit', 'terminal'] as const

    for (const tier of tiers) {
      const view = reduce(createView(), event('model.error', { tier, message: '炸了' }))
      expect(view.status.state).toBe('error')
      expect(rowAt(view, 0)).toMatchObject({ kind: 'receipt' })
    }

    expect(rowAt(reduce(createView(), event('model.error', { tier: 'transient', message: 'x' })), 0)).toMatchObject({
      text: '模型错误（瞬时）：x',
    })
    expect(rowAt(reduce(createView(), event('model.error', { tier: 'context-limit', message: 'x' })), 0)).toMatchObject({
      text: '模型错误（超限）：x',
    })
  })

  test('内核自身异常（`error`）——同样进记录区当回执，不占状态行', () => {
    const view = reduce(createView(), event('error', { message: '装配错了' }))

    expect(rowAt(view, 0)).toMatchObject({ kind: 'receipt', text: '内核异常：装配错了' })
    expect(view.status.state).toBe('error')
  })
})
