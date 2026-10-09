import {runTui} from '@magic/tui'
import {createSpyTransport} from './fakes.ts'
import {event} from './events.ts'
const spy=createSpyTransport()
const tui=await runTui({ magicBase: '/test/.magic',transport:spy.transport,reducedMotion:true,boot:async()=>{
 spy.emit(event('session.state',{active:'session-test',sessions:[{id:'session-test',at:0}]}))
 spy.emit(event('plan.changed',{entry:1,plan:{steps:Array.from({length:80},(_,i)=>({text:`真实计划步骤${String(i+1).padStart(3,'0')}`,status:'pending' as const})),notes:''}}))
}})
await tui.waitUntilExit()
