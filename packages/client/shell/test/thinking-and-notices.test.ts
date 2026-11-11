/** 真实终端中的完成呈现与思考布局回归。 */

import { describe, expect, test } from 'bun:test'
import type { RunNotice } from '@magic/contracts'
import { event } from './events.ts'
import { createStage, showScreen } from './screen.ts'
import { createShell } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'

/** 起一个壳，并投一条会话状态（与 `log-presentation.test.ts` 同一份底子）。 */
function live() {
  const stage = createStage()
  stage.feed([event('session.state', { active: 's1', sessions: [{ archived: false, id: 's1', at: 0, title: '时区修正' }] })])

  return stage
}

/** 一条通知（只给这一处判据要的那几格）。 */
const notice = (kind: RunNotice['kind'], detail?: string): RunNotice => ({
  id: `${kind}:1`,
  session: 's1',
  kind,
  at: 1_000,
  ...(detail === undefined ? {} : { detail }),
  unread: true,
})

// ══ ① 「那一轮跑完了」那条回执：**不再产出** ═════════════════════════

describe('「跑完了」那条回执', () => {
  test('阅读屏打开期间不冒认主屏呈现，返回原会话后完成已读确认', async () => {
    const { render } = await import('ink'), { createElement: h } = await import('react')
    const { PassThrough } = await import('node:stream')
    const { TuiApp } = await import('../src/components/app.ts')
    const { FakeTty } = await import('./terminal.ts')
    const spy = createSpyTransport(), marks: (readonly string[])[] = []
    let notify: (notice: RunNotice) => void = () => {}
    const shell = createShell(spy.transport, { magicBase: '/test/.magic', notices: listener => { notify = listener }, markRead: ids => marks.push(ids), reopen: async () => {} })
    spy.emit(event('session.state', { active: 's1', sessions: [] }))
    spy.emit(event('model.delta', { channel: 'text', text: '返回后仍可见的原回复' }, { session: 's1' }))
    spy.emit(event('message.assistant', { entry: 100 }, { session: 's1' }))
    spy.emit(event('turn.end', { reason: 'settled' }, { session: 's1' }))
    const stdout = new FakeTty(100, 40)
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
    const app = render(h(TuiApp, { shell }), { stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, maxFps: 0 })
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 1000
      while (!check() && Date.now() < deadline) await Bun.sleep(5)
      expect(check()).toBe(true)
    }
    try {
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      stdin.write('\u000f')
      await until(() => stdout.bytes().includes('\u001b[?1049h'))
      notify({ ...notice('done'), source: { session: 's1', entry: 100 } })
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([])
      stdin.write('\u001b')
      await until(() => stdout.bytes().includes('\u001b[?1049l'))
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([['done:1']])
      const next = { ...notice('done'), id: 'after-disconnect', source: { session: 's1', entry: 100 } }
      shell.disconnected('受控断线')
      notify(next)
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([['done:1']])
      shell.key({ kind: 'ctrl+r' })
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([['done:1'], ['after-disconnect']])
    } finally { app.unmount(); shell.dispose(); stdin.destroy() }
  })

  test('实际回复渲染后才确认完成事项；无正文、其他来源和重复通知不误读', async () => {
    const { render } = await import('ink'), { createElement: h } = await import('react')
    const { TuiApp } = await import('../src/components/app.ts')
    const { FakeStdin, FakeTty } = await import('./terminal.ts')
    const spy = createSpyTransport(), marks: (readonly string[])[] = []
    let notify: (notice: RunNotice) => void = () => {}
    const shell = createShell(spy.transport, { magicBase: '/test/.magic', notices: listener => { notify = listener }, markRead: ids => marks.push(ids) })
    spy.emit(event('session.state', { active: 's1', sessions: [] }))
    spy.emit(event('model.delta', { channel: 'text', text: '原回复完整保留' }, { session: 's1' }))
    spy.emit(event('message.assistant', { entry: 100 }, { session: 's1' }))
    spy.emit(event('turn.end', { reason: 'settled' }, { session: 's1' }))
    const done: RunNotice = { ...notice('done', '截短的通知摘要…'), source: { session: 's1', entry: 100 } }
    notify(done)
    expect(marks).toHaveLength(0)
    const stdout = new FakeTty(100, 40)
    const app = render(h(TuiApp, { shell }), { stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: new FakeStdin() as unknown as NodeJS.ReadStream, exitOnCtrlC: false, patchConsole: false, maxFps: 0 })
    try {
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(stdout.bytes()).toContain('原回复完整保留')
      expect(stdout.bytes()).not.toContain('本轮已完成')
      expect(stdout.bytes()).not.toContain('截短的通知摘要')
      expect(marks).toEqual([[done.id]])
      notify(done)
      notify({ ...done, id: 'other-session', session: 's2' })
      notify({ ...done, id: 'other-source', source: { session: 's2', entry: 100 } })
      notify({ ...done, id: 'empty-turn', source: { session: 's1', event: 101 } })
      notify({ ...done, id: 'missing-entry', source: { session: 's1', entry: 102 } })
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([[done.id]])
      spy.emit(event('model.delta', { channel: 'text', text: '下一轮的完整回复' }, { session: 's1' }))
      spy.emit(event('message.assistant', { entry: 103 }, { session: 's1' }))
      spy.emit(event('turn.end', { reason: 'settled' }, { session: 's1' }))
      notify({ ...done, id: 'next-turn', source: { session: 's1', entry: 103 } })
      await app.waitUntilRenderFlush(); await Bun.sleep(10)
      expect(marks).toEqual([[done.id], ['next-turn']])
    } finally { app.unmount(); shell.dispose() }
  })


})

// ══ ② 思考自成一块：上下各留一整行 ═══════════════════════════════════

describe('思考自成一块', () => {
  test('`› …` ／ 空行 ／ `（思考 …）…` ／ 空行 ／ 助手正文（顶格，起无记号）——**上下各一整行**', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'thinking', text: '先想一下。' }),
      event('model.delta', { channel: 'text', text: '想好了。' }),
    ])

    const frame = await stage.screen()

    expect(frame.content.map((line) => line.text)).toEqual([
      '› 看看工作区',
      '',
      // ⚠️ **U112 起那一行带它自己那一段的计时**（用户 2026-10-01 定：「动效 ＋ 计时」）。
      //    这一趟只喂了**一条**思考增量，故那一段的时长就是它自己那一下（`0ms`，不编）；
      //    真跑时思考是成串吐的，那里会是 `3.4s` 这样的数。计时**收梢之后照留着**（那是事实）。
      '│ 先想一下。',
      '',
      '  想好了。',
    ])
  })

  test('**反面**：不带思考的那一轮**一字不动**（没思考就不撑行）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([event('model.delta', { channel: 'text', text: '想好了。' })])

    const frame = await stage.screen()

    // 与 U67 判准的那一形**逐字同**：`›` ／ 空行 ／ 助手正文（顶格）
    expect(frame.content.map((line) => line.text)).toEqual(['› 看看工作区', '', '  想好了。'])
  })

  test('块内紧凑：展开的那条思考**几行紧贴**（它自成一**块**，不是一行一块）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'thinking', text: '第一行\n第二行' }),
      event('model.delta', { channel: 'text', text: '好。' }),
    ])
    // ⚠️ **U110 起「展开」在查看那一屏上**（内联那一半恒折一行）——故这一条去那一屏量
    const frame = await showScreen(stage.shell.getView())

    // ⚠️ 用 `screen.lines` ＋ **按锚点切片**（不是 `content`）：`content` 切的是**内联那一版**
    //    的记录区（字标之下、上沿那条线之上），而那一屏没有那两条线——切法不适用。
    //    切片**保留那两行空行**（这条判据量的是「几行紧贴 ＋ 上下各留一整行」，空行正是它）。
    const rows = frame.screen.lines.map((line) => line.trim())
    const at = rows.indexOf('› 看看工作区')

    expect(rows.slice(at, at + 6)).toEqual([
      '› 看看工作区',
      '',
      '│ 第一行',
      '│ 第二行',
      '',
      '好。',
    ])
  })

  test('思考在**尾巴**上时不白留一行（它后面没有块）', async () => {
    const stage = live()
    stage.type('看看工作区')
    stage.press({ kind: 'enter' })
    stage.feed([
      event('model.delta', { channel: 'text', text: '先看。' }),
      event('model.delta', { channel: 'thinking', text: '再看一眼。' }),
    ])

    const frame = await stage.screen()

    expect(frame.content.map((line) => line.text)).toEqual([
      '› 看看工作区',
      '',
      '  先看。',
      '',
      '│ 再看一眼。',
    ])
  })
})
