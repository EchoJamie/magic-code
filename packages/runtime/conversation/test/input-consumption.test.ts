import {expect,test} from 'bun:test'
import {createConversationSession} from '../src/service.ts'
import {makeStage,makeLoopRuntime,waitFor,waitUntilIdle} from './support/harness.ts'

function open(stage:ReturnType<typeof makeStage>){const runtime=makeLoopRuntime(stage);return createConversationSession({session:runtime.session,prompt:stage.promptVars,gateway:stage.gateway,tools:stage.toolDomain,records:stage.records,sink:stage.sink,stamper:stage.stamper,now:runtime.now})}
test('忙时提交按序排队，收束后处理；纯文本多条并入合并为一条',async()=>{
 let release:()=>void=()=>{}
 const latch=new Promise<void>(resolve=>{release=resolve})
 const stage=makeStage({turns:[{toolCalls:[{name:'exec',args: { command:'long'}},{name:'exec',args: { command:'old-next'}}]},{text:'rejudged'},{text:'work-a'},{text:'work-b'}],handlers:{exec:async call=>{if(call.args.command==='long')await latch;return {ok:true,output:String(call.args.command)}}}})
 const service=open(stage)
 service.submit({text:'first',ref:'first'})
 await waitFor(()=>stage.tools.calls.length>=1?true:undefined,'长工具已经执行')
 service.submit({text:'current-change',ref:'current'})
 service.submit({text:'queue-more',ref:'queue'})
 service.submit({text:'next-only',purpose:'next',ref:'next'})
 service.submit({text:'retransmit',purpose:'next',ref:'next'})
 expect(stage.records.inputs.list()).toHaveLength(4)
 expect(stage.records.inputs.get('current')?.state).toBe('pending')
 release();await waitUntilIdle(stage.sink)
 // **已派发的工具如实完成**；忙时提交按序排队——当前工作收束后才处理
 expect(stage.tools.calls.map(call=>call.args.command)).toEqual(['long','old-next'])
 expect(stage.gateway.requests).toHaveLength(4)
 const bodies=stage.gateway.requests.map(request=>JSON.stringify(request.messages))
 expect(bodies[0]).not.toContain('current-change')
 expect(bodies[1]).not.toContain('current-change') // 队列按序：运行中不再中途回带
 expect(bodies[2]).toContain('current-change');expect(bodies[2]).toContain('queue-more') // 队列多条并入合并为一条
 expect(bodies[3]).toContain('next-only');expect(bodies.join()).not.toContain('retransmit')
 expect(stage.records.entries.filter(entry=>entry.kind==='user')).toHaveLength(3)
 const merged=stage.records.entries.filter(entry=>entry.kind==='user').at(-2)
 expect(merged&&'text'in merged.content&&merged.content.text).toBe('current-change\n\nqueue-more')
 for(const ref of ['first','current','queue','next'])expect(stage.sink.byKind('input.settled').filter(event=>event.data.ref===ref&&event.data.stage==='included')).toHaveLength(1)
})
test('停止保留未消费输入，新的执行实例不自动消费遗留',async()=>{
 const stage=makeStage({turns:[{text:['one','two','three']}],stepDelayMs:10})
 const service=open(stage);service.submit({text:'first',ref:'first'})
 await waitFor(()=>stage.sink.byKind('model.delta').length>0?true:undefined,'请求已发')
 service.submit({text:'pending',ref:'pending',purpose:'next'});service.interrupt();await waitUntilIdle(stage.sink)
 expect(stage.records.inputs.get('pending')?.state).toBe('pending')
 expect(stage.records.entries.filter(entry=>entry.kind==='user')).toHaveLength(1)
 const restarted=open(stage);restarted.manage({type:'input.manage',action:'list'})
 expect(stage.records.entries.filter(entry=>entry.kind==='user')).toHaveLength(1)
 expect(stage.gateway.requests).toHaveLength(1)
})
test('本地命令记录不进入真正装配请求',async()=>{
 const stage=makeStage({turns:[{text:'done'}]});const service=open(stage)
 service.submit({text:'/help ',local:true,refs:[],ref:'command'})
 service.submit({text:'actual input',ref:'input'});await waitUntilIdle(stage.sink)
 expect(stage.records.entries.some(entry=>entry.kind==='user'&&'text'in entry.content&&entry.content.text==='/help ')).toBe(false)
 expect(stage.sink.byKind('input.local')).toContainEqual(expect.objectContaining({data:{text:'/help ',refs:[],ref:'command'}}))
 expect(JSON.stringify(stage.gateway.requests[0]!.messages)).not.toContain('/help ')
})
