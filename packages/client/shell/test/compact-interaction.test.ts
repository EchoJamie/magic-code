import { expect, test } from 'bun:test'
import { createStage } from './screen.ts'
import { event } from './events.ts'

function stageFor(session = 'session-test') {
  const stage = createStage()
  stage.feed([event('session.state', { active: session, sessions: [{ id: session, at: 1, archived: false }] })])
  return stage
}
test('主动压缩固定请求目标与重点，受理前保稿，不走普通输入或业务命令', () => {
  const stage = stageFor()
  stage.type('/compact 保留中文要求 😀 é')
  stage.press({ kind: 'enter' })
  const request = stage.commands().findLast(command => command.type === 'compact.request')
  expect(request).toMatchObject({ type: 'compact.request', session: 'session-test', focus: '保留中文要求 😀 é' })
  expect(stage.shell.getView().draft).toBe('/compact 保留中文要求 😀 é')
  expect(stage.commands().some(command => command.type === 'input.submit')).toBe(false)
  if (request?.type !== 'compact.request') throw new Error('缺少请求')
  stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'compact.query', session: 'session-test', requestId: request.requestId })
  stage.feed([event('compact.state', { requestId: request.requestId, accepted: true, focus: request.focus, state: 'pending' })])
  expect(stage.shell.getView().draft).toBe('')
  expect(stage.shell.getView().flash).toBeNull()
  stage.feed([event('compact.state', { requestId: request.requestId, accepted: true, focus: request.focus, state: 'running' })])
  expect(stage.shell.getView().flash).toBeNull()
  stage.type('/status ')
  stage.press({ kind: 'enter' })
  const dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('缺少压缩请求面板')
  expect(dock.picker.title).toBe('本会话压缩请求')
  expect(dock.picker.detail).toBeUndefined()
  expect(dock.picker.rows.map(row => row.value)).toEqual([`query:${request.requestId}`, `cancel:${request.requestId}`, 'back'])
  expect(dock.picker.rows[0]?.detail).toContain(`本次重点：${request.focus}`)
  stage.press({ kind: 'escape' })
  stage.type('新的草稿')
  stage.feed([event('compact.state', { requestId: request.requestId, accepted: true, state: 'failed', reason: '模型不可用' })])
  expect(stage.shell.getView().draft).toBe('新的草稿')
  expect(stage.shell.getView().flash).toBe('压缩失败：模型不可用')
})
test('无会话不创建；补全与召回不执行；终态不被迟到 pending 覆盖', () => {
  const empty = createStage()
  empty.type('/compact '); empty.press({ kind: 'enter' })
  expect(empty.commands().some(command => command.type === 'compact.request' || command.type === 'session.new')).toBe(false)
  const stage = stageFor()
  stage.type('/comp'); stage.press({ kind: 'tab' })
  expect(stage.commands().some(command => command.type === 'compact.request')).toBe(false)
  stage.press({ kind: 'enter' })
  const request = stage.commands().findLast(command => command.type === 'compact.request')!
  if (request.type !== 'compact.request') throw new Error('缺少请求')
  stage.feed([event('compact.state', { requestId: request.requestId, state: 'completed', accepted: true, summary: 77 })])
  expect(stage.shell.getView().flash).toBe('压缩完成')
  stage.feed([event('compact.state', { requestId: request.requestId, state: 'pending', accepted: true })])
  expect(stage.shell.getView().compactions.at(-1)?.state.state).toBe('completed')
  expect(stage.shell.getView().flash).toBe('压缩完成')
  const before = stage.commands().length
  stage.press({ kind: 'up' })
  expect(stage.shell.getView().draft.startsWith('/compact ')).toBe(true)
  expect(stage.commands()).toHaveLength(before)
})

test.each(['failed', 'cancelled', 'interrupted'] as const)('部分笔记保存后的 %s 保留保存事实，查询沿原请求', state => {
  const stage = stageFor()
  stage.feed([event('compact.state', { requestId: 'saved-notes', accepted: true, state: 'running', notesSaved: true })])
  stage.type('/status '); stage.press({ kind: 'enter' })
  let dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('缺少压缩请求面板')
  expect(dock.picker.rows[0]?.detail).toContain('已保存的笔记保留，本次历史收缩未完成')
  stage.press({ kind: 'escape' })
  stage.feed([event('compact.state', { requestId: 'saved-notes', accepted: true, state, notesSaved: true })])
  expect(stage.shell.getView().flash).toContain('已保存的笔记保留，本次历史收缩未完成')
  stage.type('/status '); stage.press({ kind: 'enter' })
  dock = stage.shell.getView().dock
  if (dock.kind !== 'picker') throw new Error('缺少压缩请求面板')
  expect(dock.picker.rows.map(row => row.value)).toEqual(['query:saved-notes', 'back'])
  stage.press({ kind: 'enter' })
  expect(stage.commands().at(-1)).toEqual({ type: 'compact.query', session: 'session-test', requestId: 'saved-notes' })
})
