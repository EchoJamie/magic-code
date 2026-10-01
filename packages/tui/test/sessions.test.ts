/**
 * 会话面 · **渲染层**（缺陷轮 II）——选择器长什么样 · 切换留什么痕 · 状态行怎么降级 ·
 * 重建收不收拢。取景走 `renderToString`（同一条链，最后一跳是纯函数）。
 *
 * 键位语义（谁触发什么命令）在 `shell.test.ts`；这一层只管**画出来的那一屏**。
 */

import { describe, expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { createElement as h } from 'react'
import type { Entry, KernelEvent, StatusLineCell } from '@magic/contracts'
import { AppView } from '../src/components/app.ts'
import { ALLOW_ALL_LABEL, StatusLine } from '../src/components/status.ts'
import type { StatusLineProps } from '../src/components/status.ts'
import { createShell } from '../src/shell.ts'
import type { ShellStatus } from '../src/view.ts'
import { HINT_IDLE, STATUS_LINE_DEFAULT, createView, patchStatus } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'
import { plain, show } from './screen.ts'
import type { Cell } from './screen.ts'

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

    // 用真链路：/resume
    const app2 = live()
    app2.feed([state(SESSION, [{ id: SESSION, title: '记录查询优化' }])])
    for (const char of '/resume')app2.shell.key({ kind: 'char', char })
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
    for (const char of '/resume')app.shell.key({ kind: 'char', char })
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

describe('状态行 · 可配与降级（U112）', () => {
  const status = (patch: Partial<ShellStatus> = {}): ShellStatus => ({
    state: 'idle',
    amount: null,
    session: '时区修正',
    model: 'MiniMax-M3',
    usage: 12400,
    window: null,
    reasoning: null,
    allowAll: false,
    hint: HINT_IDLE,
    ...patch,
  })

  /** 那一行画出来的字——缺省＝**没配过**（默认那条）。 */
  const line = (
    patch: Partial<ShellStatus> = {},
    extra: Partial<StatusLineProps> = {},
    columns = COLUMNS,
  ) =>
    plain(
      renderToString(
        h(StatusLine, {
          status: status(patch),
          columns,
          cells: STATUS_LINE_DEFAULT,
          color: true,
          workspace: null,
          ...extra,
        }),
        { columns },
      ),
    )

  /**
   * **锚（① 状态 ＋ ② 全放行）**——U112 起那一行分两层：
   *
   * - **锚**：永不省、不可配（「① 状态永不省」＋「看不见的裸奔是最坏的一形」）；
   * - **锚之后**：用户挑的那几格（挑哪几格、什么顺序、上不上色）。
   *
   * 这一条钉的是**形状那一维**：设计 ·「状态行可配置」那一行明写
   * 「圆点没问题；问题是「工作中／等你」**同形只靠颜色分** ⇒ 工作中 `●`、等你 `◊`」。
   */
  test('① 状态打头、量挂在它后面——**工作中与等你分形状**（不靠颜色也分得出）', () => {
    expect(line({ state: 'working', amount: '0.6s' })).toContain('● 工作中 0.6s')
    expect(line({ state: 'waiting', amount: '2/3' })).toContain('◊ 等你定夺 2/3')
    expect(line({ state: 'retrying', amount: '2/3' })).toContain('● 正在重试 2/3')
    expect(line({ state: 'error' })).toContain('▲ 出错')

    // **反面**：等你那一格**不是** `●`（改前正是它——同形只靠色的那一形）
    expect(line({ state: 'waiting' })).not.toContain('● 等你定夺')
  })

  /**
   * **默认那条**（设计：「默认给一条（不配也能用）」）——会话名 · 上下文占用。
   *
   * ⛔ **默认不放「用哪个模型」**：那是**配置回显**（设计那条边界：默认那条不放配置回显，
   * 用户**自己勾**才算他要的）。故那一格在这一条里是**反面**。
   */
  test('默认那条＝会话名 · 上下文占用；**模型（配置回显）不在默认里**', () => {
    const text = line()

    expect(text.indexOf('○ 空闲')).toBeLessThan(text.indexOf('时区修正'))
    expect(text.indexOf('时区修正')).toBeLessThan(text.indexOf('12.4k'))
    expect(text).not.toContain('MiniMax-M3')
  })

  test('挑哪几格、**什么顺序**——锚之后按给的那一列摆（顺序即屏上顺序）', () => {
    const text = line({}, { cells: ['model', 'session'] })

    expect(text.indexOf('MiniMax-M3')).toBeLessThan(text.indexOf('时区修正'))
    expect(text).not.toContain('12.4k') // 没挑的那一格不出现
  })

  /**
   * **某项当时不可用就整格省掉**（设计原话）——不占位、不显示空值。
   *
   * 判据落在**左段逐字**上：五格全挑、四格都拿不到值时，左段应当**一格不差**地剩下
   * 「① ＋ 会话名」——多一个空格、一个分隔点都算没做到「省掉」。
   */
  test('某一格不可用 ⇒ **整格省掉**（不占位、不显示空值）', () => {
    const text = line(
      { model: null, usage: null, reasoning: null },
      { cells: ['session', 'model', 'reasoning', 'context', 'workspace'], workspace: null },
    )

    expect(leftOf(text).trim()).toBe('○ 空闲 · 时区修正')
  })

  test('右位**独立**——出现 / 消失不推动左半', () => {
    const withHint = line({ hint: 'ctrl+c 停或离开' }, {}, 100)
    const without = line({ hint: '' }, {}, 100)

    expect(withHint.indexOf('○ 空闲')).toBe(without.indexOf('○ 空闲'))
    expect(withHint.indexOf('时区修正')).toBe(without.indexOf('时区修正'))
    expect(withHint).toContain('ctrl+c 停或离开')
  })

  test('还没有会话时，会话名那一格报「新会话」（不空一格）', () => {
    expect(line({ session: null })).toContain('新会话')
  })

  /**
   * **窄窗口从右往左省**——**让位的次序就是用户摆的次序**（挑格那一屏上排在前面的先保）。
   *
   * 这一条钉两件：① 状态那格**永不省**（视觉锚）；② 末尾那一格**先让位**。
   */
  test('窄窗口**从右往左省**：末尾那格先让位，① 永不省', () => {
    const cells: readonly StatusLineCell[] = ['session', 'model', 'context']

    expect(line({}, { cells })).toContain('12.4k')

    const narrow = line({}, { cells }, 52)
    expect(narrow).toContain('○ 空闲') // ① 是视觉锚——永不省
    expect(narrow).not.toContain('12.4k') // 排在最后的那格先让位
  })

  /**
   * **上色开关**（设计：「另有一个上色开关」）——关了整行不吃色。
   *
   * ⚠️ **这一条得走真终端那条路量**（帧文本那条先剥了 ANSI，色在它上面看不见
   * ——见 `screen.ts` 文件头那两条路）。故走 `AppView` ＋ `show()`（它开着色）。
   */
  test('上色开关：关了整行**一格都不吃色**（每格都是默认色）', async () => {
    const rowOf = async (color: boolean): Promise<readonly Cell[]> => {
      const view = patchStatus(
        createView({ statusLine: { cells: [...STATUS_LINE_DEFAULT], color } }),
        { session: '时区修正', usage: 12400 },
      )
      const frame = await show([view], { columns: COLUMNS, rows: ROWS })
      const at = frame.screen.lines.findIndex((one) => one.includes('空闲'))

      return frame.cellsOf(at)
    }

    expect((await rowOf(true)).some((cell) => cell.fg !== null)).toBe(true)
    expect((await rowOf(false)).every((cell) => cell.fg === null)).toBe(true)
  })

  /**
   * U73 · **全放行那一格**——`设计/工具执行与权限`：
   * 「**这不是配置，是状态** ⇒ 常驻。**用户必须随时看得见自己在全放行**」。
   *
   * ⚠️ **U112 起它不在「可挑的那一列」里**（`STATUS_LINE_CELLS` 头注）：挑不了的东西摆进
   * 可选项清单就是骗人——它的四条判据照旧：**在** · **位置**（① 之后、② 之前）·
   * **不在** · **永不省**。
   */
  describe('全放行那一格（U73）', () => {
    const cells: readonly StatusLineCell[] = ['session', 'model', 'context']

    test('全放行时就有——挂在 ① 之后、② 之前（那几格次序一字不动）', () => {
      const text = line({ allowAll: true }, { cells })

      expect(text).toContain(ALLOW_ALL_LABEL)
      expect(text.indexOf('○ 空闲')).toBeLessThan(text.indexOf(ALLOW_ALL_LABEL))
      expect(text.indexOf(ALLOW_ALL_LABEL)).toBeLessThan(text.indexOf('时区修正'))
      expect(text.indexOf('时区修正')).toBeLessThan(text.indexOf('MiniMax-M3'))
      expect(text.indexOf('MiniMax-M3')).toBeLessThan(text.indexOf('12.4k'))
    })

    test('不在全放行时**整格不存在**——其余几格一字不动（左段逐字比）', () => {
      const off = line({ allowAll: false }, { cells })
      const on = line({ allowAll: true }, { cells })

      expect(off).not.toContain(ALLOW_ALL_LABEL)
      expect(leftOf(on).replace(` · ${ALLOW_ALL_LABEL}`, '')).toBe(leftOf(off))
    })

    test('**永不省**——三档宽度下都在（它跟 ① 一样是常驻，可挑那几格才让位）', () => {
      for (const columns of [100, 60, 30]) {
        const text = line({ allowAll: true }, { cells }, columns)

        expect(text).toContain('○ 空闲')
        expect(text).toContain(ALLOW_ALL_LABEL)
      }
    })

    /**
     * ⚠️ **它要占宽度**，这一条把话说明白（别把它读成「多一格什么也没发生」）。
     *
     * 这条判据钉的是**降级那条规矩没变**，不是「阈值没变」：可挑那几格让位的次序还是
     * **从右往左**，第 ① 位与全放行那一格**一格都不省**；而这一格**实打实占 9 列**
     * （` · 全放行`），左段因此宽了 9 列——在某个宽度带上，同一屏会比不在全放行时
     * **早让一步**。那是「多了一格」的算术，不是规矩变了：**全放行时活下来的那几格，
     * 永远是不在全放行时活下来的那几格的子集**。
     */
    test('降级的**规矩**没变——可挑那几格只可能**更早**让位，次序与「谁永不省」都不动', () => {
      const droppable = ['时区修正', 'MiniMax-M3', '12.4k']

      for (let columns = 30; columns <= 120; columns += 2) {
        const off = line({ allowAll: false }, { cells }, columns)
        const on = line({ allowAll: true }, { cells }, columns)

        // 永不省那两格：任何宽度都在
        expect(on).toContain('○ 空闲')
        expect(on).toContain(ALLOW_ALL_LABEL)

        // 可挑那几格：全放行时活下来的，必是不在全放行时活下来的**子集**（只少不多）
        const keptOff = droppable.filter((cell) => off.includes(cell))
        const keptOn = droppable.filter((cell) => on.includes(cell))
        expect(keptOn.every((cell) => keptOff.includes(cell))).toBe(true)

        // 次序照旧：活下来的那几格在两种情形下都是同一个先后
        const order = (text: string) => droppable.filter((cell) => text.includes(cell))
        expect(order(on)).toEqual(keptOn)
        expect(order(off)).toEqual(keptOff)
      }
    })

    test('够宽时**那几格齐**——多出来的那一格不是拿谁换的', () => {
      const text = line({ allowAll: true }, { cells })

      expect(text).toContain('○ 空闲')
      expect(text).toContain(ALLOW_ALL_LABEL)
      expect(text).toContain('时区修正')
      expect(text).toContain('MiniMax-M3')
      expect(text).toContain('12.4k')
    })
  })
})


/** 一行的**左段**（`space-between` 之前那一截）——右位是独立一栏，位置随左段走。 */
function leftOf(text: string): string {
  return text.split(/\s{2,}/)[0] ?? ''
}

// ⚠️ **删掉过一节**（U31 三轮）：『空态判定（缺陷 D3）』——它量的是开机那句引导语
//    （`你按下第一次回车时才建立`）在不在。那句 2026-09-20 由用户定删（没有动作价值，
//    原型早已删掉，见 `app.ts` 的注）⇒ 判据没了载体，那一节随之去掉；
//    `createView` 那个 import 只被它用着，一并不再引入。

