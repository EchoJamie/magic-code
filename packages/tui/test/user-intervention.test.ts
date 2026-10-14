import { expect, test } from 'bun:test'
import { createShell } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { show } from './screen.ts'
import { decisionLayout } from '../src/components/decision.ts'
const enter = { kind: 'enter' } as const
const ask = (id = 12, call = 11) => event('tool.decision.request', { call, name: 'write', material: '/tmp/fixture.txt\n- old\n+ reviewed', weight: 'light' }, { id })
const answers = (spy: ReturnType<typeof createSpyTransport>) => spy.commands.filter(one => one.type === 'decision.answer')

test('审批直接展开，无预选；文字、粘贴、连续 Enter 不批准；队列逐条重置选择', () => {
 const spy=createSpyTransport(), shell=createShell(spy.transport, { magicBase: '/test/.magic' })
 shell.key({kind:'paste',text:'draft'});shell.key({kind:'left'})
 spy.emit(ask());spy.emit(ask(22,21))
 expect(shell.getView().dock.kind).toBe('decision')
 for(const char of 'yan')shell.key({kind:'char',char})
 shell.key({kind:'paste',text:'y\na\nn\n'});shell.key(enter);shell.key(enter)
 expect(answers(spy)).toHaveLength(0)
 shell.key({kind:'down'});shell.key(enter)
 expect(answers(spy)).toEqual([{type:'decision.answer',id:12,decision:'approve'}])
 shell.key(enter); expect(spy.commands.filter(one=>one.type==='input.submit')).toHaveLength(0)
 spy.emit(event('tool.decision',{call:11,decision:'approve',decider:'user',elapsedMs:1}))
 expect(shell.getView().dock.kind).toBe('decision')
 shell.key(enter);expect(answers(spy)).toHaveLength(1)
 shell.key({kind:'up'});shell.key(enter)
 expect(answers(spy)[1]).toEqual({type:'decision.answer',id:22,decision:'reject'})
 spy.emit(event('tool.decision',{call:21,decision:'reject',decider:'user',elapsedMs:1}))
 expect(shell.getView().draft).toBe('draft');expect(shell.getView().caret).toBe(4)
 shell.dispose()
})
test('Esc 归还草稿且待决策可见；另一窗口答复后卡失效', async () => {
 const spy=createSpyTransport(), shell=createShell(spy.transport, { magicBase: '/test/.magic' })
 shell.key({kind:'paste',text:'draft'});spy.emit(ask());shell.key({kind:'escape'})
 expect(shell.getView().draft).toBe('draft')
 for(const columns of [200,100]) {
  const frame=await show([shell.getView()],{columns,rows:40})
  expect(frame.screen.lines.join('\n')).toContain('/tmp/fixture.txt')
  expect(frame.screen.lines.join('\n')).toContain('Tab 进入决策')
 }
 shell.key({kind:'tab'});shell.key({kind:'down'})
 spy.emit(event('tool.decision',{call:11,decision:'reject',decider:'user',elapsedMs:1}))
 shell.key(enter);expect(answers(spy)).toHaveLength(0)
 expect(shell.getView().pendingDecision).toBeUndefined();shell.dispose()
})
test('长材料按窗口预算翻页，操作可见，队列身份不变',()=>{
 const spy=createSpyTransport(),shell=createShell(spy.transport, { magicBase: '/test/.magic' })
 spy.emit(event('tool.decision.request',{call:11,name:'write',material:Array.from({length:200},(_,i)=>`line ${i}`).join('\n'),weight:'heavy'},{id:12}))
 const dock=shell.getView().dock;if(dock.kind!=='decision')throw Error('missing')
 for(const columns of [200,100]) {
  const page=decisionLayout(dock.pending,columns,40)
  expect(page.lines.length).toBeLessThanOrEqual(20)
  expect(page.lines.join('\n')).toContain('Enter 确认')
  shell.key({kind:'decisionTop',top:page.maxTop})
  const next=shell.getView().dock;if(next.kind!=='decision')throw Error('missing')
  expect(decisionLayout(next.pending,columns,40).lines.join('\n')).toContain('line 199')
 }
 shell.dispose()
})
test('生产 disconnected 可本地 /connect；重复请求合并，重连不发草稿，旧审批失效',async()=>{
 const spy=createSpyTransport();let opens=0,done=()=>{}
 const shell=createShell(spy.transport,{ magicBase: '/test/.magic',reopen:()=>{opens++;return new Promise<void>(resolve=>{done=resolve})}})
 spy.emit(ask());shell.disconnected('fixture')
 expect(shell.getView().status.state).toBe('lost');expect(shell.getView().pendingDecision).toBeUndefined()
 shell.key(enter);expect(shell.getView().flash).toContain('连接已断开')
 shell.key({kind:'paste',text:'/connect'});shell.key(enter);shell.key({kind:'ctrl+r'})
 expect(opens).toBe(1);done();await Bun.sleep(0)
 expect(spy.commands.filter(one=>one.type==='input.submit')).toHaveLength(0)
 expect(shell.getView().status.state).not.toBe('lost');expect(answers(spy)).toHaveLength(0)
 expect(shell.getView().flash).toBeNull()
 shell.dispose()
})
test('Esc 主输入复用 run stop；审批/补全先返回，草稿保留，未伪报停止',()=>{
 const spy=createSpyTransport(),stops:unknown[]=[]
 const shell=createShell(spy.transport,{ magicBase: '/test/.magic',stop:(...args)=>stops.push(args)})
 spy.emit(event('session.state',{active:'test',sessions:[]}));spy.emit(event('turn.start',{}))
 shell.key({kind:'paste',text:'draft'});spy.emit(ask());shell.key({kind:'escape'})
 expect(stops).toHaveLength(0);shell.key({kind:'escape'})
 expect(stops).toEqual([['test','run']]);expect(shell.getView().draft).toBe('draft')
 expect(shell.getView().status.state).not.toBe('idle');shell.dispose()
})

test('审批通知先于请求时不标读；实际成员审批呈现后确认，不追加重复回执', async () => {
 const {render}=await import('ink'),{createElement:h}=await import('react')
 const {TuiApp}=await import('../src/components/app.ts')
 const {FakeStdin,FakeTty}=await import('./terminal.ts')
 let notify:(notice:import('@magic/contracts').RunNotice)=>void=()=>{}
 const marks:(readonly string[])[]=[],spy=createSpyTransport()
 const shell=createShell(spy.transport,{ magicBase: '/test/.magic',notices:listener=>{notify=listener},markRead:ids=>marks.push(ids),receipts:['离开期间有待处理事项']})
 spy.emit(event('session.state',{active:'root',sessions:[]}))
 const notice={id:'member:needs-you:12',session:'root',source:{session:'member',event:12},kind:'needs-you' as const,detail:'写入 review.txt，等待明确确认',at:1,unread:true}
 notify(notice);expect(marks).toHaveLength(0)
 const stdout=new FakeTty(100,40)
 const app=render(h(TuiApp,{shell}),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:new FakeStdin() as unknown as NodeJS.ReadStream,exitOnCtrlC:false,patchConsole:false,maxFps:0})
 try{
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(marks).toHaveLength(0)
  expect(stdout.bytes()).not.toContain('需要你决定')
  spy.emit(event('tool.decision.request',{call:11,name:'write',material:'写入 review.txt，等待明确确认',weight:'light'},{id:12,session:'member'}))
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(stdout.bytes()).toContain('review.txt')
  expect(marks).toEqual([[notice.id]])
  notify(notice);await app.waitUntilRenderFlush();expect(marks).toHaveLength(1)
 }finally{app.unmount();shell.dispose()}
})

test('排队中尚未呈现的审批、其他会话迟到通知不标读；错误只呈现一次', async () => {
 const {render}=await import('ink'),{createElement:h}=await import('react')
 const {TuiApp}=await import('../src/components/app.ts')
 const {FakeStdin,FakeTty}=await import('./terminal.ts')
 const spy=createSpyTransport(),marks:(readonly string[])[]=[]
 let notify:(notice:import('@magic/contracts').RunNotice)=>void=()=>{}
 const shell=createShell(spy.transport,{magicBase:'/test/.magic',notices:listener=>{notify=listener},markRead:ids=>marks.push(ids)})
 spy.emit(event('session.state',{active:'session-test',sessions:[]}))
 spy.emit(ask());spy.emit(ask(22,21))
 const notice={id:'second',session:'session-test',source:{session:'session-test',event:22},kind:'needs-you' as const,detail:'第二个请求',at:1,unread:true}
 notify(notice)
 const stdout=new FakeTty(100,40)
 const app=render(h(TuiApp,{shell}),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:new FakeStdin() as unknown as NodeJS.ReadStream,exitOnCtrlC:false,patchConsole:false,maxFps:0})
 try{
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(marks).toEqual([])
  spy.emit(event('tool.decision',{call:11,decision:'reject',decider:'user',elapsedMs:1}))
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(marks).toEqual([['second']])
  spy.emit(event('turn.end',{reason:'aborted'}))
  spy.emit(event('session.state',{active:'b',sessions:[]}))
  notify({...notice,id:'late-other-session'})
  notify({...notice,id:'late-failure',kind:'failed'})
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(marks).toEqual([['second']])
  spy.emit(event('model.error',{tier:'terminal',message:'唯一的实际错误'},{id:30,session:'b'}))
  notify({id:'failure',session:'b',source:{session:'b',event:30},kind:'failed',detail:'唯一的实际错误',at:2,unread:true})
  await app.waitUntilRenderFlush();await Bun.sleep(10)
  expect(marks).toEqual([['second'],['failure']])
  expect(stdout.bytes()).not.toContain('出错了')
  expect(shell.getView().settled.filter(row=>row.kind==='receipt'&&row.text.includes('唯一的实际错误'))).toHaveLength(1)
 }finally{app.unmount();shell.dispose()}
})

test('恢复命令保留原工作区与实例，session 及路径单引号完整转义',()=>{
 const spy=createSpyTransport(),shell=createShell(spy.transport,{stop:()=>{},home:'/home/user',magicBase:"/tmp/实例's/.magic",workspaceRoots:['/wrong']})
 const id="会话'$(literal)",workspace="/tmp/工作区's"
 spy.emit(event('session.state',{active:id,sessions:[{ archived: false,id,at:0,workspace:[workspace]}]}))
 spy.emit(event('turn.start',{}));shell.key({kind:'ctrl+c'});shell.key({kind:'down'});shell.key(enter)
 const quote=(text:string)=>"'"+text.replaceAll("'","'\\''")+"'"
 expect(shell.exitNote()).toBe(`恢复此会话：\ncd -- ${quote(workspace)} && MAGIC_HOME=${quote("/tmp/实例's")} magic resume ${quote(id)}`)
 shell.dispose()
})
