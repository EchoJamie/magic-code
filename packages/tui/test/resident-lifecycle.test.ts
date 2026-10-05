import { expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'

test('执行者已核销后撤去失效裁决，归还草稿并保留记录', () => {
  const spy = createSpyTransport()
  let detached: (why: string) => void = () => {}
  const shell = createShell(spy.transport, { detached: (listener) => { detached = listener } })
  for (const char of '未发送草稿') shell.key({ kind: 'char', char })
  spy.emit(event('turn.start', {}))
  spy.emit(event('tool.call', { name: 'exec', args: { cmd: 'echo fixture' } }, { id: 71 }))
  spy.emit(event('tool.decision.request', { call: 71, name: 'exec', material: 'echo fixture', weight: 'light' }, { id: 88 }))
  shell.key({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
  expect(shell.getView().dock.kind).toBe('decision')
  detached('执行者已退出')
  expect(shell.getView().dock.kind).toBe('input')
  expect(shell.getView().draft).toBe('未发送草稿')
  expect(shell.getView().status.state).toBe('idle')
  expect(shell.getView().settled.some((row) => row.kind === 'tool' && row.state === 'unexecuted')).toBe(true)
  shell.dispose()
})

test('App退出留屏且不自动重开，明确ctrl+r成功后仍不自动发送草稿', async () => {
  const spy = createSpyTransport()
  let opens = 0
  const shell = createShell(spy.transport, { reopen: async () => { opens++ } })
  for (const char of '继续之前先检查') shell.key({ kind: 'char', char })
  shell.hostGone()
  shell.key({ kind: 'enter' })
  expect(opens).toBe(0)
  expect(spy.commands).toHaveLength(0)
  expect(shell.getView().draft).toBe('继续之前先检查')
  expect(shell.getView().status.hint).toContain('Magic Code 已退出')
  shell.key({ kind: 'ctrl+r' })
  await Bun.sleep(0)
  expect(opens).toBe(1)
  expect(shell.getView().draft).toBe('继续之前先检查')
  expect(spy.commands.filter((command) => command.type === 'input.submit')).toHaveLength(0)
  shell.key({ kind: 'enter' })
  expect(spy.commands.filter((command) => command.type === 'input.submit')).toHaveLength(1)
  shell.dispose()
})

test('U114 执行者收束不收走本地阅读层，也不把已记录命令误还为未发送稿', () => {
  const spy = createSpyTransport()
  let detach: (why: string) => void = () => {}
  const shell = createShell(spy.transport, { detached: listener => { detach = listener } })
  shell.releaseInput()
  shell.key({kind:'paste',text:'/resume '})
  shell.key({kind:'enter'})
  spy.emit(event('session.state', {active:'',sessions:[]}))
  expect(shell.getView().dock.kind).toBe('picker')
  detach('执行者已退出')
  expect(shell.getView().dock.kind).toBe('picker')
  expect(shell.getView().draft).toBe('')
  shell.key({kind:'escape'})
  expect(shell.getView().draft).toBe('')
  shell.key({kind:'ctrl+p'})
  expect(shell.getView().draft).toBe('/resume ')
  shell.dispose()
})
