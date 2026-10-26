import { expect, test } from 'bun:test'
import type { Command, Knowledge } from '@magic/contracts'
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
    stage.feed([event('memory.state', { requestId: command.requestId, session: command.session, workspace: [], memory: { session: command.session!, revision: 1, items: [], inspectedThrough: null, summary: null, coveredThrough: null } })])
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
  for (let n = 0; n < 3; n++) stage.press({ kind: 'escape' })
  stage.type('/memory '); stage.press(enter)
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
