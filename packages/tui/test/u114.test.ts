import { expect, test } from 'bun:test'
import { createStage } from './screen.ts'
import { event } from './events.ts'
import { parseScreenKeys } from '../src/screen.ts'
import { rowLines } from '../src/components/log.ts'

const enter = { kind: 'enter' } as const

test('U114 多行上下不召回历史，Ctrl+P/N 归还完整原稿', () => {
 const s = createStage(); s.type('history'); s.press(enter)
 s.press({kind:'paste', text:'one\ntwo\nthree'}); s.press({kind:'up'})
 expect(s.shell.getView().draft).toBe('one\ntwo\nthree')
 expect(s.shell.getView().caret).toBe(7)
 s.press({kind:'ctrl+p'}); expect(s.shell.getView().draft).toBe('history')
 s.press({kind:'ctrl+n'}); expect(s.shell.getView().draft).toBe('one\ntwo\nthree')
 expect(s.shell.getView().caret).toBe(7)
})
test('U114 裸命令、绝对路径和相似名称是正文，Enter 不补全', () => {
 for (const text of ['/help', '/helpful text', '/Users/jamie/file check', '/unknown value']) {
  const s=createStage(); s.type(text); s.press(enter)
  expect(s.commands()).toContainEqual(expect.objectContaining({type:'input.submit',text}))
 }
})
test('U114 本地命令原文进入记录和历史，Esc 不清稿', () => {
 const s=createStage(); s.type('/help '); s.press(enter)
 expect(s.commands().filter(x=>x.type==='input.submit' && x.local!==true)).toHaveLength(0)
 expect([...s.shell.getView().settled,...s.shell.getView().rows]).toContainEqual(expect.objectContaining({kind:'user',text:'/help '}))
 s.type('draft'); s.press({kind:'up'}); expect(s.shell.getView().draft).toBe('/help ')
 s.press({kind:'down'}); s.press({kind:'escape'}); expect(s.shell.getView().draft).toBe('draft')
})
test('U114 审批不抢字母，主动进入后只答一张', () => {
 const s=createStage();s.type('draft')
 s.feed([event('tool.decision.request',{call:11,name:'exec',material:'chmod +x a',weight:'light'},{id:12})])
 s.type('yan'); expect(s.commands().filter(x=>x.type==='decision.answer')).toHaveLength(0)
 expect(s.shell.getView().draft).toBe('draftyan')
 s.press({kind:'ctrl+g'}); expect(s.shell.getView().dock.kind).toBe('decision')
 s.press({kind:'escape'}); expect(s.shell.getView().draft).toBe('draftyan')
 s.press({kind:'ctrl+g'});s.type('y');expect(s.commands()).toContainEqual({type:'decision.answer',id:12,decision:'approve'})
})
test('U114 已答卡不留下主动审批提示；新卡实际到达后才提示且不抢输入', () => {
 const s=createStage();s.type('draft')
 s.feed([event('tool.decision.request',{call:11,name:'exec',material:'chmod +x a',weight:'light'},{id:12})])
 s.press({kind:'ctrl+g'});s.type('y')
 s.feed([event('tool.decision',{call:11,decision:'approve',decider:'user',elapsedMs:2})])
 expect(s.shell.getView().dock.kind).toBe('input')
 expect(s.shell.getView().status.hint).not.toContain('Ctrl+G')
 const answered=s.commands().filter(x=>x.type==='decision.answer').length
 s.press({kind:'ctrl+g'});s.type('n')
 expect(s.commands().filter(x=>x.type==='decision.answer')).toHaveLength(answered)
 expect(s.shell.getView().draft).toBe('draftn')
 s.feed([event('tool.decision.request',{call:21,name:'exec',material:'chmod +x b',weight:'light'},{id:22})])
 expect(s.shell.getView().status.hint).toBe('Ctrl+G 审阅')
 expect(s.shell.getView().dock.kind).toBe('input')
 s.press({kind:'ctrl+g'});s.type('n')
 expect(s.commands()).toContainEqual({type:'decision.answer',id:22,decision:'reject'})
})
test('U114 PgUp/PgDn 是翻页，未知序列不污染搜索或退出', () => {
 expect(parseScreenKeys('\x1b[5~')).toEqual([{kind:'pageUp'}])
 expect(parseScreenKeys('\x1b[6~')).toEqual([{kind:'pageDown'}])
 expect(parseScreenKeys('\x1b[99~')).toEqual([])
})
test('U114 放得下的思考和摘要不省略',()=>{
 for(const columns of [200,100]) {
 const text='WIDTH_PROBE_'+ 'a'.repeat(columns - 50)
 const thinking={kind:'thinking',key:'t',text,flowing:false,startedAt:null,lastAt:null} as const
 const tool={kind:'tool',key:'x',call:1,name:'exec',argsText:'',args:null,elapsedMs:1,startedAt:null,output:[text]} as const
 for(const row of [thinking,...(['ok','failed','rejected'] as const).map(state=>({...tool,state}))]) {
  const lines=rowLines(row,{columns,expanded:false,spaced:false}).map(x=>x.segments.map(s=>s.text).join(''))
  expect(lines.join('\n')).toContain(text);expect(lines.join('\n')).not.toContain('…')
 }
 }
})

test('U114 路径原位查询取消，完整原稿及插入点恢复',()=>{
 const s=createStage();s.type('original tail');s.press({kind:'left'});s.press({kind:'left'});s.press({kind:'left'});s.press({kind:'left'})
 const before=s.shell.getView();s.press({kind:'char',char:'@'})
 s.press({kind:'paste',text:'docs/no-match'});s.press({kind:'left'});s.press({kind:'char',char:'X'})
 expect(s.shell.getView().dock.kind).toBe('picker')
 s.press({kind:'escape'});const after=s.shell.getView()
 expect(after.draft).toBe(before.draft);expect(after.caret).toBe(before.caret);expect(after.refs).toEqual(before.refs)
})

import {pickerLayout,pickerBudget} from '../src/components/picker.ts'
import {createShell} from '../src/shell.ts'
import {createSpyTransport} from './fakes.ts'
import {collaborationDetail,collaborationFixture} from './collaboration-fixture.ts'
function collaborationStage(consultation=false){
 const view=(data:typeof collaborationFixture)=>({...data,members:data.members.map(one=>one.agent.agentId==='worker'&&consultation?{...one,agent:{...one.agent,purpose:'consultation' as const}}:one)})
 const spy=createSpyTransport(); const shell=createShell({...spy.transport,send(command){spy.transport.send(command);if(command.type==='collaboration.read')spy.emit(event('collaboration.view',view(collaborationDetail(command.member))))}})
 spy.emit(event('session.state',{active:'origin',sessions:[{id:'origin',at:0},{id:'member',at:0}]}));spy.emit(event('collaboration.view',view(collaborationFixture)))
 const key=(kind:'tab'|'enter'|'down'|'escape')=>shell.key({kind})
 const pick=(value:string)=>{const dock=shell.getView().dock;if(dock.kind!=='picker')throw Error('没有选择器');const index=dock.picker.rows.findIndex(row=>row.value===value);if(index<0)throw Error(`没有 ${value}`);for(let i=0;i<(index-dock.picker.selected+dock.picker.rows.length)%dock.picker.rows.length;i++)key('down');key('enter')}
 return {spy,shell,key,pick,member:()=>{key('tab');pick('worker')},text:(text:string)=>shell.key({kind:'paste',text})}
}
import {displayWidth} from '../src/components/lines.ts'

test('U114 成员 Enter 阅读，m 默认阅读并保存位置；i 仅切目标恢复独立稿',()=>{
 const s=collaborationStage();s.text('整体稿');s.member()
 let dock=s.shell.getView().dock
 expect(dock.kind==='picker'&&dock.picker.reader?.title).toBe('实现 · 对话与工具')
 expect(s.shell.getView().inputMember).toBeUndefined()
 s.shell.key({kind:'readerTop',top:7});s.shell.key({kind:'memberMenu'})
 dock=s.shell.getView().dock
 expect(dock.kind==='picker'&&dock.picker.rows[dock.picker.selected]?.value).toBe('records')
 s.key('escape');dock=s.shell.getView().dock
 expect(dock.kind==='picker'&&dock.picker.reader?.top).toBe(7)
 s.shell.key({kind:'memberInput'});expect(s.shell.getView().inputMember).toBe('worker')
 expect(s.shell.getView().draft).toBe('');s.text('成员稿')
 s.key('tab');s.pick('whole');expect(s.shell.getView().draft).toBe('整体稿')
 s.member();s.shell.key({kind:'memberInput'});expect(s.shell.getView().draft).toBe('成员稿')
 expect(s.spy.commands.some(c=>c.type==='input.submit'||c.type==='collaboration.input')).toBe(false)
})
test('U114 菜单按真实行高，长详情逐页可读且不挤掉焦点',()=>{
 const text=Array.from({length:40},(_,i)=>`详情${i} 中文🙂é ${'a'.repeat(150)}`)
 const picker={source:'skills',selected:2,title:'技能名称与来源',rows:Array.from({length:6},(_,i)=>({current:false,label:`技能${i}`,value:String(i),meta:'用途说明',detail:i===2?text:[]})),hint:'Enter 选定 · Esc 返回'} as const
 for(const columns of [200,100]) {
  const budget=pickerBudget(picker,columns,14),read:string[]=[]
  let top=0,total=Infinity
  while(top<total){const layout=pickerLayout({...picker,detailTop:top},budget,columns)
   expect(layout.height).toBeLessThanOrEqual(budget)
   expect(layout.items.some(i=>i.kind==='row'&&i.index===2)).toBe(true)
   read.push(...layout.items.filter(i=>i.kind==='detail').map(i=>i.text));total=layout.detailTotal
   expect(layout.detailSize).toBeGreaterThan(0)
   if(layout.detailTop+layout.detailSize>=total)break
   top=layout.detailTop+layout.detailSize
  }
  const joined=read.join('');for(let i=0;i<40;i++)expect(joined).toContain(`详情${i}`)
 }
})
test('U114 同宽缓存与不同宽字素折行守住真实列宽',()=>{
 const text=('中文🙂é\t'+'x'.repeat(260)+'\n').repeat(5)
 const row={kind:'assistant',key:'width',text,flowing:false} as const
 for(const columns of [200,100,200]){
  const lines=rowLines(row,{columns,expanded:true,spaced:false})
  expect(lines.length).toBeGreaterThan(5)
  for(const line of lines)expect(displayWidth(line.segments.map(s=>s.text).join(''))).toBeLessThanOrEqual(columns)
 }
})
test('U114 用途选择和取消不发，下一件仅一次提交后回默认',()=>{
 const s=createStage();s.type('工作稿');s.press({kind:'alt+enter'});s.press({kind:'down'});s.press(enter)
 expect(s.shell.getView().inputPurpose).toBe('next');expect(s.commands().filter(c=>c.type==='input.submit')).toHaveLength(0)
 s.press({kind:'alt+enter'});s.press({kind:'up'});s.press({kind:'escape'})
 expect(s.shell.getView().draft).toBe('工作稿');expect(s.shell.getView().inputPurpose).toBe('next')
 s.press(enter);expect(s.commands()).toContainEqual(expect.objectContaining({type:'input.submit',text:'工作稿',purpose:'next'}))
 expect(s.shell.getView().inputPurpose).toBe('current')
})

test('U114 延迟受理与拒绝如实还稿，已受理也保留配对身份且不盖后来编辑',()=>{
 const s=createStage();s.type('delayed');s.press(enter)
 const submit=s.commands().find(c=>c.type==='input.submit'&&c.local!==true)
 if(submit?.type!=='input.submit')throw Error('没有提交')
 expect(s.shell.getView().rows.find(r=>r.kind==='user')?.inputState).toBe('提交中')
 expect(s.shell.getView().draft).toBe('')
 s.feed([event('input.settled',{ref:submit.ref,ok:true,stage:'accepted'})])
 expect(s.shell.getView().rows.find(r=>r.kind==='user')?.inputState).toBe('待带入')
 s.feed([event('input.settled',{ref:submit.ref,ok:false,reason:'受控拒绝'})])
 expect(s.shell.getView().draft).toBe('delayed')
 s.press(enter);const second=s.commands().filter(c=>c.type==='input.submit').at(-1)
 if(second?.type!=='input.submit')throw Error('没有第二次提交')
 s.type('new draft')
 s.feed([event('input.settled',{ref:second.ref,ok:false,reason:'受控断线，未确认接收'})])
 expect(s.shell.getView().draft).toBe('new draft')
 expect([...s.shell.getView().settled,...s.shell.getView().rows].some(r=>r.kind==='receipt'&&r.text.includes('未确认接收'))).toBe(true)
})


test('U114 与咨询集成：Enter 仍阅读，i 不切只读顾问，m 只保留只读动作',()=>{
 const s=collaborationStage(true);s.text('原工作稿');s.member()
 const before=s.shell.getView();expect(before.dock.kind==='picker'&&before.dock.picker.reader?.title).toBe('实现 · 对话与工具')
 s.shell.key({kind:'memberInput'});expect(s.shell.getView()).toEqual(before)
 s.shell.key({kind:'memberMenu'});const dock=s.shell.getView().dock
 expect(dock.kind).toBe('picker')
 if(dock.kind!=='picker')throw Error('没有操作页')
 expect(dock.picker.rows.map(row=>row.value)).not.toContain('input')
 expect(dock.picker.rows.map(row=>row.value)).not.toContain('member-model')
 expect(dock.picker.rows[dock.picker.selected]?.value).toBe('records')
 s.key('escape');s.key('escape');expect(s.shell.getView().draft).toBe('原工作稿')
 expect(s.shell.getView().inputMember).toBeUndefined()
 expect(s.spy.commands.some(command=>command.type==='collaboration.input'||command.type==='model.switch')).toBe(false)
})


test('U114 成员阅读取消只退真实层，成员列表不重复压栈，原稿光标保持',()=>{
 const s=collaborationStage();s.text('整体完整草稿');s.shell.key({kind:'left'});const original=s.shell.getView()
 s.member();s.key('escape');let dock=s.shell.getView().dock
 expect(dock.kind==='picker'&&dock.picker.source).toBe('collaboration')
 s.key('escape');expect(s.shell.getView().dock.kind).toBe('input')
 expect(s.shell.getView().draft).toBe(original.draft);expect(s.shell.getView().caret).toBe(original.caret)
 expect(s.shell.getView().refs).toEqual(original.refs);expect(s.shell.getView().inputMember).toBeUndefined()
})
