/** 只验证既有事件契约的真实 TUI/PTY 呈现，不冒充工具执行或模型请求。 */
import { runTui } from '@magic/tui'
import type { KernelEvent } from '@magic/contracts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
const s=createSpyTransport(), probe='WIDTH_PROBE_'+'a'.repeat(110)
const emit=(e:KernelEvent)=>s.emit({...e,at:Date.now()})
const tui=await runTui({transport:s.transport,reducedMotion:true,boot:async()=>{
 emit(event('session.state',{active:'session-test',sessions:[{id:'session-test',at:0}]}))
 emit(event('model.delta',{channel:'thinking',text:probe}))
 for(const [index,state] of (['ok','failed','rejected'] as const).entries()) {
  const call=100+index
  emit(event('tool.call',{name:'exec',args:{cmd:state}},{id:call}))
  if(state==='rejected')emit(event('tool.decision',{call,decision:'reject',decider:'user',elapsedMs:0}))
  emit(event('tool.result',{call,ok:state==='ok',output:{text:probe}}))
 }
}})
await tui.waitUntilExit()
