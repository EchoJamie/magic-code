import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'
import type { NativeResponse, SettingsAction } from '@magic/contracts'
import { linkOf, socketHandlers } from '../src/run/wire.ts'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
import { startFixture } from './ui/fixture.ts'
import { createSandbox } from './ui/sandbox.ts'
import { startResidentHost } from './resident-host-fixture.ts'
import { statusLineOf } from './ui/anchors.ts'

const fixture = startFixture({ turns: [{ kind: 'text', text: 'U116_WARMUP', chunks: 1 }, { kind: 'text', text: 'U116_TERMINAL_FINISHED', reasoning: 'U116_THINKING_' + 'a'.repeat(110), chunks: 80, chunkDelayMs: 250 }] })
const sandbox = createSandbox({ baseURL: fixture.baseURL, config: { statusLine: { cells: ['session', 'model', 'reasoning', 'context', 'workspace'], color: true } } })
const host = await startResidentHost(sandbox, REPO_ROOT + '/.ui-runs/u116/host')
const ui = await createUiSession({fixture,sandbox,columns:200,rows:40,argv:['--allow-all'],label:'U116-App偏好到真实PTY',artifacts:REPO_ROOT + '/.ui-runs/u116'})
const identity = host.discovery
const link = linkOf<NativeResponse>(await Bun.connect({unix:identity.socket,socket:socketHandlers()}) as never)
const responses:NativeResponse[]=[];link.onMessage(v=>responses.push(v))
const target={serviceInstance:identity.serviceInstance,dataDir:identity.dataDir}
let stamp:string|null=null
async function until(ok:()=>boolean){const end=Date.now()+10000;while(!ok()){if(Date.now()>end)throw new Error('原生偏好结果超时');await Bun.sleep(20)}}
async function settings(action?:SettingsAction){const request=crypto.randomUUID();link.send(action?{t:'native.settings.apply',...target,request,stamp,action}:{t:'native.settings.read',...target,request});await until(()=>responses.some(v=>v.t==='native.settings.result'&&v.request===request));const result=responses.find((v):v is Extract<NativeResponse,{t:'native.settings.result'}>=>v.t==='native.settings.result'&&v.request===request)!;assert(!result.error,result.error ?? "设置结果");stamp=result.snapshot!.stamp;return result.snapshot!}
try {
 link.send({t:'hello',role:'observer',protocol:identity.protocol,version:identity.version,source:identity.source,dataDir:identity.dataDir});await until(()=>responses.some(v=>v.t==='native.welcome'))
 await settings()
 const initial=await ui.capture({label:'00-空值整格省略'});const initialStatus=statusLineOf(initial.lines);assert(initialStatus.includes('空闲'));assert(!initialStatus.includes('Default'));assert(!initialStatus.includes('思考·'));assert(!/\d+k\/\d+k/.test(initialStatus))
 await ui.send('先取得真实用量');await ui.key('enter');await ui.wait({text:'U116_WARMUP'});await ui.wait({text:'○ 空闲'})
 await ui.send('/model ',{until:{text:'› /model'}});await ui.key('enter',{until:{text:'思考等级'}})
 for(let index=0;index<5;index++)await ui.key('down')
 await ui.key('enter');await ui.wait({text:'不发送思考参数'});await ui.key('enter');await ui.wait({text:'思考·默认'})
 await ui.send('检查原生设置更新期间的连续计时');await ui.key('enter');await ui.wait({text:'U116_THINKING'})
 await ui.send('/rename U116字段');await ui.key('enter');await ui.wait({text:'U116字段'})
 async function samples(){const series=[];for(let n=0;n<12;n++){await Bun.sleep(200);const screen=await ui.screen();const status=statusLineOf(screen.lines.map(v=>v.text));const row=screen.lines.find(v=>v.text===status)!;const cells=screen.cellsOf(row.row);series.push({status,color:cells.find(v=>v.text==='●')?.fg,thinking:screen.lines.find(v=>v.text.includes('（思考 '))?.text.match(/（思考 ([^)）]+)/)?.[1]});}return series}
 const normal=await samples();const first=await ui.capture({label:'01-有色正常动效与计时'})
 const all=statusLineOf(first.lines);assert(all.includes('全放行'));assert(all.includes('思考·默认'));assert(/\d.*\/\d+k/.test(all),all)
 function order(line:string,values:string[]){let previous=-1;for(const value of values){const index=line.indexOf(value);assert(index>previous,`字段顺序不符：${line}`);previous=index}}
 order(all,['全放行','U116字段','Default','思考·默认','1.0k/','ws'])
 await settings({type:'prefs.set',statusLine:{cells:['workspace','model','reasoning','context','session'],color:true},reducedMotion:true})
 await Bun.sleep(300);const reducedSeries=await samples();const reduced=await ui.capture({label:'02-原生保存减少动效-计时继续'})
 order(statusLineOf(reduced.lines),['全放行','ws','Default','思考·默认','1.0k/','U116字段'])
 await Bun.sleep(1500);await ui.capture({label:'03-减少动效持续-计时增长'})
 await settings({type:'prefs.set',statusLine:{cells:['session','workspace','model','reasoning','context'],color:false},reducedMotion:false})
 await Bun.sleep(1200);const colorless=await ui.capture({label:'04-原生保存无色-字段顺序变更'});const colorlessStatus=statusLineOf(colorless.lines);order(colorlessStatus,['全放行','U116字段','ws','Default','思考·默认','1.0k/']);const colorlessRow=colorless.lines.indexOf(colorlessStatus);assert(colorless.cellsOf(colorlessRow).every(v=>v.fg===null),'关闭颜色后整条状态行使用终端默认色')
 await settings({type:'prefs.set',statusLine:{cells:[],color:false},reducedMotion:true})
 await ui.capture({label:'06-空字段仍保留运行状态'})
 assert(reduced.text.includes('U116字段'));assert(reduced.text.includes('Default'))
 assert(new Set(normal.map(v=>v.color)).size>1,'实际工作状态呼吸颜色必须变化');assert.equal(new Set(reducedSeries.map(v=>v.color)).size,1,'减少动效后颜色须固定');assert(reducedSeries.every(v=>v.color!=null&&v.thinking!=null));assert(new Set(reducedSeries.map(v=>v.thinking)).size>1,'减少动效期间思考计时继续')
 const empty=statusLineOf((await ui.screen()).lines.map(v=>v.text));assert(empty.includes('全放行'));assert(!empty.includes('Default'))
 await ui.wait({text:'U116_TERMINAL_FINISHED'},{timeoutMs:30000});await ui.wait({text:'○ 空闲'});await ui.capture({label:'07-完成后静止'})
 writeFileSync(ui.runDir+'/u116-terminal-facts.json',JSON.stringify({entry:'native.settings.apply → existing executor受理 → real CLI/PTY',requests:ui.requests().length,run:ui.facts(),normal,reduced:reducedSeries,allFiveFields:all,initialEmptyValues:initialStatus,colorless:colorlessStatus,emptyFields:empty,finalPreview:(await settings()).preview},null,2))
 console.log(ui.runDir)
} finally {link.close();await ui.close({keepSandbox:true});await host.close();await fixture.stop()}
