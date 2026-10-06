import { afterEach, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'ink'
import type { CollaborationView } from '@magic/contracts'
import { createShell, type Shell, type ShellOptions } from '../src/shell.ts'
import { AppView } from '../src/components/app.ts'
import { collaborationSummary, memberRows, memberState } from '../src/collaboration.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { plain } from './screen.ts'
import { collaborationDetail, collaborationFixture } from './collaboration-fixture.ts'

const shells: Shell[] = []
afterEach(() => { for (const shell of shells.splice(0)) shell.dispose() })
export function collaborationStage(options: ShellOptions = {}) {
  const spy = createSpyTransport()
  const shell = createShell({ ...spy.transport, send(command) {
    spy.transport.send(command)
    if (command.type === 'collaboration.read') spy.emit(event('collaboration.view', collaborationDetail(command.member)))
    if (command.type === 'model.list') spy.emit(event('model.catalog', { entries: [{ provider: 'local' }], aliases: { default: { provider: 'local', model: 'mini' } }, current: { alias: 'default' as const, provider: 'local', model: 'mini' } }))
  } }, options)
  shells.push(shell)
  spy.emit(event('session.state', { active: 'origin', sessions: [{ id: 'origin', title: '修复回调', at: 0 }, { id: 'member', at: 0 }] }))
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
  return { spy, shell, key, pick,
    text: (text: string) => shell.key({ kind: 'paste', text }),
    screen: (columns = 100, rows = 30) => plain(renderToString(h(AppView, { view: shell.getView(), columns, rows }), { columns })),
    member: () => { key('tab'); pick('worker'); shell.key({ kind: 'memberMenu' }) },
  }
}

test('未展开不显示摘要；入口空闲不能掩盖成员执行，全员空闲不冒充交付', () => {
  expect(collaborationSummary(undefined)).toBeUndefined()
  expect(collaborationSummary({ ...collaborationFixture, collaboration: undefined })).toBeUndefined()
  expect(collaborationSummary(collaborationFixture)).toContain('1 位执行中')
  const idle: CollaborationView = { ...collaborationFixture, members: collaborationFixture.members.map((one) => ({ ...one, runtime: undefined })) }
  expect(collaborationSummary(idle)).toContain('结果待整合')
  const app = collaborationStage()
  expect(app.screen()).toContain('输入给：整件工作')
  expect(app.screen()).toContain('● 工作中')
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

test('浏览成员不改输入，不打开成员会话；完整记录与讨论可返回并保留阅读位置', () => {
  const app = collaborationStage()
  app.text('整体草稿')
  const originRows = app.shell.getView().settled
  app.member()
  expect(app.shell.getView().inputMember).toBeUndefined()
  expect(app.shell.getView().draft).toBe('整体草稿')
  app.pick('records')
  app.shell.key({ kind: 'readerTop', top: 7 })
  app.key('left')
  app.pick('discussions')
  app.key('enter')
  expect(app.screen()).toContain('讨论 #40')
  expect(app.screen()).toContain('原始要求')
  app.key('left')
  app.key('left')
  app.pick('records')
  const dock = app.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.reader?.top).toBe(7)
  app.key('escape')
  expect(app.shell.getView().settled).toBe(originRows)
  expect(app.shell.getView().draft).toBe('整体草稿')
  expect(app.spy.commands.every((command) => command.type === 'collaboration.read' || command.type === 'history.read')).toBe(true)
})

test('显式切输入保存整体与成员各自草稿、引用和光标；局部输入不会进入整体日志', () => {
  const app = collaborationStage()
  app.text('整体 ')
  app.shell.key({ kind: 'char', char: '@' })
  app.spy.emit(event('paths.catalog', { query: '', rows: [{ kind: 'file', display: 'api.ts', path: '/project/api.ts', external: false }] }))
  app.key('enter')
  const original = { draft: app.shell.getView().draft, refs: app.shell.getView().refs, caret: app.shell.getView().caret }
  app.member(); app.pick('input'); app.text('只复核这部分')
  expect(app.shell.getView().inputMember).toBe('worker')
  app.key('tab'); app.pick('whole')
  expect(app.shell.getView()).toMatchObject(original)
  app.member(); app.pick('input')
  expect(app.shell.getView().draft).toBe('只复核这部分')
  const originalRows = app.shell.getView().settled
  app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', member: 'worker', input: { text: '只复核这部分' } })
  expect(app.shell.getView().settled).toBe(originalRows)
  app.key('tab'); app.pick('whole'); app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', shared: true, input: { refs: [{ kind: 'file', source: '/project/api.ts' }] } })
})

test('晚到的失败回执只归还原目标，不能覆盖眼前另一份草稿', () => {
  const app = collaborationStage()
  app.text('整体未发稿'); app.member(); app.pick('input'); app.text('成员失败稿'); app.key('enter')
  const command = app.spy.commands.at(-1)
  if (command?.type !== 'collaboration.input') throw new Error('没有发送')
  app.key('tab'); app.pick('whole')
  app.spy.emit(event('input.settled', { ok: false, ref: command.input.ref!, reason: '未送出' }, { session: 'member' }))
  expect(app.shell.getView().draft).toBe('整体未发稿')
  app.member(); app.pick('input')
  expect(app.shell.getView().draft).toBe('成员失败稿')
})

test('停止必须点名委派；同成员排队的另一份可独立选择，浏览与输入不影响范围', () => {
  const app = collaborationStage()
  app.member(); app.pick('stop-member')
  expect(app.spy.commands.some((command) => command.type === 'collaboration.stop')).toBe(false)
  app.pick('11')
  expect(app.spy.commands.at(-1)).toEqual({ type: 'collaboration.stop', delegation: 11 })
  expect(app.shell.getView().inputMember).toBeUndefined()
  app.key('tab'); app.pick('stop-work')
  expect(app.spy.commands.at(-1)).toEqual({ type: 'collaboration.stop' })
})

test('配置复用选择器：成员与后续派生默认分别送命令，不改原会话模型', () => {
  const app = collaborationStage()
  app.member(); app.pick('member-model')
  expect(app.screen()).toContain('模型选择与思考设置作用于：实现')
  for (let i = 0; i < 4; i++) app.key('down')
  app.key('enter'); app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.configure', member: 'worker', model: { alias: 'default' } })
  app.key('tab'); app.pick('default-model'); for (let i = 0; i < 4; i++) app.key('down'); app.key('enter'); app.key('enter')
  const command = app.spy.commands.at(-1)
  expect(command?.type).toBe('collaboration.configure')
  expect(command).not.toHaveProperty('member')
  expect(app.spy.commands.some((one) => one.type === 'model.switch')).toBe(false)
})

test('从成员设置编辑全局档位时，焦点和当前标记取该映射，不取成员旧型号', () => {
  const app = collaborationStage()
  app.member(); app.pick('member-model')
  const mapping = { provider: 'local', model: 'deepseek-reasoner' }
  app.spy.emit(event('model.catalog', { aliases: { cantrip: mapping }, entries: [{ provider: 'local', cache: { snapshot: {
    provider: 'local', scope: 'test', fetchedAt: 1, models: [{ id: 'mini' }, { id: 'deepseek-reasoner' }],
  } } }] }))
  app.pick('edit:cantrip')
  const dock = app.shell.getView().dock
  expect(dock.kind).toBe('picker')
  if (dock.kind !== 'picker') throw new Error('未打开档位配置')
  expect(dock.picker.rows[dock.picker.selected]?.pick).toEqual(mapping)
  expect(dock.picker.rows.find(row => row.current)?.pick).toEqual(mapping)
  app.key('enter')
  expect(app.spy.commands.at(-1)).toEqual({ type: 'model.alias.set', alias: 'cantrip', ...mapping })
})

test('不同成员审批逐份排队；重复通知与重复按键不重复裁决；答完返回阅读位置', () => {
  const app = collaborationStage()
  app.member(); app.pick('records'); app.shell.key({ kind: 'readerTop', top: 5 })
  const ask = event('tool.decision.request', { call: 50, name: 'exec', material: '修改回调', weight: 'light' }, { id: 100, session: 'member' })
  app.spy.emit(ask); app.spy.emit(ask)
  app.spy.emit(event('tool.decision.request', { call: 51, name: 'write', material: '更新说明', weight: 'light' }, { id: 101, session: 'origin' }))
  app.shell.key({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
  expect(app.screen()).toContain('实现 · exec')
  app.spy.emit(event('turn.end', { reason: 'settled' }, { session: 'origin' }))
  expect(app.shell.getView().dock.kind).toBe('decision')
  app.shell.key({ kind: 'char', char: 'y' }); app.shell.key({ kind: 'char', char: 'y' })
  expect(app.spy.commands.filter((one) => one.type === 'decision.answer')).toHaveLength(1)
  app.spy.emit(event('tool.decision', { call: 50, decision: 'approve', decider: 'user', elapsedMs: 1 }, { session: 'member' }))
  expect(app.shell.getView().dock.kind).toBe('picker')
  app.shell.key({ kind: 'ctrl+g' })
  expect(app.shell.getView().dock.kind).toBe('picker') // root turn.end 使该卡失效
  app.spy.emit(event('tool.decision', { call: 51, decision: 'reject', decider: 'user', elapsedMs: 1 }, { session: 'origin' }))
  const dock = app.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.reader?.top).toBe(5)
  expect(app.shell.getView().status.state).toBe('working') // 成员仍有真实 runtime
})

test('等待查询时取消保留草稿，晚到快照不重新打开成员界面', () => {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
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

test('成员记录刷新保持阅读位置；配置目录刷新保持成员作用范围', () => {
  const app = collaborationStage()
  app.member(); app.pick('records'); app.shell.key({ kind: 'readerTop', top: 4 })
  app.spy.emit(event('collaboration.view', { ...collaborationDetail('worker'), entries: [{ id: 99, kind: 'assistant', at: 1, content: { text: '新到的结果' } }] }))
  const dock = app.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.reader?.top).toBe(4)
  expect(app.screen()).toContain('新到的结果')
  app.key('left'); app.pick('member-model')
  app.pick('refresh')
  expect(app.spy.commands.at(-1)).toEqual({ type: 'model.refresh' })
  app.spy.emit(event('model.catalog', { entries: [{ provider: 'local' }], aliases: { default: { provider: 'local', model: 'mini' } }, current: { alias: 'default' as const, provider: 'other', model: 'main' } }))
  expect(app.screen()).toContain('模型选择与思考设置作用于：实现')
  app.pick('choose'); app.pick('default')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.configure', member: 'worker' })
})

test('成员增量不混入原会话；换会话后旧协作快照不串线', () => {
  const app = collaborationStage()
  const rows = app.shell.getView().rows
  app.spy.emit(event('model.delta', { channel: 'text', text: '成员专属内容' }, { session: 'member' }))
  expect(app.shell.getView().rows).toBe(rows)
  app.spy.emit(event('session.state', { active: 'another', sessions: [{ id: 'another', at: 0 }] }))
  app.spy.emit(event('collaboration.view', collaborationFixture))
  expect(app.shell.getView().collaboration).toBeUndefined()
  expect(app.shell.getView().inputMember).toBeUndefined()
})

test('第二个窗口先收到协作快照时，随后入口 session.state 不能误当成员事件丢掉', () => {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport)
  shells.push(shell)
  spy.emit(event('collaboration.view', collaborationFixture))
  spy.emit(event('session.state', { active: 'origin', sessions: [{ id: 'origin', at: 0 }] }, { session: 'origin' }))
  expect(shell.getView().sessionId).toBe('origin')
  expect(shell.getView().collaboration?.originSession).toBe('origin')
  spy.emit(event('model.delta', { channel: 'text', text: '第二窗口成员事件仍不混入' }, { session: 'member' }))
  expect(shell.getView().rows).toEqual([])
})

test('入口退出只恢复入口的未接收输入，不提前恢复成员仍在途的输入', () => {
  let detached: (why: string) => void = () => {}
  const app = collaborationStage({ detached: listener => { detached = listener } })
  app.text('入口未接收输入'); app.key('enter')
  app.member(); app.pick('input'); app.text('成员在途输入'); app.key('enter')
  expect(app.shell.getView().draft).toBe('')
  detached('入口启动失败')
  expect(app.shell.getView().draft).toBe('')
  app.key('tab'); app.pick('whole')
  expect(app.shell.getView().draft).toBe('入口未接收输入')
})

test('入口 detached 不撤成员审批，答完仍回原阅读位置与各自草稿', () => {
  let detached: (why: string) => void = () => {}
  const app = collaborationStage({ detached: listener => { detached = listener } })
  app.text('整体草稿')
  app.member(); app.pick('input'); app.text('成员草稿')
  app.member(); app.pick('records'); app.shell.key({ kind: 'readerTop', top: 5 })
  const ask = event('tool.decision.request', { call: 50, name: 'exec', material: '成员校验', weight: 'light' }, { id: 100, session: 'member' })
  const rootAsk = event('tool.decision.request', { call: 51, name: 'write', material: '入口修改', weight: 'light' }, { id: 101, session: 'origin' })
  app.spy.emit(ask); app.spy.emit(rootAsk)
  detached('入口这一代执行者已退出')
  app.shell.key({kind:'ctrl+g'})
  const dock = app.shell.getView().dock
  expect(dock.kind === 'decision' && dock.pending.id).toBe(100)
  expect(app.shell.getView().sessionId).toBe('origin')
  expect(app.shell.getView().inputMember).toBe('worker')
  app.spy.emit(ask); app.spy.emit(rootAsk)
  app.shell.key({ kind: 'char', char: 'y' }); app.shell.key({ kind: 'char', char: 'y' })
  expect(app.spy.commands.filter(one => one.type === 'decision.answer')).toEqual([{ type: 'decision.answer', id: 100, decision: 'approve' }])
  app.spy.emit(event('tool.decision', { call: 50, decision: 'approve', decider: 'user', elapsedMs: 1 }, { session: 'member' }))
  const reader = app.shell.getView().dock
  expect(reader.kind === 'picker' && reader.picker.reader?.top).toBe(5)
  expect(app.shell.getView().draft).toBe('成员草稿')
  app.key('escape'); app.key('tab'); app.pick('whole')
  expect(app.shell.getView().draft).toBe('整体草稿')
})

test('入口审批失效后接续成员审批，selectedSession 只读重发不重置输入目标', () => {
  let detached: (why: string) => void = () => {}
  const app = collaborationStage({ detached: listener => { detached = listener } })
  app.member(); app.pick('input'); app.text('成员待发送')
  app.spy.emit(event('tool.decision.request', { call: 60, name: 'write', material: '入口修改', weight: 'light' }, { id: 110, session: 'origin' }))
  app.shell.key({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
  app.spy.emit(event('tool.decision.request', { call: 61, name: 'exec', material: '成员校验', weight: 'light' }, { id: 111, session: 'member' }))
  app.shell.key({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
  detached('入口已核销，当前选择仍在')
  app.shell.key({kind:'ctrl+g'})
  app.spy.emit(event('session.state', { active: 'origin', sessions: [{ id: 'origin', at: 0 }] }, { session: 'origin' }))
  app.spy.emit(event('collaboration.view', collaborationFixture))
  const dock = app.shell.getView().dock
  expect(dock.kind === 'decision' && dock.pending.id).toBe(111)
  expect(app.shell.getView().inputMember).toBe('worker')
  app.shell.key({ kind: 'char', char: 'y' })
  expect(app.spy.commands.filter(one => one.type === 'decision.answer')).toEqual([{ type: 'decision.answer', id: 111, decision: 'approve' }])
  expect(app.spy.commands.some(one => one.type === 'input.submit' || one.type === 'collaboration.input' || one.type === 'session.open')).toBe(false)
})

test('宿主退出清掉协作失效审批，明确重开保留目标草稿且不自动发送', async () => {
  let opens = 0
  const app = collaborationStage({ reopen: async () => { opens++ } })
  app.text('整体保留稿'); app.member(); app.pick('input'); app.text('成员保留稿')
  const ask = event('tool.decision.request', { call: 70, name: 'exec', material: '旧成员操作', weight: 'light' }, { id: 120, session: 'member' })
  app.spy.emit(ask)
  app.shell.hostGone()
  app.spy.emit(ask)
  app.key('enter')
  expect(app.shell.getView().dock.kind).toBe('input')
  expect(app.shell.getView().draft).toBe('成员保留稿')
  expect(app.shell.getView().inputMember).toBe('worker')
  expect(opens).toBe(0)
  app.shell.key({ kind: 'ctrl+r' })
  await Bun.sleep(0)
  expect(opens).toBe(1)
  expect(app.spy.commands.filter(one => one.type === 'history.read')).toHaveLength(2)
  expect(app.spy.commands.some(one => one.type === 'input.submit' || one.type === 'collaboration.input' || one.type === 'decision.answer')).toBe(false)
  app.member(); app.pick('input')
  app.spy.emit(event('tool.decision.request', { call: 71, name: 'exec', material: '新成员操作', weight: 'light' }, { id: 121, session: 'member' }))
  app.shell.key({kind:'ctrl+g'}) // 主动进入后测试既定裁决动作。
  expect(app.screen()).toContain('新成员操作')
  app.spy.emit(event('tool.decision', { call: 71, decision: 'reject', decider: 'user', elapsedMs: 1 }, { session: 'member' }))
  expect(app.shell.getView().draft).toBe('成员保留稿')
  app.key('tab'); app.pick('whole')
  expect(app.shell.getView().draft).toBe('整体保留稿')
})
