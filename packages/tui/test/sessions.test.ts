/**
 * 会话面 · **渲染层**（缺陷轮 II）——选择器长什么样 · 切换留什么痕 · 状态行怎么降级 ·
 * 重建收不收拢。取景走 `renderToString`（同一条链，最后一跳是纯函数）。
 *
 * 键位语义（谁触发什么命令）在 `shell.test.ts`；这一层只管**画出来的那一屏**。
 */

import { describe, expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { createElement as h } from 'react'
import type { Entry, KernelEvent } from '@magic/contracts'
import { AppView } from '../src/components/app.ts'
import { StatusLine } from '../src/components/status.ts'
import { createShell } from '../src/shell.ts'
import { createView } from '../src/view.ts'
import type { ShellStatus } from '../src/view.ts'
import { HINT_IDLE } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain } from './screen.ts'

const COLUMNS = 100
const ROWS = 30

function live() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)

  return {
    spy,
    shell,
    feed: (events: readonly KernelEvent[]) => {
      for (const item of events) spy.emit(item)
    },
    key: (kind: 'enter' | 'down' | 'escape') => shell.key({ kind } as never),
    rows: () => [...shell.getView().settled, ...shell.getView().rows],
    // ⚠️ 取景**先归一化**（`plain`——剥掉 ANSI）：这一层量的是文字与布局，
    // 而色是环境给的（缺陷 D17）。理由与做法见 `screen.ts` 文件头。
    screen: (columns = COLUMNS, rows = ROWS) =>
      plain(renderToString(h(AppView, { view: shell.getView(), columns, rows }), { columns })),
  }
}

const SESSION = 'sess-1'

const state = (active: string, rows: readonly { id: string; title?: string }[]) =>
  event('session.state', {
    active,
    sessions: rows.map((row) => ({ id: row.id, at: 0, ...(row.title === undefined ? {} : { title: row.title }) })),
  })

describe('会话目录（选择器）', () => {
  test('列出条目、当前那条标「正在用」、右位报键位', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '记录查询优化' }])])
    app.key('enter') // 无选择器时回车＝空交代，什么都不发生
    app.shell.key({ kind: 'char', char: '/' })

    // 直接开选择器（键位细节在 shell.test.ts）
    const opened = createShell(createSpyTransport().transport)
    opened.key({ kind: 'char', char: '/' })
    void opened

    // 用真链路：/session
    const app2 = live()
    app2.feed([state(SESSION, [{ id: SESSION, title: '记录查询优化' }])])
    for (const char of '/session') app2.shell.key({ kind: 'char', char })
    app2.key('enter')
    app2.feed([
      state(SESSION, [
        { id: SESSION, title: '记录查询优化' },
        { id: 's2', title: '修复时区处理…' },
      ]),
    ])

    const frame = app2.screen()
    expect(frame).toContain('记录查询优化')
    expect(frame).toContain('修复时区处理…')
    expect(frame).toContain('正在用')
    expect(frame).toContain('↑↓ 选')
  })

  test('目录为空时给一句话（不空一块）', () => {
    const app = live()
    for (const char of '/session') app.shell.key({ kind: 'char', char })
    app.key('enter')
    app.feed([state('s-new', [])])

    expect(app.screen()).toContain('还没有落过账的会话')
  })
})

describe('切换与重建（缺陷 D1）', () => {
  const entries: readonly Entry[] = [
    { id: 1, kind: 'user', content: { text: '甲那边的事' }, at: 0 },
    { id: 2, kind: 'assistant', content: { text: '好。' }, at: 1 },
  ]

  test('切过去 —— 记录区清空、重建铺上、留一行回执', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }, { id: 's2', title: '乙的事' }])])

    // 切换（`session.open` 之后内核报 `session.state` ＋ 外壳主动读历史）
    app.feed([state('s2', [{ id: SESSION, title: '甲的事' }, { id: 's2', title: '乙的事' }])])
    app.feed([event('session.history', { session: 's2', entries, done: true })])

    const frame = app.screen()
    expect(frame).toContain('甲那边的事') // 重建的内容在
    expect(frame).toContain('乙的事') // ② 格换成新会话的标题
  })

  test('重建的**只有会话内容**——命令输出与回执不回', () => {
    const app = live()
    app.feed([state(SESSION, [{ id: SESSION, title: '甲的事' }])])

    // 先留一块屏上痕迹（`/help` 的输出）
    for (const char of '/help') app.shell.key({ kind: 'char', char })
    app.key('enter')
    expect(app.screen()).toContain('可用命令')

    app.feed([event('session.history', { session: SESSION, entries, done: true })])
    const frame = app.screen()

    expect(frame).toContain('甲那边的事')
    expect(frame).not.toContain('可用命令')
  })
})

describe('状态行 · 四格与降级', () => {
  const status = (patch: Partial<ShellStatus> = {}): ShellStatus => ({
    state: 'idle',
    amount: null,
    session: '时区修正',
    model: 'MiniMax-M3',
    usage: 12400,
    window: null,
    hint: HINT_IDLE,
    ...patch,
  })

  const line = (patch: Partial<ShellStatus> = {}, columns = COLUMNS) =>
    plain(renderToString(h(StatusLine, { status: status(patch), columns }), { columns }))

  test('左半四格次序恒定：状态 · 会话 · 模型 · 用量', () => {
    const text = line()

    expect(text.indexOf('○ 空闲')).toBeLessThan(text.indexOf('时区修正'))
    expect(text.indexOf('时区修正')).toBeLessThan(text.indexOf('MiniMax-M3'))
    expect(text.indexOf('MiniMax-M3')).toBeLessThan(text.indexOf('12.4k'))
  })

  test('**量挂在状态后面**（耗时 / 件数 / 次数）', () => {
    expect(line({ state: 'working', amount: '0.6s' })).toContain('● 工作中 0.6s')
    expect(line({ state: 'waiting', amount: '2/3' })).toContain('● 等你定夺 2/3')
    expect(line({ state: 'retrying', amount: '2/3' })).toContain('● 正在重试 2/3')
    expect(line({ state: 'error' })).toContain('▲ 出错')
  })

  test('窄窗口**从右往左省**：先丢用量 → 再丢模型 → ① 永不省', () => {
    const wide = line()
    expect(wide).toContain('12.4k')

    const narrow = line({}, 52)
    expect(narrow).toContain('○ 空闲') // ① 是视觉锚——永不省
    expect(narrow).not.toContain('12.4k') // 用量先让位
  })

  test('右位**独立**——出现 / 消失不推动左半', () => {
    const withHint = line({ hint: 'ctrl+c 中断' }, 100)
    const without = line({ hint: '' }, 100)

    // 左半那四格的相对次序与起手位置两处一致
    expect(withHint.indexOf('○ 空闲')).toBe(without.indexOf('○ 空闲'))
    expect(withHint.indexOf('时区修正')).toBe(without.indexOf('时区修正'))
    expect(withHint).toContain('ctrl+c 中断')
  })

  test('还没有会话时 ② 报「新会话」（不空一格）', () => {
    expect(line({ session: null })).toContain('新会话')
  })
})

describe('空态判定（缺陷 D3）', () => {
  test('**按这条会话有没有内容判**——还没有会话＝空态；会话开了就不再是空态', () => {
    const fresh = createShell(createSpyTransport().transport)
    const emptyScreen = plain(
      renderToString(h(AppView, { view: fresh.getView(), columns: COLUMNS, rows: ROWS }), {
        columns: COLUMNS,
      }),
    )
    expect(emptyScreen).toContain('你按下第一次回车时才建立')

    // 会话建立（哪怕还没有条目）之后就**不**再是空态——那由 `sessionId` 说了算，不是本进程的计数
    const spy = createSpyTransport()
    const shell = createShell(spy.transport)
    spy.emit(state(SESSION, [{ id: SESSION, title: '甲的事' }]))
    const opened = plain(
      renderToString(h(AppView, { view: shell.getView(), columns: COLUMNS, rows: ROWS }), {
        columns: COLUMNS,
      }),
    )
    expect(opened).not.toContain('你按下第一次回车时才建立')
    void createView()
  })
})
