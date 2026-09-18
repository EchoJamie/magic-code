/**
 * 外壳 · 会话面（U16）——列表 / 切换 / 改名，以及**切换＝重开一屏**。
 *
 * 两半：
 * - **视图归约**——`session.state` 怎么落到一屏（当前会话记哪儿、什么时候清屏、
 *   什么时候列目录）；
 * - **会话壳**——`/session` 那条斜杠命令怎么变成控制面上的命令（以及**变不成时**怎么办：
 *   本地就说清楚，不发一条注定没用的命令）。
 *
 * 一条贯穿的口径：**命令只发不收**——三支会话命令的答复都是 `session.state` 事件，
 * 外壳据 `active` 变没变决定要不要重开一屏。
 */

import { describe, expect, test } from 'bun:test'
import type { SessionSummary } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import { appendSessionList, createView, reduce } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

/** 一份目录——三条，中间那条是当前。 */
const CATALOG: readonly SessionSummary[] = [
  { id: 's-a', title: '甲的事', at: 1_700_000_003_000 },
  { id: 's-b', title: '乙的事', at: 1_700_000_002_000 },
  { id: 's-c', at: 1_700_000_001_000 },
]

function state(data: {
  readonly active: string
  readonly sessions?: readonly SessionSummary[]
  readonly note?: string
}) {
  return event('session.state', {
    active: data.active,
    sessions: data.sessions ?? CATALOG,
    ...(data.note === undefined ? {} : { note: data.note }),
  })
}

// ══ 视图归约 ══════════════════════════════════════════════════════════

describe('视图 · 会话状态', () => {
  test('首次到达：记下当前会话与目录，**不动对话流**', () => {
    const view = reduce(createView(), state({ active: 's-b' }))

    expect(view.status.session).toEqual({ id: 's-b', title: '乙的事' })
    expect(view.sessions).toEqual(CATALOG)
    // 首见不是「切换」——启动那一刻没有旧屏可清，也没什么可说的
    expect(view.items).toEqual([])
  })

  test('当前会话没变：不重开一屏、不重复说', () => {
    const first = reduce(createView(), state({ active: 's-b' }))
    const second = reduce(first, state({ active: 's-b' }))

    expect(second.items).toEqual([])
    expect(second.status.session).toEqual({ id: 's-b', title: '乙的事' })
  })

  test('切换（当前会话换了）：**重开一屏** ＋ 一句「已切到」', () => {
    const before = reduce(
      reduce(createView(), state({ active: 's-b' })),
      event('message.user', { entry: 1 }),
    )
    expect(before.items.length).toBeGreaterThan(0)

    const after = reduce(before, state({ active: 's-a' }))

    // 旧的对话流清掉——上一屏说的是另一条会话的事，留着就是骗人
    expect(after.items).toHaveLength(1)
    expect(after.items[0]).toMatchObject({ kind: 'notice', text: '已切到会话：甲的事' })
    expect(after.status.session).toEqual({ id: 's-a', title: '甲的事' })
  })

  test('切换后重开的那一屏，内容只属于新会话', () => {
    const first = reduce(createView(), state({ active: 's-b' }))
    const switched = reduce(first, state({ active: 's-c' }))

    // 新会话没有标题——报 id（缺席可辨，屏上不必编一个名字）
    expect(switched.items[0]).toMatchObject({ kind: 'notice', text: '已切到会话：s-c' })
    expect(switched.status.session).toEqual({ id: 's-c', title: null })
  })

  test('有事要说（note）就单起一条提示——切换与否都算', () => {
    const first = reduce(createView(), state({ active: 's-b' }))
    const refused = reduce(first, state({ active: 's-b', note: '正在跑一轮——先 Ctrl+C 中断' }))

    expect(refused.items).toHaveLength(1)
    expect(refused.items[0]).toMatchObject({ kind: 'notice', text: '正在跑一轮——先 Ctrl+C 中断' })
    // 没切成就没清屏——原来那一屏还在
    expect(refused.status.session).toEqual({ id: 's-b', title: '乙的事' })
  })

  test('当前会话不在目录里——照样报得出来（id 兜底）', () => {
    const view = reduce(createView(), state({ active: 's-没见过的' }))

    expect(view.status.session).toEqual({ id: 's-没见过的', title: null })
  })
})

describe('视图 · 会话目录块（列表＝要看得见的那一种）', () => {
  test('列出来——带序号、标题、当前那条有标记', () => {
    const view = appendSessionList(reduce(createView(), state({ active: 's-b' })))
    const item = view.items.at(-1)

    expect(item).toMatchObject({
      kind: 'sessions',
      active: 's-b',
      rows: [
        { index: 1, id: 's-a', title: '甲的事' },
        { index: 2, id: 's-b', title: '乙的事' },
        { index: 3, id: 's-c', title: 's-c' },
      ],
    })
  })

  test('一个会话都没有——也有一条说得清的（不是空白）', () => {
    const view = appendSessionList(reduce(createView(), state({ active: 's-a', sessions: [] })))

    expect(view.items.at(-1)).toMatchObject({ kind: 'sessions', rows: [] })
  })
})

// ══ 会话壳（斜杠命令 → 控制面命令）══════════════════════════════════

describe('会话壳 · /session 三形', () => {
  test('`/session` → 问一次目录；答复到了就在屏上列出来', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('/session')
    expect(spy.commands).toEqual([{ type: 'session.list' }])
    // 命令本身照旧回显（与 `/model` 同法——打过的字看得见）；目录还没到，故只有回显
    expect(shell.getView().items.map((item) => item.kind)).toEqual(['user'])

    spy.emit(state({ active: 's-b' }))
    expect(shell.getView().items.map((item) => item.kind)).toEqual(['user', 'sessions'])
    expect(shell.getView().items.at(-1)).toMatchObject({ kind: 'sessions', active: 's-b' })
  })

  test('没问目录时，状态事件不往对话流里塞目录块（切换 ≠ 列目录）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    spy.emit(state({ active: 's-b' }))

    expect(shell.getView().items).toEqual([])
    expect(shell.getView().sessions).toEqual(CATALOG)
  })

  test('`/session new` → 新建一条', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('/session new')

    expect(spy.commands).toEqual([{ type: 'session.new' }])
  })

  test('`/session 1` → 切到目录里第 1 条（按序号解析成 id）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state({ active: 's-b' }))

    shell.submit('/session 1')

    // 序号不是 id——发出去的是目录里那一条的真身
    expect(spy.commands).toEqual([{ type: 'session.open', session: 's-a' }])
  })

  test('`/session title <文本>` → 改当前会话的标题', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state({ active: 's-b' }))

    shell.submit('/session title 换个名字')

    expect(spy.commands).toEqual([
      { type: 'session.rename', session: 's-b', title: '换个名字' },
    ])
  })
})

describe('会话壳 · 变不成的那些——本地就说清楚，不发命令', () => {
  test('序号越界', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state({ active: 's-b' }))

    shell.submit('/session 9')

    expect(spy.commands).toEqual([])
    expect(shell.getView().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  test('序号不是数', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state({ active: 's-b' }))

    shell.submit('/session 甲')

    expect(spy.commands).toEqual([])
    expect(shell.getView().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  test('改标题却没给文本', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state({ active: 's-b' }))

    shell.submit('/session title')

    expect(spy.commands).toEqual([])
    expect(shell.getView().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })

  test('还没问到目录就按序号切', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('/session 1')

    expect(spy.commands).toEqual([])
    expect(shell.getView().items.at(-1)).toMatchObject({ kind: 'notice', tone: 'error' })
  })
})

describe('会话壳 · 不吃人话', () => {
  test('`/sessions` 这类近似写法照旧发给模型（不做模糊匹配）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('/sessions 里有什么')

    expect(spy.commands).toEqual([{ type: 'input.submit', text: '/sessions 里有什么' }])
  })

  test('以斜杠开头的路径照旧发给模型（用户嘴里说出一个路径是常事）', () => {
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)

    shell.submit('/usr/bin 里有什么')

    expect(spy.commands).toEqual([{ type: 'input.submit', text: '/usr/bin 里有什么' }])
  })
})
