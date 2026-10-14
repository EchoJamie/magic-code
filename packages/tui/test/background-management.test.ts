import { expect, test } from 'bun:test'
import type { BackgroundCommand, BackgroundView } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import { backgroundKey } from '../src/background.ts'
import { collaborationStatus } from '../src/collaboration.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { collaborationFixture } from './collaboration-fixture.ts'
import { show } from './screen.ts'

const commands: BackgroundCommand[] = [
  { id: 'bg-1', execution: 'root-generation', session: 'origin', command: '主命令 · 持续服务', outputPath: '/tmp/主服务完整路径.log', state: 'running', startedAt: 1 },
  { id: 'bg-1', execution: 'member-generation', session: 'member', member: '同名成员', agent: 'worker', command: `中文测试 ${'参数很长 '.repeat(36)}\n第二行完整命令`, outputPath: `/tmp/${'很长的目录/'.repeat(15)}测试输出.log`, state: 'running', startedAt: 2 },
]
function fixture(collaboration = true) {
  const spy = createSpyTransport()
  const copied: string[] = []
  let background: BackgroundView = { commands, waiting: [] }
  const shell = createShell({ ...spy.transport, send(command) {
    spy.transport.send(command)
    if (command.type === 'collaboration.read') spy.emit(event('collaboration.view', collaboration ? collaborationFixture : { originSession: 'origin', members: [], delegations: [], waits: [], constraints: [] }, { session: 'origin' }))
    if (command.type === 'background.list') spy.emit(event('background.state', background, { session: 'origin' }))
  } }, { magicBase: '/test/.magic', copyText: async text => { copied.push(text) } })
  spy.emit(event('session.state', { active: 'origin', sessions: [{ id: 'origin', archived: false, at: 1 }] }, { session: 'origin' }))
  if (collaboration) spy.emit(event('collaboration.view', collaborationFixture, { session: 'origin' }))
  const update = (value: BackgroundView) => { background = value; spy.emit(event('background.state', value, { session: 'origin' })) }
  update(background)
  const pick = (value: string) => {
    const dock = shell.getView().dock
    if (dock.kind !== 'picker') throw Error('expected picker')
    const index = dock.picker.rows.findIndex(one => one.value === value)
    if (index < 0) throw Error(`missing ${value}`)
    for (let i = 0; i < (index - dock.picker.selected + dock.picker.rows.length) % dock.picker.rows.length; i++) shell.key({ kind: 'down' })
    return shell.key({ kind: 'enter' })
  }
  const ps = () => { shell.key({ kind: 'paste', text: '/ps' }); shell.key({ kind: 'enter' }) }
  return { shell, spy, update, pick, ps, copied }
}

test('/ps 裸命令直接打开成员页，空成员仍可切后台，不发送模型输入', () => {
  const f = fixture(false)
  f.ps()
  let dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.source).toBe('collaboration')
  expect(dock.kind === 'picker' && dock.picker.hint).toContain('没有协作成员')
  f.shell.key({ kind: 'tab' }); dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.source).toBe('background')
  expect(dock.kind === 'picker' && dock.picker.rows).toHaveLength(2)
  expect(f.spy.commands.some(one => one.type === 'input.submit' || one.type === 'collaboration.input' || one.type === 'background.stop')).toBe(false)
})

test('两个 tab 保留对象身份，更新不按旧行号跳对象；Enter 只看详情，明确停止绑定原执行代次', () => {
  const f = fixture()
  f.ps(); f.shell.key({ kind: 'tab' }); f.shell.key({ kind: 'down' })
  f.shell.key({ kind: 'shift+tab' }); f.shell.key({ kind: 'tab' })
  let dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.rows[dock.picker.selected]?.value).toBe(backgroundKey(commands[1]!))
  f.update({ commands: [{ ...commands[0]!, id: 'earlier', startedAt: 0 }, ...commands], waiting: [] })
  dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.rows[dock.picker.selected]?.value).toBe(backgroundKey(commands[1]!))
  f.shell.key({ kind: 'enter' })
  expect(f.spy.commands.some(one => one.type === 'background.stop')).toBe(false)
  f.pick('copy')
  expect(f.copied).toEqual([commands[1]!.outputPath])
  f.pick('stop')
  expect(f.spy.commands.at(-1)).toEqual({ type: 'background.stop', target: { execution: 'member-generation', session: 'member', id: 'bg-1' } })
  expect(f.shell.getView().inputMember).toBeUndefined()
})

test('主屏 Tab 共用页面，Esc 恢复草稿光标与引用；自然结束保留原命令结果到返回', async () => {
  const f = fixture()
  f.shell.key({ kind: 'paste', text: '保留🙂完整草稿' }); f.shell.key({ kind: 'left' })
  const before = f.shell.getView()
  f.shell.key({ kind: 'tab' }); f.shell.key({ kind: 'tab' }); f.pick(backgroundKey(commands[1]!))
  const command = commands[1]!
  f.update({ commands: [commands[0]!], waiting: [], result: { target: command, outcome: { ok: true, note: 'bg-1 已结束', finish: { id: command.id, command: command.command, outputPath: command.outputPath, ok: false, exit: 7 } } } })
  let dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.source).toBe('background-detail')
  expect(dock.kind === 'picker' && dock.picker.detail?.join('\n')).toContain('exit 7')
  expect(dock.kind === 'picker' && dock.picker.rows.some(one => one.value === 'stop')).toBe(false)
  for (const columns of [200, 100]) {
    const screen = await show([f.shell.getView()], { columns, rows: 40 })
    expect(screen.has('bg-1 已结束')).toBe(true)
    expect(screen.has('复制完整输出路径')).toBe(true)
    expect(screen.screen.wrapped.some(Boolean)).toBe(false)
  }
  f.shell.key({ kind: 'escape' }); dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.rows).toHaveLength(1)
  f.shell.key({ kind: 'escape' })
  expect(f.shell.getView().draft).toBe(before.draft)
  expect(f.shell.getView().caret).toBe(before.caret)
  expect(f.shell.getView().refs).toEqual(before.refs)
})

test('未确认停止保留原因和重试，失联数量未知；明确后台等待不冒充等用户或工作动画', () => {
  const f = fixture(false)
  f.ps(); f.shell.key({ kind: 'tab' }); f.pick(backgroundKey(commands[0]!))
  f.update({ commands: [{ ...commands[0]!, state: 'unconfirmed', reason: '回收尚未确认' }], waiting: [] })
  let dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.rows.some(one => one.label === '重试停止 bg-1')).toBe(true)
  f.update({ commands, waiting: ['origin'] })
  expect(collaborationStatus(f.shell.getView()).state).toBe('background')
  f.update({ commands, waiting: [], unknown: true })
  dock = f.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.title).toContain('状态待确认')
  expect(dock.kind === 'picker' && dock.picker.rows.some(one => one.value === 'stop')).toBe(false)
})

test('成员明确等待后台时整件工作不转圈；常驻服务与实际前台工作分别呈现', () => {
  const f = fixture()
  const members = collaborationFixture.members.map(member => member.agent.agentId === 'worker'
    ? { ...member, runtime: { ...member.runtime!, background: 1, backgroundWaiting: true as const, action: undefined } } : member)
  f.spy.emit(event('collaboration.view', { ...collaborationFixture, members }, { session: 'origin' }))
  f.update({ commands, waiting: ['member'] })
  expect(collaborationStatus(f.shell.getView()).state).toBe('background')
  f.spy.emit(event('collaboration.view', { ...collaborationFixture, members: members.map(member => member.agent.agentId === 'coordinator'
    ? { ...member, runtime: { ...member.runtime!, state: 'running' as const, action: '正在执行独立步骤' } } : member) }, { session: 'origin' }))
  expect(collaborationStatus(f.shell.getView()).state).toBe('working')
})

test('/ps 进入模型编辑后后台更新不抢焦点，逐层返回刷新编辑值、成员与后台列表', () => {
  const f = fixture()
  const picker = () => {
    const dock = f.shell.getView().dock
    if (dock.kind !== 'picker') throw Error('expected picker')
    return dock.picker
  }
  f.ps(); f.pick('default-model')
  f.spy.emit(event('model.catalog', { entries: [] }, { session: 'origin' }))
  f.pick('connect')
  f.spy.emit(event('provider.catalog', { entries: [], vendors: [] }, { session: 'origin' }))
  f.pick('custom'); f.pick('name')
  f.shell.key({ kind: 'paste', text: '本地连接草稿' })
  const prompt = f.shell.getView().dock
  const updated = { ...collaborationFixture, members: collaborationFixture.members.map(member => ({ ...member, agent: { ...member.agent, name: `${member.agent.name}已更新` } })) }
  f.spy.emit(event('collaboration.view', updated, { session: 'origin' }))
  f.update({ commands: [commands[1]!], waiting: [] })
  expect(f.shell.getView().dock).toEqual(prompt)
  f.shell.key({ kind: 'escape' })
  expect(picker().source).toBe('model-editor')
  expect(picker().rows.find(row => row.value === 'name')?.meta).toContain('本地连接草稿')
  f.shell.key({ kind: 'escape' }); expect(picker().source).toBe('vendor')
  f.shell.key({ kind: 'escape' }); expect(picker().source).toBe('model')
  f.shell.key({ kind: 'escape' }); expect(picker().source).toBe('collaboration')
  expect(picker().rows.some(row => row.label.includes('已更新'))).toBe(true)
  f.shell.key({ kind: 'tab' })
  expect(picker().source).toBe('background')
  expect(picker().rows.map(row => row.value)).toEqual([backgroundKey(commands[1]!)])
  f.pick(backgroundKey(commands[1]!))
  f.update({ commands: [], waiting: [] })
  f.shell.key({ kind: 'escape' })
  expect(picker().source).toBe('background')
  expect(picker().rows).toEqual([])
  expect(f.spy.commands.some(command => ['provider.save', 'model.override', 'model.configure', 'collaboration.configure', 'background.stop'].includes(command.type))).toBe(false)
  f.shell.dispose()
})
