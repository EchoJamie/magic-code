import { expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import { appendReceipt, createView, reduce } from '../src/view.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

test('首条已落账输入确认会话；清空不保留空 ID，也不读取空历史', () => {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  try {
    spy.emit(event('message.user', { entry: 1 }, { session: 'persisted' }))
    expect(shell.getView().sessionId).toBe('persisted')
    const page = shell.getView().page
    shell.key({ kind: 'char', char: '/clear' })
    shell.key({ kind: 'enter' })
    expect(spy.commands.at(-1)).toEqual({ type: 'session.new' })
    spy.emit(event('session.state', { active: '', sessions: [] }, { session: '' }))
    expect(shell.getView().sessionId).toBeNull()
    expect(shell.getView().page).toBe(page + 1)
    expect(spy.commands.some(command => command.type === 'history.read')).toBe(false)
  } finally { shell.dispose() }
})

test('空白页也能清屏；忙时拒绝清屏不改变页与记录', () => {
  const view = appendReceipt(createView(), '待清的回执')
  const state = event('session.state', { active: '', sessions: [] }, { session: '' })
  const cleared = reduce(view, state, { turn: 'new' })
  expect(cleared.sessionId).toBeNull()
  expect(cleared.page).toBe(view.page + 1)
  expect(cleared.settled.some(row => row.kind === 'receipt')).toBe(false)
  const rejected = reduce(view, event('session.state', { ...state.data, note: '正在跑一轮' }), { turn: 'new' })
  expect(rejected.page).toBe(view.page)
  expect(rejected.settled).toEqual(view.settled)
})

for (const acknowledged of [false, true]) {
  test(`执行者退出：${acknowledged ? '已接收输入不重复恢复' : '未接收输入回到草稿'}`, () => {
    const spy = createSpyTransport()
    let detached: () => void = () => {}
    const shell = createShell(spy.transport, { detached: listener => { detached = () => listener('启动失败') } })
    try {
      shell.key({ kind: 'char', char: '待提交的输入' })
      shell.key({ kind: 'enter' })
      const command = spy.commands.at(-1)
      if (command?.type !== 'input.submit') throw new Error('未提交输入')
      if (acknowledged) spy.emit(event('input.settled', { ref: command.ref!, ok: true }))
      detached()
      expect(shell.getView().draft).toBe(acknowledged ? '' : '待提交的输入')
    } finally { shell.dispose() }
  })
}

test('执行者退出不覆盖后来编辑的新稿', () => {
  const spy = createSpyTransport()
  let detached: () => void = () => {}
  const shell = createShell(spy.transport, { detached: listener => { detached = () => listener('启动失败') } })
  try {
    shell.key({ kind: 'char', char: '旧输入' })
    shell.key({ kind: 'enter' })
    shell.key({ kind: 'char', char: '新稿' })
    detached()
    expect(shell.getView().draft).toBe('新稿')
  } finally { shell.dispose() }
})
