import { describe, expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import { event } from './events.ts'
import { createSpyTransport } from './fakes.ts'

function input() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { magicBase: "/tmp/Magic ' instance/.magic", workspaceRoots: ["/tmp/Work ' space"] })
  const paste = (text: string) => shell.key({ kind: 'paste', text })
  const key = (kind: 'ctrl+c' | 'ctrl+p' | 'up' | 'down' | 'enter' | 'escape' | 'left' | 'tab') => shell.key({ kind })
  const clear = (text: string) => { paste(text); key('ctrl+c') }
  const send = (text: string) => { paste(text); key('enter'); const command = spy.commands.findLast(one => one.type === 'input.submit'); if (command?.type !== 'input.submit') throw Error('missing submit'); return command.ref! }
  return { spy, shell, paste, key, clear, send, view: shell.getView }
}

describe('输入召回与清空', () => {
  test('召回 slash、多行不打开候选、不抢多行光标，越过最新还原空稿', () => {
    const s = input()
    s.send('old\nlines')
    s.clear('/')
    s.key('up'); expect(s.view().draft).toBe('/'); expect(s.view().completion).toBeNull()
    s.key('up'); expect(s.view().draft).toBe('old\nlines')
    s.key('down'); expect(s.view().draft).toBe('/')
    s.key('down'); expect(s.view().draft).toBe(''); expect(s.view().caret).toBe(0)
    s.key('up'); s.key('tab'); expect(s.view().draft).toStartWith('/'); expect(s.view().completion).not.toBeNull()
    s.shell.dispose()
  })
  test('整份原稿及光标还原；显式移动后退出历史浏览', () => {
    const s = input(); s.send('old\nline'); s.paste('新稿'); s.key('left')
    s.key('ctrl+p'); s.key('down'); expect(s.view().draft).toBe('新稿'); expect(s.view().caret).toBe(1)
    s.key('ctrl+p'); s.key('left'); s.key('down'); expect(s.view().draft).toBe('old\nline')
    s.shell.dispose()
  })
  test('清稿不停止、不计双按退出；未编辑临时稿重复清空不重复入列', () => {
    const s = input(); s.clear('A'); s.key('up'); s.key('ctrl+c'); s.key('up'); s.key('up')
    expect(s.view().draft).toBe('A'); s.key('down'); expect(s.view().draft).toBe('')
    s.spy.emit(event('turn.start', {})); s.clear('B'); expect(s.view().dock.kind).toBe('input'); expect(s.view().exitArmed).toBe(false)
    expect(s.spy.commands.some(one => one.type === 'turn.interrupt')).toBe(false)
    s.key('ctrl+c'); expect(s.view().dock.kind).toBe('picker'); s.shell.dispose()
  })
  test('C 成功只清它提交时的 A/B；后来清空 D 留下，执行失败不复活旧批次', () => {
    const s = input(); s.send('old'); s.clear('A'); s.clear('B'); const ref = s.send('C'); s.clear('D')
    s.key('up'); expect(s.view().draft).toBe('D'); s.key('down')
    s.spy.emit(event('input.settled', { ref, ok: true, stage: 'accepted' }))
    s.key('up'); expect(s.view().draft).toBe('D'); s.key('up'); expect(s.view().draft).toBe('C'); s.key('up'); expect(s.view().draft).toBe('old')
    s.spy.emit(event('input.settled', { ref, ok: false, reason: 'execution failed' }))
    s.key('down'); expect(s.view().draft).toBe('C'); s.shell.dispose()
  })
  test('拒绝或材料失败保留临时批次，审批 Ctrl+C 不清隐藏草稿', () => {
    const s = input(); s.clear('A'); const ref = s.send('C')
    s.spy.emit(event('input.settled', { ref, ok: false, reason: 'refused' }))
    s.key('up'); expect(s.view().draft).toBe('A'); s.key('down'); expect(s.view().draft).toBe('C')
    s.spy.emit(event('tool.decision.request', { call: 99, name: 'exec', material: 'command', weight: 'heavy' }))
    s.key('ctrl+c'); s.key('ctrl+c'); expect(s.view().stashed?.draft).toBe('C'); s.shell.dispose()
  })
  test('完整图片引用和光标随清稿召回；成功回执只处理原会话批次', () => {
    const s = input()
    const select = (active:string) => s.spy.emit(event('session.state',{active,sessions:[{id:'one',at:1,archived:false},{id:'two',at:2,archived:false}]}))
    select('one')
    s.shell.attachMaterial({blob:'image-content',mime:'image/png',name:'source.png',marker:'Image#1',source:'/tmp/source.png',label:'source.png'})
    s.paste('说明'); s.key('left')
    const original = s.view()
    s.key('ctrl+c'); s.key('up')
    expect(s.view().refs).toEqual(original.refs); expect(s.view().caret).toBe(original.caret)
    s.key('down'); const ref=s.send('C')
    select('two'); s.clear('第二个会话的草稿')
    s.spy.emit(event('input.settled',{ref,ok:true,stage:'accepted'},{session:'one'}))
    s.key('up'); expect(s.view().draft).toBe('第二个会话的草稿'); s.key('down')
    select('one'); s.key('up'); expect(s.view().draft).toBe('C')
    s.key('up'); expect(s.view().draft).toBe('C')
    s.shell.dispose()
  })
  test('失败本地命令保留批次，确已受理的本地命令清理原批次', () => {
    const s = input(); s.clear('A'); s.paste('/config wrong'); s.key('enter')
    s.key('up'); expect(s.view().draft).toBe('A'); s.key('down'); s.key('ctrl+c')
    s.paste('/config '); s.key('enter')
    s.spy.emit(event('model.catalog',{entries:[]}))
    s.spy.emit(event('grants.catalog',{workspace:'/tmp',grants:[],stale:[],decisions:{total:0,uncovered:0,vetoed:0},history:{total:0,auto:0,kernel:0}}))
    s.spy.emit(event('mcp.catalog',{servers:[]}))
    s.key('escape'); s.key('up'); expect(s.view().draft).toBe('/config ')
    s.key('up'); expect(s.view().draft).toBe('/config wrong')
    s.shell.dispose()
  })
  test('空入口无恢复命令；实际会话的命令使用父目录及完整 shell 转义', () => {
    const s = input(); expect(s.shell.exitNote()).toBeNull()
    s.spy.emit(event('session.state', { active: "session'1", sessions: [] }))
    expect(s.shell.exitNote()).toBe(`恢复此会话：\ncd -- '/tmp/Work '\\'' space' && MAGIC_HOME='/tmp/Magic '\\'' instance' magic resume 'session'\\''1'`)
    s.shell.dispose()
  })
})