import { expect, test } from 'bun:test'
import type { Command, Knowledge, NoteState } from '@magic/contracts'
import { createStage } from './screen.ts'
import { event } from './events.ts'

const knowledge: Knowledge = { id: 'knowledge-id', topic: '长中文知识 😀 é', scope: { kind: 'user' }, conclusion: '旧认识', conditions: '仅满足条件时', terms: [], evidence: 'hypothesis', status: 'active', revision: 3, sources: [{ session: 'source', entry: 9 }], dependencies: [] }
const enter = { kind: 'enter' } as const
function last<T extends Command['type']>(stage: ReturnType<typeof createStage>, type: T): Command & { type: T } {
  return stage.commands().findLast(command => command.type === type) as Command & { type: T }
}
function choose(stage: ReturnType<typeof createStage>, value: string) {
  const view = stage.shell.getView()
  if (view.dock.kind !== 'picker') throw new Error('未打开阅读层')
  const index = view.dock.picker.rows.findIndex(row => row.value === value)
  if (index < 0) throw new Error(`找不到动作 ${value}`)
  const move = index - view.dock.picker.selected
  for (let n = 0; n < Math.abs(move); n++) stage.press({ kind: move > 0 ? 'down' : 'up' })
  stage.press(enter)
}
function openKnowledge(archived = false) {
  const stage = createStage()
  if (archived) stage.feed([event('session.state', { active: 'session-test', sessions: [{ id: 'session-test', at: 1, archived: true }] }), event('session.changed', { session: 'session-test', archived: true, canArchive: false, terminalOpen: false })])
  stage.type('/memory '); stage.press(enter)
  const command = stage.commands().findLast(command => command.type === 'knowledge.query' || command.type === 'memory.read')!
  if (command.type === 'memory.read') {
    stage.feed([event('memory.state', { requestId: command.requestId, session: command.session, workspace: [], notes: { directory: '/isolated/notes', path: 'MEMORY.md', status: 'empty', files: [] } })])
    choose(stage, 'knowledge')
  }
  const query = last(stage, 'knowledge.query')
  stage.feed([event('knowledge.state', { requestId: query.requestId, workspace: [], page: { items: [knowledge] } })])
  choose(stage, `item:${knowledge.id}`)
  return stage
}
test('记忆阅读和纠正只入稿，保留真实知识身份/修订，不写或发送', async () => {
  const stage = openKnowledge()
  for (const columns of [100, 200]) {
    const screen = await stage.screen({ columns, rows: 40 })
    expect(screen.has('假设')).toBe(true)
    expect(screen.has('修订 3')).toBe(true)
  }
  choose(stage, 'correct')
  expect(stage.shell.getView().refs[0]).toMatchObject({ kind: 'memory', source: 'knowledge-id', revision: 3, scope: { kind: 'user' } })
  expect(stage.commands().some(command => command.type === 'input.submit' || command.type === 'knowledge.forget')).toBe(false)
})
test('遗忘默认返回，新修订冲突需重新明确确认，原请求回查不重发', () => {
  const stage = openKnowledge()
  choose(stage, 'forget')
  stage.press(enter)
  expect(stage.commands().some(command => command.type === 'knowledge.forget')).toBe(false)
  choose(stage, 'forget'); choose(stage, 'confirm-forget')
  const request = stage.commands().findLast(command => command.type === 'knowledge.forget')!
  expect(request).toMatchObject({ id: knowledge.id, expectedRevision: 3 })
  stage.feed([event('knowledge.forgotten', { requestId: (request as { requestId: string }).requestId, result: { status: 'changed', current: { ...knowledge, revision: 4, conclusion: '新认识' } } })])
  choose(stage, 'review-forget')
  expect(stage.commands().filter(command => command.type === 'knowledge.forget')).toHaveLength(1)
  stage.press(enter)
  expect(stage.commands().filter(command => command.type === 'knowledge.forget')).toHaveLength(1)
})
test('来源分页返回保原焦点，迟到读取不把已返回页面盖回去', () => {
  const stage = openKnowledge()
  choose(stage, 'source:0')
  const request = last(stage, 'memory.source')
  stage.feed([event('memory.source', { requestId: request.requestId, page: { source: request.source, speaker: '用户', kind: 'user', text: '第一段', total: 9, complete: false, next: 3 } })])
  choose(stage, 'next-source')
  const next = last(stage, 'memory.source')
  expect(next.source.offset).toBe(3)
  stage.press({ kind: 'escape' })
  stage.feed([event('memory.source', { requestId: next.requestId, page: { source: next.source, speaker: '用户', kind: 'user', text: '迟到第二段', total: 9, complete: true } })])
  const view = stage.shell.getView()
  expect(view.dock.kind === 'picker' && view.dock.picker.detail).toEqual(['第一段'])
})

test('归档会话仍可明确遗忘适用知识，不恢复来源或启动工作', () => {
  const stage = openKnowledge(true)
  choose(stage, 'forget'); choose(stage, 'confirm-forget')
  expect(stage.commands().findLast(command => command.type === 'knowledge.forget')).toMatchObject({ id: knowledge.id, expectedRevision: 3 })
  expect(stage.commands().some(command => ['session.restore', 'session.new', 'input.submit', 'collaboration.input'].includes(command.type))).toBe(false)
})

test('遗忘未确认时退出阅读后仍查询原请求，不生成第二次遗忘', () => {
  const stage = openKnowledge()
  choose(stage, 'forget'); choose(stage, 'confirm-forget')
  const request = last(stage, 'knowledge.forget')
  for (let n = 0; n < 4; n++) stage.press({ kind: 'escape' })
  stage.type('/memory '); stage.press(enter)
  const read = last(stage, 'memory.read')
  stage.feed([event('memory.state', { requestId: read.requestId, workspace: [] })])
  choose(stage, 'knowledge')
  const query = last(stage, 'knowledge.query')
  stage.feed([event('knowledge.state', { requestId: query.requestId, workspace: [], page: { items: [knowledge] } })])
  choose(stage, `pending-forget:${request.requestId}`)
  expect(last(stage, 'knowledge.forget-result')).toEqual({ ...request, type: 'knowledge.forget-result' })
  expect(stage.commands().filter(command => command.type === 'knowledge.forget')).toHaveLength(1)
  stage.feed([event('knowledge.forgotten', { requestId: request.requestId, result: { status: 'completed' } })])
  const dock = stage.shell.getView().dock
  expect(dock.kind === 'picker' && dock.picker.memory?.mode).toBe('knowledge')
  expect(dock.kind === 'picker' && dock.picker.rows.some(row => row.value.startsWith('pending-forget:'))).toBe(false)
})

test('已受理会话引用可沿来源入口读取，始终携带原输入身份', () => {
  const stage = createStage()
  stage.feed([event('session.state', { active: 'target', sessions: [{ id: 'target', at: 1, archived: false }] })])
  stage.type('/memory '); stage.press(enter)
  const request = last(stage, 'memory.read')
  stage.feed([event('memory.state', { requestId: request.requestId, session: 'target', workspace: [], references: [{ inputRef: 'accepted-input', title: '@历史工作', source: 'origin', through: 9, sources: [{ session: 'origin', entry: 7 }] }] })])
  choose(stage, 'reference:0'); choose(stage, 'reference-source:0')
  expect(last(stage, 'memory.source')).toMatchObject({ session: 'target', inputRef: 'accepted-input', source: { session: 'origin', entry: 7 } })
  expect(stage.commands().some(command => command.type === 'input.submit')).toBe(false)
})

function openNotes() {
  const stage = createStage()
  stage.feed([event('session.state', { active: 'notes-session', sessions: [{ id: 'notes-session', title: '中文任务 👩🏽‍💻', at: 1, archived: false }] })])
  stage.type('/memory '); stage.press(enter)
  return stage
}
function deliverNotes(stage: ReturnType<typeof createStage>, notes?: NoteState) {
  const request = last(stage, 'memory.read')
  stage.feed([event('memory.state', { requestId: request.requestId, session: request.session, workspace: [], notes })])
}
function noteState(path = 'MEMORY.md', text = '正文 👩🏽‍💻 é', next?: number): NoteState {
  return { directory: '/isolated/notes', path, status: 'ready', files: [path], page: {
    session: 'notes-session', path, absolute: '/isolated/notes/' + path, text, from: 1,
    through: next === undefined ? 2 : 1, totalLines: next === undefined ? 2 : 9999, complete: next === undefined, next, cursor: 'opaque-version',
    links: [{ kind: 'note', label: '同名主题', path: '子目录/主题.md' }, { kind: 'unavailable', label: '越界位置', target: '../业务.md', reason: '不在本会话笔记范围' }, { kind: 'source', label: '原始交代', source: { session: 'notes-session', entry: 2 } }],
  } }
}
function picker(stage: ReturnType<typeof createStage>) {
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('应在阅读层')
  return dock.picker
}
test('笔记空态与仅主题可辨，读取不查询知识，主题纠正以路径身份入稿和召回', async () => {
  const stage = openNotes()
  deliverNotes(stage, { directory: '/isolated/notes', path: 'MEMORY.md', status: 'entry-missing', files: ['子目录/主题.md'] })
  expect(picker(stage).hint).toContain('尚无入口笔记')
  choose(stage, 'file:子目录/主题.md')
  expect(last(stage, 'memory.read')).toMatchObject({ session: 'notes-session', path: '子目录/主题.md' })
  deliverNotes(stage, noteState('子目录/主题.md'))
  for (const columns of [100, 200]) {
    const screen = await stage.screen({ columns, rows: 40 })
    expect(screen.has('子目录/主题.md')).toBe(true)
    expect(screen.has('修订')).toBe(false)
    expect(screen.has('opaque-version')).toBe(false)
  }
  choose(stage, 'correct-note')
  expect(stage.shell.getView().refs[0]).toMatchObject({ kind: 'note', source: '子目录/主题.md', session: 'notes-session' })
  expect(stage.commands().some(command => ['input.submit', 'knowledge.query'].includes(command.type))).toBe(false)
  stage.type(' 请纠正这段'); stage.press(enter)
  const input = last(stage, 'input.submit')
  expect(input.refs?.[0]).toMatchObject({ kind: 'note', source: '子目录/主题.md', session: 'notes-session' })
  stage.press({ kind: 'up' })
  expect(stage.shell.getView().refs[0]).toMatchObject({ kind: 'note', source: '子目录/主题.md', session: 'notes-session' })
})
test('笔记续读带宿主游标，变化不混拼，重新读取与来源往返保持身份', () => {
  const stage = openNotes()
  deliverNotes(stage, noteState('MEMORY.md', '旧片段', 3))
  choose(stage, 'next-note')
  expect(last(stage, 'memory.read')).toMatchObject({ from: 3, cursor: 'opaque-version', path: 'MEMORY.md' })
  deliverNotes(stage, { directory: '/isolated/notes', path: 'MEMORY.md', status: 'changed', files: ['MEMORY.md'] })
  expect(picker(stage).hint).toContain('内容已变化')
  expect(picker(stage).detail).toContain('旧片段')
  expect(picker(stage).rows.some(row => row.value === 'next-note')).toBe(false)
  choose(stage, 'refresh')
  expect(last(stage, 'memory.read').cursor).toBeUndefined()
  expect(last(stage, 'memory.read').from).toBeUndefined()
  deliverNotes(stage, noteState('MEMORY.md', '外部编辑后的当前正文'))
  expect(picker(stage).detail).toContain('外部编辑后的当前正文')
  expect(picker(stage).detail).not.toContain('旧片段')
  choose(stage, 'link:1')
  expect(picker(stage).hint).toContain('不在本会话笔记范围')
  choose(stage, 'link:2')
  expect(last(stage, 'memory.source')).toMatchObject({ path: 'MEMORY.md', source: { session: 'notes-session', entry: 2 } })
  stage.press({ kind: 'escape' })
  expect(picker(stage).detail).toContain('外部编辑后的当前正文')
})
test('笔记读取失败和缺失保留旧内容，迟到主题响应不覆盖返回页', () => {
  const stage = openNotes()
  deliverNotes(stage, noteState())
  choose(stage, 'refresh')
  stage.feed([event('memory.state', { requestId: last(stage, 'memory.read').requestId, workspace: [], session: 'notes-session', error: '读取被拒绝' })])
  expect(picker(stage).detail).toContain('正文 👩🏽‍💻 é')
  expect(picker(stage).hint).toContain('读取被拒绝')
  choose(stage, 'refresh')
  deliverNotes(stage, { directory: '/isolated/notes', path: 'MEMORY.md', status: 'missing', files: [] })
  expect(picker(stage).detail).toContain('正文 👩🏽‍💻 é')
  expect(picker(stage).hint).toContain('文件已不存在')
  choose(stage, 'refresh')
  deliverNotes(stage, { directory: '/isolated/notes', path: 'MEMORY.md', status: 'empty', files: [] })
  expect(picker(stage).detail).toContain('正文 👩🏽‍💻 é')
  expect(picker(stage).hint).toContain('此前已读内容保留')
  choose(stage, 'refresh'); deliverNotes(stage, noteState())
  choose(stage, 'link:0')
  const request = last(stage, 'memory.read')
  stage.press({ kind: 'escape' })
  stage.feed([event('memory.state', { requestId: request.requestId, workspace: [], session: 'notes-session', notes: noteState('子目录/主题.md', '迟到主题') })])
  expect(picker(stage).detail).toContain('正文 👩🏽‍💻 é')
  expect(picker(stage).detail).not.toContain('迟到主题')
})
