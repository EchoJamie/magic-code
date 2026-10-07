import {expect,test} from 'bun:test'
import {createConversationSession} from '../src/service.ts'
import {makeStage,makeLoopRuntime,waitFor,waitUntilIdle} from './support/harness.ts'

function open(stage:ReturnType<typeof makeStage>){const runtime=makeLoopRuntime(stage);return createConversationSession({session:runtime.session,prompt:stage.promptVars,gateway:stage.gateway,tools:stage.toolDomain,records:stage.records,sink:stage.sink,stamper:stage.stamper,now:runtime.now})}
test('U114 工具结束先带入当前补充，旧下一工具不执行；下一件不混当前请求',async()=>{
 let release:()=>void=()=>{}
 const latch=new Promise<void>(resolve=>{release=resolve})
 const stage=makeStage({turns:[{toolCalls:[{name:'exec',args:{cmd:'long'}},{name:'exec',args:{cmd:'old-next'}}]},{text:'rejudged'},{text:'next-work'}],handlers:{exec:async call=>{if(call.args.cmd==='long')await latch;return {ok:true,output:String(call.args.cmd)}}}})
 const service=open(stage)
 service.submit({text:'first',ref:'first'})
 await waitFor(()=>stage.tools.calls.length===1?true:undefined,'长工具已经执行')
 service.submit({text:'current-change',ref:'current'})
 service.submit({text:'next-only',purpose:'next',ref:'next'})
 service.submit({text:'retransmit',purpose:'next',ref:'next'})
 expect(stage.records.inputs.list()).toHaveLength(3)
 expect(stage.records.inputs.get('current')?.state).toBe('pending')
 release();await waitUntilIdle(stage.sink)
 expect(stage.tools.calls.map(call=>call.args.cmd)).toEqual(['long'])
 expect(stage.gateway.requests).toHaveLength(3)
 const bodies=stage.gateway.requests.map(request=>JSON.stringify(request.messages))
 expect(bodies[0]).not.toContain('current-change')
 expect(bodies[1]).toContain('current-change');expect(bodies[1]).not.toContain('next-only')
 expect(bodies[2]).toContain('next-only');expect(bodies.join()).not.toContain('retransmit')
 expect(stage.records.entries.filter(entry=>entry.kind==='user')).toHaveLength(3)
 for(const ref of ['first','current','next'])expect(stage.sink.byKind('input.settled').filter(event=>event.data.ref===ref&&event.data.stage==='included')).toHaveLength(1)
})
test('U114 停止保留未消费输入，新的执行实例不自动消费遗留',async()=>{
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
test('U114 本地命令记录不进入真正装配请求',async()=>{
 const stage=makeStage({turns:[{text:'done'}]});const service=open(stage)
 service.submit({text:'/help ',local:true,refs:[],ref:'command'})
 service.submit({text:'actual input',ref:'input'});await waitUntilIdle(stage.sink)
 expect(stage.records.entries.some(entry=>entry.kind==='user'&&'text'in entry.content&&entry.content.text==='/help ')).toBe(false)
 expect(stage.sink.byKind('input.local')).toContainEqual(expect.objectContaining({data:{text:'/help ',refs:[],ref:'command'}}))
 expect(JSON.stringify(stage.gateway.requests[0]!.messages)).not.toContain('/help ')
})
