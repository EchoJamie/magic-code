import { describe, expect, test } from 'bun:test'
import type { TurnTimingEvent } from '@magic/contracts'
import { createShell } from '../src/shell.ts'
import { createView, reduce, rebuild } from '../src/view.ts'
import { foldRound, roundDuration, roundSummary } from '../src/round.ts'
import { roundLineText } from '../src/components/app.ts'
import { rowLines } from '../src/components/log.ts'
import { createSpyTransport } from './fakes.ts'
import { event, TEST_AT, TEST_SESSION } from './events.ts'
import { createStage } from './screen.ts'

function input() {
  const spy = createSpyTransport()
  const shell = createShell(spy.transport, { magicBase: "/tmp/Magic ' instance/.magic", workspaceRoots: ["/tmp/Work ' space"] })
  const paste = (text: string) => shell.key({ kind: 'paste', text })
  const key = (kind: 'ctrl+c' | 'ctrl+p' | 'up' | 'down' | 'enter' | 'escape' | 'left' | 'tab') => shell.key({ kind })
  const clear = (text: string) => { paste(text); key('ctrl+c') }
  const send = (text: string) => { paste(text); key('enter'); const command = spy.commands.findLast(one => one.type === 'input.submit'); if (command?.type !== 'input.submit') throw Error('missing submit'); return command.ref! }
  return { spy, shell, paste, key, clear, send, view: shell.getView }
}

describe('U125 输入召回与清空', () => {
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
    const select = (active:string) => s.spy.emit(event('session.state',{active,sessions:[{id:'one',at:1},{id:'two',at:2}]}))
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

const timing: TurnTimingEvent[] = [
  event('turn.start', {}, { id: 1 }),
  event('turn.end', { reason: 'settled', continues: true }, { id: 10_001 }),
  event('turn.start', {}, { id: 10_002, turn: 2 }),
  event('tool.decision.request', { call: 100, name: 'exec', material: '', weight: 'heavy' }, { id: 20_001, turn: 2 }),
  event('tool.decision.request', { call: 101, name: 'exec', material: '', weight: 'heavy' }, { id: 25_001, turn: 2 }),
  event('tool.decision', { call: 100, decision: 'approve', decider: 'user', elapsedMs: 15000 }, { id: 35_001, turn: 2 }),
  event('tool.decision', { call: 101, decision: 'approve', decider: 'user', elapsedMs: 20000 }, { id: 45_001, turn: 2 }),
  event('turn.end', { reason: 'settled' }, { id: 123_001, turn: 2 }),
]

describe('U125 整轮时间投影', () => {
  test('多模型轮不归零；并行审批扣并集 25s；实时与历史统计相同', () => {
    let live = createView()
    for (const e of timing) live = reduce(live, e)
    expect(live.settled.filter(row => row.kind === 'round')).toHaveLength(1)
    const round = live.round!
    expect(roundDuration(round, 'elapsed', null)).toBe(123_000)
    expect(roundDuration(round, 'active', null)).toBe(98_000)
    expect(roundSummary(round, 'elapsed')).toMatch(/^耗时 2m 03s · 结束于 \d{2}:\d{2}$/)
    expect(roundSummary(round, 'active')).toMatch(/^耗时 1m 38s（不含等待） · 结束于 \d{2}:\d{2}$/)
    const restored = rebuild(createView(), [], { timing })
    expect(restored.round).toEqual(round)
    expect(restored.settled).toEqual(live.settled)
  })
  test('等待审批、普通 waiting、停止、失联各说实况；接回从原起点计时', () => {
    let view = rebuild({ ...createView(), sessionId: TEST_SESSION }, [], { timing: timing.slice(0, 4) })
    expect(roundLineText(view, TEST_AT + 30_001)).toBe('◊ 等待你 · 30s')
    expect(roundLineText({ ...view, turnDuration: 'active' }, TEST_AT + 30_001)).toBe('◊ 等待你 · 20s（不含等待）')
    view = reduce(view, timing[5]!)
    expect(roundLineText({ ...view, status: { ...view.status, state: 'waiting' } }, TEST_AT + 50_001)).toBe('● thinking... 50s')
    expect(roundLineText({ ...view, status: { ...view.status, state: 'lost' } }, TEST_AT + 50_001)).toBe('■ 本轮状态待确认')
  })
  test('边界缺失、时间倒退不补猜；未配对审批使扣除口径不可计算', () => {
    expect(foldRound(null, timing.at(-1)!)).toBeNull()
    const start = foldRound(null, timing[0]!)!
    const backward = foldRound(start, { ...timing.at(-1)!, at: TEST_AT - 100 })!
    expect(roundSummary(backward, 'elapsed')).toBeNull()
    let incomplete = foldRound(start, { ...timing[5]!, turn: 1 })!
    incomplete = foldRound(incomplete, { ...timing.at(-1)!, turn: 1 })!
    expect(roundSummary(incomplete, 'elapsed')).not.toBeNull()
    expect(roundSummary(incomplete, 'active')).toBeNull()
  })
  test('未关闭等待截断于结束，失败及停止有终态且结束后不继续累计', () => {
    const start = foldRound(null, timing[0]!)!
    const waiting = foldRound(start, { ...timing[3]!, turn: 1 })!
    const end = foldRound(waiting, event('turn.end', { reason: 'aborted' }, { id: 30_001 }))!
    expect(roundDuration(end, 'active', TEST_AT + 999_999)).toBe(20_000)
    expect(roundSummary(end, 'elapsed')).toStartWith('已停止 · 耗时 30s')
    expect(roundSummary({ ...end, reason: 'error' }, 'elapsed')).toStartWith('失败 · 耗时 30s')
  })
  test('正文与思考在第 2 列，思考静态且全文保留', () => {
    const assistant = rowLines({ kind: 'assistant', key: 'a', text: '1234567890' }, { columns: 8, expanded: true }).map(line => line.segments.map(s => s.text).join(''))
    expect(assistant).toEqual(['  123456', '  7890'])
    const thought = { kind: 'thinking' as const, key: 't', text: '第一行\n第二行', startedAt: 1, lastAt: 9999, flowing: true }
    expect(rowLines(thought, { columns: 100, expanded: true, now: 10000 })).toEqual(rowLines(thought, { columns: 100, expanded: true, now: 20000 }))
    expect(rowLines(thought, { columns: 100, expanded: true }).map(line => line.segments.map(s => s.text).join(''))).toEqual(['│ 第一行', '│ 第二行'])
  })
  test('200×40、100×40 与矮窗：一条 loading，两条分隔线，临时层在 dock，计划不进入 scrollback', async () => {
    const stage = createStage()
    stage.feed([timing[0]!])
    stage.at(TEST_AT + 10_001)
    for (const size of [{ columns: 200, rows: 40 }, { columns: 100, rows: 40 }, { columns: 80, rows: 10 }]) {
      stage.type('/')
      const frame = await stage.screen(size)
      expect(frame.screen.lines.filter(line => line.includes('thinking...'))).toHaveLength(1)
      expect(frame.screen.lines.filter(line => /^─+$/.test(line))).toHaveLength(2)
      expect(frame.screen.lines.filter(line => line.trim() !== '').length).toBeGreaterThan(4)
      stage.press({ kind: 'ctrl+c' })
    }
    stage.shell.dispose()
  })
})
