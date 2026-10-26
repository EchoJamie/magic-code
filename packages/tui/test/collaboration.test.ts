import { afterEach, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'ink'
import type { CollaborationView } from '@magic/contracts'
import { createShell, type Shell, type ShellOptions } from '../src/shell.ts'
import { AppView } from '../src/components/app.ts'
import { collaborationSummary, currentMember, memberRows, memberState } from '../src/collaboration.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { plain } from './screen.ts'
import { collaborationFixture, memberEntries, memberMessages, memberSessionView } from './collaboration-fixture.ts'

const shells: Shell[] = []
afterEach(() => { for (const shell of shells.splice(0)) shell.dispose() })

/**
 * 协作舞台：`session.open` 由这个替身按管理者那一路回 `session.state`、分片历史与协作快照，
 * 于是「进入子会话」与 `/resume` 走的是同一条外壳路径。
 */
export function collaborationStage(options: Omit<ShellOptions, 'magicBase'> = {}) {
  const spy = createSpyTransport()
  let active = 'origin'
  const snapshot = (): CollaborationView => active === 'member' ? memberSessionView : collaborationFixture
  const shell = createShell({ ...spy.transport, send(command) {
    spy.transport.send(command)
    if (command.type === 'collaboration.read') spy.emit(event('collaboration.view', snapshot()))
    if (command.type === 'model.list') spy.emit(event('model.catalog', { entries: [{ provider: 'local' }], configuredModels: { default: { provider: 'local', model: 'mini' } }, current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'default' as const, provider: 'local', model: 'mini' } }))
    if (command.type === 'session.open') {
      active = command.session === 'member' ? 'member' : 'origin'
      spy.emit(event('session.state', { active, sessions: [{ archived: false, id: 'origin', title: '修复回调', at: 0 }, { archived: false, id: 'member', at: 0 }] }, { session: active }))
      spy.emit(event('session.history', {
        session: active, done: true, entries: active === 'member' ? memberEntries : [],
        ...(active === 'member' ? { messages: memberMessages } : {}),
      }, { session: active }))
      spy.emit(event('collaboration.view', snapshot()))
    }
  } }, { magicBase: '/test/.magic', ...options })
  shells.push(shell)
  spy.emit(event('session.state', { active: 'origin', sessions: [{ archived: false, id: 'origin', title: '修复回调', at: 0 }, { archived: false, id: 'member', at: 0 }] }))
  spy.emit(event('collaboration.view', collaborationFixture))
  const key = (kind: 'tab' | 'enter' | 'left' | 'escape' | 'down' | 'up') => shell.key({ kind })
  const pick = (value: string) => {
    const dock = shell.getView().dock
    if (dock.kind !== 'picker') throw new Error('没有选择器')
    const index = dock.picker.rows.findIndex((row) => row.value === value)
    if (index < 0) throw new Error(`找不到 ${value}`)
    for (let i = 0; i < (index - dock.picker.selected + dock.picker.rows.length) % dock.picker.rows.length; i++) key('down')
    key('enter')
  }
  const enter = (member = 'worker') => { key('tab'); pick(member) }
  return { spy, shell, key, pick, enter,
    text: (text: string) => shell.key({ kind: 'paste', text }),
    screen: (columns = 100, rows = 30) => plain(renderToString(h(AppView, { view: shell.getView(), columns, rows }), { columns })),
    view: () => shell.getView(),
  }
}

test('未展开不显示摘要；入口显示共同补充将送达的成员数，子会话头部单列派生、委派、运行与整件状态', () => {
  expect(collaborationSummary(undefined)).toBeUndefined()
  expect(collaborationSummary({ ...collaborationFixture, collaboration: undefined })).toBeUndefined()
  expect(collaborationSummary(collaborationFixture)).toContain('1 位执行中')
  const idle: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map((one) => ({ ...one, runtime: undefined })) }
  expect(collaborationSummary(idle)).toContain('结果待整合')
  const app = collaborationStage()
  expect(app.screen()).toContain('输入给：整件工作（共同补充） · 将送达 1 位成员')
  expect(app.screen()).toContain('● 工作中')

  app.enter()
  const screen = app.screen()
  expect(screen).toContain('子会话 · 由 协调 派生 · 实现（调整校验）')
  expect(screen).toContain('委派：回调校验（已接下）')
  expect(screen).toContain('输入给：实现（由 协调 派生）')
  expect(screen).toContain('整件：进行中')
  expect(currentMember(app.view())?.agent.name).toBe('实现')
})

test('协调执行者退出后只有 suspended 身份事实，摘要仍明确中断且保留其他成员运行', () => {
  const snapshot: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map(one => one.agent.agentId === 'coordinator'
    ? { ...one, agent: { ...one.agent, reachability: 'suspended' }, runtime: undefined } : one) }
  expect(collaborationSummary(snapshot)).toContain('受阻：协调（执行中断，待处理）')
  expect(collaborationSummary(snapshot)).toContain('协调承接待核实')
  expect(collaborationSummary(snapshot)).toContain('1 位执行中')
  const app = collaborationStage()
  app.spy.emit(event('collaboration.view', snapshot))
  expect(app.screen()).toContain('执行中断')
})

test('成员无 runtime 但 suspended 时不能显示当前空闲或仅已接下', () => {
  const snapshot: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map(one => ({
    ...one, agent: { ...one.agent, reachability: 'suspended' }, runtime: undefined,
  })) }
  for (const member of snapshot.members) expect(memberState(member)).toBe('执行中断，待处理')
  expect(memberRows(snapshot).every(one => one.meta?.includes('执行中断，待处理'))).toBe(true)
  expect(collaborationSummary(snapshot)).not.toContain('暂无执行，结果待整合')
})

test('closed 摘要不再把历史拒绝显示为当前受阻，成员原拒绝记录仍可见', () => {
  const rejected: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map(one => ({
    ...one, runtime: undefined, delegation: one.delegation === undefined ? undefined : { ...one.delegation, state: 'rejected', reason: '原范围无法承担' },
  })) }
  expect(collaborationSummary(rejected)).toContain('受阻：实现（已拒绝：原范围无法承担）')
  const closed: CollaborationView = { ...rejected, collaboration: { ...rejected.collaboration!, state: 'closed' },
    members: rejected.members.map(one => ({ ...one, agent: { ...one.agent, reachability: 'historical' } })),
    delegations: rejected.delegations.map(one => ({ ...one, state: one.delegationId === 10 ? 'rejected' : 'cancelled' })),
  }
  expect(collaborationSummary(closed)).toBe('协作 · 已收尾，结果可查看')
  expect(memberRows(closed).find(one => one.value === 'worker')?.meta).toContain('已拒绝：原范围无法承担')
  const app = collaborationStage()
  app.spy.emit(event('collaboration.view', closed))
  expect(app.screen()).toContain('协作 · 已收尾，结果可查看')
  expect(app.screen()).not.toContain('受阻')
})

test('协作列表排除当前会话：主会话不出现，成员行平铺并标“由 xx 派生”', () => {
  const app = collaborationStage()
  app.key('tab')
  const dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('没有协作列表')
  expect(dock.picker.rows.some(row => row.value === 'coordinator')).toBe(false)
  const worker = dock.picker.rows.find(row => row.value === 'worker')
  expect(worker?.label).toBe('实现')
  expect(worker?.meta).toContain('由 协调 派生')
  expect(worker?.meta).toContain('回调校验')
  expect(memberRows(collaborationFixture, 'origin').some(row => row.value === 'coordinator')).toBe(false)
})

test('Enter 进入子会话：走会话历史分片，讨论消息按来源并入正文，草稿独立', () => {
  const app = collaborationStage()
  app.text('整体草稿')
  app.enter()
  const view = app.view()
  expect(view.sessionId).toBe('member')
  // 子会话不在顶层目录里：状态行用成员名，不报「新会话」。
  expect(view.status.session).toBe('实现')
  expect(app.spy.commands.some(command => command.type === 'session.open' && command.session === 'member')).toBe(true)
  // 历史是这条子会话的，不是入口的；入口草稿留在入口。
  expect(view.draft).toBe('')
  expect(view.settled.some(row => row.kind === 'user' && row.text === '按入口要求核对回调。')).toBe(true)
  // 讨论消息按来源并入正文，没有单独的讨论入口。
  const transcript = app.screen()
  expect(transcript).toContain('协调 · 决定')
  expect(transcript).toContain('保留原状态码')
  expect(transcript).not.toContain('关联讨论')
  app.text('只复核这部分')
  app.key('tab')
  app.pick('coordinator')
  expect(app.view().sessionId).toBe('origin')
  expect(app.view().draft).toBe('整体草稿')
})

test('子会话打开协作视图：当前子会话不在列表里，主会话预选，Enter 返回', () => {
  const app = collaborationStage()
  app.enter()
  app.key('tab')
  const dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('没有协作列表')
  expect(dock.picker.rows.some(row => row.value === 'worker')).toBe(false)
  const selected = dock.picker.rows[dock.picker.selected]
  expect(selected?.value).toBe('coordinator')
  expect(selected?.meta).toContain('主会话')
  app.key('enter')
  expect(app.view().sessionId).toBe('origin')
  expect(app.view().collaboration?.originSession).toBe('origin')
})

test('子会话输入只发给该子会话；共同补充仍回到入口', () => {
  const app = collaborationStage()
  app.enter()
  app.text('子会话里的一句')
  app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', member: 'worker', input: { text: '子会话里的一句' } })
  expect(app.spy.commands.at(-1)).not.toHaveProperty('shared')
  app.key('tab'); app.pick('whole')
  expect(app.view().sessionId).toBe('origin')
  app.text('整件补充')
  app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', shared: true, input: { text: '整件补充' } })
})

test('咨询子会话只读：正文可看，输入不发出', () => {
  const consultation: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map(one => one.agent.agentId === 'worker' ? { ...one, agent: { ...one.agent, purpose: 'consultation' as const } } : one) }
  const app = collaborationStage()
  app.enter()
  // 子会话快照仍把这条会话标为只读顾问。
  app.spy.emit(event('collaboration.view', { ...consultation, messages: memberMessages }))
  expect(app.view().sessionId).toBe('member')
  app.text('不该发出')
  app.key('enter')
  expect(app.spy.commands.some(command => command.type === 'collaboration.input')).toBe(false)
  expect(app.screen()).toContain('只供查看')
})

test('子会话的停止确认写明委派及派生闭包，并停止这条子会话', () => {
  const stopped: { session: string; scope: string }[] = []
  const app = collaborationStage({ stop: (session, scope) => stopped.push({ session, scope }) })
  app.enter()
  app.spy.emit(event('turn.start', {}, { session: 'member' }))
  app.shell.key({ kind: 'ctrl+c' })
  const picker = app.view().dock
  if (picker.kind !== 'picker') throw new Error('停止菜单没有打开')
  expect(picker.picker.rows[0]?.label).toBe('停止这份委派')
  expect(picker.picker.rows[0]?.meta).toContain('派生闭包')
  app.key('enter')
  expect(stopped.at(-1)).toEqual({ session: 'member', scope: 'run' })
})

test('子会话复用现有会话模型入口，只换这个成员的模型', () => {
  const app = collaborationStage()
  app.enter()
  app.text('/model ')
  app.key('enter')
  expect(app.spy.commands.some(command => command.type === 'model.list')).toBe(true)
  let dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('模型选择器没有打开')
  // 复用会话模型入口，但作用对象写明是这条子会话。
  expect(dock.picker.rows.find(row => row.value === 'choose')?.label).toContain('实现 · 选择模型')
  app.pick('choose')
  dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('模型档位没有打开')
  app.pick('default')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.configure', member: 'worker', model: { choice: 'default' } })
})

test('协作实时消息追加到子会话正文，同一 messageId 不重复', () => {
  const app = collaborationStage()
  app.enter()
  const fresh = { messageId: 90, collaborationId: 'work', senderId: 'coordinator', recipients: ['worker'], purpose: 'inform' as const, body: [{ kind: 'text' as const, text: '新到的讨论消息：先看这个。' }], at: 9, withdrawn: false }
  app.spy.emit(event('collaboration.view', { ...memberSessionView, messages: [...memberMessages, fresh] }))
  expect(app.screen()).toContain('新到的讨论消息')
  const rows = [...app.view().settled, ...app.view().rows].filter(row => row.key === 'am:90')
  expect(rows).toHaveLength(1)
  app.spy.emit(event('collaboration.view', { ...memberSessionView, messages: [...memberMessages, fresh] }))
  expect([...app.view().settled, ...app.view().rows].filter(row => row.key === 'am:90')).toHaveLength(1)
})

test('子会话内审批接管输入，答完原稿保留；不作答时不乱切会话', () => {
  const app = collaborationStage()
  app.enter()
  app.text('子会话原稿')
  app.spy.emit(event('tool.decision.request', { call: 50, name: 'exec', material: '修改回调', weight: 'light' }, { id: 100, session: 'member' }))
  expect(app.screen()).toContain('实现 · exec')
  const view = app.view()
  expect(view.dock).toMatchObject({ kind: 'decision', pending: { id: 100 } })
  expect(view.stashed).toMatchObject({ draft: '子会话原稿' })
  app.spy.emit(event('tool.decision', { call: 50, decision: 'approve', decider: 'user', elapsedMs: 1 }, { session: 'member' }))
  expect(app.view().dock.kind).toBe('input')
  expect(app.view().draft).toBe('子会话原稿')
  expect(app.spy.commands.some(command => command.type === 'session.open' && command.session !== 'member')).toBe(false)
})

test('默认模型配置只影响后续派生，不换当前成员', () => {
  const app = collaborationStage()
  app.key('tab'); app.pick('default-model')
  for (let i = 0; i < 4; i++) app.key('down')
  app.key('enter'); app.key('enter')
  const command = app.spy.commands.at(-1)
  expect(command?.type).toBe('collaboration.configure')
  expect(command).not.toHaveProperty('member')
  expect(app.spy.commands.some(one => one.type === 'model.switch')).toBe(false)
})

test('换到别的会话后旧协作快照不串线；子会话事件不混进原会话', () => {
  const app = collaborationStage()
  const rows = app.view().rows
  app.spy.emit(event('model.delta', { channel: 'text', text: '入口自己的内容' }, { session: 'origin' }))
  expect(app.view().rows.length).toBeGreaterThan(rows.length)
  app.spy.emit(event('session.state', { active: 'another', sessions: [{ archived: false, id: 'another', at: 0 }] }))
  app.spy.emit(event('collaboration.view', collaborationFixture))
  expect(app.view().collaboration).toBeUndefined()
  expect(app.view().inputMember).toBeUndefined()
})

test('第二个窗口先收到协作快照时，随后入口 session.state 不能误当成员事件丢掉', () => {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { magicBase: '/test/.magic' })
  shells.push(shell)
  spy.emit(event('collaboration.view', collaborationFixture))
  spy.emit(event('session.state', { active: 'origin', sessions: [{ archived: false, id: 'origin', at: 0 }] }, { session: 'origin' }))
  expect(shell.getView().sessionId).toBe('origin')
  expect(shell.getView().collaboration?.originSession).toBe('origin')
  spy.emit(event('model.delta', { channel: 'text', text: '别的成员事件不混入' }, { session: 'member' }))
  expect(shell.getView().rows).toEqual([])
})

test('等待查询时取消保留草稿，晚到快照不重新打开协作界面', () => {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { magicBase: '/test/.magic' })
  shells.push(shell)
  spy.emit(event('session.state', { active: 'origin', sessions: [] }))
  spy.emit(event('collaboration.view', collaborationFixture))
  shell.key({ kind: 'paste', text: '继续编辑的整体草稿' })
  shell.key({ kind: 'tab' })
  shell.key({ kind: 'escape' })
  spy.emit(event('collaboration.view', collaborationFixture))
  expect(shell.getView().dock.kind).toBe('input')
  expect(shell.getView().draft).toBe('继续编辑的整体草稿')
})

test('从子会话退出时给出主会话的恢复命令', () => {
  const app = collaborationStage()
  app.enter()
  const note = app.shell.exitNote()
  expect(note).toContain('恢复此会话')
  expect(note).toContain(`'origin'`)
  expect(note).not.toContain(`'member'`)
})

test('入口 detached 不撤子会话审批，答完仍回原草稿', () => {
  let detached: (why: string) => void = () => {}
  const app = collaborationStage({ detached: listener => { detached = listener } })
  app.enter()
  app.text('子会话草稿')
  const ask = event('tool.decision.request', { call: 50, name: 'exec', material: '成员校验', weight: 'light' }, { id: 100, session: 'member' })
  app.spy.emit(ask)
  detached('入口这一代执行者已退出')
  expect(app.view().dock).toMatchObject({ kind: 'decision', pending: { id: 100 } })
  expect(app.view().sessionId).toBe('member')
  app.shell.key({ kind: 'down' }); app.shell.key({ kind: 'enter' }); app.shell.key({ kind: 'enter' })
  expect(app.spy.commands.filter(one => one.type === 'decision.answer')).toEqual([{ type: 'decision.answer', id: 100, decision: 'approve' }])
  app.spy.emit(event('tool.decision', { call: 50, decision: 'approve', decider: 'user', elapsedMs: 1 }, { session: 'member' }))
  expect(app.view().draft).toBe('子会话草稿')
})

test('宿主退出清掉协作失效审批；明确重开保留子会话草稿且不自动发送', async () => {
  let opens = 0
  const app = collaborationStage({ reopen: async () => { opens++ } })
  app.enter()
  app.text('子会话保留稿')
  const ask = event('tool.decision.request', { call: 70, name: 'exec', material: '旧成员操作', weight: 'light' }, { id: 120, session: 'member' })
  app.spy.emit(ask)
  app.shell.hostGone()
  app.spy.emit(ask)
  app.key('enter')
  expect(app.view().dock.kind).toBe('input')
  expect(app.view().draft).toBe('子会话保留稿')
  expect(opens).toBe(0)
  app.shell.key({ kind: 'ctrl+r' })
  await Bun.sleep(0)
  expect(opens).toBe(1)
  expect(app.spy.commands.some(command => command.type === 'input.submit' || command.type === 'collaboration.input' || command.type === 'decision.answer')).toBe(false)
})
