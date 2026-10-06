/** 生产 CLI → runTui → Bun.Terminal；隔离 HOME、本地模型夹具，无真实会话。 */
import { strict as assert } from 'node:assert'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUiSession, REPO_ROOT } from './ui/driver.ts'
const mode = process.argv[2] ?? 'color'
const columns = Number(process.argv[3] ?? 200)
const ui = await createUiSession({
 columns, rows:40, label:`20261007-motion-${mode}-${columns}`, artifacts: REPO_ROOT+'/.ui-runs/defects-20261007',
 forceColor:mode==='no-color'?'0':'3',config:{motion:{reduced:mode==='reduced'}},
 turns:[
  {kind:'tool',name:'exec',args:{cmd:'chmod 755 . && sleep 5 && printf MOTION_TOOL_DONE'},reasoning:'检查终端的实际运行状态与审批入口。'.repeat(12),text:'现在执行一次受控的五秒工具。',chunks:24,chunkDelayMs:250},
  {kind:'text',text:'MOTION_PTY_FINISHED：工具执行后继续输出，完成后动效停止。'.repeat(3),chunks:20,chunkDelayMs:250},
 ],
})
const phases: {name:string;at:number;bytes:number}[]=[]
const start=performance.now()
async function observe(name:string,ms:number){
 phases.push({name,at:(performance.now()-start)/1000,bytes:statSync(join(ui.runDir,'raw.bin')).size})
 await Bun.sleep(ms)
 return ui.capture({label:name})
}
try{
 await ui.send('运行受控动效验收');await ui.key('enter');await ui.wait({text:'思考'})
 await observe('thinking-two-breaths',4400)
 if(columns===100){await ui.key('ctrl+o');await ui.capture({label:'reader-before-decision'})}
 await ui.wait({text:'↑↓ 选择'}, {timeoutMs:20000})
 const decision=await observe('decision-static',1600)
 assert(decision.text.includes('sleep 5'))
 if(columns===100){
  await ui.key('esc');await ui.wait({text:'PgUp/PgDn 翻页'});
  const reader=await ui.capture({label:'decision-return-reader'})
  assert(reader.text.includes('Tab 进入决策'));assert(reader.text.includes('chmod 755'))
  await ui.key('tab');await ui.wait({text:'○ 批准这一次'});await ui.capture({label:'reader-tab-reopens-decision'})
  await ui.key('esc');await ui.wait({text:'PgUp/PgDn 翻页'})
  await ui.key('esc');await ui.wait({absent:'PgUp/PgDn 翻页'});await ui.wait({text:'Tab 进入决策'});await ui.capture({label:'reader-exit-main-pending'});await ui.key('tab');await ui.wait({text:'○ 批准这一次'})
 }
 await ui.send('yan');await ui.key('enter');await ui.key('enter');
 assert((await ui.capture({label:'letters-enter-no-approval'})).text.includes('○ 批准这一次'))
 assert.equal(ui.requests().filter(one=>one.path.endsWith('/chat/completions')).length,1)
 await ui.key('down');await ui.key('enter')
 await observe('tool-two-breaths',4400)
 await ui.wait({text:'MOTION_PTY_FINISHED'}, {timeoutMs:15000})
 await observe('continued-two-breaths',4400)
 await ui.wait({text:'○ 空闲'}, {timeoutMs:15000})
 await observe('done-static',1200)
 const requests=ui.requests().filter(one=>one.path.endsWith('/chat/completions'))
 assert.equal(requests.length,2)
 await ui.quit()
 const raw=readFileSync(join(ui.runDir,'raw.bin'))
 const output=readFileSync(join(ui.runDir,'output.ndjson'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as {at:number;offset:number;length:number})
 writeFileSync(join(ui.runDir,'motion.cast'),[JSON.stringify({version:2,width:columns,height:40,title:`Production PTY ${mode}; original arrival timestamps`}),...output.map(one=>JSON.stringify([one.at/1000,'o',raw.subarray(one.offset,one.offset+one.length).toString('utf8')]))].join('\n')+'\n')
 writeFileSync(join(ui.runDir,'motion-facts.json'),JSON.stringify({mode,columns,phases,requests,facts:ui.facts()},null,2))
 console.log(ui.runDir)
} finally { await ui.close() }
