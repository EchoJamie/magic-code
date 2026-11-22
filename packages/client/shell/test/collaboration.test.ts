import { afterEach, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToString } from 'ink'
import type { CollaborationView } from '@magic/contracts'
import { createShell, type Shell, type ShellOptions } from '../src/shell.ts'
import { AppView, dockHeightOf } from '../src/components/app.ts'
import { logLines } from '../src/components/log.ts'
import { collaborationSummary, currentMember, memberRows, memberState, workTabs } from '../src/boards/conversation/collaboration.ts'
import { displayWidth } from '../src/components/lines.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { plain, show } from './screen.ts'
import { collaborationFixture, memberEntries, memberMessages, memberSessionView, nestedFixture, originEntries } from './collaboration-fixture.ts'

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
    if (command.type === 'model.list') spy.emit(event('model.catalog', { entries: [{ provider: 'local' }], configuredModels: { cantrip: { provider: 'local', model: 'mini' } }, current: { protocol: 'chat-completions', endpoint: 'https://fixture.invalid/v1', choice: 'cantrip' as const, provider: 'local', model: 'mini' } }))
    if (command.type === 'session.open') {
      active = command.session === 'member' ? 'member' : 'origin'
      spy.emit(event('session.state', { active, sessions: [{ archived: false, id: 'origin', title: '修复回调', at: 0 }, { archived: false, id: 'member', at: 0 }] }, { session: active }))
      spy.emit(event('session.history', {
        session: active, done: true, entries: active === 'member' ? memberEntries : originEntries,
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
  expect(app.screen()).toContain('输入给：当前会话')
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
  // 列表行：记号占状态位（▲ 出错），label 只放名字——状态词不上行。
  for (const row of memberRows(snapshot)) {
    expect(row.mark).toBe('▲')
    expect(row.label).toBe(row.value === 'coordinator' ? '协调' : '实现')
  }
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
  // 行上记号（× 没成）＋名字 · 原因（原因=内容，不是状态词）；「已拒绝」由 × 说。
  const rejectedRow = memberRows(closed).find(one => one.value === 'worker')
  expect(rejectedRow?.mark).toBe('×')
  expect(rejectedRow?.label).toBe('实现 · 原范围无法承担')
  const app = collaborationStage()
  app.spy.emit(event('collaboration.view', closed))
  expect(app.screen()).toContain('协作 · 已收尾，结果可查看')
  expect(app.screen()).not.toContain('受阻')
})

test('协作列表排除当前会话：主会话不出现，成员行左流（记号 · 名字 · 现状）', () => {
  const app = collaborationStage()
  app.key('tab')
  const dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('没有协作列表')
  expect(dock.picker.rows.some(row => row.value === 'coordinator')).toBe(false)
  const worker = dock.picker.rows.find(row => row.value === 'worker')
  expect(worker?.label).toBe('实现 · 检查回调兼容')
  expect(worker?.mark).toBe('●')
  expect(worker?.meta).toBe('')
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

test('子会话正文是它自己的历史；Ctrl+O 跟随当前会话而不是入口', () => {
  const app = collaborationStage()
  app.enter()
  const rows = (): readonly import('../src/view.ts').LogRow[] => [...app.view().settled, ...app.view().rows]
  const bodyText = (text: string): boolean => rows().some(row => (row.kind === 'user' || row.kind === 'assistant') && row.text === text)
  expect(bodyText('按入口要求核对回调。')).toBe(true)
  expect(bodyText('入口历史一句。')).toBe(false)
  expect(app.shell.key({ kind: 'ctrl+o' })).toEqual({ exit: false, screen: true })
  expect(app.view().sessionId).toBe('member')

  app.key('tab'); app.pick('coordinator')
  expect(app.view().sessionId).toBe('origin')
  expect(bodyText('入口历史一句。')).toBe(true)
  expect(bodyText('按入口要求核对回调。')).toBe(false)
  expect(app.shell.key({ kind: 'ctrl+o' })).toEqual({ exit: false, screen: true })
  expect(app.view().sessionId).toBe('origin')
})

test('子会话里工具行实时追加；默认折叠，Ctrl+O 那一屏才能看全文', () => {
  const app = collaborationStage()
  app.enter()
  const output = Array.from({ length: 40 }, (_, index) => `行${index} 输出`).join('\n')
  app.spy.emit(event('tool.call', { name: 'exec', args: { command: 'bun test' } }, { id: 70, session: 'member' }))
  app.spy.emit(event('tool.result', { call: 70, ok: true, output: { text: output } }, { id: 270, session: 'member' }))
  const rows = app.view().rows
  expect(rows.some(row => row.kind === 'tool' && row.name === 'exec')).toBe(true)
  const collapsed = logLines(rows, { columns: 100, expanded: false })
  const expanded = logLines(rows, { columns: 100, expanded: true })
  // 折叠只留标题、状态与结果摘要（摘要取末行）；正文中间那几行要 Ctrl+O 那一屏才有。
  expect(collapsed.some(line => line.segments.some(piece => piece.text.includes('行39')))).toBe(true)
  expect(collapsed.some(line => line.segments.some(piece => piece.text.includes('行20 输出')))).toBe(false)
  expect(expanded.some(line => line.segments.some(piece => piece.text.includes('行20 输出')))).toBe(true)
})

test('协作列表只保留工作级动作：不再有成员记录／讨论入口，也不打开阅读器', () => {
  const app = collaborationStage()
  app.key('tab')
  const dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('没有协作列表')
  const values = dock.picker.rows.map(row => row.value)
  expect(values).toEqual(expect.arrayContaining(['worker', 'whole', 'constraints', 'default-model', 'stop-work']))
  for (const gone of ['records', 'discussions', 'input', 'member-model', 'stop-member']) {
    expect(values).not.toContain(gone)
  }
  expect(dock.picker.reader).toBeUndefined()
  app.pick('worker')
  expect(app.view().sessionId).toBe('member')
  expect(app.view().dock.kind).toBe('input')
})

test('从子会话仍能执行整件工作动作：共同补充、带入情况、停止整件', () => {
  const app = collaborationStage()
  app.enter()
  app.key('tab')
  // 「向整件工作补充」回到入口会话（用整体草稿发送）。
  app.pick('whole')
  expect(app.view().sessionId).toBe('origin')

  app.key('tab')
  app.pick('constraints')
  let dock = app.view().dock
  if (dock.kind !== 'picker') throw new Error('带入情况没有打开')
  expect(dock.picker.reader?.title).toContain('共同补充')
  expect(dock.picker.reader?.rows.some(row => row.kind === 'output' && row.lines.some(line => line.includes('已带入后续请求')))).toBe(true)
  app.key('escape')

  // 工作级停止仍可发现并可用；子会话里按标准停止键才是局部停止。
  const list = app.view().dock
  if (list.kind !== 'picker' || list.picker.source !== 'collaboration') throw new Error('没有回到协作列表')
  app.pick('stop-work')
  expect(app.spy.commands.at(-1)).toEqual({ type: 'collaboration.stop' })
})

test('继续派生仍是平铺展示：行不缩进、不带派生语（嵌套关系在详情里说）', () => {
  const rows = memberRows(nestedFixture, 'origin')
  const descendant = rows.find(row => row.value === 'descendant')
  expect(descendant?.mark).toBe('○')
  expect(descendant?.label).toBe('复核')
  expect(descendant?.label).not.toContain('派生')
  expect(rows.every(row => !row.label.startsWith(' '))).toBe(true)
  expect(rows.some(row => row.value === 'coordinator')).toBe(false)
})

test('子会话里真实断线仍显式呈现，草稿保留', () => {
  const app = collaborationStage()
  app.enter()
  app.text('子会话未发稿')
  app.shell.disconnected('受控断线')
  expect(app.screen()).toContain('连接已断开')
  expect(app.view().draft).toBe('子会话未发稿')
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
  expect(selected?.label).toContain('协调')
  app.key('enter')
  expect(app.view().sessionId).toBe('origin')
  expect(app.view().collaboration?.originSession).toBe('origin')
})

test('子会话输入只发给该子会话；入口输入只回到入口，不广播', () => {
  const app = collaborationStage()
  app.enter()
  app.text('子会话里的一句')
  app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', member: 'worker', input: { text: '子会话里的一句' } })
  expect(app.spy.commands.at(-1)).not.toHaveProperty('shared')
  app.key('tab'); app.pick('whole')
  expect(app.view().sessionId).toBe('origin')
  app.text('入口的一句')
  app.key('enter')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.input', input: { text: '入口的一句' } })
  expect(app.spy.commands.at(-1)).not.toHaveProperty('shared')
  expect(app.spy.commands.at(-1)).not.toHaveProperty('member')
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
  if (dock.kind !== 'picker') throw new Error('模型切换器没有打开')
  // 复用切换器（三档直选），但作用对象写明是这条子会话（config：worker）。
  expect(dock.picker.rows.map(row => row.value)).toEqual(['cantrip', 'spell', 'arcane'])
  app.pick('cantrip')
  expect(app.spy.commands.at(-1)).toMatchObject({ type: 'collaboration.configure', member: 'worker', model: { choice: 'cantrip' } })
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

test('协作消息是信封不是全文：收悉回执不上屏，长文标行数', () => {
  const app = collaborationStage()
  app.enter()
  const long = Array.from({ length: 40 }, (_, i) => `工作单第 ${i + 1} 条`).join('\n')
  const messages = [
    ...memberMessages,
    { messageId: 91, collaborationId: 'work', senderId: 'coordinator', recipients: ['worker'], purpose: 'delegation' as const, body: [{ kind: 'text' as const, text: long }], at: 2, withdrawn: false },
    { messageId: 92, collaborationId: 'work', senderId: 'coordinator', recipients: ['worker'], purpose: 'receipt' as const, body: [], at: 3, withdrawn: false },
  ] as const
  app.spy.emit(event('collaboration.view', { ...memberSessionView, messages: [...messages] }))
  const transcript = app.screen()
  // 长文只给信封：抬头＋首行摘要＋行数，40 行原文不逐行铺屏。
  expect(transcript).toContain('协调 · 委派')
  expect(transcript).toContain('工作单第 1 条')
  expect(transcript).toContain('全文 40 行')
  expect(transcript).not.toContain('工作单第 40 条')
  // 收悉回执整类不上屏。
  expect(transcript).not.toContain('收悉')
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

test('/resume 只列顶层会话：子会话不占行，选主会话即返回', () => {
  const app = collaborationStage()
  app.enter()
  app.text('/resume ')
  app.key('enter')
  app.spy.emit(event('session.state', { active: 'member', sessions: [
    { archived: false, id: 'origin', title: '修复回调', at: 0 },
    { archived: false, id: 'member', at: 0 },
  ] }))
  const dock = app.view().dock
  if (dock.kind !== 'picker' || dock.picker.source !== 'session') throw new Error('会话目录没有打开')
  expect(dock.picker.rows.some(row => row.value === 'member')).toBe(false)
  expect(dock.picker.rows.some(row => row.value === 'origin')).toBe(true)
  app.pick('origin')
  expect(app.view().sessionId).toBe('origin')
  expect(app.spy.commands.some(command => command.type === 'session.open' && command.session === 'origin')).toBe(true)
})

test('从子会话退出时给出主会话的恢复命令', () => {
  const app = collaborationStage()
  app.enter()
  const note = app.shell.exitNote()
  expect(note).toContain('恢复此会话')
  expect(note).toContain(`'origin'`)
  expect(note).not.toContain(`'member'`)
})

// ══ 面板式那一屏（`Tab`）——底色、位置、留白各管一件事，不画线 ═════════

/**
 * **「不像字符画」那三件真东西**，各断一条：底色（页签与焦点）、位置（两列对齐）、
 * 留白（页签之后那一行）。
 *
 * 为什么不量「有没有边框 / 分隔线」：这一屏**本来就不该有**——层次由底色与留白立起来，
 * 画上线反而把「一屏浮在正文之上」变成「又一段正文」。故这里反过来量：**一条线都没有**。
 *
 * 色那条路必须走真终端（`show`）：帧文本那条路先剥 ANSI（D17），色到那里是量不到的。
 */
test('面板式：页签铺反白块、选中行整行底色、状态右对齐；账与屏同源', async () => {
  const stage = collaborationStage()
  stage.key('tab')
  const view = stage.view()
  const columns = 100
  const rows = 30
  const frame = await show([view], { columns, rows })
  const dock = frame.dock

  // 页签那一行：两段同名标签在，标题退到右边当面包屑
  const tabLine = dock.find((line) => line.text.includes('协作') && line.text.includes('后台命令'))
  expect(tabLine).toBeDefined()
  expect(tabLine!.text).toContain('整件工作 · 子会话')

  // 当前那一段铺反白块，另一段不铺（底色表「你在哪一页」）
  const tabs = frame.cellsOf(tabLine!.row)
  const columnOf = (part: string) => displayWidth(tabLine!.text.slice(0, tabLine!.text.indexOf(part)))
  expect(tabs[columnOf('协作')]?.bg).toBe('#d8dce4')
  expect(tabs[columnOf('后台命令')]?.bg).toBe(null)

  // 页签与列表之间留一行白——层次靠这个空行，不靠分隔线
  const after = dock.slice(dock.indexOf(tabLine!) + 1)
  expect(after[0]?.text.trim()).toBe('')

  // 选中那一条：整行铺底色（左右各留一格外边距），左端是 `❯`
  const selected = dock.find((line) => line.text.includes('❯'))
  expect(selected).toBeDefined()
  const cells = frame.cellsOf(selected!.row)
  expect(cells.slice(1, columns - 1).every((cell) => cell.bg === '#1b2530')).toBe(true)

  // 没选中的行不铺底色（底色只表焦点，不是装饰）
  const work = dock.find((line) => line.text.includes('回到主会话'))
  expect(work).toBeDefined()
  expect(frame.cellsOf(work!.row).every((cell) => cell.bg === null)).toBe(true)

  // 位置：工作行（带 meta）状态靠右对齐——收在同一列（右边留一格外边距）；
  // 成员行是 Claude 式左流（meta 为空），文本到内容为止，整行底色由 Box 铺满。
  expect(displayWidth(work!.text.trimEnd())).toBe(columns - 1)
  const selectedRow = dock.find((line) => line.text.includes('● 实现'))
  expect(displayWidth(selectedRow!.text.trimEnd())).toBeLessThan(columns - 1)

  // **一条分隔线都不画**（`─` 只该出现在记录区与交互区那两条界上）
  expect(dock.slice(dock.indexOf(tabLine!)).some((line) => line.text.includes('──'))).toBe(false)

  // 账与屏同源（U31 那一族的老病：矮终端上真光标高一行）
  expect(dock.length).toBe(dockHeightOf(view, columns, rows))
})

test('面板式：按 Tab 切到后台那一屏，页签同构、只换点亮的那一段', () => {
  const stage = collaborationStage()
  stage.key('tab')
  const before = stage.view().dock
  if (before.kind !== 'picker') throw new Error('协作那一屏没打开')
  expect(before.picker.tabs).toEqual(workTabs('collaboration'))

  stage.key('tab')
  const after = stage.view().dock
  if (after.kind !== 'picker') throw new Error('后台那一屏没打开')
  expect(after.picker.tabs).toEqual(workTabs('background'))
  // 两屏页签**同一副样子**：只有 `active` 换了位置
  expect(after.picker.tabs?.map((tab) => tab.label)).toEqual(before.picker.tabs?.map((tab) => tab.label))

  // 不可逆的工作级动作带语义色；成员在跑的那一行标 `run`（状态位走呼吸）
  stage.key('tab')
  const list = stage.view().dock
  if (list.kind !== 'picker') throw new Error('协作那一屏没打开')
  const rows = new Map(list.picker.rows.map((row) => [row.value, row] as const))
  expect(rows.get('stop-work')?.tone).toBe('danger')
  expect(rows.get('worker')?.tone).toBe('run')
})
