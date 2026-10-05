import {strict as assert} from 'node:assert'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {Database} from 'bun:sqlite'
import {createUiSession, REPO_ROOT } from './ui/driver.ts'
const ui=await createUiSession({columns:160,rows:40,label:'U114-真实受理消费',artifacts:REPO_ROOT + '/.ui-runs/u114',turns:[
 {kind:'tool',name:'exec',args:{cmd:'sleep 12; printf LONG_TOOL_DONE'},following:[{name:'exec',args:{cmd:'printf OLD_NEXT_EXECUTED'}}]},
 {kind:'text',text:'CURRENT_REJUDGED',chunks:1,chunkDelayMs:10},
 {kind:'text',text:'NEXT_COMPLETE',chunks:1,chunkDelayMs:10},
]})
const key=async(k:Parameters<typeof ui.key>[0])=>{await ui.key(k);await Bun.sleep(90)}
const frame=async(label:string)=>{await Bun.sleep(100);return ui.capture({label})}
try{
 await ui.send('U114_FIRST');await key('enter');await ui.wait({text:'sleep 12'})
 const db=new Database(join(ui.facts().dataDir,'records.db'),{readonly:true})
 await frame('160-长工具在途')
 await ui.send('CURRENT_CHANGE');await key('enter');await ui.wait({text:'待带入：CURRENT_CHANGE'});await frame('160-当前补充已受理待带入')
 const next=async(text:string)=>{await ui.send(text);await key('alt+enter');await ui.wait({text:'本条输入用途'});await key('down');await key('enter');await ui.wait({text:'本条：下一件'});await key('enter');await ui.wait({text:`下一件排队中：${text}`})}
 await next('NEXT_ORIGINAL');await next('WITHDRAW_THIS')
 assert.equal(ui.requests().filter(r=>r.path.endsWith('/chat/completions')).length,1)
 await frame('160-下一件未混当前请求')
 await key('alt+enter');await ui.wait({text:'本条输入用途'});await key('down');await key('down');await key('enter');await ui.wait({text:'输入受理记录'})
 // 目录包含全部持久输入；当前补充和下一件仍为 pending，已消费项没有编辑动作。
 await key('down');await key('down');await key('enter');await ui.wait({text:'编辑未消费输入'});await key('down');await key('enter')
 await frame('160-编辑未消费正文')
 for(let i=0;i<'NEXT_ORIGINAL'.length;i++)await key('backspace')
 await ui.send('NEXT_EDITED');await key('enter');await ui.wait({text:'已保存未消费输入'});await frame('160-编辑已持久保存')
 await key('esc');await key('down');await key('enter');await ui.wait({text:'撤回未消费输入'});await key('down');await key('down');await key('enter');await ui.wait({text:'已撤回未消费输入'});await frame('160-撤回未消费正文')
 await key('esc');await key('esc');await key('esc')
 await ui.wait({text:'NEXT_COMPLETE'},{timeoutMs:30000});await ui.wait({text:'○ 空闲'});await frame('160-消费与实际请求回执')
 const requests=ui.requests().filter(r=>r.path.endsWith('/chat/completions'))
 assert.equal(requests.length,3)
 const body=requests.map(r=>JSON.stringify(r.body))
 assert(!body[0]!.includes('CURRENT_CHANGE'));assert(body[1]!.includes('CURRENT_CHANGE'))
 assert(!body[1]!.includes('NEXT_ORIGINAL'));assert(!body[1]!.includes('NEXT_EDITED'));assert(body[2]!.includes('NEXT_EDITED'))
 assert(!body.join().includes('WITHDRAW_THIS'))
 const inputs=db.query('SELECT * FROM inputs ORDER BY at').all() as any[]
 const calls=db.query("SELECT id,kind,content_text,payload FROM entries WHERE kind IN ('tool-call','tool-result') ORDER BY id").all() as any[]
 assert.equal(calls.filter(row=>row.kind==='tool-result').length,2)
 const withheld=calls.filter(row=>row.kind==='tool-result').at(-1)!
 assert.equal(JSON.parse(withheld.payload).notExecuted,true,'旧下一工具必须落未执行事实')
 assert(!withheld.content_text.includes('OLD_NEXT_EXECUTED'),'不得把旧工具执行输出冒充未执行')
 assert.equal(inputs.find(row=>JSON.parse(row.body).text==='NEXT_EDITED')?.state,'included')
 assert.equal(inputs.find(row=>JSON.parse(row.body).text==='WITHDRAW_THIS')?.state,'withdrawn')
 writeFileSync(`${ui.runDir}/u114-runtime-facts.json`,JSON.stringify({facts:ui.facts(),requests,inputs,calls},null,2));db.close();console.log(ui.runDir)
}finally{await ui.close({keepSandbox:true})}
