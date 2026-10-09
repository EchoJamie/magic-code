/** 实时时钟驱动的 Ink 原始终端输出；事件受控，不连接真实会话或模型。 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement as h } from 'react'
import { render } from 'ink'
import chalk from 'chalk'
import { TuiApp } from '../src/components/app.ts'
import { createShell } from '../src/shell.ts'
import { createSpyTransport } from './fakes.ts'
import { event } from './events.ts'
import { FakeStdin, FakeTty, screenOf } from './terminal.ts'
import type { RunNotice } from '@magic/contracts'

const out = process.argv[2] ?? '/tmp/magic-tui-20261007'
const mode = process.argv[3] ?? 'color'
const columns = Number(process.argv[4] ?? 200), rows = 40
chalk.level = mode === 'no-color' ? 0 : 3
mkdirSync(out, { recursive: true })
const stdout = new FakeTty(columns, rows), stdin = new FakeStdin()
const started=performance.now(), chunks: [number,string,string][]=[]
const write=stdout.write
stdout.write=(chunk:string)=>{chunks.push([(performance.now()-started)/1000,'o',chunk]);return write(chunk)}
const spy=createSpyTransport(), marks:string[][]=[]
let notice: (one:RunNotice)=>void=()=>{}
const shell=createShell(spy.transport,{ magicBase: '/test/.magic',reducedMotion:mode==='reduced',markRead:ids=>marks.push([...ids]),notices:listener=>{notice=listener}})
const app=render(h(TuiApp,{shell}),{stdout:stdout as unknown as NodeJS.WriteStream,stdin:stdin as unknown as NodeJS.ReadStream,maxFps:0,exitOnCtrlC:false,patchConsole:false})
const phases:{name:string;at:number;bytes:number}[]=[]
async function phase(name:string,ms:number){await app.waitUntilRenderFlush();phases.push({name,at:(performance.now()-started)/1000,bytes:stdout.bytes().length});await Bun.sleep(ms);await app.waitUntilRenderFlush();const screen=await screenOf(stdout.bytes(),{columns,rows});writeFileSync(join(out,`${mode}-${columns}-${name}.txt`),screen.lines.join('\n'))}
try {
 shell.key({kind:'paste',text:'未发送草稿'});spy.emit(event('turn.start',{}));
 await phase('first-token',4500)
 spy.emit(event('model.delta',{channel:'thinking',text:'检查现有调用与状态。'}));await phase('thinking',1000)
 spy.emit(event('model.delta',{channel:'text',text:'准备执行受控工具。'}));
 spy.emit(event('tool.call',{name:'exec',args:{cmd:'fixture tool'}},{id:11}));await phase('tool',4500)
 spy.emit(event('tool.decision.request',{call:11,name:'exec',material:'fixture tool\n作用于临时测试文件，只执行本次操作。',weight:'light'},{id:12}));await phase('decision',1600)
 notice({id:'fixture-needs-you',session:'test',kind:'needs-you',at:Date.now(),detail:'fixture tool 等待明确决策',unread:true})
 if(marks.length!==0)throw Error('notice arrival marked read before rendering')
 await phase('notice-presented',300)
 if(!marks.some(ids=>ids.includes('fixture-needs-you')))throw Error('rendered notice not marked read')
 shell.key({kind:'down'});shell.key({kind:'enter'});
 spy.emit(event('tool.decision',{call:11,decision:'approve',decider:'user',elapsedMs:1}));await phase('continued',4500)
 spy.emit(event('tool.result',{call:11,ok:true,output:{text:'fixture complete'}}));spy.emit(event('turn.end',{reason:'settled'}));spy.emit(event('agent.state',{state:'waiting'}));await phase('done',1200)
 shell.disconnected('受控断线');await phase('disconnected',1200)
}finally{app.unmount();shell.dispose()}
writeFileSync(join(out,`${mode}-${columns}.raw`),stdout.bytes())
writeFileSync(join(out,`${mode}-${columns}.cast`),[JSON.stringify({version:2,width:columns,height:rows,timestamp:Math.floor(Date.now()/1000),title:'Magic Code 20261007 live clock controlled events'}),...chunks.map(one=>JSON.stringify(one))].join('\n')+'\n')
writeFileSync(join(out,`${mode}-${columns}.json`),JSON.stringify({mode,columns,rows,phases,marks,commands:spy.commands,duration:(performance.now()-started)/1000},null,2))
console.log(JSON.stringify({mode,columns,chunks:chunks.length,marks,out}))
