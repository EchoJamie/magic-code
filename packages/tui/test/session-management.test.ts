import { describe, expect, test } from 'bun:test'
import type { SessionSummary } from '@magic/contracts'
import { createShell, type ShellKey } from '../src/shell.ts'
import { toShellKeys } from '../src/components/app.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'

const current: SessionSummary = { id: 'current', title: '当前', at: 0, archived: false, canArchive: true, terminalOpen: true, workspace: ['/project'] }
const archived: SessionSummary = { id: 'archived', title: '旧工作', at: 1, archived: true, canArchive: false, terminalOpen: false, workspace: ['/project'] }
function setup() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { magicBase: '/isolated', workspaceRoots: ['/project'] })
  const key = (kind: ShellKey['kind']) => shell.key({ kind } as ShellKey)
  const state = (sessions: readonly SessionSummary[]) => spy.emit(event('session.state', { active: current.id, sessions }))
  state([current])
  const open = () => { shell.key({ kind: 'char', char: '/resume ' }); key('enter'); state([current]) }
  const picker = () => { const dock = shell.getView().dock; if (dock.kind !== 'picker') throw new Error('Expected picker'); return dock.picker }
  const choose = (value: string) => {
    const index = picker().rows.findIndex(row => row.value === value)
    expect(index).toBeGreaterThanOrEqual(0)
    while (picker().selected !== index) key('down')
    key('enter')
  }
  return { spy, shell, key, state, open, picker, choose }
}

describe('会话整理', () => {
  test('Shift+Tab 与 Ctrl+G 使用独立键，不抢 Tab 与普通文字', () => {
    expect(toShellKeys('', { tab: true, shift: true })).toEqual([{ kind: 'shift+tab' }])
    expect(toShellKeys('', { tab: true })).toEqual([{ kind: 'tab' }])
    expect(toShellKeys('g', { ctrl: true })).toEqual([{ kind: 'ctrl+g' }])
  })

  test('切换归档保留搜索与工作区；Enter 只读目标历史，Esc 保位不换执行会话', () => {
    const a = setup()
    a.open(); a.key('tab')
    a.shell.key({ kind: 'char', char: '旧' })
    a.key('shift+tab')
    expect(a.spy.commands.at(-1)).toEqual({ type: 'session.list', archived: true })
    a.state([archived])
    expect(a.picker().filter).toBe('旧')
    expect(a.picker().hint).toContain('本工作区')
    a.key('enter')
    expect(a.spy.commands.at(-1)).toEqual({ type: 'history.read', session: archived.id })
    expect(a.picker().reader?.title).toContain('已归档')
    a.spy.emit(event('session.history', { session: archived.id, entries: [{ id: 1, at: 1, kind: 'assistant', content: { text: '保存的历史' } }], inputs: [event('input.local', { text: '/rename 旧工作', refs: [], ref: 'local-history' })], timing: [event('turn.start', {}, { id: 10, session: archived.id }), event('turn.end', { reason: 'settled' }, { id: 1010, session: archived.id })], done: true }))
    expect(JSON.stringify(a.picker().reader?.rows)).toContain('保存的历史')
    expect(JSON.stringify(a.picker().reader?.rows)).toContain('/rename 旧工作')
    expect(a.picker().reader?.rows.find(row => row.kind === 'round')).toMatchObject({ kind: 'round', timing: { end: 1_700_000_001_010 } })
    expect(a.shell.getView().sessionId).toBe(current.id)
    a.shell.key({ kind: 'readerTop', top: 3 }); a.key('escape')
    expect(a.picker().source).toBe('session')
    expect(a.picker().filter).toBe('旧')
    expect(a.picker().rows[a.picker().selected]?.value).toBe(archived.id)
    expect(a.spy.commands.some(command => command.type === 'session.open' || command.type === 'session.restore')).toBe(false)
    a.shell.dispose()
  })

  test('归档资格只看投影；菜单无停止；失败保目标，成功相邻焦点', () => {
    const a = setup(); a.open()
    a.state([{ ...current, canArchive: false }]); a.key('ctrl+g')
    expect(a.picker().rows.map(row => row.value)).toEqual(['history', 'rename'])
    a.key('escape'); a.state([current, { ...current, id: 'next', title: '相邻' }]); a.key('ctrl+g'); a.choose('archive')
    expect(a.spy.commands.at(-1)).toEqual({ type: 'session.archive', session: current.id })
    const count = a.spy.commands.length; a.key('enter'); expect(a.spy.commands.length).toBe(count)
    a.spy.emit(event('session.managed', { session: current.id, action: 'archive', ok: false, error: '刚开始执行' }))
    expect(a.picker().source).toBe('session-actions'); expect(a.shell.getView().flash).toBe('刚开始执行')
    a.key('enter')
    a.spy.emit(event('session.changed', { session: current.id, archived: true, canArchive: false, terminalOpen: true }))
    a.spy.emit(event('session.managed', { session: current.id, action: 'archive', ok: true, archived: true }))
    a.state([{ ...current, id: 'next', title: '相邻' }])
    expect(a.picker().source).toBe('session'); expect(a.picker().rows[a.picker().selected]?.value).toBe('next')
    a.shell.dispose()
  })

  test('恢复后普通列表选中原对象，同次 Enter 不接回或发送', () => {
    const a = setup(); a.open(); a.key('shift+tab'); a.state([archived]); a.key('ctrl+g'); expect(a.picker().rows.map(row => row.value)).toEqual(['history', 'restore']); a.choose('restore')
    a.spy.emit(event('session.managed', { session: archived.id, action: 'restore', ok: true, archived: false }))
    a.state([current, { ...archived, archived: false, canArchive: true }])
    expect(a.picker().title).toContain('普通')
    expect(a.picker().rows[a.picker().selected]?.value).toBe(archived.id)
    expect(a.spy.commands.some(command => command.type === 'session.open')).toBe(false)
    a.key('enter'); expect(a.spy.commands.at(-1)).toEqual({ type: 'session.open', session: archived.id })
    a.shell.dispose()
  })

  test('被归档原草稿含引用与光标保留、只读可查看，明确恢复后原样编辑', () => {
    const a = setup()
    a.shell.key({ kind: 'char', char: '保留 ' })
    a.shell.attachMaterial({ marker: 'Image#1', name: '原图', mime: 'image/png', blob: 'sha256:123', label: '原图', source: '/project/原图.png' })
    const original = { draft: a.shell.getView().draft, refs: a.shell.getView().refs, caret: a.shell.getView().caret }
    a.key('escape')
    a.spy.emit(event('session.changed', { session: current.id, archived: true, canArchive: false, terminalOpen: true }))
    expect(a.shell.exitNote()).toBeNull()
    const count = a.spy.commands.length
    a.key('enter'); a.shell.key({ kind: 'char', char: '不能编辑' }); a.key('backspace')
    expect(a.spy.commands.length).toBe(count)
    expect({ draft: a.shell.getView().draft, refs: a.shell.getView().refs, caret: a.shell.getView().caret }).toEqual(original)
    a.key('ctrl+g'); a.choose('draft')
    expect(JSON.stringify(a.picker().reader?.rows)).toContain(original.draft)
    a.key('escape'); a.choose('restore')
    a.spy.emit(event('session.changed', { session: current.id, archived: false, canArchive: true, terminalOpen: true }))
    a.spy.emit(event('session.managed', { session: current.id, action: 'restore', ok: true, archived: false }))
    expect(a.shell.getView().dock.kind).toBe('input')
    expect(a.shell.exitNote()).toContain('magic resume')
    expect({ draft: a.shell.getView().draft, refs: a.shell.getView().refs, caret: a.shell.getView().caret }).toEqual(original)
    expect(a.spy.commands.some(command => command.type === 'input.submit')).toBe(false)
    a.shell.key({ kind: 'char', char: '继续' })
    expect(a.shell.getView().draft).toContain('继续')
    a.shell.dispose()
  })

  test('改名失败留字段与输入，Esc 逐层返回', () => {
    const a = setup(); a.open(); a.key('ctrl+g'); a.choose('rename')
    a.shell.key({ kind: 'char', char: '新名' }); a.key('enter')
    a.spy.emit(event('session.managed', { session: current.id, action: 'rename', ok: false, error: '写入失败' }))
    const dock = a.shell.getView().dock
    expect(dock.kind).toBe('prompt'); if (dock.kind === 'prompt') expect(dock.prompt.display).toContain('新名')
    expect(a.shell.getView().flash).toBe('写入失败')
    a.key('escape'); expect(a.picker().source).toBe('session-actions')
    a.key('escape'); expect(a.picker().source).toBe('session')
    a.shell.dispose()
  })
  test('历史读取失败留在阅读层、重试可读；已返回的迟到预览不重建主对话', () => {
    const a = setup(); a.open(); a.key('ctrl+g'); a.choose('history')
    a.spy.emit(event('session.history', { session: current.id, entries: [], done: true, error: '暂不可读' }))
    expect(a.picker().source).toBe('session-history'); expect(a.shell.getView().flash).toContain('Enter 重试')
    a.key('enter'); expect(a.spy.commands.at(-1)).toEqual({ type: 'history.read', session: current.id })
    a.key('escape'); a.key('escape'); a.key('escape')
    a.spy.emit(event('session.history', { session: current.id, entries: [{ id: 1, kind: 'assistant', content: { text: '迟到预览' }, at: 1 }], done: true }))
    expect(JSON.stringify(a.shell.getView().rows)).not.toContain('迟到预览')
    a.shell.dispose()
  })

  test('归档终端 /resume 不修改原稿，Esc 原样返回；菜单按新投影撤销资格', () => {
    const a = setup()
    a.shell.key({ kind: 'char', char: '原稿' })
    a.spy.emit(event('session.changed', { session: current.id, archived: true, canArchive: false, terminalOpen: true }))
    a.shell.key({ kind: 'char', char: '/resume' }); a.key('enter'); a.state([])
    expect(a.picker().source).toBe('session'); expect(a.shell.getView().draft).toBe('原稿')
    a.key('escape'); expect(a.shell.getView().draft).toBe('原稿')
    a.spy.emit(event('session.changed', { session: current.id, archived: false, canArchive: true, terminalOpen: true }))
    a.shell.dispose()
    const b = setup(); b.open(); b.key('ctrl+g')
    b.spy.emit(event('session.changed', { session: current.id, archived: false, canArchive: false, terminalOpen: true }))
    expect(b.picker().rows.map(row => row.value)).toEqual(['history', 'rename'])
    b.spy.emit(event('session.changed', { session: current.id, archived: true, canArchive: false, terminalOpen: true }))
    expect(b.picker().rows.map(row => row.value)).not.toContain('rename')
    b.shell.dispose()
  })

  test.each([true, false])('本地改名以管理回执决定临时草稿批次是否清除：ok=%s', (ok) => {
    const a = setup()
    a.shell.key({ kind: 'paste', text: '临时稿' }); a.key('ctrl+c')
    a.shell.key({ kind: 'paste', text: '/rename 新名' }); a.key('enter')
    expect(a.spy.commands.at(-1)).toEqual({ type: 'session.rename', session: current.id, title: '新名' })
    a.spy.emit(event('session.managed', { session: current.id, action: 'rename', ok, ...(ok ? {} : { error: '写入失败' }) }))
    a.key('up')
    expect(a.shell.getView().draft).toBe(ok ? '/rename 新名' : '临时稿')
    a.shell.dispose()
  })

})
